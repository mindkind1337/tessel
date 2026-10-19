<script setup>
// Live Share's Join tab once you joined, or asked to: the session card.
// Who hosts and where the session is (a tag: connecting, waiting for an
// answer, connected, reconnecting), your verification code (big while the
// host has not answered yet: they check it), the host's projects shared with
// you (a click goes to one; whether your screen follows the host's there,
// with Follow host), and what you can do (the rights grid, read only, and
// the agents the host lets you use). Reconnecting: how many tries, and that
// Tessel looks for the host's new address on the ntfy.sh relay (after the
// second try, with the relay on).
//
// Out of a session: how the last one ended, if it did (a warning, with
// "Paste a new code": an old code or a host's new share needs a new one).
import { computed } from 'vue'
import { Loader2, AlertTriangle, ClipboardPaste, Bot } from 'lucide-vue-next'
import LsAvatars from './LsAvatars.vue'
import RightsGrid from './RightsGrid.vue'
import RightsChip from './RightsChip.vue'
import { endReason, rightsText } from '../../liveShareWindow'
import { t } from '../../i18n'

const props = defineProps({
  // main's guest status (liveShare.js guestStatus).
  guest: { type: Object, required: true },
  // How the session joined from here ended ({ reason, host }), or null.
  ended: { type: Object, default: null },
  // The host's projects open here: [{ id (the project's id here), name,
  // here, follow: { on } | null }].
  projects: { type: Array, default: () => [] }
})
// goto(id), follow(id): follow the host's screen there again; paste: a new
// code (the field emptied and focused).
const emit = defineEmits(['goto', 'follow', 'paste'])

const state = computed(() => props.guest.state)
const inSession = computed(() => ['connecting', 'waiting', 'joined', 'reconnecting'].includes(state.value))
const host = computed(() => props.guest.host || '')
const hostName = computed(() => host.value || t('liveShare.guestCard.theHost', 'The host'))
// In a sentence: the host's name, or "your host".
const inText = computed(() => host.value || t('liveShare.guestCard.yourHost', 'your host'))
const stateTag = computed(() => {
  if (state.value === 'joined') return { cls: 'tag-ok', text: t('liveShare.guestCard.connected', 'Connected') }
  if (state.value === 'waiting') return { cls: 'tag-warn', text: t('liveShare.guestCard.waiting', 'Waiting for an answer') }
  if (state.value === 'reconnecting') return { cls: 'tag-warn', text: t('liveShare.guestCard.reconnecting', 'Reconnecting') }
  return { cls: 'tag-info', text: t('liveShare.guestCard.connecting', 'Connecting') }
})
const subText = computed(() => {
  if (state.value === 'waiting') return t('liveShare.guestCard.waitingText', 'Your request is with {{host}}, who decides what you can do.', { host: inText.value })
  if (state.value === 'connecting') return t('liveShare.join.connecting', 'Connecting…')
  return t('liveShare.guestCard.hostText', 'Hosts this session: its panes run on {{host}}’s computer.', { host: inText.value })
})
const retry = computed(() => (state.value === 'reconnecting' && props.guest.retry ? props.guest.retry : null))
const triesText = computed(() => {
  const n = retry.value ? retry.value.tries || 0 : 0
  return n === 1 ? t('liveShare.guestCard.tries', '{{count}} try so far', { count: 1 }) : t('liveShare.guestCard.tries', '{{count}} tries so far', { count: n })
})
const reconnectText = computed(() => t('liveShare.guestCard.reconnectText', 'The connection to {{host}} was lost. Tessel tries again by itself; your projects stay meanwhile, view only.', { host: inText.value }))
const joined = computed(() => state.value === 'joined')
const rights = computed(() => props.guest.rights || null)
const rightsLine = computed(() => rightsText(props.guest.rights))
// The host's agents this guest may use (null: a host from before that list).
const agents = computed(() => (Array.isArray(props.guest.agents) ? props.guest.agents : null))
const noProjectsText = computed(() => t('liveShare.join.noProjects', '{{host}} has not given you a project to see yet.', { host: hostName.value }))
const followTitle = computed(() => t('liveShare.follow.hint', 'Your screen follows {{host}}’s again: the tab, pane and file {{host}} has on screen', { host: inText.value }))
// (Their {{host}} would end a template interpolation: built here.)
const codeHint = computed(() =>
  state.value === 'waiting'
    ? t('liveShare.guestCard.codeWaiting', 'Tell {{host}} this code: they see it too, and check it before letting you in.', { host: inText.value })
    : t('liveShare.guestCard.codeIn', 'It is the same code {{host}} saw.', { host: inText.value })
)
const followingText = computed(() => t('liveShare.guestCard.following', 'Follows {{host}}', { host: hostName.value }))
const endedText = computed(() => (props.ended ? endReason(props.ended.reason) : ''))
const endedTitle = computed(() => (props.ended && props.ended.host ? t('liveShare.guestCard.endedWith', 'Your session with {{host}} ended', { host: props.ended.host }) : t('liveShare.guestCard.ended', 'Your session ended')))
</script>

<template>
  <div class="lsg">
    <!-- Out of a session: how the last one ended. -->
    <div v-if="!inSession && ended" class="set-callout warn lsg-ended" role="status" data-test="ls-ended">
      <AlertTriangle :size="15" aria-hidden="true" />
      <span class="set-callout-text">
        <strong class="lsg-ended-title">{{ endedTitle }}</strong>
        <span data-test="ls-ended-why">{{ endedText }}</span>
      </span>
      <button type="button" class="confirm-btn ls-small" data-test="ls-paste-new" @click="emit('paste')"><ClipboardPaste :size="13" aria-hidden="true" /> {{ t('liveShare.guestCard.pasteNew', 'Paste a new code') }}</button>
    </div>

    <!-- The session card. -->
    <div v-else-if="inSession" class="set-card set-card-pad lsg-card" :data-test="'ls-guest-' + state">
      <div class="lsg-head">
        <LsAvatars v-if="host" :people="[{ id: 'host:' + host, name: host }]" :size="30" />
        <Loader2 v-else :size="20" class="bp-spin lsg-spin" aria-hidden="true" />
        <div class="lsg-who">
          <div class="lsg-name">
            <span data-test="ls-guest-host">{{ hostName }}</span>
            <span class="tag" :class="stateTag.cls" data-test="ls-guest-state">{{ stateTag.text }}</span>
          </div>
          <div class="lsg-sub">{{ subText }}</div>
        </div>
      </div>

      <!-- Reconnecting: the tries, the relay. -->
      <div v-if="state === 'reconnecting'" class="set-callout warn lsg-callout" role="status" data-test="ls-reconnecting">
        <Loader2 :size="14" class="bp-spin" aria-hidden="true" />
        <span class="set-callout-text">
          {{ reconnectText }}
          <span v-if="retry" class="lsg-tries" data-test="ls-reconnect-tries">{{ triesText }}</span>
          <span v-if="retry && retry.lookup" class="lsg-tries" data-test="ls-reconnect-lookup">{{ t('liveShare.reconnect.lookup', 'Looking up the host’s new address via ntfy.sh') }}</span>
        </span>
      </div>

      <!-- Your verification code. -->
      <div v-if="guest.code" class="lsg-code" :class="{ big: state === 'waiting' }" data-test="ls-code">
        <span class="lsg-label">{{ t('liveShare.guestCard.code', 'Your verification code') }}</span>
        <strong class="lsg-code-value">{{ guest.code }}</strong>
        <span class="lsg-hint">{{ codeHint }}</span>
      </div>

      <!-- The host's projects shared with you. -->
      <div v-if="joined || state === 'reconnecting'" class="lsg-section" data-test="ls-guest-projects">
        <div class="lsg-label">{{ t('liveShare.guestCard.projects', 'Shared with you') }}</div>
        <p v-if="!projects.length" class="lsg-hint" data-test="ls-no-projects">{{ noProjectsText }}</p>
        <ul v-else class="lsg-projects">
          <li v-for="p in projects" :key="p.id" class="lsg-project" :class="{ here: p.here }" :data-test="'ls-guest-project-' + p.id">
            <button type="button" class="lsg-link" :title="t('liveShare.pill.goto', 'Go to {{project}}', { project: p.name })" @click="emit('goto', p.id)">{{ p.name }}</button>
            <template v-if="p.follow">
              <span v-if="p.follow.on" class="tag tag-info" data-test="ls-guest-following">{{ followingText }}</span>
              <template v-else>
                <span class="tag" data-test="ls-guest-own-view">{{ t('liveShare.guestCard.ownView', 'Your own view') }}</span>
                <button type="button" class="confirm-btn ls-small" :title="followTitle" :data-test="'ls-guest-follow-' + p.id" @click="emit('follow', p.id)">{{ t('liveShare.follow.button', 'Follow host') }}</button>
              </template>
            </template>
          </li>
        </ul>
      </div>

      <!-- What you can do. -->
      <div v-if="joined && rights" class="lsg-section" data-test="ls-guest-rights">
        <div class="lsg-label lsg-label-row">
          <span>{{ t('liveShare.guestCard.rights', 'What you can do') }}</span>
          <RightsChip :rights="rights" />
        </div>
        <RightsGrid :rights="rights" disabled dense test-key="guest" :label="t('liveShare.guestCard.rights', 'What you can do')" />
        <p class="lsg-hint" data-test="ls-rights">{{ rightsLine }}</p>
        <div v-if="agents" class="lsg-agents" data-test="ls-guest-agents">
          <span class="lsg-label lsg-agents-label"><Bot :size="13" aria-hidden="true" /> {{ t('liveShare.guestCard.agents', 'Agents you can use') }}</span>
          <span v-for="a in agents" :key="a.id" class="tag tag-scope">{{ a.name || a.id }}</span>
          <span v-if="!agents.length" class="tag tag-off">{{ t('liveShare.agents.none', 'No agent') }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.lsg {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-bottom: 4px;
}
.lsg-ended {
  margin: 4px 0 0;
}
.lsg-ended .set-callout-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.lsg-ended-title {
  color: var(--text-strong);
}
.lsg-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.lsg-head {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.lsg-spin {
  flex: none;
  color: var(--text-dim);
}
.lsg-who {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.lsg-name {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  color: var(--text-strong);
  font-size: 14px;
  font-weight: 600;
  overflow-wrap: anywhere;
}
.lsg-sub,
.lsg-hint {
  margin: 0;
  color: var(--text-dim);
  font-size: 12px;
  line-height: 1.45;
  overflow-wrap: anywhere;
}
.lsg-callout {
  margin: 0;
}
.lsg-callout .set-callout-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.lsg-tries {
  color: var(--text-dim);
}
.lsg-code {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 2px 10px;
}
.lsg-code .lsg-hint {
  flex: 1 1 100%;
}
.lsg-code-value {
  color: var(--text-strong);
  font-family: var(--mono-font, ui-monospace, monospace);
  font-size: 14px;
  letter-spacing: 0.06em;
}
.lsg-code.big {
  padding: 10px 12px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--accent) 12%, transparent);
}
.lsg-code.big .lsg-code-value {
  font-size: 22px;
}
.lsg-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 10px;
  border-top: 1px solid var(--border);
}
.lsg-label {
  color: var(--text-dim);
  font-size: 12px;
}
.lsg-label-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.lsg-projects {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.lsg-project {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  min-width: 0;
  padding: 3px 6px;
  border-radius: 6px;
}
.lsg-project.here {
  background: color-mix(in srgb, var(--accent) 12%, transparent);
}
.lsg-link {
  min-width: 0;
  max-width: 100%;
  padding: 0;
  overflow: hidden;
  border: 0;
  background: none;
  color: var(--text);
  font: inherit;
  font-size: 12.5px;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}
.lsg-link:hover {
  color: var(--text-strong);
  text-decoration: underline;
}
.lsg-link:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.lsg-agents {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 6px;
}
.lsg-agents-label {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-right: 2px;
}
</style>
