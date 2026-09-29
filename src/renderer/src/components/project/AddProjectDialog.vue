<script setup>
// "Add a project", like Orca's (MIT, Copyright (c) 2026 Lovecast Inc.:
// components/sidebar/AddRepoDialog.tsx, AddRepoStartSteps.tsx,
// AddRepoCloneStep.tsx, AddRepoCreateStep.tsx, AddRepoRemoteStep.tsx,
// AddRepoStepIndicator.tsx and their hooks).
// - Host: this computer or a saved SSH host.
// - Browse folder: a folder, a repository, or a folder holding several
//   repositories (they are found and offered: AddProjectNestedStep).
//   On an SSH host: the path of a folder on that host.
// - Clone from URL, Create new project: on this computer.
// It emits `add` with the projects to make ({ name, cwd } / { name, remote:
// { hostId, path } } / { name, cwd, group }); App makes them.
import { ref, computed, onMounted, onBeforeUnmount, nextTick, watch } from 'vue'
import { ArrowLeft, ChevronDown, Folder, GitBranch, LoaderCircle, CircleStop, X } from 'lucide-vue-next'
import { t } from '../../i18n'
import { remoteHostsState, refreshRemoteHosts } from '../../remoteHosts'
import {
  LOCAL_HOST_ID,
  buildHostOptions,
  startActions,
  baseName,
  joinPath,
  newScanId,
  planImport,
  remotePathError,
  remoteProjectName
} from '../../addProject'
import AddProjectHostSelector from './AddProjectHostSelector.vue'
import AddProjectNestedStep from './AddProjectNestedStep.vue'

const props = defineProps({
  projectCount: { type: Number, default: 1 },
  initialHostId: { type: String, default: LOCAL_HOST_ID }
})
const emit = defineEmits(['close', 'add', 'manage-hosts'])

const step = ref('add') // 'add' | 'clone' | 'create' | 'remote' | 'nested'
const hostId = ref(props.initialHostId || LOCAL_HOST_ID)
const hosts = computed(() => buildHostOptions(remoteHostsState.targets, remoteHostsState.states))
const host = computed(() => hosts.value.find((h) => h.id === hostId.value) || hosts.value[0])
const actions = computed(() => startActions(host.value ? host.value.kind : 'local'))
// A saved host removed meanwhile: back to this computer.
watch(hosts, (list) => {
  if (!list.some((h) => h.id === hostId.value)) hostId.value = LOCAL_HOST_ID
})

const busy = ref(false)
const busyLabel = ref('')
const startError = ref('')
let gen = 0

const api = () => (window.shellApi && window.shellApi.addProject) || null

// --- The start step: roving selection (the ⏎ chip follows keyboard focus) ----
const selectedKind = ref('browse')
const actionsEl = ref(null)
const browseEl = ref(null)
const shownKind = computed(() => (busy.value ? null : selectedKind.value))
function onActionsKey(e) {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
  const buttons = Array.from(actionsEl.value ? actionsEl.value.querySelectorAll('button[data-ap-action]:not(:disabled)') : [])
  if (!buttons.length) return
  const i = buttons.indexOf(document.activeElement)
  e.preventDefault()
  buttons[(i + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length].focus()
}
function onActionsBlur(e) {
  const next = e.relatedTarget
  if (!(next instanceof HTMLElement) || !next.matches('button[data-ap-action]')) selectedKind.value = null
}
function focusBrowse() {
  nextTick(() => browseEl.value && browseEl.value.focus())
}

function onAction(kind) {
  if (busy.value) return
  startError.value = ''
  if (kind === 'browse') return host.value && host.value.kind === 'ssh' ? openRemote() : browseLocal()
  if (kind === 'clone') return openClone()
  if (kind === 'create') return openCreate()
}

function emitAdd(projects, source) {
  if (!projects.length) return
  emit('add', { projects, source })
}

// --- Browse folder (this computer) + nested repositories ---------------------
const scan = ref(null)
const scanning = ref(false)
const selectedRepos = ref([])
const groupName = ref('')
let scanId = null
let stopScanProgress = null

function showNested(result) {
  if (step.value !== 'nested') {
    step.value = 'nested'
    groupName.value = baseName(result.selectedPath) || result.selectedPath
  }
  scan.value = result
  selectedRepos.value = result.repos.map((r) => r.path)
}

async function browseLocal() {
  const a = api()
  if (!a || !window.shellApi.pickFolder) return
  const my = ++gen
  busy.value = true
  busyLabel.value = t('project.busy.choose', 'Choose a folder...')
  try {
    const path = await window.shellApi.pickFolder({ title: t('project.browse.pickTitle', 'Choose a project folder') })
    if (my !== gen || !path) return
    busyLabel.value = t('project.busy.scanning', 'Scanning for repositories...')
    scanId = newScanId()
    const id = scanId
    scanning.value = true
    if (a.onScanProgress)
      stopScanProgress = a.onScanProgress((msg) => {
        if (my !== gen || !msg || msg.scanId !== id || !msg.scan) return
        if (msg.scan.selectedPathKind === 'non_git_folder' && msg.scan.repos.length) showNested(msg.scan)
      })
    const res = await a.scan(path, id)
    if (my !== gen) return
    endScan()
    if (!res || !res.ok) {
      startError.value = (res && res.error) || t('project.error.generic', 'Something went wrong.')
      return
    }
    const s = res.scan
    if (s.selectedPathKind === 'non_git_folder' && s.repos.length) {
      showNested(s)
      return
    }
    busyLabel.value = t('project.busy.opening', 'Opening project...')
    emitAdd([{ name: baseName(path), cwd: path }], 'browse')
  } finally {
    if (my === gen) {
      endScan()
      busy.value = false
      busyLabel.value = ''
    }
  }
}

function endScan() {
  scanning.value = false
  if (stopScanProgress) stopScanProgress()
  stopScanProgress = null
}

function stopScan() {
  const a = api()
  if (a && scanId && scanning.value) a.scanStop(scanId)
}

function importNested(mode) {
  if (!scan.value) return
  emitAdd(planImport({ scan: scan.value, selectedPaths: selectedRepos.value, mode, groupName: groupName.value }), mode === 'group' ? 'group' : 'separate')
}
function openNestedFolder() {
  if (!scan.value) return
  emitAdd(planImport({ scan: scan.value, selectedPaths: [], mode: 'folder' }), 'folder')
}

// --- Defaults (parent folder, is Git there) -----------------------------------
const defaultParent = ref('')
const gitAvailability = ref('unknown') // 'unknown' | 'checking' | 'available' | 'unavailable'
async function loadDefaults() {
  const a = api()
  if (!a) return
  if (gitAvailability.value === 'unknown') gitAvailability.value = 'checking'
  try {
    const res = await a.defaults()
    if (res && res.ok) {
      defaultParent.value = res.parent || ''
      gitAvailability.value = res.gitAvailable ? 'available' : 'unavailable'
    } else gitAvailability.value = 'unknown'
  } catch {
    gitAvailability.value = 'unknown'
  }
}

// --- Clone from URL -----------------------------------------------------------
const cloneUrl = ref('')
const cloneDest = ref('')
const cloneError = ref('')
const cloneProgress = ref(null)
const cloning = ref(false)
const canClone = computed(() => !!cloneUrl.value.trim() && !!cloneDest.value.trim() && !cloning.value)
let stopCloneProgress = null

async function openClone() {
  if (actions.value.secondary.find((x) => x.kind === 'clone').disabled) return
  cloneError.value = ''
  step.value = 'clone'
  await loadDefaults()
  if (step.value === 'clone' && !cloneDest.value) cloneDest.value = defaultParent.value
}
async function pickCloneDest() {
  const my = gen
  const dir = await window.shellApi.pickFolder({ title: t('project.clone.pickTitle', 'Choose where to clone it'), defaultPath: cloneDest.value || undefined })
  if (dir && my === gen) {
    cloneDest.value = dir
    cloneError.value = ''
  }
}
async function doClone() {
  const a = api()
  if (!a || !canClone.value) return
  const my = ++gen
  cloning.value = true
  cloneError.value = ''
  cloneProgress.value = null
  if (a.onCloneProgress)
    stopCloneProgress = a.onCloneProgress((p) => {
      if (my === gen && p && Number.isFinite(p.percent)) cloneProgress.value = { phase: String(p.phase || ''), percent: p.percent }
    })
  let res
  try {
    res = await a.clone(cloneUrl.value.trim(), cloneDest.value.trim())
  } catch (err) {
    res = { ok: false, error: err && err.message }
  }
  if (stopCloneProgress) stopCloneProgress()
  stopCloneProgress = null
  if (my !== gen) return
  cloning.value = false
  if (res && res.ok) emitAdd([{ name: res.name || baseName(res.path), cwd: res.path }], 'clone')
  else if (!(res && res.aborted)) cloneError.value = (res && res.error) || t('project.error.generic', 'Something went wrong.')
}
function onCloneKey(e) {
  if (e.key === 'Enter' && !e.isComposing) {
    e.preventDefault()
    if (canClone.value) doClone()
  }
}

// --- Create new project -------------------------------------------------------
const createName = ref('')
const createParent = ref('')
const createError = ref('')
const creating = ref(false)
const advancedOpen = ref(false)
const canCreate = computed(
  () =>
    !!createName.value.trim() &&
    !!createParent.value.trim() &&
    gitAvailability.value !== 'checking' &&
    gitAvailability.value !== 'unavailable' &&
    !creating.value
)
const targetPreview = computed(() => (createParent.value.trim() ? joinPath(createParent.value, createName.value.trim() || 'project-name') : ''))

async function openCreate() {
  if (actions.value.secondary.find((x) => x.kind === 'create').disabled) return
  createError.value = ''
  step.value = 'create'
  await loadDefaults()
  if (step.value === 'create' && !createParent.value) createParent.value = defaultParent.value
}
async function pickCreateParent() {
  const my = gen
  const dir = await window.shellApi.pickFolder({ title: t('project.create.pickTitle', 'Choose parent folder...'), defaultPath: createParent.value || undefined })
  if (dir && my === gen) {
    createParent.value = dir
    createError.value = ''
  }
}
async function doCreate() {
  const a = api()
  if (!a || !canCreate.value) return
  const my = ++gen
  creating.value = true
  createError.value = ''
  let res
  try {
    res = await a.create(createParent.value.trim(), createName.value.trim())
  } catch (err) {
    res = { ok: false, error: err && err.message }
  }
  if (my !== gen) return
  creating.value = false
  if (res && res.ok) emitAdd([{ name: res.name, cwd: res.path }], 'create')
  else createError.value = (res && res.error) || t('project.error.generic', 'Something went wrong.')
}
function summaryText() {
  const parent = createParent.value.trim() || t('project.create.noLocation', 'location not selected')
  return t('project.create.summary', '{{kind}} in {{parent}}', { kind: t('project.create.kindGit', 'Git repository'), parent })
}

// --- A folder on an SSH host --------------------------------------------------
const remotePath = ref('')
const remoteError = ref('')
function openRemote() {
  remoteError.value = ''
  step.value = 'remote'
}
function doAddRemote() {
  const err = remotePathError(remotePath.value)
  if (err) {
    remoteError.value = err
    return
  }
  const h = host.value
  const path = remotePath.value.trim()
  emitAdd([{ name: remoteProjectName(path, h.label), remote: { hostId: h.id, path } }], 'remote')
}
function remoteDescription() {
  return t('project.remote.description', 'Enter the path to a Git repository on {{host}}.', { host: host.value ? host.value.label : '' })
}

// --- Back, close ---------------------------------------------------------------
// Orca's resetState: a running clone is killed, a scan stopped.
function reset() {
  gen++
  if (cloning.value && api()) api().cloneAbort()
  if (scanning.value) stopScan()
  endScan()
  if (stopCloneProgress) stopCloneProgress()
  stopCloneProgress = null
  busy.value = false
  busyLabel.value = ''
  startError.value = ''
  scan.value = null
  selectedRepos.value = []
  groupName.value = ''
  cloneUrl.value = ''
  cloneDest.value = ''
  cloneError.value = ''
  cloneProgress.value = null
  cloning.value = false
  createName.value = ''
  createParent.value = ''
  createError.value = ''
  creating.value = false
  advancedOpen.value = false
  remotePath.value = ''
  remoteError.value = ''
}
const showBack = computed(() => step.value !== 'add')
function back() {
  if (step.value === 'nested' && busy.value) return
  reset()
  step.value = 'add'
  selectedKind.value = 'browse'
  focusBrowse()
}
function close() {
  reset()
  emit('close')
}
function onKeydown(e) {
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    close()
  }
}

onMounted(() => {
  if (!remoteHostsState.loaded) refreshRemoteHosts()
  focusBrowse()
})
onBeforeUnmount(() => {
  if (cloning.value || scanning.value) reset()
})
defineExpose({ step, hostId })
</script>

<template>
  <div class="ap-backdrop" @pointerdown.self="close">
    <div class="ap-dialog" :class="{ nested: step === 'nested' }" role="dialog" aria-modal="true" aria-labelledby="ap-heading" data-test="add-project" @keydown="onKeydown">
      <button type="button" class="ap-close" :aria-label="t('project.close', 'Close')" :title="t('project.close', 'Close')" data-test="ap-close" @click="close">
        <X :size="16" aria-hidden="true" />
      </button>

      <div v-if="showBack" class="ap-back-row">
        <button type="button" class="ap-back" :disabled="step === 'nested' && busy" data-test="ap-back" @click="back">
          <ArrowLeft :size="12" aria-hidden="true" />
          {{ t('project.back', 'Back') }}
        </button>
      </div>

      <!-- Start -->
      <template v-if="step === 'add'">
        <header class="ap-head">
          <h2 id="ap-heading" class="ap-title">{{ t('project.start.title', 'Add a project') }}</h2>
          <p v-if="projectCount === 0" class="ap-desc">{{ t('project.start.getStarted', 'Add a project to get started with Tessel.') }}</p>
        </header>
        <div ref="actionsEl" class="ap-start" @keydown="onActionsKey" @focusout="onActionsBlur">
          <AddProjectHostSelector :hosts="hosts" :selected-id="hostId" :disabled="busy" @select="(id) => (hostId = id)" @add-host="emit('manage-hosts')" />
          <button
            ref="browseEl"
            type="button"
            class="ap-primary"
            :class="{ selected: shownKind === actions.primary.kind }"
            :disabled="busy"
            data-ap-action
            data-test="ap-browse"
            @focus="selectedKind = actions.primary.kind"
            @click="onAction('browse')"
          >
            <span class="ap-action-icon"><component :is="actions.primary.icon" :size="16" aria-hidden="true" /></span>
            <span class="ap-action-body">
              <span class="ap-action-title">{{ actions.primary.title }}</span>
              <span class="ap-action-desc">{{ actions.primary.description }}</span>
            </span>
            <span v-if="shownKind === actions.primary.kind" class="ap-enter" aria-hidden="true">⏎</span>
          </button>

          <div class="ap-others">
            <p class="ap-others-label">{{ t('project.start.otherWays', 'Other ways to add') }}</p>
            <div class="ap-others-box">
              <button
                v-for="(action, i) in actions.secondary"
                :key="action.kind"
                type="button"
                class="ap-secondary"
                :class="{ selected: shownKind === action.kind, first: i === 0 }"
                :disabled="busy || action.disabled"
                data-ap-action
                :data-test="'ap-' + action.kind"
                @focus="selectedKind = action.kind"
                @click="onAction(action.kind)"
              >
                <span class="ap-action-icon dim"><component :is="action.icon" :size="16" aria-hidden="true" /></span>
                <span class="ap-action-body">
                  <span class="ap-action-title">{{ action.title }}</span>
                  <span class="ap-action-desc small">{{ action.description }}</span>
                </span>
                <span v-if="shownKind === action.kind" class="ap-enter" aria-hidden="true">⏎</span>
              </button>
            </div>
          </div>

          <div v-if="busy && busyLabel" class="ap-busy" data-test="ap-busy">
            <LoaderCircle :size="14" class="ap-spin" aria-hidden="true" />
            <span class="ap-busy-label">{{ busyLabel }}</span>
            <button
              v-if="scanning"
              type="button"
              class="ap-busy-stop"
              :aria-label="t('project.nested.stopScan', 'Stop scan')"
              :title="t('project.nested.stopScanning', 'Stop scanning')"
              @click="stopScan"
            >
              <CircleStop :size="14" aria-hidden="true" />
            </button>
          </div>
          <p v-if="startError" class="ap-error" role="alert">{{ startError }}</p>
        </div>
      </template>

      <!-- Clone from URL -->
      <template v-else-if="step === 'clone'">
        <header class="ap-head">
          <h2 id="ap-heading" class="ap-title">{{ t('project.clone.title', 'Clone from URL') }}</h2>
          <p class="ap-desc">{{ t('project.clone.description', 'Enter the Git URL and choose where to clone it.') }}</p>
        </header>
        <div class="ap-form">
          <div class="ap-field">
            <label class="ap-label" for="ap-clone-url">{{ t('project.clone.url', 'Git URL') }}</label>
            <input
              id="ap-clone-url"
              v-model="cloneUrl"
              class="ap-input"
              :placeholder="t('project.clone.urlPlaceholder', 'https://github.com/user/repo.git')"
              :disabled="cloning"
              spellcheck="false"
              autocomplete="off"
              data-test="clone-url"
              autofocus
              @input="cloneError = ''"
              @keydown="onCloneKey"
            />
          </div>
          <div class="ap-field">
            <label class="ap-label" for="ap-clone-dest">{{ t('project.clone.parent', 'Parent folder') }}</label>
            <div class="ap-row">
              <input
                id="ap-clone-dest"
                v-model="cloneDest"
                class="ap-input"
                :placeholder="t('project.clone.parentPlaceholder', 'C:\\path\\to\\destination')"
                :disabled="cloning"
                spellcheck="false"
                data-test="clone-dest"
                @input="cloneError = ''"
                @keydown="onCloneKey"
              />
              <button
                type="button"
                class="ap-icon-btn"
                :disabled="cloning"
                :title="t('project.clone.chooseFolder', 'Choose folder')"
                :aria-label="t('project.clone.chooseFolder', 'Choose folder')"
                data-test="clone-pick"
                @click="pickCloneDest"
              >
                <Folder :size="14" aria-hidden="true" />
              </button>
            </div>
          </div>
          <p v-if="cloneError" class="ap-error" role="alert" data-test="clone-error">{{ cloneError }}</p>
          <button type="button" class="ap-btn primary wide" :disabled="!canClone" data-test="clone-go" @click="doClone">
            {{ cloning ? t('project.clone.cloning', 'Cloning...') : t('project.clone.go', 'Clone') }}
          </button>
          <div v-if="cloning && cloneProgress" class="ap-progress" data-test="clone-progress">
            <div class="ap-progress-row">
              <span>{{ cloneProgress.phase }}</span>
              <span>{{ cloneProgress.percent }}%</span>
            </div>
            <div class="ap-progress-track"><div class="ap-progress-bar" :style="{ width: cloneProgress.percent + '%' }"></div></div>
          </div>
        </div>
      </template>

      <!-- Create new project -->
      <template v-else-if="step === 'create'">
        <header class="ap-head">
          <h2 id="ap-heading" class="ap-title">{{ t('project.create.title', 'Create a new project') }}</h2>
          <p class="ap-desc">{{ t('project.create.description', 'Name it and Tessel will create a real project with sensible defaults.') }}</p>
        </header>
        <div class="ap-form">
          <div class="ap-field">
            <label class="ap-label" for="ap-create-name">{{ t('project.create.name', 'Name') }}</label>
            <input
              id="ap-create-name"
              v-model="createName"
              class="ap-input big mono"
              :placeholder="t('project.create.namePlaceholder', 'my-project')"
              :disabled="creating"
              autocomplete="off"
              spellcheck="false"
              data-test="create-name"
              autofocus
              @input="createError = ''"
              @keydown.enter.prevent="doCreate"
            />
          </div>
          <div class="ap-summary">
            <button type="button" class="ap-summary-head" :aria-expanded="advancedOpen" data-test="create-summary" @click="advancedOpen = !advancedOpen">
              <span class="ap-summary-icon"><GitBranch :size="14" aria-hidden="true" /></span>
              <span class="ap-summary-body">
                <span class="ap-summary-title">{{ summaryText() }}</span>
                <span v-if="gitAvailability === 'checking'" class="ap-summary-sub">
                  <LoaderCircle :size="12" class="ap-spin" aria-hidden="true" />
                  {{ t('project.create.checkingGit', 'Checking Git on this host...') }}
                </span>
                <span v-else-if="gitAvailability === 'unavailable'" class="ap-summary-sub danger" data-test="create-no-git">{{
                  t('project.create.gitRequired', 'Git is required to create a project.')
                }}</span>
                <span v-else-if="targetPreview" class="ap-summary-sub mono" :title="targetPreview">{{ targetPreview }}</span>
              </span>
              <ChevronDown :size="16" class="ap-summary-chevron" :class="{ open: advancedOpen }" aria-hidden="true" />
            </button>
            <div v-if="advancedOpen" class="ap-summary-more">
              <div class="ap-field">
                <label class="ap-label" for="ap-create-parent">{{ t('project.create.location', 'Location') }}</label>
                <div class="ap-row">
                  <input
                    id="ap-create-parent"
                    v-model="createParent"
                    class="ap-input"
                    :disabled="creating"
                    spellcheck="false"
                    data-test="create-parent"
                    @input="createError = ''"
                  />
                  <button type="button" class="ap-btn outline small" :disabled="creating" :title="t('project.create.changeParent', 'Change parent folder')" @click="pickCreateParent">
                    {{ t('project.create.change', 'Change') }}
                  </button>
                </div>
              </div>
              <p v-if="targetPreview" class="ap-preview mono">{{ targetPreview }}</p>
            </div>
          </div>
          <p v-if="createError" class="ap-error" role="alert" data-test="create-error">{{ createError }}</p>
          <button type="button" class="ap-btn primary wide big" :disabled="!canCreate" data-test="create-go" @click="doCreate">
            {{ creating ? t('project.create.creating', 'Creating…') : t('project.create.go', 'Create project') }}
          </button>
        </div>
      </template>

      <!-- A folder on an SSH host -->
      <template v-else-if="step === 'remote'">
        <header class="ap-head">
          <h2 id="ap-heading" class="ap-title">{{ t('project.remote.title', 'Open project on SSH host') }}</h2>
          <p class="ap-desc">{{ remoteDescription() }}</p>
        </header>
        <div class="ap-form">
          <div class="ap-field">
            <label class="ap-label" for="ap-remote-path">{{ t('project.remote.hostPath', 'Host path') }}</label>
            <input
              id="ap-remote-path"
              v-model="remotePath"
              class="ap-input"
              :placeholder="t('project.remote.pathPlaceholder', '/home/user/project')"
              spellcheck="false"
              autocomplete="off"
              data-test="remote-path"
              autofocus
              @input="remoteError = ''"
              @keydown.enter.prevent="doAddRemote"
            />
          </div>
          <p class="ap-hint">
            {{
              t(
                'project.remote.hint',
                'Its terminals open on this host with ssh, in this folder. Files, Changes and the editor read it over SSH.'
              )
            }}
          </p>
          <p v-if="remoteError" class="ap-error" role="alert" data-test="remote-error">{{ remoteError }}</p>
          <button type="button" class="ap-btn primary wide" :disabled="!remotePath.trim()" data-test="remote-go" @click="doAddRemote">
            {{ t('project.remote.go', 'Add project on SSH host') }}
          </button>
        </div>
      </template>

      <!-- Repositories found in the folder -->
      <AddProjectNestedStep
        v-else-if="step === 'nested' && scan"
        v-model:selected="selectedRepos"
        v-model:group-name="groupName"
        :scan="scan"
        :scanning="scanning"
        :busy="busy && !scanning"
        @import="importNested"
        @open-folder="openNestedFolder"
        @stop="stopScan"
      />
    </div>
  </div>
</template>

<style>
/* Shared by the Add a project steps (unscoped: the nested step uses them). */
.ap-backdrop {
  position: fixed;
  inset: 0;
  z-index: 460;
  display: grid;
  place-items: center;
  padding: 16px;
  background: rgba(5, 6, 8, 0.6);
}
.ap-dialog {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 16px;
  width: min(512px, 100%);
  max-height: calc(100vh - 2rem);
  min-width: 0;
  overflow-x: hidden;
  overflow-y: auto;
  box-sizing: border-box;
  padding: 24px;
  border: 1px solid var(--border-strong);
  border-radius: 10px;
  background: var(--surface);
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.6);
  color: var(--text);
  font-size: 13px;
}
.ap-dialog > * {
  min-width: 0;
}
.ap-close {
  position: absolute;
  top: 16px;
  right: 16px;
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--text-dim);
  opacity: 0.7;
  cursor: pointer;
}
.ap-close:hover,
.ap-close:focus-visible {
  opacity: 1;
  color: var(--text-strong);
  outline: none;
}
.ap-back-row {
  display: flex;
  align-items: center;
  min-height: 20px;
  margin-top: -4px;
}
.ap-back {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--text-dim);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.ap-back:hover {
  color: var(--text-strong);
}
.ap-back:disabled {
  opacity: 0.4;
  cursor: default;
}
.ap-head {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-right: 24px;
}
.ap-title {
  margin: 0;
  color: var(--text-strong);
  font-size: 17px;
  font-weight: 600;
  line-height: 1.2;
}
.ap-desc {
  margin: 0;
  color: var(--text-dim);
  font-size: 13px;
}
.ap-start {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-top: 8px;
}
.ap-primary,
.ap-secondary {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 10px 12px;
  color: var(--text-strong);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.ap-primary {
  min-height: 3.75rem;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  background: var(--surface);
}
.ap-secondary {
  min-height: 3.25rem;
  border: 1px solid transparent;
  border-top-color: color-mix(in srgb, var(--border-strong) 70%, transparent);
  background: transparent;
  transition: background 0.12s;
}
.ap-secondary.first {
  border-top-color: transparent;
}
.ap-primary.selected,
.ap-secondary.selected {
  border-color: color-mix(in srgb, var(--text-strong) 44%, transparent);
  background: var(--surface-3);
  outline: none;
}
.ap-primary:focus-visible,
.ap-secondary:focus-visible {
  outline: none;
}
.ap-secondary:hover:not(:disabled) {
  background: var(--surface-3);
}
.ap-primary:disabled,
.ap-secondary:disabled {
  cursor: default;
  opacity: 0.4;
}
.ap-action-icon {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  flex-shrink: 0;
  border-radius: 6px;
  color: var(--text-strong);
}
.ap-action-icon.dim {
  color: var(--text-dim);
}
.selected .ap-action-icon {
  background: color-mix(in srgb, var(--surface) 70%, transparent);
  color: var(--text-strong);
}
.ap-action-body {
  display: block;
  flex: 1;
  min-width: 0;
}
.ap-action-title {
  display: block;
  font-size: 13px;
  font-weight: 500;
  line-height: 20px;
}
.ap-action-desc {
  display: block;
  margin-top: 2px;
  color: var(--text-dim);
  font-size: 12px;
  line-height: 20px;
}
.ap-action-desc.small {
  margin-top: 0;
  line-height: 16px;
}
.ap-enter {
  flex-shrink: 0;
  padding: 1px 5px;
  border: 1px solid color-mix(in srgb, var(--border-strong) 80%, transparent);
  border-radius: 4px;
  background: color-mix(in srgb, var(--surface) 70%, transparent);
  color: var(--text-dim);
  font-size: 11px;
}
.ap-others {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ap-others-label {
  margin: 0;
  color: var(--text-dim);
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.ap-others-box {
  overflow: hidden;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  background: var(--surface);
}
.ap-busy {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  background: var(--surface-2);
  color: var(--text-dim);
  font-size: 12px;
}
.ap-busy-label {
  flex: 1;
  min-width: 0;
}
.ap-busy-stop {
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
}
.ap-busy-stop:hover {
  background: color-mix(in srgb, var(--danger) 10%, transparent);
  color: var(--danger);
}
.ap-spin {
  flex-shrink: 0;
  animation: ap-spin 0.9s linear infinite;
}
@keyframes ap-spin {
  to {
    transform: rotate(360deg);
  }
}
.ap-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
  padding-top: 4px;
}
.ap-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.ap-label {
  color: var(--text-dim);
  font-size: 11px;
  font-weight: 500;
}
.ap-row {
  display: flex;
  gap: 8px;
  min-width: 0;
}
.ap-row > .ap-input {
  flex: 1;
}
.ap-input {
  flex: none;
  width: 100%;
  min-width: 0;
  height: 32px;
  box-sizing: border-box;
  padding: 0 10px;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  background: var(--surface-2);
  color: var(--text-strong);
  font: inherit;
  font-size: 12px;
  outline: none;
}
.ap-input.big {
  height: 44px;
  font-size: 14px;
}
.ap-input:focus {
  border-color: var(--accent);
}
.ap-input:disabled {
  opacity: 0.6;
}
.mono {
  font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
}
.ap-icon-btn {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  padding: 0;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  background: transparent;
  color: var(--text-strong);
  cursor: pointer;
}
.ap-icon-btn:hover:not(:disabled) {
  background: var(--surface-3);
}
.ap-icon-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.ap-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 32px;
  padding: 0 14px;
  border: 1px solid transparent;
  border-radius: 6px;
  font: inherit;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
}
.ap-btn.primary {
  background: var(--text-strong);
  color: var(--surface);
}
.ap-btn.primary:hover:not(:disabled) {
  opacity: 0.9;
}
.ap-btn.outline {
  border-color: var(--border-strong);
  background: transparent;
  color: var(--text-strong);
}
.ap-btn.outline:hover:not(:disabled) {
  background: var(--surface-3);
}
.ap-btn.secondary {
  background: var(--surface-3);
  color: var(--text-strong);
}
.ap-btn.small {
  height: 32px;
  padding: 0 10px;
  font-size: 12px;
}
.ap-btn.wide {
  width: 100%;
}
.ap-btn.big {
  height: 40px;
}
.ap-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.ap-error {
  margin: 0;
  color: var(--danger);
  font-size: 11px;
  overflow-wrap: anywhere;
}
.ap-hint {
  margin: 0;
  color: var(--text-dim);
  font-size: 11px;
  line-height: 1.5;
}
.ap-progress {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ap-progress-row {
  display: flex;
  justify-content: space-between;
  color: var(--text-dim);
  font-size: 11px;
}
.ap-progress-track {
  width: 100%;
  height: 6px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--surface-3);
}
.ap-progress-bar {
  height: 100%;
  border-radius: 999px;
  background: var(--text-strong);
  transition: width 0.3s ease-out;
}
.ap-summary {
  min-width: 0;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  background: color-mix(in srgb, var(--surface-3) 30%, transparent);
}
.ap-summary-head {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  width: 100%;
  min-width: 0;
  padding: 10px 12px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text-strong);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.ap-summary-head:hover {
  background: color-mix(in srgb, var(--surface-3) 50%, transparent);
}
.ap-summary-icon {
  display: inline-grid;
  place-items: center;
  width: 24px;
  height: 24px;
  flex-shrink: 0;
  margin-top: 2px;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  color: var(--text-dim);
}
.ap-summary-body {
  display: block;
  flex: 1;
  min-width: 0;
}
.ap-summary-title {
  display: block;
  overflow: hidden;
  font-size: 13px;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ap-summary-sub {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 2px;
  overflow: hidden;
  color: var(--text-dim);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ap-summary-sub.danger {
  color: var(--danger);
}
.ap-summary-chevron {
  flex-shrink: 0;
  align-self: center;
  color: var(--text-dim);
  transition: transform 0.15s;
}
.ap-summary-chevron.open {
  transform: rotate(180deg);
}
.ap-summary-more {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px;
  border-top: 1px solid var(--border-strong);
}
.ap-preview {
  margin: 0;
  padding: 8px 10px;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  background: color-mix(in srgb, var(--surface) 40%, transparent);
  color: var(--text-dim);
  font-size: 11px;
  word-break: break-all;
}
</style>
