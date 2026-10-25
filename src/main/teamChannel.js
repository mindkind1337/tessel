// Persistent, two-way team messages. Each agent writes a JSON file into its
// private outbox; the renderer polls for deliveries and acknowledges them only
// after the terminal has received the message. Pending and held messages remain
// on disk across app restarts; a held draft is never replayed automatically.
import fs from 'fs'
import { resolveAgentAddress } from '../shared/agentNames'
import { join, resolve, isAbsolute } from 'path'
import { randomBytes, createHash } from 'crypto'
import { writeJsonSafe, readJsonSafe } from './safeJson'
import { cleanSender } from '../shared/senderIdentity'

const ID_RE = /^(?!\.)(?!.*\.\.)[A-Za-z0-9._-]{1,100}$/
const MAX_FILE = 64 * 1024
const MAX_TEXT = 6000
const MAX_PER_SENDER = 20
const MAX_DELIVERIES = 200
// Delivered messages kept in state.json (it is read, parsed and written whole
// at every message). Past MAX + the slack, the oldest go to archive.jsonl, so
// the trim happens once per slack messages, not at each one.
const MAX_DELIVERED_HISTORY = 500
const DELIVERED_TRIM_SLACK = 100
// While the archive cannot be written the delivered messages stay in
// state.json, up to this many (the limit before the archive existed).
const MAX_DELIVERED_UNARCHIVED = 2000
// archive.jsonl is moved to archive.old.jsonl (the one before it is dropped)
// past this size.
const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024
const MAX_SEEN_FILES = 10000
// A message nobody can receive any more (its recipient left the team, or the
// team was ungrouped) is dropped after this long.
const UNDELIVERABLE_KEPT_MS = 7 * 24 * 60 * 60 * 1000

function location({ dir, teamId } = {}) {
  if (typeof dir !== 'string' || !isAbsolute(dir) || !fs.existsSync(dir)) return null
  if (typeof teamId !== 'string' || !ID_RE.test(teamId)) return null
  return join(resolve(dir), '.tessel', 'team-channel', teamId)
}

function validState(state) {
  return !!state && state.version === 1 && !!state.members && Array.isArray(state.messages) && !!state.seen
}

// The channel's state, saved crash-safe with its previous copy (.bak): a
// damaged state.json is restored from that copy (the damaged one kept aside)
// instead of stopping the whole channel.
// The parsed state.json of the last poll of each team, valid while the file
// has the size and time it had (a save also forgets it): a poll that finds
// nothing new answers from it without reading and parsing the file again.
// Only polls use it, and they only read it; everything that changes the
// state reads the file itself (a private copy) and saves it.
// At most MAX_POLLED teams (the least recently read goes first): the parse of
// a team that was closed does not stay in memory.
const MAX_POLLED = 16
const RACY_MS = 2000
const polled = new Map() // state.json path -> { size, mtimeMs, ino, state }
function readPolledState(root) {
  const file = join(root, 'state.json')
  let st
  try {
    st = fs.statSync(file)
  } catch {
    polled.delete(file)
    return readState(root)
  }
  const hit = polled.get(file)
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs && hit.ino === st.ino) {
    polled.delete(file)
    polled.set(file, hit) // most recently read
    return hit.state
  }
  const state = readState(root)
  // The file can be restored from its copy by readState: its stamp is read after.
  // A file written a moment ago is not kept: another Tessel (the installed one
  // and a development one share a project's channel) could write it again
  // within the same tick of a coarse clock (a network drive, FAT) with the
  // same size, and the stamp would not tell. Polls of a quiet channel use it.
  polled.delete(file)
  try {
    const after = fs.statSync(file)
    if (Date.now() - after.mtimeMs >= RACY_MS) {
      if (polled.size >= MAX_POLLED) polled.delete(polled.keys().next().value)
      polled.set(file, { size: after.size, mtimeMs: after.mtimeMs, ino: after.ino, state })
    }
  } catch {
    /* not kept */
  }
  return state
}

// Does any member's outbox hold a file to take in? (what ingest would do)
function outboxHasFiles(root, state) {
  for (const m of activeMembers(state)) {
    try {
      const names = fs.readdirSync(join(root, 'outbox', m.token))
      if (names.some((n) => n.toLowerCase().endsWith('.json'))) return true
    } catch {
      /* no outbox yet */
    }
  }
  return false
}

function readState(root) {
  const file = join(root, 'state.json')
  if (!fs.existsSync(file) && !fs.existsSync(`${file}.bak`)) return { version: 1, members: {}, messages: [], seen: {} }
  const res = readJsonSafe(file, validState)
  if (!res.data) throw new Error('The team channel state is invalid.')
  if (res.from === 'backup') writeJsonSafe(file, res.data, validState)
  return res.data
}

// Delivered messages that leave state.json are kept, one JSON line each, in
// <team>/archive.jsonl (append only), so the log of a long-lived team is not
// lost: readTeamArchive reads it. Undelivered messages are never moved.
function archiveMessages(root, messages) {
  if (!messages.length) return
  const file = join(root, 'archive.jsonl')
  try {
    if (fs.statSync(file).size > MAX_ARCHIVE_BYTES) fs.renameSync(file, join(root, 'archive.old.jsonl'))
  } catch {
    /* no archive yet */
  }
  // A leading newline: a line cut by a kill never joins the next one.
  fs.appendFileSync(file, '\n' + messages.map((m) => JSON.stringify(m)).join('\n') + '\n', 'utf8')
}

// The state.json as an older version left it (up to 2000 delivered messages),
// kept once before the first trim moves messages out of it.
function keepBeforeArchive(root) {
  const file = join(root, 'state.json')
  const copy = `${file}.before-archive`
  try {
    if (!fs.existsSync(copy) && fs.existsSync(file)) fs.copyFileSync(file, copy)
  } catch {
    /* the .bak still holds the previous copy */
  }
}

function saveState(root, state) {
  // Keep the log responsive after months of use without dropping anything
  // that has not reached its recipient yet.
  const deliveredCount = state.messages.reduce((n, m) => n + (m.status === 'delivered' ? 1 : 0), 0)
  let archived = []
  let untrimmed = null
  if (deliveredCount > MAX_DELIVERED_HISTORY + DELIVERED_TRIM_SLACK) {
    let drop = deliveredCount - MAX_DELIVERED_HISTORY
    untrimmed = state.messages
    state.messages = state.messages.filter((m) => {
      if (m.status === 'delivered' && drop > 0) {
        drop--
        archived.push(m)
        return false
      }
      return true
    })
  }
  const now = Date.now()
  const keepMessage = (m) =>
    m.status === 'delivered' ||
    (state.members[m.toId] && state.members[m.toId].active) ||
    now - (m.createdAt || 0) < UNDELIVERABLE_KEPT_MS
  state.messages = state.messages.filter(keepMessage)
  const seenKeys = Object.keys(state.seen)
  for (const key of seenKeys.slice(0, Math.max(0, seenKeys.length - MAX_SEEN_FILES)))
    delete state.seen[key]
  fs.mkdirSync(root, { recursive: true })
  const file = join(root, 'state.json')
  polled.delete(file)
  // The archive first: a kill between the two leaves a message in both
  // (read once, see readTeamArchive), never in neither. An archive that
  // cannot be written (disk full, a file another program holds) must not stop
  // the channel: the messages stay in state.json, untrimmed, and moving them
  // is tried again at the next save.
  if (archived.length) {
    try {
      keepBeforeArchive(root)
      archiveMessages(root, archived)
    } catch {
      // Bounded all the same: as before this version, the oldest delivered
      // ones go past MAX_DELIVERED_UNARCHIVED.
      let over = deliveredCount - MAX_DELIVERED_UNARCHIVED
      state.messages = untrimmed.filter((m) => {
        if (m.status === 'delivered' && over > 0) {
          over--
          return false
        }
        return keepMessage(m)
      })
    }
  }
  writeJsonSafe(file, state, validState, { indent: 0 })
}

// A message can be in the archive and still in state.json (a kill between the
// two writes). Whoever shows the archive with the channel's own messages joins
// them here: the archive's messages that state.json does not hold, then
// state.json's, each id once.
export function joinWithArchive(archiveMessages, stateMessages) {
  const inState = new Set((stateMessages || []).map((m) => m && m.id))
  return [...(archiveMessages || []).filter((m) => m && !inState.has(m.id)), ...(stateMessages || [])]
}

// Messages moved out of state.json, oldest first: the last `limit` (default
// 500, at most 5000), those before the message `before` when given.
export async function readTeamArchive({ dir, teamId, limit = 500, before = null } = {}) {
  try {
    const root = location({ dir, teamId })
    if (!root) return { ok: false, error: 'Invalid team channel location.' }
    const out = []
    const seen = new Set()
    for (const name of ['archive.old.jsonl', 'archive.jsonl']) {
      let text = ''
      try {
        text = await fs.promises.readFile(join(root, name), 'utf8')
      } catch {
        continue
      }
      let lineNo = 0
      for (const line of text.split('\n')) {
        if (!line.trim()) continue
        // Not holding the main process for a big archive: a breath every 2000 lines.
        if (++lineNo % 2000 === 0) await new Promise((r) => setImmediate(r))
        try {
          const m = JSON.parse(line)
          if (!m || typeof m.id !== 'string' || seen.has(m.id)) continue
          seen.add(m.id)
          out.push(readBack(m))
        } catch {
          /* a line cut by a kill */
        }
      }
    }
    const end = typeof before === 'string' ? out.findIndex((m) => m.id === before) : -1
    const upTo = end >= 0 ? out.slice(0, end) : out
    const n = Math.max(1, Math.min(5000, Number(limit) || 500))
    return { ok: true, messages: upTo.slice(-n), total: out.length }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

function activeMembers(state) {
  return Object.entries(state.members)
    .filter(([, m]) => m.active)
    .map(([id, m]) => ({ id, ...m }))
}

function isHeld(message) {
  return message.status === 'inflight' || message.status === 'uncertain'
}

function guide(outbox, members, selfId) {
  const others = members.filter((m) => m.id !== selfId).map((m) => `${m.paneName || m.title} (${m.title})`)
  return [
    `Your team channel outbox: ${outbox}`,
    `Teammates: ${others.length ? others.join(', ') : 'none yet'}.`,
    'To message someone, write one JSON file with a unique name ending in .json into this outbox.',
    'Example: {"to":"Ada","text":"Can you review the API?"}. Use "to":"team" to reach every teammate.',
    'Use a JSON serializer (JSON.stringify or ConvertTo-Json), especially when text includes Windows paths, quotes or newlines.',
    'To reply, write another file and add "reply_to":"<message id>" when you have an id.',
    'Tessel queues messages while an agent is busy, awaiting approval or offline. It gives you delivery status in your terminal.',
    'Write each file completely, preferably under a temporary name, then rename it to .json.'
  ].join('\n')
}

// Sync the team's current membership and return each member's private outbox.
// Member shape: { id: paneId, num: visible agent number, title }.
export function ensureTeamChannel({ dir, teamId, members } = {}) {
  try {
    const root = location({ dir, teamId })
    if (!root) return { ok: false, error: 'Invalid team channel location.' }
    if (!Array.isArray(members) || members.length > 40)
      return { ok: false, error: 'Invalid team members.' }
    const cleaned = members.map((m) => ({
      id: m && typeof m.id === 'string' ? m.id : '',
      num: Number(m && m.num),
      paneName: String((m && m.paneName) || '').trim().slice(0, 60),
      title: String((m && m.title) || 'Agent').slice(0, 100)
    }))
    if (
      cleaned.some(
        (m) => !ID_RE.test(m.id) || !Number.isInteger(m.num) || m.num < 1 || m.num > 999
      ) ||
      new Set(cleaned.map((m) => m.id)).size !== cleaned.length ||
      new Set(cleaned.map((m) => m.num)).size !== cleaned.length
    )
      return { ok: false, error: 'Invalid or duplicate team member.' }
    const state = readState(root)
    for (const m of Object.values(state.members)) m.active = false
    for (const m of cleaned) {
      const old = state.members[m.id]
      state.members[m.id] = {
        num: m.num, paneName: m.paneName,
        title: m.title,
        token: old?.token || randomBytes(16).toString('hex'),
        active: true
      }
    }
    saveState(root, state)
    const list = activeMembers(state)
    const outboxes = list.map((m) => {
      const outbox = join(root, 'outbox', m.token)
      fs.mkdirSync(outbox, { recursive: true })
      const instructions = guide(outbox, list, m.id)
      fs.writeFileSync(join(outbox, 'HOW-TO.md'), instructions, 'utf8')
      return { id: m.id, num: m.num, paneName: m.paneName, title: m.title, outbox, guide: instructions }
    })
    return { ok: true, outboxes }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

function resolveRecipients(state, fromId, to) {
  const members = activeMembers(state)
  if (to.toLowerCase() === 'team') return members.filter((m) => m.id !== fromId).map((m) => m.id)
  const n = /^#(\d{1,3})$/.exec(to)
  const member = n ? members.find((m) => m.num === Number(n[1])) : (resolveAgentAddress(members, to) || members.find((m) => m.id === to))
  return member && member.id !== fromId ? [member.id] : []
}

function sourceId(fromId, filename, stat) {
  // A filename can be reused for a later message. The file identity stays
  // unchanged across a restart if ingestion succeeded but deletion did not.
  return createHash('sha256')
    .update(`${fromId}\0${filename}\0${stat.mtimeMs}\0${stat.ino}\0${stat.size}`)
    .digest('hex')
    .slice(0, 24)
}

function appendError(state, id, toId, error) {
  state.messages.push({
    id: `${id}-error`,
    fromId: 'tessel',
    toId,
    text: `Team message was not sent: ${error}`,
    replyTo: null,
    status: 'pending',
    createdAt: Date.now(),
    deliveredAt: null
  })
}

// Who sent it, from Tessel's side only: the outbox it came from names the
// pane, the window's view of that pane (senders[paneId]: model, session,
// host, copy, card...) completes it. Anything in the message itself is
// ignored, so an agent cannot pass for another.
function senderOf(sender, senders, tesselVersion) {
  const seen = senders && typeof senders === 'object' && !Array.isArray(senders) ? senders[sender.id] : null
  return cleanSender({
    name: sender.paneName || sender.title,
    agentName: sender.title,
    num: sender.num,
    ...(seen && typeof seen === 'object' ? seen : {}),
    paneId: sender.id,
    tesselVersion: typeof tesselVersion === 'string' ? tesselVersion : '',
    at: Date.now()
  })
}

const askId = (data) => (data && typeof data.ask === 'string' && /^q-[a-z0-9-]{4,40}$/.test(data.ask) ? data.ask : null)

function ingest(root, state, { senders = null, tesselVersion = '' } = {}) {
  let changed = false
  for (const sender of activeMembers(state)) {
    const outbox = join(root, 'outbox', sender.token)
    if (!fs.existsSync(outbox)) continue
    const files = fs
      .readdirSync(outbox, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.toLowerCase().endsWith('.json'))
      .map((d) => ({ name: d.name, path: join(outbox, d.name) }))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, MAX_PER_SENDER)
    for (const file of files) {
      let stat
      try {
        stat = fs.statSync(file.path)
      } catch {
        continue
      }
      const id = sourceId(sender.id, file.name, stat)
      if (state.seen[id]) {
        try {
          fs.rmSync(file.path)
        } catch {
          /* retry next poll */
        }
        continue
      }
      let data
      let error = ''
      try {
        if (stat.size === 0 && Date.now() - stat.mtimeMs < 5000) continue
        if (stat.size > MAX_FILE) error = 'the file is too large'
        else data = JSON.parse(fs.readFileSync(file.path, 'utf8').replace(/^\uFEFF/, ''))
      } catch (err) {
        // Failure to open/read a file is not evidence of malformed JSON.
        // Keep it queued, even when it is old, until storage is accessible.
        if (!(err instanceof SyntaxError)) continue
        let age = Infinity
        try {
          age = Date.now() - fs.statSync(file.path).mtimeMs
        } catch {
          continue // removed by its writer during this poll
        }
        if (age < 5000) continue
        error = `invalid JSON (${err.message})`
      }
      if (!error) {
        const to = data && typeof data.to === 'string' ? data.to.trim() : ''
        const text = data && typeof data.text === 'string' ? data.text.trim() : ''
        if (!text || text.length > MAX_TEXT) error = `text must be 1–${MAX_TEXT} characters`
        else {
          const recipients = resolveRecipients(state, sender.id, to)
          if (!recipients.length) error = 'recipient is not an active teammate or is ambiguous. Valid names: ' + activeMembers(state).map((m) => m.paneName || m.title).join(', ')
          else {
            const replyTo = typeof data.reply_to === 'string' ? data.reply_to.slice(0, 80) : null
            const from = senderOf(sender, senders, tesselVersion)
            for (const toId of recipients)
              state.messages.push({
                id: `${id}-${toId}`,
                fromId: sender.id,
                toId,
                text,
                replyTo,
                // A question its sender waits on (team_ask): the answer is
                // the reply to this message.
                ...(askId(data) ? { askId: askId(data) } : {}),
                ...(from ? { sender: from } : {}),
                status: 'pending',
                createdAt: Date.now(),
                deliveredAt: null
              })
          }
        }
      }
      if (error) {
        appendError(state, id, sender.id, error)
        // The waiting team_ask learns its question was not sent.
        if (askId(data)) state.messages[state.messages.length - 1].askId = askId(data)
      }
      state.seen[id] = true
      saveState(root, state)
      changed = true
      try {
        fs.rmSync(file.path)
      } catch {
        /* seen id prevents duplicate ingestion */
      }
    }
  }
  return changed
}

// A message as the window gets it: its sender record cleaned again, since it
// is read back from state.json, a file in the project another program could
// have written (only the known fields, each checked; none when it names nobody).
function readBack(m) {
  if (!m || !('sender' in m)) return m
  const { sender, ...rest } = m
  const clean = cleanSender(sender)
  return clean ? { ...rest, sender: clean } : rest
}

// Hold before typing, then acknowledge only after confirmed acceptance. Held
// messages are returned separately, including for unavailable active members.
// On restart the renderer treats either held status as uncertain; a later
// message to that pane also waits until the draft is explicitly resolved.
// senders: { paneId: snapshot } the window's view of each member's pane
// (src/renderer/src/senderIdentity.js), recorded with the messages it sends.
export function pollTeamChannel({ dir, teamId, availableIds, senders, tesselVersion } = {}) {
  try {
    const root = location({ dir, teamId })
    if (!root || !fs.existsSync(join(root, 'state.json')))
      return { ok: false, error: 'Team channel is not set up.' }
    // From the cached parse when nothing waits in an outbox (it is only read
    // below); a file to take in changes the state: a private copy for that.
    let state = readPolledState(root)
    if (outboxHasFiles(root, state)) {
      state = readState(root)
      ingest(root, state, { senders, tesselVersion })
    }
    const available = Array.isArray(availableIds) ? new Set(availableIds) : null
    const held = state.messages.filter((m) => isHeld(m) && state.members[m.toId]?.active)
    // Background inbox readers are not limited by the terminal delivery batch.
    // Count all unread messages, including holds and unavailable recipients,
    // so a busy member's backlog cannot hide another member's wake-up.
    const unreadCounts = Object.create(null)
    for (const m of state.messages) {
      if (!state.members[m.toId]?.active || (m.status !== 'pending' && !isHeld(m))) continue
      if (m.fromId === 'tessel' && /^Delivered to /.test(m.text)) continue
      unreadCounts[m.toId] = (unreadCounts[m.toId] || 0) + 1
    }
    const blocked = new Set(held.map((m) => m.toId))
    const deliveries = state.messages
      .filter(
        (m) =>
          m.status === 'pending' &&
          state.members[m.toId]?.active &&
          !blocked.has(m.toId) &&
          (!available || available.has(m.toId))
      )
      .slice(0, MAX_DELIVERIES)
    const participants = Object.entries(state.members).map(([id, m]) => ({
      id,
      num: m.num, paneName: m.paneName,
      title: m.title,
      active: !!m.active
    }))
    return {
      ok: true,
      participants,
      deliveries: deliveries.map(readBack),
      held: held.map(readBack),
      unreadCounts,
      history: state.messages.slice(-200).map(readBack)
    }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

// Persist before paste, and keep the original hold time when marking a delivery
// uncertain. Repeating the same hold is idempotent; it does not authorize a
// second paste. A recipient can have only one held draft in this team.
export function holdTeamDelivery({ dir, teamId, id, toId, state: status } = {}) {
  try {
    if (status !== 'inflight' && status !== 'uncertain')
      return { ok: false, error: 'Invalid delivery hold state.' }
    const root = location({ dir, teamId })
    if (!root) return { ok: false, error: 'Invalid team channel location.' }
    const state = readState(root)
    const message = state.messages.find((m) => m.id === id && m.toId === toId)
    if (!message) return { ok: false, error: 'Unknown delivery.' }
    if (message.status === 'delivered')
      return { ok: false, error: 'Delivery is already confirmed.' }
    if (!state.members[toId]?.active)
      return { ok: false, error: 'Recipient is not an active teammate.' }
    if (state.messages.some((m) => m.id !== id && m.toId === toId && isHeld(m)))
      return { ok: false, error: 'Recipient already has an unresolved delivery.' }
    if (message.status === 'uncertain' && status === 'inflight')
      return { ok: false, error: 'Release the uncertain delivery before retrying.' }
    if (message.status === status) return { ok: true }
    if (!isHeld(message)) message.heldAt = Date.now()
    message.status = status
    saveState(root, state)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

// Retry only after a definite pre-paste failure, or after the user has cleared
// the old draft and explicitly requested another attempt. Never reopen a
// confirmed message, including when a late failure races its acknowledgement.
export function releaseTeamDelivery({ dir, teamId, id, toId } = {}) {
  try {
    const root = location({ dir, teamId })
    if (!root) return { ok: false, error: 'Invalid team channel location.' }
    const state = readState(root)
    const message = state.messages.find((m) => m.id === id && m.toId === toId)
    if (!message) return { ok: false, error: 'Unknown delivery.' }
    if (message.status === 'delivered')
      return { ok: false, error: 'Delivery is already confirmed.' }
    if (message.status === 'pending') return { ok: true }
    if (!isHeld(message)) return { ok: false, error: 'Delivery is not held.' }
    message.status = 'pending'
    delete message.heldAt
    saveState(root, state)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

export function ackTeamDelivery({ dir, teamId, id, toId } = {}) {
  try {
    const root = location({ dir, teamId })
    if (!root) return { ok: false, error: 'Invalid team channel location.' }
    const state = readState(root)
    const message = state.messages.find((m) => m.id === id && m.toId === toId)
    if (!message) return { ok: false, error: 'Unknown delivery.' }
    if (message.status !== 'delivered') {
      message.status = 'delivered'
      message.deliveredAt = Date.now()
      // An agent can see that its teammate received the message without
      // asking the user to relay a status update. Receipts are messages too,
      // so they wait durably if the sender is busy or offline.
      if (
        message.fromId !== 'tessel' &&
        message.fromId !== 'you' &&
        state.members[message.fromId]?.active
      ) {
        const recipient = state.members[toId]
        state.messages.push({
          id: `${message.id}-receipt`,
          fromId: 'tessel',
          toId: message.fromId,
          text: `Delivered to ${recipient?.paneName || recipient?.title || 'teammate'}.`,
          replyTo: message.id,
          status: 'pending',
          createdAt: Date.now(),
          deliveredAt: null
        })
      }
      saveState(root, state)
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}
