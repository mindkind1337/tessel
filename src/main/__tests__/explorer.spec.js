import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { execFileSync } from 'child_process'
import { inside, listDir, parsePorcelain, projectStatus, checkName, create, rename, trash, searchNames, searchContent, searchContentWalk, parseGrepRecord, clipLine } from '../explorer'
import { statusOf, folderStatus, ignoredSet, isIgnored } from '../../renderer/src/explorerStatus'

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

  it('finds files by name in folders not opened yet, without the heavy folders', async () => {
    fs.mkdirSync(join(root, 'src', 'deep', 'er'), { recursive: true })
    fs.writeFileSync(join(root, 'src', 'deep', 'er', 'Widget.vue'), '')
    fs.mkdirSync(join(root, 'node_modules', 'widget'), { recursive: true })
    fs.writeFileSync(join(root, 'node_modules', 'widget', 'widget.js'), '')
    fs.writeFileSync(join(root, '.widgetrc'), '')
    const res = await searchNames({ root, query: 'WIDGET' })
    expect(res.ok).toBe(true)
    expect(res.results.map((r) => r.rel).sort()).toEqual(['.widgetrc', join('src', 'deep', 'er', 'Widget.vue')])
    expect(res.results.find((r) => r.name === 'Widget.vue').path).toBe(join(root, 'src', 'deep', 'er', 'Widget.vue'))
    // Folders match too; dotfiles can be left out.
    expect((await searchNames({ root, query: 'deep' })).results).toEqual([
      { name: 'deep', path: join(root, 'src', 'deep'), rel: join('src', 'deep'), dir: true }
    ])
    expect((await searchNames({ root, query: 'widget', dotfiles: false })).results.map((r) => r.name)).toEqual(['Widget.vue'])
    expect((await searchNames({ root, query: '  ' })).results).toEqual([])
    expect((await searchNames({ root: 'relative', query: 'x' })).ok).toBe(false)
  })

  it('caps name results', async () => {
    for (let i = 0; i < 12; i++) fs.writeFileSync(join(root, `hit${i}.txt`), '')
    const res = await searchNames({ root, query: 'hit', limit: 5 })
    expect(res.results).toHaveLength(5)
    expect(res.truncated).toBe(true)
    expect((await searchNames({ root, query: 'hit' })).truncated).toBe(false)
  })

  it('searches contents without git: case-insensitive, skips binaries, big files and heavy folders', async () => {
    fs.writeFileSync(join(root, 'src', 'b.js'), 'const a = 1\n  return Needle(a)\r\nno\n')
    fs.writeFileSync(join(root, 'bin.dat'), Buffer.concat([Buffer.from('needle'), Buffer.from([0, 1, 2]), Buffer.from('needle')]))
    fs.writeFileSync(join(root, 'big.txt'), 'needle\n' + 'x'.repeat(2 * 1024 * 1024))
    fs.mkdirSync(join(root, 'node_modules'))
    fs.writeFileSync(join(root, 'node_modules', 'n.js'), 'needle')
    const res = await searchContentWalk({ root, query: 'NEEDLE' })
    expect(res.ok).toBe(true)
    expect(res.results).toEqual([{ path: join(root, 'src', 'b.js'), rel: join('src', 'b.js'), line: 2, text: 'return Needle(a)' }])
    expect(res.truncated).toBe(false)
  })

  it('caps content results', async () => {
    fs.writeFileSync(join(root, 'many.txt'), Array.from({ length: 30 }, (_, i) => `match ${i}`).join('\n'))
    const res = await searchContentWalk({ root, query: 'match', limit: 10 })
    expect(res.results).toHaveLength(10)
    expect(res.results[9].line).toBe(10)
    expect(res.truncated).toBe(true)
  })

  it('cuts long result lines around the match', () => {
    const long = 'a'.repeat(500) + 'NEEDLE' + 'b'.repeat(500)
    const t = clipLine(long, 'needle')
    expect(t.length).toBeLessThan(260)
    expect(t).toContain('NEEDLE')
    expect(t.startsWith('…') && t.endsWith('…')).toBe(true)
  })

  it('reads git grep records, without heavy folders or paths leaving the project', () => {
    expect(parseGrepRecord(root, 'src/b.js\u00002\u0000  hello\r', 'hello')).toEqual({
      path: join(root, 'src', 'b.js'),
      rel: join('src', 'b.js'),
      line: 2,
      text: 'hello'
    })
    expect(parseGrepRecord(root, 'node_modules/x.js\u00001\u0000hello', 'hello')).toBe(null)
    expect(parseGrepRecord(root, '../x.js\u00001\u0000hello', 'hello')).toBe(null)
    expect(parseGrepRecord(root, 'Binary file matches', 'hello')).toBe(null)
  })

  it('searches contents with git grep in a repository (tracked and untracked, not ignored)', async () => {
    fs.rmSync(join(root, '.git'), { recursive: true })
    const git = (...a) => execFileSync('git', ['-C', root, ...a], { windowsHide: true })
    git('init', '-q')
    fs.writeFileSync(join(root, '.gitignore'), 'logs/\n')
    fs.mkdirSync(join(root, 'logs'))
    fs.writeFileSync(join(root, 'logs', 'x.log'), 'Needle in a log')
    fs.writeFileSync(join(root, 'src', 'b.js'), 'one\nthe NEEDLE\n')
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', 'src/b.js', '.gitignore')
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'x')
    fs.writeFileSync(join(root, 'new.txt'), 'needle here')
    fs.writeFileSync(join(root, 'bin.dat'), Buffer.from([110, 101, 101, 100, 108, 101, 0, 0]))
    const res = await searchContent({ root, query: 'needle' })
    expect(res.ok).toBe(true)
    const got = res.results.map((r) => `${r.rel}:${r.line}:${r.text}`).sort()
    expect(got).toEqual([`new.txt:1:needle here`, `${join('src', 'b.js')}:2:the NEEDLE`])
    const capped = await searchContent({ root, query: 'e', limit: 1 })
    expect(capped.results).toHaveLength(1)
    expect(capped.truncated).toBe(true)
  }, 30000)

  it('marks git-ignored files and folders (and what is inside an ignored folder)', async () => {
    fs.rmSync(join(root, '.git'), { recursive: true })
    const git = (...a) => execFileSync('git', ['-C', root, ...a], { windowsHide: true })
    git('init', '-q')
    fs.writeFileSync(join(root, '.gitignore'), 'out/\n*.log\n')
    fs.mkdirSync(join(root, 'out'))
    fs.writeFileSync(join(root, 'out', 'a.js'), '')
    fs.writeFileSync(join(root, 'debug.log'), '')
    const res = await projectStatus({ root, ignored: true })
    const map = Object.fromEntries(Object.entries(res.files).map(([p, l]) => [p.toLowerCase(), l]))
    const k = (...p) => join(root, ...p).toLowerCase()
    expect(map[k('out')]).toBe('!')
    expect(map[k('debug.log')]).toBe('!')
    expect(map[k('a2.md')]).toBe('U')
    // Without asking for them, ignored files are not listed.
    const plain = await projectStatus({ root })
    expect(Object.values(plain.files)).not.toContain('!')
    const set = ignoredSet(map)
    const rk = root.toLowerCase()
    expect(isIgnored(set, k('out'), rk)).toBe(true)
    expect(isIgnored(set, k('out', 'a.js'), rk)).toBe(true)
    expect(isIgnored(set, k('debug.log'), rk)).toBe(true)
    expect(isIgnored(set, k('src', 'b.js'), rk)).toBe(false)
    expect(isIgnored(set, rk, rk)).toBe(false)
    // Ignored files never count for their folder's letter.
    expect(folderStatus(map, rk)[k('out')]).toBeUndefined()
  }, 30000)
})
