import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { spawn } from 'child_process'
import { createRequire } from 'module'
import { ensureTeamChannel, pollTeamChannel } from '../teamChannel'
import { takeTeamAcks } from '../teamAcks'
import { writeCurrentTeams, retireOldTeams, addNotices } from '../teamNotices'
import { publishTeamTasks, takeTeamRequests, finishTeamRequests, messageStatuses, writeBoardPanes, toolsAlive } from '../teamTasks'

// Run inside a Tessel pane, these tests would inherit its team identity
// (TESSEL_TEAM_SECRET / TESSEL_PANE_ID) and the tools would sign as that
// pane: each test sets up its own.
delete process.env.TESSEL_TEAM_SECRET
delete process.env.TESSEL_PANE_ID
// ... and its agent (TESSEL_AGENT_PROVIDER): a hook reports its conversation
// only for the pane's own agent.
delete process.env.TESSEL_AGENT_PROVIDER

const require = createRequire(import.meta.url)
const SERVER = join(__dirname, '..', 'teamMcp', 'server.cjs')
const mcp = require(SERVER)

describe('Tessel team tools (background messages)', () => {
  let dir
  const teamId = 'team-1'
  const A = { id: 'pane-1-aaaaaa', num: 1, title: 'Codex CLI' }
  const B = { id: 'pane-4-bbbbbb', num: 4, title: 'Claude Code' }
  const as = (pane) => {
    process.env.TESSEL_PANE_ID = pane.id
    process.env.TESSEL_PROJECT_DIR = dir
    return mcp.locate()
  }
  const state = () => JSON.parse(fs.readFileSync(join(dir, '.tessel', 'team-channel', teamId, 'state.json'), 'utf8'))

  beforeEach(() => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-mcp-'))
    expect(ensureTeamChannel({ dir, teamId, members: [A, B] }).ok).toBe(true)
    // Tessel's map of who is in which team now.
    writeCurrentTeams({ dir, panes: { [A.id]: { team: teamId, num: 1 }, [B.id]: { team: teamId, num: 4 } } })
  })
  afterEach(() => {
    delete process.env.TESSEL_PANE_ID
    delete process.env.TESSEL_PROJECT_DIR
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('finds me by pane id, or by my number', () => {
    expect(as(B).meId).toBe(B.id)
    delete process.env.TESSEL_PANE_ID
    expect(mcp.locate('#1', dir).meId).toBe(A.id)
    expect(mcp.locate(null, dir).error).toMatch(/pass your agent name/)
  })

  it('a bound pane identity cannot be overridden by "me"', () => {
    process.env.TESSEL_PANE_ID = A.id
    process.env.TESSEL_PROJECT_DIR = dir
    expect(mcp.locate('#4').meId).toBe(A.id)
  })

  it('only the current team counts: an ungrouped team is never used', () => {
    ensureTeamChannel({ dir, teamId: 'team-2-new', members: [A, B] })
    writeCurrentTeams({ dir, panes: { [A.id]: { team: 'team-2-new', num: 1 }, [B.id]: { team: 'team-2-new', num: 4 } } })
    expect(retireOldTeams({ dir, liveTeamIds: ['team-2-new'] }).retired).toEqual([teamId])
    expect(as(A).teamId).toBe('team-2-new')
    writeCurrentTeams({ dir, panes: {} })
    expect(as(A).error).toMatch(/no longer in a Tessel team/)
  })

  it('a message is marked read only if it is shown (a failed read note leaves it unread)', () => {
    mcp.send(as(A), '#4', 'one')
    mcp.send(as(A), '#4', 'two')
    pollTeamChannel({ dir, teamId })
    const ctx = as(B)
    const realLink = fs.linkSync
    let calls = 0
    fs.linkSync = (...a) => {
      if (String(a[1]).includes('acks') && ++calls === 2) throw new Error('disk full')
      return realLink(...a)
    }
    let first
    try {
      first = mcp.readInbox(ctx)
    } finally {
      fs.linkSync = realLink
    }
    expect(first).toMatch(/one/)
    expect(first).not.toMatch(/two/)
    expect(mcp.readInbox(as(B))).toMatch(/two/)
  })

  it('refuses a message that is too long instead of cutting it', () => {
    const r = mcp.send(as(A), '#4', 'x'.repeat(6000) + ' DO NOT MERGE')
    expect(r.error).toMatch(/too long/)
    expect(fs.readdirSync(join(dir, '.tessel', 'team-channel', teamId, 'outbox', state().members[A.id].token)).filter((n) => n.endsWith('.json'))).toEqual([])
  })

  it("shows Tessel's notices once, and Tessel removes them when read", () => {
    addNotices({ dir, teamId, notices: [{ toId: B.id, text: 'Team 1 was renamed.' }] })
    expect(mcp.readInbox(as(B))).toMatch(/\[Tessel → you, message n-.+\] Team 1 was renamed\./)
    expect(mcp.readInbox(as(B))).toBe('')
    takeTeamAcks({ dir, teamId })
    const n = JSON.parse(fs.readFileSync(join(dir, '.tessel', 'team-channel', teamId, 'notices.json'), 'utf8'))
    expect(n.notices).toEqual([])
  })

  it('finds the project from a task copy next to it', () => {
    expect(mcp.candidateDirs(join(dir + '.worktrees', 'fix'))).toContain(dir)
  })

  it('A sends, B reads it in the background, A gets its receipt, nothing is typed anywhere', () => {
    expect(mcp.send(as(A), '#4', 'Hello from A').ok).toBe(true)
    pollTeamChannel({ dir, teamId }) // Tessel takes the outbox in
    const inbox = mcp.readInbox(as(B))
    expect(inbox).toMatch(/\[Codex CLI \(Codex CLI\) → you, message .+\] Hello from A/)
    // Read once: not shown again.
    expect(mcp.readInbox(as(B))).toBe('')
    // Tessel turns the read note into the acknowledgement.
    expect(takeTeamAcks({ dir, teamId }).count).toBe(1)
    expect(state().messages.find((m) => m.text === 'Hello from A').status).toBe('delivered')
    // The receipt is marked read for A without being shown.
    expect(mcp.readInbox(as(A))).toBe('')
    expect(takeTeamAcks({ dir, teamId }).count).toBe(1)
    expect(state().messages.every((m) => m.status === 'delivered')).toBe(true)
  })

  it('refuses a bad recipient and an empty text', () => {
    expect(mcp.send(as(A), 'lead', 'x').error).toMatch(/Valid names/)
    expect(mcp.send(as(A), '#4', '  ').error).toMatch(/empty/)
  })

  it('speaks MCP over stdio', async () => {
    const child = spawn(process.execPath, [SERVER], {
      env: { ...process.env, TESSEL_PANE_ID: A.id, TESSEL_PROJECT_DIR: dir }
    })
    const lines = []
    let buf = ''
    child.stdout.on('data', (c) => {
      buf += c
      let i
      while ((i = buf.indexOf('\n')) !== -1) {
        lines.push(JSON.parse(buf.slice(0, i)))
        buf = buf.slice(i + 1)
      }
    })
    const send = (m) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n')
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } })
    send({ method: 'notifications/initialized' })
    send({ id: 2, method: 'tools/list' })
    send({ id: 3, method: 'tools/call', params: { name: 'team_send', arguments: { to: '#4', text: 'Over MCP' } } })
    send({ id: 4, method: 'tools/call', params: { name: 'team_members', arguments: {} } })
    await new Promise((r) => setTimeout(r, 800))
    child.kill()
    const byId = Object.fromEntries(lines.map((l) => [l.id, l]))
    expect(byId[1].result.serverInfo.name).toBe('tessel-team')
    expect(byId[1].result.instructions).toMatch(/team_inbox/)
    expect(byId[2].result.tools.map((t) => t.name)).toEqual([
      'team_inbox',
      'team_send',
      'team_members',
      'team_tasks',
      'team_task_add',
      'team_task_move',
      'team_task_done',
      'team_task_gate',
      'team_ask',
      'team_worker_start',
      'team_worker_list',
      'team_worker_read',
      'team_worker_stop',
      'team_worker_release',
      'team_worker_done',
      'team_heartbeat',
      'team_gates',
      'browser_pages',
      'browser_open',
      'browser_navigate',
      'browser_snapshot',
      'browser_click',
      'browser_fill',
      'browser_type',
      'browser_press',
      'browser_scroll',
      'browser_screenshot',
      'browser_console',
      'browser_wait'
    ])
    expect(byId[3].result.content[0].text).toMatch(/Sent to Claude Code/)
    expect(byId[4].result.content[0].text).toMatch(/Codex CLI \(Codex CLI\) \(you\)/)
    expect(lines.some((l) => l.id === undefined)).toBe(false) // no reply to the notification
  })

  it('as a Claude Code hook: unread messages become context; nothing when none', async () => {
    mcp.send(as(A), '#4', 'Ping for the hook')
    pollTeamChannel({ dir, teamId })
    const run = (input) =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, [SERVER, '--hook'], {
          env: { ...process.env, TESSEL_PANE_ID: B.id, TESSEL_PROJECT_DIR: dir }
        })
        let out = ''
        child.stdout.on('data', (c) => (out += c))
        child.on('close', () => resolve(out))
        child.stdin.end(JSON.stringify(input))
      })
    // A sub-agent's event (agent_id): nothing shown, and the message stays
    // unread for the agent itself.
    expect(await run({ hook_event_name: 'PostToolUse', cwd: dir, agent_id: 'sub-1', agent_type: 'Explore' })).toBe('')
    const first = JSON.parse(await run({ hook_event_name: 'PostToolUse', cwd: dir }))
    expect(first.hookSpecificOutput.hookEventName).toBe('PostToolUse')
    expect(first.hookSpecificOutput.additionalContext).toMatch(/Ping for the hook/)
    expect(await run({ hook_event_name: 'PostToolUse', cwd: dir })).toBe('')
    // Stop: blocks once with the new messages, never when already continuing.
    mcp.send(as(A), '#4', 'Another one')
    pollTeamChannel({ dir, teamId })
    expect(await run({ hook_event_name: 'Stop', cwd: dir, stop_hook_active: true })).toBe('')
    const stop = JSON.parse(await run({ hook_event_name: 'Stop', cwd: dir }))
    expect(stop.decision).toBe('block')
    expect(stop.reason).toMatch(/Another one/)
  })

  it('in a chat agent (TESSEL_CHAT=1) the hook never claims messages: Tessel gives them as turns', async () => {
    mcp.send(as(A), '#4', 'For the chat agent')
    pollTeamChannel({ dir, teamId })
    const run = (input, extra = {}) =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, [SERVER, '--hook'], {
          env: { ...process.env, TESSEL_PANE_ID: B.id, TESSEL_PROJECT_DIR: dir, ...extra }
        })
        let out = ''
        child.stdout.on('data', (c) => (out += c))
        child.on('close', () => resolve(out))
        child.stdin.end(JSON.stringify(input))
      })
    expect(await run({ hook_event_name: 'PostToolUse', cwd: dir }, { TESSEL_CHAT: '1' })).toBe('')
    expect(await run({ hook_event_name: 'Stop', cwd: dir }, { TESSEL_CHAT: '1' })).toBe('')
    // Still unread: a terminal agent's hook shows it.
    const shown = JSON.parse(await run({ hook_event_name: 'PostToolUse', cwd: dir }))
    expect(shown.hookSpecificOutput.additionalContext).toMatch(/For the chat agent/)
  })

  it("Claude Code's session file path is recorded only inside its own projects folder (no content)", async () => {
    const sessions = fs.mkdtempSync(join(os.tmpdir(), 'tessel-sessions-'))
    const config = fs.mkdtempSync(join(os.tmpdir(), 'tessel-claude-config-'))
    const run = (input) =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, [SERVER, '--hook'], {
          env: { ...process.env, TESSEL_PANE_ID: B.id, TESSEL_PROJECT_DIR: dir, TESSEL_SESSIONS_DIR: sessions, CLAUDE_CONFIG_DIR: config }
        })
        child.on('close', () => resolve())
        child.stdin.end(JSON.stringify({ session_id: '11111111-2222-4333-8444-555555555555', cwd: dir, hook_event_name: 'SessionStart', ...input }))
      })
    const report = () => JSON.parse(fs.readFileSync(join(sessions, `${B.id}.json`), 'utf8'))
    const inside = join(config, 'projects', 'C--proj', '99999999-2222-4333-8444-555555555555.jsonl')
    await run({ transcript_path: inside })
    expect(report()).toMatchObject({ agent: 'claude', transcriptPath: inside })
    for (const bad of [join(config, 'settings.jsonl'), join(config, 'projects', '..', '..', 'x.jsonl'), join(config, 'projects', 'a.txt'), 'relative/a.jsonl']) {
      fs.rmSync(join(sessions, `${B.id}.json`), { force: true })
      await run({ transcript_path: bad })
      expect(report().transcriptPath).toBeUndefined()
    }
    fs.rmSync(sessions, { recursive: true, force: true })
    fs.rmSync(config, { recursive: true, force: true })
  })

  it("Cursor's transcript path is recorded only inside ~/.cursor/projects, never a sub-agent's", async () => {
    const sessions = fs.mkdtempSync(join(os.tmpdir(), 'tessel-sessions-'))
    const home = fs.mkdtempSync(join(os.tmpdir(), 'tessel-cursor-home-'))
    const id = '11111111-2222-4333-8444-555555555555'
    const run = (input) =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, [SERVER, '--hook', '--agent=cursor', '--event=stop'], {
          env: { ...process.env, TESSEL_PANE_ID: B.id, TESSEL_SESSIONS_DIR: sessions, TESSEL_AGENT_PROVIDER: 'cursor', USERPROFILE: home, HOME: home }
        })
        child.on('close', () => resolve())
        child.stdin.end(JSON.stringify({ conversation_id: id, hook_event_name: 'stop', status: 'completed', ...input }))
      })
    const file = join(sessions, `${B.id}.json`)
    const report = () => JSON.parse(fs.readFileSync(file, 'utf8'))
    const inside = join(home, '.cursor', 'projects', 'C-proj', 'agent-transcripts', id, `${id}.jsonl`)
    await run({ transcript_path: inside })
    expect(report()).toMatchObject({ agent: 'cursor', sessionId: id, transcriptPath: inside })
    // A sub-agent's event: the pane's conversation is left as it was.
    fs.rmSync(file, { force: true })
    await run({ conversation_id: '99999999-2222-4333-8444-555555555555', transcript_path: join(home, '.cursor', 'projects', 'C-proj', 'agent-transcripts', id, 'subagents', 'x.jsonl') })
    expect(fs.existsSync(file)).toBe(false)
    for (const bad of [join(home, '.cursor', 'cli-config.jsonl'), join(home, '.cursor', 'projects', '..', 'x.jsonl'), 'relative/a.jsonl']) {
      fs.rmSync(file, { force: true })
      await run({ transcript_path: bad })
      expect(report().transcriptPath).toBeUndefined()
    }
    fs.rmSync(sessions, { recursive: true, force: true })
    fs.rmSync(home, { recursive: true, force: true })
  })

  it("Antigravity's conversation id is recorded (no path, no prompt), never a sub-agent's", async () => {
    const sessions = fs.mkdtempSync(join(os.tmpdir(), 'tessel-sessions-'))
    const id = '11111111-2222-4333-8444-555555555555'
    const run = (input) =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, [SERVER, '--hook', '--agent=antigravity', '--event=PostInvocation'], {
          env: { ...process.env, TESSEL_PANE_ID: B.id, TESSEL_SESSIONS_DIR: sessions, TESSEL_AGENT_PROVIDER: 'antigravity' }
        })
        child.on('close', () => resolve())
        child.stdin.end(JSON.stringify({ conversationId: id, transcriptPath: 'C:\\x\\transcript.jsonl', modelName: 'auto', invocationNum: 1, ...input }))
      })
    const file = join(sessions, `${B.id}.json`)
    await run({})
    const report = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(report).toMatchObject({ agent: 'antigravity', sessionId: id })
    expect(report.transcriptPath).toBeUndefined()
    expect(Object.keys(report).sort()).toEqual(['agent', 'at', 'cwd', 'sessionId', 'source'])
    expect(report.source).toBe('PostInvocation')
    // A sub-agent's event: the pane's conversation is left as it was.
    fs.rmSync(file, { force: true })
    await run({ conversationId: '99999999-2222-4333-8444-555555555555', parentConversationId: id })
    expect(fs.existsSync(file)).toBe(false)
    fs.rmSync(sessions, { recursive: true, force: true })
  })

  it('as a Gemini CLI hook: the same answers under its event names, and its conversation reported', async () => {
    const sessions = fs.mkdtempSync(join(os.tmpdir(), 'tessel-sessions-'))
    mcp.send(as(A), '#4', 'Gemini, after a tool')
    pollTeamChannel({ dir, teamId })
    const run = (input) =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, [SERVER, '--hook', '--gemini'], {
          env: { ...process.env, TESSEL_PANE_ID: B.id, TESSEL_PROJECT_DIR: dir, TESSEL_SESSIONS_DIR: sessions }
        })
        let out = ''
        child.stdout.on('data', (c) => (out += c))
        child.on('close', () => resolve(out))
        child.stdin.end(JSON.stringify({ session_id: 'gem-session-0001', cwd: dir, ...input }))
      })
    expect(await run({ hook_event_name: 'SessionStart', source: 'startup' })).toBe('')
    expect(JSON.parse(fs.readFileSync(join(sessions, `${B.id}.json`), 'utf8'))).toMatchObject({ agent: 'gemini', sessionId: 'gem-session-0001' })
    const after = JSON.parse(await run({ hook_event_name: 'AfterTool', tool_name: 'read_file' }))
    expect(after.hookSpecificOutput.hookEventName).toBe('AfterTool')
    expect(after.hookSpecificOutput.additionalContext).toMatch(/Gemini, after a tool/)
    // A prompt: the board rule, like Claude Code's UserPromptSubmit.
    const prompt = JSON.parse(await run({ hook_event_name: 'BeforeAgent', prompt: 'hi' }))
    expect(prompt.hookSpecificOutput.hookEventName).toBe('BeforeAgent')
    // The turn's end: continues once with a new message, never when already continuing.
    mcp.send(as(A), '#4', 'Gemini, before you stop')
    pollTeamChannel({ dir, teamId })
    expect(await run({ hook_event_name: 'AfterAgent', stop_hook_active: true })).toBe('')
    const stop = JSON.parse(await run({ hook_event_name: 'AfterAgent', stop_hook_active: false }))
    expect(stop.decision).toBe('block')
    expect(stop.reason).toMatch(/Gemini, before you stop/)
    fs.rmSync(sessions, { recursive: true, force: true })
  })

  it("as OpenCode's plugin calls it: Claude's answers, its conversation reported as OpenCode's", async () => {
    const sessions = fs.mkdtempSync(join(os.tmpdir(), 'tessel-sessions-'))
    mcp.send(as(A), '#4', 'OpenCode, when idle')
    pollTeamChannel({ dir, teamId })
    const run = (input) =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, [SERVER, '--hook', '--opencode'], {
          env: { ...process.env, TESSEL_PANE_ID: B.id, TESSEL_PROJECT_DIR: dir, TESSEL_SESSIONS_DIR: sessions }
        })
        let out = ''
        child.stdout.on('data', (c) => (out += c))
        child.on('close', () => resolve(out))
        child.stdin.end(JSON.stringify({ session_id: 'ses_open0001', cwd: dir, stop_hook_active: false, ...input }))
      })
    expect(await run({ hook_event_name: 'SessionStart' })).toBe('')
    expect(JSON.parse(fs.readFileSync(join(sessions, `${B.id}.json`), 'utf8'))).toMatchObject({ agent: 'opencode', sessionId: 'ses_open0001' })
    // Peek (the plugin, when idle): counts, reads nothing.
    expect(JSON.parse(await run({ hook_event_name: 'Peek' }))).toEqual({ unread: 1 })
    expect(JSON.parse(await run({ hook_event_name: 'Peek' }))).toEqual({ unread: 1 })
    const stop = JSON.parse(await run({ hook_event_name: 'Stop' }))
    expect(stop).toMatchObject({ decision: 'block' })
    expect(stop.reason).toMatch(/OpenCode, when idle/)
    expect(await run({ hook_event_name: 'Stop' })).toBe('') // nothing waits any more
    fs.rmSync(sessions, { recursive: true, force: true })
  })

  it('as a Copilot CLI hook: event from its command, camelCase ids, never reads at a prompt', async () => {
    const sessions = fs.mkdtempSync(join(os.tmpdir(), 'tessel-sessions-'))
    mcp.send(as(A), '#4', 'Copilot, after a tool')
    pollTeamChannel({ dir, teamId })
    const run = (event, input) =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, [SERVER, '--hook', '--copilot', `--event=${event}`], {
          env: { ...process.env, TESSEL_PANE_ID: B.id, TESSEL_PROJECT_DIR: dir, TESSEL_SESSIONS_DIR: sessions }
        })
        let out = ''
        child.stdout.on('data', (c) => (out += c))
        child.on('close', () => resolve(out))
        child.stdin.end(JSON.stringify({ sessionId: 'cop-session-0001', cwd: dir, ...input }))
      })
    expect(await run('SessionStart', { source: 'new' })).toBe('')
    expect(JSON.parse(fs.readFileSync(join(sessions, `${B.id}.json`), 'utf8'))).toMatchObject({ agent: 'copilot', sessionId: 'cop-session-0001' })
    // Its prompt hook cannot add text: the message stays unread for later.
    expect(await run('UserPromptSubmit', { prompt: 'hi' })).toBe('')
    const after = JSON.parse(await run('PostToolUse', { toolName: 'view' }))
    expect(after.additionalContext).toMatch(/Copilot, after a tool/)
    mcp.send(as(A), '#4', 'Copilot, before you stop')
    pollTeamChannel({ dir, teamId })
    expect(await run('Stop', { stop_hook_active: true })).toBe('')
    const stop = JSON.parse(await run('Stop', { stop_hook_active: false }))
    expect(stop).toMatchObject({ decision: 'block' })
    expect(stop.reason).toMatch(/Copilot, before you stop/)
    fs.rmSync(sessions, { recursive: true, force: true })
  })

  it('reports the conversation the agent is really in (start, /clear, /resume), team or not', async () => {
    const sessions = fs.mkdtempSync(join(os.tmpdir(), 'tessel-sessions-'))
    const run = (input, extra = []) =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, [SERVER, '--hook', ...extra], {
          env: { ...process.env, TESSEL_PANE_ID: 'pane-9-solo', TESSEL_SESSIONS_DIR: sessions }
        })
        let out = ''
        child.stdout.on('data', (c) => (out += c))
        child.on('close', () => resolve(out))
        child.stdin.end(JSON.stringify(input))
      })
    const report = () => JSON.parse(fs.readFileSync(join(sessions, 'pane-9-solo.json'), 'utf8'))
    // SessionStart: recorded, nothing printed (a pane in no team).
    expect(await run({ hook_event_name: 'SessionStart', source: 'startup', session_id: '11111111-aaaa-4bbb-8ccc-000000000001', cwd: dir })).toBe('')
    expect(report()).toMatchObject({ agent: 'claude', sessionId: '11111111-aaaa-4bbb-8ccc-000000000001', source: 'startup' })
    // /clear: a new conversation, reported at once.
    await run({ hook_event_name: 'SessionStart', source: 'clear', session_id: '22222222-aaaa-4bbb-8ccc-000000000002', cwd: dir })
    expect(report()).toMatchObject({ sessionId: '22222222-aaaa-4bbb-8ccc-000000000002', source: 'clear' })
    // Any later event carries it too; Codex's hook says so.
    await run({ hook_event_name: 'UserPromptSubmit', session_id: '019a0000-cccc-7ddd-8eee-000000000003', cwd: dir }, ['--codex'])
    expect(report()).toMatchObject({ agent: 'codex', sessionId: '019a0000-cccc-7ddd-8eee-000000000003' })
    // Never a strange id.
    await run({ hook_event_name: 'UserPromptSubmit', session_id: '../../evil', cwd: dir })
    expect(report().sessionId).toBe('019a0000-cccc-7ddd-8eee-000000000003')
    fs.rmSync(sessions, { recursive: true, force: true })
  })

  it("reports Claude Code's own inbox (pipe and key) with its conversation, never Codex's", async () => {
    const sessions = fs.mkdtempSync(join(os.tmpdir(), 'tessel-sessions-'))
    const run = (input, env, extra = []) =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, [SERVER, '--hook', ...extra], {
          env: { ...process.env, TESSEL_PANE_ID: 'pane-9-box', TESSEL_SESSIONS_DIR: sessions, ...env }
        })
        child.on('close', resolve)
        child.stdin.end(JSON.stringify(input))
      })
    const report = () => JSON.parse(fs.readFileSync(join(sessions, 'pane-9-box.json'), 'utf8'))
    const ev = { hook_event_name: 'SessionStart', source: 'startup', session_id: '33333333-aaaa-4bbb-8ccc-000000000003', cwd: dir }
    await run(ev, { CLAUDE_CODE_MESSAGING_SOCKET: '\\\\.\\pipe\\LOCAL\\cc-msg-1', CLAUDE_CODE_MESSAGING_TOKEN: 'tok-1' })
    expect(report()).toMatchObject({ agent: 'claude', inbox: '\\\\.\\pipe\\LOCAL\\cc-msg-1', inboxToken: 'tok-1' })
    // Same conversation in a new process (a restart): its new inbox replaces the old.
    await run({ ...ev, hook_event_name: 'UserPromptSubmit' }, { CLAUDE_CODE_MESSAGING_SOCKET: '\\\\.\\pipe\\LOCAL\\cc-msg-2', CLAUDE_CODE_MESSAGING_TOKEN: 'tok-2' })
    expect(report()).toMatchObject({ inbox: '\\\\.\\pipe\\LOCAL\\cc-msg-2', inboxToken: 'tok-2' })
    // Codex: no inbox, even if the variables are around.
    await run({ ...ev, session_id: '019a0000-cccc-7ddd-8eee-000000000004' }, { CLAUDE_CODE_MESSAGING_SOCKET: '\\\\.\\pipe\\x', CLAUDE_CODE_MESSAGING_TOKEN: 't' }, ['--codex'])
    expect(report().inbox).toBeUndefined()
    fs.rmSync(sessions, { recursive: true, force: true })
  })

  it('each user message reminds Claude Code of the board rule, with its open cards', async () => {
    const run = (input) =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, [SERVER, '--hook'], {
          env: { ...process.env, TESSEL_PANE_ID: B.id, TESSEL_PROJECT_DIR: dir }
        })
        let out = ''
        child.stdout.on('data', (c) => (out += c))
        child.on('close', () => resolve(out))
        child.stdin.end(JSON.stringify(input))
      })
    const none = JSON.parse(await run({ hook_event_name: 'UserPromptSubmit', cwd: dir }))
    expect(none.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit')
    expect(none.hookSpecificOutput.additionalContext).toMatch(/add a card for every piece of work the moment you start it/)
    expect(none.hookSpecificOutput.additionalContext).toMatch(/each step you decide to take/)
    expect(none.hookSpecificOutput.additionalContext).toMatch(/no open card/)
    fs.writeFileSync(
      join(dir, '.tessel', 'team-channel', teamId, 'tasks.json'),
      JSON.stringify({
        tasks: [
          { id: 'task-1-a', title: 'Mine, working', column: 'doing', assignee: '#4' },
          { id: 'task-2-b', title: 'Mine, finished', column: 'done', assignee: '#4' },
          { id: 'task-3-c', title: 'Not mine', column: 'doing', assignee: '#1' }
        ]
      })
    )
    const ctxText = JSON.parse(await run({ hook_event_name: 'UserPromptSubmit', cwd: dir })).hookSpecificOutput.additionalContext
    expect(ctxText).toMatch(/Your open cards: task-1-a "Mine, working" \(Doing\)\./)
    expect(ctxText).not.toMatch(/Mine, finished|Not mine/)
    // Other events stay quiet without messages.
    expect(await run({ hook_event_name: 'PostToolUse', cwd: dir })).toBe('')
  })
})

describe('setting up the team tools', () => {
  let home
  const script = 'C:\\Users\\x\\AppData\\Roaming\\tessel\\tessel-team-mcp.cjs'
  // The absolute node the commands run, and how it is written in them.
  const NODE = 'C:\\Program Files\\nodejs\\node.exe'
  const N = 'C:/"Program Files/nodejs/node.exe"'
  beforeEach(() => {
    home = fs.mkdtempSync(join(os.tmpdir(), 'tessel-home-'))
  })
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }))

  it('adds the Claude hooks once, keeping other hooks and settings', async () => {
    const { installClaudeHooks } = await import('../teamInstall')
    fs.mkdirSync(join(home, '.claude'))
    const file = join(home, '.claude', 'settings.json')
    fs.writeFileSync(file, JSON.stringify({ model: 'x', hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'mine.sh' }] }] } }))
    expect(installClaudeHooks(script, home, { node: NODE })).toEqual({ changed: true })
    const s = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(s.model).toBe('x')
    expect(s.hooks.Stop.map((g) => g.hooks[0].command)).toEqual(['mine.sh', `${N} "${script}" --hook`])
    expect(s.hooks.UserPromptSubmit[0].hooks[0].command).toMatch(/--hook$/)
    // SessionStart too: it tells Tessel the conversation after /clear, /resume.
    expect(s.hooks.SessionStart[0].hooks[0].command).toMatch(/--hook$/)
    expect(fs.existsSync(file + '.before-tessel')).toBe(true)
    expect(installClaudeHooks(script, home, { node: NODE })).toEqual({ changed: false }) // already there
  })

  it('adds the Codex session and Stop hooks, keeping the user own', async () => {
    const { installCodexHooks } = await import('../teamInstall')
    fs.mkdirSync(join(home, '.codex'))
    const file = join(home, '.codex', 'hooks.json')
    fs.writeFileSync(file, JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'mine.py' }] }], Stop: [{ hooks: [{ type: 'command', command: 'my-stop.cmd' }] }] } }))
    expect(installCodexHooks(script, home, { node: NODE })).toEqual({ changed: true })
    const h = JSON.parse(fs.readFileSync(file, 'utf8')).hooks
    const cmd = `${N} "${script}" --hook --codex`
    expect(h.UserPromptSubmit.map((g) => g.hooks[0].command)).toEqual(['mine.py', cmd])
    expect(h.SessionStart[0].hooks[0]).toEqual({ type: 'command', command: cmd, commandWindows: cmd })
    expect(h.Stop.map((g) => g.hooks[0].command)).toEqual(['my-stop.cmd', cmd])
    expect(h.Stop[1].hooks[0]).toEqual({ type: 'command', command: cmd, commandWindows: cmd })
    expect(installCodexHooks(script, home, { node: NODE })).toEqual({ changed: false })
  })

  it('adds the Gemini CLI hooks, keeping its servers and other entries (even ones Gemini ignores)', async () => {
    const { installGeminiHooks } = await import('../teamInstall')
    fs.mkdirSync(join(home, '.gemini'))
    const file = join(home, '.gemini', 'settings.json')
    const flat = { type: 'command', command: 'bs-agent-notify.cjs', timeout: 5000 } // no hooks:[...] wrapper
    fs.writeFileSync(
      file,
      JSON.stringify({ mcpServers: { x: { command: 'y' } }, hooks: { AfterAgent: [flat], AfterTool: [{ matcher: '*', hooks: [{ type: 'command', command: 'mine.sh' }] }] } })
    )
    expect(installGeminiHooks(script, home, { node: NODE })).toEqual({ changed: true })
    const s = JSON.parse(fs.readFileSync(file, 'utf8'))
    const cmd = `${N} "${script}" --hook --gemini`
    expect(s.mcpServers).toEqual({ x: { command: 'y' } })
    expect(s.hooks.AfterAgent[0]).toEqual(flat)
    expect(s.hooks.AfterAgent[1].hooks[0].command).toBe(cmd)
    expect(s.hooks.AfterTool.map((g) => g.hooks[0].command)).toEqual(['mine.sh', cmd])
    for (const ev of ['SessionStart', 'BeforeAgent']) expect(s.hooks[ev][0].hooks[0].command).toBe(cmd)
    expect(installGeminiHooks(script, home, { node: NODE })).toEqual({ changed: false })
  })

  it('writes the Copilot CLI hooks in their own file, once, never its settings', async () => {
    const { installCopilotHooks } = await import('../teamInstall')
    fs.mkdirSync(join(home, '.copilot'))
    fs.writeFileSync(join(home, '.copilot', 'settings.json'), '{"hooks":{"agentStop":[{"type":"command","bash":"theirs"}]}}')
    expect(installCopilotHooks(script, home, { node: NODE })).toEqual({ changed: true })
    const h = JSON.parse(fs.readFileSync(join(home, '.copilot', 'hooks', 'tessel-team.json'), 'utf8'))
    expect(h.version).toBe(1)
    const { COPILOT_HOOK_EVENTS } = await import('../teamInstall')
    expect(Object.keys(h.hooks)).toEqual(COPILOT_HOOK_EVENTS)
    expect(COPILOT_HOOK_EVENTS).toEqual(expect.arrayContaining(['SessionStart', 'PostToolUse', 'Stop', 'subagentStart', 'SubagentStop']))
    const cmd = `${N} "${script}" --hook --copilot --event=Stop`
    expect(h.hooks.Stop).toEqual([{ type: 'command', bash: cmd, powershell: cmd, timeoutSec: 30 }])
    expect(fs.readFileSync(join(home, '.copilot', 'settings.json'), 'utf8')).toMatch(/theirs/)
    expect(installCopilotHooks(script, home, { node: NODE })).toEqual({ changed: false })
  })

  it('writes the OpenCode plugin once, never over a file that is not Tessel’s', async () => {
    const { installOpencodePlugin, opencodePlugin } = await import('../teamInstall')
    const file = join(home, '.config', 'opencode', 'plugins', 'tessel-team.js')
    expect(installOpencodePlugin(script, home, { node: NODE })).toEqual({ changed: true })
    const text = fs.readFileSync(file, 'utf8')
    expect(text).toBe(opencodePlugin(script, NODE))
    expect(text).toContain(JSON.stringify(script))
    // Nothing outside a Tessel pane, nor in a chat pane's OpenCode.
    expect(text).toMatch(/if \(!process\.env\.TESSEL_PANE_ID \|\| process\.env\.TESSEL_CHAT === '1'\) return \{\}/)
    expect(installOpencodePlugin(script, home, { node: NODE })).toEqual({ changed: false })
    fs.writeFileSync(file, 'export const Mine = async () => ({})\n')
    expect(installOpencodePlugin(script, home, { node: NODE }).error).toMatch(/not Tessel's/)
    expect(fs.readFileSync(file, 'utf8')).toMatch(/Mine/)
  })

  it('never overwrites a settings file it cannot read', async () => {
    const { installClaudeHooks } = await import('../teamInstall')
    fs.mkdirSync(join(home, '.claude'))
    fs.writeFileSync(join(home, '.claude', 'settings.json'), '{ broken')
    expect(installClaudeHooks(script, home, { node: NODE }).error).toMatch(/could not be read/)
    expect(fs.readFileSync(join(home, '.claude', 'settings.json'), 'utf8')).toBe('{ broken')
  })

  it('adds the Codex server once, forwarding the pane variables', async () => {
    const { installCodexServer } = await import('../teamInstall')
    expect(await installCodexServer(script, null, home, { node: NODE })).toEqual({ changed: false }) // no Codex here
    fs.mkdirSync(join(home, '.codex'))
    fs.writeFileSync(join(home, '.codex', 'config.toml'), 'model = "x"\n')
    expect(await installCodexServer(script, async () => ({ ok: true }), home, { node: NODE })).toEqual({ changed: true })
    const t = fs.readFileSync(join(home, '.codex', 'config.toml'), 'utf8')
    expect(t).toMatch(/^model = "x"/)
    expect(t).toContain(`args = ['${script}']`)
    // Node by its absolute path, never by name.
    expect(t).toContain(`command = '${NODE}'`)
    expect(t).toContain('env_vars = ["TESSEL_PANE_ID", "TESSEL_PROJECT_DIR", "TESSEL_TEAM_SECRET"]')
    expect(t).toContain('default_tools_approval_mode = "approve"')
    expect(await installCodexServer(script, async () => ({ ok: true }), home, { node: NODE })).toEqual({ changed: false })
    // A quoted key is ours too: replaced, not duplicated; refused = untouched.
    fs.writeFileSync(join(home, '.codex', 'config.toml'), 'model = "x"\n[mcp_servers."tessel-team"]\ncommand = "old"\n[mcp_servers."tessel-team".env]\nA = "1"\n[other]\nk = 1\n')
    expect(await installCodexServer(script, async () => ({ ok: false, error: 'bad' }), home, { node: NODE }).then((r) => r.error)).toMatch(/would not accept/)
    expect(fs.readFileSync(join(home, '.codex', 'config.toml'), 'utf8')).toContain('command = "old"')
    expect(await installCodexServer(script, async () => ({ ok: true }), home, { node: NODE })).toEqual({ changed: true })
    const t2 = fs.readFileSync(join(home, '.codex', 'config.toml'), 'utf8')
    expect(t2.match(/^\[mcp_servers\.[^\]\n]*tessel-team[^\]\n]*\]/gm)).toEqual(['[mcp_servers.tessel-team]'])
    expect(t2).toContain('[other]\nk = 1')
    expect(t2).not.toContain('command = "old"')
  })

  it('keeps an unrelated hook that shares a group with an old Tessel hook', async () => {
    const { installClaudeHooks } = await import('../teamInstall')
    fs.mkdirSync(join(home, '.claude'))
    const file = join(home, '.claude', 'settings.json')
    fs.writeFileSync(file, JSON.stringify({ hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'node "C:/old/tessel-team-mcp.cjs" --hook' }, { type: 'command', command: 'my-existing-hook.cmd' }] }] } }))
    installClaudeHooks(script, home, { node: NODE })
    const cmds = JSON.parse(fs.readFileSync(file, 'utf8')).hooks.Stop.flatMap((g) => g.hooks.map((h) => h.command))
    expect(cmds).toContain('my-existing-hook.cmd')
    expect(cmds.filter((c) => c.includes('tessel-team-mcp.cjs'))).toEqual([`${N} "${script}" --hook`])
  })
})

describe('two Tessel windows in one project', () => {
  let dir
  beforeEach(() => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-two-'))
  })
  afterEach(() => {
    delete process.env.TESSEL_PANE_ID
    delete process.env.TESSEL_PROJECT_DIR
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const base = () => join(dir, '.tessel', 'team-channel')
  const current = () => JSON.parse(fs.readFileSync(join(base(), 'current.json'), 'utf8'))
  const ownFile = (o) => join(base(), `current.${o}.json`)
  const age = (o, ms) => {
    const d = JSON.parse(fs.readFileSync(ownFile(o), 'utf8'))
    d.at -= ms
    fs.writeFileSync(ownFile(o), JSON.stringify(d))
  }
  const active = (teamId) => pollTeamChannel({ dir, teamId }).participants.some((p) => p.active)
  const found = (paneId) => {
    process.env.TESSEL_PANE_ID = paneId
    process.env.TESSEL_PROJECT_DIR = dir
    return mcp.locate()
  }

  it('each window writes its own file; the merged view has both', () => {
    writeCurrentTeams({ dir, owner: 'dev', panes: { 'pane-1-aaaaaa': { team: 'team-1', num: 1 } } })
    writeCurrentTeams({ dir, owner: 'app', panes: { 'pane-9-zzzzzz': { team: 'team-9', num: 2 } } })
    expect(Object.keys(current().panes).sort()).toEqual(['pane-1-aaaaaa', 'pane-9-zzzzzz'])
    writeCurrentTeams({ dir, owner: 'dev', panes: {} })
    expect(current().panes).toEqual({ 'pane-9-zzzzzz': { team: 'team-9', num: 2, owner: 'app' } })
  })

  it('a window not seen for 5 minutes is gone', () => {
    writeCurrentTeams({ dir, owner: 'app', panes: { 'pane-9-zzzzzz': { team: 'team-9', num: 2 } } })
    age('app', 6 * 60 * 1000)
    writeCurrentTeams({ dir, owner: 'dev', panes: { 'pane-1-aaaaaa': { team: 'team-1', num: 1 } } })
    expect(Object.keys(current().panes)).toEqual(['pane-1-aaaaaa'])
  })

  it('the team tools find an agent from its window’s own file', () => {
    ensureTeamChannel({ dir, teamId: 'team-9', members: [{ id: 'pane-9-zzzzzz', num: 2, title: 'B' }] })
    writeCurrentTeams({ dir, owner: 'app', panes: { 'pane-9-zzzzzz': { team: 'team-9', num: 2 } } })
    fs.rmSync(join(base(), 'current.json')) // even without the merged copy
    expect(found('pane-9-zzzzzz').teamId).toBe('team-9')
  })

  it('when every window is gone, the merged copy does not bring its agents back', () => {
    ensureTeamChannel({ dir, teamId: 'team-9', members: [{ id: 'pane-9-zzzzzz', num: 2, title: 'B' }] })
    writeCurrentTeams({ dir, owner: 'app', panes: { 'pane-9-zzzzzz': { team: 'team-9', num: 2 } } })
    expect(found('pane-9-zzzzzz').teamId).toBe('team-9')
    age('app', 6 * 60 * 1000)
    expect(found('pane-9-zzzzzz').error).toMatch(/no longer in a Tessel team/)
    // Damaged and left unchanged since its window closed (not one being
    // replaced right now): the team is over.
    fs.writeFileSync(ownFile('app'), '{damaged')
    const old = new Date(Date.now() - 6 * 60 * 1000)
    fs.utimesSync(ownFile('app'), old, old)
    expect(found('pane-9-zzzzzz').error).toMatch(/no longer in a Tessel team/)
  })

  it('an older Tessel (current.json only) still works', () => {
    ensureTeamChannel({ dir, teamId: 'team-9', members: [{ id: 'pane-9-zzzzzz', num: 2, title: 'B' }] })
    writeCurrentTeams({ dir, panes: { 'pane-9-zzzzzz': { team: 'team-9', num: 2 } } })
    expect(found('pane-9-zzzzzz').teamId).toBe('team-9')
  })

  it('retires only its own teams while the other window runs', () => {
    ensureTeamChannel({ dir, teamId: 'team-9', members: [{ id: 'pane-9-zzzzzz', num: 2, title: 'B' }] })
    ensureTeamChannel({ dir, teamId: 'team-1', members: [{ id: 'pane-1-aaaaaa', num: 1, title: 'A' }] })
    writeCurrentTeams({ dir, owner: 'app', panes: { 'pane-9-zzzzzz': { team: 'team-9', num: 2 } } })
    // The other window's team has no pane right now: still its team.
    writeCurrentTeams({ dir, owner: 'app', panes: {} })
    writeCurrentTeams({ dir, owner: 'dev', panes: { 'pane-1-aaaaaa': { team: 'team-1', num: 1 } } })
    writeCurrentTeams({ dir, owner: 'dev', panes: {} }) // dev's team-1 ended
    expect(retireOldTeams({ dir, liveTeamIds: [], owner: 'dev' }).retired).toEqual(['team-1'])
    expect(active('team-9')).toBe(true)
    expect(active('team-1')).toBe(false)
    expect(JSON.parse(fs.readFileSync(ownFile('dev'), 'utf8')).teams).toEqual([])
  })

  it('a team of unknown origin is retired only when no other window runs', () => {
    ensureTeamChannel({ dir, teamId: 'team-x', members: [{ id: 'pane-5-xxxxxx', num: 5, title: 'X' }] })
    writeCurrentTeams({ dir, owner: 'app', panes: {} })
    writeCurrentTeams({ dir, owner: 'dev', panes: {} })
    expect(retireOldTeams({ dir, liveTeamIds: [], owner: 'dev' }).retired).toEqual([])
    age('app', 6 * 60 * 1000) // the other window is gone
    expect(retireOldTeams({ dir, liveTeamIds: [], owner: 'dev' }).retired).toEqual(['team-x'])
  })

  it('reports its own team found retired, so it is set up again', () => {
    ensureTeamChannel({ dir, teamId: 'team-1', members: [{ id: 'pane-1-aaaaaa', num: 1, title: 'A' }] })
    ensureTeamChannel({ dir, teamId: 'team-1', members: [] })
    const res = writeCurrentTeams({ dir, owner: 'dev', panes: { 'pane-1-aaaaaa': { team: 'team-1', num: 1 } } })
    expect(res.lost).toEqual(['team-1'])
  })

  it('two processes writing at the same time lose no update', async () => {
    const url = (s) => 'data:text/javascript;base64,' + Buffer.from(s).toString('base64')
    const agentNames = url(fs.readFileSync(join(__dirname, '..', '..', 'shared', 'agentNames.js'), 'utf8'))
    const safeJson = url(fs.readFileSync(join(__dirname, '..', 'safeJson.js'), 'utf8'))
    const channel = url(
      fs.readFileSync(join(__dirname, '..', 'teamChannel.js'), 'utf8').replace("'./safeJson'", JSON.stringify(safeJson)).replace("'../shared/agentNames'", JSON.stringify(agentNames))
    )
    const fileRead = url(fs.readFileSync(join(__dirname, '..', 'fileRead.js'), 'utf8'))
    const notices = url(
      fs
        .readFileSync(join(__dirname, '..', 'teamNotices.js'), 'utf8')
        .replace("'./teamChannel'", JSON.stringify(channel))
        .replace("'./fileRead'", JSON.stringify(fileRead))
        .replace("'./safeJson'", JSON.stringify(safeJson))
    )
    const child = (owner) =>
      new Promise((resolve) => {
        const code = `const n = await import(${JSON.stringify(notices)})
for (let i = 0; i < 150; i++) n.writeCurrentTeams({ dir: ${JSON.stringify(dir)}, owner: '${owner}', panes: { ['pane-' + '${owner}' + '-' + i]: { team: 'team-${owner}', num: 1 } } })`
        const file = join(dir, 'writer-' + owner + '.mjs')
        fs.writeFileSync(file, code)
        const p = spawn(process.execPath, [file], { stdio: ['ignore', 'ignore', 'pipe'] })
        let err = ''
        p.stderr.on('data', (d) => (err += d))
        p.on('close', (c) => resolve({ c, err }))
      })
    const [a, b] = await Promise.all([child('a'), child('b')])
    expect(a).toEqual({ c: 0, err: '' })
    expect(b).toEqual({ c: 0, err: '' })
    // Each window's own file is exact; the team tools read those.
    expect(Object.keys(JSON.parse(fs.readFileSync(ownFile('a'), 'utf8')).panes)).toEqual(['pane-a-149'])
    expect(Object.keys(JSON.parse(fs.readFileSync(ownFile('b'), 'utf8')).panes)).toEqual(['pane-b-149'])
    ensureTeamChannel({ dir, teamId: 'team-a', members: [{ id: 'pane-a-149', num: 1, title: 'A' }] })
    ensureTeamChannel({ dir, teamId: 'team-b', members: [{ id: 'pane-b-149', num: 1, title: 'B' }] })
    expect(found('pane-a-149').teamId).toBe('team-a')
    expect(found('pane-b-149').teamId).toBe('team-b')
  }, 60000)
})

describe('the team board through the team tools', () => {
  let dir
  const teamId = 'team-1'
  const A = { id: 'pane-1-aaaaaa', num: 1, title: 'Codex CLI' }
  const B = { id: 'pane-4-bbbbbb', num: 4, title: 'Claude Code' }
  beforeEach(() => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-board-'))
    ensureTeamChannel({ dir, teamId, members: [A, B] })
    writeCurrentTeams({ dir, panes: { [A.id]: { team: teamId, num: 1 }, [B.id]: { team: teamId, num: 4 } } })
    process.env.TESSEL_PANE_ID = B.id
    process.env.TESSEL_PROJECT_DIR = dir
  })
  afterEach(() => {
    delete process.env.TESSEL_PANE_ID
    delete process.env.TESSEL_PROJECT_DIR
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const call = (name, args = {}) => mcp.handle({ id: 1, method: 'tools/call', params: { name, arguments: args } })

  it('asks Tessel to add and move cards; a request stays until the board is saved', () => {
    expect(call('team_task_add', { title: 'Review  terminal scroll', assignee: '#1', column: 'doing' }).isError).toBe(false)
    expect(call('team_task_add', { title: 'Team view' }).isError).toBe(false) // for me
    expect(call('team_task_move', { id: 'task-1-2', column: 'review' }).isError).toBe(false)
    const res = takeTeamRequests({ dir, teamId })
    expect(res.refused).toEqual([])
    expect(res.requests.map(({ file, ...r }) => r)).toEqual([
      { fromId: B.id, action: 'add', title: 'Review terminal scroll', assignee: '#1', column: 'doing' },
      { fromId: B.id, action: 'add', title: 'Team view', assignee: '#4', column: 'todo' },
      { fromId: B.id, action: 'move', id: 'task-1-2', column: 'review' }
    ])
    // Not saved yet (say Tessel stopped): the same requests come back.
    expect(takeTeamRequests({ dir, teamId }).requests).toEqual(res.requests)
    const done = finishTeamRequests({ dir, teamId, files: res.requests.map((r) => r.file) })
    expect(done.removed.sort()).toEqual(res.requests.map((r) => r.file).sort())
    expect(takeTeamRequests({ dir, teamId }).requests).toEqual([])
  })

  it('refuses a bad request at once', () => {
    expect(call('team_task_add', { title: '' }).isError).toBe(true)
    expect(call('team_task_add', { title: 'x', assignee: 'Codex' }).isError).toBe(true)
    expect(call('team_task_move', { id: 'task-1', column: 'later' }).isError).toBe(true)
    expect(takeTeamRequests({ dir, teamId }).requests).toEqual([])
  })

  it('a hand-written bad request file is refused, not applied', () => {
    const folder = join(dir, '.tessel', 'team-channel', teamId, 'requests')
    fs.mkdirSync(folder, { recursive: true })
    fs.writeFileSync(join(folder, `${A.id}__x1.json`), JSON.stringify({ action: 'move', id: 'task-1', column: 'nowhere' }))
    const res = takeTeamRequests({ dir, teamId })
    expect(res.requests).toEqual([])
    expect(res.refused[0].fromId).toBe(A.id)
  })

  it('tells the status of messages, read ones no longer kept included', () => {
    const sent = mcp.send(mcp.locate(), '#1', 'hello')
    expect(sent.ok).toBe(true)
    pollTeamChannel({ dir, teamId })
    const id = pollTeamChannel({ dir, teamId }).history.find((m) => m.text === 'hello').id
    expect(messageStatuses({ dir, teamId, ids: [id, 'old-1'] }).statuses).toEqual({ [id]: 'pending', 'old-1': 'gone' })
  })

  it('lists the cards Tessel published', () => {
    expect(call('team_tasks').content[0].text).toMatch(/No cards/)
    publishTeamTasks({
      dir,
      teamId,
      tasks: [
        { id: 'task-1-2', title: 'Review terminal scroll', column: 'doing', assignee: '#1', since: 1 },
        { id: 'task-2-3', title: 'Team view', column: 'todo', assignee: '#4' }
      ]
    })
    const text = call('team_tasks').content[0].text
    expect(text).toContain('To do:\n  task-2-3  Team view  (#4)')
    expect(text).toContain('Doing:\n  task-1-2  Review terminal scroll  (#1)')
    expect(publishTeamTasks({ dir, teamId, tasks: [{ id: 'task-2-3', title: 'Team view', column: 'todo', assignee: '#4' }, { id: 'task-1-2', title: 'Review terminal scroll', column: 'doing', assignee: '#1', since: 1 }] }).changed).toBe(true)
  })
})

describe('an agent whose team was ungrouped', () => {
  let dir
  beforeEach(() => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-solo-'))
  })
  afterEach(() => {
    delete process.env.TESSEL_PANE_ID
    delete process.env.TESSEL_PROJECT_DIR
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('is told plainly it now works alone', () => {
    const A = { id: 'pane-1-aaaaaa', num: 1, title: 'Codex CLI' }
    ensureTeamChannel({ dir, teamId: 'team-1', members: [A] })
    writeCurrentTeams({ dir, owner: 'dev', panes: { [A.id]: { team: 'team-1', num: 1 } } })
    process.env.TESSEL_PANE_ID = A.id
    process.env.TESSEL_PROJECT_DIR = dir
    expect(mcp.locate().teamId).toBe('team-1')
    // The user ungroups the team.
    writeCurrentTeams({ dir, owner: 'dev', panes: {} })
    retireOldTeams({ dir, liveTeamIds: [], owner: 'dev' })
    expect(mcp.locate().error).toMatch(/no longer in a Tessel team.*work alone/)
    // Never in a team at all: the usual answer.
    process.env.TESSEL_PANE_ID = 'pane-9-zzzzzz'
    expect(mcp.locate().error).toMatch(/not in a Tessel team right now/)
  })

  it('a team list that cannot be read right now is never taken for "no team"', () => {
    const A = { id: 'pane-1-aaaaaa', num: 1, title: 'Codex CLI' }
    ensureTeamChannel({ dir, teamId: 'team-1', members: [A] })
    writeCurrentTeams({ dir, owner: 'dev', panes: { [A.id]: { team: 'team-1', num: 1 } } })
    process.env.TESSEL_PANE_ID = A.id
    process.env.TESSEL_PROJECT_DIR = dir
    const file = join(dir, '.tessel', 'team-channel', 'current.dev.json')
    const good = fs.readFileSync(file, 'utf8')
    fs.writeFileSync(file, good.slice(0, 10)) // cut mid-write, or held by another program
    expect(mcp.locate().error).toMatch(/updating its team list: try again/)
    fs.writeFileSync(file, good)
    expect(mcp.locate().teamId).toBe('team-1')
  })
})

describe('robustness of the team files', () => {
  let dir
  beforeEach(() => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-robust-'))
    ensureTeamChannel({ dir, teamId: 'team-1', members: [{ id: 'pane-1-aaaaaa', num: 1, title: 'A' }] })
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const requests = () => join(dir, '.tessel', 'team-channel', 'team-1', 'requests')

  it('a board request with a BOM is read; a damaged one is refused and removed after 5 s', () => {
    fs.mkdirSync(requests(), { recursive: true })
    fs.writeFileSync(join(requests(), 'pane-1-aaaaaa__bom.json'), '﻿' + JSON.stringify({ action: 'add', title: 'With BOM' }))
    const bad = join(requests(), 'pane-1-aaaaaa__bad.json')
    fs.writeFileSync(bad, '{cut')
    let res = takeTeamRequests({ dir, teamId: 'team-1' })
    expect(res.requests.map((r) => r.title)).toEqual(['With BOM'])
    expect(fs.existsSync(bad)).toBe(true) // maybe still being written
    const old = new Date(Date.now() - 10000)
    fs.utimesSync(bad, old, old)
    res = takeTeamRequests({ dir, teamId: 'team-1' })
    expect(res.refused).toEqual([{ fromId: 'pane-1-aaaaaa', error: 'the request file could not be read' }])
    expect(fs.existsSync(bad)).toBe(false)
  })

  it('another window silent for an hour keeps its teams (not retired)', () => {
    writeCurrentTeams({ dir, owner: 'app', panes: { 'pane-1-aaaaaa': { team: 'team-1', num: 1 } } })
    const f = join(dir, '.tessel', 'team-channel', 'current.app.json')
    const d = JSON.parse(fs.readFileSync(f, 'utf8'))
    d.at -= 60 * 60 * 1000
    fs.writeFileSync(f, JSON.stringify(d))
    writeCurrentTeams({ dir, owner: 'dev', panes: {} })
    expect(retireOldTeams({ dir, liveTeamIds: [], owner: 'dev' }).retired).toEqual([])
    d.at -= 7 * 60 * 60 * 1000 // gone for good
    fs.writeFileSync(f, JSON.stringify(d))
    expect(retireOldTeams({ dir, liveTeamIds: [], owner: 'dev' }).retired).toEqual(['team-1'])
  })
})

describe('the workspace board for an agent working alone', () => {
  let dir
  beforeEach(() => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-soloboard-'))
    process.env.TESSEL_PANE_ID = 'pane-2-bbbbbb'
    process.env.TESSEL_PROJECT_DIR = dir
  })
  afterEach(() => {
    delete process.env.TESSEL_PANE_ID
    delete process.env.TESSEL_PROJECT_DIR
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const call = (name, args = {}) => mcp.handle({ id: 1, method: 'tools/call', params: { name, arguments: args } })

  it('adds, lists and moves cards on its workspace board, with no team', () => {
    // Not known to Tessel as working alone yet: the usual answer.
    expect(call('team_tasks').isError).toBe(true)
    writeBoardPanes({ dir, owner: 'dev', panes: { 'pane-2-bbbbbb': { ws: 'ws-a', num: 2 } } })
    expect(call('team_task_add', { title: 'Fix batch 3', column: 'doing' }).isError).toBe(false)
    const res = takeTeamRequests({ dir, board: 'ws-a' })
    expect(res.requests.map(({ file, ...r }) => r)).toEqual([
      { fromId: 'pane-2-bbbbbb', action: 'add', title: 'Fix batch 3', assignee: '#2', column: 'doing' }
    ])
    publishTeamTasks({ dir, board: 'ws-a', tasks: [{ id: 'task-9-1', title: 'Fix batch 3', column: 'doing', assignee: '#2' }] })
    expect(call('team_tasks').content[0].text).toContain('task-9-1  Fix batch 3  (#2)')
    // Messages stay a team thing.
    expect(call('team_inbox').isError).toBe(true)
  })

  it('ignores the list of a window that is gone', () => {
    writeBoardPanes({ dir, owner: 'dev', panes: { 'pane-2-bbbbbb': { ws: 'ws-a', num: 2 } } })
    const f = join(dir, '.tessel', 'board', 'panes.dev.json')
    const d = JSON.parse(fs.readFileSync(f, 'utf8'))
    d.at -= 10 * 60 * 1000
    fs.writeFileSync(f, JSON.stringify(d))
    expect(call('team_tasks').isError).toBe(true)
  })
})

describe('the team channel does not grow forever', () => {
  let dir
  beforeEach(() => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-growth-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const root = (t) => join(dir, '.tessel', 'team-channel', t)

  it('drops messages nobody can receive after 7 days, keeps the rest', () => {
    const A = { id: 'pane-1-aaaaaa', num: 1, title: 'A' }
    const B = { id: 'pane-2-bbbbbb', num: 2, title: 'B' }
    ensureTeamChannel({ dir, teamId: 'team-1', members: [A, B] })
    const file = join(root('team-1'), 'state.json')
    const st = JSON.parse(fs.readFileSync(file, 'utf8'))
    const old = Date.now() - 8 * 24 * 3600 * 1000
    st.messages.push(
      { id: 'm1', fromId: A.id, toId: B.id, text: 'old, B still here', status: 'pending', createdAt: old },
      { id: 'm2', fromId: A.id, toId: 'pane-9-gone00', text: 'old, to someone gone', status: 'pending', createdAt: old },
      { id: 'm3', fromId: A.id, toId: 'pane-9-gone00', text: 'recent, to someone gone', status: 'pending', createdAt: Date.now() }
    )
    fs.writeFileSync(file, JSON.stringify(st))
    ensureTeamChannel({ dir, teamId: 'team-1', members: [A, B] }) // any save
    const ids = JSON.parse(fs.readFileSync(file, 'utf8')).messages.map((m) => m.id)
    expect(ids).toContain('m1')
    expect(ids).not.toContain('m2')
    expect(ids).toContain('m3')
  })

  it('deletes a retired team folder untouched for 7 days, not a recent one', () => {
    const A = { id: 'pane-1-aaaaaa', num: 1, title: 'A' }
    ensureTeamChannel({ dir, teamId: 'team-old', members: [A] })
    ensureTeamChannel({ dir, teamId: 'team-new', members: [A] })
    writeCurrentTeams({ dir, owner: 'dev', panes: {} })
    retireOldTeams({ dir, liveTeamIds: [], owner: 'dev' }) // both retired now
    const long = new Date(Date.now() - 8 * 24 * 3600 * 1000)
    fs.utimesSync(join(root('team-old'), 'state.json'), long, long)
    retireOldTeams({ dir, liveTeamIds: [], owner: 'dev' })
    expect(fs.existsSync(root('team-old'))).toBe(false)
    expect(fs.existsSync(root('team-new'))).toBe(true)
  })
})

describe('a message read once is never shown again', () => {
  it('keeps the read note a minute after Tessel took it in', () => {
    const dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-ack-'))
    try {
      const A = { id: 'pane-1-aaaaaa', num: 1, title: 'A' }
      const B = { id: 'pane-2-bbbbbb', num: 2, title: 'B' }
      ensureTeamChannel({ dir, teamId: 'team-1', members: [A, B] })
      writeCurrentTeams({ dir, panes: { [A.id]: { team: 'team-1', num: 1 }, [B.id]: { team: 'team-1', num: 2 } } })
      process.env.TESSEL_PROJECT_DIR = dir
      process.env.TESSEL_PANE_ID = A.id
      mcp.send(mcp.locate(), '#2', 'hello once')
      pollTeamChannel({ dir, teamId: 'team-1' })
      process.env.TESSEL_PANE_ID = B.id
      // The agent read it; its state copy is from before Tessel takes the note in.
      const before = mcp.locate()
      expect(mcp.readInbox(before)).toContain('hello once')
      takeTeamAcks({ dir, teamId: 'team-1' })
      const acks = join(dir, '.tessel', 'team-channel', 'team-1', 'acks')
      expect(fs.readdirSync(acks).length).toBe(1) // kept for now
      expect(mcp.readInbox(before)).toBe('') // stale state + note still there: not shown again
      expect(mcp.readInbox(mcp.locate())).toBe('')
    } finally {
      delete process.env.TESSEL_PANE_ID
      delete process.env.TESSEL_PROJECT_DIR
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('a damaged team channel state', () => {
  it('is restored from its previous copy instead of stopping the channel', () => {
    const dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-chsafe-'))
    try {
      const A = { id: 'pane-1-aaaaaa', num: 1, title: 'A' }
      const B = { id: 'pane-2-bbbbbb', num: 2, title: 'B' }
      ensureTeamChannel({ dir, teamId: 'team-1', members: [A] })
      ensureTeamChannel({ dir, teamId: 'team-1', members: [A, B] }) // a second save: the first is the copy
      const file = join(dir, '.tessel', 'team-channel', 'team-1', 'state.json')
      fs.writeFileSync(file, '{"version":1,"members":{') // cut by a crash
      const res = pollTeamChannel({ dir, teamId: 'team-1' })
      expect(res.ok).toBe(true)
      expect(JSON.parse(fs.readFileSync(file, 'utf8')).version).toBe(1) // put back
      const names = fs.readdirSync(join(dir, '.tessel', 'team-channel', 'team-1'))
      expect(names.some((n) => n.startsWith('state.json.corrupt-'))).toBe(true)
      expect(names.some((n) => n.endsWith('.tmp'))).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('the team tools say they are running', () => {
  it('writes its proof of life for its pane while it runs, and removes it when it ends', async () => {
    const dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-alive-'))
    try {
      const env = { ...process.env, TESSEL_PANE_ID: 'pane-7-alive1', TESSEL_PROJECT_DIR: dir }
      const p = spawn(process.execPath, [SERVER], { env, stdio: ['pipe', 'pipe', 'pipe'] })
      const file = join(dir, '.tessel', 'agents', 'pane-7-alive1.json')
      for (let i = 0; i < 50 && !fs.existsSync(file); i++) await new Promise((r) => setTimeout(r, 100))
      expect(toolsAlive({ dir, ids: ['pane-7-alive1', 'pane-8-other0'] }).alive).toEqual({
        'pane-7-alive1': { at: expect.any(Number), version: expect.any(String) },
        'pane-8-other0': null
      })
      const ended = new Promise((r) => p.on('exit', r))
      p.stdin.end() // the agent closed it
      await ended
      expect(fs.existsSync(file)).toBe(false)
      expect(toolsAlive({ dir, ids: ['pane-7-alive1'] }).alive['pane-7-alive1']).toBe(null)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 20000)
})
