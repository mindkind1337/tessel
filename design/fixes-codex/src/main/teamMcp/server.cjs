#!/usr/bin/env node
// Tessel team tools for agent CLIs (Claude Code, Codex), over MCP (stdio).
// Agents read and send team messages themselves, in the background: nothing
// is ever typed into a terminal.
//
//   team_inbox()             new messages for me (then marked read)
//   team_send({to, text})    to "#3" or "team"
//   team_members()           who is in my team
//
// Tessel stays the only writer of the channel's state.json: this server only
// reads it, sends by dropping a file into my outbox (Tessel takes it in), and
// marks messages read by dropping an ack file Tessel turns into a receipt.
//
// Who am I: env TESSEL_PANE_ID (set by Tessel on the panes it starts), or the
// `me` argument ("#4") for agents started before. Where: env
// TESSEL_PROJECT_DIR, or the current folder (and, for a task copy
// <repo>.worktrees/<name>, the repo next to it).
//
// Also used as a Claude Code hook: `node server.cjs --hook` prints unread
// messages as extra context (see hookMain).
'use strict'
const fs = require('fs')
const path = require('path')

const VERSION = '1.1.0'
const MAX_TEXT = 6000

// --- Finding my team and me ---------------------------------------------------

function candidateDirs(start) {
  const out = []
  const add = (d) => d && !out.includes(d) && out.push(d)
  add(process.env.TESSEL_PROJECT_DIR)
  let d = path.resolve(start || process.cwd())
  for (let i = 0; i < 8; i++) {
    add(d)
    // A task copy: <repo>.worktrees/<name> -> <repo>
    const parent = path.dirname(d)
    if (parent.endsWith('.worktrees')) add(parent.slice(0, -'.worktrees'.length))
    if (parent === d) break
    d = parent
  }
  return out.filter(Boolean)
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

// Tessel writes <project>/.tessel/team-channel/current.json:
// { panes: { <paneId>: { team, num } } } for the teams that exist now. Only
// those count: a folder of a team that was ungrouped is never used.
//
// When Tessel started this agent, TESSEL_PANE_ID says who it is, and nothing
// else can change that. Only without it, "me" ("#4") is used, and only when
// it matches exactly one agent.
// -> { root, state, meId, me, teamId } or { error }
function locate(meArg, start) {
  const paneId = process.env.TESSEL_PANE_ID || ''
  const num = /^#?(\d{1,3})$/.exec(String(meArg || '').trim())
  if (!paneId && !num)
    return { error: 'Tessel does not know who you are: pass your pane number as "me", e.g. {"me":"#4"}.' }
  const hits = []
  for (const dir of candidateDirs(start)) {
    const base = path.join(dir, '.tessel', 'team-channel')
    const current = readJson(path.join(base, 'current.json'))
    if (!current || !current.panes) continue
    for (const [id, p] of Object.entries(current.panes)) {
      if (!p || typeof p.team !== 'string') continue
      const mine = paneId ? id === paneId : p.num === Number(num[1])
      if (mine && !hits.some((h) => h.id === id)) hits.push({ id, team: p.team, base })
    }
    if (hits.length) break
  }
  if (!hits.length) return { error: 'You are not in a Tessel team right now (see Sessions in Tessel).' }
  if (hits.length > 1) return { error: `"${meArg}" matches several agents: Tessel cannot tell which one you are.` }
  const { id, team, base } = hits[0]
  const root = path.join(base, team)
  const state = readJson(path.join(root, 'state.json'))
  if (!state || !state.members || !state.members[id] || !state.members[id].active)
    return { error: 'Your team is being set up in Tessel: try again in a few seconds.' }
  return { root, state, meId: id, me: state.members[id], teamId: team }
}

// --- Inbox ---------------------------------------------------------------------

function ackPath(root, toId, id) {
  const safe = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, '_')
  return path.join(root, 'acks', `${safe(toId)}__${safe(id)}.json`)
}

// Messages for me not yet read: teammates' (state.json) and Tessel's own
// notices (notices.json: team changes, answers to a lead). Delivery receipts
// are marked read without being shown (they only say another message
// arrived).
function unread(ctx) {
  const list = []
  for (const m of ctx.state.messages || []) {
    if (m.toId !== ctx.meId || m.status === 'delivered') continue
    if (fs.existsSync(ackPath(ctx.root, m.toId, m.id))) continue
    list.push(m)
  }
  const notices = readJson(path.join(ctx.root, 'notices.json'))
  for (const n of (notices && notices.notices) || []) {
    if (n.toId !== ctx.meId) continue
    const id = `n-${n.id}`
    if (fs.existsSync(ackPath(ctx.root, n.toId, id))) continue
    list.push({ id, fromId: 'tessel', toId: n.toId, text: n.text, notice: true })
  }
  return list
}

// Marks each message read, one by one, and returns those that were: a
// message whose read note could not be written stays unread and is not
// shown, so nothing is ever marked read without being seen.
function markRead(ctx, messages) {
  const done = []
  try {
    fs.mkdirSync(path.join(ctx.root, 'acks'), { recursive: true })
  } catch {
    return done
  }
  for (const m of messages) {
    const file = ackPath(ctx.root, m.toId, m.id)
    const tmp = `${file}.${process.pid}.tmp`
    try {
      fs.writeFileSync(tmp, JSON.stringify({ id: m.id, toId: m.toId, at: Date.now() }))
      fs.renameSync(tmp, file)
      done.push(m)
    } catch {
      try {
        fs.rmSync(tmp, { force: true })
      } catch {
        // nothing to clean
      }
      break
    }
  }
  return done
}

function label(ctx, id) {
  if (id === 'tessel') return 'Tessel'
  const m = ctx.state.members[id]
  return m ? `#${m.num} ${m.title}` : 'a former teammate'
}

function isReceipt(m) {
  return m.fromId === 'tessel' && /^Delivered to /.test(m.text)
}

// -> text shown to the agent ('' when nothing new)
function readInbox(ctx) {
  const shown = markRead(ctx, unread(ctx)).filter((m) => !isReceipt(m))
  return shown
    .map((m) => `[${label(ctx, m.fromId)} → you, message ${m.id}${m.replyTo ? `, reply to ${m.replyTo}` : ''}] ${m.text}`)
    .join('\n')
}

// --- Send ----------------------------------------------------------------------

function send(ctx, to, text, replyTo) {
  const body = String(text || '').trim()
  if (!body) return { error: 'Nothing to send: "text" is empty.' }
  const target = String(to || '').trim().toLowerCase()
  if (!/^(#\d{1,3}|team)$/.test(target)) return { error: '"to" must be a teammate like "#3", or "team".' }
  const box = path.join(ctx.root, 'outbox', ctx.me.token)
  fs.mkdirSync(box, { recursive: true })
  const name = `mcp-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  if (body.length > MAX_TEXT)
    return { error: `The message is too long (${body.length} characters, at most ${MAX_TEXT}): nothing was sent. Split it in several messages.` }
  const payload = { to: target, text: body }
  if (replyTo) payload.reply_to = String(replyTo).slice(0, 80)
  fs.writeFileSync(path.join(box, `${name}.tmp`), JSON.stringify(payload))
  fs.renameSync(path.join(box, `${name}.tmp`), path.join(box, `${name}.json`))
  return { ok: true }
}

function members(ctx) {
  return Object.entries(ctx.state.members)
    .filter(([, m]) => m.active)
    .map(([id, m]) => `#${m.num} ${m.title}${id === ctx.meId ? ' (you)' : ''}`)
    .join('\n')
}

// --- MCP over stdio ---------------------------------------------------------------

const ME_ARG = {
  me: { type: 'string', description: 'Your pane number, e.g. "#4" (only needed if Tessel did not start you).' }
}
const TOOLS = [
  {
    name: 'team_inbox',
    description:
      'Read new messages from your Tessel teammates (then they count as read). Call it when you start and after each step of your work.',
    inputSchema: { type: 'object', properties: { ...ME_ARG } }
  },
  {
    name: 'team_send',
    description:
      'Send a message to a Tessel teammate ("#3") or your whole team ("team"). It is delivered in the background, never typed into anyone\'s terminal.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'A teammate like "#3", or "team"' },
        text: { type: 'string', description: 'The message' },
        reply_to: { type: 'string', description: 'Optional: the id of the message you answer' },
        ...ME_ARG
      },
      required: ['to', 'text']
    }
  },
  {
    name: 'team_members',
    description: 'List who is in your Tessel team.',
    inputSchema: { type: 'object', properties: { ...ME_ARG } }
  }
]

function callTool(name, args = {}) {
  const ctx = locate(args.me)
  if (ctx.error) return { text: ctx.error, isError: true }
  if (name === 'team_inbox') return { text: readInbox(ctx) || 'No new messages.' }
  if (name === 'team_members') return { text: members(ctx) }
  if (name === 'team_send') {
    const r = send(ctx, args.to, args.text, args.reply_to)
    return r.error ? { text: r.error, isError: true } : { text: `Sent to ${args.to}. Tessel delivers it in the background.` }
  }
  return { text: `Unknown tool ${name}.`, isError: true }
}

function handle(msg) {
  const { id, method, params } = msg
  if (method === 'initialize') {
    return {
      protocolVersion: (params && params.protocolVersion) || '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'tessel-team', version: VERSION },
      instructions:
        'You may be working in a Tessel team with other agents. Call team_inbox when you start and after each step of your work to read messages from teammates, and answer them with team_send. Never ask the user to pass messages between agents.'
    }
  }
  if (method === 'ping') return {}
  if (method === 'tools/list') return { tools: TOOLS }
  if (method === 'tools/call') {
    let r
    try {
      r = callTool(params && params.name, (params && params.arguments) || {})
    } catch (err) {
      r = { text: `Tessel team tool failed: ${err.message}`, isError: true }
    }
    return { content: [{ type: 'text', text: r.text }], isError: !!r.isError }
  }
  if (id === undefined) return undefined // a notification
  throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 })
}

function serve() {
  let buf = ''
  const write = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    buf += chunk
    let nl
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line) continue
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
        continue
      }
      try {
        const result = handle(msg)
        if (msg.id !== undefined && result !== undefined) write({ jsonrpc: '2.0', id: msg.id, result })
      } catch (err) {
        if (msg.id !== undefined) write({ jsonrpc: '2.0', id: msg.id, error: { code: err.code || -32603, message: err.message } })
      }
    }
  })
}

// --- Claude Code hook --------------------------------------------------------------
// `--hook`: stdin is Claude Code's hook JSON. Unread messages are shown as
// extra context (UserPromptSubmit, PostToolUse); on Stop they keep Claude
// going once so it can answer (never when it already continued for a hook).
// Outside a Tessel team it prints nothing.
function hookMain() {
  let input = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (c) => (input += c))
  process.stdin.on('end', () => {
    let data = {}
    try {
      data = JSON.parse(input || '{}')
    } catch {
      data = {}
    }
    const ctx = locate(null, data.cwd)
    if (ctx.error) return
    const event = data.hook_event_name
    if (event === 'Stop' && data.stop_hook_active) return
    const text = readInbox(ctx)
    if (!text) return
    const note = `New messages from your Tessel team (answer with the team_send tool, not through the user):\n${text}`
    if (event === 'Stop') process.stdout.write(JSON.stringify({ decision: 'block', reason: note }))
    else process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: note } }))
  })
}

if (require.main === module) {
  if (process.argv.includes('--hook')) hookMain()
  else serve()
}

module.exports = { locate, readInbox, send, members, handle, candidateDirs, ackPath, markRead, unread }
