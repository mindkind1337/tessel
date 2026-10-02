<script setup>
// One place to open anything: pick a terminal or an agent, and where it goes.
// Used from the toolbar's "New" button and from a pane's own menu (then the
// new pane opens next to that pane). App owns what actually happens.
import { ref, computed, onMounted, nextTick } from 'vue'
import BrandIcon from './BrandIcon.vue'
import { describeSteps } from '../shellChain'

const props = defineProps({
  shells: { type: Array, default: () => [] },
  agents: { type: Array, default: () => [] },
  defaultShell: { type: String, default: null },
  placement: { type: String, default: 'right' }, // 'right' | 'down' | 'workspace'
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

const PLACEMENTS = [
  { id: 'right', label: 'Right', title: 'Split to the right' },
  { id: 'down', label: 'Below', title: 'Split below' },
  { id: 'workspace', label: 'New workspace', title: 'Open in a new workspace' }
]

const whereText = computed(() => {
  if (props.placement === 'workspace') return 'Opens in a new workspace'
  if (!props.targetTitle) return 'Opens in this workspace'
  return `Opens ${props.placement === 'down' ? 'below' : 'to the right of'} ${props.targetTitle}`
})

function launch(kind, item) {
  if (kind === 'agent' && !item.available) return
  emit('launch', { kind, id: item.id })
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
      <div class="launch-seg" role="radiogroup" aria-label="Where to open">
        <button
          v-for="p in PLACEMENTS"
          :key="p.id"
          class="launch-seg-btn"
          :class="{ on: placement === p.id }"
          role="radio"
          :aria-checked="placement === p.id"
          :title="p.title"
          @click="emit('placement', p.id)"
        >
          <svg
            v-if="p.id === 'right'"
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden="true"
          >
            <rect
              x="1.5"
              y="2.5"
              width="13"
              height="11"
              rx="2"
              stroke="currentColor"
              stroke-width="1.3"
            />
            <path d="M8 2.5v11" stroke="currentColor" stroke-width="1.3" />
          </svg>
          <svg
            v-else-if="p.id === 'down'"
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden="true"
          >
            <rect
              x="1.5"
              y="2.5"
              width="13"
              height="11"
              rx="2"
              stroke="currentColor"
              stroke-width="1.3"
            />
            <path d="M1.5 8h13" stroke="currentColor" stroke-width="1.3" />
          </svg>
          <svg v-else width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <rect
              x="1.5"
              y="3.5"
              width="10"
              height="10"
              rx="2"
              stroke="currentColor"
              stroke-width="1.3"
            />
            <path
              d="M5 1.5h7.5a2 2 0 012 2V11"
              stroke="currentColor"
              stroke-width="1.3"
              stroke-linecap="round"
            />
          </svg>
          <span>{{ p.label }}</span>
        </button>
      </div>
      <div class="launch-where-text">{{ whereText }}</div>
    </div>

    <div class="launch-section">Terminals</div>
    <div v-for="shell in shells" :key="shell.id" class="launch-row">
      <button
        class="launch-item"
        :class="{ 'is-default': shell.id === defaultShell }"
        role="menuitem"
        @click="launch('shell', shell)"
      >
        <BrandIcon :kind="shell.id" :size="16" />
        <span class="launch-name">{{ shell.name }}</span>
        <span v-if="shell.id === defaultShell" class="launch-tag">Default</span>
      </button>
      <button
        v-if="shell.id !== defaultShell"
        class="launch-set-default"
        title="Use this shell by default, including for agents"
        @click="emit('set-default', shell.id)"
      >
        Set default
      </button>
    </div>

    <div class="launch-section">AI agents</div>
    <label
      class="launch-worktree"
      :class="{ disabled: !worktree.available }"
      :title="
        worktree.available
          ? 'The agent gets its own folder and git branch, so it cannot overwrite another agent\'s work. Merge the branch when it is done.'
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
        Separate copy on its own branch
        <span class="set-hint">{{
          worktree.checking
            ? 'Checking the project…'
            : worktree.available
              ? 'Best when two agents work on the same project'
              : worktree.reason
        }}</span>
      </span>
    </label>
    <div v-for="agent in installedAgents" :key="agent.id" class="launch-row">
      <button
        class="launch-item"
        role="menuitem"
        :title="`Start ${agent.name}`"
        @click="launch('agent', agent)"
      >
        <BrandIcon :kind="agent.id" :accent="agent.accent" :label="agent.name" :size="16" />
        <span class="launch-name">{{ agent.name }}</span>
      </button>
    </div>
    <p v-if="!installedAgents.length" class="launch-empty">No AI agents installed yet.</p>
    <div v-if="missingAgents.length" class="launch-install">
      <span class="launch-install-label">Install:</span>
      <button
        v-for="agent in missingAgents"
        :key="agent.id"
        class="launch-chip"
        :title="`Install ${agent.name} (${describeSteps(agent.install)}), then start it`"
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
        <span class="launch-name">Add your own agent or install tools…</span>
      </button>
    </div>

    <div class="launch-foot">
      <kbd>↑</kbd><kbd>↓</kbd> to move, <kbd>Enter</kbd> to open, <kbd>Esc</kbd> to close
    </div>
  </div>
</template>
