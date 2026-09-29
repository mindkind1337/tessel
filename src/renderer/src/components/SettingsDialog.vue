<script setup>
import { t, intlLocale, UI_LANGUAGES } from '../i18n'
// Settings, as a full page over the app's main area (like Orca's): a sidebar
// with "Back to app", a search box and the pages, then one page at a time.
// Edits the shared `settings` store directly, so every change applies live to
// all panes and is saved automatically.
import { ref, computed, watch, nextTick, onMounted, onUnmounted, onUpdated } from 'vue'
import BrandIcon from './BrandIcon.vue'
import ProviderAccounts from './ProviderAccounts.vue'
import StatsUsage from './StatsUsage.vue'
import RemoteHostsSettings from './remote/RemoteHostsSettings.vue'
import AutomationsPage from './AutomationsPage.vue'
import CliSettings from './CliSettings.vue'
import { BarChart3, Cable, LoaderCircle } from 'lucide-vue-next'
import { updateFailureText, updateKindLabel } from '../agentUpdateErrors'
import { settings, FONT_FAMILIES, resetSettings, clamp, MAX_LEFT_SIDEBAR_TINT_OPACITY, limitNumber, DEFAULT_SETTINGS, LIMITS, USAGE_REFRESH_MINUTES } from '../settings'
import { THEMES } from '../themes'
import { playAlertSound } from '../notificationsStore'
import { uiZoomPercent, stepUiZoom } from '../appearance'
import { LIGHT_BG_MIN_CONTRAST, DEFAULT_WORD_SEPARATOR } from '../terminalOptions'
import { getBranchPrefixIssue, normalizeBranchPrefix } from '../../../shared/worktreeNaming'
import { parseEnvText, YOLO_ARGS, YOLO_ENV, agentEnabled } from '../../../shared/agentPrefs'
import { AGENT_DOCS } from '../../../shared/agentDocs'
import {
  getAgentSessionOptionCatalog,
  modelOptions,
  resolveSessionOptionDefaults,
  updateSessionOptionDefaults,
  clearSessionOptionModel,
  clearSessionOptionValue
} from '../../../shared/agentSessionOptions'
import { modelsFor, modelLists, modelProbes, refreshModels, canProbeModels } from '../agentModels'
import { sessionOptionLabel, sessionChoiceLabel, probeErrorText } from '../sessionOptionLabels'
import { CACHE_TTLS } from '../promptCache'
import { ORCHESTRATION_EXAMPLES, ORCHESTRATION_TOOLS } from '../orchestrationGuide'
import { WORKER_AGENTS, MAX_CONCURRENT_LIMIT, NESTED_DEPTH_LIMIT } from '../../../shared/orchestration'
// Settings > Appearance, "Usage refresh": Off, or every N minutes.
const usageRefreshLabel = (m) =>
  m === 0
    ? t('settings.appearance.usageRefreshOff', 'Off')
    : t('settings.appearance.usageRefreshMinutes', '{{count}} min', { count: m })

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
  agentUpdateQueue: { type: Array, default: () => [] },
  // { entries: [...newest first], last: { agentId: entry } } (main's agentUpdateHistory.js)
  agentUpdateHistory: { type: Object, default: () => ({ entries: [], last: {} }) }
})

// The pages, grouped as in the sidebar. `icon` is a 16x16 stroke path.
// Titles are getters: read where they are shown, in the interface's language.
const PAGES = {
  stats: {
    get title() {
      return t('settings.pages.stats.title', 'Stats & Usage')
    },
    get desc() {
      return t('settings.pages.stats.desc', 'Tessel stats plus local agent token analytics.')
    }
  },
  agents: {
    get title() {
      return t('settings.pages.agents.title', 'Agents')
    },
    get desc() {
      return t('settings.pages.agents.desc', 'Which agents Tessel offers, how they start and what they may do.')
    },
    icon: 'M5 5h6a2 2 0 012 2v4a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2zM8 2v3M6 9h.01M10 9h.01'
  },
  accounts: {
    get title() {
      return t('settings.pages.accounts.title', 'AI provider accounts')
    },
    get desc() {
      return t('settings.pages.accounts.desc', 'Your sign-ins with each AI provider, for quick switching.')
    },
    icon: 'M8 8a2.75 2.75 0 100-5.5A2.75 2.75 0 008 8zM2.75 13.5c.7-2.3 2.8-3.75 5.25-3.75s4.55 1.45 5.25 3.75'
  },
  orchestration: {
    get title() {
      return t('settings.pages.orchestration.title', 'Orchestration')
    },
    get desc() {
      return t('settings.pages.orchestration.desc', 'Agents working as a team, followed on the task board.')
    },
    icon: 'M4 5.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3zM12 5.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3zM8 13.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3zM5 5l2.2 5M11 5l-2.2 5M5.5 4h5'
  },
  voice: {
    get title() {
      return t('settings.pages.voice.title', 'Voice typing')
    },
    get desc() {
      return t('settings.pages.voice.desc', 'Dictate into any pane with Windows voice typing.')
    },
    icon: 'M8 2a2 2 0 00-2 2v4a2 2 0 004 0V4a2 2 0 00-2-2zM4 8a4 4 0 008 0M8 12v2'
  },
  general: {
    get title() {
      return t('settings.pages.general.title', 'General')
    },
    get desc() {
      return t('settings.pages.general.desc', 'How Tessel starts and closes.')
    },
    icon: 'M3 4.5h10M3 8h10M3 11.5h10M6 3v3M10 6.5v3M5 10v3'
  },
  appearance: {
    get title() {
      return t('settings.pages.appearance.title', 'Appearance')
    },
    get desc() {
      return t('settings.pages.appearance.desc', 'The colors of the whole app, the sidebar and the status bar.')
    },
    icon: 'M8 2a6 6 0 100 12A6 6 0 008 2zM8 2v12'
  },
  text: {
    get title() {
      return t('settings.pages.text.title', 'Text')
    },
    get desc() {
      return t('settings.pages.text.desc', 'The font, size and cursor of every terminal.')
    },
    icon: 'M3 4.5V3h10v1.5M8 3v10M6 13h4'
  },
  terminal: {
    get title() {
      return t('settings.pages.terminal.title', 'Terminal')
    },
    get desc() {
      return t('settings.pages.terminal.desc', 'Shell, scrollback, drawing, copy and paste.')
    },
    icon: 'M2.5 3.5h11v9h-11zM5 6.5l2 1.5-2 1.5M8.5 10H11'
  },
  editor: {
    get title() {
      return t('settings.pages.editor.title', 'Editor')
    },
    get desc() {
      return t('settings.pages.editor.desc', 'The code editor in Tessel panes: saving, wrapping, tabs and changes.')
    },
    icon: 'M5 4L1.5 8 5 12M11 4l3.5 4-3.5 4M9.5 2.5l-3 11'
  },
  alerts: {
    get title() {
      return t('settings.pages.alerts.title', 'Notifications')
    },
    get desc() {
      return t('settings.pages.alerts.desc', 'Native desktop notifications for agent and terminal events.')
    },
    icon: 'M4 11V7a4 4 0 018 0v4l1 1.5H3zM6.5 14a1.5 1.5 0 003 0'
  },
  git: {
    get title() {
      return t('settings.pages.git.title', 'Git & Source Control')
    },
    get desc() {
      return t('settings.pages.git.desc', 'Branch naming and Source Control.')
    },
    icon: 'M5 3v7M5 10a2 2 0 100 4 2 2 0 000-4zM11 3a2 2 0 100 4 2 2 0 000-4zM11 7c0 2.5-2 3-6 3'
  },
  // Scheduled automations (Orca's Automations page): AutomationsPage.vue.
  automations: {
    get title() {
      return t('settings.pages.automations.title', 'Automations')
    },
    get desc() {
      return t('settings.pages.automations.desc', 'Run an agent task on a schedule, while Tessel is open.')
    },
    icon: 'M8 2a6 6 0 100 12A6 6 0 008 2zM8 4.5V8l2.5 1.5'
  },
  'quick-commands': {
    get title() {
      return t('settings.pages.quickCommands.title', 'Quick commands')
    },
    get desc() {
      return t('settings.pages.quickCommands.desc', 'Text you send to the active pane from the command palette.')
    },
    icon: 'M9 1.5L3.5 9H8l-1 5.5L12.5 7H8z'
  },
  updates: {
    get title() {
      return t('settings.pages.updates.title', 'Updates')
    },
    get desc() {
      return t('settings.pages.updates.desc', 'Tessel\'s version and updates.')
    },
    icon: 'M13 8a5 5 0 11-1.5-3.55M13 2.5V5h-2.5'
  },
  // Remote Hosts > SSH Hosts (Orca's SshPane; components/remote/).
  ssh: {
    get title() {
      return t('remote.page.title', 'SSH Hosts')
    },
    get desc() {
      return t('remote.page.desc', 'Use existing machines over SSH for files, terminals, Git, and workspaces.')
    },
    lucide: Cable
  }
}
const GROUPS = [
  {
    id: 'ai',
    get title() {
      return t('settings.groups.ai', 'AI capabilities')
    },
    pages: ['agents', 'accounts', 'orchestration', 'voice']
  },
  {
    id: 'configure',
    get title() {
      return t('settings.groups.configure', 'Configure')
    },
    pages: ['general', 'appearance', 'text', 'terminal', 'editor', 'alerts']
  },
  {
    id: 'workflows',
    get title() {
      return t('settings.groups.workflows', 'Workflows')
    },
    pages: ['git', 'automations', 'quick-commands']
  },
  {
    id: 'interface',
    get title() {
      return t('settings.groups.interface', 'Interface')
    },
    pages: ['stats']
  },
  {
    id: 'remote',
    get title() {
      return t('remote.group', 'Remote Hosts')
    },
    pages: ['ssh']
  },
  {
    id: 'about',
    get title() {
      return t('settings.groups.about', 'About')
    },
    pages: ['updates']
  }
]
// The pages' English titles, so a search in English finds them in any language.
const PAGE_TITLES_EN = {
  stats: 'Stats & Usage', // i18n-ignore
  agents: 'Agents', // i18n-ignore
  accounts: 'AI provider accounts', // i18n-ignore
  orchestration: 'Orchestration', // i18n-ignore
  voice: 'Voice typing', // i18n-ignore
  general: 'General', // i18n-ignore
  appearance: 'Appearance', // i18n-ignore
  text: 'Text', // i18n-ignore
  terminal: 'Terminal', // i18n-ignore
  editor: 'Editor', // i18n-ignore
  alerts: 'Notifications', // i18n-ignore
  git: 'Git & Source Control', // i18n-ignore
  automations: 'Automations', // i18n-ignore
  'quick-commands': 'Quick commands', // i18n-ignore
  updates: 'Updates', // i18n-ignore
  ssh: 'SSH Hosts', // i18n-ignore
}
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
// setting by its label, hint or choices in the interface's language; a
// page's English title also finds the whole page.
const ITEM = '.set-row, .agent-set, .orch-example, .orch-tools li, .account-provider'
function words() {
  return query.value.trim().toLowerCase().split(/\s+/).filter(Boolean)
}
function has(text, ws) {
  const lower = (text || '').toLowerCase()
  return ws.every((w) => lower.includes(w))
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
      let any = has(head && head.textContent, ws) || has(PAGE_TITLES_EN[pg.dataset.page], ws)
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
    d.error = t('settings.quick.missing', 'Give it a name and the text to send.')
    return
  }
  settings.quickCommands.push({ id: `qc-${Date.now().toString(36)}`, name, text, enter: !!d.enter }) // i18n-ignore
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
  'cancel-agent-update',
  'update-agent-in-pane',
  'close-reopen-agent-update',
  'open-update-log',
  'test-notification'
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
  if (!u) return t('settings.agents.notChecked', 'Not checked yet')
  const when = new Date(u.checkedAt).toLocaleString(intlLocale(), { dateStyle: 'short', timeStyle: 'short' })
  const n = updatableCount.value
  return n
    ? n === 1
      ? t('settings.agents.updatesSummary', '{{count}} update available · checked {{when}}', { count: n, when })
      : t('settings.agents.updatesSummary', '{{count}} updates available · checked {{when}}', { count: n, when })
    : t('settings.agents.upToDate', 'All up to date · checked {{when}}', { when })
})
function versionText(a) {
  const r = updateRow(a.id)
  if (!r) return ''
  if (r.update)
    return t('settings.agents.updateAvailable', 'Update available: {{installed}} → {{latest}}', {
      installed: r.installed,
      latest: r.latest
    })
  if (r.installed)
    return r.latest
      ? t('settings.agents.versionLatest', 'Version {{version}} (latest)', { version: r.installed })
      : t('settings.agents.version', 'Version {{version}}', { version: r.installed })
  return r.note || ''
}
// An update in progress, in words.
function jobText(id) {
  const j = props.agentUpdateJobs && props.agentUpdateJobs[id]
  if (!j) return props.agentUpdateQueue.includes(id) ? t('settings.agents.jobQueued', 'Waiting for the other updates') : ''
  const waiting = (j.waiting || []).map((w) => `${w.label} (${w.why})`).join(', ')
  switch (j.phase) {
    case 'updating':
      return j.via === 'background'
        ? t('settings.agents.jobUpdatingBackground', 'Updating in the background…')
        : t('settings.agents.jobUpdating', 'Updating in a pane below…')
    case 'waiting-stop':
      return t('settings.agents.jobWaitingStop', 'Its files are in use: waiting to stop {{panes}} safely, then updating and resuming them', {
        panes: waiting || t('settings.agents.jobItsPanes', 'its panes')
      })
    case 'retrying':
      return t('settings.agents.jobRetrying', 'Stopped its panes; updating again…')
    case 'restarting':
      return t('settings.agents.jobRestarting', 'Updated to {{version}}. Waiting to restart: {{panes}}', {
        version: j.version,
        panes: waiting || '…'
      })
    case 'done':
      // The report comes from the updater, as it is.
      return (
        t('settings.agents.jobDone', 'Updated to {{version}}.', { version: j.version || j.target }) +
        (j.report ? ` ${j.report}` : '')
      )
    case 'failed':
      // Told by the last result line (the history) when it has it.
      if (lastUpdate(id) && lastUpdate(id).at >= (j.startedAt || 0) && !j.inUse) return ''
      return j.error
        ? t('settings.agents.jobFailedWith', 'Not updated: {{error}}.', { error: j.error })
        : t('settings.agents.jobFailed', 'Not updated.')
    default:
      return ''
  }
}
function jobRunning(id) {
  const j = props.agentUpdateJobs && props.agentUpdateJobs[id]
  return !!(j && ['updating', 'retrying'].includes(j.phase))
}
// Files in use by its own panes: Tessel can close and reopen them.
function jobInUse(id) {
  const j = props.agentUpdateJobs && props.agentUpdateJobs[id]
  return !!(j && j.phase === 'failed' && j.inUse)
}

// The update history (the last attempts) and each agent's last result.
function lastUpdate(id) {
  const h = props.agentUpdateHistory
  return (h && h.last && h.last[id]) || null
}
const updateHistory = computed(() => {
  const h = props.agentUpdateHistory
  return h && Array.isArray(h.entries) ? h.entries : []
})
const historyOpen = ref(false)
const historyTitle = computed(() => t('settings.agents.history', 'Update history ({{count}})', { count: updateHistory.value.length }))
function whenText(at) {
  return new Date(at).toLocaleString(intlLocale(), { dateStyle: 'short', timeStyle: 'short' })
}
function versionsText(e) {
  const to = e.ok ? e.version || e.to : e.to
  return e.from && to ? `${e.from} → ${to}` : to || e.from || ''
}
function lastUpdateText(id) {
  const e = lastUpdate(id)
  if (!e) return ''
  const vars = { when: whenText(e.at), versions: versionsText(e) }
  return e.ok
    ? t('settings.agents.lastOk', 'Last update {{when}}: {{versions}}, succeeded', vars)
    : t('settings.agents.lastFailed', 'Last update {{when}}: {{versions}}, failed ({{kind}})', { ...vars, kind: updateKindLabel(e.kind) })
}
// Why the last attempt failed, in plain words, and the line of output that tells it.
function lastUpdateWhy(a) {
  const e = lastUpdate(a.id)
  if (!e || e.ok) return ''
  // Files in use by its own panes: the job's line says it, with its button.
  if (jobInUse(a.id)) return updateFailureText('in-use', a.name, { panes: 1 })
  return updateFailureText(e.kind, a.name)
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
      // Status-only hooks bring no team messages (agentStatusHooks.js).
      .filter((r) => !r.statusOnly && props.agents.some((a) => a.id === r.id && a.available))
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
    coverage.value = { error: (err && err.message) || t('settings.orchestration.unknownError', 'unknown error') }
  }
}
const coverageSummary = computed(() => {
  const c = coverage.value
  if (!c) return t('settings.orchestration.checking', 'Checking your agents…')
  if (c.error) return t('settings.orchestration.checkFailed', 'Could not check: {{error}}', { error: c.error })
  if (!c.length)
    return t('settings.orchestration.noAgents', 'No agent with team tools found. Install agents in Settings > Agents, then check again.')
  const ready = c.filter((r) => r.state === 'ready').length
  return ready === c.length
    ? t('settings.orchestration.allReady', 'All {{count}} agents can work as a team.', { count: c.length })
    : t('settings.orchestration.someReady', '{{ready}} of {{count}} agents can work as a team.', { ready, count: c.length })
})
// Coordinator and workers: the agents that can be started as workers (their
// team tools ready), and the limits (whole numbers in their range).
const workerAgentsReady = computed(() =>
  Array.isArray(coverage.value) ? coverage.value.filter((r) => r.state === 'ready' && WORKER_AGENTS.includes(r.id)).map((r) => r.name) : []
)
const workerAgentsLine = computed(() =>
  workerAgentsReady.value.length
    ? t('settings.orchestration.setupAgents', 'Agents that can be workers: {{agents}}', { agents: workerAgentsReady.value.join(', ') })
    : t('settings.orchestration.setupNoAgents', 'No agent that can be a worker is ready (Claude Code, Codex, Gemini or Qwen, with the team tools)')
)
const maxWorkersHint = computed(() =>
  t('settings.orchestration.maxWorkersHint', 'Per coordinator (1 to {{max}}); the others wait in a queue and start when one ends', { max: MAX_CONCURRENT_LIMIT })
)
const maxDepthHint = computed(() =>
  t('settings.orchestration.maxDepthHint', "1: the lead's workers cannot start workers of their own; 2: they can, once; up to {{max}}", { max: NESTED_DEPTH_LIMIT })
)
function setOrchestrationNumber(key, max, e) {
  const n = parseInt(e.target.value, 10)
  if (Number.isFinite(n)) settings[key] = clamp(n, 1, max)
  e.target.value = settings[key]
}
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
// Settings > Agents, each agent's default model and effort (Orca's catalogs
// and the agent's own model list). Nothing chosen: the agent's own default,
// and Tessel adds no flag (Orca's rule).
function hasModelDefaults(id) {
  return !!getAgentSessionOptionCatalog(id)
}
function modelDefaults(id) {
  return resolveSessionOptionDefaults(settings.agentSessionOptions, id) || null
}
// The models offered, with the chosen one even when the list lacks it.
function defaultModelRows(id) {
  const list = modelsFor(id)
  const d = modelDefaults(id)
  return d && !list.some((m) => m.id === d.model) ? [...list, { id: d.model, label: d.model, options: [] }] : list
}
function setDefaultModel(id, modelId) {
  settings.agentSessionOptions = modelId
    ? updateSessionOptionDefaults({ persisted: settings.agentSessionOptions, agent: id, modelId, optionId: 'model', value: modelId })
    : clearSessionOptionModel(settings.agentSessionOptions, id)
}
// The chosen model's options a launch can set (effort; Cursor's thinking and
// fast mode, which go into its model name).
function defaultOptionRows(id) {
  const d = modelDefaults(id)
  if (!d) return []
  return modelOptions(getAgentSessionOptionCatalog(id), modelsFor(id), d.model).filter(
    (o) => o.apply.launchArgs || o.apply.composedIntoModel
  )
}
// A fast mode only a running session takes (Claude Code's /fast).
function defaultHasLiveFast(id) {
  const d = modelDefaults(id)
  return !!d && modelOptions(getAgentSessionOptionCatalog(id), modelsFor(id), d.model).some(
    (o) => o.id === 'fastMode' && !o.apply.launchArgs && !o.apply.composedIntoModel
  )
}
function setDefaultOption(id, optionId, value) {
  const d = modelDefaults(id)
  if (!d) return
  settings.agentSessionOptions =
    value === '' || value === null
      ? clearSessionOptionValue({ persisted: settings.agentSessionOptions, agent: id, modelId: d.model, optionId })
      : updateSessionOptionDefaults({ persisted: settings.agentSessionOptions, agent: id, modelId: d.model, optionId, value })
}
function probeFor(id) {
  return modelProbes[id] || { busy: false, error: null }
}
function modelListText(a) {
  const list = modelLists[a.id]
  const probe = probeFor(a.id)
  if (probe.busy) return t('settings.agents.modelsListing', 'Asking {{name}} for its models…', { name: a.name })
  if (probe.error) return probeErrorText(probe.error, a.name)
  // No built-in list (OpenCode: its providers are the account's own).
  if (!list && !modelsFor(a.id).length) return t('settings.agents.modelsNone', 'No list yet. Refresh asks {{name}} for the models it offers.', { name: a.name })
  if (!list) return t('settings.agents.modelsBuiltIn', 'Built-in list. Refresh asks {{name}} for the models your account has.', { name: a.name })
  return t('settings.agents.modelsListed', '{{count}} models listed by {{name}} on {{date}}.', {
    count: list.models.length,
    name: a.name,
    date: new Date(list.fetchedAt).toLocaleString(intlLocale(), { dateStyle: 'medium', timeStyle: 'short' })
  })
}
function refreshAgentModels(a) {
  refreshModels(a.id, agentPref(a.id).command || '')
}

// The hint over an agent's variables (Yolo's own ones named).
function envHint(id) {
  return YOLO_ENV[id]
    ? t('settings.agents.variablesYolo', 'Variables, one NAME=value per line (Yolo sets {{names}})', {
        names: Object.keys(YOLO_ENV[id]).join(', ')
      })
    : t('settings.agents.variables', 'Variables, one NAME=value per line')
}
function openDocs(id) {
  if (AGENT_DOCS[id] && window.shellApi.openExternal) window.shellApi.openExternal(AGENT_DOCS[id])
}

function updateText(u) {
  switch (u.state) {
    case 'checking':
      return t('settings.updates.checking', 'Checking for updates…')
    case 'none':
      return t('settings.updates.latest', 'You have the latest version.')
    case 'downloading':
      return u.percent
        ? t('settings.updates.downloadingPct', 'Downloading {{version}} ({{percent}}%)…', { version: u.version, percent: u.percent })
        : t('settings.updates.downloading', 'Downloading {{version}}…', { version: u.version })
    case 'ready':
      return t('settings.updates.ready', 'Version {{version}} is ready to install.', { version: u.version })
    case 'error':
      return t('settings.updates.error', 'Could not check for updates. Try again later.')
    case 'disabled':
      return t('settings.updates.disabled', 'Only the installed app updates itself.')
    default:
      return t('settings.updates.idle', 'Checks automatically every few hours.')
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
  // A previous Settings that never unmounted (a hot reload) leaves its marks:
  // they are lifted first, so nothing stays unclickable.
  for (const stale of document.querySelectorAll('[data-settings-inert]')) {
    stale.removeAttribute('inert')
    stale.removeAttribute('data-settings-inert')
  }
  let branch = cardEl.value
  while (branch && branch !== document.body) {
    for (const sibling of branch.parentElement?.children || []) {
      if (sibling !== branch && !sibling.hasAttribute('inert')) {
        sibling.setAttribute('inert', '')
        sibling.setAttribute('data-settings-inert', '')
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
  for (const sibling of inertSiblings) {
    sibling.removeAttribute('inert')
    sibling.removeAttribute('data-settings-inert')
  }
  if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true })
})

function stepFont(d) {
  settings.fontSize = clamp(settings.fontSize + d, 8, 28)
}

// Settings > Agents > chat agents: minutes idle before a chat's process
// stops (0: never).
function setChatIdleMinutes(e) {
  const n = parseInt(e.target.value, 10)
  if (Number.isFinite(n)) settings.chatIdleMinutes = clamp(n, 0, 1440)
  e.target.value = settings.chatIdleMinutes
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
// The choice lists below are computed so they follow the interface's language.
const AWAKE_MODES = computed(() => [
  { id: 'on', label: t('settings.common.on', 'On'), title: t('settings.agents.awakeOnTitle', 'Keep this computer awake continuously') },
  { id: 'agents', label: t('settings.agents.awakeAgent', 'Agent'), title: t('settings.agents.awakeAgentTitle', 'Stay awake while an agent is working') },
  { id: 'off', label: t('settings.common.off', 'Off'), title: t('settings.agents.awakeOffTitle', 'Allow normal system sleep behavior') }
])

// Settings > Appearance > Window & Sidebar (Orca's AppearanceWindowSidebarSection).
const SIDEBAR_APPEARANCES = computed(() => [
  { id: 'default', label: t('settings.appearance.sidebarDefault', 'Default') },
  { id: 'match-terminal', label: t('settings.appearance.sidebarMatchTerminal', 'Match Terminal') },
  { id: 'tinted', label: t('settings.appearance.sidebarTinted', 'Tinted') }
])
const STATUS_BAR_TOGGLES = computed(() => [
  {
    id: 'ssh',
    title: t('settings.appearance.statusSsh', 'Remote Hosts'),
    description: t('settings.appearance.statusSshHint', 'Show configured SSH and remote Tessel hosts when any are available.')
  },
  {
    id: 'resource-usage',
    title: t('settings.appearance.statusResources', 'Resource Manager'),
    description: t('settings.appearance.statusResourcesHint', 'Show the Resource Manager. Click it for CPU, memory and sessions.')
  },
  {
    id: 'ports',
    title: t('settings.appearance.statusPorts', 'Ports'),
    description: t('settings.appearance.statusPortsHint', 'Show live workspace ports. Click it for workspace-scoped ports and external listeners.')
  }
])
function toggleStatusBarItem(id) {
  const list = settings.statusBarItems
  settings.statusBarItems = list.includes(id) ? list.filter((x) => x !== id) : [...list, id]
}
function setTintOpacity(e) {
  const n = parseFloat(e.target.value)
  if (Number.isFinite(n)) settings.leftSidebarTintOpacity = clamp(n, 0, MAX_LEFT_SIDEBAR_TINT_OPACITY)
  e.target.value = settings.leftSidebarTintOpacity
}

const CURSORS = computed(() => [
  { id: 'block', label: t('settings.text.cursorBlock', 'Block') },
  { id: 'bar', label: t('settings.text.cursorBar', 'Bar') },
  { id: 'underline', label: t('settings.text.cursorUnderline', 'Underline') }
])

// A number setting typed in a field: kept in its range (Orca's), shown back.
function setNumber(key, e, round = false) {
  const v = limitNumber(key, parseFloat(e.target.value))
  if (v !== null) settings[key] = round ? Math.round(v) : Math.round(v * 100) / 100
  e.target.value = settings[key]
}
function setRange(key, e) {
  const v = limitNumber(key, parseFloat(e.target.value))
  if (v !== null) settings[key] = Math.round(v * 100) / 100
}

const OFF_ON = computed(() => [
  { id: false, label: t('settings.common.off', 'Off') },
  { id: true, label: t('settings.common.on', 'On') }
])
const GPU_MODES = computed(() => [
  { id: 'auto', label: t('settings.terminal.gpuAuto', 'Auto') },
  { id: 'on', label: t('settings.common.on', 'On') },
  { id: 'off', label: t('settings.common.off', 'Off') }
])
const gpuHint = computed(() =>
  settings.gpuAcceleration === 'off'
    ? t('settings.terminal.gpuOffHint', 'WebGL disabled; DOM renderer for max compatibility.')
    : settings.gpuAcceleration === 'on'
      ? t('settings.terminal.gpuOnHint', 'WebGL is always attempted for terminal panes.')
      : t('settings.terminal.gpuAutoHint', 'Auto tries WebGL, with DOM fallback for unsupported or risky renderers.')
)

// Color Contrast (Orca's): Automatic (null), Off (1) or a custom ratio.
const CONTRAST_MODES = computed(() => [
  { id: 'auto', label: t('settings.terminal.contrastAuto', 'Automatic') },
  { id: 'off', label: t('settings.common.off', 'Off') },
  { id: 'custom', label: t('settings.terminal.contrastCustom', 'Custom') }
])
const contrastMode = computed(() =>
  settings.minimumContrastRatio === null ? 'auto' : settings.minimumContrastRatio === 1 ? 'off' : 'custom'
)
let lastCustomContrast = LIGHT_BG_MIN_CONTRAST
function setContrastMode(mode) {
  if (contrastMode.value === 'custom') lastCustomContrast = settings.minimumContrastRatio
  settings.minimumContrastRatio = mode === 'auto' ? null : mode === 'off' ? 1 : lastCustomContrast
}
const contrastHint = computed(() =>
  contrastMode.value === 'auto'
    ? t('settings.terminal.contrastAutoHint', 'Balances readability with your terminal theme. Recommended.')
    : contrastMode.value === 'off'
      ? t('settings.terminal.contrastOffHint', 'Keeps program colors unchanged, including dim text and Powerline separators.')
      : t('settings.terminal.contrastCustomHint', 'Choose how much to increase contrast between text and its background.')
)

function resetScrollSpeed() {
  settings.scrollSensitivity = DEFAULT_SETTINGS.scrollSensitivity
  settings.fastScrollSensitivity = DEFAULT_SETTINGS.fastScrollSensitivity
}

const zoomPercent = computed(() => uiZoomPercent(settings.uiZoomLevel))
function zoom(direction) {
  settings.uiZoomLevel = stepUiZoom(settings.uiZoomLevel, direction)
}

// Settings > Git & Source Control.
const BRANCH_PREFIX_MODES = computed(() => [
  { id: 'git-username', label: t('settings.git.prefixGitUsername', 'Git Username') },
  { id: 'custom', label: t('settings.git.prefixCustom', 'Custom') },
  { id: 'none', label: t('settings.git.prefixNone', 'None') }
])
const GROUP_ORDERS = computed(() => [
  { id: 'changes-first', label: t('settings.git.changesFirst', 'Changes first') },
  { id: 'staged-first', label: t('settings.git.stagedFirst', 'Staged first') },
  { id: 'untracked-first', label: t('settings.git.untrackedFirst', 'Untracked first') }
])
const branchPrefixFeedback = computed(() => {
  if (settings.branchPrefix === 'none') return { text: '', error: false }
  if (settings.branchPrefix === 'git-username')
    return {
      text: t('settings.git.usernameHint', 'Uses git config github.user or user.username, else your GitHub CLI login'),
      error: false
    }
  const raw = settings.branchPrefixCustom || ''
  if (getBranchPrefixIssue(raw))
    return {
      text: t('settings.git.prefixInvalid', 'Prefix cannot contain spaces or special characters like ~ ^ : ? * [ \\'),
      error: true
    }
  const p = normalizeBranchPrefix(raw)
  if (p) return { text: t('settings.git.prefixExampleName', 'Branches will be named {{prefix}}/feature', { prefix: p }), error: false }
  return { text: raw.trim() ? t('settings.git.noPrefix', 'No prefix will be applied') : '', error: false }
})

// Notifications: the sound at the chosen volume.
function previewSound() {
  playAlertSound(settings.alertSound, settings.notificationVolume)
}
</script>

<template>
  <div
    ref="cardEl"
    class="settings-page"
    :class="{ searching }"
    role="dialog"
    :aria-label="t('settings.dialog.label', 'Settings')"
    aria-modal="true"
    tabindex="-1"
    @keydown="onKeydown"
    @keydown.tab.stop="trapTab"
    @keydown.escape.prevent.stop="onEscape"
  >
    <nav class="set-side" :aria-label="t('settings.nav.pagesLabel', 'Settings pages')">
      <button class="set-back" type="button" :title="t('settings.nav.backTitle', 'Back to app (Esc)')" @click="emit('close')">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M13 8H3.5M7.5 3.5L3 8l4.5 4.5"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
        {{ t('settings.nav.back', 'Back to app') }}
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
          :placeholder="t('settings.search.placeholder', 'Search settings')"
          :aria-label="t('settings.search.placeholder', 'Search settings')"
          :title="t('settings.search.title', 'Search settings (Ctrl+F)')"
          spellcheck="false"
        />
      </div>
      <div v-for="g in GROUPS" :key="g.id" class="set-nav-group">
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
              <component :is="PAGES[id].lucide" v-else-if="PAGES[id].lucide" :size="15" aria-hidden="true" />
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
        <p
          v-if="searching && !matched.length"
          class="set-empty"
          role="status"
          v-text="t('settings.search.noMatch', 'No settings match “{{query}}”.', { query: query.trim() })"
        ></p>

        <section id="set-stats" class="set-page" data-page="stats" :hidden="!shown('stats')" aria-labelledby="set-stats-title">
          <header class="set-page-head">
            <h2 id="set-stats-title">{{ PAGES.stats.title }}</h2>
            <p class="set-page-desc">{{ PAGES.stats.desc }}</p>
          </header>
          <div class="set-group">
            <StatsUsage v-if="page === 'stats' && !searching" :worktree-paths="worktreePaths" />
            <div v-else class="set-row">
              <div class="set-label">{{ t('settings.stats.analytics', 'Usage Analytics') }}
                <span class="set-hint">{{ t('settings.stats.analyticsHint', 'Overview, Claude, Codex, tokens, costs, cache efficiency, daily usage, models, projects and sessions.') }}</span>
              </div>
              <button type="button" class="exit-btn" @click="go('stats')">{{ t('settings.stats.open', 'Open Stats & Usage') }}</button>
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
            <h3 class="set-group-title">{{ t('settings.agents.newAgents', 'New agents') }}</h3>
            <div class="set-card">
              <div class="set-row">
                <label class="set-label" for="settings-default-agent">
                  {{ t('settings.agents.defaultAgent', 'Default agent') }}
                  <span class="set-hint">{{ t('settings.agents.defaultAgentHint', 'What a new pane starts (Ctrl+Shift+T)') }}</span>
                </label>
                <select id="settings-default-agent" v-model="settings.defaultAgent" class="set-select">
                  <option value="">{{ t('settings.agents.defaultShell', 'The default shell') }}</option>
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
                  {{ t('settings.agents.permissions', 'Permissions') }}
                  <span class="set-hint">{{ t('settings.agents.permissionsHint', 'For agents you start from now on') }}</span>
                </div>
                <div class="launch-seg set-seg" role="group" aria-labelledby="settings-perm-label">
                  <button
                    class="launch-seg-btn"
                    :class="{ on: settings.agentPermissions === 'manual' }"
                    :aria-pressed="settings.agentPermissions === 'manual'"
                    @click="settings.agentPermissions = 'manual'"
                  >
                    {{ t('settings.agents.manual', 'Manual') }}
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
                {{ t('settings.agents.yoloWarning', 'Yolo: agents run commands and change files without asking you first (each agent\'s own skip-approvals option, unless you set its arguments yourself). Use it only in projects you can restore.') }}
              </p>
              <!-- Folders where agents always start in Yolo (pane menu > Yolo in this folder). -->
              <div v-if="(settings.yoloFolders || []).length" class="set-row yolo-folders" data-test="settings-yolo-folders">
                <div class="set-label">
                  {{ t('settings.agents.yoloFolders', 'Yolo folders') }}
                  <span class="set-hint">{{ t('settings.agents.yoloFoldersHint', 'Agents started in these folders always start in Yolo (pane menu > Yolo in this folder)') }}</span>
                </div>
                <div class="yolo-folder-list">
                  <div v-for="f in settings.yoloFolders || []" :key="f" class="yolo-folder">
                    <span class="yolo-folder-path" :title="f">{{ f }}</span>
                    <button class="exit-btn" :title="t('settings.agents.yoloFolderRemoveHint', 'Agents started here ask first again (unless Yolo is on above)')" @click="settings.yoloFolders = settings.yoloFolders.filter((x) => x !== f)">
                      {{ t('settings.agents.yoloFolderRemove', 'Remove') }}
                    </button>
                  </div>
                </div>
              </div>
              <label class="set-row">
                <div class="set-label">
                  {{ t('settings.agents.resume', 'Resume conversations when panes reopen') }}
                  <span class="set-hint">{{ t('settings.agents.resumeHint', 'Claude Code and Codex continue where they left off after a restart, instead of starting a new chat') }}</span>
                </div>
                <input v-model="settings.resumeAgents" type="checkbox" class="set-switch" />
              </label>
              <label class="set-row">
                <div class="set-label">
                  {{ t('settings.agents.autoTitles', 'Show the conversation\'s title') }}
                  <span class="set-hint">{{ t('settings.agents.autoTitlesHint', 'Under the agent in the left sidebar and in the pane\'s hover card (Claude Code and Codex)') }}</span>
                </div>
                <input v-model="settings.autoTitles" type="checkbox" class="set-switch" />
              </label>
            </div>
          </div>

          <div class="set-group">
            <h3 class="set-group-title">{{ t('settings.agents.whileWorking', 'While agents work') }}</h3>
            <div class="set-card">
              <div class="set-row">
                <div id="settings-awake-label" class="set-label">
                  {{ t('settings.agents.keepAwake', 'Keep computer awake') }}
                  <span class="set-hint">{{ t('settings.agents.keepAwakeHint', 'Choose On, Agent, or Off. Agent mode stays awake while agents are working; lid-close behavior follows this device\'s power settings.') }}</span>
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
                  {{ t('settings.agents.cacheTimer', 'Prompt cache timer') }}
                  <span class="set-hint">{{ t('settings.agents.cacheTimerHint', 'Claude keeps your conversation cached for a while after it answers. A message sent later re-sends it all uncached (slower, costs more). Shows a countdown in Claude\'s panes') }}</span>
                </div>
                <input v-model="settings.promptCacheTimer" type="checkbox" class="set-switch" />
              </label>
              <div v-if="settings.promptCacheTimer" class="set-row">
                <label class="set-label" for="settings-cache-ttl">
                  {{ t('settings.agents.cacheDuration', 'Cache duration') }}
                  <span class="set-hint">{{ t('settings.agents.cacheDurationHint', 'Match your provider\'s cache. The default is 5 minutes') }}</span>
                </label>
                <select id="settings-cache-ttl" v-model.number="settings.promptCacheTtlMs" class="set-select">
                  <option v-for="ttl in CACHE_TTLS" :key="ttl.ms" :value="ttl.ms">{{ ttl.label }}</option>
                </select>
              </div>
              <label class="set-row">
                <div class="set-label">
                  {{ t('settings.agents.sleep', 'Put idle agents to sleep') }}
                  <span class="set-hint">{{ t('settings.agents.sleepHint', 'An agent idle for a while stops its terminal to free memory; its pane stays and opening it resumes the conversation. Only agents whose conversation Tessel can resume, never teammates, nor the pane you are in') }}</span>
                </div>
                <input v-model="settings.agentSleep" type="checkbox" class="set-switch" />
              </label>
              <div v-if="settings.agentSleep" class="set-row">
                <label class="set-label" for="settings-sleep-min">
                  {{ t('settings.agents.sleepAfter', 'Sleep after') }}
                  <span class="set-hint">{{ t('settings.agents.sleepAfterHint', 'Minutes idle (1 to 1440)') }}</span>
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
              <div class="set-row">
                <label class="set-label" for="settings-chat-idle">
                  {{ t('settings.agents.chatIdle', 'Stop an idle chat agent after') }}
                  <span class="set-hint">{{
                    t('settings.agents.chatIdleHint', 'Minutes without a turn (0: never). Its next message starts it again, its conversation resumed')
                  }}</span>
                </label>
                <input
                  id="settings-chat-idle"
                  class="set-number"
                  type="number"
                  min="0"
                  max="1440"
                  data-setting="chatIdleMinutes"
                  :value="settings.chatIdleMinutes"
                  @change="setChatIdleMinutes"
                />
              </div>
            </div>
          </div>

          <div class="set-group">
            <h3 class="set-group-title">{{ t('settings.agents.installed', 'Installed agents') }}</h3>
            <div class="set-card">
              <div class="agents-head">
                <span class="set-hint">{{ t('settings.agents.detected', 'Detected on this computer') }}</span>
                <button class="exit-btn" type="button" :disabled="detecting" @click="detectAgents">
                  {{ detecting ? t('settings.agents.detecting', 'Detecting…') : t('settings.agents.detectAgain', 'Detect again') }}
                </button>
              </div>
              <div class="set-row agent-updates-row" data-test="agent-updates">
                <div class="set-label">
                  {{ t('settings.agents.updates', 'Agent updates') }}
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
                    {{ checkingAgentUpdates ? t('settings.agents.checking', 'Checking…') : t('settings.agents.checkUpdates', 'Check for agent updates') }}
                  </button>
                  <button
                    v-if="updatableCount > 1"
                    class="exit-btn"
                    type="button"
                    data-test="update-all-agents"
                    @click="emit('update-all-agents')"
                  >
                    {{ t('settings.agents.updateAll', 'Update all') }}
                  </button>
                </div>
              </div>
              <label class="set-row">
                <div class="set-label">
                  {{ t('settings.agents.autoUpdate', 'Update agents automatically') }}
                  <span class="set-hint">{{ t('settings.agents.autoUpdateHint', 'When a newer version is found, update it by itself at a safe moment: panes running it are idle, nothing typed in them. They restart in place and resume their conversation') }}</span>
                </div>
                <input v-model="settings.autoUpdateAgents" type="checkbox" class="set-switch" />
              </label>
              <div v-for="a in agents" :key="a.id" class="agent-set" :data-agent="a.id">
                <div class="set-row">
                  <div class="set-label agent-set-name">
                    <BrandIcon :kind="a.id" :size="15" />
                    <span>{{ a.name }}</span>
                    <span class="set-hint">
                      {{ a.available ? t('settings.agents.isInstalled', 'Installed') : t('settings.agents.notFound', 'Not found')
                      }}{{ customized(a.id) ? ' · ' + t('settings.agents.customized', 'customized') : '' }}
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
                      <LoaderCircle v-if="jobRunning(a.id)" :size="11" class="sb-spin agent-update-spinner" aria-hidden="true" />
                      {{ jobText(a.id) }}
                    </div>
                    <div
                      v-if="a.available && lastUpdate(a.id)"
                      class="set-hint agent-update-last"
                      :class="{ 'agent-update-failed': !lastUpdate(a.id).ok }"
                      :data-test="`agent-update-last-${a.id}`"
                    >
                      <span>{{ lastUpdateText(a.id) }}</span>
                      <span v-if="lastUpdateWhy(a)" class="agent-update-why">{{ lastUpdateWhy(a) }}</span>
                      <code v-if="!lastUpdate(a.id).ok && lastUpdate(a.id).detail" class="agent-update-detail">{{ lastUpdate(a.id).detail }}</code>
                      <span class="agent-update-last-actions">
                        <button
                          v-if="jobInUse(a.id)"
                          class="exit-btn"
                          type="button"
                          :data-test="`close-reopen-${a.id}`"
                          @click="emit('close-reopen-agent-update', a.id)"
                        >
                          {{ t('settings.agents.closeReopen', 'Close and reopen them') }}
                        </button>
                        <button
                          v-if="lastUpdate(a.id).file"
                          class="exit-btn"
                          type="button"
                          :data-test="`view-update-log-${a.id}`"
                          @click="emit('open-update-log', lastUpdate(a.id).file)"
                        >
                          {{ t('settings.agents.viewLog', 'View log') }}
                        </button>
                      </span>
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
                      <LoaderCircle v-if="jobRunning(a.id)" :size="11" class="sb-spin agent-update-spinner" aria-hidden="true" />
                      {{ jobActive(a.id) ? t('settings.agents.updating', 'Updating…') : t('settings.agents.update', 'Update') }}
                    </button>
                    <button
                      v-if="a.available && updateRow(a.id) && updateRow(a.id).update && !jobActive(a.id)"
                      class="exit-btn"
                      type="button"
                      :data-test="`update-agent-pane-${a.id}`"
                      :title="t('settings.agents.runInTerminalTitle', 'Run the update in a terminal pane, to see its output as it goes')"
                      @click="emit('update-agent-in-pane', a.id)"
                    >
                      {{ t('settings.agents.runInTerminal', 'Run in a terminal') }}
                    </button>
                    <button
                      v-if="agentUpdateJobs[a.id] && ['waiting-stop', 'restarting'].includes(agentUpdateJobs[a.id].phase)"
                      class="exit-btn"
                      type="button"
                      :title="t('settings.agents.stopWaitingTitle', 'Stop waiting for its panes (they keep running as they are)')"
                      @click="emit('cancel-agent-update', a.id)"
                    >
                      {{ t('settings.agents.stopWaiting', 'Stop waiting') }}
                    </button>
                    <button v-if="AGENT_DOCS[a.id]" class="exit-btn" type="button" @click="openDocs(a.id)">
                      {{ t('settings.agents.docs', 'Docs') }}
                    </button>
                    <button
                      class="exit-btn"
                      type="button"
                      :aria-expanded="openAgent === a.id"
                      @click="openAgent = openAgent === a.id ? null : a.id"
                    >
                      {{ t('settings.agents.customize', 'Customize') }}
                    </button>
                    <input
                      type="checkbox"
                      class="set-switch"
                      :aria-label="t('settings.agents.offerInMenus', 'Offer {{name}} in menus', { name: a.name })"
                      :title="
                        agentEnabled(settings.agentPrefs, a.id)
                          ? t('settings.agents.shownInMenus', 'Shown in menus')
                          : t('settings.agents.hiddenFromMenus', 'Hidden from menus')
                      "
                      :checked="agentEnabled(settings.agentPrefs, a.id)"
                      @change="setAgentPref(a.id, 'enabled', $event.target.checked)"
                    />
                  </div>
                </div>
                <!-- Its default model and effort (Orca's model per agent). -->
                <div v-if="a.available && hasModelDefaults(a.id)" class="agent-models" :data-test="`agent-models-${a.id}`">
                  <label class="agent-model-field">
                    <span class="set-hint">{{ t('settings.agents.defaultModel', 'Model') }}</span>
                    <select
                      class="set-select"
                      :data-test="`agent-model-${a.id}`"
                      @change="setDefaultModel(a.id, $event.target.value)"
                    >
                      <option value="" :selected="!modelDefaults(a.id)">{{ t('pane.sessionOptions.agentDefault', "Agent's own default") }}</option>
                      <option
                        v-for="m in defaultModelRows(a.id)"
                        :key="m.id"
                        :value="m.id"
                        :selected="!!modelDefaults(a.id) && modelDefaults(a.id).model === m.id"
                      >
                        {{ m.label }}
                      </option>
                    </select>
                  </label>
                  <template v-for="o in defaultOptionRows(a.id)" :key="o.id">
                    <label v-if="o.kind.type === 'select'" class="agent-model-field">
                      <span class="set-hint">{{ sessionOptionLabel(o) }}</span>
                      <select
                        class="set-select"
                        :data-test="`agent-option-${a.id}-${o.id}`"
                        @change="setDefaultOption(a.id, o.id, $event.target.value)"
                      >
                        <option value="" :selected="modelDefaults(a.id)[o.id] === undefined">{{ t('pane.sessionOptions.valueIsDefault', 'Default') }}</option>
                        <option v-for="c in o.kind.choices" :key="c.value" :value="c.value" :selected="modelDefaults(a.id)[o.id] === c.value">
                          {{ sessionChoiceLabel(c) }}
                        </option>
                      </select>
                    </label>
                    <label v-else class="agent-model-field agent-model-switch">
                      <span class="set-hint">{{ sessionOptionLabel(o) }}</span>
                      <input
                        type="checkbox"
                        class="set-switch"
                        :data-test="`agent-option-${a.id}-${o.id}`"
                        :checked="modelDefaults(a.id)[o.id] === undefined ? o.kind.defaultValue : modelDefaults(a.id)[o.id] === true"
                        @change="setDefaultOption(a.id, o.id, $event.target.checked)"
                      />
                    </label>
                  </template>
                  <button
                    v-if="canProbeModels(a.id)"
                    class="exit-btn"
                    type="button"
                    :data-test="`agent-models-refresh-${a.id}`"
                    :disabled="probeFor(a.id).busy"
                    :title="t('settings.agents.refreshModelsHint', 'Ask {{name}} which models it offers (it may use its sign-in and the network; no prompt is sent)', { name: a.name })"
                    @click="refreshAgentModels(a)"
                  >
                    <LoaderCircle v-if="probeFor(a.id).busy" :size="11" class="sb-spin agent-update-spinner" aria-hidden="true" />
                    {{ t('settings.agents.refreshModels', 'Refresh models') }}
                  </button>
                  <div class="set-hint agent-models-status" :class="{ 'agent-update-failed': !!probeFor(a.id).error }" :data-test="`agent-models-status-${a.id}`">
                    {{ modelListText(a) }}
                    <template v-if="defaultHasLiveFast(a.id)"> {{ t('settings.agents.fastModeLive', 'Fast mode is switched in a running pane (pane menu > Model).') }}</template>
                    {{ modelDefaults(a.id) ? t('settings.agents.modelApplies', 'Applies to panes you start from now on; running ones show Restart to apply.') : '' }}
                  </div>
                </div>
                <div v-if="openAgent === a.id" class="agent-custom">
                  <label class="agent-field">
                    <span class="set-hint">{{ t('settings.agents.command', 'Command') }}</span>
                    <input
                      class="set-number mcp-input"
                      spellcheck="false"
                      :placeholder="a.command"
                      :value="agentPref(a.id).command || ''"
                      @change="setAgentPref(a.id, 'command', $event.target.value)"
                    />
                  </label>
                  <label class="agent-field">
                    <span class="set-hint">{{ t('settings.agents.arguments', 'Arguments (replace the Yolo option when set)') }}</span>
                    <input
                      class="set-number mcp-input"
                      spellcheck="false"
                      :placeholder="
                        YOLO_ARGS[a.id]
                          ? t('settings.agents.yoloAdds', 'Yolo adds: {{args}}', { args: YOLO_ARGS[a.id] })
                          : t('settings.agents.argsExample', 'e.g. --model …')
                      "
                      :value="agentPref(a.id).args || ''"
                      @change="setAgentPref(a.id, 'args', $event.target.value)"
                    />
                  </label>
                  <label class="agent-field">
                    <span class="set-hint" v-text="envHint(a.id)"></span>
                    <textarea
                      class="set-number mcp-input agent-env"
                      rows="3"
                      spellcheck="false"
                      :value="agentPref(a.id).env || ''"
                      @change="setAgentPref(a.id, 'env', $event.target.value)"
                    ></textarea>
                  </label>
                  <p v-if="envErrors[a.id]" class="mcp-error">
                    {{ envErrors[a.id] }} {{ t('settings.agents.notUsedUntilFixed', 'Not used until fixed.') }}
                  </p>
                  <div class="agent-custom-foot">
                    <span class="set-hint">{{ t('settings.agents.appliesFromNow', 'Applies to panes you start from now on') }}</span>
                    <button class="exit-btn" type="button" :disabled="!customized(a.id)" @click="resetAgent(a.id)">
                      {{ t('settings.agents.reset', 'Reset') }}
                    </button>
                  </div>
                </div>
              </div>
              <!-- The last update attempts (kept by Tessel, at most 20). -->
              <div v-if="updateHistory.length" class="agent-update-history" data-test="agent-update-history">
                <button
                  class="agent-update-history-toggle"
                  type="button"
                  :aria-expanded="historyOpen"
                  @click="historyOpen = !historyOpen"
                >
                  {{ historyOpen ? '▾' : '▸' }}
                  {{ historyTitle }}
                </button>
                <ul v-if="historyOpen" class="agent-update-history-list">
                  <li
                    v-for="(e, i) in updateHistory"
                    :key="`${e.agentId}-${e.at}-${i}`"
                    :class="{ 'agent-update-failed': !e.ok }"
                    data-test="agent-update-history-entry"
                  >
                    <span class="set-hint">{{ whenText(e.at) }}</span>
                    <span>{{ e.name }}</span>
                    <span class="set-hint">{{ versionsText(e) }}</span>
                    <span>{{ updateKindLabel(e.kind) }}</span>
                    <span v-if="e.via === 'pane'" class="set-hint">{{ t('settings.agents.viaPane', 'in a terminal') }}</span>
                    <span v-else-if="e.auto" class="set-hint">{{ t('settings.agents.viaAuto', 'automatic') }}</span>
                    <button v-if="e.file" class="exit-btn" type="button" @click="emit('open-update-log', e.file)">
                      {{ t('settings.agents.viewLog', 'View log') }}
                    </button>
                  </li>
                </ul>
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
            <h3 class="set-group-title">{{ t('settings.orchestration.yourTeam', 'Your team') }}</h3>
            <div class="set-card">
              <p class="set-hint set-card-text">
                {{ t('settings.orchestration.intro', 'Agents in a team (Sessions) coordinate through Tessel: they give each other cards, wait for the cards before theirs, ask and answer, report when done, and ask you to decide. You follow it on the task board.') }}
              </p>
              <div class="agents-head">
                <span class="set-hint">{{ coverageSummary }}</span>
                <span class="agent-set-actions">
                  <button class="exit-btn" type="button" @click="loadCoverage">{{ t('settings.orchestration.checkAgain', 'Check again') }}</button>
                  <button class="exit-btn" type="button" @click="emit('open-connections')">{{ t('settings.orchestration.details', 'Details') }}</button>
                </span>
              </div>
              <div v-if="Array.isArray(coverage) && coverage.length" class="orch-coverage">
                <span v-for="r in coverage" :key="r.id" class="orch-chip" :class="r.state" :data-agent="r.id">
                  <BrandIcon :kind="r.id" :size="13" />{{ r.name }}:
                  {{
                    r.state === 'ready'
                      ? t('settings.orchestration.ready', 'ready')
                      : r.state === 'approval'
                        ? t('settings.orchestration.needsApproval', 'needs your approval')
                        : t('settings.orchestration.notSetUp', 'not set up')
                  }}
                </span>
              </div>
              <label class="set-row">
                <div class="set-label">
                  {{ t('settings.orchestration.wakeUps', 'Wake idle agents for team messages') }}
                  <span class="set-hint">{{ t('settings.orchestration.wakeUpsHint', 'Types a one-line reminder in an idle agent\'s terminal, never while you are in that pane or typing there (nothing else can start an idle agent). Off: messages wait until the agent next works') }}</span>
                </div>
                <input v-model="settings.teamWakeUps" type="checkbox" class="set-switch" />
              </label>
              <label class="set-row" :class="{ 'set-disabled': !settings.teamWakeUps }">
                <div class="set-label">
                  {{ t('settings.orchestration.wakeUnconfirmed', 'Wake agents even without confirmation (like other tools)') }}
                  <span class="set-hint">{{ t('settings.orchestration.wakeUnconfirmedHint', 'Also types the reminder into an agent whose hooks have not confirmed it is idle yet (a Codex relaunched in place), with the same checks: never while you type there, over a draft, an approval or an unsent line. Off: Tessel asks you first') }}</span>
                  <span v-if="settings.teamWakeUnconfirmed" class="set-hint set-warn" data-wake-unconfirmed-warning="">{{ t('settings.orchestration.wakeUnconfirmedWarn', 'Risk: without that confirmation the line could land in a program that crashed or at a bad moment in the agent.') }}</span>
                </div>
                <input v-model="settings.teamWakeUnconfirmed" type="checkbox" class="set-switch" data-setting="teamWakeUnconfirmed" :disabled="!settings.teamWakeUps" />
              </label>
            </div>
          </div>
          <!-- Coordinator and workers (Orca's orchestration): the setup card,
               then the limits and the confirmation. -->
          <div class="set-group" data-orch-workers="">
            <h3 class="set-group-title">{{ t('settings.orchestration.workers', 'Coordinator and workers') }}</h3>
            <div class="set-card">
              <p class="set-hint set-card-text">
                {{ t('settings.orchestration.workersIntro', 'A team lead can start workers: new agents in new panes of its project, each with its own card, brief and, by default, its own copy of the project. They join the team, report when done and send a heartbeat while they work. You see each start on the board and in Activity.') }}
              </p>
              <p class="set-hint set-card-text" data-orch-trust="">
                {{ t('settings.orchestration.trust', 'Each worker request is signed with a secret only its pane has, and Tessel checks who sent it and whether it may still do it; answers (like what a worker shows) are encrypted for the agent that asked. This keeps one agent from posing as another by mistake or on the cheap. All agents run as your Windows user, so it cannot stop a determined program running as you.') }}
              </p>
              <ol class="orch-setup" data-orch-setup="">
                <li :class="{ ok: workerAgentsReady.length > 0 }" v-text="workerAgentsLine"></li>
                <li>{{ t('settings.orchestration.setupTeam', 'Make a team in Sessions and choose its lead (right-click an agent, Make Lead)') }}</li>
                <li>{{ t('settings.orchestration.setupAsk', 'Ask the lead to coordinate workers (see "Coordinate workers" below)') }}</li>
              </ol>
              <label class="set-row">
                <div class="set-label">
                  {{ t('settings.orchestration.confirmWorkers', 'Ask before an agent starts workers') }}
                  <span class="set-hint">{{ t('settings.orchestration.confirmWorkersHint', 'Each worker waits in the Tasks panel until you allow it. Off: workers start at once, within the limits below') }}</span>
                </div>
                <input v-model="settings.orchestrationConfirmWorkers" type="checkbox" class="set-switch" data-setting="orchestrationConfirmWorkers" />
              </label>
              <div class="set-row">
                <label class="set-label" for="settings-orch-max">
                  {{ t('settings.orchestration.maxWorkers', 'Workers at a time') }}
                  <span class="set-hint" v-text="maxWorkersHint"></span>
                </label>
                <input
                  id="settings-orch-max"
                  class="set-number"
                  type="number"
                  min="1"
                  :max="MAX_CONCURRENT_LIMIT"
                  :value="settings.orchestrationMaxWorkers"
                  data-setting="orchestrationMaxWorkers"
                  @change="setOrchestrationNumber('orchestrationMaxWorkers', MAX_CONCURRENT_LIMIT, $event)"
                />
              </div>
              <div class="set-row">
                <label class="set-label" for="settings-orch-depth">
                  {{ t('settings.orchestration.maxDepth', 'Nested worker depth') }}
                  <span class="set-hint" v-text="maxDepthHint"></span>
                </label>
                <input
                  id="settings-orch-depth"
                  class="set-number"
                  type="number"
                  min="1"
                  :max="NESTED_DEPTH_LIMIT"
                  :value="settings.orchestrationMaxDepth"
                  data-setting="orchestrationMaxDepth"
                  @change="setOrchestrationNumber('orchestrationMaxDepth', NESTED_DEPTH_LIMIT, $event)"
                />
              </div>
              <div class="set-row">
                <label class="set-label" for="settings-orch-mode">
                  {{ t('settings.orchestration.workerMode', 'Mode for new workers') }}
                  <span class="set-hint">{{
                    t('settings.orchestration.workerModeHint', 'Claude and Codex can work in a chat pane, without a terminal. Other agents use a terminal pane. This applies to the next workers; it does not change those already open.')
                  }}</span>
                </label>
                <select id="settings-orch-mode" v-model="settings.orchestrationWorkerMode" class="set-select" data-setting="orchestrationWorkerMode">
                  <option value="terminal">{{ t('settings.orchestration.workerModeTerminal', 'A terminal pane') }}</option>
                  <option value="chat">{{ t('settings.orchestration.workerModeChat', 'A chat pane (Claude, Codex)') }}</option>
                </select>
              </div>
            </div>
          </div>
          <div class="set-group">
            <h3 class="set-group-title">{{ t('settings.orchestration.tools', 'The team tools') }}</h3>
            <div class="set-card">
              <ul class="orch-tools">
                <li v-for="[name, what] in ORCHESTRATION_TOOLS" :key="name"><code>{{ name }}</code> {{ what }}</li>
              </ul>
            </div>
          </div>
          <div class="set-group">
            <h3 class="set-group-title">{{ t('settings.orchestration.howTo', 'How to use it') }}</h3>
            <div class="set-card">
              <p class="set-hint set-card-text">
                {{ t('settings.orchestration.howToIntro', 'Tell the agent that leads the team, in your own words, for example:') }}
              </p>
              <div v-for="ex in ORCHESTRATION_EXAMPLES" :key="ex.id" class="orch-example">
                <div class="set-label">
                  {{ ex.title }}
                  <span class="set-hint">{{ ex.prompt }}</span>
                </div>
                <button class="exit-btn" type="button" @click="copyExample(ex)">
                  {{ copiedExample === ex.id ? t('settings.orchestration.copied', 'Copied') : t('settings.orchestration.copy', 'Copy') }}
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
                  {{ t('settings.voice.language', 'Language') }}
                  <span class="set-hint">{{ t('settings.voice.languageHint', 'Windows dictation listens in one language. The mic button switches to this one first. Add languages in Windows Settings, Time & language.') }}</span>
                </label>
                <select
                  id="settings-language"
                  v-model="settings.voiceTip"
                  class="set-select"
                  @change="settings.voiceTipChosen = true"
                >
                  <option value="">{{ t('settings.voice.currentKeyboard', 'Current keyboard language') }}</option>
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
                  {{ t('settings.general.restore', 'Reopen my workspaces at launch') }}
                  <span class="set-hint">{{ t('settings.general.restoreHint', 'Off starts with a single terminal') }}</span>
                </div>
                <input v-model="settings.restoreWorkspaces" type="checkbox" class="set-switch" />
              </label>
              <label class="set-row">
                <div class="set-label">
                  {{ t('settings.general.confirmClose', 'Confirm before closing running terminals') }}
                  <span class="set-hint">{{ t('settings.general.confirmCloseHint', 'Ask before stopping a running agent or command when closing a terminal.') }}</span>
                </div>
                <input v-model="settings.confirmCloseAgent" type="checkbox" class="set-switch" />
              </label>
            </div>
          </div>
          <!-- The tessel command (Settings > General, as Orca's CLI section). -->
          <CliSettings v-if="page === 'general' || searching" />
          <div class="set-group">
            <h3 class="set-group-title">{{ t('settings.general.workspace', 'Workspace') }}</h3>
            <div class="set-card">
              <p class="set-hint set-card-text">{{ t('settings.general.workspaceIntro', 'Configure where new workspaces are created.') }}</p>
              <div class="set-row">
                <label class="set-label" for="settings-workspace-dir">
                  {{ t('settings.general.workspaceDir', 'Workspace Directory') }}
                  <span class="set-hint">{{ t('settings.general.workspaceDirHint', 'Root directory where workspace folders are created. Use a relative path (e.g. .tessel/worktrees) for a per-project location, or an absolute path for one shared folder. Empty: next to the project, in <project>.worktrees.') }}</span>
                </label>
                <div class="set-inline">
                  <input
                    id="settings-workspace-dir"
                    class="set-number mcp-input"
                    spellcheck="false"
                    :placeholder="t('settings.general.workspaceDirPlaceholder', '<project>.worktrees')"
                    :value="settings.workspaceDir"
                    @change="settings.workspaceDir = $event.target.value.trim()"
                  />
                  <button
                    class="exit-btn"
                    type="button"
                    :disabled="!settings.workspaceDir"
                    @click="settings.workspaceDir = ''"
                  >
                    {{ t('settings.common.reset', 'Reset') }}
                  </button>
                </div>
              </div>
              <label class="set-row">
                <div class="set-label">
                  {{ t('settings.general.confirmDelete', 'Ask Before Deleting Workspaces') }}
                  <span class="set-hint">{{ t('settings.general.confirmDeleteHint', 'Show a confirmation before deleting a workspace from the context menu. Unsaved files are always asked about.') }}</span>
                </div>
                <input v-model="settings.confirmDeleteWorkspace" type="checkbox" class="set-switch" />
              </label>
            </div>
          </div>
          <div class="set-group">
            <h3 class="set-group-title">{{ t('settings.general.resetGroup', 'Reset') }}</h3>
            <div class="set-card">
              <div class="set-row set-foot">
                <div class="set-label">
                  {{ t('settings.general.resetAll', 'Reset every setting') }}
                  <span class="set-hint">{{ t('settings.general.resetAllHint', 'Changes apply right away and are saved. This puts every setting back to its default') }}</span>
                </div>
                <button class="exit-btn" type="button" @click="resetSettings">{{ t('settings.general.resetToDefaults', 'Reset to defaults') }}</button>
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
              <div class="set-row" data-setting="ui-language">
                <label class="set-label" for="appearance-language">
                  {{ t('settings.language.title', 'Language') }}
                  <span class="set-hint">{{
                    t('settings.language.hint', "The language of Tessel's interface. System follows Windows.")
                  }}</span>
                </label>
                <select id="appearance-language" v-model="settings.uiLanguage" class="set-select">
                  <option v-for="lang in UI_LANGUAGES" :key="lang.value" :value="lang.value">
                    {{ t(lang.key, lang.label) }}
                  </option>
                </select>
              </div>
              <div class="set-row">
                <label class="set-label" for="appearance-theme">
                  {{ t('settings.appearance.theme', 'Theme') }}
                  <span class="set-hint">{{ t('settings.appearance.themeHint', 'Applies immediately. Your sessions keep running.') }}</span>
                </label>
                <select id="appearance-theme" v-model="settings.theme" class="set-select">
                  <option v-for="theme in THEMES" :key="theme.id" :value="theme.id">
                    {{ theme.label }}
                  </option>
                </select>
              </div>
              <div class="set-row" data-setting="ui-zoom">
                <div class="set-label">
                  {{ t('settings.appearance.zoom', 'UI Zoom') }}
                  <span class="set-hint">{{ t('settings.appearance.zoomHint', 'Scale the entire application interface.') }}</span>
                </div>
                <div class="set-inline">
                  <div class="set-stepper">
                    <button
                      type="button"
                      :title="t('settings.appearance.zoomOut', 'Zoom out')"
                      :aria-label="t('settings.appearance.zoomOut', 'Zoom out')"
                      :disabled="settings.uiZoomLevel <= LIMITS.uiZoomLevel[0]"
                      @click="zoom('out')"
                    >
                      −
                    </button>
                    <span data-test="ui-zoom-percent">{{ zoomPercent }}%</span>
                    <button
                      type="button"
                      :title="t('settings.appearance.zoomIn', 'Zoom in')"
                      :aria-label="t('settings.appearance.zoomIn', 'Zoom in')"
                      :disabled="settings.uiZoomLevel >= LIMITS.uiZoomLevel[1]"
                      @click="zoom('in')"
                    >
                      +
                    </button>
                  </div>
                  <button class="exit-btn" type="button" :disabled="settings.uiZoomLevel === 0" @click="zoom('reset')">
                    {{ t('settings.common.reset', 'Reset') }}
                  </button>
                </div>
              </div>
            </div>
          </div>
          <div class="set-group">
            <h3 class="set-group-title">{{ t('settings.appearance.terminalPanes', 'Terminal Panes') }}</h3>
            <div class="set-card">
              <div class="set-row">
                <label class="set-label" for="settings-inactive-opacity">
                  {{ t('settings.appearance.inactiveOpacity', 'Inactive Pane Opacity') }}
                  <span class="set-hint">{{ t('settings.appearance.inactiveOpacityHint', 'Dim unfocused panes. 0-1') }}</span>
                </label>
                <input
                  id="settings-inactive-opacity"
                  class="set-number"
                  type="number"
                  min="0"
                  max="1"
                  step="0.05"
                  :value="settings.inactivePaneOpacity"
                  @change="setNumber('inactivePaneOpacity', $event)"
                />
              </div>
              <div class="set-row">
                <label class="set-label" for="settings-divider">
                  {{ t('settings.appearance.divider', 'Divider Thickness') }}
                  <span class="set-hint">{{ t('settings.appearance.dividerHint', 'Thickness of the pane divider line. px') }}</span>
                </label>
                <input
                  id="settings-divider"
                  class="set-number"
                  type="number"
                  min="1"
                  max="32"
                  step="1"
                  :value="settings.dividerThickness"
                  @change="setNumber('dividerThickness', $event, true)"
                />
              </div>
            </div>
          </div>
          <div class="set-group">
            <h3 class="set-group-title">{{ t('settings.appearance.window', 'Window') }}</h3>
            <div class="set-card">
              <p class="set-hint set-card-text">{{ t('settings.appearance.windowIntro', 'Window appearance and background settings.') }}</p>
              <div class="set-row">
                <label class="set-label" for="settings-pad-x">
                  {{ t('settings.appearance.padX', 'Horizontal Padding') }}
                  <span class="set-hint">{{ t('settings.appearance.padXHint', 'Horizontal padding around the terminal grid in pixels.') }}</span>
                </label>
                <input
                  id="settings-pad-x"
                  class="set-number"
                  type="number"
                  min="0"
                  max="512"
                  step="1"
                  :value="settings.terminalPaddingX"
                  @change="setNumber('terminalPaddingX', $event, true)"
                />
              </div>
              <div class="set-row">
                <label class="set-label" for="settings-pad-y">
                  {{ t('settings.appearance.padY', 'Vertical Padding') }}
                  <span class="set-hint">{{ t('settings.appearance.padYHint', 'Vertical padding around the terminal grid in pixels.') }}</span>
                </label>
                <input
                  id="settings-pad-y"
                  class="set-number"
                  type="number"
                  min="0"
                  max="512"
                  step="1"
                  :value="settings.terminalPaddingY"
                  @change="setNumber('terminalPaddingY', $event, true)"
                />
              </div>
              <label class="set-row">
                <div class="set-label">{{ t('settings.appearance.hideMouse', 'Hide Mouse While Typing') }}</div>
                <input v-model="settings.hideMouseWhileTyping" type="checkbox" class="set-switch" />
              </label>
            </div>
          </div>
          <div class="set-group">
            <h3 class="set-group-title">{{ t('settings.appearance.windowSidebar', 'Window & Sidebar') }}</h3>
            <div class="set-card">
              <div class="set-row">
                <div id="settings-usage-pct-label" class="set-label">
                  {{ t('settings.appearance.usagePct', 'Usage percentages') }}
                  <span class="set-hint">{{ t('settings.appearance.usagePctHint', 'Choose whether provider limits show the percentage used or remaining.') }}</span>
                </div>
                <div class="launch-seg set-seg" role="group" aria-labelledby="settings-usage-pct-label">
                  <button
                    v-for="o in [
                      { id: 'used', label: t('settings.appearance.used', 'Used') },
                      { id: 'remaining', label: t('settings.appearance.remaining', 'Remaining') }
                    ]"
                    :key="o.id"
                    type="button"
                    class="launch-seg-btn"
                    :class="{ on: settings.usagePercentageDisplay === o.id }"
                    :aria-pressed="settings.usagePercentageDisplay === o.id"
                    @click="settings.usagePercentageDisplay = o.id"
                  >
                    {{ o.label }}
                  </button>
                </div>
              </div>
              <div class="set-row">
                <div id="settings-usage-refresh-label" class="set-label">
                  {{ t('settings.appearance.usageRefresh', 'Usage refresh') }}
                  <span class="set-hint">{{ t('settings.appearance.usageRefreshHint', 'How often provider limits are read again while Tessel is in use. Off: only when you open Usage.') }}</span>
                </div>
                <div class="launch-seg set-seg" role="group" aria-labelledby="settings-usage-refresh-label">
                  <button
                    v-for="m in USAGE_REFRESH_MINUTES"
                    :key="m"
                    type="button"
                    class="launch-seg-btn"
                    :class="{ on: settings.usageRefreshMinutes === m }"
                    :aria-pressed="settings.usageRefreshMinutes === m"
                    @click="settings.usageRefreshMinutes = m"
                  >
                    {{ usageRefreshLabel(m) }}
                  </button>
                </div>
              </div>
              <label class="set-row">
                <div class="set-label">
                  {{ t('settings.appearance.gitIgnored', 'Show Git-Ignored Files') }}
                  <span class="set-hint">{{ t('settings.appearance.gitIgnoredHint', 'Files matched by .gitignore.') }}</span>
                </div>
                <input v-model="settings.showGitIgnoredFiles" type="checkbox" class="set-switch" />
              </label>
              <!-- Orca's Appearance > Window & Sidebar (same section). -->
              <div class="set-row">
                <div id="settings-sidebar-appearance-label" class="set-label">
                  {{ t('settings.appearance.sidebar', 'Left Sidebar Appearance') }}
                  <span class="set-hint">{{ t('settings.appearance.sidebarHint', 'Make the left sidebar match your terminal, stay default, or use a tint.') }}</span>
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
                    {{ t('settings.appearance.tint', 'Sidebar Tint') }}
                    <span class="set-hint">{{ t('settings.appearance.tintHint', 'The color mixed into the left sidebar surface.') }}</span>
                  </div>
                  <input v-model="settings.leftSidebarTintColor" type="color" class="set-color" :aria-label="t('settings.appearance.tint', 'Sidebar Tint')" />
                </label>
                <label class="set-row">
                  <div class="set-label">
                    {{ t('settings.appearance.tintStrength', 'Tint Strength') }}
                    <span
                      class="set-hint"
                      v-text="t('settings.appearance.tintStrengthHint', 'Controls how strongly the tint is mixed into the sidebar. 0 to {{max}}', { max: MAX_LEFT_SIDEBAR_TINT_OPACITY })"
                    ></span>
                  </div>
                  <input
                    type="number"
                    class="set-number"
                    min="0"
                    :max="MAX_LEFT_SIDEBAR_TINT_OPACITY"
                    step="0.01"
                    :value="settings.leftSidebarTintOpacity"
                    :aria-label="t('settings.appearance.tintStrength', 'Tint Strength')"
                    @change="setTintOpacity"
                  />
                </label>
              </template>
              <label class="set-row">
                <div class="set-label">
                  {{ t('settings.appearance.statusBarVisible', 'Show Status Bar') }}
                  <span class="set-hint">{{ t('settings.appearance.statusBarVisibleHint', 'The bar at the bottom of the window.') }}</span>
                </div>
                <input v-model="settings.statusBarVisible" type="checkbox" class="set-switch" />
              </label>
              <div class="set-row">
                <div class="set-label">
                  {{ t('settings.appearance.statusBar', 'Status Bar') }}
                  <span class="set-hint">{{ t('settings.appearance.statusBarHint', 'Choose which indicators appear in the status bar.') }}</span>
                </div>
              </div>
              <label v-for="item in STATUS_BAR_TOGGLES" :key="item.id" class="set-row set-row-nested">
                <div class="set-label">
                  {{ item.title }}
                  <span class="set-hint">{{ item.description }}</span>
                </div>
                <input
                  type="checkbox"
                  class="set-switch"
                  :checked="settings.statusBarItems.includes(item.id)"
                  :aria-label="item.title"
                  @change="toggleStatusBarItem(item.id)"
                />
              </label>
            </div>
          </div>
          <div class="set-group">
            <h3 class="set-group-title">{{ t('settings.appearance.sidebarGroup', 'Sidebar') }}</h3>
            <div class="set-card">
              <div class="set-row">
                <div id="settings-card-layout-label" class="set-label">
                  {{ t('settings.appearance.cardLayout', 'Workspace Card Layout') }}
                  <span class="set-hint">{{ t('settings.appearance.cardLayoutHint', 'Workspace cards can use compact or detailed layouts.') }}</span>
                </div>
                <div class="launch-seg set-seg" role="group" aria-labelledby="settings-card-layout-label">
                  <button
                    class="launch-seg-btn"
                    :class="{ on: !settings.compactWorktreeCards }"
                    :aria-pressed="!settings.compactWorktreeCards"
                    @click="settings.compactWorktreeCards = false"
                  >
                    {{ t('settings.appearance.detailed', 'Detailed') }}
                  </button>
                  <button
                    class="launch-seg-btn"
                    :class="{ on: settings.compactWorktreeCards }"
                    :aria-pressed="settings.compactWorktreeCards"
                    @click="settings.compactWorktreeCards = true"
                  >
                    {{ t('settings.appearance.compact', 'Compact') }}
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
                  {{ t('settings.text.font', 'Font') }}
                  <span class="set-hint">{{ t('settings.text.fontHint', 'The typeface of every terminal') }}</span>
                </label>
                <select id="settings-font" v-model="settings.fontFamily" class="set-select">
                  <option v-for="f in FONT_FAMILIES" :key="f" :value="f">{{ f }}</option>
                </select>
              </div>
              <div class="set-row">
                <div class="set-label">
                  {{ t('settings.text.size', 'Size') }}
                  <span class="set-hint">{{ t('settings.text.sizeHint', 'Also Ctrl+= and Ctrl+-') }}</span>
                </div>
                <div class="set-stepper">
                  <button :title="t('settings.text.smaller', 'Smaller')" @click="stepFont(-1)">−</button>
                  <span>{{ settings.fontSize }}</span>
                  <button :title="t('settings.text.bigger', 'Bigger')" @click="stepFont(1)">+</button>
                </div>
              </div>
              <div class="set-row">
                <div id="settings-cursor-label" class="set-label">{{ t('settings.text.cursor', 'Cursor') }}</div>
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
                <div class="set-label">{{ t('settings.text.blink', 'Blinking cursor') }}</div>
                <input v-model="settings.cursorBlink" type="checkbox" class="set-switch" />
              </label>
              <div class="set-row">
                <label class="set-label" for="settings-cursor-opacity">
                  {{ t('settings.text.cursorOpacity', 'Cursor Opacity') }}
                  <span class="set-hint">{{ t('settings.text.cursorOpacityHint', 'Opacity of the terminal cursor. 0-1') }}</span>
                </label>
                <input
                  id="settings-cursor-opacity"
                  class="set-number"
                  type="number"
                  min="0"
                  max="1"
                  step="0.05"
                  :value="settings.cursorOpacity"
                  @change="setNumber('cursorOpacity', $event)"
                />
              </div>
            </div>
          </div>
          <div class="set-group">
            <h3 class="set-group-title">{{ t('settings.text.typography', 'Terminal Typography') }}</h3>
            <div class="set-card">
              <div class="set-row">
                <label class="set-label" for="settings-font-weight">
                  {{ t('settings.text.fontWeight', 'Font Weight') }}
                  <span class="set-hint">{{ t('settings.text.fontWeightHint', 'Controls the terminal text font weight. 100-900') }}</span>
                </label>
                <input
                  id="settings-font-weight"
                  class="set-number"
                  type="number"
                  min="100"
                  max="900"
                  step="100"
                  :value="settings.fontWeight"
                  @change="setNumber('fontWeight', $event, true)"
                />
              </div>
              <div class="set-row">
                <label class="set-label" for="settings-font-weight-bold">
                  {{ t('settings.text.boldWeight', 'Bold Font Weight') }}
                  <span class="set-hint">{{ t('settings.text.boldWeightHint', 'Adjust independently from Font Weight. Some fonts map several values to one face, so lower Font Weight or choose another font if bold looks unchanged. 100-900') }}</span>
                </label>
                <input
                  id="settings-font-weight-bold"
                  class="set-number"
                  type="number"
                  min="100"
                  max="900"
                  step="100"
                  :value="settings.fontWeightBold"
                  @change="setNumber('fontWeightBold', $event, true)"
                />
              </div>
              <div class="set-row">
                <label class="set-label" for="settings-line-height">
                  {{ t('settings.text.lineHeight', 'Line Height') }}
                  <span class="set-hint">{{ t('settings.text.lineHeightHint', 'Controls the terminal line height multiplier. 1-3') }}</span>
                </label>
                <input
                  id="settings-line-height"
                  class="set-number"
                  type="number"
                  min="1"
                  max="3"
                  step="0.1"
                  :value="settings.lineHeight"
                  @change="setNumber('lineHeight', $event)"
                />
              </div>
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
            <h3 class="set-group-title">{{ t('settings.terminal.shell', 'Shell') }}</h3>
            <div class="set-card">
              <div class="set-row">
                <label class="set-label" for="settings-shell">
                  {{ t('settings.terminal.defaultShell', 'Default shell') }} <span class="set-hint">{{ t('settings.terminal.defaultShellHint', 'Agents run in it too') }}</span>
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
                  {{ t('settings.terminal.scrollback', 'Scrollback lines') }} <span class="set-hint">{{ t('settings.terminal.scrollbackHint', 'Applies to new panes') }}</span>
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
            </div>
          </div>
          <div class="set-group">
            <h3 class="set-group-title">{{ t('settings.terminal.rendering', 'Rendering') }}</h3>
            <div class="set-card">
              <p class="set-hint set-card-text">{{ t('settings.terminal.renderingIntro', 'Terminal renderer behavior for live panes and new panes.') }}</p>
              <div class="set-row">
                <div id="settings-gpu-label" class="set-label">
                  {{ t('settings.terminal.gpu', 'GPU Acceleration') }}
                  <span class="set-hint">{{ gpuHint }}</span>
                </div>
                <div class="launch-seg set-seg" role="group" aria-labelledby="settings-gpu-label">
                  <button
                    v-for="m in GPU_MODES"
                    :key="m.id"
                    type="button"
                    class="launch-seg-btn"
                    :class="{ on: settings.gpuAcceleration === m.id }"
                    :aria-pressed="settings.gpuAcceleration === m.id"
                    @click="settings.gpuAcceleration = m.id"
                  >
                    {{ m.label }}
                  </button>
                </div>
              </div>
              <div class="set-row">
                <div id="settings-contrast-label" class="set-label">
                  {{ t('settings.terminal.contrast', 'Color Contrast') }}
                  <span class="set-hint">{{ contrastHint }}</span>
                </div>
                <div class="launch-seg set-seg" role="group" aria-labelledby="settings-contrast-label">
                  <button
                    v-for="m in CONTRAST_MODES"
                    :key="m.id"
                    type="button"
                    class="launch-seg-btn"
                    :class="{ on: contrastMode === m.id }"
                    :aria-pressed="contrastMode === m.id"
                    @click="setContrastMode(m.id)"
                  >
                    {{ m.label }}
                  </button>
                </div>
              </div>
              <div v-if="contrastMode === 'custom'" class="set-row">
                <label class="set-label" for="settings-contrast-ratio">
                  {{ t('settings.terminal.contrastTarget', 'Contrast target') }}
                  <span class="set-hint">{{ t('settings.terminal.contrastTargetHint', 'Higher values increase contrast where possible. Background colors stay unchanged.') }}</span>
                </label>
                <div class="set-inline">
                  <input
                    class="set-range"
                    type="range"
                    min="1.1"
                    max="21"
                    step="0.1"
                    :aria-label="t('settings.terminal.contrastTarget', 'Contrast target')"
                    :value="settings.minimumContrastRatio"
                    @input="setRange('minimumContrastRatio', $event)"
                  />
                  <input
                    id="settings-contrast-ratio"
                    class="set-number set-number-short"
                    type="number"
                    min="1"
                    max="21"
                    step="0.1"
                    :value="settings.minimumContrastRatio"
                    @change="setNumber('minimumContrastRatio', $event)"
                  />
                </div>
              </div>
            </div>
          </div>
          <div class="set-group">
            <h3 class="set-group-title">{{ t('settings.terminal.copyPaste', 'Copy and paste') }}</h3>
            <div class="set-card">
              <label class="set-row">
                <div class="set-label">{{ t('settings.terminal.copyOnSelect', 'Copy text when you select it') }}</div>
                <input v-model="settings.copyOnSelect" type="checkbox" class="set-switch" />
              </label>
              <label class="set-row">
                <div class="set-label">
                  {{ t('settings.terminal.rightClickPaste', 'Right-click pastes') }}
                  <span class="set-hint">{{ t('settings.terminal.rightClickPasteHint', 'Pastes the selection, or the clipboard. Shift+right-click opens the menu') }}</span>
                </div>
                <input v-model="settings.rightClickPaste" type="checkbox" class="set-switch" />
              </label>
              <label class="set-row">
                <div class="set-label">
                  {{ t('settings.terminal.confirmMultiline', 'Ask before pasting several lines') }}
                  <span class="set-hint">{{ t('settings.terminal.confirmMultilineHint', 'So an accidental paste can\'t run commands') }}</span>
                </div>
                <input v-model="settings.confirmMultilinePaste" type="checkbox" class="set-switch" />
              </label>
              <label class="set-row">
                <div class="set-label">
                  {{ t('settings.terminal.alwaysSelect', 'Always select with the mouse') }}
                  <span class="set-hint">{{ t('settings.terminal.alwaysSelectHint', 'Even in programs that use the mouse (GitHub Copilot, htop). They no longer get clicks or the wheel. Otherwise, hold Shift to select') }}</span>
                </div>
                <input v-model="settings.alwaysSelect" type="checkbox" class="set-switch" />
              </label>
            </div>
          </div>
          <div class="set-group">
            <h3 class="set-group-title">{{ t('settings.terminal.interaction', 'Terminal Interaction') }}</h3>
            <div class="set-card">
              <p class="set-hint set-card-text">{{ t('settings.terminal.interactionIntro', 'Mouse and clipboard behavior for terminal panes.') }}</p>
              <div class="set-row">
                <div class="set-label">
                  {{ t('settings.terminal.scrollSpeed', 'Scroll Speed') }}
                  <span class="set-hint">{{ t('settings.terminal.scrollSpeedHint', 'Adjust how wheel input feels in scrollback and in mouse-aware terminal apps.') }}</span>
                </div>
                <button class="exit-btn" type="button" @click="resetScrollSpeed">{{ t('settings.common.reset', 'Reset') }}</button>
              </div>
              <div class="set-row">
                <label class="set-label" for="settings-scroll-normal">
                  {{ t('settings.terminal.scrollNormal', 'Normal') }}
                  <span class="set-hint">{{ t('settings.terminal.scrollNormalHint', 'Scrollback wheel multiplier.') }}</span>
                </label>
                <div class="set-inline">
                  <input
                    class="set-range"
                    type="range"
                    min="0.5"
                    max="3"
                    step="0.05"
                    :aria-label="t('settings.terminal.scrollNormalLabel', 'Normal scroll speed')"
                    :value="settings.scrollSensitivity"
                    @input="setRange('scrollSensitivity', $event)"
                  />
                  <input
                    id="settings-scroll-normal"
                    class="set-number set-number-short"
                    type="number"
                    min="0.5"
                    max="3"
                    step="0.05"
                    :value="settings.scrollSensitivity"
                    @change="setNumber('scrollSensitivity', $event)"
                  />
                </div>
              </div>
              <div class="set-row">
                <label class="set-label" for="settings-scroll-fast">
                  {{ t('settings.terminal.scrollFast', 'Fast') }}
                  <span class="set-hint">{{ t('settings.terminal.scrollFastHint', 'Extra multiplier while scrolling with a modifier key.') }}</span>
                </label>
                <div class="set-inline">
                  <input
                    class="set-range"
                    type="range"
                    min="1"
                    max="10"
                    step="0.5"
                    :aria-label="t('settings.terminal.scrollFastLabel', 'Fast scroll speed')"
                    :value="settings.fastScrollSensitivity"
                    @input="setRange('fastScrollSensitivity', $event)"
                  />
                  <input
                    id="settings-scroll-fast"
                    class="set-number set-number-short"
                    type="number"
                    min="1"
                    max="10"
                    step="0.5"
                    :value="settings.fastScrollSensitivity"
                    @change="setNumber('fastScrollSensitivity', $event)"
                  />
                </div>
              </div>
              <label class="set-row">
                <div class="set-label">
                  {{ t('settings.terminal.focusFollowsMouse', 'Focus Follows Mouse') }}
                  <span class="set-hint">{{ t('settings.terminal.focusFollowsMouseHint', 'Hovering a terminal pane activates it without needing to click.') }}</span>
                </div>
                <input v-model="settings.focusFollowsMouse" type="checkbox" class="set-switch" />
              </label>
              <label class="set-row">
                <div class="set-label">
                  {{ t('settings.terminal.trimGutter', 'Trim Gutter on Copy') }}
                  <span class="set-hint">{{ t('settings.terminal.trimGutterHint', 'Drop the left gutter agent output is painted behind, so copied text is not indented. Only the indent every selected line shares is removed.') }}</span>
                </div>
                <input v-model="settings.copyTrimsGutter" type="checkbox" class="set-switch" />
              </label>
              <label class="set-row">
                <div class="set-label">
                  {{ t('settings.terminal.osc52', 'Allow TUI Clipboard Writes (OSC 52)') }}
                  <span class="set-hint">{{ t('settings.terminal.osc52Hint', 'Let programs in the terminal (Zellij, tmux, Neovim, fzf, Grok, SSH) copy to your system clipboard.') }}</span>
                </div>
                <input v-model="settings.allowOsc52Clipboard" type="checkbox" class="set-switch" />
              </label>
            </div>
          </div>
          <div class="set-group">
            <h3 class="set-group-title">{{ t('settings.terminal.advanced', 'Advanced') }}</h3>
            <div class="set-card">
              <p class="set-hint set-card-text">{{ t('settings.terminal.advancedIntro', 'Scrollback, word boundaries, and platform-specific terminal behaviors.') }}</p>
              <div class="set-row">
                <label class="set-label" for="settings-word-separators">
                  {{ t('settings.terminal.wordSeparators', 'Word Separators') }}
                  <span class="set-hint">{{ t('settings.terminal.wordSeparatorsHint', 'Characters treated as word boundaries for double-click selection.') }}</span>
                </label>
                <input
                  id="settings-word-separators"
                  class="set-number mcp-input set-mono"
                  spellcheck="false"
                  :placeholder="DEFAULT_WORD_SEPARATOR"
                  :value="settings.wordSeparator"
                  @input="settings.wordSeparator = $event.target.value"
                />
              </div>
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
                  {{ t('settings.alerts.enable', 'Enable Notifications') }}
                  <span class="set-hint">{{ t('settings.alerts.enableHint', 'Native system notifications for background events.') }}</span>
                </div>
                <input v-model="settings.notificationsEnabled" type="checkbox" class="set-switch" />
              </label>
              <label class="set-row" :class="{ 'set-disabled': !settings.notificationsEnabled }">
                <div class="set-label">
                  {{ t('settings.alerts.windows', 'Windows notifications') }}
                  <span class="set-hint">{{ t('settings.alerts.windowsHint', 'When an agent finishes while the app is in the background') }}</span>
                </div>
                <input
                  v-model="settings.desktopNotifications"
                  type="checkbox"
                  class="set-switch"
                  :disabled="!settings.notificationsEnabled"
                />
              </label>
              <label class="set-row" :class="{ 'set-disabled': !settings.notificationsEnabled }">
                <div class="set-label">
                  {{ t('settings.alerts.bell', 'Terminal Bell') }}
                  <span class="set-hint">{{ t('settings.alerts.bellHint', 'A background terminal emits a bell character.') }}</span>
                </div>
                <input
                  v-model="settings.notifyTerminalBell"
                  type="checkbox"
                  class="set-switch"
                  :disabled="!settings.notificationsEnabled"
                />
              </label>
              <label class="set-row">
                <div class="set-label">
                  {{ t('settings.alerts.inApp', 'In-app alerts') }}
                  <span class="set-hint">{{ t('settings.alerts.inAppHint', 'When an agent finishes in a pane you aren\'t looking at') }}</span>
                </div>
                <input v-model="settings.inAppAlerts" type="checkbox" class="set-switch" />
              </label>
              <div class="set-row" :class="{ 'set-disabled': !settings.notificationsEnabled }">
                <label class="set-label" for="settings-alert-sound">
                  {{ t('settings.alerts.sound', 'Sound') }}
                  <span class="set-hint">{{ t('settings.alerts.soundHint', 'With each new notification (the bell in the toolbar lists them)') }}</span>
                </label>
                <select
                  id="settings-alert-sound"
                  v-model="settings.alertSound"
                  class="set-select"
                  :disabled="!settings.notificationsEnabled"
                  @change="previewSound"
                >
                  <option value="none">{{ t('settings.alerts.soundNone', 'None') }}</option>
                  <option value="chime">{{ t('settings.alerts.soundChime', 'Chime') }}</option>
                  <option value="ping">{{ t('settings.alerts.soundPing', 'Ping') }}</option>
                </select>
              </div>
              <div
                v-if="settings.alertSound !== 'none'"
                class="set-row"
                :class="{ 'set-disabled': !settings.notificationsEnabled }"
              >
                <label class="set-label" for="settings-volume">{{ t('settings.alerts.volume', 'Volume') }}</label>
                <div class="set-inline">
                  <input
                    id="settings-volume"
                    class="set-range"
                    type="range"
                    min="0"
                    max="100"
                    step="5"
                    :aria-label="t('settings.alerts.volumeLabel', 'Notification sound volume')"
                    :disabled="!settings.notificationsEnabled"
                    :value="settings.notificationVolume"
                    @input="settings.notificationVolume = Math.round(Number($event.target.value))"
                    @change="previewSound"
                  />
                  <span class="set-hint set-volume-value">{{ settings.notificationVolume }}%</span>
                </div>
              </div>
              <label class="set-row" :class="{ 'set-disabled': !settings.notificationsEnabled }">
                <div class="set-label">
                  {{ t('settings.alerts.suppress', 'Suppress While Focused') }}
                  <span class="set-hint">{{ t('settings.alerts.suppressHint', 'Skip notifications when the triggering worktree is already visible.') }}</span>
                </div>
                <input
                  v-model="settings.notifySuppressWhenFocused"
                  type="checkbox"
                  class="set-switch"
                  :disabled="!settings.notificationsEnabled"
                />
              </label>
              <div class="set-row">
                <span></span>
                <button
                  class="exit-btn"
                  type="button"
                  data-test="test-notification"
                  :disabled="!settings.notificationsEnabled"
                  @click="emit('test-notification')"
                >
                  {{ t('settings.alerts.test', 'Send Test Notification') }}
                </button>
              </div>
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
                  {{ t('settings.editor.autoSave', 'Save automatically') }}
                  <span class="set-hint">{{ t('settings.editor.autoSaveHint', 'A moment after you stop typing (never over a file that changed on disk)') }}</span>
                </div>
                <input v-model="settings.editorAutoSave" type="checkbox" class="set-switch" />
              </label>
              <div v-if="settings.editorAutoSave" class="set-row">
                <label class="set-label" for="settings-autosave-ms">
                  {{ t('settings.editor.saveAfter', 'Save after') }}
                  <span class="set-hint">{{ t('settings.editor.saveAfterHint', 'Milliseconds without typing (250 to 10000)') }}</span>
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
                  {{ t('settings.editor.wordWrap', 'Word wrap') }}
                  <span class="set-hint">{{ t('settings.editor.wordWrapHint', 'Long lines wrap to the pane\'s width (Alt+Z in the editor)') }}</span>
                </div>
                <input v-model="settings.editorWordWrap" type="checkbox" class="set-switch" />
              </label>
              <label class="set-row">
                <div class="set-label">{{ t('settings.editor.minimap', 'Minimap') }}</div>
                <input v-model="settings.editorMinimap" type="checkbox" class="set-switch" />
              </label>
              <label class="set-row">
                <div class="set-label">
                  {{ t('settings.editor.previewTabs', 'Preview tabs') }}
                  <span class="set-hint">{{ t('settings.editor.previewTabsHint', 'A file opened with one click replaces the previous one until you edit it or double-click its tab') }}</span>
                </div>
                <input v-model="settings.editorPreviewTabs" type="checkbox" class="set-switch" />
              </label>
              <label class="set-row">
                <div class="set-label">
                  {{ t('settings.editor.sideBySide', 'Changes side by side') }}
                  <span class="set-hint">{{ t('settings.editor.sideBySideHint', 'Otherwise inline, in one column') }}</span>
                </div>
                <input v-model="settings.diffSideBySide" type="checkbox" class="set-switch" />
              </label>
              <div class="set-row">
                <label class="set-label" for="settings-editor-font">
                  {{ t('settings.editor.font', 'Editor Font Family') }}
                  <span class="set-hint">{{ t('settings.editor.fontHint', 'Font used by file editors and diff views. Leave empty to follow the terminal font.') }}</span>
                </label>
                <input
                  id="settings-editor-font"
                  class="set-number mcp-input"
                  list="settings-editor-fonts"
                  spellcheck="false"
                  :placeholder="t('settings.editor.fontPlaceholder', 'Same as terminal font')"
                  :value="settings.editorFontFamily"
                  @change="settings.editorFontFamily = $event.target.value.trim()"
                />
                <datalist id="settings-editor-fonts">
                  <option v-for="f in FONT_FAMILIES" :key="f" :value="f"></option>
                </datalist>
              </div>
              <div class="set-row">
                <div id="settings-diff-ws-label" class="set-label">
                  {{ t('settings.editor.diffWhitespace', 'Diff Show Whitespace') }}
                  <span class="set-hint">{{ t('settings.editor.diffWhitespaceHint', 'Show leading and trailing whitespace differences in diffs.') }}</span>
                </div>
                <div class="launch-seg set-seg set-seg-small" role="group" aria-labelledby="settings-diff-ws-label">
                  <button
                    v-for="o in OFF_ON"
                    :key="String(o.id)"
                    type="button"
                    class="launch-seg-btn"
                    :class="{ on: settings.diffShowWhitespace === o.id }"
                    :aria-pressed="settings.diffShowWhitespace === o.id"
                    @click="settings.diffShowWhitespace = o.id"
                  >
                    {{ o.label }}
                  </button>
                </div>
              </div>
              <div class="set-row">
                <div id="settings-diff-collapse-label" class="set-label">
                  {{ t('settings.editor.collapseUnchanged', 'Collapse Unchanged Regions') }}
                  <span class="set-hint">{{ t('settings.editor.collapseUnchangedHint', 'Show only changed lines and a little surrounding context in a file diff, hiding the rest behind expandable bands.') }}</span>
                </div>
                <div class="launch-seg set-seg set-seg-small" role="group" aria-labelledby="settings-diff-collapse-label">
                  <button
                    v-for="o in OFF_ON"
                    :key="String(o.id)"
                    type="button"
                    class="launch-seg-btn"
                    :class="{ on: settings.diffCollapseUnchanged === o.id }"
                    :aria-pressed="settings.diffCollapseUnchanged === o.id"
                    @click="settings.diffCollapseUnchanged = o.id"
                  >
                    {{ o.label }}
                  </button>
                </div>
              </div>
              <div class="set-row">
                <div id="settings-diff-wrap-label" class="set-label">
                  {{ t('settings.editor.diffWordWrap', 'Diff Word Wrap') }}
                  <span class="set-hint">{{ t('settings.editor.diffWordWrapHint', 'Wrap long lines in diff editors instead of requiring horizontal scrolling.') }}</span>
                </div>
                <div class="launch-seg set-seg set-seg-small" role="group" aria-labelledby="settings-diff-wrap-label">
                  <button
                    v-for="o in OFF_ON"
                    :key="String(o.id)"
                    type="button"
                    class="launch-seg-btn"
                    :class="{ on: settings.diffWordWrap === o.id }"
                    :aria-pressed="settings.diffWordWrap === o.id"
                    @click="settings.diffWordWrap = o.id"
                  >
                    {{ o.label }}
                  </button>
                </div>
              </div>

            </div>
          </div>
        </section>

        <!-- ============ Git & Source Control ============ -->
        <section
          id="set-git"
          class="set-page"
          data-page="git"
          :hidden="!shown('git')"
          aria-labelledby="set-git-title"
        >
          <header class="set-page-head">
            <h2 id="set-git-title">{{ PAGES.git.title }}</h2>
            <p class="set-page-desc">{{ PAGES.git.desc }}</p>
          </header>
          <div class="set-group">
            <div class="set-card">
              <div class="set-row set-row-wrap">
                <div id="settings-branch-prefix-label" class="set-label">
                  {{ t('settings.git.branchPrefix', 'Branch Prefix') }}
                  <span class="set-hint">{{ t('settings.git.branchPrefixHint', 'Choose whether branch names use your Git username, a custom prefix, or no prefix.') }}</span>
                </div>
                <div class="set-branch-prefix">
                  <div class="launch-seg set-seg" role="group" aria-labelledby="settings-branch-prefix-label">
                    <button
                      v-for="m in BRANCH_PREFIX_MODES"
                      :key="m.id"
                      type="button"
                      class="launch-seg-btn"
                      :class="{ on: settings.branchPrefix === m.id }"
                      :aria-pressed="settings.branchPrefix === m.id"
                      @click="settings.branchPrefix = m.id"
                    >
                      {{ m.label }}
                    </button>
                  </div>
                  <input
                    v-if="settings.branchPrefix === 'custom'"
                    class="set-number mcp-input"
                    :aria-label="t('settings.git.customPrefix', 'Custom branch prefix')"
                    spellcheck="false"
                    :placeholder="t('settings.git.prefixExample', 'e.g. feature')"
                    :value="settings.branchPrefixCustom"
                    @input="settings.branchPrefixCustom = $event.target.value"
                  />
                  <span
                    class="set-hint"
                    data-test="branch-prefix-feedback"
                    :class="{ 'set-error': branchPrefixFeedback.error }"
                    >{{ branchPrefixFeedback.text }}</span
                  >
                </div>
              </div>
              <div class="set-row">
                <div id="settings-group-order-label" class="set-label">
                  {{ t('settings.git.groupOrder', 'Source Control Group Order') }}
                  <span class="set-hint">{{ t('settings.git.groupOrderHint', 'Choose whether Changes, Staged Changes, or Untracked Files appear first in Source Control.') }}</span>
                </div>
                <div class="launch-seg set-seg set-seg-wide" role="group" aria-labelledby="settings-group-order-label">
                  <button
                    v-for="o in GROUP_ORDERS"
                    :key="String(o.id)"
                    type="button"
                    class="launch-seg-btn"
                    :class="{ on: settings.sourceControlGroupOrder === o.id }"
                    :aria-pressed="settings.sourceControlGroupOrder === o.id"
                    @click="settings.sourceControlGroupOrder = o.id"
                  >
                    {{ o.label }}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </section>

        <!-- ============ Automations ============ -->
        <section
          id="set-automations"
          class="set-page"
          data-page="automations"
          :hidden="!shown('automations')"
          aria-labelledby="set-automations-title"
        >
          <header class="set-page-head">
            <h2 id="set-automations-title">{{ PAGES.automations.title }}</h2>
            <p class="set-page-desc">{{ PAGES.automations.desc }}</p>
          </header>
          <div class="set-group">
            <AutomationsPage v-if="page === 'automations' && !searching" />
            <div v-else class="set-row">
              <div class="set-label">{{ t('settings.automations.open', 'Open Automations') }}
                <span class="set-hint">{{ t('settings.automations.openHint', 'Create schedules and inspect recent runs.') }}</span>
              </div>
              <button type="button" class="exit-btn" @click="go('automations')">{{ t('settings.automations.open', 'Open Automations') }}</button>
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
                {{ t('settings.quick.intro', 'Text you send to the active pane from the command palette (Ctrl+Shift+P, then "Run: name"): a command you type often, or a prompt for an agent.') }}
              </p>
              <div v-for="q in settings.quickCommands" :key="q.id" class="set-row quick-row">
                <div class="set-label">
                  {{ q.name }}
                  <span class="set-hint quick-text">{{ q.text }}{{ q.enter ? ' ⏎' : '' }}</span>
                </div>
                <button class="exit-btn" type="button" @click="removeQuickCommand(q.id)">{{ t('settings.quick.remove', 'Remove') }}</button>
              </div>
              <form class="custom-agent-form" @submit.prevent="addQuickCommand">
                <input
                  v-model="quickDraft.name"
                  class="set-number"
                  :placeholder="t('settings.quick.namePlaceholder', 'Name, e.g. Run tests')"
                  :aria-label="t('settings.quick.nameLabel', 'Quick command name')"
                  spellcheck="false"
                />
                <input
                  v-model="quickDraft.text"
                  class="set-number mcp-input"
                  :placeholder="t('settings.quick.textPlaceholder', 'Text, e.g. npm test')"
                  :aria-label="t('settings.quick.textLabel', 'Quick command text')"
                  spellcheck="false"
                />
                <label class="quick-enter"><input v-model="quickDraft.enter" type="checkbox" /> {{ t('settings.quick.pressEnter', 'Press Enter') }}</label>
                <button class="exit-btn primary" type="submit">{{ t('settings.quick.add', 'Add') }}</button>
              </form>
              <p v-if="quickDraft.error" class="mcp-error">{{ quickDraft.error }}</p>
            </div>
          </div>
        </section>

        <!-- ============ SSH Hosts (Remote Hosts) ============ -->
        <section id="set-ssh" class="set-page" data-page="ssh" :hidden="!shown('ssh')" aria-labelledby="set-ssh-title">
          <header class="set-page-head">
            <h2 id="set-ssh-title">{{ PAGES.ssh.title }}</h2>
            <p class="set-page-desc">{{ PAGES.ssh.desc }}</p>
          </header>
          <div class="set-group">
            <RemoteHostsSettings />
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
                  {{ t('settings.updates.restart', 'Restart and update') }}
                </button>
                <button
                  v-else
                  class="exit-btn"
                  :disabled="['disabled', 'checking', 'downloading'].includes(updateStatus.state)"
                  @click="emit('check-updates')"
                >
                  {{ t('settings.updates.check', 'Check for updates') }}
                </button>
              </div>
            </div>
          </div>
        </section>
      </div>
    </main>
  </div>
</template>
