// @vitest-environment node
// The Changes tab's list on a huge tree (2026-10-25, a FiveM server's
// resources folder): tens of thousands of untracked files went to the window,
// which drew every row and grew by 7 GB in a minute until it froze. The list
// now holds at most STATUS_ENTRIES_MAX changes, and a remote project lists an
// untracked folder once ("dir/").
import { describe, it, expect, vi } from 'vitest'
import { capStatusEntries, createScm, STATUS_ENTRIES_MAX } from '../sourceControl'

const untracked = (n, dir = 'cache') => Array.from({ length: n }, (_, i) => ({ path: `${dir}/f${i}.bin`, area: 'untracked', status: 'untracked' }))

describe('capStatusEntries', () => {
  it('keeps a list that fits as it is', () => {
    const list = [{ path: 'a.js', area: 'unstaged', status: 'modified' }, ...untracked(3)]
    expect(capStatusEntries(list, 10)).toEqual({ entries: list, total: 4, truncated: false })
  })

  it('cut short: changes to tracked files and conflicts first, then untracked ones, in git order', () => {
    const list = [
      ...untracked(3, 'a'),
      { path: 'm.js', area: 'unstaged', status: 'modified' },
      { path: 's.js', area: 'staged', status: 'added' },
      { path: 'c.js', area: 'unstaged', status: 'modified', conflict: true },
      ...untracked(3, 'z')
    ]
    const out = capStatusEntries(list, 5)
    expect(out.truncated).toBe(true)
    expect(out.total).toBe(9)
    expect(out.entries.map((e) => e.path)).toEqual(['a/f0.bin', 'a/f1.bin', 'm.js', 's.js', 'c.js'])
  })

  it('more tracked changes than the cap: only those', () => {
    const tracked = Array.from({ length: 4 }, (_, i) => ({ path: `t${i}.js`, area: 'unstaged', status: 'modified' }))
    const out = capStatusEntries([...untracked(2), ...tracked], 3)
    expect(out.entries.map((e) => e.path)).toEqual(['t0.js', 't1.js', 't2.js'])
  })
})

// A backend answering git from a table (sourceControl.js createScm).
function backend({ statusOut, untrackedFiles } = {}) {
  const calls = []
  const b = {
    ...(untrackedFiles ? { untrackedFiles } : {}),
    git: vi.fn(async (_top, args) => {
      calls.push(args)
      if (args[0] === 'status') return { ok: true, stdout: statusOut }
      return { ok: true, stdout: '' }
    }),
    repoOf: async () => ({ top: '/repo' }),
    relIn: (_top, p) => (typeof p === 'string' && p && !p.includes('..') ? p.replace(/\/+$/, '') : null),
    key: (top) => top,
    present: (top) => top,
    fullPath: (top, rel) => `${top}/${rel}`,
    operation: async () => null,
    untracked: vi.fn(async (_top, rels) => new Map(rels.map((r) => [r, { added: 1 }]))),
    prepareTrash: vi.fn((_top, rels) => ({ targets: rels })),
    trash: vi.fn(async (_top, targets) => ({ trashed: targets.length })),
    working: async () => ({ exists: false, version: { text: '' } })
  }
  return { b, calls }
}
const statusArgs = (calls) => calls.find((a) => a[0] === 'status')

describe("the Changes tab's status", () => {
  it(`holds at most ${STATUS_ENTRIES_MAX} changes and says how many there are`, async () => {
    const recs = ['# branch.oid abc', '# branch.head main', '1 .M N... 100644 100644 100644 aa bb src/a.js', '1 M. N... 100644 100644 100644 aa bb src/b.js']
    for (let i = 0; i < STATUS_ENTRIES_MAX + 1000; i++) recs.push(`? cache/f${i}.bin`)
    const { b } = backend({ statusOut: recs.join('\0') + '\0' })
    const st = await createScm(b).scmStatus({ root: '/repo' })
    expect(st.ok).toBe(true)
    expect(st.truncated).toBe(true)
    expect(st.totalEntries).toBe(STATUS_ENTRIES_MAX + 1002)
    expect(st.entries).toHaveLength(STATUS_ENTRIES_MAX)
    expect(st.entries.slice(0, 2).map((e) => [e.path, e.area])).toEqual([['src/a.js', 'unstaged'], ['src/b.js', 'staged']])
    // Line counts only for the untracked files listed.
    expect(b.untracked.mock.calls[0][1]).toHaveLength(STATUS_ENTRIES_MAX - 2)
  })

  it('a list that fits says nothing more', async () => {
    const { b } = backend({ statusOut: '# branch.head main\0? n.txt\0' })
    const st = await createScm(b).scmStatus({ root: '/repo' })
    expect(st.entries.map((e) => e.path)).toEqual(['n.txt'])
    expect(st).not.toHaveProperty('truncated')
    expect(st).not.toHaveProperty('totalEntries')
  })

  it('a local repository lists every untracked file; a backend asking for it lists a folder once', async () => {
    const local = backend({ statusOut: '' })
    await createScm(local.b).scmStatus({ root: '/repo' })
    expect(statusArgs(local.calls)).toContain('--untracked-files=all')
    const remote = backend({ statusOut: '', untrackedFiles: 'normal' })
    await createScm(remote.b).scmStatus({ root: '/repo' })
    expect(statusArgs(remote.calls)).toContain('--untracked-files=normal')
    expect(statusArgs(remote.calls)).not.toContain('--untracked-files=all')
  })

  it('discarding an untracked folder listed once ("dir/") finds it and moves it to the trash', async () => {
    const { b, calls } = backend({ statusOut: '? cache/\0? n.txt\0', untrackedFiles: 'normal' })
    const res = await createScm(b).scmDiscard({ root: '/repo', paths: ['cache/'] }, () => {})
    expect(res).toEqual({ ok: true, restored: 0, trashed: 1 })
    expect(b.trash.mock.calls[0][1]).toEqual(['cache'])
    // The same mode as the list, so "cache/" is there to be found.
    expect(statusArgs(calls)).toContain('--untracked-files=normal')
  })
})
