<script setup>
// Live Share (src/main/liveShare.js): Share lets others join this Tessel from
// theirs; Join opens another Tessel's shared projects here with the code its
// host gave. Why a session ended shows here while the dialog is open (a
// toast says it too).
//
// Share has five sections, all views of main's one access model (the latest
// HostStatus; every change goes to main, which answers with a fresh one):
// - Overview: before sharing, the projects to share, your name and the first
//   invitation's settings (Start sharing makes it: start, copy, send); while
//   sharing, the invitations' codes to copy, the projects shared (tick or
//   untick at any time), who is there, and what guests changed lately
//   (Recent guest actions); always, the share's setting "Hide ignored and
//   secret files from guests" (main's, kept across shares);
// - Invitations (liveshare/LsInvitations.vue), People (LsPeople.vue), Access
//   (LsAccess.vue: the people x projects grid, or one project's people) and
//   Trusted (LsTrusted.vue, also while not sharing).
// The sections share one context (provide 'lsDialog'): the calls, a change
// on its way per key (a click on a box whose change is on its way does
// nothing), the error and notice lines, the clipboard and the project names.
import { ref, computed, watch, nextTick, onMounted, onUnmounted, provide } from 'vue'
import { ScreenShare, Copy, Check, Loader2, AlertTriangle, LogIn, LogOut, ChevronDown, X } from 'lucide-vue-next'
import { t, intlLocale } from '../i18n'
import { endReason, rightsText, actionText } from '../liveShareWindow'
import { accessError, invitesOf, inviteName, inviteExpiry, joinedGuests, waitingGuests, offlinePeople, trustedPeople } from '../liveShareAccess'
import { rightsShort } from '../liveShareRights'
import LsInviteEditor from './liveshare/LsInviteEditor.vue'
import LsInvitations from './liveshare/LsInvitations.vue'
import LsPeople from './liveshare/LsPeople.vue'
import LsAccess from './liveshare/LsAccess.vue'
import LsTrusted from './liveshare/LsTrusted.vue'
import { plainBridge } from '../liveShareBridge'

const props = defineProps({
  open: { type: Boolean, default: false },
  initialTab: { type: String, default: 'share' },
  // The Share section shown first: overview, invites, people, access, trusted.
  initialSection: { type: String, default: 'overview' },
  // Access: a project shown on its own first (a project's "Who has access…").
  focusProject: { type: String, default: null },
  // Your projects ({ id, name }), and the ones ticked: shared, or picked to
  // share before you start.
  projects: { type: Array, default: () => [] },
  projectIds: { type: Array, default: () => [] },
  // The name of one of your panes (what a guest is watching).
  paneTitle: { type: Function, default: null }
})
// toggle-project(id, on): a project ticked or not (liveShareWindow.js setShared);
// review-guest(id): People's "Let in…" for a guest waiting for your answer
// (liveShareWindow.js showAsk puts their prompt first).
const emit = defineEmits(['close', 'toggle-project', 'review-guest'])

// Plain arguments only (liveShareBridge.js): the first invitation lives in a
// ref, and a reactive object makes the call throw before it is sent.
const api = plainBridge(window.shellApi && window.shellApi.liveShare)
const OFF_HOST = { state: 'off', projectIds: [], invites: [], guests: [], offline: [], trusted: [], presence: [], progress: null, error: null, settings: { hideIgnored: true }, actions: [] }
const OFF_GUEST = { state: 'off', host: null, panes: [], projects: [], reason: null, rights: null, code: null, agents: null }
const SECTIONS = ['overview', 'invites', 'people', 'access', 'trusted']

const tab = ref(props.initialTab === 'join' ? 'join' : 'share')
const section = ref(SECTIONS.includes(props.initialSection) ? props.initialSection : 'overview')
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

const card = ref(null)
let previousFocus = null
const unsubscribe = []

function onHost(status) {
  host.value = { ...OFF_HOST, ...(status || {}) }
  if (host.value.state === 'error' && host.value.error) hostError.value = host.value.error
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
  section.value = SECTIONS.includes(props.initialSection) ? props.initialSection : 'overview'
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
    if (props.open && SECTIONS.includes(s)) {
      tab.value = 'share'
      section.value = s
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
const trusted = computed(() => trustedPeople(host.value))

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
  review: (guestId) => emit('review-guest', guestId)
})

const firstSummary = computed(() => {
  const s = firstInvite.value || {}
  const life = { hour: t('liveShare.invite.lifetimeHour', '1 hour'), day: t('liveShare.invite.lifetimeDay', '1 day'), week: t('liveShare.invite.lifetimeWeek', '7 days'), never: t('liveShare.invite.lifetimeNever', 'No expiry') }[s.lifetime || 'hour']
  return t('liveShare.share.firstSummary', '{{lifetime}}, {{rights}}', { lifetime: life, rights: rightsShort(s.rights).toLocaleLowerCase() })
})

async function startSharing() {
  if (!api || busy.value || !props.projectIds.length) return
  busy.value = true
  hostError.value = ''
  try {
    const r = await api.start({ name: name.value.trim(), projects: [...props.projectIds], invite: { ...firstInvite.value } })
    if (r && !r.ok && r.error) hostError.value = r.error
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
async function copyInvite(inv) {
  if (!inv.code || !(await copyText(inv.code))) return
  copied.value = inv.id
  clearTimeout(copiedTimer)
  copiedTimer = setTimeout(() => (copied.value = ''), 1500)
}
const stopText = computed(() =>
  joined.value.length === 1
    ? t('liveShare.share.stopText', 'Stop sharing? {{count}} person is disconnected and every invitation stops working.', { count: 1 })
    : t('liveShare.share.stopText', 'Stop sharing? {{count}} people are disconnected and every invitation stops working.', { count: joined.value.length })
)
const peopleSummary = computed(() => {
  const parts = []
  parts.push(t('liveShare.share.connected', '{{count}} connected', { count: joined.value.length }))
  if (waiting.value.length) parts.push(t('liveShare.share.waitingCount', '{{count}} waiting for your answer', { count: waiting.value.length }))
  if (offline.value.length) parts.push(t('liveShare.share.offlineCount', '{{count}} offline', { count: offline.value.length }))
  return parts.join(' · ')
})

// The share's setting for guests (main's): hide what git ignores and what
// looks like a secret. A change counts for every request from now on.
const hideIgnored = computed(() => !(host.value.settings && host.value.settings.hideIgnored === false))
function setHideIgnored(event) {
  const box = event && event.target
  const want = box ? !!box.checked : !hideIgnored.value
  if (box) box.checked = hideIgnored.value
  run('setting:hideIgnored', async () => {
    const r = await api.setSettings({ hideIgnored: want })
    if (r && r.ok && r.settings) host.value = { ...host.value, settings: { ...r.settings } }
    return r
  })
}
// The relay (main's): "Find me again after a restart", on unless turned off.
const rendezvous = computed(() => !(host.value.settings && host.value.settings.rendezvous === false))
function setRendezvous(event) {
  const box = event && event.target
  const want = box ? !!box.checked : !rendezvous.value
  if (box) box.checked = rendezvous.value
  run('setting:rendezvous', async () => {
    const r = await api.setSettings({ rendezvous: want })
    if (r && r.ok && r.settings) host.value = { ...host.value, settings: { ...r.settings } }
    return r
  })
}
// What guests changed lately (main's, newest first): the last few here.
const RECENT_SHOWN = 8
const recentActions = computed(() => (Array.isArray(host.value.actions) ? host.value.actions : []).slice(0, RECENT_SHOWN))
// In the interface's language (French: 06 h 13, not 06:13 AM).
const actionTime = (a) => (Number.isFinite(a.at) ? new Intl.DateTimeFormat(intlLocale(), { hour: '2-digit', minute: '2-digit' }).format(a.at) : '')

const sections = computed(() => [
  { id: 'overview', label: t('liveShare.section.overview', 'Overview') },
  { id: 'invites', label: t('liveShare.section.invites', 'Invitations'), count: sharing.value ? invites.value.length : null },
  { id: 'people', label: t('liveShare.section.people', 'People'), count: sharing.value ? joined.value.length + waiting.value.length + offline.value.length : null },
  { id: 'access', label: t('liveShare.section.access', 'Access') },
  { id: 'trusted', label: t('liveShare.section.trusted', 'Trusted'), count: trusted.value.length }
])

// --- Join ----------------------------------------------------------------
const guestState = computed(() => guest.value.state)
const inSession = computed(() => ['connecting', 'waiting', 'joined', 'reconnecting'].includes(guestState.value))
const joinedText = computed(() => t('liveShare.join.joined2', 'You joined {{host}}’s Live Share. Each project they share with you opens as a Live Share project in the sidebar.', { host: guest.value.host || '?' }))
const noProjectsText = computed(() =>
  guest.value.state === 'joined' && !(guest.value.projects || []).length ? t('liveShare.join.noProjects', '{{host}} has not given you a project to see yet.', { host: guest.value.host || '?' }) : ''
)
const rightsLine = computed(() => rightsText(guest.value.rights))
// Its {{host}} would end a template interpolation: built here.
const reconnectingText = computed(() => t('liveShare.join.reconnecting', 'Connection lost: reconnecting to {{host}}…', { host: guest.value.host || '?' }))
const codeLine = computed(() => (guest.value.code ? t('liveShare.join.code', 'Your code is {{code}}. Tell your host, so they know it is you.', { code: guest.value.code }) : ''))

const endedText = computed(() => (ended.value ? endReason(ended.value.reason) : ''))

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
  const items = [...(card.value?.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)') || [])].filter((el) => !el.closest('[style*="display: none"]'))
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
            <span v-if="s.count" class="ls-count">{{ s.count }}</span>
          </button>
        </div>

        <!-- Overview -->
        <div v-if="section === 'overview'" role="tabpanel" data-test="ls-overview">
          <template v-if="!sharing && !preparing">
            <p class="ls-intro">
              {{ t('liveShare.share.intro4', 'Others join from their own Tessel and see the projects you share, live (their terminals and agents, not their history). Each one waits for your yes, with what their invitation offers.') }}
            </p>
            <div class="ls-warn" role="note">
              <AlertTriangle :size="15" aria-hidden="true" />
              <span>{{ t('liveShare.share.warning2', 'A guest you let type can run any command on this PC as you. Only let people you trust type.') }}</span>
            </div>
          </template>

          <fieldset class="ls-field ls-projects" data-test="ls-projects">
            <legend class="ls-label">{{ sharing ? t('liveShare.share.projectsSharedTitle', 'Projects you share') : t('liveShare.share.projects', 'Projects to share') }}</legend>
            <p v-if="sharing" class="ls-hint ls-hint-top">{{ t('liveShare.share.projectsSharedHint', 'Tick or untick them at any time.') }}</p>
            <p v-if="!projects.length" class="ls-empty">{{ t('liveShare.share.noProject', 'No project to share') }}</p>
            <ul v-else class="ls-project-list">
              <li v-for="p in projects" :key="p.id">
                <label
                  class="ls-project"
                  :class="{ locked: lastShared(p) }"
                  :title="lastShared(p) ? t('liveShare.share.lastProject', 'To stop sharing your last project, use Stop sharing.') : ''"
                  :data-test="'ls-project-' + p.id"
                >
                  <input type="checkbox" :checked="ticked.has(p.id)" :disabled="preparing || lastShared(p)" @change="toggleProject(p, $event)" />
                  <span class="ls-project-name">{{ p.name }}</span>
                </label>
                <p v-if="p.noFiles" class="ls-hint ls-project-note" :data-test="'ls-nofiles-' + p.id">{{ t('liveShare.share.noFiles', 'Its files are on an SSH server: guests see its terminals and agents, not its files.') }}</p>
              </li>
            </ul>
            <p v-if="!sharing && !preparing && projects.length && !projectIds.length" class="ls-hint" data-test="ls-need-project">{{ t('liveShare.share.needProject', 'Tick at least one project.') }}</p>
            <p v-if="sharing && ticked.size === 1" class="ls-hint" data-test="ls-last-project">{{ t('liveShare.share.lastProject', 'To stop sharing your last project, use Stop sharing.') }}</p>
          </fieldset>

          <div class="ls-field" data-test="ls-settings">
            <label class="ls-setting">
              <input type="checkbox" :checked="hideIgnored" :disabled="pending.has('setting:hideIgnored')" data-test="ls-hide-ignored" @change="setHideIgnored" />
              <span class="ls-setting-text">
                <span>{{ t('liveShare.setting.hideIgnored', 'Hide ignored and secret files from guests') }}</span>
                <span class="ls-hint">{{ t('liveShare.setting.hideIgnoredHint', 'Files git ignores and files that look like secrets (.env, keys, credentials) stay out of guests’ Files, search and Changes. .git and .tessel are always hidden.') }}</span>
              </span>
            </label>
            <label class="ls-setting">
              <input type="checkbox" :checked="rendezvous" :disabled="pending.has('setting:rendezvous')" data-test="ls-rendezvous" @change="setRendezvous" />
              <span class="ls-setting-text">
                <span>{{ t('liveShare.setting.rendezvous', 'Find me again after a restart (uses ntfy.sh)') }}</span>
                <span class="ls-hint">{{ t('liveShare.setting.rendezvousHint', 'When your address changes, Tessel leaves it, encrypted, on the free ntfy.sh relay so your guests find you (and looks there for a host’s when you are a guest). Off: nothing is sent there, and codes stop working when your address changes.') }}</span>
              </span>
            </label>
          </div>

          <template v-if="!sharing && !preparing">
            <label class="ls-field">
              <span class="ls-label">{{ t('liveShare.share.name', 'Your name (guests see it)') }}</span>
              <input v-model="name" class="ls-input" type="text" spellcheck="false" maxlength="40" data-test="ls-share-name" @keydown.enter="startSharing" />
            </label>
            <div class="ls-field">
              <button type="button" class="ls-disclosure" :aria-expanded="firstOpen" data-test="ls-first-toggle" @click="firstOpen = !firstOpen">
                <ChevronDown :size="14" :class="{ closed: !firstOpen }" aria-hidden="true" />
                <span>{{ t('liveShare.share.firstInvite', 'First invitation') }}</span>
                <span class="ls-disclosure-meta">{{ firstSummary }}</span>
              </button>
              <div v-show="firstOpen" class="ls-first">
                <LsInviteEditor embedded :projects="sharedList" @update="(s) => (firstInvite = s)" />
              </div>
            </div>
          </template>

          <div v-if="preparing" class="ls-status" data-test="ls-progress">
            <Loader2 :size="15" class="bp-spin" aria-hidden="true" />
            <span>{{ progressText }}</span>
          </div>

          <template v-if="sharing">
            <div class="ls-field">
              <div class="ls-label">{{ t('liveShare.share.codesTitle', 'Invitation codes') }}</div>
              <p class="ls-hint ls-hint-top">{{ t('liveShare.share.codesHint', 'Send one: each person waits for your yes. Codes stop working when you stop sharing; trusted people get in with any new code.') }}</p>
              <p v-if="!invites.length" class="ls-empty" data-test="ls-no-invites">
                {{ t('liveShare.share.noInvites', 'No invitation left: make one to let people ask to join.') }}
                <button type="button" class="ls-link" @click="section = 'invites'">{{ t('liveShare.invite.new', 'New invitation') }}</button>
              </p>
              <ul v-else class="ls-first-list">
                <li v-for="inv in invites.slice(0, 3)" :key="inv.id" class="ls-first-item" :data-test="'ls-first-' + inv.id">
                  <span class="ls-first-head">
                    <span class="ls-first-name">{{ inviteName(inv) }}</span>
                    <span class="ls-first-meta">{{ inviteExpiry(inv, now).text }}</span>
                  </span>
                  <input class="ls-input ls-code" type="text" readonly spellcheck="false" :value="inv.code || ''" :aria-label="t('liveShare.invite.codeLabel', 'Code of {{label}}', { label: inviteName(inv) })" data-test="ls-invite" @focus="$event.target.select()" />
                  <button type="button" class="confirm-btn ls-small primary" :disabled="!inv.code || inv.state !== 'live'" :data-test="'ls-first-copy-' + inv.id" @click="copyInvite(inv)">
                    <Check v-if="copied === inv.id" :size="13" aria-hidden="true" />
                    <Copy v-else :size="13" aria-hidden="true" />
                    {{ copied === inv.id ? t('liveShare.share.copied', 'Copied') : t('liveShare.invite.copyCode', 'Copy code') }}
                  </button>
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
            <div class="ls-field">
              <div class="ls-label">{{ t('liveShare.share.guests', 'Guests') }}</div>
              <p class="ls-empty" data-test="ls-people-summary">
                {{ joined.length || waiting.length || offline.length ? peopleSummary : t('liveShare.share.noGuests', 'No one has joined yet.') }}
                <button v-if="joined.length || waiting.length || offline.length" type="button" class="ls-link" @click="section = 'people'">{{ t('liveShare.share.seePeople', 'See people…') }}</button>
              </p>
            </div>
            <div class="ls-field" data-test="ls-recent">
              <div class="ls-label">{{ t('liveShare.recent.title', 'Recent guest actions') }}</div>
              <p v-if="!recentActions.length" class="ls-empty" data-test="ls-recent-none">{{ t('liveShare.recent.none', 'Nothing changed by a guest yet.') }}</p>
              <ul v-else class="ls-recent-list">
                <li v-for="a in recentActions" :key="a.id" class="ls-recent-item" :class="{ flagged: a.flagged }" :data-test="'ls-recent-' + a.id">
                  <span class="ls-recent-time">{{ actionTime(a) }}</span>
                  <span class="ls-recent-text">{{ actionText(a) }}</span>
                  <span v-if="projectName(a.project) && sharedList.length > 1" class="ls-recent-project">{{ projectName(a.project) }}</span>
                  <span v-if="a.flagged" class="ls-recent-flag" :title="t('liveShare.recent.flaggedHint', 'This file tells agents what to do: check the change.')">{{ t('liveShare.recent.flagged', 'Agent instructions') }}</span>
                </li>
              </ul>
            </div>
          </template>
        </div>

        <LsInvitations v-else-if="section === 'invites' && sharing" role="tabpanel" />
        <LsPeople v-else-if="section === 'people' && sharing" role="tabpanel" />
        <LsAccess v-else-if="section === 'access'" role="tabpanel" :focus-project="focusProject" />
        <LsTrusted v-else-if="section === 'trusted'" role="tabpanel" />
        <p v-else class="ls-empty ls-section-off" role="tabpanel" data-test="ls-section-off">{{ t('liveShare.section.off', 'Start sharing first: invitations and people come with a share.') }}</p>

        <div v-if="hostNotice" class="ls-notice" role="status" data-test="ls-host-notice">{{ hostNotice }}</div>
        <div v-if="hostError" class="ls-error" role="alert" data-test="ls-host-error">{{ hostError }}</div>

        <div v-if="confirmStop" class="lsd-confirm ls-stop-confirm" role="group" :aria-label="stopText" data-test="ls-stop-confirm" @keydown.escape.stop.prevent="confirmStop = false">
          <p class="lsd-confirm-text">{{ stopText }}</p>
          <div class="lsd-actions">
            <button type="button" class="confirm-btn ls-small" data-test="ls-stop-cancel" @click="confirmStop = false">{{ t('liveShare.share.keepSharing', 'Keep sharing') }}</button>
            <button type="button" class="confirm-btn ls-small primary danger" data-test="ls-stop-yes" @click="stopSharing">{{ t('liveShare.share.stop', 'Stop sharing') }}</button>
          </div>
        </div>

        <div class="confirm-actions">
          <button class="confirm-btn" @click="emit('close')">{{ t('liveShare.close', 'Close') }}</button>
          <button v-if="preparing" class="confirm-btn" data-test="ls-cancel-share" @click="stopSharing">{{ host.restarting ? t('liveShare.share.stop', 'Stop sharing') : t('liveShare.share.cancel', 'Cancel') }}</button>
          <template v-else-if="sharing">
            <!-- Asked inline: that confirm's Stop sharing is the only one. -->
            <button v-if="!confirmStop" class="confirm-btn primary danger" data-test="ls-stop" @click="askStop">{{ t('liveShare.share.stop', 'Stop sharing') }}</button>
          </template>
          <button v-else class="confirm-btn primary" :disabled="busy || !projectIds.length" data-test="ls-start" @click="startSharing">
            {{ t('liveShare.share.start', 'Start sharing') }}
          </button>
        </div>
      </section>

      <!-- Join -->
      <section v-else role="tabpanel" data-test="ls-join-panel">
        <template v-if="!inSession">
          <p class="ls-intro">{{ t('liveShare.join.intro', 'Paste the invite code your host sent you. Their panes open here, in a Live Share project.') }}</p>
          <label class="ls-field">
            <span class="ls-label">{{ t('liveShare.join.invite', 'Invite code') }}</span>
            <input v-model="invite" class="ls-input ls-code" type="text" spellcheck="false" autocomplete="off" data-test="ls-join-invite" @keydown.enter="join" />
          </label>
          <label class="ls-field">
            <span class="ls-label">{{ t('liveShare.join.name', 'Your name (the host sees it)') }}</span>
            <input v-model="name" class="ls-input" type="text" spellcheck="false" maxlength="40" data-test="ls-join-name" @keydown.enter="join" />
          </label>
          <div v-if="ended" class="ls-ended" role="status" data-test="ls-ended">{{ endedText }}</div>
        </template>

        <div v-else-if="guestState === 'connecting'" class="ls-status" data-test="ls-connecting">
          <Loader2 :size="15" class="bp-spin" aria-hidden="true" />
          <span>{{ t('liveShare.join.connecting', 'Connecting…') }}</span>
        </div>
        <div v-else-if="guestState === 'reconnecting'" class="ls-status" data-test="ls-reconnecting">
          <Loader2 :size="15" class="bp-spin" aria-hidden="true" />
          <span>{{ reconnectingText }}</span>
        </div>
        <template v-else-if="guestState === 'waiting'">
          <div class="ls-status" data-test="ls-waiting">
            <Loader2 :size="15" class="bp-spin" aria-hidden="true" />
            <span>{{ t('liveShare.join.waiting', 'Waiting for the host to accept…') }}</span>
          </div>
          <div v-if="codeLine" class="ls-joined" data-test="ls-code">{{ codeLine }}</div>
        </template>
        <template v-else>
          <div class="ls-joined" data-test="ls-joined">{{ joinedText }}</div>
          <p v-if="noProjectsText" class="ls-intro ls-rights-line" data-test="ls-no-projects">{{ noProjectsText }}</p>
          <p class="ls-intro ls-rights-line" data-test="ls-rights">{{ rightsLine }}</p>
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
.ls-intro {
  margin: 0 0 12px;
  color: var(--text-dim);
  font-size: 12.5px;
  line-height: 1.45;
}
.ls-warn {
  display: flex;
  gap: 8px;
  padding: 9px 11px;
  border: 1px solid color-mix(in srgb, var(--warn) 50%, transparent);
  border-radius: 8px;
  background: color-mix(in srgb, var(--warn) 12%, transparent);
  color: var(--text);
  font-size: 12px;
  line-height: 1.45;
}
.ls-warn svg {
  flex: 0 0 auto;
  margin-top: 1px;
  color: var(--warn);
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
.ls-project-list {
  margin: 0;
  padding: 4px;
  border: 1px solid var(--border);
  border-radius: 9px;
  list-style: none;
  max-height: 22vh;
  overflow-y: auto;
}
.ls-project {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 6px;
  border-radius: 7px;
  color: var(--text);
  font-size: 12.5px;
  cursor: pointer;
}
.ls-project:hover {
  background: var(--surface-3);
}
.ls-project.locked {
  cursor: default;
}
.ls-project input {
  margin: 0;
  accent-color: var(--accent);
}
.ls-project-name {
  flex: 1;
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
.ls-project-note {
  margin: 2px 0 6px 26px;
}
.ls-hint-top {
  margin: 0 0 8px;
}
.ls-disclosure {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-width: 0;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: transparent;
  color: var(--text);
  font: inherit;
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
}
.ls-disclosure:hover {
  background: var(--surface-3);
}
.ls-disclosure:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.ls-disclosure svg {
  flex: none;
  transition: transform 0.12s;
}
.ls-disclosure svg.closed {
  transform: rotate(-90deg);
}
.ls-disclosure-meta {
  min-width: 0;
  margin-left: auto;
  overflow: hidden;
  color: var(--text-dim);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ls-first {
  margin-top: 10px;
  padding: 0 4px;
}
.ls-first-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.ls-first-item {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 6px 8px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 9px;
}
.ls-first-head {
  display: flex;
  grid-column: 1 / -1;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}
.ls-first-head .ls-first-name {
  flex: 1;
}
.ls-first-item > .confirm-btn {
  justify-content: center;
  min-width: 120px;
}
.ls-first-name {
  min-width: 0;
  overflow: hidden;
  color: var(--text-strong);
  font-size: 12.5px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ls-first-meta {
  color: var(--text-dim);
  font-size: 11.5px;
  text-align: right;
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
.ls-rights-line {
  margin: 10px 0 0;
}
.ls-status {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 14px;
  color: var(--text);
  font-size: 12.5px;
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
  margin-top: 12px;
}
.ls-joined,
.ls-ended {
  margin-top: 14px;
  padding: 9px 11px;
  border-radius: 8px;
  color: var(--text-strong);
  font-size: 12.5px;
  line-height: 1.45;
}
.ls-joined {
  background: color-mix(in srgb, var(--accent) 12%, transparent);
}
.ls-ended {
  background: var(--surface-2);
  color: var(--text);
}
.ls-notice {
  margin-top: 12px;
  color: var(--text);
  font-size: 12.5px;
}
.ls-error {
  margin-top: 12px;
  color: var(--danger);
  font-size: 12.5px;
}
.ls-setting {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 12.5px;
  color: var(--text);
  cursor: pointer;
}
.ls-setting input {
  flex: none;
  margin: 2px 0 0;
  accent-color: var(--accent);
}
.ls-setting-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
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
.ls-recent-flag {
  flex: none;
  padding: 0 6px;
  border-radius: 8px;
  font-size: 11px;
  color: var(--warn);
  border: 1px solid currentColor;
}
</style>
