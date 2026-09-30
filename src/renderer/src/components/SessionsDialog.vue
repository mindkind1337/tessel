<script setup>
import ThemedSelect from './ui/ThemedSelect.vue'
// Past agent conversations, newest first. Resume one in a new
// pane (in the folder it ran in), jump to a pane that already has it open, or
// copy its session id.
// With session search turned on (opt-in: a local index of what was said, in
// Tessel's data folder, src/main/sessionSearch), the search box looks in the
// conversations themselves: results show the matching passage, and the same
// Resume. Turning it off or clearing the index is here too. After Orca's
// "Search every agent session" (AiVaultPanelSearch.tsx, MIT, Copyright (c)
// 2026 Lovecast Inc.).
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { maskSecrets } from '../chat/chatModel'
import BrandIcon from './BrandIcon.vue'
import { t, intlLocale } from '../i18n'

const props = defineProps({
  cwd: { type: String, default: null }, // current workspace folder
  openIds: { type: Object, default: () => ({}) } // sessionId -> paneId
})
const emit = defineEmits(['close', 'resume', 'show', 'copied'])

const AGENT_NAME = {
  claude: 'Claude Code', // i18n-ignore
  codex: 'Codex',
  gemini: 'Gemini',
  qwen: 'Qwen',
  opencode: 'OpenCode',
  openclaude: 'OpenClaude',
  copilot: 'Copilot',
  kimi: 'Kimi',
  cline: 'Cline',
  cursor: 'Cursor',
  droid: 'Droid',
  grok: 'Grok',
  pi: 'Pi',
  antigravity: 'Antigravity',
  devin: 'Devin'
}

const cardEl = ref(null)
const loading = ref(true)
const sessions = ref([])
const onlyHere = ref(!!props.cwd)
const agentFilter = ref('all')
const query = ref('')

// --- Search in what was said (opt-in) ---------------------------------------------------
const searchApi = () => (window.shellApi && window.shellApi.sessionSearch) || null
const index = ref(null) // { available, enabled, phase, filesIndexed, filesDue, sessions, sizeBytes, historyDays }
const scope = ref(props.cwd ? 'project' : 'all') // folder | project | all
const hits = ref(null) // null: not searching; else the results
const searching = ref(false)
const indexBusy = ref(false)
let statusTimer = null
let searchTimer = null
let searchSeq = 0
const fullText = computed(() => !!(index.value && index.value.enabled) && query.value.trim().length > 0)

async function refreshIndex() {
  const api = searchApi()
  if (!api) return
  try {
    index.value = await api.status()
  } catch {
    index.value = null
  }
  clearTimeout(statusTimer)
  // Followed only while it is indexing.
  if (index.value && index.value.enabled && index.value.phase !== 'current') statusTimer = setTimeout(refreshIndex, 2000)
}
async function indexAction(name, arg) {
  const api = searchApi()
  if (!api || indexBusy.value) return
  indexBusy.value = true
  try {
    await api[name](arg)
  } catch {
    // the status below says what it is now
  }
  indexBusy.value = false
  await refreshIndex()
  runSearch()
}
async function runSearch() {
  const api = searchApi()
  if (!api || !fullText.value) {
    hits.value = null
    return
  }
  const seq = ++searchSeq
  searching.value = true
  let res = null
  try {
    res = await api.search({
      query: query.value,
      scope: { kind: props.cwd ? scope.value : 'all', path: props.cwd || '' },
      agents: agentFilter.value === 'all' ? null : [agentFilter.value],
      limit: 40
    })
  } catch {
    res = null
  }
  if (seq !== searchSeq) return
  searching.value = false
  hits.value = res && res.ok ? res.hits : []
}
watch([query, scope, agentFilter, () => index.value && index.value.enabled], () => {
  clearTimeout(searchTimer)
  if (!fullText.value) {
    hits.value = null
    return
  }
  searchTimer = setTimeout(runSearch, 180)
})
onBeforeUnmount(() => {
  clearTimeout(statusTimer)
  clearTimeout(searchTimer)
})

// A result as the rows below show a session.
const hitRows = computed(() =>
  (hits.value || []).map((h) => ({
    agent: h.agent,
    id: h.sessionId,
    cwd: h.cwd,
    title: maskSecrets(h.title || '') || t('app.sessions.untitled', 'Untitled conversation'),
    updated: h.updatedAt,
    messageCount: h.messageCount,
    // The passage, its matches marked: [{ text, match }], secrets masked.
    snippet: h.evidence && h.evidence.snippet ? snippetParts(h.evidence.snippet) : []
  }))
)
// The marks are private-use characters (never in a conversation's text: the
// index takes them out). The index holds the text with its secrets masked;
// masked once more here, on each part, so a mark cannot split one.
const MARK_OPEN = '\uE000'
const MARK_CLOSE = '\uE001'
function snippetParts(snippet) {
  const out = []
  String(snippet)
    .split(MARK_OPEN)
    .forEach((piece, i) => {
      const end = piece.indexOf(MARK_CLOSE)
      if (i === 0 || end < 0) {
        if (piece) out.push({ text: maskSecrets(piece.replace(MARK_CLOSE, '')), match: false })
        return
      }
      out.push({ text: maskSecrets(piece.slice(0, end)), match: true })
      if (piece.length > end + 1) out.push({ text: maskSecrets(piece.slice(end + 1)), match: false })
    })
  return out
}
const sizeText = (n) => (n >= 1048576 ? `${Math.round(n / 1048576)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`) // i18n-ignore
const indexLine = computed(() => {
  const i = index.value
  if (!i || !i.enabled) return ''
  const size = sizeText(i.sizeBytes)
  if (i.phase === 'indexing') return t('app.sessions.indexing', 'Indexing… {{due}} conversations left ({{size}})', { due: i.filesDue, size })
  if (i.phase === 'paused') return t('app.sessions.indexPaused', 'Indexing waits while the window is hidden ({{due}} left)', { due: i.filesDue })
  return t('app.sessions.indexCurrent', 'Index up to date: {{count}} conversations ({{size}})', { count: i.sessions, size })
})
const scopes = computed(() => [
  { id: 'folder', label: t('app.sessions.scopeFolder', 'This folder') },
  { id: 'project', label: t('app.sessions.scopeProject', 'Project') },
  { id: 'all', label: t('app.sessions.scopeAll', 'All') }
])
const keepOptions = computed(() => [
  { days: 30, label: t('app.sessions.keep30', 'Last 30 days') },
  { days: 90, label: t('app.sessions.keep90', 'Last 90 days') },
  { days: 365, label: t('app.sessions.keep365', 'Last year') },
  { days: 0, label: t('app.sessions.keepAll', 'Everything') }
])
const messagesText = (n) => t('app.sessions.messages', '{{n}} messages', { n })
const searchPlaceholder = computed(() => (index.value && index.value.enabled ? t('app.sessions.searchFull', 'Search in what was said') : t('app.sessions.search', 'Search conversations')))
// prettier-ignore
const optinText = computed(() => t('app.sessions.optinText', 'Find a conversation by what was said in it. Tessel builds a search index of your agents’ conversations on this computer; nothing is sent anywhere. Before you turn it on:'))
// prettier-ignore
const optinPoints = computed(() => [
  t('app.sessions.optinKeeps', 'The index keeps the full text of the conversations, including what was pasted into them (keys, passwords…); it masks what it recognizes as a secret, not everything.'),
  t('app.sessions.optinPlain', 'It is not encrypted: anyone who can read your files can read it.'),
  t('app.sessions.optinStays', 'It stays on this computer after you turn the search off, until you clear it.')
])
const indexLeft = computed(() => (index.value && !index.value.enabled && index.value.sizeBytes > 0 ? t('app.sessions.optinLeft', 'An index of {{size}} is still on this computer.', { size: sizeText(index.value.sizeBytes) }) : ''))

async function load() {
  loading.value = true
  try {
    const list = await window.shellApi.listSessions({
      cwd: onlyHere.value ? props.cwd : null,
      limit: 80
    })
    sessions.value = Array.isArray(list) ? list : []
  } catch {
    sessions.value = []
  } finally {
    loading.value = false
  }
}

// Only the agents that have conversations here (Claude Code and Codex always).
const filters = computed(() => [
  'all',
  ...Object.keys(AGENT_NAME).filter(
    (a) => a === 'claude' || a === 'codex' || a === agentFilter.value || sessions.value.some((s) => s.agent === a)
  )
])

const shown = computed(() => {
  const q = query.value.trim().toLowerCase()
  return sessions.value.filter(
    (s) =>
      (agentFilter.value === 'all' || s.agent === agentFilter.value) &&
      (!q || `${s.title} ${s.cwd} ${s.id}`.toLowerCase().includes(q))
  )
})

function ago(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000)
  if (s < 60) return t('app.sessions.justNow', 'just now')
  if (s < 3600) return t('app.sessions.minAgo', '{{n}} min ago', { n: Math.floor(s / 60) })
  if (s < 86400) return t('app.sessions.hAgo', '{{n}} h ago', { n: Math.floor(s / 3600) })
  if (s < 86400 * 7) return t('app.sessions.dAgo', '{{n}} d ago', { n: Math.floor(s / 86400) })
  return new Date(ms).toLocaleDateString(intlLocale())
}

const onlyLabel = computed(() => t('app.sessions.only', 'Only {{folder}}', { folder: folderName(props.cwd) }))
const emptyText = computed(() =>
  onlyHere.value && props.cwd
    ? t('app.sessions.emptyIn', 'No conversations found in {{folder}}.', { folder: folderName(props.cwd) })
    : t('app.sessions.empty', 'No conversations found.')
)

function folderName(p) {
  const parts = String(p || '')
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
  return parts[parts.length - 1] || p
}

function copyId(s) {
  window.shellApi.writeClipboard(s.id)
  emit('copied', s.id)
}

function toggleHere() {
  onlyHere.value = !onlyHere.value
  load()
}

onMounted(() => {
  if (cardEl.value) cardEl.value.focus()
  load()
  refreshIndex()
})
</script>

<template>
  <div class="help-backdrop" @pointerdown.self="emit('close')">
    <div
      ref="cardEl"
      class="help-card sessions-card"
      role="dialog"
      :aria-label="t('app.sessions.label', 'Sessions')"
      tabindex="-1"
      @keydown.escape.prevent.stop="emit('close')"
    >
      <div class="help-head">
        <span>{{ t('app.sessions.title', 'Agent sessions') }}</span>
        <button class="tb-icon" :title="t('app.sessions.close', 'Close (Esc)')" @click="emit('close')">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M4 4l8 8M12 4l-8 8"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
            />
          </svg>
        </button>
      </div>
      <p class="mcp-intro">{{ t('app.sessions.intro', 'Your past conversations. Resume one to pick up where it left off.') }}</p>

      <div class="sessions-filters">
        <input
          v-model="query"
          class="set-number sessions-search"
          data-test="sessions-query"
          :placeholder="searchPlaceholder"
          :aria-label="t('app.sessions.search', 'Search conversations')"
          spellcheck="false"
        />
        <div class="mcp-cats">
          <button
            v-for="f in filters"
            :key="f"
            class="mcp-cat"
            :class="{ on: agentFilter === f }"
            @click="agentFilter = f"
          >
            {{ f === 'all' ? t('app.sessions.all', 'All') : AGENT_NAME[f] }}
          </button>
          <button
            v-if="cwd && !fullText"
            class="mcp-cat"
            :class="{ on: onlyHere }"
            :title="cwd"
            @click="toggleHere"
          >
            {{ onlyLabel }}
          </button>
        </div>
        <div v-if="fullText && cwd" class="mcp-cats" role="group" :aria-label="t('app.sessions.scope', 'Where to search')" data-test="sessions-scopes">
          <button v-for="sc in scopes" :key="sc.id" class="mcp-cat" :class="{ on: scope === sc.id }" :aria-pressed="scope === sc.id ? 'true' : 'false'" @click="scope = sc.id">
            {{ sc.label }}
          </button>
        </div>
      </div>

      <!-- Opt-in: nothing is indexed before this. -->
      <div v-if="index && index.available && !index.enabled" class="sessions-optin" data-test="sessions-optin">
        <div class="tool-main">
          <span class="session-title">{{ t('app.sessions.optinTitle', 'Search every agent session') }}</span>
          <span class="set-hint">{{ optinText }}</span>
          <ul class="set-hint sessions-optin-points">
            <li v-for="(p, i) in optinPoints" :key="i">{{ p }}</li>
          </ul>
          <span v-if="indexLeft" class="set-hint" data-test="sessions-left">{{ indexLeft }}</span>
        </div>
        <button class="exit-btn primary" data-test="sessions-enable" :disabled="indexBusy" @click="indexAction('enable')">
          {{ t('app.sessions.optinEnable', 'Turn on session search') }}
        </button>
        <button v-if="indexLeft" class="exit-btn" data-test="sessions-clear-left" :disabled="indexBusy" :title="t('app.sessions.clearTitle', 'Delete the search index (never your conversations)')" @click="indexAction('clear')">
          {{ t('app.sessions.clear', 'Clear index') }}
        </button>
      </div>
      <div v-else-if="index && index.enabled" class="sessions-index" data-test="sessions-index">
        <span class="set-hint" role="status">{{ indexLine }}</span>
        <label class="set-hint sessions-keep">
          {{ t('app.sessions.keep', 'Keep') }}
          <ThemedSelect class="set-number" :value="index.historyDays" :disabled="indexBusy" @change="indexAction('setHistoryDays', Number($event.target.value))">
            <option v-for="k in keepOptions" :key="k.days" :value="k.days">{{ k.label }}</option>
          </ThemedSelect>
        </label>
        <button class="exit-btn" data-test="sessions-disable" :disabled="indexBusy" :title="t('app.sessions.disableTitle', 'Stop indexing; the index is kept until you clear it')" @click="indexAction('disable')">
          {{ t('app.sessions.disable', 'Turn off') }}
        </button>
        <button class="exit-btn" data-test="sessions-clear" :disabled="indexBusy" :title="t('app.sessions.clearRebuildTitle', 'Delete the search index (never your conversations); while the search is on, it is built again from nothing')" @click="indexAction('clear')">
          {{ t('app.sessions.clear', 'Clear index') }}
        </button>
      </div>

      <template v-if="fullText">
        <p v-if="searching && !hitRows.length" class="set-hint">{{ t('app.sessions.searching', 'Searching…') }}</p>
        <div v-else-if="!hitRows.length" class="mcp-empty" data-test="sessions-nohits">{{ t('app.sessions.noHits', 'Nothing found in your conversations.') }}</div>
        <div v-for="s in hitRows" :key="'hit' + s.agent + s.id" class="session-row session-hit" data-test="sessions-hit">
          <BrandIcon :kind="s.agent" :size="18" />
          <div class="tool-main">
            <span class="session-title" :title="s.title">{{ s.title }}</span>
            <span v-if="s.snippet.length" class="session-snippet" data-test="sessions-snippet"
              ><template v-for="(part, i) in s.snippet" :key="i"><mark v-if="part.match">{{ part.text }}</mark><template v-else>{{ part.text }}</template></template></span
            >
            <span class="set-hint session-meta">
              {{ AGENT_NAME[s.agent] || s.agent }} · {{ messagesText(s.messageCount) }}<template v-if="s.updated"> · {{ ago(s.updated) }}</template> ·
              <span :title="s.cwd">{{ folderName(s.cwd) || t('app.sessions.unknownFolder', 'Unknown folder') }}</span>
            </span>
          </div>
          <button v-if="openIds[s.id]" class="exit-btn" @click="emit('show', openIds[s.id])">{{ t('app.sessions.showPane', 'Show pane') }}</button>
          <button
            v-else
            class="exit-btn primary"
            :disabled="!s.cwd || !s.id"
            :title="s.cwd ? t('app.sessions.resumeTitle', 'Resume in its project folder') : t('app.sessions.resumeUnavailable', 'The saved project folder is unavailable. You can still copy the session ID.')"
            @click="emit('resume', s)"
          >
            {{ t('app.sessions.resume', 'Resume') }}
          </button>
        </div>
      </template>
      <template v-else>

      <p v-if="loading" class="set-hint">{{ t('app.sessions.loading', 'Loading…') }}</p>
      <div v-else-if="!shown.length" class="mcp-empty">
        {{ emptyText }}
        <button v-if="onlyHere && cwd" class="exit-btn" @click="toggleHere">
          {{ t('app.sessions.showAll', 'Show all folders') }}
        </button>
      </div>

      <div v-for="s in shown" :key="s.agent + s.id" class="session-row">
        <BrandIcon :kind="s.agent" :size="18" />
        <div class="tool-main">
          <span class="session-title" :title="s.title">{{ s.title }}</span>
          <span class="set-hint session-meta">
            {{ ago(s.updated) }} ·
            <span :title="s.cwd">{{ folderName(s.cwd) || t('app.sessions.unknownFolder', 'Unknown folder') }}</span> ·
            <code class="session-id" :title="s.id">{{ s.id.slice(0, 8) }}</code>
          </span>
        </div>
        <button class="exit-btn" :title="t('app.sessions.copyIdTitle', 'Copy the session id')" @click="copyId(s)">{{ t('app.sessions.copyId', 'Copy ID') }}</button>
        <button v-if="openIds[s.id]" class="exit-btn" @click="emit('show', openIds[s.id])">
          {{ t('app.sessions.showPane', 'Show pane') }}
        </button>
        <button
          v-else
          class="exit-btn primary"
          :disabled="!s.cwd"
          :title="
            s.cwd
              ? t('app.sessions.resumeTitle', 'Resume in its project folder')
              : t('app.sessions.resumeUnavailable', 'The saved project folder is unavailable. You can still copy the session ID.')
          "
          @click="emit('resume', s)"
        >
          {{ t('app.sessions.resume', 'Resume') }}
        </button>
      </div>
      </template>
    </div>
  </div>
</template>
