<script setup>
// Live Share (src/main/liveShare.js): Share lets others join this Tessel from
// theirs; Join opens another Tessel's shared projects here with the code its
// host gave. Why a session ended shows here while the dialog is open (a
// toast says it too).
//
// Share has four sections, all views of main's one access model (the latest
// HostStatus; every change goes to main, which answers with a fresh one),
// under a status header while the share runs or gets ready
// (liveshare/LsStatus.vue: since when, its facts, Stop sharing):
// - Overview: before sharing, one card with the projects to share, your
//   name and the first invitation (its preset, how long it lasts, Edit), the
//   warning about typing, then Start sharing (start, copy, send); while
//   sharing, who waits for your answer (Let in / Refuse), the projects shared
//   (tick or untick at any time), the invitations' codes to copy, who is in
//   now (what they watch or type, their rights in one chip) and what guests
//   changed lately (Recent guest actions);
// - People: everyone of the share, trusted people included (also while not
//   sharing), as a list with filters or as a grid against the shared
//   projects (liveshare/LsPeople.vue, LsAccess.vue);
// - Invitations (LsInvitations.vue);
// - Settings (LsSettings.vue: main's share settings, kept across shares).
// The sections share one context (provide 'lsDialog'): the calls, a change
// on its way per key (a click on a box whose change is on its way does
// nothing), the error and notice lines, the clipboard and the project names.
import { ref, computed, watch, nextTick, onMounted, onUnmounted, provide } from 'vue'
import { ScreenShare, Copy, Check, AlertTriangle, LogIn, LogOut, X, MessageSquareText, UserCheck, Keyboard, Eye } from 'lucide-vue-next'
import { t, intlLocale } from '../i18n'
import { actionText } from '../liveShareWindow'
import { accessError, invitesOf, inviteName, inviteExpiry, joinedGuests, waitingGuests, offlinePeople, personName, viaName, shortCode } from '../liveShareAccess'
import { cleanRights } from '../../../shared/liveShareRights'
import { shownRights, presetRights } from '../liveShareRights'
import LsInviteEditor from './liveshare/LsInviteEditor.vue'
import LsInvitations from './liveshare/LsInvitations.vue'
import LsPeople from './liveshare/LsPeople.vue'
import LsStatus from './liveshare/LsStatus.vue'
import LsSettings from './liveshare/LsSettings.vue'
import LsAvatars from './liveshare/LsAvatars.vue'
import LsGuest from './liveshare/LsGuest.vue'
import RightsChip from './liveshare/RightsChip.vue'
import { plainBridge } from '../liveShareBridge'

const props = defineProps({
  open: { type: Boolean, default: false },
  initialTab: { type: String, default: 'share' },
  // The Share section shown first: overview, people, invites, settings; or
  // one of People's views: access (the grid), trusted (the list, trusted
  // people only).
  initialSection: { type: String, default: 'overview' },
  // The grid: a project's column lit (a project's "Who has access…").
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
const SECTIONS = ['overview', 'people', 'invites', 'settings']
// People's view and filter for the old sections that are one of them now.
const VIEW_OF = { access: { view: 'grid', filter: 'all' }, trusted: { view: 'list', filter: 'trusted' }, people: { view: 'list', filter: 'all' } }

const tab = ref(props.initialTab === 'join' ? 'join' : 'share')
const section = ref('overview')
const peopleView = ref('list')
const peopleFilter = ref('all')
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
// The first invitation's settings (set before you start).
const firstInvite = ref({})
const firstOpen = ref(false)
const confirmStop = ref(false)
const allRecent = ref(false)

const card = ref(null)
let previousFocus = null
const unsubscribe = []

// A section by its id, or an old one (access, trusted: People's views).
function goTo(id) {
  if (VIEW_OF[id]) {
    section.value = 'people'
    peopleView.value = VIEW_OF[id].view
    peopleFilter.value = VIEW_OF[id].filter
  } else section.value = SECTIONS.includes(id) ? id : 'overview'
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
    if (props.open && (SECTIONS.includes(s) || VIEW_OF[s])) {
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
const offline = computed(() => offlinePeople(host.value))

// The projects ticked; while sharing, the last one can't be unticked (Stop
// sharing ends the share).
const ticked = computed(() => new Set(props.projectIds || []))
const lastShared = (p) => sharing.value && ticked.value.size === 1 && ticked.value.has(p.id)
function toggleProject(p, event) {
  const box = event && event.target
  const on = box ? !!box.checked : !ticked.value.has(p.id)
  // The box shows what is ticked until the answer changes it (sharing: once
  // main says so).
  if (box) box.checked = ticked.value.has(p.id)
  if (!on && lastShared(p)) return
  emit('toggle-project', p.id, on)
}
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
  review: (guestId) => emit('review-guest', guestId)
})

// The first invitation, in a few words: how long it lasts (its rights are
// a chip next to it).
const firstLifetime = computed(() => {
  const s = firstInvite.value || {}
  return { hour: t('liveShare.invite.lifetimeHour', '1 hour'), day: t('liveShare.invite.lifetimeDay', '1 day'), week: t('liveShare.invite.lifetimeWeek', '7 days'), never: t('liveShare.invite.lifetimeNever', 'No expiry') }[s.lifetime || 'hour']
})
const firstTypes = computed(() => !!(firstInvite.value && firstInvite.value.rights && firstInvite.value.rights.type === true))

async function startSharing() {
  if (!api || busy.value || !props.projectIds.length) return
  busy.value = true
  hostError.value = ''
  try {
    const r = await api.start({ name: name.value.trim(), projects: [...props.projectIds], invite: { ...firstInvite.value } })
    if (r && !r.ok && r.error) hostError.value = t('liveShare.share.failedWhy', 'Sharing could not start: {{error}}', { error: r.error })
    else if (r && r.ok) {
      onHost(r)
      // Start, copy, send: the first invitation's Copy has the keyboard.
      section.value = 'overview'
      nextTick(() => card.value?.querySelector('[data-test^="ls-first-copy-"]')?.focus())
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

const peopleSummary = computed(() => {
  const parts = []
  parts.push(t('liveShare.share.connected', '{{count}} connected', { count: joined.value.length }))
  if (waiting.value.length) parts.push(t('liveShare.share.waitingCount', '{{count}} waiting for your answer', { count: waiting.value.length }))
  if (offline.value.length) parts.push(t('liveShare.share.offlineCount', '{{count}} offline', { count: offline.value.length }))
  return parts.join(' · ')
})
// What a guest in now has on screen and types in (pane names).
function panesOf(id, what) {
  const names = []
  for (const p of host.value.presence || []) if ((p.guests || []).some((g) => g.id === id && g[what])) names.push(props.paneTitle ? props.paneTitle(p.id) : '')
  return names.filter(Boolean)
}
function inNowMeta(g) {
  const typing = panesOf(g.id, 'typing')
  if (typing.length) return { typing: true, text: t('liveShare.people.typing', 'Typing in {{panes}}', { panes: typing.join(', ') }) }
  const watching = panesOf(g.id, 'watching')
  if (watching.length) return { typing: false, text: t('liveShare.people.watching', 'Watching {{panes}}', { panes: watching.join(', ') }) }
  const via = viaName(g.invite, invites.value)
  return { typing: false, text: via ? t('liveShare.people.via', 'Came with {{invite}}', { invite: via }) : '' }
}
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

const relayOn = computed(() => !(host.value.settings && host.value.settings.rendezvous === false))

// What guests changed lately (main's, newest first): the last five, or all
// main sent.
const RECENT_SHOWN = 5
const actions = computed(() => (Array.isArray(host.value.actions) ? host.value.actions : []))
const recentActions = computed(() => (allRecent.value ? actions.value : actions.value.slice(0, RECENT_SHOWN)))
// Its {{count}} would end a template interpolation: built here.
const recentToggleText = computed(() => (allRecent.value ? t('liveShare.recent.fewer', 'Show fewer') : t('liveShare.recent.all', 'See all ({{count}})', { count: actions.value.length })))
// In the interface's language (French: 06 h 13, not 06:13 AM).
const actionTime = (a) => (Number.isFinite(a.at) ? new Intl.DateTimeFormat(intlLocale(), { hour: '2-digit', minute: '2-digit' }).format(a.at) : '')

const sections = computed(() => [
  { id: 'overview', label: t('liveShare.section.overview', 'Overview') },
  { id: 'people', label: t('liveShare.section.people', 'People'), count: sharing.value ? joined.value.length + waiting.value.length + offline.value.length : null, warn: waiting.value.length > 0 },
  { id: 'invites', label: t('liveShare.section.invites', 'Invitations'), count: sharing.value ? invites.value.length : null },
  { id: 'settings', label: t('liveShare.section.settings', 'Settings') }
])

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
  // (Not the ones folded away: the first invitation's settings, closed.)
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
        <button class="tb-icon" :title="t('liveShare.closeEsc', 'Close (Esc)')" :aria-label="t('liveShare.closeEsc', 'Close (Esc)')" @click="emit('close')"><X :size="14" aria-hidden="true" /></button>
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

        <div class="ls-sections" role="tablist" :aria-label="t('liveShare.section.label', 'Live Share sections')" @keydown="tabKeys($event, SECTIONS, section, (v) => (section = v))">
          <button
            v-for="s in sections"
            :key="s.id"
            type="button"
            role="tab"
            class="ls-section-tab"
            :class="{ on: section === s.id }"
            :aria-selected="section === s.id"
            :tabindex="section === s.id ? 0 : -1"
            :data-test="'ls-section-' + s.id"
            @click="section = s.id"
          >
            <span>{{ s.label }}</span>
            <span v-if="s.count" class="ls-count" :class="{ warn: s.warn }">{{ s.count }}</span>
          </button>
        </div>

        <!-- Overview -->
        <div v-if="section === 'overview'" role="tabpanel" data-test="ls-overview">
          <!-- Before sharing: one card, then Start sharing. -->
          <template v-if="!sharing && !preparing">
            <div class="set-card set-card-pad ls-hero">
              <p class="ls-intro">
                {{ t('liveShare.share.intro4', 'Others join from their own Tessel and see the projects you share, live (their terminals and agents, not their history). Each one waits for your yes, with what their invitation offers.') }}
              </p>
              <fieldset class="ls-field ls-projects" data-test="ls-projects">
                <legend class="ls-label">{{ t('liveShare.share.projects', 'Projects to share') }}</legend>
                <p v-if="!projects.length" class="ls-empty">{{ t('liveShare.share.noProject', 'No project to share') }}</p>
                <ul v-else class="ls-chips">
                  <li v-for="p in projects" :key="p.id">
                    <label class="ls-pchip" :class="{ on: ticked.has(p.id) }" :data-test="'ls-project-' + p.id">
                      <input type="checkbox" :checked="ticked.has(p.id)" @change="toggleProject(p, $event)" />
                      <Check v-if="ticked.has(p.id)" :size="12" aria-hidden="true" />
                      <span class="ls-pchip-name">{{ p.name }}</span>
                      <span v-if="p.noFiles" class="tag tag-warn" :title="t('liveShare.share.noFiles', 'Its files are on an SSH server: guests see its terminals and agents, not its files.')" :data-test="'ls-nofiles-' + p.id">{{ t('liveShare.share.terminalsOnly', 'Terminals only') }}</span>
                    </label>
                  </li>
                </ul>
                <p v-if="projects.length && !projectIds.length" class="ls-hint" data-test="ls-need-project">{{ t('liveShare.share.needProject', 'Tick at least one project.') }}</p>
              </fieldset>

              <label class="ls-field">
                <span class="ls-label">{{ t('liveShare.share.name', 'Your name (guests see it)') }}</span>
                <input v-model="name" class="ls-input" type="text" spellcheck="false" maxlength="40" data-test="ls-share-name" @keydown.enter="startSharing" />
              </label>

              <div class="ls-field">
                <div class="ls-first-row" data-test="ls-first-summary">
                  <span class="ls-label ls-first-label">{{ t('liveShare.share.firstInvite', 'First invitation') }}</span>
                  <RightsChip :rights="firstInvite.rights || {}" />
                  <span class="tag tag-scope">{{ firstLifetime }}</span>
                  <button type="button" class="confirm-btn ls-small ls-first-edit" :aria-expanded="firstOpen" data-test="ls-first-toggle" @click="firstOpen = !firstOpen">
                    {{ firstOpen ? t('liveShare.share.firstDone', 'Done') : t('liveShare.invite.edit', 'Edit') }}
                  </button>
                </div>
                <div v-show="firstOpen" class="ls-first">
                  <LsInviteEditor embedded :projects="sharedList" @update="(s) => (firstInvite = s)" />
                </div>
              </div>

              <div class="set-callout ls-callout" :class="firstTypes ? 'danger' : 'warn'" role="note" data-test="ls-type-warning">
                <AlertTriangle :size="14" aria-hidden="true" />
                <span class="set-callout-text">{{ t('liveShare.share.warning2', 'A guest you let type can run any command on this PC as you. Only let people you trust type.') }}</span>
              </div>
            </div>
            <p class="ls-facts" data-test="ls-facts">
              <span>{{ t('liveShare.status.permanent', 'Comes back after restarts') }}</span>
              <span aria-hidden="true">·</span>
              <span>{{ relayOn ? t('liveShare.overview.relayOn', 'Found again via ntfy.sh: on') : t('liveShare.overview.relayOff', 'Found again via ntfy.sh: off') }}</span>
              <button type="button" class="ls-link" data-test="ls-goto-settings" @click="section = 'settings'">{{ t('liveShare.section.settings', 'Settings') }}</button>
            </p>
          </template>

          <p v-if="preparing" class="ls-empty" data-test="ls-preparing-note">
            {{ host.restarting ? t('liveShare.overview.restarting', 'Your invitations and people come back here once the share has started again.') : t('liveShare.overview.preparing', 'Your first invitation is ready to copy here once the share has started.') }}
          </p>

          <!-- While sharing -->
          <template v-if="sharing">
            <div v-if="waiting.length" class="ls-field ls-waiting" data-test="ls-ov-waiting">
              <div class="ls-label">{{ t('liveShare.people.waitingLabel', 'Waiting for your answer') }}</div>
              <ul class="ls-rows">
                <li v-for="g in waiting" :key="g.id" class="ls-row ls-row-waiting" :data-test="'ls-ov-waiting-' + g.id">
                  <LsAvatars :people="[{ id: g.id, name: personName(g) }]" :size="22" />
                  <span class="ls-row-main">
                    <span class="ls-row-name">{{ personName(g) }}</span>
                    <span class="ls-row-meta">{{ waitingMeta(g) }}</span>
                  </span>
                  <span class="ls-row-actions">
                    <button type="button" class="confirm-btn ls-small primary" :disabled="pending.has(g.id + ':answer')" :data-test="'ls-ov-letin-' + g.id" @click="emit('review-guest', g.id)">
                      <UserCheck :size="12" aria-hidden="true" /> {{ t('liveShare.people.letIn', 'Let in…') }}
                    </button>
                    <button type="button" class="confirm-btn ls-small danger" :disabled="pending.has(g.id + ':answer')" :data-test="'ls-ov-refuse-' + g.id" @click="refuse(g)">{{ t('liveShare.people.refuse', 'Refuse') }}</button>
                  </span>
                </li>
              </ul>
            </div>

            <fieldset class="ls-field ls-projects" data-test="ls-projects">
              <legend class="ls-label">{{ t('liveShare.share.projectsSharedTitle', 'Projects you share') }}</legend>
              <ul class="ls-chips">
                <li v-for="p in projects" :key="p.id">
                  <label
                    class="ls-pchip"
                    :class="{ on: ticked.has(p.id), locked: lastShared(p) }"
                    :title="lastShared(p) ? t('liveShare.share.lastProject', 'To stop sharing your last project, use Stop sharing.') : ''"
                    :data-test="'ls-project-' + p.id"
                  >
                    <input type="checkbox" :checked="ticked.has(p.id)" :disabled="lastShared(p)" @change="toggleProject(p, $event)" />
                    <Check v-if="ticked.has(p.id)" :size="12" aria-hidden="true" />
                    <span class="ls-pchip-name">{{ p.name }}</span>
                    <span v-if="p.noFiles" class="tag tag-warn" :title="t('liveShare.share.noFiles', 'Its files are on an SSH server: guests see its terminals and agents, not its files.')" :data-test="'ls-nofiles-' + p.id">{{ t('liveShare.share.terminalsOnly', 'Terminals only') }}</span>
                  </label>
                </li>
              </ul>
              <p v-if="ticked.size === 1" class="ls-hint" data-test="ls-last-project">{{ t('liveShare.share.lastProject', 'To stop sharing your last project, use Stop sharing.') }}</p>
              <p v-else class="ls-hint">{{ t('liveShare.share.projectsSharedHint', 'Tick or untick them at any time.') }}</p>
            </fieldset>

            <div class="ls-field">
              <div class="ls-label">{{ t('liveShare.share.codesTitle', 'Invitation codes') }}</div>
              <p class="ls-hint ls-hint-top">{{ t('liveShare.share.codesHint', 'Send one: each person waits for your yes. Codes stop working when you stop sharing; trusted people get in with any new code.') }}</p>
              <p v-if="!invites.length" class="ls-empty" data-test="ls-no-invites">
                {{ t('liveShare.share.noInvites', 'No invitation left: make one to let people ask to join.') }}
                <button type="button" class="ls-link" @click="section = 'invites'">{{ t('liveShare.invite.new', 'New invitation') }}</button>
              </p>
              <ul v-else class="ls-rows">
                <li v-for="inv in invites.slice(0, 3)" :key="inv.id" class="ls-row ls-inv" :data-test="'ls-first-' + inv.id">
                  <span class="ls-row-main">
                    <span class="ls-row-top">
                      <span class="ls-row-name">{{ inviteName(inv) }}</span>
                      <RightsChip :rights="inv.rights || {}" />
                      <span v-if="inv.state === 'blocked'" class="tag tag-danger">{{ t('liveShare.invite.badgeBlocked', 'Blocked') }}</span>
                      <span v-else-if="inv.state === 'used'" class="tag tag-warn">{{ t('liveShare.invite.badgeUsed', 'Used up') }}</span>
                    </span>
                    <span class="ls-row-meta">
                      <code class="ls-code-short" :title="inv.code || ''" data-test="ls-invite">{{ shortCode(inv.code) }}</code>
                      <span aria-hidden="true">·</span>
                      <span>{{ inviteExpiry(inv, now).text }}</span>
                    </span>
                  </span>
                  <span class="ls-row-actions">
                    <button type="button" class="confirm-btn ls-small primary" :disabled="!inv.code || inv.state !== 'live'" :data-test="'ls-first-copy-' + inv.id" @click="copyInvite(inv, false)">
                      <Check v-if="copied === 'code:' + inv.id" :size="13" aria-hidden="true" />
                      <Copy v-else :size="13" aria-hidden="true" />
                      {{ copied === 'code:' + inv.id ? t('liveShare.share.copied', 'Copied') : t('liveShare.invite.copyCode', 'Copy code') }}
                    </button>
                    <button
                      type="button"
                      class="confirm-btn ls-small"
                      :disabled="!inv.code || inv.state !== 'live'"
                      :title="t('liveShare.invite.copyMessageTitle', 'The code with a line saying how to join')"
                      :data-test="'ls-first-message-' + inv.id"
                      @click="copyInvite(inv, true)"
                    >
                      <Check v-if="copied === 'message:' + inv.id" :size="13" aria-hidden="true" />
                      <MessageSquareText v-else :size="13" aria-hidden="true" />
                      {{ copied === 'message:' + inv.id ? t('liveShare.share.copied', 'Copied') : t('liveShare.invite.copyMessage', 'Copy message') }}
                    </button>
                  </span>
                </li>
              </ul>
              <button
                v-if="invites.length"
                type="button"
                class="ls-link"
                data-test="ls-goto-invites"
                @click="section = 'invites'"
                v-text="invites.length > 3 ? t('liveShare.share.allInvites', 'All {{count}} invitations…', { count: invites.length }) : t('liveShare.share.manageInvites', 'Manage invitations…')"
              ></button>
            </div>

            <div class="ls-field" data-test="ls-in-now">
              <div class="ls-label">{{ t('liveShare.overview.inNow', 'In now') }}</div>
              <p class="ls-empty" data-test="ls-people-summary">
                {{ joined.length || waiting.length || offline.length ? peopleSummary : t('liveShare.share.noGuests', 'No one has joined yet.') }}
                <button v-if="joined.length || waiting.length || offline.length" type="button" class="ls-link" @click="goTo('people')">{{ t('liveShare.share.seePeople', 'See people…') }}</button>
              </p>
              <ul v-if="joined.length" class="ls-rows ls-in-list">
                <li v-for="g in joined" :key="g.id" class="ls-row" :data-test="'ls-in-' + g.id">
                  <LsAvatars :people="[{ id: g.id, name: personName(g) }]" :size="22" />
                  <span class="ls-row-main">
                    <span class="ls-row-name">{{ personName(g) }}</span>
                    <span v-if="inNowMeta(g).text" class="ls-row-meta" :class="{ typing: inNowMeta(g).typing }">
                      <Keyboard v-if="inNowMeta(g).typing" :size="12" aria-hidden="true" />
                      <Eye v-else-if="panesOf(g.id, 'watching').length" :size="12" aria-hidden="true" />
                      {{ inNowMeta(g).text }}
                    </span>
                  </span>
                  <RightsChip :rights="g.rights || {}" />
                </li>
              </ul>
            </div>

            <div class="ls-field" data-test="ls-recent">
              <div class="ls-label">{{ t('liveShare.recent.title', 'Recent guest actions') }}</div>
              <p v-if="!recentActions.length" class="ls-empty" data-test="ls-recent-none">{{ t('liveShare.recent.none', 'Nothing changed by a guest yet.') }}</p>
              <ul v-else class="ls-recent-list">
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
            </div>
          </template>
        </div>

        <!-- People: everyone, as a list (filters) or a grid -->
        <div v-else-if="section === 'people'" role="tabpanel" data-test="ls-people-section">
          <LsPeople v-model:view="peopleView" v-model:filter="peopleFilter" :focus-project="focusProject" />
        </div>

        <LsInvitations v-else-if="section === 'invites' && sharing" role="tabpanel" />
        <LsSettings v-else-if="section === 'settings'" role="tabpanel" />
        <p v-else class="ls-empty ls-section-off" role="tabpanel" data-test="ls-section-off">{{ t('liveShare.section.offInvites', 'Invitations come with a share: start sharing, and the first one is ready to copy.') }}</p>

        <div v-if="hostNotice" class="set-callout info ls-callout" role="status" data-test="ls-host-notice">{{ hostNotice }}</div>
        <div v-if="hostError" class="set-callout danger ls-callout" role="alert" data-test="ls-host-error">
          <AlertTriangle :size="14" aria-hidden="true" />
          <span class="set-callout-text">{{ hostError }}</span>
        </div>

        <div class="confirm-actions">
          <button class="confirm-btn" @click="emit('close')">{{ t('liveShare.close', 'Close') }}</button>
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
</style>
