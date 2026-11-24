<script setup>
// Live Share: the people with access, one list (main's one access model;
// LiveShareDialog's context runs the calls): the guests in now, the people
// let in who are offline (they come back by themselves) and the people you
// trust (kept across shares, so also before you share). Who waits for your
// answer is in the dialog's band, above.
//
// Every row is the same: who it is, one line saying what they do or when
// they were last seen and the projects they see, and one access menu (View
// only, Collaborate, Full control; Remove access or Stop trusting). A row
// never opens in place: a click goes to that person's page (LsPersonPage).
// Lowering someone's access applies at once; Full control (they can type, so
// run commands on this PC) is asked first, under their row. A project's "Who
// has access…" shows only the people who see it, until Show everyone.
import { ref, computed, nextTick, inject, watch } from 'vue'
import { ShieldCheck, X, ChevronRight } from 'lucide-vue-next'
import LsAvatars from './LsAvatars.vue'
import ThemedSelect from '../ui/ThemedSelect.vue'
import { invitesOf, personName, viaName } from '../../liveShareAccess'
import { peopleRows } from '../../liveSharePeople'
import { rightsPreset, presetLabel, presetHint, rightsSummary, shownRights } from '../../liveShareRights'
import { formatWhen } from '../../timeFormat'
import { t } from '../../i18n'

const props = defineProps({
  // A project's "Who has access…": only the people who see it.
  focusProject: { type: String, default: null }
})

// show-all: Show everyone (the dialog forgets the project).
const emit = defineEmits(['show-all'])

const ctx = inject('lsDialog')
const host = computed(() => ctx.host.value)
const sharing = computed(() => host.value.state === 'sharing')
const invites = computed(() => invitesOf(host.value))
const root = ref(null)

// Everyone but who waits (the band has them).
const rows = computed(() => peopleRows(host.value).filter((r) => r.kind !== 'waiting'))

// A project's "Who has access…": the people who see it, until Show everyone.
const onlyProject = computed(() => props.focusProject)
const shown = computed(() => (onlyProject.value ? rows.value.filter((r) => (r.projects || []).includes(onlyProject.value)) : rows.value))
const onlyText = computed(() => t('liveShare.people.onlyProject', 'Who sees {{project}}', { project: ctx.projectName(onlyProject.value) || '?' }))

const TEST_PREFIX = { guest: 'ls-guest-', offline: 'ls-offline-', trusted: 'ls-trusted-' }
const testId = (r) => TEST_PREFIX[r.kind] + r.id

// The names of the projects they see: a trusted person keeps projects of
// this window; the others, the projects shared now.
function projectNames(r) {
  const offered = r.kind === 'trusted' ? ctx.all.value : ctx.shared.value
  return offered.filter((p) => (r.projects || []).includes(p.id)).map((p) => p.name)
}
// The panes a guest in now has on screen, or types in (their names).
function panesOf(id, what) {
  const names = []
  for (const p of host.value.presence || []) if ((p.guests || []).some((g) => g.id === id && g[what])) names.push(ctx.paneTitle(p.id))
  return names.filter(Boolean)
}
const typingNow = (r) => r.kind === 'guest' && panesOf(r.id, 'typing').length > 0
function seenText(r) {
  if (r.online) return t('liveShare.trusted.online', 'Connected now')
  if (r.lastSeen) return t('liveShare.trusted.lastSeen', 'Last seen {{when}}', { when: formatWhen(r.lastSeen, ctx.now.value) })
  return t('liveShare.trusted.since', 'Trusted since {{when}}', { when: formatWhen(r.since, ctx.now.value) })
}
// The second line: what they do now or when they were last here, then the
// projects they see. Before a share, a trusted person: whether they will
// get in (one of their projects is ticked).
function lineOf(r) {
  const parts = []
  const names = projectNames(r)
  if (r.kind === 'guest') {
    const typing = panesOf(r.id, 'typing')
    const watching = panesOf(r.id, 'watching')
    if (typing.length) parts.push(t('liveShare.people.typing', 'Typing in {{panes}}', { panes: typing.join(', ') }))
    else if (watching.length) parts.push(t('liveShare.people.watching', 'Watching {{panes}}', { panes: watching.join(', ') }))
    else {
      const via = viaName(r.invite, invites.value)
      if (via) parts.push(t('liveShare.people.via', 'Came with {{invite}}', { invite: via }))
    }
  } else if (r.kind === 'offline') parts.push(t('liveShare.people.offline', 'Offline: comes back by itself'))
  else if (!sharing.value) {
    if (!names.length) return t('liveShare.people.noProject', 'No project')
    const ticked = ctx.shared.value.some((p) => (r.projects || []).includes(p.id))
    parts.push(ticked ? t('liveShare.people.willEnter', 'Gets in without asking') : t('liveShare.people.noTicked', 'None of their projects is ticked'))
  } else parts.push(seenText(r))
  parts.push(names.length ? names.join(', ') : t('liveShare.people.noProject', 'No project'))
  return parts.join(' · ')
}

// --- The access menu ---------------------------------------------------------
// A preset (each right that differs, in turn), or Remove / Stop trusting
// (asked first, on their page). Full control is asked first, here.
const ACCESS = ['view', 'collaborate', 'full']
const accessOf = (r) => rightsPreset(r.rights)
const removeText = (r) => (r.kind === 'trusted' ? t('liveShare.trusted.untrust', 'Stop trusting') : t('liveShare.people.removeAccess', 'Remove access'))
const busyAccess = (r) => shownRights().some((x) => ctx.busy(`${r.id}:right:${x.id}`)) // i18n-ignore
const raising = ref(null)
const focusIn = (selector) => nextTick(() => root.value?.querySelector(selector)?.focus())
function pickAccess(r, event) {
  const id = event && event.target ? event.target.value : ''
  if (id === 'remove') return ctx.openPerson(r.id, r.kind === 'trusted' ? 'untrust' : 'remove')
  if (!ACCESS.includes(id) || id === accessOf(r)) return
  if (id === 'full') {
    raising.value = r.id
    focusIn(`[data-test="ls-raise-cancel-${r.id}"]`) // i18n-ignore
    return
  }
  raising.value = null
  ctx.preset(r.id, r.rights, id)
}
function giveFull(r) {
  raising.value = null
  focusIn(`[data-test="ls-person-toggle-${r.id}"]`) // i18n-ignore
  ctx.preset(r.id, r.rights, 'full')
}
function cancelRaise(r) {
  raising.value = null
  focusIn(`[data-test="ls-person-toggle-${r.id}"]`) // i18n-ignore
}
// Someone gone while asked about: the question goes.
watch(rows, (list) => {
  if (raising.value && !list.some((r) => r.id === raising.value)) raising.value = null
})
const raiseText = (r) => t('liveShare.people.raiseText', '{{name}} will be able to run any command on this PC as you.', { name: personName(r) })
const accessLabel = (r) => t('liveShare.people.accessOf', 'What {{name}} can do', { name: personName(r) })
const openLabel = (r) => t('liveShare.people.open', 'Details of {{name}}', { name: personName(r) })

const emptyText = computed(() => {
  if (onlyProject.value && rows.value.length) return t('liveShare.people.noneProject', 'No one sees this project yet.')
  if (sharing.value) return t('liveShare.people.empty', 'No one has joined yet. Send an invitation code: each person waits for your yes.')
  return t('liveShare.people.noneYet', 'No one yet: once you share, the people you let in show here. People you trust stay here between shares.')
})
</script>

<template>
  <section ref="root" class="lpe" data-test="ls-people" :aria-label="t('liveShare.people.withAccess', 'People with access')">
    <p v-if="onlyProject" class="lpe-only" data-test="ls-people-only">
      <span>{{ onlyText }}</span>
      <button type="button" class="lpe-all" data-test="ls-people-all" @click="emit('show-all')"><X :size="11" aria-hidden="true" /> {{ t('liveShare.people.showAll', 'Show everyone') }}</button>
    </p>
    <p v-if="!shown.length" class="lsd-empty" data-test="ls-people-empty">{{ emptyText }}</p>

    <ul v-else class="lpe-list">
      <li v-for="r in shown" :key="r.kind + r.id" class="lpe-item" :data-test="testId(r)">
        <div class="lpe-row">
          <button type="button" class="lpe-main" :title="openLabel(r)" :aria-label="openLabel(r)" :data-test="'ls-person-toggle-' + r.id" @click="ctx.openPerson(r.id)">
            <span class="lpe-avatar" :class="{ off: !r.online }"><LsAvatars :people="[{ id: r.id, name: personName(r) }]" :size="24" /></span>
            <span class="lpe-text">
              <span class="lpe-top">
                <span class="lpe-name" :class="{ dim: !r.online }">{{ personName(r) }}</span>
                <span v-if="r.trusted" class="lpe-trusted" :title="t('liveShare.people.trustedBadge', 'Trusted')" data-test="ls-person-trusted"><ShieldCheck :size="12" aria-hidden="true" /><span class="sr-only">{{ t('liveShare.people.trustedBadge', 'Trusted') }}</span></span>
                <span v-if="typingNow(r)" class="tag tag-warn">{{ t('liveShare.people.typingTag', 'Typing') }}</span>
                <span v-else-if="r.online" class="tag tag-ok">{{ t('liveShare.overview.inNow', 'In now') }}</span>
              </span>
              <span class="lpe-line" :title="lineOf(r)">{{ lineOf(r) }}</span>
            </span>
            <ChevronRight :size="14" class="lpe-chevron" aria-hidden="true" />
          </button>
          <ThemedSelect
            class="ls-input lpe-access"
            :value="accessOf(r)"
            :disabled="busyAccess(r)"
            :title="rightsSummary(r.rights).title"
            :aria-label="accessLabel(r)"
            :data-test="'ls-person-access-' + r.id"
            @change="pickAccess(r, $event)"
          >
            <option v-for="id in ACCESS" :key="id" :value="id" :title="presetHint(id, r.rights)">{{ presetLabel(id) }}</option>
            <option v-if="accessOf(r) === 'custom'" value="custom" disabled>{{ rightsSummary(r.rights).text }}</option>
            <option value="remove">{{ removeText(r) }}</option>
          </ThemedSelect>
        </div>
        <div v-if="raising === r.id" class="lsd-confirm lpe-raise" role="group" :aria-label="raiseText(r)" :data-test="'ls-raise-confirm-' + r.id" @keydown.escape.stop.prevent="cancelRaise(r)">
          <p class="lsd-confirm-text">{{ raiseText(r) }}</p>
          <div class="lsd-actions">
            <button type="button" class="confirm-btn ls-small" :data-test="'ls-raise-cancel-' + r.id" @click="cancelRaise(r)">{{ t('liveShare.cancel', 'Cancel') }}</button>
            <button type="button" class="confirm-btn ls-small primary danger" :data-test="'ls-raise-yes-' + r.id" @click="giveFull(r)">{{ t('liveShare.people.raiseYes', 'Give full control') }}</button>
          </div>
        </div>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.lpe {
  min-width: 0;
}
.lpe-only {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0 0 6px;
  color: var(--text);
  font-size: 12px;
}
.lpe-all {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--accent);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.lpe-all:hover {
  text-decoration: underline;
}
/* Every row the same height; only this list scrolls when it is long. */
.lpe-list {
  max-height: 372px;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: 9px;
  list-style: none;
}
.lpe-item + .lpe-item {
  border-top: 1px solid var(--border);
}
.lpe-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-right: 10px;
}
.lpe-main {
  display: flex;
  flex: 1 1 0;
  align-items: center;
  gap: 10px;
  min-width: 0;
  min-height: 50px;
  padding: 6px 4px 6px 10px;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.lpe-main:hover {
  background: var(--surface-3);
}
.lpe-main:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
.lpe-avatar {
  flex: none;
  display: inline-flex;
}
.lpe-avatar.off {
  opacity: 0.55;
}
.lpe-text {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
.lpe-top {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.lpe-name {
  min-width: 0;
  overflow: hidden;
  color: var(--text-strong);
  font-size: 13px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.lpe-name.dim {
  color: var(--text);
}
.lpe-trusted {
  display: inline-flex;
  flex: none;
  color: var(--accent);
}
.lpe-line {
  overflow: hidden;
  color: var(--text-dim);
  font-size: 11.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.lpe-chevron {
  flex: none;
  color: var(--text-dim);
  opacity: 0.7;
}
.lpe-raise {
  margin: 0 10px 10px 44px;
}
</style>
