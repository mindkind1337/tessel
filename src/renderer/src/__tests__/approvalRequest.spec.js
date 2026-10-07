// The chat view's approval card: what the agent asks to do, from its file's
// pending tool call or its screen's prompt, and the choices it offers.
import { describe, expect, it } from 'vitest'
import { approvalChoice, approvalFromScreen, approvalRequest, cleanText, pendingToolsFromEvents, requestFromTool } from '../chat/approvalRequest.js'

const user = { type: 'user', id: 'u1', text: 'Check the site', origin: 'user', status: 'accepted' }
const curl = "curl -sS -o /dev/null -w '%{http_code} %{url_effective}\\n' -L https://example.test"
const bashCall = { type: 'tool', id: 't1', name: 'Bash', input: { command: curl, description: 'Check the URL' }, status: 'running' }
// The reader closes the file's open calls itself ("done", no result).
const fileEnd = [{ type: 'tool', id: 't1', status: 'done' }, { type: 'turnEnd', status: 'completed' }]

const CLAUDE_BOX = [
  '● Checking the site.',
  '────────────────────────────────────────────────────────',
  ' Bash command',
  '',
  `   ${curl}`,
  '   Check the URL',
  '',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  "   2. Yes, and don't ask again for curl commands in",
  '      /root/project',
  '   3. No, and tell Claude what to do differently (esc)',
  '',
  ' Esc to cancel · Tab to amend'
].join('\n')

const CODEX_BOX = [
  '  Would you like to run the following command?',
  '',
  '  $ npm test -- --watch=false',
  '',
  '› 1. Yes, proceed (y)',
  "  2. Yes, and don't ask again for this command (a)",
  '  3. No, and tell Codex what to do differently (esc)',
  '',
  '  Press enter to confirm or esc to cancel'
].join('\n')

describe('pendingToolsFromEvents', () => {
  it('the call of the current turn with no result is pending, even after the reader closed the file', () => {
    expect(pendingToolsFromEvents([user, bashCall, ...fileEnd])).toEqual([{ id: 't1', name: 'Bash', input: bashCall.input }])
  })
  it('a result, an interruption, a new prompt or the agent writing on clears it; a question tool is not one', () => {
    expect(pendingToolsFromEvents([user, bashCall, { type: 'toolResult', id: 't1', text: '200' }])).toEqual([])
    expect(pendingToolsFromEvents([user, bashCall, { type: 'turnEnd', status: 'interrupted' }])).toEqual([])
    expect(pendingToolsFromEvents([user, bashCall, { ...user, id: 'u2' }])).toEqual([])
    expect(pendingToolsFromEvents([user, bashCall, { type: 'assistant', messageId: 'a', text: 'Done' }])).toEqual([])
    expect(pendingToolsFromEvents([user, { type: 'tool', id: 'q', name: 'AskUserQuestion', input: {}, status: 'running' }])).toEqual([])
  })
})

describe('requestFromTool', () => {
  it('a command: the whole command, its description', () => {
    expect(requestFromTool(bashCall.input && { name: 'Bash', input: bashCall.input })).toMatchObject({ source: 'transcript', tool: 'Bash', kind: 'command', command: curl, detail: 'Check the URL' })
  })
  it("Codex's argv command shows the shell's script", () => {
    expect(requestFromTool({ name: 'shell', input: { command: ['bash', '-lc', 'ls -la && rm -rf build'] } })).toMatchObject({ kind: 'command', command: 'ls -la && rm -rf build' })
  })
  it('an edit: its file and lines added and removed; a write: its file and lines', () => {
    expect(requestFromTool({ name: 'Edit', input: { file_path: '/root/a.js', old_string: 'a\nb', new_string: 'c' } })).toMatchObject({ kind: 'file', path: '/root/a.js', diff: { added: 1, removed: 2 } })
    expect(requestFromTool({ name: 'Write', input: { file_path: '/root/b.md', content: '1\n2\n3' } })).toMatchObject({ kind: 'file', path: '/root/b.md', diff: { added: 3, removed: 0 } })
  })
  it('a fetch: its URL; an MCP tool: its server and tool, its arguments', () => {
    expect(requestFromTool({ name: 'WebFetch', input: { url: 'https://example.test/x', prompt: 'Summarize' } })).toMatchObject({ kind: 'url', url: 'https://example.test/x', detail: 'Summarize' })
    const mcp = requestFromTool({ name: 'mcp__github__create_issue', input: { title: 'Bug' } })
    expect(mcp).toMatchObject({ kind: 'mcp', mcp: { server: 'Github', tool: 'create issue' } })
    expect(mcp.detail).toContain('"title": "Bug"')
  })
})

describe('approvalFromScreen', () => {
  it("Claude Code's box: its title, command, question and choices (a wrapped choice whole)", () => {
    const box = approvalFromScreen(CLAUDE_BOX)
    expect(box.title).toBe('Bash command')
    expect(box.detail).toBe(`${curl}\nCheck the URL`)
    expect(box.question).toBe('Do you want to proceed?')
    expect(box.options).toEqual([
      { number: 1, label: 'Yes' },
      { number: 2, label: "Yes, and don't ask again for curl commands in /root/project" },
      { number: 3, label: 'No, and tell Claude what to do differently (esc)' }
    ])
  })
  it("Codex's prompt: the command under its question, without its $", () => {
    const box = approvalFromScreen(CODEX_BOX)
    expect(box).toMatchObject({ title: '', detail: 'npm test -- --watch=false', question: 'Would you like to run the following command?' })
    expect(box.options.map((o) => o.number)).toEqual([1, 2, 3])
  })
  it('no prompt on screen: nothing; without a box top, nothing above the question is taken', () => {
    expect(approvalFromScreen('● Working on it\n✻ Thinking… (esc to interrupt)')).toBeNull()
    const box = approvalFromScreen('Some reply of the agent\nDo you want to proceed?\n❯ 1. Yes\n  2. No')
    expect(box.title).toBe('')
    expect(box.detail).toBe('')
  })
})

describe('approvalChoice: the options mapped to their keys', () => {
  it('Yes, Yes and do not ask again (its scope), No: each its own number key', () => {
    expect(approvalChoice({ number: 1, label: 'Yes' })).toMatchObject({ kind: 'yes', keys: '1' })
    expect(approvalChoice({ number: 2, label: "Yes, and don't ask again for curl commands in /root (a)" })).toMatchObject({ kind: 'always', scope: 'curl commands in /root', keys: '2' })
    expect(approvalChoice({ number: 2, label: 'Yes, allow all edits during this session (shift+tab)' })).toMatchObject({ kind: 'always', label: 'Yes, allow all edits during this session', keys: '2' })
    expect(approvalChoice({ number: 3, label: 'No, and tell Claude what to do differently (esc)' })).toMatchObject({ kind: 'no', keys: '3' })
    expect(approvalChoice({ number: 1, label: 'Trust and continue' })).toMatchObject({ kind: 'other', keys: '1' })
    // Claude Code's current prompt: a typographic apostrophe, a colon, a gray hint.
    expect(approvalChoice({ number: 2, label: 'Yes, and don’t ask again for: curl *' })).toMatchObject({ kind: 'always', scope: 'curl *', keys: '2' })
    expect(approvalChoice({ number: 3, label: 'Yes, and switch to auto mode · auto mode handles these prompts for you' })).toMatchObject({ kind: 'auto', label: 'Yes, and switch to auto mode', keys: '3' })
    expect(approvalChoice({ number: 4, label: 'No' })).toMatchObject({ kind: 'no', keys: '4' })
    // Only a plain "Yes" is shown as just "Yes".
    expect(approvalChoice({ number: 2, label: 'Yes, during this session' }).kind).not.toBe('yes')
  })
})

describe('approvalRequest', () => {
  it("from the file's pending call, with the screen's choices", () => {
    const r = approvalRequest({ agent: 'claude', events: [user, bashCall, ...fileEnd], screen: CLAUDE_BOX })
    expect(r).toMatchObject({ source: 'transcript', tool: 'Bash', kind: 'command', command: curl, question: 'Do you want to proceed?' })
    expect(r.choices.map((c) => [c.kind, c.keys])).toEqual([['yes', '1'], ['always', '2'], ['no', '3']])
  })
  it('from the file alone (screen unread): the call, no choices (the card keeps Allow / Deny)', () => {
    const r = approvalRequest({ agent: 'claude', events: [user, bashCall, ...fileEnd], screen: '' })
    expect(r).toMatchObject({ source: 'transcript', command: curl })
    expect(r.choices).toEqual([])
  })
  it("from the screen alone (the file lags: Codex), and a box showing another call than the file's", () => {
    expect(approvalRequest({ agent: 'codex', events: [], screen: CODEX_BOX })).toMatchObject({ source: 'screen', detail: 'npm test -- --watch=false' })
    const other = { type: 'tool', id: 't9', name: 'Bash', input: { command: 'sleep 100' }, status: 'running' }
    const r = approvalRequest({ agent: 'claude', events: [user, other], screen: CLAUDE_BOX })
    expect(r).toMatchObject({ source: 'screen', tool: 'Bash command' })
    expect(r.detail).toContain('curl -sS')
  })
  it('of several pending calls, the one its box shows', () => {
    const other = { type: 'tool', id: 't0', name: 'Bash', input: { command: 'sleep 100' }, status: 'running' }
    expect(approvalRequest({ agent: 'claude', events: [user, other, bashCall], screen: CLAUDE_BOX })).toMatchObject({ source: 'transcript', command: curl })
  })
  it('nothing readable: null (the generic note); choices only for agents whose selector takes numbers', () => {
    expect(approvalRequest({ agent: 'claude', events: [user], screen: '● Working' })).toBeNull()
    const cursor = approvalRequest({ agent: 'cursor', events: [user, bashCall], screen: CLAUDE_BOX })
    expect(cursor.choices).toEqual([])
  })
  it('the agent\'s text is cleaned: control and bidirectional characters removed', () => {
    expect(cleanText('rm\u001b[31m -rf‮ /\u0007')).toBe('rm[31m -rf /')
    const r = approvalRequest({ agent: 'claude', events: [user, { ...bashCall, input: { command: 'echo <img src=x onerror=alert(1)>‮' } }] })
    expect(r.command).toBe('echo <img src=x onerror=alert(1)>')
  })
})
