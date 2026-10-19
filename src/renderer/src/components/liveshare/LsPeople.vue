<script setup>
// Live Share: the people of this share. The guests in now (with the
// invitation they came with, what they look at, the shared projects they see
// and what they may do, each box a live change), the ones waiting for your
// answer, and the ones let in who are offline now (they come back by
// themselves, with what you leave them). A trusted person's boxes change
// what is kept for next time. Trust makes a guest trusted (their Tessel has
// an identity key); Remove takes them out (a trusted one: they stop being
// trusted too, unless you untick it). A guest waiting for your answer can be
// let in (Let in… brings up their prompt, with the code to check and what
// their invitation offers) or refused from here.
import { ref, computed, nextTick, inject } from 'vue'
import { ShieldCheck, UserX, Eye, UserCheck } from 'lucide-vue-next'
import ProjectChecks from './ProjectChecks.vue'
import RightsChecks from './RightsChecks.vue'
import LsAgents from './LsAgents.vue'
import LsAvatars from './LsAvatars.vue'
import { joinedGuests, waitingGuests, offlinePeople, personName, viaName } from '../../liveShareAccess'
import { cleanRights } from '../../../../shared/liveShareRights'
import { t } from '../../i18n'

const ctx = inject('lsDialog')
const host = computed(() => ctx.host.value)
const rows = computed(() => [
  ...joinedGuests(host.value).map((g) => ({ ...g, online: true })),
  ...offlinePeople(host.value).map((p) => ({ ...p, online: false }))
])
const waiting = computed(() => waitingGuests(host.value))
const removing = ref(null)
const untrustToo = ref(false)
const root = ref(null)
const focusIn = (selector) => nextTick(() => root.value?.querySelector(selector)?.focus())

// The panes a guest has on screen now (their names).
function watchingOf(id) {
  const names = []
  for (const p of host.value.presence || []) if ((p.guests || []).some((g) => g.id === id && g.watching)) names.push(ctx.paneTitle(p.id))
  return names.filter(Boolean)
}
function metaOf(p) {
  const parts = []
  const via = viaName(p.invite)
  if (via) parts.push(t('liveShare.people.via', 'Came with {{invite}}', { invite: via }))
  const watching = p.online ? watchingOf(p.id) : []
  if (watching.length) parts.push(t('liveShare.people.watching', 'Watching {{panes}}', { panes: watching.join(', ') }))
  if (!p.online) parts.push(t('liveShare.people.offline', 'Offline: comes back by itself'))
  return parts
}

const busyProject = (p) => (id) => ctx.busy(`${p.id}:project:${id}`) // i18n-ignore
const busyRight = (p) => (id) => ctx.busy(`${p.id}:right:${id}`) // i18n-ignore
function setProject(p, project, on) {
  ctx.run(`${p.id}:project:${project}`, () => ctx.api.access({ subject: p.id, project, on })) // i18n-ignore
}
function setRight(p, right, on) {
  ctx.run(`${p.id}:right:${right}`, () => ctx.api.access({ subject: p.id, right, on })) // i18n-ignore
}
// The agents they may use (null: the share's setting).
function setAgents(p, agents) {
  ctx.run(`${p.id}:agents`, () => ctx.api.access({ subject: p.id, agents })) // i18n-ignore
}
async function trust(p) {
  const r = await ctx.run(`${p.id}:trust`, () => ctx.api.trust({ guestId: p.id }), t('liveShare.people.trustFailed', '{{name}} could not be trusted (they may have left, or their Tessel is too old).', { name: personName(p) })) // i18n-ignore
  if (r && r.ok) ctx.notice(t('liveShare.people.trusted', '{{name}} is trusted: next time they get in without asking, with these projects and rights.', { name: personName(p) }))
}
function askRemove(p) {
  // A trusted person removed stops being trusted too unless you untick it
  // (else they could come back without asking).
  untrustToo.value = !!p.trusted
  removing.value = p.id
  focusIn(`[data-test="ls-person-remove-cancel-${p.id}"]`) // i18n-ignore
}
function cancelRemove(p) {
  removing.value = null
  focusIn(`[data-test="ls-person-remove-${p.id}"]`) // i18n-ignore
}
async function remove(p) {
  const untrust = !!(p.trusted && untrustToo.value)
  const r = await ctx.run(`${p.id}:remove`, () => ctx.api.removeGuest({ guestId: p.id, untrust })) // i18n-ignore
  removing.value = null
  if (r && r.ok) ctx.notice(untrust ? t('liveShare.people.removedUntrusted', '{{name}} was removed and is no longer trusted.', { name: personName(p) }) : t('liveShare.people.removed', '{{name}} was removed.', { name: personName(p) }))
}
// A no: main turns them away (their prompt goes with it).
async function refuse(g) {
  const r = await ctx.run(`${g.id}:answer`, () => ctx.api.approve({ guestId: g.id, yes: false, projects: [], rights: cleanRights(null), trust: false })) // i18n-ignore
  if (r && r.ok) ctx.notice(t('liveShare.people.refused', '{{name}} was turned away.', { name: personName(g) }))
}
const waitingText = (g) => (g.code ? t('liveShare.share.guestWaitingCode', 'Waiting for your answer (code {{code}})', { code: g.code }) : t('liveShare.share.guestWaiting', 'Waiting for your answer'))
</script>

<template>
  <section ref="root" class="lsd-section" data-test="ls-people" :aria-label="t('liveShare.section.people', 'People')">
    <p v-if="!rows.length && !waiting.length" class="lsd-empty" data-test="ls-people-empty">{{ t('liveShare.people.empty', 'No one has joined yet. Send an invitation code: each person waits for your yes.') }}</p>

    <ul v-if="waiting.length" class="lsd-list" :aria-label="t('liveShare.people.waitingLabel', 'Waiting for your answer')">
      <li v-for="g in waiting" :key="g.id" class="lsd-item lsd-item-waiting" :data-test="'ls-waiting-' + g.id">
        <div class="lsd-item-head">
          <LsAvatars :people="[{ id: g.id, name: personName(g) }]" :size="20" />
          <span class="lsd-name">{{ personName(g) }}</span>
          <span class="lsd-badge warn">{{ waitingText(g) }}</span>
        </div>
        <div v-if="g.invite" class="lsd-meta" v-text="t('liveShare.people.via', 'Came with {{invite}}', { invite: viaName(g.invite) })"></div>
        <div class="lsd-actions start">
          <button type="button" class="confirm-btn ls-small primary" :disabled="ctx.busy(g.id + ':answer')" :data-test="'ls-waiting-letin-' + g.id" @click="ctx.review(g.id)">
            <UserCheck :size="12" aria-hidden="true" /> {{ t('liveShare.people.letIn', 'Let in…') }}
          </button>
          <button type="button" class="confirm-btn ls-small danger" :disabled="ctx.busy(g.id + ':answer')" :data-test="'ls-waiting-refuse-' + g.id" @click="refuse(g)">{{ t('liveShare.people.refuse', 'Refuse') }}</button>
        </div>
      </li>
    </ul>

    <ul v-if="rows.length" class="lsd-list">
      <li v-for="p in rows" :key="p.id" class="lsd-item" :class="{ offline: !p.online }" :data-test="(p.online ? 'ls-guest-' : 'ls-offline-') + p.id">
        <div class="lsd-item-head">
          <LsAvatars :people="[{ id: p.id, name: personName(p) }]" :size="20" />
          <span class="lsd-name">{{ personName(p) }}</span>
          <span v-if="p.trusted" class="lsd-badge accent" data-test="ls-person-trusted"><ShieldCheck :size="11" aria-hidden="true" /> {{ t('liveShare.people.trustedBadge', 'Trusted') }}</span>
          <span v-if="!p.online" class="lsd-badge">{{ t('liveShare.people.offlineBadge', 'Offline') }}</span>
          <Eye v-if="p.online && watchingOf(p.id).length" :size="13" class="lsd-watch" aria-hidden="true" />
        </div>
        <div v-if="metaOf(p).length" class="lsd-meta">
          <template v-for="(m, i) in metaOf(p)" :key="i"><span v-if="i" aria-hidden="true">·</span><span>{{ m }}</span></template>
        </div>
        <div class="lsd-grants">
          <div class="lsd-grant">
            <span class="lsd-sub">{{ t('liveShare.people.sees', 'Sees') }}</span>
            <ProjectChecks
              compact
              :projects="ctx.shared.value"
              :selected="p.projects || []"
              :test-key="p.id"
              :busy="busyProject(p)"
              :label="t('liveShare.share.seesLabel', 'What {{name}} sees', { name: personName(p) })"
              @toggle="(id, on) => setProject(p, id, on)"
            />
          </div>
          <div class="lsd-grant">
            <span class="lsd-sub">{{ t('liveShare.people.can', 'Can') }}</span>
            <RightsChecks compact :rights="p.rights || {}" :test-key="p.id" :busy="busyRight(p)" :label="t('liveShare.share.rightsLabel', 'What {{name}} can do', { name: personName(p) })" @toggle="(id, on) => setRight(p, id, on)" />
          </div>
          <LsAgents :rule="(p.rights && p.rights.agents) || null" :busy="ctx.busy(p.id + ':agents')" :test-key="p.id" @change="(rule) => setAgents(p, rule)" />
        </div>
        <p v-if="p.trusted" class="lsd-hint">{{ t('liveShare.people.trustedHint', 'Trusted: what you change here is kept for next time.') }}</p>

        <div v-if="removing === p.id" class="lsd-confirm" role="group" :aria-label="t('liveShare.people.removeTitle', 'Remove {{name}}?', { name: personName(p) })" :data-test="'ls-person-remove-confirm-' + p.id" @keydown.escape.stop.prevent="cancelRemove(p)">
          <p class="lsd-confirm-text" v-text="t('liveShare.people.removeText', 'Remove {{name}}? They leave the session now and need a new invitation and your yes to come back.', { name: personName(p) })"></p>
          <label v-if="p.trusted" class="lsd-check" :data-test="'ls-person-untrust-' + p.id">
            <input v-model="untrustToo" type="checkbox" />
            <span>{{ t('liveShare.people.untrustToo2', 'Also stop trusting them (otherwise they can come back without asking, with any new code)') }}</span>
          </label>
          <p v-if="p.trusted && !untrustToo" class="lsd-hint" :data-test="'ls-person-keep-trust-' + p.id">{{ t('liveShare.people.keepTrust', 'They stay trusted: they can come back without asking.') }}</p>
          <div class="lsd-actions">
            <button type="button" class="confirm-btn ls-small" :data-test="'ls-person-remove-cancel-' + p.id" @click="cancelRemove(p)">{{ t('liveShare.cancel', 'Cancel') }}</button>
            <button type="button" class="confirm-btn ls-small primary danger" :disabled="ctx.busy(p.id + ':remove')" :data-test="'ls-person-remove-yes-' + p.id" @click="remove(p)">{{ t('liveShare.share.remove', 'Remove') }}</button>
          </div>
        </div>
        <div v-else class="lsd-actions start">
          <button
            v-if="p.trustable && !p.trusted"
            type="button"
            class="confirm-btn ls-small"
            :disabled="ctx.busy(p.id + ':trust')"
            :title="t('liveShare.people.trustTitle', 'Next time they get in without asking, with these projects and rights')"
            :data-test="'ls-person-trust-' + p.id"
            @click="trust(p)"
          >
            <ShieldCheck :size="12" aria-hidden="true" /> {{ t('liveShare.people.trust', 'Trust') }}
          </button>
          <button type="button" class="confirm-btn ls-small danger" :data-test="'ls-person-remove-' + p.id" @click="askRemove(p)"><UserX :size="12" aria-hidden="true" /> {{ t('liveShare.share.remove', 'Remove') }}</button>
        </div>
      </li>
    </ul>
  </section>
</template>
