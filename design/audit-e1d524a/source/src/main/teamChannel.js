// Persistent, two-way team messages. Each agent writes a JSON file into its
// private outbox; the renderer polls for deliveries and acknowledges them only
// after the terminal has received the message. Pending and held messages remain
// on disk across app restarts; a held draft is never replayed automatically.
import fs from 'fs'
import { join, resolve, isAbsolute } from 'path'
import { randomBytes, createHash } from 'crypto'

const ID_RE = /^(?!\.)(?!.*\.\.)[A-Za-z0-9._-]{1,100}$/
const MAX_FILE = 64 * 1024
const MAX_TEXT = 6000
const MAX_PER_SENDER = 20
const MAX_DELIVERIES = 200
const MAX_DELIVERED_HISTORY = 2000
const MAX_SEEN_FILES = 10000

function location({ dir, teamId } = {}) {
  if (typeof dir !== 'string' || !isAbsolute(dir) || !fs.existsSync(dir)) return null
  if (typeof teamId !== 'string' || !ID_RE.test(teamId)) return null
  return join(resolve(dir), '.tessel', 'team-channel', teamId)
}

function readState(root) {
  const file = join(root, 'state.json')
  if (!fs.existsSync(file)) return { version: 1, members: {}, messages: [], seen: {} }
  const state = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (state.version !== 1 || !state.members || !Array.isArray(state.messages) || !state.seen)
    throw new Error('The team channel state is invalid.')
  return state
}

function saveState(root, state) {
  // Keep the log responsive after months of use without dropping anything
  // that has not reached its recipient yet.
  const deliveredCount = state.messages.reduce((n, m) => n + (m.status === 'delivered' ? 1 : 0), 0)
  if (deliveredCount > MAX_DELIVERED_HISTORY) {
    let drop = deliveredCount - MAX_DELIVERED_HISTORY
    state.messages = state.messages.filter((m) => {
      if (m.status === 'delivered' && drop > 0) {
        drop--
        return false
      }
      return true
    })
  }
  const seenKeys = Object.keys(state.seen)
  for (const key of seenKeys.slice(0, Math.max(0, seenKeys.length - MAX_SEEN_FILES)))
    delete state.seen[key]
  fs.mkdirSync(root, { recursive: true })
  const temp = join(root, `state.${process.pid}.tmp`)
  fs.writeFileSync(temp, JSON.stringify(state, null, 2), 'utf8')
  fs.renameSync(temp, join(root, 'state.json'))
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
  const others = members.filter((m) => m.id !== selfId).map((m) => `#${m.num} ${m.title}`)
  return [
    `Your team channel outbox: ${outbox}`,
    `Teammates: ${others.length ? others.join(', ') : 'none yet'}.`,
    'To message someone, write one JSON file with a unique name ending in .json into this outbox.',
    'Example: {"to":"#2","text":"Can you review the API?"}. Use "to":"team" to reach every teammate.',
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
        num: m.num,
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
      return { id: m.id, num: m.num, title: m.title, outbox, guide: instructions }
    })
    return { ok: true, outboxes }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

function resolveRecipients(state, fromId, to) {
  const members = activeMembers(state)
  if (to === 'team') return members.filter((m) => m.id !== fromId).map((m) => m.id)
  const n = /^#(\d{1,3})$/.exec(to)
  const member = n ? members.find((m) => m.num === Number(n[1])) : members.find((m) => m.id === to)
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

function ingest(root, state) {
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
          if (!recipients.length) error = 'recipient is not an active teammate'
          else {
            const replyTo = typeof data.reply_to === 'string' ? data.reply_to.slice(0, 80) : null
            for (const toId of recipients)
              state.messages.push({
                id: `${id}-${toId}`,
                fromId: sender.id,
                toId,
                text,
                replyTo,
                status: 'pending',
                createdAt: Date.now(),
                deliveredAt: null
              })
          }
        }
      }
      if (error) appendError(state, id, sender.id, error)
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

// Hold before typing, then acknowledge only after confirmed acceptance. Held
// messages are returned separately, including for unavailable active members.
// On restart the renderer treats either held status as uncertain; a later
// message to that pane also waits until the draft is explicitly resolved.
export function pollTeamChannel({ dir, teamId, availableIds } = {}) {
  try {
    const root = location({ dir, teamId })
    if (!root || !fs.existsSync(join(root, 'state.json')))
      return { ok: false, error: 'Team channel is not set up.' }
    const state = readState(root)
    ingest(root, state)
    const available = Array.isArray(availableIds) ? new Set(availableIds) : null
    const held = state.messages.filter((m) => isHeld(m) && state.members[m.toId]?.active)
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
      num: m.num,
      title: m.title,
      active: !!m.active
    }))
    return { ok: true, participants, deliveries, held, history: state.messages.slice(-200) }
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
          text: `Delivered to #${recipient?.num || '?'} ${recipient?.title || 'teammate'}.`,
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
