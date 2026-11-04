// The Files panel and the Changes tab of a remote project over tessel-host
// (remoteFs.js uses this when the host's daemon is there, daemon.ts): the
// folder listings come from the daemon's file tree, which keeps them current
// and sends what changed (no more `find -newer` every few seconds), and the
// git status comes from the daemon's status cache, kept current from file
// system events (no more `git status` over the whole tree on each change):
// the explorer's letters, and the porcelain text the Changes tab's reader
// expects, rebuilt from the cache. The answers keep the shapes remoteFs.js
// gives the window, so the window does not know which path a host uses.
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
}

/** One repository's status, followed from the daemon (the Files letters and the Changes tab share it). */
interface GitWatch {
  /** hostId + the repository's top: one per repository, whatever root asked. */
  key: string
  hostId: string
  /** The window's roots this status is shown under (each told when it changes). */
  roots: Set<string>
  git: Git
  /** The repository's top on the host. */
  top: string
  files: Map<string, GitEntry> // rel path below the top (text) -> its entry
  stale: boolean
  truncated: boolean
  revision: number
  /** The first whole status (a reset) arrived: before it the cache says nothing. */
  ready: boolean
  waiters: Array<() => void>
  usedAt: number
  branch: GitChanged['state']['branch'] | undefined
  /** A git command that changes the repository ran on the host (stage, commit…) while the cache showed this revision: the next status waits for a newer, complete one. */
  writeSeen: number | null
}

const CONTROL = /[\u0000-\u001f\u007f]/
/** Repositories followed at once (the least recently asked one is let go beyond). */
const MAX_GITS = 4
/** How long the Changes tab waits for a repository's first status from the daemon before the old path serves it. */
const FIRST_STATUS_MS = 2000
/** After a stage or a commit, how long the next status waits for the daemon's complete re-read before the old path serves it. */
const AFTER_WRITE_MS = 4000
/** A repository the daemon refused (not found, outside its roots): not asked again sooner than this. */
const REFUSED_MS = 60_000
/** A porcelain record of the daemon is git's own line head: its kind and field count, or it is not shown. */
const RECORD_FIELDS: Record<string, number> = { '1': 8, '2': 9, u: 10, '?': 1 }
const recordOk = (record: string): boolean => okText(record) && RECORD_FIELDS[record[0] ?? ''] === record.split(' ').length

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

/**
 * `git status --porcelain=v2 -z` (with `--branch` headers when asked) rebuilt
 * from the daemon's cache: each entry's porcelain record (kept as git printed
 * it, without the path) followed by its path, a rename's original path as the
 * next record, an untracked directory as `dir/`. What sourceControl.js's
 * parseStatusV2 reads.
 */
export function porcelainV2(entries: Iterable<[string, GitEntry]>, branch: GitChanged['state']['branch'] | undefined, withBranch: boolean): string | null {
  const out: string[] = []
  if (withBranch) {
    // The branch as the daemon read it; a value that is not plain text is
    // not shown at all (the caller reads git itself).
    for (const v of [branch?.oid, branch?.head, branch?.upstream]) if (v !== undefined && !okText(v)) return null
    out.push(`# branch.oid ${branch?.oid || '(initial)'}`)
    out.push(`# branch.head ${branch?.head || '(detached)'}`)
    if (branch?.upstream) {
      out.push(`# branch.upstream ${branch.upstream}`)
      // Only when git gave them (an upstream that is gone has none).
      if (typeof branch.ahead === 'number' && typeof branch.behind === 'number') out.push(`# branch.ab +${branch.ahead} -${branch.behind}`)
    }
  }
  for (const [rel, entry] of entries) {
    if (!okText(rel) || !recordOk(entry.record)) continue
    const path = entry.untracked_dir ? `${rel}/` : rel
    if (entry.kind === 'renamed' || entry.record.startsWith('2 ')) {
      // A rename without a usable original path is not shown as a rename from itself: left out.
      const orig = entry.orig_path ? relPathText(entry.orig_path) : ''
      if (!okText(orig)) continue
      out.push(`${entry.record} ${path}`, orig)
      continue
    }
    out.push(`${entry.record} ${path}`)
  }
  return out.length ? out.join('\0') + '\0' : ''
}

export function createRemoteExplorer(deps: RemoteExplorerDeps) {
  const log = deps.log ?? (() => {})
  const now = deps.now ?? (() => Date.now())
  const watched = new Map<string, WatchedRoot>() // virtual root -> state
  const gits = new Map<string, GitWatch>() // hostId\nrepository top -> status
  const aliases = new Map<string, string>() // hostId\nroot path asked -> the key of its repository
  const gitOpenings = new Map<string, Promise<GitWatch | null>>()
  const refused = new Map<string, number>() // hostId\nroot path -> time before which it is not asked again

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
    watched.set(virtual, { virtual, hostId, rootPath: path, tree: null, opening: null })
  }

  /** The Files tab shows no project: its tree goes (the repositories followed stay for the Changes tab). */
  function unwatchAll(): void {
    for (const w of watched.values()) void w.tree?.end()
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
  function wake(g: GitWatch): void {
    for (const w of g.waiters.splice(0)) w()
  }

  function applyGit(g: GitWatch, change: GitChanged): void {
    if (change.reset) g.files.clear()
    for (const p of change.removed) g.files.delete(relPathText(p))
    for (const entry of change.upsert) {
      const rel = relPathText(entry.path)
      if (!okText(rel)) continue
      g.files.set(rel, entry)
    }
    g.stale = change.state.stale || !change.state.complete
    g.truncated = change.state.truncated
    g.revision = change.revision
    g.branch = change.state.branch
    // The whole status came (the daemon's first successful full read always
    // resets; a failed or cut one sends an empty event, stale, that says
    // nothing of the repository).
    if (change.reset) g.ready = true
    if (g.writeSeen !== null && g.revision > g.writeSeen && !g.stale) g.writeSeen = null
    wake(g)
  }

  function endGit(g: GitWatch): void {
    gits.delete(g.key)
    for (const [alias, key] of [...aliases]) if (key === g.key) aliases.delete(alias)
    wake(g)
    void g.git.end()
  }

  /** The least recently asked repository goes when too many are followed. */
  function trimGits(): void {
    while (gits.size > MAX_GITS) {
      let oldest: GitWatch | null = null
      for (const g of gits.values()) if (!oldest || g.usedAt < oldest.usedAt) oldest = g
      if (!oldest) return
      endGit(oldest)
    }
  }

  async function openGit(hostId: string, rootPath: string, virtual: string): Promise<GitWatch | null> {
    const client = deps.daemons.client(hostId)
    if (!client || client.state.kind !== 'connected') return null
    const asked = `${hostId}\n${rootPath}`
    const holder: { g: GitWatch | null } = { g: null }
    let git: Git
    try {
      git = await Git.open(client, rootPath, [], (event) => {
        const g = holder.g
        if (!g || gits.get(g.key) !== g) return
        if (event.kind === 'changed') {
          applyGit(g, event.change)
          for (const root of g.roots) deps.send('explorer:statusChanged', { root })
        } else if (event.kind === 'disconnected') {
          // Until the session resumes and resets, what is shown may be old.
          g.stale = true
        }
      })
    } catch (e) {
      if (!isConnectionLost(e)) {
        // The daemon refused (not a repository it can serve): not asked again for a while.
        refused.set(asked, now() + REFUSED_MS)
        log(`tessel-host git of ${rootPath} on ${hostId}: ${e instanceof Error ? e.message : String(e)}`)
      }
      return null
    }
    if (deps.daemons.client(hostId) !== client) {
      // The host closed while opening: never the host's.
      void git.end()
      return null
    }
    const key = `${hostId}\n${git.opened.toplevel}`
    aliases.set(asked, key)
    const same = gits.get(key)
    if (same) {
      // Another root of the same repository asked first: one status for both.
      void git.end()
      same.roots.add(virtual)
      same.usedAt = now()
      return same
    }
    holder.g = { key, hostId, roots: new Set([virtual]), git, top: git.opened.toplevel, files: new Map(), stale: true, truncated: false, revision: 0, ready: false, waiters: [], usedAt: now(), branch: undefined, writeSeen: null }
    gits.set(key, holder.g)
    trimGits()
    return gits.get(key) === holder.g ? holder.g : null
  }

  /** The repository below `rootPath`, followed (opened on first use; null: no daemon for this host now, or it refused a moment ago). */
  function gitOf(hostId: string, rootPath: string, virtual: string): Promise<GitWatch | null> {
    const asked = `${hostId}\n${rootPath}`
    const have = gits.get(aliases.get(asked) ?? asked)
    if (have) {
      have.usedAt = now()
      have.roots.add(virtual)
      return Promise.resolve(have)
    }
    if ((refused.get(asked) ?? 0) > now()) return Promise.resolve(null)
    let opening = gitOpenings.get(asked)
    if (!opening) {
      opening = openGit(hostId, rootPath, virtual).finally(() => gitOpenings.delete(asked))
      gitOpenings.set(asked, opening)
    }
    return opening
  }

  /** Waits until `done()` holds (woken at each event of the repository), at most `ms`. */
  function waitFor(g: GitWatch, done: () => boolean, ms: number): Promise<boolean> {
    if (done()) return Promise.resolve(true)
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(done()), ms)
      const check = (): void => {
        if (!done() && gits.get(g.key) === g) {
          g.waiters.push(check)
          return
        }
        clearTimeout(timer)
        resolve(done())
      }
      g.waiters.push(check)
    })
  }

  /** Within `ms`, or null (the daemon is slow or away: the caller runs git itself). */
  function within<T>(promise: Promise<T | null>, ms: number): Promise<T | null> {
    return Promise.race([promise, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))])
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
    const rootPath = w.rootPath()
    if (!rootPath) return null
    const g = await within(gitOf(w.hostId, rootPath, virtual), FIRST_STATUS_MS)
    if (!g) return null
    const t0 = now()
    const files: Record<string, string> = {}
    for (const [rel, entry] of g.files) {
      const below = deps.relativeTo(realRoot, deps.joinPath(g.top, rel))
      if (below === null || !okText(below)) continue
      files[deps.childPath(virtual, below)] = letterOf(entry)
    }
    return { ok: true, files, repo: true, ms: now() - t0, daemon: true, stale: g.stale, truncated: g.truncated }
  }

  /**
   * The Changes tab's `git status --porcelain=v2 [--branch] -z` from the
   * daemon's cache for the repository whose top is `top` (absolute, on the
   * host), or null when the daemon does not serve this host now or has no
   * status for it yet (the caller runs git the old way). `virtual`: the
   * window's root the tab shows (told when the status changes).
   */
  async function statusText(hostId: string, top: string, virtual: string, { branch = false }: { branch?: boolean } = {}): Promise<string | null> {
    const client = deps.daemons.client(hostId)
    if (!client || client.state.kind !== 'connected') return null
    const g = await within(gitOf(hostId, top, virtual), FIRST_STATUS_MS)
    if (!g) return null
    if (!(await waitFor(g, () => g.ready, FIRST_STATUS_MS))) return null
    // A stage or a commit just ran on the host: the list must not show the
    // repository as it was before it (the daemon re-reads within seconds).
    if (g.writeSeen !== null && !(await waitFor(g, () => g.writeSeen === null, AFTER_WRITE_MS))) return null
    if (branch && !g.branch) return null
    return porcelainV2(g.files, g.branch, branch)
  }

  /**
   * A git command that changes the repository at `top` ran on the host (a
   * stage, a commit, a discard): the next status from the cache waits for the
   * daemon's re-read of it, or the old path serves it.
   */
  function noteWrite(hostId: string, top: string): void {
    const g = gits.get(aliases.get(`${hostId}\n${top}`) ?? `${hostId}\n${top}`)
    if (g) g.writeSeen = g.revision
  }

  /** The host's connection ended: what was open on it is gone. */
  function closeHost(hostId: string): void {
    for (const w of watched.values()) {
      if (w.hostId !== hostId) continue
      void w.tree?.end()
      w.tree = null
    }
    for (const g of [...gits.values()]) if (g.hostId === hostId) endGit(g)
  }

  return { watch, unwatchAll, served, list, status, statusText, noteWrite, closeHost, pathKey, followed: () => gits.size }
}

export type RemoteExplorer = ReturnType<typeof createRemoteExplorer>
