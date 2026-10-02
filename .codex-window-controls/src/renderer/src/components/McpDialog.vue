<script setup>
// MCP servers for Claude Code and Codex, in one place:
//   Installed - every server, which agents have it, a live connection test,
//               copy to the other agent, sign-in help, remove.
//   Catalog   - popular servers, searchable, added in one click (asks only
//               for what the server needs: a folder, an API key...).
//   Custom    - any other server, by command or URL.
// All changes go through each agent's own CLI, so the config stays in the
// format each agent expects. Running agents load changes when restarted.
import { ref, reactive, computed, onMounted } from 'vue'
import BrandIcon from './BrandIcon.vue'
import { MCP_CATALOG, MCP_CATEGORIES, catalogSpec } from '../mcpCatalog'

const props = defineProps({
  cwd: { type: String, default: null }, // current workspace's project folder
  agents: { type: Array, default: () => [] }
})
const emit = defineEmits(['close', 'run', 'tools'])

const AGENTS = ['claude', 'codex']
const AGENT_NAME = { claude: 'Claude Code', codex: 'Codex' }
const SCOPE_LABEL = {
  user: 'All projects',
  local: 'This project (private)',
  project: 'This project (shared)'
}

const cardEl = ref(null)
const tab = ref('installed')
const loading = ref(true)
const lists = reactive({ claude: [], codex: [], codexError: null })
const busy = ref('') // key of the action in progress
const message = reactive({ text: '', kind: 'ok' })
const tests = reactive({}) // "agent:scope:name" -> result
const haveCmd = reactive({}) // 'node' / 'uvx' -> bool

const installed = computed(() => ({
  claude: !!props.agents.find((a) => a.id === 'claude' && a.available),
  codex: !!props.agents.find((a) => a.id === 'codex' && a.available)
}))

function say(text, kind = 'ok') {
  message.text = text
  message.kind = kind
}

// ---------------------------------------------------------------- Installed
// One row per server name, showing which agents have it.
const rows = computed(() => {
  const map = new Map()
  for (const agent of AGENTS) {
    for (const s of lists[agent]) {
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
    for (const agent of AGENTS) if (row.by[agent]) jobs.push(test(agent, row.by[agent]))
  }
  await Promise.all(jobs)
}

function testLabel(t) {
  if (!t) return ''
  if (t.status === 'testing') return 'Testing…'
  if (t.status === 'connected') return `Connected · ${t.tools ? t.tools.length : 0} tools`
  if (t.status === 'auth') return 'Needs sign-in'
  return 'Failed'
}

function testTitle(t) {
  if (!t) return ''
  if (t.status === 'connected') {
    const secs = Math.round((t.ms || 0) / 100) / 10
    return `${t.server || 'Server'} answered in ${secs}s.\nTools: ${(t.tools || []).join(', ') || 'none'}`
  }
  return [t.error, t.log].filter(Boolean).join('\n')
}

async function copyTo(row, to) {
  const from = to === 'claude' ? 'codex' : 'claude'
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
        `Added "${row.name}" to ${AGENT_NAME[to]}.${res.note ? ' ' + res.note : ''} Restart running ${AGENT_NAME[to]} panes to load it.`
      )
    } else {
      say(`${AGENT_NAME[to]}: ${(res && res.error) || 'copy failed'}`, 'error')
    }
  } finally {
    busy.value = ''
  }
  refresh()
}

async function remove(agent, s) {
  if (!window.confirm(`Remove "${s.name}" from ${AGENT_NAME[agent]}?`)) return
  busy.value = `rm:${agent}:${s.name}`
  try {
    const res = await window.shellApi.mcpRemove({
      agent,
      name: s.name,
      scope: s.scope,
      cwd: props.cwd
    })
    if (res && res.ok) say(`Removed "${s.name}" from ${AGENT_NAME[agent]}.`)
    else say(`${AGENT_NAME[agent]}: ${(res && res.error) || 'remove failed'}`, 'error')
  } finally {
    busy.value = ''
  }
  delete tests[testKey(agent, s)]
  refresh()
}

function signIn(agent, name) {
  if (agent === 'codex') {
    emit('run', { label: `Sign in: ${name}`, command: `codex mcp login ${name}` })
  } else {
    say(
      `In a Claude Code pane, type /mcp, pick "${name}" and choose Authenticate. Your browser opens to sign in.`
    )
  }
}

// ---------------------------------------------------------------- Catalog
const query = ref('')
const category = ref('All')
const openId = ref(null)
const answers = reactive({})
const targets = reactive({ claude: true, codex: true })
const scope = ref('user')
const formError = ref('')

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  return MCP_CATALOG.filter(
    (e) =>
      (category.value === 'All' || e.category === category.value) &&
      (!q || `${e.name} ${e.desc} ${e.category}`.toLowerCase().includes(q))
  )
})

function addedTo(id) {
  return AGENTS.filter((a) => lists[a].some((s) => s.name === id))
}

function open(entry) {
  openId.value = openId.value === entry.id ? null : entry.id
  formError.value = ''
  for (const k of Object.keys(answers)) delete answers[k]
  for (const input of entry.inputs || []) {
    answers[input.key] = input.kind === 'folder' ? props.cwd || '' : ''
  }
  targets.claude = installed.value.claude && !addedTo(entry.id).includes('claude')
  targets.codex = installed.value.codex && !addedTo(entry.id).includes('codex')
}

async function browse(key) {
  const picked = await window.shellApi.pickFolder({
    title: 'Choose a folder',
    defaultPath: answers[key] || props.cwd || undefined
  })
  if (picked) answers[key] = picked
}

async function addFromCatalog(entry) {
  formError.value = ''
  const chosen = AGENTS.filter((a) => targets[a] && installed.value[a])
  if (!chosen.length) {
    formError.value = 'Choose Claude Code, Codex, or both.'
    return
  }
  for (const input of entry.inputs || []) {
    const neededHere = input.as !== 'header' || chosen.includes('claude')
    if (neededHere && !String(answers[input.key] || '').trim()) {
      formError.value = `Enter: ${input.label}.`
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
        formError.value = `${AGENT_NAME[agent]}: ${(res && res.error) || 'failed'}`
        break
      }
      done.push(AGENT_NAME[agent])
    }
  } finally {
    busy.value = ''
  }
  if (done.length) {
    const signInHint =
      entry.auth === 'oauth' ? ' It asks you to sign in the first time an agent uses it.' : ''
    say(
      `Added ${entry.name} to ${done.join(' and ')}.${signInHint} Restart running agent panes to load it.`
    )
    if (!formError.value) openId.value = null
    await refresh()
    // Check it right away.
    for (const agent of chosen) {
      const s = lists[agent].find((x) => x.name === entry.id)
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
const customTargets = reactive({ claude: true, codex: true })
const customError = ref('')

async function addCustom() {
  customError.value = ''
  const chosen = AGENTS.filter((a) => customTargets[a] && installed.value[a])
  if (!chosen.length) {
    customError.value = 'Choose Claude Code, Codex, or both.'
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
        customError.value = `${AGENT_NAME[agent]}: ${(res && res.error) || 'failed'}`
        break
      }
      done.push(AGENT_NAME[agent])
    }
  } finally {
    busy.value = ''
  }
  if (done.length) {
    say(
      `Added "${custom.name.trim()}" to ${done.join(' and ')}. Restart running agent panes to load it.`
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

onMounted(async () => {
  if (cardEl.value) cardEl.value.focus()
  refresh()
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
      aria-label="MCP servers"
      tabindex="-1"
      @keydown.escape.prevent.stop="emit('close')"
    >
      <div class="help-head">
        <span>MCP servers</span>
        <button class="tb-icon" title="Close (Esc)" @click="emit('close')">
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
        MCP servers give your agents extra tools: a browser, library docs, GitHub, your issue
        tracker. They're added with each agent's own command, so they also work outside this app.
      </p>

      <div class="mcp-tabbar">
        <div class="launch-seg">
          <button
            class="launch-seg-btn"
            :class="{ on: tab === 'installed' }"
            @click="tab = 'installed'"
          >
            Installed<span v-if="rows.length" class="mcp-count">{{ rows.length }}</span>
          </button>
          <button
            class="launch-seg-btn"
            :class="{ on: tab === 'catalog' }"
            @click="tab = 'catalog'"
          >
            Catalog
          </button>
          <button class="launch-seg-btn" :class="{ on: tab === 'custom' }" @click="tab = 'custom'">
            Custom
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
            <template v-if="loading">Loading…</template>
            <template v-else
              >{{ rows.length }} {{ rows.length === 1 ? 'server' : 'servers' }}</template
            >
            <template v-if="lists.codexError"> · Codex: {{ lists.codexError }}</template>
          </span>
          <button class="exit-btn" :disabled="!rows.length" @click="testAll">Test all</button>
        </div>

        <div v-if="!loading && !rows.length" class="mcp-empty">
          No MCP servers yet.
          <button class="exit-btn primary" @click="tab = 'catalog'">Browse the catalog</button>
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
            <span class="launch-tag muted">{{ row.type === 'stdio' ? 'command' : row.type }}</span>
          </div>

          <div class="mcp-agents">
            <div v-for="agent in AGENTS" :key="agent" class="mcp-agent">
              <BrandIcon :kind="agent" :size="14" />
              <template v-if="row.by[agent]">
                <span class="mcp-agent-name">{{ AGENT_NAME[agent] }}</span>
                <span v-if="agent === 'claude'" class="mcp-scope">{{
                  SCOPE_LABEL[row.by[agent].scope] || row.by[agent].scope
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
                    Sign in
                  </button>
                  <button class="exit-btn" @click="test(agent, row.by[agent])">Test</button>
                  <button
                    class="ws-icon-btn small danger"
                    :title="`Remove from ${AGENT_NAME[agent]}`"
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
                <span class="mcp-agent-name dim">Not in {{ AGENT_NAME[agent] }}</span>
                <span class="mcp-agent-actions">
                  <button
                    v-if="installed[agent]"
                    class="exit-btn"
                    :disabled="!!busy"
                    @click="copyTo(row, agent)"
                  >
                    {{
                      busy === `copy:${row.name}:${agent}`
                        ? 'Adding…'
                        : `Add to ${AGENT_NAME[agent]}`
                    }}
                  </button>
                  <span v-else class="set-hint">Not installed</span>
                </span>
              </template>
            </div>
          </div>
        </div>
      </template>

      <!-- ================= Catalog ================= -->
      <template v-else-if="tab === 'catalog'">
        <input
          v-model="query"
          class="set-number tools-search"
          placeholder="Search servers"
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
            {{ c }}
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
                <span class="launch-tag muted">{{ entry.category }}</span>
                <span v-if="entry.auth === 'oauth'" class="launch-tag muted">Sign-in</span>
              </span>
              <span class="set-hint">{{ entry.desc }}</span>
            </div>
            <span v-if="addedTo(entry.id).length === 2" class="tool-status ok">Added</span>
            <button
              v-else
              class="exit-btn"
              :class="{ primary: openId !== entry.id }"
              @click="open(entry)"
            >
              {{
                openId === entry.id
                  ? 'Cancel'
                  : addedTo(entry.id).length
                    ? 'Add to other agent'
                    : 'Add'
              }}
            </button>
          </div>

          <form
            v-if="openId === entry.id"
            class="mcp-entry-form"
            @submit.prevent="addFromCatalog(entry)"
          >
            <p v-if="entry.requires && haveCmd[entry.requires] === false" class="mcp-error">
              This server needs {{ entry.requires === 'uvx' ? 'uv' : 'Node.js' }}, which isn't
              installed.
              <button type="button" class="exit-btn" @click="emit('tools')">Open Tools</button>
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
                  Browse
                </button>
              </div>
            </div>
            <div class="set-row">
              <div class="set-label">Add to</div>
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
                For Claude Code, use it in
                <span class="set-hint">{{
                  cwd ? cwd : 'Set a workspace folder to limit it to one project'
                }}</span>
              </div>
              <div class="launch-seg set-seg">
                <button
                  type="button"
                  class="launch-seg-btn"
                  :class="{ on: scope === 'user' }"
                  @click="scope = 'user'"
                >
                  All projects
                </button>
                <button
                  type="button"
                  class="launch-seg-btn"
                  :class="{ on: scope === 'project' }"
                  :disabled="!cwd"
                  @click="scope = 'project'"
                >
                  This project
                </button>
              </div>
            </div>
            <code class="mcp-preview">{{
              entry.transport === 'http' ? entry.url : entry.command
            }}</code>
            <p v-if="formError" class="mcp-error">{{ formError }}</p>
            <div class="set-foot">
              <span class="set-hint">Codex servers always apply to all projects.</span>
              <button class="exit-btn primary" type="submit" :disabled="!!busy">
                {{ busy === `add:${entry.id}` ? 'Adding…' : `Add ${entry.name}` }}
              </button>
            </div>
          </form>
        </div>
        <p v-if="!filtered.length" class="set-hint">No servers match. Try the Custom tab.</p>
      </template>

      <!-- ================= Custom ================= -->
      <form v-else class="mcp-form" @submit.prevent="addCustom">
        <div class="set-row">
          <div class="set-label">Add to</div>
          <div class="mcp-targets">
            <label v-for="a in AGENTS" :key="a" :class="{ disabled: !installed[a] }">
              <input v-model="customTargets[a]" type="checkbox" :disabled="!installed[a]" />
              <BrandIcon :kind="a" :size="13" />
              {{ AGENT_NAME[a] }}
            </label>
          </div>
        </div>
        <div class="set-row">
          <div class="set-label">Name <span class="set-hint">Letters, digits, - and _</span></div>
          <input
            v-model="custom.name"
            class="set-number mcp-input"
            placeholder="my-server"
            spellcheck="false"
          />
        </div>
        <div class="set-row">
          <div class="set-label">Type</div>
          <div class="launch-seg set-seg">
            <button
              type="button"
              class="launch-seg-btn"
              :class="{ on: custom.transport === 'stdio' }"
              @click="custom.transport = 'stdio'"
            >
              Command
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
            Command <span class="set-hint">npx commands are wrapped for Windows automatically</span>
          </div>
          <input
            v-model="custom.commandLine"
            class="set-number mcp-input wide"
            placeholder="npx -y some-mcp-server"
            spellcheck="false"
          />
        </div>
        <div v-else class="set-row">
          <div class="set-label">URL</div>
          <input
            v-model="custom.url"
            class="set-number mcp-input wide"
            placeholder="https://example.com/mcp"
            spellcheck="false"
          />
        </div>
        <div v-if="custom.transport === 'stdio'" class="set-row tall">
          <div class="set-label">
            Environment <span class="set-hint">Optional, one KEY=value per line</span>
          </div>
          <textarea
            v-model="custom.env"
            class="mcp-textarea"
            rows="2"
            placeholder="API_KEY=..."
            spellcheck="false"
          ></textarea>
        </div>
        <template v-else>
          <div v-if="customTargets.claude" class="set-row tall">
            <div class="set-label">
              Headers <span class="set-hint">Optional, Claude Code only. Name: value per line</span>
            </div>
            <textarea
              v-model="custom.headers"
              class="mcp-textarea"
              rows="2"
              placeholder="Authorization: Bearer ..."
              spellcheck="false"
            ></textarea>
          </div>
          <div v-if="customTargets.codex" class="set-row">
            <div class="set-label">
              Codex token variable
              <span class="set-hint">Optional: environment variable holding a bearer token</span>
            </div>
            <input
              v-model="custom.bearerEnvVar"
              class="set-number mcp-input"
              placeholder="MY_TOKEN"
              spellcheck="false"
            />
          </div>
        </template>
        <div v-if="customTargets.claude" class="set-row">
          <div class="set-label">For Claude Code, use it in</div>
          <div class="launch-seg set-seg">
            <button
              type="button"
              class="launch-seg-btn"
              :class="{ on: scope === 'user' }"
              @click="scope = 'user'"
            >
              All projects
            </button>
            <button
              type="button"
              class="launch-seg-btn"
              :class="{ on: scope === 'project' }"
              :disabled="!cwd"
              @click="scope = 'project'"
            >
              This project
            </button>
          </div>
        </div>
        <p v-if="customError" class="mcp-error">{{ customError }}</p>
        <div class="set-foot">
          <span class="set-hint">Codex servers always apply to all projects.</span>
          <button class="exit-btn primary" type="submit" :disabled="!!busy || !custom.name.trim()">
            {{ busy === 'custom' ? 'Adding…' : 'Add server' }}
          </button>
        </div>
      </form>
    </div>
  </div>
</template>
