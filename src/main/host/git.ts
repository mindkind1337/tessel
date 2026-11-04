// A repository's git status on the host (capability `git`). The first event
// resets the status (`reset: true`) and carries it whole; then differences.
// After a reconnect the session subscribes again and the next event resets
// the status again; after a daemon restart it opens the root and the
// repository again by their paths first. Show `state.complete`/`stale` as
// they are.
import { type Client, type Resumable } from './client'
import { type RelPath } from './paths'

export type GitEntryKind = 'changed' | 'renamed' | 'unmerged' | 'untracked'

export interface GitEntry {
  path: RelPath
  orig_path?: RelPath
  kind: GitEntryKind
  /** The two status letters, as git's porcelain v2 prints them (`.M`, `??`, `A.`). */
  xy: string
  sub: string
  /** The porcelain record without its path(s), exactly as git printed it. */
  record: string
  /** A whole untracked directory shown as one entry: `untracked(path)` lists its files. */
  untracked_dir: boolean
}

export interface GitBranch {
  head: string
  oid: string
  upstream?: string
  ahead?: number
  behind?: number
}

export interface GitState {
  branch?: GitBranch
  complete: boolean
  stale: boolean
  truncated: boolean
  slow: boolean
  coverage_complete: boolean
  duration_ms: number
}

export interface GitChanged {
  revision: number
  reset: boolean
  upsert: GitEntry[]
  removed: RelPath[]
  state: GitState
}

export interface GitOpened {
  repo: string
  toplevel: string
  features: { untracked_cache: boolean; fsmonitor: boolean; git_version: string }
}

export interface UntrackedList {
  path: RelPath
  entries: RelPath[]
  truncated: boolean
}

export type GitEvent = { kind: 'changed'; change: GitChanged } | { kind: 'disconnected' }

async function openRepo(client: Client, rootPath: string, below: RelPath): Promise<GitOpened> {
  const root = await client.ask<{ root: string }>('root.open', { path: rootPath })
  return client.ask<GitOpened>('git.open', { root: root.root, path: below })
}

export class Git implements Resumable {
  readonly opened: GitOpened
  private readonly client: Client
  private readonly rootPath: string
  private readonly below: RelPath
  private repo: string
  private readonly onEvent: (event: GitEvent) => void
  private stream: string | null = null
  private ended = false

  private constructor(client: Client, rootPath: string, below: RelPath, opened: GitOpened, onEvent: (event: GitEvent) => void) {
    this.client = client
    this.rootPath = rootPath
    this.below = below
    this.opened = opened
    this.repo = opened.repo
    this.onEvent = onEvent
  }

  /** The repository holding `below` under `rootPath` (absolute, on the host), subscribed. */
  static async open(client: Client, rootPath: string, below: RelPath, onEvent: (event: GitEvent) => void): Promise<Git> {
    const opened = await client.retrying(() => openRepo(client, rootPath, below))
    const git = new Git(client, rootPath, below, opened, onEvent)
    await git.subscribe()
    client.register(git)
    return git
  }

  /** Asks for a full read, soon (a Refresh button); otherwise nothing needs asking. */
  async refresh(): Promise<void> {
    await this.client.retrying(() => this.client.ask('git.refresh', { repo: this.repo }))
  }

  /** The files inside an untracked directory shown as one entry. */
  untracked(path: RelPath): Promise<UntrackedList> {
    return this.client.retrying(() => this.client.ask<UntrackedList>('git.untracked', { repo: this.repo, path }))
  }

  /** Stops following: the host runs nothing for a repository nobody subscribed to. */
  async end(): Promise<void> {
    this.ended = true
    const stream = this.stream
    this.stream = null
    if (!stream) return
    try {
      this.client.live().unregister(stream)
      await this.client.ask('git.unsubscribe', { stream })
    } catch {
      /* gone with the link, or the link is gone */
    }
  }

  private async subscribe(): Promise<void> {
    const link = this.client.live()
    const subscribed = (await link.request('git.subscribe', { repo: this.repo }, this.client.options.requestTimeout)).body as {
      stream: string
      revision: number
    }
    this.stream = subscribed.stream
    link.register(subscribed.stream, (item) => {
      if (this.ended) return
      if (item.gap) {
        // Events were missed: the next full read puts the list right.
        void this.client.ask('git.refresh', { repo: this.repo }).catch(() => {})
        return
      }
      if (item.kind === 'git.changed') this.onEvent({ kind: 'changed', change: item.body as GitChanged })
    })
    link.onClose(() => {
      if (this.stream === subscribed.stream && !this.ended) this.onEvent({ kind: 'disconnected' })
    })
  }

  async resume(client: Client, sameEpoch: boolean): Promise<void> {
    if (this.ended) return
    if (!sameEpoch) this.repo = (await openRepo(client, this.rootPath, this.below)).repo
    await this.subscribe()
  }
}
