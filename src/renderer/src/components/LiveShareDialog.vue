<script setup>
// Live Share (src/main/liveShare.js): Share lets others join this Tessel from
// theirs; Join opens another Tessel's shared projects here with the code its
// host gave. Why a session ended shows here while the dialog is open (a
// toast says it too).
//
// Share is one page, like a document's Share dialog (Google Docs, VS Code
// Live Share), top to bottom: the status while the share runs
// (liveshare/LsStatus.vue: since when, Stop sharing); who asks to come in (a
// band, on every page: Let in…, Refuse); the projects shared, and only
// those (chips with a cross; Add a project opens a picker with a search
// over all of yours, LsProjectPicker.vue); the people with access
// (LsPeople.vue: one row and one access menu each; a click opens that
// person's page, LsPersonPage.vue); the invitation (its code, Copy, what
// people who join can do, how long it works; the other invitations and
// their options on a page of their own, LsInvitations.vue); what guests
// changed lately, folded. Before you share: the same page with the projects
// to choose, your trusted people (and whether they will get in), the first
// invitation and your name, then Start sharing. Settings (LsSettings.vue) is
// a page of its own, behind the gear in the header. Giving Full control
// (typing: commands on this PC) is always asked first.
// The parts share one context (provide 'lsDialog'): the calls, a change
// on its way per key (a click on a box whose change is on its way does
// nothing), the error and notice lines, the clipboard and the project names.
import { ref, computed, watch, nextTick, onMounted, onUnmounted, provide } from 'vue'
import { ScreenShare, Copy, Check, AlertTriangle, LogIn, LogOut, X, MessageSquareText, Settings, ArrowLeft, Plus, ChevronRight, UserCheck } from 'lucide-vue-next'
import { t, intlLocale } from '../i18n'
import { actionText } from '../liveShareWindow'
import { accessError, invitesOf, inviteExpiry, joinedGuests, waitingGuests, shortCode, personName, viaName } from '../liveShareAccess'
import { peopleRows, canType } from '../liveSharePeople'
import { cleanRights } from '../../../shared/liveShareRights'
import { remoteRootTooBroad } from '../../../shared/remoteRootPolicy'
import { shownRights, presetRights, rightsPreset, presetLabel, presetHint } from '../liveShareRights'
import LsInvitations from './liveshare/LsInvitations.vue'
import LsPeople from './liveshare/LsPeople.vue'
import LsPersonPage from './liveshare/LsPersonPage.vue'
import LsProjectPicker from './liveshare/LsProjectPicker.vue'
import LsAvatars from './liveshare/LsAvatars.vue'
import LsStatus from './liveshare/LsStatus.vue'
import LsSettings from './liveshare/LsSettings.vue'
import LsGuest from './liveshare/LsGuest.vue'
import ThemedSelect from './ui/ThemedSelect.vue'
import { plainBridge } from '../liveShareBridge'

// An SSH project whose folder is too broad shares no files (main refuses it too).
const sshBroad = (p) => remoteRootTooBroad(p.sshPath)

const props = defineProps({
  open: { type: Boolean, default: false },
  initialTab: { type: String, default: 'share' },
  // The Share page shown first: invites or settings; anything else
  // (overview, people, access, trusted) the main page.
  initialSection: { type: String, default: 'overview' },
  // A project's "Who has access…": the people list shows who sees it.
  focusProject: { type: String, default: null },
  // Your projects ({ id, name }), and the ones ticked: shared, or picked to
  // share before you start.
  projects: { type: Array, default: () => [] },
  projectIds: { type: Array, default: () => [] },
  // The name of one of your panes (what a guest is watching).
  paneTitle: { type: Function, default: null },
  // In someone's session: the host's projects open here ([{ id, name, here,
  // follow }], LsGuest).
  guestProjects: { type: Array, default: () => [] }
})
// toggle-project(id, on): a project ticked or not (liveShareWindow.js setShared);
// review-guest(id): "Let in…" for a guest waiting for your answer
// (liveShareWindow.js showAsk puts their prompt first).
// goto(id), follow(id): a host's project here (Join tab).
const emit = defineEmits(['close', 'toggle-project', 'review-guest', 'goto', 'follow'])

// Plain arguments only (liveShareBridge.js): the first invitation lives in a
// ref, and a reactive object makes the call throw before it is sent.
const api = plainBridge(window.shellApi && window.shellApi.liveShare)
const OFF_HOST = { state: 'off', projectIds: [], invites: [], guests: [], offline: [], trusted: [], presence: [], progress: null, error: null, settings: { hideIgnored: true }, actions: [] }
const OFF_GUEST = { state: 'off', host: null, panes: [], projects: [], reason: null, rights: null, code: null, agents: null }
// The Share pages: the main one, the invitations, the settings (a person's
// page opens from their row).
const PAGES = ['main', 'invites', 'settings']
const tab = ref(props.initialTab === 'join' ? 'join' : 'share')
const page = ref('main')
// The person whose page is open, and what it asks at once ('remove', 'untrust').
const personId = ref('')
const personAction = ref('')
// The project picker, open under "Add a project".
const picking = ref(false)
// A project's "Who has access…": the people list shows who sees it, until
// Show everyone (kept here: the list is gone while another page shows).
const onlyProject = ref(props.focusProject)
const host = ref(OFF_HOST)
const guest = ref(OFF_GUEST)
const name = ref('')
const invite = ref('')
const hostError = ref('')
const hostNotice = ref('')
const joinError = ref('')
// How the session joined from here ended ({ reason, host }): the main
// process forgets it once it said so.
const ended = ref(null)
const busy = ref(false)
const copied = ref('')
let copiedTimer = 0
let noticeTimer = 0
// The time, for the invitations' expiry (twice a minute is enough).
const now = ref(Date.now())
let clock = 0
// The first invitation (set before you start): what it lets people do and
// how long it lasts; its other options are on the invitations page once
// the share runs.
const firstInvite = ref({ label: '', lifetime: 'hour', maxUses: 0, rights: presetRights('view') })
const confirmStop = ref(false)
const allRecent = ref(false)

const card = ref(null)
let previousFocus = null
const unsubscribe = []

// A page by its id; any other (overview, people, access, trusted) the main one.
function goTo(id) {
  page.value = PAGES.includes(id) ? id : 'main'
  personId.value = ''
  personAction.value = ''
}
function openPerson(id, action = '') {
  personId.value = id
  personAction.value = action
  picking.value = false
  page.value = 'person'
}
goTo(props.initialSection)

function onHost(status) {
  host.value = { ...OFF_HOST, ...(status || {}) }
  // Main's own words, after a sentence in the interface's language.
  if (host.value.state === 'error' && host.value.error) hostError.value = t('liveShare.share.stoppedWhy', 'Sharing stopped: {{error}}', { error: host.value.error })
}
function onGuest(status) {
  guest.value = status || OFF_GUEST
  if (guest.value.state === 'ended') ended.value = { reason: guest.value.reason, host: guest.value.host }
}

async function refresh() {
  if (!api) return
  try {
    const s = await api.state()
    onHost(s.host)
    if (!(s.guest && s.guest.state === 'off' && guest.value.state === 'ended')) onGuest(s.guest)
    if (!name.value) name.value = s.defaultName || ''
  } catch {
    // Keeps what it showed.
  }
}

onMounted(() => {
  if (api) unsubscribe.push(api.onHost(onHost), api.onGuest(onGuest))
  if (props.open) opened()
  else refresh()
  clock = setInterval(() => (now.value = Date.now()), 30000)
})
onUnmounted(() => {
  for (const off of unsubscribe) if (typeof off === 'function') off()
  clearTimeout(copiedTimer)
  clearTimeout(noticeTimer)
  clearInterval(clock)
  restoreFocus()
})

function opened() {
  tab.value = props.initialTab === 'join' ? 'join' : 'share'
  goTo(props.initialSection)
  picking.value = false
  onlyProject.value = props.focusProject
  previousFocus = document.activeElement
  refresh()
  nextTick(() => card.value?.focus())
}
function restoreFocus() {
  if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true })
  previousFocus = null
}
watch(
  () => props.open,
  (open) => (open ? opened() : restoreFocus())
)
watch(
  () => [props.initialSection, props.focusProject],
  ([s]) => {
    onlyProject.value = props.focusProject
    if (props.open && s) {
      tab.value = 'share'
      goTo(s)
    }
  }
)

// --- Share ---------------------------------------------------------------
const hostState = computed(() => host.value.state)
const preparing = computed(() => ['preparing', 'starting', 'checking'].includes(hostState.value))
const sharing = computed(() => hostState.value === 'sharing')
const progressText = computed(() => {
  const h = host.value
  // A share starting again by itself (after a restart) that could not yet:
  // it tries again until it works or you stop it.
  if (h.retry && h.retry.error) return t('liveShare.share.retrying', 'Sharing could not start again yet ({{error}}). It tries again by itself.', { error: h.retry.error })
  if (h.state === 'preparing')
    return h.progress == null
      ? t('liveShare.share.preparing', 'Getting the Cloudflare tunnel ready…')
      : t('liveShare.share.downloading', 'Downloading the Cloudflare tunnel… {{percent}}%', { percent: Math.round(h.progress * 100) })
  if (h.state === 'starting') return t('liveShare.share.starting', 'Starting…')
  if (h.state === 'checking') return t('liveShare.share.checking', 'Checking the address…')
  return ''
})
const invites = computed(() => invitesOf(host.value))
const joined = computed(() => joinedGuests(host.value))
const waiting = computed(() => waitingGuests(host.value))

// The projects ticked; while sharing, the last one can't be unticked (Stop
// sharing ends the share).
const ticked = computed(() => new Set(props.projectIds || []))
const lastShared = (p) => sharing.value && ticked.value.size === 1 && ticked.value.has(p.id)
function setProject(p, on) {
  if (!on && lastShared(p)) return
  emit('toggle-project', p.id, on)
}
function closePicker() {
  picking.value = false
  nextTick(() => card.value?.querySelector('[data-test="ls-add-project"]')?.focus())
}
const unshareText = (p) => t('liveShare.projects.remove', 'Stop sharing {{project}}', { project: p.name })
// The shared projects, by name (the ones this window has), and all of yours.
const sharedList = computed(() => props.projects.filter((p) => (sharing.value || preparing.value ? (host.value.projectIds || []).includes(p.id) : ticked.value.has(p.id))))
const allList = computed(() => props.projects)
const projectName = (id) => (props.projects.find((p) => p.id === id) || {}).name || ''

// A change on its way, per key: a click on it meanwhile does nothing. One
// that could not be made says why. -> main's answer, or null.
const pending = ref(new Set())
async function run(key, send, failed) {
  if (!api || pending.value.has(key)) return null
  pending.value = new Set([...pending.value, key])
  hostError.value = ''
  const r = await Promise.resolve()
    .then(send)
    .catch(() => null)
  const rest = new Set(pending.value)
  rest.delete(key)
  pending.value = rest
  if (!r || !r.ok) hostError.value = accessError(r, failed)
  return r
}
function openSettings() {
  tab.value = 'share'
  goTo('settings')
}
function notice(text) {
  hostNotice.value = text
  clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => (hostNotice.value = ''), 6000)
}
// A preset for a person (People's presets, the grid's preset column): one
// change per right that differs, in turn (main takes one right at a time);
// the first that fails stops the rest.
async function setPreset(subject, rights, id) {
  const want = presetRights(id)
  for (const r of shownRights()) {
    const on = want[r.id] === true
    if (!!(rights && rights[r.id] === true) === on) continue
    const res = await run(`${subject}:right:${r.id}`, () => api.access({ subject, right: r.id, on })) // i18n-ignore
    if (!res || !res.ok) break
  }
}
async function copyText(text) {
  try {
    if (window.shellApi && window.shellApi.writeClipboard) await window.shellApi.writeClipboard(text)
    else await navigator.clipboard.writeText(text)
    return true
  } catch {
    hostError.value = t('liveShare.share.copyFailed', 'Could not copy to the clipboard.')
    return false
  }
}
provide('lsDialog', {
  api,
  host,
  now,
  shared: sharedList,
  all: allList,
  projectName,
  paneTitle: (id) => (props.paneTitle && props.paneTitle(id)) || '',
  run,
  busy: (key) => pending.value.has(key),
  notice,
  error: (text) => (hostError.value = text),
  copy: copyText,
  preset: setPreset,
  openPerson,
  review: (guestId) => emit('review-guest', guestId)
})

// --- The invitation -----------------------------------------------------
// What an invitation lets people do (presets; Custom shows, not chosen here)
// and how long new people can use it.
const ACCESS = ['view', 'collaborate', 'full']
const LIFETIMES = ['hour', 'day', 'week', 'never']
const lifetimeLabel = (id) =>
  ({ hour: t('liveShare.invite.lifetimeHour', '1 hour'), day: t('liveShare.invite.lifetimeDay', '1 day'), week: t('liveShare.invite.lifetimeWeek', '7 days'), never: t('liveShare.invite.lifetimeNever', 'No expiry') })[id] || id
// A preset keeps the agents rule chosen.
const withAgents = (rights, agents) => (agents ? { ...rights, agents } : rights)

// Before sharing: the first invitation.
const firstPreset = computed(() => rightsPreset(firstInvite.value.rights))
const firstTypes = computed(() => !!(firstInvite.value.rights && firstInvite.value.rights.type === true))
function setFirstPreset(event) {
  const id = event && event.target ? event.target.value : ''
  if (ACCESS.includes(id)) firstInvite.value = { ...firstInvite.value, rights: withAgents(presetRights(id), firstInvite.value.rights && firstInvite.value.rights.agents) }
}
function setFirstLifetime(event) {
  const id = event && event.target ? event.target.value : ''
  if (LIFETIMES.includes(id)) firstInvite.value = { ...firstInvite.value, lifetime: id }
}

// While sharing: the invitation shown is the first one that lets people in
// (live and not expired; main prunes expired ones later), or the first one;
// the others are on the invitations page.
const letsIn = (inv) => inv.state === 'live' && !inviteExpiry(inv, now.value).expired
const mainInvite = computed(() => invites.value.find(letsIn) || invites.value[0] || null)
const linkPreset = computed(() => (mainInvite.value ? rightsPreset(mainInvite.value.rights) : 'view'))
const linkTypes = computed(() => !!(mainInvite.value && mainInvite.value.rights && mainInvite.value.rights.type === true))
const canCopyLink = computed(() => !!(mainInvite.value && mainInvite.value.code && letsIn(mainInvite.value)))
// A change to the invitation: for the people who come with it from now on;
// a right taken away is taken from the people who came with it too (as the
// invitation editor does by default), one given is not given to them.
// The invitation asked about (its id), while Full control waits for a yes.
const raisingLink = ref(null)
const focusLinkMenu = () => nextTick(() => card.value?.querySelector('[data-test="ls-link-access"]')?.focus())
function cancelLinkRaise() {
  raisingLink.value = null
  focusLinkMenu()
}
function applyLinkPreset(id) {
  const inv = mainInvite.value
  if (!inv) return
  run(`invite:${inv.id}`, () => api.updateInvite({ id: inv.id, patch: { rights: withAgents(presetRights(id), inv.rights && inv.rights.agents) }, applyRemovals: true, applyAdditions: false })) // i18n-ignore
}
function setLinkPreset(event) {
  const inv = mainInvite.value
  const id = event && event.target ? event.target.value : ''
  if (!inv || !ACCESS.includes(id) || id === linkPreset.value) return
  // Full control (typing: commands on this PC) is asked first.
  if (id === 'full') {
    raisingLink.value = inv.id
    nextTick(() => card.value?.querySelector('[data-test="ls-link-raise-cancel"]')?.focus())
    return
  }
  raisingLink.value = null
  applyLinkPreset(id)
}
// Only for the invitation asked about (another one may show by now).
function giveLinkFull() {
  const asked = raisingLink.value
  raisingLink.value = null
  focusLinkMenu()
  if (mainInvite.value && mainInvite.value.id === asked) applyLinkPreset('full')
}
watch(
  () => [mainInvite.value && mainInvite.value.id, sharing.value],
  () => (raisingLink.value = null)
)
function setLinkLifetime(event) {
  const inv = mainInvite.value
  const id = event && event.target ? event.target.value : ''
  if (!inv || !LIFETIMES.includes(id)) return
  run(`invite:${inv.id}`, () => api.updateInvite({ id: inv.id, patch: { lifetime: id }, applyRemovals: false, applyAdditions: false })) // i18n-ignore
}
// No invitation left: a new one, view only, for an hour, with every shared
// project (and the ones shared later).
async function newLink() {
  const r = await run('invite:new', () => api.createInvite({ label: '', lifetime: 'hour', maxUses: 0, rights: presetRights('view'), projects: sharedList.value.map((p) => p.id), later: true }))
  if (r && r.ok) nextTick(() => card.value?.querySelector('[data-test="ls-link-copy"]')?.focus())
}
const linkExpiry = computed(() => (mainInvite.value ? inviteExpiry(mainInvite.value, now.value).text : ''))
const otherInvites = computed(() => Math.max(0, invites.value.length - 1))
const manageText = computed(() =>
  otherInvites.value ? t('liveShare.link.manageMore', 'Invitations ({{count}} more)…', { count: otherInvites.value }) : t('liveShare.link.manage', 'Invitation options…')
)

async function startSharing() {
  if (!api || busy.value || !props.projectIds.length) return
  busy.value = true
  hostError.value = ''
  try {
    const r = await api.start({ name: name.value.trim(), projects: [...props.projectIds], invite: { ...firstInvite.value } })
    if (r && !r.ok && r.error) hostError.value = t('liveShare.share.failedWhy', 'Sharing could not start: {{error}}', { error: r.error })
    else if (r && r.ok) {
      onHost(r)
      // Start, copy, send: the invitation's Copy has the keyboard.
      picking.value = false
      page.value = 'main'
      nextTick(() => card.value?.querySelector('[data-test="ls-link-copy"]')?.focus())
    }
  } catch (err) {
    // Say why: the bare sentence hid a call that never reached the main process.
    const why = err && err.message ? String(err.message).slice(0, 200) : ''
    hostError.value = why ? t('liveShare.share.failedWhy', 'Sharing could not start: {{error}}', { error: why }) : t('liveShare.share.failed', 'Sharing could not start.')
  }
  busy.value = false
}
// Asked first while anyone is in or waiting for an answer, with the same
// words as the toolbar's Stop (App.vue liveShareStop).
function askStop() {
  if (joined.value.length || waiting.value.length) {
    confirmStop.value = true
    nextTick(() => card.value?.querySelector('[data-test="ls-stop-cancel"]')?.focus())
  } else stopSharing()
}
function stopSharing() {
  confirmStop.value = false
  if (api) api.stop()
}
const stopText = computed(() => {
  const n = joined.value.length
  if (!n) return t('liveShare.stop.textWaiting', '{{count}} waiting for your answer will be turned away, and every invitation code stops working. Trusted people stay trusted.', { count: waiting.value.length })
  return n === 1
    ? t('liveShare.stop.text', '{{count}} person is disconnected, and every invitation code stops working. Trusted people stay trusted.', { count: 1 })
    : t('liveShare.stop.text', '{{count}} people are disconnected, and every invitation code stops working. Trusted people stay trusted.', { count: n })
})

// The invitations' codes: shortened on screen (the whole code in its
// tooltip and on the clipboard), or a message saying how to join.
async function copyInvite(inv, message) {
  if (!inv.code) return
  const text = message ? t('liveShare.invite.message', 'Join my Tessel Live Share: in Tessel, open Live Share, then Join, and paste this code: {{code}}', { code: inv.code }) : inv.code
  if (!(await copyText(text))) return
  copied.value = (message ? 'message:' : 'code:') + inv.id
  clearTimeout(copiedTimer)
  copiedTimer = setTimeout(() => (copied.value = ''), 1500)
}


// What guests changed lately (main's, newest first): the last five, or all
// main sent.
const RECENT_SHOWN = 5
const actions = computed(() => (Array.isArray(host.value.actions) ? host.value.actions : []))
const recentActions = computed(() => (allRecent.value ? actions.value : actions.value.slice(0, RECENT_SHOWN)))
// Its {{count}} would end a template interpolation: built here.
const recentToggleText = computed(() => (allRecent.value ? t('liveShare.recent.fewer', 'Show fewer') : t('liveShare.recent.all', 'See all ({{count}})', { count: actions.value.length })))
// In the interface's language (French: 06 h 13, not 06:13 AM).
const actionTime = (a) => (Number.isFinite(a.at) ? new Intl.DateTimeFormat(intlLocale(), { hour: '2-digit', minute: '2-digit' }).format(a.at) : '')

// Who asks to come in (the band).
const waitingTitle = computed(() => (waiting.value.length === 1 ? t('liveShare.waiting.one', 'One access request') : t('liveShare.waiting.many', '{{count}} access requests', { count: waiting.value.length })))
const waitingMeta = (g) => {
  const parts = []
  if (g.code) parts.push(t('liveShare.overview.code', 'Code {{code}}', { code: g.code }))
  const via = viaName(g.invite, invites.value)
  if (via) parts.push(t('liveShare.people.via', 'Came with {{invite}}', { invite: via }))
  return parts.join(' · ')
}
// A no: main turns them away (their prompt goes with it).
async function refuse(g) {
  const r = await run(g.id + ':answer', () => api.approve({ guestId: g.id, yes: false, projects: [], rights: cleanRights(null), trust: false }))
  if (r && r.ok) notice(t('liveShare.people.refused', '{{name}} was turned away.', { name: personName(g) }))
}
// How many people can type (run commands on this PC): said once, by the list.
const typers = computed(() => peopleRows(host.value).filter((r) => r.kind !== 'waiting' && canType(r)).length)
const typersText = computed(() => (typers.value === 1 ? t('liveShare.people.dangerOne', '1 person can run commands on this PC') : t('liveShare.people.dangerMany', '{{count}} people can run commands on this PC', { count: typers.value })))
// Guest changes to a file that tells agents what to do: counted while folded.
const flaggedCount = computed(() => actions.value.filter((a) => a.flagged).length)
const flaggedText = computed(() => t('liveShare.recent.toCheck', '{{count}} to check', { count: flaggedCount.value }))
const pageTitle = computed(() => {
  if (page.value === 'settings') return t('liveShare.section.settings', 'Settings')
  if (page.value === 'person') return ''
  return t('liveShare.section.invites', 'Invitations')
})

// --- Join ----------------------------------------------------------------
const guestState = computed(() => guest.value.state)
const inSession = computed(() => ['connecting', 'waiting', 'joined', 'reconnecting'].includes(guestState.value))
const joinedText = computed(() => t('liveShare.join.joined2', 'You joined {{host}}’s Live Share. Each project they share with you opens as a Live Share project in the sidebar.', { host: guest.value.host || '?' }))
const inviteField = ref(null)
// "Paste a new code" (a session ended, an old code): the clipboard's text
// when it looks like an invite code, else an empty field to paste into.
async function pasteNew() {
  ended.value = null
  joinError.value = ''
  invite.value = ''
  try {
    const text = String((window.shellApi && window.shellApi.readClipboard ? await window.shellApi.readClipboard() : '') || '').trim()
    if (/^(TS[12]\.|tessel-ls:)\S+$/.test(text) && text.length < 4096) invite.value = text
  } catch {
    // The field stays empty: pasted by hand.
  }
  nextTick(() => inviteField.value?.focus())
}

async function join() {
  const code = invite.value.trim()
  if (!api || !code || busy.value) return
  busy.value = true
  joinError.value = ''
  ended.value = null
  try {
    const r = await api.join({ invite: code, name: name.value.trim() })
    if (r && !r.ok) joinError.value = r.error || t('liveShare.join.failed', 'Could not join.')
  } catch {
    joinError.value = t('liveShare.join.failed', 'Could not join.')
  }
  busy.value = false
}
function leave() {
  if (api) api.leave()
}

// --- Keyboard ------------------------------------------------------------
function trapTab(event) {
  const items = [...(card.value?.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary') || [])].filter((el) => !el.closest('[style*="display: none"]'))
  if (!items.length) return
  const i = items.indexOf(document.activeElement)
  if (event.shiftKey && i <= 0) {
    event.preventDefault()
    items.at(-1).focus()
  } else if (!event.shiftKey && i === items.length - 1) {
    event.preventDefault()
    items[0].focus()
  }
}
// Left / Right (Home / End) move between tabs, as in any tab list.
function tabKeys(event, list, current, set) {
  const keys = { ArrowRight: 1, ArrowLeft: -1 }
  let i = list.indexOf(current)
  if (event.key in keys) i = (i + keys[event.key] + list.length) % list.length
  else if (event.key === 'Home') i = 0
  else if (event.key === 'End') i = list.length - 1
  else return
  event.preventDefault()
  set(list[i])
  nextTick(() => event.currentTarget?.querySelector('[aria-selected="true"]')?.focus())
}
</script>

<template>
  <div v-if="open" class="help-backdrop" @pointerdown.self="emit('close')">
    <div
      ref="card"
      class="help-card ls-card"
      role="dialog"
      aria-modal="true"
      aria-labelledby="ls-title"
      tabindex="-1"
      data-test="live-share-dialog"
      @focusin.stop
      @keydown.escape.prevent.stop="emit('close')"
      @keydown.tab.stop="trapTab"
    >
      <div class="help-head">
        <span id="ls-title"><ScreenShare :size="16" aria-hidden="true" /> {{ t('liveShare.title', 'Live Share') }}</span>
        <span class="ls-head-tools">
          <button v-if="api" class="tb-icon" :class="{ on: tab === 'share' && page === 'settings' }" :title="t('liveShare.section.settings', 'Settings')" :aria-label="t('liveShare.section.settings', 'Settings')" data-test="ls-goto-settings" @click="openSettings"><Settings :size="14" aria-hidden="true" /></button>
          <button class="tb-icon" :title="t('liveShare.closeEsc', 'Close (Esc)')" :aria-label="t('liveShare.closeEsc', 'Close (Esc)')" @click="emit('close')"><X :size="14" aria-hidden="true" /></button>
        </span>
      </div>

      <div class="ls-tabs" role="tablist" :aria-label="t('liveShare.title', 'Live Share')" @keydown="tabKeys($event, ['share', 'join'], tab, (v) => (tab = v))">
        <button type="button" role="tab" class="ls-tab" :class="{ on: tab === 'share' }" :aria-selected="tab === 'share'" :tabindex="tab === 'share' ? 0 : -1" data-test="ls-tab-share" @click="tab = 'share'">
          {{ t('liveShare.tabs.share', 'Share') }}
        </button>
        <button type="button" role="tab" class="ls-tab" :class="{ on: tab === 'join' }" :aria-selected="tab === 'join'" :tabindex="tab === 'join' ? 0 : -1" data-test="ls-tab-join" @click="tab = 'join'">
          {{ t('liveShare.tabs.join', 'Join') }}
        </button>
      </div>

      <div v-if="!api" class="ls-error" role="alert">{{ t('liveShare.unavailable', 'Live Share is not available in this version.') }}</div>

      <!-- Share -->
      <section v-else-if="tab === 'share'" role="tabpanel" data-test="ls-share-panel">
        <LsStatus v-if="sharing || preparing" :host="host" :projects="sharedList.length" :progress="progressText" :confirming="confirmStop" :now="now" @stop="askStop" @cancel="stopSharing" />

        <div v-if="confirmStop" class="lsd-confirm ls-stop-confirm" role="group" :aria-label="t('liveShare.stop.title', 'Stop Live Share?')" data-test="ls-stop-confirm" @keydown.escape.stop.prevent="confirmStop = false">
          <p class="lsd-confirm-text">
            <strong>{{ t('liveShare.stop.title', 'Stop Live Share?') }}</strong>
            {{ stopText }}
          </p>
          <div class="lsd-actions">
            <button type="button" class="confirm-btn ls-small" data-test="ls-stop-cancel" @click="confirmStop = false">{{ t('liveShare.share.keepSharing', 'Keep sharing') }}</button>
            <button type="button" class="confirm-btn ls-small primary danger" data-test="ls-stop-yes" @click="stopSharing">{{ t('liveShare.stop.confirm', 'Stop sharing') }}</button>
          </div>
        </div>

        <!-- Who asks to come in: on every page, first. -->
        <div v-if="waiting.length" class="ls-band" role="group" :aria-label="waitingTitle" data-test="ls-waiting-band">
          <div class="ls-band-title">{{ waitingTitle }}</div>
          <div v-for="g in waiting" :key="g.id" class="ls-band-row" :data-test="'ls-waiting-' + g.id">
            <LsAvatars :people="[{ id: g.id, name: personName(g) }]" :size="22" />
            <span class="ls-band-main">
              <span class="ls-band-name">{{ personName(g) }}</span>
              <span v-if="waitingMeta(g)" class="ls-band-meta">{{ waitingMeta(g) }}</span>
            </span>
            <button type="button" class="confirm-btn ls-small danger" :disabled="pending.has(g.id + ':answer')" :data-test="'ls-waiting-refuse-' + g.id" @click="refuse(g)">{{ t('liveShare.people.refuse', 'Refuse') }}</button>
            <button type="button" class="confirm-btn ls-small primary" :disabled="pending.has(g.id + ':answer')" :data-test="'ls-waiting-letin-' + g.id" @click="emit('review-guest', g.id)">
              <UserCheck :size="12" aria-hidden="true" /> {{ t('liveShare.people.letIn', 'Let in…') }}
            </button>
          </div>
        </div>

        <!-- A page of its own (a person, the invitations, the settings): Back to the main page. -->
        <div v-if="page !== 'main'" class="ls-page" data-test="ls-subpage">
          <div class="ls-page-head">
            <button type="button" class="ls-back" data-test="ls-back" @click="goTo('main')">
              <ArrowLeft :size="14" aria-hidden="true" /> {{ t('liveShare.back', 'Back') }}
            </button>
            <span class="ls-page-title">{{ pageTitle }}</span>
          </div>
          <LsPersonPage v-if="page === 'person'" :key="personId" :person-id="personId" :action="personAction" @gone="goTo('main')" />
          <LsInvitations v-else-if="page === 'invites' && sharing" />
          <LsSettings v-else-if="page === 'settings'" />
          <p v-else class="ls-empty ls-section-off" data-test="ls-section-off">{{ t('liveShare.section.offInvites', 'Invitations come with a share: start sharing, and the first one is ready to copy.') }}</p>
        </div>

        <div v-else data-test="ls-main">
          <p v-if="!sharing && !preparing" class="ls-intro">
            {{ t('liveShare.share.intro5', 'People join from their own Tessel and see the projects you share, live. Each one waits for your yes.') }}
          </p>

          <!-- Projects: only the ones shared; the others in the picker. -->
          <div class="ls-block" data-test="ls-projects">
            <div class="ls-block-title">
              {{ sharing || preparing ? t('liveShare.share.projectsSharedTitle', 'Projects you share') : t('liveShare.share.projects', 'Projects to share') }}
              <span v-if="sharedList.length" class="ls-count">{{ sharedList.length }}</span>
            </div>
            <div class="ls-chips">
              <span v-for="p in sharedList" :key="p.id" class="ls-chip" :data-test="'ls-chip-' + p.id">
                <span class="ls-chip-name" :title="p.name">{{ p.name }}</span>
                <span v-if="p.noFiles" class="ls-chip-tag" :title="t('liveShare.share.noFiles', 'It has no folder on this computer: guests see its terminals and agents, not its files.')">{{ t('liveShare.share.terminalsOnly', 'Terminals only') }}</span>
                <span v-else-if="p.ssh && sshBroad(p)" class="ls-chip-tag" :title="t('liveShare.share.sshBroad', 'This SSH folder is too broad to share its files (the server’s root, a home or system folder): guests get its terminals and agents only. Choose a project folder inside it to share files.')">{{ t('liveShare.share.sshBroadTag', 'SSH, no files') }}</span>
                <span v-else-if="p.ssh" class="ls-chip-tag" :title="t('liveShare.share.sshFiles', 'Guests can read this project’s files on the server (through your connection to it, while it is connected) and save them with the edit right. Secret and git-ignored files stay hidden unless you turn that off. Changes are not shared.')">{{ t('liveShare.share.sshTag', 'SSH') }}</span>
                <button
                  type="button"
                  class="ls-chip-x"
                  :disabled="lastShared(p)"
                  :title="lastShared(p) ? t('liveShare.share.lastProject', 'To stop sharing your last project, use Stop sharing.') : unshareText(p)"
                  :aria-label="unshareText(p)"
                  :data-test="'ls-chip-remove-' + p.id"
                  @click="setProject(p, false)"
                >
                  <X :size="12" aria-hidden="true" />
                </button>
              </span>
              <button v-if="!picking && projects.length" type="button" class="ls-chip-add" data-test="ls-add-project" @click="picking = true"><Plus :size="13" aria-hidden="true" /> {{ t('liveShare.projects.add', 'Add a project') }}</button>
            </div>
            <p v-if="!projects.length" class="ls-empty">{{ t('liveShare.share.noProject', 'No project to share') }}</p>
            <p v-else-if="!projectIds.length && !sharing && !preparing" class="ls-hint" data-test="ls-need-project">{{ t('liveShare.share.needProject', 'Tick at least one project.') }}</p>
            <LsProjectPicker
              v-if="picking"
              :projects="projects"
              :selected="sharedList.map((p) => p.id)"
              :locked="lastShared"
              :locked-title="t('liveShare.share.lastProject', 'To stop sharing your last project, use Stop sharing.')"
              @toggle="(id, on) => emit('toggle-project', id, on)"
              @close="closePicker"
            />
          </div>

          <!-- People with access. -->
          <div class="ls-block" data-test="ls-people-block">
            <div class="ls-block-title">
              {{ t('liveShare.people.withAccess', 'People with access') }}
              <span v-if="typers" class="ls-danger-note" data-test="ls-danger-summary"><AlertTriangle :size="12" aria-hidden="true" /> {{ typersText }}</span>
            </div>
            <LsPeople :focus-project="onlyProject" @show-all="onlyProject = null" />
          </div>

          <!-- Before sharing: your name and the first invitation. -->
          <div v-if="!sharing && !preparing" class="ls-block" data-test="ls-first">
            <div class="ls-block-title">{{ t('liveShare.link.title', 'Invitation') }}</div>
            <div class="ls-link-row">
              <span class="ls-link-words">{{ t('liveShare.link.people', 'People who join') }}</span>
              <ThemedSelect class="ls-input ls-select" :value="firstPreset" :aria-label="t('liveShare.link.access', 'What people who join can do')" data-test="ls-first-access" @change="setFirstPreset">
                <option v-for="id in ACCESS" :key="id" :value="id">{{ presetLabel(id) }}</option>
                <option v-if="firstPreset === 'custom'" value="custom" disabled>{{ presetLabel('custom') }}</option>
              </ThemedSelect>
              <span class="ls-link-words">{{ t('liveShare.link.for', 'Code works for') }}</span>
              <ThemedSelect class="ls-input ls-select" :value="firstInvite.lifetime" :aria-label="t('liveShare.invite.lifetime', 'New people can use it for')" data-test="ls-first-lifetime" @change="setFirstLifetime">
                <option v-for="id in LIFETIMES" :key="id" :value="id">{{ lifetimeLabel(id) }}</option>
              </ThemedSelect>
            </div>
            <p class="ls-hint" :class="{ 'ls-danger-text': firstTypes }" data-test="ls-first-hint">{{ presetHint(firstPreset, firstInvite.rights) }}</p>
            <label class="ls-name-row">
              <span class="ls-link-words">{{ t('liveShare.share.name', 'Your name (guests see it)') }}</span>
              <input v-model="name" class="ls-input ls-name" type="text" spellcheck="false" maxlength="40" data-test="ls-share-name" @keydown.enter="startSharing" />
            </label>
          </div>

          <p v-if="preparing" class="ls-empty" data-test="ls-preparing-note">
            {{ host.restarting ? t('liveShare.overview.restarting', 'Your invitations and people come back here once the share has started again.') : t('liveShare.overview.preparing', 'Your first invitation is ready to copy here once the share has started.') }}
          </p>

          <!-- While sharing: the invitation. -->
          <div v-if="sharing" class="ls-block" data-test="ls-link">
            <div class="ls-block-title">{{ t('liveShare.link.title', 'Invitation') }}</div>
            <template v-if="mainInvite">
              <div class="ls-link-row">
                <code class="ls-link-code" :title="mainInvite.code || ''" data-test="ls-invite">{{ shortCode(mainInvite.code) }}</code>
                <button type="button" class="confirm-btn ls-small primary" :disabled="!canCopyLink" data-test="ls-link-copy" @click="copyInvite(mainInvite, false)">
                  <Check v-if="copied === 'code:' + mainInvite.id" :size="13" aria-hidden="true" />
                  <Copy v-else :size="13" aria-hidden="true" />
                  {{ copied === 'code:' + mainInvite.id ? t('liveShare.share.copied', 'Copied') : t('liveShare.invite.copyCode', 'Copy code') }}
                </button>
                <button
                  type="button"
                  class="confirm-btn ls-small ls-icon-btn"
                  :disabled="!canCopyLink"
                  :title="t('liveShare.invite.copyMessageTitle', 'The code with a line saying how to join')"
                  :aria-label="t('liveShare.invite.copyMessage', 'Copy message')"
                  data-test="ls-link-message"
                  @click="copyInvite(mainInvite, true)"
                >
                  <Check v-if="copied === 'message:' + mainInvite.id" :size="13" aria-hidden="true" />
                  <MessageSquareText v-else :size="13" aria-hidden="true" />
                </button>
              </div>
              <div class="ls-link-row">
                <span class="ls-link-words">{{ t('liveShare.link.people', 'People who join') }}</span>
                <ThemedSelect
                  class="ls-input ls-select"
                  :value="linkPreset"
                  :disabled="pending.has('invite:' + mainInvite.id)"
                  :aria-label="t('liveShare.link.access', 'What people who join can do')"
                  data-test="ls-link-access"
                  @change="setLinkPreset"
                >
                  <option v-for="id in ACCESS" :key="id" :value="id">{{ presetLabel(id) }}</option>
                  <option v-if="linkPreset === 'custom'" value="custom" disabled>{{ presetLabel('custom') }}</option>
                </ThemedSelect>
                <span v-if="mainInvite.state === 'blocked'" class="tag tag-danger">{{ t('liveShare.invite.badgeBlocked', 'Blocked') }}</span>
                <span v-else-if="mainInvite.state === 'used'" class="tag tag-warn">{{ t('liveShare.invite.badgeUsed', 'Used up') }}</span>
                <span class="ls-link-words ls-dim">{{ linkExpiry }}</span>
                <ThemedSelect
                  class="ls-input ls-select ls-select-small"
                  :value="''"
                  :disabled="pending.has('invite:' + mainInvite.id)"
                  :aria-label="t('liveShare.invite.lifetime', 'New people can use it for')"
                  data-test="ls-link-lifetime"
                  @change="setLinkLifetime"
                >
                  <option value="" disabled>{{ t('liveShare.link.renew', 'Make it work for…') }}</option>
                  <option v-for="id in LIFETIMES" :key="id" :value="id">{{ lifetimeLabel(id) }}</option>
                </ThemedSelect>
              </div>
              <div v-if="raisingLink" class="lsd-confirm" role="group" data-test="ls-link-raise-confirm" @keydown.escape.stop.prevent="cancelLinkRaise">
                <p class="lsd-confirm-text">{{ t('liveShare.link.raiseText', 'With Full control, the people you let in with this invitation can run any command on this PC as you.') }}</p>
                <div class="lsd-actions">
                  <button type="button" class="confirm-btn ls-small" data-test="ls-link-raise-cancel" @click="cancelLinkRaise">{{ t('liveShare.cancel', 'Cancel') }}</button>
                  <button type="button" class="confirm-btn ls-small primary danger" data-test="ls-link-raise-yes" @click="giveLinkFull">{{ t('liveShare.people.raiseYes', 'Give full control') }}</button>
                </div>
              </div>
              <p v-else-if="linkTypes" class="ls-hint ls-danger-text" data-test="ls-link-types">{{ t('liveShare.link.typesNote', 'This invitation gives Full control: the people you let in with it can run commands on this PC.') }}</p>
            </template>
            <p v-else class="ls-empty" data-test="ls-no-invites">
              {{ t('liveShare.share.noInvites', 'No invitation left: make one to let people ask to join.') }}
              <button type="button" class="confirm-btn ls-small primary" :disabled="pending.has('invite:new')" data-test="ls-link-new" @click="newLink"><Plus :size="13" aria-hidden="true" /> {{ t('liveShare.invite.new', 'New invitation') }}</button>
            </p>
            <button type="button" class="ls-link ls-more" data-test="ls-goto-invites" @click="goTo('invites')">{{ manageText }} <ChevronRight :size="12" aria-hidden="true" /></button>
          </div>

          <!-- What guests changed lately. -->
          <details v-if="sharing && actions.length" class="ls-block ls-recent" data-test="ls-recent">
            <summary class="ls-block-title">
              {{ t('liveShare.recent.title', 'Recent guest actions') }} <span class="ls-count">{{ actions.length }}</span>
              <span v-if="flaggedCount" class="ls-count warn" data-test="ls-recent-flagged">{{ flaggedText }}</span>
            </summary>
            <ul class="ls-recent-list">
              <li v-for="a in recentActions" :key="a.id" class="ls-recent-item" :class="{ flagged: a.flagged }" :data-test="'ls-recent-' + a.id">
                <span class="ls-recent-time">{{ actionTime(a) }}</span>
                <span class="ls-recent-text">{{ actionText(a) }}</span>
                <span v-if="projectName(a.project) && sharedList.length > 1" class="ls-recent-project">{{ projectName(a.project) }}</span>
                <span v-if="a.flagged" class="tag tag-warn" :title="t('liveShare.recent.flaggedHint', 'This file tells agents what to do: check the change.')">{{ t('liveShare.recent.flagged', 'Agent instructions') }}</span>
              </li>
            </ul>
            <button v-if="actions.length > RECENT_SHOWN" type="button" class="ls-link" :aria-expanded="allRecent" data-test="ls-recent-all" @click="allRecent = !allRecent">
              {{ recentToggleText }}
            </button>
          </details>
        </div>

        <div v-if="hostNotice" class="set-callout info ls-callout" role="status" data-test="ls-host-notice">{{ hostNotice }}</div>
        <div v-if="hostError" class="set-callout danger ls-callout" role="alert" data-test="ls-host-error">
          <AlertTriangle :size="14" aria-hidden="true" />
          <span class="set-callout-text">{{ hostError }}</span>
        </div>

        <div class="confirm-actions">
          <button class="confirm-btn" data-test="ls-close" @click="emit('close')">{{ sharing ? t('liveShare.done', 'Done') : t('liveShare.close', 'Close') }}</button>
          <button v-if="!sharing && !preparing" class="confirm-btn primary" :disabled="busy || !projectIds.length" data-test="ls-start" @click="startSharing">
            {{ t('liveShare.share.start', 'Start sharing') }}
          </button>
        </div>
      </section>

      <!-- Join -->
      <section v-else role="tabpanel" data-test="ls-join-panel">
        <template v-if="!inSession">
          <p class="ls-intro">{{ t('liveShare.join.intro', 'Paste the invite code your host sent you. Their panes open here, in a Live Share project.') }}</p>
          <LsGuest v-if="ended" :guest="guest" :ended="ended" @paste="pasteNew" />
          <label class="ls-field">
            <span class="ls-label">{{ t('liveShare.join.invite', 'Invite code') }}</span>
            <input ref="inviteField" v-model="invite" class="ls-input ls-code" type="text" spellcheck="false" autocomplete="off" data-test="ls-join-invite" @keydown.enter="join" />
          </label>
          <label class="ls-field">
            <span class="ls-label">{{ t('liveShare.join.name', 'Your name (the host sees it)') }}</span>
            <input v-model="name" class="ls-input" type="text" spellcheck="false" maxlength="40" data-test="ls-join-name" @keydown.enter="join" />
          </label>
        </template>

        <!-- In a session (or asking to join): the session card. -->
        <template v-else>
          <p v-if="guestState === 'joined'" class="ls-intro" data-test="ls-joined">{{ joinedText }}</p>
          <LsGuest :guest="guest" :projects="guestProjects" @goto="(id) => emit('goto', id)" @follow="(id) => emit('follow', id)" />
        </template>

        <div v-if="joinError" class="ls-error" role="alert" data-test="ls-join-error">{{ joinError }}</div>

        <div class="confirm-actions">
          <button class="confirm-btn" @click="emit('close')">{{ t('liveShare.close', 'Close') }}</button>
          <button v-if="guestState === 'joined' || guestState === 'reconnecting'" class="confirm-btn primary danger" data-test="ls-leave" @click="leave">
            <LogOut :size="14" aria-hidden="true" /> {{ t('liveShare.join.leave', 'Leave') }}
          </button>
          <button v-else-if="inSession" class="confirm-btn" data-test="ls-cancel-join" @click="leave">{{ t('liveShare.join.cancel', 'Cancel') }}</button>
          <button v-else class="confirm-btn primary" :disabled="busy || !invite.trim()" data-test="ls-join" @click="join">
            <LogIn :size="14" aria-hidden="true" /> {{ t('liveShare.join.join', 'Join') }}
          </button>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.ls-card {
  width: min(720px, 100%);
}
.help-head span {
  display: inline-flex;
  align-items: center;
  gap: 7px;
}
.ls-tabs {
  display: flex;
  gap: 4px;
  margin-bottom: 12px;
  padding: 3px;
  border: 1px solid var(--border);
  border-radius: 9px;
}
.ls-tab {
  flex: 1;
  height: 26px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text-dim);
  font: inherit;
  font-size: 12.5px;
  cursor: pointer;
}
.ls-tab:hover {
  background: var(--surface-3);
  color: var(--text);
}
.ls-tab.on {
  background: color-mix(in srgb, var(--accent) 22%, transparent);
  color: var(--text-strong);
}
.ls-tab:focus-visible,
.ls-section-tab:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.ls-sections {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
  margin-bottom: 12px;
  border-bottom: 1px solid var(--border);
}
.ls-section-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  margin-bottom: -1px;
  padding: 0 10px;
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--text-dim);
  font: inherit;
  font-size: 12.5px;
  white-space: nowrap;
  cursor: pointer;
}
.ls-section-tab:hover {
  color: var(--text);
}
.ls-section-tab.on {
  border-bottom-color: var(--accent);
  color: var(--text-strong);
}
.ls-count {
  min-width: 16px;
  height: 16px;
  padding: 0 5px;
  border-radius: 8px;
  background: var(--surface-3);
  color: var(--text);
  font-size: 10.5px;
  line-height: 16px;
  text-align: center;
}
/* Someone waits for your answer. */
.ls-count.warn {
  background: color-mix(in srgb, #d29922 30%, transparent);
  color: #ffd98f;
}
.ls-intro {
  margin: 0 0 12px;
  color: var(--text-dim);
  font-size: 12.5px;
  line-height: 1.45;
}
.ls-hero .ls-intro {
  margin: 0;
}
.ls-callout {
  margin: 12px 0 0;
}
.ls-field {
  display: block;
  margin-top: 14px;
}
.ls-label {
  display: block;
  margin-bottom: 6px;
  color: var(--text-strong);
  font-size: 13px;
  font-weight: 600;
}
.ls-projects {
  min-width: 0;
  margin: 14px 0 0;
  padding: 0;
  border: 0;
}
.ls-projects legend {
  padding: 0;
}
/* The projects as chips: ticked ones lit (a check says it, not only the
   colour). */
.ls-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.ls-pchip {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  height: 26px;
  padding: 0 10px;
  border: 1px solid var(--border-strong);
  border-radius: 13px;
  color: var(--text-dim);
  font-size: 12px;
  cursor: pointer;
}
.ls-pchip input {
  position: absolute;
  opacity: 0;
  pointer-events: none;
}
.ls-pchip:hover {
  background: var(--surface-3);
  color: var(--text);
}
.ls-pchip.on {
  border-color: color-mix(in srgb, var(--accent) 60%, transparent);
  background: color-mix(in srgb, var(--accent) 18%, transparent);
  color: var(--text-strong);
}
.ls-pchip.on svg {
  color: var(--accent);
}
.ls-pchip.locked {
  cursor: default;
}
.ls-pchip:has(:focus-visible) {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.ls-pchip-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ls-hint {
  margin: 6px 0 0;
  color: var(--text-dim);
  font-size: 12px;
  line-height: 1.4;
}
.ls-hint-top {
  margin: 0 0 8px;
}
.ls-first-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 8px;
}
.ls-first-label {
  margin: 0;
}
.ls-first-edit {
  margin-left: auto;
}
.ls-first {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--border);
}
.ls-facts {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 6px;
  margin: 8px 2px 0;
  color: var(--text-dim);
  font-size: 11.5px;
}
.ls-facts .ls-link {
  font-size: 11.5px;
}
/* Rows of the overview: who waits, the codes, who is in. */
.ls-rows {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.ls-row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--surface-2);
}
.ls-row-waiting {
  border-color: color-mix(in srgb, #d29922 45%, transparent);
  background: color-mix(in srgb, #d29922 8%, var(--surface-2));
}
.ls-row-main {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.ls-row-top {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  min-width: 0;
}
.ls-row-name {
  min-width: 0;
  overflow: hidden;
  color: var(--text-strong);
  font-size: 12.5px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ls-row-meta {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  overflow: hidden;
  color: var(--text-dim);
  font-size: 11.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ls-row-meta.typing {
  color: var(--warn);
}
.ls-row-meta svg {
  flex: none;
}
.ls-row-actions {
  display: flex;
  flex: none;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 6px;
}
.ls-code-short {
  flex: none;
  color: var(--text);
  font-family: 'Cascadia Mono', Consolas, monospace;
  font-size: 11.5px;
}
.ls-link {
  margin-left: 4px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--accent);
  font: inherit;
  font-size: 12.5px;
  cursor: pointer;
}
.ls-link:hover {
  text-decoration: underline;
}
.ls-link:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
  border-radius: 3px;
}
.ls-field > .ls-link {
  margin: 6px 0 0;
}
.ls-empty {
  margin: 0;
  color: var(--text-dim);
  font-size: 12.5px;
  line-height: 1.45;
}
.ls-section-off {
  padding: 14px 0;
}
.confirm-actions .confirm-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.ls-stop-confirm {
  margin: 0 0 12px;
}
.ls-error {
  margin-top: 12px;
  color: var(--danger);
  font-size: 12.5px;
}
.ls-recent-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.ls-recent-item {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
  font-size: 12px;
  color: var(--text);
}
.ls-recent-time {
  flex: none;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
}
.ls-recent-text {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}
.ls-recent-project {
  flex: none;
  color: var(--text-dim);
}
/* The one Share page: blocks one under the other, as in a Share dialog. */
.ls-block {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  margin: 0 0 16px;
  padding: 0;
  border: 0;
}
.ls-block-title {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0;
  color: var(--text-strong);
  font-size: 12.5px;
  font-weight: 600;
}
fieldset.ls-block > legend.ls-block-title {
  margin-bottom: 8px;
}
.ls-link-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.ls-link-words {
  color: var(--text);
  font-size: 12px;
}
.ls-link-code {
  flex: 1 1 160px;
  min-width: 0;
  height: 28px;
  box-sizing: border-box;
  padding: 0 10px;
  overflow: hidden;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  background: var(--bg, var(--surface));
  color: var(--text-strong);
  font-size: 12px;
  line-height: 26px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ls-icon-btn {
  padding-inline: 8px;
}
.ls-link-foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  color: var(--text-dim);
  font-size: 11.5px;
}
.ls-more {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  align-self: flex-start;
}
.ls-danger-text {
  color: var(--danger, #f87171);
}
.ls-recent > summary {
  cursor: pointer;
  list-style: revert;
}
.ls-page-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}
.ls-back {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  background: transparent;
  color: var(--text);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.ls-back:hover {
  background: var(--surface-3);
  color: var(--text-strong);
}
.ls-page-title {
  color: var(--text-strong);
  font-size: 13px;
  font-weight: 600;
}
.ls-callout-gap {
  margin-bottom: 16px;
}
.ls-foot {
  display: flex;
  align-items: center;
}
.ls-foot-space {
  flex: 1;
}
.ls-gear {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
/* The header's tools (settings, close). */
.ls-head-tools {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}
/* Who asks to come in: on every page. */
.ls-band {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 14px;
  padding: 9px 12px;
  border: 1px solid color-mix(in srgb, #d29922 45%, transparent);
  border-radius: 9px;
  background: color-mix(in srgb, #d29922 9%, transparent);
}
.ls-band-title {
  color: var(--text-strong);
  font-size: 12px;
  font-weight: 600;
}
.ls-band-row {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
}
.ls-band-main {
  display: flex;
  flex: 1;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 2px 8px;
  min-width: 0;
}
.ls-band-name {
  color: var(--text-strong);
  font-size: 13px;
  font-weight: 600;
}
.ls-band-meta {
  color: var(--text);
  font-size: 11.5px;
}
/* A shared project: its name, a small tag, a cross. */
.ls-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  height: 26px;
  padding: 0 4px 0 10px;
  border: 1px solid color-mix(in srgb, var(--accent) 45%, var(--border-strong));
  border-radius: 999px;
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  color: var(--text-strong);
  font-size: 12px;
}
.ls-chip-name {
  min-width: 0;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ls-chip-tag {
  flex: none;
  color: var(--text-dim);
  font-size: 10.5px;
}
.ls-chip-x {
  display: grid;
  flex: none;
  place-items: center;
  width: 18px;
  height: 18px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--text);
  cursor: pointer;
}
.ls-chip-x:hover:not(:disabled) {
  background: var(--surface-3);
  color: var(--text-strong);
}
.ls-chip-x:disabled {
  opacity: 0.3;
  cursor: default;
}
.ls-chip-x:focus-visible,
.ls-chip-add:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.ls-chip-add {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 11px 0 8px;
  border: 1px dashed var(--border-strong);
  border-radius: 999px;
  background: transparent;
  color: var(--text);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.ls-chip-add:hover {
  border-style: solid;
  background: var(--surface-3);
  color: var(--text-strong);
}
.ls-danger-note {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-left: auto;
  color: #ffb4b6;
  font-size: 11.5px;
  font-weight: 500;
}
.ls-name-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ls-name {
  flex: 1;
  min-width: 0;
  max-width: 260px;
  height: 28px;
}
.ls-dim {
  color: var(--text-dim);
}
</style>
