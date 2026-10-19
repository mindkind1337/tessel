// An agent's file tools as things to open (chat/agentEdits.js): the file and
// line a card names, relative paths read against the right folder (Codex's
// apply_patch: the turn's cwd, which may be a worktree copy), an edit's whole
// before rebuilt from the file as it is now, and a turn's changed files.
import { describe, expect, it } from 'vitest'
import {
  editSteps,
  firstChangedLine,
  joinToolPath,
  locateSteps,
  resolveToolPath,
  revertSteps,
  snippetSides,
  toolFileTarget,
  turnChangedFiles
} from '../agentEdits.js'
import { buildEditCards } from '../orca/native-chat-edit-cards.js'
import { editFilesFromToolPair } from '../orca/shared/native-chat-edit-normalize.js'

const call = (name, input, extra = {}) => ({ type: 'tool-call', name, input, state: 'completed', ...extra })
const local = { worktreeId: 'pane-1', worktreePath: 'C:\\proj', roots: ['C:\\proj'] }

describe('toolFileTarget', () => {
  it("names a Read's file at the line it starts reading", () => {
    expect(toolFileTarget(call('Read', { file_path: 'C:\\proj\\a.js', offset: 40, limit: 20 }))).toEqual({ path: 'C:\\proj\\a.js', line: 40, read: true, edit: false })
    expect(toolFileTarget(call('view_file', { AbsolutePath: '"C:/proj/b.js"', StartLine: 7 }))).toMatchObject({ path: 'C:/proj/b.js', line: 7 })
    expect(toolFileTarget(call('read_file', { target_file: 'src/c.js', start_line_one_indexed: 3 }))).toMatchObject({ path: 'src/c.js', line: 3 })
  })

  it("names an edit's file at the line the agent recorded, and nothing for other tools", () => {
    expect(toolFileTarget(call('Edit', { file_path: 'src/a.js', old_string: 'a', new_string: 'b' }, { editLine: 12 }))).toMatchObject({ path: 'src/a.js', line: 12, edit: true })
    expect(toolFileTarget(call('Write', { file_path: 'src/new.js', content: 'x' }))).toMatchObject({ line: null, edit: true })
    expect(toolFileTarget(call('Bash', { command: 'ls' }))).toBeNull()
    expect(toolFileTarget(call('Read', { file_path: 'a\u0000b' }))).toBeNull()
  })
})

describe('resolveToolPath', () => {
  it('reads an input path against the chat folder it was made relative to, then the pane folder', () => {
    const block = call('Edit', { file_path: 'src/a.js' }, { folder: 'C:\\proj\\sub' })
    expect(resolveToolPath('src/a.js', { block, context: local })).toBe('C:\\proj\\sub\\src\\a.js')
    expect(resolveToolPath('src/a.js', { block: call('Edit', {}), context: local })).toBe('C:\\proj\\src\\a.js')
    expect(resolveToolPath('C:/elsewhere/x.js', { block, context: local })).toBe('C:/elsewhere/x.js')
  })

  it("reads a Codex patch's relative path against the turn's cwd (a worktree copy), never the project folder", () => {
    const block = call('apply_patch', '*** Begin Patch\n*** Update File: src/app.js\n@@\n-a\n+b\n*** End Patch', { cwd: 'C:\\proj.worktrees\\task-1' })
    expect(resolveToolPath('src/app.js', { block, context: local, fromPatch: true })).toBe('C:\\proj.worktrees\\task-1\\src\\app.js')
    expect(resolveToolPath('../other/x.js', { block, context: local, fromPatch: true })).toBe('C:\\proj.worktrees\\other\\x.js')
  })

  it("opens an SSH agent's files by their ssh:// path and a guest's never", () => {
    const remote = { worktreeId: 'p', worktreePath: 'ssh://ssh-box/home/me/app', remote: true, remoteRoot: 'ssh://ssh-box/home/me/app' }
    expect(resolveToolPath('/home/me/app/src/a.js', { context: remote })).toBe('ssh://ssh-box/home/me/app/src/a.js')
    expect(resolveToolPath('src/a.js', { block: call('apply_patch', '', { cwd: '/home/me/wt' }), context: remote, fromPatch: true })).toBe('ssh://ssh-box/home/me/wt/src/a.js')
    const home = { worktreeId: 'p', worktreePath: 'ssh://ssh-box/~', remote: true, remoteRoot: 'ssh://ssh-box/~' }
    expect(resolveToolPath('src/a.js', { context: home })).toBe('ssh://ssh-box/~/src/a.js')
    expect(resolveToolPath('C:\\x.js', { context: remote })).toBeNull()
    expect(resolveToolPath('C:\\proj\\a.js', { context: null })).toBeNull()
    expect(resolveToolPath('\\\\server\\share\\a.js', { context: local })).toBeNull()
    expect(resolveToolPath('~/a.js', { context: local })).toBeNull()
  })

  it('joins POSIX and Windows paths and refuses to climb above the root', () => {
    expect(joinToolPath('/a/b', '../c/./d')).toBe('/a/c/d')
    expect(joinToolPath('C:\\a', 'b/c')).toBe('C:\\a\\b\\c')
    expect(joinToolPath('/a', '../../x')).toBeNull()
  })
})

describe('an edit as steps', () => {
  const now = ['line 1', 'line 2', 'const b = 3', 'line 4', ''].join('\n')

  it("rebuilds a Claude Edit's whole before from the file now, and finds its first changed line", () => {
    const block = call('Edit', { file_path: 'a.js', old_string: 'line 2\nconst b = 2', new_string: 'line 2\nconst b = 3' })
    const steps = editSteps(block)
    expect(revertSteps(now, steps)).toBe(['line 1', 'line 2', 'const b = 2', 'line 4', ''].join('\n'))
    expect(locateSteps(now, steps)).toBe(3)
    // CRLF files read the same.
    expect(locateSteps(now.replace(/\n/g, '\r\n'), steps)).toBe(3)
  })

  it('undoes MultiEdit in reverse order, and says when the file changed since', () => {
    const block = call('MultiEdit', { file_path: 'a.js', edits: [{ old_string: 'one', new_string: 'two' }, { old_string: 'two', new_string: 'three' }] })
    expect(revertSteps('x three y', editSteps(block))).toBe('x one y')
    expect(revertSteps('nothing here', editSteps(block))).toBeNull()
  })

  it("undoes a patch's hunks by their lines and reports its first change", () => {
    const block = call('apply_patch', '*** Begin Patch\n*** Update File: a.js\n@@\n line 1\n-line two\n+line 2\n*** End Patch')
    const [file] = editFilesFromToolPair({ name: 'apply_patch', input: block.input, state: 'completed' })
    const steps = editSteps(block, file)
    expect(steps).toEqual([{ kind: 'lines', before: ['line 1', 'line two'], after: ['line 1', 'line 2'], lead: 1 }])
    expect(locateSteps(now, steps)).toBe(2)
    expect(revertSteps(now, steps).split('\n').slice(0, 2)).toEqual(['line 1', 'line two'])
  })

  it('a new file was empty before; a whole write over an old one cannot be undone from its steps', () => {
    expect(revertSteps('x', editSteps(call('Write', { file_path: 'n.js', content: 'x' }), null, 'File created successfully at: n.js'))).toBe('')
    expect(revertSteps('x', editSteps(call('Write', { file_path: 'n.js', content: 'x' }), null, 'The file n.js has been updated.'))).toBeNull()
    expect(snippetSides([{ kind: 'replace', before: 'a', after: 'b' }, { kind: 'lines', before: ['c'], after: ['d'] }])).toEqual({ original: 'a\n\nc', modified: 'b\n\nd' })
  })

  it("takes a card's own line numbers when its patch carried them", () => {
    const file = {
      lineNumbersKnown: true,
      lines: [
        { kind: 'context', text: 'a', oldLineNumber: 9, newLineNumber: 9 },
        { kind: 'del', text: 'b', oldLineNumber: 10, newLineNumber: null },
        { kind: 'add', text: 'c', oldLineNumber: null, newLineNumber: 10 }
      ]
    }
    expect(firstChangedLine(file)).toBe(10)
    expect(firstChangedLine({ ...file, lineNumbersKnown: false })).toBeNull()
  })
})

describe("a turn's changed files", () => {
  it('sums each file over the turn, keeps every edit, and keeps turns apart', () => {
    const edit = (path, o, n) => call('Edit', { file_path: path, old_string: o, new_string: n })
    const result = (output = 'ok') => ({ type: 'tool-result', output })
    const messages = [
      { id: 'u1', role: 'user', blocks: [{ type: 'text', text: 'go' }] },
      { id: 'a1', role: 'assistant', blocks: [edit('a.js', 'x', 'y\nz'), result(), edit('b.js', 'p', 'q'), result()] },
      { id: 'a2', role: 'assistant', blocks: [edit('a.js', 'z', 'w'), result()] },
      { id: 'u2', role: 'user', blocks: [{ type: 'text', text: 'more' }] },
      { id: 'a3', role: 'assistant', blocks: [{ type: 'text', text: 'nothing' }] }
    ]
    const turns = turnChangedFiles(messages, ['u1', 'u1', 'u1', 'u2', 'u2'], buildEditCards)
    expect([...turns.keys()]).toEqual(['u1'])
    const turn = turns.get('u1')
    expect(turn.files.map((f) => f.path)).toEqual(['a.js', 'b.js'])
    expect(turn.files[0].edits).toHaveLength(2)
    expect(turn.files[0].added).toBe(3)
    expect(turn.added).toBe(turn.files.reduce((n, f) => n + f.added, 0))
  })
})
