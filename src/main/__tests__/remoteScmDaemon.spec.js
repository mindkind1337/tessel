// The Changes tab over tessel-host: the porcelain v2 text rebuilt from the
// daemon's status cache (host/remote.ts porcelainV2) is what
// sourceControl.js's reader (parseStatusV2) expects: the same entries as
// git's own output, headers included.
import { describe, it, expect } from 'vitest'
import { porcelainV2 } from '../host/remote'
import { parseStatusV2, capStatusEntries } from '../sourceControl'

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64')
const entry = (rel, over) => [rel, { path: rel.split('/').map(b64), kind: 'changed', xy: '.M', sub: 'N...', record: '1 .M N... 100644 100644 100644 aaaa bbbb', untracked_dir: false, ...over }]

describe('porcelain v2 from the daemon cache', () => {
  it('headers, a change in the index and on disk, a rename with its original path, a conflict, an untracked folder', () => {
    const entries = [
      entry('src/a.js', { xy: 'MM', record: '1 MM N... 100644 100644 100644 aaaa bbbb' }),
      entry('src/b.js'),
      entry('new name.txt', { kind: 'renamed', xy: 'R.', record: '2 R. N... 100644 100644 100644 cccc dddd R100', orig_path: ['old name.txt'].map(b64) }),
      entry('conflict.txt', { kind: 'unmerged', xy: 'UU', record: 'u UU N... 100644 100644 100644 100644 e1 e2 e3' }),
      entry('tmp', { kind: 'untracked', xy: '??', record: '?', untracked_dir: true }),
      entry('loose.txt', { kind: 'untracked', xy: '??', record: '?' })
    ]
    const text = porcelainV2(entries, { head: 'main', oid: 'f'.repeat(40), upstream: 'origin/main', ahead: 2, behind: 1 }, true)
    expect(text.startsWith('# branch.oid ' + 'f'.repeat(40) + '\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +2 -1\0')).toBe(true)
    const info = parseStatusV2(text)
    expect(info).toMatchObject({ branch: 'main', oid: 'f'.repeat(40), upstream: 'origin/main', ahead: 2, behind: 1, hasAb: true })
    expect(info.entries).toEqual([
      { path: 'src/a.js', area: 'staged', status: 'modified' },
      { path: 'src/a.js', area: 'unstaged', status: 'modified' },
      { path: 'src/b.js', area: 'unstaged', status: 'modified' },
      { path: 'new name.txt', oldPath: 'old name.txt', area: 'staged', status: 'renamed' },
      { path: 'conflict.txt', area: 'unstaged', status: 'modified', conflict: true, conflictStatus: 'unresolved', conflictKind: expect.any(String) },
      { path: 'tmp/', area: 'untracked', status: 'untracked' },
      { path: 'loose.txt', area: 'untracked', status: 'untracked' }
    ])
    expect(capStatusEntries(info.entries).truncated).toBe(false)
  })

  it('no branch headers when not asked; a detached head and no upstream; an empty cache is an empty text', () => {
    expect(porcelainV2([], undefined, false)).toBe('')
    const text = porcelainV2([entry('x')], { head: '(detached)', oid: '1'.repeat(40) }, true)
    const info = parseStatusV2(text)
    expect(info.branch).toBeNull()
    expect(info.upstream).toBeNull()
    expect(info.hasAb).toBe(false)
    expect(parseStatusV2(porcelainV2([entry('x')], undefined, false)).entries).toHaveLength(1)
    // No repository state yet: initial.
    expect(parseStatusV2(porcelainV2([], undefined, true)).oid).toBeNull()
  })

  it('a record that is not git’s own line head (kind, field count, control characters) is left out; a branch value that is not plain text gives no text at all', () => {
    const text = porcelainV2(
      [entry('a'), entry('b', { record: '1 .M N... 100644' }), entry('c', { record: 'x .M N... 100644 100644 100644 aaaa bbbb' }), entry('d', { record: '1 .M\u0000N... 100644 100644 100644 aaaa bbbb' })],
      undefined,
      false
    )
    expect(parseStatusV2(text).entries.map((e) => e.path)).toEqual(['a'])
    expect(porcelainV2([entry('a')], { head: 'ma\u001bin', oid: '1'.repeat(40) }, true)).toBeNull()
    // Without headers asked, the branch is not looked at.
    expect(porcelainV2([entry('a')], { head: 'ma\u001bin', oid: '1'.repeat(40) }, false)).not.toBeNull()
  })

  it('ahead/behind only when git gave them (an upstream that is gone has none); a rename without a usable original path is left out', () => {
    const gone = parseStatusV2(porcelainV2([], { head: 'main', oid: '1'.repeat(40), upstream: 'origin/main' }, true))
    expect(gone.upstream).toBe('origin/main')
    expect(gone.hasAb).toBe(false)
    const text = porcelainV2([entry('kept.txt', { kind: 'renamed', xy: 'R.', record: '2 R. N... 100644 100644 100644 cccc dddd R100', orig_path: ['bad\\name'].map(b64) }), entry('ok.txt')], undefined, false)
    expect(parseStatusV2(text).entries.map((e) => e.path)).toEqual(['ok.txt'])
  })

  it('a path with a control character or a backslash is left out (never reaches the window)', () => {
    const text = porcelainV2([entry('bad\\name'), entry('bad\nname'), entry('fine.txt')], undefined, false)
    expect(parseStatusV2(text).entries.map((e) => e.path)).toEqual(['fine.txt'])
  })
})
