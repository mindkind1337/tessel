import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { execFileSync } from 'child_process'
import { listProjectFiles } from '../fileOpen'

let dir
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))
const put = (rel, text = 'x') => {
  fs.mkdirSync(join(dir, rel, '..'), { recursive: true })
  fs.writeFileSync(join(dir, rel), text)
}

describe('the project files for Jump to file', () => {
  it("a git repository: git's list, tracked and new files, never what .gitignore ignores", async () => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-files-'))
    execFileSync('git', ['-C', dir, 'init', '-q'])
    put('.gitignore', 'secret.log\nbuild/\n')
    put('src/app.js')
    put('secret.log')
    put('build/out.js')
    execFileSync('git', ['-C', dir, 'add', 'src/app.js', '.gitignore'])
    put('notes/new.md') // untracked, not ignored
    const res = await listProjectFiles(dir)
    expect(res).toMatchObject({ ok: true, source: 'git', truncated: false })
    expect(res.files.sort()).toEqual(['.gitignore', 'notes/new.md', 'src/app.js'])
  })
  it('a plain folder: walked, skipping node_modules and .git', async () => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-files-'))
    put('a.txt')
    put('lib/b.js')
    put('node_modules/pkg/index.js')
    const res = await listProjectFiles(dir)
    expect(res).toMatchObject({ ok: true, source: 'walk' })
    expect(res.files).toEqual(['a.txt', 'lib/b.js'])
  })
  it('a missing folder is an error', async () => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-files-'))
    expect((await listProjectFiles(join(dir, 'nope'))).ok).toBe(false)
  })
})
