// Live Share in the window (main side: src/main/liveShare.js).
//
// Host: you share one project or several (ticked when you start; added or
// taken out at any time, from Live Share or a project's menu; the last one
// stays, Stop sharing ends the share). Each one's layout, its panes' names and
// its active pane are sent to the guests each time they change, so they see
// it live; a project you switch away from stays shared. A guest asking to
// join waits in `asks` until you answer that guest: the prompt comes with the
// invitation it used, its projects and rights ticked (you can change them),
// and, once you checked the verification code, whether to trust that person
// next time. Who may see and do what afterwards is main's one access model
// (liveShareAccess.js derives the views; the Live Share dialog edits it).
// What guests do in your panes (open a terminal or an agent) is done here,
// with a notice: at once for a guest with the right to open, after your yes
// for one without it (an 'ask-open' request waits in `asks`; main may call
// it off, and is told when the window is done with each request); a guest asking
// to close an agent, or a terminal where a program runs, waits in `asks` for
// your yes too. A request is checked again when it is done: the same
// sharing, the guest still in with that right, the pane (or the project it
// opens in) still in a project you share that this guest sees. Who looks at,
// types in or reads which of your panes comes with the presence pushes
// (presenceOf, readersOf), and the agents guests may ask for are sent to
// main as they change (setAgents).
//
// Guest: each of the host's projects you see becomes a Live Share project in
// the sidebar ("<project> — <host>"); they come and go as the host shares
// them with you or stops. Their panes are the host's terminals and agents,
// attached like terminals kept in the terminal host (attachPty gives their
// screen, pty:data their output); each one's layout follows the host's,
// fullscreen pane and project included. They are never saved with the
// layout; closing one leaves the session. What the host does not let you do
// (type, close) is not done, with a notice; a terminal or one of the host's
// agents opened in its project opens at once with the right to open, and is
// asked of the host without it; closing one of its panes only asks the host
// (the pane goes when the host closed it). The host's pane on your screen is
// told to the host (focus: its eyes only). Panes of this
// computer never mix with the host's: none moves in or out, and one that
// opened there anyway (a page, a file) comes back to a project of yours when
// its project goes.
//
// Phase 2, host: each shared project's task board goes to main as it changes
// (setTasks: guests get a masked copy), a guest's change of a board (main's
// 'task' request, already checked there) is checked again here (the guest
// still in, with the right to manage tasks, seeing the project, the card on
// that project's board) and made with deps.taskBoard; every change a guest
// makes (a save, a commit, a task...) is a toast (onGuestAction, actionText).
// Guest: what you may do in each of the host's projects goes to the panels
// (liveShareGuestAccess.js: edit, git, tasks, or why not: no access any
// more, a host too old, the session over), and the host's board of the
// project on screen comes as a source for the Tasks tab (taskSource),
// followed while it is on screen; its changes go to the host.
//
// Phase 2b, host: each shared project's panes as their headers and the
// Dashboard show them (deps.paneAgents) and its finished tasks
// (deps.historyRecords) go to main as they change; a guest asking to delete a
// card with its own copy of the project makes you confirm, as your own ✕
// does (deps.taskBoard.removeWithCopy). Guest: the host's panes' model,
// effort, state and task for their headers, the sidebar and the Dashboard
// (paneAgent), a pane's sub-agents (childrenSource), the host's usage with the
// right (hostUsage), a project's task history (historySource, read while its
// tab is shown) and a task branch's review, read only (reviewSource).
//
// Your own view of a host's agent pane: its header's chat button shows its
// conversation as a chat (read only: nothing is sent from it) or its terminal
// again, on your screen only (setGuestView: the host's pane, its mode, its
// terminal and its agent never change, and nothing is sent to the host to
// switch). Your choice stays for each pane during the session. A pane the
// host has in chat mode has no terminal: it shows as a chat, and its terminal
// view says so. The conversation comes from the host (chatSource: main's
// liveShare:chatWatch, read only); a host whose Tessel does not share
// conversations yet: the chat view says so.
//
// Phase 2c (liveShareWindowFeeds.js): your browser panes in the shared
// projects and the activity guests follow go to main; as a guest, the host's
// browser pages (as links you open in your own browser), its past
// conversations and its activity come to the panels.
//
// Following the host: in each of the host's projects, your screen follows
// the host's (the tab it shows: its terminals, a browser page, one of its
// editor tabs; its active pane; the task copy it looks at) until you pick
// something yourself; "Follow host" (the Live Share pill) takes it up again.
// The host's editor tabs of the project (the files its Files tab shows you)
// are a tab of their own here (tabsLeaf: they open through your usual access
// to its files, read-only without "Edit files"); closing one only hides it
// on your screen.
import { reactive, watch } from 'vue'
import { t } from './i18n'
import { buildGuestTree, hostLayoutFromWorkspace, hostChatsFromWorkspace, hostTabsFromWorkspace, GUEST_CHAT_AGENTS } from './liveShareLayout'
import { lsharePath } from '../../shared/liveSharePath'
import { docs } from './editor/documents'
import { pathKey, samePath } from './editor/editorTabs'
import { cleanRights } from '../../shared/liveShareRights'
import { shownRights } from './liveShareRights'
import { initials, inviteName, personName, joinedGuests } from './liveShareAccess'
import { LS_TEXT_SIZES } from './liveShareFit'
import { setLshareAccess, endLshareSession, forgetLshareAccess } from './liveShareGuestAccess'
import { COLUMNS } from '../../shared/taskModel'
import { createLiveShareFeeds } from './liveShareWindowFeeds'
import { plainBridge } from './liveShareBridge'

// Typing shown on a pane is main's (typed in the last 3 s, said again every
// 4 s while it goes on and when it ends); one main never said the end of (a
// lost push) goes after this.
export const TYPING_STALE_MS = 12000

const REASONS = {
  denied: () => t('liveShare.reason.denied', 'The host said no.'),
  removed: () => t('liveShare.reason.removed', 'The host removed you from the session.'),
  stopped: () => t('liveShare.reason.stopped', 'The host stopped sharing.'),
  closed: () => t('liveShare.reason.closed', 'The connection closed.'),
  refused: () => t('liveShare.reason.refused', 'The invite code is not valid any more.'),
  expired: () => t('liveShare.reason.expired', 'This invite code expired. Ask the host for a new one.'),
  busy: () => t('liveShare.reason.busy2', 'The host is not taking new guests right now (too many people are waiting for an answer, or several were just turned away). Try again in a few minutes.'),
  timeout: () => t('liveShare.reason.timeout', 'The host did not answer in time.'),
  unreachable: () => t('liveShare.reason.unreachable', 'The host could not be reached.'),
  'not-tessel': () => t('liveShare.reason.notTessel', 'This address is not a Tessel Live Share.'),
  slow: () => t('liveShare.reason.slow', 'The connection was too slow to keep up.'),
  tunnel: () => t('liveShare.reason.tunnel', 'The host’s tunnel stopped.'),
  replaced: () => t('liveShare.reason.replaced', 'You joined another session.'),
  left: () => t('liveShare.reason.left', 'You left the session.'),
  error: () => t('liveShare.reason.error', 'The connection failed.'),
  lost: () => t('liveShare.reason.lost', 'The connection to the host was lost and did not come back.'),
  'rejoin-refused': () => t('liveShare.reason.rejoinRefused', 'The host no longer knows this Tessel: join again with an invite code.'),
  'old-code': () => t('liveShare.reason.oldCode', 'This code’s address no longer answers, and the code is too old to find the host again: ask the host for a new code.'),
  outdated: () => t('liveShare.reason.outdated', 'Your Tessel is too old for the host’s Live Share: update Tessel and join again.'),
  protocol: () => t('liveShare.reason.protocol', 'The two Tessels do not speak the same Live Share: update both and join again.'),
  'host-unverified': () => t('liveShare.reason.hostUnverified', 'The host could not prove it is the same Tessel as before: join again with an invite code, and check the code with the host.'),
  'outdated-host': () => t('liveShare.reason.outdatedHost', 'The host’s Tessel is too old for this Live Share: the host needs to update Tessel.')
}
// Only REASONS' own words (a host's word like "constructor" is not one).
export const endReason = (reason) => (typeof reason === 'string' && Object.hasOwn(REASONS, reason) ? REASONS[reason]() : t('liveShare.reason.ended', 'The session ended.'))

// What a guest may do, in words ("type, open terminals and agents").
export function rightsText(rights) {
  if (!rights) return t('liveShare.rights.all', 'The host’s Tessel lets guests type, open and close panes.')
  const parts = shownRights()
    .filter((r) => rights[r.id] === true)
    .map((r) => r.part)
  if (!parts.length) return t('liveShare.rights.watch', 'You can watch. The host has not let you type yet.')
  return t('liveShare.rights.can', 'You can watch and {{list}}.', { list: parts.join(', ') })
}

// A Live Share project's name in a guest's sidebar: the host's project, then
// the host.
export const guestWsName = (project, host) => t('liveShare.wsName2', '{{project}} — {{host}}', { project, host: host || '?' })

// A change a guest made (main's guestAction entry), in words: "Ana saved
// src/app.js".
export function actionText(a) {
  if (!a || typeof a !== 'object') return ''
  const name = a.name || t('liveShare.guest', 'A guest')
  const path = a.path || ''
  const count = Number.isInteger(a.count) ? a.count : 0
  const title = a.detail || ''
  switch (a.kind) {
    case 'save':
      return t('liveShare.action.save', '{{name}} saved {{path}}', { name, path })
    case 'create':
      return t('liveShare.action.create', '{{name}} created {{path}}', { name, path })
    case 'rename':
      return t('liveShare.action.rename', '{{name}} renamed {{path}} to {{to}}', { name, path, to: a.to || '' })
    case 'trash':
      return t('liveShare.action.trash', '{{name}} moved {{path}} to the Recycle Bin', { name, path })
    case 'notes':
      return t('liveShare.action.notes', '{{name}} saved the notes', { name })
    case 'stage':
      return count === 1 && a.paths ? t('liveShare.action.stageOne', '{{name}} staged {{path}}', { name, path: a.paths[0] }) : t('liveShare.action.stage', '{{name}} staged {{count}} files', { name, count })
    case 'unstage':
      return count === 1 && a.paths ? t('liveShare.action.unstageOne', '{{name}} unstaged {{path}}', { name, path: a.paths[0] }) : t('liveShare.action.unstage', '{{name}} unstaged {{count}} files', { name, count })
    case 'discard':
      return count === 1 && a.paths ? t('liveShare.action.discardOne', '{{name}} discarded the changes of {{path}}', { name, path: a.paths[0] }) : t('liveShare.action.discard', '{{name}} discarded the changes of {{count}} files', { name, count })
    case 'commit':
      return t('liveShare.action.commit', '{{name}} committed “{{message}}”', { name, message: title })
    case 'taskAdd':
      return t('liveShare.action.taskAdd', '{{name}} added a task: {{title}}', { name, title })
    case 'taskMove':
      return t('liveShare.action.taskMove', '{{name}} moved “{{title}}” to {{column}}', { name, title, column: columnName(a.column) })
    case 'taskEdit':
      return a.from ? t('liveShare.action.taskRenamed', '{{name}} renamed the task “{{from}}” to “{{title}}”', { name, from: a.from, title }) : t('liveShare.action.taskEdit', '{{name}} renamed a task: {{title}}', { name, title })
    case 'taskRemove':
      return t('liveShare.action.taskRemove', '{{name}} deleted the task “{{title}}”', { name, title })
    case 'taskAnswer':
      return a.answer ? t('liveShare.action.taskAnswered', '{{name}} answered “{{answer}}” on “{{title}}”', { name, answer: a.answer, title }) : t('liveShare.action.taskAnswer', '{{name}} answered the question on “{{title}}”', { name, title })
    default:
      return ''
  }
}
function columnName(column) {
  if (column === 'doing') return t('tasks.column.doing', 'Doing')
  if (column === 'review') return t('tasks.column.review', 'Review')
  if (column === 'done') return t('tasks.column.done', 'Done')
  return t('tasks.column.todo', 'To do')
}

// deps: workspaces() (the array), currentWs(), currentWsId(), maximizedId()
// / setMaximized(id), makeWorkspace(name), selectWorkspace(id),
// removeWorkspace(id, confirmed, editorChecked), findLeaf(id), closeLeaf(id,
// opts), launch(spec, targetId, where), selectedShell(), seedBuffer(id, text),
// dropBuffer(id), showToast(text, opts), isAgentLeaf(leaf),
// probeRunningWork(id) -> Promise<{ running, unknown, names }>, killPty(id),
// adoptLeaves(leaves) (panes of this computer, put in a project of yours),
// hasAgent(id), layoutReady() (optional: the window has its projects back
// after a start), agentList() (optional: the agents this window can start,
// [{ id, name }], offered to guests), agentName(id) (optional), activePaneId()
// (optional: the pane with the keyboard, for a guest's focus), taskBoard
// (optional: this computer's board for guests, { tasks() (the cards), add({
// title, wsId, guest }), move(id, column), rename(id, title, guest),
// remove(id), answer(id, answer, guest), removeWithCopy(id, guestName) (a
// card with its own copy: deleted after your yes, with that copy) }; guest:
// the guest's name, for what agents read), paneAgents(wsId) (optional: a
// shared project's panes as their headers show them), historyRecords()
// (optional: taskHistory.js records), historyShown() (optional: the Task
// history tab is on screen). Phase 2c: pageGuest(paneId) (its page's
// webContents id, reactive), activityOf(wsId) -> { events, teams },
// activityRev() (liveShareWindowFeeds.js).
const OFF_HOST = () => ({ state: 'off', projectIds: [], invites: [], guests: [], offline: [], trusted: [], presence: [], progress: null, error: null })
export function createLiveShareWindow(deps) {
  // Plain arguments only (liveShareBridge.js): a reactive object sent as is
  // makes the call throw before it reaches the main process.
  let bridged = null
  let bridgedFrom = null
  const api = () => {
    const raw = (window.shellApi && window.shellApi.liveShare) || null
    if (raw !== bridgedFrom) {
      bridgedFrom = raw
      bridged = plainBridge(raw)
    }
    return bridged
  }
  const state = reactive({
    host: OFF_HOST(),
    guest: { state: 'off', host: null, session: null, panes: [], projects: [], reason: null, rights: null, code: null, chat: false, chats: [], agents: null },
    defaultName: '',
    // The projects you pick to share (their ids), before you start. While
    // sharing, the projects shared are main's (host.projectIds).
    pickedIds: [],
    // What waits for your answer, first one shown: { kind: 'join', key,
    // guestId, name, code, invite, offer, trustable }, { kind: 'close', key,
    // guestId, name, paneId, paneName, detail } or { kind: 'open', key,
    // guestId, name, spec, projectName, agentName }.
    asks: [],
    // Counts the moments a typing mark may have gone stale (presenceOf reads
    // it, so the marks are looked at again then).
    presenceTick: 0,
    // Guest: the host's boards that came (project -> { tasks }).
    boards: {},
    // Phase 2b, guest: what each of the host's panes runs and how it is, as
    // its header shows it (this window's pane id -> { project, kind, agentId,
    // model, state, sleeping, since, task, attention, reset, team, copy,
    // children }); the host's usage (with the right: { providers }); each
    // project's task history (project -> { records, usd, error, at }); the
    // review shown ({ project, taskId }).
    paneAgents: {},
    hostUsage: null,
    histories: {},
    review: null,
    // Guest: whether your screen follows the host's in each of its projects
    // (project -> { on }), and the host's editor tabs there (project -> {
    // tabs: [rel], active }).
    follow: {},
    tabs: {}
  })
  const guestLeaves = new Map() // local pane id -> leaf
  const attaching = new Set()
  const offs = []
  const stops = []
  // Your own view of each host pane (local pane id -> 'chat' | 'terminal'),
  // for the session.
  const views = new Map()
  // Your Text size for each host terminal (local pane id -> 'fit' | 'width'
  // | 'normal', liveShareFit.js), for the session.
  const textSizes = new Map()
  const chatListeners = new Set()

  const isGuestWs = (ws) => !!(ws && ws.liveShare)
  const isGuestLeaf = (leaf) => !!(leaf && leaf.backend === 'liveshare')
  // Per project of the host you see: its fullscreen pane last followed (only
  // its changes are), and what following last put on your screen (applied:
  // your active pane, tab and editor file then; any other is your own pick).
  const follow = new Map() // host project id -> { maximized, pending, applied }
  const followOf = (id) => {
    if (!follow.has(id)) follow.set(id, { maximized: null, pending: false, applied: null })
    return follow.get(id)
  }
  const followState = (id) => {
    if (!state.follow[id]) state.follow[id] = { on: true }
    return state.follow[id]
  }
  // The host's editor tabs of each project, as a tab here (project -> leaf),
  // and the ones you hid (project -> Set of paths).
  const tabsLeaves = new Map()
  const hiddenTabs = new Map()
  // Each time you start sharing: a request from an earlier sharing is stale.
  let generation = 0
  const guestWss = (session) => deps.workspaces().filter((w) => w.liveShare && w.liveShare.session === session)
  const guestWs = (session, project) => guestWss(session).find((w) => w.liveShare.project === project) || null
  const hostSharing = () => state.host.state === 'sharing'
  const hostStarting = () => ['preparing', 'starting', 'checking'].includes(state.host.state)

  // --- Host ----------------------------------------------------------------
  const localWs = (id) => (id ? deps.workspaces().find((w) => w.id === id && !isGuestWs(w)) || null : null)
  // The projects shared now (their ids, main's), while sharing or starting.
  const sharedIds = () => (hostSharing() || hostStarting() ? state.host.projectIds || [] : [])
  // The ones this window has (a share taken back after a restart waits for
  // them to be found again).
  const sharedWss = () => sharedIds().map(localWs).filter(Boolean)
  const isShared = (id) => sharedIds().includes(id)
  // What Live Share ticks: the projects shared, or the ones picked to start.
  const chosenIds = () => (hostSharing() || hostStarting() ? sharedIds() : state.pickedIds)

  // What guests see of each shared project you have here. The fullscreen
  // pane is the window's: only for the project on screen. Its agent panes
  // with a conversation (chats) and its folder (root: what guests' Files,
  // editor and Changes read, through main; none for a project on an SSH
  // host) are for main only: guests get the panes by name, never the folder.
  function layoutsNow() {
    return sharedWss().map((ws) => ({
      id: ws.id,
      layout: hostLayoutFromWorkspace(ws, deps.currentWsId() === ws.id ? deps.maximizedId() : null),
      chats: hostChatsFromWorkspace(ws),
      root: !ws.remote && typeof ws.cwd === 'string' && ws.cwd ? ws.cwd : null,
      // Its editor tabs (host-only: main keeps those guests may see).
      tabs: ws.remote ? { files: [], active: null } : hostTabsFromWorkspace(ws)
    }))
  }

  // Before you start: the projects picked last time that are still there
  // (this window's, else the ones main kept from the last share: a restart
  // forgets the window's), else the project on screen (or your first one
  // when a Live Share project is on screen).
  function prepareShare() {
    if (hostSharing() || hostStarting()) return
    const kept = state.pickedIds.filter((id) => localWs(id))
    if (kept.length) {
      state.pickedIds = kept
      return
    }
    const last = (Array.isArray(state.host.lastProjectIds) ? state.host.lastProjectIds : []).filter((id) => localWs(id))
    if (last.length) {
      state.pickedIds = last
      return
    }
    const cur = deps.currentWs()
    const ws = cur && !isGuestWs(cur) ? cur : deps.workspaces().find((w) => !isGuestWs(w)) || null
    state.pickedIds = ws ? [ws.id] : []
  }

  // A project ticked or not: before you start, what you pick; while sharing,
  // added to the share or taken out at once. The last one shared stays (Stop
  // sharing ends the share).
  async function setShared(id, on) {
    const ws = localWs(id)
    if (on && !ws) return false
    if (!hostSharing() && !hostStarting()) {
      const rest = state.pickedIds.filter((x) => x !== id)
      state.pickedIds = on ? [...rest, id] : rest
      return true
    }
    if (!on === !isShared(id)) return true
    if (!on && sharedIds().length <= 1) {
      deps.showToast(t('liveShare.toast.lastProject', 'This is the only project you share. To stop sharing it, use Stop sharing in Live Share.'), { timeout: 6000 })
      return false
    }
    const r = await Promise.resolve(api()?.share({ id, shared: !!on })).catch(() => null)
    if (!r || !r.ok) {
      if (r && r.reason === 'full') deps.showToast(t('liveShare.toast.tooManyProjects', 'You can share up to {{count}} projects at once.', { count: r.max || 16 }), { timeout: 6000 })
      else if (r && r.reason === 'last') deps.showToast(t('liveShare.toast.lastProject', 'This is the only project you share. To stop sharing it, use Stop sharing in Live Share.'), { timeout: 6000 })
      return false
    }
    if (Array.isArray(r.projectIds) && (hostSharing() || hostStarting())) state.host.projectIds = r.projectIds
    const name = (ws && ws.name) || '?'
    if (on) deps.showToast(t('liveShare.toast.projectAdded', '{{project}} is shared now. Guests already in see it only once you give it to them (Live Share, in the toolbar).', { project: name }), { timeout: 7000 })
    else deps.showToast(t('liveShare.toast.projectRemoved', '{{project}} is no longer shared: guests no longer see it.', { project: name }), { timeout: 5000 })
    return true
  }

  // The projects of this share seen in this window, with their names (a
  // project closed after that is taken out of the share).
  const seen = new Map()
  const sharedName = (id) => (localWs(id) || {}).name || seen.get(id) || ''

  // "Simpa joined ESXLegacy." (the projects that guest sees, by name).
  function joinedText(g) {
    const names = (Array.isArray(g.projects) ? g.projects : []).map(sharedName).filter(Boolean)
    const name = personName(g)
    if (!names.length) return t('liveShare.toast.joined', '{{name}} joined your Live Share.', { name })
    if (names.length === 1) return t('liveShare.toast.joinedProject', '{{name}} joined {{project}}.', { name, project: names[0] })
    return t('liveShare.toast.joinedProjects', '{{name}} joined {{project}} and {{count}} more.', { name, project: names[0], count: names.length - 1 })
  }

  // A share that came back by itself after a restart: said once.
  let resumedShown = null
  function onHost(s) {
    if (!s) return
    if (s.resumed && s.resumed !== resumedShown) {
      resumedShown = s.resumed
      deps.showToast(t('liveShare.toast.resumed', 'Your Live Share started again: your guests reconnect by themselves.'), { timeout: 6000 })
    }
    const before = new Map(state.host.guests.map((g) => [g.id, g]))
    const wasOn = hostSharing() || hostStarting()
    const lastShared = sharedIds()
    if (s.state === 'sharing' && state.host.state !== 'sharing') generation++
    Object.assign(state.host, OFF_HOST(), s)
    feeds.onHost(state.host)
    noteTyping(state.host.presence)
    // Sharing ended: the projects it shared are the ones picked next time.
    if (wasOn && !hostSharing() && !hostStarting()) {
      seen.clear()
      if (lastShared.length) state.pickedIds = [...lastShared]
    }
    // Joined and left, trusted people let in at once included. A trusted
    // person's new connection replacing its old one (one connection per
    // trusted identity, a new id each time) is neither.
    const wasIn = new Set([...before.values()].filter((g) => g.state === 'joined' && g.trustId).map((g) => g.trustId))
    const nowIn = new Set((s.guests || []).filter((g) => g.state === 'joined' && g.trustId).map((g) => g.trustId))
    for (const g of s.guests || []) {
      const was = before.get(g.id)
      if (g.state === 'joined' && (!was || was.state !== 'joined') && !(g.trustId && wasIn.has(g.trustId))) deps.showToast(joinedText(g), { timeout: 5000 })
      before.delete(g.id)
    }
    for (const g of before.values())
      if (g.state === 'joined' && !(g.trustId && nowIn.has(g.trustId))) deps.showToast(t('liveShare.toast.left', '{{name}} left your Live Share.', { name: personName(g) }), { timeout: 5000 })
    // A guest who is no longer waiting (gone, or answered elsewhere), and the
    // requests that no longer stand (the guest left, lost the right or the
    // project, sharing stopped).
    const waiting = new Set((s.guests || []).filter((g) => g.state === 'waiting').map((g) => g.id))
    for (let i = state.asks.length - 1; i >= 0; i--) {
      const a = state.asks[i]
      const stands = a.kind === 'join' ? waiting.has(a.guestId) : a.kind === 'open' ? openStands(a) : closeStands(a)
      if (!stands) dropAsk(i)
    }
  }

  // An ask taken away (answered, no longer standing, called off): a request
  // to open is done with, for main.
  function dropAsk(i) {
    const [a] = state.asks.splice(i, 1)
    if (a && a.kind === 'open') requestDone(a.request)
    return a
  }
  const requestDone = (request) => {
    if (typeof request === 'string' && request) api()?.requestDone?.(request)
  }

  // An invitation got blocked (connections used its code without joining).
  function onInviteBlocked(m) {
    const inv = m && (state.host.invites || []).find((x) => x.id === m.id)
    const label = inv ? inviteName(inv) : t('liveShare.invite.untitled', 'Invitation')
    deps.showToast(t('liveShare.toast.blocked2', 'Several connections used the code of “{{label}}” without joining: it no longer lets anyone in. Make a new code for it in Live Share.', { label }), { kind: 'error', timeout: 12000 })
  }

  // --- Presence ------------------------------------------------------------
  // When each guest's typing in each pane was last said (pane id + guest id),
  // for the stale ones.
  const typingSeen = new Map()
  let typingTimer = 0
  function noteTyping(list) {
    const now = Date.now()
    const live = new Set()
    for (const p of Array.isArray(list) ? list : [])
      for (const g of (p && Array.isArray(p.guests) ? p.guests : []))
        if (g && g.typing) {
          const key = `${p.id}\n${g.id}` // i18n-ignore
          live.add(key)
          typingSeen.set(key, now)
        }
    for (const key of [...typingSeen.keys()]) if (!live.has(key)) typingSeen.delete(key)
    clearTimeout(typingTimer)
    typingTimer = typingSeen.size ? setTimeout(() => state.presenceTick++, TYPING_STALE_MS + 50) : 0
  }
  function onPresence(list) {
    if (!hostSharing()) return
    state.host.presence = Array.isArray(list) ? list : []
    noteTyping(state.host.presence)
  }

  // Who is at a pane of yours now: [{ id, name, initials, watching, typing,
  // reading }], the guests in only, only while sharing.
  function presenceOf(paneId) {
    void state.presenceTick
    if (!hostSharing() || !paneId) return []
    const entry = (state.host.presence || []).find((p) => p && p.id === paneId)
    if (!entry || !Array.isArray(entry.guests)) return []
    const now = Date.now()
    const out = []
    // The guests in now (a trusted person's replaced connection is not).
    const inNow = joinedGuests(state.host)
    for (const g of entry.guests) {
      const guest = g && inNow.find((x) => x.id === g.id)
      if (!guest) continue
      const seenAt = typingSeen.get(`${paneId}\n${g.id}`) // i18n-ignore
      const typing = !!g.typing && seenAt !== undefined && now - seenAt < TYPING_STALE_MS
      if (!g.watching && !typing && !g.reading) continue
      const name = personName(guest)
      out.push({ id: g.id, name, initials: initials(guest.name), watching: !!g.watching, typing, reading: !!g.reading })
    }
    return out
  }

  // The guests reading a pane's conversation now (their names), shown on
  // the pane: sharing it is on by default, never unseen.
  const readersOf = (paneId) => presenceOf(paneId).filter((p) => p.reading).map((p) => p.name)

  // The guest is in, with this right, in this sharing.
  const guestMay = (guestId, right) => !!guestId && (state.host.guests || []).some((g) => g.id === guestId && g.state === 'joined' && g.rights && g.rights[right])
  // The guest is in and sees this project, and it is still shared.
  const guestSees = (guestId, projectId) =>
    !!guestId && !!projectId && isShared(projectId) && (state.host.guests || []).some((g) => g.id === guestId && g.state === 'joined' && Array.isArray(g.projects) && g.projects.includes(projectId))
  // The shared project a pane of yours is in (null: none).
  const projectOfPane = (id) => {
    const ws = sharedWss().find((w) => hasLeaf(w.tree, id))
    return ws ? ws.id : null
  }
  // A guest's close request still stands: same sharing, the guest still in
  // with the right, the pane still in a shared project that guest sees.
  const closeStands = (a) => hostSharing() && a.generation === generation && guestMay(a.guestId, 'close') && guestSees(a.guestId, projectOfPane(a.paneId)) && !!deps.findLeaf(a.paneId)
  // A guest's request to open something (asked of you) still stands: same
  // sharing, the guest still in and seeing that project, the agent still
  // one you have.
  const openStands = (a) => hostSharing() && a.generation === generation && guestSees(a.guestId, a.spec && a.spec.project) && !(a.spec.agent && !deps.hasAgent(a.spec.agent))

  function onAsk(a) {
    if (!a || !a.guestId || state.asks.some((x) => x.key === a.guestId)) return
    const offer = a.offer && typeof a.offer === 'object' ? { projects: Array.isArray(a.offer.projects) ? [...a.offer.projects] : [], rights: cleanRights(a.offer.rights) } : null
    state.asks.push({ kind: 'join', key: a.guestId, guestId: a.guestId, name: a.name, code: a.code || null, invite: a.invite || null, offer, trustable: !!a.trustable })
  }

  // Your answer to one ask (its key): a guest's join (with the shared
  // projects and the rights it gets, none when not said, and whether it is
  // trusted from now on), a close request, or a request to open.
  function answerAsk({ key, yes, projects, rights, trust } = {}) {
    const i = state.asks.findIndex((a) => a.key === key)
    if (i < 0) return
    const a = dropAsk(i)
    if (a.kind === 'join') {
      // Main decides whether it can be trusted (and says why not).
      const trustIt = !!(yes && trust)
      Promise.resolve(
        api()?.approve({
          guestId: a.guestId,
          yes: !!yes,
          projects: yes ? (Array.isArray(projects) ? projects : []).filter((id) => isShared(id)) : [],
          rights: yes ? cleanRights(rights) : cleanRights(null),
          trust: trustIt
        })
      )
        .then((r) => {
          // Let in, but NOT trusted: the trusted list is full, or its Tessel
          // can't be trusted (too old: no identity key).
          if (!trustIt || !r) return
          if (r.reason === 'trust-full')
            deps.showToast(t('liveShare.toast.trustFullJoined', 'Trusted list full ({{max}}): {{name}} joined without being trusted. Remove someone from Trusted people to trust them.', { max: r.max || 50, name: personName(a) }), { kind: 'error', timeout: 9000 })
          else if (r.reason === 'not-trustable')
            deps.showToast(t('liveShare.toast.notTrustable', '{{name}} joined without being trusted: their Tessel is too old to be trusted (it needs an update).', { name: personName(a) }), { kind: 'error', timeout: 9000 })
        })
        .catch(() => {})
    } else if (a.kind === 'close' && yes && closeStands(a)) closeForGuest(a.paneId, a.name)
    else if (a.kind === 'open' && yes && openStands(a)) openForGuest(a.spec, a.name)
  }

  // People's "Let in…" for a guest waiting for your answer: their ask comes
  // first, so the prompt shows them (with the code to check and what their
  // invitation offers). One this window lost is made again from main's
  // status. -> whether that guest still waits.
  function showAsk(guestId) {
    let i = state.asks.findIndex((a) => a.kind === 'join' && a.guestId === guestId)
    if (i < 0) {
      const g = state.host.guests.find((x) => x.id === guestId && x.state === 'waiting')
      if (!g) return false
      onAsk({ guestId: g.id, name: g.name, code: g.code, invite: g.invite || null, offer: offerOf(g.invite), trustable: !!g.trustable })
      i = state.asks.length - 1
    }
    if (i > 0) state.asks.unshift(...state.asks.splice(i, 1))
    return true
  }

  function closeForGuest(id, who) {
    const leaf = deps.findLeaf(id)
    if (!leaf) return
    deps.showToast(t('liveShare.toast.closed', '{{name}} closed {{pane}}.', { name: who, pane: leaf.paneName || leaf.title }), { timeout: 5000 })
    deps.closeLeaf(id, { force: true })
  }

  // A guest asks to close one of your panes: an idle terminal closes (with a
  // notice); an agent, or a terminal where a program runs, waits for your yes.
  async function askClose(req, who) {
    const leaf = deps.findLeaf(req.id)
    const key = `close-${req.id}` // i18n-ignore
    const ask = { kind: 'close', key, guestId: (req.guest && req.guest.id) || null, name: who, paneId: req.id, paneName: leaf ? leaf.paneName || leaf.title : '', detail: null, generation }
    if (!leaf || state.asks.some((a) => a.key === key) || !closeStands(ask)) return
    if (deps.isAgentLeaf(leaf)) ask.detail = t('liveShare.closeAsk.agent', 'Its agent session ends (it can be resumed later from Agent sessions).')
    // A pane on an SSH host or in WSL: what runs there is out of Windows'
    // sight, so Tessel can't tell; you are asked.
    else if (leaf.remoteHostId || leaf.shellId === 'wsl' || leaf.backend === 'ssh') ask.detail = t('liveShare.closeAsk.remote', 'It runs on another system (an SSH host or WSL): Tessel can’t see what runs in it. Closing stops anything running.')
    else {
      const work = await deps.probeRunningWork(req.id)
      // Things changed while it checked (the guest left or lost the right or
      // the project, sharing stopped, the pane closed or moved): nothing is
      // done.
      if (!closeStands(ask)) return
      if (work.unknown) ask.detail = t('liveShare.closeAsk.unknown', 'Tessel could not check whether a command still runs in it. Closing stops anything running.')
      else if (work.running) ask.detail = t('liveShare.closeAsk.running', '{{names}} still runs in it. Closing stops it.', { names: work.names.join(', ') })
    }
    if (!ask.detail) return closeForGuest(req.id, who)
    if (state.asks.some((a) => a.key === key)) return
    state.asks.push(ask)
  }

  // Where a guest's terminal or agent opens: in the project it was asked in
  // (still shared, and one this guest sees), beside its active pane (never in
  // a new project, whatever "Open new panes" says); a project with no pane
  // left has nowhere to put it, and an agent you don't have is not opened.
  function openTarget(spec, guestId) {
    const projectId = spec && spec.project
    const ws = guestSees(guestId, projectId) ? localWs(projectId) : null
    return ws && (ws.activeId && hasLeaf(ws.tree, ws.activeId) ? ws.activeId : firstLeafId(ws.tree))
  }
  // Opens what a guest asked for, with your shell or your agent's command
  // (nothing of the guest's message but the project and the agent's id).
  function openForGuest(spec, who) {
    const agent = spec && spec.kind === 'agent' ? spec.agent : null
    const target = openTarget(spec, spec && spec.guestId)
    if (!target || (agent && !deps.hasAgent(agent))) return
    deps.showToast(
      agent ? t('liveShare.toast.openedAgent', '{{name}} opened {{agent}} in your Tessel.', { name: who, agent: agentLabel(agent) }) : t('liveShare.toast.openedTerminal', '{{name}} opened a terminal in your Tessel.', { name: who }),
      { timeout: 5000 }
    )
    deps.launch(agent ? { kind: 'agent', id: agent } : { kind: 'shell', id: deps.selectedShell() }, target, 'right')
  }
  const agentLabel = (id) => (deps.agentName && deps.agentName(id)) || id

  let openSeq = 0
  function onHostRequest(req) {
    if (!req) return
    // Main called a request off (the guest left, lost that project, or the
    // right to open): its prompt goes; nothing opens.
    if (req.action === 'cancel') {
      const i = state.asks.findIndex((a) => a.kind === 'open' && a.request === req.request)
      if (i >= 0) dropAsk(i)
      return
    }
    const request = typeof req.request === 'string' ? req.request : null
    if (req.action === 'task') return applyTask(req)
    if (!hostSharing()) return requestDone(request)
    const who = (req.guest && req.guest.name) || t('liveShare.guest', 'A guest')
    const guestId = (req.guest && req.guest.id) || null
    if (req.action === 'open' || req.action === 'ask-open') {
      const s = req.spec || {}
      const spec = { kind: s.kind === 'agent' ? 'agent' : 'terminal', agent: s.kind === 'agent' && typeof s.agent === 'string' ? s.agent : null, project: typeof s.project === 'string' ? s.project : null, guestId }
      if (req.action === 'open') {
        // Main checked the right; it is checked here again. Done with it
        // either way.
        if (guestMay(guestId, 'open')) openForGuest(spec, who)
        return requestDone(request)
      }
      // Without the right: you are asked (a few at a time per guest).
      const ask = { kind: 'open', key: `open-${guestId}-${++openSeq}`, request, guestId, name: who, spec, projectName: sharedName(spec.project), agentName: spec.agent ? agentLabel(spec.agent) : null, generation } // i18n-ignore
      if (!openTarget(spec, guestId) || !openStands(ask) || state.asks.filter((a) => a.kind === 'open' && a.guestId === guestId).length >= 3) return requestDone(request)
      state.asks.push(ask)
    } else if (req.action === 'close') {
      askClose(req, who)
    }
  }

  // --- Panes and finished tasks for guests (phase 2b) ------------------------
  // What guests' headers, sidebar and Dashboard show of each shared project's
  // panes (deps.paneAgents: the rows the sidebar has, with each header's
  // model; main makes the guests' copy, sharePanels.js), and each shared
  // project's finished tasks (deps.historyRecords: taskHistory.js; main gives
  // the costs in dollars only to guests with the usage right).
  function paneAgentsNow() {
    return sharedWss().map((ws) => ({ project: ws.id, panes: (deps.paneAgents && deps.paneAgents(ws.id)) || [] }))
  }
  function historyNow() {
    const all = deps.historyRecords ? deps.historyRecords() : []
    const list = Array.isArray(all) ? all : []
    return sharedWss().map((ws) => ({ project: ws.id, records: list.filter((r) => r && r.wsId === ws.id).slice(-500) }))
  }
  // A guest asking to delete a card with its own copy: a notice (never a
  // question that a key you type could answer), whose button opens your usual
  // delete with Cancel first, never over another open question. One ask per
  // guest at a time (DELETE_ASK_MS), none from that guest for a while after
  // your no (DELETE_QUIET_MS); when you look, and again when you answer, the
  // request must still hold (the guest in, with the right to manage tasks,
  // seeing the project; the card there with its copy). -> the guest's code:
  // 'confirm' (you were asked), 'busy' (another ask waits, or you said no
  // lately), 'not-allowed'.
  const DELETE_ASK_MS = 60000
  const DELETE_QUIET_MS = 60000
  const deleteAsks = new Map() // guest id -> { card, project, who, timer }
  const deleteQuiet = new Map() // guest id -> until when its asks are not heard
  function askDelete(guestId, who, card, project) {
    const board = deps.taskBoard
    if (!board || typeof board.removeWithCopy !== 'function' || !guestId) return 'not-allowed'
    const pending = deleteAsks.get(guestId)
    if (pending) return pending.card === card.id ? 'confirm' : 'busy'
    if ((deleteQuiet.get(guestId) || 0) > Date.now()) return 'busy'
    const ask = { card: card.id, title: card.title || '', project, who, timer: null }
    deleteAsks.set(guestId, ask)
    noticeDelete(guestId, ask)
    return 'confirm'
  }
  function noticeDelete(guestId, ask) {
    clearTimeout(ask.timer)
    ask.timer = setTimeout(() => deleteAsks.get(guestId) === ask && deleteAsks.delete(guestId), DELETE_ASK_MS)
    deps.showToast(t('liveShare.toast.deleteAsk', '{{name}} asks to delete the task “{{title}}” with its own copy of the project.', { name: ask.who, title: ask.title }), {
      timeout: DELETE_ASK_MS,
      action: { label: t('liveShare.deleteAsk.review', 'Review…'), run: () => reviewDeleteAsk(guestId, ask) }
    })
  }
  const deleteStands = (guestId, ask) => () =>
    hostSharing() && guestMay(guestId, 'tasks') && guestSees(guestId, ask.project) && !!localWs(ask.project) && !!(deps.taskBoard && deps.taskBoard.tasks().find((x) => x && x.id === ask.card && x.wsId === ask.project && x.worktree && !x.mergedAt))
  async function reviewDeleteAsk(guestId, ask) {
    if (deleteAsks.get(guestId) !== ask) return
    clearTimeout(ask.timer)
    const stands = deleteStands(guestId, ask)
    if (!stands()) {
      deleteAsks.delete(guestId)
      deps.showToast(t('liveShare.toast.deleteAskGone', 'That request no longer stands: nothing was deleted.'), { timeout: 5000 })
      return
    }
    const res = await Promise.resolve()
      .then(() => deps.taskBoard.removeWithCopy(ask.card, ask.who, stands))
      .catch(() => false)
    // Another question was open: the ask waits (its notice again).
    if (res === null) return noticeDelete(guestId, ask)
    deleteAsks.delete(guestId)
    if (res === false) deleteQuiet.set(guestId, Date.now() + DELETE_QUIET_MS)
  }

  // --- Task boards for guests ------------------------------------------------
  // Each shared project's cards (main makes the guests' copy).
  function boardsNow() {
    const board = deps.taskBoard
    if (!board) return []
    const cards = board.tasks()
    return sharedWss().map((ws) => ({ project: ws.id, tasks: cards.filter((x) => x && x.wsId === ws.id) }))
  }
  // A guest's change of a board, checked again here, then once more by main
  // right before it is made (the access model's word: this window's view of
  // the rights may be late), then made; main hears whether it was ({ request,
  // ok, code }). A guest's text that reaches an agent (a card it added or
  // renamed, its answer) is marked as the guest's (guest: its name).
  async function applyTask(req) {
    const answer = (ok, code) => api()?.taskDone?.({ request: req.request, ok, code })
    const board = deps.taskBoard
    const guestId = (req.guest && req.guest.id) || null
    const project = typeof req.project === 'string' ? req.project : null
    const stands = () => !!board && typeof req.request === 'string' && hostSharing() && guestMay(guestId, 'tasks') && guestSees(guestId, project) && !!localWs(project)
    if (!stands()) return answer(false, 'revoked')
    const check = await Promise.resolve(api()?.taskCheck?.(req.request)).catch(() => null)
    if (!check || check.ok !== true || !stands()) return answer(false, 'revoked')
    const who = (req.guest && typeof req.guest.name === 'string' && req.guest.name) || t('liveShare.guest', 'A guest')
    const a = req.args && typeof req.args === 'object' ? req.args : {}
    const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '')
    const card = typeof a.id === 'string' ? board.tasks().find((x) => x && x.id === a.id) : null
    if (req.op !== 'add' && (!card || card.wsId !== project)) return answer(false, 'not-found')
    switch (req.op) {
      case 'add': {
        const title = text(a.title, 300)
        if (!title) return answer(false, 'bad-args')
        board.add({ title, wsId: project, guest: who })
        return answer(true)
      }
      case 'move':
        if (!COLUMNS.includes(a.column)) return answer(false, 'bad-args')
        if (card.column !== a.column) board.move(card.id, a.column)
        return answer(true)
      case 'edit': {
        const title = text(a.title, 300)
        // Only a card not started yet is renamed (as on this computer).
        if (!title || card.column !== 'todo') return answer(false, 'not-allowed')
        board.rename(card.id, title, who)
        return answer(true)
      }
      case 'remove':
        // A card with its own copy of the project: deleting it deletes that
        // copy and its branch with any work not merged yet. Never a question
        // over your work: a notice says who asks, and its button opens your
        // usual delete (askDelete). The guest hears that you were asked.
        if (card.worktree && !card.mergedAt) {
          const code = askDelete(guestId, who, card, project)
          return answer(false, code)
        }
        board.remove(card.id)
        return answer(true)
      case 'answer': {
        const reply = text(a.answer, 4096)
        if (!reply || !card.gate || card.gate.status !== 'pending') return answer(false, 'not-allowed')
        // Without the type right: one of the choices the agent offered only
        // (free text would be typed to the agent).
        const options = Array.isArray(card.gate.options) ? card.gate.options : []
        if (!guestMay(guestId, 'type') && !options.includes(reply)) return answer(false, 'not-allowed')
        board.answer(card.id, reply, who)
        return answer(true)
      }
      default:
        return answer(false, 'bad-args')
    }
  }
  // A change a guest made: said (an agent's instructions changed: said as a
  // warning).
  function onGuestAction(a) {
    if (!hostSharing()) return
    const text = actionText(a)
    if (!text) return
    if (a.flagged) deps.showToast(t('liveShare.toast.actionFlagged', '{{action}} (an agent’s instructions)', { action: text }), { kind: 'error', timeout: 9000 })
    else deps.showToast(text, { timeout: 5000 })
  }

  // Shared projects that are gone from this window: taken out of the share
  // (guests never see another project in their place); all of them gone,
  // sharing stops. A project not found yet after a restart waits until the
  // window has its projects back.
  function checkGone() {
    if (!hostSharing()) return
    const gone = []
    for (const id of sharedIds()) {
      const ws = localWs(id)
      if (ws) seen.set(id, ws.name)
      else if (seen.has(id) || (deps.layoutReady && deps.layoutReady())) gone.push(id)
    }
    if (!gone.length) return
    const a = api()
    if (gone.length >= sharedIds().length) {
      seen.clear()
      a?.stop()
      deps.showToast(t('liveShare.toast.projectClosed', 'You closed the project you shared: Live Share stopped.'), { timeout: 6000 })
      return
    }
    for (const id of gone) {
      const name = seen.get(id)
      seen.delete(id)
      a?.share({ id, shared: false })
      if (name) deps.showToast(t('liveShare.toast.projectGone', 'You closed {{project}}: guests no longer see it.', { project: name }), { timeout: 6000 })
    }
  }

  // --- Guest ---------------------------------------------------------------
  // What this guest may do (a host from before rights: everything).
  const may = (right) => !state.guest.rights || !!state.guest.rights[right]
  // Phase 2c: pages, past conversations, activity (both sides).
  const feeds = createLiveShareFeeds(deps, { api, state, hostSharing, sharedWss, isShared, guestWs })
  // A host pane's chat: 'shared' (the host sends its conversation), 'old-host'
  // (an agent pane of a host whose Tessel does not share conversations yet:
  // the chat view says so) or null (no chat button).
  const chatEntry = (id) => (state.guest.chats || []).find((c) => c.id === id) || null
  // 'unavailable': the host says why it has none (chatWhy: 'agent' |
  // 'none'); the button shows, off, and says it.
  function chatOf(p) {
    if (state.guest.chat) {
      const c = chatEntry(p.id)
      return c ? (c.reason ? 'unavailable' : 'shared') : null
    }
    return p.kind === 'agent' && GUEST_CHAT_AGENTS.includes(p.agentId) ? 'old-host' : null
  }
  const chatWhy = (p) => {
    const c = state.guest.chat ? chatEntry(p.id) : null
    return c && c.reason ? c.reason : null
  }
  // Your view of a pane: your choice, else its terminal (the chat when it has
  // none).
  const viewOf = (id, terminal) => views.get(id) || (terminal ? 'terminal' : 'chat')
  const projectName = (p) => (p && p.layout && p.layout.project) || ''
  // A leaf of the host's shown here, in this project of the host's.
  const leafIn = (id, projectId) => {
    const leaf = id && guestLeaves.get(id)
    return leaf && leaf.liveShare.project === projectId ? leaf : null
  }

  function applyLayout(ws, p) {
    const f = followOf(p.id)
    const session = ws.liveShare.session
    // Your own pick since following last put something on your screen (the
    // watch below may not have seen it yet): not following any more.
    if (followState(p.id).on && f.applied && followKey(ws, p.id) !== f.applied) followState(p.id).on = false
    // The host's browser panes too, with "See my browser pages" (as links
    // opened in your own browser, phase 2c).
    const built = buildGuestTree(p.layout, (l) => (l.view === 'browser' ? feeds.pageLeaf(l, p.id, session) : leafIn(l.id, p.id)), { pages: feeds.showsPages() })
    // Tabs of the host's that are no pane of its layout: its editor tabs, the
    // pages of its side panel.
    const tabs = tabsLeaf(p.id, session)
    const extra = [tabs, ...feeds.sideLeaves(p.id, session)].filter(Boolean)
    // Panes of this computer that opened here (a page, a file) stay, beside
    // the host's.
    const local = localLeaves(ws.tree)
    if (!local.length && !extra.length) ws.tree = built
    else {
      const children = [built, ...extra, ...local].filter(Boolean)
      ws.tree = !children.length ? null : children.length === 1 ? children[0] : reactive({ type: 'split', id: 'ls-split-local', dir: 'row', sizes: children.map(() => 100 / children.length), children })
    }
    const target = hostTarget(ws, p, tabs)
    if (followState(p.id).on && target) {
      // Following: the host's tab, active pane and editor file, never the
      // keyboard (quietFocus: the pane made active does not take it).
      if (target.path && tabs) tabs.activePath = target.path
      if (target.activeId && target.activeId !== ws.activeId) quiet(target.activeId)
      if (target.view !== ws.view && target.view !== 'terminal') quiet(target.view)
      if (target.activeId) ws.activeId = target.activeId
      ws.view = target.view
      f.applied = followKey(ws, p.id)
    } else if (!ws.activeId || !hasLeaf(ws.tree, ws.activeId)) {
      // Your own pick is gone: the host's, or a pane of the host's here.
      ws.activeId = (target && target.activeId) || [...guestLeaves.keys()].find((id) => leafIn(id, p.id) && hasLeaf(ws.tree, id)) || null
      if (followState(p.id).on) f.applied = followKey(ws, p.id)
    }
    // The host's fullscreen pane: followed when the host changes it (you can
    // leave it meanwhile).
    const max = p.layout && leafIn(p.layout.maximizedId, p.id) ? p.layout.maximizedId : null
    if (max !== f.maximized) {
      f.maximized = max
      // Not on screen: applied when that project comes up (pending).
      if (deps.currentWsId() === ws.id) {
        f.pending = false
        if (deps.maximizedId() !== max) deps.setMaximized(max)
      } else f.pending = true
    }
  }

  // Panes following made active just now: their own focus is skipped, so
  // the keyboard stays where you were typing (a key of yours then is your
  // own pick: onGuestKey).
  const QUIET_MS = 1500
  const quietIds = new Map() // pane id -> when
  function quiet(id) {
    quietIds.set(id, Date.now())
    if (quietIds.size > 32) quietIds.delete(quietIds.keys().next().value)
  }
  const quietFocus = (id) => quietIds.has(id) && Date.now() - quietIds.get(id) < QUIET_MS
  // A key you press in a host's project while your screen follows the
  // host's: your own pick (following stops), in the pane you typed in.
  function onGuestKey(e) {
    if (!e || ['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock'].includes(e.key)) return
    const ws = deps.currentWs()
    if (!isGuestWs(ws) || ws.liveShare.session !== state.guest.session) return
    const fs = state.follow[ws.liveShare.project]
    if (!fs || !fs.on) return
    fs.on = false
    const el = e.target && typeof e.target.closest === 'function' ? e.target.closest('[data-pane-id]') : null
    const id = el ? el.getAttribute('data-pane-id') : null
    if (id && id !== ws.activeId && hasLeaf(ws.tree, id)) ws.activeId = id
  }

  // What the host shows in a project, as this window can show it: { activeId,
  // view, path } (view: 'terminal' or the id of a tab here; path: the editor
  // file, for its editor tabs), or null. A tab of the host's you do not have
  // here (a page you may not see, a file its Files tab hides from you): its
  // grid.
  function hostTarget(ws, p, tabs) {
    const L = p.layout
    if (!L) return null
    const inTree = (id) => !!id && hasLeaf(ws.tree, id)
    if (L.shown && L.shown !== 'terminal') {
      const l = layoutLeaf(L.tree, L.shown)
      if (l && l.view === 'browser' && inTree(L.shown)) return { activeId: L.shown, view: L.shown, path: null }
      if (l && l.view === 'editor' && tabs && inTree(tabs.id)) {
        const got = state.tabs[p.id]
        const path = got && got.active ? lsharePath(p.id, got.active) : null
        if (path && (tabs.files || []).some((x) => samePath(x.path, path))) return { activeId: tabs.id, view: tabs.id, path }
      }
    }
    const grid = (id) => inTree(id) && !!guestLeaves.get(id)
    const activeId = grid(L.activeId) ? L.activeId : grid(ws.activeId) ? ws.activeId : [...guestLeaves.keys()].find((id) => leafIn(id, p.id) && hasLeaf(ws.tree, id)) || null
    return { activeId, view: 'terminal', path: null }
  }
  // Your screen in a host's project, as following compares it.
  function followKey(ws, project) {
    const tabs = tabsLeaves.get(project)
    return JSON.stringify([ws.activeId || null, ws.view || null, tabs ? tabs.activePath || null : null])
  }

  // The host's editor tabs of a project, as one editor tab here (the same
  // leaf each time): its files the host's open ones you may see, minus the
  // ones you hid; one you are editing stays while it has unsaved changes.
  // null when there are none.
  function tabsLeaf(project, session) {
    const got = state.tabs[project]
    let leaf = tabsLeaves.get(project)
    if (leaf && leaf.liveShare.session !== session) {
      tabsLeaves.delete(project)
      leaf = null
    }
    const hidden = hiddenTabs.get(project) || new Set()
    // The host's tabs you closed here since: hidden from now on.
    if (leaf) {
      const open = new Set((leaf.files || []).map((x) => x.path))
      for (const path of leaf.liveShare.sent || []) if (!open.has(path)) hidden.add(path)
      hiddenTabs.set(project, hidden)
    }
    const wanted = (got ? got.tabs : []).map((rel) => lsharePath(project, rel)).filter((path) => path && !hidden.has(path))
    const dirty = (path) => !!(docs[pathKey(path)] && docs[pathKey(path)].dirty)
    const kept = leaf ? (leaf.files || []).filter((x) => !wanted.includes(x.path) && dirty(x.path)) : []
    if (!wanted.length && !kept.length) {
      if (leaf) tabsLeaves.delete(project)
      return null
    }
    if (!leaf) {
      const host = state.guest.host || ''
      leaf = reactive({
        type: 'leaf',
        kind: 'editor',
        id: `pane-lstabs-${project}`.slice(0, 80), // i18n-ignore
        title: t('app.pane.editor', 'Editor'),
        files: [],
        activePath: null,
        broadcast: false,
        reveal: null,
        backend: 'liveshare',
        liveShare: { session, project, host, hostTabs: true, sent: [] }
      })
      tabsLeaves.set(project, leaf)
    }
    const byPath = new Map((leaf.files || []).map((x) => [x.path, x]))
    leaf.files = [...wanted.map((path) => byPath.get(path) || { path }), ...kept]
    leaf.liveShare.sent = wanted
    if (!leaf.files.some((x) => samePath(x.path, leaf.activePath))) leaf.activePath = leaf.files[0].path
    return leaf
  }

  // Every project of the host's shown, built again from its layout.
  function applyAll(session) {
    const s = state.guest
    if (s.session !== session) return
    for (const p of s.projects || []) {
      const ws = guestWs(session, p.id)
      if (ws) applyLayout(ws, p)
    }
  }

  // The host's pane started again (restarted, moved to another of its
  // projects, or the connection came back): its new screen is taken
  // (attachPty waits for it) and given to a new terminal here (gen,
  // SplitNode's key), never the old screen; it shows in its project from then.
  async function reattachGuestPane(p, leaf, session) {
    const gen = p.gen || 0
    attaching.add(p.id)
    try {
      const a = await window.shellApi.attachPty(p.id).catch(() => null)
      if (!a || !a.ok || state.guest.session !== session || guestLeaves.get(p.id) !== leaf) return
      deps.dropBuffer(p.id)
      deps.seedBuffer(p.id, a.buffer)
      leaf.exitedAtStart = !!a.exited
      leaf.gen = gen
      const latest = state.guest.panes.find((x) => x.id === p.id)
      leaf.liveShare.project = (latest && latest.project) || p.project || null
    } finally {
      attaching.delete(p.id)
    }
    applyAll(session)
    // Restarted again meanwhile: once more.
    const now = state.guest.panes.find((x) => x.id === p.id)
    if (now && (now.gen || 0) !== (leaf.gen || 0) && state.guest.session === session && guestLeaves.get(p.id) === leaf) reattachGuestPane(now, leaf, session)
  }

  async function attachGuestPane(p, session) {
    attaching.add(p.id)
    try {
      const a = await window.shellApi.attachPty(p.id).catch(() => null)
      if (!a || !a.ok || state.guest.session !== session || state.guest.state !== 'joined') return
      deps.seedBuffer(p.id, a.buffer)
      const leaf = reactive({
        type: 'leaf',
        id: p.id,
        shellId: 'liveshare',
        shellName: (a.shell && a.shell.name) || t('liveShare.title', 'Live Share'),
        title: p.title || (a.shell && a.shell.name) || t('liveShare.title', 'Live Share'),
        kind: 'shell',
        agentId: null,
        agentCommand: null,
        accent: p.accent || null,
        worktree: null,
        backend: 'liveshare',
        pid: null,
        startDir: null,
        sessionId: null,
        // The host's pane: its project, its size (the terminal shows it at
        // that size), what it runs there, and whether you may type in it.
        liveShare: { session, project: p.project || null, cols: p.cols || 0, rows: p.rows || 0, kind: p.kind, agentId: p.agentId || null, canType: may('type'), host: state.guest.host || '', terminal: true, chat: chatOf(p), chatWhy: chatWhy(p), view: 'terminal', textSize: textSizes.get(p.id) || 'fit' },
        // A new terminal here each time the host's pane starts again (or the
        // connection came back): SplitNode's key.
        gen: p.gen || 0,
        launchedAt: Date.now(),
        exitedAtStart: !!a.exited,
        restoredText: '',
        broadcast: false
      })
      leaf.attached = true
      leaf.liveShare.view = leaf.liveShare.chat && leaf.liveShare.chat !== 'unavailable' ? viewOf(p.id, true) : 'terminal'
      guestLeaves.set(p.id, leaf)
      applyAll(session)
    } finally {
      attaching.delete(p.id)
    }
    // The host's pane started again (or moved) while it was being attached:
    // once more, with its new screen.
    const leaf = guestLeaves.get(p.id)
    const now = state.guest.panes.find((x) => x.id === p.id)
    if (leaf && now && (now.gen || 0) !== (leaf.gen || 0) && state.guest.session === session) reattachGuestPane(now, leaf, session)
  }

  // A Live Share project that goes (the host no longer shares it with you, or
  // the session ended): panes of this computer that opened in it go to a
  // project of yours.
  function dropGuestWs(ws) {
    const local = localLeaves(ws.tree)
    ws.tree = null
    if (local.length) deps.adoptLeaves(local)
    ws.activeId = null
    if (ws.liveShare) {
      follow.delete(ws.liveShare.project)
      delete state.follow[ws.liveShare.project]
      delete state.tabs[ws.liveShare.project]
      tabsLeaves.delete(ws.liveShare.project)
      hiddenTabs.delete(ws.liveShare.project)
    }
    deps.removeWorkspace(ws.id, true, true)
  }

  // A pane the host has in chat mode: no terminal here, its conversation
  // shown as a chat (and a note in its terminal view).
  function chatLeaf(c, session) {
    const host = state.guest.host || ''
    return reactive({
      type: 'leaf',
      id: c.id,
      shellId: 'liveshare',
      shellName: host || t('liveShare.title', 'Live Share'),
      title: c.title || t('liveShare.title', 'Live Share'),
      kind: 'shell',
      agentId: null,
      agentCommand: null,
      accent: c.accent || null,
      worktree: null,
      backend: 'liveshare',
      pid: null,
      startDir: null,
      sessionId: null,
      liveShare: { session, project: c.project || null, cols: 0, rows: 0, kind: 'agent', agentId: c.agentId || null, canType: false, host, terminal: false, chat: 'shared', view: viewOf(c.id, false) },
      gen: 0,
      launchedAt: Date.now(),
      exitedAtStart: false,
      restoredText: '',
      broadcast: false
    })
  }

  function syncGuest(s) {
    const projects = s.projects || []
    const first = !guestWss(s.session).length
    // The projects the host no longer shares with you go.
    for (const ws of guestWss(s.session)) {
      if (projects.some((p) => p.id === ws.liveShare.project)) continue
      const name = ws.liveShare.projectName || ''
      dropGuestWs(ws)
      if (name) deps.showToast(t('liveShare.toast.hostRemovedProject', '{{host}} no longer shares {{project}} with you.', { host: s.host || '?', project: name }), { timeout: 6000 })
    }
    for (const p of projects) {
      let ws = guestWs(s.session, p.id)
      const name = projectName(p)
      if (!ws) {
        ws = deps.makeWorkspace(name ? guestWsName(name, s.host) : t('liveShare.wsName', '{{host}} · Live Share', { host: s.host || '?' }))
        ws.liveShare = { session: s.session, host: s.host, project: p.id, projectName: name }
        deps.workspaces().push(ws)
        // Your first one opens; one shared with you later is said.
        if (first && p === projects[0]) deps.selectWorkspace(ws.id)
        else if (!first) deps.showToast(t('liveShare.toast.hostAddedProject', '{{host}} now shares {{project}} with you.', { host: s.host || '?', project: name || '?' }), { timeout: 6000 })
      }
      // (Its name stays while the host's layout of it is not there yet.)
      if (name) {
        ws.name = guestWsName(name, s.host)
        ws.liveShare.projectName = name
      }
    }
    const ids = new Set(s.panes.map((p) => p.id))
    // The host's panes in chat mode (no terminal).
    const chatOnly = new Map((s.chat ? s.chats || [] : []).filter((c) => c.terminal === false && !ids.has(c.id)).map((c) => [c.id, c]))
    for (const [id, leaf] of [...guestLeaves]) {
      // A pane that went to chat mode or came back to a terminal on the host
      // is a new leaf here (a terminal, or none).
      const kept = leaf.liveShare.terminal === false ? chatOnly.has(id) : ids.has(id)
      if (kept && leaf.liveShare.session === s.session) continue
      guestLeaves.delete(id)
      deps.dropBuffer(id)
    }
    for (const c of chatOnly.values()) {
      const leaf = guestLeaves.get(c.id)
      if (!leaf) guestLeaves.set(c.id, chatLeaf(c, s.session))
      else {
        if (c.title) leaf.title = c.title
        leaf.accent = c.accent || null
        leaf.liveShare.project = c.project || null
        leaf.liveShare.agentId = c.agentId || null
      }
    }
    for (const p of s.panes) {
      const leaf = guestLeaves.get(p.id)
      if (leaf) {
        if (p.title) leaf.title = p.title
        leaf.accent = p.accent || null
        if (p.cols > 0 && p.rows > 0) {
          leaf.liveShare.cols = p.cols
          leaf.liveShare.rows = p.rows
        }
        leaf.liveShare.canType = may('type')
        // Its chat (the host may start or stop sharing its conversation).
        leaf.liveShare.chat = chatOf(p)
        leaf.liveShare.chatWhy = chatWhy(p)
        leaf.liveShare.view = leaf.liveShare.chat && leaf.liveShare.chat !== 'unavailable' ? viewOf(p.id, true) : 'terminal'
        if ((p.gen || 0) !== (leaf.gen || 0)) {
          if (!attaching.has(p.id)) reattachGuestPane(p, leaf, s.session)
        } else if (p.project && leaf.liveShare.project !== p.project) leaf.liveShare.project = p.project
      } else if (!attaching.has(p.id)) attachGuestPane(p, s.session)
    }
    // The host's browser panes and the projects' activity that are no longer
    // there go (phase 2c).
    const pageIds = new Set()
    const walkPages = (n) => {
      if (!n) return
      if (n.type === 'leaf') n.view === 'browser' && pageIds.add(n.id)
      else (n.children || []).forEach(walkPages)
    }
    for (const p of projects) walkPages(p.layout && p.layout.tree)
    feeds.syncPages(pageIds)
    feeds.syncProjects(new Set(projects.map((p) => p.id)))
    applyAll(s.session)
  }

  // --- What the panels may do in the host's projects ---------------------------
  // Each project the host shows you: your rights there (edit, git, tasks),
  // or why its files are not there (a host whose Tessel does not share them).
  // A project you no longer see: no access (its tabs stay, read-only).
  let accessSession = null
  const accessKnown = {} // projects told to the panels in this session
  function syncAccess(s) {
    if (s.session !== accessSession) {
      forgetLshareAccess()
      for (const k of Object.keys(state.boards)) delete state.boards[k]
      endPanels()
      accessSession = s.session
    }
    const rights = s.rights || {}
    const files = Array.isArray(s.features) && s.features.includes('files')
    const seen = new Set()
    for (const p of s.projects || []) {
      seen.add(p.id)
      setLshareAccess(p.id, { edit: rights.edit === true, git: rights.git === true, tasks: rights.tasks === true, state: files ? 'ok' : 'outdated-host' })
    }
    for (const id of Object.keys(accessKnown)) if (!seen.has(id)) setLshareAccess(id, { edit: false, git: false, tasks: false, state: 'no-access' })
    for (const id of seen) accessKnown[id] = true
    for (const id of Object.keys(state.boards)) if (!seen.has(id)) delete state.boards[id]
    // A project no longer seen: its panes' states and its history go.
    for (const [id, p] of Object.entries(state.paneAgents)) if (!seen.has(p.project)) delete state.paneAgents[id]
    for (const id of Object.keys(state.histories)) if (!seen.has(id)) delete state.histories[id]
    for (const id of [...childSources.keys()]) if (!paneAgent(id)) childSources.delete(id)
    if (state.review && !seen.has(state.review.project)) state.review = null
    // The usage right taken away: its readings go at once.
    if (!(s.rights && s.rights.usage === true)) state.hostUsage = null
  }
  function endAccess() {
    endLshareSession()
    for (const k of Object.keys(accessKnown)) delete accessKnown[k]
    for (const k of Object.keys(state.boards)) delete state.boards[k]
    endPanels()
  }

  // --- The host's task boards ---------------------------------------------------
  // The Tasks tab of one of the host's projects: its board (a source,
  // taskBoardSource.js), with the changes you may make (the host checks each
  // again). Built anew as what it reads changes.
  function taskSource(project) {
    const s = state.guest
    if (!project) return null
    const inSession = s.state === 'joined' || s.state === 'reconnecting'
    const b = state.boards[project]
    const speaks = Array.isArray(s.features) && s.features.includes('tasks')
    const st = !inSession ? 'ended' : !(s.projects || []).some((p) => p.id === project) ? 'no-access' : s.state === 'joined' && !speaks ? 'outdated-host' : 'ok'
    const may = s.state === 'joined' && st === 'ok' && !!(s.rights && s.rights.tasks === true)
    const run = (op, args) => changeTask(project, op, args)
    // A card in Review with its own copy: its branch's changes, read only
    // (a host that speaks it).
    const reviews = s.state === 'joined' && st === 'ok' && Array.isArray(s.features) && s.features.includes('history')
    return {
      tasks: b ? b.tasks : [],
      loaded: !!b || st !== 'ok',
      state: st,
      ...(reviews ? { review: (id) => openReview(project, id) } : {}),
      ...(may
        ? {
            add: ({ title } = {}) => run('add', { title }),
            move: (id, column) => run('move', { id, column }),
            edit: (id, { title } = {}) => run('edit', { id, title }),
            remove: (id) => run('remove', { id }),
            answer: (id, reply) => run('answer', { id, answer: reply })
          }
        : {})
    }
  }
  async function changeTask(project, op, args) {
    const r = await Promise.resolve(api()?.task?.({ op, project, args })).catch(() => null)
    if (r && r.ok) return true
    // A card with its own copy of the project: the host is asked to confirm
    // its delete (its copy and branch go with it).
    if (r && r.code === 'confirm') {
      deps.showToast(t('liveShare.toast.taskConfirm', '{{host}} was asked to confirm: this task has its own copy of the project, deleted with it.', { host: state.guest.host || '?' }), { timeout: 6000 })
      return false
    }
    deps.showToast(t('liveShare.toast.taskFailed', '{{host}} did not make this change: {{reason}}', { host: state.guest.host || '?', reason: taskFailText(r && r.code) }), { kind: 'error', timeout: 6000 })
    return false
  }
  function taskFailText(code) {
    if (code === 'forbidden' || code === 'revoked') return t('liveShare.taskFail.rights', 'you can no longer manage its tasks.')
    if (code === 'not-found') return t('liveShare.taskFail.missing', 'this task is no longer on its board.')
    if (code === 'not-allowed') return t('liveShare.taskFail.notAllowed', 'this task can no longer be changed that way.')
    if (code === 'remote-project') return t('liveShare.taskFail.remote', 'the files of this project are on the host’s SSH server and aren’t shared.')
    if (code === 'no-project') return t('liveShare.taskFail.noProject', 'you no longer have access to this project.')
    if (code === 'offline') return t('liveShare.taskFail.offline', 'the connection to the host is down.')
    if (code === 'bad-op') return t('liveShare.taskFail.outdated', 'the host needs to update Tessel.')
    if (code === 'busy') return t('liveShare.taskFail.busy', 'too many changes at once: wait a moment.')
    return t('liveShare.taskFail.failed', 'it could not be done.')
  }
  // The host's board of the project on screen, followed while it is.
  let followedBoard = null
  function followBoard(project) {
    const a = api()
    if (project === followedBoard || !a || typeof a.subscribe !== 'function') return
    if (followedBoard) Promise.resolve(a.subscribe({ topic: 'tasks', project: followedBoard, on: false })).catch(() => {})
    followedBoard = project
    if (!project) return
    Promise.resolve(a.subscribe({ topic: 'tasks', project, on: true }))
      .then((r) => {
        if (r && r.ok && r.data && Array.isArray(r.data.tasks) && followedBoard === project) state.boards[project] = { tasks: r.data.tasks }
      })
      .catch(() => {})
  }
  function onPush(m) {
    if (!m) return
    // Phase 2c's news (the activity of a project followed, its pages as
    // links: its layout here again).
    if (feeds.onPush(m)) {
      if (m.topic === 'links') applyAll(state.guest.session)
      return
    }
    // The host's usage (null: the right was taken away).
    if (m.topic === 'usage') {
      state.hostUsage = m.data && Array.isArray(m.data.providers) ? m.data : null
      return
    }
    if (typeof m.project !== 'string' || !m.data || !(state.guest.projects || []).some((p) => p.id === m.project)) return
    if (m.topic === 'agents' && Array.isArray(m.data.panes)) return setPaneAgents(m.project, m.data.panes)
    // The host's editor tabs of a project: its layout here again.
    if (m.topic === 'tabs' && Array.isArray(m.data.tabs)) {
      state.tabs[m.project] = { tabs: m.data.tabs.slice(), active: typeof m.data.active === 'string' ? m.data.active : null }
      return applyAll(state.guest.session)
    }
    if (m.topic !== 'tasks' || !Array.isArray(m.data.tasks)) return
    state.boards[m.project] = { tasks: m.data.tasks }
  }

  // --- The host's panes, sub-agents, usage, task history, review (phase 2b) ----
  // What each of the host's panes runs and how it is, as its header shows it
  // (main follows every project's; this window's pane ids): its header, the
  // sidebar and the Dashboard show it (paneAgent).
  function setPaneAgents(project, panes) {
    const ids = new Set()
    for (const p of panes) {
      if (!p || typeof p.id !== 'string') continue
      ids.add(p.id)
      const next = { ...p, project }
      const was = state.paneAgents[p.id]
      if (!was || JSON.stringify(was) !== JSON.stringify(next)) state.paneAgents[p.id] = next
    }
    for (const [id, p] of Object.entries(state.paneAgents)) if (p.project === project && !ids.has(id)) delete state.paneAgents[id]
  }
  const paneAgent = (id) => (typeof id === 'string' && Object.hasOwn(state.paneAgents, id) ? state.paneAgents[id] : null)

  // A host pane's sub-agents, for its header's list (AgentChildren's source):
  // asked of the host (it reads them from the pane's conversation, which
  // stays there), the last answer kept CHILDREN_MS so several readers never
  // ask more often. One source per pane (a new one would empty the list).
  const CHILDREN_MS = 8000
  const childSources = new Map()
  function childrenSource(id) {
    const a = api()
    const info = paneAgent(id)
    if (!a || typeof a.request !== 'function' || !info || !info.children) return null
    let src = childSources.get(id)
    if (src) return src
    let last = { at: 0, items: null, pending: null }
    src = {
      read() {
        if (last.pending) return last.pending
        if (last.items && Date.now() - last.at < CHILDREN_MS) return Promise.resolve(last.items)
        const project = paneAgent(id) ? paneAgent(id).project : null
        if (!project) return Promise.resolve([])
        const pending = Promise.resolve(a.request({ op: 'agents.children', project, args: { pane: id } }))
          .catch(() => null)
          .then((r) => {
            const items = r && r.ok && r.data && Array.isArray(r.data.items) ? r.data.items : last.items || []
            last = { at: Date.now(), items, pending: null }
            return items
          })
        last.pending = pending
        return pending
      }
    }
    childSources.set(id, src)
    return src
  }

  // The host's usage, for a guest with the usage right (UsageMenu's "<host>'s
  // usage"): null otherwise.
  const hostUsage = () => ((state.guest.state === 'joined' || state.guest.state === 'reconnecting') && state.guest.rights && state.guest.rights.usage === true ? state.hostUsage : null)

  // The task history of one of the host's projects (TaskHistoryPanel's
  // source): read while its tab is shown, every HISTORY_MS. Costs in dollars
  // only when the host says this guest may see them.
  const HISTORY_MS = 30000
  let historyTimer = 0
  let historyFollowed = null
  function followHistory(project) {
    clearInterval(historyTimer)
    historyTimer = 0
    historyFollowed = project
    if (!project) return
    loadHistory(project)
    historyTimer = setInterval(() => historyFollowed === project && loadHistory(project), HISTORY_MS)
  }
  async function loadHistory(project, again = true) {
    const a = api()
    if (!a || typeof a.request !== 'function') return
    const r = await Promise.resolve(a.request({ op: 'history.list', project })).catch(() => null)
    if (!(state.guest.projects || []).some((p) => p.id === project)) return
    if (r && r.ok && r.data && Array.isArray(r.data.records)) {
      state.histories[project] = { records: r.data.records, usd: r.data.usd === true, error: '', code: null, at: Date.now() }
      return
    }
    // The usage right changed while it was on its way: asked again (once).
    if (r && r.code === 'revoked' && again) return loadHistory(project, false)
    const was = state.histories[project]
    state.histories[project] = { records: was ? was.records : [], usd: !!(was && was.usd), error: historyFailText(r && r.code), code: (r && r.code) || 'offline', at: was ? was.at : 0 }
  }
  function historyFailText(code) {
    if (code === 'offline') return t('liveShare.panels.offline', 'the connection to the host is down.')
    if (code === 'busy') return t('liveShare.panels.busy', 'the host is busy: it is read again in a moment.')
    return t('liveShare.panels.failed', 'the host could not read it.')
  }
  function historySource(project) {
    const s = state.guest
    if (!project) return null
    const inSession = s.state === 'joined' || s.state === 'reconnecting'
    const h = state.histories[project]
    const speaks = Array.isArray(s.features) && s.features.includes('history')
    const st = !inSession ? 'ended' : !(s.projects || []).some((p) => p.id === project) || (h && h.code === 'no-project') ? 'no-access' : (s.state === 'joined' && !speaks) || (h && h.code === 'bad-op') ? 'outdated-host' : 'ok'
    return { records: h ? h.records : [], loaded: !!h || st !== 'ok', error: h && h.error && !h.records.length ? h.error : '', state: st, usd: !!(h && h.usd) }
  }

  // A task branch's review (ReviewPanel's source, read only): what the host
  // reads of it, in the shape the panel shows; merging, discarding,
  // committing, pushing and asking for changes stay the host's.
  function openReview(project, taskId) {
    state.review = { project, taskId }
  }
  function closeReview() {
    state.review = null
  }
  function reviewFailText(code) {
    if (code === 'not-found') return t('liveShare.review.notFound', 'This task’s branch could not be read on the host.')
    if (code === 'remote-project') return t('liveShare.access.remote', 'The files of this project are on the host’s SSH server and aren’t shared with guests.')
    if (code === 'no-project' || code === 'forbidden' || code === 'revoked') return t('liveShare.review.noAccess', 'You no longer have access to this project.')
    if (code === 'bad-op') return t('liveShare.review.outdated', 'The host needs to update Tessel to show this.')
    if (code === 'offline') return t('liveShare.panels.offline', 'the connection to the host is down.')
    if (code === 'busy') return t('liveShare.panels.busy', 'the host is busy: it is read again in a moment.')
    return t('liveShare.panels.failed', 'the host could not read it.')
  }
  function reviewSource() {
    const r = state.review
    const s = state.guest
    if (!r || s.state !== 'joined' || !(s.projects || []).some((p) => p.id === r.project)) return null
    const board = state.boards[r.project]
    const task = board && board.tasks.find((x) => x.id === r.taskId)
    if (!task) return null
    const host = s.host || '?'
    const ask = (op, args) => Promise.resolve(api()?.request?.({ op, project: r.project, args })).catch(() => null)
    return {
      task,
      host,
      // Its own place for the panel's viewed marks and comments (apart from
      // this computer's tasks).
      key: `${s.session}:${r.project}:${r.taskId}`, // i18n-ignore
      async info() {
        const res = await ask('review.info', { task: r.taskId })
        if (!res || !res.ok || !res.data) return { ok: false, error: reviewFailText(res && res.code) }
        // What only the host's own review checks (its folder, its merge) is
        // not said here: the guest cannot merge.
        const blocker = res.data.mergeCheck === 'failed' ? t('liveShare.review.checkFailed', '{{host}}’s Tessel could not check this branch for conflicts.', { host }) : t('liveShare.review.hostOnly', 'Only {{host}} can merge this task.', { host })
        return { ok: true, ...res.data, dirtyOverlap: [], rootBranch: res.data.target, merging: false, blocker }
      },
      async diff(file) {
        const res = await ask('review.diff', { task: r.taskId, file })
        return res && res.ok && res.data ? { ok: true, text: res.data.text, truncated: !!res.data.truncated } : { ok: false, error: reviewFailText(res && res.code) }
      }
    }
  }
  // What main already has of the host's panes and usage (this window
  // reloaded during a session).
  function askGuestFeeds() {
    const a = api()
    if (!a || typeof a.subscribe !== 'function') return
    for (const p of state.guest.projects || []) {
      Promise.resolve(a.subscribe({ topic: 'agents', project: p.id, on: true }))
        .then((r) => r && r.ok && r.data && Array.isArray(r.data.panes) && setPaneAgents(p.id, r.data.panes))
        .catch(() => {})
      for (const topic of ['tabs', 'links'])
        Promise.resolve(a.subscribe({ topic, project: p.id, on: true }))
          .then((r) => r && r.ok && r.data && onPush({ topic, project: p.id, data: r.data }))
          .catch(() => {})
    }
    Promise.resolve(a.subscribe({ topic: 'usage', on: true }))
      .then((r) => {
        if (r && r.ok && r.data && Array.isArray(r.data.providers)) state.hostUsage = r.data
      })
      .catch(() => {})
  }
  function endPanels() {
    for (const k of Object.keys(state.paneAgents)) delete state.paneAgents[k]
    for (const k of Object.keys(state.histories)) delete state.histories[k]
    state.hostUsage = null
    state.review = null
    childSources.clear()
    followHistory(null)
  }

  function endGuest(s) {
    endAccess()
    feeds.endGuest()
    followedBoard = null
    for (const id of guestLeaves.keys()) deps.dropBuffer(id)
    guestLeaves.clear()
    views.clear()
    textSizes.clear()
    // Its panes are not terminals of this computer: nothing to stop here.
    for (const ws of deps.workspaces().filter((w) => w.liveShare)) dropGuestWs(ws)
    follow.clear()
    tabsLeaves.clear()
    hiddenTabs.clear()
    for (const k of Object.keys(state.follow)) delete state.follow[k]
    for (const k of Object.keys(state.tabs)) delete state.tabs[k]
    if (s.reason && s.reason !== 'left') deps.showToast(t('liveShare.toast.ended', 'Live Share with {{host}} ended: {{reason}}', { host: s.host || '?', reason: endReason(s.reason) }), { kind: 'error', timeout: 9000 })
  }

  function onGuest(s) {
    if (!s) return
    const was = state.guest.state
    const wasIn = was === 'joined' || was === 'reconnecting'
    const before = JSON.stringify(state.guest.rights || null)
    Object.assign(state.guest, { rights: null, code: null, projects: [], chat: false, chats: [], agents: null, features: [] }, s)
    if (s.state === 'joined' || s.state === 'reconnecting') syncAccess(state.guest)
    if (s.state === 'joined') {
      // The host changed what you may do (not the first word on it): said once.
      if (was === 'joined' && before !== 'null' && JSON.stringify(s.rights || null) !== before) deps.showToast(`${t('liveShare.toast.rights', '{{host}} changed what you can do.', { host: s.host || '?' })} ${rightsText(s.rights)}`, { timeout: 6000 })
      if (was === 'reconnecting') deps.showToast(t('liveShare.toast.reconnected', 'Back in {{host}}’s Live Share.', { host: s.host || '?' }), { timeout: 4000 })
      syncGuest(state.guest)
    } else if (s.state === 'reconnecting') {
      // The projects stay, their panes view only, until the connection is back.
      if (was !== 'reconnecting') deps.showToast(t('liveShare.toast.reconnecting', 'Connection to {{host}} lost: reconnecting…', { host: s.host || '?' }), { timeout: 6000 })
      for (const leaf of guestLeaves.values()) leaf.liveShare.canType = false
    } else if (s.state === 'ended' || (s.state === 'off' && wasIn)) endGuest(s)
  }

  // The host's agents you may ask for ([{ id, name }]), or null: a host from
  // before that list (its own agents can't be offered; only with the right
  // to open, as before).
  const hostAgents = () => (Array.isArray(state.guest.agents) ? state.guest.agents : null)
  // What the "+" menu offers in a Live Share project of this session: the
  // host's shell and agents ({ host, agents, canOpen }); null elsewhere, or
  // for a host from before that list.
  function hostMenu(ws = deps.currentWs()) {
    if (!isGuestWs(ws) || state.guest.state !== 'joined' || ws.liveShare.session !== state.guest.session) return null
    const agents = hostAgents()
    if (!agents) return null
    return { host: state.guest.host || '?', agents: agents.map((a) => ({ id: a.id, name: a.name || a.id })), canOpen: may('open') }
  }

  // A new terminal or agent in a Live Share project opens on the host, in
  // that project: at once with the right to open, else the host is asked
  // (a host from before asking: only with the right).
  async function openOnHost(spec, ws = deps.currentWs()) {
    if (state.guest.state !== 'joined') return
    const host = state.guest.host || '?'
    const noOpen = () => deps.showToast(t('liveShare.toast.noOpen', '{{host}} has not let you open terminals or agents.', { host }), { timeout: 5000 })
    if (!may('open') && !hostAgents()) return noOpen()
    const project = ws && ws.liveShare && ws.liveShare.session === state.guest.session ? ws.liveShare.project : null
    if (!project) return
    const r = await Promise.resolve(api()?.open({ ...spec, project })).catch(() => null)
    if (r && r.ok) deps.showToast(r.asked ? t('liveShare.toast.openAsked', 'Asked {{host}} to open it: it opens once they say yes.', { host }) : t('liveShare.toast.opening', 'Opening it on {{host}}’s computer…', { host }), { timeout: r.asked ? 5000 : 3000 })
    else if (r && r.reason === 'rights') noOpen()
    else if (r && r.reason === 'agent') noAgent()
    else if (r && r.reason === 'project') deps.showToast(t('liveShare.toast.noProject', '{{host}} no longer shares this project with you.', { host }), { timeout: 5000 })
    else deps.showToast(t('liveShare.toast.openFailed', 'It could not be asked of {{host}}: the connection may be down.', { host }), { kind: 'error', timeout: 5000 })
  }
  function noAgent() {
    deps.showToast(t('liveShare.toast.noAgent', '{{host}} does not have that agent.', { host: state.guest.host || '?' }), { timeout: 5000 })
  }

  // Something this computer would run (a tool, a session, an SSH connection)
  // asked for in a Live Share project: not there.
  function notHere() {
    deps.showToast(t('liveShare.notHere', 'This runs on your computer: open it in one of your projects (a Live Share project shows the host’s panes).'), { timeout: 6000 })
  }

  // Whether you may ask the host to close its panes (else a notice).
  function canClose() {
    if (may('close')) return true
    deps.showToast(t('liveShare.toast.noClose', '{{host}} has not let you close their panes.', { host: state.guest.host || '?' }), { timeout: 5000 })
    return false
  }

  // Asks the host to close one of its panes (main: guestKill). Nothing goes
  // here: the pane leaves when the host closed it (the host may keep it).
  function requestClose(id, name) {
    if (state.guest.state !== 'joined' || !guestLeaves.has(id) || !canClose()) return
    deps.killPty(id)
    deps.showToast(t('liveShare.toast.closeAsked', 'Asked {{host}} to close {{pane}}.', { host: state.guest.host || '?', pane: name || '?' }), { timeout: 4000 })
  }

  function onNotice(n) {
    if (n && n.code === 'limit') deps.showToast(t('liveShare.toast.limit', '{{host}}’s Tessel limits how often guests open or close panes. Wait a minute.', { host: state.guest.host || '?' }), { timeout: 6000 })
    else if (n && n.code === 'agent') noAgent()
  }

  function leave() {
    api()?.leave()
  }

  // Your own view of a host's pane: its chat or its terminal, on your screen
  // only. Nothing goes to the host (its pane, its mode, its terminal and its
  // agent stay as they are); remembered for the session. -> done
  function setGuestView(id, view) {
    const leaf = guestLeaves.get(id)
    if (!leaf || !leaf.liveShare || (view !== 'chat' && view !== 'terminal')) return false
    if (view === 'chat' && (!leaf.liveShare.chat || leaf.liveShare.chat === 'unavailable')) return false
    leaf.liveShare.view = view
    views.set(id, view)
    return true
  }

  // Your own text size for a host's terminal in its pane: 'fit' (all of it,
  // larger or smaller text), 'width' (as large as its columns allow) or
  // 'normal' (your usual size). On your screen only: nothing goes to the
  // host; remembered for the session. -> done
  function setGuestTextSize(id, size) {
    const leaf = guestLeaves.get(id)
    if (!leaf || !leaf.liveShare || !LS_TEXT_SIZES.includes(size)) return false
    leaf.liveShare.textSize = size
    textSizes.set(id, size)
    return true
  }

  // A host pane's conversation, read only, for its chat view (the shape of
  // shellApi.transcriptView: open, close, onEvent). null: not available.
  const CHAT_FIRST_MS = 15000
  function onChat(fn) {
    chatListeners.add(fn)
    return () => chatListeners.delete(fn)
  }
  // The first word on a conversation (main has none yet): up to CHAT_FIRST_MS.
  function firstChat(id) {
    return new Promise((resolve) => {
      let off = null
      const timer = setTimeout(() => {
        off?.()
        resolve(null)
      }, CHAT_FIRST_MS)
      off = onChat((m) => {
        if (m.id !== id) return
        clearTimeout(timer)
        off()
        resolve(m)
      })
    })
  }
  // What the host said, as the chat view reads it ('closed': it opens again
  // later; 'missing': looked for again soon).
  const asRead = (m) => (m.ok ? { ok: true, events: Array.isArray(m.events) ? m.events : [], truncated: !!m.truncated, more: false, background: [] } : { ok: false, code: m.code === 'busy' ? 'closed' : 'missing' })
  function chatSource(id) {
    const a = api()
    if (!a || typeof a.chatWatch !== 'function') return null
    return {
      async open() {
        const r = await Promise.resolve(a.chatWatch({ id, on: true })).catch(() => null)
        if (!r || !r.ok) return { ok: false, code: r && r.code === 'missing' ? 'missing' : 'error' }
        const m = r.last || (await firstChat(id))
        if (!m) return { ok: false, code: 'missing' }
        const read = asRead(m)
        if (!read.ok) return { ok: false, code: read.code === 'closed' ? 'missing' : read.code }
        return { viewId: id, ...read }
      },
      close() {
        Promise.resolve(a.chatWatch({ id, on: false })).catch(() => {})
      },
      onEvent(cb) {
        return onChat((m) => m.id === id && cb({ viewId: id, ...asRead(m) }))
      }
    }
  }

  // --- Following the host --------------------------------------------------------
  // Your screen in one of the host's projects follows the host's again (the
  // pill's "Follow host"), the tabs you hid there back too.
  function followHost(ws = deps.currentWs()) {
    if (!isGuestWs(ws) || ws.liveShare.session !== state.guest.session) return false
    const project = ws.liveShare.project
    followState(project).on = true
    followOf(project).applied = null
    hiddenTabs.delete(project)
    const lt = tabsLeaves.get(project)
    if (lt) lt.liveShare.sent = []
    feeds.followAll(project)
    const p = (state.guest.projects || []).find((x) => x.id === project)
    if (p) applyLayout(ws, p)
    return true
  }
  // What the pill says of a host's project on screen: { on (following), copy
  // (the task copy the host looks at, its branch, or null) }, or null.
  function followInfo(ws = deps.currentWs()) {
    if (!isGuestWs(ws) || ws.liveShare.session !== state.guest.session) return null
    const project = ws.liveShare.project
    const p = (state.guest.projects || []).find((x) => x.id === project)
    return { on: followState(project).on, copy: (p && p.layout && p.layout.copy) || null }
  }
  // A tab of the host's closed here (its editor tabs, one of its pages):
  // hidden on your screen only, never closed on the host's.
  function hideHostTab(id) {
    const ws = deps.workspaces().find((w) => isGuestWs(w) && hasLeaf(w.tree, id))
    if (!ws) return false
    const project = ws.liveShare.project
    const lt = tabsLeaves.get(project)
    if (lt && lt.id === id) {
      const hidden = hiddenTabs.get(project) || new Set()
      for (const x of lt.files || []) hidden.add(x.path)
      hiddenTabs.set(project, hidden)
    } else if (!feeds.hidePage(id)) return false
    const p = (state.guest.projects || []).find((x) => x.id === project)
    if (p) applyLayout(ws, p)
    return true
  }
  const isHostTab = (leaf) => !!(leaf && leaf.backend === 'liveshare' && leaf.liveShare && (leaf.liveShare.hostTabs || leaf.liveShare.link))

  async function init() {
    const a = api()
    if (!a) return
    if (typeof document !== 'undefined') {
      document.addEventListener('keydown', onGuestKey, true)
      offs.push(() => document.removeEventListener('keydown', onGuestKey, true))
    }
    offs.push(a.onHost(onHost), a.onGuest(onGuest), a.onAsk(onAsk), a.onHostRequest(onHostRequest))
    if (a.onNotice) offs.push(a.onNotice(onNotice))
    if (a.onPresence) offs.push(a.onPresence(onPresence))
    if (a.onInviteBlocked) offs.push(a.onInviteBlocked(onInviteBlocked))
    if (a.onGuestAction) offs.push(a.onGuestAction(onGuestAction))
    if (a.onPush) offs.push(a.onPush(onPush))
    feeds.init(a)
    if (a.onChat)
      offs.push(
        a.onChat((m) => {
          if (!m || typeof m.id !== 'string') return
          for (const fn of [...chatListeners]) fn(m)
        })
      )
    try {
      const s = await a.state()
      state.defaultName = s.defaultName || ''
      onHost(s.host)
      // Guests waiting for your answer before this window (re)loaded: their
      // invitation's projects and rights ticked, as main would offer them.
      for (const g of (s.host && s.host.guests) || []) if (g.state === 'waiting') onAsk({ guestId: g.id, name: g.name, code: g.code, invite: g.invite || null, offer: offerOf(g.invite), trustable: !!g.trustable })
      onGuest(s.guest)
      if (s.guest && (s.guest.state === 'joined' || s.guest.state === 'reconnecting')) askGuestFeeds()
    } catch {
      /* not available */
    }
    stops.push(
      watch(
        // Only the projects this window has: one not found yet (a share taken
        // back after a restart) keeps what guests saw of it meanwhile.
        () => (hostSharing() ? JSON.stringify(layoutsNow()) : ''),
        (text) => {
          if (text && a.setLayouts) a.setLayouts(JSON.parse(text))
        },
        { immediate: true }
      ),
      // Your own pick in a host's project (another pane, tab or editor file
      // than following put there): your screen stops following the host's.
      watch(
        () => {
          const ws = deps.currentWs()
          if (!isGuestWs(ws) || state.guest.state !== 'joined') return ''
          const project = ws.liveShare.project
          return followState(project).on ? `${project}\n${followKey(ws, project)}` : ''
        },
        (key) => {
          if (!key) return
          const project = key.slice(0, key.indexOf('\n'))
          const f = follow.get(project)
          if (f && f.applied && key.slice(project.length + 1) !== f.applied) followState(project).on = false
        }
      ),
      // A host's project comes on screen: the fullscreen pane the host chose
      // while it was not on screen is applied then.
      watch(
        () => deps.currentWsId(),
        (id) => {
          const ws = deps.workspaces().find((w) => w.id === id)
          const f = ws && isGuestWs(ws) && ws.liveShare ? follow.get(ws.liveShare.project) : null
          if (!f || !f.pending) return
          f.pending = false
          if (deps.maximizedId() !== f.maximized) deps.setMaximized(f.maximized)
        }
      ),
      // A shared project closed (or not there after a restart): out of the
      // share; the last one: sharing stops.
      watch(
        () => (hostSharing() ? JSON.stringify([sharedIds().map((id) => [id, (localWs(id) || {}).name || null]), !!(deps.layoutReady && deps.layoutReady())]) : ''),
        () => checkGone(),
        { immediate: true }
      ),
      // Each shared project's task board, for guests (main makes their copy),
      // sent at once and whenever it changes.
      watch(
        () => (hostSharing() && deps.taskBoard ? JSON.stringify(boardsNow()) : ''),
        (text) => {
          if (text && a.setTasks) a.setTasks(JSON.parse(text))
        },
        { immediate: true }
      ),
      // Each shared project's panes as their headers show them, and its
      // finished tasks, for guests: sent at once and whenever they change
      // (main sends guests the panes at most once a second).
      watch(
        () => (hostSharing() && deps.paneAgents ? JSON.stringify(paneAgentsNow()) : ''),
        (text) => {
          if (text && a.setPaneAgents) a.setPaneAgents(JSON.parse(text))
        },
        { immediate: true }
      ),
      watch(
        () => (hostSharing() && deps.historyRecords ? JSON.stringify(historyNow()) : ''),
        (text) => {
          if (text && a.setHistory) a.setHistory(JSON.parse(text))
        },
        { immediate: true }
      ),
      // As a guest: the task history of the host's project on screen, read
      // while its tab is shown (every 30 s, and when the usage right changes:
      // the costs in dollars come with it).
      watch(
        () => {
          const ws = deps.currentWs()
          const on = state.guest.state === 'joined' && isGuestWs(ws) && ws.liveShare.session === state.guest.session && !!(deps.historyShown && deps.historyShown())
          return on ? `${ws.liveShare.project}\n${!!(state.guest.rights && state.guest.rights.usage)}` : ''
        },
        (key) => followHistory(key ? key.split('\n')[0] : null),
        { immediate: true }
      ),
      // As a guest: the board of the host's project on screen, followed.
      watch(
        () => {
          const ws = deps.currentWs()
          return state.guest.state === 'joined' && isGuestWs(ws) && ws.liveShare.session === state.guest.session ? ws.liveShare.project : null
        },
        (project) => followBoard(project),
        { immediate: true }
      ),
      // The agents guests may ask for: the ones this window can start, sent
      // at once and whenever that list changes.
      watch(
        () => JSON.stringify(agentsNow()),
        (text) => {
          if (a.setAgents) a.setAgents(JSON.parse(text))
        },
        { immediate: true }
      ),
      // As a guest: the host's pane on your screen (its eyes only), none
      // while one of your own projects is. Main keeps the latest while the
      // connection comes back, and says it once in again.
      watch(
        () => (state.guest.state === 'joined' || state.guest.state === 'reconnecting' ? focusNow() || '' : null),
        (id) => {
          if (id !== null && a.focus) a.focus(id || null)
        },
        { immediate: true }
      )
    )
  }

  // The agents offered to guests ([{ id, name }]; main keeps the first 32).
  function agentsNow() {
    const list = deps.agentList ? deps.agentList() : []
    return (Array.isArray(list) ? list : []).filter((x) => x && typeof x.id === 'string').map((x) => ({ id: x.id, name: typeof x.name === 'string' ? x.name : x.id }))
  }
  // The host's pane with the keyboard, in a project of the host's on screen.
  function focusNow() {
    const ws = deps.currentWs()
    if (!isGuestWs(ws)) return null
    const id = deps.activePaneId ? deps.activePaneId() : ws.activeId
    return id && guestLeaves.has(id) && hasLeaf(ws.tree, id) ? id : null
  }
  // What an invitation offers now (its projects shared now, its rights), for
  // a guest whose ask came before this window loaded.
  function offerOf(via) {
    const inv = via && via.id ? (state.host.invites || []).find((x) => x.id === via.id) : null
    return inv ? { projects: (inv.projects || []).filter((id) => isShared(id)), rights: inv.rights } : null
  }

  function dispose() {
    for (const off of offs.splice(0)) if (typeof off === 'function') off()
    for (const stop of stops.splice(0)) stop()
    clearTimeout(typingTimer)
    clearInterval(historyTimer)
    for (const ask of deleteAsks.values()) clearTimeout(ask.timer)
    feeds.dispose()
  }

  return {
    state,
    init,
    dispose,
    isGuestWs,
    isGuestLeaf,
    openOnHost,
    notHere,
    canClose,
    requestClose,
    leave,
    setGuestView,
    setGuestTextSize,
    chatSource,
    readersOf,
    presenceOf,
    answerAsk,
    showAsk,
    hostMenu,
    taskSource,
    // Phase 2b, guest: the host's panes as their headers show them, a pane's
    // sub-agents, the host's usage, a project's task history, a review.
    paneAgent,
    childrenSource,
    hostUsage,
    historySource,
    reviewSource,
    closeReview,
    prepareShare,
    setShared,
    sharedIds,
    sharedWss,
    chosenIds,
    isShared,
    // Phase 2c: your page's share (its eye, its hide), and as a guest the
    // host's pages, past conversations and activity.
    feeds: feeds.feeds,
    pageShare: feeds.pageShare,
    setPageHidden: feeds.setPageHidden,
    setPageShared: feeds.setPageShared,
    pageNote: feeds.pageNote,
    followPage: feeds.followPage,
    approvePage: feeds.approvePage,
    quietFocus,
    // Following the host (guest).
    followHost,
    followInfo,
    hideHostTab,
    isHostTab,
    sessionSource: feeds.sessionSource,
    activitySource: feeds.activitySource
  }
}

function hasLeaf(node, id) {
  if (!node) return false
  if (node.type === 'leaf') return node.id === id
  return (node.children || []).some((c) => hasLeaf(c, id))
}

// The panes of this computer in a tree (not a Live Share host's).
function localLeaves(node, out = []) {
  if (!node) return out
  if (node.type === 'leaf') {
    if (node.backend !== 'liveshare') out.push(node)
  } else for (const c of node.children || []) localLeaves(c, out)
  return out
}

// A leaf of a host's layout by its id here.
function layoutLeaf(node, id) {
  if (!node) return null
  if (node.type === 'leaf') return node.id === id ? node : null
  for (const c of node.children || []) {
    const l = layoutLeaf(c, id)
    if (l) return l
  }
  return null
}

function firstLeafId(node) {
  if (!node) return null
  if (node.type === 'leaf') return node.id
  for (const c of node.children || []) {
    const id = firstLeafId(c)
    if (id) return id
  }
  return null
}
