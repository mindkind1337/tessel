<script setup>
// Live Share: everyone of the share in one list (main's one access model;
// LiveShareDialog's context runs the calls): who waits for your answer, the
// guests in now, the people let in who are offline (they come back by
// themselves, with what you leave them), and the people you trust (kept
// across shares and restarts, so also before you share). Filter chips narrow
// it: All · In now · Waiting · Offline · Trusted.
//
// A row says who it is, how they came and what they do now, the projects
// they see (chips) and their rights (one chip). Someone waiting has Let in…
// (their prompt, with the code to check and what their invitation offers)
// and Refuse on their row. Any other row opens on what they see (a chip per
// project), what they may do (presets, then a tile per right), the agents
// they may use, and Trust / Rename / Stop trusting / Remove. Every chip and
// tile is a live change; a trusted person's changes are kept for next time.
// Remove takes a guest out (a trusted one: they stop being trusted too,
// unless you untick it); Stop trusting is asked first (their connections
// end, and they need your yes again).
//
// List | Grid: the grid (LsAccess.vue) shows the same people against the
// shared projects, to change many at once.
import { ref, computed, nextTick, inject, watch } from 'vue'
import { ShieldCheck, ShieldOff, UserX, UserCheck, Pencil, List, Table2 } from 'lucide-vue-next'
import ProjectChecks from './ProjectChecks.vue'
import RightsGrid from './RightsGrid.vue'
import RightsChip from './RightsChip.vue'
import LsAgents from './LsAgents.vue'
import LsAvatars from './LsAvatars.vue'
import LsAccess from './LsAccess.vue'
import { joinedGuests, waitingGuests, offlinePeople, trustedPeople, invitesOf, personName, viaName } from '../../liveShareAccess'
import { cleanRights } from '../../../../shared/liveShareRights'
import { formatWhen } from '../../timeFormat'
import { t } from '../../i18n'

const props = defineProps({
  // 'list' or 'grid'.
  view: { type: String, default: 'list' },
  // all, in, waiting, offline, trusted.
  filter: { type: String, default: 'all' },
  // The grid: a project's column lit first (a project's "Who has access…").
  focusProject: { type: String, default: null }
})
const emit = defineEmits(['update:view', 'update:filter'])

const ctx = inject('lsDialog')
const host = computed(() => ctx.host.value)
const sharing = computed(() => host.value.state === 'sharing')
const invites = computed(() => invitesOf(host.value))

// Everyone, once each, in this order. kind: 'waiting' | 'guest' (in now) |
// 'offline' (let in during this share) | 'trusted' (not connected through
// this share). A trusted person connected now is their guest row (trustId
// links it); one offline is their trusted entry.
const rows = computed(() => {
  const h = host.value
  const trusted = trustedPeople(h)
  const trustedIds = new Set(trusted.map((e) => e.id))
  const joined = joinedGuests(h)
  const out = waitingGuests(h).map((g) => ({ ...g, kind: 'waiting', online: false }))
  for (const g of joined) out.push({ ...g, kind: 'guest', online: true })
  for (const p of offlinePeople(h)) if (!(p.trustId && trustedIds.has(p.trustId))) out.push({ ...p, kind: 'offline', online: false })
  const inNow = new Set(joined.map((g) => g.trustId).filter(Boolean))
  for (const e of trusted) if (!inNow.has(e.id)) out.push({ ...e, kind: 'trusted', online: !!e.online, trusted: true, trustable: true })
  return out
})

const FILTERS = {
  all: () => true,
  in: (r) => r.online,
  waiting: (r) => r.kind === 'waiting',
  offline: (r) => !r.online && r.kind !== 'waiting',
  trusted: (r) => !!r.trusted
}
const filterId = computed(() => (FILTERS[props.filter] ? props.filter : 'all'))
const shown = computed(() => rows.value.filter(FILTERS[filterId.value]))
const filters = computed(() => [
  { id: 'all', label: t('liveShare.people.filterAll', 'All') },
  { id: 'in', label: t('liveShare.overview.inNow', 'In now') },
  { id: 'waiting', label: t('liveShare.people.filterWaiting', 'Waiting') },
  { id: 'offline', label: t('liveShare.people.offlineBadge', 'Offline') },
  { id: 'trusted', label: t('liveShare.people.trustedBadge', 'Trusted') }
].map((f) => ({ ...f, count: rows.value.filter(FILTERS[f.id]).length })))

// --- Rows ----------------------------------------------------------------------
const TEST_PREFIX = { waiting: 'ls-waiting-', guest: 'ls-guest-', offline: 'ls-offline-', trusted: 'ls-trusted-' }
const testId = (r) => TEST_PREFIX[r.kind] + r.id
// Their trusted entry (t-…): a trusted row's own id, or the one a trusted
// guest's connection carries (rename and stop trusting go to it).
const trustIdOf = (r) => (r.kind === 'trusted' ? r.id : r.trusted ? r.trustId || null : null)
// A trusted person not connected keeps projects for when they are shared:
// any project of this window; the others, the projects shared now.
const offered = (r) => (r.kind === 'trusted' ? ctx.all.value : ctx.shared.value)
function projectsOf(r) {
  const list = offered(r).filter((p) => (r.projects || []).includes(p.id))
  return { shown: list.slice(0, 2), more: list.slice(2) }
}
// Projects kept for someone that this window does not have (another set of
// projects, a project removed since): counted, never lost.
const elsewhere = (r) => (r.kind === 'trusted' ? (r.projects || []).filter((id) => !ctx.all.value.some((x) => x.id === id)).length : 0)
const elsewhereText = (r) => {
  const count = elsewhere(r)
  return count === 1 ? t('liveShare.trusted.elsewhere', 'And {{count}} project not in this window (kept).', { count }) : t('liveShare.trusted.elsewhere', 'And {{count}} projects not in this window (kept).', { count })
}

// The panes a guest in now has on screen, or types in (their names).
function panesOf(id, what) {
  const names = []
  for (const p of host.value.presence || []) if ((p.guests || []).some((g) => g.id === id && g[what])) names.push(ctx.paneTitle(p.id))
  return names.filter(Boolean)
}
function seenText(r) {
  if (r.online) return t('liveShare.trusted.online', 'Connected now')
  if (r.lastSeen) return t('liveShare.trusted.lastSeen', 'Last seen {{when}}', { when: formatWhen(r.lastSeen, ctx.now.value) })
  return t('liveShare.trusted.since', 'Trusted since {{when}}', { when: formatWhen(r.since, ctx.now.value) })
}
// The line under the name: their code (waiting), what they type in or
// watch, the invitation they came with, when a trusted person was last here.
function descOf(r) {
  const parts = []
  if (r.kind === 'waiting' && r.code) parts.push(t('liveShare.overview.code', 'Code {{code}}', { code: r.code }))
  if (r.kind === 'trusted') parts.push(seenText(r))
  const typing = r.kind === 'guest' ? panesOf(r.id, 'typing') : []
  const watching = r.kind === 'guest' ? panesOf(r.id, 'watching') : []
  if (typing.length) parts.push(t('liveShare.people.typing', 'Typing in {{panes}}', { panes: typing.join(', ') }))
  else if (watching.length) parts.push(t('liveShare.people.watching', 'Watching {{panes}}', { panes: watching.join(', ') }))
  const via = viaName(r.invite, invites.value)
  if (via) parts.push(t('liveShare.people.via', 'Came with {{invite}}', { invite: via }))
  if (r.kind === 'offline') parts.push(t('liveShare.people.offline', 'Offline: comes back by itself'))
  return parts.join(' · ')
}
const typingNow = (r) => r.kind === 'guest' && panesOf(r.id, 'typing').length > 0

// --- Open rows -------------------------------------------------------------------
const openId = ref(null)
const root = ref(null)
const focusIn = (selector) => nextTick(() => root.value?.querySelector(selector)?.focus())
function toggle(r) {
  openId.value = openId.value === r.id ? null : r.id
  removing.value = null
  untrusting.value = null
  renaming.value = null
}
// Someone gone (left, removed, no longer trusted): their row closes.
watch(rows, (list) => {
  if (openId.value && !list.some((r) => r.id === openId.value && r.kind !== 'waiting')) openId.value = null
})
// From the grid: their row, open, in the list.
function openPerson(id) {
  emit('update:filter', 'all')
  emit('update:view', 'list')
  openId.value = id
  nextTick(() => focusIn(`[data-test="ls-person-toggle-${id}"]`)) // i18n-ignore
}

// --- Changes ---------------------------------------------------------------------
const busyProject = (r) => (id) => ctx.busy(`${r.id}:project:${id}`) // i18n-ignore
const busyRight = (r) => (id) => ctx.busy(`${r.id}:right:${id}`) // i18n-ignore
function setProject(r, project, on) {
  // A trusted person not connected has a cap on the projects kept.
  const failed =
    r.kind !== 'trusted'
      ? undefined
      : on
        ? t('liveShare.trusted.addFailed', '{{project}} could not be given to {{name}} (a trusted person can have up to 64 projects).', { project: ctx.projectName(project) || '?', name: personName(r) })
        : t('liveShare.trusted.removeFailed', '{{project}} could not be taken away from {{name}}.', { project: ctx.projectName(project) || '?', name: personName(r) })
  ctx.run(`${r.id}:project:${project}`, () => ctx.api.access({ subject: r.id, project, on }), failed) // i18n-ignore
}
function setRight(r, right, on) {
  ctx.run(`${r.id}:right:${right}`, () => ctx.api.access({ subject: r.id, right, on })) // i18n-ignore
}
// The agents they may use (null: the share's setting).
function setAgents(r, agents) {
  ctx.run(`${r.id}:agents`, () => ctx.api.access({ subject: r.id, agents })) // i18n-ignore
}

async function trust(r) {
  const res = await ctx.run(`${r.id}:trust`, () => ctx.api.trust({ guestId: r.id }), t('liveShare.people.trustFailed', '{{name}} could not be trusted (they may have left, or their Tessel is too old).', { name: personName(r) })) // i18n-ignore
  if (res && res.ok) ctx.notice(t('liveShare.people.trusted', '{{name}} is trusted: next time they get in without asking, with these projects and rights.', { name: personName(r) }))
}

// Remove (a guest, in or offline).
const removing = ref(null)
const untrustToo = ref(false)
function askRemove(r) {
  renaming.value = null
  untrusting.value = null
  // A trusted person removed stops being trusted too unless you untick it
  // (else they could come back without asking).
  untrustToo.value = !!r.trusted
  removing.value = r.id
  focusIn(`[data-test="ls-person-remove-cancel-${r.id}"]`) // i18n-ignore
}
function cancelRemove(r) {
  removing.value = null
  focusIn(`[data-test="ls-person-remove-${r.id}"]`) // i18n-ignore
}
async function remove(r) {
  const untrust = !!(r.trusted && untrustToo.value)
  const res = await ctx.run(`${r.id}:remove`, () => ctx.api.removeGuest({ guestId: r.id, untrust })) // i18n-ignore
  removing.value = null
  if (res && res.ok) ctx.notice(untrust ? t('liveShare.people.removedUntrusted', '{{name}} was removed and is no longer trusted.', { name: personName(r) }) : t('liveShare.people.removed', '{{name}} was removed.', { name: personName(r) }))
}

// Rename (a trusted person: the name kept for them).
const renaming = ref(null)
const draft = ref('')
function startRename(r) {
  removing.value = null
  untrusting.value = null
  renaming.value = r.id
  draft.value = r.name || ''
  focusIn(`[data-test="ls-trusted-name-input-${r.id}"]`) // i18n-ignore
}
function cancelRename(r) {
  renaming.value = null
  focusIn(`[data-test="ls-trusted-rename-${r.id}"]`) // i18n-ignore
}
async function rename(r) {
  const name = draft.value.trim()
  if (!name || name === r.name) return cancelRename(r)
  const res = await ctx.run(`${r.id}:rename`, () => ctx.api.renameTrusted({ id: trustIdOf(r), name })) // i18n-ignore
  if (res && res.ok) cancelRename(r)
}

// Stop trusting (asked first).
const untrusting = ref(null)
function askUntrust(r) {
  removing.value = null
  renaming.value = null
  untrusting.value = r.id
  focusIn(`[data-test="ls-trusted-untrust-cancel-${r.id}"]`) // i18n-ignore
}
function cancelUntrust(r) {
  untrusting.value = null
  focusIn(`[data-test="ls-trusted-untrust-${r.id}"]`) // i18n-ignore
}
async function untrust(r) {
  const res = await ctx.run(`${r.id}:untrust`, () => ctx.api.untrust({ id: trustIdOf(r) })) // i18n-ignore
  untrusting.value = null
  if (res && res.ok) ctx.notice(t('liveShare.trusted.untrusted', '{{name}} is no longer trusted: next time they need an invitation and your yes.', { name: personName(r) }))
}

// A no: main turns them away (their prompt goes with it).
async function refuse(g) {
  const res = await ctx.run(`${g.id}:answer`, () => ctx.api.approve({ guestId: g.id, yes: false, projects: [], rights: cleanRights(null), trust: false })) // i18n-ignore
  if (res && res.ok) ctx.notice(t('liveShare.people.refused', '{{name}} was turned away.', { name: personName(g) }))
}

const emptyText = computed(() => {
  if (filterId.value === 'trusted') return t('liveShare.trusted.empty', 'You trust no one yet.')
  if (!rows.value.length && sharing.value) return t('liveShare.people.empty', 'No one has joined yet. Send an invitation code: each person waits for your yes.')
  return t('liveShare.people.noneHere', 'No one here.')
})
const emptyTest = computed(() => (filterId.value === 'trusted' ? 'ls-trusted-empty' : 'ls-people-empty'))
</script>

<template>
  <section ref="root" class="lsd-section" data-test="ls-people" :aria-label="t('liveShare.section.people', 'People')">
    <div class="lpe-bar">
      <div v-if="view !== 'grid'" class="lpe-filters" role="group" :aria-label="t('liveShare.people.filterLabel', 'Show')">
        <button
          v-for="f in filters"
          :key="f.id"
          type="button"
          class="chip"
          :class="{ on: filterId === f.id }"
          :aria-pressed="filterId === f.id"
          :data-test="'ls-people-filter-' + f.id"
          @click="emit('update:filter', f.id)"
        >
          {{ f.label }}<span v-if="f.count" class="chip-count">{{ f.count }}</span>
        </button>
      </div>
      <p v-else class="lpe-caption">{{ t('liveShare.access.caption', 'Who sees each shared project, and what they can do') }}</p>
      <div class="lpe-seg" role="group" :aria-label="t('liveShare.people.viewLabel', 'View')">
        <button type="button" class="lpe-seg-item" :class="{ on: view !== 'grid' }" :aria-pressed="view !== 'grid'" data-test="ls-people-view-list" @click="emit('update:view', 'list')">
          <List :size="13" aria-hidden="true" /> {{ t('liveShare.peopleView.list2', 'List') }}
        </button>
        <button type="button" class="lpe-seg-item" :class="{ on: view === 'grid' }" :aria-pressed="view === 'grid'" data-test="ls-people-view-grid" @click="emit('update:view', 'grid')">
          <Table2 :size="13" aria-hidden="true" /> {{ t('liveShare.peopleView.grid2', 'Grid') }}
        </button>
      </div>
    </div>

    <LsAccess v-if="view === 'grid'" :focus-project="focusProject" @open="openPerson" />

    <template v-else>
      <p v-if="!sharing" class="lpe-note" data-test="ls-section-off">{{ t('liveShare.section.offPeople', 'No one is here before you share. Trusted people are kept between shares.') }}</p>
      <p v-if="filterId === 'trusted' && rows.some((r) => r.trusted)" class="lpe-note">{{ t('liveShare.trusted.intro', 'Trusted people get in without asking, with the projects and rights kept here (they see the ones you share at the time). Trust someone from People or when you let them in.') }}</p>
      <p v-if="!shown.length" class="lsd-empty" :data-test="emptyTest">{{ emptyText }}</p>

      <ul v-else class="sl-list lpe-list">
        <li v-for="r in shown" :key="r.kind + r.id" class="sl-item" :class="{ open: openId === r.id, waiting: r.kind === 'waiting' }" :data-test="testId(r)">
          <!-- Waiting for your answer: Let in… and Refuse on the row. -->
          <div v-if="r.kind === 'waiting'" class="sl-row ls-row ls-row-static">
            <span class="ls-row-inner">
              <span class="sl-row-icon"><LsAvatars :people="[{ id: r.id, name: personName(r) }]" :size="22" /></span>
              <span class="sl-row-main">
                <span class="sl-row-top">
                  <span class="sl-row-name">{{ personName(r) }}</span>
                  <span class="tag tag-warn">{{ t('liveShare.people.waitingTag', 'Waiting for your answer') }}</span>
                </span>
                <span v-if="descOf(r)" class="sl-row-desc" :title="descOf(r)">{{ descOf(r) }}</span>
              </span>
            </span>
            <span class="sl-actions">
              <button type="button" class="confirm-btn ls-small primary" :disabled="ctx.busy(r.id + ':answer')" :data-test="'ls-waiting-letin-' + r.id" @click="ctx.review(r.id)">
                <UserCheck :size="12" aria-hidden="true" /> {{ t('liveShare.people.letIn', 'Let in…') }}
              </button>
              <button type="button" class="confirm-btn ls-small danger" :disabled="ctx.busy(r.id + ':answer')" :data-test="'ls-waiting-refuse-' + r.id" @click="refuse(r)">{{ t('liveShare.people.refuse', 'Refuse') }}</button>
            </span>
          </div>

          <template v-else>
            <div class="sl-row ls-row">
              <button type="button" class="ls-row-inner ls-row-toggle" :aria-expanded="openId === r.id" :aria-controls="'lpe-details-' + r.id" :data-test="'ls-person-toggle-' + r.id" @click="toggle(r)">
                <span class="sl-row-icon"><LsAvatars :people="[{ id: r.id, name: personName(r) }]" :size="22" /></span>
                <span class="sl-row-main">
                  <span class="sl-row-top">
                    <span class="sl-row-name" :class="{ dim: !r.online }">{{ personName(r) }}</span>
                    <span v-if="r.trusted" class="tag tag-info lpe-tag-icon" data-test="ls-person-trusted"><ShieldCheck :size="10" aria-hidden="true" /> {{ t('liveShare.people.trustedBadge', 'Trusted') }}</span>
                    <span v-if="typingNow(r)" class="tag tag-warn">{{ t('liveShare.people.typingTag', 'Typing') }}</span>
                    <span v-else-if="r.online" class="tag tag-ok">{{ t('liveShare.overview.inNow', 'In now') }}</span>
                    <span v-else class="tag tag-off">{{ t('liveShare.people.offlineBadge', 'Offline') }}</span>
                  </span>
                  <span v-if="descOf(r)" class="sl-row-desc" :title="descOf(r)">{{ descOf(r) }}</span>
                </span>
                <span class="sl-row-meta lpe-meta">
                  <span v-for="p in projectsOf(r).shown" :key="p.id" class="tag tag-scope lpe-proj" :title="p.name">{{ p.name }}</span>
                  <span v-if="projectsOf(r).more.length" class="tag tag-scope" :title="projectsOf(r).more.map((p) => p.name).join(', ')">+{{ projectsOf(r).more.length }}</span>
                  <span v-if="!projectsOf(r).shown.length" class="tag tag-off">{{ t('liveShare.people.noProject', 'No project') }}</span>
                  <RightsChip :rights="r.rights || {}" />
                </span>
                <svg class="sl-chevron" width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M6 3.5l4.5 4.5L6 12.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </button>
            </div>

            <div v-if="openId === r.id" :id="'lpe-details-' + r.id" class="sl-details lpe-details" role="region" :aria-label="personName(r)">
              <div class="sl-section-head">{{ r.kind === 'trusted' ? t('liveShare.trusted.projects', 'Projects (seen when shared)') : t('liveShare.people.sees', 'Sees') }}</div>
              <ProjectChecks
                chips
                :projects="offered(r)"
                :selected="r.projects || []"
                :test-key="r.id"
                :busy="busyProject(r)"
                :label="t('liveShare.share.seesLabel', 'What {{name}} sees', { name: personName(r) })"
                :empty="r.kind === 'trusted' ? t('liveShare.trusted.noProjects', 'No project in this window.') : ''"
                @toggle="(id, on) => setProject(r, id, on)"
              />
              <p v-if="elsewhere(r)" class="lsd-hint">{{ elsewhereText(r) }}</p>

              <div class="sl-section-head">{{ t('liveShare.people.can', 'Can') }}</div>
              <RightsGrid
                presets
                :rights="r.rights || {}"
                :test-key="r.id"
                :busy="busyRight(r)"
                :label="t('liveShare.share.rightsLabel', 'What {{name}} can do', { name: personName(r) })"
                @toggle="(id, on) => setRight(r, id, on)"
                @preset="(id) => ctx.preset(r.id, r.rights, id)"
              />
              <LsAgents class="lpe-agents" :rule="(r.rights && r.rights.agents) || null" :can-type="!!(r.rights && r.rights.type)" :busy="ctx.busy(r.id + ':agents')" :test-key="r.id" @change="(rule) => setAgents(r, rule)" />
              <p v-if="r.trusted" class="lsd-hint lpe-hint">{{ t('liveShare.people.trustedHint', 'Trusted: what you change here is kept for next time.') }}</p>

              <div v-if="removing === r.id" class="lsd-confirm" role="group" :aria-label="t('liveShare.people.removeTitle', 'Remove {{name}}?', { name: personName(r) })" :data-test="'ls-person-remove-confirm-' + r.id" @keydown.escape.stop.prevent="cancelRemove(r)">
                <p class="lsd-confirm-text" v-text="t('liveShare.people.removeText', 'Remove {{name}}? They leave the session now and need a new invitation and your yes to come back.', { name: personName(r) })"></p>
                <label v-if="r.trusted" class="lsd-check" :data-test="'ls-person-untrust-' + r.id">
                  <input v-model="untrustToo" type="checkbox" />
                  <span>{{ t('liveShare.people.untrustToo2', 'Also stop trusting them (otherwise they can come back without asking, with any new code)') }}</span>
                </label>
                <p v-if="r.trusted && !untrustToo" class="lsd-hint" :data-test="'ls-person-keep-trust-' + r.id">{{ t('liveShare.people.keepTrust', 'They stay trusted: they can come back without asking.') }}</p>
                <div class="lsd-actions">
                  <button type="button" class="confirm-btn ls-small" :data-test="'ls-person-remove-cancel-' + r.id" @click="cancelRemove(r)">{{ t('liveShare.cancel', 'Cancel') }}</button>
                  <button type="button" class="confirm-btn ls-small primary danger" :disabled="ctx.busy(r.id + ':remove')" :data-test="'ls-person-remove-yes-' + r.id" @click="remove(r)">{{ t('liveShare.share.remove', 'Remove') }}</button>
                </div>
              </div>
              <div v-else-if="untrusting === r.id" class="lsd-confirm" role="group" :aria-label="t('liveShare.trusted.untrustTitle', 'Stop trusting {{name}}?', { name: personName(r) })" :data-test="'ls-trusted-untrust-confirm-' + r.id" @keydown.escape.stop.prevent="cancelUntrust(r)">
                <p class="lsd-confirm-text" v-text="t('liveShare.trusted.untrustText2', 'Stop trusting {{name}}? If they are connected, they are disconnected; to come back they need an invitation and your yes.', { name: personName(r) })"></p>
                <div class="lsd-actions">
                  <button type="button" class="confirm-btn ls-small" :data-test="'ls-trusted-untrust-cancel-' + r.id" @click="cancelUntrust(r)">{{ t('liveShare.cancel', 'Cancel') }}</button>
                  <button type="button" class="confirm-btn ls-small primary danger" :disabled="ctx.busy(r.id + ':untrust')" :data-test="'ls-trusted-untrust-yes-' + r.id" @click="untrust(r)">{{ t('liveShare.trusted.untrust', 'Stop trusting') }}</button>
                </div>
              </div>
              <form v-else-if="renaming === r.id" class="lsd-rename" @submit.prevent="rename(r)" @keydown.escape.stop.prevent="cancelRename(r)">
                <input v-model="draft" class="ls-input" type="text" maxlength="40" spellcheck="false" :aria-label="t('liveShare.trusted.nameLabel', 'Name')" :data-test="'ls-trusted-name-input-' + r.id" />
                <button type="submit" class="confirm-btn ls-small primary" :disabled="!draft.trim()">{{ t('liveShare.invite.save', 'Save') }}</button>
                <button type="button" class="confirm-btn ls-small" @click="cancelRename(r)">{{ t('liveShare.cancel', 'Cancel') }}</button>
              </form>
              <div v-else class="lsd-actions start lpe-actions">
                <button
                  v-if="r.trustable && !r.trusted"
                  type="button"
                  class="confirm-btn ls-small"
                  :disabled="ctx.busy(r.id + ':trust')"
                  :title="t('liveShare.people.trustTitle', 'Next time they get in without asking, with these projects and rights')"
                  :data-test="'ls-person-trust-' + r.id"
                  @click="trust(r)"
                >
                  <ShieldCheck :size="12" aria-hidden="true" /> {{ t('liveShare.people.trust', 'Trust') }}
                </button>
                <button v-if="trustIdOf(r)" type="button" class="confirm-btn ls-small" :data-test="'ls-trusted-rename-' + r.id" @click="startRename(r)"><Pencil :size="12" aria-hidden="true" /> {{ t('liveShare.trusted.rename', 'Rename') }}</button>
                <button v-if="trustIdOf(r)" type="button" class="confirm-btn ls-small danger" :data-test="'ls-trusted-untrust-' + r.id" @click="askUntrust(r)"><ShieldOff :size="12" aria-hidden="true" /> {{ t('liveShare.trusted.untrust', 'Stop trusting') }}</button>
                <button v-if="r.kind !== 'trusted'" type="button" class="confirm-btn ls-small danger" :data-test="'ls-person-remove-' + r.id" @click="askRemove(r)"><UserX :size="12" aria-hidden="true" /> {{ t('liveShare.share.remove', 'Remove') }}</button>
              </div>
            </div>
          </template>
        </li>
      </ul>
    </template>
  </section>
</template>

<style scoped>
.lpe-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 12px;
}
.lpe-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
}
.lpe-caption {
  margin: 0;
  color: var(--text-dim);
  font-size: 12px;
}
/* List | Grid. */
.lpe-seg {
  display: inline-flex;
  flex: none;
  padding: 2px;
  border: 1px solid var(--border);
  border-radius: 7px;
}
.lpe-seg-item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 22px;
  padding: 0 9px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--text-dim);
  font: inherit;
  font-size: 11.5px;
  cursor: pointer;
}
.lpe-seg-item:hover {
  color: var(--text);
}
.lpe-seg-item.on {
  background: color-mix(in srgb, var(--accent) 22%, transparent);
  color: var(--text-strong);
}
.lpe-seg-item:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.lpe-note {
  margin: 0;
  color: var(--text-dim);
  font-size: 12px;
  line-height: 1.45;
}
.lpe-list .sl-item.waiting {
  background: color-mix(in srgb, #d29922 7%, transparent);
}
.sl-row-name.dim {
  color: var(--text);
}
.lpe-tag-icon {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}
.lpe-meta {
  max-width: 46%;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 4px;
}
.lpe-proj {
  max-width: 110px;
}
.lpe-details {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.lpe-details .sl-section-head {
  margin: 4px 0 -2px;
  min-height: 0;
}
.lpe-agents {
  margin-top: 2px;
}
.lpe-actions {
  margin-top: 2px;
}
</style>
