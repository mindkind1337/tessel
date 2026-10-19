// Live Share phase 2 on the guest's side (src/main/liveShare/guestFs.js): a
// shared path becomes { project, rel } for the host, the host's answer comes
// back in the local handlers' shape, and a host answer that does not fit
// (names with separators, absolute paths, sizes past the limits, unknown
// shapes) is refused whole. What would act on the guest's computer is
// refused for a shared path, and a save too large for a guest message never
// leaves.
import { describe, it, expect, vi } from 'vitest'
import { createGuestFs, checkEntries, checkRels, checkScmEntries, textWithin, failure, refusesLocal, LOCAL_ONLY_ACTIONS } from '../liveShare/guestFs'
import { LSHARE_LIMITS } from '../../shared/liveSharePath'

const ROOT = 'lshare://p1'
const HASH = 'a'.repeat(64)
// A fake host: answer(op, project, args) gives the data (or a whole answer).
function host(answer) {
  const calls = []
  const request = vi.fn(async (op, project, args) => {
    calls.push({ op, project, args })
    const out = await answer(op, project, args)
    return out && Object.hasOwn(out, 'ok') ? out : { ok: true, data: out }
  })
  return { fs: createGuestFs({ request }), calls, request }
}

describe('checking host answers', () => {
  it('takes names a guest can address, each once', () => {
    expect(checkEntries([{ name: 'a.js', dir: false }, { name: 'src', dir: true, link: true }])).toEqual([{ name: 'a.js', dir: false }, { name: 'src', dir: true, link: true }])
    for (const name of ['a/b', 'a\\b', '..', '.', 'C:', 'x:y', 'nul', 'trail.', '', 'a\u0000b', 'x'.repeat(256)]) expect(checkEntries([{ name, dir: false }]), name).toBe(null)
    expect(checkEntries([{ name: 'A', dir: false }, { name: 'a', dir: false }])).toBe(null)
    expect(checkEntries('nope')).toBe(null)
    expect(checkEntries(Array.from({ length: LSHARE_LIMITS.entries + 1 }, (_, i) => ({ name: `f${i}` })))).toBe(null)
  })

  it('takes relative paths only', () => {
    expect(checkRels(['a/b.js', 'c'], 10)).toEqual(['a/b.js', 'c'])
    for (const bad of [['C:\\x'], ['/etc/passwd'], ['a/../b'], ['\\\\srv\\share'], ['a\\b'], [''], [3]]) expect(checkRels(bad, 10), JSON.stringify(bad)).toBe(null)
    expect(checkRels(['a', 'b'], 1)).toBe(null)
    expect(checkScmEntries([{ path: 'src/a.js', area: 'staged', status: 'modified', added: 1, removed: null, extra: 'C:\\x' }])).toEqual([{ path: 'src/a.js', area: 'staged', status: 'modified', added: 1, removed: null }])
    expect(checkScmEntries([{ path: 'C:/repo/src/a.js' }])).toBe(null)
    expect(checkScmEntries([{ path: 'a.js', oldPath: '../b.js' }])).toBe(null)
  })

  it('bounds texts by their bytes', () => {
    expect(textWithin('abc', 3)).toBe(true)
    expect(textWithin('\u00e9\u00e9', 3)).toBe(false)
    expect(textWithin(5, 10)).toBe(false)
  })

  it('words errors itself, with git words cleaned', () => {
    expect(failure('not-found')).toMatchObject({ ok: false, code: 'not-found', error: 'Not found on the host.' })
    expect(failure('made-up').code).toBe('failed')
    expect(failure('conflict').conflict).toBe(true)
    const git = failure('git', `fatal: bad\u001b[31m thing\n${'x'.repeat(500)}`)
    expect(git.error.startsWith('Git failed on the host: fatal: bad')).toBe(true)
    // eslint-disable-next-line no-control-regex -- control characters are what it checks
    expect(git.error).not.toMatch(/[\u0000-\u001f]/)
    expect(git.error.length).toBeLessThan(400)
  })
})

describe('the guest handlers', () => {
  it('sends relative paths and builds the views paths itself', async () => {
    const h = host((op) => (op === 'fs.list' ? { entries: [{ name: 'a.js', dir: false, path: 'C:\\evil\\a.js' }, { name: 'src', dir: true }], truncated: false, hidden: 2 } : null))
    const res = await h.fs.listDir({ root: ROOT, dir: 'lshare://p1\\src' })
    expect(h.calls).toEqual([{ op: 'fs.list', project: 'p1', args: { dir: 'src', dotfiles: true } }])
    expect(res).toEqual({
      ok: true,
      entries: [
        { name: 'a.js', path: 'lshare://p1\\src\\a.js', dir: false },
        { name: 'src', path: 'lshare://p1\\src\\src', dir: true }
      ],
      truncated: false,
      hidden: 2
    })
  })

  it('never sends a path of another project or a local one', async () => {
    const h = host(() => ({}))
    expect((await h.fs.listDir({ root: ROOT, dir: 'lshare://p2\\src' })).code).toBe('outside')
    expect((await h.fs.listDir({ root: ROOT, dir: 'C:\\Users' })).code).toBe('outside')
    expect((await h.fs.readForEdit('lshare://p1\\..\\x')).code).toBe('outside')
    expect((await h.fs.readForEdit('C:\\Windows\\win.ini')).code).toBe('outside')
    expect((await h.fs.scm.scmStage({ root: ROOT, paths: ['src/a.js', 'C:\\x'] })).code).toBe('outside')
    expect((await h.fs.scm.scmStage({ root: ROOT, paths: ['lshare://p2\\a'] })).code).toBe('outside')
    expect(h.request).not.toHaveBeenCalled()
  })

  it('refuses a host answer that does not fit, as a whole', async () => {
    const cases = [
      ['fs.list', { entries: [{ name: '..\\..\\Windows', dir: true }] }, (fs) => fs.listDir({ root: ROOT })],
      ['fs.list', { entries: 'x' }, (fs) => fs.listDir({ root: ROOT })],
      ['fs.read', { text: 'x'.repeat(LSHARE_LIMITS.textBytes + 1), hash: HASH }, (fs) => fs.readForEdit('lshare://p1\\a.js')],
      ['fs.read', { text: 'ok', hash: 'not-a-hash' }, (fs) => fs.readForEdit('lshare://p1\\a.js')],
      ['fs.searchNames', { results: [{ rel: 'C:/Users/me/x' }] }, (fs) => fs.searchNames({ root: ROOT, query: 'x' })],
      ['fs.searchContent', { results: [{ rel: 'a.js', line: 0, text: 'x' }] }, (fs) => fs.searchContent({ root: ROOT, query: 'x' })],
      ['fs.fileList', { files: ['ok.js', '/etc/passwd'] }, (fs) => fs.listProjectFiles(ROOT)],
      ['fs.status', { repo: true, files: { 'C:\\x': 'M' } }, (fs) => fs.projectStatus({ root: ROOT })],
      ['fs.status', { repo: true, files: { 'a.js': 'Z' } }, (fs) => fs.projectStatus({ root: ROOT })],
      ['fs.image', { dataUrl: 'data:text/html;base64,PHNjcmlwdD4=' }, (fs) => fs.readImage('lshare://p1\\a.png')],
      ['fs.image', { dataUrl: 'javascript:alert(1)' }, (fs) => fs.readImage('lshare://p1\\a.png')],
      ['fs.create', { rel: '../escape' }, (fs) => fs.create({ root: ROOT, dir: ROOT, name: 'n.txt' })],
      ['scm.status', { repo: true, entries: [{ path: '/abs/a.js' }] }, (fs) => fs.scm.scmStatus({ root: ROOT })],
      ['scm.history', { items: [{ id: 'not a commit' }] }, (fs) => fs.scm.scmHistory({ root: ROOT })],
      ['scm.versions', { original: 'x'.repeat(LSHARE_LIMITS.textBytes + 1), modified: '' }, (fs) => fs.scm.scmFileVersions({ root: ROOT, path: 'a.js', area: 'unstaged' })],
      ['fs.listMany', { results: [{ dir: '../up', ok: true, entries: [] }] }, (fs) => fs.listMany({ root: ROOT, dirs: [ROOT] })],
      ['notes.load', { exists: true, text: 'x'.repeat(LSHARE_LIMITS.notesBytes + 1) }, (fs) => fs.loadNotes({ dir: ROOT })]
    ]
    for (const [op, data, run] of cases) {
      const h = host(() => data)
      const res = await run(h.fs)
      expect(res, `${op} ${JSON.stringify(data).slice(0, 80)}`).toMatchObject({ ok: false, code: 'bad-answer' })
    }
    // Not even an object, or not { ok, data }.
    for (const answer of [null, 'yes', { ok: true }, { ok: true, data: [1] }]) {
      const fs = createGuestFs({ request: async () => answer })
      expect((await fs.readForEdit('lshare://p1\\a.js')).code, JSON.stringify(answer)).toBe('bad-answer')
    }
  })

  it('keeps only the known fields of a fitting answer', async () => {
    const h = host((op) => {
      if (op === 'scm.status')
        return { repo: true, top: 'C:\\repo', branch: 'main', entries: [{ path: 'src/a.js', area: 'unstaged', status: 'modified', full: 'C:\\repo\\src\\a.js' }], hidden: 3 }
      if (op === 'scm.history') return { items: [{ id: 'a'.repeat(40), author: 'Ana', authorEmail: 'ana@example.com', subject: 's', message: 'm' }], hasMore: false }
      if (op === 'scm.fileHistory') return { items: [{ id: 'b'.repeat(40), author: 'Ana', email: 'ana@example.com', time: 1, message: 'm' }] }
      if (op === 'scm.commitInfo') return { stats: { files: 1, insertions: 2, deletions: 3 }, webUrl: 'javascript:alert(1)' }
      if (op === 'scm.branchCompare') return { base: 'origin/main', files: [], reviewUrl: 'https://github.com/a/b/compare/main...x' }
      return null
    })
    const st = await h.fs.scm.scmStatus({ root: ROOT })
    expect(st.top).toBe('lshare://p1')
    expect(st.entries).toEqual([{ path: 'src/a.js', area: 'unstaged', status: 'modified' }])
    expect(st.hidden).toBe(3)
    const hist = await h.fs.scm.scmHistory({ root: ROOT })
    expect(JSON.stringify(hist)).not.toContain('ana@example.com')
    const fh = await h.fs.scm.scmFileHistory({ root: ROOT, path: 'lshare://p1\\src\\a.js' })
    expect(fh.items[0].email).toBe('')
    expect(h.calls.find((c) => c.op === 'scm.fileHistory').args).toEqual({ path: 'src/a.js', limit: 50 })
    expect((await h.fs.scm.scmCommitInfo({ root: ROOT, commit: 'c'.repeat(40) })).webUrl).toBe(null)
    expect((await h.fs.scm.scmBranchCompare({ root: ROOT })).reviewUrl).toBe('https://github.com/a/b/compare/main...x')
  })

  it("a commit hash in a host's pane: asked through the history the host shares (scm.commitFiles), its full id only", async () => {
    const full = 'abc1234' + 'd'.repeat(33)
    const h = host((op, project, args) => (op === 'scm.commitFiles' ? { entries: [], commit: args.commit === 'abc1234' ? full : 'e'.repeat(40), parent: null } : null))
    expect(await h.fs.scm.scmResolveCommit({ root: ROOT, commit: 'abc1234' })).toEqual({ ok: true, id: full, subject: '', author: '', timestamp: null })
    expect(h.calls).toEqual([{ op: 'scm.commitFiles', project: 'p1', args: { commit: 'abc1234' } }])
    // Another commit back is no answer; a non-hash never leaves.
    expect((await h.fs.scm.scmResolveCommit({ root: ROOT, commit: 'fff1234' })).ok).toBe(false)
    for (const commit of ['--all', 'HEAD', 'a'.repeat(64)]) expect((await h.fs.scm.scmResolveCommit({ root: ROOT, commit })).ok).toBe(false)
    expect(h.calls).toHaveLength(2)
    // No right to the host's history: no link.
    const denied = host(() => ({ ok: false, code: 'forbidden' }))
    expect((await denied.fs.scm.scmResolveCommit({ root: ROOT, commit: 'abc1234' })).ok).toBe(false)
  })

  it('words the host codes, and reads a lost connection as no answer', async () => {
    const h = host(() => ({ ok: false, code: 'forbidden' }))
    expect(await h.fs.writeForEdit({ file: 'lshare://p1\\a.js', text: 'x', expectHash: HASH })).toMatchObject({ ok: false, code: 'forbidden', error: 'The host has not given you the right to do this.' })
    const odd = host(() => ({ ok: false, code: 'C:\\Users\\host', detail: 'x' }))
    expect((await odd.fs.readForEdit('lshare://p1\\a.js')).code).toBe('failed')
    const gone = createGuestFs({ request: async () => { throw new Error('closed') } })
    expect(await gone.readForEdit('lshare://p1\\a.js')).toMatchObject({ ok: false, code: 'offline', transient: true })
    const conflict = host(() => ({ ok: false, code: 'conflict' }))
    expect((await conflict.fs.writeForEdit({ file: 'lshare://p1\\a.js', text: 'x', expectHash: HASH })).conflict).toBe(true)
  })

  it('refuses a save too large for a guest message before sending it', async () => {
    const h = host(() => ({ size: 1, mtimeMs: 1, sig: '1:1', hash: HASH }))
    const big = 'x'.repeat(LSHARE_LIMITS.writeBytes + 1)
    expect((await h.fs.writeForEdit({ file: 'lshare://p1\\a.js', text: big })).code).toBe('too-large-to-send')
    expect((await h.fs.writeForEdit({ file: 'lshare://p1\\a.js', text: 'x'.repeat(LSHARE_LIMITS.writeBytes - 2), bom: true })).code).toBe('too-large-to-send')
    expect((await h.fs.saveNotes({ dir: ROOT, text: 'x'.repeat(LSHARE_LIMITS.notesBytes + 1) })).code).toBe('too-large-to-send')
    expect(h.request).not.toHaveBeenCalled()
    const ok = await h.fs.writeForEdit({ file: 'lshare://p1\\src\\a.js', text: 'hi', bom: false, expectHash: HASH })
    expect(ok).toEqual({ ok: true, size: 1, mtimeMs: 1, sig: '1:1', hash: HASH })
    expect(h.calls[0]).toEqual({ op: 'fs.write', project: 'p1', args: { path: 'src/a.js', text: 'hi', bom: false, expectHash: HASH } })
  })

  it('refuses what acts on this computer for a shared path', async () => {
    const h = host(() => ({}))
    for (const fn of ['scmPush', 'scmPull', 'scmFetch', 'scmSync', 'scmStagedDiff']) expect((await h.fs.scm[fn]({ root: ROOT })).code, fn).toBe('local-only')
    expect((await h.fs.readForView('lshare://p1\\doc.pdf')).code).toBe('local-only')
    expect(h.fs.localOnly()).toMatchObject({ ok: false, code: 'local-only', error: 'Not available for a project shared with you.' })
    expect(refusesLocal('lshare://p1\\a')).toBe(true)
    expect(refusesLocal('C:\\a')).toBe(false)
    expect(LOCAL_ONLY_ACTIONS).toEqual(expect.arrayContaining(['explorer:reveal', 'files:open', 'files:openPdf', 'scm:generate']))
    expect(h.request).not.toHaveBeenCalled()
  })

  it('maps changes, notes and the head note to the local shapes', async () => {
    const h = host((op) => {
      if (op === 'scm.discard') return { restored: 2, trashed: 1 }
      if (op === 'notes.load') return { exists: true, text: '# n', mtime: 5 }
      if (op === 'fs.head') return { repo: true, isNew: true, text: '', note: 'new-file' }
      if (op === 'fs.listMany') return { results: [{ dir: 'src', ok: true, entries: [{ name: 'only', dir: true }] }, { dir: 'src/only', ok: true, entries: [] }, { dir: 'gone', ok: false, code: 'not-found' }] }
      return {}
    })
    expect(await h.fs.scm.scmDiscard({ root: ROOT, paths: ['src/a.js', 'src\\b.js'] })).toEqual({ ok: true, restored: 2, trashed: 1 })
    expect(h.calls[0].args).toEqual({ paths: ['src/a.js', 'src/b.js'] })
    expect(await h.fs.loadNotes({ dir: ROOT })).toEqual({ ok: true, exists: true, path: 'lshare://p1\\.tessel\\notes.md', text: '# n', mtime: 5 })
    expect((await h.fs.headContent('lshare://p1\\a.js')).note).toBe('Not in the last commit (a new file): the left side is empty.')
    const many = await h.fs.listMany({ root: ROOT, dirs: ['lshare://p1/src', 'lshare://p1\\gone'], chain: true })
    expect(many.results.map((r) => r.dir)).toEqual(['lshare://p1/src', 'lshare://p1\\src\\only', 'lshare://p1\\gone'])
    expect(many.results[2]).toMatchObject({ ok: false, code: 'not-found' })
    expect(h.calls.find((c) => c.op === 'fs.listMany').args).toEqual({ dirs: ['src', 'gone'], dotfiles: true, chain: true })
  })
})
