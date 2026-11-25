<script setup>
// Live Share: one person's page (from their row in LsPeople; the dialog
// shows it with Back). What they see (the shared projects as chips; a
// trusted person also keeps projects for later shares: theirs show too, and
// Add a project… opens the picker over all of this window's), what they may
// do (presets, then a tile per right), the agents they may use, and Trust /
// Rename / Stop trusting / Remove. Every chip and tile is a live change; a
// trusted person's changes are kept for next time. Typing (Full control, or
// the Type tile) runs commands on this PC: asked first, here. Remove takes
// a guest out (a trusted one stops being trusted too, unless you untick
// it); Stop trusting is asked first. On top, the invitation to send them:
// the code that lets them in (one made for them, else the one they came
// with, else the share's), Copy, and a new one of their own (one use, a
// day, their projects and rights, never typing: a code can be passed on).
import { ref, computed, nextTick, inject, watch, onMounted } from 'vue'
import { ShieldCheck, ShieldOff, UserX, Pencil, Plus, Copy, Check, MessageSquare } from 'lucide-vue-next'
import ProjectChecks from './ProjectChecks.vue'
import RightsGrid from './RightsGrid.vue'
import LsAgents from './LsAgents.vue'
import LsAvatars from './LsAvatars.vue'
import LsProjectPicker from './LsProjectPicker.vue'
import { personName, invitesOf, inviteName, inviteExpiry, shortCode } from '../../liveShareAccess'
import { peopleRows, trustIdOf } from '../../liveSharePeople'
import { t } from '../../i18n'

const props = defineProps({
  personId: { type: String, required: true },
  // Opened to ask at once: 'remove' or 'untrust' (their row's menu).
  action: { type: String, default: '' }
})
// gone: they are no longer there (left, removed, no longer trusted).
const emit = defineEmits(['gone'])

const ctx = inject('lsDialog')
const root = ref(null)
const r = computed(() => peopleRows(ctx.host.value).find((x) => x.id === props.personId && x.kind !== 'waiting') || null)
watch(r, (row) => {
  if (!row) emit('gone')
})
const name = computed(() => (r.value ? personName(r.value) : ''))
const focusIn = (selector) => nextTick(() => root.value?.querySelector(selector)?.focus())
const key = (what) => `${props.personId}:${what}` // i18n-ignore

// --- Their invitation --------------------------------------------------------
const sharingNow = computed(() => !!(ctx.host.value && ctx.host.value.state === 'sharing'))
const letsIn = (inv) => !!(inv && inv.code) && inv.state === 'live' && !inviteExpiry(inv, ctx.now.value).expired
// The one made here, just now.
const madeId = ref('')
const invitation = computed(() => {
  const row = r.value
  if (!row) return null
  // A trusted person keeps the projects of an invitation they use: only one
  // that gives nothing more than theirs is shown as theirs (never the
  // share's own, which may give every project).
  const mine = new Set(row.projects || [])
  const noMore = (i) => !row.trusted || (i.later !== true && (i.projects || []).every((id) => mine.has(id)))
  // The newest first.
  const usable = invitesOf(ctx.host.value)
    .filter((i) => letsIn(i) && noMore(i))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  const came = row.invite && row.invite.id
  return usable.find((i) => i.id === madeId.value) || (row.name && usable.find((i) => (i.label || '') === row.name)) || (came && usable.find((i) => i.id === came)) || (row.trusted ? null : usable[0]) || null
})
const noInviteText = computed(() => t('liveShare.personInvite.none', 'No invitation for {{name}} right now: make a new one.', { name: name.value }))
const inviteHint = computed(() => {
  const inv = invitation.value
  if (!inv) return ''
  const vars = { name: name.value, invite: inviteName(inv), expiry: inviteExpiry(inv, ctx.now.value).text }
  return r.value && r.value.trusted
    ? t('liveShare.personInvite.hintTrusted', '{{invite}} · {{expiry}}. With this code, {{name}} gets in without asking.', vars)
    : t('liveShare.personInvite.hint', '{{invite}} · {{expiry}}. With this code, {{name}} asks to come in and waits for your yes.', vars)
})
const newInviteText = computed(() => t('liveShare.personInvite.new', 'New invitation for {{name}}', { name: name.value }))
const copied = ref('')
let copiedTimer = null
async function copyInvite(message) {
  const inv = invitation.value
  if (!inv) return
  const text = message ? t('liveShare.invite.message', 'Join my Tessel Live Share: in Tessel, open Live Share, then Join, and paste this code: {{code}}', { code: inv.code }) : inv.code
  if (!(await ctx.copy(text))) return
  copied.value = message ? 'message' : 'code'
  clearTimeout(copiedTimer)
  copiedTimer = setTimeout(() => (copied.value = ''), 1500)
}
// One of their own: one use, a day, the shared projects they see and their
// rights without typing (whoever holds a code could use it).
async function newInvite() {
  const row = r.value
  if (!row) return
  const shared = new Set(ctx.shared.value.map((p) => p.id))
  const spec = { label: row.name || '', lifetime: 'day', maxUses: 1, rights: { ...(row.rights || {}), type: false }, projects: (row.projects || []).filter((id) => shared.has(id)), later: false }
  const res = await ctx.run(key('invite'), () => ctx.api.createInvite(spec), t('liveShare.personInvite.failed', 'The invitation could not be made.'))
  if (!res || !res.ok || !res.invite) return
  madeId.value = res.invite.id
  ctx.notice(t('liveShare.personInvite.made', 'New invitation for {{name}}: one use, works for a day. Copy its code and send it.', { name: name.value }))
  focusIn('[data-test="ls-pp-copy"]')
}

// --- Projects ----------------------------------------------------------------
// The projects shared now, and for a trusted person the ones kept for them.
const picking = ref(false)
const offered = computed(() => {
  const row = r.value
  if (!row) return []
  if (row.kind !== 'trusted') return ctx.shared.value
  const mine = new Set(row.projects || [])
  const shared = new Set(ctx.shared.value.map((p) => p.id))
  return ctx.all.value.filter((p) => shared.has(p.id) || mine.has(p.id))
})
// Projects kept for someone that this window does not have: counted, never lost.
const elsewhere = computed(() => (r.value && r.value.kind === 'trusted' ? (r.value.projects || []).filter((id) => !ctx.all.value.some((x) => x.id === id)).length : 0))
const elsewhereText = computed(() => {
  const count = elsewhere.value
  return count === 1 ? t('liveShare.trusted.elsewhere', 'And {{count}} project not in this window (kept).', { count }) : t('liveShare.trusted.elsewhere', 'And {{count}} projects not in this window (kept).', { count })
})
function setProject(project, on) {
  const row = r.value
  // A trusted person not connected has a cap on the projects kept.
  const failed =
    row.kind !== 'trusted'
      ? undefined
      : on
        ? t('liveShare.trusted.addFailed', '{{project}} could not be given to {{name}} (a trusted person can have up to 64 projects).', { project: ctx.projectName(project) || '?', name: name.value })
        : t('liveShare.trusted.removeFailed', '{{project}} could not be taken away from {{name}}.', { project: ctx.projectName(project) || '?', name: name.value })
  ctx.run(key('project:' + project), () => ctx.api.access({ subject: row.id, project, on }), failed)
}
const busyProject = (id) => ctx.busy(key('project:' + id))

// --- Rights --------------------------------------------------------------------
// Typing is asked first: { preset: 'full' } or { right: 'type' }.
const raising = ref(null)
const busyRight = (id) => ctx.busy(key('right:' + id))
function setRight(right, on) {
  if (right === 'type' && on) return askRaise({ right })
  ctx.run(key('right:' + right), () => ctx.api.access({ subject: r.value.id, right, on }))
}
function setPreset(id) {
  if (id === 'full') return askRaise({ preset: id })
  ctx.preset(r.value.id, r.value.rights, id)
}
function askRaise(what) {
  raising.value = what
  focusIn('[data-test="ls-pp-raise-cancel"]')
}
// The question gone: the keyboard goes back to the rights.
function endRaise(what) {
  raising.value = null
  focusIn(what && what.right ? `[data-test="ls-right-type-${props.personId}"] input` : `[data-test="ls-${props.personId}-preset-full"] input`) // i18n-ignore
}
function closePicker() {
  picking.value = false
  focusIn('[data-test="ls-pp-add-project"]')
}
function giveRaise() {
  const what = raising.value
  endRaise(what)
  if (!what || !r.value) return
  if (what.preset) ctx.preset(r.value.id, r.value.rights, what.preset)
  else ctx.run(key('right:type'), () => ctx.api.access({ subject: r.value.id, right: 'type', on: true }))
}
const raiseText = computed(() => t('liveShare.people.raiseText', '{{name}} will be able to run any command on this PC as you.', { name: name.value }))
// The agents they may use (null: the share's setting).
function setAgents(agents) {
  ctx.run(key('agents'), () => ctx.api.access({ subject: r.value.id, agents }))
}

// --- Trust, rename, remove ------------------------------------------------------
async function trust() {
  const res = await ctx.run(key('trust'), () => ctx.api.trust({ guestId: r.value.id }), t('liveShare.people.trustFailed', '{{name}} could not be trusted (they may have left, or their Tessel is too old).', { name: name.value }))
  if (res && res.ok) ctx.notice(t('liveShare.people.trusted', '{{name}} is trusted: next time they get in without asking, with these projects and rights.', { name: name.value }))
}

const removing = ref(false)
const untrustToo = ref(false)
function askRemove() {
  renaming.value = false
  untrusting.value = false
  // A trusted person removed stops being trusted too unless you untick it
  // (else they could come back without asking).
  untrustToo.value = !!(r.value && r.value.trusted)
  removing.value = true
  focusIn('[data-test="ls-person-remove-cancel-' + props.personId + '"]')
}
function cancelRemove() {
  removing.value = false
  focusIn('[data-test="ls-person-remove-' + props.personId + '"]')
}
async function remove() {
  const who = name.value
  const untrust = !!(r.value.trusted && untrustToo.value)
  const res = await ctx.run(key('remove'), () => ctx.api.removeGuest({ guestId: r.value.id, untrust }))
  removing.value = false
  if (res && res.ok) ctx.notice(untrust ? t('liveShare.people.removedUntrusted', '{{name}} was removed and is no longer trusted.', { name: who }) : t('liveShare.people.removed', '{{name}} was removed.', { name: who }))
}

const renaming = ref(false)
const draft = ref('')
function startRename() {
  removing.value = false
  untrusting.value = false
  renaming.value = true
  draft.value = r.value.name || ''
  focusIn('[data-test="ls-trusted-name-input-' + props.personId + '"]')
}
function cancelRename() {
  renaming.value = false
  focusIn('[data-test="ls-trusted-rename-' + props.personId + '"]')
}
async function rename() {
  const next = draft.value.trim()
  if (!next || next === r.value.name) return cancelRename()
  const res = await ctx.run(key('rename'), () => ctx.api.renameTrusted({ id: trustIdOf(r.value), name: next }))
  if (res && res.ok) cancelRename()
}

const untrusting = ref(false)
function askUntrust() {
  removing.value = false
  renaming.value = false
  untrusting.value = true
  focusIn('[data-test="ls-trusted-untrust-cancel-' + props.personId + '"]')
}
function cancelUntrust() {
  untrusting.value = false
  focusIn('[data-test="ls-trusted-untrust-' + props.personId + '"]')
}
async function untrust() {
  const who = name.value
  const res = await ctx.run(key('untrust'), () => ctx.api.untrust({ id: trustIdOf(r.value) }))
  untrusting.value = false
  if (res && res.ok) ctx.notice(t('liveShare.trusted.untrusted', '{{name}} is no longer trusted: next time they need an invitation and your yes.', { name: who }))
}

onMounted(() => {
  if (!r.value) return emit('gone')
  if (props.action === 'remove' && r.value.kind !== 'trusted') askRemove()
  else if (props.action === 'untrust' && trustIdOf(r.value)) askUntrust()
})

const seesLabel = computed(() => t('liveShare.share.seesLabel', 'What {{name}} sees', { name: name.value }))
const rightsLabel = computed(() => t('liveShare.share.rightsLabel', 'What {{name}} can do', { name: name.value }))
const removeTitle = computed(() => t('liveShare.people.removeTitle', 'Remove {{name}}?', { name: name.value }))
const removeText = computed(() => t('liveShare.people.removeText', 'Remove {{name}}? They leave the session now and need a new invitation and your yes to come back.', { name: name.value }))
const untrustTitle = computed(() => t('liveShare.trusted.untrustTitle', 'Stop trusting {{name}}?', { name: name.value }))
const untrustText = computed(() => t('liveShare.trusted.untrustText2', 'Stop trusting {{name}}? If they are connected, they are disconnected; to come back they need an invitation and your yes.', { name: name.value }))
</script>

<template>
  <section v-if="r" ref="root" class="lpp" data-test="ls-person-page" :aria-label="name">
    <div class="lpp-who">
      <LsAvatars :people="[{ id: r.id, name }]" :size="30" />
      <div class="lpp-who-text">
        <div class="lpp-name">
          {{ name }}
          <span v-if="r.trusted" class="tag tag-info lpp-tag"><ShieldCheck :size="10" aria-hidden="true" /> {{ t('liveShare.people.trustedBadge', 'Trusted') }}</span>
          <span v-if="r.online" class="tag tag-ok">{{ t('liveShare.overview.inNow', 'In now') }}</span>
          <span v-else class="tag tag-off">{{ t('liveShare.people.offlineBadge', 'Offline') }}</span>
        </div>
        <div v-if="r.trusted" class="lpp-hint">{{ t('liveShare.people.trustedHint', 'Trusted: what you change here is kept for next time.') }}</div>
      </div>
    </div>

    <div class="lpp-block" data-test="ls-pp-invite">
      <div class="lpp-title">{{ t('liveShare.link.title', 'Invitation') }}</div>
      <template v-if="invitation">
        <div class="lpp-code-row">
          <code class="lpp-code" :title="invitation.code" data-test="ls-pp-code">{{ shortCode(invitation.code) }}</code>
          <button type="button" class="confirm-btn ls-small primary" data-test="ls-pp-copy" @click="copyInvite(false)">
            <Check v-if="copied === 'code'" :size="13" aria-hidden="true" />
            <Copy v-else :size="13" aria-hidden="true" />
            {{ copied === 'code' ? t('liveShare.share.copied', 'Copied') : t('liveShare.invite.copyCode', 'Copy code') }}
          </button>
          <button type="button" class="confirm-btn ls-small" :title="t('liveShare.invite.copyMessageTitle', 'The code with a line saying how to join')" data-test="ls-pp-copy-message" @click="copyInvite(true)">
            <Check v-if="copied === 'message'" :size="13" aria-hidden="true" />
            <MessageSquare v-else :size="13" aria-hidden="true" />
            {{ t('liveShare.invite.copyMessage', 'Copy message') }}
          </button>
        </div>
        <p class="lsd-hint" data-test="ls-pp-invite-hint">{{ inviteHint }}</p>
      </template>
      <p v-else class="lsd-hint" data-test="ls-pp-no-invite">
        {{ sharingNow ? noInviteText : t('liveShare.personInvite.notSharing', 'The invitation code shows here once you share.') }}
      </p>
      <button v-if="sharingNow" type="button" class="lpp-add" :disabled="ctx.busy(key('invite'))" data-test="ls-pp-new-invite" @click="newInvite"><Plus :size="12" aria-hidden="true" /> {{ newInviteText }}</button>
    </div>

    <div class="lpp-block">
      <div class="lpp-title">{{ r.kind === 'trusted' ? t('liveShare.trusted.projects', 'Projects (seen when shared)') : t('liveShare.people.sees', 'Sees') }}</div>
      <ProjectChecks
        chips
        :projects="offered"
        :selected="r.projects || []"
        :test-key="r.id"
        :busy="busyProject"
        :label="seesLabel"
        :empty="r.kind === 'trusted' ? t('liveShare.trusted.noProjects', 'No project in this window.') : ''"
        @toggle="setProject"
      />
      <template v-if="r.kind === 'trusted'">
        <button v-if="!picking" type="button" class="lpp-add" data-test="ls-pp-add-project" @click="picking = true"><Plus :size="12" aria-hidden="true" /> {{ t('liveShare.projects.addMore', 'Add a project…') }}</button>
        <LsProjectPicker v-else :projects="ctx.all.value" :selected="r.projects || []" :busy="busyProject" :tags="false" :test-key="'-pick-' + r.id" @toggle="setProject" @close="closePicker" />
      </template>
      <p v-if="elsewhere" class="lsd-hint">{{ elsewhereText }}</p>
    </div>

    <div class="lpp-block">
      <div class="lpp-title">{{ t('liveShare.people.can', 'Can') }}</div>
      <RightsGrid presets :rights="r.rights || {}" :test-key="r.id" :busy="busyRight" :label="rightsLabel" @toggle="setRight" @preset="setPreset" />
      <div v-if="raising" class="lsd-confirm" role="group" :aria-label="raiseText" data-test="ls-pp-raise-confirm" @keydown.escape.stop.prevent="endRaise(raising)">
        <p class="lsd-confirm-text">{{ raiseText }}</p>
        <div class="lsd-actions">
          <button type="button" class="confirm-btn ls-small" data-test="ls-pp-raise-cancel" @click="endRaise(raising)">{{ t('liveShare.cancel', 'Cancel') }}</button>
          <button type="button" class="confirm-btn ls-small primary danger" data-test="ls-pp-raise-yes" @click="giveRaise">{{ raising.preset ? t('liveShare.people.raiseYes', 'Give full control') : t('liveShare.people.raiseType', 'Let them type') }}</button>
        </div>
      </div>
      <LsAgents :rule="(r.rights && r.rights.agents) || null" :can-type="!!(r.rights && r.rights.type)" :busy="ctx.busy(key('agents'))" :test-key="r.id" @change="setAgents" />
    </div>

    <div v-if="removing" class="lsd-confirm" role="group" :aria-label="removeTitle" :data-test="'ls-person-remove-confirm-' + r.id" @keydown.escape.stop.prevent="cancelRemove">
      <p class="lsd-confirm-text">{{ removeText }}</p>
      <label v-if="r.trusted" class="lsd-check" :data-test="'ls-person-untrust-' + r.id">
        <input v-model="untrustToo" type="checkbox" />
        <span>{{ t('liveShare.people.untrustToo2', 'Also stop trusting them (otherwise they can come back without asking, with any new code)') }}</span>
      </label>
      <p v-if="r.trusted && !untrustToo" class="lsd-hint" :data-test="'ls-person-keep-trust-' + r.id">{{ t('liveShare.people.keepTrust', 'They stay trusted: they can come back without asking.') }}</p>
      <div class="lsd-actions">
        <button type="button" class="confirm-btn ls-small" :data-test="'ls-person-remove-cancel-' + r.id" @click="cancelRemove">{{ t('liveShare.cancel', 'Cancel') }}</button>
        <button type="button" class="confirm-btn ls-small primary danger" :disabled="ctx.busy(key('remove'))" :data-test="'ls-person-remove-yes-' + r.id" @click="remove">{{ t('liveShare.share.remove', 'Remove') }}</button>
      </div>
    </div>
    <div v-else-if="untrusting" class="lsd-confirm" role="group" :aria-label="untrustTitle" :data-test="'ls-trusted-untrust-confirm-' + r.id" @keydown.escape.stop.prevent="cancelUntrust">
      <p class="lsd-confirm-text">{{ untrustText }}</p>
      <div class="lsd-actions">
        <button type="button" class="confirm-btn ls-small" :data-test="'ls-trusted-untrust-cancel-' + r.id" @click="cancelUntrust">{{ t('liveShare.cancel', 'Cancel') }}</button>
        <button type="button" class="confirm-btn ls-small primary danger" :disabled="ctx.busy(key('untrust'))" :data-test="'ls-trusted-untrust-yes-' + r.id" @click="untrust">{{ t('liveShare.trusted.untrust', 'Stop trusting') }}</button>
      </div>
    </div>
    <form v-else-if="renaming" class="lsd-rename" @submit.prevent="rename" @keydown.escape.stop.prevent="cancelRename">
      <input v-model="draft" class="ls-input" type="text" maxlength="40" spellcheck="false" :aria-label="t('liveShare.trusted.nameLabel', 'Name')" :data-test="'ls-trusted-name-input-' + r.id" />
      <button type="submit" class="confirm-btn ls-small primary" :disabled="!draft.trim()">{{ t('liveShare.invite.save', 'Save') }}</button>
      <button type="button" class="confirm-btn ls-small" @click="cancelRename">{{ t('liveShare.cancel', 'Cancel') }}</button>
    </form>
    <div v-else class="lsd-actions start lpp-actions">
      <button
        v-if="r.trustable && !r.trusted"
        type="button"
        class="confirm-btn ls-small"
        :disabled="ctx.busy(key('trust'))"
        :title="t('liveShare.people.trustTitle', 'Next time they get in without asking, with these projects and rights')"
        :data-test="'ls-person-trust-' + r.id"
        @click="trust"
      >
        <ShieldCheck :size="12" aria-hidden="true" /> {{ t('liveShare.people.trust', 'Trust') }}
      </button>
      <button v-if="trustIdOf(r)" type="button" class="confirm-btn ls-small" :data-test="'ls-trusted-rename-' + r.id" @click="startRename"><Pencil :size="12" aria-hidden="true" /> {{ t('liveShare.trusted.rename', 'Rename') }}</button>
      <button v-if="trustIdOf(r)" type="button" class="confirm-btn ls-small danger" :data-test="'ls-trusted-untrust-' + r.id" @click="askUntrust"><ShieldOff :size="12" aria-hidden="true" /> {{ t('liveShare.trusted.untrust', 'Stop trusting') }}</button>
      <button v-if="r.kind !== 'trusted'" type="button" class="confirm-btn ls-small danger" :data-test="'ls-person-remove-' + r.id" @click="askRemove"><UserX :size="12" aria-hidden="true" /> {{ t('liveShare.share.remove', 'Remove') }}</button>
    </div>
  </section>
</template>

<style scoped>
.lpp {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
}
.lpp-who {
  display: flex;
  align-items: center;
  gap: 12px;
}
.lpp-who-text {
  min-width: 0;
}
.lpp-name {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 7px;
  color: var(--text-strong);
  font-size: 14px;
  font-weight: 600;
}
.lpp-tag {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}
.lpp-hint {
  margin-top: 2px;
  color: var(--text-dim);
  font-size: 11.5px;
}
.lpp-block {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
.lpp-title {
  color: var(--text-strong);
  font-size: 12.5px;
  font-weight: 600;
}
.lpp-add {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  align-self: flex-start;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--accent);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.lpp-add:disabled {
  opacity: 0.55;
  cursor: default;
}
.lpp-code-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.lpp-code {
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
  user-select: all;
}
.lpp-add:hover:not(:disabled) {
  text-decoration: underline;
}
.lpp-actions {
  padding-top: 12px;
  border-top: 1px solid var(--border);
}
</style>
