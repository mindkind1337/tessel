<script setup>
// "Add a project", like Orca's (MIT, Copyright (c) 2026 Lovecast Inc.:
// components/sidebar/AddRepoDialog.tsx, AddRepoStartSteps.tsx,
// AddRepoCloneStep.tsx, AddRepoCreateStep.tsx, AddRepoRemoteStep.tsx,
// AddRepoStepIndicator.tsx and their hooks).
// - Host: this computer or a saved SSH host. An SSH host is signed in to
//   from its row in the host list (Connect / Retry; the askpass dialog asks
//   for a password when needed) and selected once connected.
//   "Add remote host" opens the SSH host form over this dialog (like VS
//   Code's Connect to Host from a new window): once saved, the new host is
//   signed in to and selected here, and the new project goes on with it.
//   Nothing opens in the current project; Cancel comes back unchanged.
// - Browse folder: a folder, a repository, or a folder holding several
//   repositories (they are found and offered: AddProjectNestedStep).
//   On an SSH host: its folders are browsed (RemoteFolderBrowser) and the
//   folder chosen becomes the project.
// - Clone from URL, Create new project: on this computer or on the SSH host
//   (the parent folder typed or browsed on that host).
// It emits `add` with the projects to make ({ name, cwd } / { name, remote:
// { hostId, path } } / { name, cwd, group }); App makes them.
import { ref, reactive, computed, onMounted, onBeforeUnmount, nextTick, watch } from 'vue'
import { ArrowLeft, ChevronDown, Folder, GitBranch, LoaderCircle, CircleStop, X } from 'lucide-vue-next'
import { t } from '../../i18n'
import { remoteHostsState, refreshRemoteHosts, emptyForm, buildSavePayload, remoteErrorText } from '../../remoteHosts'
import {
  LOCAL_HOST_ID,
  buildHostOptions,
  canConnectHost,
  startActions,
  baseName,
  joinPath,
  joinRemote,
  newScanId,
  planImport,
  remotePathError,
  remoteProjectName
} from '../../addProject'
import { sshCredentialState } from '../../sshCredentials'
import AddProjectHostSelector from './AddProjectHostSelector.vue'
import AddProjectNestedStep from './AddProjectNestedStep.vue'
import RemoteFolderBrowser from './RemoteFolderBrowser.vue'
import RemoteHostForm from '../remote/RemoteHostForm.vue'

const props = defineProps({
  projectCount: { type: Number, default: 1 },
  initialHostId: { type: String, default: LOCAL_HOST_ID }
})
const emit = defineEmits(['close', 'add'])

const step = ref('add') // 'add' | 'clone' | 'create' | 'remote' | 'nested'
const hostId = ref(props.initialHostId || LOCAL_HOST_ID)
// What this dialog is doing with the SSH hosts (sign-in in progress, the
// last error, signed in here): shown over what the main process says.
const conn = reactive({ connecting: {}, errors: {}, connected: {} })
const hosts = computed(() => buildHostOptions(remoteHostsState.targets, remoteHostsState.states, conn))
const host = computed(() => hosts.value.find((h) => h.id === hostId.value) || hosts.value[0])
const isSsh = computed(() => !!host.value && host.value.kind === 'ssh')
const actions = computed(() => startActions(host.value ? host.value.kind : 'local'))
// A saved host removed meanwhile: back to this computer.
watch(hosts, (list) => {
  if (!list.some((h) => h.id === hostId.value)) hostId.value = LOCAL_HOST_ID
})
// Signed in here, then its session ended (idle, Disconnect): not connected anymore.
watch(
  () => remoteHostsState.states,
  (states) => {
    for (const id of Object.keys(conn.connected)) {
      const s = states && states[id]
      if (s && s.status !== 'connected' && s.status !== 'connecting') delete conn.connected[id]
    }
  }
)

const busy = ref(false)
const busyLabel = ref('')
const startError = ref('')
let gen = 0

const api = () => (window.shellApi && window.shellApi.addProject) || null
const remoteApi = () => (window.shellApi && window.shellApi.remoteFs) || null

// --- Signing in to an SSH host ------------------------------------------------
// Through the host's Files session (src/main/remoteFs.js): the askpass
// dialog asks for a password or passphrase when needed. -> true once connected.
const hostSelector = ref(null)
async function connectHost(id) {
  const a = remoteApi()
  if (!a || !a.connect || conn.connecting[id]) return false
  conn.connecting[id] = true
  delete conn.errors[id]
  let res
  try {
    res = await a.connect(id)
  } catch (err) {
    res = { ok: false, error: err && err.message }
  }
  delete conn.connecting[id]
  if (res && res.ok) {
    conn.connected[id] = true
    return true
  }
  delete conn.connected[id]
  if (!(res && res.cancelled)) conn.errors[id] = (res && res.error) || t('project.host.connectFailed', 'SSH connection failed.')
  return false
}
// From the host list: once connected, the host is selected and the list
// closes (the dialog goes on with it).
async function connectFromList(id) {
  startError.value = ''
  const ok = await connectHost(id)
  if (!ok || step.value !== 'add') return
  hostId.value = id
  if (hostSelector.value) hostSelector.value.close()
  focusBrowse()
}

// The sign-in prompt (SshPasswordDialog: password, passphrase, host key)
// goes over this dialog: the host list closes so nothing covers it; the
// dialog stays, and selects the host once signed in (connectFromList).
watch(
  () => sshCredentialState.queue.length > 0,
  (asking) => {
    if (asking && hostSelector.value) hostSelector.value.close()
  }
)

// --- Add remote host: the SSH host form over this dialog ---------------------
const hostForm = reactive({ open: false, initial: emptyForm(), error: '', saving: false })
function openHostForm() {
  if (busy.value) return
  hostForm.initial = emptyForm()
  hostForm.error = ''
  hostForm.saving = false
  hostForm.open = true
}
// Cancel: back to the dialog as it was.
function closeHostForm() {
  if (hostForm.saving) return
  hostForm.open = false
  nextTick(() => {
    const trig = document.querySelector('[data-test="host-trigger"]')
    if (trig) trig.focus()
  })
}
// Saved: the new host is selected here and signed in to (its Files
// session, the askpass dialog when needed), never a pane in the current
// project.
async function saveHostForm(form) {
  const payload = buildSavePayload(form)
  if (!payload.ok) {
    hostForm.error = payload.error
    return
  }
  const a = window.shellApi && window.shellApi.remoteHosts
  if (hostForm.saving || !a || typeof a.add !== 'function') return
  hostForm.saving = true
  hostForm.error = ''
  let res
  try {
    res = await a.add(payload.target)
  } catch {
    res = null
  }
  hostForm.saving = false
  if (!res || !res.ok || !res.target || typeof res.target.id !== 'string') {
    hostForm.error = remoteErrorText(res && res.error, t('remote.pane.saveFailed', 'Failed to save target'))
    return
  }
  const id = res.target.id
  hostForm.open = false
  await refreshRemoteHosts()
  // Shown at once, even before the list is read again.
  if (!remoteHostsState.targets.some((x) => x && x.id === id)) remoteHostsState.targets = [...remoteHostsState.targets, res.target]
  if (step.value !== 'add') return
  hostId.value = id
  startError.value = ''
  const ok = await connectHost(id)
  if (!ok && conn.errors[id]) startError.value = conn.errors[id]
  focusBrowse()
}

// The selected SSH host, signed in (connecting first when needed).
async function ensureConnected() {
  const h = host.value
  if (!h || h.kind !== 'ssh') return true
  if (!canConnectHost(h)) return true
  const my = gen
  const ok = await connectHost(h.id)
  if (my !== gen || hostId.value !== h.id) return false
  if (!ok) startError.value = conn.errors[h.id] || ''
  return ok
}

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
  if (isSsh.value) return onSshAction(kind)
  if (kind === 'browse') return browseLocal()
  if (kind === 'clone') return openClone()
  if (kind === 'create') return openCreate()
}

// On an SSH host: signed in first (the dialog goes on by itself once
// connected), then the step.
async function onSshAction(kind) {
  const h = host.value
  if (canConnectHost(h)) {
    const my = gen
    busy.value = true
    busyLabel.value = t('project.busy.connecting', 'Connecting to {{host}}...', { host: h.label })
    const ok = await ensureConnected()
    if (my !== gen) return
    busy.value = false
    busyLabel.value = ''
    if (!ok) return
  }
  if (kind === 'browse') return openRemote()
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

// A clone or a new project on the SSH host: its parent folder is typed or
// picked on that host ('clone' / 'create' while the folder picker is open).
const browseFor = ref(null)
const cloneHostId = ref(null) // the host a running remote clone is on

async function openClone() {
  if (actions.value.secondary.find((x) => x.kind === 'clone').disabled) return
  cloneError.value = ''
  step.value = 'clone'
  if (isSsh.value) {
    if (!cloneDest.value) cloneDest.value = '~'
    return
  }
  await loadDefaults()
  if (step.value === 'clone' && !cloneDest.value) cloneDest.value = defaultParent.value
}
async function pickCloneDest() {
  if (isSsh.value) {
    browseFor.value = 'clone'
    return
  }
  const my = gen
  const dir = await window.shellApi.pickFolder({ title: t('project.clone.pickTitle', 'Choose where to clone it'), defaultPath: cloneDest.value || undefined })
  if (dir && my === gen) {
    cloneDest.value = dir
    cloneError.value = ''
  }
}
async function doClone() {
  if (isSsh.value) return doRemoteClone()
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
// On the host, by its session: git clone into <parent>/<name from the URL>.
async function doRemoteClone() {
  const a = remoteApi()
  const h = host.value
  if (!a || !a.clone || !canClone.value || !h) return
  const parentErr = remotePathError(cloneDest.value)
  if (parentErr) {
    cloneError.value = parentErr
    return
  }
  const my = ++gen
  cloning.value = true
  cloneHostId.value = h.id
  cloneError.value = ''
  let res
  try {
    res = await a.clone(h.id, cloneUrl.value.trim(), cloneDest.value.trim())
  } catch (err) {
    res = { ok: false, error: err && err.message }
  }
  if (my !== gen) return
  cloning.value = false
  cloneHostId.value = null
  if (res && res.ok) emitAdd([{ name: res.name || remoteProjectName(res.path, h.label), remote: { hostId: h.id, path: res.path } }], 'clone')
  else cloneError.value = (res && res.error) || t('project.error.generic', 'Something went wrong.')
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
// On an SSH host, the host checks git itself (and says so).
const canCreate = computed(
  () =>
    !!createName.value.trim() &&
    !!createParent.value.trim() &&
    (isSsh.value || (gitAvailability.value !== 'checking' && gitAvailability.value !== 'unavailable')) &&
    !creating.value
)
const targetPreview = computed(() => {
  const parent = createParent.value.trim()
  if (!parent) return ''
  const name = createName.value.trim() || 'project-name'
  return isSsh.value ? joinRemote(parent, name) : joinPath(parent, name)
})

async function openCreate() {
  if (actions.value.secondary.find((x) => x.kind === 'create').disabled) return
  createError.value = ''
  step.value = 'create'
  if (isSsh.value) {
    if (!createParent.value) createParent.value = '~'
    return
  }
  await loadDefaults()
  if (step.value === 'create' && !createParent.value) createParent.value = defaultParent.value
}
async function pickCreateParent() {
  if (isSsh.value) {
    browseFor.value = 'create'
    return
  }
  const my = gen
  const dir = await window.shellApi.pickFolder({ title: t('project.create.pickTitle', 'Choose parent folder...'), defaultPath: createParent.value || undefined })
  if (dir && my === gen) {
    createParent.value = dir
    createError.value = ''
  }
}
async function doCreate() {
  if (isSsh.value) return doRemoteCreate()
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
function cloneDescription() {
  return isSsh.value
    ? t('project.clone.descriptionOnHost', 'Enter the Git URL and choose where to clone it on {{host}}.', { host: host.value.label })
    : t('project.clone.description', 'Enter the Git URL and choose where to clone it.')
}
function createDescription() {
  return isSsh.value
    ? t('project.create.descriptionOnHost', 'Name it and Tessel will create a Git project on {{host}}.', { host: host.value.label })
    : t('project.create.description', 'Name it and Tessel will create a real project with sensible defaults.')
}
// On the host: mkdir <parent>/<name>, git init, an empty first commit.
async function doRemoteCreate() {
  const a = remoteApi()
  const h = host.value
  if (!a || !a.create || !canCreate.value || !h) return
  const parentErr = remotePathError(createParent.value)
  if (parentErr) {
    createError.value = parentErr
    return
  }
  const my = ++gen
  creating.value = true
  createError.value = ''
  let res
  try {
    res = await a.create(h.id, createParent.value.trim(), createName.value.trim())
  } catch (err) {
    res = { ok: false, error: err && err.message }
  }
  if (my !== gen) return
  creating.value = false
  if (res && res.ok) emitAdd([{ name: res.name || remoteProjectName(res.path, h.label), remote: { hostId: h.id, path: res.path } }], 'create')
  else createError.value = (res && res.error) || t('project.error.generic', 'Something went wrong.')
}
function summaryText() {
  const parent = createParent.value.trim() || t('project.create.noLocation', 'location not selected')
  return t('project.create.summary', '{{kind}} in {{parent}}', { kind: t('project.create.kindGit', 'Git repository'), parent })
}

// --- A folder on an SSH host --------------------------------------------------
// Its folders are browsed; the folder chosen becomes the project.
const remoteError = ref('')
function openRemote() {
  remoteError.value = ''
  step.value = 'remote'
}
function addRemoteFolder(path) {
  const err = remotePathError(path)
  if (err) {
    remoteError.value = err
    return
  }
  const h = host.value
  const p = String(path).trim()
  emitAdd([{ name: remoteProjectName(p, h.label), remote: { hostId: h.id, path: p } }], 'remote')
}
// The folder picker for a clone's or a new project's parent folder.
function onParentPicked(path) {
  if (browseFor.value === 'clone') {
    cloneDest.value = path
    cloneError.value = ''
  } else if (browseFor.value === 'create') {
    createParent.value = path
    createError.value = ''
  }
  browseFor.value = null
}
// --- Back, close ---------------------------------------------------------------
// Orca's resetState: a running clone is killed, a scan stopped.
function reset() {
  gen++
  // A clone running on a host ends with its session (the next operation
  // on that host signs in again).
  if (cloning.value && cloneHostId.value && remoteApi() && remoteApi().cancel) remoteApi().cancel(cloneHostId.value)
  else if (cloning.value && api()) api().cloneAbort()
  cloneHostId.value = null
  browseFor.value = null
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
  remoteError.value = ''
}
const showBack = computed(() => step.value !== 'add')
function back() {
  if (step.value === 'nested' && busy.value) return
  // The parent folder picker: back to its form.
  if (browseFor.value) {
    browseFor.value = null
    return
  }
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
defineExpose({ step, hostId, browseFor })
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
          <AddProjectHostSelector
            ref="hostSelector"
            :hosts="hosts"
            :selected-id="hostId"
            :disabled="busy"
            @select="(id) => (hostId = id)"
            @connect="connectFromList"
            @add-host="openHostForm"
          />
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

      <!-- The parent folder of a clone / a new project, on the SSH host -->
      <template v-else-if="browseFor">
        <header class="ap-head">
          <h2 id="ap-heading" class="ap-title">{{ t('project.remoteBrowser.title', 'Browse remote file system') }}</h2>
          <p class="ap-desc">{{ t('project.remoteBrowser.description', 'Navigate to a folder and click Select to choose it.') }}</p>
        </header>
        <RemoteFolderBrowser
          :host-id="hostId"
          :purpose="browseFor"
          :initial-path="(browseFor === 'clone' ? cloneDest : createParent).trim() || '~'"
          @select="onParentPicked"
          @cancel="browseFor = null"
        />
      </template>

      <!-- Clone from URL -->
      <template v-else-if="step === 'clone'">
        <header class="ap-head">
          <h2 id="ap-heading" class="ap-title">{{ t('project.clone.title', 'Clone from URL') }}</h2>
          <p class="ap-desc">{{ cloneDescription() }}</p>
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
                :placeholder="isSsh ? t('project.remote.pathPlaceholder', '/home/user/project') : t('project.clone.parentPlaceholder', 'C:\\path\\to\\destination')"
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
          <p class="ap-desc">{{ createDescription() }}</p>
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
                <span v-if="!isSsh && gitAvailability === 'checking'" class="ap-summary-sub">
                  <LoaderCircle :size="12" class="ap-spin" aria-hidden="true" />
                  {{ t('project.create.checkingGit', 'Checking Git on this host...') }}
                </span>
                <span v-else-if="!isSsh && gitAvailability === 'unavailable'" class="ap-summary-sub danger" data-test="create-no-git">{{
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
                  <button
                    type="button"
                    class="ap-btn outline small"
                    :disabled="creating"
                    :title="t('project.create.changeParent', 'Change parent folder')"
                    data-test="create-pick"
                    @click="pickCreateParent"
                  >
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
          <h2 id="ap-heading" class="ap-title">{{ t('project.remoteBrowser.title', 'Browse remote file system') }}</h2>
          <p class="ap-desc">{{ t('project.remoteBrowser.description', 'Navigate to a folder and click Select to choose it.') }}</p>
        </header>
        <RemoteFolderBrowser :host-id="hostId" purpose="project" @select="addRemoteFolder" @cancel="back" />
        <p v-if="remoteError" class="ap-error" role="alert" data-test="remote-error">{{ remoteError }}</p>
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
    <!-- Add remote host: over this dialog, outside it (its Esc is its own). -->
    <Teleport to="body">
      <RemoteHostForm
        v-if="hostForm.open"
        :initial="hostForm.initial"
        :saving="hostForm.saving"
        :error="hostForm.error"
        @save="saveHostForm"
        @close="closeHostForm"
      />
    </Teleport>
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
