#!/usr/bin/env node
// Tessel team tools for agent CLIs (Claude Code, Codex), over MCP (stdio).
// Agents read and send team messages themselves, in the background: nothing
// is ever typed into a terminal.
//
//   team_inbox()             new messages for me (then marked read)
//   team_send({to, text})    to "#3" or "team"
//   team_members()           who is in my team
//   team_tasks() / team_task_add({title, assignee, column}) / team_task_move({id, column})
//                            the team's task board (applied by Tessel)
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

const VERSION = '1.6.4'
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

// Tessel writes who is in which team now (see currentPanes):
// { panes: { <paneId>: { team, num } } } for the teams that exist now. Only
// those count: a folder of a team that was ungrouped is never used.
//
// When Tessel started this agent, TESSEL_PANE_ID says who it is, and nothing
// else can change that. Only without it, "me" ("#4") is used, and only when
// it matches exactly one agent.
// Each Tessel window writes its own current.<window>.json ({ at, panes });
// those written in the last 5 minutes are read (the others' windows are
// gone: no team). current.json only when there is no window file at all
// (an older Tessel wrote just that).
const WINDOW_GONE_MS = 5 * 60 * 1000
function currentPanes(base) {
  let names = []
  try {
    names = fs.readdirSync(base)
  } catch {
    return null
  }
  const windows = names.filter((n) => /^current\.[A-Za-z0-9_-]{1,40}\.json$/.test(n))
  if (windows.length) {
    const panes = {}
    for (const n of windows) {
      const data = readJson(path.join(base, n))
      if (!data || !data.panes || typeof data.at !== 'number' || Date.now() - data.at > WINDOW_GONE_MS) continue
      Object.assign(panes, data.panes)
    }
    return panes
  }
  const current = readJson(path.join(base, 'current.json'))
  return current && current.panes ? current.panes : null
}

// This pane was a member of a team of this project (now inactive in it).
function formerMember(paneId, start) {
  for (const dir of candidateDirs(start)) {
    const base = path.join(dir, '.tessel', 'team-channel')
    let names = []
    try {
      names = fs.readdirSync(base)
    } catch {
      continue
    }
    for (const n of names) {
      const state = readJson(path.join(base, n, 'state.json'))
      if (state && state.members && state.members[paneId]) return true
    }
  }
  return false
}

// -> { root, state, meId, me, teamId } or { error }
function locate(meArg, start) {
  const paneId = process.env.TESSEL_PANE_ID || ''
  const num = /^#?(\d{1,3})$/.exec(String(meArg || '').trim())
  if (!paneId && !num)
    return { error: 'Tessel does not know who you are: pass your pane number as "me", e.g. {"me":"#4"}.' }
  const hits = []
  for (const dir of candidateDirs(start)) {
    const base = path.join(dir, '.tessel', 'team-channel')
    const panes = currentPanes(base)
    if (!panes) continue
    for (const [id, p] of Object.entries(panes)) {
      if (!p || typeof p.team !== 'string') continue
      const mine = paneId ? id === paneId : p.num === Number(num[1])
      if (mine && !hits.some((h) => h.id === id)) hits.push({ id, team: p.team, base })
    }
    if (hits.length) break
  }
  if (!hits.length) {
    // Was it in a team that the user ungrouped (or that it left)? Say so
    // plainly, so the agent stops acting as a team member.
    if (paneId && formerMember(paneId, start))
      return {
        error:
          'You are no longer in a Tessel team: the user ungrouped it (or took you out). You now work alone: talk to the user directly, do not use the team tools and do not wait for teammates.'
      }
    return { error: 'You are not in a Tessel team right now (see Sessions in Tessel).' }
  }
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

// --- Task board ------------------------------------------------------------------
// Tessel publishes the team's cards in tasks.json; an agent asks for a change
// by dropping a request file Tessel applies (it stays the board's only writer).

const COLUMNS = ['todo', 'doing', 'review', 'done']
const COLUMN_NAMES = { todo: 'To do', doing: 'Doing', review: 'Review', done: 'Done' }

function listTasks(ctx) {
  const data = readJson(path.join(ctx.root, 'tasks.json'))
  const tasks = data && Array.isArray(data.tasks) ? data.tasks : []
  if (!tasks.length) return 'No cards on the team board yet. Add one with team_task_add.'
  return COLUMNS.map((c) => {
    const here = tasks.filter((t) => t.column === c)
    if (!here.length) return null
    return `${COLUMN_NAMES[c]}:\n${here.map((t) => `  ${t.id}  ${t.title}${t.assignee ? `  (${t.assignee})` : ''}`).join('\n')}`
  })
    .filter(Boolean)
    .join('\n')
}

// The reminder added to each user message (Claude Code hook): the rule, and
// this agent's cards still open.
function boardReminder(ctx) {
  const data = readJson(path.join(ctx.root, 'tasks.json'))
  const tasks = data && Array.isArray(data.tasks) ? data.tasks : []
  const me = `#${ctx.me.num}`
  const mine = tasks.filter((t) => t.assignee === me && (t.column === 'doing' || t.column === 'todo' || t.column === 'review'))
  const open = mine.length
    ? `Your open cards: ${mine.slice(0, 6).map((t) => `${t.id} "${t.title}" (${COLUMN_NAMES[t.column]})`).join('; ')}${mine.length > 6 ? ' …' : ''}.`
    : 'You have no open card.'
  return `Tessel task board (the user follows your work there; keep it up to date yourself): add a card for every piece of work the moment you start it, what this message asks and each step you decide to take (team_task_add, column "doing"); move your cards as they go (team_task_move: "done" as soon as one is finished). Only a quick question or a short answer needs no card. ${open}`
}

function taskRequest(ctx, data) {
  const folder = path.join(ctx.root, 'requests')
  fs.mkdirSync(folder, { recursive: true })
  const safeId = String(ctx.meId).replace(/[^A-Za-z0-9._-]/g, '_')
  const name = `${safeId}__${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  fs.writeFileSync(path.join(folder, `${name}.tmp`), JSON.stringify(data))
  fs.renameSync(path.join(folder, `${name}.tmp`), path.join(folder, `${name}.json`))
}

function addTask(ctx, args) {
  const title = String(args.title || '').replace(/\s+/g, ' ').trim()
  if (!title) return { error: 'A card needs a "title".' }
  if (title.length > 200) return { error: 'The title is too long (at most 200 characters).' }
  const assignee = args.assignee == null || args.assignee === '' ? `#${ctx.me.num}` : String(args.assignee).trim()
  if (!/^#\d{1,3}$/.test(assignee)) return { error: '"assignee" must be a teammate like "#3".' }
  const column = String(args.column || 'todo').toLowerCase()
  if (!COLUMNS.includes(column)) return { error: `"column" must be one of ${COLUMNS.join(', ')}.` }
  taskRequest(ctx, { action: 'add', title, assignee, column })
  return { ok: true }
}

function moveTask(ctx, args) {
  const id = String(args.id || '').trim()
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(id)) return { error: 'Give the card "id" (see team_tasks).' }
  const column = String(args.column || '').toLowerCase()
  if (!COLUMNS.includes(column)) return { error: `"column" must be one of ${COLUMNS.join(', ')}.` }
  taskRequest(ctx, { action: 'move', id, column })
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
  },
  {
    name: 'team_tasks',
    description:
      "List the cards on your team's task board in Tessel (To do, Doing, Review, Done), with their ids and who does each.",
    inputSchema: { type: 'object', properties: { ...ME_ARG } }
  },
  {
    name: 'team_task_add',
    description:
      "Tessel's task board is how the user follows your work: it must show everything you do. Add a card for every piece of work, the moment you start it: what the user asks, each step you decide to take (split bigger work into cards), and each task you give a teammate. Column \"doing\" for what you start now, \"todo\" for later. Then move it (team_task_move). Only a quick question or a short answer needs no card.",
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'What the task is, in a few words' },
        assignee: { type: 'string', description: 'Who does it, like "#3" (default: you)' },
        column: { type: 'string', enum: COLUMNS, description: 'Where it starts (default: todo)' },
        ...ME_ARG
      },
      required: ['title']
    }
  },
  {
    name: 'team_task_move',
    description:
      'Move your cards as the work goes, every time, without being asked: "doing" when you start one, "review" when it waits for a review, "done" as soon as it is finished. See the ids with team_tasks.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The card id (see team_tasks)' },
        column: { type: 'string', enum: COLUMNS },
        ...ME_ARG
      },
      required: ['id', 'column']
    }
  }
]

// An agent in no team: its workspace's board (.tessel/board/<workspace>),
// from the panes.<window>.json files Tessel writes (fresh ones only).
function boardLocate(start) {
  const paneId = process.env.TESSEL_PANE_ID || ''
  if (!paneId) return null
  for (const dir of candidateDirs(start)) {
    const base = path.join(dir, '.tessel', 'board')
    let names = []
    try {
      names = fs.readdirSync(base)
    } catch {
      continue
    }
    for (const n of names) {
      if (!/^panes\.[A-Za-z0-9_-]{1,40}\.json$/.test(n)) continue
      const data = readJson(path.join(base, n))
      if (!data || !data.panes || typeof data.at !== 'number' || Date.now() - data.at > WINDOW_GONE_MS) continue
      const p = data.panes[paneId]
      if (p && /^[A-Za-z0-9._-]{1,100}$/.test(String(p.ws)) && !String(p.ws).startsWith('.'))
        return { root: path.join(base, p.ws), meId: paneId, me: { num: p.num } }
    }
  }
  return null
}

const BOARD_TOOLS = ['team_tasks', 'team_task_add', 'team_task_move']

function callTool(name, args = {}) {
  let ctx = locate(args.me)
  // Alone (no team): the board tools use the workspace's board.
  if (ctx.error && BOARD_TOOLS.includes(name)) ctx = boardLocate() || ctx
  if (ctx.error) return { text: ctx.error, isError: true }
  if (name === 'team_inbox') return { text: readInbox(ctx) || 'No new messages.' }
  if (name === 'team_members') return { text: members(ctx) }
  if (name === 'team_tasks') return { text: listTasks(ctx) }
  if (name === 'team_task_add' || name === 'team_task_move') {
    const r = name === 'team_task_add' ? addTask(ctx, args) : moveTask(ctx, args)
    return r.error
      ? { text: r.error, isError: true }
      : { text: 'Sent to Tessel: the board shows it within a few seconds (check with team_tasks).' }
  }
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
        'You work in Tessel: the user follows everything you do on its task board, so keep it up to date yourself, without being asked. Add a card (team_task_add) for every piece of work the moment you start it (what the user asks, each step you decide to take, each task you give a teammate), and move your cards as they go (team_task_move: "done" as soon as one is finished). Only a quick question or a short answer needs no card. If you are in a team, call team_inbox when you start and after each step to read messages from teammates, answer them with team_send, and never ask the user to pass messages between agents.'
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
// --- Session reports -------------------------------------------------------------
// The conversation an agent is in right now, as its own hooks say it (every
// event carries session_id; SessionStart comes right after /clear, /resume
// or a restart). Written per pane in <this script's folder>/sessions/, so
// Tessel always resumes the conversation the agent was really in, never an
// id recorded at launch that the user left since.
function reportSession(data, agent) {
  const paneId = process.env.TESSEL_PANE_ID || ''
  const id = String((data && data.session_id) || '')
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(paneId) || paneId.startsWith('.')) return
  if (!/^[A-Za-z0-9_-]{6,80}$/.test(id)) return
  const dir = process.env.TESSEL_SESSIONS_DIR || path.join(__dirname, 'sessions')
  const file = path.join(dir, `${paneId}.json`)
  try {
    const old = readJson(file)
    if (old && old.sessionId === id && old.agent === agent) return // unchanged
    fs.mkdirSync(dir, { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(
      tmp,
      JSON.stringify({ agent, sessionId: id, source: String(data.source || data.hook_event_name || ''), cwd: String(data.cwd || ''), at: Date.now() })
    )
    fs.renameSync(tmp, file)
  } catch {
    // not recorded this time: the next event tries again
  }
}

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
    // A sub-agent of this agent (Claude Code's Task/Agent tool, agent_id set):
    // not the agent itself. Its events must not read the agent's messages
    // (they would be marked read and never reach it) nor change its session.
    if (data.agent_id) return
    // Which conversation the agent is in: recorded first, team or not.
    const codex = process.argv.includes('--codex')
    reportSession(data, codex ? 'codex' : 'claude')
    // Codex's hooks only tell the conversation: its hook output format is
    // not Claude Code's, so nothing is printed for it.
    if (codex) return
    const event = data.hook_event_name
    if (event === 'SessionStart') return // only the report above
    const ctx = locate(null, data.cwd)
    if (ctx.error) return
    if (event === 'Stop' && data.stop_hook_active) return
    const text = readInbox(ctx)
    const notes = []
    if (text) notes.push(`New messages from your Tessel team (answer with the team_send tool, not through the user):\n${text}`)
    // Each message from the user: the board rule, with the cards this agent
    // has open, so it is never forgotten (a long session, a compacted one).
    if (event === 'UserPromptSubmit') notes.push(boardReminder(ctx))
    if (!notes.length) return
    const note = notes.join('\n\n')
    if (event === 'Stop') process.stdout.write(JSON.stringify({ decision: 'block', reason: note }))
    else process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: note } }))
  })
}

// --- Proof of life -------------------------------------------------------------
// While this server runs for a pane Tessel started, it says so every 30 s in
// <project>/.tessel/agents/<paneId>.json, so Tessel can tell the user when an
// agent's team tools are not connected (never started, or closed: "Transport
// closed"). Removed when the server ends normally.
const ALIVE_EVERY_MS = 30000
function aliveFile() {
  const paneId = process.env.TESSEL_PANE_ID || ''
  const dir = process.env.TESSEL_PROJECT_DIR || ''
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(paneId) || paneId.startsWith('.') || !dir) return null
  return path.join(dir, '.tessel', 'agents', `${paneId}.json`)
}
function sayAlive() {
  const file = aliveFile()
  if (!file) return
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, at: Date.now(), version: VERSION }))
    fs.renameSync(tmp, file)
  } catch {
    // tried again in 30 s
  }
}
function startAlive() {
  sayAlive()
  const timer = setInterval(sayAlive, ALIVE_EVERY_MS)
  timer.unref()
  const done = () => {
    const file = aliveFile()
    try {
      if (file && JSON.parse(fs.readFileSync(file, 'utf8')).pid === process.pid) fs.rmSync(file, { force: true })
    } catch {
      // gone already
    }
  }
  process.on('exit', done)
  process.stdin.on('end', () => process.exit(0))
}

if (require.main === module) {
  if (process.argv.includes('--hook')) hookMain()
  else {
    serve()
    startAlive()
  }
}

module.exports = { locate, readInbox, send, members, handle, candidateDirs, ackPath, markRead, unread, listTasks, addTask, moveTask }
