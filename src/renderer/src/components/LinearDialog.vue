<!-- i18n-pending: text here does not go through t() yet -->
<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

const props = defineProps({
  cwd: { type: String, default: '' },
  agents: { type: Array, default: () => [] },
  defaultAgent: { type: String, default: '' },
  startIssue: { type: Function, default: null }
})
const emit = defineEmits(['close', 'start', 'busy'])
const card = ref(null)
const connection = ref(null)
const key = ref('')
const busy = ref(false)
const loading = ref(true)
const error = ref('')
const notice = ref('')
const disconnectConfirm = ref(false)
const filter = ref('assigned')
const teamId = ref('')
const stateId = ref('')
const teams = ref([])
const states = ref([])
const items = ref([])
const hasNextPage = ref(false)
const selected = ref(null)
const agentId = ref(props.defaultAgent || props.agents[0]?.id || '')
const worktree = ref(true)
const nextStateId = ref('')
const startStates = ref([])
const statesLoading = ref(false)
let alive = true
let statusRequest = 0
let listRequest = 0
let statesRequest = 0
let teamsRequest = 0
let startStatesRequest = 0
let previousFocus
const configured = computed(() => connection.value?.configured)
const api = () => window.shellApi.linear
const failed = (result) => {
  if (!result?.ok) throw new Error(result?.error || 'Linear request failed.')
  return result
}
function errorText(err, secret = '') {
  const value = err?.message || 'Linear request failed.'
  return secret ? value.split(secret).join('[redacted]') : value
}
function close() {
  if (!busy.value) emit('close')
}
async function openUrl(value) {
  try {
    const url = new URL(value)
    if (url.protocol === 'https:') await window.shellApi.openExternal(url.href)
  } catch {
    error.value = 'Could not open this link.'
  }
}
async function copy(value, message = 'Link copied.') {
  try {
    await window.shellApi.writeClipboard(value)
    notice.value = message
  } catch {
    error.value = 'Could not copy to the clipboard.'
  }
}
function copyIssue() {
  const item = selected.value
  copy(
    `${item.identifier} ${item.title}\n${item.url}\n\n${item.description || ''}`,
    'Issue copied.'
  )
}
async function loadStatus() {
  const request = ++statusRequest
  loading.value = true
  error.value = ''
  try {
    if (!window.shellApi.linear)
      throw new Error('Linear integration is not available in this version.')
    const result = failed(await api().status())
    if (!alive || request !== statusRequest) return
    connection.value = result
    if (result.configured) await Promise.all([loadTeams(), loadIssues()])
  } catch (err) {
    if (alive && request === statusRequest) error.value = errorText(err)
  } finally {
    if (alive && request === statusRequest && !configured.value) loading.value = false
  }
}
async function loadTeams() {
  const request = ++teamsRequest
  try {
    const result = failed(await api().teams())
    if (alive && request === teamsRequest) teams.value = result.teams || []
  } catch (err) {
    if (alive && request === teamsRequest) error.value = errorText(err)
  }
}
async function loadIssues(refresh = false) {
  if (!configured.value) return
  const request = ++listRequest
  loading.value = true
  error.value = ''
  try {
    const result = failed(
      await api().issues({
        filter: filter.value,
        ...(teamId.value ? { teamId: teamId.value } : {}),
        ...(stateId.value ? { stateId: stateId.value } : {}),
        refresh
      })
    )
    if (!alive || request !== listRequest) return
    items.value = result.items || []
    hasNextPage.value = !!result.hasNextPage
  } catch (err) {
    if (alive && request === listRequest) error.value = errorText(err)
  } finally {
    if (alive && request === listRequest) loading.value = false
  }
}
async function loadStates() {
  const request = ++statesRequest
  states.value = []
  if (!teamId.value) return
  try {
    const result = failed(await api().states({ teamId: teamId.value }))
    if (alive && request === statesRequest) states.value = result.states || []
  } catch (err) {
    if (alive && request === statesRequest) error.value = errorText(err)
  }
}
async function selectIssue(item) {
  selected.value = item
  nextStateId.value = ''
  startStates.value = []
  statesLoading.value = !!item.team?.id
  error.value = ''
  const request = ++startStatesRequest
  if (!item.team?.id) return
  try {
    const result = failed(await api().states({ teamId: item.team.id }))
    if (alive && request === startStatesRequest) startStates.value = result.states || []
  } catch (err) {
    if (alive && request === startStatesRequest) error.value = errorText(err)
  } finally {
    if (alive && request === startStatesRequest) statesLoading.value = false
  }
}
function back() {
  if (busy.value) return
  startStatesRequest++
  selected.value = null
  nextStateId.value = ''
  error.value = ''
}
async function connect() {
  if (busy.value || !key.value.trim()) return
  const secret = key.value.trim()
  busy.value = true
  error.value = ''
  try {
    const result = failed(await api().connect({ key: secret }))
    if (!alive) return
    key.value = ''
    connection.value = result
    notice.value = 'Connected to Linear.'
    await Promise.all([loadTeams(), loadIssues()])
  } catch (err) {
    if (alive) error.value = errorText(err, secret)
  } finally {
    if (alive) busy.value = false
  }
}
async function disconnect() {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    failed(await api().disconnect())
    if (!alive) return
    listRequest++
    statesRequest++
    startStatesRequest++
    statusRequest++
    teamsRequest++
    connection.value = { configured: false }
    items.value = []
    teams.value = []
    states.value = []
    selected.value = null
    key.value = ''
    disconnectConfirm.value = false
    notice.value = 'Disconnected from Linear.'
    loading.value = false
  } catch (err) {
    if (alive) error.value = errorText(err)
  } finally {
    if (alive) busy.value = false
  }
}
async function start() {
  if (!selected.value || busy.value || !agentId.value) return
  const request = {
    provider: 'linear',
    item: selected.value,
    agentId: agentId.value,
    worktree: worktree.value,
    ...(nextStateId.value ? { stateId: nextStateId.value } : {})
  }
  busy.value = true
  error.value = ''
  try {
    if (!props.startIssue) {
      emit('start', request)
      notice.value = 'Task preparation requested.'
      return
    }
    failed(await props.startIssue(request))
    if (alive) emit('close')
  } catch (err) {
    if (alive) error.value = errorText(err)
  } finally {
    if (alive) busy.value = false
  }
}
function onKey(event) {
  if (event.key === 'Escape') {
    event.stopPropagation()
    close()
    return
  }
  if (event.key !== 'Tab') return
  const controls = [...card.value.querySelectorAll('button,input,select,textarea,a[href]')].filter(
    (el) => !el.disabled
  )
  const first = controls[0],
    last = controls.at(-1)
  if (
    document.activeElement === card.value ||
    (event.shiftKey && document.activeElement === first)
  ) {
    event.preventDefault()
    ;(event.shiftKey ? last : first)?.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first?.focus()
  }
}
watch([filter, stateId], () => {
  back()
  loadIssues()
})
watch(teamId, () => {
  stateId.value = ''
  back()
  loadStates()
  loadIssues()
})
watch(busy, (value) => emit('busy', value), { flush: 'sync' })
onMounted(() => {
  previousFocus = document.activeElement
  nextTick(() => card.value?.focus())
  loadStatus()
})
onBeforeUnmount(() => {
  alive = false
  key.value = ''
  previousFocus?.focus?.()
})
</script>

<template>
  <div class="help-backdrop issue-backdrop" @pointerdown.self="close">
    <div
      ref="card"
      class="issue-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="linear-dialog-title"
      tabindex="-1"
      @keydown="onKey"
    >
      <header class="issue-dialog-head">
        <div>
          <h2 id="linear-dialog-title">Linear</h2>
          <p>{{ connection?.organization?.name || 'Issues for your agents' }}</p>
        </div>
        <button class="issue-btn" aria-label="Close Linear" :disabled="busy" @click="close">
          ✕
        </button>
      </header>
      <div class="issue-dialog-body">
        <p v-if="error" class="issue-error" role="alert">
          {{ error }}
          <button v-if="!configured" class="issue-link" :disabled="busy" @click="loadStatus">
            Retry connection
          </button>
        </p>
        <p v-if="notice" class="issue-notice" role="status">{{ notice }}</p>
        <template v-if="!configured"
          ><p v-if="loading" class="issue-empty">Reading connection…</p>
          <form v-else class="issue-form" @submit.prevent="connect">
            <h3>Connect Linear</h3>
            <p class="issue-hint">
              Use a personal API key from Linear Settings → Security & access. It is stored securely
              on this computer.
            </p>
            <label
              >Personal API key<input
                v-model="key"
                data-test="linear-key"
                type="password"
                autocomplete="off"
                spellcheck="false"
                :disabled="busy"
            /></label>
            <div class="issue-actions">
              <button
                type="button"
                class="issue-btn"
                :disabled="busy"
                @click="openUrl('https://linear.app/settings/api')"
              >
                Open Linear settings</button
              ><button
                class="issue-btn primary"
                data-test="linear-connect"
                :disabled="busy || !key.trim()"
              >
                {{ busy ? 'Testing…' : 'Test and save' }}
              </button>
            </div>
          </form></template
        >
        <template v-else>
          <div class="issue-toolbar">
            <span class="issue-hint">{{
              connection.viewer?.displayName || connection.viewer?.name || 'Connected'
            }}</span
            ><span class="issue-spacer"></span
            ><button class="issue-btn" :disabled="busy || loading" @click="loadIssues(true)">
              Refresh</button
            ><button
              class="issue-btn"
              data-test="linear-disconnect"
              :disabled="busy"
              @click="disconnectConfirm = true"
            >
              Disconnect
            </button>
          </div>
          <div
            v-if="disconnectConfirm"
            class="issue-confirm"
            role="group"
            aria-label="Confirm Linear disconnect"
          >
            <p>Remove the saved Linear key from this computer? Your Linear issues will remain.</p>
            <div class="issue-actions">
              <button class="issue-btn" :disabled="busy" @click="disconnectConfirm = false">
                Keep connection</button
              ><button
                class="issue-btn"
                data-test="linear-disconnect-confirm"
                :disabled="busy"
                @click="disconnect"
              >
                Disconnect
              </button>
            </div>
          </div>
          <template v-if="selected">
            <div class="issue-toolbar">
              <button class="issue-link" :disabled="busy" @click="back">← Issues</button
              ><span class="issue-spacer"></span
              ><button class="issue-btn" @click="openUrl(selected.url)">Open</button
              ><button class="issue-btn" @click="copy(selected.url)">Copy link</button>
            </div>
            <h3 class="issue-item-title">
              <span class="issue-id">{{ selected.identifier }}</span> {{ selected.title }}
            </h3>
            <div class="issue-labels">
              <span class="issue-tag">{{ selected.state?.name || 'Unknown state' }}</span
              ><span v-if="selected.team?.name" class="issue-tag">{{ selected.team.name }}</span
              ><span v-if="selected.assignee?.name" class="issue-tag">{{
                selected.assignee.name
              }}</span>
            </div>
            <pre class="issue-prose">{{ selected.description || 'No description.' }}</pre>
            <div class="issue-start">
              <h4>Work on this issue</h4>
              <div class="issue-start-row">
                <label class="issue-field"
                  >Agent<select
                    v-model="agentId"
                    aria-label="Agent for Linear issue"
                    :disabled="busy"
                  >
                    <option v-for="agent in agents" :key="agent.id" :value="agent.id">
                      {{ agent.name || agent.id }}
                    </option>
                  </select></label
                ><label class="issue-checkbox"
                  ><input v-model="worktree" type="checkbox" :disabled="busy" />Own Git copy</label
                >
              </div>
              <label class="issue-field"
                >After the task is prepared<select
                  v-model="nextStateId"
                  data-test="linear-start-state"
                  :disabled="busy || statesLoading"
                >
                  <option value="">Keep current Linear state</option>
                  <option v-for="state in startStates" :key="state.id" :value="state.id">
                    Move to {{ state.name }}
                  </option>
                </select></label
              >
              <p class="issue-hint">
                An optional state change is applied only after Tessel has prepared the task
                successfully.
              </p>
              <div class="issue-actions">
                <button class="issue-btn" @click="copyIssue">Copy issue</button
                ><button
                  class="issue-btn primary"
                  data-test="linear-start"
                  :disabled="busy || !agentId"
                  @click="start"
                >
                  {{ busy ? 'Preparing…' : 'Start task' }}
                </button>
              </div>
            </div>
          </template>
          <template v-else>
            <div class="issue-filters">
              <label
                >Show<select v-model="filter" data-test="linear-filter" :disabled="busy">
                  <option value="assigned">Assigned to me</option>
                  <option value="created">Created by me</option>
                  <option value="open">All open</option>
                  <option value="completed">Completed</option>
                  <option value="all">All issues</option>
                </select></label
              ><label
                >Team<select v-model="teamId" data-test="linear-team" :disabled="busy">
                  <option value="">All teams</option>
                  <option v-for="team in teams" :key="team.id" :value="team.id">
                    {{ team.name }}
                  </option>
                </select></label
              ><label
                >State<select
                  v-model="stateId"
                  data-test="linear-state"
                  :disabled="busy || !teamId"
                >
                  <option value="">All states</option>
                  <option v-for="state in states" :key="state.id" :value="state.id">
                    {{ state.name }}
                  </option>
                </select></label
              >
            </div>
            <p v-if="loading" class="issue-empty" role="status">Reading issues…</p>
            <p v-else-if="!items.length && !error" class="issue-empty">
              No issues match this view.
            </p>
            <p v-if="hasNextPage" class="issue-hint">
              Showing the first 100 issues. Narrow the filters to find more.
            </p>
            <div class="issue-list">
              <button
                v-for="item in items"
                :key="item.id"
                class="issue-row"
                data-test="linear-item"
                :disabled="busy || loading"
                @click="selectIssue(item)"
              >
                <span class="issue-row-heading"
                  ><span class="issue-id">{{ item.identifier }}</span
                  ><strong>{{ item.title }}</strong></span
                ><span class="issue-row-meta"
                  >{{ item.state?.name || 'Unknown state'
                  }}<span v-if="item.team?.name"> · {{ item.team.name }}</span
                  ><span v-if="item.assignee?.name"> · {{ item.assignee.name }}</span></span
                >
              </button>
            </div>
          </template>
        </template>
      </div>
    </div>
  </div>
</template>
