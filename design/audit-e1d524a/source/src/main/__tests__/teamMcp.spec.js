import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { spawn } from 'child_process'
import { createRequire } from 'module'
import { ensureTeamChannel, pollTeamChannel } from '../teamChannel'
import { takeTeamAcks } from '../teamAcks'
import { writeCurrentTeams, retireOldTeams, addNotices } from '../teamNotices'

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
    expect(mcp.locate(null, dir).error).toMatch(/pass your pane number/)
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
    expect(as(A).error).toMatch(/not in a Tessel team/)
  })

  it('a message is marked read only if it is shown (a failed read note leaves it unread)', () => {
    mcp.send(as(A), '#4', 'one')
    mcp.send(as(A), '#4', 'two')
    pollTeamChannel({ dir, teamId })
    const ctx = as(B)
    const realRename = fs.renameSync
    let calls = 0
    fs.renameSync = (...a) => {
      if (String(a[1]).includes('acks') && ++calls === 2) throw new Error('disk full')
      return realRename(...a)
    }
    let first
    try {
      first = mcp.readInbox(ctx)
    } finally {
      fs.renameSync = realRename
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
    expect(inbox).toMatch(/\[#1 Codex CLI → you, message .+\] Hello from A/)
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
    expect(mcp.send(as(A), 'lead', 'x').error).toMatch(/must be a teammate/)
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
    expect(byId[2].result.tools.map((t) => t.name)).toEqual(['team_inbox', 'team_send', 'team_members'])
    expect(byId[3].result.content[0].text).toMatch(/Sent to #4/)
    expect(byId[4].result.content[0].text).toMatch(/#1 Codex CLI \(you\)/)
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
})

describe('setting up the team tools', () => {
  let home
  const script = 'C:\\Users\\x\\AppData\\Roaming\\tessel\\tessel-team-mcp.cjs'
  beforeEach(() => {
    home = fs.mkdtempSync(join(os.tmpdir(), 'tessel-home-'))
  })
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }))

  it('adds the Claude hooks once, keeping other hooks and settings', async () => {
    const { installClaudeHooks } = await import('../teamInstall')
    fs.mkdirSync(join(home, '.claude'))
    const file = join(home, '.claude', 'settings.json')
    fs.writeFileSync(file, JSON.stringify({ model: 'x', hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'mine.sh' }] }] } }))
    expect(installClaudeHooks(script, home)).toEqual({ changed: true })
    const s = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(s.model).toBe('x')
    expect(s.hooks.Stop.map((g) => g.hooks[0].command)).toEqual(['mine.sh', `node "${script}" --hook`])
    expect(s.hooks.UserPromptSubmit[0].hooks[0].command).toMatch(/--hook$/)
    expect(fs.existsSync(file + '.before-tessel')).toBe(true)
    expect(installClaudeHooks(script, home)).toEqual({ changed: false }) // already there
  })

  it('never overwrites a settings file it cannot read', async () => {
    const { installClaudeHooks } = await import('../teamInstall')
    fs.mkdirSync(join(home, '.claude'))
    fs.writeFileSync(join(home, '.claude', 'settings.json'), '{ broken')
    expect(installClaudeHooks(script, home).error).toMatch(/could not be read/)
    expect(fs.readFileSync(join(home, '.claude', 'settings.json'), 'utf8')).toBe('{ broken')
  })

  it('adds the Codex server once, forwarding the pane variables', async () => {
    const { installCodexServer } = await import('../teamInstall')
    expect(await installCodexServer(script, null, home)).toEqual({ changed: false }) // no Codex here
    fs.mkdirSync(join(home, '.codex'))
    fs.writeFileSync(join(home, '.codex', 'config.toml'), 'model = "x"\n')
    expect(await installCodexServer(script, async () => ({ ok: true }), home)).toEqual({ changed: true })
    const t = fs.readFileSync(join(home, '.codex', 'config.toml'), 'utf8')
    expect(t).toMatch(/^model = "x"/)
    expect(t).toContain(`args = ['${script}']`)
    expect(t).toContain('env_vars = ["TESSEL_PANE_ID", "TESSEL_PROJECT_DIR"]')
    expect(t).toContain('default_tools_approval_mode = "approve"')
    expect(await installCodexServer(script, async () => ({ ok: true }), home)).toEqual({ changed: false })
    // A quoted key is ours too: replaced, not duplicated; refused = untouched.
    fs.writeFileSync(join(home, '.codex', 'config.toml'), 'model = "x"\n[mcp_servers."tessel-team"]\ncommand = "old"\n[mcp_servers."tessel-team".env]\nA = "1"\n[other]\nk = 1\n')
    expect(await installCodexServer(script, async () => ({ ok: false, error: 'bad' }), home).then((r) => r.error)).toMatch(/would not accept/)
    expect(fs.readFileSync(join(home, '.codex', 'config.toml'), 'utf8')).toContain('command = "old"')
    expect(await installCodexServer(script, async () => ({ ok: true }), home)).toEqual({ changed: true })
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
    installClaudeHooks(script, home)
    const cmds = JSON.parse(fs.readFileSync(file, 'utf8')).hooks.Stop.flatMap((g) => g.hooks.map((h) => h.command))
    expect(cmds).toContain('my-existing-hook.cmd')
    expect(cmds.filter((c) => c.includes('tessel-team-mcp.cjs'))).toEqual([`node "${script}" --hook`])
  })
})
