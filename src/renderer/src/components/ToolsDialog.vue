<script setup>
// "Tools": see which AI agents and developer tools are installed, install the
// missing ones in a pane (npm / winget), run their setup steps, and add your
// own agent commands.
import { ref, reactive, computed, onMounted, onBeforeUnmount } from 'vue'
import BrandIcon from './BrandIcon.vue'
import { DEV_TOOLS } from '../toolsCatalog'
import { settings } from '../settings'
import { describeSteps } from '../shellChain'
import { t } from '../i18n'

const props = defineProps({
  agents: { type: Array, default: () => [] }
})
const emit = defineEmits(['close', 'run', 'refresh', 'install-agent'])

const cardEl = ref(null)
const tab = ref('needs')

// What Tessel itself needs (main process, tesselNeeds.js): each row ok, to
// fix, missing or optional, with the install or the place to fix it.
// (Text with {{placeholders}} is built here: in the template, "}}" would end
// the interpolation.)
function fixWhere(where) {
  return t('tools.needs.fixWhere', 'Fix: {{where}}', { where })
}
function needLabel(status) {
  if (status === 'ok') return t('tools.needs.ok', 'OK')
  if (status === 'warn') return t('tools.needs.warn', 'To fix')
  if (status === 'missing') return t('tools.needs.missing', 'Missing')
  if (status === 'optional') return t('tools.needs.optional', 'Optional')
  return status
}
const toolById = Object.fromEntries(DEV_TOOLS.map((tool) => [tool.id, tool]))
const needs = ref(null)
const needsError = ref('')
const needsToFix = computed(() => (needs.value || []).filter((r) => r.status === 'warn' || r.status === 'missing').length)
async function loadNeeds() {
  if (!window.shellApi.tesselNeeds) return
  needsError.value = ''
  try {
    const res = await window.shellApi.tesselNeeds()
    if (res && res.ok) needs.value = res.rows
    else needsError.value = (res && res.error) || t('tools.needs.checkFailed', 'Could not check.')
  } catch (err) {
    needsError.value = (err && err.message) || t('tools.needs.checkFailed', 'Could not check.')
  }
}
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
  return DEV_TOOLS.filter((tool) => `${tool.name} ${tool.desc} ${tool.bin}`.toLowerCase().includes(q))
})

async function checkAll() {
  checking.value = true
  try {
    if (window.shellApi.refreshPath) await window.shellApi.refreshPath()
    if (window.shellApi.checkTools) {
      const res = await window.shellApi.checkTools(DEV_TOOLS.map((tool) => tool.bin))
      Object.assign(found, res || {})
    }
    await loadSetup()
    await loadNeeds()
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
function setupState(tool) {
  if (tool.id === 'gh' && setup.gh) {
    return setup.gh.signedIn
      ? {
          done: true,
          text: setup.gh.account
            ? t('tools.dev.signedInAs', 'Signed in as {{account}}', { account: setup.gh.account })
            : t('tools.dev.signedIn', 'Signed in')
        }
      : { done: false }
  }
  if (tool.id === 'git' && setup.git) {
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
  emit('run', { label: t('tools.installPane', 'Install {{name}}', { name: label }), command })
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
    custom.error = t('tools.custom.needNameCommand', 'Enter a name and the command that starts the agent.')
    return
  }
  if (settings.customAgents.some((a) => a.name.toLowerCase() === name.toLowerCase())) {
    custom.error = t('tools.custom.nameTaken', 'An agent with that name already exists.')
    return
  }
  settings.customAgents.push({
    id: `custom-${Date.now().toString(36)}`, // i18n-ignore
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
      :aria-label="t('tools.title', 'Tools')"
      tabindex="-1"
      @keydown.escape.prevent.stop="emit('close')"
    >
      <div class="help-head">
        <span>{{ t('tools.title', 'Tools') }}</span>
        <div class="tools-head-actions">
          <button class="exit-btn" :disabled="checking" @click="checkAll">
            {{ checking ? t('tools.checking', 'Checking…') : t('tools.checkAgain', 'Check again') }}
          </button>
          <button class="tb-icon" :title="t('tools.close', 'Close (Esc)')" @click="emit('close')">
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
        <button class="launch-seg-btn" :class="{ on: tab === 'needs' }" @click="tab = 'needs'">
          {{ t('tools.tab.needs', 'Tessel needs') }}<span v-if="needsToFix" class="mcp-count">{{ needsToFix }}</span>
        </button>
        <button class="launch-seg-btn" :class="{ on: tab === 'agents' }" @click="tab = 'agents'">
          {{ t('tools.tab.agents', 'AI agents') }}
        </button>
        <button class="launch-seg-btn" :class="{ on: tab === 'dev' }" @click="tab = 'dev'">
          {{ t('tools.tab.dev', 'Developer tools') }}
        </button>
      </div>
      <p class="mcp-intro">
        {{
          t('tools.intro', 'Installs run in a new pane so you can watch them. When one finishes, click Check again. New panes pick it up without restarting the app.')
        }}
      </p>

      <!-- What Tessel itself needs -->
      <template v-if="tab === 'needs'">
        <p v-if="needsError" class="mcp-error">{{ needsError }}</p>
        <p v-else-if="!needs" class="set-hint">{{ t('tools.checking', 'Checking…') }}</p>
        <p v-else-if="!needsToFix" class="mcp-notice">{{ t('tools.needs.allHere', 'Everything Tessel needs is here.') }}</p>
        <div v-for="r in needs || []" :key="r.id" class="tool-row">
          <div class="tool-main">
            <span class="tool-name">{{ r.name }}</span>
            <span class="tool-why">{{ r.why }}</span>
            <span class="tool-detail">{{ r.detail }}</span>
            <span v-if="r.fix && r.fix.where" class="tool-why">{{ fixWhere(r.fix.where) }}</span>
          </div>
          <span class="tool-status" :class="r.status">{{ needLabel(r.status) }}</span>
          <button v-if="r.fix && r.fix.install && toolById[r.fix.install]" class="exit-btn primary" @click="install(toolById[r.fix.install].name, toolById[r.fix.install].install)">
            {{ t('tools.install', 'Install') }}
          </button>
          <button v-else-if="r.fix && r.fix.run" class="exit-btn primary" @click="runAction({ label: r.fix.run, command: r.fix.run })">
            {{ t('tools.update', 'Update') }}
          </button>
        </div>
      </template>

      <!-- AI agents -->
      <template v-else-if="tab === 'agents'">
        <div v-for="a in builtinAgents" :key="a.id" class="tool-row">
          <BrandIcon :kind="a.id" :accent="a.accent" :label="a.name" :size="22" />
          <div class="tool-main">
            <span class="tool-name">{{ a.name }}</span>
            <code class="tool-cmd">{{ a.available ? a.command : describeSteps(a.install) }}</code>
          </div>
          <span v-if="a.available" class="tool-status ok">{{ t('tools.installed', 'Installed') }}</span>
          <button v-else-if="a.install" class="exit-btn primary" @click="emit('install-agent', a)">
            {{ t('tools.install', 'Install') }}
          </button>
        </div>

        <h3 class="tools-sub">{{ t('tools.custom.title', 'Your own agents') }}</h3>
        <p class="set-hint">
          {{
            t('tools.custom.hint', 'Any command-line agent works. It appears in the New menu and runs in the default shell.')
          }}
        </p>
        <div v-for="a in customAgents" :key="a.id" class="tool-row">
          <BrandIcon :kind="a.id" :accent="a.accent" :label="a.name" :size="22" />
          <div class="tool-main">
            <span class="tool-name">{{ a.name }}</span>
            <code class="tool-cmd">{{ a.command }}</code>
          </div>
          <span class="tool-status" :class="{ ok: a.available }">{{
            a.available ? t('tools.custom.found', 'Found') : t('tools.custom.notFound', 'Not found on PATH')
          }}</span>
          <button class="ws-icon-btn small danger" :title="t('tools.custom.remove', 'Remove')" @click="removeCustom(a.id)">
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
          <input v-model="custom.accent" type="color" class="custom-color" :title="t('tools.custom.color', 'Color')" />
          <input
            v-model="custom.name"
            class="set-number"
            :placeholder="t('tools.custom.namePlaceholder', 'Name, e.g. Crush')"
            spellcheck="false"
          />
          <input
            v-model="custom.command"
            class="set-number mcp-input"
            :placeholder="t('tools.custom.commandPlaceholder', 'Command, e.g. crush --yolo')"
            spellcheck="false"
          />
          <button class="exit-btn primary" type="submit">{{ t('tools.custom.add', 'Add agent') }}</button>
        </form>
        <p v-if="custom.error" class="mcp-error">{{ custom.error }}</p>
      </template>

      <!-- Developer tools -->
      <template v-else>
        <input
          v-model="query"
          class="set-number tools-search"
          :placeholder="t('tools.dev.search', 'Search tools')"
          spellcheck="false"
        />
        <div v-for="tool in filteredTools" :key="tool.id" class="tool-row">
          <BrandIcon :kind="tool.id" :accent="tool.accent" :label="tool.name" :size="22" />
          <div class="tool-main">
            <span class="tool-name">{{ tool.name }}</span>
            <span class="set-hint">{{ tool.desc }}</span>
          </div>
          <template v-if="found[tool.bin]">
            <template v-if="setupState(tool) && setupState(tool).done">
              <span class="tool-setup" :title="setupState(tool).text">{{ setupState(tool).text }}</span>
              <button
                v-for="act in tool.actions || []"
                :key="act.label"
                class="exit-btn subtle"
                :title="act.label"
                @click="runAction(act)"
              >
                {{ act.doneLabel || t('tools.dev.change', 'Change') }}
              </button>
            </template>
            <template v-else>
              <button
                v-for="act in tool.actions || []"
                :key="act.label"
                class="exit-btn"
                @click="runAction(act)"
              >
                {{ act.label }}
              </button>
            </template>
            <span class="tool-status ok">{{ t('tools.installed', 'Installed') }}</span>
          </template>
          <span v-else-if="checking && found[tool.bin] === undefined" class="set-hint">…</span>
          <button v-else class="exit-btn primary" @click="install(tool.name, tool.install)">
            {{ t('tools.install', 'Install') }}
          </button>
        </div>
        <p class="set-hint tools-foot">
          {{
            t('tools.dev.foot', 'Tools install with winget, the package manager built into Windows. Some installers ask for permission in a Windows prompt.')
          }}
        </p>
      </template>
    </div>
  </div>
</template>
