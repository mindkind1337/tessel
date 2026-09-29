// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { spawn } from 'child_process'
import { createRequire } from 'module'
import { ensureTeamChannel, pollTeamChannel } from '../teamChannel'
import { writeCurrentTeams, addNotices } from '../teamNotices'
import { takeTeamAcks } from '../teamAcks'

const require = createRequire(import.meta.url)
const server = join(__dirname, '..', 'teamMcp', 'server.cjs')
const mcp = require(server)
// Run inside a Tessel pane, the hooks would inherit its agent: a hook reports
// its conversation only for the pane's own agent.
delete process.env.TESSEL_AGENT_PROVIDER

describe('Codex Stop hook delivers team messages without terminal input', () => {
  let dir, root, outbox, payload
  const teamId = 'team-stop'
  const sender = { id: 'pane-a', num: 1, title: 'Claude' }
  const receiver = { id: 'pane-b', num: 2, title: 'Codex' }
  const context = () => ({
    root,
    meId: receiver.id,
    state: JSON.parse(fs.readFileSync(join(root, 'state.json'), 'utf8'))
  })
  const acks = () =>
    fs.existsSync(join(root, 'acks'))
      ? fs.readdirSync(join(root, 'acks')).filter((n) => n.endsWith('.json'))
      : []
  beforeEach(() => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-codex-stop-'))
    root = join(dir, '.tessel', 'team-channel', teamId)
    const ready = ensureTeamChannel({ dir, teamId, members: [sender, receiver] })
    outbox = ready.outboxes[0].outbox
    writeCurrentTeams({
      dir,
      panes: { [sender.id]: { team: teamId, num: 1 }, [receiver.id]: { team: teamId, num: 2 } }
    })
    // Codex's documented Stop wire payload, including its turn/session fields.
    payload = {
      hook_event_name: 'Stop',
      cwd: dir,
      session_id: '019a0000-cccc-7ddd-8eee-000000000003',
      transcript_path: join(dir, 'rollout.jsonl'),
      turn_id: '019a0000-cccc-7ddd-8eee-000000000004',
      permission_mode: 'default',
      stop_hook_active: false,
      last_assistant_message: 'The requested work is finished.'
    }
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  function send(text, name = 'message') {
    fs.writeFileSync(
      join(outbox, `${name}.json`),
      JSON.stringify({ to: '#2', text, reply_to: 'original-request' })
    )
    pollTeamChannel({ dir, teamId })
  }
  function run(args, input = '') {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, args, {
        cwd: dir,
        windowsHide: true,
        env: {
          ...process.env,
          TESSEL_PANE_ID: receiver.id,
          TESSEL_PROJECT_DIR: dir,
          TESSEL_SESSIONS_DIR: join(dir, 'sessions'),
          CODEX_HOME: join(dir, 'codex-home')
        }
      })
      let output = '',
        error = ''
      child.stdout.on('data', (b) => {
        output += b
      })
      child.stderr.on('data', (b) => {
        error += b
      })
      child.on('error', reject)
      child.on('close', (code) =>
        code === 0 ? resolve(output) : reject(new Error(`hook exit ${code}: ${error}`))
      )
      child.stdin.end(input)
    })
  }
  const hook = (overrides) =>
    run([server, '--hook', '--codex'], JSON.stringify({ ...payload, ...overrides }))

  it('continues with the sender, message id and entire message, then team_inbox cannot read it twice', async () => {
    send('Please review the completed changes.\nKeep the second line.')
    const message = mcp.unread(context())[0]
    const output = JSON.parse(await hook())
    expect(output.decision).toBe('block')
    expect(output.reason).toContain('[Tessel] New team messages:')
    expect(output.reason).toContain('#1 Claude')
    expect(output.reason).toContain(message.id)
    expect(output.reason).toContain('original-request')
    expect(output.reason).toContain(message.text)
    expect(output.reason).toContain('team_send')
    expect(mcp.readInbox(context())).toBe('')
    expect(takeTeamAcks({ dir, teamId }).count).toBe(1)
    expect(context().state.messages.find((m) => m.id === message.id).status).toBe('delivered')
    expect(await hook()).toBe('')
  })

  it('never starts a second hook continuation and leaves new messages unread', async () => {
    send('Do not consume this in a continuing stop hook.')
    expect(await hook({ stop_hook_active: true })).toBe('')
    expect(acks()).toEqual([])
    expect(mcp.readInbox(context())).toContain('Do not consume this')
  })

  it('stays silent with no messages and ignores messages for another pane', async () => {
    expect(await hook()).toBe('')
    const state = context().state
    state.messages.push({
      id: 'not-mine',
      toId: sender.id,
      fromId: receiver.id,
      text: 'For Claude',
      status: 'pending'
    })
    fs.writeFileSync(join(root, 'state.json'), JSON.stringify(state))
    expect(await hook()).toBe('')
    expect(acks()).toEqual([])
  })

  it('reports the session on other Codex events without consuming inbox messages', async () => {
    send('Leave this for Stop or team_inbox.')
    for (const hook_event_name of ['SessionStart', 'UserPromptSubmit', 'PostToolUse']) {
      expect(await hook({ hook_event_name })).toBe('')
    }
    expect(acks()).toEqual([])
    expect(
      JSON.parse(fs.readFileSync(join(dir, 'sessions', `${receiver.id}.json`), 'utf8'))
    ).toMatchObject({ agent: 'codex', sessionId: payload.session_id })
  })

  it('does not consume the parent inbox from a subagent stop', async () => {
    send('For the main agent only.')
    expect(await hook({ agent_id: 'child-agent' })).toBe('')
    expect(acks()).toEqual([])
    expect(fs.existsSync(join(dir, 'sessions'))).toBe(false)
  })

  it('does not prompt a continuation for delivery receipts alone', async () => {
    const state = context().state
    state.messages.push({
      id: 'receipt',
      fromId: 'tessel',
      toId: receiver.id,
      text: 'Delivered to #1 Claude.',
      status: 'pending'
    })
    fs.writeFileSync(join(root, 'state.json'), JSON.stringify(state))
    expect(await hook()).toBe('')
    expect(mcp.unread(context())).toEqual([])
  })

  it('bounds the prompt by whole messages, leaving the rest unclaimed for team_inbox', async () => {
    const texts = Array.from(
      { length: 4 },
      (_, i) => `message-${i}:` + String(i).repeat(5700) + `:end-${i}`
    )
    texts.forEach((text, i) => send(text, `message-${i}`))
    const output = JSON.parse(await hook())
    expect(output.reason.length).toBeLessThanOrEqual(16000)
    const rest = mcp.unread(context())
    expect(rest.length).toBeGreaterThan(0)
    expect(rest.length).toBeLessThan(4)
    for (const text of texts) {
      const left = rest.some((m) => m.text === text)
      expect(output.reason.includes(text)).toBe(!left)
    }
    expect(output.reason).toContain('team_inbox')
    expect(acks()).toHaveLength(4 - rest.length)
  })

  it('delivers Tessel notices once through the same inbox claim', async () => {
    addNotices({ dir, teamId, notices: [{ toId: receiver.id, text: 'The team has a new lead.' }] })
    const output = JSON.parse(await hook())
    expect(output.reason).toContain('Tessel → you, message n-')
    expect(output.reason).toContain('The team has a new lead.')
    expect(mcp.readInbox(context())).toBe('')
    expect(takeTeamAcks({ dir, teamId }).count).toBe(1)
    expect(JSON.parse(fs.readFileSync(join(root, 'notices.json'), 'utf8')).notices).toEqual([])
  })

  it('leaves an oversized legacy message unread and asks for the full inbox', async () => {
    const text = 'Legacy message ' + 'x'.repeat(17000)
    const state = context().state
    state.messages.push({
      id: 'legacy-large',
      fromId: sender.id,
      toId: receiver.id,
      text,
      status: 'pending'
    })
    fs.writeFileSync(join(root, 'state.json'), JSON.stringify(state))
    const output = JSON.parse(await hook())
    expect(output.decision).toBe('block')
    expect(output.reason.length).toBeLessThan(16000)
    expect(output.reason).toContain('team_inbox')
    expect(acks()).toEqual([])
    expect(mcp.readInbox(context())).toContain(text)
  })

  it('stays silent and leaves messages unread when an ack cannot be published', async () => {
    send('No receipt without successful publication.')
    fs.writeFileSync(join(root, 'acks'), 'not a directory')
    expect(await hook()).toBe('')
    expect(mcp.unread(context())).toHaveLength(1)
  })

  // Three real Node processes can take longer to start under suite/CI load.
  it('delivers once when two Stop hooks and a team_inbox reader race', async () => {
    const text = 'Only one reader gets this exact message.'
    send(text)
    const tool = join(dir, 'tool.cjs')
    fs.writeFileSync(
      tool,
      `const mcp = require(${JSON.stringify(server)}); process.stdout.write(mcp.readInbox(mcp.locate()));`
    )
    const outputs = await Promise.all([hook(), hook(), run([tool])])
    expect(outputs.filter((output) => output.includes(text))).toHaveLength(1)
    expect(acks()).toHaveLength(1)
    expect(mcp.readInbox(context())).toBe('')
  }, 20_000)
})
