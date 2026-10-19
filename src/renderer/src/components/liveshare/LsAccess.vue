<script setup>
// Live Share: People's Grid view, from main's one access model. Every person
// with access (the guests in, the people offline, the trusted people not
// connected; not the ones still waiting for your answer) against the shared
// projects, then their rights: one preset per person, or, the Rights header
// opened, a column per right. Each box a live change, as in the list; a name
// opens that person in the list (trust, remove, the agents they may use).
//
// The grid fits the dialog (720 px) without scrolling sideways: its columns
// share the width (project names shortened, whole in their tooltips), and
// the per-right columns replace the preset column instead of adding to it.
// A project's "Who has access…" lights that project's column. Invitations
// have their own section (a change there asks about the people who joined
// with them).
import { ref, computed, inject } from 'vue'
import { ShieldCheck, ChevronRight, ChevronLeft } from 'lucide-vue-next'
import LsAvatars from './LsAvatars.vue'
import ThemedSelect from '../ui/ThemedSelect.vue'
import { rightIcon } from './RightsGrid.vue'
import { accessPeople, personName } from '../../liveShareAccess'
import { shownRights, rightsPreset, rightsSummary, presetLabel } from '../../liveShareRights'
import { t } from '../../i18n'

const props = defineProps({
  // A project's column lit (a project's "Who has access…").
  focusProject: { type: String, default: null }
})
// open(id): that person, in the list.
const emit = defineEmits(['open'])

const ctx = inject('lsDialog')
const host = computed(() => ctx.host.value)
const sharing = computed(() => host.value.state === 'sharing')
const shared = computed(() => ctx.shared.value)
const rights = computed(() => shownRights())
const people = computed(() => accessPeople(host.value))
const focused = computed(() => shared.value.find((p) => p.id === props.focusProject) || null)
// The per-right columns instead of the preset column.
const allRights = ref(false)

const has = (row, projectId) => Array.isArray(row.projects) && row.projects.includes(projectId)
const busyKey = (id, what, key) => `${id}:${what}:${key}` // i18n-ignore
function setProject(row, projectId, event) {
  event.target.checked = has(row, projectId)
  ctx.run(busyKey(row.id, 'project', projectId), () => ctx.api.access({ subject: row.id, project: projectId, on: !has(row, projectId) }))
}
const hasRight = (row, id) => !!(row.rights && row.rights[id] === true)
function setRight(row, id, event) {
  event.target.checked = hasRight(row, id)
  ctx.run(busyKey(row.id, 'right', id), () => ctx.api.access({ subject: row.id, right: id, on: !hasRight(row, id) }))
}
// A preset picked: each right that differs, in turn (the dialog's preset).
const PRESETS = ['view', 'collaborate', 'full']
const presetOf = (row) => rightsPreset(row.rights)
function pickPreset(row, event) {
  const id = event && event.target ? event.target.value : ''
  if (PRESETS.includes(id) && id !== presetOf(row)) ctx.preset(row.id, row.rights, id)
}
const busyRights = (row) => rights.value.some((r) => ctx.busy(busyKey(row.id, 'right', r.id)))

const kindText = (row) => (row.kind === 'trusted' ? t('liveShare.access.trustedOffline', 'Trusted, not connected') : row.kind === 'offline' ? t('liveShare.people.offlineBadge', 'Offline') : '')
const cellLabel = (name, what) => t('liveShare.access.cell', '{{name}}: {{what}}', { name, what })
const openTitle = (row) => t('liveShare.access.openPerson', 'Open {{name}} in the list', { name: personName(row) })
const focusText = computed(() => (focused.value ? t('liveShare.access.focusNote', 'Who has access to {{project}}: its column is lit.', { project: focused.value.name }) : ''))
</script>

<template>
  <section class="lsd-section" data-test="ls-access" :aria-label="t('liveShare.peopleView.grid2', 'Grid')">
    <p v-if="!sharing" class="lsd-empty" data-test="ls-access-off">{{ t('liveShare.access.off2', 'Start sharing to see who has access to each shared project. Trusted people are in the list.') }}</p>
    <p v-else-if="!shared.length" class="lsd-empty">{{ t('liveShare.access.noProjects', 'Tessel is still finding the projects you share.') }}</p>
    <p v-else-if="!people.length" class="lsd-empty" data-test="ls-access-empty">{{ t('liveShare.access.empty2', 'Nobody has access yet: send an invitation, or trust someone.') }}</p>
    <template v-else>
      <p v-if="focused" class="lsx-focus-note" data-test="ls-access-focus">{{ focusText }}</p>
      <div class="lsx-frame">
        <table class="lsx-grid" :class="{ wide: allRights }" data-test="ls-access-grid">
          <caption class="sr-only">{{ t('liveShare.access.caption', 'Who sees each shared project, and what they can do') }}</caption>
          <colgroup>
            <col class="lsx-c-who" />
            <col v-for="p in shared" :key="p.id" />
            <col v-if="!allRights" class="lsx-c-preset" />
            <template v-else><col v-for="r in rights" :key="r.id" class="lsx-c-right" /></template>
          </colgroup>
          <thead>
            <tr>
              <th scope="col" class="lsx-who" :rowspan="allRights ? 2 : 1">{{ t('liveShare.access.person', 'Person') }}</th>
              <th v-for="p in shared" :key="p.id" scope="col" class="lsx-col" :class="{ focus: focusProject === p.id }" :title="p.name" :rowspan="allRights ? 2 : 1" :data-test="'ls-access-col-' + p.id">
                <span class="lsx-ellip">{{ p.name }}</span>
              </th>
              <th scope="col" class="lsx-col lsx-rights-head" :colspan="allRights ? rights.length : 1">
                <button type="button" class="lsx-head-btn" :aria-expanded="allRights" :title="allRights ? t('liveShare.access.presetsTitle', 'One preset per person') : t('liveShare.access.eachRightTitle', 'A column per right')" data-test="ls-access-rights-toggle" @click="allRights = !allRights">
                  <ChevronLeft v-if="allRights" :size="12" aria-hidden="true" />
                  <span>{{ t('liveShare.access.rights', 'Rights') }}</span>
                  <ChevronRight v-if="!allRights" :size="12" aria-hidden="true" />
                </button>
              </th>
            </tr>
            <tr v-if="allRights">
              <th v-for="(r, i) in rights" :key="r.id" scope="col" class="lsx-col lsx-right" :class="{ first: i === 0, danger: r.danger }" :title="r.label + '\n' + r.hint" :data-test="'ls-access-right-col-' + r.id">
                <component :is="rightIcon(r.id)" :size="13" aria-hidden="true" />
                <span class="sr-only">{{ r.label }}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in people" :key="row.id" :data-test="'ls-access-row-' + row.id">
              <th scope="row" class="lsx-who">
                <button type="button" class="lsx-who-btn" :title="openTitle(row)" :data-test="'ls-access-open-' + row.id" @click="emit('open', row.id)">
                  <LsAvatars :people="[{ id: row.id, name: row.name }]" :size="18" />
                  <span class="lsx-who-text">
                    <span class="lsx-name-line">
                      <span class="lsx-name">{{ row.name }}</span>
                      <ShieldCheck v-if="row.trusted" :size="12" class="lsx-trusted" :aria-label="t('liveShare.people.trustedBadge', 'Trusted')" />
                    </span>
                    <span v-if="kindText(row)" class="lsx-kind">{{ kindText(row) }}</span>
                  </span>
                </button>
              </th>
              <td v-for="p in shared" :key="p.id" class="lsx-cell" :class="{ focus: focusProject === p.id }">
                <input type="checkbox" :checked="has(row, p.id)" :disabled="ctx.busy(busyKey(row.id, 'project', p.id))" :aria-label="cellLabel(row.name, p.name)" :data-test="'ls-access-' + row.id + '-' + p.id" @change="setProject(row, p.id, $event)" />
              </td>
              <td v-if="!allRights" class="lsx-cell lsx-preset">
                <ThemedSelect
                  class="ls-input lsx-select"
                  :class="{ danger: rightsSummary(row.rights).danger }"
                  :value="presetOf(row)"
                  :disabled="busyRights(row)"
                  :title="rightsSummary(row.rights).title"
                  :aria-label="cellLabel(row.name, t('liveShare.access.rights', 'Rights'))"
                  :data-test="'ls-access-' + row.id + '-preset'"
                  @change="pickPreset(row, $event)"
                >
                  <option v-for="id in PRESETS" :key="id" :value="id">{{ presetLabel(id) }}</option>
                  <option v-if="presetOf(row) === 'custom'" value="custom" disabled>{{ rightsSummary(row.rights).text }}</option>
                </ThemedSelect>
              </td>
              <template v-else>
                <td v-for="(r, i) in rights" :key="r.id" class="lsx-cell lsx-right" :class="{ first: i === 0 }">
                  <input type="checkbox" :checked="hasRight(row, r.id)" :disabled="ctx.busy(busyKey(row.id, 'right', r.id))" :aria-label="cellLabel(row.name, r.label)" :data-test="'ls-access-' + row.id + '-right-' + r.id" @change="setRight(row, r.id, $event)" />
                </td>
              </template>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </section>
</template>

<style scoped>
.lsx-focus-note {
  margin: 0;
  color: var(--text);
  font-size: 12px;
}
.lsx-frame {
  min-width: 0;
  border: 1px solid var(--border);
  border-radius: 9px;
  overflow: hidden;
}
/* Fixed layout: the columns share the dialog's width, never wider. */
.lsx-grid {
  width: 100%;
  table-layout: fixed;
  border-collapse: collapse;
  font-size: 12px;
}
.lsx-c-who {
  width: 32%;
}
.lsx-c-preset {
  width: 138px;
}
.lsx-c-right {
  width: 30px;
}
.lsx-grid th,
.lsx-grid td {
  padding: 5px 6px;
  border-bottom: 1px solid var(--border);
  text-align: center;
  vertical-align: middle;
}
.lsx-grid tbody tr:last-child th,
.lsx-grid tbody tr:last-child td {
  border-bottom: 0;
}
.lsx-grid thead th {
  color: var(--text-dim);
  font-weight: 500;
  white-space: nowrap;
}
.lsx-ellip {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.lsx-who {
  text-align: left !important;
}
.lsx-who-btn {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  min-width: 0;
  padding: 2px 4px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.lsx-who-btn:hover {
  background: var(--surface-3);
}
.lsx-who-btn:focus-visible,
.lsx-head-btn:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.lsx-who-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.lsx-name-line {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
}
.lsx-name {
  min-width: 0;
  overflow: hidden;
  color: var(--text-strong);
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.lsx-kind {
  overflow: hidden;
  color: var(--text-dim);
  font-size: 11px;
  font-weight: 400;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.lsx-trusted {
  flex: none;
  color: var(--accent);
}
/* A project's "Who has access…": its column lit. */
.lsx-col.focus {
  color: var(--text-strong);
  box-shadow: inset 0 -2px 0 var(--accent);
}
.lsx-cell.focus,
.lsx-col.focus {
  background: color-mix(in srgb, var(--accent) 10%, transparent);
}
.lsx-head-btn {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  max-width: 100%;
  padding: 2px 6px;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  background: transparent;
  color: var(--text);
  font: inherit;
  font-size: 11.5px;
  cursor: pointer;
}
.lsx-head-btn:hover {
  background: var(--surface-3);
  color: var(--text-strong);
}
.lsx-right {
  padding-left: 2px !important;
  padding-right: 2px !important;
}
.lsx-right.first {
  border-left: 1px solid var(--border-strong);
}
.lsx-right.danger {
  color: #ffb4b6;
}
.lsx-cell input {
  margin: 0;
  accent-color: var(--accent);
}
.lsx-cell input:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.lsx-preset {
  text-align: left !important;
}
.lsx-select {
  width: 100%;
  height: 24px;
  padding: 0 6px;
  font-size: 11.5px;
}
.lsx-select.danger {
  border-color: color-mix(in srgb, var(--danger) 55%, transparent);
}
</style>
