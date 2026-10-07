<script setup>
// Agent Session History: a tab of the right side panel listing the past
// conversations of every agent on this computer (src/main/agentSessions.js),
// newest first, to resume one in a new pane or jump to the pane it is open
// in. A header with view options (agents, grouping, history depth) and
// Refresh; a scope switch (Workspace: this folder; Project: this folder and
// below; All); a search box that filters the list by title, id, agent and
// folder, or, with session search turned on (the opt-in index of what was
// said, src/main/sessionSearch), searches the conversations themselves; a
// bar with the count and the sort; the rows (SessionHistoryRow.vue) under
// collapsible group headers; Show more at the end.
// After Orca's AiVaultPanel.tsx, AiVaultPanelHeader.tsx,
// AiVaultPanelControls.tsx, AiVaultPanelSearch.tsx, AiVaultSessionListBar.tsx,
// AiVaultSessionListStates.tsx and AiVaultShowMoreSessionsRow.tsx (MIT,
// Copyright (c) 2026 Lovecast Inc.).
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { ArchiveRestore, ChevronDown, ChevronRight, ListFilter, LoaderCircle, RefreshCw, Search, X } from 'lucide-vue-next'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from './chat/orca/ui/index.js'
import BrandIcon from './BrandIcon.vue'
import SessionHistoryRow from './SessionHistoryRow.vue'
import {
  AGENTS,
  DEFAULT_SESSION_LIMIT,
  MAX_SESSION_LIMIT,
  SESSION_LIMITS,
  SESSION_LIMIT_STEP,
  agentLabel,
  countViewAdjustments,
  defaultViewOptions,
  filterSessions,
  groupSessions,
  hitRow,
  loadViewOptions,
  resultCountLabel,
  saveViewOptions,
  sessionCountLabel,
  showMoreAvailable
} from '../sessionHistory'
import { t } from '../i18n'
// The menus are the chat's (their tokens are scoped to .nc-root, which they carry).
import './chat/orca/orca-tokens.css'
import './sessionHistory.css'

const props = defineProps({
  // The workspace's folder (null for a remote project).
  cwd: { type: String, default: null },
  // A project on an SSH host: { hostId, host, path }. Its conversations are
  // the host's own (sessions:listRemote), scoped to its folder there.
  remote: { type: Object, default: null },
  // sessionId -> paneId for the conversations open in a pane.
  openIds: { type: Object, default: () => ({}) },
  // Shown now (the list is read again when it is shown after a while).
  active: { type: Boolean, default: true }
})
const emit = defineEmits(['resume', 'focus-pane', 'open-editor', 'toast'])
const api = () => (typeof window !== 'undefined' && window.shellApi) || null

// --- View options (kept in localStorage) ----------------------------------------
const view = reactive(loadViewOptions())
watch(view, (v) => saveViewOptions(v), { deep: true })
const adjustments = computed(() => countViewAdjustments(view))
const allAgents = computed(() => AGENTS.every((a) => view.agents.includes(a)))
function setAgent(agent, on) {
  const has = view.agents.includes(agent)
  if (on && !has) view.agents = AGENTS.filter((a) => a === agent || view.agents.includes(a))
  if (!on && has) view.agents = view.agents.filter((a) => a !== agent)
}
function setAllAgents(on) {
  view.agents = on ? [...AGENTS] : []
}
function resetView() {
  Object.assign(view, defaultViewOptions())
}
const limitLabel = (n) => n.toLocaleString()
const depthLabel = computed(() => t('sessionHistory.depth.label', 'History depth: {{value}}', { value: limitLabel(view.limit) }))
const depthWarning = computed(() => t('sessionHistory.depth.warning', 'Larger histories can slow the entire app. The depth is per agent.'))
const limitHint = (n) =>
  n === DEFAULT_SESSION_LIMIT ? t('sessionHistory.depth.recommended', 'Recommended') : n === 100 ? t('sessionHistory.depth.mayBeSlower', 'May be slower') : t('sessionHistory.depth.slowest', 'Slowest')

// --- Scope ----------------------------------------------------------------------------
// The folder the Workspace / Project scopes compare with: the project's, on
// this computer or on the host.
const scopeDir = computed(() => (props.remote && typeof props.remote.path === 'string' ? props.remote.path : props.cwd))
const scope = ref(scopeDir.value ? 'workspace' : 'all')
const scopes = computed(() => [
  { id: 'workspace', label: t('sessionHistory.scope.workspace', 'Workspace'), disabled: !scopeDir.value },
  { id: 'project', label: t('sessionHistory.scope.project', 'Project'), disabled: !scopeDir.value },
  { id: 'all', label: t('sessionHistory.scope.all', 'All'), disabled: false }
])
const scopeAria = computed(() =>
  t('sessionHistory.scope.aria', 'Session History scope: {{scope}}', {
    scope:
      scope.value === 'workspace'
        ? t('sessionHistory.scope.currentWorkspaceLower', 'current workspace')
        : scope.value === 'project'
          ? t('sessionHistory.scope.currentProjectLower', 'current project')
          : t('sessionHistory.scope.allSessionsLower', 'all sessions')
  })
)
watch(scopeDir, (dir) => {
  if (!dir) scope.value = 'all'
})

// --- The list -------------------------------------------------------------------------
const sessions = ref([])
const loading = ref(false)
const loaded = ref(false)
const error = ref('')
const now = ref(Date.now())
let loadSeq = 0
let loadedAt = 0
let clock = 0
async function load() {
  const a = api()
  if (!a || !a.listSessions) return
  const seq = ++loadSeq
  loading.value = true
  error.value = ''
  try {
    const remote = props.remote && props.remote.hostId ? props.remote : null
    if (remote && !a.listRemoteSessions) {
      sessions.value = []
      return
    }
    const res = remote ? await a.listRemoteSessions({ hostId: remote.hostId, limit: view.limit }) : await a.listSessions({ cwd: null, limit: view.limit })
    if (seq !== loadSeq) return
    if (remote) {
      waitingHost.value = !!(res && !res.ok && res.notConnected)
      sessions.value = res && res.ok && Array.isArray(res.sessions) ? res.sessions : []
      if (res && !res.ok)
        error.value = res.notConnected
          ? t('sessionHistory.remoteNotConnected', 'Connect to {{host}} (open a terminal there) to see its sessions.', { host: remote.host || remote.hostId })
          : (res.error || t('sessionHistory.remoteFailed', 'The sessions of {{host}} could not be read.', { host: remote.host || remote.hostId }))
    } else {
      waitingHost.value = false
      sessions.value = Array.isArray(res) ? res : []
    }
  } catch (err) {
    if (seq !== loadSeq) return
    sessions.value = []
    error.value = t('sessionHistory.loadFailed', 'The sessions could not be read: {{error}}', { error: (err && err.message) || String(err) })
  } finally {
    if (seq === loadSeq) {
      loading.value = false
      loaded.value = true
      loadedAt = Date.now()
      now.value = loadedAt
    }
  }
}
function refresh() {
  if (searching.value) runSearch()
  else load()
}
watch(() => view.limit, load)
// A host not signed in yet: asked again every few seconds while the tab is
// shown, so its list appears once a terminal there connects.
const waitingHost = ref(false)
let hostRetry = 0
watch(
  () => waitingHost.value && props.active,
  (on) => {
    if (hostRetry) clearInterval(hostRetry)
    hostRetry = on ? setInterval(() => !loading.value && load(), 5000) : 0
  }
)
onBeforeUnmount(() => hostRetry && clearInterval(hostRetry))
// Another project: its list is read again. Another source (this computer /
// an SSH host): the rows of the previous one go at once (the list shows it
// is loading, never "none"), and an answer for it still on the way is
// dropped (loadSeq). The same source, another folder: the rows stay while
// the list is read again (a conversation may be newer than the last read).
const sourceKey = () => (props.remote && props.remote.hostId ? `remote:${props.remote.hostId}` : 'local') // i18n-ignore
watch(
  () => [sourceKey(), scopeDir.value],
  ([src, dir], before) => {
    if (!before || (src === before[0] && dir === before[1])) return
    if (src !== before[0]) {
      loadSeq++
      sessions.value = []
      error.value = ''
      waitingHost.value = false
      expanded.clear()
    }
    load()
  }
)
// Shown again after a minute away: read again (a conversation may have ended).
watch(
  () => props.active,
  (on) => {
    if (on && loaded.value && Date.now() - loadedAt > 60_000) load()
  }
)

const query = ref('')
const filtered = computed(() =>
  filterSessions(sessions.value, { query: searching.value ? '' : query.value, agents: view.agents, scope: scope.value, sort: view.sort, cwd: scopeDir.value })
)
const groups = computed(() => {
  if (searching.value) return hitRows.value.length ? [{ key: 'search', label: null, sessions: hitRows.value }] : []
  return groupSessions(filtered.value, view.group)
})
const collapsed = reactive(new Set())
function toggleGroup(key) {
  if (collapsed.has(key)) collapsed.delete(key)
  else collapsed.add(key)
}
const expanded = reactive(new Set())
function toggleExpanded(id) {
  if (expanded.has(id)) expanded.delete(id)
  else expanded.add(id)
}
const showMore = computed(() => !searching.value && showMoreAvailable(sessions.value, view.limit))
function more() {
  view.limit = Math.min(MAX_SESSION_LIMIT, view.limit + SESSION_LIMIT_STEP)
}

// --- Search in what was said (opt-in) ------------------------------------------------
const searchApi = () => (api() && api().sessionSearch) || null
const index = ref(null) // { available, enabled, phase, filesDue, sessions, sizeBytes }
const hits = ref(null) // null: no search done; else the results
const searchLoading = ref(false)
const searchFailed = ref(false)
const indexBusy = ref(false)
let statusTimer = null
let searchTimer = null
let searchSeq = 0
const hasQuery = computed(() => query.value.trim().length > 0)
// The conversation-text index holds this computer's sessions only: a remote
// project's list is filtered by title and folder instead.
const searching = computed(() => hasQuery.value && !props.remote && !!(index.value && index.value.enabled))
const needsConsent = computed(() => hasQuery.value && !!(index.value && index.value.available && !index.value.enabled))
async function refreshIndex() {
  const a = searchApi()
  if (!a) return
  try {
    index.value = await a.status()
  } catch {
    index.value = null
  }
  clearTimeout(statusTimer)
  // Followed only while it is indexing.
  if (index.value && index.value.enabled && index.value.phase !== 'current') statusTimer = setTimeout(refreshIndex, 2000)
}
async function enableSearch() {
  const a = searchApi()
  if (!a || indexBusy.value) return
  indexBusy.value = true
  try {
    await a.enable()
  } catch {
    // the status below says what it is now
  }
  indexBusy.value = false
  await refreshIndex()
  runSearch()
}
async function runSearch() {
  const a = searchApi()
  if (!a || !searching.value) {
    hits.value = null
    return
  }
  const seq = ++searchSeq
  searchLoading.value = true
  searchFailed.value = false
  let res = null
  try {
    res = await a.search({
      query: query.value,
      scope: { kind: scope.value === 'workspace' ? 'folder' : scope.value === 'project' ? 'project' : 'all', path: props.cwd || '' },
      agents: allAgents.value ? null : view.agents,
      limit: 40
    })
  } catch {
    res = null
  }
  if (seq !== searchSeq) return
  searchLoading.value = false
  searchFailed.value = !res || !res.ok
  hits.value = res && res.ok ? res.hits : []
}
watch([query, scope, () => view.agents, () => index.value && index.value.enabled], () => {
  clearTimeout(searchTimer)
  if (!searching.value) {
    hits.value = null
    return
  }
  searchTimer = setTimeout(runSearch, 180)
})
const hitRows = computed(() => {
  // A hit names no origin: an Antigravity IDE conversation's comes from the list.
  const ide = new Set(sessions.value.filter((x) => x.origin === 'ide').map((x) => `${x.agent}:${x.id}`))
  const rows = (hits.value || []).map(hitRow).map((r) => (ide.has(`${r.agent}:${r.id}`) ? { ...r, origin: 'ide' } : r))
  return view.searchSort === 'newest' ? rows.sort((a, b) => b.updated - a.updated) : rows
})
const sizeText = (n) => (n >= 1048576 ? `${Math.round(n / 1048576)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`) // i18n-ignore
const indexLine = computed(() => {
  const i = index.value
  if (!searching.value || !i || i.phase === 'current') return ''
  const size = sizeText(i.sizeBytes)
  if (i.phase === 'indexing') return t('app.sessions.indexing', 'Indexing… {{due}} conversations left ({{size}})', { due: i.filesDue, size })
  if (i.phase === 'paused') return t('app.sessions.indexPaused', 'Indexing waits while the window is hidden ({{due}} left)', { due: i.filesDue })
  return ''
})
// The notice above the list while a query is typed, as Orca's consent /
// result messages: the opt-in, no agents, a failed search, no match.
const searchMessage = computed(() => {
  if (!hasQuery.value) return ''
  if (needsConsent.value) return t('app.sessions.optinText', 'Find a conversation by what was said in it. Tessel builds a search index of your agents’ conversations on this computer; nothing is sent anywhere. Before you turn it on:')
  if (!view.agents.length) return t('sessionHistory.empty.noAgentsSelected', 'No agents selected')
  if (!searching.value) return ''
  if (searchFailed.value) return t('sessionHistory.searching.failed', 'Could not search this computer. Try again.')
  if (hits.value && !hits.value.length && !searchLoading.value) return t('sessionHistory.searching.noMatches', 'No matching sessions in the indexed history. Try another query or scope.')
  return ''
})
// prettier-ignore
const optinPoints = computed(() => [
  t('app.sessions.optinKeeps', 'The index keeps the full text of the conversations, including what was pasted into them (keys, passwords…); it masks what it recognizes as a secret, not everything.'),
  t('app.sessions.optinPlain', 'It is not encrypted: anyone who can read your files can read it.'),
  t('app.sessions.optinStays', 'It stays on this computer after you turn the search off, until you clear it.')
])

// --- The bar above the list -----------------------------------------------------------
const barLabel = computed(() => (searching.value ? resultCountLabel(hitRows.value.length) : sessionCountLabel(filtered.value.length, sessions.value.length)))
const barShown = computed(() => (searching.value ? hitRows.value.length > 0 : sessions.value.length > 0))
const sortOptions = computed(() =>
  searching.value
    ? [
        { value: 'relevance', label: t('sessionHistory.sort.relevance', 'Most relevant') },
        { value: 'newest', label: t('sessionHistory.sort.newest', 'Newest') }
      ]
    : [
        { value: 'updated', label: t('sessionHistory.sort.lastUpdated', 'Last updated') },
        { value: 'created', label: t('sessionHistory.sort.created', 'Created') }
      ]
)
const sortValue = computed({
  get: () => (searching.value ? view.searchSort : view.sort),
  set: (v) => {
    if (searching.value) view.searchSort = v
    else view.sort = v
  }
})
const sortLabel = computed(() => (sortOptions.value.find((o) => o.value === sortValue.value) || sortOptions.value[0]).label)
const sortAria = computed(() =>
  searching.value
    ? t('sessionHistory.sort.resultsAria', 'Sort results: {{sort}}', { sort: sortLabel.value })
    : t('sessionHistory.sort.sessionsAria', 'Sort sessions: {{sort}}', { sort: sortLabel.value })
)

// --- Empty states ------------------------------------------------------------------------
// While a read is on the way and nothing is listed for this project yet: the
// loading rows, not "No sessions".
const showLoading = computed(() => loading.value && !searching.value && !filtered.value.length)
const emptyTitle = computed(() => {
  if (searching.value) return ''
  if (loading.value) return ''
  if (!sessions.value.length) return error.value ? '' : t('sessionHistory.empty.noSessions', 'No agent sessions found')
  if (!filtered.value.length) return view.agents.length ? t('sessionHistory.empty.noMatch', 'No sessions match the current filters') : t('sessionHistory.empty.noAgentsSelected', 'No agents selected')
  return ''
})

function onResume(s) {
  emit('resume', { agent: s.agent, id: s.id, cwd: s.cwd, title: s.title, ...(s.origin ? { origin: s.origin } : {}), ...(s.accountId !== undefined ? { accountId: s.accountId } : {}) })
}
function onDeleted(s) {
  expanded.delete(s.id)
  sessions.value = sessions.value.filter((x) => !(x.agent === s.agent && x.id === s.id))
  if (hits.value) hits.value = hits.value.filter((h) => !(h.agent === s.agent && h.sessionId === s.id))
  load()
}

onMounted(() => {
  load()
  refreshIndex()
  clock = setInterval(() => (now.value = Date.now()), 60_000)
})
onBeforeUnmount(() => {
  clearTimeout(statusTimer)
  clearTimeout(searchTimer)
  clearInterval(clock)
})
</script>

<template>
  <div class="sh-panel" data-test="session-history">
    <div class="sh-head">
      <div class="sh-head-row">
        <div class="sh-head-text">
          <div class="sh-title">
            <span class="sh-title-full">{{ t('sessionHistory.title', 'Agent Session History') }}</span>
            <span class="sh-title-short">{{ t('sessionHistory.titleShort', 'Agents') }}</span>
          </div>
          <div class="sh-subtitle">{{ searching || loaded ? t('sessionHistory.indexedHistory', 'Indexed history') : t('sessionHistory.resumePastSessions', 'Resume past sessions') }}</div>
        </div>
        <div class="sh-head-actions">
          <DropdownMenu>
            <DropdownMenuTrigger as-child>
              <button class="sh-icon-btn sh-view-btn" :title="t('sessionHistory.view.options', 'View options')" :aria-label="t('sessionHistory.view.aria', 'Session History view options')" data-test="session-view">
                <ListFilter :size="14" aria-hidden="true" />
                <span v-if="adjustments" class="sh-view-count" aria-hidden="true">{{ adjustments }}</span>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" :side-offset="6" class="sh-menu sh-view-menu">
              <div class="sh-menu-row">
                <span class="sh-menu-heading">{{ t('sessionHistory.view.agents', 'Agents') }}</span>
                <span class="sh-menu-bulk">
                  <DropdownMenuItem class="sh-menu-pill" :disabled="allAgents" data-test="agents-all" @select="(e) => { e.preventDefault(); setAllAgents(true) }">{{ t('sessionHistory.view.selectAll', 'Select all') }}</DropdownMenuItem>
                  <DropdownMenuItem class="sh-menu-pill" :disabled="!view.agents.length" data-test="agents-clear" @select="(e) => { e.preventDefault(); setAllAgents(false) }">{{ t('sessionHistory.view.clear', 'Clear') }}</DropdownMenuItem>
                </span>
              </div>
              <DropdownMenuCheckboxItem
                v-for="agent in AGENTS"
                :key="agent"
                :checked="view.agents.includes(agent)"
                :data-test="'agent-' + agent"
                @update:checked="(on) => setAgent(agent, on)"
                @select="(e) => e.preventDefault()"
              >
                <BrandIcon :kind="agent" :size="14" /> {{ agentLabel(agent) }}
              </DropdownMenuCheckboxItem>
              <template v-if="!searching">
                <DropdownMenuSeparator />
                <DropdownMenuLabel>{{ t('sessionHistory.view.group', 'Group') }}</DropdownMenuLabel>
                <DropdownMenuRadioGroup v-model="view.group">
                  <DropdownMenuRadioItem value="folder" data-test="group-folder">{{ t('sessionHistory.view.folder', 'Folder') }}</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="agent" data-test="group-agent">{{ t('sessionHistory.view.agent', 'Agent') }}</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
                <DropdownMenuSeparator />
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger data-test="depth">{{ depthLabel }}</DropdownMenuSubTrigger>
                  <DropdownMenuSubContent class="sh-menu sh-depth-menu">
                    <DropdownMenuLabel class="sh-menu-note">{{ depthWarning }}</DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    <DropdownMenuRadioGroup v-model="view.limit">
                      <DropdownMenuRadioItem v-for="n in SESSION_LIMITS" :key="n" :value="n" :data-test="'depth-' + n">
                        <span>{{ limitLabel(n) }}</span><span class="sh-menu-hint">{{ limitHint(n) }}</span>
                      </DropdownMenuRadioItem>
                    </DropdownMenuRadioGroup>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              </template>
              <template v-if="adjustments">
                <DropdownMenuSeparator />
                <DropdownMenuItem data-test="reset-view" @select="resetView">{{ t('sessionHistory.view.reset', 'Reset view') }}</DropdownMenuItem>
              </template>
            </DropdownMenuContent>
          </DropdownMenu>
          <button class="sh-icon-btn" :disabled="loading || searchLoading" :aria-busy="loading ? 'true' : 'false'" :title="t('sessionHistory.refresh', 'Refresh Session History')" :aria-label="t('sessionHistory.refresh', 'Refresh Session History')" data-test="session-refresh" @click="refresh">
            <LoaderCircle v-if="loading || searchLoading" :size="13" class="sh-spin" aria-hidden="true" />
            <RefreshCw v-else :size="13" aria-hidden="true" />
          </button>
        </div>
      </div>

      <div class="sh-scope" role="group" :aria-label="scopeAria" data-test="session-scopes">
        <button v-for="sc in scopes" :key="sc.id" class="sh-scope-btn" :class="{ on: scope === sc.id }" :disabled="sc.disabled" :aria-pressed="scope === sc.id ? 'true' : 'false'" :data-test="'scope-' + sc.id" @click="scope = sc.id">
          {{ sc.label }}
        </button>
      </div>

      <div class="sh-search">
        <Search :size="13" class="sh-search-icon" aria-hidden="true" />
        <input
          v-model="query"
          class="sh-search-input"
          data-test="session-query"
          :placeholder="t('sessionHistory.search', 'Search sessions')"
          :aria-label="t('sessionHistory.search', 'Search sessions')"
          spellcheck="false"
          @keydown.escape.stop="query = ''"
        />
        <LoaderCircle v-if="searching && searchLoading" :size="12" class="sh-spin sh-search-busy" aria-hidden="true" />
        <button v-if="query" class="sh-search-clear" :aria-label="t('sessionHistory.clearSearch', 'Clear search')" :title="t('sessionHistory.clearSearch', 'Clear search')" data-test="session-clear" @click="query = ''">
          <X :size="12" aria-hidden="true" />
        </button>
      </div>
    </div>

    <div v-if="error && !searching" class="sh-error" role="alert" data-test="session-error">
      <span>{{ error }}</span>
      <button class="exit-btn sh-error-retry" :disabled="loading" data-test="session-load-retry" @click="load">{{ t('changes.compare.retry', 'Retry') }}</button>
    </div>

    <div v-if="searchMessage || indexLine" class="sh-notice" role="status" data-test="session-notice">
      <p v-if="searchMessage">{{ searchMessage }}</p>
      <ul v-if="needsConsent" class="sh-notice-points">
        <li v-for="(p, i) in optinPoints" :key="i">{{ p }}</li>
      </ul>
      <p v-if="indexLine">{{ indexLine }}</p>
      <button v-if="needsConsent" class="exit-btn primary" :disabled="indexBusy" data-test="session-enable-search" @click="enableSearch">{{ t('app.sessions.optinEnable', 'Turn on session search') }}</button>
      <button v-else-if="searching && searchFailed" class="exit-btn" :disabled="searchLoading" data-test="session-retry" @click="runSearch">{{ t('sessionHistory.searching.retry', 'Try again') }}</button>
    </div>

    <div v-if="barShown" class="sh-bar" data-test="session-bar">
      <span class="sh-bar-label">{{ barLabel }}</span>
      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <button class="sh-sort-btn" :aria-label="sortAria" data-test="session-sort">{{ sortLabel }} <ChevronDown :size="12" aria-hidden="true" /></button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" class="sh-menu">
          <DropdownMenuRadioGroup v-model="sortValue">
            <DropdownMenuRadioItem v-for="o in sortOptions" :key="o.value" :value="o.value" :data-test="'sort-' + o.value">{{ o.label }}</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>

    <div class="sh-list" data-test="session-list">
      <div v-if="showLoading" class="sh-loading" aria-busy="true" data-test="session-loading">
        <div class="sh-loading-line"><LoaderCircle :size="13" class="sh-spin" aria-hidden="true" /><span>{{ t('sessionHistory.scanning', 'Scanning sessions') }}</span></div>
        <div v-for="i in 6" :key="i" class="sh-skeleton"><span class="sh-skel-dot"></span><span class="sh-skel-lines"><span class="sh-skel w80"></span><span class="sh-skel w60"></span><span class="sh-skel w40"></span></span></div>
      </div>
      <div v-else-if="emptyTitle" class="sh-empty" data-test="session-empty">
        <ArchiveRestore :size="28" class="sh-empty-icon" aria-hidden="true" />
        <p>{{ emptyTitle }}</p>
      </div>
      <template v-for="g in groups" :key="g.key">
        <button v-if="g.label !== null" class="sh-group" :aria-expanded="collapsed.has(g.key) ? 'false' : 'true'" data-test="session-group" @click="toggleGroup(g.key)">
          <ChevronRight :size="13" class="sh-chevron-r" :class="{ open: !collapsed.has(g.key) }" aria-hidden="true" />
          <span class="sh-group-label">{{ g.label }}</span>
          <span class="sh-group-count">{{ g.sessions.length }}</span>
        </button>
        <template v-if="g.label === null || !collapsed.has(g.key)">
          <SessionHistoryRow
            v-for="s in g.sessions"
            :key="s.agent + s.id"
            :session="s"
            :pane-id="openIds[s.id] || null"
            :scope="scope"
            :expanded="expanded.has(s.id)"
            :now="now"
            @toggle="toggleExpanded(s.id)"
            @resume="onResume(s)"
            @focus-pane="(id) => emit('focus-pane', id)"
            @open-log="(file) => emit('open-editor', file)"
            @toast="(text) => emit('toast', text)"
            @deleted="onDeleted(s)"
          />
        </template>
      </template>
    </div>

    <div v-if="showMore" class="sh-more">
      <button class="exit-btn subtle" :disabled="loading" data-test="session-more" @click="more">
        {{ loading ? t('sessionHistory.loadingMore', 'Loading more sessions…') : t('sessionHistory.showMore', 'Show more sessions') }}
      </button>
    </div>
  </div>
</template>
