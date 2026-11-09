// The explorer's drag and drop and "Download…": a row moved onto a folder,
// files dropped from Windows (copied in, or sent to the SSH host), files and
// folders downloaded (local copies, a remote folder a file at a time).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { move, create, rename, trash } from '../explorer'
import { createExplorerImport } from '../explorerImport'
import { createFileDownload } from '../fileDownload'

let base
let proj
beforeEach(() => {
  base = fs.mkdtempSync(join(os.tmpdir(), 'tessel-xfer-'))
  proj = join(base, 'proj')
  fs.mkdirSync(join(proj, 'src', 'deep'), { recursive: true })
  fs.mkdirSync(join(proj, 'docs'))
  fs.writeFileSync(join(proj, 'a.txt'), 'one')
  fs.writeFileSync(join(proj, 'docs', 'a.txt'), 'other')
  fs.writeFileSync(join(proj, 'src', 'main.js'), 'x')
})
afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true })
})
// A junction needs no rights on Windows (a symbolic link elsewhere).
const link = (target, at) => fs.symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir')

describe('moving a row onto a folder (local)', () => {
  it('moves a file and a folder into another folder of the project', () => {
    expect(move({ root: proj, path: join(proj, 'src', 'main.js'), dir: join(proj, 'docs') })).toEqual({ ok: true, path: join(proj, 'docs', 'main.js') })
    expect(fs.readFileSync(join(proj, 'docs', 'main.js'), 'utf8')).toBe('x')
    expect(move({ root: proj, path: join(proj, 'src'), dir: join(proj, 'docs') })).toEqual({ ok: true, path: join(proj, 'docs', 'src') })
    expect(fs.existsSync(join(proj, 'docs', 'src', 'deep'))).toBe(true)
    // Back to the project's own folder.
    expect(move({ root: proj, path: join(proj, 'docs', 'src'), dir: proj }).ok).toBe(true)
    expect(fs.existsSync(join(proj, 'src', 'deep'))).toBe(true)
  })
  it('never replaces, never a folder into itself, nothing outside the project', () => {
    expect(move({ root: proj, path: join(proj, 'a.txt'), dir: join(proj, 'docs') })).toMatchObject({ ok: false })
    expect(fs.readFileSync(join(proj, 'docs', 'a.txt'), 'utf8')).toBe('other')
    expect(move({ root: proj, path: join(proj, 'src'), dir: join(proj, 'src', 'deep') })).toMatchObject({ ok: false })
    expect(move({ root: proj, path: join(proj, 'src'), dir: join(proj, 'src') })).toMatchObject({ ok: false })
    expect(move({ root: proj, path: join(proj, 'a.txt'), dir: base })).toMatchObject({ ok: false })
    expect(move({ root: proj, path: proj, dir: join(proj, 'docs') })).toMatchObject({ ok: false })
    expect(move({ root: proj, path: join(proj, 'a.txt'), dir: join(proj, 'src', 'main.js') })).toMatchObject({ ok: false })
    expect(move({ root: proj, path: join(proj, 'gone.txt'), dir: join(proj, 'docs') })).toMatchObject({ ok: false })
    expect(fs.existsSync(join(proj, 'a.txt'))).toBe(true)
  })
  it('the folder it is already in: nothing to do', () => {
    expect(move({ root: proj, path: join(proj, 'docs', 'a.txt'), dir: join(proj, 'docs') })).toMatchObject({ ok: true, same: true })
  })
  it('a junction to another place: nothing goes in through it, nothing comes out of it', () => {
    // A worktree's node_modules linked to the main copy's.
    const other = join(base, 'main-copy-modules')
    fs.mkdirSync(join(other, 'pkg'), { recursive: true })
    fs.writeFileSync(join(other, 'pkg', 'index.js'), 'p')
    link(other, join(proj, 'node_modules'))
    expect(move({ root: proj, path: join(proj, 'a.txt'), dir: join(proj, 'node_modules') })).toMatchObject({ ok: false })
    expect(fs.existsSync(join(other, 'a.txt'))).toBe(false)
    expect(move({ root: proj, path: join(proj, 'node_modules', 'pkg'), dir: join(proj, 'src') })).toMatchObject({ ok: false })
    expect(fs.existsSync(join(other, 'pkg', 'index.js'))).toBe(true)
    // The junction itself moves as a link (its target stays where it is).
    expect(move({ root: proj, path: join(proj, 'node_modules'), dir: join(proj, 'docs') }).ok).toBe(true)
    expect(fs.lstatSync(join(proj, 'docs', 'node_modules')).isSymbolicLink()).toBe(true)
    expect(fs.existsSync(join(other, 'pkg', 'index.js'))).toBe(true)
  })
  it('new, rename and the Recycle Bin: never inside a folder that is a junction to another place', async () => {
    const other = join(base, 'main-copy-modules')
    fs.mkdirSync(join(other, 'pkg'), { recursive: true })
    link(other, join(proj, 'node_modules'))
    const nm = join(proj, 'node_modules')
    expect(create({ root: proj, dir: nm, name: 'x.txt' }).ok).toBe(false)
    expect(fs.existsSync(join(other, 'x.txt'))).toBe(false)
    expect(rename({ root: proj, path: join(nm, 'pkg'), name: 'pkg2' }).ok).toBe(false)
    expect(fs.existsSync(join(other, 'pkg'))).toBe(true)
    const trashItem = vi.fn(async () => {})
    expect((await trash({ root: proj, path: join(nm, 'pkg') }, trashItem)).ok).toBe(false)
    expect(trashItem).not.toHaveBeenCalled()
    // The project's own files still work.
    expect(create({ root: proj, dir: join(proj, 'docs'), name: 'n.txt' }).ok).toBe(true)
    expect(rename({ root: proj, path: join(proj, 'docs', 'n.txt'), name: 'm.txt' }).ok).toBe(true)
    expect((await trash({ root: proj, path: join(proj, 'docs', 'm.txt') }, trashItem)).ok).toBe(true)
  })
})

describe('files dropped from Windows onto a local folder', () => {
  let outside
  beforeEach(() => {
    outside = join(base, 'outside')
    fs.mkdirSync(join(outside, 'pack', 'inner'), { recursive: true })
    fs.writeFileSync(join(outside, 'pack', 'inner', 'x.bin'), Buffer.from([0, 1, 2]))
    fs.writeFileSync(join(outside, 'note.txt'), 'hello')
    fs.writeFileSync(join(outside, 'a.txt'), 'dropped')
  })
  it('copies files and folders in, keeps what is there, leaves links out', async () => {
    const elsewhere = join(base, 'elsewhere')
    fs.mkdirSync(elsewhere)
    fs.writeFileSync(join(elsewhere, 'secret'), 's')
    link(elsewhere, join(outside, 'pack', 'mods'))
    const progress = vi.fn()
    const importPaths = createExplorerImport({ remote: null, progress })
    const res = await importPaths({ root: proj, dir: proj, paths: [join(outside, 'pack'), join(outside, 'note.txt'), join(outside, 'a.txt')] })
    expect(res).toMatchObject({ ok: true, copied: ['pack', 'note.txt'], skipped: ['a.txt'], failed: [] })
    expect(fs.readFileSync(join(proj, 'note.txt'), 'utf8')).toBe('hello')
    expect([...fs.readFileSync(join(proj, 'pack', 'inner', 'x.bin'))]).toEqual([0, 1, 2])
    expect(fs.existsSync(join(proj, 'pack', 'mods'))).toBe(false)
    expect(fs.readFileSync(join(proj, 'a.txt'), 'utf8')).toBe('one')
    expect(fs.existsSync(join(outside, 'note.txt'))).toBe(true)
    expect(progress).toHaveBeenCalled()
  })
  it('into a sub-folder; a dropped link itself is refused; nothing outside', async () => {
    link(join(outside, 'pack'), join(outside, 'ln'))
    const importPaths = createExplorerImport({ remote: null })
    const res = await importPaths({ root: proj, dir: join(proj, 'docs'), paths: [join(outside, 'note.txt'), join(outside, 'ln')] })
    expect(res.copied).toEqual(['note.txt'])
    expect(res.failed.map((f) => f.name)).toEqual(['ln'])
    expect(fs.existsSync(join(proj, 'docs', 'note.txt'))).toBe(true)
    expect((await importPaths({ root: proj, dir: base, paths: [join(outside, 'note.txt')] })).ok).toBe(false)
    expect(fs.existsSync(join(base, 'note.txt'))).toBe(false)
  })
  it('a folder of the project that is a junction to elsewhere takes nothing', async () => {
    const other = join(base, 'linked')
    fs.mkdirSync(other)
    link(other, join(proj, 'node_modules'))
    const importPaths = createExplorerImport({ remote: null })
    expect((await importPaths({ root: proj, dir: join(proj, 'node_modules'), paths: [join(outside, 'note.txt')] })).ok).toBe(false)
    expect(fs.readdirSync(other)).toEqual([])
  })
  it('one drop is bounded: the rest is left and said; links below are counted', async () => {
    for (let i = 0; i < 5; i++) fs.writeFileSync(join(outside, 'pack', `f${i}.txt`), 'x')
    link(join(outside, 'pack', 'inner'), join(outside, 'pack', 'a-ln'))
    const progress = vi.fn()
    const importPaths = createExplorerImport({ remote: null, progress, localLimits: { files: 3, bytes: 1e9, folders: 10 } })
    const res = await importPaths({ root: proj, dir: proj, paths: [join(outside, 'pack')] })
    expect(res).toMatchObject({ ok: true, copied: ['pack'], cut: true, files: 3, links: 1 })
    expect(progress).toHaveBeenCalledTimes(3)
    const many = createExplorerImport({ remote: null, limits: { items: 1, files: 10, bytes: 1e9, folders: 10 } })
    const two = await many({ root: proj, dir: join(proj, 'docs'), paths: [join(outside, 'note.txt'), join(outside, 'a.txt')] })
    expect(two).toMatchObject({ copied: ['note.txt'], cut: true })
  })
  it('a folder into itself is refused; relative, remote or shared sources and Live Share projects too', async () => {
    const importPaths = createExplorerImport({ remote: null })
    const res = await importPaths({ root: proj, dir: join(proj, 'src'), paths: [proj] })
    expect(res.copied).toEqual([])
    expect(res.failed.length).toBe(1)
    expect((await importPaths({ root: proj, dir: proj, paths: ['note.txt', 'ssh://box/srv/x', 'lshare://p/x'] })).ok).toBe(false)
    expect((await importPaths({ root: 'lshare://p1', dir: 'lshare://p1', paths: [join(outside, 'note.txt')] })).ok).toBe(false)
  })
})

describe('files dropped from Windows onto a remote folder', () => {
  const ROOT = 'ssh://ssh-box/srv/app'
  function fakeRemote(existing = new Set()) {
    const calls = []
    return {
      calls,
      create: vi.fn(async ({ dir, name, folder }) => {
        calls.push(['mk', dir, name, folder])
        const path = `${dir}\\${name}`
        if (existing.has(path)) return { ok: false, exists: true, error: 'exists' }
        existing.add(path)
        return { ok: true, path }
      }),
      upload: vi.fn(async ({ dir, name, data }) => {
        calls.push(['put', dir, name, data.toString()])
        const path = `${dir}\\${name}`
        if (existing.has(path)) return { ok: false, exists: true, error: 'exists' }
        existing.add(path)
        return { ok: true, path }
      })
    }
  }
  it('sends a folder file by file, never over what is there, links left out', async () => {
    const src = join(base, 'up')
    fs.mkdirSync(join(src, 'pack', 'sub'), { recursive: true })
    fs.writeFileSync(join(src, 'pack', 'one.txt'), '1')
    fs.writeFileSync(join(src, 'pack', 'sub', 'two.txt'), '2')
    fs.writeFileSync(join(src, 'taken.txt'), 't')
    link(join(src, 'pack'), join(src, 'pack', 'loop'))
    const remote = fakeRemote(new Set([`${ROOT}\\taken.txt`]))
    const importPaths = createExplorerImport({ remote })
    const res = await importPaths({ root: ROOT, dir: ROOT, paths: [join(src, 'pack'), join(src, 'taken.txt')] })
    expect(res).toMatchObject({ ok: true, copied: ['pack'], skipped: ['taken.txt'], failed: [], files: 2 })
    expect(remote.calls).toContainEqual(['mk', ROOT, 'pack', true])
    expect(remote.calls).toContainEqual(['put', `${ROOT}\\pack`, 'one.txt', '1'])
    expect(remote.calls).toContainEqual(['mk', `${ROOT}\\pack`, 'sub', true])
    expect(remote.calls).toContainEqual(['put', `${ROOT}\\pack\\sub`, 'two.txt', '2'])
    expect(remote.calls.some((c) => c[2] === 'loop')).toBe(false)
  })
  it('a file over the cap is not read or sent; the file count stops it', async () => {
    const src = join(base, 'up')
    fs.mkdirSync(src)
    fs.writeFileSync(join(src, 'big.bin'), Buffer.alloc(32))
    fs.writeFileSync(join(src, 'b.txt'), 'b')
    fs.writeFileSync(join(src, 'c.txt'), 'c')
    const remote = fakeRemote()
    const importPaths = createExplorerImport({ remote, maxUploadBytes: 16, limits: { items: 10, files: 1, bytes: 1e9 } })
    const res = await importPaths({ root: ROOT, dir: ROOT, paths: [join(src, 'big.bin'), join(src, 'b.txt'), join(src, 'c.txt')] })
    expect(res.tooLarge).toEqual(['big.bin'])
    expect(res.copied).toEqual(['b.txt'])
    expect(res.cut).toBe(true)
    expect(remote.upload).toHaveBeenCalledTimes(1)
  })
})

describe('"Download…"', () => {
  function setup({ remote = {}, save = null, folder = null } = {}) {
    const dialog = {
      showSaveDialog: vi.fn(async () => (save ? { filePath: save } : { canceled: true })),
      showOpenDialog: vi.fn(async () => (folder ? { filePaths: [folder] } : { canceled: true }))
    }
    const download = createFileDownload({ dialog, getWindow: () => null, downloadsDir: () => base, remote, guest: () => remote })
    return { dialog, download }
  }
  it('a local file: a copy where the dialog says', async () => {
    const h = setup({ save: join(base, 'copy.txt') })
    expect(await h.download({ file: join(proj, 'a.txt'), root: proj })).toEqual({ ok: true, path: join(base, 'copy.txt') })
    expect(fs.readFileSync(join(base, 'copy.txt'), 'utf8')).toBe('one')
    expect(h.dialog.showSaveDialog.mock.calls[0][0].defaultPath).toBe(join(base, 'a.txt'))
  })
  it('a local file outside its project, or without one, is refused', async () => {
    const h = setup({ save: join(base, 'copy.txt') })
    fs.writeFileSync(join(base, 'loose.txt'), 'l')
    expect((await h.download({ file: join(base, 'loose.txt'), root: proj })).ok).toBe(false)
    expect((await h.download(join(proj, 'a.txt'))).ok).toBe(false)
    expect(h.dialog.showSaveDialog).not.toHaveBeenCalled()
  })
  it('a local folder: copied into the chosen folder, "(2)" when taken, links left out', async () => {
    const dest = join(base, 'dl')
    fs.mkdirSync(join(dest, 'src'), { recursive: true })
    link(join(proj, 'docs'), join(proj, 'src', 'mods'))
    const h = setup({ folder: dest })
    const res = await h.download({ file: join(proj, 'src'), root: proj, folder: true })
    expect(res).toMatchObject({ ok: true, path: join(dest, 'src (2)'), skipped: 1 })
    expect(fs.readFileSync(join(dest, 'src (2)', 'main.js'), 'utf8')).toBe('x')
    expect(fs.existsSync(join(dest, 'src (2)', 'deep'))).toBe(true)
    expect(fs.existsSync(join(dest, 'src (2)', 'mods'))).toBe(false)
  })
  it('a local folder that is a junction is not copied (never a link made for a copy)', async () => {
    const other = join(base, 'linked')
    fs.mkdirSync(other)
    fs.writeFileSync(join(other, 'x'), 'x')
    link(other, join(proj, 'node_modules'))
    const h = setup({ folder: join(base, 'dl') })
    expect((await h.download({ file: join(proj, 'node_modules'), root: proj, folder: true })).ok).toBe(false)
    expect(h.dialog.showOpenDialog).not.toHaveBeenCalled()
  })
  it('a local folder into itself is refused; cancel copies nothing', async () => {
    expect((await setup({ folder: join(proj, 'src') }).download({ file: join(proj, 'src'), root: proj, folder: true })).ok).toBe(false)
    expect(fs.existsSync(join(proj, 'src', 'src'))).toBe(false)
    expect(await setup().download({ file: join(proj, 'src'), root: proj, folder: true })).toMatchObject({ ok: false, canceled: true })
  })
  it('a remote folder: listed folder by folder, read a file at a time, names made safe for Windows', async () => {
    const ROOT = 'ssh://ssh-box/srv/app'
    const tree = {
      [`${ROOT}\\pkg`]: [
        { name: 'sub', path: `${ROOT}\\pkg\\sub`, dir: true },
        { name: 'a:b.txt', path: `${ROOT}\\pkg\\a:b.txt`, dir: false },
        { name: 'big.bin', path: `${ROOT}\\pkg\\big.bin`, dir: false },
        { name: 'ln', path: `${ROOT}\\pkg\\ln`, dir: true, link: true }
      ],
      [`${ROOT}\\pkg\\sub`]: [{ name: 'c.txt', path: `${ROOT}\\pkg\\sub\\c.txt`, dir: false }]
    }
    const remote = {
      listMany: vi.fn(async ({ dirs }) => ({ ok: true, results: dirs.map((d) => ({ dir: d, ok: true, entries: tree[d] || [] })) })),
      readDownload: vi.fn(async (f) => (f.endsWith('big.bin') ? { ok: false, code: 'too-large' } : { ok: true, buf: Buffer.from(f.split('\\').pop()) }))
    }
    const dest = join(base, 'dl')
    fs.mkdirSync(dest)
    const h = setup({ remote, folder: dest })
    const res = await h.download({ file: `${ROOT}\\pkg`, root: ROOT, folder: true })
    expect(res).toMatchObject({ ok: true, path: join(dest, 'pkg'), files: 2, tooLarge: 1, skipped: 1, cut: false })
    expect(fs.readFileSync(join(dest, 'pkg', 'a_b.txt'), 'utf8')).toBe('a:b.txt')
    expect(fs.readFileSync(join(dest, 'pkg', 'sub', 'c.txt'), 'utf8')).toBe('c.txt')
    expect(remote.readDownload).not.toHaveBeenCalledWith(`${ROOT}\\pkg\\ln`)
  })
  it('a remote folder the answer did not reach is asked again, then counted as left out', async () => {
    const ROOT = 'ssh://ssh-box/srv/app'
    const remote = {
      // The sub-folder never gets an answer (cut at the answer's size).
      listMany: vi.fn(async ({ dirs }) => ({
        ok: true,
        results: dirs.filter((d) => !d.endsWith('sub')).map((d) => ({ dir: d, ok: true, entries: [{ name: 'sub', path: `${d}\\sub`, dir: true }] }))
      })),
      readDownload: vi.fn()
    }
    const dest = join(base, 'dl')
    fs.mkdirSync(dest)
    const res = await setup({ remote, folder: dest }).download({ file: `${ROOT}\\pkg`, root: ROOT, folder: true })
    expect(res).toMatchObject({ ok: true, skipped: 1 })
    expect(remote.listMany).toHaveBeenCalledTimes(3)
    expect(remote.listMany.mock.calls[0][0]).toMatchObject({ direct: true })
  })
  it('a shared (Live Share) folder is not offered', async () => {
    const h = setup({ folder: base })
    expect((await h.download({ file: 'lshare://p1/dir', root: 'lshare://p1', folder: true })).ok).toBe(false)
    expect(h.dialog.showOpenDialog).not.toHaveBeenCalled()
  })
})
