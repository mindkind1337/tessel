<script setup>
// Past agent conversations, newest first. Resume one in a new
// pane (in the folder it ran in), jump to a pane that already has it open, or
// copy its session id.
import { ref, computed, onMounted } from 'vue'
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
          :placeholder="t('app.sessions.search', 'Search conversations')"
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
            v-if="cwd"
            class="mcp-cat"
            :class="{ on: onlyHere }"
            :title="cwd"
            @click="toggleHere"
          >
            {{ onlyLabel }}
          </button>
        </div>
      </div>

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
    </div>
  </div>
</template>
