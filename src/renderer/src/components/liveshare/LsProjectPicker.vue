<script setup>
// Live Share: choose among all your projects without listing them on the
// page. A panel under "Add a project": a search field (name or host), then
// the projects in groups (On this computer, then one group per SSH host), a
// box each; a tick is a live change (the panel stays open), Done closes it.
// The list scrolls inside the panel: 3 projects or 40, the page keeps its size.
import { ref, computed, onMounted } from 'vue'
import { Search } from 'lucide-vue-next'
import { remoteRootTooBroad } from '../../../../shared/remoteRootPolicy'
import { t } from '../../i18n'

const props = defineProps({
  // [{ id, name, ssh, host, sshPath, noFiles }]
  projects: { type: Array, default: () => [] },
  // Ticked ids.
  selected: { type: Array, default: () => [] },
  // (project) => true when its box cannot be unticked (the last one shared).
  locked: { type: Function, default: null },
  lockedTitle: { type: String, default: '' },
  // (id) => a change is on its way.
  busy: { type: Function, default: null },
  // The Live Share tags (terminals only, SSH…): on for the share's own picker.
  tags: { type: Boolean, default: true },
  // For data-test: ls-project-<id><testKey>.
  testKey: { type: String, default: '' }
})
const emit = defineEmits(['toggle', 'close'])

const query = ref('')
const field = ref(null)
onMounted(() => field.value?.focus())

const has = (p) => props.selected.includes(p.id)
const isLocked = (p) => !!(props.locked && props.locked(p))
const isBusy = (p) => !!(props.busy && props.busy(p.id))
const sshBroad = (p) => remoteRootTooBroad(p.sshPath)

const matches = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return props.projects
  return props.projects.filter((p) => String(p.name || '').toLowerCase().includes(q) || String(p.host || '').toLowerCase().includes(q))
})
// On this computer first, then each SSH host (in the order of its first project).
const groups = computed(() => {
  const local = { key: 'local', label: t('liveShare.projects.local', 'On this computer'), items: [] }
  const hosts = new Map()
  for (const p of matches.value) {
    if (!p.ssh) local.items.push(p)
    else {
      const key = p.host || ''
      if (!hosts.has(key)) hosts.set(key, { key: 'ssh:' + key, label: key ? t('liveShare.projects.sshGroup', 'SSH · {{host}}', { host: key }) : t('liveShare.share.sshTag', 'SSH'), items: [] })
      hosts.get(key).items.push(p)
    }
  }
  return [local, ...hosts.values()].filter((g) => g.items.length)
})
const placeholder = computed(() => t('liveShare.projects.search', 'Search {{count}} projects…', { count: props.projects.length }))
const noneText = computed(() => t('liveShare.projects.none', 'No project matches “{{q}}”.', { q: query.value.trim() }))

function toggle(p, event) {
  const box = event.target
  const on = !!box.checked
  // The box shows what is ticked until the answer changes it.
  box.checked = has(p)
  if (isBusy(p) || (!on && isLocked(p))) return
  emit('toggle', p.id, on)
}
</script>

<template>
  <div class="lpk" role="group" :aria-label="t('liveShare.projects.add', 'Add a project')" data-test="ls-picker" @keydown.escape.stop.prevent="emit('close')">
    <div class="lpk-search">
      <Search :size="14" class="lpk-search-icon" aria-hidden="true" />
      <input ref="field" v-model="query" type="text" class="ls-input lpk-input" spellcheck="false" autocomplete="off" :placeholder="placeholder" :aria-label="placeholder" data-test="ls-picker-search" />
    </div>
    <div class="lpk-list">
      <p v-if="!projects.length" class="lpk-empty">{{ t('liveShare.share.noProject', 'No project to share') }}</p>
      <p v-else-if="!groups.length" class="lpk-empty" data-test="ls-picker-empty">{{ noneText }}</p>
      <template v-for="g in groups" :key="g.key">
        <div class="lpk-group">{{ g.label }} <span class="lpk-count">{{ g.items.length }}</span></div>
        <label v-for="p in g.items" :key="p.id" class="lpk-row" :class="{ on: has(p), locked: isLocked(p) }" :title="isLocked(p) ? lockedTitle : p.name" :data-test="'ls-project-' + p.id + testKey">
          <input type="checkbox" :checked="has(p)" :disabled="isLocked(p) || isBusy(p)" @change="toggle(p, $event)" />
          <span class="lpk-name">{{ p.name }}</span>
          <template v-if="tags">
            <span v-if="p.noFiles" class="tag tag-warn" :title="t('liveShare.share.noFiles', 'It has no folder on this computer: guests see its terminals and agents, not its files.')" :data-test="'ls-nofiles-' + p.id">{{ t('liveShare.share.terminalsOnly', 'Terminals only') }}</span>
            <span v-else-if="p.ssh && sshBroad(p)" class="tag tag-warn" :title="t('liveShare.share.sshBroad', 'This SSH folder is too broad to share its files (the server’s root, a home or system folder): guests get its terminals and agents only. Choose a project folder inside it to share files.')" :data-test="'ls-ssh-broad-' + p.id">{{ t('liveShare.share.sshBroadTag', 'SSH, no files') }}</span>
            <span v-else-if="p.ssh" class="tag tag-warn" :title="t('liveShare.share.sshFiles', 'Guests can read this project’s files on the server (through your connection to it, while it is connected) and save them with the edit right. Secret and git-ignored files stay hidden unless you turn that off. Changes are not shared.')" :data-test="'ls-ssh-' + p.id">{{ t('liveShare.share.sshTag', 'SSH') }}</span>
          </template>
        </label>
      </template>
    </div>
    <div class="lpk-foot">
      <span class="lpk-foot-count">{{ selected.length }} / {{ projects.length }}</span>
      <button type="button" class="confirm-btn ls-small primary" data-test="ls-picker-done" @click="emit('close')">{{ t('liveShare.done', 'Done') }}</button>
    </div>
  </div>
</template>

<style scoped>
.lpk {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border-strong);
  border-radius: 9px;
  background: var(--surface-2);
  overflow: hidden;
}
.lpk-search {
  position: relative;
  padding: 8px;
  border-bottom: 1px solid var(--border);
}
.lpk-search-icon {
  position: absolute;
  top: 50%;
  left: 18px;
  color: var(--text-dim);
  transform: translateY(-50%);
  pointer-events: none;
}
.lpk-input {
  padding-left: 30px;
  background: var(--surface);
}
.lpk-list {
  max-height: 236px;
  overflow-y: auto;
  padding: 4px 0;
}
.lpk-group {
  padding: 8px 12px 3px;
  color: var(--text-dim);
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.lpk-count {
  font-weight: 400;
  opacity: 0.8;
}
.lpk-row {
  display: flex;
  align-items: center;
  gap: 9px;
  min-height: 28px;
  padding: 0 12px;
  color: var(--text);
  font-size: 12.5px;
  cursor: pointer;
}
.lpk-row:hover {
  background: var(--surface-3);
}
.lpk-row.on {
  color: var(--text-strong);
}
.lpk-row.locked {
  cursor: default;
}
.lpk-row input {
  flex: none;
  margin: 0;
  accent-color: var(--accent);
}
.lpk-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.lpk-empty {
  margin: 0;
  padding: 14px 12px;
  color: var(--text-dim);
  font-size: 12px;
}
.lpk-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 7px 8px 7px 12px;
  border-top: 1px solid var(--border);
}
.lpk-foot-count {
  color: var(--text-dim);
  font-size: 11.5px;
}
</style>
