// The Files panel of a remote project over tessel-host (remoteFs.js uses
// this when the host's daemon is there, daemon.ts): the folder listings come
// from the daemon's file tree, which keeps them current and sends what
// changed (no more `find -newer` every few seconds), and the explorer's git
// letters come from the daemon's status cache, kept current from file system
// events (no more `git status` over the whole tree on each change). The
// answers keep the shapes remoteFs.js gives the window, so the window does
// not know which path a host uses.
import { type HostDaemons } from './daemon'
import { type GitChanged, type GitEntry, Git } from './git'
import { type RelPath, labelOf, nameOf, pathKey, relPathText } from './paths'
import { type Listing, type TreeEvent, Tree } from './tree'
import { isConnectionLost } from './wire'

export interface ExplorerEntry {
  name: string
  path: string
  dir: boolean
  link?: boolean
}

export interface ListAnswer {
  ok: true
  entries: ExplorerEntry[]
  truncated: boolean
  /** The daemon keeps this folder current (false: not watched: read again when shown again). */
  watched: boolean
}

export interface StatusAnswer {
  ok: true
  files: Record<string, string>
  repo: boolean
  ms: number
  /** From the daemon's cache: the window may ask again as soon as it is told of a change. */
  daemon: true
  /** The status is still being read (first read, or a refresh after a git change): the letters may lag. */
  stale: boolean
  truncated: boolean
}

export interface RemoteExplorerDeps {
  daemons: HostDaemons
  /** send(channel, payload) to the window. */
  send(channel: string, payload: unknown): void
  /** The window's virtual path of `rel` below the virtual root (src/shared/remotePath.js childPath). */
  childPath(virtualRoot: string, rel: string): string
  /** `path` relative to `base` (both absolute on the host), or null when not below it (remotePath.js relativeTo). */
  relativeTo(base: string, path: string): string | null
  joinPath(base: string, rel: string): string
  /** The explorer's order (src/shared/explorerSort.js sortEntries). */
  sortEntries<T extends ExplorerEntry>(entries: T[]): T[]
  /** A watched project changed on the host (what the shell poll told its listeners). */
  onChanged?(virtualRoot: string): void
  log?: (text: string) => void
  now?: () => number
}

interface WatchedRoot {
  virtual: string
  hostId: string
  /** The project folder on the host, absolute (what root.open resolves); null while not known (a ~/… project not resolved yet). */
  rootPath: () => string | null
  tree: Tree | null
  opening: Promise<Tree | null> | null
  git: GitWatch | null
  gitOpening: Promise<GitWatch | null> | null
}

interface GitWatch {
  git: Git
  /** The repository's top on the host, and the project folder's real path (for the window's paths). */
  top: string
  realRoot: string
  files: Map<string, string> // rel path below the top (text) -> letter
  dirs: Set<string> // untracked directories (rel path text)
  stale: boolean
  truncated: boolean
  revision: number
}

const CONTROL = /[\u0000-\u001f\u007f]/

/** The explorer's letter for a porcelain v2 entry (as remoteFs.js porcelainLetters gives for v1). */
export function letterOf(entry: Pick<GitEntry, 'xy' | 'kind'>): string {
  const x = entry.xy[0] ?? ' '
  const y = entry.xy[1] ?? ' '
  if (entry.kind === 'untracked' || (x === '?' && y === '?')) return 'U'
  if (x === '!' && y === '!') return '!'
  if (x === 'R' || y === 'R') return 'R'
  if (x === 'C' || y === 'C') return 'C'
  if (x === 'D' || y === 'D') return 'D'
  if (x === 'A') return 'A'
  return 'M'
}

const okText = (rel: string): boolean => !!rel && !CONTROL.test(rel) && !rel.includes('\\')

export function createRemoteExplorer(deps: RemoteExplorerDeps) {
  const log = deps.log ?? (() => {})
  const now = deps.now ?? (() => Date.now())
  const watched = new Map<string, WatchedRoot>() // virtual root -> state

  // --- The file tree -----------------------------------------------------------------
  function onTreeEvent(w: WatchedRoot, event: TreeEvent): void {
    if (watched.get(w.virtual) !== w) return
    const dirPath = (path: RelPath): string => (path.length ? deps.childPath(w.virtual, relPathText(path)) : w.virtual)
    if (event.kind !== 'disconnected') deps.onChanged?.(w.virtual)
    switch (event.kind) {
      case 'changed':
      case 'relisted':
        deps.send('explorer:changed', { root: w.virtual, paths: [dirPath(event.kind === 'changed' ? event.change.path : event.listing.path)] })
        break
      case 'stale':
        deps.send('explorer:changed', { root: w.virtual, paths: event.path.length ? [dirPath(event.path)] : null })
        break
      case 'resynced':
        deps.send('explorer:changed', { root: w.virtual, paths: null })
        break
      case 'disconnected':
        // The tree subscribes again by itself; what it relists is sent then.
        break
    }
  }

  async function openTree(w: WatchedRoot): Promise<Tree | null> {
    const client = deps.daemons.client(w.hostId)
    const rootPath = w.rootPath()
    if (!client || !rootPath) return null
    try {
      const tree = await Tree.open(client, rootPath, (e) => onTreeEvent(w, e))
      if (watched.get(w.virtual) !== w) {
        void tree.end()
        return null
      }
      w.tree = tree
      return tree
    } catch (e) {
      if (!isConnectionLost(e)) log(`tessel-host tree of ${w.virtual}: ${e instanceof Error ? e.message : String(e)}`)
      return null
    }
  }

  /** The tree of a watched root, opened on first use (null: no daemon for this host now). */
  function treeOf(virtual: string): Promise<Tree | null> {
    const w = watched.get(virtual)
    if (!w) return Promise.resolve(null)
    if (w.tree) return Promise.resolve(w.tree)
    if (!w.opening)
      w.opening = openTree(w).finally(() => {
        w.opening = null
      })
    return w.opening
  }

  /**
   * The project the Files tab shows (one at a time). Idempotent; a daemon
   * missing now is looked for again at the next listing.
   */
  function watch(virtual: string, hostId: string, rootPath: string | (() => string | null)): void {
    if (watched.has(virtual)) return
    unwatchAll()
    const path = typeof rootPath === 'function' ? rootPath : () => rootPath
    watched.set(virtual, { virtual, hostId, rootPath: path, tree: null, opening: null, git: null, gitOpening: null })
  }

  function unwatchAll(): void {
    for (const w of watched.values()) {
      void w.tree?.end()
      void w.git?.git.end()
    }
    watched.clear()
  }

  /** Whether a root is served by the daemon now (its tree is open): the poll then leaves it alone. */
  const served = (virtual: string): boolean => !!watched.get(virtual)?.tree

  /**
   * A folder's entries from the daemon (`rel`: below the root, '' for the
   * root itself), or null when this root is not served now (the caller lists
   * it the old way). An error from the host is thrown as { error, code }.
   */
  async function list(virtual: string, rel: string, dotfiles: boolean): Promise<ListAnswer | null> {
    const tree = await treeOf(virtual)
    if (!tree) return null
    const parts = rel.split('/').filter((p) => p && p !== '.')
    const path: RelPath = parts.map(nameOf)
    let listing: Listing
    try {
      listing = await tree.expand(path)
    } catch (e) {
      if (isConnectionLost(e)) return null
      throw e
    }
    const base = parts.length ? deps.childPath(virtual, parts.join('/')) : virtual
    const entries: ExplorerEntry[] = []
    for (const entry of listing.entries) {
      // (labelOf is lossy for a name that is not UTF-8: the window's path
      // for it does not lead back to the same bytes, so that folder cannot
      // be expanded; such names are rare and the daemon lists them anyway.)
      const name = labelOf(entry.name)
      if (!okText(name) || name.includes('/') || name === '.' || name === '..' || name === '.git') continue
      if (!dotfiles && name.startsWith('.')) continue
      if (entry.kind === 'other') continue
      const item: ExplorerEntry = { name, path: deps.childPath(base, name), dir: entry.kind === 'dir' }
      if (entry.kind === 'symlink') item.link = true
      entries.push(item)
    }
    return { ok: true, entries: deps.sortEntries(entries), truncated: listing.truncated, watched: listing.watched }
  }

  // --- Git status ------------------------------------------------------------------------
  function applyGit(g: GitWatch, change: GitChanged): void {
    if (change.reset) {
      g.files.clear()
      g.dirs.clear()
    }
    for (const p of change.removed) {
      const rel = relPathText(p)
      g.files.delete(rel)
      g.dirs.delete(rel)
    }
    for (const entry of change.upsert) {
      const rel = relPathText(entry.path)
      if (!okText(rel)) continue
      g.files.set(rel, letterOf(entry))
      if (entry.untracked_dir) g.dirs.add(rel)
      else g.dirs.delete(rel)
    }
    g.stale = change.state.stale || !change.state.complete
    g.truncated = change.state.truncated
    g.revision = change.revision
  }

  async function openGit(w: WatchedRoot, realRoot: string): Promise<GitWatch | null> {
    const client = deps.daemons.client(w.hostId)
    const rootPath = w.rootPath()
    if (!client || !rootPath) return null
    const holder: { g: GitWatch | null } = { g: null }
    try {
      const git = await Git.open(client, rootPath, [], (event) => {
        if (watched.get(w.virtual) !== w || !holder.g) return
        if (event.kind === 'changed') {
          applyGit(holder.g, event.change)
          deps.send('explorer:statusChanged', { root: w.virtual })
        }
      })
      if (watched.get(w.virtual) !== w) {
        void git.end()
        return null
      }
      holder.g = { git, top: git.opened.toplevel, realRoot, files: new Map(), dirs: new Set(), stale: true, truncated: false, revision: 0 }
      w.git = holder.g
      return holder.g
    } catch (e) {
      if (!isConnectionLost(e)) log(`tessel-host git of ${w.virtual}: ${e instanceof Error ? e.message : String(e)}`)
      return null
    }
  }

  /**
   * The explorer's letters for a watched root from the daemon's cache, or
   * null when this root is not served now (the caller runs git status the
   * old way). `realRoot`: the project folder's real path on the host
   * (remoteFs.js repoInfo), for the window's paths.
   */
  async function status(virtual: string, realRoot: string): Promise<StatusAnswer | null> {
    const w = watched.get(virtual)
    if (!w) return null
    if (!(await treeOf(virtual))) return null
    let g = w.git
    if (!g) {
      if (!w.gitOpening)
        w.gitOpening = openGit(w, realRoot).finally(() => {
          w.gitOpening = null
        })
      g = await w.gitOpening
      if (!g) return null
    }
    const t0 = now()
    const files: Record<string, string> = {}
    for (const [rel, letter] of g.files) {
      const below = deps.relativeTo(g.realRoot, deps.joinPath(g.top, rel))
      if (below === null || !okText(below)) continue
      files[deps.childPath(virtual, below)] = letter
    }
    return { ok: true, files, repo: true, ms: now() - t0, daemon: true, stale: g.stale, truncated: g.truncated }
  }

  /** The host's connection ended: what was open on it is gone. */
  function closeHost(hostId: string): void {
    for (const w of [...watched.values()]) {
      if (w.hostId !== hostId) continue
      void w.tree?.end()
      void w.git?.git.end()
      w.tree = null
      w.git = null
    }
  }

  return { watch, unwatchAll, served, list, status, closeHost, pathKey }
}

export type RemoteExplorer = ReturnType<typeof createRemoteExplorer>
