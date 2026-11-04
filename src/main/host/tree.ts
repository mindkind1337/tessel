// A file tree on the host (capability `tree`). Expand the directories you
// show; apply `changed` events of a directory with a revision above its
// listing's. After a reconnect the tree subscribes again and lists every
// expanded directory again (`relisted`, from the host's cache); after a
// daemon restart it opens the root again by its path first.
import { type Client, type Resumable } from './client'
import { type RelPath, pathKey, startsWith } from './paths'

export type EntryKind = 'file' | 'dir' | 'symlink' | 'other'

export interface Entry {
  /** The raw name, base64. */
  name: string
  label: string
  kind: EntryKind
  size: number
  mtime_ms: number
  excluded: boolean
}

export interface Listing {
  path: RelPath
  revision: number
  entries: Entry[]
  /** Kept current by the host; false: expand again when shown again, never show it as complete. */
  watched: boolean
  excluded: boolean
  truncated: boolean
}

export interface RootOpened {
  root: string
  label: string
  limits: { max_watches: number; exclusions: string[] }
}

export interface TreeChanged {
  revision: number
  path: RelPath
  added: Entry[]
  updated: Entry[]
  removed: string[]
}

export type StaleReason = 'overflow' | 'lagging' | 'error'

export type TreeEvent =
  | { kind: 'changed'; change: TreeChanged }
  /** Expand this directory again (from the cache); an empty path means the whole root. */
  | { kind: 'stale'; path: RelPath; reason: StaleReason | 'gap' }
  | { kind: 'resynced'; revision: number }
  /** A directory listed again after a reconnect: replace what is shown for it. */
  | { kind: 'relisted'; listing: Listing }
  | { kind: 'disconnected' }

export class Tree implements Resumable {
  readonly label: string
  private readonly client: Client
  private readonly path: string
  private root: string
  private readonly expanded = new Map<string, RelPath>()
  private readonly onEvent: (event: TreeEvent) => void
  private stream: string | null = null
  private ended = false

  private constructor(client: Client, path: string, opened: RootOpened, onEvent: (event: TreeEvent) => void) {
    this.client = client
    this.path = path
    this.root = opened.root
    this.label = opened.label
    this.onEvent = onEvent
  }

  /** Opens `path` (absolute, on the host) as a root and subscribes to its changes. */
  static async open(client: Client, path: string, onEvent: (event: TreeEvent) => void): Promise<Tree> {
    const opened = await client.retrying(() => client.ask<RootOpened>('root.open', { path }))
    const tree = new Tree(client, path, opened, onEvent)
    await tree.subscribe()
    client.register(tree)
    return tree
  }

  get rootId(): string {
    return this.root
  }

  async expand(path: RelPath): Promise<Listing> {
    const listing = await this.client.retrying(() => this.client.ask<Listing>('tree.expand', { root: this.root, path }))
    this.expanded.set(pathKey(path), path)
    return listing
  }

  async collapse(path: RelPath): Promise<void> {
    for (const [key, p] of this.expanded) if (startsWith(p, path)) this.expanded.delete(key)
    await this.client.retrying(() => this.client.ask('tree.collapse', { root: this.root, path }))
  }

  /** Stops following: the host drops this connection's subscription; events stop. */
  async end(): Promise<void> {
    this.ended = true
    const stream = this.stream
    this.stream = null
    if (!stream) return
    try {
      this.client.live().unregister(stream)
      await this.client.ask('tree.unsubscribe', { stream })
    } catch {
      /* gone with the link, or the link is gone */
    }
  }

  private async subscribe(): Promise<void> {
    const link = this.client.live()
    const subscribed = (await link.request('tree.subscribe', { root: this.root }, this.client.options.requestTimeout)).body as {
      stream: string
      revision: number
    }
    this.stream = subscribed.stream
    link.register(subscribed.stream, (item) => {
      if (this.ended) return
      if (item.gap) {
        this.onEvent({ kind: 'stale', path: [], reason: 'gap' })
        return
      }
      const body = item.body as Record<string, unknown>
      switch (item.kind) {
        case 'tree.changed':
          this.onEvent({ kind: 'changed', change: body as unknown as TreeChanged })
          break
        case 'tree.stale':
          this.onEvent({ kind: 'stale', path: body.path as RelPath, reason: body.reason as StaleReason })
          break
        case 'tree.resynced':
          this.onEvent({ kind: 'resynced', revision: body.revision as number })
          break
      }
    })
    link.onClose(() => {
      if (this.stream === subscribed.stream && !this.ended) this.onEvent({ kind: 'disconnected' })
    })
  }

  async resume(client: Client, sameEpoch: boolean): Promise<void> {
    if (this.ended) return
    if (!sameEpoch) {
      // The root's id belonged to the old daemon: open it again by its path.
      const opened = await client.ask<RootOpened>('root.open', { path: this.path })
      this.root = opened.root
    }
    await this.subscribe()
    for (const [key, path] of [...this.expanded]) {
      try {
        const listing = await client.ask<Listing>('tree.expand', { root: this.root, path })
        this.onEvent({ kind: 'relisted', listing })
      } catch {
        this.expanded.delete(key)
      }
    }
  }
}
