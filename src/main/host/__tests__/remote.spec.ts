// @vitest-environment node
// The Files panel over the daemon: listings in the window's shape (dotfiles,
// .git dropped, folders first), git letters keyed by the window's virtual
// paths from the daemon's status cache (paths relative to the repository's
// top, mapped below the project folder), change notices sent as the window
// expects them, and what happens when the host's connection ends.
import { describe, it, expect } from 'vitest'
import { Client } from '../client'
import { type HostDaemons } from '../daemon'
import { createRemoteExplorer, letterOf } from '../remote'
import { nameOf } from '../paths'
import { fakeConnector, type Script } from './fakeHost'

const ROOT = 'c'.repeat(32)
const REPO = 'd'.repeat(32)
const TREE_STREAM = 'e'.repeat(32)
const GIT_STREAM = 'f'.repeat(32)
const EPOCH = 'a'.repeat(32)

const entry = (label: string, kind: 'file' | 'dir' | 'symlink' | 'other' = 'file') => ({ name: nameOf(label), label, kind, size: 1, mtime_ms: 1, excluded: false })

const script: Script = (kind, body) => {
  switch (kind) {
    case 'root.open':
      return { ok: 'root.opened', body: { root: ROOT, label: '/srv/app', limits: { max_watches: 8192, exclusions: [] } } }
    case 'tree.subscribe':
      return { ok: 'tree.subscribed', body: { stream: TREE_STREAM, revision: 0 } }
    case 'tree.expand': {
      const path = (body as { path: string[] }).path
      const entries = path.length
        ? [entry('b.txt'), entry('a.txt')]
        : [entry('zeta.js'), entry('.git', 'dir'), entry('.env'), entry('src', 'dir'), entry('link', 'symlink'), entry('sock', 'other'), entry('bad\\name')]
      return { ok: 'tree.listing', body: { path, revision: 1, entries, watched: path.length === 0, excluded: false, truncated: false } }
    }
    case 'tree.collapse':
    case 'tree.unsubscribe':
    case 'git.unsubscribe':
    case 'git.refresh':
      return { ok: 'done' }
    case 'git.open':
      return { ok: 'git.opened', body: { repo: REPO, toplevel: '/srv', features: { untracked_cache: false, fsmonitor: false, git_version: 'git version 2.43.0' } } }
    case 'git.subscribe':
      return { ok: 'git.subscribed', body: { stream: GIT_STREAM, revision: 0 } }
    default:
      return { error: 'unsupported_kind' }
  }
}

// The window's virtual paths: ssh://<host>/<posix path> (src/shared/remotePath.js, simplified).
const childPath = (root: string, rel: string): string => `${root}/${rel}`
const relativeTo = (base: string, path: string): string | null => (path === base ? '' : path.startsWith(base + '/') ? path.slice(base.length + 1) : null)
const joinPath = (base: string, rel: string): string => (rel ? `${base}/${rel}` : base)
const sortEntries = <T extends { name: string; dir: boolean }>(entries: T[]): T[] => [...entries].sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))

async function setup() {
  const c = fakeConnector(() => EPOCH, script)
  const client = await Client.connect(c.connect, { connectTimeout: 1000, requestTimeout: 1000, maxBackoff: 50 })
  const sent: Array<{ channel: string; payload: unknown }> = []
  const daemons = { client: () => client } as unknown as HostDaemons
  const explorer = createRemoteExplorer({ daemons, send: (channel, payload) => sent.push({ channel, payload }), childPath, relativeTo, joinPath, sortEntries })
  return { client, host: () => c.hosts[0]!, sent, explorer }
}

const until = async (test: () => boolean, ms = 2000): Promise<void> => {
  const end = Date.now() + ms
  while (!test()) {
    if (Date.now() > end) throw new Error('condition not met in time')
    await new Promise((r) => setTimeout(r, 0))
  }
}

describe('letters', () => {
  it('maps porcelain v2 xy to the explorer letters as the v1 reader does', () => {
    const l = (xy: string, kind: 'changed' | 'renamed' | 'unmerged' | 'untracked' = 'changed') => letterOf({ xy, kind })
    expect(l('??', 'untracked')).toBe('U')
    expect(l('.M')).toBe('M')
    expect(l('M.')).toBe('M')
    expect(l('A.')).toBe('A')
    expect(l('AM')).toBe('A')
    expect(l('.D')).toBe('D')
    expect(l('R.', 'renamed')).toBe('R')
    expect(l('C.', 'renamed')).toBe('C')
    expect(l('UU', 'unmerged')).toBe('M')
    expect(l('DD', 'unmerged')).toBe('D')
    expect(l('AA', 'unmerged')).toBe('A')
  })
})

describe('remote explorer over the daemon', () => {
  it('nothing is served before a root is watched; a watched root lists from the daemon in the window’s shape', async () => {
    const { explorer, client, host } = await setup()
    expect(await explorer.list('ssh://h/srv/app', '', true)).toBeNull()
    explorer.watch('ssh://h/srv/app', 'h', '/srv/app')
    expect(explorer.served('ssh://h/srv/app')).toBe(false)
    const root = await explorer.list('ssh://h/srv/app', '', true)
    expect(root).toMatchObject({ ok: true, truncated: false, watched: true })
    // Folders first, .git and names with a backslash dropped, a link marked, an "other" left out.
    expect(root!.entries).toEqual([
      { name: 'src', path: 'ssh://h/srv/app/src', dir: true },
      { name: '.env', path: 'ssh://h/srv/app/.env', dir: false },
      { name: 'link', path: 'ssh://h/srv/app/link', dir: false, link: true },
      { name: 'zeta.js', path: 'ssh://h/srv/app/zeta.js', dir: false }
    ])
    expect(explorer.served('ssh://h/srv/app')).toBe(true)
    const noDots = await explorer.list('ssh://h/srv/app', '', false)
    expect(noDots!.entries.map((e) => e.name)).toEqual(['src', 'link', 'zeta.js'])
    const sub = await explorer.list('ssh://h/srv/app', 'src', true)
    expect(sub!.entries.map((e) => e.path)).toEqual(['ssh://h/srv/app/src/a.txt', 'ssh://h/srv/app/src/b.txt'])
    expect(sub!.watched).toBe(false)
    expect(host().seen.filter((s) => s.kind === 'tree.expand').map((s) => (s.body as { path: string[] }).path)).toEqual([[], [], [nameOf('src')]])
    client.close()
  })

  it('the tree’s events become the window’s change notices: the folder that changed, everything when the root is stale or resynced', async () => {
    const { explorer, sent, client, host } = await setup()
    explorer.watch('ssh://h/srv/app', 'h', '/srv/app')
    await explorer.list('ssh://h/srv/app', '', true)
    host().event(TREE_STREAM, 1, 'tree.changed', { revision: 2, path: [nameOf('src')], added: [entry('new.txt')], updated: [], removed: [] })
    host().event(TREE_STREAM, 2, 'tree.changed', { revision: 3, path: [], added: [], updated: [], removed: [nameOf('zeta.js')] })
    host().event(TREE_STREAM, 3, 'tree.stale', { revision: 3, path: [], reason: 'lagging' })
    host().event(TREE_STREAM, 4, 'tree.stale', { revision: 3, path: [nameOf('src')], reason: 'overflow' })
    host().event(TREE_STREAM, 5, 'tree.resynced', { revision: 4 })
    await until(() => sent.length === 5)
    expect(sent).toEqual([
      { channel: 'explorer:changed', payload: { root: 'ssh://h/srv/app', paths: ['ssh://h/srv/app/src'] } },
      { channel: 'explorer:changed', payload: { root: 'ssh://h/srv/app', paths: ['ssh://h/srv/app'] } },
      { channel: 'explorer:changed', payload: { root: 'ssh://h/srv/app', paths: null } },
      { channel: 'explorer:changed', payload: { root: 'ssh://h/srv/app', paths: ['ssh://h/srv/app/src'] } },
      { channel: 'explorer:changed', payload: { root: 'ssh://h/srv/app', paths: null } }
    ])
    await until(() => host().seen.filter((s) => s.ack).length === 5)
    client.close()
  })

  it('git letters from the status cache: paths relative to the top mapped below the project, untracked folders as one entry, the window told of each change', async () => {
    const { explorer, sent, client, host } = await setup()
    explorer.watch('ssh://h/srv/app', 'h', '/srv/app')
    const first = explorer.status('ssh://h/srv/app', '/srv/app')
    await until(() => host().seen.some((s) => s.kind === 'git.subscribe'))
    const state = { complete: true, stale: false, truncated: false, slow: false, coverage_complete: true, duration_ms: 3 }
    host().event(GIT_STREAM, 1, 'git.changed', {
      revision: 1,
      reset: true,
      upsert: [
        { path: [nameOf('app'), nameOf('a.txt')], kind: 'changed', xy: '.M', sub: 'N...', record: '1 .M', untracked_dir: false },
        { path: [nameOf('app'), nameOf('tmp')], kind: 'untracked', xy: '??', sub: '', record: '?', untracked_dir: true },
        { path: [nameOf('other'), nameOf('x.txt')], kind: 'changed', xy: 'A.', sub: 'N...', record: '1 A.', untracked_dir: false }
      ],
      removed: [],
      state
    })
    const answer = await first
    expect(answer).toMatchObject({ ok: true, repo: true, daemon: true })
    // Before the first event the cache is empty and said stale; once it came, the letters are there.
    const now = (await explorer.status('ssh://h/srv/app', '/srv/app'))!
    expect(now.files).toEqual({ 'ssh://h/srv/app/a.txt': 'M', 'ssh://h/srv/app/tmp': 'U' })
    expect(now.stale).toBe(false)
    expect(sent.filter((s) => s.channel === 'explorer:statusChanged')).toEqual([{ channel: 'explorer:statusChanged', payload: { root: 'ssh://h/srv/app' } }])
    host().event(GIT_STREAM, 2, 'git.changed', { revision: 2, reset: false, upsert: [], removed: [[nameOf('app'), nameOf('a.txt')]], state: { ...state, stale: true } })
    await until(() => sent.filter((s) => s.channel === 'explorer:statusChanged').length === 2)
    const after = (await explorer.status('ssh://h/srv/app', '/srv/app'))!
    expect(after.files).toEqual({ 'ssh://h/srv/app/tmp': 'U' })
    expect(after.stale).toBe(true)
    expect(host().seen.filter((s) => s.kind === 'git.open').map((s) => s.body)).toEqual([{ root: ROOT, path: [] }])
    client.close()
  })

  it('a project whose folder is not known absolute yet (~/…) is not served until it is; a change tells the project’s listeners', async () => {
    const { client, host } = await setup()
    const changed: string[] = []
    const explorer = createRemoteExplorer({ daemons: { client: () => client } as unknown as HostDaemons, send: () => {}, childPath, relativeTo, joinPath, sortEntries, onChanged: (v) => changed.push(v) })
    let real: string | null = null
    explorer.watch('ssh://h/~/app', 'h', () => real)
    expect(await explorer.list('ssh://h/~/app', '', true)).toBeNull()
    expect(host().seen.some((s) => s.kind === 'root.open')).toBe(false)
    real = '/home/u/app'
    expect((await explorer.list('ssh://h/~/app', '', true))!.ok).toBe(true)
    expect(host().seen.find((s) => s.kind === 'root.open')!.body).toEqual({ path: '/home/u/app' })
    host().event(TREE_STREAM, 1, 'tree.changed', { revision: 2, path: [], added: [], updated: [], removed: [] })
    await until(() => changed.length === 1)
    expect(changed).toEqual(['ssh://h/~/app'])
    client.close()
  })

  it('the host’s connection ends: the sessions are let go; another root watched ends the first', async () => {
    const { explorer, client, host } = await setup()
    explorer.watch('ssh://h/srv/app', 'h', '/srv/app')
    await explorer.list('ssh://h/srv/app', '', true)
    explorer.closeHost('h')
    expect(explorer.served('ssh://h/srv/app')).toBe(false)
    await until(() => host().seen.some((s) => s.kind === 'tree.unsubscribe'))
    // Listed again: a new tree (the daemon may be back).
    expect((await explorer.list('ssh://h/srv/app', '', true))!.ok).toBe(true)
    explorer.watch('ssh://h/srv/other', 'h', '/srv/other')
    expect(explorer.served('ssh://h/srv/app')).toBe(false)
    await until(() => host().seen.filter((s) => s.kind === 'tree.unsubscribe').length === 2)
    explorer.unwatchAll()
    client.close()
  })
})
