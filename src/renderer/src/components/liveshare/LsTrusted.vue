<script setup>
// Live Share: the people you trust (main's trusted list, kept across shares
// and restarts). A trusted person gets into your share without the accept
// prompt, with the projects and rights kept here: they see the ones you
// share at that time. Each can be changed at any time, connected or not,
// sharing or not; renamed; or no longer trusted (asked first: their
// connections end, and they need your yes again).
import { ref, computed, nextTick, inject } from 'vue'
import { ShieldOff, Pencil } from 'lucide-vue-next'
import ProjectChecks from './ProjectChecks.vue'
import RightsChecks from './RightsChecks.vue'
import LsAgents from './LsAgents.vue'
import LsAvatars from './LsAvatars.vue'
import { trustedPeople, personName } from '../../liveShareAccess'
import { formatWhen } from '../../timeFormat'
import { t } from '../../i18n'

const ctx = inject('lsDialog')
const people = computed(() => trustedPeople(ctx.host.value))
const untrusting = ref(null)
const renaming = ref(null)
const draft = ref('')
const root = ref(null)
const focusIn = (selector) => nextTick(() => root.value?.querySelector(selector)?.focus())

// Projects kept for someone that this window does not have (another set of
// projects, a project removed since): counted, never lost.
const elsewhere = (p) => (p.projects || []).filter((id) => !ctx.all.value.some((x) => x.id === id)).length
const elsewhereText = (p) => {
  const count = elsewhere(p)
  return count === 1 ? t('liveShare.trusted.elsewhere', 'And {{count}} project not in this window (kept).', { count }) : t('liveShare.trusted.elsewhere', 'And {{count}} projects not in this window (kept).', { count })
}
function seenText(p) {
  if (p.online) return t('liveShare.trusted.online', 'Connected now')
  if (p.lastSeen) return t('liveShare.trusted.lastSeen', 'Last seen {{when}}', { when: formatWhen(p.lastSeen, ctx.now.value) })
  return t('liveShare.trusted.since', 'Trusted since {{when}}', { when: formatWhen(p.since, ctx.now.value) })
}

const busyProject = (p) => (id) => ctx.busy(`${p.id}:project:${id}`) // i18n-ignore
const busyRight = (p) => (id) => ctx.busy(`${p.id}:right:${id}`) // i18n-ignore
function setProject(p, project, on) {
  const failed = on
    ? t('liveShare.trusted.addFailed', '{{project}} could not be given to {{name}} (a trusted person can have up to 64 projects).', { project: ctx.projectName(project) || '?', name: personName(p) })
    : t('liveShare.trusted.removeFailed', '{{project}} could not be taken away from {{name}}.', { project: ctx.projectName(project) || '?', name: personName(p) })
  ctx.run(`${p.id}:project:${project}`, () => ctx.api.access({ subject: p.id, project, on }), failed) // i18n-ignore
}
function setRight(p, right, on) {
  ctx.run(`${p.id}:right:${right}`, () => ctx.api.access({ subject: p.id, right, on })) // i18n-ignore
}
// The agents they may use (null: the share's setting).
function setAgents(p, agents) {
  ctx.run(`${p.id}:agents`, () => ctx.api.access({ subject: p.id, agents })) // i18n-ignore
}

function startRename(p) {
  untrusting.value = null
  renaming.value = p.id
  draft.value = p.name || ''
  focusIn(`[data-test="ls-trusted-name-input-${p.id}"]`) // i18n-ignore
}
function cancelRename(p) {
  renaming.value = null
  focusIn(`[data-test="ls-trusted-rename-${p.id}"]`) // i18n-ignore
}
async function rename(p) {
  const name = draft.value.trim()
  if (!name || name === p.name) return cancelRename(p)
  const r = await ctx.run(`${p.id}:rename`, () => ctx.api.renameTrusted({ id: p.id, name })) // i18n-ignore
  if (r && r.ok) cancelRename(p)
}

function askUntrust(p) {
  renaming.value = null
  untrusting.value = p.id
  focusIn(`[data-test="ls-trusted-untrust-cancel-${p.id}"]`) // i18n-ignore
}
function cancelUntrust(p) {
  untrusting.value = null
  focusIn(`[data-test="ls-trusted-untrust-${p.id}"]`) // i18n-ignore
}
async function untrust(p) {
  const r = await ctx.run(`${p.id}:untrust`, () => ctx.api.untrust({ id: p.id })) // i18n-ignore
  untrusting.value = null
  if (r && r.ok) ctx.notice(t('liveShare.trusted.untrusted', '{{name}} is no longer trusted: next time they need an invitation and your yes.', { name: personName(p) }))
}
</script>

<template>
  <section ref="root" class="lsd-section" data-test="ls-trusted" :aria-label="t('liveShare.section.trusted', 'Trusted')">
    <!-- In a head row like the other sections' (on its own in the column it
         would take its flex basis as height). -->
    <div class="lsd-section-head">
      <p class="lsd-intro">{{ t('liveShare.trusted.intro', 'Trusted people get in without asking, with the projects and rights kept here (they see the ones you share at the time). Trust someone from People or when you let them in.') }}</p>
    </div>
    <p v-if="!people.length" class="lsd-empty" data-test="ls-trusted-empty">{{ t('liveShare.trusted.empty', 'You trust no one yet.') }}</p>
    <ul v-else class="lsd-list">
      <li v-for="p in people" :key="p.id" class="lsd-item" :class="{ offline: !p.online }" :data-test="'ls-trusted-' + p.id">
        <div class="lsd-item-head">
          <LsAvatars :people="[{ id: p.id, name: personName(p) }]" :size="20" />
          <form v-if="renaming === p.id" class="lsd-rename" @submit.prevent="rename(p)" @keydown.escape.stop.prevent="cancelRename(p)">
            <input v-model="draft" class="ls-input" type="text" maxlength="40" spellcheck="false" :aria-label="t('liveShare.trusted.nameLabel', 'Name')" :data-test="'ls-trusted-name-input-' + p.id" />
            <button type="submit" class="confirm-btn ls-small primary" :disabled="!draft.trim()">{{ t('liveShare.invite.save', 'Save') }}</button>
            <button type="button" class="confirm-btn ls-small" @click="cancelRename(p)">{{ t('liveShare.cancel', 'Cancel') }}</button>
          </form>
          <template v-else>
            <span class="lsd-name">{{ personName(p) }}</span>
            <span class="lsd-badge" :class="{ live: p.online }">{{ seenText(p) }}</span>
          </template>
        </div>
        <div class="lsd-grants">
          <div class="lsd-grant">
            <span class="lsd-sub">{{ t('liveShare.trusted.projects', 'Projects (seen when shared)') }}</span>
            <ProjectChecks
              compact
              :projects="ctx.all.value"
              :selected="p.projects || []"
              :test-key="p.id"
              :busy="busyProject(p)"
              :label="t('liveShare.share.seesLabel', 'What {{name}} sees', { name: personName(p) })"
              :empty="t('liveShare.trusted.noProjects', 'No project in this window.')"
              @toggle="(id, on) => setProject(p, id, on)"
            />
            <span v-if="elsewhere(p)" class="lsd-hint">{{ elsewhereText(p) }}</span>
          </div>
          <div class="lsd-grant">
            <span class="lsd-sub">{{ t('liveShare.people.can', 'Can') }}</span>
            <RightsChecks compact :rights="p.rights || {}" :test-key="p.id" :busy="busyRight(p)" :label="t('liveShare.share.rightsLabel', 'What {{name}} can do', { name: personName(p) })" @toggle="(id, on) => setRight(p, id, on)" />
          </div>
          <LsAgents :rule="(p.rights && p.rights.agents) || null" :can-type="!!(p.rights && p.rights.type)" :busy="ctx.busy(p.id + ':agents')" :test-key="p.id" @change="(rule) => setAgents(p, rule)" />
        </div>
        <div v-if="untrusting === p.id" class="lsd-confirm" role="group" :aria-label="t('liveShare.trusted.untrustTitle', 'Stop trusting {{name}}?', { name: personName(p) })" @keydown.escape.stop.prevent="cancelUntrust(p)">
          <p class="lsd-confirm-text" v-text="t('liveShare.trusted.untrustText2', 'Stop trusting {{name}}? If they are connected, they are disconnected; to come back they need an invitation and your yes.', { name: personName(p) })"></p>
          <div class="lsd-actions">
            <button type="button" class="confirm-btn ls-small" :data-test="'ls-trusted-untrust-cancel-' + p.id" @click="cancelUntrust(p)">{{ t('liveShare.cancel', 'Cancel') }}</button>
            <button type="button" class="confirm-btn ls-small primary danger" :disabled="ctx.busy(p.id + ':untrust')" :data-test="'ls-trusted-untrust-yes-' + p.id" @click="untrust(p)">{{ t('liveShare.trusted.untrust', 'Stop trusting') }}</button>
          </div>
        </div>
        <div v-else-if="renaming !== p.id" class="lsd-actions start">
          <button type="button" class="confirm-btn ls-small" :data-test="'ls-trusted-rename-' + p.id" @click="startRename(p)"><Pencil :size="12" aria-hidden="true" /> {{ t('liveShare.trusted.rename', 'Rename') }}</button>
          <button type="button" class="confirm-btn ls-small danger" :data-test="'ls-trusted-untrust-' + p.id" @click="askUntrust(p)"><ShieldOff :size="12" aria-hidden="true" /> {{ t('liveShare.trusted.untrust', 'Stop trusting') }}</button>
        </div>
      </li>
    </ul>
  </section>
</template>
