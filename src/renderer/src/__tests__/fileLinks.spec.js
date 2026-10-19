import { describe, it, expect } from 'vitest'
import { findFileRefs, pickFileLinks } from '../../../shared/fileLinks'

const refs = (t) => findFileRefs(t).map((r) => [r.path, r.line, r.col])
// What the pane links when every ref exists (overlaps resolved).
const links = (t) => pickFileLinks(findFileRefs(t)).map((r) => [r.path, r.line, r.col])

describe('file references in terminal text', () => {
  it('finds paths with a line and column', () => {
    expect(refs('Error at src/main/index.js:123:5 here')).toEqual([['src/main/index.js', 123, 5]])
    expect(refs('C:\\Proj\\app.ts:12 failed')).toEqual([['C:\\Proj\\app.ts', 12, null]])
    expect(refs('app.cs(12,7): error')).toEqual([['app.cs', 12, 7]])
    expect(refs('Updated README.md')).toEqual([['README.md', null, null]])
  })
  it('ignores URLs, versions and e-mails', () => {
    expect(refs('see https://example.com/docs/page.html')).toEqual([])
    expect(refs('released v1.4.0 and 2.1.283')).toEqual([])
    expect(refs('write to me@example.com')).toEqual([])
    expect(refs('on 2026/10/19, 1/2 of it')).toEqual([])
  })
  it('gives each match its position in the line', () => {
    const [r] = findFileRefs('x src/a.js:1')
    expect(r.index).toBe(2)
    expect(r.text).toBe('src/a.js:1')
  })
  it('honors the line of "file line 12", #L12 and Python tracebacks', () => {
    expect(refs('  File "./a/b.py", line 3, in main')).toEqual([['./a/b.py', 3, null]])
    expect(refs('see app.py line 12')).toEqual([['app.py', 12, null]])
    expect(refs('see src/app.js#L12')).toEqual([['src/app.js', 12, null]])
    expect(refs('see src/app.js#L12C4')).toEqual([['src/app.js', 12, 4]])
    expect(refs('lines src/app.js#L12-L20')).toEqual([['src/app.js', 12, null]])
    const [r] = findFileRefs('  File "./a/b.py", line 3')
    expect(r.text).toBe('"./a/b.py", line 3')
    expect(r.index).toBe(7)
  })
  it('quoted paths may hold spaces; a line inside the quotes counts', () => {
    expect(links('open "C:\\My Folder\\read me.txt" now')).toEqual([['C:\\My Folder\\read me.txt', null, null]])
    expect(links("wrote 'docs/user guide.md'")).toEqual([['docs/user guide.md', null, null]])
    expect(links('at "src/my file.js:7:2"')).toEqual([['src/my file.js', 7, 2]])
    // Apostrophes of words are not quotes.
    expect(refs("it's here, don't")).toEqual([])
  })
  it('non-ASCII names', () => {
    expect(refs('écrit dans docs/résumé.md et 文件/说明.txt:3')).toEqual([
      ['docs/résumé.md', null, null],
      ['文件/说明.txt', 3, null]
    ])
  })
  it('home paths, WSL shares, folders and extensionless files', () => {
    expect(refs('see ~/notes/todo.md')).toEqual([['~/notes/todo.md', null, null]])
    expect(refs('cd ~/projects/app')).toEqual([['~/projects/app', null, null]])
    expect(refs('in \\\\wsl.localhost\\Ubuntu\\home\\me\\a.sh')).toEqual([['\\\\wsl.localhost\\Ubuntu\\home\\me\\a.sh', null, null]])
    expect(refs('in \\\\wsl$\\Ubuntu\\home\\me')).toEqual([['\\\\wsl$\\Ubuntu\\home\\me', null, null]])
    expect(refs('created src/components/ and bin/run')).toEqual([
      ['src/components/', null, null],
      ['bin/run', null, null]
    ])
    expect(refs('edit Makefile and Dockerfile')).toEqual([
      ['Makefile', null, null],
      ['Dockerfile', null, null]
    ])
    // A bare word is prose.
    expect(refs('build the project')).toEqual([])
    // Another network share never links.
    expect(refs('\\\\server\\share\\a.txt').map((r) => r[0])).not.toContain('\\\\server\\share\\a.txt')
  })
  it('emoji and other characters outside the BMP around paths', () => {
    expect(refs('🚀 done src/b.ts 🎉')).toEqual([['src/b.ts', null, null]])
    expect(refs('𝒳🙂')).toEqual([])
  })
  it('a full stop after a path is not part of it', () => {
    expect(refs('Saved to src/a.js.')).toEqual([['src/a.js', null, null]])
  })
  it('one link for overlapping refs: quoted first, then the longer', () => {
    const all = findFileRefs("say 'see the docs/ here' ok")
    expect(all.map((r) => r.path)).toEqual(['see the docs/ here', 'docs/'])
    // The quoted one does not exist: the folder inside still links.
    expect(pickFileLinks(all, (r) => r.path === 'docs/').map((r) => r.path)).toEqual(['docs/'])
    expect(pickFileLinks(all).map((r) => r.path)).toEqual(['see the docs/ here'])
  })
})
