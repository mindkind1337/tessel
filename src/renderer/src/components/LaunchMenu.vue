<script setup>
// One place to open anything: pick a terminal or an agent, and where it goes.
// Used from the toolbar's "New" button and from a pane's own menu (then the
// new pane opens next to that pane). App owns what actually happens.
import { ref, computed, onMounted, nextTick } from 'vue'
import BrandIcon from './BrandIcon.vue'
import SessionOptionPicker from './SessionOptionPicker.vue'
import { describeSteps } from '../shellChain'
import { settings } from '../settings'
import { modelsFor } from '../agentModels'
import { sessionPillLabel } from '../sessionOptionLabels'
import { getAgentSessionOptionCatalog, resolveSessionOptionDefaults } from '../../../shared/agentSessionOptions'
import { t } from '../i18n'

const props = defineProps({
  shells: { type: Array, default: () => [] },
  agents: { type: Array, default: () => [] },
  defaultShell: { type: String, default: null },
  placement: { type: String, default: 'right' }, // 'left' | 'right' | 'down'
  // Title of the pane the new one will open next to (null = empty workspace).
  targetTitle: { type: String, default: null },
  // { available: bool, reason: string|null, checking: bool }
  worktree: { type: Object, default: () => ({ available: false, reason: null, checking: false }) },
  useWorktree: { type: Boolean, default: false },
  x: { type: Number, default: 0 },
  y: { type: Number, default: 0 }
})

const emit = defineEmits([
  'launch',
  'set-default',
  'placement',
  'close',
  'worktree',
  'tools',
  'install'
])

const installedAgents = computed(() => props.agents.filter((a) => a.available))
const missingAgents = computed(() => props.agents.filter((a) => !a.available && a.install))

const rootEl = ref(null)
const pos = ref({ left: props.x, top: props.y })

// Where the new pane goes, next to the pane in use. (A new workspace has its
// own button in the sidebar.) The icon shades the side it opens on.
const placements = computed(() => [
  {
    id: 'left',
    label: t('pane.launch.left', 'Left'),
    title: t('pane.launch.splitLeft', 'Split to the left'),
    shade: { x: 2.1, y: 3.1, w: 5.9, h: 9.8 },
    line: 'M8 2.5v11'
  },
  {
    id: 'right',
    label: t('pane.launch.right', 'Right'),
    title: t('pane.launch.splitRight', 'Split to the right'),
    shade: { x: 8, y: 3.1, w: 5.9, h: 9.8 },
    line: 'M8 2.5v11'
  },
  {
    id: 'down',
    label: t('pane.launch.below', 'Below'),
    title: t('pane.launch.splitBelow', 'Split below'),
    shade: { x: 2.1, y: 8, w: 11.8, h: 4.9 },
    line: 'M1.5 8h13'
  }
])

const whereText = computed(() => {
  if (!props.targetTitle) return t('pane.launch.opensHere', 'Opens in this workspace')
  const name = props.targetTitle
  if (props.placement === 'left') return t('pane.launch.opensLeftOf', 'Opens to the left of {{name}}', { name })
  if (props.placement === 'down') return t('pane.launch.opensBelow', 'Opens below {{name}}', { name })
  return t('pane.launch.opensRightOf', 'Opens to the right of {{name}}', { name })
})

function launch(kind, item) {
  if (kind === 'agent' && !item.available) return
  const chosen = kind === 'agent' ? picked.value[item.id] : undefined
  emit('launch', chosen ? { kind, id: item.id, sessionOptions: chosen } : { kind, id: item.id })
}

// The model a new agent starts with (Orca's per-session picker before a
// session starts): chosen here for this pane only; untouched, the agent's
// default from Settings > Agents (or its own) applies.
const picked = ref({}) // agent id -> { model, effort? } chosen here
const pickerFor = ref(null) // the agent whose picker is open
function hasModels(agent) {
  return !!getAgentSessionOptionCatalog(agent.id)
}
function valuesFor(agent) {
  return picked.value[agent.id] || resolveSessionOptionDefaults(settings.agentSessionOptions, agent.id) || null
}
function pillText(agent) {
  return sessionPillLabel(modelsFor(agent.id), valuesFor(agent))
}
function defaultLabelFor(agent) {
  const d = resolveSessionOptionDefaults(settings.agentSessionOptions, agent.id)
  return d
    ? t('pane.sessionOptions.settingsDefault', 'Default from Settings ({{model}})', { model: sessionPillLabel(modelsFor(agent.id), d) })
    : t('pane.sessionOptions.agentDefault', "Agent's own default")
}
function onPick(agent, { optionId, value }) {
  const current = picked.value[agent.id] || null
  let next
  if (optionId === 'model') next = value ? { model: value } : null
  else if (current) {
    next = { ...current }
    if (value === null || value === undefined) delete next[optionId]
    else next[optionId] = value
  } else next = null
  const all = { ...picked.value }
  if (next) all[agent.id] = next
  else delete all[agent.id]
  picked.value = all
}

// Arrow keys move between items; Enter activates; Esc closes.
function onKeydown(e) {
  if (e.key === 'Escape') {
    e.preventDefault()
    emit('close')
    return
  }
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
  e.preventDefault()
  const items = [...rootEl.value.querySelectorAll('.launch-item:not(:disabled)')]
  if (!items.length) return
  const i = items.indexOf(document.activeElement)
  const next =
    e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length
  items[next].focus()
}

onMounted(async () => {
  await nextTick()
  const el = rootEl.value
  if (!el) return
  // Keep the menu on screen.
  const r = el.getBoundingClientRect()
  pos.value = {
    left: Math.max(6, Math.min(props.x, window.innerWidth - r.width - 6)),
    top: Math.max(6, Math.min(props.y, window.innerHeight - r.height - 6))
  }
  const first = el.querySelector('.launch-item.is-default') || el.querySelector('.launch-item')
  if (first) first.focus()
})
</script>

<template>
  <div
    ref="rootEl"
    class="launch-menu"
    role="menu"
    :style="{ left: pos.left + 'px', top: pos.top + 'px' }"
    @keydown="onKeydown"
    @pointerdown.stop
  >
    <div class="launch-where">
      <div class="launch-seg" role="radiogroup" :aria-label="t('pane.launch.whereToOpen', 'Where to open')">
        <button
          v-for="p in placements"
          :key="p.id"
          class="launch-seg-btn"
          :class="{ on: placement === p.id }"
          role="radio"
          :aria-checked="placement === p.id"
          :title="p.title"
          @click="emit('placement', p.id)"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <rect :x="p.shade.x" :y="p.shade.y" :width="p.shade.w" :height="p.shade.h" rx="1" fill="currentColor" opacity="0.35" />
            <rect x="1.5" y="2.5" width="13" height="11" rx="2" stroke="currentColor" stroke-width="1.3" />
            <path :d="p.line" stroke="currentColor" stroke-width="1.3" />
          </svg>
          <span>{{ p.label }}</span>
        </button>
      </div>
      <div class="launch-where-text">{{ whereText }}</div>
    </div>

    <div class="launch-section">{{ t('pane.launch.terminals', 'Terminals') }}</div>
    <div v-for="shell in shells" :key="shell.id" class="launch-row">
      <button
        class="launch-item"
        :class="{ 'is-default': shell.id === defaultShell }"
        role="menuitem"
        @click="launch('shell', shell)"
      >
        <BrandIcon :kind="shell.id" :size="16" />
        <span class="launch-name">{{ shell.name }}</span>
        <span v-if="shell.id === defaultShell" class="launch-tag">{{ t('pane.launch.default', 'Default') }}</span>
      </button>
      <button
        v-if="shell.id !== defaultShell"
        class="launch-set-default"
        :title="t('pane.launch.setDefaultHint', 'Use this shell by default, including for agents')"
        @click="emit('set-default', shell.id)"
      >
        {{ t('pane.launch.setDefault', 'Set default') }}
      </button>
    </div>

    <div class="launch-section">{{ t('pane.launch.agents', 'AI agents') }}</div>
    <label
      class="launch-worktree"
      :class="{ disabled: !worktree.available }"
      :title="
        worktree.available
          ? t('pane.launch.worktreeHint', 'The agent gets its own folder and git branch, so it cannot overwrite another agent\'s work. Merge the branch when it is done.')
          : worktree.reason || ''
      "
    >
      <input
        type="checkbox"
        class="set-switch"
        :checked="useWorktree && worktree.available"
        :disabled="!worktree.available"
        @change="emit('worktree', $event.target.checked)"
      />
      <span class="launch-worktree-text">
        {{ t('pane.launch.worktree', 'Separate copy on its own branch') }}
        <span class="set-hint">{{
          worktree.checking
            ? t('pane.launch.checking', 'Checking the project…')
            : worktree.available
              ? t('pane.launch.worktreeBest', 'Best when two agents work on the same project')
              : worktree.reason
        }}</span>
      </span>
    </label>
    <template v-for="agent in installedAgents" :key="agent.id">
      <div class="launch-row">
        <button
          class="launch-item"
          role="menuitem"
          :title="t('pane.launch.start', 'Start {{name}}', { name: agent.name })"
          @click="launch('agent', agent)"
        >
          <BrandIcon :kind="agent.id" :accent="agent.accent" :label="agent.name" :size="16" />
          <span class="launch-name">{{ agent.name }}</span>
        </button>
        <button
          v-if="hasModels(agent)"
          class="launch-model-pill"
          type="button"
          data-test="launch-model-pill"
          :data-agent="agent.id"
          :class="{ chosen: !!picked[agent.id] }"
          :aria-expanded="pickerFor === agent.id"
          :aria-label="t('pane.sessionOptions.pillAccessibleName', '{{category}} {{value}}', { category: t('pane.sessionOptions.model', 'Model'), value: pillText(agent) })"
          :title="t('pane.launch.modelHint', 'The model {{name}} starts with', { name: agent.name })"
          @click.stop="pickerFor = pickerFor === agent.id ? null : agent.id"
        >
          {{ pillText(agent) }} ▾
        </button>
      </div>
      <div v-if="pickerFor === agent.id" class="launch-model-picker" data-test="launch-model-picker">
        <SessionOptionPicker
          :agent-id="agent.id"
          :models="modelsFor(agent.id)"
          :values="picked[agent.id] || null"
          :default-label="defaultLabelFor(agent)"
          @set="(e) => onPick(agent, e)"
        />
      </div>
    </template>
    <!-- Claude as a chat (src/main/chat): no terminal, team messages as turns. -->
    <div v-if="installedAgents.some((a) => a.id === 'claude' && a.available !== false)" class="launch-row">
      <button
        class="launch-item"
        role="menuitem"
        data-test="launch-chat"
        :title="t('pane.launch.chatHint', 'Claude in a chat pane: no terminal; team messages reach it as turns of their own')"
        @click="emit('launch', { kind: 'chat', id: 'claude' })"
      >
        <BrandIcon kind="claude" :label="t('pane.launch.chat', 'Claude Code (chat)')" :size="16" />
        <span class="launch-name">{{ t('pane.launch.chat', 'Claude Code (chat)') }}</span>
      </button>
    </div>
    <p v-if="!installedAgents.length" class="launch-empty">{{ t('pane.launch.noAgents', 'No AI agents installed yet.') }}</p>
    <div v-if="missingAgents.length" class="launch-install">
      <span class="launch-install-label">{{ t('pane.launch.install', 'Install:') }}</span>
      <button
        v-for="agent in missingAgents"
        :key="agent.id"
        class="launch-chip"
        :title="t('pane.launch.installHint', 'Install {{name}} ({{steps}}), then start it', { name: agent.name, steps: describeSteps(agent.install) })"
        @click="emit('install', agent)"
      >
        <BrandIcon :kind="agent.id" :accent="agent.accent" :label="agent.name" :size="13" />
        {{ agent.name }}
      </button>
    </div>
    <div class="launch-row">
      <button class="launch-item subtle" role="menuitem" @click="emit('tools')">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M2.5 5.2L8 2.3l5.5 2.9v5.6L8 13.7l-5.5-2.9V5.2z"
            stroke="currentColor"
            stroke-width="1.3"
            stroke-linejoin="round"
          />
          <path
            d="M2.5 5.2L8 8.1l5.5-2.9M8 8.1v5.6"
            stroke="currentColor"
            stroke-width="1.3"
            stroke-linejoin="round"
          />
        </svg>
        <span class="launch-name">{{ t('pane.launch.tools', 'Add your own agent or install tools…') }}</span>
      </button>
    </div>

    <div class="launch-foot">
      <kbd>↑</kbd><kbd>↓</kbd> {{ t('pane.launch.keysMove', 'to move,') }} <kbd>Enter</kbd> {{ t('pane.launch.keysOpen', 'to open,') }}
      <kbd>Esc</kbd> {{ t('pane.launch.keysClose', 'to close') }}
    </div>
  </div>
</template>
