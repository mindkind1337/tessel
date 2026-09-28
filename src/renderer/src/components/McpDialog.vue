<script setup>
// MCP servers for every agent CLI (Claude Code, Codex, Gemini CLI, Qwen Code,
// Copilot CLI, OpenCode), in one place:
//   Installed - every server, which agents have it, a live connection test,
//               copy to the other agent, sign-in help, remove.
//   Catalog   - popular servers, searchable, added in one click (asks only
//               for what the server needs: a folder, an API key...).
//   Custom    - any other server, by command or URL.
// Claude Code and Codex are changed through their own CLI; the others in their
// settings file, in the format each expects (src/main/jsonAgents.js). Only the
// agents installed here (or that already have servers) are shown. Running
// agents load changes when restarted.
import { ref, reactive, computed, onMounted, inject } from 'vue'
import BrandIcon from './BrandIcon.vue'
import { MCP_CATALOG, MCP_CATEGORIES, catalogSpec, categoryLabel } from '../mcpCatalog'
import { t, intlLocale } from '../i18n'

const props = defineProps({
  cwd: { type: String, default: null }, // current workspace's project folder
  agents: { type: Array, default: () => [] },
  // Open on this tab ('connections' from Settings > Orchestration).
  initialTab: { type: String, default: 'installed' }
})
const emit = defineEmits(['close', 'run', 'tools'])

const ALL_AGENTS = ['claude', 'codex', 'gemini', 'qwen', 'copilot', 'opencode', 'cline', 'kimi']
const AGENT_NAME = {
  claude: 'Claude Code', // i18n-ignore
  codex: 'Codex', // i18n-ignore
  gemini: 'Gemini CLI', // i18n-ignore
  qwen: 'Qwen Code', // i18n-ignore
  copilot: 'Copilot CLI', // i18n-ignore
  opencode: 'OpenCode', // i18n-ignore
  cline: 'Cline', // i18n-ignore
  kimi: 'Kimi Code' // i18n-ignore
}
function scopeLabel(scope) {
  if (scope === 'user') return t('mcp.scope.user', 'All projects')
  if (scope === 'local') return t('mcp.scope.local', 'This project (private)')
  if (scope === 'project') return t('mcp.scope.project', 'This project (shared)')
  return scope
}
// "Claude Code and Codex" in the interface's language.
function agentList(names) {
  try {
    return new Intl.ListFormat(intlLocale(), { type: 'conjunction' }).format(names)
  } catch {
    return names.join(' and ') // i18n-ignore
  }
}

// Text with {{placeholders}} is built here: in the template, "}}" would end
// the interpolation.
const serversLabel = (count) =>
  count === 1
    ? t('mcp.installed.servers', '{{count}} server', { count })
    : t('mcp.installed.servers', '{{count}} servers', { count })
const notInLabel = (agent) => t('mcp.installed.notIn', 'Not in {{agent}}', { agent: AGENT_NAME[agent] })
const addToLabel = (agent) => t('mcp.installed.addTo', 'Add to {{agent}}', { agent: AGENT_NAME[agent] })
const removeFromLabel = (agent) => t('mcp.installed.removeFrom', 'Remove from {{agent}}', { agent: AGENT_NAME[agent] })
const hooksErrorLabel = (error) => t('mcp.hooks.checkFailed', 'Could not check: {{error}}', { error })
const lastSignalLabel = (signal) =>
  signal.source
    ? t('mcp.hooks.lastSignalFrom', 'Last signal {{when}} ({{source}})', { when: ago(signal.at), source: signal.source })
    : t('mcp.hooks.lastSignal', 'Last signal {{when}}', { when: ago(signal.at) })
const needsToolLabel = (entry) =>
  t('mcp.catalog.needsTool', "This server needs {{tool}}, which isn't installed.", {
    tool: entry.requires === 'uvx' ? 'uv' : 'Node.js'
  })
const addEntryLabel = (entry) => t('mcp.catalog.addEntry', 'Add {{name}}', { name: entry.name })

const cardEl = ref(null)
const tab = ref(props.initialTab === 'connections' ? 'connections' : 'installed')
if (tab.value === 'connections') onMounted(() => loadHooks())
const loading = ref(true)
// One (empty until read) list per agent in ALL_AGENTS: the dialog draws before
// the lists arrive, so every agent it names must have one.
const lists = reactive({ ...Object.fromEntries(ALL_AGENTS.map((a) => [a, []])), codexError: null })
const listOf = (agent) => (Array.isArray(lists[agent]) ? lists[agent] : [])
const listErrors = reactive({}) // agent -> why its servers could not be read
const busy = ref('') // key of the action in progress
const message = reactive({ text: '', kind: 'ok' })
const tests = reactive({}) // "agent:scope:name" -> result
const haveCmd = reactive({}) // 'node' / 'uvx' -> bool

const installed = computed(() =>
  Object.fromEntries(ALL_AGENTS.map((id) => [id, !!props.agents.find((a) => a.id === id && a.available)]))
)
// The agents shown: installed here, or already holding servers (Claude Code
// and Codex when nothing is detected, so the dialog is never empty).
const AGENTS = computed(() => {
  const shown = ALL_AGENTS.filter((a) => installed.value[a] || listOf(a).length)
  return shown.length ? shown : ['claude', 'codex']
})

function say(text, kind = 'ok') {
  message.text = text
  message.kind = kind
}

// ---------------------------------------------------------------- Installed
// One row per server name, showing which agents have it.
const rows = computed(() => {
  const map = new Map()
  for (const agent of AGENTS.value) {
    for (const s of listOf(agent)) {
      if (!map.has(s.name))
        map.set(s.name, { name: s.name, target: s.target, type: s.type, by: {} })
      map.get(s.name).by[agent] = s
    }
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name))
})

const catalogById = computed(() => Object.fromEntries(MCP_CATALOG.map((e) => [e.id, e])))

async function refresh() {
  loading.value = true
  try {
    const res = await window.shellApi.mcpList(props.cwd)
    lists.claude = (res && res.claude) || []
    lists.codex = (res && res.codex) || []
    lists.codexError = (res && res.codexError) || null
    for (const [agent, r] of Object.entries((res && res.others) || {})) {
      lists[agent] = (r && r.servers) || []
      if (r && r.error) listErrors[agent] = r.error
      else delete listErrors[agent]
    }
  } catch (err) {
    lists.codexError = err.message
  } finally {
    loading.value = false
  }
}

const testKey = (agent, s) => `${agent}:${s.scope}:${s.name}`

async function test(agent, s) {
  const key = testKey(agent, s)
  tests[key] = { status: 'testing' }
  try {
    tests[key] = await window.shellApi.mcpTest({
      agent,
      name: s.name,
      scope: s.scope,
      cwd: props.cwd
    })
  } catch (err) {
    tests[key] = { status: 'error', error: err.message }
  }
}

async function testAll() {
  const jobs = []
  for (const row of rows.value) {
    for (const agent of AGENTS.value) if (row.by[agent]) jobs.push(test(agent, row.by[agent]))
  }
  await Promise.all(jobs)
}

function testLabel(res) {
  if (!res) return ''
  if (res.status === 'testing') return t('mcp.test.testing', 'Testing…')
  if (res.status === 'connected')
    return t('mcp.test.connected', 'Connected · {{count}} tools', { count: res.tools ? res.tools.length : 0 })
  if (res.status === 'auth') return t('mcp.test.needsSignIn', 'Needs sign-in')
  return t('mcp.test.failed', 'Failed')
}

function testTitle(res) {
  if (!res) return ''
  if (res.status === 'connected') {
    const secs = (Math.round((res.ms || 0) / 100) / 10).toLocaleString(intlLocale())
    return t('mcp.test.answered', '{{server}} answered in {{secs}}s.\nTools: {{tools}}', {
      server: res.server || t('mcp.test.server', 'Server'),
      secs,
      tools: (res.tools || []).join(', ') || t('mcp.test.none', 'none')
    })
  }
  return [res.error, res.log].filter(Boolean).join('\n')
}

async function copyTo(row, to) {
  // From an agent that has it (the first one shown).
  const from = AGENTS.value.find((a) => a !== to && row.by[a])
  if (!from) return
  const src = row.by[from]
  busy.value = `copy:${row.name}:${to}`
  try {
    const res = await window.shellApi.mcpCopy({
      from,
      to,
      name: row.name,
      scope: src.scope,
      cwd: props.cwd
    })
    if (res && res.ok) {
      say(
        t('mcp.copy.added', 'Added "{{name}}" to {{agent}}.{{note}} Restart running {{agent}} panes to load it.', {
          name: row.name,
          agent: AGENT_NAME[to],
          note: res.note ? ' ' + res.note : ''
        })
      )
    } else {
      say(`${AGENT_NAME[to]}: ${(res && res.error) || t('mcp.copy.failed', 'copy failed')}`, 'error')
    }
  } finally {
    busy.value = ''
  }
  refresh()
}

// Tessel's own confirmation (falls back to the system one outside the app).
const askConfirm = inject('askConfirm', (o) => Promise.resolve(window.confirm(o.title)))

async function remove(agent, s) {
  const ok = await askConfirm({
    title: t('mcp.remove.confirm', 'Remove "{{name}}" from {{agent}}?', { name: s.name, agent: AGENT_NAME[agent] }),
    confirmLabel: t('mcp.remove.button', 'Remove'),
    danger: true
  })
  if (!ok) return
  busy.value = `rm:${agent}:${s.name}`
  try {
    const res = await window.shellApi.mcpRemove({
      agent,
      name: s.name,
      scope: s.scope,
      cwd: props.cwd
    })
    if (res && res.ok)
      say(t('mcp.remove.done', 'Removed "{{name}}" from {{agent}}.', { name: s.name, agent: AGENT_NAME[agent] }))
    else say(`${AGENT_NAME[agent]}: ${(res && res.error) || t('mcp.remove.failed', 'remove failed')}`, 'error')
  } finally {
    busy.value = ''
  }
  delete tests[testKey(agent, s)]
  refresh()
}

function signIn(agent, name) {
  if (agent === 'codex') {
    emit('run', { label: t('mcp.signIn.pane', 'Sign in: {{name}}', { name }), command: `codex mcp login ${name}` })
  } else if (agent !== 'claude') {
    say(
      t('mcp.signIn.other', 'Sign in to "{{name}}" from a {{agent}} pane (its own MCP command), or set the server\'s API key.', { name, agent: AGENT_NAME[agent] })
    )
  } else {
    say(
      t('mcp.signIn.claude', 'In a Claude Code pane, type /mcp, pick "{{name}}" and choose Authenticate. Your browser opens to sign in.', { name })
    )
  }
}

// ---------------------------------------------------------------- Catalog
const query = ref('')
const category = ref('All')
const openId = ref(null)
const answers = reactive({})
const targets = reactive(Object.fromEntries(ALL_AGENTS.map((a) => [a, true])))
const scope = ref('user')
const formError = ref('')

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  return MCP_CATALOG.filter(
    (e) =>
      (category.value === 'All' || e.category === category.value) &&
      (!q || `${e.name} ${e.desc} ${e.category} ${categoryLabel(e.category)}`.toLowerCase().includes(q))
  )
})

function addedTo(id) {
  return AGENTS.value.filter((a) => listOf(a).some((s) => s.name === id))
}

function open(entry) {
  openId.value = openId.value === entry.id ? null : entry.id
  formError.value = ''
  for (const k of Object.keys(answers)) delete answers[k]
  for (const input of entry.inputs || []) {
    answers[input.key] = input.kind === 'folder' ? props.cwd || '' : ''
  }
  for (const a of ALL_AGENTS) targets[a] = installed.value[a] && !addedTo(entry.id).includes(a)
}

async function browse(key) {
  const picked = await window.shellApi.pickFolder({
    title: t('mcp.catalog.chooseFolder', 'Choose a folder'),
    defaultPath: answers[key] || props.cwd || undefined
  })
  if (picked) answers[key] = picked
}

async function addFromCatalog(entry) {
  formError.value = ''
  const chosen = AGENTS.value.filter((a) => targets[a] && installed.value[a])
  if (!chosen.length) {
    formError.value = t('mcp.chooseAgent', 'Choose at least one agent.')
    return
  }
  for (const input of entry.inputs || []) {
    const neededHere = input.as !== 'header' || chosen.includes('claude')
    if (neededHere && !String(answers[input.key] || '').trim()) {
      formError.value = t('mcp.catalog.enter', 'Enter: {{field}}.', { field: input.label })
      return
    }
  }
  busy.value = `add:${entry.id}`
  const done = []
  try {
    for (const agent of chosen) {
      const spec = catalogSpec(entry, answers, agent)
      spec.scope = agent === 'claude' ? scope.value : 'user'
      spec.cwd = props.cwd
      const res = await window.shellApi.mcpAdd(spec)
      if (!res || !res.ok) {
        formError.value = `${AGENT_NAME[agent]}: ${(res && res.error) || t('mcp.addFailed', 'failed')}`
        break
      }
      done.push(AGENT_NAME[agent])
    }
  } finally {
    busy.value = ''
  }
  if (done.length) {
    const vars = { name: entry.name, agents: agentList(done) }
    say(
      entry.auth === 'oauth'
        ? t('mcp.catalog.addedOauth', 'Added {{name}} to {{agents}}. It asks you to sign in the first time an agent uses it. Restart running agent panes to load it.', vars)
        : t('mcp.catalog.added', 'Added {{name}} to {{agents}}. Restart running agent panes to load it.', vars)
    )
    if (!formError.value) openId.value = null
    await refresh()
    // Check it right away.
    for (const agent of chosen) {
      const s = listOf(agent).find((x) => x.name === entry.id)
      if (s) test(agent, s)
    }
  }
}

// ---------------------------------------------------------------- Custom
const custom = reactive({
  name: '',
  transport: 'stdio',
  commandLine: '',
  url: '',
  env: '',
  headers: '',
  bearerEnvVar: ''
})
const customTargets = reactive(Object.fromEntries(ALL_AGENTS.map((a) => [a, true])))
const customError = ref('')

async function addCustom() {
  customError.value = ''
  const chosen = AGENTS.value.filter((a) => customTargets[a] && installed.value[a])
  if (!chosen.length) {
    customError.value = t('mcp.chooseAgent', 'Choose at least one agent.')
    return
  }
  busy.value = 'custom'
  const done = []
  try {
    for (const agent of chosen) {
      const res = await window.shellApi.mcpAdd({
        agent,
        name: custom.name.trim(),
        transport: custom.transport,
        commandLine: custom.commandLine,
        url: custom.url.trim(),
        env: custom.env,
        headers: custom.headers,
        bearerEnvVar: custom.bearerEnvVar.trim(),
        scope: agent === 'claude' ? scope.value : 'user',
        cwd: props.cwd
      })
      if (!res || !res.ok) {
        customError.value = `${AGENT_NAME[agent]}: ${(res && res.error) || t('mcp.addFailed', 'failed')}`
        break
      }
      done.push(AGENT_NAME[agent])
    }
  } finally {
    busy.value = ''
  }
  if (done.length) {
    say(
      t('mcp.custom.added', 'Added "{{name}}" to {{agents}}. Restart running agent panes to load it.', {
        name: custom.name.trim(),
        agents: agentList(done)
      })
    )
    Object.assign(custom, {
      name: '',
      commandLine: '',
      url: '',
      env: '',
      headers: '',
      bearerEnvVar: ''
    })
    await refresh()
    tab.value = 'installed'
  }
}

// --- Connections: how each agent gets its team messages (its hooks) ---------
// Read-only status from the main process (teamHooksStatus.js): hooks in place,
// Codex's one-time approval in /hooks, and the last signal a hook sent, the
// proof it works. Agents without hooks set up get the typed reminder only.
const hooks = ref(null) // { agents: [...] } | { error }
const hooksLoading = ref(false)
async function loadHooks() {
  if (!window.shellApi.teamHooksStatus) return
  hooksLoading.value = true
  try {
    hooks.value = await window.shellApi.teamHooksStatus()
  } catch (err) {
    hooks.value = { error: err && err.message }
  } finally {
    hooksLoading.value = false
  }
}
// Agents installed here, or with Tessel's hooks still in place.
const hookRows = computed(() =>
  (hooks.value && Array.isArray(hooks.value.agents) ? hooks.value.agents : []).filter(
    (r) => installed.value[r.id] || r.hooks !== 'missing'
  )
)
// Installed agents Tessel has no hooks for yet (they get the typed reminder).
const noHookAgents = computed(() =>
  ALL_AGENTS.filter((a) => installed.value[a] && !hookRows.value.find((r) => r.id === a))
)
function hookState(r) {
  if (r.error || r.hooks === 'error') return { cls: 'error', label: t('mcp.hooks.error', 'Error') }
  if (r.hooks !== 'installed')
    return {
      cls: 'error',
      label: r.hooks === 'partial' ? t('mcp.hooks.incomplete', 'Incomplete') : t('mcp.hooks.notSetUp', 'Not set up')
    }
  if (r.approval === 'needs-approval' || r.approval === 'changed')
    return { cls: 'auth', label: t('mcp.hooks.needsApproval', 'Needs your approval') }
  // Codex's saved approval could not be read: /hooks is the reference.
  if (r.id === 'codex' && !r.approval) return { cls: 'auth', label: t('mcp.hooks.approvalUnknown', 'Approval unknown') }
  return { cls: 'connected', label: r.lastSignal ? t('mcp.hooks.working', 'Working') : t('mcp.hooks.setUp', 'Set up') }
}
function ago(at) {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (s < 60) return t('mcp.ago.now', 'just now')
  if (s < 3600) return t('mcp.ago.minutes', '{{count}} min ago', { count: Math.round(s / 60) })
  if (s < 86400) return t('mcp.ago.hours', '{{count}} h ago', { count: Math.round(s / 3600) })
  return t('mcp.ago.days', '{{count}} d ago', { count: Math.round(s / 86400) })
}
async function reinstallHooks() {
  if (!window.shellApi.installTeamTools) return
  busy.value = 'hooks'
  try {
    const res = await window.shellApi.installTeamTools()
    const errors = (res && res.errors) || []
    message.kind = errors.length ? 'error' : 'ok'
    message.text = errors.length ? errors.join(' ') : t('mcp.hooks.reinstalled', 'Team tools and hooks are set up.')
  } catch (err) {
    message.kind = 'error'
    message.text = (err && err.message) || t('mcp.hooks.reinstallFailed', 'The team tools could not be set up.')
  } finally {
    busy.value = ''
    loadHooks()
  }
}

onMounted(async () => {
  if (cardEl.value) cardEl.value.focus()
  refresh()
  loadHooks()
  if (window.shellApi.checkTools) {
    Object.assign(haveCmd, (await window.shellApi.checkTools(['node', 'uvx'])) || {})
  }
})
</script>

<template>
  <div class="help-backdrop" @pointerdown.self="emit('close')">
    <div
      ref="cardEl"
      class="help-card mcp-card"
      role="dialog"
      :aria-label="t('mcp.title', 'MCP servers')"
      tabindex="-1"
      @keydown.escape.prevent.stop="emit('close')"
    >
      <div class="help-head">
        <span>{{ t('mcp.title', 'MCP servers') }}</span>
        <button class="tb-icon" :title="t('mcp.close', 'Close (Esc)')" @click="emit('close')">
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
      <p class="mcp-intro">
        {{
          t('mcp.intro', "MCP servers give your agents extra tools: a browser, library docs, GitHub, your issue tracker. They're added with each agent's own command, so they also work outside this app."
          )
        }}
      </p>

      <div class="mcp-tabbar">
        <div class="launch-seg">
          <button
            class="launch-seg-btn"
            :class="{ on: tab === 'installed' }"
            @click="tab = 'installed'"
          >
            {{ t('mcp.tab.installed', 'Installed') }}<span v-if="rows.length" class="mcp-count">{{ rows.length }}</span>
          </button>
          <button
            class="launch-seg-btn"
            :class="{ on: tab === 'catalog' }"
            @click="tab = 'catalog'"
          >
            {{ t('mcp.tab.catalog', 'Catalog') }}
          </button>
          <button class="launch-seg-btn" :class="{ on: tab === 'custom' }" @click="tab = 'custom'">
            {{ t('mcp.tab.custom', 'Custom') }}
          </button>
          <button
            class="launch-seg-btn"
            :class="{ on: tab === 'connections' }"
            @click="(tab = 'connections'), loadHooks()"
          >
            {{ t('mcp.tab.connections', 'Team connections') }}
          </button>
        </div>
      </div>

      <p v-if="message.text" :class="message.kind === 'error' ? 'mcp-error' : 'mcp-notice'">
        {{ message.text }}
      </p>

      <!-- ================= Installed ================= -->
      <template v-if="tab === 'installed'">
        <div class="mcp-toolbar">
          <span class="set-hint">
            <template v-if="loading">{{ t('mcp.loading', 'Loading…') }}</template>
            <template v-else>{{ serversLabel(rows.length) }}</template>
            <template v-if="lists.codexError"> · Codex: {{ lists.codexError }}</template>
            <template v-for="(err, a) in listErrors" :key="a"> · {{ AGENT_NAME[a] }}: {{ err }}</template>
          </span>
          <button class="exit-btn" :disabled="!rows.length" @click="testAll">{{ t('mcp.installed.testAll', 'Test all') }}</button>
        </div>

        <div v-if="!loading && !rows.length" class="mcp-empty">
          {{ t('mcp.installed.empty', 'No MCP servers yet.') }}
          <button class="exit-btn primary" @click="tab = 'catalog'">
            {{ t('mcp.installed.browse', 'Browse the catalog') }}
          </button>
        </div>

        <div v-for="row in rows" :key="row.name" class="mcp-server">
          <div class="mcp-server-head">
            <BrandIcon
              :kind="'mcp-' + row.name"
              :accent="(catalogById[row.name] && catalogById[row.name].accent) || '#8a93a6'"
              :label="row.name"
              :size="22"
            />
            <div class="mcp-row-main">
              <span class="mcp-name">{{ row.name }}</span>
              <span class="mcp-target" :title="row.target">{{ row.target }}</span>
            </div>
            <span class="launch-tag muted">{{ row.type === 'stdio' ? t('mcp.installed.command', 'command') : row.type }}</span>
          </div>

          <p v-if="row.name === 'tessel-team'" class="mcp-about">
            <strong>{{ t('mcp.teamServer.title', 'Added by Tessel: team messages.') }}</strong>
            {{
              t('mcp.teamServer.body', "Agents in the same team use it to talk to each other in the background, so nothing is ever typed into your terminals, and to put the work they share on the team's task board (who does what). It does nothing for an agent that is not in a team. Claude Code also gets its new messages automatically (hooks in ~/.claude/settings.json). An agent that was already open uses it after a restart."
              )
            }}
          </p>

          <div class="mcp-agents">
            <div v-for="agent in AGENTS" :key="agent" class="mcp-agent">
              <BrandIcon :kind="agent" :size="14" />
              <template v-if="row.by[agent]">
                <span class="mcp-agent-name">{{ AGENT_NAME[agent] }}</span>
                <span v-if="agent === 'claude'" class="mcp-scope">{{
                  scopeLabel(row.by[agent].scope)
                }}</span>
                <span
                  v-if="tests[testKey(agent, row.by[agent])]"
                  class="mcp-status"
                  :class="tests[testKey(agent, row.by[agent])].status"
                  :title="testTitle(tests[testKey(agent, row.by[agent])])"
                  >{{ testLabel(tests[testKey(agent, row.by[agent])]) }}</span
                >
                <span class="mcp-agent-actions">
                  <button
                    v-if="
                      tests[testKey(agent, row.by[agent])] &&
                      tests[testKey(agent, row.by[agent])].status === 'auth'
                    "
                    class="exit-btn"
                    @click="signIn(agent, row.name)"
                  >
                    {{ t('mcp.installed.signIn', 'Sign in') }}
                  </button>
                  <button class="exit-btn" @click="test(agent, row.by[agent])">
                    {{ t('mcp.installed.test', 'Test') }}
                  </button>
                  <button
                    class="ws-icon-btn small danger"
                    :title="removeFromLabel(agent)"
                    :disabled="!!busy"
                    @click="remove(agent, row.by[agent])"
                  >
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <path
                        d="M4 4l8 8M12 4l-8 8"
                        stroke="currentColor"
                        stroke-width="1.5"
                        stroke-linecap="round"
                      />
                    </svg>
                  </button>
                </span>
              </template>
              <template v-else>
                <span class="mcp-agent-name dim">{{ notInLabel(agent) }}</span>
                <span class="mcp-agent-actions">
                  <button
                    v-if="installed[agent]"
                    class="exit-btn"
                    :disabled="!!busy"
                    @click="copyTo(row, agent)"
                  >
                    {{ busy === `copy:${row.name}:${agent}` ? t('mcp.adding', 'Adding…') : addToLabel(agent) }}
                  </button>
                  <span v-else class="set-hint">{{ t('mcp.installed.notInstalled', 'Not installed') }}</span>
                </span>
              </template>
            </div>
          </div>
        </div>
      </template>

      <!-- ================= Team connections ================= -->
      <template v-else-if="tab === 'connections'">
        <p class="mcp-about">
          {{
            t('mcp.hooks.intro', 'How each agent gets its team messages. With its hooks set up, an agent receives them while it works and when it finishes a turn, without anything typed into its terminal. Without hooks, Tessel types a short reminder when the agent is idle.')
          }}
        </p>
        <div class="mcp-toolbar">
          <span class="set-hint">
            <template v-if="hooksLoading">{{ t('mcp.hooks.checking', 'Checking…') }}</template>
            <template v-else-if="hooks && hooks.error">{{ hooksErrorLabel(hooks.error) }}</template>
          </span>
          <button class="exit-btn" :disabled="hooksLoading" @click="loadHooks">
            {{ t('mcp.hooks.checkAgain', 'Check again') }}
          </button>
          <button class="exit-btn" :disabled="!!busy" @click="reinstallHooks">
            {{ busy === 'hooks' ? t('mcp.hooks.settingUp', 'Setting up…') : t('mcp.hooks.setUpAgain', 'Set up again') }}
          </button>
        </div>

        <div v-for="r in hookRows" :key="r.id" class="mcp-server">
          <div class="mcp-server-head">
            <BrandIcon :kind="r.id" :size="22" />
            <div class="mcp-row-main">
              <span class="mcp-name">{{ AGENT_NAME[r.id] || r.id }}</span>
              <span class="mcp-target">
                <template v-if="r.lastSignal">{{ lastSignalLabel(r.lastSignal) }}</template>
                <template v-else>{{ t('mcp.hooks.noSignal', 'No signal from its hooks yet') }}</template>
                <template v-if="r.id === 'claude'">
                  · {{
                    r.inbox
                      ? t('mcp.hooks.ownInbox', 'reminders go to its own inbox')
                      : t('mcp.hooks.inboxUnknown', 'inbox not reported yet')
                  }}</template
                >
              </span>
            </div>
            <span class="mcp-status" :class="hookState(r).cls">{{ hookState(r).label }}</span>
          </div>
          <p v-if="r.id === 'codex' && r.approval !== 'approved'" class="mcp-about">
            <strong>{{ t('mcp.hooks.codexStepTitle', 'One step for you:') }}</strong>
            {{
              t('mcp.hooks.codexStep', "in each Codex pane, type /hooks and approve Tessel's entries. Codex runs a new or changed hook only after you review it."
              )
            }}
          </p>
          <p v-else-if="r.id === 'codex'" class="set-hint">
            {{
              t('mcp.hooks.codexApproved', 'Approved (saved in Codex). If messages stop arriving, /hooks in Codex shows the current state.')
            }}
          </p>
          <p v-if="r.id === 'kimi'" class="set-hint">
            {{
              t('mcp.hooks.kimi', 'Team messages arrive when you send a prompt, or extend the end of a turn once.')
            }}
          </p>
          <p v-if="r.error" class="mcp-error">{{ r.error }}</p>
          <div v-if="r.events" class="mcp-agents">
            <div v-for="(on, ev) in r.events" :key="ev" class="mcp-agent">
              <span class="mcp-agent-name" :class="{ dim: !on }">{{ ev }}</span>
              <span class="mcp-agent-actions">
                <span class="set-hint">{{ on ? t('mcp.hooks.eventOn', 'set up') : t('mcp.hooks.eventMissing', 'missing') }}</span>
              </span>
            </div>
          </div>
        </div>

        <div v-if="noHookAgents.length" class="mcp-server">
          <div class="mcp-server-head">
            <div class="mcp-row-main">
              <span class="mcp-name">{{ t('mcp.hooks.none', 'No hooks yet') }}</span>
              <span class="mcp-target">{{
                t('mcp.hooks.noneHint', 'Typed reminder only, when the agent is idle')
              }}</span>
            </div>
          </div>
          <div class="mcp-agents">
            <div v-for="a in noHookAgents" :key="a" class="mcp-agent">
              <BrandIcon :kind="a" :size="14" />
              <span class="mcp-agent-name">{{ AGENT_NAME[a] }}</span>
            </div>
          </div>
        </div>
      </template>

      <!-- ================= Catalog ================= -->
      <template v-else-if="tab === 'catalog'">
        <input
          v-model="query"
          class="set-number tools-search"
          :placeholder="t('mcp.catalog.search', 'Search servers')"
          spellcheck="false"
        />
        <div class="mcp-cats">
          <button
            v-for="c in MCP_CATEGORIES"
            :key="c"
            class="mcp-cat"
            :class="{ on: category === c }"
            @click="category = c"
          >
            {{ categoryLabel(c) }}
          </button>
        </div>

        <div
          v-for="entry in filtered"
          :key="entry.id"
          class="mcp-entry"
          :class="{ open: openId === entry.id }"
        >
          <div class="mcp-entry-head">
            <BrandIcon
              :kind="'mcp-' + entry.id"
              :accent="entry.accent"
              :label="entry.name"
              :size="26"
            />
            <div class="mcp-row-main">
              <span class="mcp-name">
                {{ entry.name }}
                <span class="launch-tag muted">{{ categoryLabel(entry.category) }}</span>
                <span v-if="entry.auth === 'oauth'" class="launch-tag muted">{{
                  t('mcp.catalog.signInTag', 'Sign-in')
                }}</span>
              </span>
              <span class="set-hint">{{ entry.desc }}</span>
            </div>
            <span v-if="addedTo(entry.id).length === 2" class="tool-status ok">{{ t('mcp.catalog.addedTag', 'Added') }}</span>
            <button
              v-else
              class="exit-btn"
              :class="{ primary: openId !== entry.id }"
              @click="open(entry)"
            >
              {{
                openId === entry.id
                  ? t('mcp.catalog.cancel', 'Cancel')
                  : addedTo(entry.id).length
                    ? t('mcp.catalog.addToOther', 'Add to other agent')
                    : t('mcp.catalog.add', 'Add')
              }}
            </button>
          </div>

          <form
            v-if="openId === entry.id"
            class="mcp-entry-form"
            @submit.prevent="addFromCatalog(entry)"
          >
            <p v-if="entry.requires && haveCmd[entry.requires] === false" class="mcp-error">
              {{ needsToolLabel(entry) }}
              <button type="button" class="exit-btn" @click="emit('tools')">
                {{ t('mcp.catalog.openTools', 'Open Tools') }}
              </button>
            </p>
            <div v-for="input in entry.inputs || []" :key="input.key" class="set-row">
              <div class="set-label">
                {{ input.label }}
                <span v-if="input.help" class="set-hint">{{ input.help }}</span>
              </div>
              <div class="mcp-input-wrap">
                <input
                  v-model="answers[input.key]"
                  class="set-number mcp-input"
                  :type="input.kind === 'secret' ? 'password' : 'text'"
                  spellcheck="false"
                  autocomplete="off"
                />
                <button
                  v-if="input.kind === 'folder'"
                  type="button"
                  class="exit-btn"
                  @click="browse(input.key)"
                >
                  {{ t('mcp.catalog.browse', 'Browse') }}
                </button>
              </div>
            </div>
            <div class="set-row">
              <div class="set-label">{{ t('mcp.addTo', 'Add to') }}</div>
              <div class="mcp-targets">
                <label
                  v-for="a in AGENTS"
                  :key="a"
                  :class="{ disabled: !installed[a] || addedTo(entry.id).includes(a) }"
                >
                  <input
                    v-model="targets[a]"
                    type="checkbox"
                    :disabled="!installed[a] || addedTo(entry.id).includes(a)"
                  />
                  <BrandIcon :kind="a" :size="13" />
                  {{ AGENT_NAME[a] }}
                </label>
              </div>
            </div>
            <div v-if="targets.claude" class="set-row">
              <div class="set-label">
                {{ t('mcp.claudeScope', 'For Claude Code, use it in') }}
                <span class="set-hint">{{
                  cwd ? cwd : t('mcp.claudeScopeHint', 'Set a workspace folder to limit it to one project')
                }}</span>
              </div>
              <div class="launch-seg set-seg">
                <button
                  type="button"
                  class="launch-seg-btn"
                  :class="{ on: scope === 'user' }"
                  @click="scope = 'user'"
                >
                  {{ t('mcp.scope.user', 'All projects') }}
                </button>
                <button
                  type="button"
                  class="launch-seg-btn"
                  :class="{ on: scope === 'project' }"
                  :disabled="!cwd"
                  @click="scope = 'project'"
                >
                  {{ t('mcp.scope.thisProject', 'This project') }}
                </button>
              </div>
            </div>
            <code class="mcp-preview">{{
              entry.transport === 'http' ? entry.url : entry.command
            }}</code>
            <p v-if="formError" class="mcp-error">{{ formError }}</p>
            <div class="set-foot">
              <span class="set-hint">{{
            t('mcp.codexScope', 'Codex servers always apply to all projects.')
          }}</span>
              <button class="exit-btn primary" type="submit" :disabled="!!busy">
                {{ busy === `add:${entry.id}` ? t('mcp.adding', 'Adding…') : addEntryLabel(entry) }}
              </button>
            </div>
          </form>
        </div>
        <p v-if="!filtered.length" class="set-hint">
          {{ t('mcp.catalog.noMatch', 'No servers match. Try the Custom tab.') }}
        </p>
      </template>

      <!-- ================= Custom ================= -->
      <form v-else class="mcp-form" @submit.prevent="addCustom">
        <div class="set-row">
          <div class="set-label">{{ t('mcp.addTo', 'Add to') }}</div>
          <div class="mcp-targets">
            <label v-for="a in AGENTS" :key="a" :class="{ disabled: !installed[a] }">
              <input v-model="customTargets[a]" type="checkbox" :disabled="!installed[a]" />
              <BrandIcon :kind="a" :size="13" />
              {{ AGENT_NAME[a] }}
            </label>
          </div>
        </div>
        <div class="set-row">
          <div class="set-label">
            {{ t('mcp.custom.name', 'Name') }}
            <span class="set-hint">{{ t('mcp.custom.nameHint', 'Letters, digits, - and _') }}</span>
          </div>
          <input
            v-model="custom.name"
            class="set-number mcp-input"
            :placeholder="'my-server'"
            spellcheck="false"
          />
        </div>
        <div class="set-row">
          <div class="set-label">{{ t('mcp.custom.type', 'Type') }}</div>
          <div class="launch-seg set-seg">
            <button
              type="button"
              class="launch-seg-btn"
              :class="{ on: custom.transport === 'stdio' }"
              @click="custom.transport = 'stdio'"
            >
              {{ t('mcp.custom.command', 'Command') }}
            </button>
            <button
              type="button"
              class="launch-seg-btn"
              :class="{ on: custom.transport === 'http' }"
              @click="custom.transport = 'http'"
            >
              URL
            </button>
          </div>
        </div>
        <div v-if="custom.transport === 'stdio'" class="set-row">
          <div class="set-label">
            {{ t('mcp.custom.command', 'Command') }}
            <span class="set-hint">{{
              t('mcp.custom.commandHint', 'npx commands are wrapped for Windows automatically')
            }}</span>
          </div>
          <input
            v-model="custom.commandLine"
            class="set-number mcp-input wide"
            :placeholder="'npx -y some-mcp-server'"
            spellcheck="false"
          />
        </div>
        <div v-else class="set-row">
          <div class="set-label">URL</div>
          <input
            v-model="custom.url"
            class="set-number mcp-input wide"
            :placeholder="'https://example.com/mcp'"
            spellcheck="false"
          />
        </div>
        <div v-if="custom.transport === 'stdio'" class="set-row tall">
          <div class="set-label">
            {{ t('mcp.custom.env', 'Environment') }}
            <span class="set-hint">{{ t('mcp.custom.envHint', 'Optional, one KEY=value per line') }}</span>
          </div>
          <textarea
            v-model="custom.env"
            class="mcp-textarea"
            rows="2"
            :placeholder="'API_KEY=...'"
            spellcheck="false"
          ></textarea>
        </div>
        <template v-else>
          <div v-if="customTargets.claude" class="set-row tall">
            <div class="set-label">
              {{ t('mcp.custom.headers', 'Headers') }}
              <span class="set-hint">{{
                t('mcp.custom.headersHint', 'Optional, Claude Code only. Name: value per line')
              }}</span>
            </div>
            <textarea
              v-model="custom.headers"
              class="mcp-textarea"
              rows="2"
              :placeholder="'Authorization: Bearer ...'"
              spellcheck="false"
            ></textarea>
          </div>
          <div v-if="customTargets.codex" class="set-row">
            <div class="set-label">
              {{ t('mcp.custom.tokenVar', 'Codex token variable') }}
              <span class="set-hint">{{
                t('mcp.custom.tokenVarHint', 'Optional: environment variable holding a bearer token')
              }}</span>
            </div>
            <input
              v-model="custom.bearerEnvVar"
              class="set-number mcp-input"
              :placeholder="'MY_TOKEN'"
              spellcheck="false"
            />
          </div>
        </template>
        <div v-if="customTargets.claude" class="set-row">
          <div class="set-label">{{ t('mcp.claudeScope', 'For Claude Code, use it in') }}</div>
          <div class="launch-seg set-seg">
            <button
              type="button"
              class="launch-seg-btn"
              :class="{ on: scope === 'user' }"
              @click="scope = 'user'"
            >
              {{ t('mcp.scope.user', 'All projects') }}
            </button>
            <button
              type="button"
              class="launch-seg-btn"
              :class="{ on: scope === 'project' }"
              :disabled="!cwd"
              @click="scope = 'project'"
            >
              {{ t('mcp.scope.thisProject', 'This project') }}
            </button>
          </div>
        </div>
        <p v-if="customError" class="mcp-error">{{ customError }}</p>
        <div class="set-foot">
          <span class="set-hint">{{
            t('mcp.codexScope', 'Codex servers always apply to all projects.')
          }}</span>
          <button class="exit-btn primary" type="submit" :disabled="!!busy || !custom.name.trim()">
            {{ busy === 'custom' ? t('mcp.adding', 'Adding…') : t('mcp.custom.add', 'Add server') }}
          </button>
        </div>
      </form>
    </div>
  </div>
</template>
