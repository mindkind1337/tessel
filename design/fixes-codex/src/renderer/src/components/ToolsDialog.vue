<script setup>
// "Tools": see which AI agents and developer tools are installed, install the
// missing ones in a pane (npm / winget), run their setup steps, and add your
// own agent commands.
import { ref, reactive, computed, onMounted, onBeforeUnmount } from 'vue'
import BrandIcon from './BrandIcon.vue'
import { DEV_TOOLS } from '../toolsCatalog'
import { settings } from '../settings'
import { describeSteps } from '../shellChain'

const props = defineProps({
  agents: { type: Array, default: () => [] }
})
const emit = defineEmits(['close', 'run', 'refresh', 'install-agent'])

const cardEl = ref(null)
const tab = ref('agents')
const found = reactive({}) // bin -> bool
const setup = reactive({}) // tool id -> setup status from the main process
const checking = ref(false)
const query = ref('')

const custom = reactive({ name: '', command: '', accent: '#8a93a6', error: '' })

const builtinAgents = computed(() => props.agents.filter((a) => !a.custom))
const customAgents = computed(() => props.agents.filter((a) => a.custom))

const filteredTools = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return DEV_TOOLS
  return DEV_TOOLS.filter((t) => `${t.name} ${t.desc} ${t.bin}`.toLowerCase().includes(q))
})

async function checkAll() {
  checking.value = true
  try {
    if (window.shellApi.refreshPath) await window.shellApi.refreshPath()
    if (window.shellApi.checkTools) {
      const res = await window.shellApi.checkTools(DEV_TOOLS.map((t) => t.bin))
      Object.assign(found, res || {})
    }
    await loadSetup()
    emit('refresh')
  } finally {
    checking.value = false
  }
}

async function loadSetup() {
  if (!window.shellApi.toolStatus) return
  try {
    Object.assign(setup, (await window.shellApi.toolStatus()) || {})
  } catch {
    /* keep showing the setup buttons */
  }
}

// What a tool's setup step looks like now: done (with a short summary) or not.
function setupState(t) {
  if (t.id === 'gh' && setup.gh) {
    return setup.gh.signedIn
      ? { done: true, text: setup.gh.account ? `Signed in as ${setup.gh.account}` : 'Signed in' }
      : { done: false }
  }
  if (t.id === 'git' && setup.git) {
    return setup.git.configured
      ? { done: true, text: `${setup.git.name} <${setup.git.email}>` }
      : { done: false }
  }
  return null
}

// Setup steps change status; check again a little after one is started, and
// again when you come back to the window.
function scheduleRecheck() {
  setTimeout(loadSetup, 15000)
  setTimeout(loadSetup, 45000)
}

function install(label, command) {
  emit('run', { label: `Install ${label}`, command })
}

function runAction(act) {
  emit('run', { label: act.label, command: act.command, shell: act.shell })
  scheduleRecheck()
}

function addCustom() {
  custom.error = ''
  const name = custom.name.trim()
  const command = custom.command.trim()
  if (!name || !command) {
    custom.error = 'Enter a name and the command that starts the agent.'
    return
  }
  if (settings.customAgents.some((a) => a.name.toLowerCase() === name.toLowerCase())) {
    custom.error = 'An agent with that name already exists.'
    return
  }
  settings.customAgents.push({
    id: `custom-${Date.now().toString(36)}`,
    name,
    command,
    accent: custom.accent
  })
  custom.name = ''
  custom.command = ''
  emit('refresh')
}

function removeCustom(id) {
  const i = settings.customAgents.findIndex((a) => a.id === id)
  if (i >= 0) settings.customAgents.splice(i, 1)
  emit('refresh')
}

function onWindowFocus() {
  loadSetup()
}

onMounted(() => {
  if (cardEl.value) cardEl.value.focus()
  checkAll()
  window.addEventListener('focus', onWindowFocus)
})

onBeforeUnmount(() => window.removeEventListener('focus', onWindowFocus))
</script>

<template>
  <div class="help-backdrop" @pointerdown.self="emit('close')">
    <div
      ref="cardEl"
      class="help-card tools-card"
      role="dialog"
      aria-label="Tools"
      tabindex="-1"
      @keydown.escape.prevent.stop="emit('close')"
    >
      <div class="help-head">
        <span>Tools</span>
        <div class="tools-head-actions">
          <button class="exit-btn" :disabled="checking" @click="checkAll">
            {{ checking ? 'Checking…' : 'Check again' }}
          </button>
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
      </div>

      <div class="launch-seg tools-tabs">
        <button class="launch-seg-btn" :class="{ on: tab === 'agents' }" @click="tab = 'agents'">
          AI agents
        </button>
        <button class="launch-seg-btn" :class="{ on: tab === 'dev' }" @click="tab = 'dev'">
          Developer tools
        </button>
      </div>
      <p class="mcp-intro">
        Installs run in a new pane so you can watch them. When one finishes, click
        <b>Check again</b>. New panes pick it up without restarting the app.
      </p>

      <!-- AI agents -->
      <template v-if="tab === 'agents'">
        <div v-for="a in builtinAgents" :key="a.id" class="tool-row">
          <BrandIcon :kind="a.id" :accent="a.accent" :label="a.name" :size="22" />
          <div class="tool-main">
            <span class="tool-name">{{ a.name }}</span>
            <code class="tool-cmd">{{ a.available ? a.command : describeSteps(a.install) }}</code>
          </div>
          <span v-if="a.available" class="tool-status ok">Installed</span>
          <button v-else-if="a.install" class="exit-btn primary" @click="emit('install-agent', a)">
            Install
          </button>
        </div>

        <h3 class="tools-sub">Your own agents</h3>
        <p class="set-hint">
          Any command-line agent works. It appears in the New menu and runs in the default shell.
        </p>
        <div v-for="a in customAgents" :key="a.id" class="tool-row">
          <BrandIcon :kind="a.id" :accent="a.accent" :label="a.name" :size="22" />
          <div class="tool-main">
            <span class="tool-name">{{ a.name }}</span>
            <code class="tool-cmd">{{ a.command }}</code>
          </div>
          <span class="tool-status" :class="{ ok: a.available }">{{
            a.available ? 'Found' : 'Not found on PATH'
          }}</span>
          <button class="ws-icon-btn small danger" title="Remove" @click="removeCustom(a.id)">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M4 4l8 8M12 4l-8 8"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
              />
            </svg>
          </button>
        </div>
        <form class="custom-agent-form" @submit.prevent="addCustom">
          <input v-model="custom.accent" type="color" class="custom-color" title="Color" />
          <input
            v-model="custom.name"
            class="set-number"
            placeholder="Name, e.g. Crush"
            spellcheck="false"
          />
          <input
            v-model="custom.command"
            class="set-number mcp-input"
            placeholder="Command, e.g. crush --yolo"
            spellcheck="false"
          />
          <button class="exit-btn primary" type="submit">Add agent</button>
        </form>
        <p v-if="custom.error" class="mcp-error">{{ custom.error }}</p>
      </template>

      <!-- Developer tools -->
      <template v-else>
        <input
          v-model="query"
          class="set-number tools-search"
          placeholder="Search tools"
          spellcheck="false"
        />
        <div v-for="t in filteredTools" :key="t.id" class="tool-row">
          <BrandIcon :kind="t.id" :accent="t.accent" :label="t.name" :size="22" />
          <div class="tool-main">
            <span class="tool-name">{{ t.name }}</span>
            <span class="set-hint">{{ t.desc }}</span>
          </div>
          <template v-if="found[t.bin]">
            <template v-if="setupState(t) && setupState(t).done">
              <span class="tool-setup" :title="setupState(t).text">{{ setupState(t).text }}</span>
              <button
                v-for="act in t.actions || []"
                :key="act.label"
                class="exit-btn subtle"
                :title="act.label"
                @click="runAction(act)"
              >
                {{ act.doneLabel || 'Change' }}
              </button>
            </template>
            <template v-else>
              <button
                v-for="act in t.actions || []"
                :key="act.label"
                class="exit-btn"
                @click="runAction(act)"
              >
                {{ act.label }}
              </button>
            </template>
            <span class="tool-status ok">Installed</span>
          </template>
          <span v-else-if="checking && found[t.bin] === undefined" class="set-hint">…</span>
          <button v-else class="exit-btn primary" @click="install(t.name, t.install)">
            Install
          </button>
        </div>
        <p class="set-hint tools-foot">
          Tools install with winget, the package manager built into Windows. Some installers ask for
          permission in a Windows prompt.
        </p>
      </template>
    </div>
  </div>
</template>
