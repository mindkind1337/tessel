import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { execFileSync } from 'child_process'
import { inside, listDir, parsePorcelain, projectStatus, checkName, create, rename, trash } from '../explorer'
import { statusOf, folderStatus } from '../../renderer/src/explorerStatus'

describe('file explorer', () => {
  let root
  beforeEach(() => {
    root = fs.mkdtempSync(join(os.tmpdir(), 'tessel-explorer-'))
    fs.mkdirSync(join(root, 'src'))
    fs.mkdirSync(join(root, '.git'))
    fs.writeFileSync(join(root, 'src', 'b.js'), 'x')
    fs.writeFileSync(join(root, 'a10.md'), '')
    fs.writeFileSync(join(root, 'a2.md'), '')
    fs.writeFileSync(join(root, '.env'), '')
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  it('never leaves the project folder', () => {
    expect(inside(root, 'src\\b.js')).toBe(join(root, 'src', 'b.js'))
    expect(inside(root, '..\\x')).toBe(null)
    expect(inside(root, 'C:\\Windows')).toBe(null)
    expect(inside('relative', 'x')).toBe(null)
    expect(listDir({ root, dir: join(root, '..') }).ok).toBe(false)
  })

  it('lists folders first, in natural order, without .git; dotfiles optional', () => {
    expect(listDir({ root }).entries.map((e) => e.name)).toEqual(['src', '.env', 'a2.md', 'a10.md'])
    expect(listDir({ root, dotfiles: false }).entries.map((e) => e.name)).toEqual(['src', 'a2.md', 'a10.md'])
  })

  it('reads git status letters (renames skip their old path)', () => {
    const out = [' M src/b.js', 'A  new.js', 'R  moved.js', 'old.js', '?? notes/', '!! build/', ' D gone.js'].join('\0') + '\0'
    const files = parsePorcelain(root, out)
    expect(files[join(root, 'src', 'b.js')]).toBe('M')
    expect(files[join(root, 'new.js')]).toBe('A')
    expect(files[join(root, 'moved.js')]).toBe('R')
    expect(files[join(root, 'old.js')]).toBeUndefined()
    expect(files[join(root, 'notes')]).toBe('U')
    expect(files[join(root, 'build')]).toBe('!')
    expect(files[join(root, 'gone.js')]).toBe('D')
  })

  it('a folder shows what matters most inside it', () => {
    const k = (...p) => join(root, ...p).toLowerCase()
    const map = { [k('src', 'ui', 'a.js')]: 'U', [k('src', 'b.js')]: 'M', [k('x', 'y.js')]: '!' }
    const f = folderStatus(map, root.toLowerCase())
    expect(f[k('src')]).toBe('M')
    expect(f[k('src', 'ui')]).toBe('U')
    expect(f[k('x')]).toBeUndefined()
    expect(statusOf(map, k('x', 'y.js'))).toBe('')
  })

  it('refuses Windows-invalid names; creates, renames, never overwrites', () => {
    expect(checkName('a:b')).toMatch(/not a valid name/)
    expect(checkName('CON')).toMatch(/not a valid name/)
    expect(checkName('end.')).toMatch(/not a valid name/)
    expect(checkName('..')).toMatch(/not a valid name/)
    expect(create({ root, dir: join(root, 'src'), name: 'c.js' }).ok).toBe(true)
    expect(create({ root, dir: join(root, 'src'), name: 'c.js' }).error).toMatch(/already exists/)
    expect(create({ root, dir: root, name: 'lib', folder: true }).ok).toBe(true)
    expect(fs.statSync(join(root, 'lib')).isDirectory()).toBe(true)
    expect(rename({ root, path: join(root, 'src', 'c.js'), name: 'b.js' }).error).toMatch(/already exists/)
    const r = rename({ root, path: join(root, 'src', 'c.js'), name: 'd.js' })
    expect(r.ok && fs.existsSync(join(root, 'src', 'd.js'))).toBe(true)
    expect(rename({ root, path: root, name: 'x' }).ok).toBe(false)
    expect(create({ root, dir: root, name: '..\\escape.txt' }).ok).toBe(false)
  })

  it('moves to the Recycle Bin through the given function, only inside the project', async () => {
    const trashed = []
    const fake = async (p) => {
      trashed.push(p)
      fs.rmSync(p, { recursive: true, force: true })
    }
    expect((await trash({ root, path: join(root, 'a2.md') }, fake)).ok).toBe(true)
    expect(trashed).toEqual([join(root, 'a2.md')])
    expect((await trash({ root, path: root }, fake)).ok).toBe(false)
    expect((await trash({ root, path: join(root, '..', 'x') }, fake)).ok).toBe(false)
  })

  it('reads the status of a real repository, from a folder inside it', async () => {
    fs.rmSync(join(root, '.git'), { recursive: true })
    const git = (...a) => execFileSync('git', ['-C', root, ...a], { windowsHide: true })
    git('init', '-q')
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', 'src/b.js')
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'x')
    fs.writeFileSync(join(root, 'src', 'b.js'), 'changed')
    const res = await projectStatus({ root: join(root, 'src') })
    expect(res.repo).toBe(true)
    const byName = Object.fromEntries(Object.entries(res.files).map(([p, l]) => [p.toLowerCase(), l]))
    expect(byName[join(root, 'src', 'b.js').toLowerCase()]).toBe('M')
    expect(byName[join(root, 'a2.md').toLowerCase()]).toBe('U')
  }, 30000)
})
