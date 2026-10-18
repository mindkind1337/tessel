// Live Share phase 2's requests (src/main/liveShare/shareRequests.js) on a
// real temp repository whose top is above the shared project: every op
// answers with paths relative to the project only, never a host path or the
// host's own error text; hidden files are counted, not named; git's author
// emails and remote credentials never go out; each change needs its right
// (edit, git, and type for the files that run things), asked again right
// before it is made; a save checks the file did not change since the guest
// read it.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { execFileSync } from 'child_process'
import { createShareRequests, requiredRight, mayRun, parseArgs, fromTop, toTop, maskUrl, SHARE_OPS } from '../liveShare/shareRequests'
import { LSHARE_CODES } from '../../shared/liveSharePath'
import { hashOf } from '../editorFiles'

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 })

const g = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' }).toString()
const TOKEN = 'abcdefghijklmnop1234'
const EMAIL = 'author-secret@example.com'
let dir
let repo
let root
let outside
let requests
let trashed
const put = (base, rel, text = 'x') => {
  const p = join(base, ...rel.split('/'))
  fs.mkdirSync(join(p, '..'), { recursive: true })
  fs.writeFileSync(p, text)
  return p
}
const READ = { edit: false, git: false, type: false }
const EDIT = { edit: true }
const GIT = { git: true }
const ctx = (extra = {}) => ({ roots: { p1: root }, rights: READ, settings: {}, trashItem: async (p) => trashed.push(p), ...extra })
const ask = (op, args, extra) => requests.handle({ op, project: 'p1', args }, ctx(extra))

// No host path in any string of an answer (the temp folder, a drive, a share).
function hostPathsIn(value) {
  const found = []
  const needles = [dir, dir.replace(/\\/g, '/'), os.homedir()].map((s) => s.toLowerCase())
  const visit = (v) => {
    if (typeof v === 'string') {
      const low = v.toLowerCase()
      if (needles.some((n) => low.includes(n)) || /(?<![A-Za-z0-9])[A-Za-z]:[\\/]|\\\\[^\\\s]/.test(v)) found.push(v.slice(0, 200))
    } else if (Array.isArray(v)) v.forEach(visit)
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) visit(k), visit(x)
  }
  visit(value)
  return found
}

beforeEach(() => {
  dir = fs.realpathSync.native(fs.mkdtempSync(join(os.tmpdir(), 'tessel-lsreq-')))
  repo = join(dir, 'repo')
  root = join(repo, 'proj')
  outside = join(dir, 'outside')
  trashed = []
  requests = createShareRequests()
  put(outside, 'secret.txt', 'outside secret')
  fs.mkdirSync(root, { recursive: true })
  g(repo, 'init', '-q', '-b', 'main')
  g(repo, 'config', 'user.email', EMAIL)
  g(repo, 'config', 'user.name', 'Ana Author')
  g(repo, 'config', 'core.autocrlf', 'false')
  g(repo, 'remote', 'add', 'origin', 'https://bob:hunter2pass@github.com/acme/app.git')
  put(root, 'src/a.js', 'one\n')
  put(root, 'src/deep/only/x.js', 'deep\n')
  put(root, 'README.md', 'TOKEN_NEEDLE in readme\n')
  put(root, '.gitignore', 'dist/\n')
  put(root, '.tessel/notes.md', '# notes\n')
  put(repo, 'other/b.js', 'b\n')
  g(repo, 'add', '-A')
  g(repo, 'commit', '-q', '-m', 'first')
  // After the commit: untracked, ignored and hidden files.
  put(root, '.env', 'API_KEY=TOKEN_NEEDLE')
  put(root, 'dist/out.js', 'built TOKEN_NEEDLE')
  put(root, `.tessel/team/${TOKEN}/HOW-TO.md`, 'inbox TOKEN_NEEDLE')
  put(root, '.claude/settings.json', '{}')
  put(root, 'src/a.js', 'one\ntwo\n')
  put(repo, 'other/b.js', 'b changed\n')
  put(repo, 'other/new.js', 'new\n')
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('the op table', () => {
  it('names the right each op needs', () => {
    expect(requiredRight('fs.read')).toBe('view')
    expect(requiredRight('scm.status')).toBe('view')
    expect(requiredRight('fs.write')).toBe('edit')
    expect(requiredRight('notes.save')).toBe('edit')
    expect(requiredRight('fs.trash')).toBe('edit')
    for (const op of ['scm.stage', 'scm.unstage', 'scm.discard', 'scm.commit']) expect(requiredRight(op)).toBe('git')
    expect(requiredRight('scm.push')).toBe(null)
    expect(requiredRight('__proto__')).toBe(null)
    expect(mayRun('fs.read', null)).toBe(true)
    expect(mayRun('fs.write', { edit: 'true' })).toBe(false)
    expect(mayRun('fs.write', { edit: true })).toBe(true)
    expect(mayRun('scm.commit', { edit: true })).toBe(false)
    expect(mayRun('scm.commit', { git: true })).toBe(true)
    expect(mayRun('nope', { edit: true, git: true })).toBe(false)
    for (const [op, spec] of Object.entries(SHARE_OPS)) {
      expect(['view', 'edit', 'git'], op).toContain(spec.right)
      expect(['light', 'heavy', 'write'], op).toContain(spec.kind)
      expect(spec.kind === 'write', op).toBe(spec.right !== 'view')
    }
  })

  it('takes only the exact argument shapes', () => {
    const schema = { path: (v) => (typeof v === 'string' ? { ok: true, value: v } : { ok: false }) }
    expect(parseArgs(schema, { path: 'a', extra: 1 })).toEqual({ path: 'a' })
    expect(parseArgs(schema, ['a'])).toBe(null)
    expect(parseArgs(schema, 'a')).toBe(null)
    expect(parseArgs(schema, {})).toBe(null)
  })

  it('maps git paths between the top and the project', () => {
    const place = { prefix: 'proj' }
    expect(fromTop(place, 'proj/src/a.js')).toBe('src/a.js')
    expect(fromTop(place, 'PROJ/src/a.js')).toBe('src/a.js')
    expect(fromTop(place, 'other/b.js')).toBe(null)
    expect(fromTop(place, 'project/x')).toBe(null)
    expect(fromTop(place, 'proj')).toBe(null)
    expect(fromTop({ prefix: '' }, 'a/b')).toBe('a/b')
    expect(toTop(place, 'src/a.js')).toBe('proj/src/a.js')
  })

  it('masks web addresses', () => {
    expect(maskUrl('https://bob:pw@github.com/acme/app/compare/main...x')).toBe('https://github.com/acme/app/compare/main...x')
    expect(maskUrl('javascript:alert(1)')).toBe(null)
    expect(maskUrl('file:///C:/x')).toBe(null)
    expect(maskUrl(42)).toBe(null)
  })
})

describe('refusals', () => {
  it('refuses unknown ops, bad arguments, other projects', async () => {
    expect(await requests.handle({ op: 'scm.push', project: 'p1', args: {} }, ctx())).toEqual({ ok: false, code: 'bad-op' })
    expect(await requests.handle({ op: 'toString', project: 'p1' }, ctx())).toEqual({ ok: false, code: 'bad-op' })
    expect(await requests.handle(null, ctx())).toEqual({ ok: false, code: 'bad-op' })
    for (const path of [root + '\\src\\a.js', 'C:/Windows/win.ini', '../other/b.js', 'src/../../other/b.js', '\\\\localhost\\c$\\x', 'src\\a.js', '', 'a.js::$DATA', 'nul', 7])
      expect(await ask('fs.read', { path }), String(path)).toEqual({ ok: false, code: 'bad-args' })
    expect(await requests.handle({ op: 'fs.read', project: 'p2', args: { path: 'README.md' } }, ctx())).toEqual({ ok: false, code: 'remote-project' })
    expect(await requests.handle({ op: 'fs.read', project: '__proto__', args: { path: 'README.md' } }, ctx())).toEqual({ ok: false, code: 'remote-project' })
    // Not a project id at all: not the guest's.
    expect(await requests.handle({ op: 'fs.read', project: '../x', args: { path: 'README.md' } }, ctx())).toEqual({ ok: false, code: 'no-project' })
    expect(await requests.handle({ op: 'fs.read', project: 'p1', args: { path: 'README.md' } }, ctx({ roots: { p1: 'ssh://ssh-1/x' } }))).toEqual({ ok: false, code: 'remote-project' })
    expect((await requests.handle({ op: 'fs.read', project: 'p1', args: { path: 'README.md' } }, ctx({ roots: new Map([['p1', root]]) }))).ok).toBe(true)
  })

  it('never forwards the host error text: fixed codes only', async () => {
    expect(await ask('fs.read', { path: 'src/gone.js' })).toEqual({ ok: false, code: 'not-found' })
    expect(await ask('fs.read', { path: 'src' })).toEqual({ ok: false, code: 'not-file' })
    expect(await ask('fs.list', { dir: 'src/a.js' })).toEqual({ ok: false, code: 'not-found' })
    expect(await ask('fs.create', { dir: 'src', name: 'a.js' }, { rights: EDIT })).toEqual({ ok: false, code: 'exists' })
    expect(await ask('fs.rename', { path: 'src/a.js', name: 'deep' }, { rights: EDIT })).toEqual({ ok: false, code: 'exists' })
    expect(await ask('scm.commitFiles', { commit: 'deadbeefdeadbeef' })).toEqual({ ok: false, code: 'bad-commit' })
    expect(await ask('scm.commit', { message: '  ' }, { rights: GIT })).toEqual({ ok: false, code: 'no-message' })
    expect(await ask('scm.commit', { message: 'x' }, { rights: GIT })).toEqual({ ok: false, code: 'nothing-staged' })
    // git's own words go out only with the paths hidden: an index lock.
    fs.writeFileSync(join(repo, '.git', 'index.lock'), '')
    const res = await ask('scm.stage', { paths: ['src/a.js'] }, { rights: GIT })
    expect(res.ok).toBe(false)
    expect(res.code).toBe('git')
    expect(res.detail.length).toBeLessThanOrEqual(300)
    expect(hostPathsIn(res)).toEqual([])
    for (const r of [res]) expect(LSHARE_CODES).toContain(r.code)
  })
})

describe('reading', () => {
  it('answers every read op with project-relative paths only', async () => {
    const answers = {
      list: await ask('fs.list', { dir: '' }),
      listMany: await ask('fs.listMany', { dirs: ['', 'src/deep'], chain: true }),
      names: await ask('fs.searchNames', { query: 'a' }),
      content: await ask('fs.searchContent', { query: 'TOKEN_NEEDLE' }),
      files: await ask('fs.fileList', {}),
      status: await ask('fs.status', {}),
      read: await ask('fs.read', { path: 'src/a.js' }),
      stat: await ask('fs.stat', { path: 'src/a.js' }),
      head: await ask('fs.head', { path: 'src/a.js' }),
      notes: await ask('notes.load', {}),
      scm: await ask('scm.status', {}),
      versions: await ask('scm.versions', { path: 'src/a.js', area: 'unstaged' }),
      history: await ask('scm.history', { limit: 10 }),
      fileHistory: await ask('scm.fileHistory', { path: 'src/a.js' }),
      compare: await ask('scm.branchCompare', {})
    }
    const head = answers.history.data.items[0].id
    answers.commitFiles = await ask('scm.commitFiles', { commit: head })
    answers.commitInfo = await ask('scm.commitInfo', { commit: head })
    for (const [name, res] of Object.entries(answers)) {
      expect(res.ok, `${name}: ${JSON.stringify(res)}`).toBe(true)
      expect(hostPathsIn(res), name).toEqual([])
      const text = JSON.stringify(res)
      expect(text.includes(EMAIL), name).toBe(false)
      expect(text.includes('hunter2pass'), name).toBe(false)
      expect(text.includes(TOKEN), name).toBe(false)
      expect(/"top"|"full"|"authorEmail"|"email"/.test(text), name).toBe(false)
    }
    expect(answers.read.data.text).toBe('one\ntwo\n')
    expect(answers.read.data.readOnly).toBe(true)
    expect(answers.head.data.text).toBe('one\n')
    expect(answers.versions.data).toMatchObject({ original: 'one\n', modified: 'one\ntwo\n', rel: 'src/a.js' })
    expect(answers.history.data.items[0].author).toBe('Ana Author')
    expect(answers.fileHistory.data.items[0].author).toBe('Ana Author')
    expect(answers.commitFiles.data.entries.map((e) => e.path).sort()).toEqual(['.gitignore', '.tessel/notes.md', 'README.md', 'src/a.js', 'src/deep/only/x.js'])
    expect(answers.commitInfo.data.webUrl).toBe(`https://github.com/acme/app/commit/${head}`)
    // listMany followed src/deep's sole sub-folder.
    expect(answers.listMany.data.results.map((r) => r.dir)).toEqual(['', 'src/deep', 'src/deep/only'])
  })

  it('lists a folder without what is hidden, and counts it', async () => {
    const res = await ask('fs.list', { dir: '' })
    const names = res.data.entries.map((e) => e.name)
    expect(names).toEqual(expect.arrayContaining(['src', '.tessel', '.gitignore', 'README.md']))
    expect(names).not.toContain('.env')
    expect(names).not.toContain('dist')
    expect(res.data.hidden).toBeGreaterThanOrEqual(2)
    const tessel = await ask('fs.list', { dir: '.tessel' })
    expect(tessel.data.entries.map((e) => e.name)).toEqual(['notes.md'])
    expect(await ask('fs.read', { path: `.tessel/team/${TOKEN}/HOW-TO.md` })).toEqual({ ok: false, code: 'not-found' })
    expect(await ask('fs.list', { dir: '.tessel/team' })).toEqual({ ok: false, code: 'not-found' })
    expect((await ask('fs.read', { path: '.tessel/notes.md' })).data.text).toBe('# notes\n')
    // The share's setting off: ignored and secret files show, .git and the
    // team folder never.
    const all = await ask('fs.list', { dir: '' }, { settings: { hideIgnored: false } })
    expect(all.data.entries.map((e) => e.name)).toEqual(expect.arrayContaining(['.env', 'dist']))
    expect((await ask('fs.read', { path: '.env' }, { settings: { hideIgnored: false } })).data.text).toBe('API_KEY=TOKEN_NEEDLE')
    const top = await requests.handle({ op: 'fs.list', project: 'p1', args: {} }, ctx({ roots: { p1: repo }, settings: { hideIgnored: false } }))
    expect(top.data.entries.map((e) => e.name)).not.toContain('.git')
    expect((await requests.handle({ op: 'fs.read', project: 'p1', args: { path: '.git/config' } }, ctx({ roots: { p1: repo }, settings: { hideIgnored: false } }))).code).toBe('not-found')
  })

  it('never lists or reads through a junction out of the project', async () => {
    fs.symlinkSync(outside, join(root, 'link'), 'junction')
    const res = await ask('fs.list', { dir: '' })
    expect(res.data.entries.map((e) => e.name)).not.toContain('link')
    expect(await ask('fs.read', { path: 'link/secret.txt' })).toEqual({ ok: false, code: 'not-found' })
    expect(await ask('fs.list', { dir: 'link' })).toEqual({ ok: false, code: 'not-found' })
    fs.symlinkSync(join(root, 'src'), join(root, 'inside'), 'junction')
    const again = await ask('fs.list', { dir: '' })
    expect(again.data.entries.find((e) => e.name === 'inside')).toEqual({ name: 'inside', dir: true, link: true })
    expect((await ask('fs.read', { path: 'inside/a.js' })).data.text).toBe('one\ntwo\n')
  })

  it('filters searches and the file list, naming nothing hidden', async () => {
    const names = await ask('fs.searchNames', { query: 'HOW-TO' })
    expect(names.data.results).toEqual([])
    // Hidden names are never counted (that would tell they are there).
    expect(names.data.hidden).toBe(0)
    const content = await ask('fs.searchContent', { query: 'TOKEN_NEEDLE' })
    expect(content.data.results.map((r) => r.rel)).toEqual(['README.md'])
    const files = await ask('fs.fileList', {})
    expect(files.data.files).toEqual(expect.arrayContaining(['src/a.js', '.tessel/notes.md', 'README.md']))
    for (const f of files.data.files) expect(/^\.env$|^dist\/|\.tessel\/team|^other\//.test(f), f).toBe(false)
  })

  it('shows a repository above the project as the project alone, relative to it', async () => {
    const st = await ask('scm.status', {})
    expect(st.data.repo).toBe(true)
    const paths = st.data.entries.map((e) => e.path)
    expect(paths).toContain('src/a.js')
    expect(paths.some((p) => p.startsWith('other') || p.startsWith('proj/'))).toBe(false)
    // .env (untracked, not ignored) and the team inbox are counted, not named.
    expect(paths).not.toContain('.env')
    expect(paths.some((p) => p.startsWith('.tessel/team'))).toBe(false)
    expect(st.data.hidden).toBeGreaterThanOrEqual(2)
    const letters = await ask('fs.status', {})
    expect(Object.keys(letters.data.files)).toContain('src/a.js')
    expect(Object.keys(letters.data.files).some((p) => p.startsWith('other') || p === '.env')).toBe(false)
    // The branch's line totals would count the rest of the repository: none.
    g(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
    g(repo, 'checkout', '-q', '-b', 'feature')
    put(root, 'src/f.js', 'f\n')
    put(repo, 'other/g.js', 'g\n')
    g(repo, 'add', '-A')
    g(repo, 'commit', '-q', '-m', 'feature work')
    const cmp = await ask('scm.branchCompare', {})
    expect(cmp.data.base).toBe('origin/main')
    expect(cmp.data.files.map((f) => f.path).sort()).toEqual(expect.arrayContaining(['src/f.js']))
    expect(cmp.data.files.some((f) => /^other|^proj\//.test(f.path))).toBe(false)
    expect(cmp.data.added).toBe(null)
    expect(hostPathsIn(cmp)).toEqual([])
    expect(JSON.stringify(cmp).includes('hunter2pass')).toBe(false)
  })
})

describe('changes', () => {
  it('needs the edit right to save, create, rename or trash, and the git right for git', async () => {
    expect(await ask('fs.write', { path: 'src/a.js', text: 'x', expectHash: hashOf(Buffer.from('one\ntwo\n')) })).toEqual({ ok: false, code: 'forbidden' })
    expect(await ask('fs.create', { dir: '', name: 'n.txt' })).toEqual({ ok: false, code: 'forbidden' })
    expect(await ask('fs.trash', { path: 'README.md' }, { rights: GIT })).toEqual({ ok: false, code: 'forbidden' })
    expect(await ask('notes.save', { text: 'x', baseMtime: 1 })).toEqual({ ok: false, code: 'forbidden' })
    expect(await ask('scm.stage', { paths: ['src/a.js'] }, { rights: { edit: true, type: true } })).toEqual({ ok: false, code: 'forbidden' })
    expect(await ask('scm.commit', { message: 'm' }, { rights: EDIT })).toEqual({ ok: false, code: 'forbidden' })
    expect(await ask('scm.discard', { paths: ['src/a.js'] }, { rights: EDIT })).toEqual({ ok: false, code: 'forbidden' })
    expect(g(repo, 'status', '--porcelain')).toContain(' M proj/src/a.js')
    // With the git right: staged, committed.
    expect(await ask('scm.stage', { paths: ['src/a.js'] }, { rights: GIT })).toEqual({ ok: true, data: { count: 1 } })
    expect(g(repo, 'status', '--porcelain')).toContain('M  proj/src/a.js')
    expect(await ask('scm.unstage', { paths: ['src/a.js'] }, { rights: GIT })).toEqual({ ok: true, data: { count: 1 } })
    await ask('scm.stage', { paths: ['src/a.js'] }, { rights: GIT })
    const c = await ask('scm.commit', { message: 'guest commit' }, { rights: GIT })
    expect(c.ok).toBe(true)
    expect(g(repo, 'log', '-1', '--format=%s')).toContain('guest commit')
    expect(g(repo, 'rev-parse', 'HEAD').trim()).toBe(c.data.sha)
  })

  it('never stages, discards or names a hidden file', async () => {
    expect(await ask('scm.stage', { paths: ['.env'] }, { rights: GIT })).toEqual({ ok: false, code: 'not-found' })
    expect(await ask('scm.stage', { paths: [`.tessel/team/${TOKEN}/HOW-TO.md`] }, { rights: GIT })).toEqual({ ok: false, code: 'not-found' })
    // A hidden file named with a visible one: only the visible one.
    put(root, 'src/new.txt', 'n')
    expect(await ask('scm.discard', { paths: ['src/new.txt', '.env'] }, { rights: GIT })).toEqual({ ok: true, data: { restored: 0, trashed: 1, count: 1 } })
    expect(trashed).toEqual([join(repo, 'proj', 'src', 'new.txt')])
    expect(fs.existsSync(join(root, '.env'))).toBe(true)
    expect(g(repo, 'status', '--porcelain')).not.toContain('A  proj/.env')
    // A file deleted with its folder is still named by git: staged by name.
    fs.rmSync(join(root, 'src', 'deep'), { recursive: true })
    expect(await ask('scm.stage', { paths: ['src/deep/only/x.js'] }, { rights: GIT })).toEqual({ ok: true, data: { count: 1 } })
    // Discard: tracked files restored, untracked ones to the Recycle Bin.
    put(root, 'src/new2.txt', 'n')
    const d = await ask('scm.discard', { paths: ['src/a.js', 'src/new2.txt'] }, { rights: GIT })
    expect(d).toEqual({ ok: true, data: { restored: 1, trashed: 1, count: 2 } })
    expect(fs.readFileSync(join(root, 'src', 'a.js'), 'utf8')).toBe('one\n')
    expect(trashed).toEqual([join(repo, 'proj', 'src', 'new.txt'), join(repo, 'proj', 'src', 'new2.txt')])
  })

  it('saves only over the file the guest read, and asks for the right again first', async () => {
    const read = await ask('fs.read', { path: 'src/a.js' }, { rights: EDIT })
    expect(read.data.readOnly).toBe(false)
    const hash = read.data.hash
    expect(await ask('fs.write', { path: 'src/a.js', text: 'blind' }, { rights: EDIT })).toEqual({ ok: false, code: 'conflict' })
    fs.writeFileSync(join(root, 'src', 'a.js'), 'changed by an agent\n')
    expect(await ask('fs.write', { path: 'src/a.js', text: 'guest', expectHash: hash }, { rights: EDIT })).toEqual({ ok: false, code: 'conflict' })
    expect(fs.readFileSync(join(root, 'src', 'a.js'), 'utf8')).toBe('changed by an agent\n')
    const fresh = (await ask('fs.read', { path: 'src/a.js' }, { rights: EDIT })).data.hash
    // Access taken back while the request waited: nothing written.
    expect(await ask('fs.write', { path: 'src/a.js', text: 'late', expectHash: fresh }, { rights: EDIT, recheck: async () => false })).toEqual({ ok: false, code: 'revoked' })
    expect(fs.readFileSync(join(root, 'src', 'a.js'), 'utf8')).toBe('changed by an agent\n')
    const ok = await ask('fs.write', { path: 'src/a.js', text: 'guest\n', expectHash: fresh }, { rights: EDIT, recheck: async () => true })
    expect(ok.ok).toBe(true)
    expect(ok.data.hash).toBe(hashOf(Buffer.from('guest\n')))
    expect(fs.readFileSync(join(root, 'src', 'a.js'), 'utf8')).toBe('guest\n')
    // A new file needs no hash; too large is refused.
    expect((await ask('fs.write', { path: 'src/new.js', text: 'new' }, { rights: EDIT })).ok).toBe(true)
    expect(await ask('fs.write', { path: 'src/big.js', text: 'x'.repeat(768 * 1024 + 1) }, { rights: EDIT })).toEqual({ ok: false, code: 'bad-args' })
    expect(await ask('fs.write', { path: 'src/big.js', text: '\u00e9'.repeat(400 * 1024) }, { rights: EDIT })).toEqual({ ok: false, code: 'too-large' })
  })

  it('write-protects the files that run things, unless the guest may type', async () => {
    const TYPE = { edit: true, type: true }
    const read = await ask('fs.read', { path: '.claude/settings.json' }, { rights: EDIT })
    expect(read.data.readOnly).toBe(true)
    const hash = read.data.hash
    expect(await ask('fs.write', { path: '.claude/settings.json', text: '{"hooks":1}', expectHash: hash }, { rights: EDIT })).toEqual({ ok: false, code: 'not-allowed' })
    expect(await ask('fs.create', { dir: '', name: '.mcp.json' }, { rights: EDIT })).toEqual({ ok: false, code: 'not-allowed' })
    expect(await ask('fs.create', { dir: '', name: '.vscode', folder: true }, { rights: EDIT })).toEqual({ ok: false, code: 'not-allowed' })
    expect(await ask('fs.create', { dir: 'src', name: '.husky', folder: true }, { rights: EDIT })).toEqual({ ok: false, code: 'not-allowed' })
    expect(await ask('fs.rename', { path: 'README.md', name: '.envrc' }, { rights: EDIT })).toEqual({ ok: false, code: 'not-allowed' })
    expect(await ask('fs.rename', { path: '.claude', name: 'claude-off' }, { rights: EDIT })).toEqual({ ok: false, code: 'not-allowed' })
    expect(await ask('fs.trash', { path: '.claude/settings.json' }, { rights: EDIT })).toEqual({ ok: false, code: 'not-allowed' })
    expect(await ask('fs.write', { path: '.tessel/setup.ps1', text: 'calc' }, { rights: TYPE })).toEqual({ ok: false, code: 'not-found' })
    expect(fs.readFileSync(join(root, '.claude', 'settings.json'), 'utf8')).toBe('{}')
    // With type too (it already runs any command as the host): allowed.
    expect((await ask('fs.read', { path: '.claude/settings.json' }, { rights: TYPE })).data.readOnly).toBe(false)
    expect((await ask('fs.write', { path: '.claude/settings.json', text: '{"a":1}', expectHash: hash }, { rights: TYPE })).ok).toBe(true)
    expect((await ask('fs.create', { dir: '', name: '.mcp.json' }, { rights: TYPE })).ok).toBe(true)
  })

  it('never makes a name a guest could not see', async () => {
    for (const name of ['.git', '.env', '.ENV.local']) expect(await ask('fs.create', { dir: 'src', name, folder: true }, { rights: EDIT }), name).toEqual({ ok: false, code: 'not-allowed' })
    expect(await ask('fs.create', { dir: '.tessel', name: 'team2' }, { rights: EDIT })).toEqual({ ok: false, code: 'not-allowed' })
    expect(await ask('fs.rename', { path: 'src', name: '.git' }, { rights: EDIT })).toEqual({ ok: false, code: 'not-allowed' })
    expect(await ask('fs.create', { dir: 'dist', name: 'x.js' }, { rights: EDIT })).toEqual({ ok: false, code: 'not-found' })
    expect(await ask('fs.create', { dir: 'src', name: 'con' }, { rights: EDIT })).toEqual({ ok: false, code: 'bad-args' })
    expect(await ask('fs.create', { dir: 'src', name: 'a/b' }, { rights: EDIT })).toEqual({ ok: false, code: 'bad-args' })
    const made = await ask('fs.create', { dir: 'src', name: 'made.txt' }, { rights: EDIT })
    expect(made).toEqual({ ok: true, data: { rel: 'src/made.txt' } })
    expect(await ask('fs.rename', { path: 'src/made.txt', name: 'renamed.txt' }, { rights: EDIT })).toEqual({ ok: true, data: { rel: 'src/renamed.txt' } })
    expect(fs.existsSync(join(root, 'src', 'renamed.txt'))).toBe(true)
    expect(await ask('fs.trash', { path: 'src/renamed.txt' }, { rights: EDIT })).toEqual({ ok: true, data: { rel: 'src/renamed.txt' } })
    expect(trashed).toEqual([join(root, 'src', 'renamed.txt')])
  })

  it('loads and saves the notes, refusing a stale copy', async () => {
    const loaded = await ask('notes.load', {})
    expect(loaded.data).toMatchObject({ exists: true, text: '# notes\n' })
    // Agents read the notes: saving them needs the type right too.
    expect(await ask('notes.save', { text: 'x', baseMtime: loaded.data.mtime }, { rights: EDIT })).toEqual({ ok: false, code: 'not-allowed' })
    const NOTES = { edit: true, type: true }
    expect(await ask('notes.save', { text: 'x', baseMtime: loaded.data.mtime - 5000 }, { rights: NOTES })).toEqual({ ok: false, code: 'conflict' })
    const saved = await ask('notes.save', { text: '# notes\nguest\n', baseMtime: loaded.data.mtime }, { rights: NOTES })
    expect(saved.ok).toBe(true)
    expect(fs.readFileSync(join(root, '.tessel', 'notes.md'), 'utf8')).toBe('# notes\nguest\n')
    // No .tessel at all: made on the first save.
    fs.rmSync(join(root, '.tessel'), { recursive: true })
    expect((await ask('notes.load', {})).data).toEqual({ exists: false, text: '', mtime: null })
    expect((await ask('notes.save', { text: 'first' }, { rights: NOTES })).ok).toBe(true)
    expect(fs.readFileSync(join(root, '.tessel', 'notes.md'), 'utf8')).toBe('first')
  })
})
