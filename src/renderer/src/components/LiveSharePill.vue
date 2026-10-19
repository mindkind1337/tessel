<script setup>
// Live Share in the top bar, while you share or are in someone's session
// (App.vue builds `pill` from liveShareWindow.js's state):
// - host: "● Live · N" (the dot coloured while someone is connected, grey
//   while nobody is), with an amber badge while people wait for your answer;
//   "Starting…", "Restarting…" (a share coming back by itself) or "Retrying
//   in 30 s" (it could not yet). Its popover: a status header (since when,
//   and the tags: it comes back after restarts, the ntfy.sh relay on or
//   off), the people waiting (their code, Let in), Copy invite code, the
//   projects shared (a click goes to one, × takes it out while another
//   stays, who is there), Share / Stop sharing the project on screen, the
//   people connected (what they look at, their rights in one chip), then
//   Manage… and Stop Live Share;
// - guest: "● Live with <host>". Its popover: what it means, your
//   verification code, whether your screen follows the host's (a switch),
//   what you may do (a chip, the words under it), the host's projects shared
//   with you, Manage… and Leave. Reconnecting: how many tries, and whether
//   the ntfy.sh relay is asked for the host's new address. In a host's
//   project, once you pick something yourself, "Follow host" also shows
//   beside the pill; the task copy the host looks at is said too.
// Escape or a click outside closes the popover (the keyboard goes back to
// the pill).
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { X, Plus, ScreenShareOff, Eye, Keyboard, LogOut, Copy, Check } from 'lucide-vue-next'
import LsAvatars from './liveshare/LsAvatars.vue'
import RightsChip from './liveshare/RightsChip.vue'
import { clockText } from '../liveShareTime'
import { t } from '../i18n'

const props = defineProps({
  // Host: { mode: 'host', starting, restarting, retryAt, since, relay,
  //   guests: [{ id, name, via, rights, watching: [pane names], typing: [pane
  //   names] }], waiting (how many), waitingList: [{ id, name, code }],
  //   invite: { id, label, code } | null, projects: [{ id, name, here,
  //   people: [{ id, name }] }], current: { id, name, shared } | null }
  // Guest: { mode: 'guest', host, reconnecting, retry: { tries, lookup } |
  //   null, rights (in words), grant (the rights object), code, projects:
  //   [{ id, name, here }], follow: { on, copy } | null }
  pill: { type: Object, required: true }
})
// open(section), goto(id), share(id, on), stop, leave, follow, unfollow,
// review(guestId): Let in (its prompt first), copy-invite
const emit = defineEmits(['open', 'goto', 'share', 'stop', 'leave', 'follow', 'unfollow', 'review', 'copy-invite'])

const open = ref(false)
const root = ref(null)
const button = ref(null)
const pop = ref(null)
const isHost = computed(() => props.pill.mode === 'host')
const guests = computed(() => (Array.isArray(props.pill.guests) ? props.pill.guests : []))
const projects = computed(() => (Array.isArray(props.pill.projects) ? props.pill.projects : []))
const waitingList = computed(() => (isHost.value && Array.isArray(props.pill.waitingList) ? props.pill.waitingList : []))
const waitingCount = computed(() => (isHost.value ? Math.max(Number(props.pill.waiting) || 0, waitingList.value.length) : 0))
const count = computed(() => guests.value.length)
// Someone is connected (host), or the session is live (guest).
const lit = computed(() => (isHost.value ? !props.pill.starting && count.value > 0 : !props.pill.reconnecting))

// A share that could not start again yet: the seconds until its next try.
const now = ref(Date.now())
let tick = 0
const retryIn = computed(() => {
  const at = isHost.value && props.pill.starting ? props.pill.retryAt : null
  return Number.isFinite(at) && at > now.value ? Math.ceil((at - now.value) / 1000) : 0
})
watch(
  () => (isHost.value && props.pill.starting ? props.pill.retryAt : null),
  (at) => {
    clearInterval(tick)
    tick = 0
    now.value = Date.now()
    if (Number.isFinite(at) && at > now.value) tick = setInterval(() => (now.value = Date.now()) >= at && clearInterval(tick), 1000)
  },
  { immediate: true }
)

const startingLabel = computed(() => {
  if (retryIn.value) return t('liveShare.pill.retryIn', 'Retrying in {{count}} s', { count: retryIn.value })
  return props.pill.restarting ? t('liveShare.pill.restarting', 'Restarting…') : t('liveShare.pill.starting', 'Starting…')
})
const label = computed(() => {
  const p = props.pill
  if (!isHost.value) return p.reconnecting ? t('liveShare.pill.reconnecting', 'Reconnecting to {{host}}…', { host: p.host || '?' }) : t('liveShare.pill.guest', 'Live with {{host}}', { host: p.host || '?' })
  if (p.starting) return startingLabel.value
  return t('liveShare.pill.host', 'Live · {{count}}', { count: count.value })
})
const waitingBadge = computed(() => (waitingCount.value === 1 ? t('liveShare.pill.waitingBadge', '{{count}} waiting for your answer', { count: 1 }) : t('liveShare.pill.waitingBadge', '{{count}} waiting for your answer', { count: waitingCount.value })))
const ariaLabel = computed(() => {
  if (!isHost.value) return t('liveShare.pill.guestLabel', 'Live Share: in {{host}}’s session. Open the details', { host: props.pill.host || '?' })
  if (props.pill.starting) return t('liveShare.pill.startingLabel', 'Live Share is starting. Open the details')
  const base =
    count.value === 1
      ? t('liveShare.pill.hostLabel', 'Live Share: sharing, {{count}} person connected. Open the details', { count: 1 })
      : t('liveShare.pill.hostLabel', 'Live Share: sharing, {{count}} people connected. Open the details', { count: count.value })
  return waitingCount.value ? `${base} (${waitingBadge.value})` : base
})
const headText = computed(() => {
  if (props.pill.starting) return props.pill.restarting ? t('liveShare.pill.restartingHead', 'Your share is starting again…') : t('liveShare.pill.startingHead', 'Starting your share…')
  if (!count.value) return t('liveShare.pill.nobody', 'Sharing: nobody connected yet')
  return count.value === 1 ? t('liveShare.pill.connected', 'Sharing: {{count}} person connected', { count: 1 }) : t('liveShare.pill.connected', 'Sharing: {{count}} people connected', { count: count.value })
})
const sinceText = computed(() => {
  const time = props.pill.starting ? '' : clockText(props.pill.since)
  return time ? t('liveShare.pill.since', 'Since {{time}}', { time }) : ''
})
const retryText = computed(() => (retryIn.value ? t('liveShare.pill.retryText', 'It could not start yet: next try in {{count}} s.', { count: retryIn.value }) : ''))
const waitingText = computed(() =>
  waitingCount.value === 1 ? t('liveShare.pill.waiting', '{{count}} person waiting for your answer', { count: 1 }) : t('liveShare.pill.waiting', '{{count}} people waiting for your answer', { count: waitingCount.value })
)
const canRemove = computed(() => !props.pill.starting && projects.value.length > 1)
const current = computed(() => (isHost.value ? props.pill.current || null : null))
const invite = computed(() => (isHost.value && !props.pill.starting && props.pill.invite && props.pill.invite.code ? props.pill.invite : null))
const codeOf = (g) => (g.code ? t('liveShare.pill.codeShort', 'Code {{code}}', { code: g.code }) : '')

// Guest: in a host's project, following the host's screen or not, and the
// task copy the host looks at.
const follow = computed(() => (!isHost.value && props.pill.follow ? props.pill.follow : null))
const copyText = computed(() => (follow.value && follow.value.copy ? t('liveShare.follow.copy', '{{host}} is looking at the task copy {{branch}}.', { host: props.pill.host || '?', branch: follow.value.copy }) : ''))
const followLabel = computed(() => t('liveShare.pill.followSwitch', 'Follow {{host}}’s screen', { host: props.pill.host || '?' }))
const followText = computed(() =>
  follow.value && follow.value.on ? t('liveShare.follow.on', 'Your screen follows {{host}}’s.', { host: props.pill.host || '?' }) : t('liveShare.follow.off', 'You picked your own view: it no longer follows {{host}}’s.', { host: props.pill.host || '?' })
)
const guestText = computed(() => t('liveShare.pill.guestText', 'You are in {{host}}’s session: its panes run on {{host}}’s computer, and {{host}} decides what you can do.', { host: props.pill.host || '?' }))
const reconnectText = computed(() => {
  const r = props.pill.retry
  if (isHost.value || !props.pill.reconnecting || !r) return ''
  const tries = r.tries === 1 ? t('liveShare.pill.tries', 'Try {{count}}', { count: 1 }) : t('liveShare.pill.tries', 'Try {{count}}', { count: r.tries || 0 })
  return r.lookup ? `${tries} · ${t('liveShare.reconnect.lookup', 'Looking up the host’s new address via ntfy.sh')}` : tries
})
const codeText = computed(() => (props.pill.code ? t('liveShare.pill.code', 'Your verification code: {{code}}', { code: props.pill.code }) : ''))
function whatText(g) {
  if (g.typing && g.typing.length) return t('liveShare.pill.typing', 'Typing in {{panes}}', { panes: g.typing.join(', ') })
  if (g.watching && g.watching.length) return t('liveShare.pill.watching', 'Watching {{panes}}', { panes: g.watching.join(', ') })
  return ''
}

// "Copied" for a moment after Copy invite code.
const copied = ref(false)
let copiedTimer = 0
function copyInvite() {
  emit('copy-invite', invite.value)
  copied.value = true
  clearTimeout(copiedTimer)
  copiedTimer = setTimeout(() => (copied.value = false), 1500)
}
function setFollow(event) {
  const want = !!event.target.checked
  event.target.checked = !!(follow.value && follow.value.on)
  emit(want ? 'follow' : 'unfollow')
}

function toggle() {
  if (open.value) return close(true)
  open.value = true
  nextTick(() => pop.value?.querySelector('button')?.focus())
}
function close(refocus) {
  open.value = false
  if (refocus) nextTick(() => button.value?.focus())
}
function act(name, ...args) {
  close(false)
  emit(name, ...args)
}
function onDocDown(e) {
  if (open.value && root.value && !root.value.contains(e.target)) close(false)
}
onMounted(() => document.addEventListener('pointerdown', onDocDown, true))
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocDown, true)
  clearInterval(tick)
  clearTimeout(copiedTimer)
})
</script>

<template>
  <div ref="root" class="lsp-wrap" @keydown.escape="open && (close(true), $event.stopPropagation())">
    <button
      ref="button"
      type="button"
      class="lsp-pill"
      :class="[pill.mode, { lit, open }]"
      :aria-label="ariaLabel"
      :title="ariaLabel"
      :aria-expanded="open"
      aria-haspopup="dialog"
      data-test="live-pill"
      @click="toggle"
    >
      <span class="lsp-dot" :class="{ lit, pulse: !lit && (pill.starting || pill.reconnecting) }" aria-hidden="true" data-test="live-pill-dot"></span>
      <span class="lsp-text">{{ label }}</span>
      <span v-if="waitingCount" class="lsp-badge" aria-hidden="true" data-test="live-pill-badge">{{ waitingCount }}</span>
    </button>
    <button
      v-if="follow && !follow.on"
      type="button"
      class="lsp-follow"
      data-test="live-pill-follow"
      :title="t('liveShare.follow.hint', 'Your screen follows {{host}}’s again: the tab, pane and file {{host}} has on screen', { host: pill.host || '?' })"
      @click="emit('follow')"
    >
      {{ t('liveShare.follow.button', 'Follow host') }}
    </button>

    <div v-if="open" ref="pop" class="lsp-pop" role="dialog" :aria-label="t('liveShare.title', 'Live Share')" data-test="live-pill-popover">
      <!-- Host -->
      <template v-if="isHost">
        <div class="lsp-status">
          <div class="lsp-head">
            <span class="lsp-dot" :class="{ lit, pulse: pill.starting }" aria-hidden="true"></span>
            <span data-test="live-pill-head">{{ headText }}</span>
          </div>
          <p v-if="retryText" class="lsp-text-block lsp-warn-text" data-test="live-pill-retry">{{ retryText }}</p>
          <div class="lsp-tags">
            <span v-if="sinceText" class="lsp-since" data-test="live-pill-since">{{ sinceText }}</span>
            <span class="tag tag-scope" :title="t('liveShare.status.permanentHint', 'Until you stop it, the share starts again by itself when Tessel restarts, with its invitations and people.')" data-test="live-pill-permanent">{{ t('liveShare.pill.permanent', 'Permanent') }}</span>
            <span v-if="pill.relay !== undefined" class="tag" :class="pill.relay ? 'tag-ok' : 'tag-off'" data-test="live-pill-relay">{{ pill.relay ? t('liveShare.status.relayOn', 'Relay on') : t('liveShare.status.relayOff', 'Relay off') }}</span>
          </div>
        </div>

        <template v-if="waitingCount">
          <div class="lsp-title lsp-warn-title" data-test="live-pill-waiting">{{ waitingText }}</div>
          <ul v-if="waitingList.length" class="lsp-list">
            <li v-for="g in waitingList" :key="g.id" class="lsp-person lsp-waiting-row" :data-test="'live-pill-wait-' + g.id">
              <LsAvatars :people="[{ id: g.id, name: g.name }]" :size="20" />
              <span class="lsp-person-text">
                <span class="lsp-person-name">{{ g.name }}</span>
                <span v-if="g.code" class="lsp-person-meta lsp-code">{{ codeOf(g) }}</span>
              </span>
              <button type="button" class="lsp-btn primary" :data-test="'live-pill-letin-' + g.id" @click="act('review', g.id)">{{ t('liveShare.pill.letIn', 'Let in…') }}</button>
            </li>
          </ul>
        </template>

        <div v-if="invite" class="lsp-invite" data-test="live-pill-invite">
          <button type="button" class="lsp-btn" :title="invite.code" data-test="live-pill-copy-invite" @click="copyInvite">
            <Check v-if="copied" :size="12" aria-hidden="true" />
            <Copy v-else :size="12" aria-hidden="true" />
            {{ copied ? t('liveShare.pill.copied', 'Copied') : t('liveShare.pill.copyInvite', 'Copy invite code') }}
          </button>
          <span v-if="invite.label" class="lsp-person-meta lsp-invite-label">{{ invite.label }}</span>
        </div>

        <div class="lsp-title">{{ t('liveShare.pill.projects', 'Shared projects') }}</div>
        <ul class="lsp-list">
          <li v-for="p in projects" :key="p.id" class="lsp-row" :class="{ here: p.here }" :data-test="'live-pill-project-' + p.id">
            <button type="button" class="lsp-link" :title="p.here ? t('liveShare.pill.here', 'On screen now') : t('liveShare.pill.goto', 'Go to {{project}}', { project: p.name })" @click="act('goto', p.id)">{{ p.name }}</button>
            <LsAvatars :people="p.people || []" :size="16" :lead="t('liveShare.pill.inProject', 'In {{project}}:', { project: p.name })" />
            <button
              v-if="canRemove"
              type="button"
              class="lsp-icon"
              :title="t('liveShare.pill.removeProject', 'Stop sharing {{project}}: guests no longer see it', { project: p.name })"
              :aria-label="t('liveShare.pill.removeProject', 'Stop sharing {{project}}: guests no longer see it', { project: p.name })"
              :data-test="'live-pill-remove-' + p.id"
              @click="act('share', p.id, false)"
            >
              <X :size="12" aria-hidden="true" />
            </button>
          </li>
        </ul>
        <div v-if="current && !pill.starting" class="lsp-current">
          <button v-if="!current.shared" type="button" class="lsp-btn" data-test="live-pill-share-here" @click="act('share', current.id, true)">
            <Plus :size="12" aria-hidden="true" /> {{ t('liveShare.pill.shareHere', 'Share this project') }}
          </button>
          <button v-else-if="canRemove" type="button" class="lsp-btn" data-test="live-pill-unshare-here" @click="act('share', current.id, false)">
            <ScreenShareOff :size="12" aria-hidden="true" /> {{ t('liveShare.pill.unshareHere', 'Stop sharing this project') }}
          </button>
        </div>

        <div class="lsp-title">{{ t('liveShare.pill.people', 'Connected') }}</div>
        <p v-if="!guests.length" class="lsp-empty" data-test="live-pill-nobody">{{ t('liveShare.pill.nobodyHint2', 'Nobody yet. Copy an invite code and send it to them.') }}</p>
        <ul v-else class="lsp-list">
          <li v-for="g in guests" :key="g.id" class="lsp-person" :data-test="'live-pill-guest-' + g.id">
            <LsAvatars :people="[{ id: g.id, name: g.name }]" :size="20" />
            <span class="lsp-person-text">
              <span class="lsp-person-name">{{ g.name }}</span>
              <span v-if="g.via" class="lsp-person-meta">{{ g.via }}</span>
              <span v-if="whatText(g)" class="lsp-person-meta lsp-what">
                <Keyboard v-if="g.typing && g.typing.length" :size="11" aria-hidden="true" />
                <Eye v-else :size="11" aria-hidden="true" />
                {{ whatText(g) }}
              </span>
            </span>
            <RightsChip v-if="g.rights" class="lsp-chip" :rights="g.rights" />
          </li>
        </ul>

        <div class="lsp-actions">
          <button type="button" class="lsp-btn" data-test="live-pill-manage" @click="act('open', 'overview')">{{ t('liveShare.pill.manage', 'Manage…') }}</button>
          <button type="button" class="lsp-btn danger" data-test="live-pill-stop" @click="act('stop')">{{ t('liveShare.pill.stop', 'Stop Live Share') }}</button>
        </div>
      </template>

      <!-- Guest -->
      <template v-else>
        <div class="lsp-head">
          <span class="lsp-dot guest" :class="{ lit, pulse: pill.reconnecting }" aria-hidden="true"></span>
          <span>{{ label }}</span>
        </div>
        <p v-if="reconnectText" class="lsp-text-block lsp-warn-text" data-test="live-pill-reconnect">{{ reconnectText }}</p>
        <p class="lsp-text-block" data-test="live-pill-guest-text">{{ guestText }}</p>
        <p v-if="codeText" class="lsp-text-block lsp-dim" data-test="live-pill-code">{{ codeText }}</p>
        <label v-if="follow" class="lsp-switch-row" data-test="live-pill-follow-switch">
          <span class="lsp-switch-text">
            <span>{{ followLabel }}</span>
            <span class="lsp-person-meta" data-test="live-pill-following">
              {{ followText }}
              <span v-if="copyText" data-test="live-pill-copy"> {{ copyText }}</span>
            </span>
          </span>
          <input type="checkbox" class="set-switch" :checked="follow.on" @change="setFollow" />
        </label>
        <div v-if="pill.rights" class="lsp-rights" data-test="live-pill-rights-box">
          <RightsChip v-if="pill.grant" :rights="pill.grant" />
          <p class="lsp-text-block lsp-dim" data-test="live-pill-rights">{{ pill.rights }}</p>
        </div>
        <template v-if="projects.length">
          <div class="lsp-title">{{ t('liveShare.pill.sharedWithYou', 'Shared with you') }}</div>
          <ul class="lsp-list">
            <li v-for="p in projects" :key="p.id" class="lsp-row" :class="{ here: p.here }">
              <button type="button" class="lsp-link" :title="t('liveShare.pill.goto', 'Go to {{project}}', { project: p.name })" @click="act('goto', p.id)">{{ p.name }}</button>
            </li>
          </ul>
        </template>
        <div class="lsp-actions">
          <button type="button" class="lsp-btn" data-test="live-pill-manage" @click="act('open', 'join')">{{ t('liveShare.pill.manage', 'Manage…') }}</button>
          <button type="button" class="lsp-btn danger" data-test="live-pill-leave" @click="act('leave')"><LogOut :size="12" aria-hidden="true" /> {{ t('liveShare.pill.leave', 'Leave') }}</button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.lsp-wrap {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.lsp-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 240px;
  height: 24px;
  margin: 0 2px;
  padding: 0 10px 0 8px;
  border: 1px solid var(--border-strong);
  border-radius: 12px;
  background: var(--surface-2);
  color: var(--text);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.lsp-pill:hover,
.lsp-pill.open {
  background: var(--surface-3);
  color: var(--text-strong);
}
.lsp-pill.host.lit {
  border-color: color-mix(in srgb, var(--danger) 55%, transparent);
}
.lsp-pill.guest {
  border-color: color-mix(in srgb, var(--accent) 55%, transparent);
}
.lsp-pill:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
/* A narrow window (or a big zoom): the pill gives room to the toolbar; its
   full words stay in its tooltip and popover. */
@media (max-width: 760px) {
  .lsp-pill {
    max-width: 130px;
  }
}
.lsp-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* People waiting for your answer: an amber count on the pill. */
.lsp-badge {
  flex: none;
  min-width: 16px;
  height: 16px;
  margin-right: -4px;
  padding: 0 4px;
  border-radius: 8px;
  background: var(--warn);
  color: #1b1405;
  font-size: 10.5px;
  font-weight: 700;
  line-height: 16px;
  text-align: center;
  box-sizing: border-box;
}
.lsp-dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-dim);
}
.lsp-dot.lit {
  background: var(--danger);
}
.lsp-pill.guest .lsp-dot.lit,
.lsp-dot.guest.lit {
  background: var(--accent);
}
.lsp-dot.pulse {
  animation: lsp-pulse 1.4s ease-in-out infinite;
}
@keyframes lsp-pulse {
  50% {
    opacity: 0.35;
  }
}
.lsp-pop {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 60;
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: min(360px, calc(100vw - 24px));
  max-height: min(560px, 78vh);
  overflow-y: auto;
  padding: 10px;
  border: 1px solid var(--border-strong);
  border-radius: 10px;
  background: var(--surface-2);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
  color: var(--text);
  font-size: 12.5px;
}
.lsp-status {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border);
}
.lsp-head {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-strong);
  font-weight: 600;
}
.lsp-tags {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 6px;
  padding-left: 16px;
}
.lsp-since {
  color: var(--text-dim);
  font-size: 11.5px;
}
.lsp-title {
  margin-top: 4px;
  color: var(--text-dim);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.03em;
  text-transform: uppercase;
}
.lsp-warn-title {
  color: var(--warn);
}
.lsp-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.lsp-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding: 2px 4px;
  border-radius: 6px;
}
.lsp-row.here {
  background: color-mix(in srgb, var(--accent) 12%, transparent);
}
.lsp-link {
  flex: 1 1 auto;
  min-width: 0;
  padding: 2px 0;
  overflow: hidden;
  border: 0;
  background: transparent;
  color: var(--text);
  font: inherit;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}
.lsp-link:hover {
  color: var(--text-strong);
  text-decoration: underline;
}
.lsp-icon {
  display: inline-grid;
  flex: none;
  place-items: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
}
.lsp-icon:hover {
  background: var(--surface-3);
  color: var(--text-strong);
}
.lsp-current {
  display: flex;
}
.lsp-invite {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.lsp-invite-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.lsp-person {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 3px 4px;
}
.lsp-waiting-row {
  align-items: center;
  border-radius: 6px;
  background: color-mix(in srgb, #d29922 10%, transparent);
}
.lsp-person-text {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-width: 0;
}
.lsp-person-name {
  overflow: hidden;
  color: var(--text-strong);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.lsp-person-meta {
  color: var(--text-dim);
  font-size: 11.5px;
  overflow-wrap: anywhere;
}
.lsp-code {
  font-variant-numeric: tabular-nums;
}
.lsp-chip {
  flex: none;
  margin-top: 2px;
}
.lsp-what {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.lsp-empty,
.lsp-text-block {
  margin: 0;
  line-height: 1.45;
  overflow-wrap: anywhere;
}
.lsp-empty,
.lsp-dim {
  color: var(--text-dim);
}
.lsp-warn-text {
  color: var(--warn);
}
.lsp-switch-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 0;
  border-top: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
  cursor: pointer;
}
.lsp-switch-text {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.lsp-rights {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
}
.lsp-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
  padding-top: 8px;
  border-top: 1px solid var(--border);
}
.lsp-btn {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 5px;
  height: 24px;
  padding: 0 9px;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  background: transparent;
  color: var(--text);
  font: inherit;
  font-size: 12px;
  white-space: nowrap;
  cursor: pointer;
}
.lsp-btn:hover {
  border-color: var(--accent);
  color: var(--text-strong);
}
.lsp-btn.primary {
  border-color: transparent;
  background: var(--accent);
  color: var(--chrome);
}
.lsp-btn.primary:hover {
  filter: brightness(1.1);
}
.lsp-btn.danger {
  border-color: color-mix(in srgb, var(--danger) 60%, transparent);
  color: #ffb4b6;
}
.lsp-btn:focus-visible,
.lsp-link:focus-visible,
.lsp-icon:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.lsp-follow {
  height: 22px;
  padding: 0 9px;
  border: 1px solid var(--accent);
  border-radius: 11px;
  background: transparent;
  color: var(--accent);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
  white-space: nowrap;
}
.lsp-follow:hover {
  background: var(--accent);
  color: var(--chrome);
}
</style>
