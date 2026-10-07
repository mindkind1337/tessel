<script setup>
// The empty project's launcher (projectLauncher.js): shown in the grid of a
// project with no pane instead of a shell nobody asked for. It offers the
// agents (on an SSH host: those found there), a terminal (and its shell), a
// browser page and the project's recent conversations to resume. Keys:
// 1-9 or the arrows and Enter pick; Esc leaves it as it is. Nothing here
// connects to an SSH host: a host's conversations are listed only while it
// is connected (sessions:listRemote never signs in).
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Globe, History, SquareTerminal } from 'lucide-vue-next'
import BrandIcon from './BrandIcon.vue'
import ThemedSelect from './ui/ThemedSelect.vue'
import { recentProjectSessions } from '../projectLauncher'
import { agentLabel, timeAgo } from '../sessionHistory'
import { t } from '../i18n'

const props = defineProps({
  name: { type: String, default: '' },
  // The project's folder on this computer (null on an SSH host).
  cwd: { type: String, default: null },
  // An SSH project: { hostId, host, path }.
  remote: { type: Object, default: null },
  // [{ id, name, accent, unchecked, missing }] (launcherAgents).
  agents: { type: Array, default: () => [] },
  // The shells a terminal can open in, the default first (launcherShells).
  shells: { type: Array, default: () => [] },
  // The SSH host is connected (its conversations can be listed).
  hostConnected: { type: Boolean, default: false },
  // Shown now (a hidden project's launcher does not take the keys).
  active: { type: Boolean, default: true }
})
const emit = defineEmits(['pick', 'more-sessions'])

const root = ref(null)
const remember = ref(false)
const shellId = ref(props.shells[0] ? props.shells[0].id : null)
watch(
  () => props.shells.map((s) => s.id).join('|'),
  () => {
    if (!props.shells.some((s) => s.id === shellId.value)) shellId.value = props.shells[0] ? props.shells[0].id : null
  }
)

// --- Recent conversations --------------------------------------------------------
const sessions = ref([])
const sessionNote = ref('')
const now = ref(Date.now())
let loadSeq = 0
const dir = computed(() => (props.remote ? props.remote.path || null : props.cwd))
async function loadSessions() {
  const api = typeof window !== 'undefined' && window.shellApi
  const seq = ++loadSeq
  sessionNote.value = ''
  if (!api || !dir.value) {
    sessions.value = []
    return
  }
  try {
    let rows = []
    if (props.remote && props.remote.hostId) {
      if (!props.hostConnected || !api.listRemoteSessions) {
        sessions.value = []
        sessionNote.value = t('launcher.sessions.hostNotConnected', 'Connect to {{host}} to see its recent conversations.', { host: props.remote.host || props.remote.hostId })
        return
      }
      const res = await api.listRemoteSessions({ hostId: props.remote.hostId, limit: 50 })
      rows = res && res.ok && Array.isArray(res.sessions) ? res.sessions : []
    } else if (api.listSessions) {
      const res = await api.listSessions({ cwd: null, limit: 50 })
      rows = Array.isArray(res) ? res : []
    }
    if (seq !== loadSeq) return
    sessions.value = recentProjectSessions(rows, dir.value, 5)
    now.value = Date.now()
  } catch {
    if (seq === loadSeq) sessions.value = []
  }
}
watch(() => [dir.value, props.hostConnected, props.remote && props.remote.hostId], loadSessions)
watch(
  () => props.active,
  (on) => {
    if (on) {
      loadSessions()
      focusSoon()
    }
  }
)

// --- The choices, in key order ------------------------------------------------------
const items = computed(() => {
  const out = props.agents.map((a) => ({ key: `agent:${a.id}`, kind: 'agent', agent: a })) // i18n-ignore
  out.push({ key: 'terminal', kind: 'terminal' })
  out.push({ key: 'browser', kind: 'browser' })
  for (const s of sessions.value) out.push({ key: `session:${s.agent}:${s.id}`, kind: 'session', session: s }) // i18n-ignore
  return out
})
const sessionItems = computed(() => items.value.filter((i) => i.kind === 'session'))
const selected = ref(0)
watch(
  () => items.value.length,
  (n) => {
    if (selected.value >= n) selected.value = Math.max(0, n - 1)
  }
)
const indexOf = (item) => items.value.indexOf(item)
const numberOf = (item) => {
  const i = indexOf(item)
  return i >= 0 && i < 9 ? String(i + 1) : ''
}

// A missing agent reads as its install (the name has mustaches: built here).
const agentLabelOf = (a) => (a.missing ? t('launcher.installAgent', 'Install {{name}}…', { name: a.name }) : a.name)

function pick(item) {
  if (!item) return
  // Missing on the host: its install (asked first), never started as if ready.
  if (item.kind === 'agent' && item.agent.missing) emit('pick', { kind: 'install', id: item.agent.id }, { remember: false })
  else if (item.kind === 'agent') emit('pick', { kind: 'agent', id: item.agent.id }, { remember: remember.value })
  else if (item.kind === 'terminal') emit('pick', { kind: 'terminal', shellId: props.remote ? null : shellId.value }, { remember: remember.value })
  else if (item.kind === 'browser') emit('pick', { kind: 'browser' }, { remember: false })
  else if (item.kind === 'session') emit('pick', { kind: 'session', session: item.session }, { remember: false })
}

function onKey(e) {
  if (e.ctrlKey || e.altKey || e.metaKey) return
  // Typing in the shell list or the checkbox: theirs.
  if (e.target && e.target.closest && e.target.closest('[role="listbox"], [aria-haspopup="listbox"]')) return
  const n = items.value.length
  if (/^[1-9]$/.test(e.key)) {
    const item = items.value[Number(e.key) - 1]
    if (item) {
      e.preventDefault()
      pick(item)
    }
    return
  }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    if (!n) return
    selected.value = (selected.value + (e.key === 'ArrowDown' ? 1 : n - 1)) % n
    nextTick(() => {
      const el = root.value && root.value.querySelector(`[data-index="${selected.value}"]`) // i18n-ignore
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' })
    })
    return
  }
  if (e.key === 'Enter') {
    if (e.target && e.target.tagName === 'INPUT') return
    e.preventDefault()
    pick(items.value[selected.value])
    return
  }
  if (e.key === 'Escape') {
    // The project stays empty: the launcher stays, nothing starts.
    e.preventDefault()
    if (root.value && root.value.blur) root.value.blur()
  }
}

function focusSoon() {
  nextTick(() => {
    if (props.active && root.value && root.value.focus) root.value.focus({ preventScroll: true })
  })
}
onMounted(() => {
  loadSessions()
  focusSoon()
})
onBeforeUnmount(() => {
  loadSeq++
})

const title = computed(() => t('launcher.title', 'What do you want to start in {{name}}?', { name: props.name }))
const where = computed(() =>
  props.remote
    ? t('launcher.whereRemote', '{{path}} on {{host}}', { path: props.remote.path || '~', host: props.remote.host || props.remote.hostId })
    : props.cwd || t('launcher.noFolder', 'No project folder')
)
const terminalHint = computed(() =>
  props.remote ? t('launcher.terminal.remoteHint', 'The login shell on {{host}}', { host: props.remote.host || props.remote.hostId }) : t('launcher.terminal.hint', 'A shell in the project folder')
)
</script>

<template>
  <div ref="root" class="project-launcher" tabindex="0" data-test="project-launcher" @keydown="onKey">
    <div class="pl-card">
      <header class="pl-head">
        <h2 class="pl-title">{{ title }}</h2>
        <p class="pl-where" :title="where">{{ where }}</p>
      </header>

      <section v-if="agents.length" class="pl-section">
        <h3 class="pl-section-title">{{ remote ? t('launcher.agentsOnHost', 'Agents on the host') : t('launcher.agents', 'Agents') }}</h3>
        <button
          v-for="item in items.filter((i) => i.kind === 'agent')"
          :key="item.key"
          type="button"
          class="pl-row"
          :class="{ selected: indexOf(item) === selected }"
          :data-index="indexOf(item)"
          :data-test="`launcher-agent-${item.agent.id}`"
          @mouseenter="selected = indexOf(item)"
          @click="pick(item)"
        >
          <span class="pl-num">{{ numberOf(item) }}</span>
          <BrandIcon :kind="item.agent.id" :accent="item.agent.accent" :label="item.agent.name" :size="16" />
          <span class="pl-label">{{ agentLabelOf(item.agent) }}</span>
          <span v-if="item.agent.missing" class="pl-hint" :data-test="`launcher-missing-${item.agent.id}`">{{ t('launcher.agentMissing', 'Not installed on the host') }}</span>
          <span v-else-if="item.agent.unchecked" class="pl-hint">{{ t('launcher.agentUnchecked', 'Not checked on the host yet') }}</span>
        </button>
      </section>
      <p v-else class="pl-empty">
        {{ remote ? t('launcher.noAgentsOnHost', 'No agent was found on this host.') : t('launcher.noAgents', 'No agent is installed. Settings > Agents shows how to install one.') }}
      </p>

      <section class="pl-section">
        <h3 class="pl-section-title">{{ t('launcher.other', 'Other') }}</h3>
        <div
          v-for="item in items.filter((i) => i.kind === 'terminal')"
          :key="item.key"
          class="pl-row pl-row-terminal"
          :class="{ selected: indexOf(item) === selected }"
          :data-index="indexOf(item)"
          @mouseenter="selected = indexOf(item)"
        >
          <button type="button" class="pl-row-main" data-test="launcher-terminal" @click="pick(item)">
            <span class="pl-num">{{ numberOf(item) }}</span>
            <SquareTerminal :size="16" class="pl-icon" />
            <span class="pl-label">{{ t('launcher.terminalLabel', 'Terminal') }}</span>
            <span class="pl-hint">{{ terminalHint }}</span>
          </button>
          <ThemedSelect
            v-if="shells.length > 1"
            v-model="shellId"
            class="pl-shell"
            data-test="launcher-shell"
            :aria-label="t('launcher.shell', 'Shell')"
          >
            <option v-for="s in shells" :key="s.id" :value="s.id">{{ s.name }}</option>
          </ThemedSelect>
        </div>
        <button
          v-for="item in items.filter((i) => i.kind === 'browser')"
          :key="item.key"
          type="button"
          class="pl-row"
          :class="{ selected: indexOf(item) === selected }"
          :data-index="indexOf(item)"
          data-test="launcher-browser"
          @mouseenter="selected = indexOf(item)"
          @click="pick(item)"
        >
          <span class="pl-num">{{ numberOf(item) }}</span>
          <Globe :size="16" class="pl-icon" />
          <span class="pl-label">{{ t('launcher.browser', 'Browser page') }}</span>
        </button>
      </section>

      <section v-if="sessionItems.length || sessionNote || dir" class="pl-section">
        <h3 class="pl-section-title">{{ t('launcher.sessionsTitle', 'Resume a recent session') }}</h3>
        <button
          v-for="item in sessionItems"
          :key="item.key"
          type="button"
          class="pl-row"
          :class="{ selected: indexOf(item) === selected }"
          :data-index="indexOf(item)"
          data-test="launcher-session"
          @mouseenter="selected = indexOf(item)"
          @click="pick(item)"
        >
          <span class="pl-num">{{ numberOf(item) }}</span>
          <BrandIcon :kind="item.session.agent" :label="agentLabel(item.session.agent)" :size="16" />
          <span class="pl-label pl-session-title" :title="item.session.title || item.session.id">{{ item.session.title || item.session.id }}</span>
          <span class="pl-hint">{{ agentLabel(item.session.agent) }} · {{ timeAgo(item.session.updated, now) }}</span>
        </button>
        <p v-if="sessionNote" class="pl-empty">{{ sessionNote }}</p>
        <p v-else-if="!sessionItems.length" class="pl-empty">{{ t('launcher.sessions.none', 'No conversation in this project yet.') }}</p>
        <button type="button" class="pl-more" data-test="launcher-more-sessions" @click="emit('more-sessions')">
          <History :size="13" />
          {{ t('launcher.sessions.more', 'More…') }}
        </button>
      </section>

      <footer class="pl-foot">
        <label class="pl-remember">
          <input v-model="remember" type="checkbox" data-test="launcher-remember" />
          {{ t('launcher.remember', 'Remember for new projects') }}
        </label>
        <span class="pl-keys">{{ t('launcher.keys', '1-9 or ↑↓ and Enter to start · Esc to stay empty') }}</span>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.project-launcher {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  overflow: auto;
  padding: 48px 24px 24px;
  outline: none;
  background: var(--backdrop);
  color: var(--text);
}
.pl-card {
  width: min(520px, 100%);
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.pl-title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--text-strong);
}
.pl-where {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--text-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pl-section {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.pl-section-title {
  margin: 0 0 4px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-dim);
}
.pl-row,
.pl-row-main {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  padding: 6px 8px;
  border: 1px solid transparent;
  border-radius: var(--radius);
  background: none;
  color: inherit;
  font: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}
.pl-row-terminal {
  padding: 0 8px 0 0;
  cursor: default;
}
.pl-row-main {
  flex: 1 1 auto;
  border: 0;
}
.pl-row.selected {
  background: var(--surface);
  border-color: var(--border);
}
.pl-num {
  flex: 0 0 auto;
  width: 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border);
  border-radius: 4px;
  font-size: 11px;
  color: var(--text-dim);
}
.pl-icon {
  flex: 0 0 auto;
  color: var(--text-dim);
}
.pl-label {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pl-session-title {
  flex: 1 1 auto;
}
.pl-hint {
  margin-left: auto;
  flex: 0 0 auto;
  font-size: 11.5px;
  color: var(--text-dim);
}
.pl-shell {
  flex: 0 0 auto;
  min-width: 130px;
}
.pl-empty {
  margin: 2px 8px;
  font-size: 12px;
  color: var(--text-dim);
}
.pl-more {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin: 2px 8px 0;
  padding: 2px 0;
  border: 0;
  background: none;
  color: var(--accent);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.pl-foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding-top: 10px;
  border-top: 1px solid var(--border);
  font-size: 12px;
  color: var(--text-dim);
}
.pl-remember {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  color: var(--text);
}
</style>
