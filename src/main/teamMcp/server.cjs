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
//   team_worker_start / _list / _read / _stop / _release, team_worker_done,
//   team_heartbeat, team_gates
//                            orchestration: a coordinator (the team's lead)
//                            starts workers in new panes (Orca's
//                            coordinator and workers, the Tessel way)
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
const crypto = require('crypto')
const { randomUUID } = crypto

const VERSION = '1.9.2'
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
// A file there that cannot be read right now (being replaced, held by an
// antivirus, Tessel restarting) is tried again briefly; still unreadable, it
// is reported in `info.unsure` so a caller never takes it for "no team". One
// left unchanged longer than a window is kept (its window is gone) is not.
function readJsonSteady(file, info) {
  for (let i = 0; i < 4; i++) {
    const data = readJson(file)
    if (data) return data
    if (!fs.existsSync(file)) return null
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40)
  }
  try {
    if (info && Date.now() - fs.statSync(file).mtimeMs <= WINDOW_GONE_MS) info.unsure = true
  } catch {
    // gone meanwhile
  }
  return null
}

function currentPanes(base, info) {
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
      const data = readJsonSteady(path.join(base, n), info)
      if (!data || !data.panes || typeof data.at !== 'number' || Date.now() - data.at > WINDOW_GONE_MS) continue
      Object.assign(panes, data.panes)
    }
    return panes
  }
  const current = readJsonSteady(path.join(base, 'current.json'), info)
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
  const info = { unsure: false }
  for (const dir of candidateDirs(start)) {
    const base = path.join(dir, '.tessel', 'team-channel')
    const panes = currentPanes(base, info)
    if (!panes) continue
    for (const [id, p] of Object.entries(panes)) {
      if (!p || typeof p.team !== 'string') continue
      const mine = paneId ? id === paneId : p.num === Number(num[1])
      if (mine && !hits.some((h) => h.id === id)) hits.push({ id, team: p.team, base })
    }
    if (hits.length) break
  }
  if (!hits.length) {
    // Tessel's team list could not be read just now: never taken for "no
    // team" (that tells the agent to stop working as a team member).
    if (info.unsure) return { error: 'Tessel is updating its team list: try again in a few seconds.' }
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

// Claim each message before returning it. Hooks and MCP tools may have
// selected the same unread snapshot: publishing an already complete ack
// without replacing an existing one lets only one reader return it.
// Failed publication leaves the message unread for a later attempt.
function markRead(ctx, messages) {
  const done = []
  try {
    fs.mkdirSync(path.join(ctx.root, 'acks'), { recursive: true })
  } catch {
    return done
  }
  for (const m of messages) {
    const file = ackPath(ctx.root, m.toId, m.id)
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`
    try {
      fs.writeFileSync(tmp, JSON.stringify({ id: m.id, toId: m.toId, at: Date.now() }))
      // Same-directory hard link: atomic, complete, and exclusive. Unlike
      // rename it cannot replace the claim made by another reader.
      fs.linkSync(tmp, file)
      done.push(m)
    } catch (err) {
      // Another reader won this message; later messages can still be ours.
      if (err.code !== 'EEXIST') break
    } finally {
      try {
        fs.rmSync(tmp, { force: true })
      } catch {
        // nothing to clean
      }
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

function send(ctx, to, text, replyTo, extra = null) {
  const body = String(text || '').trim()
  if (!body) return { error: 'Nothing to send: "text" is empty.' }
  const target = String(to || '').trim().toLowerCase()
  // A group: one message to each of its members.
  if (/^@[a-z0-9-]{1,30}$/.test(target)) {
    const targets = groupTargets(ctx, target)
    if (targets.error) return targets
    for (const t of targets) {
      const r = send(ctx, t, text, replyTo, extra)
      if (r.error) return r
    }
    return { ok: true, to: targets }
  }
  if (!/^(#\d{1,3}|team)$/.test(target))
    return { error: '"to" must be a teammate like "#3", "team", or a group: "@claude", "@codex" (an agent), "@idle", "@all".' }
  const box = path.join(ctx.root, 'outbox', ctx.me.token)
  fs.mkdirSync(box, { recursive: true })
  const name = `mcp-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  if (body.length > MAX_TEXT)
    return { error: `The message is too long (${body.length} characters, at most ${MAX_TEXT}): nothing was sent. Split it in several messages.` }
  const payload = { to: target, text: body, ...(extra || {}) }
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

// What else a card says: what it waits for, a decision asked, its report.
function cardNotes(t) {
  const out = []
  if (Array.isArray(t.waitingOn) && t.waitingOn.length) out.push(`waits for ${t.waitingOn.join(', ')}`)
  else if (Array.isArray(t.deps) && t.deps.length) out.push(`after ${t.deps.join(', ')}: can start`)
  if (t.gate && t.gate.status === 'pending') out.push(`waits for the user's decision: ${t.gate.question}`)
  if (t.gate && t.gate.status === 'resolved') out.push(`the user decided: ${t.gate.answer}`)
  if (t.report) out.push(`${t.report.outcome}: ${String(t.report.summary || '').slice(0, 160)}`)
  return out.length ? `  [${out.join('; ')}]` : ''
}

function listTasks(ctx) {
  const data = readJson(path.join(ctx.root, 'tasks.json'))
  const tasks = data && Array.isArray(data.tasks) ? data.tasks : []
  if (!tasks.length) return 'No cards on the team board yet. Add one with team_task_add.'
  return COLUMNS.map((c) => {
    const here = tasks.filter((t) => t.column === c)
    if (!here.length) return null
    return `${COLUMN_NAMES[c]}:\n${here.map((t) => `  ${t.id}  ${t.title}${t.assignee ? `  (${t.assignee})` : ''}${cardNotes(t)}`).join('\n')}`
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

// --- Who sent it (src/main/teamAuth.js) ---------------------------------------------
// Tessel gives each pane it starts a secret (TESSEL_TEAM_SECRET, only in the
// environment). A request is MACed with it (over the pane, the team, the
// content, a random nonce and the time); the secret itself is never written
// anywhere. Tessel's answers to a waiting tool are encrypted with a key
// derived from it, so only this agent can read and trust them. All agents run
// as the same Windows user: this stops cheap impersonation between agents,
// not a determined local attacker.
const teamSecret = () => (/^[a-f0-9]{64}$/.test(String(process.env.TESSEL_TEAM_SECRET || '')) ? process.env.TESSEL_TEAM_SECRET : null)

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',')}}`
  return JSON.stringify(value === undefined ? null : value)
}

// The request as written: signed when this agent has its pane's secret.
function signed(ctx, data) {
  const body = JSON.parse(JSON.stringify(data)) // exactly what Tessel will read
  if (!teamSecret()) return body
  const nonce = crypto.randomBytes(18).toString('base64url')
  const at = Date.now()
  const mac = crypto
    .createHmac('sha256', Buffer.from(teamSecret(), 'hex'))
    .update(canonical({ pane: String(ctx.meId), team: String(ctx.teamKey || ctx.teamId || ''), body: { ...body, nonce, at } }))
    .digest('hex')
  return { ...body, auth: { nonce, at, mac } }
}

// An answer Tessel sealed for this agent and this request, or null (not
// ours, forged, or damaged).
function openAnswer(ctx, rid, sealed) {
  if (!teamSecret() || !sealed || typeof sealed !== 'object') return null
  try {
    const key = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(teamSecret(), 'hex'), Buffer.alloc(0), Buffer.from('tessel-team-answer'), 32))
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(String(sealed.iv), 'base64'))
    d.setAAD(Buffer.from(`${ctx.meId}\n${rid}`))
    d.setAuthTag(Buffer.from(String(sealed.tag), 'base64'))
    const a = JSON.parse(Buffer.concat([d.update(Buffer.from(String(sealed.data), 'base64')), d.final()]).toString('utf8'))
    return a && a.rid === rid ? a : null
  } catch {
    return null
  }
}

function taskRequest(ctx, data) {
  const folder = path.join(ctx.root, 'requests')
  fs.mkdirSync(folder, { recursive: true })
  const safeId = String(ctx.meId).replace(/[^A-Za-z0-9._-]/g, '_')
  const name = `${safeId}__${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  fs.writeFileSync(path.join(folder, `${name}.tmp`), JSON.stringify(signed(ctx, data)))
  fs.renameSync(path.join(folder, `${name}.tmp`), path.join(folder, `${name}.json`))
}

const CARD_ID = /^[A-Za-z0-9._-]{1,100}$/

// A list given as an array or as "a, b" text.
function listArg(v) {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean)
  if (typeof v === 'string') return v.split(',').map((x) => x.trim()).filter(Boolean)
  return []
}

function addTask(ctx, args) {
  const title = String(args.title || '').replace(/\s+/g, ' ').trim()
  if (!title) return { error: 'A card needs a "title".' }
  if (title.length > 200) return { error: 'The title is too long (at most 200 characters).' }
  const assignee = args.assignee == null || args.assignee === '' ? `#${ctx.me.num}` : String(args.assignee).trim()
  if (!/^#\d{1,3}$/.test(assignee)) return { error: '"assignee" must be a teammate like "#3".' }
  const column = String(args.column || 'todo').toLowerCase()
  if (!COLUMNS.includes(column)) return { error: `"column" must be one of ${COLUMNS.join(', ')}.` }
  // Cards that must be done first: the card waits, and its agent is told
  // when it can start.
  const deps = listArg(args.after)
  if (deps.length > 10 || deps.some((d) => !CARD_ID.test(d))) return { error: '"after" must be up to 10 card ids (see team_tasks).' }
  taskRequest(ctx, deps.length ? { action: 'add', title, assignee, column, deps } : { action: 'add', title, assignee, column })
  return { ok: true }
}

// The structured end of a card: what was done, found or left, and the files
// changed. Succeeded: the card goes to Done; failed: it stays where it is,
// marked failed. Whoever gave the card is told.
function reportTask(ctx, args) {
  const id = String(args.id || '').trim()
  if (!CARD_ID.test(id)) return { error: 'Give the card "id" (see team_tasks).' }
  const outcome = String(args.outcome || 'succeeded').toLowerCase()
  if (outcome !== 'succeeded' && outcome !== 'failed') return { error: '"outcome" must be "succeeded" or "failed".' }
  const summary = String(args.summary || '').trim()
  if (!summary) return { error: 'Give a "summary": what you did, what you found, what is left (a few sentences).' }
  if (summary.length > 2000) return { error: 'The summary is too long (at most 2000 characters).' }
  const files = listArg(args.files)
  if (files.length > 50 || files.some((f) => f.length > 300)) return { error: '"files": at most 50 paths.' }
  taskRequest(ctx, { action: 'report', id, outcome, summary, files })
  return { ok: true }
}

// A decision only the user makes: the card waits, its question and choices
// shown on the board; the answer comes back as a team message.
function gateTask(ctx, args) {
  const id = String(args.id || '').trim()
  if (!CARD_ID.test(id)) return { error: 'Give the card "id" (see team_tasks).' }
  const question = String(args.question || '').replace(/\s+/g, ' ').trim()
  if (!question) return { error: 'Give the "question" the user decides.' }
  if (question.length > 500) return { error: 'The question is too long (at most 500 characters).' }
  const options = listArg(args.options)
  if (options.length > 6 || options.some((o) => o.length > 80)) return { error: '"options": at most 6 choices of 80 characters.' }
  taskRequest(ctx, { action: 'gate', id, question, options })
  return { ok: true }
}

// --- Who is who ------------------------------------------------------------------
// Tessel writes roster.json in the team's folder: each member's agent, model
// and state (working, idle, approval, limited), for group addresses and
// team_members. Missing (an older Tessel): only "#3" and "team" work.
function roster(ctx) {
  const data = readJson(path.join(ctx.root, 'roster.json'))
  return data && data.members && typeof data.members === 'object' ? data.members : null
}

// "@claude", "@codex" (an agent kind), "@idle" (not working now), "@all"
// -> ["#3", ...] without me, or { error }.
function groupTargets(ctx, group) {
  const g = group.slice(1)
  const active = Object.entries(ctx.state.members).filter(([id, m]) => m.active && id !== ctx.meId)
  if (g === 'all') return active.length ? active.map(([, m]) => `#${m.num}`) : { error: 'You are the only one in your team.' }
  const r = roster(ctx)
  if (!r) return { error: 'Tessel has not said yet which agent is which: send to "#3" or "team" for now.' }
  const hits = active.filter(([id]) => {
    const who = r[id]
    if (!who) return false
    return g === 'idle' ? who.state === 'idle' : who.agent === g
  })
  if (!hits.length) return { error: g === 'idle' ? 'No teammate is idle right now.' : `No teammate is ${group} (see team_members).` }
  return hits.map(([, m]) => `#${m.num}`)
}

function moveTask(ctx, args) {
  const id = String(args.id || '').trim()
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(id)) return { error: 'Give the card "id" (see team_tasks).' }
  const column = String(args.column || '').toLowerCase()
  if (!COLUMNS.includes(column)) return { error: `"column" must be one of ${COLUMNS.join(', ')}.` }
  taskRequest(ctx, { action: 'move', id, column })
  return { ok: true }
}

// Each member, with its agent, model and state, and its open cards.
function members(ctx) {
  const r = roster(ctx) || {}
  const data = readJson(path.join(ctx.root, 'tasks.json'))
  const tasks = data && Array.isArray(data.tasks) ? data.tasks : []
  return Object.entries(ctx.state.members)
    .filter(([, m]) => m.active)
    .map(([id, m]) => {
      const who = r[id] || {}
      const about = [who.agent, who.model, who.state].filter((x) => typeof x === 'string' && x).join(', ')
      const cards = tasks.filter((t) => t.assignee === `#${m.num}` && t.column !== 'done').map((t) => t.id)
      return `#${m.num} ${m.title}${id === ctx.meId ? ' (you)' : ''}${about ? ` [${about}]` : ''}${cards.length ? `, cards: ${cards.join(', ')}` : ''}`
    })
    .join('\n')
}

// --- Asking and waiting for the answer ---------------------------------------------
// team_ask sends a question to one teammate and waits for their answer (a
// message sent with reply_to the question). Waited too long: the question
// stays open, and team_ask with `resume` waits again without asking twice.
const ASK_DEFAULT_S = 50 // under the 60 s some agents give a tool
const ASK_MAX_S = 600
const ASK_ID = /^q-[a-z0-9-]{4,40}$/

function answerTo(ctx, qid) {
  const state = readJson(path.join(ctx.root, 'state.json'))
  const messages = (state && Array.isArray(state.messages) && state.messages) || []
  const asked = messages.filter((m) => m.fromId === ctx.meId && m.askId === qid)
  // Only the one asked answers it (a reply from someone else is a message).
  const askedWhom = new Map(asked.map((m) => [m.id, m.toId]))
  const answer = messages.find(
    (m) => m.toId === ctx.meId && m.replyTo && askedWhom.has(m.replyTo) && m.fromId === askedWhom.get(m.replyTo)
  )
  const refused = messages.find((m) => m.toId === ctx.meId && m.fromId === 'tessel' && m.askId === qid)
  return { asked: asked.length > 0, answer, refused, state }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// signal: aborted when the agent's tool call is cancelled; the answer is then
// left unread (team_inbox, or team_ask with resume, still gets it).
async function ask(ctx, args, signal = null) {
  let qid = args.resume ? String(args.resume).trim() : ''
  if (qid && !ASK_ID.test(qid)) return { error: '"resume" must be the question id team_ask gave you.' }
  const waitS = Math.min(ASK_MAX_S, Math.max(5, Number(args.wait_seconds) || ASK_DEFAULT_S))
  let to = ''
  if (!qid) {
    to = String(args.to || '').trim()
    if (!/^#\d{1,3}$/.test(to)) return { error: '"to" must be one teammate like "#3" (a question has one person who answers).' }
    const question = String(args.question || '').trim()
    if (!question) return { error: 'Give the "question".' }
    const options = listArg(args.options).slice(0, 6)
    qid = `q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const text = `QUESTION, ${label(ctx, ctx.meId)} waits for your answer: reply with team_send, reply_to this message's id.\n${question}${
      options.length ? `\nChoices: ${options.join(' / ')}` : ''
    }`
    const sent = send(ctx, to, text, null, { ask: qid })
    if (sent.error) return sent
  }
  const until = Date.now() + waitS * 1000
  for (;;) {
    if (signal && signal.aborted) return { error: 'Cancelled.' }
    const r = answerTo(ctx, qid)
    if (r.answer) {
      markRead(ctx, [r.answer])
      return { ok: true, text: `Answer from ${label(ctx, r.answer.fromId)} (message ${r.answer.id}): ${r.answer.text}` }
    }
    if (r.refused) return { error: `The question was not sent: ${r.refused.text}` }
    if (Date.now() >= until) break
    await sleep(1000)
  }
  return {
    ok: true,
    text: `No answer yet after ${waitS} s. The question stays open: wait again with team_ask {"resume":"${qid}"} (do not ask again), or go on with other work; the answer also arrives in team_inbox.`
  }
}

// --- Orchestration: workers -------------------------------------------------------
// A coordinator (the team's lead, or a worker allowed to nest) asks Tessel to
// start, stop, release or read its workers; a worker reports done and sends
// heartbeats. Each is a request file like the board's; for the ones that
// answer, Tessel writes <team>/answers/<rid>.json, which the tool waits for.
// The rules (who may, how many at once, how deep, the user's confirmation)
// are Tessel's (src/shared/orchestration.js); this only checks the shape.
const WORKER_AGENTS = ['claude', 'codex', 'gemini', 'qwen']
const HEARTBEAT_PHASES = ['investigating', 'implementing', 'reviewing', 'waiting']
const ANSWER_WAIT_S = 30
const FLAG_VALUE = /^[A-Za-z0-9._:[\]-]{1,60}$/

const newRid = () => `r-${crypto.randomBytes(16).toString('base64url')}`

// Tessel's answer to a request: its text, or null once `seconds` passed.
async function waitAnswer(ctx, rid, seconds, signal = null) {
  const file = path.join(ctx.root, 'answers', `${rid}.json`)
  const until = Date.now() + seconds * 1000
  for (;;) {
    if (signal && signal.aborted) return { error: 'Cancelled.' }
    const raw = readJson(file)
    // Only an answer sealed for this agent and this request counts; anything
    // else in that file is ignored (and left for Tessel to clean up).
    const a = raw && raw.rid === rid ? openAnswer(ctx, rid, raw.sealed) : null
    if (a) {
      try {
        fs.rmSync(file, { force: true })
      } catch {
        // cleaned up by Tessel later
      }
      return a.ok === false ? { error: String(a.text || 'Refused.') } : { ok: true, text: String(a.text || 'Done.') }
    }
    if (Date.now() >= until) return { ok: true, text: null }
    await sleep(500)
  }
}

// Sent, then Tessel's answer (or, when it takes longer, where it will come).
async function workerRequest(ctx, data, signal, later) {
  const rid = newRid()
  taskRequest(ctx, { ...data, rid })
  const a = await waitAnswer(ctx, rid, ANSWER_WAIT_S, signal)
  if (a.error) return a
  return { ok: true, text: a.text || later }
}

function workerHandle(v) {
  const m = /^#?(\d{1,3})$/.exec(String(v == null ? '' : v).trim())
  return m ? `#${m[1]}` : null
}

function workerStart(ctx, args, signal) {
  const agent = String(args.agent || '').trim().toLowerCase()
  if (!WORKER_AGENTS.includes(agent)) return { error: `"agent" must be one of ${WORKER_AGENTS.join(', ')}.` }
  const title = String(args.task || args.title || '').replace(/\s+/g, ' ').trim()
  if (!title) return { error: 'Give the worker\'s "task": a short title for its card.' }
  if (title.length > 200) return { error: 'The task title is too long (at most 200 characters).' }
  const brief = String(args.brief || '').trim()
  if (!brief) return { error: 'Give the worker a "brief": what to do, where, and how to check it.' }
  if (brief.length > 4000) return { error: 'The brief is too long (at most 4000 characters).' }
  const isolation = String(args.isolation || 'worktree').toLowerCase()
  if (isolation !== 'worktree' && isolation !== 'project') return { error: '"isolation" must be "worktree" (its own copy) or "project".' }
  for (const k of ['model', 'effort'])
    if (args[k] != null && args[k] !== '' && !FLAG_VALUE.test(String(args[k]))) return { error: `"${k}" must be a plain name.` }
  const deps = listArg(args.after)
  if (deps.length > 10 || deps.some((d) => !CARD_ID.test(d))) return { error: '"after" must be up to 10 card ids (see team_tasks).' }
  const data = { action: 'worker-start', agent, title, brief, isolation }
  if (args.model) data.model = String(args.model)
  if (args.effort) data.effort = String(args.effort)
  if (deps.length) data.deps = deps
  return workerRequest(ctx, data, signal, 'Sent to Tessel. It has not answered yet: you will hear in team_inbox when the worker starts (or why not). Check with team_worker_list.')
}

function workerAction(action, ctx, args, signal) {
  const all = action === 'worker-stop' && String(args.worker || '').trim().toLowerCase() === 'all'
  const worker = all ? 'all' : workerHandle(args.worker)
  if (!worker) return { error: 'Give the "worker", like "#5" (see team_worker_list).' }
  const data = { action, worker }
  if (action === 'worker-stop' && args.reason) data.reason = String(args.reason).slice(0, 300)
  if (action === 'worker-read') data.lines = Math.min(200, Math.max(1, Number(args.lines) || 60))
  return workerRequest(ctx, data, signal, 'Sent to Tessel. It has not answered yet: check with team_worker_list in a moment.')
}

function workerDone(ctx, args) {
  const outcome = String(args.outcome || 'succeeded').toLowerCase()
  if (outcome !== 'succeeded' && outcome !== 'failed') return { error: '"outcome" must be "succeeded" or "failed".' }
  const summary = String(args.summary || '').trim()
  if (!summary) return { error: 'Give a "summary": what you did, what you found, what is left (3 sentences).' }
  if (summary.length > 2000) return { error: 'The summary is too long (at most 2000 characters).' }
  const files = listArg(args.files)
  if (files.length > 50 || files.some((f) => f.length > 300)) return { error: '"files": at most 50 paths.' }
  taskRequest(ctx, { action: 'worker-done', outcome, summary, files })
  return { ok: true, text: 'Sent to Tessel: your coordinator is told. Your work on this task is complete: stop here and return to an idle prompt.' }
}

function heartbeat(ctx, args) {
  const phase = args.phase ? String(args.phase).toLowerCase() : null
  if (phase && !HEARTBEAT_PHASES.includes(phase)) return { error: `"phase" must be one of ${HEARTBEAT_PHASES.join(', ')}.` }
  taskRequest(ctx, { action: 'heartbeat', phase, note: String(args.note || '').slice(0, 200) })
  return { ok: true, text: 'Heartbeat sent.' }
}

const ago = (at) => {
  if (!Number.isFinite(at)) return ''
  const m = Math.round((Date.now() - at) / 60000)
  return m < 1 ? 'just now' : `${m} min ago`
}

// The workers Tessel published (workers.json): who, whose, which card, how.
function listWorkers(ctx) {
  const data = readJson(path.join(ctx.root, 'workers.json'))
  const workers = data && Array.isArray(data.workers) ? data.workers : []
  const lim = data && data.limits
  const head = lim
    ? `Limits: ${lim.maxConcurrent} workers at a time per coordinator, nesting depth ${lim.maxDepth}${lim.confirm ? ', the user confirms each start' : ''}.`
    : ''
  const phases = data && data.phases ? Object.entries(data.phases).map(([k, v]) => `${k}: ${v}`) : []
  if (!workers.length) return [head, 'No workers yet. A coordinator starts one with team_worker_start.'].filter(Boolean).join('\n')
  const lines = workers.map((w) => {
    const bits = [w.status, w.agent, w.isolation === 'worktree' ? (w.branch ? `own copy, branch ${w.branch}` : 'own copy') : 'project folder']
    if (w.card) bits.push(`card ${w.card}`)
    if (w.heartbeatAt) bits.push(`heartbeat ${ago(w.heartbeatAt)}${w.phase ? ` (${w.phase})` : ''}`)
    if (w.note) bits.push(w.note)
    return `  ${w.handle || '(not started)'} "${w.title}"${w.coordinator ? `, worker of ${w.coordinator}` : ''}  [${bits.filter(Boolean).join('; ')}]`
  })
  return [head, phases.length ? `Coordinator phase: ${phases.join(', ')}.` : '', 'Workers:', ...lines].filter(Boolean).join('\n')
}

// Orca's gate-list: the decisions asked on the team's cards.
function listGates(ctx) {
  const data = readJson(path.join(ctx.root, 'tasks.json'))
  const tasks = data && Array.isArray(data.tasks) ? data.tasks : []
  const gated = tasks.filter((t) => t.gate && (t.gate.status === 'pending' || t.gate.status === 'resolved'))
  if (!gated.length) return 'No decisions asked. Ask one with team_task_gate; the user answers on the board.'
  return gated
    .map((t) =>
      t.gate.status === 'pending'
        ? `  pending   ${t.id} "${t.title}": ${t.gate.question}${t.gate.options && t.gate.options.length ? ` (choices: ${t.gate.options.join(' / ')})` : ''}`
        : `  resolved  ${t.id} "${t.title}": ${t.gate.question} -> ${t.gate.answer}`
    )
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
      'Send a message to a Tessel teammate ("#3"), your whole team ("team"), or a group: "@claude", "@codex" (every teammate running that agent), "@idle" (those not working now), "@all". It is delivered in the background, never typed into anyone\'s terminal.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'A teammate like "#3", "team", or a group like "@codex", "@idle", "@all"' },
        text: { type: 'string', description: 'The message' },
        reply_to: { type: 'string', description: 'Optional: the id of the message you answer' },
        ...ME_ARG
      },
      required: ['to', 'text']
    }
  },
  {
    name: 'team_members',
    description: 'List who is in your Tessel team: each teammate’s agent, model, state (working, idle, approval, limited) and open cards. Use it to pick who gets a task.',
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
        after: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional: ids of cards that must be done first. The card waits, and its agent is told when it can start (phases: plan, then backend, then UI, then tests).'
        },
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
  },
  {
    name: 'team_task_done',
    description:
      'Finish a card with a report: succeeded (the card goes to Done) or failed (it stays, marked failed), what you did, found and left, and the files you changed. Whoever gave you the card is told. Use it instead of just moving the card to Done when you finish work a teammate gave you.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The card id (see team_tasks)' },
        outcome: { type: 'string', enum: ['succeeded', 'failed'], description: 'Default: succeeded' },
        summary: { type: 'string', description: 'A few sentences: what you did, what you found, what is left' },
        files: { type: 'array', items: { type: 'string' }, description: 'Optional: the files you changed' },
        ...ME_ARG
      },
      required: ['id', 'summary']
    }
  },
  {
    name: 'team_task_gate',
    description:
      'Ask the user to decide something before a card goes on (a choice only they make: a design, a risky change, spending). The card shows the question and your choices on the board; the answer comes back as a team message. Meanwhile, do other work or wait.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The card id (see team_tasks)' },
        question: { type: 'string', description: 'What the user decides' },
        options: { type: 'array', items: { type: 'string' }, description: 'Optional: up to 6 choices' },
        ...ME_ARG
      },
      required: ['id', 'question']
    }
  },
  {
    name: 'team_ask',
    description:
      'Ask one teammate a question and wait for the answer (they reply with team_send and reply_to). Waits up to wait_seconds (default 50); with no answer by then the question stays open: call team_ask again with "resume" set to its id to keep waiting, never ask again.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'One teammate like "#3"' },
        question: { type: 'string', description: 'The question' },
        options: { type: 'array', items: { type: 'string' }, description: 'Optional: choices to offer' },
        wait_seconds: { type: 'number', description: 'How long to wait (5 to 600, default 50)' },
        resume: { type: 'string', description: 'Keep waiting for a question asked before (its id)' },
        ...ME_ARG
      }
    }
  },
  {
    name: 'team_worker_start',
    description:
      'Coordinators only (the team lead, or a worker allowed to nest): start a worker, a new agent in a new Tessel pane of your project, with its own card on the board. It joins your team, gets your brief with its handle, yours and its card id, and reports back with team_worker_done. Tessel applies the user\'s limits: workers at a time (the rest wait in a queue), nesting depth, and, when set, the user confirms each start. Split the work first (team_task_add), then start one worker per independent piece.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', enum: WORKER_AGENTS, description: 'Which agent CLI runs the worker' },
        task: { type: 'string', description: 'A short title for the worker\'s card' },
        brief: { type: 'string', description: 'What to do, where, how to check it, what to report (up to 4000 characters)' },
        isolation: {
          type: 'string',
          enum: ['worktree', 'project'],
          description: '"worktree" (default): its own git copy and branch of your project; "project": the project folder itself'
        },
        model: { type: 'string', description: 'Optional: the model the worker runs' },
        effort: { type: 'string', description: 'Optional: its reasoning effort, like "high"' },
        after: { type: 'array', items: { type: 'string' }, description: 'Optional: card ids that must be done before it starts (it waits in the queue)' },
        ...ME_ARG
      },
      required: ['agent', 'task', 'brief']
    }
  },
  {
    name: 'team_worker_list',
    description:
      "List your team's workers: each one's handle, coordinator, card, status (confirming, queued, starting, running, done, failed, stopped, released), its own copy, last heartbeat; the limits and each coordinator's phase.",
    inputSchema: { type: 'object', properties: { ...ME_ARG } }
  },
  {
    name: 'team_worker_read',
    description: "Read a worker's recent terminal output (the last lines on its screen), to see how it is doing without disturbing it. Only its coordinator (or the lead).",
    inputSchema: {
      type: 'object',
      properties: {
        worker: { type: 'string', description: 'The worker, like "#5"' },
        lines: { type: 'number', description: 'How many lines (1 to 200, default 60)' },
        ...ME_ARG
      },
      required: ['worker']
    }
  },
  {
    name: 'team_worker_stop',
    description:
      'Stop one of your workers ("#5") or all of them ("all"): its pane is closed the way the user closes one; its card and its copy stay for review. A worker still waiting (confirming, queued) is cancelled.',
    inputSchema: {
      type: 'object',
      properties: {
        worker: { type: 'string', description: 'The worker, like "#5", or "all"' },
        reason: { type: 'string', description: 'Optional: why, shown on the board' },
        ...ME_ARG
      },
      required: ['worker']
    }
  },
  {
    name: 'team_worker_release',
    description:
      'Release one of your workers: it stays open as an ordinary teammate, no longer counted among your workers (its slot goes to the next one waiting).',
    inputSchema: {
      type: 'object',
      properties: { worker: { type: 'string', description: 'The worker, like "#5"' }, ...ME_ARG },
      required: ['worker']
    }
  },
  {
    name: 'team_worker_done',
    description:
      'Workers only: report the outcome of your task, exactly once. succeeded or failed, a 3-sentence summary (what you did, what you found, what is left), the files you changed. Your card is finished with it and your coordinator is told. Then stop and return to an idle prompt.',
    inputSchema: {
      type: 'object',
      properties: {
        outcome: { type: 'string', enum: ['succeeded', 'failed'], description: 'Default: succeeded' },
        summary: { type: 'string', description: 'What you did, what you found, what is left' },
        files: { type: 'array', items: { type: 'string' }, description: 'Optional: the files you changed' },
        ...ME_ARG
      },
      required: ['summary']
    }
  },
  {
    name: 'team_heartbeat',
    description: 'Workers only: say you are still working, every 5 minutes, with your phase. Your coordinator sees it in team_worker_list.',
    inputSchema: {
      type: 'object',
      properties: {
        phase: { type: 'string', enum: HEARTBEAT_PHASES },
        note: { type: 'string', description: 'Optional: a few words on where you are' },
        ...ME_ARG
      }
    }
  },
  {
    name: 'team_gates',
    description: "List the decisions asked on your team's cards (team_task_gate): pending ones wait for the user, who answers on Tessel's board; resolved ones with the answer.",
    inputSchema: { type: 'object', properties: { ...ME_ARG } }
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
        return { root: path.join(base, p.ws), meId: paneId, me: { num: p.num }, teamKey: `board:${p.ws}` }
    }
  }
  return null
}

const BOARD_TOOLS = ['team_tasks', 'team_task_add', 'team_task_move', 'team_task_done', 'team_task_gate']

function callTool(name, args = {}, signal = null) {
  let ctx = locate(args.me)
  // Alone (no team): the board tools use the workspace's board.
  if (ctx.error && BOARD_TOOLS.includes(name)) ctx = boardLocate() || ctx
  if (ctx.error) return { text: ctx.error, isError: true }
  if (name === 'team_inbox') return { text: readInbox(ctx) || 'No new messages.' }
  if (name === 'team_members') return { text: members(ctx) }
  if (name === 'team_tasks') return { text: listTasks(ctx) }
  const boardOps = { team_task_add: addTask, team_task_move: moveTask, team_task_done: reportTask, team_task_gate: gateTask }
  if (boardOps[name]) {
    const r = boardOps[name](ctx, args)
    return r.error
      ? { text: r.error, isError: true }
      : { text: 'Sent to Tessel: the board shows it within a few seconds (check with team_tasks).' }
  }
  if (name === 'team_send') {
    const r = send(ctx, args.to, args.text, args.reply_to)
    if (r.error) return { text: r.error, isError: true }
    return { text: `Sent to ${r.to ? r.to.join(', ') : args.to}. Tessel delivers it in the background.` }
  }
  if (name === 'team_ask') {
    // Only in a team: someone must be there to answer.
    if (!ctx.state) return { text: 'You are not in a Tessel team: nobody can answer.', isError: true }
    return ask(ctx, args, signal).then((r) => (r.error ? { text: r.error, isError: true } : { text: r.text }))
  }
  // Orchestration: only in a team (a worker joins its coordinator's team).
  const workerOps = {
    team_worker_start: () => workerStart(ctx, args, signal),
    team_worker_read: () => workerAction('worker-read', ctx, args, signal),
    team_worker_stop: () => workerAction('worker-stop', ctx, args, signal),
    team_worker_release: () => workerAction('worker-release', ctx, args, signal),
    team_worker_done: () => workerDone(ctx, args),
    team_heartbeat: () => heartbeat(ctx, args),
    team_worker_list: () => ({ ok: true, text: listWorkers(ctx) }),
    team_gates: () => ({ ok: true, text: listGates(ctx) })
  }
  if (workerOps[name]) {
    if (!ctx.state) return { text: 'You are not in a Tessel team: workers belong to a team (see Sessions in Tessel).', isError: true }
    // Tessel only acts on signed orchestration requests (the lists are read
    // here, they need no signature).
    if (!teamSecret() && name !== 'team_worker_list' && name !== 'team_gates')
      return { text: 'Tessel did not start this agent with its team secret: restart it from Tessel (right-click its pane, Restart) to use the worker tools.', isError: true }
    const out = (r) => (r.error ? { text: r.error, isError: true } : { text: r.text })
    const r = workerOps[name]()
    return r && typeof r.then === 'function' ? r.then(out) : out(r)
  }
  return { text: `Unknown tool ${name}.`, isError: true }
}

// signal: aborted when the client cancels this request (a waiting team_ask).
function handle(msg, signal = null) {
  const { id, method, params } = msg
  if (method === 'initialize') {
    return {
      protocolVersion: (params && params.protocolVersion) || '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'tessel-team', version: VERSION },
      instructions:
        'You work in Tessel: the user follows everything you do on its task board, so keep it up to date yourself, without being asked. Add a card (team_task_add) for every piece of work the moment you start it (what the user asks, each step you decide to take, each task you give a teammate), and move your cards as they go (team_task_move: "done" as soon as one is finished). Only a quick question or a short answer needs no card. If you are in a team, call team_inbox when you start and after each step to read messages from teammates, answer them with team_send, and never ask the user to pass messages between agents. To work together: give a teammate a card (team_task_add, with "after" when it must wait for other cards), finish work you were given with team_task_done and a short report, ask one teammate and wait for the answer with team_ask, ask the user to decide with team_task_gate, and send to groups like "@codex" or "@idle"; team_members shows who is idle. A team lead can also coordinate workers: start new agents in new panes with team_worker_start (one per independent piece of work), follow them with team_worker_list and team_worker_read, and stop or release them; a worker reports with team_worker_done and sends team_heartbeat while it works.'
    }
  }
  if (method === 'ping') return {}
  if (method === 'tools/list') return { tools: TOOLS }
  if (method === 'tools/call') {
    const done = (r) => ({ content: [{ type: 'text', text: r.text }], isError: !!r.isError })
    const failed = (err) => done({ text: `Tessel team tool failed: ${err.message}`, isError: true })
    try {
      const r = callTool(params && params.name, (params && params.arguments) || {}, signal)
      // Only a tool that waits (team_ask) answers later.
      return r && typeof r.then === 'function' ? r.then(done, failed) : done(r)
    } catch (err) {
      return failed(err)
    }
  }
  if (id === undefined) return undefined // a notification
  throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 })
}

function serve() {
  let buf = ''
  const running = new Map() // request id -> AbortController
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
      // The client gave up on a request (a waiting team_ask): stop it.
      if (msg.method === 'notifications/cancelled') {
        const c = msg.params && running.get(msg.params.requestId)
        if (c) c.abort()
        continue
      }
      // A tool may wait (team_ask): answered when done, the others meanwhile.
      const control = new AbortController()
      if (msg.id !== undefined) running.set(msg.id, control)
      Promise.resolve()
        .then(() => handle(msg, control.signal))
        .then(
          (result) => {
            if (msg.id !== undefined && result !== undefined && !control.signal.aborted) write({ jsonrpc: '2.0', id: msg.id, result })
          },
          (err) => {
            if (msg.id !== undefined && !control.signal.aborted)
              write({ jsonrpc: '2.0', id: msg.id, error: { code: err.code || -32603, message: err.message } })
          }
        )
        .finally(() => running.delete(msg.id))
    }
  })
}

// --- Claude Code hook --------------------------------------------------------------
// `--hook`: stdin is Claude Code's hook JSON. Unread messages are shown as
// extra context (UserPromptSubmit, PostToolUse); on Stop they keep Claude
// going once so it can answer (never when it already continued for a hook).
// Outside a Tessel team it prints nothing.
// --- Session reports -------------------------------------------------------------
// Status observations have their own bounded spool. They never claim messages
// or return a permission decision. Keep this self-contained: this file is also
// copied outside the application and run directly by the CLIs.
const AGENT_STATE_PROTOCOL = 1
// The agents this script reports the status of (see STATUS_AGENTS below):
// agentStateSetup.js checks the shared copy knows them.
const AGENT_STATUS_AGENTS = 2
const HOOK_STARTED_AT = Date.now()
const STATUS_EVENTS = {
  claude: new Set(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'Notification', 'Stop', 'StopFailure', 'SessionEnd', 'SubagentStart', 'SubagentStop']),
  codex: new Set(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'Stop', 'Interrupt', 'SessionEnd', 'SubagentStart', 'SubagentStop'])
}
// The other agents' own events, in the names above (status evidence only:
// never a prompt, a tool's arguments or its output). Mapping after Orca's
// src/shared/agent-hook-listener/providers/*-events.ts, MIT, Copyright (c)
// 2026 Lovecast Inc.
// Agents whose hooks (agentStatusHooks.js) only report their status: the hook
// answers nothing, or the neutral answer their CLI waits for.
const STATUS_AGENTS = ['cursor', 'droid', 'grok', 'antigravity', 'openclaude', 'commandcode', 'amp', 'pi']
// Cursor's prompt hook answers {"continue":true} (it takes the AND of every
// hook's answer: never a refusal of Tessel's). Antigravity's PreInvocation can
// only add context (its result has no decision): an explicit empty result, as
// its documentation shows, never a silence it could read otherwise.
const STATUS_ANSWERS = { cursor: { beforeSubmitPrompt: '{"continue":true}' }, antigravity: { PreInvocation: '{}' } }
// The events Tessel's own plugins and extensions (OpenCode, Amp, Pi) send.
const STATUS_PLUGIN_EVENTS = new Set(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'StopFailure', 'Interrupt', 'SessionEnd', 'Elicitation', 'ElicitationResult', 'SubagentStart', 'SubagentStop'])
const str = (v) => (typeof v === 'string' ? v : '')
const firstStr = (data, keys) => {
  for (const key of keys) if (typeof data[key] === 'string' && data[key]) return data[key]
  return ''
}
const compact = (v) => str(v).replace(/[^a-z0-9]/gi, '').toLowerCase()
const snakeName = (v) =>
  str(v)
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_')
    .toLowerCase()
// A question to the user: the pane waits for an answer.
const isAskTool = (name) => ['askuserquestion', 'askuser', 'askquestion', 'requestuserinput'].includes(compact(name))
const toolOf = (data) => firstStr(data, ['tool_name', 'toolName', 'name'])
const askOr = (event, data) => (isAskTool(toolOf(data)) ? { event, toolName: 'AskUserQuestion' } : { event })
const permission = () => ({ event: 'Notification', notificationType: 'permission_prompt' })
const COPILOT_NAMES = {
  sessionStart: 'SessionStart',
  sessionEnd: 'SessionEnd',
  userPromptSubmitted: 'UserPromptSubmit',
  userPromptSubmit: 'UserPromptSubmit',
  preToolUse: 'PreToolUse',
  postToolUse: 'PostToolUse',
  postToolUseFailure: 'PostToolUseFailure',
  subagentStart: 'SubagentStart',
  subagentStop: 'SubagentStop',
  agentStop: 'Stop',
  stop: 'Stop',
  errorOccurred: 'ErrorOccurred',
  permissionRequest: 'PermissionRequest',
  notification: 'Notification'
}
const NORMALIZE = {
  gemini(name, data) {
    if (name === 'Notification') return data.notification_type === 'ToolPermission' ? permission() : null
    const map = { SessionStart: 'SessionStart', BeforeAgent: 'UserPromptSubmit', BeforeTool: 'PreToolUse', AfterTool: 'PostToolUse', AfterAgent: 'Stop', SessionEnd: 'SessionEnd' }
    return map[name] ? { event: map[name] } : null
  },
  copilot(raw, data) {
    const name = COPILOT_NAMES[raw] || raw
    if (name === 'Notification')
      return ['permission_prompt', 'elicitation_dialog'].includes(firstStr(data, ['notification_type', 'notificationType'])) ? permission() : null
    if (name === 'PreToolUse') return askOr('PreToolUse', data)
    if (name === 'ErrorOccurred') return { event: data.recoverable === true ? 'PostToolUse' : 'StopFailure' }
    if (name === 'SubagentStart' || name === 'SubagentStop') {
      // A sub-agent Copilot runs: its name identifies it (there is no id).
      const agentId = firstStr(data, ['agent_id', 'agentId', 'agentName', 'agent_name'])
      return agentId ? { event: name, agentId } : null
    }
    return ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure', 'Stop'].includes(name) ? { event: name } : null
  },
  kimi(name, data) {
    if (name === 'PreToolUse') return askOr('PreToolUse', data)
    // Kimi asks before a tool runs: the pane waits for the user.
    if (name === 'PermissionRequest') return permission()
    if (name === 'Stop') return { event: data.is_interrupt === true ? 'Interrupt' : 'Stop' }
    return ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure', 'StopFailure', 'SessionEnd'].includes(name) ? { event: name } : null
  },
  opencode: (name) => (STATUS_PLUGIN_EVENTS.has(name) ? { event: name } : null),
  amp: (name) => (STATUS_PLUGIN_EVENTS.has(name) ? { event: name } : null),
  pi: (name, data) => (name === 'PreToolUse' ? askOr('PreToolUse', data) : STATUS_PLUGIN_EVENTS.has(name) ? { event: name } : null),
  openclaude: (name) => (STATUS_EVENTS.claude.has(name) ? { event: name } : null),
  cursor(name, data) {
    if (name === 'beforeSubmitPrompt') return { event: 'UserPromptSubmit' }
    if (name === 'postToolUse') return { event: 'PostToolUse' }
    if (name === 'postToolUseFailure') return { event: 'PostToolUseFailure' }
    if (name === 'stop') {
      const status = str(data.status)
      return { event: !status || status === 'completed' ? 'Stop' : status === 'error' ? 'StopFailure' : 'Interrupt' }
    }
    return null
  },
  droid(name, data) {
    if (name === 'PreToolUse') {
      // Droid asks before a high-risk tool (no Notification then).
      const input = data.tool_input && typeof data.tool_input === 'object' ? data.tool_input : {}
      const risk = str(data.riskLevel || data.risk_level || input.riskLevel || input.risk_level).trim().toLowerCase()
      return risk === 'high' ? permission() : askOr('PreToolUse', data)
    }
    if (name === 'PermissionRequest') return permission()
    if (name === 'Notification') {
      const message = str(data.message).toLowerCase()
      if (/permission|approve|approval/.test(message)) return permission()
      // Droid runs no Stop hook when interrupted: only this idle notice.
      if (/waiting for (your )?input/.test(message)) return { event: 'Stop' }
      return null
    }
    return ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop'].includes(name) ? { event: name } : null
  },
  grok(raw, data) {
    // A sub-agent's own session: its lifecycle is not the pane's.
    if (firstStr(data, ['subagentType', 'subagent_type'])) return null
    const name = snakeName(raw)
    const simple = {
      session_start: 'SessionStart',
      session_end: 'SessionEnd',
      user_prompt_submit: 'UserPromptSubmit',
      post_tool_use: 'PostToolUse',
      post_tool_use_failure: 'PostToolUseFailure',
      stop_failure: 'StopFailure',
      stop_cancelled: 'Interrupt'
    }
    if (simple[name]) return { event: simple[name] }
    if (name === 'pre_tool_use') return askOr('PreToolUse', data)
    if (name === 'stop') {
      if (['shutdown', 'channel_closed'].includes(str(data.reason))) return { event: 'SessionEnd' }
      // Background sub-agents or shells still run: the pane still works, until
      // Grok's idle notice.
      const tasks = Array.isArray(data.backgroundTasks) ? data.backgroundTasks : Array.isArray(data.background_tasks) ? data.background_tasks : []
      return { event: tasks.some((t) => t && (t.type === 'subagent' || t.type === 'shell')) ? 'PostToolUse' : 'Stop' }
    }
    if (name === 'notification') {
      const type = snakeName(firstStr(data, ['notificationType', 'notification_type', 'type']))
      const message = str(data.message).trim().toLowerCase()
      if (type === 'idle_prompt') return { event: 'Stop' }
      // Sent before each tool, even when nothing is asked.
      if (type === 'permission_prompt' && message === 'tool permission requested') return null
      if (/permission|approval|approve|allow|confirm|needs your|requires your|feedback|clarify|question/.test(message)) return permission()
    }
    return null
  },
  antigravity(name, data) {
    if (name === 'PreInvocation') return { event: 'UserPromptSubmit' }
    if (name === 'PostInvocation' || name === 'PostToolUse') return { event: 'PostToolUse' }
    // A Stop between two steps (not fully idle) is not the turn's end.
    if (name === 'Stop') return { event: data.fullyIdle === false || data.fully_idle === false ? 'PostToolUse' : 'Stop' }
    return null
  },
  commandcode: (name) => (['PreToolUse', 'PostToolUse', 'Stop'].includes(name) ? { event: name } : null)
}
// -> the status event this hook stands for ({ event, ...fields }), or null.
function statusEvent(provider, data) {
  const name = data.hook_event_name
  if (provider === 'claude' || provider === 'codex') return STATUS_EVENTS[provider].has(name) ? { event: name } : null
  const normalize = Object.hasOwn(NORMALIZE, provider) ? NORMALIZE[provider] : null
  return normalize && typeof name === 'string' ? normalize(name, data) : null
}
function reportAgentState(data, provider, continuing = false) {
  const paneId = process.env.TESSEL_PANE_ID || ''
  const launchToken = process.env.TESSEL_AGENT_LAUNCH || ''
  const root = process.env.TESSEL_AGENT_STATE_DIR || ''
  if (process.env.TESSEL_AGENT_PROVIDER !== provider) return
  const status = statusEvent(provider, data)
  if (!status) return
  if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$/.test(paneId) || !/^[A-Za-z0-9_-]{16,100}$/.test(launchToken)) return
  let sessionId = String(data.session_id || '')
  // An agent whose events carry no usable conversation id: one per launch.
  // Derived from the launch token, never a piece of it (the token binds events
  // to this launch; the session id is written where other processes read it).
  if (!/^[A-Za-z0-9_-]{6,100}$/.test(sessionId) && provider !== 'claude' && provider !== 'codex')
    sessionId = `launch-${crypto.createHash('sha256').update(launchToken).digest('hex').slice(0, 16)}`
  if (!/^[A-Za-z0-9_-]{6,100}$/.test(sessionId) || !path.isAbsolute(root)) return
  const dir = path.join(root, 'events')
  let tmp
  try {
    fs.mkdirSync(dir, { recursive: true })
    // A stopped application must not leave an unbounded event log. Recovery
    // will use new observations, not pretend dropped history was complete.
    let count = 0
    const listing = fs.opendirSync(dir)
    try { while (listing.readSync()) if (++count >= 4096) return } finally { listing.closeSync() }
    // A plugin (OpenCode, Amp, Pi) says when its event happened: it runs its
    // hooks one after the other, but each process starts a little later.
    const sent = Number(data.tessel_at)
    const at = Number.isSafeInteger(sent) && sent <= Date.now() && sent > Date.now() - 60000 ? sent : HOOK_STARTED_AT
    const event = {
      v: AGENT_STATE_PROTOCOL, id: randomUUID(), paneId, provider, launchToken,
      sessionId, event: status.event, at, source: 'hook'
    }
    const identifier = (value) => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value) ? value : undefined
    const agentId = status.agentId !== undefined ? status.agentId : data.agent_id
    if (agentId && !identifier(agentId)) return // never turn an invalid child identity into the parent
    const fields = {
      agentId,
      toolId: data.tool_use_id || data.tool_call_id,
      turnId: data.prompt_id || data.turn_id
    }
    for (const [key, value] of Object.entries(fields)) if (identifier(value)) event[key] = value
    const notificationType = status.notificationType || data.notification_type
    if (['permission_prompt', 'idle_prompt'].includes(notificationType)) event.notificationType = notificationType
    if (['startup', 'resume', 'clear', 'compact'].includes(data.source)) event.startSource = data.source
    if (status.event === 'Stop') event.continuing = continuing
    // Only a tool's identity, never its arguments or prompt text.
    const toolName = status.toolName || data.tool_name
    if (['AskUserQuestion', 'request_user_input'].includes(toolName)) event.toolName = toolName
    const file = path.join(dir, `${event.at}-${event.id}.json`)
    tmp = file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(event), { flag: 'wx', mode: 0o600 })
    fs.renameSync(tmp, file)
  } catch {
    // Observation cannot break a command or permission hook.
    if (tmp) { try { fs.unlinkSync(tmp) } catch { /* already absent */ } }
  }
}

// The conversation an agent is in right now, as its own hooks say it (every
// event carries session_id; SessionStart comes right after /clear, /resume
// or a restart). Written per pane in <this script's folder>/sessions/, so
// Tessel always resumes the conversation the agent was really in, never an
// id recorded at launch that the user left since.
function reportSession(data, agent) {
  const paneId = process.env.TESSEL_PANE_ID || ''
  // Another agent started inside the pane's agent (it inherits the pane's
  // environment): its conversation is not the pane's, never recorded over it.
  const paneAgent = process.env.TESSEL_AGENT_PROVIDER || ''
  if (paneAgent && paneAgent !== agent) return
  const id = String((data && data.session_id) || '')
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(paneId) || paneId.startsWith('.')) return
  if (!/^[A-Za-z0-9_-]{6,80}$/.test(id)) return
  const dir = process.env.TESSEL_SESSIONS_DIR || path.join(__dirname, 'sessions')
  const file = path.join(dir, `${paneId}.json`)
  // Claude Code's own inbox (a named pipe and its key, given to its hooks):
  // Tessel posts reminders there instead of typing them into the terminal.
  const inbox = agent === 'claude' ? String(process.env.CLAUDE_CODE_MESSAGING_SOCKET || '') : ''
  const inboxToken = inbox ? String(process.env.CLAUDE_CODE_MESSAGING_TOKEN || '') : ''
  try {
    const old = readJson(file)
    // Unchanged: rewritten at most once a minute, so its time says when the
    // hooks last ran (Tessel's "last signal"), without a write per event.
    if (
      old &&
      old.sessionId === id &&
      old.agent === agent &&
      (old.inbox || '') === inbox &&
      (old.inboxToken || '') === inboxToken &&
      Date.now() - (Number(old.at) || 0) < 60000
    )
      return
    fs.mkdirSync(dir, { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    const report = { agent, sessionId: id, source: String(data.source || data.hook_event_name || ''), cwd: String(data.cwd || ''), at: Date.now() }
    if (inbox && inboxToken) Object.assign(report, { inbox, inboxToken })
    fs.writeFileSync(tmp, JSON.stringify(report))
    fs.renameSync(tmp, file)
  } catch {
    // not recorded this time: the next event tries again
  }
}

// Older Kimi hook payloads without stop_hook_active get one continuation until
// the next real user prompt. Current 2.x also enforces this in its own loop.
function kimiStopGuard(data, reset = false) {
  const pane = process.env.TESSEL_PANE_ID || ''
  const session = String(data.session_id || '')
  if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$/.test(pane) || !/^[A-Za-z0-9_-]{6,80}$/.test(session)) return false
  const dir = path.join(process.env.TESSEL_SESSIONS_DIR || path.join(__dirname, 'sessions'), 'kimi-stop')
  const file = path.join(dir, `${pane}-${session}.json`)
  try {
    if (reset) fs.rmSync(file, { force: true })
    else {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(file, JSON.stringify({ at: Date.now() }), { flag: 'wx' })
    }
    return true
  } catch { return false }
}

function kimiHook(data) {
  const event = data.hook_event_name
  // Observation-only events, including PostToolUse, must NEVER claim messages.
  if (event !== 'UserPromptSubmit' && event !== 'Stop') return
  if (event === 'Stop' && data.stop_hook_active) return
  if (event === 'UserPromptSubmit') kimiStopGuard(data, true)
  const ctx = locate(null, data.cwd)
  if (ctx.error) return
  if (event === 'Stop') {
    if (!unread(ctx).some((m) => !isReceipt(m))) return
    if (data.stop_hook_active !== false && !kimiStopGuard(data)) return
  }
  const text = readInbox(ctx)
  const notes = []
  if (text) notes.push(`New messages from your Tessel team (answer with team_send, not through the user):\n${text}`)
  if (event === 'UserPromptSubmit') notes.push(boardReminder(ctx))
  if (!notes.length) return
  const note = notes.join('\n\n')
  if (event === 'Stop') {
    // Kimi's runner uses stderr as the continuation reason for exit code 2.
    process.stderr.write(note)
    process.exitCode = 2
    return true
  }
  process.stdout.write(note)
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
    // Copilot CLI (hooks in Claude Code's names, --event=<name> in its command
    // since its payload may not name the event): camelCase fields accepted too.
    const copilot = process.argv.includes('--copilot')
    // An agent whose hooks only report its status (agentStatusHooks.js,
    // --agent=<id>), or a status event from Tessel's own plugins (--status).
    const agentArg = process.argv.find((a) => a.startsWith('--agent='))
    const statusAgent = agentArg ? agentArg.slice(8) : ''
    const named = process.argv.find((a) => a.startsWith('--event='))
    if (statusAgent) {
      // The neutral answer its CLI waits for, in or out of Tessel.
      const answer = STATUS_ANSWERS[statusAgent] && STATUS_ANSWERS[statusAgent][named ? named.slice(8) : data.hook_event_name]
      if (answer) process.stdout.write(answer)
      if (!STATUS_AGENTS.includes(statusAgent)) return
    }
    if (copilot || statusAgent) {
      data = {
        ...data,
        session_id: data.session_id || data.sessionId || data.conversation_id || data.conversationId || '',
        hook_event_name: statusAgent ? (named ? named.slice(8) : data.hook_event_name || data.hookEventName || '') : data.hook_event_name || (named ? named.slice(8) : '')
      }
    }
    // Which conversation the agent is in: recorded first, team or not.
    const codex = process.argv.includes('--codex')
    const gemini = process.argv.includes('--gemini')
    // OpenCode's plugin (teamInstall.js) sends Claude Code's event names and
    // reads Claude's answers: only its conversation is reported as OpenCode's.
    const opencode = process.argv.includes('--opencode')
    const kimi = process.argv.includes('--kimi')
    const provider = statusAgent || (codex ? 'codex' : gemini ? 'gemini' : copilot ? 'copilot' : opencode ? 'opencode' : kimi ? 'kimi' : 'claude')
    const statusOnly = !!statusAgent || process.argv.includes('--status')
    let continuing = false
    try {
    // Children may report their own state, but never change the root session
    // or consume its messages (the finally below is observation-only).
    if (data.agent_id) return
    reportSession(data, provider)
    // Status only: never a team message (they come as a typed reminder).
    if (statusOnly) return
    // A chat agent (src/main/chat): Tessel gives it its team messages as turns
    // of their own and marks them read when the agent takes them. Its hooks
    // must not claim them too (they would reach it twice, or never be
    // acknowledged).
    if (process.env.TESSEL_CHAT === '1') return
    if (kimi) {
      continuing = kimiHook(data) === true
      return
    }
    if (codex) {
      // Codex Stop decisions become continuation prompts. Other events keep
      // reporting the session only; an already continued turn never loops.
      if (data.hook_event_name !== 'Stop' || data.stop_hook_active) return
      const ctx = locate(null, data.cwd)
      if (ctx.error) return
      const prefix = '[Tessel] New team messages:\n'
      const suffix = '\nReply with team_send. Read team_inbox for any remaining messages.'
      const format = (m) => `[${label(ctx, m.fromId)} → you, message ${m.id}${m.replyTo ? `, reply to ${m.replyTo}` : ''}] ${m.text}`
      const selected = []
      let remaining = 16000 - prefix.length - suffix.length
      let oversized = false
      for (const m of unread(ctx)) {
        const size = isReceipt(m) ? 0 : format(m).length + 1
        // Never acknowledge a message and then truncate away its contents:
        // whole messages that do not fit stay unread for team_inbox.
        if (size > remaining) {
          oversized = selected.every(isReceipt)
          break
        }
        remaining -= size
        selected.push(m)
      }
      // The same exclusive claim as team_inbox: a concurrent reader cannot
      // also receive the messages this hook includes in its continuation.
      const shown = markRead(ctx, selected).filter((m) => !isReceipt(m))
      if (shown.length) {
        continuing = true
        process.stdout.write(JSON.stringify({ decision: 'block', reason: prefix + shown.map(format).join('\n') + suffix }))
      } else if (oversized) {
        // Older/foreign channel data may contain one oversized message.
        // Leave it unread and ask for the full inbox instead of losing text.
        continuing = true
        process.stdout.write(JSON.stringify({ decision: 'block', reason: '[Tessel] A new team message is too long for this notification. Read it with team_inbox and reply with team_send.' }))
      }
      return
    }
    // Gemini CLI takes Claude Code's answers under its own event names: a
    // prompt (BeforeAgent), after a tool (AfterTool), the turn's end
    // (AfterAgent, where a "block" continues with the reason as a prompt).
    const GEMINI_EVENTS = { BeforeAgent: 'UserPromptSubmit', AfterTool: 'PostToolUse', AfterAgent: 'Stop' }
    const event = gemini ? GEMINI_EVENTS[data.hook_event_name] || data.hook_event_name : data.hook_event_name
    if (event === 'SessionStart') return // only the report above
    // Status/permission/failure events cannot carry our delivery format.
    // Never acknowledge inbox messages on an observation-only event.
    if (!['UserPromptSubmit', 'PostToolUse', 'Stop', 'Peek'].includes(event)) return
    // Copilot's prompt hook cannot add text: messages read there would be lost.
    if (copilot && event === 'UserPromptSubmit') return
    const ctx = locate(null, data.cwd)
    if (ctx.error) return
    // How many messages wait, read nothing (OpenCode's plugin, when idle,
    // then asks the agent to read them with team_inbox): { unread: n }.
    if (event === 'Peek') {
      process.stdout.write(JSON.stringify({ unread: unread(ctx).filter((m) => !isReceipt(m)).length }))
      return
    }
    if (event === 'Stop' && data.stop_hook_active) return
    const text = readInbox(ctx)
    const notes = []
    if (text) notes.push(`New messages from your Tessel team (answer with the team_send tool, not through the user):\n${text}`)
    // Each message from the user: the board rule, with the cards this agent
    // has open, so it is never forgotten (a long session, a compacted one).
    if (event === 'UserPromptSubmit') notes.push(boardReminder(ctx))
    if (!notes.length) return
    const note = notes.join('\n\n')
    if (event === 'Stop') {
      continuing = true
      process.stdout.write(JSON.stringify({ decision: 'block', reason: note }))
    }
    // Copilot reads additionalContext at the top level (its own format).
    else if (copilot) process.stdout.write(JSON.stringify({ additionalContext: note, hookSpecificOutput: { hookEventName: data.hook_event_name, additionalContext: note } }))
    else process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: data.hook_event_name, additionalContext: note } }))
    } finally {
      reportAgentState(data, provider, continuing)
    }
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

module.exports = { taskRequest, locate, readInbox, send, members, handle, candidateDirs, ackPath, markRead, unread, listTasks, addTask, moveTask, reportTask, gateTask, ask, groupTargets, listWorkers, listGates, TOOLS, VERSION, AGENT_STATUS_AGENTS, statusEvent }
