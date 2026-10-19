<script setup>
// Conversations (a tab of the right side panel, after Agents): what the
// agents of a team said to each other through the team channel, and what
// you and an agent said to each other through Tessel (its native chat, the
// notes, a review, a decision on a card, its reports), as threads built from
// the activity log (src/shared/conversations.js); and what you and each
// terminal agent said in its terminal (your prompts, its answers), read from
// its own conversation file by the main process
// (src/main/chat/terminalConversations.js), merged in time into your thread
// with it, a small terminal mark on each. One thread per team and one per
// agent you talked with, latest first; a thread's lines read like a chat
// (newest at the top), as chat rows (who,
// to whom, when, the text, its delivery status, the model it was said with
// at its bottom right). A scope switch (this workspace / all), a period, an
// agent filter, a search box, and a switch to show Tessel's own notices. A
// thread can be copied as text, and an agent's name goes to its pane while
// it is open.
// A message reads as the chat shows it (RichMessage.vue: its Markdown, its
// links, its paths read against the folder of the pane that wrote it, the
// images a terminal line holds as thumbnails). Type chips (Links, Images,
// Videos, Files, Folders, Code: messageMedia.js, each with its count of
// messages) keep only the messages that share one of them, together with the
// search, the agent and the period; the Media view lists everything the
// conversations shown share, and goes back to a message.
// In a Live Share project (source): the host's activity of that project and
// what its terminal agents said, from the host (masked there), followed
// while the tab is shown; "You" is the host there. No image comes from the
// host, no path is a link there, a web link goes through the host's filter.
import { senderDetails, senderRemote } from '../senderIdentity'
import { computed, nextTick, onBeforeUnmount, reactive, ref, shallowRef, watch } from 'vue'
import { Check, ChevronRight, Code2, Copy, FileText, Film, Folder, ImageIcon, LayoutGrid, Link2, LocateFixed, MessagesSquare, Search, SquareTerminal, Users, X } from 'lucide-vue-next'
import BrandIcon from './BrandIcon.vue'
import RichMessage from './RichMessage.vue'
import ConversationMedia from './ConversationMedia.vue'
import ThemedSelect from './ui/ThemedSelect.vue'
import { buildThreads, filterThreads, lineCount, modelOf, participantsOf, recipients, replyText, statusText, threadText } from '../../../shared/conversations'
import { MEDIA_TYPES, filterByTypes, mediaItems, typeCounts } from '../links/messageMedia'
import { useMessageLinks } from '../links/useMessageLinks'
import { nativeChatSessionChoiceLabel } from '../chat/orca/native-chat-session-option-labels'
import { confirmSession, notePanes, paneSessionTrail, sessionIds } from '../paneSessionTrail'
import { formatWhen } from '../timeFormat'
import { agentLabel } from '../sessionHistory'
import { t, intlLocale } from '../i18n'
import './sessionHistory.css'

const props = defineProps({
  // The activity log (activityStore.js's reactive array).
  events: { type: Array, default: () => [] },
  // App's teams: [{ id, name, color }], for the team threads' names.
  teams: { type: Array, default: () => [] },
  // App's sidebarProjects: which agent panes exist now, and their names.
  projects: { type: Array, default: () => [] },
  // The workspace shown (its conversations by default; All for every one).
  workspaceId: { type: String, default: null },
  now: { type: Number, default: () => Date.now() },
  // Shown now: the threads are built only then (the log changes often).
  active: { type: Boolean, default: true },
  // A Live Share host's project: { project, host, events, teams, follow(on),
  // terminal({ from, known }) } (liveShareWindowFeeds.js activitySource).
  source: { type: Object, default: null }
})
const emit = defineEmits(['focus-pane', 'toast'])

// --- Filters ----------------------------------------------------------------------------
const scope = ref('workspace')
const period = ref('7d')
const participant = ref('')
const query = ref('')
const notices = ref(false)
const PERIODS = { '24h': 24 * 3600 * 1000, '7d': 7 * 24 * 3600 * 1000, '30d': 30 * 24 * 3600 * 1000 }
const periodLabel = (p) => (p === '24h' ? t('conversations.period.24h', '24 h') : p === '7d' ? t('conversations.period.7d', '7 days') : t('conversations.period.30d', '30 days'))

// The agent panes open now: their names win over the ones recorded, and an
// agent's name goes to its pane.
const panes = computed(() => {
  const out = {}
  for (const p of props.projects || []) for (const pane of p.panes || []) if (pane && pane.id) out[pane.id] = { title: pane.title, agentId: pane.agentId || null, accent: pane.accent || null }
  return out
})
const paneAlive = (id) => !!id && !!panes.value[id]

// --- What was said in the agents' terminals ---------------------------------------------
// The conversations of the terminal agents in scope (a chat agent's messages
// already go through Tessel): each pane's current one, then its earlier ones
// and those of panes closed since, while this window runs (paneSessionTrail.js),
// MAX_ASKS at most. Their prompts and answers come from each agent's own
// conversation file, asked while the tab is shown, when it is shown, when
// the scope, the period or the conversations change, and with the clock's
// tick (every 20 s); the main process answers only what changed since (by
// the key it gave), and nothing is rebuilt when nothing did.
const MAX_ASKS = 32
const terminal = shallowRef({}) // ask -> { key, items, paneId, wsId, title, agentId, sessionId, host, hostLabel }
// Agents on a host not read yet: [{ title, host, state: 'offline' | 'reading' }].
const waiting = shallowRef([])
const waitingText = computed(() => {
  const off = waiting.value.filter((w) => w.state === 'offline')
  const reading = waiting.value.filter((w) => w.state === 'reading')
  const names = (list) => [...new Set(list.map((w) => w.title).filter(Boolean))].join(', ')
  const hosts = [...new Set(off.map((w) => w.host).filter(Boolean))].join(', ')
  return [
    off.length ? t('conversations.waiting.offline', 'Not read: {{names}} (their host {{hosts}} is not connected)', { names: names(off), hosts }) : '',
    reading.length ? t('conversations.waiting.reading', 'Reading from their host: {{names}}', { names: names(reading) }) : ''
  ]
    .filter(Boolean)
    .join(' · ')
})
// A Live Share host's project: its log and its teams, from the host.
const logEvents = computed(() => (props.source ? props.source.events || [] : props.events))
const logTeams = computed(() => (props.source ? props.source.teams || [] : props.teams))
// Followed while the tab is shown (the host's window sends it only then).
let followed = null
watch(
  () => (props.active && props.source ? props.source.project : null),
  () => {
    if (followed) followed.follow(false)
    followed = props.active && props.source ? props.source : null
    if (followed) followed.follow(true)
  },
  { immediate: true }
)
onBeforeUnmount(() => followed && followed.follow(false))
// What the host's terminal agents said (their panes here, by their ids).
async function askHost() {
  const had = terminal.value
  const known = {}
  for (const [ask, e] of Object.entries(had)) known[ask] = e.key
  const res = await props.source.terminal({ from: from.value, known })
  if (!res || !res.ok || !res.panes || typeof res.panes !== 'object') return
  const next = {}
  for (const [paneId, r] of Object.entries(res.panes)) {
    if (!r || typeof r.key !== 'string') continue
    const meta = { paneId, wsId: props.workspaceId, title: r.title || '', agentId: r.agentId || null, sessionId: paneId, host: 'local', hostLabel: '' }
    if (r.same && had[paneId]) next[paneId] = had[paneId]
    else if (Array.isArray(r.items)) next[paneId] = { key: r.key, items: r.items, ...meta }
  }
  const keys = Object.keys(next)
  if (keys.length !== Object.keys(had).length || keys.some((k) => next[k] !== had[k])) terminal.value = next
}
function terminalAsks() {
  const open = new Map() // paneId -> { pane, wsId, hostLabel }, every workspace's
  // A chat's conversation goes through Tessel: never read from its file.
  const chats = new Set()
  for (const p of props.projects || []) {
    for (const pane of p.panes || []) {
      if (!pane || !pane.id) continue
      if (pane.kind === 'chat' && pane.sessionId) chats.add(pane.sessionId)
      if (pane.kind !== 'agent' || !pane.agentId || typeof pane.sessionId !== 'string' || !pane.sessionId) continue
      open.set(pane.id, { pane, wsId: p.id, hostLabel: p.remote && p.remote.host ? p.remote.host : '' })
    }
  }
  // One pane per conversation: an open pane's first, then the latest closed
  // (a conversation resumed in another pane is that pane's now).
  const all = []
  const taken = new Set()
  const add = (a) => {
    const conv = `${a.agent}|${a.hostId || ''}|${a.sessionId}` // i18n-ignore
    if (taken.has(conv) || chats.has(a.sessionId)) return
    taken.add(conv)
    all.push(a)
  }
  for (const { pane, wsId, hostLabel } of open.values())
    add({ ask: pane.id, paneId: pane.id, agent: pane.agentId, sessionId: pane.sessionId, accountId: pane.accountId, hostId: pane.remoteHostId || null, wsId, title: pane.title, hostLabel })
  const trail = Object.values(paneSessionTrail).filter((row) => !row.chat)
  // An open pane's earlier conversations (the latest first).
  for (const row of trail) {
    const now = open.get(row.paneId)
    if (!now || row.agentId !== now.pane.agentId) continue
    for (const sid of sessionIds(row).reverse())
      if (sid !== now.pane.sessionId) add({ ask: `${row.paneId}~${sid}`, paneId: row.paneId, agent: row.agentId, sessionId: sid, accountId: row.accountId, hostId: row.hostId, wsId: now.wsId, title: now.pane.title, hostLabel: now.hostLabel }) // i18n-ignore
  }
  // Panes closed since (the latest first).
  const closed = trail.filter((row) => row.closedAt && !open.has(row.paneId)).sort((a, b) => b.closedAt - a.closedAt)
  for (const row of closed)
    for (const sid of sessionIds(row).reverse()) add({ ask: `${row.paneId}~${sid}`, paneId: row.paneId, agent: row.agentId, sessionId: sid, accountId: row.accountId, hostId: row.hostId, wsId: row.wsId, title: row.title, hostLabel: '' }) // i18n-ignore
  return all.filter((a) => scope.value !== 'workspace' || a.wsId === props.workspaceId).slice(0, MAX_ASKS)
}
const sameMeta = (a, b) => ['paneId', 'wsId', 'title', 'agentId', 'sessionId', 'host', 'hostId', 'hostLabel'].every((k) => a[k] === b[k])
let asking = false
let askAgain = false
async function askTerminal() {
  const api = window.shellApi && window.shellApi.conversations
  if (!props.active || (!props.source && (!api || typeof api.terminal !== 'function'))) return
  if (asking) {
    askAgain = true
    return
  }
  asking = true
  try {
    do {
      askAgain = false
      if (props.source) {
        await askHost()
        continue
      }
      // Without App (its watch notes them too): what this tab sees.
      notePanes(props.projects)
      const asks = terminalAsks()
      const had = terminal.value
      const known = {}
      for (const a of asks) if (had[a.ask] && had[a.ask].sessionId === a.sessionId) known[a.ask] = had[a.ask].key
      const res = await api.terminal({
        from: from.value,
        known,
        panes: asks.map((a) => ({
          ask: a.ask,
          paneId: a.paneId,
          agent: a.agent,
          sessionId: a.sessionId,
          ...(a.accountId !== undefined ? { accountId: a.accountId } : {}),
          ...(a.hostId ? { hostId: a.hostId } : {})
        }))
      })
      if (!res || !res.ok || !res.panes || typeof res.panes !== 'object') continue
      // The agents on a host whose conversation is not read yet (said under
      // the counts: never a silent gap).
      const wait = res.waiting && typeof res.waiting === 'object' ? res.waiting : {}
      waiting.value = asks.filter((a) => wait[a.ask] === 'offline' || wait[a.ask] === 'reading').map((a) => ({ title: a.title || '', host: a.hostLabel || '', state: wait[a.ask] }))
      const next = {}
      for (const a of asks) {
        const r = res.panes[a.ask]
        if (!r || typeof r.key !== 'string') continue
        const meta = { paneId: a.paneId, wsId: a.wsId, title: a.title || '', agentId: a.agent, sessionId: a.sessionId, host: a.hostId ? 'ssh' : 'local', hostId: a.hostId || '', hostLabel: a.hostLabel || '' }
        if (r.same && had[a.ask]) next[a.ask] = sameMeta(had[a.ask], meta) ? had[a.ask] : { ...had[a.ask], ...meta }
        else if (Array.isArray(r.items)) next[a.ask] = { key: r.key, items: r.items, ...meta }
        // Its file was read: the pane really ran it (kept once it is left).
        if (next[a.ask]) confirmSession(a.paneId, a.sessionId)
      }
      // Every conversation as it was: the threads are not built again.
      const keys = Object.keys(next)
      if (keys.length !== Object.keys(had).length || keys.some((k) => next[k] !== had[k])) terminal.value = next
    } while (askAgain && props.active)
  } catch {
    // asked again with the next tick
  } finally {
    asking = false
  }
}
const terminalSignature = computed(() =>
  props.source
    ? `lshare:${props.source.project}` // i18n-ignore
    : terminalAsks()
        .map((a) => `${a.ask}:${a.sessionId}:${a.hostId || ''}`)
        .join('|')
)

// --- The threads --------------------------------------------------------------------------
// Built again as the log grows, but only while the tab is shown: hidden, the
// last threads are kept (props.events is not read, so a new event does not
// rebuild anything).
const cache = shallowRef([])
// The period's start moves with the clock only to the minute: a tick of the
// clock does not rebuild the threads.
const from = computed(() => Math.floor((props.now - PERIODS[period.value]) / 60000) * 60000)
watch([() => props.active, scope, from, () => props.now, terminalSignature], () => askTerminal(), { immediate: true })
// An effort in the app's language, as a pane's header says it ("Élevé").
const effortLabel = (effort) => nativeChatSessionChoiceLabel({ value: effort, label: effort })
const terminalEntries = computed(() =>
  Object.entries(terminal.value).map(([ask, e]) => {
    // Its pane open now: its name and program as shown; closed: as noted.
    const pane = panes.value[e.paneId] || {}
    const agentId = pane.agentId || e.agentId
    return { paneId: e.paneId, group: ask, wsId: e.wsId, title: pane.title || e.title, agentId, agentName: agentId ? agentLabel(agentId) : '', sessionId: e.sessionId, host: e.host, hostId: e.hostId, hostLabel: e.hostLabel, items: e.items }
  })
)
const threads = computed(() => {
  if (!props.active) return cache.value
  // In a host's project, "You" is the host.
  const host = props.source ? props.source.host || '?' : null
  const tt = host
    ? (key, en, vars) =>
        key === 'conversations.you' ? host : key === 'conversations.withAgent' ? t('conversations.hostWithAgent', '{{host}} and {{agent}}', { host, agent: (vars && vars.agent) || '' }) : t(key, en, vars)
    : t
  cache.value = buildThreads(logEvents.value, {
    t: tt,
    teams: logTeams.value,
    panes: panes.value,
    wsId: scope.value === 'workspace' ? props.workspaceId : null,
    from: from.value,
    notices: notices.value,
    terminal: terminalEntries.value,
    effortLabel
  })
  return cache.value
})
const participants = computed(() => participantsOf(threads.value))
const matching = computed(() => filterThreads(threads.value, { query: query.value, participant: participant.value }))

// --- What the messages share: type chips and the Media view -------------------------------
// The chips' counts: the messages the other filters keep that share each type.
const types = ref([])
const view = ref('messages')
const counts = computed(() => typeCounts(matching.value))
const shown = computed(() => filterByTypes(matching.value, types.value))
const media = computed(() => (view.value === 'media' ? mediaItems(shown.value, types.value) : []))
const toggleType = (type) => (types.value = types.value.includes(type) ? types.value.filter((x) => x !== type) : [...types.value, type])
const TYPE_ICONS = { link: Link2, image: ImageIcon, video: Film, file: FileText, folder: Folder, code: Code2 }
const typeLabel = (type) =>
  ({
    link: t('conversations.type.links', 'Links'),
    image: t('conversations.type.images', 'Images'),
    video: t('conversations.type.videos', 'Videos'),
    file: t('conversations.type.files', 'Files'),
    folder: t('conversations.type.folders', 'Folders'),
    code: t('conversations.type.code', 'Code')
  })[type]
const typeHint = (type) => t('conversations.type.hint', 'Only the messages with: {{type}} ({{count}})', { type: typeLabel(type), count: counts.value[type] })

const total = computed(() => lineCount(shown.value))
const countText = computed(() =>
  view.value === 'media'
    ? t('conversations.media.count', '{{count}} shared items', { count: media.value.length })
    : `${t('conversations.threads', '{{count}} conversations', { count: shown.value.length })} · ${t('conversations.count', '{{count}} messages', { count: total.value })}`
)

// A line's paths are read against the folder of the pane that wrote it (an
// agent's own; yours, the agent's you wrote to): its pane open now, else the
// SSH host its agent ran on (as Tessel recorded the pane: never what the
// agent wrote), else its project's folder (an SSH project's on its host);
// none on a host's project (Live Share). A line from an SSH host is never
// read against a folder of this computer.
const guest = computed(() => !!props.source)
const links = useMessageLinks()
// paneId -> { hostId, path, label }: the host each agent's own lines name
// (its sender records), for the lines that do not say (yours to it).
const hostByPane = computed(() => {
  const out = new Map()
  for (const thread of threads.value)
    for (const line of thread.lines || []) {
      const r = line.from && line.from.kind === 'agent' && line.from.paneId ? senderRemote(line.sender) : null
      if (r && (r.hostId || !out.has(line.from.paneId))) out.set(line.from.paneId, r)
    }
  return out
})
function lineHost(line, paneId, project) {
  const own = line.from && line.from.kind === 'agent' ? senderRemote(line.sender) : null
  const known = paneId ? hostByPane.value.get(paneId) : null
  const terminal = line.remoteHost || null
  const host = (own && own.hostId && own) || (known && known.hostId && known) || own || known || null
  if (!terminal) return host
  // A terminal line names its host; its folder: the one the agent's records
  // or its SSH project name on that host, else the host's home folder.
  if (host && host.hostId === terminal.hostId) return host
  const projectPath = project && project.remote && project.remote.hostId === terminal.hostId ? project.remote.path : ''
  return { hostId: terminal.hostId, path: projectPath || '~', label: terminal.label || '' }
}
function lineContext(line) {
  if (guest.value || !line) return null
  const paneId = line.from && line.from.kind === 'agent' ? line.from.paneId : line.to && line.to.paneId
  const project = (props.projects || []).find((p) => p.id === line.wsId) || null
  return links.contextFor(paneId, { folder: project ? project.cwd : null, remote: project && project.remote ? project.remote : false, host: lineHost(line, paneId, project) })
}
// A terminal line's image, asked for once its thumbnail is in view; an image
// file a message names, read as the image viewer reads it (Media view).
function loadImage(img) {
  const api = window.shellApi
  if (guest.value || !api || !img) return null
  if (img.key && api.conversations && typeof api.conversations.image === 'function') return api.conversations.image(img.key)
  if (img.local && img.path && typeof api.viewImage === 'function') return api.viewImage(img.path)
  return null
}
const mediaContext = (item) => lineContext(item.line)
// "Show in conversation": the messages again, its thread open and whole,
// the message scrolled to and marked a moment.
const flash = ref('')
let flashTimer = 0
async function jumpTo(item) {
  const thread = item.thread
  const line = item.line
  view.value = 'messages'
  folded[thread.key] = false
  whole[thread.key] = true
  await nextTick()
  const el = [...document.querySelectorAll('[data-line-key]')].find((x) => x.getAttribute('data-line-key') === line.key)
  if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center' })
  flash.value = line.key
  clearTimeout(flashTimer)
  flashTimer = setTimeout(() => (flash.value = ''), 1800)
}
onBeforeUnmount(() => clearTimeout(flashTimer))

// --- Threads open or folded, lines shown ----------------------------------------------------
const folded = reactive({}) // thread key -> true when folded
const toggleThread = (key) => (folded[key] = !folded[key])
// A thread's lines newest first (a new message appears at the top, like the
// threads themselves); a long thread shows its latest ones, Show earlier (at
// the bottom) the rest.
const TAIL = 30
const whole = reactive({}) // thread key -> true: every line shown
const visibleLines = (thread) => (whole[thread.key] || thread.lines.length <= TAIL ? thread.lines : thread.lines.slice(-TAIL)).slice().reverse()
const hiddenCount = (thread) => (whole[thread.key] ? 0 : Math.max(0, thread.lines.length - TAIL))
// A long text is clamped; a click on it shows it whole.
const LONG = 280
const expanded = reactive({}) // line key -> true
const isLong = (line) => line.text.length > LONG || line.text.split('\n').length > 4 || /```|~~~/.test(line.text)
const toggleLine = (line) => {
  if (isLong(line)) expanded[line.key] = !expanded[line.key]
}

// A color of its own for each agent's name and avatar, the same every time:
// the pane's accent when Tessel has one, else one of a palette by the name.
const PALETTE = ['#e06c75', '#61afef', '#98c379', '#d19a66', '#c678dd', '#56b6c2', '#f0a35e', '#7aa2f7', '#e5c07b', '#2ac3de']
function agentColor(who) {
  if (!who || who.kind !== 'agent') return null
  const pane = who.paneId ? panes.value[who.paneId] : null
  if (pane && pane.accent) return pane.accent
  let h = 0
  for (const ch of String(who.label || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return PALETTE[h % PALETTE.length]
}
// The program an agent runs (claude, codex, opencode...): its logo beside its
// name and in its avatar. From the line, else from its pane open now.
const agentKind = (who) => (who && (who.agentId || (who.paneId && panes.value[who.paneId] && panes.value[who.paneId].agentId))) || ''
// The program's name after an agent's name ("Ada · Claude Code"), so two
// agents with the same name are told apart.
const programOf = (who) => (agentKind(who) ? agentLabel(agentKind(who)) : '')
// Bubbles like Messenger's: consecutive ones of the same speaker (within ten
// minutes) make a group whose joined corners are nearly square; the name
// goes above the group's first bubble, the avatar beside its last one.
const sameSpeaker = (a, b) => !!a && !!b && a.kind !== 'notice' && b.kind !== 'notice' && a.from.kind === b.from.kind && a.from.label === b.from.label && Math.abs(b.t - a.t) < 10 * 60000
// In a team thread the group head names the recipients too: a message to
// someone else starts a new group, so every bubble's recipients show.
const toKey = (line) => recipients(line).map((to) => to.label).join(', ')
const sameGroup = (team, a, b) => sameSpeaker(a, b) && (!team || toKey(a) === toKey(b))
// A time stamp sits between messages an hour or more apart (and above the
// first one shown), like Messenger's. Lines run newest first, so a stamp heads
// the cluster below it and carries the time of that cluster's newest message;
// the clusters read newest to oldest, each stamp older than the one above.
const STAMP_GAP = 60 * 60000
function rows(thread) {
  const lines = visibleLines(thread)
  const team = thread.kind === 'team'
  return lines.map((line, i) => {
    const prev = sameGroup(team, lines[i - 1], line)
    const next = sameGroup(team, line, lines[i + 1])
    const stamp = !lines[i - 1] || Math.abs(lines[i - 1].t - line.t) >= STAMP_GAP
    return { line, shape: prev && next ? 'mid' : prev ? 'last' : next ? 'first' : 'single', head: !prev, tail: !next, stamp }
  })
}
// An agent's bubble carries a faint tint of its color; its avatar, a ring.
const tint = (who) => {
  const c = agentColor(who)
  return c ? { background: `color-mix(in srgb, ${c} 9%, var(--surface-3))` } : null // i18n-ignore
}
const ring = (who) => {
  const c = agentColor(who)
  return c ? { boxShadow: `0 0 0 1.5px ${c}`, background: `color-mix(in srgb, ${c} 18%, var(--surface-2))` } : null // i18n-ignore
}

// What a line says about itself: a reply's nature, a delivery status, its card.
function noteOf(line) {
  return [replyText(line, t), statusText(line, t), line.taskTitle ? t('conversations.onCard', 'on "{{title}}"', { title: line.taskTitle }) : '', line.lead ? t('conversations.lead', 'lead') : '']
    .filter(Boolean)
    .join(' · ')
}
const when = (at) => formatWhen(at, props.now)
const lastText = (thread) => t('conversations.last', 'Last message {{when}}', { when: when(thread.last) })
// Vue closes an interpolation at the first }}: the texts with placeholders
// are made here, not in the template.
const threadLabel = (thread) => (thread.kind === 'team' ? t('conversations.teamThread', 'Team "{{name}}"', { name: thread.title }) : thread.title)
const earlierLabel = (thread) => t('conversations.showEarlier', 'Show the {{count}} earlier messages', { count: hiddenCount(thread) })

function goTo(who) {
  if (who && who.paneId && paneAlive(who.paneId)) emit('focus-pane', who.paneId)
}

// --- Copy -------------------------------------------------------------------------------------
const copied = ref('')
let copiedTimer = 0
async function copyThread(thread) {
  const text = threadText(thread, { t, locale: intlLocale() })
  try {
    await navigator.clipboard.writeText(text)
    copied.value = thread.key
    clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => (copied.value = ''), 1500)
    emit('toast', t('conversations.copied', 'Conversation copied'))
  } catch {
    emit('toast', t('conversations.copyFailed', 'The conversation could not be copied'))
  }
}

// The model a line was said with ("Opus 5.5 · High"), at the bottom right of
// its bubble; every detail Tessel recorded about its sender on hover.
function modelTitle(line) {
  const s = line.sender || (line.run ? { model: line.run.model, modelId: line.run.modelId, effort: line.run.effort } : null)
  return s ? senderDetails(s) : ''
}
// A line said in the agent's terminal (read from its conversation file).
const terminalHint = (line) => (line.from.kind === 'you' ? t('conversations.terminal.typed', 'Typed in its terminal') : t('conversations.terminal.answered', 'Answered in its terminal'))
</script>

<template>
  <div class="sh-panel cv-panel" data-test="conversations">
    <div class="sh-head">
      <div class="sh-head-row">
        <MessagesSquare :size="14" aria-hidden="true" class="cv-head-icon" />
        <div class="sh-head-text">
          <div class="sh-title">{{ t('conversations.title', 'Conversations') }}</div>
          <div class="sh-subtitle">{{ t('conversations.subtitle', 'Between the agents of a team, and with you') }}</div>
        </div>
      </div>
    </div>

    <div class="sh-scope cv-scope" role="group" :aria-label="t('conversations.scope.aria', 'Which conversations')" data-test="cv-scopes">
      <button
        v-for="sc in ['workspace', 'all']"
        :key="sc"
        type="button"
        class="sh-scope-btn"
        :class="{ on: scope === sc }"
        :disabled="sc === 'workspace' && !workspaceId"
        :aria-pressed="scope === sc ? 'true' : 'false'"
        :data-test="'cv-scope-' + sc"
        @click="scope = sc"
      >
        {{ sc === 'workspace' ? t('conversations.scope.workspace', 'This workspace') : t('conversations.scope.all', 'All workspaces') }}
      </button>
    </div>

    <div class="cv-filters">
      <ThemedSelect v-model="period" class="cv-select" :title="t('conversations.period.label', 'Period')" data-test="cv-period">
        <option v-for="p in Object.keys(PERIODS)" :key="p" :value="p">{{ periodLabel(p) }}</option>
      </ThemedSelect>
      <ThemedSelect v-model="participant" class="cv-select" :title="t('conversations.participant.label', 'Agent')" data-test="cv-participant">
        <option value="">{{ t('conversations.participant.all', 'All agents') }}</option>
        <option v-for="p in participants" :key="p" :value="p">{{ p }}</option>
      </ThemedSelect>
      <button
        type="button"
        class="cv-chip"
        :class="{ on: notices }"
        :aria-pressed="notices ? 'true' : 'false'"
        :title="t('conversations.noticesHint', 'Also show what Tessel told the agents (team, cards, deliveries)')"
        data-test="cv-notices"
        @click="notices = !notices"
      >
        <Check v-if="notices" :size="11" aria-hidden="true" />
        {{ t('conversations.notices', 'Tessel notices') }}
      </button>
      <label class="sh-search cv-search">
        <Search :size="12" class="sh-search-icon" aria-hidden="true" />
        <input
          v-model="query"
          class="sh-search-input"
          type="search"
          :placeholder="t('conversations.search', 'Search the conversations')"
          :aria-label="t('conversations.search', 'Search the conversations')"
          data-test="cv-search"
        />
        <button
          v-if="query"
          type="button"
          class="sh-search-clear"
          :title="t('conversations.clearSearch', 'Clear search')"
          :aria-label="t('conversations.clearSearch', 'Clear search')"
          data-test="cv-search-clear"
          @click="query = ''"
        >
          <X :size="12" aria-hidden="true" />
        </button>
      </label>
    </div>

    <div class="cv-types" role="group" :aria-label="t('conversations.type.aria', 'Messages that share')" data-test="cv-types">
      <button
        v-for="type in MEDIA_TYPES"
        :key="type"
        type="button"
        class="cv-chip cv-type"
        :class="{ on: types.includes(type) }"
        :disabled="!counts[type] && !types.includes(type)"
        :aria-pressed="types.includes(type) ? 'true' : 'false'"
        :title="typeHint(type)"
        :data-test="'cv-type-' + type"
        @click="toggleType(type)"
      >
        <component :is="TYPE_ICONS[type]" :size="11" aria-hidden="true" />
        {{ typeLabel(type) }}
        <span class="cv-type-count">{{ counts[type] }}</span>
      </button>
    </div>

    <div class="sh-bar cv-bar" data-test="cv-count">
      <span class="sh-bar-label">{{ countText }}</span>
      <div class="cv-views" role="group" :aria-label="t('conversations.view.aria', 'Show')">
        <button
          type="button"
          class="cv-view"
          :class="{ on: view === 'messages' }"
          :aria-pressed="view === 'messages' ? 'true' : 'false'"
          :title="t('conversations.view.messages', 'Messages')"
          :aria-label="t('conversations.view.messages', 'Messages')"
          data-test="cv-view-messages"
          @click="view = 'messages'"
        >
          <MessagesSquare :size="13" aria-hidden="true" />
        </button>
        <button
          type="button"
          class="cv-view"
          :class="{ on: view === 'media' }"
          :aria-pressed="view === 'media' ? 'true' : 'false'"
          :title="t('conversations.view.media', 'Media: everything shared')"
          :aria-label="t('conversations.view.media', 'Media: everything shared')"
          data-test="cv-view-media"
          @click="view = 'media'"
        >
          <LayoutGrid :size="13" aria-hidden="true" />
        </button>
      </div>
    </div>

    <div v-if="waitingText && !guest" class="cv-waiting" data-test="cv-waiting">{{ waitingText }}</div>

    <div class="sh-list cv-list" role="list" data-test="cv-list">
      <div v-if="!threads.length" class="sh-empty" data-test="cv-empty">
        <MessagesSquare :size="28" class="sh-empty-icon" aria-hidden="true" />
        <p>{{ t('conversations.empty2', 'Nothing said yet. Team messages and your chats with agents show up here.') }}</p>
      </div>
      <div v-else-if="!shown.length" class="sh-empty" data-test="cv-none">
        <p>{{ t('conversations.noMatch', 'No message matches.') }}</p>
      </div>
      <template v-else-if="view === 'media'">
        <div v-if="!media.length" class="sh-empty" data-test="cv-media-empty">
          <p>{{ t('conversations.media.empty', 'Nothing shared in these conversations: no link, image, video, file, folder or code.') }}</p>
        </div>
        <ConversationMedia v-else :items="media" :context-of="mediaContext" :guest="guest" :load-image="loadImage" :now="now" @jump="jumpTo" />
      </template>
      <template v-else>
      <section v-for="thread in shown" :key="thread.key" class="cv-thread" :class="{ folded: folded[thread.key] }" role="listitem" :data-test="'cv-thread-' + thread.key">
        <div class="sh-group cv-group">
          <button type="button" class="cv-group-main" :aria-expanded="!folded[thread.key]" :data-test="'cv-toggle-' + thread.key" @click="toggleThread(thread.key)">
            <ChevronRight :size="14" class="sh-chevron-r" :class="{ open: !folded[thread.key] }" aria-hidden="true" />
            <span v-if="thread.kind === 'team'" class="cv-team-icon" :style="thread.color ? { color: thread.color } : null">
              <Users :size="14" aria-hidden="true" />
            </span>
            <BrandIcon v-else :kind="thread.agentId || ''" :size="14" :label="thread.agent" />
            <span class="sh-group-label" :title="lastText(thread)">{{ threadLabel(thread) }}</span>
            <span class="cv-group-when">{{ when(thread.last) }}</span>
            <span class="sh-group-count">{{ thread.count }}</span>
          </button>
          <button
            type="button"
            class="sh-icon-btn cv-copy"
            :title="t('conversations.copy', 'Copy the conversation')"
            :aria-label="t('conversations.copy', 'Copy the conversation')"
            :data-test="'cv-copy-' + thread.key"
            @click.stop="copyThread(thread)"
          >
            <Check v-if="copied === thread.key" :size="13" aria-hidden="true" />
            <Copy v-else :size="13" aria-hidden="true" />
          </button>
        </div>
        <div v-if="!folded[thread.key]" class="cv-lines">
          <template v-for="row in rows(thread)" :key="row.line.key">
          <div v-if="row.stamp" class="cv-stamp" data-test="cv-stamp">{{ when(row.line.t) }}</div>
          <article
            class="cv-line"
            :class="['from-' + row.line.from.kind, 'kind-' + row.line.kind, 'shape-' + row.shape, { long: isLong(row.line), open: expanded[row.line.key], unsent: ['held', 'skipped', 'failed'].includes(row.line.status), flash: flash === row.line.key }]"
            :data-line-key="row.line.key"
            data-test="cv-line"
          >
            <!-- A Tessel notice: a line in the middle, like a system message. -->
            <div v-if="row.line.kind === 'notice'" class="cv-system" :title="when(row.line.t)">
              <span class="cv-who" data-test="cv-from">{{ row.line.from.label }}</span>
              <span class="cv-arrow" aria-hidden="true">→</span>
              <component
                :is="paneAlive(row.line.to.paneId) ? 'button' : 'span'"
                :type="paneAlive(row.line.to.paneId) ? 'button' : null"
                class="cv-who"
                :class="{ link: paneAlive(row.line.to.paneId) }"
                :style="{ color: agentColor(row.line.to) }"
                data-test="cv-to"
                @click="goTo(row.line.to)"
              >
                {{ row.line.to.label }}
              </component>
              <span class="cv-system-text" :class="{ clamp4: isLong(row.line) && !expanded[row.line.key] }" data-test="cv-text" @click="toggleLine(row.line)">{{ row.line.text }}</span>
            </div>
            <template v-else>
              <!-- The avatar, beside the last bubble of an agent's group. -->
              <div v-if="row.line.from.kind === 'agent'" class="cv-avatar" :class="{ shown: row.tail }" :style="row.tail ? ring(row.line.from) : null" aria-hidden="true">
                <BrandIcon v-if="row.tail" :kind="agentKind(row.line.from)" :size="16" :label="row.line.from.label" :accent="agentColor(row.line.from)" />
              </div>
              <div class="cv-col">
                <div v-if="row.head && row.line.from.kind === 'agent'" class="cv-line-head">
                  <component
                    :is="paneAlive(row.line.from.paneId) ? 'button' : 'span'"
                    :type="paneAlive(row.line.from.paneId) ? 'button' : null"
                    class="cv-who"
                    :class="{ link: paneAlive(row.line.from.paneId) }"
                    :style="{ color: agentColor(row.line.from) }"
                    :title="paneAlive(row.line.from.paneId) ? t('conversations.goToPane', 'Go to its pane') : null"
                    data-test="cv-from"
                    @click="goTo(row.line.from)"
                  >
                    <BrandIcon v-if="agentKind(row.line.from)" :kind="agentKind(row.line.from)" :size="12" class="cv-logo" data-test="cv-logo" />
                    {{ row.line.from.label }}
                    <span v-if="programOf(row.line.from)" class="cv-program" data-test="cv-program">· {{ programOf(row.line.from) }}</span>
                    <LocateFixed v-if="paneAlive(row.line.from.paneId)" :size="10" class="cv-locate" aria-hidden="true" />
                  </component>
                  <template v-if="thread.kind === 'team'">
                    <span class="cv-arrow" aria-hidden="true">→</span>
                    <template v-for="(to, ti) in recipients(row.line)" :key="ti">
                      <span v-if="ti" class="cv-comma" aria-hidden="true">,</span>
                      <component
                        :is="paneAlive(to.paneId) ? 'button' : 'span'"
                        :type="paneAlive(to.paneId) ? 'button' : null"
                        class="cv-who"
                        :class="{ link: paneAlive(to.paneId) }"
                        :style="{ color: agentColor(to) }"
                        :title="paneAlive(to.paneId) ? t('conversations.goToPane', 'Go to its pane') : null"
                        data-test="cv-to"
                        @click="goTo(to)"
                      >
                        <BrandIcon v-if="agentKind(to)" :kind="agentKind(to)" :size="12" class="cv-logo" />
                        {{ to.label }}
                      </component>
                    </template>
                  </template>
                </div>
                <div class="cv-bubble" :style="row.line.from.kind === 'agent' ? tint(row.line.from) : null" :title="when(row.line.t)">
                  <div class="cv-text" :class="{ clamp4: isLong(row.line) && !expanded[row.line.key] }" data-test="cv-text" @click="toggleLine(row.line)">
                    <span v-if="row.line.via === 'terminal'" class="cv-via" :title="terminalHint(row.line)" :aria-label="terminalHint(row.line)" data-test="cv-via"><SquareTerminal :size="11" aria-hidden="true" /></span>
                    <RichMessage
                      :text="row.line.text"
                      :images="row.line.images || []"
                      :images-more="row.line.imagesMore || 0"
                      :files="row.line.files || []"
                      :context="lineContext(row.line)"
                      :guest="guest"
                      :load-image="loadImage"
                    />
                  </div>
                  <button v-if="isLong(row.line)" type="button" class="cv-more" @click="toggleLine(row.line)">
                    {{ expanded[row.line.key] ? t('conversations.showLess', 'Show less') : t('conversations.showMore', 'Show all') }}
                  </button>
                </div>
                <div class="cv-caption" :class="{ shown: !!noteOf(row.line) || !!modelOf(row.line) }">
                  <span class="cv-when">{{ when(row.line.t) }}</span>
                  <span v-if="noteOf(row.line)" class="cv-note" data-test="cv-note">{{ noteOf(row.line) }}</span>
                  <!-- The model it was said with (every detail on hover), at the bottom right. -->
                  <span v-if="modelOf(row.line)" class="cv-model" :title="modelTitle(row.line)" data-test="cv-model">{{ modelOf(row.line) }}</span>
                </div>
              </div>
            </template>
          </article>
          </template>
          <button v-if="hiddenCount(thread)" type="button" class="cv-earlier" :data-test="'cv-earlier-' + thread.key" @click="whole[thread.key] = true">
            {{ earlierLabel(thread) }}
          </button>
        </div>
      </section>
      </template>
    </div>
  </div>
</template>

<style scoped>
.cv-panel {
  height: 100%;
  color: var(--text);
}
.cv-head-icon {
  flex: 0 0 auto;
  color: var(--text-dim);
}
.cv-scope {
  flex: 0 0 auto;
}
.cv-filters {
  display: flex;
  flex: 0 0 auto;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
}
.cv-select {
  flex: 1 1 90px;
  min-width: 0;
}
/* A filter that is on or off: a chip (the Settings' filter chips' look). */
.cv-chip {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 4px;
  height: 22px;
  padding: 0 8px;
  border: 1px solid var(--border-strong);
  border-radius: 11px;
  background: transparent;
  color: var(--text-dim);
  font: inherit;
  font-size: 11px;
  white-space: nowrap;
  cursor: pointer;
}
.cv-chip:hover {
  color: var(--text-strong);
}
.cv-chip.on {
  border-color: transparent;
  background: var(--surface-3);
  color: var(--text-strong);
  box-shadow: inset 0 0 0 1px var(--accent);
}
.cv-chip:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.cv-search {
  flex: 1 1 100%;
  margin: 0;
}
/* What the messages share: one chip per type, its count of messages. */
.cv-types {
  display: flex;
  flex: 0 0 auto;
  flex-wrap: wrap;
  gap: 4px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
}
.cv-type:disabled {
  opacity: 0.45;
  cursor: default;
}
.cv-type:disabled:hover {
  color: var(--text-dim);
}
.cv-type-count {
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
}
/* Agents on a host not read yet: said, never a silent gap. */
.cv-waiting {
  flex: 0 0 auto;
  padding: 4px 10px;
  border-bottom: 1px solid var(--border);
  color: var(--text-dim);
  font-size: 11px;
  line-height: 15px;
}
.cv-views {
  display: inline-flex;
  gap: 2px;
  margin-left: auto;
}
.cv-view {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 22px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
}
.cv-view:hover {
  color: var(--text-strong);
}
.cv-view.on {
  background: var(--surface-3);
  color: var(--text-strong);
  box-shadow: inset 0 0 0 1px var(--accent);
}
.cv-view:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.cv-bar {
  flex: 0 0 auto;
}
.cv-list {
  display: flex;
  flex-direction: column;
}
.cv-group {
  padding: 0 4px 0 6px;
  gap: 0;
}
.cv-group-main {
  display: flex;
  flex: 1 1 auto;
  align-items: center;
  gap: 6px;
  min-width: 0;
  height: 100%;
  padding: 0 4px;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.cv-team-icon {
  display: inline-flex;
  flex: 0 0 auto;
  color: var(--text-dim);
}
.cv-group-when {
  flex: 0 0 auto;
  color: var(--text-dim);
  font-size: 11px;
  font-weight: 400;
  font-variant-numeric: tabular-nums;
}
.cv-copy {
  flex: 0 0 auto;
}
.cv-lines {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 4px 10px 12px;
}
.cv-stamp {
  align-self: center;
  margin: 10px 0 4px;
  color: var(--text-dim);
  font-size: 10.5px;
  font-weight: 600;
}
.cv-earlier {
  align-self: center;
  margin-top: 10px;
  padding: 3px 10px;
  border: 0;
  border-radius: 12px;
  background: var(--surface-3);
  color: var(--text-dim);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}
.cv-earlier:hover {
  color: var(--text-strong);
}

/* --- A row: the avatar, then the name, the bubble and its caption. Like
   Messenger: yours blue on the right, an agent's gray on the left with its
   avatar, a Tessel notice as a small centered line. --- */
.cv-line {
  display: flex;
  align-items: flex-end;
  gap: 6px;
  max-width: 100%;
}
.cv-line.shape-first,
.cv-line.shape-single {
  margin-top: 10px;
}
.cv-stamp + .cv-line {
  margin-top: 0;
}
.cv-line.from-you {
  flex-direction: row-reverse;
}
.cv-line.from-tessel {
  justify-content: center;
  margin: 8px 0 4px;
}
.cv-avatar {
  display: flex;
  flex: 0 0 26px;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  margin-bottom: 2px;
  border-radius: 50%;
  overflow: hidden;
}
.cv-avatar.shown {
  background: var(--surface-2);
}
.cv-col {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  min-width: 0;
  max-width: 80%;
}
.cv-line.from-you .cv-col {
  align-items: flex-end;
}
.cv-line-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  min-width: 0;
  margin: 0 0 2px 10px;
  font-size: 11px;
}
.cv-who {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--text-dim);
  font: inherit;
  font-size: 11px;
  font-weight: 600;
}
.cv-who.link {
  cursor: pointer;
}
.cv-logo {
  flex: 0 0 auto;
}
.cv-program {
  color: var(--text-dim);
  font-weight: 500;
}
.cv-locate {
  opacity: 0.6;
}
.cv-who.link:hover {
  opacity: 0.8;
}
.cv-arrow,
.cv-comma {
  color: var(--text-dim);
}
.cv-comma {
  margin-left: -3px;
}

.cv-bubble {
  position: relative;
  min-width: 0;
  max-width: 100%;
  padding: 8px 13px;
  border-radius: 18px;
  background: var(--surface-3);
  color: var(--text-strong);
  box-shadow: 0 1px 1.5px rgba(0, 0, 0, 0.12);
  transition: filter 80ms;
}
.cv-line:hover .cv-bubble {
  filter: brightness(1.04);
}
.cv-line.from-you .cv-bubble {
  background: linear-gradient(160deg, #2b9bff 0%, #0a7cff 55%, #0066f0 100%);
  color: #fff;
  box-shadow: 0 1px 2px rgba(0, 102, 240, 0.35);
}
/* The joined corners of a group. */
.cv-line.from-agent.shape-first .cv-bubble {
  border-bottom-left-radius: 4px;
}
.cv-line.from-agent.shape-mid .cv-bubble {
  border-top-left-radius: 4px;
  border-bottom-left-radius: 4px;
}
.cv-line.from-agent.shape-last .cv-bubble {
  border-top-left-radius: 4px;
}
.cv-line.from-you.shape-first .cv-bubble {
  border-bottom-right-radius: 4px;
}
.cv-line.from-you.shape-mid .cv-bubble {
  border-top-right-radius: 4px;
  border-bottom-right-radius: 4px;
}
.cv-line.from-you.shape-last .cv-bubble {
  border-top-right-radius: 4px;
}
.cv-line.unsent .cv-bubble {
  opacity: 0.6;
}
.cv-text {
  font-size: 13px;
  line-height: 18.5px;
  letter-spacing: 0.005em;
  overflow-wrap: anywhere;
}
/* A long message shows its first lines until opened. */
.cv-text.clamp4 {
  max-height: calc(18.5px * 4 + 4px);
  overflow: hidden;
  -webkit-mask-image: linear-gradient(to bottom, #000 70%, transparent);
  mask-image: linear-gradient(to bottom, #000 70%, transparent);
}
.cv-line.flash .cv-bubble {
  box-shadow: 0 0 0 2px var(--accent);
}
.cv-line.long .cv-text {
  cursor: pointer;
}
.cv-more {
  display: block;
  margin-top: 2px;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 11px;
  font-weight: 600;
  opacity: 0.8;
  cursor: pointer;
}
.cv-more:hover {
  opacity: 1;
  text-decoration: underline;
}

/* Under the bubble: the time (on hover, like Messenger's), and what the
   line says about itself (a decision asked, not read yet), always shown. */
.cv-caption {
  display: flex;
  flex-wrap: wrap;
  align-self: stretch;
  gap: 6px;
  max-height: 0;
  margin: 0 10px;
  overflow: hidden;
  color: var(--text-dim);
  font-size: 10.5px;
  line-height: 14px;
  opacity: 0;
  transition:
    max-height 120ms,
    opacity 120ms;
}
/* With a note (a reply's nature, its card: a long title wraps on several
   lines), all of it; only the time, on hover, one line. */
.cv-caption.shown {
  max-height: none;
  margin-top: 2px;
  opacity: 1;
}
.cv-line:hover .cv-caption:not(.shown) {
  max-height: 40px;
  margin-top: 2px;
  opacity: 1;
}
.cv-caption .cv-when {
  opacity: 0;
}
.cv-line:hover .cv-caption .cv-when {
  opacity: 1;
}
.cv-note {
  font-style: italic;
}
/* The model, at the bottom right of the bubble, small and dim. */
.cv-model {
  margin-left: auto;
  white-space: nowrap;
}
/* Said in the agent's terminal: a small mark at the top right of the text. */
.cv-via {
  display: inline-flex;
  float: right;
  margin: 3px 0 0 6px;
  opacity: 0.55;
}

.cv-system {
  max-width: 100%;
  padding: 3px 10px;
  border-radius: 12px;
  background: color-mix(in srgb, var(--surface-3) 55%, transparent);
  color: var(--text-dim);
  font-size: 11px;
  line-height: 15px;
  text-align: center;
}
.cv-system .cv-who {
  font-size: 11px;
}
.cv-system-text {
  display: inline;
  margin-left: 4px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.cv-system-text.clamp4 {
  display: -webkit-box;
  cursor: pointer;
}
</style>
