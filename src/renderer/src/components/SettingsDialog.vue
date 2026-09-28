<script setup>
// Settings, as a full page over the app's main area (like Orca's): a sidebar
// with "Back to app", a search box and the pages, then one page at a time.
// Edits the shared `settings` store directly, so every change applies live to
// all panes and is saved automatically.
import { ref, computed, watch, nextTick, onMounted, onUnmounted, onUpdated } from 'vue'
import BrandIcon from './BrandIcon.vue'
import ProviderAccounts from './ProviderAccounts.vue'
import StatsUsage from './StatsUsage.vue'
import { BarChart3 } from 'lucide-vue-next'
import { settings, FONT_FAMILIES, resetSettings, clamp, MAX_LEFT_SIDEBAR_TINT_OPACITY } from '../settings'
import { THEMES } from '../themes'
import { playAlertSound } from '../notificationsStore'
import { parseEnvText, YOLO_ARGS, YOLO_ENV, agentEnabled } from '../../../shared/agentPrefs'
import { AGENT_DOCS } from '../../../shared/agentDocs'
import { CACHE_TTLS } from '../promptCache'
import { ORCHESTRATION_EXAMPLES, ORCHESTRATION_TOOLS } from '../orchestrationGuide'

const props = defineProps({
  shells: { type: Array, default: () => [] },
  // Built-in and your own agents, with `available` (found on the PATH).
  agents: { type: Array, default: () => [] },
  worktreePaths: { type: Array, default: () => [] },
  defaultShell: { type: String, default: null },
  updateStatus: { type: Object, default: () => ({ state: 'disabled' }) },
  // Open on this page, e.g. 'quick-commands', 'accounts', 'agents'.
  section: { type: String, default: null },
  // Agent CLI updates: { checkedAt, agents: { id: { installed, latest,
  // update, source, note } } }, the updates running (agentId -> job) and
  // the ones waiting their turn.
  agentUpdates: { type: Object, default: null },
  agentUpdateJobs: { type: Object, default: () => ({}) },
  agentUpdateQueue: { type: Array, default: () => [] }
})

// The pages, grouped as in the sidebar. `icon` is a 16x16 stroke path.
const PAGES = {
  stats: {
    title: 'Stats & Usage',
    desc: 'Tessel stats plus local agent token analytics.'
  },
  agents: {
    title: 'Agents',
    desc: 'Which agents Tessel offers, how they start and what they may do.',
    icon: 'M5 5h6a2 2 0 012 2v4a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2zM8 2v3M6 9h.01M10 9h.01'
  },
  accounts: {
    title: 'AI provider accounts',
    desc: 'Your sign-ins with each AI provider, for quick switching.',
    icon: 'M8 8a2.75 2.75 0 100-5.5A2.75 2.75 0 008 8zM2.75 13.5c.7-2.3 2.8-3.75 5.25-3.75s4.55 1.45 5.25 3.75'
  },
  orchestration: {
    title: 'Orchestration',
    desc: 'Agents working as a team, followed on the task board.',
    icon: 'M4 5.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3zM12 5.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3zM8 13.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3zM5 5l2.2 5M11 5l-2.2 5M5.5 4h5'
  },
  voice: {
    title: 'Voice typing',
    desc: 'Dictate into any pane with Windows voice typing.',
    icon: 'M8 2a2 2 0 00-2 2v4a2 2 0 004 0V4a2 2 0 00-2-2zM4 8a4 4 0 008 0M8 12v2'
  },
  general: {
    title: 'General',
    desc: 'How Tessel starts and closes.',
    icon: 'M3 4.5h10M3 8h10M3 11.5h10M6 3v3M10 6.5v3M5 10v3'
  },
  appearance: {
    title: 'Appearance',
    desc: 'The colors of the whole app, the sidebar and the status bar.',
    icon: 'M8 2a6 6 0 100 12A6 6 0 008 2zM8 2v12'
  },
  text: {
    title: 'Text',
    desc: 'The font, size and cursor of every terminal.',
    icon: 'M3 4.5V3h10v1.5M8 3v10M6 13h4'
  },
  terminal: {
    title: 'Terminal',
    desc: 'Shell, scrollback, drawing, copy and paste.',
    icon: 'M2.5 3.5h11v9h-11zM5 6.5l2 1.5-2 1.5M8.5 10H11'
  },
  editor: {
    title: 'Editor',
    desc: 'The code editor in Tessel panes: saving, wrapping, tabs and changes.',
    icon: 'M5 4L1.5 8 5 12M11 4l3.5 4-3.5 4M9.5 2.5l-3 11'
  },
  alerts: {
    title: 'Agent alerts',
    desc: 'How Tessel tells you an agent has finished.',
    icon: 'M4 11V7a4 4 0 018 0v4l1 1.5H3zM6.5 14a1.5 1.5 0 003 0'
  },
  'quick-commands': {
    title: 'Quick commands',
    desc: 'Text you send to the active pane from the command palette.',
    icon: 'M9 1.5L3.5 9H8l-1 5.5L12.5 7H8z'
  },
  updates: {
    title: 'Updates',
    desc: "Tessel's version and updates.",
    icon: 'M13 8a5 5 0 11-1.5-3.55M13 2.5V5h-2.5'
  }
}
const GROUPS = [
  { title: 'AI capabilities', pages: ['agents', 'accounts', 'orchestration', 'voice'] },
  { title: 'Configure', pages: ['general', 'appearance', 'text', 'terminal', 'editor', 'alerts'] },
  { title: 'Workflows', pages: ['quick-commands'] },
  { title: 'Interface', pages: ['stats'] },
  { title: 'About', pages: ['updates'] }
]
const PAGE_KEY = 'tessel.settingsPage'

function storedPage() {
  try {
    const p = localStorage.getItem(PAGE_KEY)
    return PAGES[p] ? p : null
  } catch {
    return null
  }
}
const page = ref((PAGES[props.section] && props.section) || storedPage() || 'general')
const query = ref('')
const searching = computed(() => !!query.value.trim())
const matched = ref([]) // the pages with a match for the search
const mainEl = ref(null)
const searchEl = ref(null)

function go(id) {
  if (!PAGES[id]) return
  page.value = id
  query.value = ''
  try {
    localStorage.setItem(PAGE_KEY, id)
  } catch {
    // no storage (private window): the page is just not remembered
  }
  if (mainEl.value) mainEl.value.scrollTop = 0
}
watch(
  () => props.section,
  (s) => s && go(s)
)
function shown(id) {
  return searching.value ? matched.value.includes(id) : page.value === id
}

// Search: shows the rows that match across all pages (every word, any case),
// under their page's title. Works on the rendered text, so it finds a
// setting by its label, hint or choices.
const ITEM = '.set-row, .agent-set, .orch-example, .orch-tools li, .account-provider'
function words() {
  return query.value.trim().toLowerCase().split(/\s+/).filter(Boolean)
}
function has(text, ws) {
  const t = (text || '').toLowerCase()
  return ws.every((w) => t.includes(w))
}
function hide(el) {
  el.hidden = true
  el.setAttribute('data-sh', '')
}
function filterBlock(el, ws) {
  if (!has(el.textContent, ws)) return false
  if (el.matches(ITEM) || !el.querySelector(ITEM)) return true
  const title = el.querySelector(':scope > .set-group-title')
  if (title && has(title.textContent, ws)) return true
  let any = false
  for (const child of el.children) {
    if (child.classList.contains('set-group-title')) continue
    if (filterBlock(child, ws)) any = true
    else hide(child)
  }
  return any
}
function applySearch() {
  const root = mainEl.value
  if (!root) return
  for (const el of root.querySelectorAll('[data-sh]')) {
    el.hidden = false
    el.removeAttribute('data-sh')
  }
  const ws = words()
  const hits = []
  if (ws.length) {
    for (const pg of root.querySelectorAll('.set-page')) {
      const head = pg.querySelector('.set-page-head h2')
      let any = has(head && head.textContent, ws)
      if (!any) {
        for (const group of pg.querySelectorAll(':scope > .set-group')) {
          if (filterBlock(group, ws)) any = true
          else hide(group)
        }
      }
      if (any) hits.push(pg.dataset.page)
    }
  }
  if (hits.join() !== matched.value.join()) matched.value = hits
}
watch(query, () => nextTick(applySearch))
onUpdated(applySearch)

function onKeydown(e) {
  if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
    e.preventDefault()
    e.stopPropagation()
    searchEl.value?.focus()
    searchEl.value?.select()
  }
}
function onEscape(e) {
  // Escape in the search box first empties it; otherwise it closes Settings.
  if (e.target === searchEl.value && query.value) query.value = ''
  else emit('close')
}

// Quick commands: text sent to the active pane from the command palette.
const quickDraft = ref({ name: '', text: '', enter: true, error: '' })
function addQuickCommand() {
  const d = quickDraft.value
  const name = d.name.trim()
  const text = d.text.replace(/\s+$/, '')
  if (!name || !text.trim()) {
    d.error = 'Give it a name and the text to send.'
    return
  }
  settings.quickCommands.push({ id: `qc-${Date.now().toString(36)}`, name, text, enter: !!d.enter })
  quickDraft.value = { name: '', text: '', enter: d.enter, error: '' }
}
function removeQuickCommand(id) {
  const i = settings.quickCommands.findIndex((q) => q.id === id)
  if (i >= 0) settings.quickCommands.splice(i, 1)
}
const emit = defineEmits([
  'close',
  'set-default-shell',
  'check-updates',
  'open-update',
  'detect-agents',
  'open-connections',
  'check-agent-updates',
  'update-agent',
  'update-all-agents',
  'cancel-agent-update'
])

// Settings > Agents: versions and updates of the installed agent CLIs.
const checkingAgentUpdates = ref(false)
async function checkAgentUpdates() {
  checkingAgentUpdates.value = true
  try {
    await new Promise((resolve) => emit('check-agent-updates', resolve))
  } finally {
    checkingAgentUpdates.value = false
  }
}
function updateRow(id) {
  return (props.agentUpdates && props.agentUpdates.agents && props.agentUpdates.agents[id]) || null
}
const updatableCount = computed(() =>
  props.agentUpdates && props.agentUpdates.agents ? Object.values(props.agentUpdates.agents).filter((r) => r.update).length : 0
)
const agentUpdatesSummary = computed(() => {
  const u = props.agentUpdates
  if (!u) return 'Not checked yet'
  const when = new Date(u.checkedAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })
  const n = updatableCount.value
  return `${n ? `${n} update${n === 1 ? '' : 's'} available` : 'All up to date'} · checked ${when}`
})
function versionText(a) {
  const r = updateRow(a.id)
  if (!r) return ''
  if (r.update) return `Update available: ${r.installed} → ${r.latest}`
  if (r.installed) return `Version ${r.installed}${r.latest ? ' (latest)' : ''}`
  return r.note || ''
}
// An update in progress, in words.
function jobText(id) {
  const j = props.agentUpdateJobs && props.agentUpdateJobs[id]
  if (!j) return props.agentUpdateQueue.includes(id) ? 'Waiting for the other updates' : ''
  const waiting = (j.waiting || []).map((w) => `${w.label} (${w.why})`).join(', ')
  switch (j.phase) {
    case 'updating':
      return 'Updating in a pane below…'
    case 'waiting-stop':
      return `Its files are in use: waiting to stop ${waiting || 'its panes'} safely, then updating and resuming them`
    case 'retrying':
      return 'Stopped its panes; updating again…'
    case 'restarting':
      return `Updated to ${j.version}. Waiting to restart: ${waiting || '…'}`
    case 'done':
      return `Updated to ${j.version || j.target}.${j.report ? ` ${j.report}` : ''}`
    case 'failed':
      return `Not updated${j.error ? `: ${j.error}` : ''}.`
    default:
      return ''
  }
}
function jobActive(id) {
  const j = props.agentUpdateJobs && props.agentUpdateJobs[id]
  return props.agentUpdateQueue.includes(id) || !!(j && !['done', 'failed'].includes(j.phase))
}

// Settings > Orchestration: which agents can work as a team (Tessel's team
// tools and hooks set up in them), and how to ask for it.
const coverage = ref(null) // [{ id, name, state: 'ready'|'missing'|'approval' }] | { error }
async function loadCoverage() {
  if (!window.shellApi.teamHooksStatus) return
  try {
    const res = await window.shellApi.teamHooksStatus()
    const rows = (res && Array.isArray(res.agents) ? res.agents : [])
      .filter((r) => props.agents.some((a) => a.id === r.id && a.available))
      .map((r) => ({
        id: r.id,
        name: (props.agents.find((a) => a.id === r.id) || {}).name || r.id,
        state:
          r.error || r.hooks !== 'installed'
            ? 'missing'
            : r.approval === 'needs-approval' || r.approval === 'changed'
              ? 'approval'
              : 'ready'
      }))
    coverage.value = rows
  } catch (err) {
    coverage.value = { error: (err && err.message) || 'unknown error' }
  }
}
const coverageSummary = computed(() => {
  const c = coverage.value
  if (!c) return 'Checking your agents…'
  if (c.error) return `Could not check: ${c.error}`
  if (!c.length) return 'No agent with team tools found. Install agents in Settings > Agents, then check again.'
  const ready = c.filter((r) => r.state === 'ready').length
  return ready === c.length ? `All ${c.length} agents can work as a team.` : `${ready} of ${c.length} agents can work as a team.`
})
const copiedExample = ref('')
function copyExample(ex) {
  if (navigator.clipboard) navigator.clipboard.writeText(ex.prompt).catch(() => {})
  copiedExample.value = ex.id
  setTimeout(() => {
    if (copiedExample.value === ex.id) copiedExample.value = ''
  }, 1500)
}

// Settings > Agents: each detected agent's own command, arguments and
// variables, whether it is offered, and the one a new pane starts.
const openAgent = ref(null) // the agent whose "Customize" is open
const envErrors = ref({})
function agentPref(id) {
  return settings.agentPrefs[id] || {}
}
function setAgentPref(id, field, value) {
  const next = { ...agentPref(id), [field]: value }
  if (field === 'env') {
    const r = parseEnvText(value)
    envErrors.value = { ...envErrors.value, [id]: r.error || '' }
  }
  settings.agentPrefs = { ...settings.agentPrefs, [id]: next }
}
function resetAgent(id) {
  const next = { ...settings.agentPrefs }
  const keepOff = next[id] && next[id].enabled === false
  delete next[id]
  if (keepOff) next[id] = { enabled: false }
  settings.agentPrefs = next
  envErrors.value = { ...envErrors.value, [id]: '' }
}
function customized(id) {
  const p = agentPref(id)
  return !!((p.command && p.command.trim()) || (p.args && p.args.trim()) || (p.env && p.env.trim()))
}
const detecting = ref(false)
async function detectAgents() {
  detecting.value = true
  try {
    await new Promise((resolve) => emit('detect-agents', resolve))
  } finally {
    detecting.value = false
  }
}
function openDocs(id) {
  if (AGENT_DOCS[id] && window.shellApi.openExternal) window.shellApi.openExternal(AGENT_DOCS[id])
}

function updateText(u) {
  switch (u.state) {
    case 'checking':
      return 'Checking for updates…'
    case 'none':
      return 'You have the latest version.'
    case 'downloading':
      return `Downloading ${u.version}${u.percent ? ` (${u.percent}%)` : ''}…`
    case 'ready':
      return `Version ${u.version} is ready to install.`
    case 'error':
      return 'Could not check for updates. Try again later.'
    case 'disabled':
      return 'Only the installed app updates itself.'
    default:
      return 'Checks automatically every few hours.'
  }
}

const cardEl = ref(null)
const languages = ref([])
let previousFocus
const inertSiblings = []

function focusCard() {
  cardEl.value?.focus({ preventScroll: true })
}

function containFocus(event) {
  if (cardEl.value && !cardEl.value.contains(event.target)) focusCard()
}

function trapTab(event) {
  const card = cardEl.value
  const controls = [
    ...card.querySelectorAll('button, input, select, textarea, a[href], [tabindex]')
  ].filter((el) => {
    const style = getComputedStyle(el)
    return (
      el.tabIndex >= 0 &&
      !el.matches(':disabled') &&
      !el.closest('[hidden], [inert]') &&
      style.display !== 'none' &&
      style.visibility !== 'hidden'
    )
  })
  const first = controls[0]
  const last = controls.at(-1)
  if (!first || document.activeElement === card) {
    event.preventDefault()
    ;(event.shiftKey ? last : first)?.focus()
  } else if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

onMounted(async () => {
  previousFocus = document.activeElement
  // Make every branch outside this page inert, including live xterm inputs.
  // Keep existing inert attributes intact when Settings closes.
  let branch = cardEl.value
  while (branch && branch !== document.body) {
    for (const sibling of branch.parentElement?.children || []) {
      if (sibling !== branch && !sibling.hasAttribute('inert')) {
        sibling.setAttribute('inert', '')
        inertSiblings.push(sibling)
      }
    }
    branch = branch.parentElement
  }
  document.addEventListener('focusin', containFocus)
  focusCard()
  loadCoverage()
  if (window.shellApi.inputLanguages) {
    try {
      languages.value = (await window.shellApi.inputLanguages()) || []
    } catch {
      languages.value = []
    }
  }
})

onUnmounted(() => {
  document.removeEventListener('focusin', containFocus)
  for (const sibling of inertSiblings) sibling.removeAttribute('inert')
  if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true })
})

function stepFont(d) {
  settings.fontSize = clamp(settings.fontSize + d, 8, 28)
}

function setSleepMinutes(e) {
  const n = parseInt(e.target.value, 10)
  if (Number.isFinite(n)) settings.agentSleepMinutes = clamp(n, 1, 1440)
  e.target.value = settings.agentSleepMinutes
}

function setScrollback(e) {
  const n = parseInt(e.target.value, 10)
  if (Number.isFinite(n)) settings.scrollback = clamp(n, 500, 100000)
  e.target.value = settings.scrollback
}

// Orca's "Keep computer awake" (agent-awake-copy.ts): On, Agent, Off.
const AWAKE_MODES = [
  { id: 'on', label: 'On', title: 'Keep this computer awake continuously' },
  { id: 'agents', label: 'Agent', title: 'Stay awake while an agent is working' },
  { id: 'off', label: 'Off', title: 'Allow normal system sleep behavior' }
]

// Settings > Appearance > Window & Sidebar (Orca's AppearanceWindowSidebarSection).
const SIDEBAR_APPEARANCES = [
  { id: 'default', label: 'Default' },
  { id: 'match-terminal', label: 'Match Terminal' },
  { id: 'tinted', label: 'Tinted' }
]
const STATUS_BAR_TOGGLES = [
  {
    id: 'ssh',
    title: 'Remote Hosts',
    description: 'Show configured SSH and remote Tessel hosts when any are available.'
  },
  {
    id: 'resource-usage',
    title: 'Resource Manager',
    description: 'Show the Resource Manager. Click it for CPU, memory and sessions.'
  },
  {
    id: 'ports',
    title: 'Ports',
    description: 'Show live workspace ports. Click it for workspace-scoped ports and external listeners.'
  }
]
function toggleStatusBarItem(id) {
  const list = settings.statusBarItems
  settings.statusBarItems = list.includes(id) ? list.filter((x) => x !== id) : [...list, id]
}
function setTintOpacity(e) {
  const n = parseFloat(e.target.value)
  if (Number.isFinite(n)) settings.leftSidebarTintOpacity = clamp(n, 0, MAX_LEFT_SIDEBAR_TINT_OPACITY)
  e.target.value = settings.leftSidebarTintOpacity
}

const CURSORS = [
  { id: 'block', label: 'Block' },
  { id: 'bar', label: 'Bar' },
  { id: 'underline', label: 'Underline' }
]
</script>

<template>
  <div
    ref="cardEl"
    class="settings-page"
    :class="{ searching }"
    role="dialog"
    aria-label="Settings"
    aria-modal="true"
    tabindex="-1"
    @keydown="onKeydown"
    @keydown.tab.stop="trapTab"
    @keydown.escape.prevent.stop="onEscape"
  >
    <nav class="set-side" aria-label="Settings pages">
      <button class="set-back" type="button" title="Back to app (Esc)" @click="emit('close')">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M13 8H3.5M7.5 3.5L3 8l4.5 4.5"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
        Back to app
      </button>
      <div class="set-search">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M7 12A5 5 0 107 2a5 5 0 000 10zM10.6 10.6L14 14"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
          />
        </svg>
        <input
          ref="searchEl"
          v-model="query"
          type="search"
          placeholder="Search settings"
          aria-label="Search settings"
          title="Search settings (Ctrl+F)"
          spellcheck="false"
        />
      </div>
      <div v-for="g in GROUPS" :key="g.title" class="set-nav-group">
        <h3 class="set-nav-head">{{ g.title }}</h3>
        <ul class="set-nav-list">
          <li v-for="id in g.pages" :key="id">
            <button
              class="set-nav-item"
              type="button"
              :data-page="id"
              :class="{ on: !searching && page === id, dim: searching && !matched.includes(id) }"
              :aria-current="!searching && page === id ? 'page' : undefined"
              @click="go(id)"
            >
              <BarChart3 v-if="id === 'stats'" :size="15" aria-hidden="true" />
              <svg v-else width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path
                  :d="PAGES[id].icon"
                  stroke="currentColor"
                  stroke-width="1.3"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
              {{ PAGES[id].title }}
            </button>
          </li>
        </ul>
      </div>
    </nav>

    <main ref="mainEl" class="set-main">
      <div class="set-content">
        <p v-if="searching && !matched.length" class="set-empty" role="status">
          No settings match “{{ query.trim() }}”.
        </p>

        <section id="set-stats" class="set-page" data-page="stats" :hidden="!shown('stats')" aria-labelledby="set-stats-title">
          <header class="set-page-head">
            <h2 id="set-stats-title">{{ PAGES.stats.title }}</h2>
            <p class="set-page-desc">{{ PAGES.stats.desc }}</p>
          </header>
          <div class="set-group">
            <StatsUsage v-if="page === 'stats' && !searching" :worktree-paths="worktreePaths" />
            <div v-else class="set-row">
              <div class="set-label">Usage Analytics
                <span class="set-hint">Overview, Claude, Codex, tokens, costs, cache efficiency, daily usage, models, projects and sessions.</span>
              </div>
              <button type="button" class="exit-btn" @click="go('stats')">Open Stats &amp; Usage</button>
            </div>
          </div>
        </section>

        <!-- ============ Agents ============ -->
        <section
          id="set-agents"
          class="set-page"
          data-page="agents"
          :hidden="!shown('agents')"
          aria-labelledby="set-agents-title"
        >
          <header class="set-page-head">
            <h2 id="set-agents-title">{{ PAGES.agents.title }}</h2>
            <p class="set-page-desc">{{ PAGES.agents.desc }}</p>
          </header>
          <div class="set-group">
            <h3 class="set-group-title">New agents</h3>
            <div class="set-card">
              <div class="set-row">
                <label class="set-label" for="settings-default-agent">
                  Default agent
                  <span class="set-hint">What a new pane starts (Ctrl+Shift+T)</span>
                </label>
                <select id="settings-default-agent" v-model="settings.defaultAgent" class="set-select">
                  <option value="">The default shell</option>
                  <option
                    v-for="a in agents.filter((x) => x.available && agentEnabled(settings.agentPrefs, x.id))"
                    :key="a.id"
                    :value="a.id"
                  >
                    {{ a.name }}
                  </option>
                </select>
              </div>
              <div class="set-row">
                <div id="settings-perm-label" class="set-label">
                  Permissions
                  <span class="set-hint">For agents you start from now on</span>
                </div>
                <div class="launch-seg set-seg" role="group" aria-labelledby="settings-perm-label">
                  <button
                    class="launch-seg-btn"
                    :class="{ on: settings.agentPermissions === 'manual' }"
                    :aria-pressed="settings.agentPermissions === 'manual'"
                    @click="settings.agentPermissions = 'manual'"
                  >
                    Manual
                  </button>
                  <button
                    class="launch-seg-btn"
                    :class="{ on: settings.agentPermissions === 'yolo' }"
                    :aria-pressed="settings.agentPermissions === 'yolo'"
                    @click="settings.agentPermissions = 'yolo'"
                  >
                    Yolo
                  </button>
                </div>
              </div>
              <p v-if="settings.agentPermissions === 'yolo'" class="mcp-error agents-warn">
                Yolo: agents run commands and change files without asking you first (each agent's own
                skip-approvals option, unless you set its arguments yourself). Use it only in projects you
                can restore.
              </p>
              <label class="set-row">
                <div class="set-label">
                  Resume conversations when panes reopen
                  <span class="set-hint"
                    >Claude Code and Codex continue where they left off after a restart, instead of
                    starting a new chat</span
                  >
                </div>
                <input v-model="settings.resumeAgents" type="checkbox" class="set-switch" />
              </label>
              <label class="set-row">
                <div class="set-label">
                  Show the conversation's title
                  <span class="set-hint"
                    >Beside the agent's name in Claude Code and Codex panes (the name stays)</span
                  >
                </div>
                <input v-model="settings.autoTitles" type="checkbox" class="set-switch" />
              </label>
            </div>
          </div>

          <div class="set-group">
            <h3 class="set-group-title">While agents work</h3>
            <div class="set-card">
              <div class="set-row">
                <div id="settings-awake-label" class="set-label">
                  Keep computer awake
                  <span class="set-hint"
                    >Choose On, Agent, or Off. Agent mode stays awake while agents are working; lid-close
                    behavior follows this device's power settings.</span
                  >
                </div>
                <div class="launch-seg set-seg" role="group" aria-labelledby="settings-awake-label">
                  <button
                    v-for="m in AWAKE_MODES"
                    :key="m.id"
                    class="launch-seg-btn"
                    :class="{ on: settings.keepAwake === m.id }"
                    :aria-pressed="settings.keepAwake === m.id"
                    :title="m.title"
                    @click="settings.keepAwake = m.id"
                  >
                    {{ m.label }}
                  </button>
                </div>
              </div>
              <label class="set-row">
                <div class="set-label">
                  Prompt cache timer
                  <span class="set-hint"
                    >Claude keeps your conversation cached for a while after it answers. A message sent
                    later re-sends it all uncached (slower, costs more). Shows a countdown in Claude's
                    panes</span
                  >
                </div>
                <input v-model="settings.promptCacheTimer" type="checkbox" class="set-switch" />
              </label>
              <div v-if="settings.promptCacheTimer" class="set-row">
                <label class="set-label" for="settings-cache-ttl">
                  Cache duration
                  <span class="set-hint">Match your provider's cache. The default is 5 minutes</span>
                </label>
                <select id="settings-cache-ttl" v-model.number="settings.promptCacheTtlMs" class="set-select">
                  <option v-for="t in CACHE_TTLS" :key="t.ms" :value="t.ms">{{ t.label }}</option>
                </select>
              </div>
              <label class="set-row">
                <div class="set-label">
                  Put idle agents to sleep
                  <span class="set-hint"
                    >An agent idle for a while stops its terminal to free memory; its pane stays and
                    opening it resumes the conversation. Only agents whose conversation Tessel can resume,
                    never teammates, nor the pane you are in</span
                  >
                </div>
                <input v-model="settings.agentSleep" type="checkbox" class="set-switch" />
              </label>
              <div v-if="settings.agentSleep" class="set-row">
                <label class="set-label" for="settings-sleep-min">
                  Sleep after
                  <span class="set-hint">Minutes idle (1 to 1440)</span>
                </label>
                <input
                  id="settings-sleep-min"
                  class="set-number"
                  type="number"
                  min="1"
                  max="1440"
                  :value="settings.agentSleepMinutes"
                  @change="setSleepMinutes"
                />
              </div>
            </div>
          </div>

          <div class="set-group">
            <h3 class="set-group-title">Installed agents</h3>
            <div class="set-card">
              <div class="agents-head">
                <span class="set-hint">Detected on this computer</span>
                <button class="exit-btn" type="button" :disabled="detecting" @click="detectAgents">
                  {{ detecting ? 'Detecting…' : 'Detect again' }}
                </button>
              </div>
              <div class="set-row agent-updates-row" data-test="agent-updates">
                <div class="set-label">
                  Agent updates
                  <span class="set-hint agent-updates-summary">{{ agentUpdatesSummary }}</span>
                </div>
                <div class="agent-set-actions">
                  <button
                    class="exit-btn"
                    type="button"
                    data-test="check-agent-updates"
                    :disabled="checkingAgentUpdates"
                    @click="checkAgentUpdates"
                  >
                    {{ checkingAgentUpdates ? 'Checking…' : 'Check for agent updates' }}
                  </button>
                  <button
                    v-if="updatableCount > 1"
                    class="exit-btn"
                    type="button"
                    data-test="update-all-agents"
                    @click="emit('update-all-agents')"
                  >
                    Update all
                  </button>
                </div>
              </div>
              <label class="set-row">
                <div class="set-label">
                  Update agents automatically
                  <span class="set-hint"
                    >When a newer version is found, update it by itself at a safe moment: panes running it
                    are idle, nothing typed in them. They restart in place and resume their conversation</span
                  >
                </div>
                <input v-model="settings.autoUpdateAgents" type="checkbox" class="set-switch" />
              </label>
              <div v-for="a in agents" :key="a.id" class="agent-set" :data-agent="a.id">
                <div class="set-row">
                  <div class="set-label agent-set-name">
                    <BrandIcon :kind="a.id" :size="15" />
                    <span>{{ a.name }}</span>
                    <span class="set-hint">
                      {{ a.available ? 'Installed' : 'Not found' }}{{ customized(a.id) ? ' · customized' : '' }}
                    </span>
                    <!-- Full-width lines under the name row. -->
                    <div
                      v-if="a.available && versionText(a)"
                      class="set-hint agent-version"
                      :class="{ 'agent-update-available': updateRow(a.id) && updateRow(a.id).update }"
                      :data-test="`agent-version-${a.id}`"
                    >
                      {{ versionText(a) }}
                    </div>
                    <div v-if="jobText(a.id)" class="set-hint agent-update-job" :data-test="`agent-update-job-${a.id}`">
                      {{ jobText(a.id) }}
                    </div>
                  </div>
                  <div class="agent-set-actions">
                    <button
                      v-if="a.available && updateRow(a.id) && updateRow(a.id).update"
                      class="exit-btn agent-update-btn"
                      type="button"
                      :data-test="`update-agent-${a.id}`"
                      :disabled="jobActive(a.id)"
                      @click="emit('update-agent', a.id)"
                    >
                      {{ jobActive(a.id) ? 'Updating…' : 'Update' }}
                    </button>
                    <button
                      v-if="agentUpdateJobs[a.id] && ['waiting-stop', 'restarting'].includes(agentUpdateJobs[a.id].phase)"
                      class="exit-btn"
                      type="button"
                      title="Stop waiting for its panes (they keep running as they are)"
                      @click="emit('cancel-agent-update', a.id)"
                    >
                      Stop waiting
                    </button>
                    <button v-if="AGENT_DOCS[a.id]" class="exit-btn" type="button" @click="openDocs(a.id)">
                      Docs
                    </button>
                    <button
                      class="exit-btn"
                      type="button"
                      :aria-expanded="openAgent === a.id"
                      @click="openAgent = openAgent === a.id ? null : a.id"
                    >
                      Customize
                    </button>
                    <input
                      type="checkbox"
                      class="set-switch"
                      :aria-label="`Offer ${a.name} in menus`"
                      :title="agentEnabled(settings.agentPrefs, a.id) ? 'Shown in menus' : 'Hidden from menus'"
                      :checked="agentEnabled(settings.agentPrefs, a.id)"
                      @change="setAgentPref(a.id, 'enabled', $event.target.checked)"
                    />
                  </div>
                </div>
                <div v-if="openAgent === a.id" class="agent-custom">
                  <label class="agent-field">
                    <span class="set-hint">Command</span>
                    <input
                      class="set-number mcp-input"
                      spellcheck="false"
                      :placeholder="a.command"
                      :value="agentPref(a.id).command || ''"
                      @change="setAgentPref(a.id, 'command', $event.target.value)"
                    />
                  </label>
                  <label class="agent-field">
                    <span class="set-hint">Arguments (replace the Yolo option when set)</span>
                    <input
                      class="set-number mcp-input"
                      spellcheck="false"
                      :placeholder="YOLO_ARGS[a.id] ? `Yolo adds: ${YOLO_ARGS[a.id]}` : 'e.g. --model …'"
                      :value="agentPref(a.id).args || ''"
                      @change="setAgentPref(a.id, 'args', $event.target.value)"
                    />
                  </label>
                  <label class="agent-field">
                    <span class="set-hint"
                      >Variables, one NAME=value per line{{
                        YOLO_ENV[a.id] ? ` (Yolo sets ${Object.keys(YOLO_ENV[a.id]).join(', ')})` : ''
                      }}</span
                    >
                    <textarea
                      class="set-number mcp-input agent-env"
                      rows="3"
                      spellcheck="false"
                      :value="agentPref(a.id).env || ''"
                      @change="setAgentPref(a.id, 'env', $event.target.value)"
                    ></textarea>
                  </label>
                  <p v-if="envErrors[a.id]" class="mcp-error">{{ envErrors[a.id] }} Not used until fixed.</p>
                  <div class="agent-custom-foot">
                    <span class="set-hint">Applies to panes you start from now on</span>
                    <button class="exit-btn" type="button" :disabled="!customized(a.id)" @click="resetAgent(a.id)">
                      Reset
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <!-- ============ AI provider accounts ============ -->
        <section
          id="set-accounts"
          class="set-page"
          data-page="accounts"
          :hidden="!shown('accounts')"
          aria-labelledby="set-accounts-title"
        >
          <header class="set-page-head">
            <h2 id="set-accounts-title">{{ PAGES.accounts.title }}</h2>
            <p class="set-page-desc">{{ PAGES.accounts.desc }}</p>
          </header>
          <div class="set-group">
            <div class="set-card set-card-pad">
              <ProviderAccounts />
            </div>
          </div>
        </section>

        <!-- ============ Orchestration ============ -->
        <section
          id="set-orchestration"
          class="set-page"
          data-page="orchestration"
          :hidden="!shown('orchestration')"
          aria-labelledby="set-orchestration-title"
        >
          <header class="set-page-head">
            <h2 id="set-orchestration-title">{{ PAGES.orchestration.title }}</h2>
            <p class="set-page-desc">{{ PAGES.orchestration.desc }}</p>
          </header>
          <div class="set-group">
            <h3 class="set-group-title">Your team</h3>
            <div class="set-card">
              <p class="set-hint set-card-text">
                Agents in a team (Sessions) coordinate through Tessel: they give each other cards, wait for
                the cards before theirs, ask and answer, report when done, and ask you to decide. You follow
                it on the task board.
              </p>
              <div class="agents-head">
                <span class="set-hint">{{ coverageSummary }}</span>
                <span class="agent-set-actions">
                  <button class="exit-btn" type="button" @click="loadCoverage">Check again</button>
                  <button class="exit-btn" type="button" @click="emit('open-connections')">Details</button>
                </span>
              </div>
              <div v-if="Array.isArray(coverage) && coverage.length" class="orch-coverage">
                <span v-for="r in coverage" :key="r.id" class="orch-chip" :class="r.state" :data-agent="r.id">
                  <BrandIcon :kind="r.id" :size="13" />{{ r.name }}:
                  {{ r.state === 'ready' ? 'ready' : r.state === 'approval' ? 'needs your approval' : 'not set up' }}
                </span>
              </div>
              <label class="set-row">
                <div class="set-label">
                  Wake idle agents for team messages
                  <span class="set-hint"
                    >Types a one-line reminder in an idle agent's terminal, never while you are in that pane
                    or typing there (nothing else can start an idle agent). Off: messages wait until the
                    agent next works</span
                  >
                </div>
                <input v-model="settings.teamWakeUps" type="checkbox" class="set-switch" />
              </label>
            </div>
          </div>
          <div class="set-group">
            <h3 class="set-group-title">The team tools</h3>
            <div class="set-card">
              <ul class="orch-tools">
                <li v-for="[name, what] in ORCHESTRATION_TOOLS" :key="name"><code>{{ name }}</code> {{ what }}</li>
              </ul>
            </div>
          </div>
          <div class="set-group">
            <h3 class="set-group-title">How to use it</h3>
            <div class="set-card">
              <p class="set-hint set-card-text">Tell the agent that leads the team, in your own words, for example:</p>
              <div v-for="ex in ORCHESTRATION_EXAMPLES" :key="ex.id" class="orch-example">
                <div class="set-label">
                  {{ ex.title }}
                  <span class="set-hint">{{ ex.prompt }}</span>
                </div>
                <button class="exit-btn" type="button" @click="copyExample(ex)">
                  {{ copiedExample === ex.id ? 'Copied' : 'Copy' }}
                </button>
              </div>
            </div>
          </div>
        </section>

        <!-- ============ Voice typing ============ -->
        <section
          id="set-voice"
          class="set-page"
          data-page="voice"
          :hidden="!shown('voice')"
          aria-labelledby="set-voice-title"
        >
          <header class="set-page-head">
            <h2 id="set-voice-title">{{ PAGES.voice.title }}</h2>
            <p class="set-page-desc">{{ PAGES.voice.desc }}</p>
          </header>
          <div class="set-group">
            <div class="set-card">
              <div class="set-row">
                <label class="set-label" for="settings-language">
                  Language
                  <span class="set-hint"
                    >Windows dictation listens in one language. The mic button switches to this one first.
                    Add languages in Windows Settings, Time &amp; language.</span
                  >
                </label>
                <select
                  id="settings-language"
                  v-model="settings.voiceTip"
                  class="set-select"
                  @change="settings.voiceTipChosen = true"
                >
                  <option value="">Current keyboard language</option>
                  <option v-for="l in languages.filter((x) => x.tip)" :key="l.tip" :value="l.tip">
                    {{ l.name }}
                  </option>
                </select>
              </div>
            </div>
          </div>
        </section>

        <!-- ============ General ============ -->
        <section
          id="set-general"
          class="set-page"
          data-page="general"
          :hidden="!shown('general')"
          aria-labelledby="set-general-title"
        >
          <header class="set-page-head">
            <h2 id="set-general-title">{{ PAGES.general.title }}</h2>
            <p class="set-page-desc">{{ PAGES.general.desc }}</p>
          </header>
          <div class="set-group">
            <div class="set-card">
              <label class="set-row">
                <div class="set-label">
                  Reopen my workspaces at launch
                  <span class="set-hint">Off starts with a single terminal</span>
                </div>
                <input v-model="settings.restoreWorkspaces" type="checkbox" class="set-switch" />
              </label>
              <label class="set-row">
                <div class="set-label">Ask before closing an agent pane</div>
                <input v-model="settings.confirmCloseAgent" type="checkbox" class="set-switch" />
              </label>
            </div>
          </div>
          <div class="set-group">
            <h3 class="set-group-title">Reset</h3>
            <div class="set-card">
              <div class="set-row set-foot">
                <div class="set-label">
                  Reset every setting
                  <span class="set-hint"
                    >Changes apply right away and are saved. This puts every setting back to its
                    default</span
                  >
                </div>
                <button class="exit-btn" type="button" @click="resetSettings">Reset to defaults</button>
              </div>
            </div>
          </div>
        </section>

        <!-- ============ Appearance ============ -->
        <section
          id="set-appearance"
          class="set-page"
          data-page="appearance"
          :hidden="!shown('appearance')"
          aria-labelledby="set-appearance-title"
        >
          <header class="set-page-head">
            <h2 id="set-appearance-title">{{ PAGES.appearance.title }}</h2>
            <p class="set-page-desc">{{ PAGES.appearance.desc }}</p>
          </header>
          <div class="set-group">
            <div class="set-card">
              <div class="set-row">
                <label class="set-label" for="appearance-theme">
                  Theme
                  <span class="set-hint">Applies immediately. Your sessions keep running.</span>
                </label>
                <select id="appearance-theme" v-model="settings.theme" class="set-select">
                  <option v-for="theme in THEMES" :key="theme.id" :value="theme.id">
                    {{ theme.label }}
                  </option>
                </select>
              </div>
            </div>
          </div>

          <!-- Orca's Appearance > Window & Sidebar. -->
          <div class="set-group">
            <h3 class="set-group-title">Window &amp; Sidebar</h3>
            <div class="set-card">
              <div class="set-row">
                <div id="settings-sidebar-appearance-label" class="set-label">
                  Left Sidebar Appearance
                  <span class="set-hint">Make the left sidebar match your terminal, stay default, or use a tint.</span>
                </div>
                <div class="launch-seg set-seg" role="group" aria-labelledby="settings-sidebar-appearance-label">
                  <button
                    v-for="m in SIDEBAR_APPEARANCES"
                    :key="m.id"
                    class="launch-seg-btn"
                    :class="{ on: settings.leftSidebarAppearanceMode === m.id }"
                    :aria-pressed="settings.leftSidebarAppearanceMode === m.id"
                    @click="settings.leftSidebarAppearanceMode = m.id"
                  >
                    {{ m.label }}
                  </button>
                </div>
              </div>
              <template v-if="settings.leftSidebarAppearanceMode === 'tinted'">
                <label class="set-row">
                  <div class="set-label">
                    Sidebar Tint
                    <span class="set-hint">The color mixed into the left sidebar surface.</span>
                  </div>
                  <input v-model="settings.leftSidebarTintColor" type="color" class="set-color" aria-label="Sidebar Tint" />
                </label>
                <label class="set-row">
                  <div class="set-label">
                    Tint Strength
                    <span class="set-hint">Controls how strongly the tint is mixed into the sidebar. 0 to {{ MAX_LEFT_SIDEBAR_TINT_OPACITY }}</span>
                  </div>
                  <input
                    type="number"
                    class="set-number"
                    min="0"
                    :max="MAX_LEFT_SIDEBAR_TINT_OPACITY"
                    step="0.01"
                    :value="settings.leftSidebarTintOpacity"
                    aria-label="Tint Strength"
                    @change="setTintOpacity"
                  />
                </label>
              </template>
              <label class="set-row">
                <div class="set-label">
                  Show Status Bar
                  <span class="set-hint">The bar at the bottom of the window.</span>
                </div>
                <input v-model="settings.statusBarVisible" type="checkbox" class="set-switch" />
              </label>
              <div class="set-row">
                <div class="set-label">
                  Status Bar
                  <span class="set-hint">Choose which indicators appear in the status bar.</span>
                </div>
              </div>
              <label v-for="t in STATUS_BAR_TOGGLES" :key="t.id" class="set-row set-row-nested">
                <div class="set-label">
                  {{ t.title }}
                  <span class="set-hint">{{ t.description }}</span>
                </div>
                <input
                  type="checkbox"
                  class="set-switch"
                  :checked="settings.statusBarItems.includes(t.id)"
                  :aria-label="t.title"
                  @change="toggleStatusBarItem(t.id)"
                />
              </label>
            </div>
          </div>
          <div class="set-group">
            <h3 class="set-group-title">Sidebar</h3>
            <div class="set-card">
              <div class="set-row">
                <div id="settings-card-layout-label" class="set-label">
                  Workspace Card Layout
                  <span class="set-hint">Workspace cards can use compact or detailed layouts.</span>
                </div>
                <div class="launch-seg set-seg" role="group" aria-labelledby="settings-card-layout-label">
                  <button
                    class="launch-seg-btn"
                    :class="{ on: !settings.compactWorktreeCards }"
                    :aria-pressed="!settings.compactWorktreeCards"
                    @click="settings.compactWorktreeCards = false"
                  >
                    Detailed
                  </button>
                  <button
                    class="launch-seg-btn"
                    :class="{ on: settings.compactWorktreeCards }"
                    :aria-pressed="settings.compactWorktreeCards"
                    @click="settings.compactWorktreeCards = true"
                  >
                    Compact
                  </button>
                </div>
              </div>
            </div>
          </div>
        </section>

        <!-- ============ Text ============ -->
        <section
          id="set-text"
          class="set-page"
          data-page="text"
          :hidden="!shown('text')"
          aria-labelledby="set-text-title"
        >
          <header class="set-page-head">
            <h2 id="set-text-title">{{ PAGES.text.title }}</h2>
            <p class="set-page-desc">{{ PAGES.text.desc }}</p>
          </header>
          <div class="set-group">
            <div class="set-card">
              <div class="set-row">
                <label class="set-label" for="settings-font">
                  Font
                  <span class="set-hint">The typeface of every terminal</span>
                </label>
                <select id="settings-font" v-model="settings.fontFamily" class="set-select">
                  <option v-for="f in FONT_FAMILIES" :key="f" :value="f">{{ f }}</option>
                </select>
              </div>
              <div class="set-row">
                <div class="set-label">
                  Size
                  <span class="set-hint">Also Ctrl+= and Ctrl+-</span>
                </div>
                <div class="set-stepper">
                  <button title="Smaller" @click="stepFont(-1)">−</button>
                  <span>{{ settings.fontSize }}</span>
                  <button title="Bigger" @click="stepFont(1)">+</button>
                </div>
              </div>
              <div class="set-row">
                <div id="settings-cursor-label" class="set-label">Cursor</div>
                <div class="launch-seg set-seg" role="group" aria-labelledby="settings-cursor-label">
                  <button
                    v-for="c in CURSORS"
                    :key="c.id"
                    class="launch-seg-btn"
                    :class="{ on: settings.cursorStyle === c.id }"
                    :aria-pressed="settings.cursorStyle === c.id"
                    @click="settings.cursorStyle = c.id"
                  >
                    {{ c.label }}
                  </button>
                </div>
              </div>
              <label class="set-row">
                <div class="set-label">Blinking cursor</div>
                <input v-model="settings.cursorBlink" type="checkbox" class="set-switch" />
              </label>
            </div>
          </div>
        </section>

        <!-- ============ Terminal ============ -->
        <section
          id="set-terminal"
          class="set-page"
          data-page="terminal"
          :hidden="!shown('terminal')"
          aria-labelledby="set-terminal-title"
        >
          <header class="set-page-head">
            <h2 id="set-terminal-title">{{ PAGES.terminal.title }}</h2>
            <p class="set-page-desc">{{ PAGES.terminal.desc }}</p>
          </header>
          <div class="set-group">
            <h3 class="set-group-title">Shell</h3>
            <div class="set-card">
              <div class="set-row">
                <label class="set-label" for="settings-shell">
                  Default shell <span class="set-hint">Agents run in it too</span>
                </label>
                <div class="set-shell">
                  <BrandIcon :kind="defaultShell || ''" :size="15" />
                  <select
                    id="settings-shell"
                    class="set-select"
                    :value="defaultShell"
                    @change="emit('set-default-shell', $event.target.value)"
                  >
                    <option v-for="s in shells" :key="s.id" :value="s.id">{{ s.name }}</option>
                  </select>
                </div>
              </div>
              <div class="set-row">
                <label class="set-label" for="settings-scrollback">
                  Scrollback lines <span class="set-hint">Applies to new panes</span>
                </label>
                <input
                  id="settings-scrollback"
                  class="set-number"
                  type="number"
                  min="500"
                  max="100000"
                  step="500"
                  :value="settings.scrollback"
                  @change="setScrollback"
                />
              </div>
              <label class="set-row">
                <div class="set-label">
                  Use the graphics card to draw terminals
                  <span class="set-hint"
                    >Faster with busy agents. Turn off if text looks wrong. Applies to new panes</span
                  >
                </div>
                <input v-model="settings.gpuRendering" type="checkbox" class="set-switch" />
              </label>
            </div>
          </div>
          <div class="set-group">
            <h3 class="set-group-title">Copy and paste</h3>
            <div class="set-card">
              <label class="set-row">
                <div class="set-label">Copy text when you select it</div>
                <input v-model="settings.copyOnSelect" type="checkbox" class="set-switch" />
              </label>
              <label class="set-row">
                <div class="set-label">
                  Right-click pastes
                  <span class="set-hint"
                    >Pastes the selection, or the clipboard. Shift+right-click opens the menu</span
                  >
                </div>
                <input v-model="settings.rightClickPaste" type="checkbox" class="set-switch" />
              </label>
              <label class="set-row">
                <div class="set-label">
                  Ask before pasting several lines
                  <span class="set-hint">So an accidental paste can't run commands</span>
                </div>
                <input v-model="settings.confirmMultilinePaste" type="checkbox" class="set-switch" />
              </label>
              <label class="set-row">
                <div class="set-label">
                  Always select with the mouse
                  <span class="set-hint"
                    >Even in programs that use the mouse (GitHub Copilot, htop). They no longer get clicks
                    or the wheel. Otherwise, hold Shift to select</span
                  >
                </div>
                <input v-model="settings.alwaysSelect" type="checkbox" class="set-switch" />
              </label>
            </div>
          </div>
        </section>

        <!-- ============ Agent alerts ============ -->
        <section
          id="set-alerts"
          class="set-page"
          data-page="alerts"
          :hidden="!shown('alerts')"
          aria-labelledby="set-alerts-title"
        >
          <header class="set-page-head">
            <h2 id="set-alerts-title">{{ PAGES.alerts.title }}</h2>
            <p class="set-page-desc">{{ PAGES.alerts.desc }}</p>
          </header>
          <div class="set-group">
            <div class="set-card">
              <label class="set-row">
                <div class="set-label">
                  Windows notifications
                  <span class="set-hint">When an agent finishes while the app is in the background</span>
                </div>
                <input v-model="settings.desktopNotifications" type="checkbox" class="set-switch" />
              </label>
              <label class="set-row">
                <div class="set-label">
                  In-app alerts
                  <span class="set-hint">When an agent finishes in a pane you aren't looking at</span>
                </div>
                <input v-model="settings.inAppAlerts" type="checkbox" class="set-switch" />
              </label>
              <label class="set-row">
                <div class="set-label">
                  Sound
                  <span class="set-hint">With each new notification (the bell in the toolbar lists them)</span>
                </div>
                <select v-model="settings.alertSound" class="set-select" @change="playAlertSound(settings.alertSound)">
                  <option value="none">None</option>
                  <option value="chime">Chime</option>
                  <option value="ping">Ping</option>
                </select>
              </label>
            </div>
          </div>
        </section>

        <!-- ============ Editor ============ -->
        <section
          id="set-editor"
          class="set-page"
          data-page="editor"
          :hidden="!shown('editor')"
          aria-labelledby="set-editor-title"
        >
          <header class="set-page-head">
            <h2 id="set-editor-title">{{ PAGES.editor.title }}</h2>
            <p class="set-page-desc">{{ PAGES.editor.desc }}</p>
          </header>
          <div class="set-group">
            <div class="set-card">
              <label class="set-row">
                <div class="set-label">
                  Save automatically
                  <span class="set-hint">A moment after you stop typing (never over a file that changed on disk)</span>
                </div>
                <input v-model="settings.editorAutoSave" type="checkbox" class="set-switch" />
              </label>
              <div v-if="settings.editorAutoSave" class="set-row">
                <label class="set-label" for="settings-autosave-ms">
                  Save after
                  <span class="set-hint">Milliseconds without typing (250 to 10000)</span>
                </label>
                <input
                  id="settings-autosave-ms"
                  class="set-number"
                  type="number"
                  min="250"
                  max="10000"
                  step="250"
                  :value="settings.editorAutoSaveDelayMs"
                  @change="
                    settings.editorAutoSaveDelayMs = Math.min(10000, Math.max(250, parseInt($event.target.value, 10) || 1000));
                    $event.target.value = settings.editorAutoSaveDelayMs
                  "
                />
              </div>
              <label class="set-row">
                <div class="set-label">
                  Word wrap
                  <span class="set-hint">Long lines wrap to the pane's width (Alt+Z in the editor)</span>
                </div>
                <input v-model="settings.editorWordWrap" type="checkbox" class="set-switch" />
              </label>
              <label class="set-row">
                <div class="set-label">Minimap</div>
                <input v-model="settings.editorMinimap" type="checkbox" class="set-switch" />
              </label>
              <label class="set-row">
                <div class="set-label">
                  Preview tabs
                  <span class="set-hint">A file opened with one click replaces the previous one until you edit it or double-click its tab</span>
                </div>
                <input v-model="settings.editorPreviewTabs" type="checkbox" class="set-switch" />
              </label>
              <label class="set-row">
                <div class="set-label">
                  Changes side by side
                  <span class="set-hint">Otherwise inline, in one column</span>
                </div>
                <input v-model="settings.diffSideBySide" type="checkbox" class="set-switch" />
              </label>

            </div>
          </div>
        </section>

        <!-- ============ Quick commands ============ -->
        <section
          id="set-quick-commands"
          class="set-page"
          data-page="quick-commands"
          :hidden="!shown('quick-commands')"
          aria-labelledby="set-quick-commands-title"
        >
          <header class="set-page-head">
            <h2 id="set-quick-commands-title">{{ PAGES['quick-commands'].title }}</h2>
            <p class="set-page-desc">{{ PAGES['quick-commands'].desc }}</p>
          </header>
          <div class="set-group">
            <div class="set-card">
              <p class="set-hint set-card-text">
                Text you send to the active pane from the command palette (Ctrl+Shift+P, then "Run: name"):
                a command you type often, or a prompt for an agent.
              </p>
              <div v-for="q in settings.quickCommands" :key="q.id" class="set-row quick-row">
                <div class="set-label">
                  {{ q.name }}
                  <span class="set-hint quick-text">{{ q.text }}{{ q.enter ? ' ⏎' : '' }}</span>
                </div>
                <button class="exit-btn" type="button" @click="removeQuickCommand(q.id)">Remove</button>
              </div>
              <form class="custom-agent-form" @submit.prevent="addQuickCommand">
                <input
                  v-model="quickDraft.name"
                  class="set-number"
                  placeholder="Name, e.g. Run tests"
                  aria-label="Quick command name"
                  spellcheck="false"
                />
                <input
                  v-model="quickDraft.text"
                  class="set-number mcp-input"
                  placeholder="Text, e.g. npm test"
                  aria-label="Quick command text"
                  spellcheck="false"
                />
                <label class="quick-enter"><input v-model="quickDraft.enter" type="checkbox" /> Press Enter</label>
                <button class="exit-btn primary" type="submit">Add</button>
              </form>
              <p v-if="quickDraft.error" class="mcp-error">{{ quickDraft.error }}</p>
            </div>
          </div>
        </section>

        <!-- ============ Updates ============ -->
        <section
          id="set-updates"
          class="set-page"
          data-page="updates"
          :hidden="!shown('updates')"
          aria-labelledby="set-updates-title"
        >
          <header class="set-page-head">
            <h2 id="set-updates-title">{{ PAGES.updates.title }}</h2>
            <p class="set-page-desc">{{ PAGES.updates.desc }}</p>
          </header>
          <div class="set-group">
            <div class="set-card">
              <div class="set-row">
                <div class="set-label">
                  Tessel {{ updateStatus.current || '' }}
                  <span class="set-hint">{{ updateText(updateStatus) }}</span>
                </div>
                <button
                  v-if="updateStatus.state === 'ready'"
                  class="exit-btn primary"
                  @click="emit('open-update')"
                >
                  Restart and update
                </button>
                <button
                  v-else
                  class="exit-btn"
                  :disabled="['disabled', 'checking', 'downloading'].includes(updateStatus.state)"
                  @click="emit('check-updates')"
                >
                  Check for updates
                </button>
              </div>
            </div>
          </div>
        </section>
      </div>
    </main>
  </div>
</template>
