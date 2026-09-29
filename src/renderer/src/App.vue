<script setup>
import { ref, reactive, provide, watch, computed, nextTick, onMounted, onBeforeUnmount } from 'vue'
import SplitNode from './components/SplitNode.vue'
import BrandIcon from './components/BrandIcon.vue'
import SidePanel from './components/SidePanel.vue'
import WorkspaceSidebar from './components/WorkspaceSidebar.vue'
import StatusBar from './components/StatusBar.vue'
import { buildProjectCards, cardTargetPane, portProbes } from './sidebarModel'
import { createPortScanner, browserUrlForPort, addressForPort } from './portScanner'
import { allowedBrowserUrl, BLANK_URL } from '../../shared/browserUrl'
import LaunchMenu from './components/LaunchMenu.vue'
import SettingsDialog from './components/SettingsDialog.vue'
import UpdateDialog from './components/UpdateDialog.vue'
import UpdateCard from './components/UpdateCard.vue'
import SshPasswordDialog from './components/remote/SshPasswordDialog.vue'
import { settings, loadSettings, DEFAULT_SETTINGS } from './settings'
import { effectiveAgent, agentEnabled, launchSignature, launchIsYolo, launchSessionValues } from '../../shared/agentPrefs'
import { validPaneSessionOptions } from '../../shared/agentSessionOptions'
import { loadModelLists, modelsFor } from './agentModels'
import { THEMES } from './themes'
import McpDialog from './components/McpDialog.vue'
import CommandPalette from './components/CommandPalette.vue'
import ToolsDialog from './components/ToolsDialog.vue'
import SessionsDialog from './components/SessionsDialog.vue'
import { getPane } from './paneRegistry'
import { installChain } from './shellChain'
import {
  agentStatus,
  attention,
  limits,
  approvals,
  applyAgentStates,
  getAgentState,
  agentStateKnown,
  managedAgentStatus,
  clearAgentStatus,
  clearAttention,
  setAttention
} from './agentStatus'
import { detectApproval } from './agentLimit'
import { activity, recordActivity, loadActivity, saveActivityNow, activityChanged } from './activityStore'
import ActivityPanel from './components/ActivityPanel.vue'
import ConfirmDialog from './components/ConfirmDialog.vue'
import ImageViewer from './components/ImageViewer.vue'
import FileViewer from './components/FileViewer.vue'
import { fileKind, isViewed } from '../../shared/fileKinds'
import { remoteRoot, isRemotePath, parseRemotePath } from '../../shared/remotePath'
import NotificationsMenu from './components/NotificationsMenu.vue'
import FileFinder from './components/FileFinder.vue'
import UsageMenu from './components/UsageMenu.vue'
import GitHubDialog from './components/GitHubDialog.vue'
import LinearDialog from './components/LinearDialog.vue'
import { createExternalIssueStarter } from './externalIssues'
import './issueDialogs.css'
import { addNotification, readForPane, playAlertSound } from './notificationsStore'
import { initRemoteHosts, setRemoteHostHandlers, remoteHostsState, manageRemoteHosts } from './remoteHosts'
import AddProjectDialog from './components/project/AddProjectDialog.vue'
import { savedRemote, savedGroup } from './addProject'
import NotesPanel from './components/NotesPanel.vue'
import NewTaskDialog from './components/NewTaskDialog.vue'
import ReviewPanel from './components/ReviewPanel.vue'
import { parseLeadRequest, findTaskRef, leadGuide, memberGuide } from '../../shared/leadRequests'
import { workerLaunchArgs, wakeLaunchArgs } from '../../shared/orchestration'
import { createOrchestrator } from './orchestrator'
import { automationLaunchArgs, AUTOMATION_AGENTS, permissionFingerprint, quoteGlobArgs } from '../../shared/automations'
import { createAutomationRunner, probeRunAgent } from './automationRunner'
import { createCliRequests, CliRequestError } from './cliRequests'
import { automationsState, applySnapshot as applyAutomations, subscribeAutomations } from './automationsStore'
import { trackAgent } from '../../shared/tracking'
import { pasteAndConfirm } from './deliver'
import { dropBuffer, seedBuffer } from './ptyStore'
import { tasks as boardTasks, setTasks, updateTask, removeTask, addTask } from './taskBoardStore'
import { paneModels } from './paneModels'
import { sleepBlocker } from '../../shared/agentSleep'
import { updateBlocker, planUpdate, autoUpdateMoment, describeWaiting } from '../../shared/agentUpdatePlan'
import { stopThenRetry, stuckMessage } from './agentUpdateRetry'
import { updateFailureText, updateKindLabel } from './agentUpdateErrors'
import {
  docs as editorDocs,
  getDoc,
  dirtyOnlyIn,
  saveDocs,
  releaseOwner,
  getEditorPane,
  setEditorHooks,
  startDiskWatch,
  autoSaveSettingsChanged
} from './editor/documents'
import { openTab, validSavedFiles, samePath, fileName, docPathOf, diffTabPath } from './editor/editorTabs'
import { setNotesDelivery } from './notesDelivery'
import { t, intlLocale } from './i18n'

const shells = ref([])
const agents = ref([])
// The agents offered in menus: not those turned off in Settings > Agents.
const launchableAgents = computed(() => agents.value.filter((a) => agentEnabled(settings.agentPrefs, a.id)))
const selectedShell = ref(null)
const broadcast = ref(false)

// --- Workspaces --------------------------------------------------------------
// Each workspace is an independent split tree with its own active pane. All
// workspaces stay mounted (hidden ones are invisible but keep their size), so
// switching never kills or resizes a running shell or agent.
const workspaces = ref([]) // [{ id, name, tree, activeId }]
// Panes whose sub-agents run now (TerminalPane reports its AgentChildren):
// they are at work even while the main agent waits for them.
const childrenRunning = reactive({})
function setChildrenRunning(id, n) {
  if (n > 0) childrenRunning[id] = n
  else delete childrenRunning[id]
}
// A workspace by its id, or null.
const wsById = (id) => workspaces.value.find((w) => w.id === id) || null
const currentWsId = ref(null)
const sidebarCollapsed = ref(false)
const sidebarWidth = ref(280) // Orca's default sidebar width

// Terminal font size lives in settings; zoomed with Ctrl+= / Ctrl+- / Ctrl+0.
const DEFAULT_FONT_SIZE = DEFAULT_SETTINGS.fontSize
const fontSize = computed({
  get: () => settings.fontSize,
  set: (v) => {
    settings.fontSize = v
  }
})
// Windows input languages that dictation can switch to (loaded at startup).
const voiceLanguages = ref([])
async function loadVoiceLanguages() {
  if (!window.shellApi.inputLanguages) return
  try {
    const list = (await window.shellApi.inputLanguages()) || []
    voiceLanguages.value = list.filter((l) => l && l.tip)
    // Not chosen yet: default to the language of your Windows region (fr-FR ->
    // a French input language), not whatever keyboard happens to be active.
    if (!settings.voiceTipChosen && !settings.voiceTip && window.shellApi.systemLocale) {
      const locale = String((await window.shellApi.systemLocale()) || '').toLowerCase()
      const prefix = locale.split('-')[0]
      const match =
        voiceLanguages.value.find((l) => l.tag.toLowerCase() === locale) ||
        voiceLanguages.value.find((l) => l.tag.toLowerCase().split('-')[0] === prefix)
      if (match) settings.voiceTip = match.tip
    }
  } catch {
    voiceLanguages.value = []
  }
}

// Short label for the mic button: "FR", "EN"... ("" = current keyboard language).
const voiceLabel = computed(() => {
  const l = voiceLanguages.value.find((x) => x.tip === settings.voiceTip)
  return l ? l.tag.slice(0, 2).toUpperCase() : ''
})
const voiceName = computed(() => {
  const l = voiceLanguages.value.find((x) => x.tip === settings.voiceTip)
  return l ? l.name : t('app.voice.currentKeyboard', 'current keyboard language')
})

// Hovering a pane in a menu outlines it, so you can see which one you pick.
const highlightId = ref(null)
const settingsOpen = ref(false)
const githubOpen = ref(false)
const linearOpen = ref(false)
const githubBusy = ref(false)
const linearBusy = ref(false)
watch(githubOpen, (open) => { if (!open) githubBusy.value = false })
watch(linearOpen, (open) => { if (!open) linearBusy.value = false })
const issueWorkspaceId = ref(null)
const issueWorkspace = computed(() => wsById(issueWorkspaceId.value))
const githubTaskContext = ref(null)
function openGitHub(task = null) {
  closeMenus()
  paletteOpen.value = false
  issueWorkspaceId.value = task?.wsId || currentWsId.value
  githubTaskContext.value = task?.worktree ? { cwd: task.worktree.path, base: task.worktree.baseBranch || '' } : null
  githubOpen.value = true
}
function openLinear() {
  closeMenus()
  paletteOpen.value = false
  issueWorkspaceId.value = currentWsId.value
  linearOpen.value = true
}
const startLinkedIssue = createExternalIssueStarter({
  getWorkspace: () => issueWorkspace.value,
  hasWorkspace: (ws) => workspaces.value.includes(ws),
  agentAvailable: (id) => launchableAgents.value.some((a) => a.id === id && a.available !== false),
  startTask: (spec, opts) => startTask(spec, opts),
  github: window.shellApi.github,
  linear: window.shellApi.linear
})
async function prepareLinkedIssue(request) {
  const result = await startLinkedIssue(request)
  if (result.ok && result.paneId) focusPane(result.paneId)
  if (result.warning) showToast(result.warning, { kind: 'error', timeout: 10000 })
  return result
}
const settingsSection = ref(null) // opens Settings scrolled to that section
function openSettingsAt(section) {
  settingsSection.value = section
  settingsOpen.value = true
}
const usageWorktreePaths = computed(() => {
  const paths = new Set(boardTasks.map(task => task.worktree?.path).filter(Boolean))
  for (const ws of workspaces.value)
    forEachLeaf(ws.tree, leaf => { if (leaf.worktree?.path) paths.add(leaf.worktree.path) })
  return [...paths]
})
// Markdown, diagrams, tables, JSON and images open as editor tabs with
// Orca's view toggle (Preview | Source | Changes, Table, the picture); PDFs
// in their own window (Chromium's viewer). The modal viewer (FileViewer.vue)
// stays only as a fallback when no workspace can hold an editor pane.
const fileView = ref(null) // { file, label, line }
async function viewFile({ file, label = '', line = null, preview = true }) {
  if (!file) return
  if (fileKind(file) === 'pdf') {
    const res = window.shellApi.openPdf ? await window.shellApi.openPdf(file).catch(() => null) : null
    if (!res || !res.ok) showToast(res && res.error ? t('app.file.openFailedWhy', 'Could not open {{file}}: {{error}}', { file: label || file, error: res.error }) : t('app.file.openFailed', 'Could not open {{file}}', { file: label || file }), { kind: 'error', timeout: 5000 })
    return
  }
  const ln = Number.isInteger(line) ? line : null
  if (openInTesselEditor({ file, line: ln, preview })) return
  fileView.value = { file, label, line: ln }
}
// Outside Tessel: VS Code at the line when installed, else the file's own program.
async function openExternally({ file, line, col }) {
  const res = await window.shellApi.openFile({ file, line: line || undefined, col: col || undefined }).catch(() => null)
  if (!res || !res.ok) showToast(res && res.error ? t('app.file.openFailedWhy', 'Could not open {{file}}: {{error}}', { file, error: res.error }) : t('app.file.openFailed', 'Could not open {{file}}', { file }), { kind: 'error', timeout: 5000 })
}

// --- Tessel's code editor (EditorPane.vue) --------------------------------------------
// A file opens in the workspace's editor pane (the active pane when it is
// one), as a preview tab when opened with one click (replaced by the next
// such file until edited); with no editor pane yet, the active pane is split
// to the right with a new one. line / col: shown centred, briefly highlighted.
let revealSeq = 0
function makeEditorLeaf(id = null) {
  return reactive({
    type: 'leaf',
    kind: 'editor',
    id: id || newId('pane'),
    title: t('app.pane.editor', 'Editor'),
    files: [],
    activePath: null,
    broadcast: false,
    reveal: null
  })
}
function openInTesselEditor({ file, line = null, col = null, preview = true, ws = currentWs.value } = {}) {
  if (!file || !ws) return null
  const active = ws.activeId ? findLeafIn(ws.tree, ws.activeId) : null
  let leaf = active && active.kind === 'editor' ? active : null
  if (!leaf) forEachLeaf(ws.tree, (l) => !leaf && l.kind === 'editor' && (leaf = l))
  if (!leaf) {
    leaf = makeEditorLeaf()
    const split = (orig) => reactive({ type: 'split', id: newId('split'), dir: 'row', sizes: [50, 50], children: [orig, leaf] })
    if (active) ws.tree = replaceNode(ws.tree, active.id, split)
    else ws.tree = ws.tree ? split(ws.tree) : leaf
  }
  const res = openTab(leaf.files, leaf.activePath, file, {
    preview,
    previewTabs: settings.editorPreviewTabs,
    isDirty: (p) => !!(getDoc(p) && getDoc(p).dirty)
  })
  // A line in a Markdown, Mermaid or CSV file: its source, at that line.
  if (Number.isInteger(line) && line > 0 && ['markdown', 'mermaid', 'table'].includes(fileKind(file)))
    res.files = res.files.map((f) => (samePath(f.path, res.activePath) && !f.diff ? { ...f, mode: 'edit' } : f))
  leaf.files = res.files
  leaf.activePath = res.activePath
  leaf.reveal = {
    path: res.activePath,
    line: Number.isInteger(line) && line > 0 ? line : null,
    col: Number.isInteger(col) && col > 0 ? col : null,
    seq: ++revealSeq
  }
  if (maximizedId.value && maximizedId.value !== leaf.id) maximizedId.value = null
  selectWorkspace(ws.id)
  ws.activeId = leaf.id
  refitSoon()
  return leaf
}
// --- Tessel's built-in browser (BrowserPane.vue) ---------------------------------------
// Panes without a terminal: an editor, a browser page.
function hasNoTerminal(leaf) {
  return !!leaf && (leaf.kind === 'editor' || leaf.kind === 'browser')
}
function makeBrowserLeaf(id = null, url = BLANK_URL) {
  return reactive({
    type: 'leaf',
    kind: 'browser',
    id: id || newId('pane'),
    title: t('app.pane.browser', 'Browser'),
    url: allowedBrowserUrl(url) || BLANK_URL,
    // Chromium's zoom level of the page (0: 100%).
    zoom: 0,
    // Bumped to put the keyboard in its address bar.
    focusAddress: 0,
    broadcast: false
  })
}
// A page opens in the workspace's browser pane (the active pane when it is
// one, else the first one); with none yet, or newPane, the active pane is
// split to the right with a new one.
function openInBrowser({ url = BLANK_URL, ws = currentWs.value, newPane = false, focusAddress = false } = {}) {
  if (!ws) return null
  const target = allowedBrowserUrl(url) || BLANK_URL
  const active = ws.activeId ? findLeafIn(ws.tree, ws.activeId) : null
  let leaf = null
  if (!newPane) {
    leaf = active && active.kind === 'browser' ? active : null
    if (!leaf) forEachLeaf(ws.tree, (l) => !leaf && l.kind === 'browser' && (leaf = l))
  }
  if (!leaf) {
    leaf = makeBrowserLeaf(null, target)
    const split = (orig) => reactive({ type: 'split', id: newId('split'), dir: 'row', sizes: [50, 50], children: [orig, leaf] })
    if (active) ws.tree = replaceNode(ws.tree, active.id, split)
    else ws.tree = ws.tree ? split(ws.tree) : leaf
  } else if (target !== BLANK_URL) leaf.url = target
  if (focusAddress || target === BLANK_URL) leaf.focusAddress = (leaf.focusAddress || 0) + 1
  if (maximizedId.value && maximizedId.value !== leaf.id) maximizedId.value = null
  selectWorkspace(ws.id)
  ws.activeId = leaf.id
  refitSoon()
  return leaf
}
// A page in the system browser (http and https only, checked again by main).
function openExternalUrl(url) {
  Promise.resolve(window.shellApi.openExternal ? window.shellApi.openExternal(url) : false)
    .then((ok) => {
      if (!ok) showToast(t('app.port.browserFailed', 'Failed to open browser'), { kind: 'error' })
    })
    .catch(() => showToast(t('app.port.browserFailed', 'Failed to open browser'), { kind: 'error' }))
}
// The file viewer's "Open in editor": Tessel's editor (a kept tab).
function openViewedInEditor({ file, line }) {
  fileView.value = null
  openInTesselEditor({ file, line, preview: false })
}
// A link in a viewed file: shown here too, or opened in the editor.
function openFromViewer(file) {
  if (isViewed(file)) viewFile({ file })
  else if (fileKind(file) === 'text') {
    fileView.value = null
    openInTesselEditor({ file })
  }
}

// Closing editor files with unsaved changes: Save, Don't Save or Cancel.
// -> true when closing may go on (saved, or not wanted).
async function askEditorClose(paths) {
  if (!paths.length) return true
  const names = paths.map((p) => fileName(p))
  const answer = await askConfirm({
    title: t('app.unsaved.title', 'Unsaved changes'),
    text:
      paths.length === 1
        ? t('app.unsaved.one', '"{{name}}" has unsaved changes. Do you want to save before closing?', { name: names[0] })
        : t('app.unsaved.many', '{{count}} files have unsaved changes ({{names}}). Do you want to save them before closing?', { count: paths.length, names: `${names.slice(0, 4).join(', ')}${paths.length > 4 ? ', …' : ''}` }),
    confirmLabel: paths.length === 1 ? t('app.unsaved.save', 'Save') : t('app.unsaved.saveAll', 'Save all'),
    altLabel: t('app.unsaved.dontSave', "Don't Save")
  })
  if (answer === 'alt') return true
  if (answer !== true) return false
  return saveDocs(paths)
}
// Editor files with unsaved changes that closing these panes would lose: every
// pane still showing one is among them (two closing panes showing the same
// file lose it too), each file asked about once.
function dirtyEditorPaths(leaves) {
  const editors = leaves.filter((l) => l && l.kind === 'editor')
  const ids = editors.map((l) => l.id)
  const out = []
  for (const l of editors) {
    for (const p of dirtyOnlyIn(ids, (l.files || []).map((f) => docPathOf(f)))) if (!out.some((o) => samePath(o, p))) out.push(p)
  }
  return out
}
// The keyboard goes back to the active pane: its terminal, or its editor.
function focusActiveInput() {
  const id = activeId.value
  const ed = id ? getEditorPane(id) : null
  if (ed) {
    ed.focus()
    return
  }
  const ta = document.querySelector('.ws-layer:not(.hidden) .pane.active .xterm-helper-textarea')
  if (ta) ta.focus()
}

// Jump to file (Ctrl+Shift+J): the current workspace's project files.
const finderOpen = ref(false)
function openFinder() {
  paletteOpen.value = false
  // Its files are on the remote host: nothing local to search.
  if (currentWs.value && currentWs.value.remote) {
    showToast(t('project.remote.unavailable', 'Not available for a remote project yet'))
    return
  }
  finderOpen.value = true
}
// Its folder: the workspace's project, else the active pane's folder.
function finderRoot() {
  if (currentWs.value && currentWs.value.cwd) return currentWs.value.cwd
  const leaf = activeId.value ? findLeaf(activeId.value) : null
  return (leaf && leaf.startDir) || null
}
function openFoundFile({ full, rel }) {
  if (isViewed(full)) return viewFile({ file: full, label: rel })
  openInTesselEditor({ file: full })
}
// Ctrl+Enter in Jump to file: the path into the active pane (quoted when it
// has spaces), e.g. to point an agent at it.
function insertFoundPath({ rel }) {
  const id = activeId.value
  const pane = id && getPane(id)
  if (!pane || !pane.paste) return
  pane.paste(/\s/.test(rel) ? `"${rel}"` : rel)
  focusPane(id)
}
// A quick command (Settings > Quick commands) into a pane: pasted as text
// (safe, bracketed when the program supports it), then Enter if asked.
function runQuickCommand(id, q) {
  const pane = getPane(id)
  if (!pane || !pane.paste) return
  pane.paste(q.text)
  if (q.enter) setTimeout(() => pane.submit && pane.submit(), 60)
  focusPane(id)
}
const mcpOpen = ref(false)
const mcpTab = ref('installed') // the tab it opens on
watch(mcpOpen, (open) => {
  if (!open) mcpTab.value = 'installed'
})
const toolsOpen = ref(false)
const sessionsOpen = ref(false)
// Launcher's "separate copy" (git worktree) option for agents.
const useWorktree = ref(false)
const worktreeState = reactive({ available: false, reason: null, checking: false })

// Where the launcher opens new panes: 'left' | 'right' | 'down'. Saved.
const placement = ref('right')
const launcher = reactive({ open: false, x: 0, y: 0, targetId: null })
const helpOpen = ref(false)
const helpCardEl = ref(null)
// The help dialog takes keyboard focus (so Esc reaches it, not the terminal)
// and hands it back to the active pane when it closes.
watch(helpOpen, (open) => {
  nextTick(() => {
    if (open) {
      if (helpCardEl.value) helpCardEl.value.focus()
    } else focusActiveInput()
  })
})

// Small, non-blocking notices (errors, "agent is done", folder changes).
const toasts = ref([])
let toastSeq = 0
function showToast(text, opts = {}) {
  const id = ++toastSeq
  toasts.value.push({ id, text, kind: opts.kind || 'info', action: opts.action || null })
  setTimeout(() => dismissToast(id), opts.timeout || 5000)
}
function dismissToast(id) {
  toasts.value = toasts.value.filter((t) => t.id !== id)
}
function runToastAction(t) {
  dismissToast(t.id)
  if (t.action) t.action.run()
}
const sidebarEl = ref(null)

// Confirmations in Tessel's own look (window.confirm ignores the theme).
// askConfirm({ title, text, confirmLabel, danger }) resolves to true / false.
// An image shown over Tessel ([Image #N] in a Claude Code pane): { src, title, file }
const imageView = ref(null)
const confirmState = ref(null)
function askConfirm(opts) {
  return new Promise((resolve) => {
    if (confirmState.value) confirmState.value.resolve(false)
    confirmState.value = { ...opts, resolve }
  })
}
function answerConfirm(ok) {
  const c = confirmState.value
  confirmState.value = null
  if (c) c.resolve(ok === 'alt' ? 'alt' : !!ok)
}
provide('askConfirm', askConfirm)
const currentWs = computed(() => wsById(currentWsId.value))

// Teams: named, coloured groups of agents inside a workspace. Each member pane
// keeps its team id (leaf.team); saved with the layout.
const TEAM_COLORS = ['#e0a526', '#3fb6a8', '#c77dd6', '#5b9df5', '#e2724f', '#8fbf4f']
const teams = ref([]) // [{ id, name, color }]
// Panes whose last message was pasted but not seen taken: leafId -> { item }.
// Nothing else is pasted there until the user resolves it.
const unsent = reactive({})
// Team messages waiting to be read, per agent (shown in Sessions).
const teamUnread = reactive({})
// The user's own typing, per pane. Tessel never types into a pane where the
// user has a line in progress (typed, not sent yet) or typed a moment ago:
// what the user writes is the user's, and is never sent for them.
const userDraft = reactive({}) // leafId -> true while a typed line is not sent
const lastUserKey = {}
// Panes found running whose line state is not known (older layout).
const draftUnknown = {}
const USER_QUIET_MS = 8000
function noteUserInput(id, data) {
  const s = String(data || '')
  if (s.includes('\r')) shellEnterAt[id] = Date.now()
  // Terminal replies and arrow keys (ESC [ ..., ESC O ...) are not typing;
  // a paste the user makes (ESC [200~ ... ESC [201~) is.
  const pasted = s.startsWith('\x1b[200~')
  // Keys the user presses that edit the line without typing: Up/Down recall
  // an older entry into it, Delete removes text, so its state is unknown
  // again (the screen can prove it empty later); other navigation keys are
  // activity in that pane.
  if (/^\x1b(?:\[|O)[AB]$|^\x1b\[3~$/.test(s)) {
    lastUserKey[id] = Date.now()
    if (!userDraft[id]) setDraftUnknown(id)
    return
  }
  if (/^\x1b(?:\[|O)[CDHF]$|^\x1b\[[1-8]~$/.test(s)) {
    lastUserKey[id] = Date.now()
    return
  }
  // Other escape sequences (focus, colour and device replies the terminal
  // sends by itself) are not typing; Esc alone is (it clears).
  if (s.length > 1 && s.startsWith('\x1b') && !pasted) return
  if (pasted) {
    lastUserKey[id] = Date.now()
    setDraft(id, true)
    return
  }
  lastUserKey[id] = Date.now()
  if (/[\r\n]/.test(s)) setDraft(id, false)
  // Ctrl+C, Esc, Ctrl+U clear the line in the agent CLIs.
  else if (s === '\x03' || s === '\x1b' || s === '\x15') setDraft(id, false)
  else if (/[^\x00-\x1f\x7f]/.test(s)) setDraft(id, true)
}
// Recorded at once in this window's storage (before the key reaches the
// terminal), so a reload right after a keystroke still knows it.
const DRAFTS_KEY = 'tessel.userDrafts'
function readDrafts() {
  try {
    return JSON.parse(localStorage.getItem(DRAFTS_KEY) || '{}') || {}
  } catch {
    return {}
  }
}
function setDraft(id, on) {
  if (userDraft[id] === on && !draftUnknown[id]) return // already recorded
  userDraft[id] = on
  delete draftUnknown[id]
  const all = readDrafts()
  if (all[id] === on) return
  all[id] = on
  try {
    localStorage.setItem(DRAFTS_KEY, JSON.stringify(all))
  } catch {
    // storage unavailable: the pane counts as unknown after a reload
  }
}
// The line may hold something again (history recalled, text deleted):
// unknown, also after a reload (the record is removed at once, before the
// key reaches the terminal).
function setDraftUnknown(id) {
  draftUnknown[id] = true
  const all = readDrafts()
  if (!(id in all)) return
  delete all[id]
  try {
    localStorage.setItem(DRAFTS_KEY, JSON.stringify(all))
  } catch {
    // storage unavailable: unknown after a reload anyway
  }
}
function userIsTyping(id) {
  return !!userDraft[id] || Date.now() - (lastUserKey[id] || 0) < USER_QUIET_MS
}


// `tree` and `activeId` always point at the current workspace, so the pane
// operations below work unchanged.
const tree = computed({
  get: () => (currentWs.value ? currentWs.value.tree : null),
  set: (v) => {
    if (currentWs.value) currentWs.value.tree = v
  }
})
const activeId = computed({
  get: () => (currentWs.value ? currentWs.value.activeId : null),
  set: (v) => {
    if (currentWs.value) currentWs.value.activeId = v
  }
})
const initError = ref('')
const openMenu = ref(null) // toolbar dropdown: 'layout' | 'agents'

// The help dialog's shortcuts, in the interface's language.
const shortcuts = computed(() => [
  {
    title: t('app.help.panes', 'Panes'),
    rows: [
      ['Ctrl+Shift+T', t('app.help.newPane', 'New pane: the default agent, or the default shell')],
      ['Ctrl+Shift+Space', t('app.help.launcher', 'Open a terminal or agent')],
      ['Ctrl+Shift+P', t('app.help.palette', 'Command palette: find panes, workspaces, commands')],
      ['Ctrl+Shift+J', t('app.help.finder', "Jump to a file of the workspace's project")],
      ['Ctrl+Shift+E', t('app.help.splitRight', 'Split right')],
      ['Ctrl+Shift+O', t('app.help.splitDown', 'Split down')],
      ['Ctrl+Shift+W', t('app.help.closePane', 'Close pane')],
      ['Ctrl+Shift+R', t('app.help.restartPane', 'Restart pane')],
      ['Alt+Arrow', t('app.help.movePanes', 'Move between panes')],
      ['Esc', t('app.help.restoreMax', 'Restore a maximized pane')]
    ]
  },
  {
    title: t('app.help.workspaces', 'Workspaces'),
    rows: [
      ['Ctrl+Shift+N', t('app.help.newWorkspace', 'New workspace')],
      ['Ctrl+PageUp', t('app.help.prevWorkspace', 'Previous workspace')],
      ['Ctrl+PageDown', t('app.help.nextWorkspace', 'Next workspace')]
    ]
  },
  {
    title: t('app.help.terminal', 'Terminal'),
    rows: [
      ['Ctrl+Shift+F', t('app.help.find', 'Find')],
      ['Ctrl+Shift+C', t('app.help.copy', 'Copy')],
      ['Ctrl+Shift+V', t('app.help.paste', 'Paste')],
      ['Ctrl+=', t('app.help.bigger', 'Bigger text')],
      ['Ctrl+-', t('app.help.smaller', 'Smaller text')],
      ['Ctrl+0', t('app.help.resetSize', 'Reset text size')],
      ['Shift+PageUp', t('app.help.scrollUp', 'Scroll up in the pane')],
      ['Shift+PageDown', t('app.help.scrollDown', 'Scroll down in the pane')]
    ]
  },
  {
    title: t('app.help.editor', 'Editor'),
    rows: [
      ['Ctrl+S', t('app.help.save', 'Save the file')],
      ['Ctrl+W', t('app.help.closeTab', 'Close the editor tab')],
      ['Ctrl+F', t('app.help.findInFile', 'Find in the file')],
      ['Ctrl+H', t('app.help.replace', 'Replace')],
      ['Ctrl+G', t('app.help.goToLine', 'Go to line')],
      ['Alt+Z', t('app.help.wordWrap', 'Word wrap on or off')],
      ['F7 / Shift+F7', t('app.help.nextChange', 'Next / previous change (a diff)')],
      ['Ctrl+Shift+A', t('app.help.reviewNote', 'Add Review Note (a diff: the selected lines)')]
    ]
  },
  {
    title: t('app.help.app', 'App'),
    rows: [
      ['Ctrl+Shift+B', t('app.help.broadcast', 'Broadcast typing to all panes')],
      ['Ctrl+Shift+K', t('app.help.taskBoard', 'Task board')],
      ['Ctrl+Shift+X', t('app.help.fileExplorer', 'File explorer')],
      ['Ctrl+Shift+G', t('app.help.sourceControl', 'Source Control (the git changes)')],
      ['Ctrl+,', t('app.help.settings', 'Settings')],
      ['Win+H', t('app.help.voice', 'Voice typing (Windows)')],
      ['F1', t('app.help.thisHelp', 'This help')]
    ]
  }
])
const updateLabel = computed(() => t('app.toolbar.updateVersion', 'Update {{version}}', { version: updateStatus.value.version }))

const gridOptions = [
  { value: '1x2', label: '1 x 2' },
  { value: '2x1', label: '2 x 1' },
  { value: '2x2', label: '2 x 2' },
  { value: '3x2', label: '3 x 2' },
  { value: '3x3', label: '3 x 3' }
]

let counter = 0
function newId(prefix) {
  counter += 1
  return `${prefix}-${counter}-${Math.floor(Math.random() * 1e6)}`
}

// Which agents we can resume, and how. Claude Code, Gemini and Qwen take the
// id we choose; Codex, OpenCode, Cline, Copilot and Kimi choose theirs, found
// after they start (watchFoundSession).
const RESUMABLE = ['claude', 'codex', 'gemini', 'qwen', 'opencode', 'cline', 'copilot', 'kimi']
const FOUND_AFTER_START = ['codex', 'opencode', 'cline', 'copilot', 'kimi']
function sessionKind(agent) {
  return agent && RESUMABLE.includes(agent.id) ? agent.id : null
}
// Ids come from the agents' own files: only plain ones go into a command line.
const safeSessionId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{6,80}$/.test(id)

function newUuid() {
  if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID()
  const b = window.crypto.getRandomValues(new Uint8Array(16))
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

// The command that starts an agent: a fresh conversation, or the pane's own
// previous one when `resume` is set and it exists.
async function agentStartLine(agent, sessionId, resume, accountId) {
  const kind = sessionKind(agent)
  if (kind === 'claude') {
    if (sessionId && resume) {
      // Resume if the conversation exists. If we can't check (older app
      // version), try resuming anyway rather than reusing an id in use.
      const exists = window.shellApi.claudeSessionExists
        ? await window.shellApi.claudeSessionExists(sessionId, accountId !== undefined ? { accountId } : undefined)
        : true
      if (exists)
        return { line: `${agent.command} --resume ${sessionId}`, sessionId, resumed: true } // i18n-ignore
    }
    // No transcript yet (you never messaged it): start fresh, same id.
    const id = sessionId || newUuid()
    return { line: `${agent.command} --session-id ${id}`, sessionId: id, resumed: false } // i18n-ignore
  }
  if (kind === 'codex') {
    // Without Codex's shared daemon: with it, the team tools lose the pane's
    // identity and are closed after start (see codexSupportsNoDaemon).
    const own =
      (window.shellApi.codexNoDaemon && (await window.shellApi.codexNoDaemon().catch(() => false)) ? ' --no-daemon' : '') +
      // No update check at start: its menu takes keystrokes (a reminder's
      // Enter chose "Update now" and Codex quit). Updates: Settings > Agents.
      ' -c check_for_update_on_startup=false'
    if (sessionId && resume) return { line: `${agent.command} resume ${sessionId}${own}`, sessionId, resumed: true } // i18n-ignore
    return { line: `${agent.command}${own}`, sessionId: null, resumed: false }
  }
  if (kind === 'gemini' || kind === 'qwen') {
    // Like Claude Code: resume if it was written to, else start with this id.
    if (sessionId && resume) {
      const check = kind === 'gemini' ? window.shellApi.geminiSessionExists : window.shellApi.qwenSessionExists
      const exists = check ? await check(sessionId).catch(() => false) : false
      if (exists) return { line: `${agent.command} --resume ${sessionId}`, sessionId, resumed: true } // i18n-ignore
    }
    const id = sessionId || newUuid()
    return { line: `${agent.command} --session-id ${id}`, sessionId: id, resumed: false } // i18n-ignore
  }
  const flag = { opencode: '--session', cline: '--id', copilot: '--resume', kimi: '--session' }[kind]
  if (flag && sessionId && resume && safeSessionId(sessionId)) {
    return { line: `${agent.command} ${flag} ${sessionId}`, sessionId, resumed: true }
  }
  return { line: agent.command, sessionId: null, resumed: false }
}

// Codex, OpenCode, Cline and Copilot pick their own session id; find it from
// their session files after the pane starts (some only create it with your
// first message: looked for during 30 minutes), so the pane can resume it
// next time.
function watchFoundSession(leaf, kind) {
  const find = window.shellApi.findAgentSession
    ? (q) => window.shellApi.findAgentSession({ ...q, agent: kind, ...(leaf.accountId !== undefined ? { accountId: leaf.accountId } : {}) })
    : kind === 'codex'
      ? window.shellApi.findCodexSession
      : null
  if (!find || !leaf.startDir) return
  let tries = 0
  const tick = async () => {
    if (leaf.sessionId || !findLeaf(leaf.id) || leaf.agentId !== kind || ++tries > 120) return
    const exclude = []
    forEachWsLeaf((l) => {
      if (l.sessionId) exclude.push(l.sessionId)
    })
    try {
      const id = await find({
        cwd: leaf.startDir,
        since: leaf.launchedAt,
        exclude,
        latest: !!leaf.launchGuessed,
        activeSince: leaf.launchGuessed ? leaf.attachedAt : 0
      })
      if (id) {
        leaf.sessionId = id
        return
      }
    } catch {
      /* try again */
    }
    setTimeout(tick, 15000)
  }
  setTimeout(tick, 8000)
}

async function createLeaf(shellId, agent = null, cwd = null, worktree = null, opts = {}) {
  const projectDir = cwd
  if (worktree && worktree.path) cwd = worktree.path
  const id = opts.id || newId('pane')
  let res = null
  let attached = false
  let restoredText = ''
  // Reopening a pane: its terminal may still be running in the terminal host
  // (after a restart, crash or reload). Re-attach and replay its output.
  if (opts.id && window.shellApi.attachPty) {
    try {
      const a = await window.shellApi.attachPty(opts.id)
      if (a && a.ok) {
        res = a
        attached = true
        seedBuffer(id, a.buffer)
      }
    } catch {
      /* fall back to a new terminal */
    }
  }
  // Settings > Agents: its command, arguments and variables; and the account
  // chosen for it (Settings > AI provider accounts), when there is one.
  // Its model (and effort): the pane's own choice (new pane menu, pane menu >
  // Model), else the agent's default (Settings > Agents), else no flag.
  // A worker (orchestration) starts with the model its coordinator asked for:
  // its flags come from workerLaunchArgs (the one place for a worker's launch
  // options), and it becomes the pane's own choice for its restarts.
  const workerChoice =
    agent && opts.launchOptions
      ? validPaneSessionOptions({
          model: opts.launchOptions.model,
          ...(typeof opts.launchOptions.effort === 'string' && opts.launchOptions.effort ? { effort: opts.launchOptions.effort } : {})
        })
      : null
  const paneChoice = agent ? validPaneSessionOptions(opts.sessionOptions) || workerChoice : null
  const sessionValues = agent ? launchSessionValues(paneChoice, settings.agentSessionOptions, agent.id) : null
  const agentModels = agent ? modelsFor(agent.id) : null
  // What it runs with, flags included (for the signature and the header).
  const launchAll = agent ? effectiveAgent(agent, settings.agentPrefs, settings.agentPermissions, sessionValues, agentModels) : null
  const launch = workerChoice ? effectiveAgent(agent, settings.agentPrefs, settings.agentPermissions, null, agentModels) : launchAll
  // The model flags really added (none when your own arguments set them).
  const modelApplied = !!(launchAll && sessionValues && launchAll.args !== effectiveAgent(agent, settings.agentPrefs, settings.agentPermissions).args)
  const extraEnv = launch ? { ...launch.env } : {}
  let unsetEnv = []
  // The account's own variables go separately, so they are never crowded out
  // by the agent's (at most 50 each).
  let accountEnv = {}
  // The pane keeps the account it started with (saved with the layout): a
  // restart or resume uses that one, not whichever is chosen now. null = the
  // system's own sign-in, chosen on purpose; undefined = not recorded (an
  // older layout, or a new pane): the account chosen now.
  let accountId = typeof opts.accountId === 'string' || opts.accountId === null ? opts.accountId : undefined
  // The account can't be used: never started on another one without saying
  // so. A saved pane stays in the layout, with the reason and Retry.
  let refused = null
  // Install the system hook definition before a managed account mirrors it.
  // A status setup failure does not prevent the user's agent from launching.
  if (agent && !attached && window.shellApi.prepareAgentStatus) {
    const statusSetup = await window.shellApi.prepareAgentStatus(agent.id).catch(() => null)
    if (statusSetup?.needsReview) showToast(t('app.codexHooks.updated', 'Codex status hooks were updated. Review them in /hooks to enable live status.'), { timeout: 10000 })
  }
  if (agent && !attached && window.shellApi.accounts && window.shellApi.accounts.launchEnv) {
    let acc = null
    try {
      acc = await window.shellApi.accounts.launchEnv(agent.id, accountId)
    } catch (err) {
      acc = { ok: false, error: err && err.message }
    }
    if (!acc || acc.ok === false) {
      refused = t('app.account.refused', '{{agent}} was not started: its account could not be used ({{error}}). See Settings > AI provider accounts.', { agent: agent.name || agent.id, error: (acc && acc.error) || t('app.common.unknownError', 'unknown error') })
      if (!opts.keepOnFailure) {
        showToast(refused, { kind: 'error', timeout: 10000 })
        return null
      }
    } else {
      // What the account removes can't come back from the agent's own
      // variables (an ANTHROPIC_API_KEY there would override the account).
      if (Array.isArray(acc.unsetEnv)) {
        unsetEnv = acc.unsetEnv.filter((n) => typeof n === 'string')
        const drop = new Set(unsetEnv.map((n) => n.toUpperCase()))
        for (const k of Object.keys(extraEnv)) if (drop.has(k.toUpperCase())) delete extraEnv[k]
      }
      if (acc.env && typeof acc.env === 'object') accountEnv = { ...acc.env }
      accountId = typeof acc.accountId === 'string' ? acc.accountId : null
    }
  }
  if (refused) {
    res = { ok: false, error: refused }
  } else if (!attached) {
    try {
      res = await window.shellApi.createPty({ id, shellId, agentId: agent?.id, cols: 80, rows: 24, cwd, projectDir, extraEnv, accountEnv, unsetEnv, ...(opts.remoteHostId ? { remoteHostId: opts.remoteHostId } : {}), ...(opts.remoteHostId && opts.remotePath ? { remotePath: opts.remotePath } : {}) })
    } catch (err) {
      res = { ok: false, error: err && err.message }
    }
    // The terminal stopped when the app closed: the pane shows what it last
    // printed above the new session (see TerminalPane).
    restoredText = res && res.ok ? opts.savedOutput || '' : ''
  }
  if (!res || !res.ok) {
    const msg = (res && res.error) || t('app.pane.startFailed', 'Could not start the terminal.')
    showToast(msg, { kind: 'error', timeout: 8000 })
    if (window.shellApi.log) window.shellApi.log('error', `pane ${id} could not start: ${msg}`)
    if (!opts.keepOnFailure) {
      initError.value = msg
      return null
    }
    // Reopening a saved pane: keep it in place so it isn't lost from the
    // layout; it shows the error and a Retry button.
    const failed = reactive({
      type: 'leaf',
      id,
      shellId,
      shellName: shellId,
      title: agent ? agent.name : shellId,
      kind: agent ? 'agent' : 'shell',
      agentId: agent ? agent.id : null,
      agentCommand: agent ? agent.command : null,
      accent: agent ? agent.accent : null,
      worktree: worktree && worktree.path ? { path: worktree.path, branch: worktree.branch } : null,
      backend: 'conpty',
      sessionId: opts.sessionId || null,
      accountId,
      ...(paneChoice ? { sessionOptions: paneChoice } : {}),
      remoteHostId: opts.remoteHostId || null,
      remotePath: (opts.remoteHostId && opts.remotePath) || null,
      failed: msg,
      broadcast: true
    })
    return failed
  }
  const leaf = reactive({
    type: 'leaf',
    id,
    shellId: res.shell.id,
    shellName: res.shell.name,
    title: agent ? agent.name : (res.remoteHost && res.remoteHost.label) || res.shell.name,
    kind: agent ? 'agent' : 'shell',
    agentId: agent ? agent.id : null,
    agentCommand: agent ? agent.command : null,
    accent: agent ? agent.accent : null,
    worktree: worktree && worktree.path ? { path: worktree.path, branch: worktree.branch } : null,
    backend: res.backend || 'winpty',
    windowsBuild: res.windowsBuild,
    pid: res.pid,
    startDir: res.cwd || cwd || null,
    sessionId: null,
    accountId,
    // A terminal on a remote host (Settings > SSH Hosts): ssh runs in it.
    remoteHostId: opts.remoteHostId || res.remoteHostId || null,
    // ...in this folder of that host (a remote project).
    remotePath: (opts.remoteHostId && opts.remotePath) || null,
    agentLaunchToken: res.agentLaunchToken || null,
    // How it was launched (Settings > Agents), to show Yolo and whether a
    // restart is needed to apply changed settings.
    launchSig: !attached && launchAll ? launchSignature(launchAll) : null,
    launchYolo: !attached && launch ? launchIsYolo(agent.id, launch) : false,
    // The pane's own model choice (kept with the layout and for restarts).
    ...(paneChoice ? { sessionOptions: paneChoice } : {}),
    // Started with a chosen model: the header shows it until the agent's
    // conversation answers with another one.
    ...(!attached && modelApplied
      ? { modelChoice: { model: sessionValues.model, effort: typeof sessionValues.effort === 'string' ? sessionValues.effort : null } }
      : {}),
    launchedAt: Date.now(),
    teamTools: !attached && teamToolsReady,
    toolsVersion: !attached && teamToolsReady ? teamToolsVersion : null,
    exitedAtStart: attached && !!res.exited,
    restoredText,
    broadcast: true
  })
  leaf.attached = attached
  if (res.agentStatusWarning) showToast(res.agentStatusWarning, { timeout: 10000 })
  if (attached) {
    // Still running: nothing to start. Keep the pane's conversation id, and
    // if Codex's id wasn't found yet, keep looking for it.
    leaf.sessionId = opts.sessionId || null
    if (opts.launchedAt) leaf.launchedAt = opts.launchedAt
    else {
      // Start time not recorded (older layout): take the latest session
      // from this folder in the last 12 hours.
      // Only a session you use from now on counts, so an unrelated older
      // conversation in the same folder is never picked by mistake.
      leaf.launchedAt = Date.now() - 12 * 3600 * 1000
      leaf.attachedAt = Date.now()
      leaf.launchGuessed = true
    }
    if (opts.startDir) leaf.startDir = opts.startDir
    if (FOUND_AFTER_START.includes(sessionKind(agent)) && !leaf.sessionId) watchFoundSession(leaf, agent.id)
    return leaf
  }
  // Launch the agent CLI once the shell has had a moment to print its prompt.
  if (agent && agent.command) {
    const start = await agentStartLine({ ...agent, command: launch.command }, opts.sessionId || null, !!opts.resume, accountId)
    leaf.sessionId = start.sessionId
    // Its arguments (or the Yolo flag) at the end: they work with resuming too.
    // A worker's launch options (model, effort, its first prompt) only on a
    // fresh start, through the one helper (src/shared/orchestration.js).
    const ownArgs = typeof (settings.agentPrefs[agent.id] || {}).args === 'string' ? settings.agentPrefs[agent.id].args : ''
    const workerOpts = opts.launchOptions && start.resumed ? { model: opts.launchOptions.model, effort: opts.launchOptions.effort } : opts.launchOptions
    const workerArgs = workerOpts ? workerLaunchArgs(agent.id, workerOpts, { ownArgs, models: agentModels }) : ''
    const extra = opts.remoteHostId ? quoteGlobArgs(workerArgs) : workerArgs
    if (opts.launchOptions) leaf.launchOptions = { model: opts.launchOptions.model || null, effort: opts.launchOptions.effort || null }
    // Relaunched by Tessel itself (opts.wake: resumed in place, restarted for
    // the team tools or an update, a dead pane resumed at start) while team
    // messages wait for it: its first prompt says so, on the command line
    // (nothing typed). Only when messages wait, never over a worker's own
    // first prompt, only with the team tools set up to read them, and only
    // while team wake-ups are on (checked before and after counting, and
    // again when the line is typed).
    let wakeArg = ''
    let waiting = 0
    if (opts.wake && settings.teamWakeUps && teamToolsReady && !(workerOpts && workerOpts.initialPrompt) && wakeLaunchArgs(agent.id, 1)) {
      waiting = await unreadAtLaunch(id, opts.wake.teamId)
      if (settings.teamWakeUps) wakeArg = wakeLaunchArgs(agent.id, waiting)
    }
    // A scheduled automation's run: its first prompt on the command line
    // (automationRunner.js), only on a fresh start.
    const automationArgs =
      opts.automationLaunch && !start.resumed ? automationLaunchArgs(agent.id, { ...opts.automationLaunch, shellId: res.shell && res.shell.id }) : ''
    if (opts.automationLaunch && !automationArgs && !start.resumed) {
      // Checked before the pane opened (the run then fails); never started without it.
      window.shellApi.killPty(id)
      return null
    }
    const base = (launch.args ? `${start.line} ${launch.args}` : start.line) + extra + automationArgs
    setTimeout(() => {
      const withWake = !!wakeArg && !!settings.teamWakeUps
      const full = base + (withWake ? wakeArg : '')
      const line = opts.wrap ? opts.wrap(full) : full
      window.shellApi.writePty(id, `${line}\r`)
      // Recorded only when the prompt really went: it was this launch's reminder.
      if (withWake) {
        noteLaunchWake(id, opts.wake.gen || 0)
        if (window.shellApi.log) window.shellApi.log('info', `team tools: ${agent.name || agent.id} (${id}) relaunched with a first prompt for ${waiting} waiting message(s)`)
      }
    }, 600)
    if (FOUND_AFTER_START.includes(sessionKind(agent)) && !leaf.sessionId) watchFoundSession(leaf, agent.id)
  }
  return leaf
}

function replaceNode(node, targetId, make) {
  if (!node) return null
  if (node.type === 'leaf') return node.id === targetId ? make(node) : node
  return {
    ...node,
    children: node.children.map((c) => replaceNode(c, targetId, make))
  }
}

// The panes that stay keep their share of the room (the sizes follow the
// children; the removed one's share is spread over the others).
function removeLeaf(node, targetId) {
  if (!node) return null
  if (node.type === 'leaf') return node.id === targetId ? null : node
  const kept = []
  node.children.forEach((c, i) => {
    const k = removeLeaf(c, targetId)
    if (k) kept.push({ node: k, size: (node.sizes && node.sizes[i]) || 0 })
  })
  if (kept.length === 0) return null
  if (kept.length === 1) return kept[0].node
  const total = kept.reduce((t, k) => t + k.size, 0)
  const sizes = kept.map((k) => (total > 0 ? (k.size / total) * 100 : 100 / kept.length))
  return { ...node, children: kept.map((k) => k.node), sizes }
}

function forEachLeaf(node, fn) {
  if (!node) return
  if (node.type === 'leaf') fn(node)
  else node.children.forEach((c) => forEachLeaf(c, fn))
}

function forEachWsLeaf(fn) {
  workspaces.value.forEach((w) => forEachLeaf(w.tree, fn))
}

// The pane with this id in a tree, or null (stops at the first match).
function findLeafIn(node, id) {
  if (!node) return null
  if (node.type === 'leaf') return node.id === id ? node : null
  for (const c of node.children) {
    const found = findLeafIn(c, id)
    if (found) return found
  }
  return null
}

// The workspace whose tree contains a pane. Pane operations target the owning
// workspace, so an async PTY spawn still lands in the right place even if the
// user switched workspaces meanwhile.
function wsOfLeaf(leafId) {
  return workspaces.value.find((w) => findLeafIn(w.tree, leafId)) || null
}

function firstLeafId(node) {
  if (!node) return null
  if (node.type === 'leaf') return node.id
  for (const c of node.children) {
    const id = firstLeafId(c)
    if (id) return id
  }
  return null
}

// --- Workspace persistence -------------------------------------------------
// Serialize the live tree into a plain snapshot (no PTYs / pids / runtime ids).
function serializeNode(node) {
  if (!node) return null
  // An editor pane: its tabs (no terminal).
  if (node.type === 'leaf' && node.kind === 'editor') {
    return {
      type: 'leaf',
      kind: 'editor',
      id: node.id,
      title: node.title || t('app.pane.editor', 'Editor'),
      num: node.num || null,
      files: (node.files || []).map((f) => ({ path: f.path, preview: !!f.preview })),
      activePath: node.activePath || null
    }
  }
  // A browser pane: its page (no terminal).
  if (node.type === 'leaf' && node.kind === 'browser') {
    return {
      type: 'leaf',
      kind: 'browser',
      id: node.id,
      title: node.title || t('app.pane.browser', 'Browser'),
      num: node.num || null,
      url: allowedBrowserUrl(node.url) || BLANK_URL,
      zoom: Number.isFinite(node.zoom) ? node.zoom : 0
    }
  }
  if (node.type === 'leaf') {
    return {
      type: 'leaf',
      id: node.id,
      shellId: node.shellId,
      title: node.detected ? node.shellTitle || node.title : node.title,
      broadcast: node.broadcast !== false,
      // An agent started by hand in a shell is saved as that shell (it is
      // detected again after a restart if it still runs there).
      kind: node.detected ? 'shell' : node.kind || 'shell',
      agentId: node.detected ? null : node.agentId || null,
      agentCommand: node.agentCommand || null,
      accent: node.accent || null,
      worktree: node.worktree || null,
      sessionId: node.sessionId || null,
      // Left out when not recorded (see createLeaf); null is kept.
      accountId: node.detected ? undefined : node.accountId,
      remoteHostId: node.remoteHostId || undefined,
      remotePath: node.remotePath || undefined,
      // Asleep: restored asleep (no terminal) until you open it.
      sleeping: !node.detected && node.sleeping && Number.isFinite(node.sleeping.at) ? { at: node.sleeping.at } : undefined,
      titleSet: node.detected ? undefined : node.titleSet || undefined,
      autoTitle: node.detected ? undefined : node.autoTitle || undefined,
      launchedAt: node.launchedAt || null,
      startDir: node.startDir || null,
      num: node.num || null,
      team: node.team || null,
      teamTools: !!node.teamTools,
      toolsVersion: node.toolsVersion || null,
      // Its own model choice (pane menu > Model), for the next start.
      sessionOptions: node.detected ? undefined : node.sessionOptions || undefined,
      launchSig: node.detected ? undefined : node.launchSig || undefined,
      launchYolo: node.detected ? undefined : node.launchYolo || undefined
    }
  }
  return {
    type: 'split',
    dir: node.dir,
    sizes: node.sizes.slice(),
    children: node.children.map(serializeNode)
  }
}

// Rebuild a live tree from a snapshot, spawning a fresh PTY per leaf.
async function deserializeNode(snap, cwd = null) {
  if (!snap) return null
  // An editor pane comes back with its tabs, without any terminal (a file
  // gone since shows its error in its tab).
  if (snap.type === 'leaf' && snap.kind === 'editor') {
    const files = validSavedFiles(snap.files)
    if (!files.length) return null
    const id = typeof snap.id === 'string' && /^pane-[\w-]+$/.test(snap.id) ? snap.id : null
    const leaf = makeEditorLeaf(id)
    if (typeof snap.title === 'string' && snap.title) leaf.title = snap.title.slice(0, 80)
    if (Number.isInteger(snap.num) && snap.num > 0) leaf.num = snap.num
    leaf.files = files
    const active = files.find((f) => samePath(f.path, snap.activePath))
    leaf.activePath = (active || files[0]).path
    return leaf
  }
  // A browser pane comes back on its page (http(s) only).
  if (snap.type === 'leaf' && snap.kind === 'browser') {
    const id = typeof snap.id === 'string' && /^pane-[\w-]+$/.test(snap.id) ? snap.id : null
    const leaf = makeBrowserLeaf(id, typeof snap.url === 'string' ? snap.url : BLANK_URL)
    if (typeof snap.title === 'string' && snap.title) leaf.title = snap.title.slice(0, 200)
    if (Number.isInteger(snap.num) && snap.num > 0) leaf.num = snap.num
    if (Number.isFinite(snap.zoom)) leaf.zoom = Math.max(-3, Math.min(5, snap.zoom))
    return leaf
  }
  if (snap.type === 'leaf') {
    const agent =
      snap.kind === 'agent' && snap.agentCommand
        ? {
            id: snap.agentId,
            name: snap.title || snap.agentId,
            command: snap.agentCommand,
            accent: snap.accent
          }
        : null
    const savedId = typeof snap.id === 'string' && /^pane-[\w-]+$/.test(snap.id) ? snap.id : null
    // An agent put to sleep stays asleep: its pane, conversation, account and
    // copy are kept, no terminal is started until you open it (Wake).
    if (agent && savedId && snap.sleeping && Number.isFinite(snap.sleeping.at) && safeSessionId(snap.sessionId)) {
      const asleep = reactive({
        type: 'leaf',
        id: savedId,
        shellId: snap.shellId,
        shellName: snap.shellId,
        title: snap.title || agent.name,
        kind: 'agent',
        agentId: agent.id,
        agentCommand: agent.command,
        accent: agent.accent || null,
        worktree: snap.worktree && snap.worktree.path ? { path: snap.worktree.path, branch: snap.worktree.branch } : null,
        backend: 'conpty',
        startDir: typeof snap.startDir === 'string' ? snap.startDir : cwd,
        sessionId: snap.sessionId,
        accountId:
          snap.accountId === null || (typeof snap.accountId === 'string' && /^[\w.-]{1,80}$/.test(snap.accountId))
            ? snap.accountId
            : undefined,
        launchedAt: Number.isFinite(snap.launchedAt) ? snap.launchedAt : null,
        ...(validPaneSessionOptions(snap.sessionOptions) ? { sessionOptions: validPaneSessionOptions(snap.sessionOptions) } : {}),
        restoredText: savedOutput[savedId] || '',
        sleeping: { at: snap.sleeping.at },
        broadcast: snap.broadcast !== false
      })
      if (Number.isInteger(snap.num) && snap.num > 0) asleep.num = snap.num
      if (snap.titleSet === true) asleep.titleSet = true
      if (typeof snap.autoTitle === 'string' && snap.autoTitle) asleep.autoTitle = snap.autoTitle.slice(0, 80)
      return asleep
    }
    const leaf = await createLeaf(snap.shellId, agent, cwd, snap.worktree || null, {
      id: savedId,
      savedOutput: snap.id ? savedOutput[snap.id] || '' : '',
      sessionId: snap.sessionId || null,
      accountId:
        snap.accountId === null || (typeof snap.accountId === 'string' && /^[\w.-]{1,80}$/.test(snap.accountId))
          ? snap.accountId
          : undefined,
      launchedAt: Number.isFinite(snap.launchedAt) ? snap.launchedAt : null,
      startDir: typeof snap.startDir === 'string' ? snap.startDir : null,
      sessionOptions: snap.sessionOptions,
      resume: settings.resumeAgents,
      remoteHostId: typeof snap.remoteHostId === 'string' && /^ssh-[\w-]{1,60}$/.test(snap.remoteHostId) ? snap.remoteHostId : undefined,
      remotePath: typeof snap.remotePath === 'string' && snap.remotePath.length <= 1024 ? snap.remotePath : undefined,
      keepOnFailure: true,
      // A team member started again (its terminal was gone): team messages
      // waiting for it go in its first prompt (see createLeaf).
      ...(typeof snap.team === 'string' ? { wake: { teamId: snap.team, gen: 0 } } : {})
    })
    if (!leaf) return null
    if (Number.isInteger(snap.num) && snap.num > 0) leaf.num = snap.num
    if (snap.teamTools) leaf.teamTools = true
    if (typeof snap.toolsVersion === 'string') leaf.toolsVersion = snap.toolsVersion
    // Still running since before: it keeps how it was launched.
    if (leaf.attached && typeof snap.launchSig === 'string') {
      leaf.launchSig = snap.launchSig.slice(0, 20000)
      leaf.launchYolo = snap.launchYolo === true
    }
    if (snap.titleSet === true) leaf.titleSet = true
    if (typeof snap.autoTitle === 'string' && snap.autoTitle) leaf.autoTitle = snap.autoTitle.slice(0, 80)
    // Still running: its line is what was saved. Unknown (an older layout):
    // no automatic reminder until the user sends or clears a line there.
    // Still running: its line is what this window recorded; nothing
    // recorded = unknown (no automatic reminder until the user sends or
    // clears a line there). A new terminal starts with an empty line.
    if (leaf.attached) {
      const saved = readDrafts()[leaf.id]
      if (saved === true) userDraft[leaf.id] = true
      else if (saved !== false) draftUnknown[leaf.id] = true
    }
    if (snap.title) leaf.title = snap.title
    // An older version named the pane after its conversation: the agent's
    // name comes back (the conversation's title shows beside it).
    if (leaf.kind === 'agent' && !leaf.titleSet && leaf.autoTitle && leaf.title === leaf.autoTitle) {
      const preset = agents.value.find((a) => a.id === leaf.agentId)
      if (preset && preset.name) leaf.title = preset.name
    }
    leaf.broadcast = snap.broadcast !== false
    if (typeof snap.team === 'string') leaf.team = snap.team
    return leaf
  }
  const children = []
  for (const child of snap.children || []) {
    const built = await deserializeNode(child, cwd)
    if (built) children.push(built)
  }
  if (!children.length) return null
  if (children.length === 1) return children[0]
  const sizes =
    Array.isArray(snap.sizes) && snap.sizes.length === children.length
      ? snap.sizes.slice()
      : children.map(() => 100 / children.length)
  return reactive({ type: 'split', id: newId('split'), dir: snap.dir, sizes, children })
}

let persistReady = false
let saveTimer = null
function scheduleSave() {
  if (!persistReady) return
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(saveLayoutNow, 500)
}

// Write the layout right away (also used before an update restarts the app).
function saveLayoutNow() {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = null
  if (!persistReady || !workspaces.value.length) return
  // JSON round-trip: IPC can only send plain data, and some values here
  // (custom agents, worktree info) are Vue reactive proxies.
  const snapshot = {
    version: 2,
    selectedShell: selectedShell.value,
    broadcast: broadcast.value,
    sidebarCollapsed: sidebarCollapsed.value,
    sidebarWidth: sidebarWidth.value,
    taskPanelWidth: taskPanelWidth.value,
    taskPanelOpen: taskPanelOpen.value,
    sidePanelTab: sideTab.value,
    currentIndex: Math.max(
      0,
      workspaces.value.findIndex((w) => w.id === currentWsId.value)
    ),
    placement: placement.value,
    teams: teams.value,
    settings: { ...settings },
    workspaces: workspaces.value.map((w) => ({
      id: w.id,
      name: w.name,
      cwd: w.cwd || null,
      ...(w.remote ? { remote: { hostId: w.remote.hostId, path: w.remote.path } } : {}),
      ...(w.group ? { group: { repos: w.group.repos.map((r) => ({ path: r.path, name: r.name })) } } : {}),
      tree: serializeNode(w.tree)
    }))
  }
  try {
    const text = JSON.stringify(snapshot)
    // Many changes never reach the saved layout (a pane's process id, its
    // restart count, a team's poll state): the same snapshot is not written
    // again.
    if (text === lastLayoutText) return
    lastLayoutText = text
    window.shellApi.saveLayout(JSON.parse(text))
  } catch (err) {
    console.error('Could not save the layout', err)
  }
}
let lastLayoutText = ''

async function splitLeaf(
  leafId,
  dir,
  agent = null,
  shellId = selectedShell.value,
  worktree = null,
  opts = {}
) {
  const ws = wsOfLeaf(leafId) || currentWs.value
  const leaf = await createLeaf(shellId, agent, opts.cwd || (ws && ws.cwd), worktree, wsLeafOpts(ws, opts))
  if (!leaf) return
  if (!ws || !workspaces.value.includes(ws)) {
    // The workspace is gone meanwhile: do not leave its terminal running.
    window.shellApi.killPty(leaf.id)
    return
  }
  // The pane it was split from was closed meanwhile: the new pane goes next
  // to what is there (or is the whole workspace), never lost.
  if (!findLeafIn(ws.tree, leafId)) {
    ws.tree = ws.tree
      ? reactive({ type: 'split', id: newId('split'), dir, sizes: [50, 50], children: opts.before ? [leaf, ws.tree] : [ws.tree, leaf] })
      : leaf
    ws.activeId = leaf.id
    return leaf
  }
  ws.tree = replaceNode(ws.tree, leafId, (orig) =>
    reactive({
      type: 'split',
      id: newId('split'),
      dir,
      sizes: [50, 50],
      // opts.before: the new pane goes first (to the left / above).
      children: opts.before ? [leaf, orig] : [orig, leaf]
    })
  )
  ws.activeId = leaf.id
  return leaf
}

// Settings > Git and > General: how task copies are named and where they go.
function worktreeSettings() {
  return {
    branchPrefix: settings.branchPrefix,
    branchPrefixCustom: settings.branchPrefixCustom,
    workspaceDir: settings.workspaceDir
  }
}

// Asks the main process what runs under a terminal's shell, at most 4 s (an
// unanswered probe is not proof it is idle: then Tessel asks, as Orca does).
function probeRunningWork(leafId) {
  const timeout = new Promise((resolve) => setTimeout(() => resolve({ unknown: true }), 4000))
  const ask = Promise.resolve(window.shellApi.ptyRunningWork(leafId))
    .then((r) => (r && typeof r === 'object' ? { running: !!r.running, unknown: !!r.unknown, names: Array.isArray(r.names) ? r.names : [] } : { unknown: true }))
    .catch(() => ({ unknown: true }))
  return Promise.race([ask, timeout]).then((r) => ({ names: [], ...r }))
}

function closeLeaf(leafId, opts = {}) {
  const ws = wsOfLeaf(leafId)
  const closing = findLeaf(leafId)
  const hadTeam = closing?.team || null
  const closingTitle = closing?.title || 'An agent' // i18n-ignore
  // An editor pane: unsaved files are asked about first; it has no terminal.
  if (closing && closing.kind === 'editor') {
    if (!opts.editorChecked) {
      const dirty = dirtyEditorPaths([closing])
      if (dirty.length) {
        askEditorClose(dirty).then((ok) => ok && closeLeaf(leafId, { ...opts, force: true, editorChecked: true }))
        return
      }
    }
    releaseOwner(leafId)
  }
  const isEditor = !!(closing && closing.kind === 'editor')
  // An editor or a browser pane: no terminal to stop.
  const noTerminal = hasNoTerminal(closing)
  // Settings > General, "Confirm before closing running terminals" (Orca's):
  // an agent pane, or a terminal where a program runs under the shell.
  if (!opts.force && settings.confirmCloseAgent && ws) {
    const leaf = findLeafIn(ws.tree, leafId)
    if (leaf && leaf.kind === 'agent') {
      askConfirm({
        title: t('app.close.title', 'Close {{name}}?', { name: leaf.title }),
        text: t('app.close.agentText', 'The agent session will end. Its conversation can be resumed later from Agent sessions.'),
        confirmLabel: t('app.close.confirm', 'Close'),
        danger: true
      }).then((ok) => ok && closeLeaf(leafId, { ...opts, force: true }))
      return
    }
    if (leaf && !noTerminal && !opts.probed && window.shellApi.ptyRunningWork) {
      probeRunningWork(leafId).then((work) => {
        if (!findLeaf(leafId)) return // closed meanwhile
        if (!work.running && !work.unknown) return closeLeaf(leafId, { ...opts, probed: true })
        askConfirm({
          title: t('app.close.title', 'Close {{name}}?', { name: leaf.title }),
          text: work.unknown
            ? t('app.close.unknownWork', 'Tessel could not check whether a command is still running in it. Closing stops anything running.')
            : work.names.length === 1
              ? t('app.close.runningOne', '{{names}} is still running in it. Closing stops it.', { names: work.names.join(', ') })
              : t('app.close.runningMany', '{{names}} are still running in it. Closing stops them.', { names: work.names.join(', ') }),
          confirmLabel: t('app.close.confirm', 'Close'),
          danger: true
        }).then((ok) => ok && closeLeaf(leafId, { ...opts, force: true }))
      })
      return
    }
  }
  if (!noTerminal) {
    window.shellApi.killPty(leafId)
    dropBuffer(leafId)
    clearAgentStatus(leafId)
  }
  if (!ws) return
  if (maximizedId.value === leafId) maximizedId.value = null
  const next = removeLeaf(ws.tree, leafId)
  if (next) {
    ws.tree = next
    if (ws.activeId === leafId) ws.activeId = firstLeafId(next)
  } else {
    ws.tree = null
    ws.activeId = null
    createLeaf(selectedShell.value, null, ws.cwd, null, wsLeafOpts(ws)).then((leaf) => {
      if (!leaf) return
      // A pane was dropped here meanwhile: keep it, drop this new shell.
      if (ws.tree) {
        window.shellApi.killPty(leaf.id)
        return
      }
      ws.tree = leaf
      ws.activeId = leaf.id
    })
  }
  if (hadTeam) {
    pruneTeams()
    // Its teammates hear it is gone, as with "Leave".
    if (teamById(hadTeam)) {
      recordActivity({
        type: 'team',
        action: 'closed',
        teamId: hadTeam,
        wsId: ws ? ws.id : null,
        name: teamById(hadTeam).name,
        detail: closingTitle
      })
      tellTeam(hadTeam, `${closingTitle} was closed and left the team.`) // i18n-ignore
    }
  }
}

// Arrange the workspace as an even grid. The panes already open are kept
// (still running, in their order) and fill the grid first; only the empty
// slots get a new shell. More panes than slots: rows are added, nothing is
// ever closed.
async function buildGrid(cols, rows, ws = currentWs.value) {
  if (!ws) return
  const kept = []
  forEachLeaf(ws.tree, (leaf) => kept.push(leaf))
  rows = Math.max(rows, Math.ceil(kept.length / cols))

  const rowNodes = []
  for (let r = 0; r < rows; r++) {
    const leaves = []
    for (let c = 0; c < cols; c++) {
      const leaf = kept.length ? kept.shift() : await createLeaf(selectedShell.value, null, ws.cwd, null, wsLeafOpts(ws))
      if (leaf) leaves.push(leaf)
    }
    if (!leaves.length) continue
    rowNodes.push(
      reactive({
        type: 'split',
        id: newId('split'),
        dir: 'row',
        sizes: leaves.map(() => 100 / leaves.length),
        children: leaves
      })
    )
  }
  if (!rowNodes.length) return

  const root =
    rowNodes.length === 1
      ? rowNodes[0]
      : reactive({
          type: 'split',
          id: newId('split'),
          dir: 'col',
          sizes: rowNodes.map(() => 100 / rowNodes.length),
          children: rowNodes
        })

  const active = ws.activeId
  ws.tree = root
  // The pane you were in stays the active one.
  if (!active || !findLeafIn(root, active)) ws.activeId = firstLeafId(root)
  maximizedId.value = null
  window.dispatchEvent(new Event('terminal-layout-change'))
}

// A terminal's own answer to a program's question (cursor position, device
// attributes, focus in/out): it goes back to that terminal only, never to
// the other panes.
const TERMINAL_REPLY = /^\x1b\[[?>]?[\d;]*[cRn]$|^\x1b\[[IO]$|^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)$/

function routeInput(sourceId, data) {
  // Multi-write: only typing in a pane that takes part (its "write" box
  // ticked), in the workspace on screen, goes to every such pane.
  const source = findLeafIn(tree.value, sourceId)
  const fanOut = broadcast.value && source && source.broadcast && !TERMINAL_REPLY.test(String(data))
  if (fanOut) {
    forEachLeaf(tree.value, (leaf) => {
      if (!leaf.broadcast || hasNoTerminal(leaf)) return
      noteUserInput(leaf.id, data)
      window.shellApi.writePty(leaf.id, data)
    })
  } else {
    noteUserInput(sourceId, data)
    window.shellApi.writePty(sourceId, data)
  }
}

function setActive(id) {
  activeId.value = id
}

const maximizedId = ref(null)

function toggleMaximize(id) {
  maximizedId.value = maximizedId.value === id ? null : id
}

// --- Agent Task Board (kanban side panel) ----------------------------------
const taskPanelOpen = ref(false)
// The task board's width: dragged by its left edge (double-click: back to
// the default), saved with the layout.
const TASK_PANEL_DEFAULT = 330
const TASK_PANEL_MIN = 260
const TASK_PANEL_MAX = 900
const taskPanelWidth = ref(TASK_PANEL_DEFAULT)
const taskResizing = ref(false)
// The width asked for is kept (taskPanelWidth); what is shown always leaves
// the terminals at least 420 px next to the workspace sidebar, also when the
// window or the sidebar changes size later.
const winWidth = ref(window.innerWidth)
const onWinResize = () => (winWidth.value = window.innerWidth)
window.addEventListener('resize', onWinResize)
onBeforeUnmount(() => window.removeEventListener('resize', onWinResize))
function clampTaskPanel(w) {
  const side = sidebarCollapsed.value ? 52 : sidebarWidth.value
  const max = Math.min(TASK_PANEL_MAX, Math.max(TASK_PANEL_MIN, winWidth.value - side - 420))
  return Math.round(Math.min(max, Math.max(TASK_PANEL_MIN, w)))
}
const taskPanelShown = computed(() => clampTaskPanel(taskPanelWidth.value))
watch(taskPanelShown, () => window.dispatchEvent(new Event('terminal-layout-change')))
let taskResizeLastDown = 0
function startTaskResize(e) {
  if (e.button !== 0) return
  e.preventDefault()
  const now = Date.now()
  if (now - taskResizeLastDown < 400) {
    taskResizeLastDown = 0
    taskPanelWidth.value = TASK_PANEL_DEFAULT
    window.dispatchEvent(new Event('terminal-layout-change'))
    return
  }
  taskResizeLastDown = now
  const right = e.currentTarget.parentElement.getBoundingClientRect().right
  // Keep receiving the pointer even outside the window, so letting go there
  // still ends the resize.
  try {
    e.currentTarget.setPointerCapture(e.pointerId)
  } catch {
    // not capturable: the window listeners below still end it
  }
  taskResizing.value = true
  document.body.classList.add('ws-resizing')
  const move = (ev) => {
    taskPanelWidth.value = clampTaskPanel(right - ev.clientX)
    window.dispatchEvent(new Event('terminal-layout-change'))
  }
  const up = () => {
    taskResizing.value = false
    document.body.classList.remove('ws-resizing')
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    window.removeEventListener('pointercancel', up)
    window.removeEventListener('blur', up)
    refitSoon()
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
  window.addEventListener('pointercancel', up)
  window.addEventListener('blur', up)
}

// Live list of agent panes, handed to the board so a task can be assigned to
// one. Walks the same tree the terminals render from, so it recomputes only when
// the tree structure or a pane title/accent changes.
// Agent panes a task on the current workspace's board can be assigned to.
const agentPanes = computed(() => {
  const out = []
  forEachLeaf(tree.value, (leaf) => {
    if (leaf.kind === 'agent') {
      out.push({
        id: leaf.id,
        num: leaf.num || null,
        title: leaf.title,
        agentId: leaf.agentId,
        accent: leaf.accent,
        track: trackOf(leaf.id)
      })
    }
  })
  return out
})

// --- The right side panel (SidePanel.vue): Files, Changes, Tasks tabs --------------
// taskPanelOpen: the panel is shown; sideTab: the tab it shows.
const SIDE_TABS = ['files', 'changes', 'tasks']
const sideTab = ref('tasks')
const explorerOpen = computed(() => taskPanelOpen.value && sideTab.value === 'files')
const taskBoardShown = computed(() => taskPanelOpen.value && sideTab.value === 'tasks')
// Show a tab; the same tab again (its shortcut or button) closes the panel.
function toggleSideTab(tab) {
  if (taskPanelOpen.value && sideTab.value === tab) taskPanelOpen.value = false
  else {
    sideTab.value = tab
    taskPanelOpen.value = true
  }
  nextTick(() => window.dispatchEvent(new Event('terminal-layout-change')))
}
// Show a tab, never closing the panel.
function showSideTab(tab) {
  sideTab.value = tab
  if (!taskPanelOpen.value) {
    taskPanelOpen.value = true
    nextTick(() => window.dispatchEvent(new Event('terminal-layout-change')))
  }
}
function closeSidePanel() {
  taskPanelOpen.value = false
  nextTick(() => window.dispatchEvent(new Event('terminal-layout-change')))
}
function toggleExplorer() {
  toggleSideTab('files')
}
// A file from the explorer or the changes. Second argument: a line (a
// content search result) or { keep } (a double-click keeps its tab).
// Markdown, images... open in the viewer; code in Tessel's editor (one click:
// a preview tab).
function openExplorerFile(file, arg = null) {
  const line = Number.isInteger(arg) ? arg : null
  const keep = !!(arg && typeof arg === 'object' && arg.keep)
  if (isViewed(file)) viewFile({ file, line, preview: !keep })
  else openInTesselEditor({ file, line, preview: !keep })
}
// A file of Source Control (the Changes tab): its diff, in its own editor tab
// ("name (diff)" / "name (staged diff)"), like Orca's openDiff.
// A file of a commit (area 'commit', its commit id): that commit's change, read-only.
function openScmDiff({ root, rel, oldRel = null, area, status = null, file, preview = true, line = null, commit = null } = {}) {
  if (!root || !rel || !file || !['staged', 'unstaged', 'untracked', 'commit'].includes(area)) return null
  if (area === 'commit' && !/^[0-9a-f]{7,64}$/.test(String(commit || ''))) return null
  const path = diffTabPath(file, area, commit)
  const leaf = openInTesselEditor({ file: path, line: Number.isInteger(line) ? line : null, preview })
  if (!leaf) return null
  leaf.files = leaf.files.map((f) =>
    samePath(f.path, path)
      ? { ...f, mode: f.mode === 'rich' ? 'rich' : 'diff', diff: { root, rel, oldRel: oldRel || null, area, status, full: file, ...(area === 'commit' ? { commit } : {}) } }
      : f
  )
  return leaf
}
// "Create PR" from Source Control: GitHub's pull request form for that folder.
function openCreatePr({ cwd, taskId = null } = {}) {
  const task = taskId ? boardTasks.find((t) => t.id === taskId) : null
  if (task && task.worktree) return openGitHub(task)
  closeMenus()
  paletteOpen.value = false
  issueWorkspaceId.value = currentWsId.value
  githubTaskContext.value = cwd ? { cwd, base: '' } : null
  githubOpen.value = true
}
// A path can go into the active pane when it is a terminal.
const canInsertPath = computed(() => {
  const l = activeId.value ? findLeaf(activeId.value) : null
  return !!l && !hasNoTerminal(l)
})
function terminalHere(dir) {
  // A folder of a remote project: a terminal on its host, in that folder.
  if (isRemotePath(dir)) {
    const p = parseRemotePath(dir)
    if (p) openPaneBelow(selectedShell.value, null, { remoteHostId: p.hostId, remotePath: p.path })
    return
  }
  openPaneBelow(selectedShell.value, null, { cwd: dir })
}

// The side panel's folder: the project's, or for a project on an SSH host its
// virtual root (ssh://…), which Files, Changes and the editor read over SSH
// (src/main/remoteFs.js).
const sideRoot = computed(() => {
  const ws = currentWs.value
  if (!ws) return null
  if (ws.remote) return remoteRoot(ws.remote.hostId, ws.remote.path)
  return ws.cwd
})
const sideRemote = computed(() => {
  const ws = currentWs.value
  return ws && ws.remote ? { hostId: ws.remote.hostId, host: remoteHostLabel(ws.remote.hostId), path: ws.remote.path } : null
})
// The main process reads files only below the remote projects of the saved
// layout: a remote project added or removed is saved at once (not after the
// usual short delay), so its Files tab can read it right away.
watch(
  () =>
    workspaces.value
      .filter((w) => w.remote)
      .map((w) => remoteRoot(w.remote.hostId, w.remote.path))
      .filter(Boolean)
      .join('\n'),
  () => saveLayoutNow()
)
function insertPathInPane(text) {
  const id = activeId.value
  const pane = id && getPane(id)
  if (!pane || !pane.paste) return
  pane.paste(text)
  focusPane(id)
}

// The task board: the side panel's Tasks tab (Ctrl+Shift+K). Opening/closing
// the panel changes the terminal area's width — toggleSideTab nudges panes to
// refit with the same event SplitNode dispatches on a divider drag.
function toggleTaskPanel() {
  toggleSideTab('tasks')
}

// Pane ids are re-minted on every launch (serializeNode drops the id;
// deserializeNode spawns fresh PTYs with new ids), so a persisted task.paneId
// from a previous session points at a pane that no longer exists. After
// hydrating, null any assignment whose pane isn't in the live tree so the board
// never shows a task pinned to a dead pane.
function reconcileTaskPanes() {
  const liveIds = new Set()
  forEachWsLeaf((leaf) => liveIds.add(leaf.id))
  const wsIds = new Set(workspaces.value.map((w) => w.id))
  const fallback = currentWsId.value || (workspaces.value[0] && workspaces.value[0].id)
  for (const task of boardTasks) {
    // Each workspace has its own board. Tasks saved before that (or whose
    // workspace is gone) go to their pane's workspace, else the current one,
    // so none disappears.
    if (!task.wsId || !wsIds.has(task.wsId)) {
      const owner = task.paneId && wsOfLeaf(task.paneId)
      updateTask(task.id, { wsId: owner ? owner.id : fallback })
    }
    if (task.paneId && !liveIds.has(task.paneId)) updateTask(task.id, { paneId: null })
  }
}

// Debounced task persistence — mirrors scheduleSave() for the workspace layout,
// but targets B2's separate taskboard store. Snapshot to plain objects so the
// Vue reactive proxy is stripped before the IPC structured clone.
let taskSaveTimer = null
// Board requests from agents already applied ("<team>/<file>"), saved in the
// board's file with the cards (see syncTeamBoard).
const appliedRequests = new Set()
function boardToSave() {
  return { tasks: JSON.parse(JSON.stringify(boardTasks)), appliedRequests: [...appliedRequests] }
}

// Every board save goes here: none while the saved board could not be read
// (locked at start), so it is never overwritten.
function saveBoard() {
  if (boardLocked) return Promise.resolve({ ok: false, error: t('app.board.lockedAtStart', 'The saved board could not be read at start.') })
  return window.shellApi.taskBoard.save(boardToSave())
}
function scheduleTaskSave() {
  if (taskSaveTimer) clearTimeout(taskSaveTimer)
  taskSaveTimer = setTimeout(() => {
    taskSaveTimer = null
    saveBoard()
  }, 500)
}

// --- Updates ------------------------------------------------------------------
// The main process downloads new versions in the background (updater.js); the
// toolbar shows a button once one is ready, and installing restarts the app
// with every pane reopened where it was.
// The dev build marks itself in the toolbar (yellow logo + "(dev)"), so it
// can't be mistaken for the installed app when both are around.
const isDev = !!window.shellApi.isDev
const updateStatus = ref({ state: 'disabled' })
const updateOpen = ref(false)
const updateInstalling = ref(false)
// This version's GitHub release page ("Release notes" on the update card).
const updateReleaseUrl = computed(() =>
  updateStatus.value.version ? `https://github.com/mindkind1337/tessel/releases/tag/v${updateStatus.value.version}` : '' // i18n-ignore
)
let unsubUpdate = null

function paneCount() {
  let n = 0
  forEachWsLeaf(() => n++)
  return n
}

async function checkForUpdates() {
  if (!window.shellApi.update) return
  updateStatus.value = await window.shellApi.update.check()
}

async function installUpdate() {
  if (updateInstalling.value) return
  // The app restarts: unsaved editor files are asked about first.
  const dirty = Object.values(editorDocs)
    .filter((d) => d.dirty)
    .map((d) => d.path)
  if (dirty.length && !(await askEditorClose(dirty))) return
  updateInstalling.value = true
  // Write everything now instead of waiting for the debounced saves.
  saveLayoutNow()
  await saveActivityNow()
  if (taskSaveTimer) {
    clearTimeout(taskSaveTimer)
    taskSaveTimer = null
    try {
      await saveBoard()
    } catch {
      /* best-effort */
    }
  }
  const ok = await window.shellApi.update.install()
  if (!ok) {
    updateInstalling.value = false
    showToast(t('app.update.notReady', 'The update is not ready to install yet.'), { kind: 'error' })
  }
}

async function initUpdates() {
  const api = window.shellApi.update
  if (!api) return
  unsubUpdate = api.onStatus((s) => {
    // A ready update shows Orca's "Update Available" card (UpdateCard.vue).
    updateStatus.value = s
  })
  updateStatus.value = await api.status()
  const done = await api.justInstalled()
  if (done) {
    showToast(t('app.update.done', 'Updated to Tessel {{version}}. Your panes were restored.', { version: done.to }), {
      timeout: 8000
    })
  }
}

provide('panelCtx', {
  broadcast,
  activeId,
  maximizedId,
  shells,
  // The agents' names, for a pane's hover card (its agent under its name).
  agents,
  selectedShell,
  routeInput,
  splitLeaf,
  closeLeaf,
  restartLeaf,
  wakeLeaf: (id) => wakeLeaf(id),
  setActive,
  toggleMaximize,
  fontSize,
  notifyAgentDone,
  notifyAgentLimit,
  terminalBell,
  openLauncherAt,
  beginPaneDrag,
  otherPanes,
  sendToPane,
  highlightId,
  voiceTyping,
  voiceTypingIn,
  voiceLanguages,
  voiceLabel,
  voiceName,
  teamById,
  leaveTeam,
  setTeamLead,
  teamLead,
  taskOfPane,
  trackOf,
  setChildrenRunning,
  unsent,
  resolveUnsent,
  agentReportedDone,
  automationTurnDone,
  copied: (what) => showToast(t('app.toast.copied', '{{what}} copied.', { what }), { timeout: 2000 }),
  toast: (text, opts) => showToast(text, opts),
  showImage: (img) => (imageView.value = img),
  viewFile: (f) => viewFile(f),
  // A file:line link into Tessel's editor ({ file, line, col }).
  openInEditor: (q) => openInTesselEditor(q),
  // The built-in browser: the active ports, a page in the system browser.
  browserPorts: () => browserPorts(),
  openExternal: (url) => openExternalUrl(url),
  // Tessel's shortcuts pressed in an editor pane (it keeps them from Monaco).
  appShortcut: (e) => onKey(e, { fromEditor: true })
})

function splitActive(dir) {
  if (activeId.value) splitLeaf(activeId.value, dir)
}

function closeActive() {
  if (activeId.value) closeLeaf(activeId.value)
}

function toggleBroadcast() {
  broadcast.value = !broadcast.value
}

function applyGrid(v) {
  if (!v) return
  const [cols, rows] = v.split('x').map(Number)
  closeMenus()
  buildGrid(cols, rows)
}

function toggleMenu(name) {
  launcher.open = false
  openMenu.value = openMenu.value === name ? null : name
}

// --- Command palette (Ctrl+Shift+P, or the search box in the toolbar) ------------
const paletteOpen = ref(false)
const paletteCommands = ref([])

function openPalette() {
  closeMenus()
  paletteCommands.value = buildCommands()
  paletteOpen.value = true
}

function togglePalette() {
  if (paletteOpen.value) paletteOpen.value = false
  else openPalette()
}

// Everything the palette can do, built fresh each time it opens.
function buildCommands() {
  const cmds = []
  const add = (group, title, run, extra = {}) =>
    cmds.push({ id: `${group}:${cmds.length}`, group, title, run, ...extra })

  for (const s of shells.value) {
    add(t('app.cmd.group.new', 'New'), t('app.cmd.newNamed', 'New {{name}}', { name: s.name }), () => launch({ kind: 'shell', id: s.id }), {
      shortcut: s.id === selectedShell.value ? 'Ctrl+Shift+T' : ''
    })
  }
  for (const a of launchableAgents.value.filter((x) => x.available)) {
    add(t('app.cmd.group.new', 'New'), t('app.cmd.newNamed', 'New {{name}}', { name: a.name }), () => launch({ kind: 'agent', id: a.id }), { hint: t('app.cmd.aiAgent', 'AI agent') })
  }
  add(t('app.cmd.group.new', 'New'), t('app.cmd.newWorkspace', 'New workspace'), createWorkspace, { shortcut: 'Ctrl+Shift+N' })
  add(t('app.cmd.group.new', 'New'), t('project.cmd.addProject', 'Add a project…'), openAddProject)
  if (currentWs.value)
    add(t('app.cmd.group.new', 'New'), t('app.cmd.newBrowser', 'New browser pane'), () => openInBrowser({ newPane: true, focusAddress: true }), {
      hint: t('app.cmd.newBrowserHint', 'A web page next to your terminals (your dev server, docs)')
    })

  const layout = t('app.cmd.group.layout', 'Layout')
  add(layout, t('app.cmd.splitRight', 'Split right'), () => splitActive('row'), { shortcut: 'Ctrl+Shift+E' })
  add(layout, t('app.cmd.splitDown', 'Split down'), () => splitActive('col'), { shortcut: 'Ctrl+Shift+O' })
  for (const o of gridOptions) add(layout, t('app.cmd.evenGrid', 'Even grid {{grid}}', { grid: o.label }), () => applyGrid(o.value))
  if (activeId.value) {
    const id = activeId.value
    add(layout, t('app.cmd.maximize', 'Maximize or restore the active pane'), () => toggleMaximize(id))
  }
  add(layout, t('app.cmd.closeActive', 'Close the active pane'), closeActive, { shortcut: 'Ctrl+Shift+W' })
  add(layout, sidebarCollapsed.value ? t('app.cmd.showSidebar', 'Show the sidebar') : t('app.cmd.hideSidebar', 'Hide the sidebar'), toggleSidebar)

  const agentsGroup = t('app.cmd.group.agents', 'Agents')
  add(agentsGroup, t('app.cmd.resumeSession', 'Resume a session'), openSessions, {
    hint: t('app.cmd.resumeSessionHint', 'Reopen a past Claude or Codex conversation')
  })
  add(agentsGroup, t('app.cmd.mcp', 'MCP servers'), () => (mcpOpen.value = true), { hint: t('app.cmd.mcpHint', 'Give agents extra tools') })
  add(agentsGroup, t('app.cmd.installTools', 'Install tools'), openTools, { hint: t('app.cmd.installToolsHint', 'Agents, Git, Node.js and more') })
  add(agentsGroup, t('app.cmd.checkAgentUpdates', 'Check for agent updates'), () => checkAgentUpdates({ force: true }), {
    hint: t('app.cmd.checkAgentUpdatesHint', 'Newer versions of your installed agent CLIs')
  })
  if (agentUpdateCount.value) {
    add(agentsGroup, t('app.cmd.updateAgents', 'Update agents ({{count}})', { count: agentUpdateCount.value }), () => openSettingsAt('agents'), {
      hint: t('app.cmd.updateAgentsHint', 'Settings > Agents: update, then resume each conversation')
    })
  }
  add(agentsGroup, broadcast.value ? t('app.cmd.broadcastOff', 'Turn broadcast off') : t('app.cmd.broadcastOn', 'Turn broadcast on'), toggleBroadcast, {
    shortcut: 'Ctrl+Shift+B'
  })
  add(
    agentsGroup,
    taskBoardShown.value ? t('app.cmd.hideBoard', 'Hide the task board') : t('app.cmd.showBoard', 'Show the task board'),
    toggleTaskPanel,
    {
      shortcut: 'Ctrl+Shift+K'
    }
  )

  // Quick commands (Settings > Quick commands): sent to the active pane
  // (a terminal: an editor pane takes no command).
  if (activeId.value && findLeaf(activeId.value) && !hasNoTerminal(findLeaf(activeId.value))) {
    const id = activeId.value
    for (const q of settings.quickCommands || []) {
      add(t('app.cmd.group.quick', 'Quick commands'), t('app.cmd.runQuick', 'Run: {{name}}', { name: q.name }), () => runQuickCommand(id, q), {
        hint: q.text.length > 60 ? `${q.text.slice(0, 60)}…` : q.text
      })
    }
  }
  const files = t('app.cmd.group.files', 'Files')
  add(files, explorerOpen.value ? t('app.cmd.hideExplorer', 'Hide the file explorer') : t('app.cmd.showExplorer', 'Show the file explorer'), toggleExplorer, {
    shortcut: 'Ctrl+Shift+X',
    hint: t('app.cmd.explorerHint', "The project's files, with their git status")
  })
  add(files, taskPanelOpen.value && sideTab.value === 'changes' ? t('app.cmd.hideScm', 'Hide Source Control') : t('app.cmd.showScm', 'Show Source Control'), () => toggleSideTab('changes'), {
    shortcut: 'Ctrl+Shift+G',
    hint: t('app.cmd.scmHint', 'Stage, commit, push; review diffs and send notes to an agent')
  })
  add(files, t('app.cmd.jumpToFile', 'Jump to a file…'), openFinder, {
    shortcut: 'Ctrl+Shift+J',
    hint: t('app.cmd.jumpToFileHint', "Find a file of this workspace's project by a few letters")
  })
  add(t('app.cmd.group.quick', 'Quick commands'), t('app.cmd.editQuick', 'Add or edit quick commands'), () => openSettingsAt('quick-commands'), {
    hint: t('app.cmd.editQuickHint', 'Text you send to a pane in two keystrokes')
  })
  add(t('app.cmd.group.settings', 'Settings'), t('app.cmd.stats', 'Stats & Usage'), () => openSettingsAt('stats'), { hint: t('app.cmd.statsHint', 'Token analytics, daily usage, models, projects and conversations') })

  add(t('app.cmd.group.task', 'Task'), t('app.cmd.newTask', 'New task…'), openNewTask, { hint: t('app.cmd.newTaskHint', 'Give an agent a task, in its own copy of the project') })
  add(t('app.cmd.group.task', 'Task'), t('app.cmd.automations', 'Automations'), () => openSettingsAt('automations'), {
    hint: t('app.cmd.automationsHint', 'Run an agent task on a schedule while Tessel is open')
  })
  const issues = t('app.cmd.group.issues', 'Issues')
  add(issues, t('app.cmd.github', 'GitHub issues and pull requests'), () => openGitHub(), { hint: t('app.cmd.githubHint', 'Browse, create, check and start a task from GitHub') })
  add(issues, t('app.cmd.linear', 'Linear issues'), openLinear, { hint: t('app.cmd.linearHint', 'Assigned issues, teams, states and new agent tasks') })
  const activeTask = activeId.value ? taskOfPane(activeId.value) : null
  if (activeTask?.worktree) add(issues, t('app.cmd.createPr', 'Create a GitHub pull request from this task copy'), () => openGitHub(activeTask))
  if (currentWs.value) {
    const wsId = currentWs.value.id
    const wsGroup = t('app.cmd.group.workspace', 'Workspace')
    add(wsGroup, t('app.cmd.messageAll', 'Message every agent in this workspace'), () => startWsMessage(wsId), {
      hint: t('app.cmd.messageAllHint', 'One message, sent to each agent (never to plain shells)')
    })
    add(wsGroup, t('app.cmd.activity', 'Activity of the agents'), () => openActivity('workspace'), {
      hint: t('app.cmd.activityHint', 'Messages, approvals, limits and working time')
    })
    add(wsGroup, t('app.cmd.notes', 'Project notes'), () => openNotesView(wsId), {
      hint: t('app.cmd.notesHint', 'Read or edit the notes the agents of this workspace share')
    })
    add(wsGroup, t('app.cmd.notesExternal', 'Open project notes in a text editor'), () => openProjectNotes(wsId))
    add(wsGroup, t('app.cmd.shareNotes', 'Share project notes with the agents'), () => shareProjectNotes(wsId), {
      hint: t('app.cmd.shareNotesHint', 'Tell each agent where the notes are')
    })
  }

  for (const theme of THEMES) {
    if (theme.id !== settings.theme) {
      add(t('app.cmd.group.theme', 'Theme'), t('app.cmd.theme', 'Theme: {{name}}', { name: theme.label }), () => (settings.theme = theme.id), { hint: theme.description })
    }
  }

  add('Tessel', t('app.cmd.settings', 'Settings'), () => (settingsOpen.value = true), { shortcut: 'Ctrl+,' })
  add('Tessel', t('app.cmd.help', 'Keyboard shortcuts and help'), () => (helpOpen.value = true), { shortcut: 'F1' })
  if (updateStatus.value.state === 'ready') {
    add('Tessel', t('app.cmd.installUpdate', 'Install update {{version}}', { version: updateStatus.value.version }), () => (updateOpen.value = true))
  } else {
    add('Tessel', t('app.cmd.checkUpdates', 'Check for updates'), checkForUpdates)
  }
  add('Tessel', t('app.cmd.openLogs', 'Open the logs folder'), openLogs)

  for (const w of workspaces.value) {
    if (w.id !== currentWsId.value) {
      add(t('app.cmd.group.goWorkspace', 'Go to workspace'), w.name, () => selectWorkspace(w.id), { hint: w.cwd || '' })
    }
  }
  for (const w of workspaces.value) {
    forEachLeaf(w.tree, (leaf) => {
      add(t('app.cmd.group.goPane', 'Go to pane'), paneLabel(leaf), () => focusPane(leaf.id), {
        hint: workspaces.value.length > 1 ? w.name : leaf.shellName || ''
      })
    })
  }
  return cmds
}

// Run a toolbar menu command and close the menu.
function menuAction(fn) {
  closeMenus()
  fn()
}

function agentById(id) {
  return agents.value.find((a) => a.id === id) || null
}

// Open a terminal (kind 'shell') or an agent next to `targetId`, per the
// chosen placement. Agents run inside the default shell.
async function launch({ kind, id, sessionOptions = null }, targetId = activeId.value, where = placement.value) {
  closeMenus()
  const agent = kind === 'agent' ? agentById(id) : null
  if (kind === 'agent' && (!agent || agent.available === false)) return
  const shellId = kind === 'shell' ? id : selectedShell.value

  // Optionally give the agent its own git worktree + branch.
  let worktree = null
  const baseWs = (targetId && wsOfLeaf(targetId)) || currentWs.value
  if (agent && useWorktree.value && worktreeState.available && baseWs && baseWs.cwd) {
    const res = await window.shellApi.createWorktree(baseWs.cwd, agent.id, worktreeSettings())
    if (!res || !res.ok) {
      showToast((res && res.error) || t('app.worktree.createFailed', 'Could not create a separate copy.'), {
        kind: 'error',
        timeout: 8000
      })
      return
    }
    worktree = { path: res.path, branch: res.branch }
    showToast(
      t('app.worktree.created', '{{agent}} works on branch {{branch}} in {{path}}. When it is done, merge it from the main folder with: git merge {{branch}}', { agent: agent.name, branch: res.branch, path: res.path }),
      { timeout: 12000 }
    )
  }

  if (where === 'workspace') {
    const from = currentWs.value
    const ws = makeWorkspace(
      agent ? agent.name.replace(/\s+(CLI|Code)$/i, '') : nextWorkspaceName()
    )
    ws.cwd = from ? from.cwd : null
    ws.remote = from && from.remote ? { ...from.remote } : null
    workspaces.value.push(ws)
    selectWorkspace(ws.id)
    const leaf = await createLeaf(shellId, agent, ws.cwd, worktree, wsLeafOpts(ws, { sessionOptions }))
    if (leaf) {
      ws.tree = leaf
      ws.activeId = leaf.id
    }
    return
  }

  const ws = (targetId && wsOfLeaf(targetId)) || currentWs.value
  if (targetId && ws && ws.tree) {
    await splitLeaf(targetId, where === 'down' ? 'col' : 'row', agent, shellId, worktree, { before: where === 'left', sessionOptions })
    return
  }
  if (!ws) return
  const leaf = await createLeaf(shellId, agent, ws.cwd, worktree, { sessionOptions })
  if (leaf) {
    ws.tree = leaf
    ws.activeId = leaf.id
  }
}

// Agents: built-in list from the main process plus your own (settings), with
// availability checked against the current PATH.
async function loadAgents(refresh = false) {
  const custom = settings.customAgents.map((a) => ({ ...a }))
  try {
    const fn =
      refresh && window.shellApi.refreshAgents
        ? window.shellApi.refreshAgents
        : window.shellApi.listAgents
    const list = await fn(custom)
    if (Array.isArray(list)) {
      const before = new Set(agents.value.filter((a) => a.available).map((a) => a.id))
      agents.value = list
      // An agent installed since the team tools were set up (Install button,
      // or by hand): set them up again so it gets them, and the board rule in
      // its memory, without restarting Tessel.
      if (teamToolsReady && list.some((a) => a.available && !a.custom && !before.has(a.id))) {
        teamToolsReady = false
        installTeamToolsOnce()
      }
    }
  } catch {
    /* keep the previous list */
  }
}

// Open a new pane below the active one (or as the workspace's only pane).
async function openPaneBelow(shellId, agent = null, opts = {}) {
  const ws = currentWs.value
  if (!ws) return null
  if (activeId.value && ws.tree) return splitLeaf(activeId.value, 'col', agent, shellId, null, opts)
  const leaf = await createLeaf(shellId, agent, ws.cwd, null, wsLeafOpts(ws, opts))
  if (leaf) {
    ws.tree = leaf
    ws.activeId = leaf.id
  }
  return leaf
}

// Remote hosts (remoteHosts.js): Connect opens a terminal pane running ssh
// on the host; Manage Remote Hosts opens Settings > SSH Hosts.
setRemoteHostHandlers({
  connect: async (target) => {
    settingsOpen.value = false
    return !!(await openPaneBelow(selectedShell.value, null, { remoteHostId: target.id }))
  },
  openSettings: () => openSettingsAt('ssh')
})
initRemoteHosts()

// --- Add a project (components/project/AddProjectDialog.vue) ----------------
// The sidebar's "Add project" opens it; it hands back the projects to make:
// a local folder, a clone, a new project, several repositories (separately or
// as one group), or a folder on an SSH host.
const addProjectOpen = ref(false)
function openAddProject() {
  closeMenus()
  paletteOpen.value = false
  addProjectOpen.value = true
}
function remoteHostLabel(hostId) {
  const target = remoteHostsState.targets.find((x) => x.id === hostId)
  return target ? target.label || target.host : hostId
}
function sameProject(ws, spec) {
  if (spec.remote) return !!(ws.remote && ws.remote.hostId === spec.remote.hostId && ws.remote.path === spec.remote.path)
  return !ws.remote && !!ws.cwd && !!spec.cwd && samePath(ws.cwd, spec.cwd)
}
async function addProjects({ projects, source } = {}) {
  addProjectOpen.value = false
  const list = Array.isArray(projects) ? projects : []
  let firstId = null
  let added = 0
  for (const spec of list) {
    const existing = workspaces.value.find((w) => sameProject(w, spec))
    if (existing) {
      firstId = firstId || existing.id
      if (list.length === 1) showToast(t('project.toast.alreadyAdded', 'Project already added'))
      continue
    }
    const ws = makeWorkspace(String(spec.name || '').slice(0, 80) || nextWorkspaceName())
    if (spec.remote) ws.remote = { hostId: spec.remote.hostId, path: spec.remote.path }
    else ws.cwd = spec.cwd || null
    if (spec.group && Array.isArray(spec.group.repos)) ws.group = { repos: spec.group.repos.map((r) => ({ path: r.path, name: r.name })) }
    workspaces.value.push(ws)
    firstId = firstId || ws.id
    added++
    const leaf = await createLeaf(selectedShell.value, null, ws.cwd, null, wsLeafOpts(ws))
    if (leaf && workspaces.value.includes(ws) && !ws.tree) {
      ws.tree = leaf
      ws.activeId = leaf.id
    } else if (leaf) window.shellApi.killPty(leaf.id)
  }
  if (firstId) selectWorkspace(firstId)
  if (!added) return
  if (source === 'clone') showToast(t('project.toast.cloned', 'Repository cloned'))
  else if (source === 'create') showToast(t('project.toast.created', 'Project created'))
  else if (source === 'remote') showToast(t('project.toast.remoteAdded', 'Project added on SSH host'))
  else if (added > 1) showToast(t('project.toast.imported', '{{count}} projects added', { count: added }))
}
function manageHostsFromAddProject() {
  addProjectOpen.value = false
  manageRemoteHosts()
}

// Run a command (or steps) in a new terminal pane (installs, setup). `shell`
// forces a shell, e.g. PowerShell for commands written in PowerShell syntax.
async function runInPane({ label, command, steps, shell }) {
  closeMenus()
  toolsOpen.value = false
  const shellId = shell && shells.value.some((s) => s.id === shell) ? shell : selectedShell.value
  // Installs run on this computer, also from a remote project.
  const leaf = await openPaneBelow(shellId, null, { local: true })
  if (!leaf) return
  leaf.title = label
  const list = steps || [command]
  const line = installChain(list, null, shellId)
  await startInstallLog(leaf.id, label, shellId, list, null)
  setTimeout(() => window.shellApi.writePty(leaf.id, `${line}\r`), 700)
  showToast(t('app.install.running', '{{label}} is running below. Tessel tells you when it has finished.', { label }), {
    timeout: 7000
  })
}

// Installs are logged (<logs>/installs) and their end told here: success,
// or a failure with its log to open (and attach to a bug report).
const installRuns = {} // paneId -> { label, agent }
async function startInstallLog(paneId, label, shellId, steps, agent) {
  installRuns[paneId] = { label, agent }
  if (!window.shellApi.installLogStart) return
  try {
    await window.shellApi.installLogStart({ paneId, name: label, shell: shellId, steps })
  } catch {
    /* no log this time: the install still runs */
  }
}
function onInstallResult(r) {
  const run = installRuns[r.paneId]
  if (!run) return
  delete installRuns[r.paneId]
  if (run.update) {
    onAgentUpdateResult(run.update, r)
      .catch((err) => logUpdate('error', `${run.label}: ${err && err.message}`))
      .finally(() => startQueuedUpdate())
    // Updated: its pane closes by itself a moment later (the result is in the
    // toast, the notifications and the log). Failed: it stays, with the error.
    if (r.ok === true) {
      const paneId = r.paneId
      setTimeout(() => {
        const leaf = findLeaf(paneId)
        if (leaf && leaf.kind !== 'agent' && !userIsTyping(paneId)) closeLeaf(paneId, { force: true })
      }, 5000)
    }
    return
  }
  loadAgents(true)
  if (r.ok === true) {
    showToast(run.agent ? t('app.install.installedStarting', '{{label}} is installed and starting.', { label: run.label }) : t('app.install.finished', '{{label}} finished.', { label: run.label }), { timeout: 6000 })
    return
  }
  const reason = r.reason ? ` (${r.reason})` : ''
  showToast(
    r.ok === false
      ? t('app.install.failed', '{{label}} failed{{reason}}. The log shows what went wrong; attach it to a bug report.', { label: run.label, reason })
      : t('app.install.unfinished', '{{label}} did not finish{{reason}}. The log shows what went wrong; attach it to a bug report.', { label: run.label, reason }),
    {
    kind: 'error',
    timeout: 30000,
    action: r.file ? { label: t('app.common.openLog', 'Open log'), run: () => window.shellApi.openInstallLog(r.file) } : null
  })
}
const stopInstallResults = window.shellApi.onInstallResult ? window.shellApi.onInstallResult(onInstallResult) : null
onBeforeUnmount(() => stopInstallResults && stopInstallResults())

// Install an agent, then start it in the same pane once the install succeeds.
async function installAgent(agent) {
  if (!agent || !agent.install) return
  closeMenus()
  toolsOpen.value = false
  const shellId = selectedShell.value
  // Install first; start the agent (with its session) only if that succeeds.
  const install = [].concat(agent.install)
  const leaf = await openPaneBelow(shellId, agent, {
    wrap: (startLine) => installChain(install, startLine, shellId)
  })
  if (!leaf) return
  await startInstallLog(leaf.id, agent.name, shellId, install, agent)
  showToast(t('app.install.agent', 'Installing {{agent}}. It starts in the new pane when the install finishes.', { agent: agent.name }), {
    timeout: 7000
  })
}

// --- Sessions -----------------------------------------------------------------
// sessionId -> paneId for conversations already open in a pane.
const openSessionIds = computed(() => {
  const map = {}
  forEachWsLeaf((l) => {
    if (l.sessionId) map[l.sessionId] = l.id
  })
  return map
})

// Reopen a past conversation in a new pane, in the folder it ran in.
async function resumeSession(s) {
  sessionsOpen.value = false
  const agent = agentById(s.agent) || {
    id: s.agent,
    name: s.agent === 'claude' ? 'Claude Code' : 'Codex CLI', // i18n-ignore
    command: s.agent,
    accent: s.agent === 'claude' ? '#d97757' : '#10a37f'
  }
  const ws = currentWs.value
  if (!ws) return
  // A Codex session of a managed account resumes in that account (null: the
  // system's own sign-in).
  const opts = { cwd: s.cwd || null, sessionId: s.id, resume: true, ...(s.accountId === null || typeof s.accountId === 'string' ? { accountId: s.accountId } : {}) }
  if (activeId.value && ws.tree) {
    await splitLeaf(
      activeId.value,
      placement.value === 'down' ? 'col' : 'row',
      agent,
      selectedShell.value,
      null,
      { ...opts, before: placement.value === 'left' }
    )
  } else {
    const leaf = await createLeaf(selectedShell.value, agent, opts.cwd, null, opts)
    if (leaf) {
      ws.tree = leaf
      ws.activeId = leaf.id
    }
  }
}

function openSessions() {
  closeMenus()
  sessionsOpen.value = true
}

function closeSessions() {
  sessionsOpen.value = false
  nextTick(() => {
    focusActiveInput()
  })
}

// --- Voice typing ----------------------------------------------------------------
// Pick a language from a pane's mic menu, remember it, and start dictation.
function voiceTypingIn(paneId, tip) {
  settings.voiceTip = tip || ''
  settings.voiceTipChosen = true
  voiceTyping(paneId)
}
async function voiceTyping(paneId) {
  if (paneId) focusPane(paneId)
  await nextTick()
  focusActiveInput()
  if (!window.shellApi.voiceTyping) {
    showToast(t('app.voice.restart', 'Restart Tessel to enable voice typing, or press Win+H.'), { kind: 'error' })
    return
  }
  const ok = await window.shellApi.voiceTyping({ tip: settings.voiceTip || null })
  if (!ok)
    showToast(t('app.voice.failed', 'Could not start voice typing. Press Win+H to start it yourself.'), { kind: 'error' })
}

function openTools() {
  closeMenus()
  toolsOpen.value = true
}

function closeTools() {
  toolsOpen.value = false
  nextTick(() => {
    focusActiveInput()
  })
}

// Ctrl+Shift+T: the default agent (Settings > Agents) when one is set, is
// installed and not turned off; else the default shell.
function newDefaultTerminal() {
  const a = settings.defaultAgent ? agentById(settings.defaultAgent) : null
  if (a && a.available !== false && agentEnabled(settings.agentPrefs, a.id)) launch({ kind: 'agent', id: a.id })
  else launch({ kind: 'shell', id: selectedShell.value })
}

function openLauncherAt(rect, targetId = null) {
  closeMenus()
  launcher.targetId = targetId || activeId.value
  launcher.x = rect.left
  launcher.y = rect.bottom + 6
  launcher.open = true
  checkWorktree()
  // Pick up agents installed since last time (re-reads PATH).
  loadAgents(true)
}

async function checkWorktree() {
  const ws = (launcher.targetId && wsOfLeaf(launcher.targetId)) || currentWs.value
  worktreeState.available = false
  if (!ws || !ws.cwd) {
    worktreeState.reason = t('app.worktree.needFolder', 'Set a project folder on this workspace to use this')
    return
  }
  if (!window.shellApi.gitInfo) {
    worktreeState.reason = t('app.worktree.restart', 'Restart Tessel to enable this')
    return
  }
  worktreeState.checking = true
  try {
    const info = await window.shellApi.gitInfo(ws.cwd)
    if (!info || !info.isRepo)
      worktreeState.reason = (info && info.error) || t('app.worktree.notRepo', 'The project folder is not a git repository')
    else if (!info.hasCommits) worktreeState.reason = t('app.worktree.noCommits', 'Make a first git commit to use this')
    else {
      worktreeState.available = true
      worktreeState.reason = null
    }
  } catch {
    worktreeState.reason = t('app.worktree.checkFailed', 'Could not check the project')
  } finally {
    worktreeState.checking = false
  }
}

// Other panes in the same workspace, for "send to" / "ask to review".
function otherPanes(paneId) {
  const ws = wsOfLeaf(paneId)
  const out = []
  if (!ws) return out
  forEachLeaf(ws.tree, (l) => {
    // Editor panes take no text from a terminal.
    if (l.id !== paneId && !hasNoTerminal(l)) {
      out.push({
        id: l.id,
        num: l.num || null,
        title: l.title,
        agent: l.kind === 'agent',
        kind: l.kind === 'agent' ? l.agentId : l.shellId,
        accent: l.kind === 'agent' ? l.accent : null,
        where: paneWhere(l.id),
        branch: l.worktree ? l.worktree.branch : null
      })
    }
  })
  return out.sort((a, b) => (a.num || 99) - (b.num || 99))
}

// Where a pane sits in the visible layout, in words ("top left", "right").
function paneWhere(paneId) {
  const layer = document.querySelector('.ws-layer:not(.hidden)')
  const el = layer && layer.querySelector(`.pane[data-pane-id="${paneId}"]`) // i18n-ignore
  if (!layer || !el) return ''
  const L = layer.getBoundingClientRect()
  const r = el.getBoundingClientRect()
  if (r.width >= L.width - 4 && r.height >= L.height - 4) return 'full'
  const fx = (r.left + r.width / 2 - L.left) / L.width
  const fy = (r.top + r.height / 2 - L.top) / L.height
  const v = r.height >= L.height - 4 ? '' : fy < 0.4 ? 'top' : fy > 0.6 ? 'bottom' : 'middle'
  const h = r.width >= L.width - 4 ? '' : fx < 0.4 ? 'left' : fx > 0.6 ? 'right' : 'center'
  return [v, h].filter(Boolean).join(' ')
}

// Short label for a pane, like "#2 Claude Code".
function paneLabel(leaf) {
  return leaf ? `${leaf.num ? `#${leaf.num} ` : ''}${leaf.title}` : ''
}

function reviewPrompt(fromLeaf, ws) {
  const dir = (fromLeaf && fromLeaf.worktree && fromLeaf.worktree.path) || (ws && ws.cwd)
  // Sent to an agent: stays English.
  const who = fromLeaf ? fromLeaf.title : 'another agent' // i18n-ignore
  const where = dir ? ` in ${dir}` : '' // i18n-ignore
  const branch = fromLeaf && fromLeaf.worktree ? ` (branch ${fromLeaf.worktree.branch})` : '' // i18n-ignore
  return (
    `Please review the changes ${who} made${where}${branch}. ` + // i18n-ignore
    'Run git status and git diff there to see them. Point out bugs, risky changes and missing ' + // i18n-ignore
    'tests, with file and line references. Do not modify any files; only report.' // i18n-ignore
  )
}

// Hand text from one pane to another. 'selection' pastes without pressing
// Enter; 'review' pastes a review request and submits it.
function sendToPane(fromId, toId, mode, text = '') {
  const target = getPane(toId)
  if (!target) return
  const ws = wsOfLeaf(fromId)
  const to = findLeaf(toId)
  if (mode === 'review' && to && to.kind === 'agent') {
    // Like every message to an agent: not over a line being typed there, not
    // during an approval, and Enter confirmed (deliver.js).
    const from = findLeaf(fromId)
    deliverToAgent(toId, reviewPrompt(from, ws), { source: 'you', scope: 'review', from: from ? from.title : null })
  } else if (mode === 'review') {
    target.paste(reviewPrompt(findLeaf(fromId), ws))
    setTimeout(() => target.submit(), 150)
  } else {
    target.paste(text)
  }
  if (ws) ws.activeId = toId
  if (to)
    showToast(
      mode === 'review' ? t('app.send.askedReview', 'Asked {{pane}} to review.', { pane: paneLabel(to) }) : t('app.send.sent', 'Sent to {{pane}}.', { pane: paneLabel(to) }),
      {
        timeout: 2500
      }
    )
}

function toggleLauncher(e) {
  openMenu.value = null
  if (launcher.open) {
    launcher.open = false
    return
  }
  openLauncherAt(e.currentTarget.getBoundingClientRect())
}

function openLauncherCentered() {
  openLauncherAt({ left: window.innerWidth / 2 - 170, bottom: 80 })
}

function onLauncherLaunch(item) {
  const target = launcher.targetId
  launcher.open = false
  launch(item, target)
}

const launcherTargetTitle = computed(() => {
  const id = launcher.targetId
  if (!id) return null
  let title = null
  forEachWsLeaf((l) => {
    if (l.id === id) title = l.title
  })
  return title
})

function closeMcp() {
  mcpOpen.value = false
  nextTick(() => {
    focusActiveInput()
  })
}

function openLogs() {
  if (window.shellApi.openLogs) window.shellApi.openLogs()
  else showToast(t('app.logs.restart', 'Restart Tessel to enable logs.'), { kind: 'error' })
}

async function copyDiagnostics() {
  if (!window.shellApi.diagnostics) {
    showToast(t('app.diagnostics.restart', 'Restart Tessel to enable diagnostics.'), { kind: 'error' })
    return
  }
  const text = await window.shellApi.diagnostics()
  window.shellApi.writeClipboard(text)
  showToast(t('app.diagnostics.copied', 'Diagnostics copied. Paste them into your message.'), { timeout: 4000 })
}

// The dialog gives focus back to what had it before (terminal or button).
function closeSettings() {
  settingsOpen.value = false
  settingsSection.value = null
}

function setDefaultShell(id) {
  selectedShell.value = id
  const shell = shells.value.find((s) => s.id === id)
  if (shell) showToast(t('app.shell.default', '{{name}} is now the default shell.', { name: shell.name }))
}

// Replace a pane with a fresh process of the same kind, in the same spot.
const restartingLeaves = new Set()
async function restartLeaf(leafId) {
  let ws = wsOfLeaf(leafId)
  if (!ws) return
  let old = findLeafIn(ws.tree, leafId)
  // An editor pane has no process to restart.
  if (!old || hasNoTerminal(old)) return
  // An agent keeps its pane id: its team messages, lead role, tasks and
  // inbox stay addressed to it.
  if (old.kind === 'agent' && old.agentCommand) {
    if (restartingLeaves.has(leafId)) return // already restarting
    const ok = await restartInPlace(leafId, { resume: settings.resumeAgents })
    // Never a new id for an agent (its messages would stay addressed to the
    // old one): if its old terminal would not stop, say so and leave it.
    if (!ok && findLeaf(leafId) === old)
      showToast(t('app.restart.failed', '{{name}} could not be restarted: its terminal did not stop. Try again.', { name: old.title }), { kind: 'error', timeout: 8000 })
    return
  }
  const agent =
    old.kind === 'agent' && old.agentCommand
      ? { id: old.agentId, name: old.title, command: old.agentCommand, accent: old.accent }
      : null
  const fresh = await createLeaf(old.shellId, agent, old.startDir || ws.cwd, old.worktree, {
    sessionId: old.sessionId,
    accountId: old.accountId,
    sessionOptions: old.sessionOptions,
    resume: settings.resumeAgents,
    ...(old.remoteHostId ? { remoteHostId: old.remoteHostId } : {}),
    ...(old.remoteHostId && old.remotePath ? { remotePath: old.remotePath } : {})
  })
  if (!fresh) return
  // Closed, or moved to another workspace, while it was starting.
  const now = wsOfLeaf(leafId)
  if (!now || findLeaf(leafId) !== old) {
    window.shellApi.killPty(fresh.id)
    return
  }
  ws = now
  fresh.title = old.title
  if (old.titleSet) fresh.titleSet = true
  if (old.autoTitle && fresh.sessionId === old.sessionId) fresh.autoTitle = old.autoTitle
  fresh.broadcast = old.broadcast
  if (old.num) fresh.num = old.num
  if (old.team && teamById(old.team)) {
    fresh.team = old.team
    const team = teamById(old.team)
    if (team.leadId === leafId) team.leadId = fresh.id
  }
  for (const t of boardTasks) if (t.paneId === leafId) updateTask(t.id, { paneId: fresh.id })
  ws.tree = replaceNode(ws.tree, leafId, () => fresh)
  if (ws.activeId === leafId) ws.activeId = fresh.id
  if (maximizedId.value === leafId) maximizedId.value = fresh.id
  window.shellApi.killPty(leafId)
  dropBuffer(leafId)
  clearAgentStatus(leafId)
}

function restartActive() {
  if (activeId.value) restartLeaf(activeId.value)
}

// Bring a pane (in any workspace) to the front and focus it.
function focusPane(paneId) {
  const ws = wsOfLeaf(paneId)
  if (!ws) return
  selectWorkspace(ws.id)
  ws.activeId = paneId
  clearAttention(paneId)
  readForPane(paneId)
  // An editor pane: the keyboard goes to its editor (a terminal pane
  // focuses itself when it becomes active).
  if (getEditorPane(paneId)) nextTick(() => getEditorPane(paneId) && getEditorPane(paneId).focus())
}

// An entry in the notification inbox (toolbar bell), with its sound
// (Settings > Notifications: off with Enable Notifications, at its Volume).
function inboxNote(kind, title, body, paneId) {
  addNotification({ kind, title, body, paneId })
  if (settings.notificationsEnabled !== false) playAlertSound(settings.alertSound, settings.notificationVolume)
}

// A Windows notification (Settings > Notifications): only with Enable
// Notifications and Windows notifications on; while Tessel is in front only
// when Suppress While Focused is off.
function wantsNative() {
  return (
    !!window.shellApi.notify &&
    settings.notificationsEnabled !== false &&
    settings.desktopNotifications !== false &&
    (!document.hasFocus() || settings.notifySuppressWhenFocused === false)
  )
}
function nativeNotify(payload) {
  if (wantsNative()) window.shellApi.notify(payload)
}

// An agent finished a stretch of work while you were elsewhere.
function notifyAgentDone(node) {
  const ws = wsOfLeaf(node.id)
  const inWs = ws && workspaces.value.length > 1
  const message = node.agentLaunchToken
    ? t('app.notify.finishedResponse', '{{name}} finished a response', { name: node.title })
    : t('app.notify.finishedWaiting', '{{name}} finished and is waiting for you', { name: node.title })
  const wsLine = ws ? t('app.notify.workspace', 'Workspace: {{name}}', { name: ws.name }) : ''
  inboxNote('done', message, wsLine, node.id)
  if (document.hasFocus() && settings.inAppAlerts)
    showToast(
      node.agentLaunchToken
        ? inWs
          ? t('app.notify.finishedResponseIn', '{{name}} finished a response in {{ws}}.', { name: node.title, ws: ws.name })
          : t('app.notify.finishedResponseDot', '{{name}} finished a response.', { name: node.title })
        : inWs
          ? t('app.notify.finishedWaitingIn', '{{name}} finished and is waiting for you in {{ws}}.', { name: node.title, ws: ws.name })
          : t('app.notify.finishedWaitingDot', '{{name}} finished and is waiting for you.', { name: node.title }),
      {
        kind: 'attention',
        timeout: 8000,
        action: { label: t('app.common.show', 'Show'), run: () => focusPane(node.id) }
      }
    )
  nativeNotify({
    title: t('app.notify.waiting', '{{name}} is waiting for you', { name: node.title }),
    body: wsLine,
    paneId: node.id
  })
}

// A program rang the terminal bell (BEL) in a pane (Settings > Notifications,
// Terminal Bell, off by default). Nothing when its workspace is on screen and
// Suppress While Focused is on; one per pane every 5 s.
const bellAt = new Map()
function terminalBell(node) {
  if (!node || settings.notificationsEnabled === false || !settings.notifyTerminalBell) return
  const ws = wsOfLeaf(node.id)
  const visible = !!ws && ws.id === currentWsId.value && document.hasFocus()
  if (visible && settings.notifySuppressWhenFocused !== false) return
  const now = Date.now()
  if (now - (bellAt.get(node.id) || 0) < 5000) return
  bellAt.set(node.id, now)
  const title = ws ? t('app.bell.titleIn', 'Bell in {{ws}}', { ws: ws.name }) : t('app.bell.title', 'Bell in workspace')
  const body = t('app.bell.body', '{{name}} · Attention requested', { name: node.title })
  inboxNote('attention', title, body, node.id)
  if (document.hasFocus() && settings.inAppAlerts)
    showToast(t('app.bell.toast', '{{name}}: bell.', { name: node.title }), { kind: 'attention', timeout: 6000, action: { label: t('app.common.show', 'Show'), run: () => focusPane(node.id) } })
  nativeNotify({ title, body, paneId: node.id })
}

// Settings > Notifications, "Send Test Notification": always shown, with the
// alert sound.
function sendTestNotification() {
  if (window.shellApi.notify)
    window.shellApi.notify({ title: t('app.notify.testTitle', 'Tessel notifications are on'), body: t('app.notify.testBody', 'This is a test notification from Tessel.') })
  playAlertSound(settings.alertSound, settings.notificationVolume)
  showToast(window.shellApi.notify ? t('app.notify.testSent', 'Test notification sent') : t('app.notify.unsupported', 'Notifications are not supported on this system'), { timeout: 3000 })
}

// Alt+Arrow: move focus to the nearest pane in that direction.
function moveFocus(dir) {
  const layer = document.querySelector('.ws-layer:not(.hidden)')
  if (!layer || !activeId.value) return
  const panes = [...layer.querySelectorAll('.pane[data-pane-id]')].map((el) => ({
    id: el.dataset.paneId,
    r: el.getBoundingClientRect()
  }))
  const cur = panes.find((p) => p.id === activeId.value)
  if (!cur) return
  const cx = (r) => r.left + r.width / 2
  const cy = (r) => r.top + r.height / 2
  let best = null
  let bestScore = Infinity
  for (const p of panes) {
    if (p.id === cur.id) continue
    const { r } = p
    let ok = false
    let dist = 0
    let off = 0
    if (dir === 'left') {
      ok = r.right <= cur.r.left + 2
      dist = cur.r.left - r.right
      off = Math.abs(cy(r) - cy(cur.r))
    } else if (dir === 'right') {
      ok = r.left >= cur.r.right - 2
      dist = r.left - cur.r.right
      off = Math.abs(cy(r) - cy(cur.r))
    } else if (dir === 'up') {
      ok = r.bottom <= cur.r.top + 2
      dist = cur.r.top - r.bottom
      off = Math.abs(cx(r) - cx(cur.r))
    } else {
      ok = r.top >= cur.r.bottom - 2
      dist = r.top - cur.r.bottom
      off = Math.abs(cx(r) - cx(cur.r))
    }
    if (!ok) continue
    const score = dist * 4 + off
    if (score < bestScore) {
      bestScore = score
      best = p
    }
  }
  if (best) activeId.value = best.id
}

// --- Drag a pane by its header to rearrange -----------------------------------
// Drop on a pane edge to place it on that side, on the middle to swap the two,
// or on a workspace in the sidebar to move it there.
const paneDrag = reactive({
  active: false,
  srcId: null,
  title: '',
  kind: '',
  x: 0,
  y: 0,
  target: null, // { kind: 'pane', id, zone } | { kind: 'ws', id }
  zoneRect: null,
  label: ''
})
const DRAG_THRESHOLD = 6

function findLeaf(id) {
  for (const w of workspaces.value) {
    const found = findLeafIn(w.tree, id)
    if (found) return found
  }
  return null
}

function beginPaneDrag(srcId, e) {
  const leaf = findLeaf(srcId)
  if (!leaf) return
  const startX = e.clientX
  const startY = e.clientY
  const move = (ev) => {
    if (!paneDrag.active) {
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD) return
      paneDrag.active = true
      paneDrag.srcId = srcId
      paneDrag.title = leaf.title
      paneDrag.kind = leaf.kind === 'agent' ? leaf.agentId : hasNoTerminal(leaf) ? '' : leaf.shellId
      maximizedId.value = null
      closeMenus()
      document.body.classList.add('pane-dragging')
    }
    paneDrag.x = ev.clientX
    paneDrag.y = ev.clientY
    updateDropTarget(ev.clientX, ev.clientY)
  }
  const up = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    window.removeEventListener('keydown', esc, true)
    if (paneDrag.active && paneDrag.target) movePane(paneDrag.srcId, paneDrag.target)
    endPaneDrag()
  }
  const esc = (ev) => {
    if (ev.key !== 'Escape') return
    ev.preventDefault()
    ev.stopPropagation()
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    window.removeEventListener('keydown', esc, true)
    endPaneDrag()
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
  window.addEventListener('keydown', esc, true)
}

function endPaneDrag() {
  paneDrag.active = false
  paneDrag.srcId = null
  paneDrag.target = null
  paneDrag.zoneRect = null
  document.body.classList.remove('pane-dragging')
}

function updateDropTarget(x, y) {
  paneDrag.target = null
  paneDrag.zoneRect = null
  const els = document.elementsFromPoint(x, y)
  const wsEl = els.find((el) => el.dataset && el.dataset.wsDropId)
  if (wsEl) {
    const id = wsEl.dataset.wsDropId
    const src = wsOfLeaf(paneDrag.srcId)
    if (id && (!src || src.id !== id)) {
      const ws = wsById(id)
      const r = wsEl.getBoundingClientRect()
      paneDrag.target = { kind: 'ws', id }
      paneDrag.zoneRect = { left: r.left, top: r.top, width: r.width, height: r.height }
      paneDrag.label = ws ? t('app.drag.moveTo', 'Move to {{ws}}', { ws: ws.name }) : t('app.drag.moveToWorkspace', 'Move to workspace')
    }
    return
  }
  const paneEl = els.find(
    (el) => el.classList && el.classList.contains('pane') && el.closest('.ws-layer:not(.hidden)')
  )
  if (!paneEl || paneEl.dataset.paneId === paneDrag.srcId) return
  const r = paneEl.getBoundingClientRect()
  const fx = (x - r.left) / r.width
  const fy = (y - r.top) / r.height
  let zone = 'center'
  if (fx < 0.3 || fx > 0.7 || fy < 0.3 || fy > 0.7) {
    const d = { left: fx, right: 1 - fx, top: fy, bottom: 1 - fy }
    zone = Object.keys(d).reduce((a, b) => (d[a] <= d[b] ? a : b))
  }
  const half = { width: r.width / 2, height: r.height / 2 }
  const rect = {
    left: { left: r.left, top: r.top, width: half.width, height: r.height },
    right: { left: r.left + half.width, top: r.top, width: half.width, height: r.height },
    top: { left: r.left, top: r.top, width: r.width, height: half.height },
    bottom: { left: r.left, top: r.top + half.height, width: r.width, height: half.height },
    center: { left: r.left + 8, top: r.top + 8, width: r.width - 16, height: r.height - 16 }
  }[zone]
  const title = paneEl.querySelector('.pane-title')
  const other = title ? title.textContent.trim() : t('app.drag.thisPane', 'this pane')
  paneDrag.target = { kind: 'pane', id: paneEl.dataset.paneId, zone }
  paneDrag.zoneRect = rect
  paneDrag.label =
    zone === 'center'
      ? t('app.drag.swap', 'Swap with {{pane}}', { pane: other })
      : zone === 'top'
        ? t('app.drag.above', 'Place above {{pane}}', { pane: other })
        : zone === 'bottom'
          ? t('app.drag.below', 'Place below {{pane}}', { pane: other })
          : zone === 'left'
            ? t('app.drag.leftOf', 'Place left of {{pane}}', { pane: other })
            : t('app.drag.rightOf', 'Place right of {{pane}}', { pane: other })
}

function mapLeaves(node, fn) {
  if (!node) return node
  if (node.type === 'leaf') return fn(node)
  return { ...node, children: node.children.map((c) => mapLeaves(c, fn)) }
}

// Take a pane out of its workspace; an emptied workspace gets a fresh shell.
function detachLeaf(ws, leafId) {
  const next = removeLeaf(ws.tree, leafId)
  ws.tree = next
  if (ws.activeId === leafId) ws.activeId = next ? firstLeafId(next) : null
  if (!next) {
    createLeaf(selectedShell.value, null, ws.cwd, null, wsLeafOpts(ws)).then((leaf) => {
      if (leaf && !ws.tree) {
        ws.tree = leaf
        ws.activeId = leaf.id
      }
    })
  }
}

function movePane(srcId, target) {
  const srcWs = wsOfLeaf(srcId)
  const src = findLeaf(srcId)
  if (!srcWs || !src) return

  if (target.kind === 'ws') {
    const dst = wsById(target.id)
    if (!dst || dst === srcWs) return
    detachLeaf(srcWs, srcId)
    const anchor = dst.activeId || firstLeafId(dst.tree)
    dst.tree = !dst.tree
      ? src
      : replaceNode(dst.tree, anchor, (orig) =>
          reactive({
            type: 'split',
            id: newId('split'),
            dir: 'row',
            sizes: [50, 50],
            children: [orig, src]
          })
        )
    selectWorkspace(dst.id)
    dst.activeId = srcId
    refitSoon()
    return
  }

  const dstWs = wsOfLeaf(target.id)
  const dstLeaf = findLeaf(target.id)
  if (!dstWs || !dstLeaf || target.id === srcId) return

  if (target.zone === 'center') {
    if (dstWs === srcWs) {
      srcWs.tree = mapLeaves(srcWs.tree, (l) =>
        l.id === srcId ? dstLeaf : l.id === target.id ? src : l
      )
    } else {
      srcWs.tree = mapLeaves(srcWs.tree, (l) => (l.id === srcId ? dstLeaf : l))
      dstWs.tree = mapLeaves(dstWs.tree, (l) => (l.id === target.id ? src : l))
      if (srcWs.activeId === srcId) srcWs.activeId = target.id
    }
    dstWs.activeId = srcId
    refitSoon()
    return
  }

  detachLeaf(srcWs, srcId)
  const dir = target.zone === 'left' || target.zone === 'right' ? 'row' : 'col'
  const before = target.zone === 'left' || target.zone === 'top'
  dstWs.tree = replaceNode(dstWs.tree, target.id, (orig) =>
    reactive({
      type: 'split',
      id: newId('split'),
      dir,
      sizes: [50, 50],
      children: before ? [src, orig] : [orig, src]
    })
  )
  dstWs.activeId = srcId
  refitSoon()
}

function zoom(delta) {
  fontSize.value =
    delta === 0 ? DEFAULT_FONT_SIZE : Math.min(28, Math.max(8, fontSize.value + delta))
}

// --- Workspace actions -------------------------------------------------------
function makeWorkspace(name) {
  // remote: a project on an SSH host ({ hostId, path }, cwd stays null: no
  // local folder). group: the repositories of a folder imported as a group
  // ({ repos: [{ path, name }] }, cwd is their parent folder).
  return reactive({ id: newId('ws'), name, tree: null, activeId: null, cwd: null, remote: null, group: null })
}

// A new pane in `ws`: on a remote project, a terminal on its host, in its
// folder (remoteProject.js builds the ssh command). A host chosen on purpose
// (Connect on a remote host) is kept as it is.
function wsLeafOpts(ws, opts = {}) {
  if (!ws || !ws.remote || opts.remoteHostId || opts.local) return opts
  return { ...opts, remoteHostId: ws.remote.hostId, remotePath: ws.remote.path }
}

function folderName(path) {
  if (!path) return ''
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || path
}

// Choose the folder new panes in a workspace start in.
async function setWorkspaceFolder(id) {
  const ws = wsById(id)
  if (!ws) return
  // A remote project's folder is on its host (Add a project sets it).
  if (ws.remote) {
    showToast(t('project.remote.unavailable', 'Not available for a remote project yet'))
    return
  }
  if (!window.shellApi.pickFolder) {
    showToast(t('app.folder.restart', 'Restart Tessel to enable project folders.'), { kind: 'error' })
    return
  }
  const picked = await window.shellApi.pickFolder({
    title: t('app.folder.pickTitle', 'Project folder for "{{name}}"', { name: ws.name }),
    defaultPath: ws.cwd || undefined
  })
  if (!picked) return
  ws.cwd = picked
  if (isDefaultWorkspaceName(ws.name)) ws.name = folderName(picked)
  showToast(t('app.folder.set', 'New panes in {{name}} will open in {{folder}}', { name: ws.name, folder: picked }))
}

// "Workspace 3", in the interface's language.
function defaultWorkspaceName(n) {
  return t('app.ws.defaultName', 'Workspace {{n}}', { n })
}
// A name Tessel gave (in English or in the interface's language), not the user.
function isDefaultWorkspaceName(name) {
  if (/^Workspace \d+$/.test(name)) return true // i18n-ignore
  const [pre, post] = defaultWorkspaceName('\u0001').split('\u0001')
  const mid = name.startsWith(pre) && name.endsWith(post) ? name.slice(pre.length, name.length - post.length) : ''
  return /^\d+$/.test(mid)
}
function nextWorkspaceName() {
  const taken = new Set(workspaces.value.map((w) => w.name))
  let n = workspaces.value.length + 1
  while (taken.has(defaultWorkspaceName(n))) n++
  return defaultWorkspaceName(n)
}

function refitSoon() {
  nextTick(() => window.dispatchEvent(new Event('terminal-layout-change')))
}

function selectWorkspace(id) {
  if (id === currentWsId.value) return
  maximizedId.value = null
  closeMenus()
  currentWsId.value = id
  refitSoon()
}

async function createWorkspace() {
  const ws = makeWorkspace(nextWorkspaceName())
  ws.cwd = currentWs.value ? currentWs.value.cwd : null
  ws.remote = currentWs.value && currentWs.value.remote ? { ...currentWs.value.remote } : null
  workspaces.value.push(ws)
  selectWorkspace(ws.id)
  // Put the new workspace's name straight into edit mode.
  nextTick(() => sidebarEl.value && sidebarEl.value.startRename(ws.id))
  const leaf = await createLeaf(selectedShell.value, null, ws.cwd, null, wsLeafOpts(ws))
  if (leaf) {
    ws.tree = leaf
    ws.activeId = leaf.id
  }
}

function renameWorkspace(id, name) {
  const ws = wsById(id)
  if (ws) ws.name = name
}

function removeWorkspace(id, confirmed = false, editorChecked = false) {
  const idx = workspaces.value.findIndex((w) => w.id === id)
  if (idx < 0) return
  const ws = workspaces.value[idx]
  // Its editor panes' unsaved files are asked about first.
  if (!editorChecked) {
    const leaves = []
    forEachLeaf(ws.tree, (l) => leaves.push(l))
    const dirty = dirtyEditorPaths(leaves)
    if (dirty.length) {
      askEditorClose(dirty).then((ok) => ok && removeWorkspace(id, confirmed, true))
      return
    }
  }
  let count = 0
  forEachLeaf(ws.tree, () => count++)
  const wsTasks = boardTasks.filter((t) => t.wsId === id)
  const lost = []
  if (count) lost.push('panes')
  if (wsTasks.length) lost.push('tasks')
  const panesText =
    count === 1 ? t('app.ws.deletePanesOne', 'Its 1 pane will be closed') : t('app.ws.deletePanes', 'Its {{count}} panes will be closed', { count })
  const tasksText =
    wsTasks.length === 1 ? t('app.ws.deleteTasksOne', 'its 1 task deleted') : t('app.ws.deleteTasks', 'its {{count}} tasks deleted', { count: wsTasks.length })
  const what =
    count && wsTasks.length
      ? t('app.ws.deleteBoth', '{{panes}} and {{tasks}}.', { panes: panesText, tasks: tasksText })
      : count
        ? `${panesText}.`
        : wsTasks.length === 1
          ? t('app.ws.deleteOnlyTasksOne', 'Its 1 task deleted.')
          : t('app.ws.deleteOnlyTasks', 'Its {{count}} tasks deleted.', { count: wsTasks.length })
  // Settings > General, "Ask Before Deleting Workspaces" (unsaved files are
  // still asked about above).
  if (lost.length && !confirmed && settings.confirmDeleteWorkspace !== false) {
    askConfirm({
      title: t('app.ws.deleteTitle', 'Delete "{{name}}"?', { name: ws.name }),
      text: what,
      confirmLabel: t('app.common.delete', 'Delete'),
      danger: true
    }).then((ok) => ok && removeWorkspace(id, true, true))
    return
  }
  for (const t of wsTasks) removeTask(t.id)
  forEachLeaf(ws.tree, (leaf) => {
    if (hasNoTerminal(leaf)) {
      if (leaf.kind === 'editor') releaseOwner(leaf.id)
      return
    }
    window.shellApi.killPty(leaf.id)
    dropBuffer(leaf.id)
    clearAgentStatus(leaf.id)
  })
  workspaces.value.splice(idx, 1)
  if (!workspaces.value.length) {
    currentWsId.value = null
    createWorkspace()
    return
  }
  if (currentWsId.value === id) {
    const next = workspaces.value[Math.min(idx, workspaces.value.length - 1)]
    currentWsId.value = null
    selectWorkspace(next.id)
  }
}

function cycleWorkspace(step) {
  const list = workspaces.value
  if (list.length < 2) return
  const i = list.findIndex((w) => w.id === currentWsId.value)
  selectWorkspace(list[(i + step + list.length) % list.length].id)
}

// Live resize: the terminal area shrinks/grows with the sidebar, so ask panes
// to refit (same event a divider drag sends).
function resizeSidebar(w) {
  sidebarWidth.value = w
  window.dispatchEvent(new Event('terminal-layout-change'))
}

function toggleSidebar() {
  sidebarCollapsed.value = !sidebarCollapsed.value
  refitSoon()
}

// Every pane gets a small number within its workspace (#1, #2, ...), kept for
// the pane's lifetime and saved, like tmux pane numbers or VS Code's "1: pwsh".
// New panes take the smallest free number.
function numberPanes() {
  for (const ws of workspaces.value) {
    const used = new Set()
    const need = []
    forEachLeaf(ws.tree, (l) => {
      if (Number.isInteger(l.num) && l.num > 0 && !used.has(l.num)) used.add(l.num)
      else need.push(l)
    })
    let n = 1
    for (const l of need) {
      while (used.has(n)) n++
      l.num = n
      used.add(n)
    }
  }
}
watch(
  () =>
    workspaces.value
      .map((w) => {
        const ids = []
        forEachLeaf(w.tree, (l) => ids.push(`${l.id}:${l.num || 0}`))
        return ids.join(',')
      })
      .join('|'),
  numberPanes,
  { immediate: true }
)

// The sidebar's projects (Orca's logic, see sidebarModel.js): each workspace
// with its folder's git branch, its task copies and every pane (agent or
// terminal) with its live state.
const wsBranches = reactive({}) // ws.cwd -> git branch ('' when not a repo)
async function refreshBranches() {
  if (!window.shellApi.gitInfo) return
  const cwds = [...new Set(workspaces.value.map((w) => w.cwd).filter(Boolean))]
  for (const cwd of cwds) {
    try {
      const info = await window.shellApi.gitInfo(cwd)
      const branch = info && info.isRepo && info.branch && info.branch !== 'HEAD' ? info.branch : ''
      if (wsBranches[cwd] !== branch) wsBranches[cwd] = branch
    } catch {
      // next time
    }
  }
}
watch(() => workspaces.value.map((w) => w.cwd || '').join('|'), refreshBranches, { immediate: true })
function onWindowFocusBranches() {
  refreshBranches()
}
window.addEventListener('focus', onWindowFocusBranches)
onBeforeUnmount(() => window.removeEventListener('focus', onWindowFocusBranches))

// When you were last in each pane (Orca's "Recent" order).
const paneActivityAt = reactive({})
watch(
  () => activeId.value,
  (id) => {
    if (id) paneActivityAt[id] = Date.now()
  },
  { immediate: true }
)

const sidebarProjects = computed(() =>
  workspaces.value.map((w) => {
    const panes = []
    forEachLeaf(w.tree, (leaf) => {
      if (hasNoTerminal(leaf)) return
      const task = taskOfPane(leaf.id)
      const tracked = trackedState[leaf.id]
      panes.push({
        id: leaf.id,
        num: leaf.num || 0,
        kind: leaf.kind || 'shell',
        title: leaf.title || leaf.shellName || t('app.pane.terminal', 'Terminal'),
        agentId: leaf.agentId || null,
        shellId: leaf.shellId || null,
        accent: leaf.accent || null,
        state: paneState(leaf),
        sleeping: !!leaf.sleeping,
        attention: !!attention[leaf.id],
        reset: limits[leaf.id] ? limits[leaf.id].reset : '',
        held: !!pendingMessages[leaf.id],
        typingHold: !!pendingMessages[leaf.id] && !!userDraft[leaf.id],
        teamUnread: teamUnread[leaf.id] || 0,
        toolsDown: !!toolsDown[leaf.id],
        team: leaf.team || null,
        lead: !!(leaf.team && teamById(leaf.team)?.leadId === leaf.id),
        // A worker of a coordinator (orchestration): linked to it.
        workerOf: workerOfRow(leaf),
        task: leaf.kind === 'agent' ? task?.title || null : null,
        track: leaf.kind === 'agent' ? trackOf(leaf.id) : null,
        pid: Number.isInteger(leaf.pid) ? leaf.pid : null,
        copyPath: leaf.worktree && leaf.worktree.path ? leaf.worktree.path : null,
        copyBranch: leaf.worktree ? leaf.worktree.branch || '' : '',
        since: tracked && tracked.since ? tracked.since : 0,
        activityAt: paneActivityAt[leaf.id] || 0,
        isActive: leaf.id === w.activeId,
        focused: w.id === currentWsId.value && leaf.id === activeId.value,
        sessionId: leaf.sessionId || null,
        ...(leaf.accountId !== undefined ? { accountId: leaf.accountId } : {})
      })
    })
    const copies = boardTasks
      .filter((t) => t.wsId === w.id && t.worktree && t.worktree.path && !t.mergedAt)
      .map((t) => ({ path: t.worktree.path, branch: t.worktree.branch || '', title: t.title, taskId: t.id }))
    return {
      id: w.id,
      name: w.name,
      cwd: w.cwd || null,
      branch: (w.cwd && wsBranches[w.cwd]) || '',
      panes,
      copies,
      ...(w.remote ? { remote: { host: remoteHostLabel(w.remote.hostId), path: w.remote.path } } : {}),
      ...(w.group ? { repoCount: w.group.repos.length } : {})
    }
  })
)

// Live ports of each workspace (Orca's scanner: every 30 s while visible).
const portScanner = createPortScanner({ getProbes: () => portProbes(sidebarProjects.value) })
const probeSignature = computed(() =>
  portProbes(sidebarProjects.value)
    .map((p) => `${p.id}:${p.pids.join(',')}`)
    .join('|')
)
onMounted(() => portScanner.start(() => probeSignature.value))
// Tessel's shortcuts pressed while a browser page has the keyboard: the page
// would keep them, the main process sends them here (browserGuest.js).
let offBrowserKeys = null
onMounted(() => {
  const api = window.shellApi.browser
  if (!api || !api.onShortcut) return
  offBrowserKeys = api.onShortcut((e) => {
    if (!e || e.action !== 'app' || typeof e.key !== 'string') return
    onKey({ key: e.key, ctrlKey: !!e.ctrl, shiftKey: !!e.shift, altKey: false, metaKey: false, target: document.body, preventDefault() {}, stopPropagation() {} })
  })
})
onBeforeUnmount(() => offBrowserKeys && offBrowserKeys())
onBeforeUnmount(() => portScanner.stop())

function cardByKey(key) {
  for (const p of sidebarProjects.value) {
    const card = buildProjectCards(p).find((c) => c.key === key)
    if (card) return card
  }
  return null
}

// A port's Open: its page in Tessel's browser (the system browser when no
// project is open).
function openPort(port) {
  const url = browserUrlForPort(port)
  if (currentWs.value) openInBrowser({ url })
  else openExternalUrl(url)
}
// The active ports for a browser pane's Ports menu: the current project's
// first, then the others', then the rest of this computer's.
function browserPorts() {
  const out = []
  const seen = new Set()
  const push = (port, label) => {
    const url = browserUrlForPort(port)
    if (seen.has(url)) return
    seen.add(url)
    out.push({ id: port.id || url, url, port: port.port, processName: port.processName || '', label })
  }
  const cur = currentWsId.value
  const projects = [...sidebarProjects.value].sort((a, b) => (b.id === cur) - (a.id === cur))
  for (const p of projects) {
    for (const card of buildProjectCards(p)) for (const port of portScanner.state.byCard[card.key] || []) push(port, `${p.name} / ${card.title}`)
  }
  for (const port of portScanner.state.external || []) push(port, '')
  return out
}
function copyPort(port) {
  const address = addressForPort(port)
  if (window.shellApi.writeClipboard) window.shellApi.writeClipboard(address)
  showToast(t('app.toast.copiedValue', 'Copied {{value}}', { value: address }))
}
async function stopPort(port) {
  const res = await portScanner.kill(port)
  if (res && res.ok) showToast(res.alreadyExited ? t('app.port.alreadyExited', 'The process on {{port}} had already exited', { port: port.port }) : t('app.port.stopped', 'Stopped process on {{port}}', { port: port.port }))
  else showToast((res && res.reason) || t('app.port.stopFailed', 'Failed to stop the process.'), { kind: 'error' })
}

// A workspace card with no pane (a task copy whose agent was closed, or the
// project folder): a terminal opens there.
async function openCard({ wsId, path, isMain }) {
  const ws = wsById(wsId)
  if (!ws) return
  selectWorkspace(ws.id)
  const task = !isMain ? boardTasks.find((t) => t.wsId === ws.id && t.worktree && t.worktree.path === path) : null
  const worktree = task ? { path: task.worktree.path, branch: task.worktree.branch } : null
  if (!ws.tree) {
    const leaf = await createLeaf(selectedShell.value, null, isMain ? ws.cwd : path, worktree, isMain ? wsLeafOpts(ws) : {})
    if (leaf && wsById(wsId)) {
      ws.tree = leaf
      ws.activeId = leaf.id
    }
    return
  }
  await splitLeaf(ws.activeId || largestLeaf(ws.tree).id, 'row', null, selectedShell.value, worktree, isMain ? {} : { cwd: path })
}
function activateCardByKey(key) {
  const card = cardByKey(key)
  if (!card) return
  const target = cardTargetPane(card)
  if (target) focusPane(target)
  else openCard({ wsId: card.projectId, path: card.path, isMain: card.isMain })
}

function markPanesRead(ids) {
  for (const id of ids || []) {
    clearAttention(id)
    readForPane(id)
  }
}
function markPaneUnread(id) {
  if (findLeaf(id)) setAttention(id)
}
// "Sleep" from the sidebar: agents whose conversation can be resumed stop
// their terminal now (opening the pane resumes them); the pane you are in
// stays awake.
function sleepPanes(ids) {
  const skipped = []
  let slept = 0
  for (const id of ids || []) {
    const leaf = findLeaf(id)
    if (!leaf || leaf.kind !== 'agent' || leaf.sleeping || restartingLeaves.has(id)) continue
    const ws = wsOfLeaf(id)
    if (ws && ws.id === currentWsId.value && id === activeId.value) {
      skipped.push(t('app.sleep.activePane', '{{pane}} (the pane you are in)', { pane: paneLabel(leaf) }))
      continue
    }
    if (!sessionKind({ id: leaf.agentId }) || !safeSessionId(leaf.sessionId)) {
      skipped.push(t('app.sleep.notResumable', '{{pane}} (its conversation cannot be resumed)', { pane: paneLabel(leaf) }))
      continue
    }
    putToSleep(leaf)
    slept++
  }
  if (skipped.length) showToast(t('app.sleep.staysAwake', 'Stays awake: {{list}}.', { list: skipped.join(', ') }), { timeout: 7000 })
  else if (slept)
    showToast(
      slept === 1
        ? t('app.sleep.asleepOne', '1 agent asleep. Open a pane to wake it.')
        : t('app.sleep.asleep', '{{count}} agents asleep. Open a pane to wake it.', { count: slept })
    )
}
function copyText(text) {
  if (!text) return
  if (window.shellApi.writeClipboard) window.shellApi.writeClipboard(text)
  showToast(t('app.toast.copiedValue', 'Copied {{value}}', { value: text }))
}
function revealFolder(path) {
  if (!path || !window.shellApi.explorer || !window.shellApi.explorer.reveal) return
  window.shellApi.explorer
    .reveal({ root: path, path })
    .then((res) => {
      if (res && res.ok === false) showToast(t('app.file.openFailedWhy', 'Could not open {{file}}: {{error}}', { file: path, error: res.error || t('app.common.notFound', 'not found') }), { kind: 'error' })
    })
    .catch(() => {})
}

// Every open agent's state, for the activity log and the Activity view.
// One subscription supplies the whole app. A slow initial snapshot must not
// overwrite an update already received while IPC was awaiting the response.
let agentStateRevision = 0
const offAgentState = window.shellApi.onAgentState?.((states) => {
  agentStateRevision++
  applyAgentStates(states)
})
if (window.shellApi.agentStates) {
  const revision = agentStateRevision
  window.shellApi.agentStates().then((states) => {
    if (revision === agentStateRevision) applyAgentStates(states)
  }).catch(() => {})
}
onBeforeUnmount(() => offAgentState?.())
const agentStates = computed(() => {
  const out = {}
  for (const ws of workspaces.value) {
    forEachLeaf(ws.tree, (leaf) => {
      if (leaf.kind !== 'agent') return
      addAgentState(out, leaf, ws.id)
    })
  }
  return out
})
function addAgentState(out, leaf, wsId) {
  const observed = leaf.agentLaunchToken ? getAgentState(leaf.id, leaf.agentLaunchToken) : null
  let state = observed?.state || (leaf.agentLaunchToken ? 'unknown' : 'idle')
  if (leaf.sleeping) state = 'sleeping'
  else if (approvals[leaf.id]) state = 'approval'
  else if (limits[leaf.id]) state = 'limited'
  else if (agentStatus[leaf.id] === 'busy') state = 'working'
  out[leaf.id] = {
    state,
    ...(observed ? { source: observed.source, confirmed: observed.confirmed, since: observed.since } : {}),
    title: leaf.title || t('app.pane.agent', 'Agent'),
    agentId: leaf.agentId || null,
    reset: limits[leaf.id] ? limits[leaf.id].reset : '',
    wsId,
    teamId: leaf.team || null
  }
}

// --- Agent tracking -----------------------------------------------------------
// For each agent: its state and since when (trackedState), its task, and
// whether it looks stuck (src/shared/tracking.js). A clock ticks every 20 s;
// time the computer slept is not counted as observed time.
const trackedState = reactive({}) // leafId -> { state, since, sinceStart }
const appStartedAt = Date.now()

// After a restart or reload, a pane found in the state the saved log last
// recorded for it takes that state's real start back (an approval waiting
// 9 min before the reload still shows 9 min), also when the state is only
// detected a little after startup (an approval prompt shows once its
// terminal redraws). Each logged state keeps its real start in its event
// (`since`), so this holds across any number of reloads. When it cannot be
// restored, a time that began before startup shows as a minimum ("+").
const RESTORE_WINDOW_MS = 60000
let activityLoaded = false
const lastStateEvent = {} // leafId -> the logged event of its current state

function savedStateBefore(id) {
  let last = null
  for (const e of activity) {
    if (e.type === 'agent.state' && e.paneId === id && e.t < appStartedAt && (!last || e.t > last.t)) last = e
  }
  return last
}

// The saved start is taken back once per pane at most, and never after the
// pane has been seen working in this session: from then on its states are
// new episodes, timed from when they are seen.
const restoreDone = {} // leafId -> true

function restoreSince(id) {
  const t = trackedState[id]
  if (!t || !activityLoaded || restoreDone[id]) return
  const prev = savedStateBefore(id)
  if (prev && prev.state === t.state) {
    restoreDone[id] = true
    t.since = prev.since || prev.t
    t.sinceStart = false
    if (lastStateEvent[id]) {
      lastStateEvent[id].since = t.since
      activityChanged()
    }
  }
}

function hydrateTracking() {
  activityLoaded = true
  for (const id of Object.keys(trackedState)) restoreSince(id)
}
const clock = ref(Date.now())
let lastTick = Date.now()
const clockTimer = setInterval(() => {
  const now = Date.now()
  const slept = now - lastTick - 20000
  if (slept > 60000) {
    for (const [id, t] of Object.entries(trackedState)) {
      t.since += slept
      if (lastStateEvent[id]) lastStateEvent[id].since = t.since
    }
    activityChanged()
    // The time on a task does not grow while asleep either.
    for (const t of boardTasks) if (t.column === 'doing' && t.doingSince) t.doingSince += slept
  }
  lastTick = now
  clock.value = now
}, 20000)
onBeforeUnmount(() => clearInterval(clockTimer))

function trackOf(leafId) {
  const tracked = trackedState[leafId]
  if (!tracked) return null
  const info = agentStates.value[leafId]
  // Waiting for its running sub-agents is not being quiet.
  const state = childrenRunning[leafId] && (tracked.state === 'idle' || tracked.state === 'unknown') ? 'working' : tracked.state
  return trackAgent(
    {
      state,
      since: tracked.since,
      sinceStart: tracked.sinceStart,
      reset: info ? info.reset : '',
      // Its last turn completed normally (hooks saw it answer, not an error
      // or an interruption): idle then means it waits for you.
      answered: !!(info && info.state === 'idle' && info.reason === 'ready' && info.turnCompletedAt)
    },
    taskOfPane(leafId),
    clock.value,
    t
  )
}

// One notice per episode when an agent needs you (level 'alert'); a new
// episode starts once it has recovered.
const alertedAgents = new Set()
const agentAlerts = computed(() => {
  const out = []
  forEachWsLeaf((leaf) => {
    if (leaf.kind !== 'agent') return
    const t = trackOf(leaf.id)
    if (t && t.level === 'alert')
      out.push({ id: leaf.id, key: `${leaf.id}:${t.kind}:${t.taskId}`, title: paneLabel(leaf), reason: t.reason })
  })
  return out
})
watch(agentAlerts, (list) => {
  const now = new Set(list.map((a) => a.key))
  for (const key of [...alertedAgents]) if (!now.has(key)) alertedAgents.delete(key)
  for (const a of list) {
    if (alertedAgents.has(a.key)) continue
    alertedAgents.add(a.key)
    inboxNote('alert', t('app.notify.needsYou', '{{name}} needs you', { name: a.title }), a.reason, a.id)
    showToast(t('app.notify.reason', '{{name}}: {{reason}}', { name: a.title, reason: a.reason }), { kind: 'attention', timeout: 12000, action: { label: t('app.common.show', 'Show'), run: () => focusPane(a.id) } })
  }
})

// Log state changes. A burst of work shorter than 3 s (typing echoes, a
// redraw) is not logged, so the log shows real stretches of work.
const loggedState = {}
const workingTimers = {}
function logState(id, info, state) {
  if (loggedState[id] === state) return
  loggedState[id] = state
  // The tracking clock follows logged states only, so a short burst (a
  // pasted message echoing, a redraw) does not restart it.
  // Seen working: whatever it does next is observed from the start.
  if (state === 'working' || info?.confirmed) restoreDone[id] = true
  const early = Date.now() - appStartedAt < RESTORE_WINDOW_MS && !restoreDone[id]
  if (state === 'closed') {
    delete trackedState[id]
    delete lastStateEvent[id]
  } else trackedState[id] = {
    state,
    since: info?.confirmed && Number.isFinite(info.since) ? info.since : Date.now(),
    sinceStart: early && !info?.confirmed
  }
  recordActivity({
    type: 'agent.state',
    paneId: id,
    agent: info ? { title: info.title, agentId: info.agentId } : null,
    state,
    reset: info && state === 'limited' ? info.reset : undefined,
    wsId: info ? info.wsId : null,
    teamId: info ? info.teamId : null,
    since: state === 'closed' ? undefined : trackedState[id].since
  })
  if (state !== 'closed') {
    lastStateEvent[id] = activity[activity.length - 1]
    if (early) restoreSince(id)
  }
}
watch(
  agentStates,
  (now, before = {}) => {
    for (const [id, info] of Object.entries(now)) {
      if (before[id] && before[id].state === info.state) continue
      clearTimeout(workingTimers[id])
      if (info.state === 'working' && loggedState[id] !== 'working' && !(info.confirmed && info.source === 'hook')) {
        workingTimers[id] = setTimeout(() => {
          if (agentStates.value[id]?.state === 'working') logState(id, agentStates.value[id], 'working')
        }, 3000)
      } else {
        logState(id, info, info.state)
      }
    }
    for (const id of Object.keys(before)) {
      if (!now[id]) {
        clearTimeout(workingTimers[id])
        logState(id, before[id], 'closed')
        delete loggedState[id]
      }
    }
  },
  { immediate: true }
)

// Automatic titles (Settings > Agents): Claude Code and Codex panes are named
// after their conversation. Looked for every 20 s until found, then every
// 5 min (a /rename changes it).
const titleCheckedAt = new Map()
async function refreshAutoTitles() {
  if (!settings.autoTitles || !window.shellApi.sessionTitle || document.visibilityState !== 'visible') return
  const now = Date.now()
  const due = []
  forEachWsLeaf((l) => {
    if (l.kind !== 'agent' || l.titleSet || !l.sessionId || !['claude', 'codex'].includes(l.agentId)) return
    const wait = l.autoTitle ? 5 * 60 * 1000 : 0
    if (now - (titleCheckedAt.get(l.id) || 0) >= wait) due.push(l)
  })
  for (const l of due) {
    titleCheckedAt.set(l.id, now)
    try {
      const t = await window.shellApi.sessionTitle({
        agent: l.agentId,
        sessionId: l.sessionId,
        ...(l.accountId !== undefined ? { accountId: l.accountId } : {})
      })
      if (typeof t === 'string' && t && t !== l.autoTitle) l.autoTitle = t.slice(0, 80)
    } catch {
      /* next time */
    }
  }
}
const autoTitleTimer = setInterval(refreshAutoTitles, 20 * 1000)
onBeforeUnmount(() => clearInterval(autoTitleTimer))

// Keep the computer awake (Settings > Agents): always, or while an agent works.
const wantAwake = computed(
  () =>
    settings.keepAwake === 'on' ||
    (settings.keepAwake === 'agents' && Object.values(agentStates.value).some((a) => a.state === 'working'))
)
watch(
  wantAwake,
  (on) => {
    if (window.shellApi.keepAwake) window.shellApi.keepAwake(on).catch(() => {})
  },
  { immediate: true }
)

// --- Activity view -------------------------------------------------------------
const activityOpen = ref(false)
const activityScope = ref('workspace') // 'workspace' | 'team:<id>' | 'all'

// What the Activity view can show: this workspace, one of its teams, or all.
// A scope's panes include agents closed since (found through the log).
const activityScopes = computed(() => {
  const ws = currentWs.value
  const out = []
  if (ws) {
    out.push({ value: 'workspace', label: t('app.notify.workspace', 'Workspace: {{name}}', { name: ws.name }), wsId: ws.id, teamId: null, notesDir: ws.cwd || null })
  }
  for (const team of teams.value) {
    const home = wsById(teamWsId(team.id)) || ws
    out.push({ value: 'team:' + team.id, label: t('app.activity.team', 'Team: {{name}}', { name: team.name }), wsId: null, teamId: team.id, notesDir: (home && home.cwd) || null })
  }
  out.push({ value: 'all', label: t('app.activity.all', 'All workspaces'), wsId: null, teamId: null, notesDir: (ws && ws.cwd) || null })
  return out
})

function openActivity(scope = 'workspace') {
  closeMenus()
  activityScope.value = scope
  activityOpen.value = true
}

// --- Messages to agents ------------------------------------------------------------
// An agent showing an approval prompt: typing into it could answer it, so a
// message waits until the prompt is gone.
function awaitingApproval(leafId) {
  const pane = getPane(leafId)
  return !!(pane && pane.screenText && detectApproval(pane.screenText(20)))
}

// Messages waiting for an agent to be free: leafId -> [text].
const pendingMessages = reactive({})
// Panes a message is being pasted into and confirmed right now.
const delivering = new Set()

// Ask the user what happened to an unconfirmed message, then go on.
async function resolveUnsent(id) {
  const u = unsent[id]
  if (!u) return
  focusPane(id)
  const leaf = findLeaf(id)
  const who = leaf ? leaf.title : t('app.unsent.theAgent', 'the agent')
  const answer = await askConfirm({
    title: t('app.unsent.title', 'Did {{who}} get the message?', { who }),
    text: t('app.unsent.text', 'Tessel pasted a message and pressed Enter, but {{who}} did not visibly take it: "{{message}}". Look at its input box. If the message is still there, press Enter in the terminal yourself, then choose "It was sent". If it is gone and was not received, choose "Send again".', { who, message: `${u.item.text.slice(0, 160)}${u.item.text.length > 160 ? '…' : ''}` }),
    confirmLabel: t('app.unsent.wasSent', 'It was sent'),
    altLabel: t('app.unsent.sendAgain', 'Send again')
  })
  if (!unsent[id] || unsent[id] !== u) return
  const meta = u.item.meta || {}
  if (answer === true) {
    // Recorded first; the pane stays held if that fails.
    const ok = meta.confirmSent ? await meta.confirmSent() : true
    if (!ok) {
      showToast(t('app.unsent.recordFailed', 'Tessel could not record that. Try again.'), { kind: 'error' })
      return
    }
    if (unsent[id] === u) delete unsent[id]
    if (u.item.held) logMessage(id, 'delivered', u.item.text, meta)
    if (!meta.confirmSent && meta.onDelivered) meta.onDelivered()
  } else if (answer === 'alt') {
    // A channel message is released on disk and delivered again by the
    // channel; anything else is queued again here.
    const handled = meta.onRetry ? await meta.onRetry() : false
    if (handled === null) {
      showToast(t('app.unsent.recordFailed', 'Tessel could not record that. Try again.'), { kind: 'error' })
      return
    }
    if (unsent[id] === u) delete unsent[id]
    if (!handled) requeueDelivery(id, u.item)
  } else return
  flushPending()
}
let pendingTimer = null

// meta: { source: 'you' | 'tessel', scope: 'team' | 'workspace' | 'notes' |
// 'team-change', teamId } for the activity log.
function deliverToAgent(leafId, text, meta = {}) {
  const item = { text, meta, held: false }
  if (!pendingMessages[leafId]) pendingMessages[leafId] = []
  pendingMessages[leafId].push(item)
  flushPending()
  const queued = !!pendingMessages[leafId]?.includes(item)
  item.held = queued
  logMessage(leafId, queued ? 'held' : 'sent', text, meta)
}

// A pane joined (teamId) or left (null) a team.
function logMembership(leaf, teamId) {
  if (!leaf || leaf.kind !== 'agent') return
  recordActivity({
    type: 'agent.team',
    paneId: leaf.id,
    agent: agentInfo(leaf),
    teamId: teamId || null,
    wsId: wsOfLeaf(leaf.id)?.id || null
  })
}

// The workspace a team works in (its first member's).
function teamWsId(teamId) {
  const m = teamMembers(teamId)[0]
  return (m && wsOfLeaf(m.id)?.id) || currentWsId.value || null
}

function agentInfo(leaf) {
  return leaf ? { title: leaf.title || t('app.pane.agent', 'Agent'), agentId: leaf.agentId || null } : null
}

function logMessage(leafId, status, text, meta = {}) {
  const leaf = findLeaf(leafId)
  recordActivity({
    type: 'message',
    paneId: leafId,
    agent: agentInfo(leaf),
    status,
    source: meta.source || 'you',
    from: meta.from || null,
    scope: meta.scope || 'workspace',
    teamId: meta.teamId || null,
    wsId: wsOfLeaf(leafId)?.id || null,
    preview: String(text || '')
      .replace(/\s+/g, ' ')
      .slice(0, 160),
    text: String(text || '').slice(0, 8000)
  })
}

// Paste each queued message and press Enter, except into panes that are
// asking for approval: those are tried again every 2 seconds.
function flushPending() {
  let waiting = false
  for (const id of Object.keys(pendingMessages)) {
    const pane = getPane(id)
    if (!pane || !findLeaf(id)) {
      for (const item of pendingMessages[id]) failDelivery(item)
      delete pendingMessages[id]
      continue
    }
    if (awaitingApproval(id)) {
      waiting = true
      continue
    }
    // A task for an agent that is still starting: wait until its first
    // screen is up and it is quiet.
    const first = pendingMessages[id][0]
    const m = first && first.meta
    if (m && (m.notBefore || m.waitIdle)) {
      if ((m.notBefore && Date.now() < m.notBefore) || agentStatus[id] === 'busy') {
        waiting = true
        continue
      }
    }
    // One message per pane at a time: it is pasted, Enter is pressed, and
    // Tessel watches the agent take it (src/renderer/src/deliver.js) before
    // the next one goes.
    // The user is typing there: wait until the line is sent or cleared.
    if (delivering.has(id) || unsent[id] || userIsTyping(id)) {
      waiting = true
      continue
    }
    const item = pendingMessages[id].shift()
    if (pendingMessages[id].length) waiting = true
    else delete pendingMessages[id]
    delivering.add(id)
    const deps = {
      getPane: (pid) => (findLeaf(pid) ? getPane(pid) : null),
      isBusy: (pid) => agentStatus[pid] === 'busy',
      awaitingApproval,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      waitIdle: !!(item.meta && item.meta.waitIdle),
      userTyping: userIsTyping,
      guard: item.meta && item.meta.guard ? item.meta.guard : null
    }
    // A channel message is marked in flight on disk first; if that is
    // refused, it is not typed now ('refused').
    Promise.resolve(item.meta && item.meta.beforePaste ? item.meta.beforePaste() : true)
      .catch(() => false)
      .then((ok) => (ok ? pasteAndConfirm(id, item.text, deps) : 'refused'))
      .catch(() => 'unconfirmed')
      .then((result) => {
        delivering.delete(id)
        if (result === 'confirmed') {
          if (item.held) logMessage(id, 'delivered', item.text, item.meta)
          if (item.meta && item.meta.onDelivered) item.meta.onDelivered()
        } else if (result === 'requeue') {
          // Not typed now (the user came back, or it is no longer needed). A
          // message that would be stale later is dropped instead of waiting.
          if (item.meta && item.meta.dropIfNotNow) {
            if (item.meta.onDropped) item.meta.onDropped()
          } else requeueDelivery(id, item)
        } else if (result === 'refused') {
          if (item.meta && item.meta.onRefused) item.meta.onRefused()
        } else if (result === 'unconfirmed') {
          // Pasted, but the agent did not visibly take it: not acknowledged,
          // not pasted again blindly, and nothing else goes to this pane (it
          // would land on the draft) until the user says what happened.
          logMessage(id, 'unconfirmed', item.text, item.meta)
          unsent[id] = { item, at: Date.now() }
          if (item.meta && item.meta.onUncertain) item.meta.onUncertain()
          const leaf = findLeaf(id)
          showToast(leaf ? t('app.unsent.toast', 'A message to {{name}} may not have been sent. Check its input box.', { name: leaf.title }) : t('app.unsent.toastAgent', 'A message to an agent may not have been sent. Check its input box.'), {
            kind: 'attention',
            timeout: 15000,
            action: { label: t('app.unsent.check', 'Check'), run: () => resolveUnsent(id) }
          })
        } else {
          failDelivery(item)
        }
        if (result !== 'requeue') flushPending()
      })
  }
  clearTimeout(pendingTimer)
  pendingTimer = waiting ? setTimeout(flushPending, 2000) : null
}

function failDelivery(item) {
  if (item.meta && item.meta.onFailed) item.meta.onFailed()
}

function requeueDelivery(id, item) {
  if (!pendingMessages[id]) pendingMessages[id] = []
  pendingMessages[id].unshift(item)
  clearTimeout(pendingTimer)
  pendingTimer = setTimeout(flushPending, 2000)
}

// --- Tasks ------------------------------------------------------------------------
// A task is a card of the workspace's board: title, instructions, the agent
// pane doing it (paneId), and its own copy of the project when it has one
// (worktree: { path, branch, baseBranch, root }). Columns: todo, doing,
// review, done.
const newTaskOpen = ref(false)

async function openNewTask() {
  closeMenus()
  if (!currentWs.value) return
  await checkWorktree()
  newTaskOpen.value = true
}

// Agent kinds that can be started, for the dialog.
const taskAgentKinds = computed(() =>
  launchableAgents.value
    .filter((a) => a.available !== false)
    .map((a) => ({ id: a.id, name: a.name, accent: a.accent || null }))
)

// Agents already open in this workspace, for the dialog.
const taskOpenAgents = computed(() =>
  (currentWs.value ? wsAgents(currentWs.value.id) : []).map((l) => ({
    id: l.id,
    num: l.num || 0,
    title: l.title || t('app.pane.agent', 'Agent'),
    agentId: l.agentId || null,
    accent: l.accent || null,
    state: paneState(l),
    reset: limits[l.id] ? limits[l.id].reset : '',
    task: taskOfPane(l.id)?.title || null
  }))
)

// Why an open agent cannot take a new task now, or '' if it can (English:
// it goes to a team lead; busyReasonText says it to the person).
function busyReason(leaf) {
  const task = taskOfPane(leaf.id)
  if (task) return `already on "${task.title}"` // i18n-ignore
  if (limits[leaf.id]) return 'at its usage limit' // i18n-ignore
  if (approvals[leaf.id]) return 'waiting for your approval' // i18n-ignore
  if (agentStatus[leaf.id] === 'busy') return 'working on something else' // i18n-ignore
  return ''
}
function busyReasonText(leaf) {
  if (!leaf) return t('app.task.busy.gone', 'gone')
  const task = taskOfPane(leaf.id)
  if (task) return t('app.task.busy.onTask', 'already on "{{title}}"', { title: task.title })
  if (limits[leaf.id]) return t('app.task.busy.limit', 'at its usage limit')
  if (approvals[leaf.id]) return t('app.task.busy.approval', 'waiting for your approval')
  if (agentStatus[leaf.id] === 'busy') return t('app.task.busy.working', 'working on something else')
  return ''
}

// The task a pane is working on or waiting to have reviewed.
function taskOfPane(paneId) {
  if (!paneId) return null
  return boardTasks.find((t) => t.paneId === paneId && (t.column === 'doing' || t.column === 'review')) || null
}

function taskPrompt(task, ws) {
  const wt = task.worktree
  // Sent to the agent: stays English.
  const where = wt
    ? `You work in your own copy of the project: ${wt.path} (git branch ${wt.branch}, made from ${wt.baseBranch || 'the main branch'}). ` + // i18n-ignore
      'Commit your work on that branch (git add the files you changed, then git commit). Do not merge it and do not push: the user reviews and merges it. ' + // i18n-ignore
      'In your last commit message, list the checks you ran (tests, build) and their results. ' + // i18n-ignore
      'If the project needs its dependencies installed, install them in this copy (for example npm ci); never link them to another folder.' // i18n-ignore
    : `You work directly in the project folder ${(ws && ws.cwd) || ''}. Other agents may work there too: check .tessel/notes.md before editing shared files.` // i18n-ignore
  const lead = task.teamId ? teamLead(task.teamId) : null
  const tm = task.teamId ? teamById(task.teamId) : null
  const box = tm && task.paneId && channelBoxes[tm.id] ? channelBoxes[tm.id][task.paneId] : null
  const team = tm
    ? `You are in team "${tm.name}"` + // i18n-ignore
      (lead ? `, led by ${paneLabel(lead)}: it gave you this task and reviews your work when you finish. Ask it if something is unclear.` : '.') + // i18n-ignore
      (box ? `\n${box.guide}` : '') +
      '\n\n'
    : ''
  return (
    `[Tessel task] ${task.title}\n\n` + // i18n-ignore
    (task.brief ? `${task.brief}\n\n` : '') +
    team +
    `${where}\n\n` +
    'When the task is complete and checked, end your last message with a line that contains only the words TASK and COMPLETE joined by an underscore, and nothing else on that line.' // i18n-ignore
  )
}

// opts (for a team lead): { ws, roomy: open the agent by splitting the
// workspace's largest pane (not the active one),
// teamId: the team the task belongs to (a new agent joins it) }.
// -> { task, leaf } or { error }.
async function startTask(spec, opts = {}) {
  newTaskOpen.value = false
  const ws = opts.ws || currentWs.value
  if (!ws || !spec || !spec.title) return { error: 'no workspace' }
  if (opts.expectedCwd && (!workspaces.value.includes(ws) || ws.cwd !== opts.expectedCwd)) return { error: t('app.task.folderChanged', 'The workspace folder changed. No agent was started.') }
  const task = addTask({ title: spec.title, wsId: ws.id })
  updateTask(task.id, {
    brief: spec.brief || '',
    column: 'doing',
    reviewerId: spec.reviewerId || null,
    startedAt: Date.now(),
    doingSince: Date.now(),
    teamId: opts.teamId || null
  })

  let leaf = null
  let fresh = false
  if (spec.agent.kind === 'pane') {
    leaf = findLeaf(spec.agent.id)
    const why = leaf ? busyReason(leaf) : 'gone'
    if (why) {
      removeTask(task.id)
      showToast(t('app.task.cannotTake', '{{name}} cannot take this task: {{why}}.', { name: leaf ? leaf.title : t('app.task.thatAgent', 'That agent'), why: busyReasonText(leaf) }), { kind: 'error', timeout: 7000 })
      return { error: `${leaf ? paneLabel(leaf) : 'that agent'} cannot take it: ${why}` } // i18n-ignore
    }
  } else {
    const agent = agentById(spec.agent.id)
    if (!agent) {
      removeTask(task.id)
      showToast(t('app.task.agentUnavailable', 'That agent is not available.'), { kind: 'error' })
      return { error: 'that agent kind is not available' }
    }
    let worktree = null
    if (spec.isolated) {
      const res = await window.shellApi.createWorktree(ws.cwd, spec.title, { ...(spec.worktreeOptions || {}), ...worktreeSettings() })
      // The copy exists even when its setup script failed: said, never undone.
      if (res && res.ok && res.setup && res.setup.ran && !res.setup.ok)
        showToast(t('app.task.setupFailed', 'The copy is ready, but .tessel/setup.ps1 failed: {{error}}.', { error: res.setup.error || t('app.task.seeScript', 'see the script') }), { kind: 'error', timeout: 9000 })
      if (res && res.ok && res.copyEnvResult && res.copyEnvResult.error)
        showToast(t('app.task.envFailed', 'The copy is ready, but its .env files were not all copied: {{error}}.', { error: res.copyEnvResult.error }), { kind: 'error', timeout: 9000 })
      if (!res || !res.ok) {
        updateTask(task.id, { column: 'todo' })
        showToast(t('app.task.copyFailed', 'Could not make a separate copy: {{error}}. The task stays in To do.', { error: (res && res.error) || t('app.common.unknownError', 'unknown error') }), {
          kind: 'error',
          timeout: 9000
        })
        return { error: `could not make a separate copy: ${(res && res.error) || 'unknown error'}` } // i18n-ignore
      }
      worktree = { path: res.path, branch: res.branch, baseBranch: res.baseBranch || null, root: res.root || ws.cwd }
      updateTask(task.id, { worktree })
    }
    if (opts.expectedCwd && (!workspaces.value.includes(ws) || ws.cwd !== opts.expectedCwd)) {
      updateTask(task.id, { column: 'todo' })
      return { error: t('app.task.folderChangedKept', 'The workspace folder changed. The task and any prepared copy were kept in To do; no agent was started.') }
    }
    const target =
      opts.roomy && ws.tree ? largestLeaf(ws.tree).id : ws.activeId && findLeaf(ws.activeId) ? ws.activeId : null
    leaf = target
      ? await splitLeaf(target, opts.roomy ? largestLeaf(ws.tree).dir : 'row', agent, selectedShell.value, worktree)
      : await createLeaf(selectedShell.value, agent, ws.cwd, worktree, wsLeafOpts(ws))
    if (leaf && !target) {
      ws.tree = leaf
      ws.activeId = leaf.id
    }
    fresh = true
  }
  if (!leaf) {
    updateTask(task.id, { column: 'todo' })
    showToast(t('app.task.startFailed', 'Could not start the agent. The task stays in To do.'), { kind: 'error' })
    return { error: 'could not start the agent' }
  }
  // A new agent started by a lead joins its team (told in the task itself).
  if (fresh && opts.teamId && teamById(opts.teamId)) {
    const before = teamMembers(opts.teamId)
    leaf.team = opts.teamId
    logMembership(leaf, opts.teamId)
    await syncChannel(teamById(opts.teamId), { quiet: [leaf.id] })
    tellAgents(before, `[Tessel] Team "${teamById(opts.teamId).name}": ${paneLabel(leaf)} joined the team.`, opts.teamId) // i18n-ignore
  }
  updateTask(task.id, { paneId: leaf.id })
  const started = boardTasks.find((x) => x.id === task.id)
  recordActivity({
    type: 'task',
    action: 'started',
    taskId: task.id,
    title: task.title,
    paneId: leaf.id,
    agent: agentInfo(leaf),
    wsId: ws.id,
    branch: started.worktree ? started.worktree.branch : null
  })
  deliverToAgent(leaf.id, taskPrompt(started, ws), {
    source: 'tessel',
    scope: 'task',
    // A new agent needs a moment to start (and may ask to trust the folder).
    notBefore: fresh ? Date.now() + 6000 : 0
  })
  if (!taskPanelOpen.value) showSideTab('tasks')
  showToast(
    started.worktree
      ? t('app.task.startedOnBranch', '{{name}} started "{{title}}" on branch {{branch}}.', { name: leaf.title, title: task.title, branch: started.worktree.branch })
      : t('app.task.started', '{{name}} started "{{title}}".', { name: leaf.title, title: task.title }),
    { timeout: 5000 }
  )
  return { task: started, leaf }
}

// An agent printed the task signal: its card goes to Review.
function agentReportedDone(paneId) {
  const task = boardTasks.find((t) => t.paneId === paneId && t.column === 'doing')
  if (!task) return
  const leaf = findLeaf(paneId)
  updateTask(task.id, { column: 'review', doneAt: Date.now() })
  const lead = leaf && leaf.team ? teamLead(leaf.team) : null
  recordActivity({
    type: 'task',
    action: 'review',
    taskId: task.id,
    title: task.title,
    paneId,
    agent: agentInfo(leaf),
    wsId: task.wsId,
    detail: lead && lead.id !== paneId ? t('app.task.leadReviewsDetail', '{{lead}} (lead) reviews it first', { lead: lead.title }) : ''
  })
  if (lead && lead.id !== paneId) {
    updateTask(task.id, { leadReview: 'pending', teamId: task.teamId || leaf.team })
    noticeAgents([lead], leadReviewPrompt(task, leaf), leaf.team, { source: 'tessel', scope: 'lead', teamId: leaf.team })
    showToast(t('app.task.finishedLead', '{{name}} finished "{{title}}". {{lead}} (lead) reviews it first.', { name: leaf.title, title: task.title, lead: lead.title }), { timeout: 6000 })
    return
  }
  showToast(t('app.task.finished', '{{name}} finished "{{title}}". It is ready for your review.', { name: leaf ? leaf.title : t('app.task.anAgent', 'An agent'), title: task.title }), {
    kind: 'attention',
    timeout: 10000,
    action: task.worktree
      ? { label: t('app.task.review', 'Review'), run: () => openReview(task.id) }
      : { label: t('app.common.show', 'Show'), run: () => focusPane(paneId) }
  })
  // Optional second opinion from another agent.
  const reviewer = task.reviewerId && findLeaf(task.reviewerId)
  if (reviewer) {
    deliverToAgent(reviewer.id, reviewPrompt(leaf, wsOfLeaf(paneId)), {
      source: 'tessel',
      scope: 'task',
      waitIdle: true
    })
  }
}

// --- Review and merge ------------------------------------------------------------
// A task in Review opens ReviewPanel: its branch's files, commits and diff,
// then Merge, Request changes or Discard.
const reviewTaskId = ref(null)
const reviewTask = computed(() => (reviewTaskId.value && boardTasks.find((t) => t.id === reviewTaskId.value)) || null)
const reviewAgentLabel = computed(() => {
  const leaf = reviewTask.value && findLeaf(reviewTask.value.paneId)
  return leaf ? paneLabel(leaf) : ''
})

function openReview(taskId) {
  closeMenus()
  if (boardTasks.some((t) => t.id === taskId)) reviewTaskId.value = taskId
}

function taskEvent(task, action, detail = '', by = null) {
  const leaf = findLeaf(task.paneId)
  recordActivity({
    type: 'task',
    action,
    taskId: task.id,
    title: task.title,
    paneId: task.paneId || null,
    agent: leaf ? agentInfo(leaf) : { title: t('app.unsent.theAgent', 'the agent') },
    wsId: task.wsId,
    branch: task.worktree ? task.worktree.branch : null,
    detail,
    by
  })
}

// Back to the agent, with the task: the card returns to Doing until it
// signals again.
function sendBackToAgent(task, text, action, detail, by = null) {
  const leaf = findLeaf(task.paneId)
  if (!leaf) {
    showToast(t('app.task.agentClosed', 'The agent of this task was closed. Start a new task instead.'), { kind: 'error' })
    return false
  }
  const wt = task.worktree
  deliverToAgent(
    leaf.id,
    `[Tessel review] ${task.title}\n\n${text}\n\n` + // i18n-ignore
      (wt ? `Work in ${wt.path} on branch ${wt.branch}, commit the changes there (say which checks you ran in the commit message), and do not merge. ` : '') + // i18n-ignore
      'When it is done and checked, end your last message with a line that contains only the words TASK and COMPLETE joined by an underscore.', // i18n-ignore
    by ? { source: 'lead', scope: 'task', from: by } : { source: 'you', scope: 'task' }
  )
  // Back in Doing: a new period starts.
  updateTask(task.id, { column: 'doing', leadReview: null, doingSince: Date.now() })
  taskEvent(task, action, detail, by)
  reviewTaskId.value = null
  showToast(t('app.task.sentBack', 'Sent to {{name}}. "{{title}}" is back in Doing.', { name: leaf.title, title: task.title }), { timeout: 5000 })
  return true
}

// Close the task's agent and delete its copy (after a merge, or to discard).
async function removeTaskCopy(task, force) {
  const wt = task.worktree
  if (!wt) return { ok: true }
  if (task.paneId && findLeaf(task.paneId)) {
    closeLeaf(task.paneId, { force: true })
    // Let its terminal release the folder.
    await new Promise((r) => setTimeout(r, 800))
  }
  return window.shellApi.review.remove({ root: wt.root, path: wt.path, branch: wt.branch, target: wt.baseBranch || 'main', force })
}

// ✕ on a card: asked first. A task working in its own copy of the project
// also has that copy and branch deleted (with its agent closed), so nothing
// is left behind with no way to merge it; the dialog says what is lost.
async function deleteTask(taskId) {
  const task = boardTasks.find((t) => t.id === taskId)
  if (!task) return
  const wt = task.worktree && !task.mergedAt ? task.worktree : null
  const leaf = task.paneId ? findLeaf(task.paneId) : null
  const ok = await askConfirm({
    title: t('app.task.deleteTitle', 'Delete "{{title}}"?', { title: task.title }),
    text: wt
      ? leaf
        ? t('app.task.deleteCopyAgent', '{{name}} closes, and its copy ({{path}}) and branch {{branch}} are deleted with any work not merged yet. To keep the work, open Review and merge it first. This cannot be undone.', { name: leaf.title, path: wt.path, branch: wt.branch })
        : t('app.task.deleteCopy', 'its copy ({{path}}) and branch {{branch}} are deleted with any work not merged yet. To keep the work, open Review and merge it first. This cannot be undone.', { path: wt.path, branch: wt.branch })
      : t('app.task.deleteCard', 'The card is removed from the board.'),
    confirmLabel: t('app.common.delete', 'Delete'),
    danger: !!wt
  })
  if (!ok) return
  if (wt) {
    const rm = await removeTaskCopy(task, true)
    if (!rm || !rm.ok) {
      showToast(t('app.task.cardKept', 'The card was kept: its copy could not be deleted ({{error}}).', { error: (rm && rm.error) || t('app.common.unknownError', 'unknown error') }), { kind: 'error', timeout: 9000 })
      return
    }
  }
  removeTask(task.id)
}
provide('deleteTask', deleteTask)

// Several cards at once (Done > Select): one question for all; the copies
// with work not merged are named in it and deleted like with ✕. A card whose
// copy cannot be deleted is kept.
async function deleteTasks(taskIds) {
  const list = (taskIds || []).map((id) => boardTasks.find((t) => t.id === id)).filter(Boolean)
  if (!list.length) return false
  const withCopy = list.filter((t) => t.worktree && !t.mergedAt)
  const ok = await askConfirm({
    title: list.length === 1 ? t('app.task.deleteManyTitleOne', 'Delete 1 task?') : t('app.task.deleteManyTitle', 'Delete {{count}} tasks?', { count: list.length }),
    text: withCopy.length
      ? withCopy.length === 1
        ? t('app.task.deleteManyCopyOne', '1 of them still has its own copy of the project ({{branches}}): it is deleted with any work not merged yet. This cannot be undone.', { branches: withCopy.map((task) => task.worktree.branch).join(', ') })
        : t('app.task.deleteManyCopy', '{{count}} of them still have their own copy of the project ({{branches}}): they are deleted with any work not merged yet. This cannot be undone.', { count: withCopy.length, branches: withCopy.map((task) => task.worktree.branch).join(', ') })
      : t('app.task.deleteCards', 'The cards are removed from the board.'),
    confirmLabel: t('app.common.delete', 'Delete'),
    danger: withCopy.length > 0
  })
  if (!ok) return false
  const kept = []
  for (const task of list) {
    if (task.worktree && !task.mergedAt) {
      const rm = await removeTaskCopy(task, true)
      if (!rm || !rm.ok) {
        kept.push(task.title)
        continue
      }
    }
    removeTask(task.id)
  }
  if (kept.length) {
    showToast(t('app.task.keptMany', 'Kept {{count}}: their copy could not be deleted ({{titles}}).', { count: kept.length, titles: kept.join(', ') }), { kind: 'error', timeout: 9000 })
  } else {
    showToast(list.length === 1 ? t('app.task.deletedOne', 'Deleted 1 task.') : t('app.task.deleted', 'Deleted {{count}} tasks.', { count: list.length }), { timeout: 4000 })
  }
  return true
}
provide('deleteTasks', deleteTasks)

const reviewActions = {
  createPr() {
    const task = reviewTask.value
    if (!task?.worktree) return
    reviewTaskId.value = null
    openGitHub(task)
  },
  requestChanges(text) {
    const task = reviewTask.value
    if (task) sendBackToAgent(task, `Changes requested by the user:\n${text}`, 'changes', // i18n-ignore
       text.length > 80 ? text.slice(0, 80) + '…' : text)
  },
  resolveConflicts(info) {
    const task = reviewTask.value
    if (!task || !info) return
    sendBackToAgent(
      task,
      `Your branch ${info.branch} conflicts with ${info.target} in: ${info.conflicts.join(', ')}. ` + // i18n-ignore
        `Merge ${info.target} into your branch (git merge ${info.target}), resolve the conflicts keeping both intents, run the checks again, and commit.`, // i18n-ignore
      'resolve',
      info.conflicts.join(', ')
    )
  },
  async merge(info, { cleanup } = {}) {
    const task = reviewTask.value
    if (!task || !info || !info.ok) return false
    const leaf = findLeaf(task.paneId)
    const ok = await askConfirm({
      title: t('app.merge.title', 'Merge "{{title}}" into {{target}}?', { title: task.title, target: info.target }),
      text:
        t('app.merge.text', '{{commits}} and {{files}} from {{branch}} go into {{target}} in {{repo}}.', {
          commits: info.commits.length === 1 ? t('app.merge.commitOne', '1 commit') : t('app.merge.commits', '{{count}} commits', { count: info.commits.length }),
          files: info.files.length === 1 ? t('app.merge.fileOne', '1 file') : t('app.merge.files', '{{count}} files', { count: info.files.length }),
          branch: info.branch,
          target: info.target,
          repo: info.repo
        }) +
        (cleanup
          ? ' ' +
            (leaf
              ? t('app.merge.cleanupAgent', 'Then {{name}} closes and its copy and branch are deleted.', { name: leaf.title })
              : t('app.merge.cleanup', 'Then its copy and branch are deleted.'))
          : ''),
      confirmLabel: t('app.merge.confirm', 'Merge')
    })
    if (!ok) return false
    const res = await window.shellApi.review.merge({
      root: task.worktree.root,
      path: task.worktree.path,
      branch: task.worktree.branch,
      target: info.target,
      title: task.title,
      expectHead: info.head
    })
    if (!res || !res.ok) {
      showToast(t('app.merge.failed', 'Not merged: {{error}}', { error: (res && res.error) || t('app.common.unknownError', 'unknown error') }), { kind: 'error', timeout: 9000 })
      return false
    }
    updateTask(task.id, { column: 'done', mergedAt: Date.now(), mergeSha: res.sha })
    taskEvent(task, 'merged', res.commits === 1 ? t('app.merge.detailOne', '1 commit into {{target}}', { target: info.target }) : t('app.merge.detail', '{{count}} commits into {{target}}', { count: res.commits, target: info.target }))
    reviewTaskId.value = null
    let note = ''
    if (cleanup) {
      const rm = await removeTaskCopy(task, false)
      if (rm && rm.ok) updateTask(task.id, { paneId: null })
      else note = ' ' + t('app.merge.copyKept', 'Its copy was kept: {{error}}.', { error: (rm && rm.error) || t('app.merge.couldNotRemove', 'could not remove it') })
    }
    showToast(t('app.merge.done', 'Merged "{{title}}" into {{target}}.', { title: task.title, target: info.target }) + note, { kind: note ? 'error' : undefined, timeout: note ? 9000 : 5000 })
    return true
  },
  async discard(info) {
    const task = reviewTask.value
    if (!task || !task.worktree) return false
    const leaf = findLeaf(task.paneId)
    const n = info && info.ok ? info.commits.length : 0
    const ok = await askConfirm({
      title: t('app.discard.title', 'Discard "{{title}}"?', { title: task.title }),
      text: t('app.discard.text', '{{who}}its copy ({{path}}) and branch {{branch}} are deleted{{commits}}. This cannot be undone.', {
        who: leaf ? t('app.discard.closes', '{{name}} closes, and ', { name: leaf.title }) : '',
        path: task.worktree.path,
        branch: task.worktree.branch,
        commits: n ? (n === 1 ? t('app.discard.commitOne', ', with its 1 unmerged commit') : t('app.discard.commits', ', with its {{count}} unmerged commits', { count: n })) : ''
      }),
      confirmLabel: t('app.discard.confirm', 'Discard'),
      danger: true
    })
    if (!ok) return false
    const rm = await removeTaskCopy(task, true)
    if (!rm || !rm.ok) {
      showToast(t('app.discard.failed', 'Could not delete the copy: {{error}}', { error: (rm && rm.error) || t('app.common.unknownError', 'unknown error') }), { kind: 'error', timeout: 9000 })
      return false
    }
    taskEvent(task, 'discarded', task.worktree.branch)
    reviewTaskId.value = null
    removeTask(task.id)
    showToast(t('app.discard.done', 'Discarded "{{title}}".', { title: task.title }), { timeout: 5000 })
    return true
  },
  markDone() {
    const task = reviewTask.value
    if (!task) return
    updateTask(task.id, { column: 'done' })
    taskEvent(task, 'done')
    reviewTaskId.value = null
  },
  focusAgent() {
    const task = reviewTask.value
    reviewTaskId.value = null
    if (task && task.paneId) focusPane(task.paneId)
  },
  // A task done in the project folder: its changes are the project's, shown
  // in the Changes tab (list, diffs, review notes) like Orca's review.
  openChanges() {
    const task = reviewTask.value
    reviewTaskId.value = null
    if (task && task.wsId && workspaces.value.some((w) => w.id === task.wsId)) selectWorkspace(task.wsId)
    showSideTab('changes')
  }
}

// Review notes from Source Control / a diff tab (Orca's "Send notes to"):
// the agents of the current workspace, and delivery through their message
// queue: never typed while the agent works or waits for an approval,
// confirmed when it takes the message; the notes are then cleared.
function noteTargetState(state) {
  if (state === 'ready') return t('app.notes.state.ready', 'Ready')
  if (state === 'working') return t('app.notes.state.working', 'Working: sent when it is free')
  if (state === 'waiting') return t('app.notes.state.waiting', 'Waiting for you')
  if (state === 'limited') return t('app.notes.state.limited', 'At its usage limit')
  if (state === 'unknown') return t('app.notes.state.starting', 'Starting')
  return ''
}
setNotesDelivery({
  targets() {
    return (currentWs.value ? wsAgents(currentWs.value.id) : []).map((l) => {
      const state = paneState(l)
      const task = taskOfPane(l.id)
      return {
        id: l.id,
        label: `#${l.num || '?'} ${l.title || t('app.pane.agent', 'Agent')}`,
        stateLabel: noteTargetState(state),
        disabledReason: state === 'approval' ? t('app.notes.needsPermission', 'Agent needs permission') : '',
        hint: task ? t('app.notes.workingOn', 'Working on "{{title}}"', { title: task.title }) : ''
      }
    })
  },
  send(paneId, text, { onDelivered } = {}) {
    const leaf = findLeaf(paneId)
    if (!leaf || !text) {
      showToast(t('app.notes.terminalGone', 'Terminal is no longer available'), { kind: 'error' })
      return
    }
    showToast(t('app.notes.sending', 'Sending notes...'), { timeout: 3000 })
    deliverToAgent(leaf.id, text, {
      source: 'you',
      scope: 'notes',
      waitIdle: true,
      onDelivered: () => {
        // A task waiting for review goes back to Doing: its agent works again.
        const task = taskOfPane(leaf.id)
        if (task && task.column === 'review') updateTask(task.id, { column: 'doing', leadReview: null, doingSince: Date.now() })
        showToast(t('app.notes.sent', 'Notes sent.'), { timeout: 3000 })
        if (onDelivered) onDelivered()
      },
      onFailed: () => showToast(t('app.notes.failed', 'The notes could not be sent to {{name}}.', { name: leaf.title }), { kind: 'error' })
    })
  }
})

// The agents (not plain shells) of a workspace.
function wsAgents(wsId) {
  const ws = wsById(wsId)
  const out = []
  if (ws) forEachLeaf(ws.tree, (l) => l.kind === 'agent' && out.push(l))
  return out
}

function agentLabel(l) {
  return `#${l.num || '?'} ${l.title}${l.agentId ? ` (${l.agentId})` : ''}`
}

// --- Team lead -------------------------------------------------------------------
// A team may have one lead: an agent that splits the work, gives tasks to its
// teammates (or starts new agents), and reviews what they finish before the
// user merges it. It acts through JSON files in its own inbox folder
// (src/main/leadInbox.js, src/shared/leadRequests.js); it cannot merge,
// discard or close anything.
const LEAD_MAX_ACTIVE = 6

function teamLead(teamId) {
  const team = teamById(teamId)
  const leaf = team && team.leadId ? findLeaf(team.leadId) : null
  return leaf && leaf.team === teamId ? leaf : null
}

function teamDir(teamId) {
  const m = teamMembers(teamId)[0]
  const ws = m && wsOfLeaf(m.id)
  return (ws && ws.cwd) || null
}

function inboxPathFor(dir, token) {
  const sep = dir.includes('\\') ? '\\' : '/'
  return [dir.replace(/[\\/]+$/, ''), '.tessel', 'team', token].join(sep)
}

function randomToken() {
  return Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('')
}

// Make leafId the lead of its team, or (leafId null) leave the team without one.
// Lead changes of a team run one after the other: two quick changes would
// both see the same "old" lead, and the first new lead would never be told
// it no longer leads.
const leadChanges = {} // teamId -> the change running now
function setTeamLead(teamId, leafId) {
  closeMenus()
  const run = (leadChanges[teamId] || Promise.resolve()).then(() => changeTeamLead(teamId, leafId))
  leadChanges[teamId] = run.catch(() => {})
  return run
}

async function changeTeamLead(teamId, leafId) {
  const team = teamById(teamId)
  if (!team) return
  const old = teamLead(teamId)
  const dir = teamDir(teamId)
  const leaf = leafId ? findLeaf(leafId) : null
  if (leaf && old && old.id === leaf.id) return
  if (leaf && (leaf.kind !== 'agent' || leaf.team !== teamId)) return
  if (leaf && !dir) {
    showToast(t('app.lead.needFolder', 'Set a project folder on this workspace first: the lead works from it.'), { kind: 'error' })
    return
  }
  // The new lead's inbox first: if it cannot be made, nothing changes.
  let box = null
  if (leaf) {
    box = await assignLeadInbox(team, leaf)
    // It left the team (or the team is gone) meanwhile: not the lead.
    if (box && (!teamById(teamId) || !findLeaf(leaf.id) || findLeaf(leaf.id).team !== teamId)) {
      dropInbox(team, leaf.id, dir)
      return
    }
    if (!box) {
      // Not the lead after all: the poll tells it about the channel instead.
      if (team.channelTold) delete team.channelTold[leaf.id]
      showToast(t('app.lead.inboxFailed', "Could not make {{name}}'s inbox, so it is not the lead. Check that the project folder can be written to.", { name: leaf.title }), {
        kind: 'error',
        timeout: 8000
      })
      return
    }
  }
  team.leadId = leaf ? leaf.id : null
  // Still in the team after the wait: its inbox stays, for messages only.
  if (old && findLeaf(old.id) && findLeaf(old.id).team === teamId) {
    await assignInbox(team, old)
    tellAgents([old], `[Tessel] You no longer lead the team "${team.name}". Your inbox now takes messages only.`, teamId) // i18n-ignore
  }
  if (!leaf) {
    handOffLeadReviews(teamId)
    if (old) {
      recordActivity({ type: 'team', action: 'lead-removed', teamId, wsId: teamWsId(teamId), name: team.name, detail: old.title })
      tellAgents(teamMembers(teamId).filter((l) => l.id !== old.id), `[Tessel] Team "${team.name}": ${paneLabel(old)} no longer leads the team.`, teamId) // i18n-ignore
    }
    return
  }
  recordActivity({ type: 'team', action: 'lead', teamId, wsId: teamWsId(teamId), name: team.name, detail: leaf.title })
  tellAgents([leaf], `[Tessel] ${box.guide}`, teamId)
  tellAgents(
    teamMembers(teamId).filter((l) => l.id !== leaf.id),
    `[Tessel] Team "${team.name}": ${paneLabel(leaf)} now leads the team. It may give you tasks; when you finish one, it reviews your work first.`, // i18n-ignore
    teamId
  )
  showToast(t('app.lead.nowLeads', '{{name}} now leads {{team}}.', { name: leaf.title, team: team.name }), { timeout: 4000 })
  handOffLeadReviews(teamId, leaf)
}

// Every team member has its own inbox folder (.tessel/team/<random>/): an
// agent writes a JSON file there to message a teammate, the team or its lead,
// and Tessel delivers it into their terminal. The lead also gives tasks and
// reviews through it. -> { path, guide }, or null when there is no project
// folder or the folder could not be made (then nobody is told about it).
async function assignInbox(team, leaf, guideFn = null) {
  const dir = teamDir(team.id)
  if (!dir || !window.shellApi.lead) return null
  const token = reserveInbox(team, leaf)
  const path = inboxPathFor(dir, token)
  const lead = teamLead(team.id)
  const guide = guideFn
    ? guideFn(path)
    : memberGuide({
        teamName: team.name,
        inbox: path,
        me: paneLabel(leaf),
        members: teamMembers(team.id).filter((l) => l.id !== leaf.id).map(agentLabel),
        lead: lead && lead.id !== leaf.id ? paneLabel(lead) : null
      })
  let res = null
  inboxesBeingMade.add(token)
  try {
    res = await window.shellApi.lead.ensure({ dir, token, guide })
  } catch (err) {
    res = { ok: false, error: err.message }
  } finally {
    inboxesBeingMade.delete(token)
  }
  if (!res || !res.ok) {
    // Forget the token (even one reserved earlier): the poll makes it again.
    if (team.inboxes && team.inboxes[leaf.id] === token) delete team.inboxes[leaf.id]
    return null
  }
  return { path, guide }
}

// The lead's inbox, with the lead's guide (tasks, reviews, messages).
async function assignLeadInbox(team, leaf) {
  const mates = teamMembers(team.id).filter((l) => l.id !== leaf.id)
  const boxes = await syncChannel(team, { quiet: [leaf.id] })
  const outbox = boxes && boxes[leaf.id] ? boxes[leaf.id].outbox : null
  return assignInbox(team, leaf, (inbox) =>
    leadGuide({
      teamName: team.name,
      inbox,
      outbox,
      members: mates.map(agentLabel),
      kinds: taskAgentKinds.value.map((a) => a.id)
    })
  )
}

// The lead lost its inbox (folder deleted, or it could not be made): made
// again by the poll, at most every 30 s, and the lead told the new path.
const leadInboxRetry = {} // teamId -> time of the next try
async function restoreLeadInbox(team, leaf) {
  if (Date.now() < (leadInboxRetry[team.id] || 0)) return
  leadInboxRetry[team.id] = Date.now() + 30000
  const box = await assignLeadInbox(team, leaf)
  if (!box || team.leadId !== leaf.id) return
  delete leadInboxRetry[team.id]
  tellAgents([leaf], `[Tessel] Your lead inbox was made again. ${box.guide}`, team.id) // i18n-ignore
}

// Inbox folders being made right now: the poll leaves them alone.
const inboxesBeingMade = new Set()

// The inbox token of a member, made at once (no folder yet), so two callers
// never make two.
function reserveInbox(team, leaf) {
  if (!team.inboxes) team.inboxes = {}
  if (!team.inboxes[leaf.id]) team.inboxes[leaf.id] = randomToken()
  return team.inboxes[leaf.id]
}

function dropInbox(team, leafId, dir = teamDir(team.id)) {
  const token = team.inboxes && team.inboxes[leafId]
  if (!token) return
  if (dir && window.shellApi.lead) window.shellApi.lead.remove({ dir, token })
  delete team.inboxes[leafId]
}

// The pane with the most room in a layout, and the direction to split it in
// (side by side when it is wider than tall, on a 16:9 screen).
function largestLeaf(node, w = 1.78, h = 1) {
  if (!node) return { id: null, area: 0, dir: 'row' }
  if (node.type !== 'split') return { id: node.id, area: w * h, dir: w >= h ? 'row' : 'col' }
  let best = null
  node.children.forEach((c, i) => {
    const f = (node.sizes && node.sizes[i] ? node.sizes[i] : 100 / node.children.length) / 100
    const r = node.dir === 'row' ? largestLeaf(c, w * f, h) : largestLeaf(c, w, h * f)
    if (!best || r.area > best.area) best = r
  })
  return best
}

// Reviews a lead had not done yet go to the new lead, or else to the user.
function handOffLeadReviews(teamId, newLead = null) {
  const pending = boardTasks.filter((t) => t.teamId === teamId && t.column === 'review' && t.leadReview === 'pending')
  for (const task of pending) {
    const worker = findLeaf(task.paneId)
    if (newLead && worker && newLead.id !== worker.id) {
      noticeAgents([newLead], leadReviewPrompt(task, worker), teamId, { source: 'tessel', scope: 'lead', teamId })
      continue
    }
    updateTask(task.id, { leadReview: null })
    showToast(t('app.lead.noLeadReview', '"{{title}}" is ready for your review: its team has no lead any more.', { title: task.title }), {
      kind: 'attention',
      timeout: 10000,
      action: task.worktree ? { label: t('app.task.review', 'Review'), run: () => openReview(task.id) } : { label: t('app.common.show', 'Show'), run: () => focusPane(task.paneId) }
    })
  }
}

function leadReviewPrompt(task, worker) {
  const wt = task.worktree
  const where = wt
    ? `in its own copy ${wt.path} (branch ${wt.branch}, from ${wt.baseBranch || 'main'}). See the changes with: git -C "${wt.path}" log ${wt.baseBranch || 'main'}..HEAD and git -C "${wt.path}" diff ${wt.baseBranch || 'main'}...HEAD` // i18n-ignore
    : 'in the project folder (see git status and git diff there)' // i18n-ignore
  return (
    `[Tessel] ${paneLabel(worker)} finished the task "${task.title}" (task id ${task.id}) ${where}.\n` + // i18n-ignore
    'Review it: correctness, scope, tests. Do not edit its files. Then write to your lead inbox either ' + // i18n-ignore
    `{"action":"approve","task":"${task.id}","note":"..."} or {"action":"changes","task":"${task.id}","text":"what to fix"}.` // i18n-ignore
  )
}

// Carry out one request from a lead; returns the line to answer it with.
async function runLeadRequest(team, lead, req) {
  const ws = wsOfLeaf(lead.id)
  const member = (num) => teamMembers(team.id).find((l) => l.num === num && l.id !== lead.id) || null
  if (req.action === 'task') {
    const active = boardTasks.filter((t) => t.teamId === team.id && (t.column === 'doing' || t.column === 'review')).length
    // Answers to a lead (an agent): English.
    if (active >= LEAD_MAX_ACTIVE) return `Not started "${req.title}": the team already has ${active} tasks in progress (limit ${LEAD_MAX_ACTIVE}).` // i18n-ignore
    let spec
    if (req.num != null) {
      const m = member(req.num)
      if (!m) return `Not started "${req.title}": #${req.num} is not in your team.` // i18n-ignore
      spec = { title: req.title, brief: req.brief, agent: { kind: 'pane', id: m.id }, isolated: false }
    } else {
      const kind = taskAgentKinds.value.find((a) => a.id === req.kind)
      if (!kind) return `Not started "${req.title}": unknown agent kind "${req.kind}". Use one of: ${taskAgentKinds.value.map((a) => a.id).join(', ')}.` // i18n-ignore
      if (req.ownCopy) {
        const info = ws && ws.cwd ? await window.shellApi.gitInfo(ws.cwd) : null
        if (!info || !info.isRepo || !info.hasCommits) {
          const why = !ws || !ws.cwd ? 'the workspace has no project folder' : !info || !info.isRepo ? 'the project folder is not a git repository' : 'the repository has no commits yet'
          return `Not started "${req.title}": ${why}, so the new agent cannot have its own copy. Add "own_copy": false to let it work in the project folder.` // i18n-ignore
        }
      }
      spec = { title: req.title, brief: req.brief, agent: { kind: 'new', id: kind.id }, isolated: req.ownCopy }
    }
    const res = await startTask(spec, { ws, roomy: true, teamId: team.id })
    if (!res || res.error) return `Not started "${req.title}": ${(res && res.error) || 'unknown error'}.` // i18n-ignore
    return `Started "${req.title}" (task id ${res.task.id}) with ${paneLabel(res.leaf)}${res.task.worktree ? ` on branch ${res.task.worktree.branch}` : ''}.` // i18n-ignore
  }
  if (req.action === 'message') return runMemberMessage(team, lead, req)
  const inReview = boardTasks.filter((t) => t.teamId === team.id && t.column === 'review')
  const found = findTaskRef(inReview, req.task)
  const task = found.task
  if (!task) {
    if (found.error) return `Not done: ${found.error}.` // i18n-ignore
    return (
      `No task of your team waits for review under "${req.task}".` + // i18n-ignore
      (inReview.length ? ` In review: ${inReview.map((t) => `${t.id} "${t.title}"`).join(', ')}.` : '') // i18n-ignore
    )
  }
  if (req.action === 'approve') {
    updateTask(task.id, { leadReview: 'approved', leadNote: req.text || '' })
    taskEvent(task, 'approved', req.text, lead.title)
    showToast(t('app.lead.approved', '{{lead}} (lead) approved "{{title}}". It is ready for you to merge.', { lead: lead.title, title: task.title }), {
      kind: 'attention',
      timeout: 10000,
      action: task.worktree ? { label: t('app.task.review', 'Review'), run: () => openReview(task.id) } : { label: t('app.common.show', 'Show'), run: () => focusPane(task.paneId) }
    })
    return `Approved "${task.title}". The user was told it is ready to merge.` // i18n-ignore
  }
  const ok = sendBackToAgent(task, `Your lead ${paneLabel(lead)} asks for changes:\n${req.text}`, 'changes', req.text.slice(0, 80), lead.title) // i18n-ignore
  return ok ? `Sent your changes for "${task.title}" back to its agent.` : `The agent of "${task.title}" was closed.` // i18n-ignore
}

// A message from one team member to others (to: "#3", "team" or "lead").
// Delivered straight into their terminals; '' when it went through.
const MESSAGE_BUDGET = { max: 30, perMs: 10 * 60 * 1000 }
const sentLog = {}
function runMemberMessage(team, from, req) {
  const now = Date.now()
  const log = (sentLog[from.id] = (sentLog[from.id] || []).filter((t) => now - t < MESSAGE_BUDGET.perMs))
  if (log.length >= MESSAGE_BUDGET.max) return 'Not sent: too many messages in the last 10 minutes. Wait a little.' // i18n-ignore
  const others = teamMembers(team.id).filter((l) => l.id !== from.id && l.kind === 'agent')
  const lead = teamLead(team.id)
  const to =
    req.to === 'team'
      ? others
      : req.to === 'lead'
        ? others.filter((l) => lead && l.id === lead.id)
        : others.filter((l) => l.num === req.num)
  if (!to.length) {
    if (req.to === 'team') return 'Nobody else is in your team yet.' // i18n-ignore
    if (req.to === 'lead') return 'Your team has no lead.' // i18n-ignore
    return `#${req.num} is not in your team. Teammates: ${others.map(paneLabel).join(', ') || 'none'}.` // i18n-ignore
  }
  log.push(now)
  const isLead = lead && lead.id === from.id
  const head = isLead ? `[From your lead ${paneLabel(from)}]` : `[From ${paneLabel(from)}, team "${team.name}"]` // i18n-ignore
  const meta = { source: isLead ? 'lead' : 'agent', scope: 'team', teamId: team.id, from: from.title, waitIdle: true }
  const skipped = []
  for (const l of to) {
    if (limits[l.id]) {
      logMessage(l.id, 'skipped', req.text, meta)
      skipped.push(paneLabel(l))
    } else noticeAgents([l], `${head} ${req.text}`, team.id, meta)
  }
  return skipped.length ? `Not delivered to ${skipped.join(', ')}: usage limit reached.` : '' // i18n-ignore
}

// Every few seconds: take each team member's requests and carry them out.
let teamPolling = false
// Nothing runs on teams until the layout and the board are restored: an early
// round would see no members (lead "removed", inboxes dropped) and publish an
// empty team list for the MCP tools.
let teamsReady = false

// Watchdog: a round that never ends (a call that never answers) would stop
// all team work for good. A round older than 2 minutes is left behind (it
// can no longer block: rounds are numbered) and a new one starts; the log
// says at which step it was stuck.
const TEAM_ROUND_STUCK_MS = 2 * 60 * 1000
let teamRound = 0
let teamRoundStart = 0
let teamStep = ''
// A round the watchdog replaced must not change anything when its stuck call
// finally answers (it would apply old results over newer ones): every step
// checks it is still the current round after each wait.
function roundGone(round) {
  return round !== teamRound
}
function teamStepIs(what, team) {
  teamStep = team ? `${what} (${team.name})` : what
}

async function pollTeams() {
  if (!teamsReady || !window.shellApi.lead) return
  if (teamPolling) {
    const stuck = Date.now() - teamRoundStart
    if (stuck < TEAM_ROUND_STUCK_MS) return
    if (window.shellApi.log)
      window.shellApi.log('error', `team loop: a round was stuck for ${Math.round(stuck / 1000)} s at "${teamStep}"; starting a new one`)
  }
  const round = ++teamRound
  teamPolling = true
  teamRoundStart = Date.now()
  teamStepIs('start')
  try {
    for (const team of [...teams.value]) {
      const dir = teamDir(team.id)
      if (team.leadId && !teamLead(team.id)) {
        // The lead was closed or left the team.
        team.leadId = null
        recordActivity({ type: 'team', action: 'lead-removed', teamId: team.id, wsId: teamWsId(team.id), name: team.name })
        tellTeam(team.id, 'The team has no lead any more.') // i18n-ignore
        handOffLeadReviews(team.id)
      }
      const members = teamMembers(team.id).filter((l) => l.kind === 'agent')
      // Orchestration: closed or silent workers, the queue, the workers list.
      teamStepIs('workers', team)
      try {
        orchestrator.tick(team, teams.value)
      } catch (err) {
        if (window.shellApi.log) window.shellApi.log('error', `orchestration: ${err && err.message}`)
      }
      // Inboxes of agents no longer in the team go away.
      for (const id of Object.keys(team.inboxes || {})) {
        if (!members.some((m) => m.id === id) && !inboxesBeingMade.has(team.inboxes[id])) dropInbox(team, id, dir)
      }
      if (!dir) {
        // The channel keeps its own folder (channelDir): still deliver.
        teamStepIs('channel set-up', team)
        await syncChannel(team)
        if (roundGone(round)) return
        teamStepIs('channel delivery', team)
        await deliverChannel(team, members, round)
        if (roundGone(round)) return
        continue
      }
      for (const m of members) {
        const token = team.inboxes && team.inboxes[m.id]
        if (token && inboxesBeingMade.has(token)) continue
        // Plain members message through the team channel; only the lead
        // (and members told about an inbox before) have one.
        if (!token) {
          if (team.leadId === m.id) await restoreLeadInbox(team, m)
          continue
        }
        teamStepIs('inbox', team)
        // Taken = removed from disk: from here on they are carried out and
        // answered even if the watchdog replaces this round (nothing else
        // would ever do them).
        const res = await window.shellApi.lead.take({ dir, token })
        // Its folder is gone (deleted by hand?): make it again next round.
        if (res && res.ok && res.missing) {
          // Only if it is still that inbox (a new one may be being made).
          if (team.inboxes[m.id] === token && !inboxesBeingMade.has(token)) delete team.inboxes[m.id]
          continue
        }
        if (!res || !res.ok || !res.items.length) continue
        const leaf = findLeaf(m.id)
        if (!leaf || leaf.team !== team.id) continue
        const isLead = team.leadId === leaf.id
        const answers = []
        for (const item of res.items) {
          const req = item.error ? { ok: false, error: item.error } : parseLeadRequest(item.data)
          if (!req.ok) answers.push(`${item.file}: not done, ${req.error}.`) // i18n-ignore
          else if (req.action === 'message') answers.push(runMemberMessage(team, leaf, req))
          else if (!isLead) answers.push(`${item.file}: only the team lead can use "${req.action}". Send a message instead.`) // i18n-ignore
          else answers.push(await runLeadRequest(team, leaf, req))
        }
        const text = answers.filter(Boolean)
        if (!text.length) continue
        noticeAgents([leaf], text.map((a) => `[Tessel] ${a}`).join('\n'), team.id, {
          source: 'tessel',
          scope: 'lead',
          teamId: team.id
        })
        if (roundGone(round)) return
      }
      teamStepIs('channel set-up', team)
      await syncChannel(team)
      if (roundGone(round)) return
      teamStepIs('channel delivery', team)
      await deliverChannel(team, members, round)
      if (roundGone(round)) return
    }
    teamStepIs('team tools check')
    await checkTeamTools(round)
    if (roundGone(round)) return
    teamStepIs('workspace boards')
    await syncSoloBoards(round)
    if (roundGone(round)) return
    // The team tools (messages and the task board) are set up as soon as
    // an agent CLI is here (Claude Code, Codex, Gemini, Qwen, Copilot,
    // OpenCode), not only once a team exists: an agent
    // working alone uses the board too.
    if (agents.value.some((a) => MCP_AGENT_IDS.includes(a.id) && a.available)) installTeamToolsOnce()
    // Agents of a team started before the current tools: restarted (once
    // per round, it looks at every team itself).
    if (teams.value.length) restartForTeamTools()
    teamStepIs('team map')
    await publishCurrentTeams()
  } finally {
    // A round left behind by the watchdog does not end the current one.
    if (round === teamRound) teamPolling = false
  }
}

// current.json per project: which agent is in which team now (the team
// tools trust only this). A project whose teams are all gone gets an empty
// map, and its old channels are retired.
const teamDirsSeen = new Set()
async function publishCurrentTeams() {
  if (!window.shellApi.team) return
  const byDir = {}
  // Open projects too: after a reload with no team left, a project's old
  // map is still cleaned up.
  for (const ws of workspaces.value) if (ws.cwd) teamDirsSeen.add(ws.cwd)
  for (const team of teams.value) {
    const dir = channelDir(team)
    if (!dir) continue
    teamDirsSeen.add(dir)
    const panes = (byDir[dir] = byDir[dir] || {})
    for (const l of teamMembers(team.id)) if (l.kind === 'agent' && l.num) panes[l.id] = { team: team.id, num: l.num }
  }
  for (const dir of teamDirsSeen) {
    const cur = await window.shellApi.team.current({ dir, panes: byDir[dir] || {} })
    // Retired by another Tessel window that did not know about it yet: set
    // up again on the next round.
    for (const id of (cur && cur.lost) || []) {
      delete channelSigs[id]
      delete channelBoxes[id]
    }
    const res = await window.shellApi.team.retire({ dir, liveTeamIds: teams.value.filter((t) => channelDir(t) === dir).map((t) => t.id) })
    // A retired channel is set up again from scratch if its team comes back
    // (Undo after Ungroup): forget what this session knew about it.
    for (const id of (res && res.retired) || []) {
      delete channelSigs[id]
      delete channelBoxes[id]
    }
  }
}

// --- Team channel ------------------------------------------------------------------
// Durable messages between teammates (src/main/teamChannel.js, by Codex): each
// agent has an outbox folder; a message waits on disk until it has been pasted
// into its recipient's terminal, then Tessel acknowledges it (and the sender
// gets a receipt). Unacknowledged messages come back after a restart.
const channelBoxes = {} // teamId -> { leafId: { outbox, guide } }
const channelSigs = {} // teamId -> membership last sent to ensure()
const channelQueued = new Set() // deliveries queued in this session

// Keep the channel's members in step with the team; tell members about a new
// outbox (except `quiet` ones, told another way).
// The channel's folder is fixed the first time: the first member leaving or
// moving to another workspace must not hide messages still waiting.
function channelDir(team) {
  if (!team.channelDir) team.channelDir = teamDir(team.id) || null
  return team.channelDir
}

async function syncChannel(team, opts = {}) {
  if (!team || !window.shellApi.channel) return null
  const dir = channelDir(team)
  if (!dir) return null
  const members = teamMembers(team.id).filter((l) => l.kind === 'agent' && l.num)
  const sig = members.map((m) => `${m.id}:${m.num}:${m.title}`).join('|')
  if (channelSigs[team.id] !== sig || !channelBoxes[team.id]) {
    const res = await window.shellApi.channel.ensure({
      dir,
      teamId: team.id,
      members: members.map((m) => ({ id: m.id, num: m.num, title: m.title || 'Agent' }))
    })
    if (!res || !res.ok) return null
    channelSigs[team.id] = sig
    channelBoxes[team.id] = Object.fromEntries(res.outboxes.map((o) => [o.id, { outbox: o.outbox, guide: o.guide }]))
  }
  const boxes = channelBoxes[team.id]
  if (!team.channelTold) team.channelTold = {}
  for (const m of members) {
    const box = boxes[m.id]
    if (!box || team.channelTold[m.id] === box.outbox) continue
    // Out of usage: tellAgents (and the welcome) skip it; it is told on a
    // later round, once the limit is over.
    if (limits[m.id]) continue
    team.channelTold[m.id] = box.outbox
    if (opts.quiet && opts.quiet.includes(m.id)) continue
    if (!TEAM_MESSAGES_IN_TERMINALS) continue
    tellAgents([m], `[Tessel] Team "${team.name}": talk to your teammates directly through the team channel, not through the user.\n${box.guide}`, team.id) // i18n-ignore
  }
  for (const id of Object.keys(team.channelTold)) if (!boxes[id]) delete team.channelTold[id]
  return boxes
}

async function ackChannel(dir, teamId, d, key, tries = 0) {
  let res = null
  try {
    res = await window.shellApi.channel.ack({ dir, teamId, id: d.id, toId: d.toId })
  } catch {
    res = null
  }
  if (res && res.ok) return
  if (tries < 5) setTimeout(() => ackChannel(dir, teamId, d, key, tries + 1), 3000)
  // Still failing: let a later poll deliver it again (a duplicate is better
  // than a lost message).
  else channelQueued.delete(key)
}

let teamToolsReady = false
// Team members whose team tools are not connected: the tools say they run
// every 30 s (teamMcp/server.cjs, .tessel/agents/<pane>.json). An agent of a
// team with no such sign for a minute after it started gets a warning on its
// row and a message once; both go when the tools are back.
const MCP_AGENT_IDS = ['claude', 'codex', 'gemini', 'qwen', 'copilot', 'opencode', 'cline']
const toolsDown = reactive({}) // paneId -> true
const toolsWarned = new Set()
let toolsCheckAt = 0
async function checkTeamTools(round) {
  if (!window.shellApi.team || !window.shellApi.team.toolsAlive || !teamToolsReady) return
  if (Date.now() < toolsCheckAt) return
  toolsCheckAt = Date.now() + 20000
  const inTeam = new Set()
  for (const team of teams.value) {
    const members = teamMembers(team.id).filter((l) => l.kind === 'agent' && MCP_AGENT_IDS.includes(l.agentId))
    if (!members.length) continue
    // Where each tool writes: the project folder it was given (its
    // workspace's, or the folder it started in).
    const byDir = {}
    for (const m of members) {
      inTeam.add(m.id)
      for (const d of new Set([channelDir(team), wsOfLeaf(m.id)?.cwd, m.startDir].filter(Boolean))) (byDir[d] = byDir[d] || []).push(m.id)
    }
    const alive = new Set()
    for (const [dir, ids] of Object.entries(byDir)) {
      const res = await window.shellApi.team.toolsAlive({ dir, ids })
      if (roundGone(round)) return
      for (const [id, a] of Object.entries((res && res.ok && res.alive) || {})) if (a) alive.add(id)
    }
    for (const m of members) {
      // Started with older tools (before they said they run): cannot tell;
      // it is restarted with the new ones anyway.
      if (m.teamTools && m.toolsVersion !== teamToolsVersion) {
        delete toolsDown[m.id]
        continue
      }
      const young = Date.now() - (m.restartedAt || m.launchedAt || 0) < 60000
      if (alive.has(m.id)) {
        delete toolsDown[m.id]
        toolsWarned.delete(m.id)
      } else if (!young && !toolsDown[m.id]) {
        toolsDown[m.id] = true
        if (!toolsWarned.has(m.id)) {
          toolsWarned.add(m.id)
          showToast(t('app.team.toolsDown', '{{pane}}: its team tools (tessel-team) are not connected, so it cannot read or send team messages. Restart it (right-click its pane, Restart).', { pane: paneLabel(m) }), {
            kind: 'attention',
            timeout: 15000,
            action: { label: t('app.common.restart', 'Restart'), run: () => restartLeaf(m.id) }
          })
          if (window.shellApi.log) window.shellApi.log('info', `team tools: ${paneLabel(m)} (${m.id}) has no connected tessel-team server`)
        }
      }
    }
  }
  // Not in a team any more: no warning.
  for (const id of Object.keys(toolsDown)) if (!inTeam.has(id)) delete toolsDown[id]
}

// Agents started by hand in a shell pane (`claude` typed in PowerShell):
// Tessel looks at what runs under the pane's shell after Enter is pressed
// there (for a minute), and every few seconds while such an agent runs. The
// pane then works as an agent pane (status, teams, board) and goes back to
// being a shell when the agent quits. Checked once for every shell pane at
// startup (an agent may still run from before).
const shellEnterAt = {} // paneId -> last Enter pressed there
let detectBusy = false
let detectedAtStart = false
const DETECTED_EVERY_MS = 20000
let lastDetectedCheck = 0
async function detectShellAgents() {
  if (!teamsReady || detectBusy || !window.shellApi.detectAgents) return
  const now = Date.now()
  const shells = {}
  const watched = {}
  // An agent already recognised is only watched to see it exit: every 20 s
  // (each check lists the processes through PowerShell), not every 4 s.
  const checkDetected = now - lastDetectedCheck >= DETECTED_EVERY_MS
  forEachWsLeaf((l) => {
    if (!l.pid) return
    const watch =
      (l.detected && checkDetected) ||
      (l.kind !== 'agent' && (!detectedAtStart || now - (shellEnterAt[l.id] || 0) < 60000))
    if (watch) {
      shells[l.id] = l.pid
      watched[l.id] = l
    }
  })
  detectedAtStart = true
  if (checkDetected && Object.values(watched).some((l) => l.detected)) lastDetectedCheck = now
  if (!Object.keys(shells).length) return
  detectBusy = true
  try {
    const res = await window.shellApi.detectAgents({ shells })
    if (!res || !res.ok) return
    for (const [id, agentId] of Object.entries(res.agents || {})) {
      const l = findLeaf(id)
      if (!l || l !== watched[id]) continue // closed or replaced meanwhile
      // Its command line (the model may be in it: ollama run <model>, --model).
      const cmd = res.commands && typeof res.commands[id] === 'string' ? res.commands[id].slice(0, 2000) : null
      if (agentId && l.detectedCommand !== cmd) l.detectedCommand = cmd
      if (agentId && !l.detected && l.kind !== 'agent') becomeAgent(l, agentId)
      else if (agentId && l.detected && l.agentId !== agentId) becomeAgent(l, agentId)
      else if (!agentId && l.detected) becomeShell(l)
    }
  } finally {
    detectBusy = false
  }
}
function becomeAgent(leaf, agentId) {
  const preset = agents.value.find((a) => a.id === agentId)
  if (!leaf.detected) leaf.shellTitle = leaf.title
  leaf.detected = true
  leaf.kind = 'agent'
  leaf.agentId = agentId
  leaf.accent = (preset && preset.accent) || null
  leaf.title = (preset && preset.name) || agentId
  leaf.teamTools = teamToolsReady
  leaf.toolsVersion = teamToolsReady ? teamToolsVersion : null
  if (window.shellApi.log) window.shellApi.log('info', `detected ${leaf.title} started by hand in pane ${leaf.id}`)
}
function becomeShell(leaf) {
  leaf.kind = 'shell'
  leaf.agentId = null
  leaf.accent = null
  leaf.title = leaf.shellTitle || leaf.title
  leaf.detected = false
  delete leaf.shellTitle
  delete leaf.sessionOptions
  delete leaf.modelChoice
  delete leaf.detectedCommand
  clearAgentStatus(leaf.id)
}
const detectTimer = setInterval(detectShellAgents, 4000)
onBeforeUnmount(() => clearInterval(detectTimer))

// The team tools' version now (server.cjs VERSION), once they are set up.
let teamToolsVersion = null
// Started with the team tools as they are now (an older version: restarted).
// Only a new tools API (the first two numbers of their version: new or
// changed tools) restarts agents; a fix (third number) is picked up by the
// next hook run or tool start without restarting anyone.
const toolsApi = (v) => String(v || '').split('.').slice(0, 2).join('.')
function hasCurrentTools(leaf) {
  return !!leaf.teamTools && (!teamToolsVersion || toolsApi(leaf.toolsVersion) === toolsApi(teamToolsVersion))
}

// The conversation each agent is really in, as its hooks report it (after
// /clear, /resume, a new conversation...): the pane follows it, so a restart
// or a reopened Tessel resumes that one, never the id found at launch.
const safeReportedId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{6,80}$/.test(id)
// paneId -> the conversation whose Claude Code inbox its hooks reported
// (agentInbox.js): reminders go there, never typed into the terminal.
const agentInboxes = {}
const inboxDownAt = {} // paneId -> when posting to its inbox last failed
async function followReportedSessions() {
  if (!window.shellApi.reportedSessions) return
  let reports = null
  try {
    reports = await window.shellApi.reportedSessions()
  } catch {
    return
  }
  if (!reports) return
  forEachWsLeaf((leaf) => {
    const r = reports[leaf.id]
    if (!r || leaf.kind !== 'agent' || r.agent !== leaf.agentId || !safeReportedId(r.sessionId)) {
      delete agentInboxes[leaf.id]
      return
    }
    // A report older than this pane's start belongs to an earlier agent in it
    // (its inbox is gone with it).
    if (leaf.launchedAt && r.at < leaf.launchedAt - 5000) {
      delete agentInboxes[leaf.id]
      return
    }
    if (r.inbox) agentInboxes[leaf.id] = r.sessionId
    else delete agentInboxes[leaf.id]
    if (r.sessionId === leaf.sessionId) return
    if (window.shellApi.log) window.shellApi.log('info', `${paneLabel(leaf)} (${leaf.id}) is now in conversation ${r.sessionId} (${r.source || 'reported'})`)
    leaf.sessionId = r.sessionId
  })
}
const sessionFollowTimer = setInterval(followReportedSessions, 5000)
onBeforeUnmount(() => clearInterval(sessionFollowTimer))
// The team tools are set up for Claude Code and Codex once a team exists
// (MCP server "tessel-team" + Claude Code hooks; listed in the MCP dialog).
let teamToolsNextTry = 0
let teamToolsBusy = false
let teamToolsFailed = ''
async function installTeamToolsOnce() {
  if (teamToolsReady || teamToolsBusy || Date.now() < teamToolsNextTry || !window.shellApi.installTeamTools) return
  teamToolsBusy = true
  let res = null
  try {
    res = await window.shellApi.installTeamTools()
  } catch (err) {
    res = { ok: false, errors: [err.message] }
  } finally {
    teamToolsBusy = false
  }
  if (res && res.ok) {
    teamToolsReady = true
    teamToolsVersion = res.version || null
    if (res.changed && res.changed.some((c) => c.includes('MCP server')))
      showToast(t('app.team.toolsReady', 'Team messages now go in the background, never into your terminals (MCP servers: tessel-team).'), { timeout: 10000 })
    return
  }
  // Not (fully) set up: say so once per failure, and try again in 5 minutes.
  teamToolsNextTry = Date.now() + 5 * 60 * 1000
  const why = (res && res.errors && res.errors[0]) || 'unknown error'
  if (why !== teamToolsFailed) {
    teamToolsFailed = why
    showToast(t('app.team.toolsFailed', 'Team messages are not set up yet: {{why}} Tessel will try again in 5 minutes.', { why }), { kind: 'error', timeout: 12000 })
  }
}

// Agents started before the team tools were set up do not have them (an
// agent CLI loads its MCP servers when it starts). Tessel restarts each one
// once, in place (same pane, number, team and task, conversation resumed),
// only when it is quiet, not waiting for an approval, and not in use.
// opts.resume: resume the conversation (default: when it has one);
// opts.forTools: restarted to load the team tools (it has them afterwards).
async function restartInPlace(leafId, opts = {}) {
  // One restart at a time per pane (the automatic one and the user's).
  if (restartingLeaves.has(leafId)) return false
  restartingLeaves.add(leafId)
  try {
    return await restartInPlaceNow(leafId, opts)
  } finally {
    restartingLeaves.delete(leafId)
  }
}

async function restartInPlaceNow(leafId, opts) {
  const old = findLeaf(leafId)
  if (!wsOfLeaf(leafId) || !old || old.kind !== 'agent' || !old.agentCommand) return false
  window.shellApi.killPty(leafId)
  // Wait until its terminal is really gone, so the new one gets the same id.
  let gone = false
  for (let i = 0; i < 40 && !gone; i++) {
    await new Promise((r) => setTimeout(r, 250))
    const a = await window.shellApi.attachPty(leafId).catch(() => null)
    gone = !a || !a.ok
    if (!gone) window.shellApi.killPty(leafId)
  }
  // The pane was closed meanwhile: nothing to restart.
  if (!gone || findLeaf(leafId) !== old) return false
  dropBuffer(leafId)
  clearAgentStatus(leafId)
  const agent = { id: old.agentId, name: old.title, command: old.agentCommand, accent: old.accent }
  // Where it was started (a Codex conversation is found by its folder).
  const fresh = await createLeaf(old.shellId, agent, old.startDir || (wsOfLeaf(leafId) || {}).cwd, old.worktree, {
    id: leafId,
    sessionId: old.sessionId,
    accountId: old.accountId,
    sessionOptions: old.sessionOptions,
    resume: !!old.sessionId && opts.resume !== false,
    // Team messages waiting for it: its first prompt says so (see createLeaf).
    wake: { teamId: old.team || null, gen: (old.gen || 0) + 1 }
  })
  if (!fresh) return false
  if (findLeaf(leafId) !== old) {
    // Closed while it was starting: do not leave its terminal running.
    window.shellApi.killPty(leafId)
    return false
  }
  Object.assign(fresh, {
    title: old.title,
    ...(old.titleSet ? { titleSet: true } : {}),
    ...(old.autoTitle && fresh.sessionId === old.sessionId ? { autoTitle: old.autoTitle } : {}),
    broadcast: old.broadcast,
    num: old.num,
    team: old.team,
    gen: (old.gen || 0) + 1,
    restartedAt: Date.now()
  })
  if (opts.forTools) {
    fresh.teamTools = true
    fresh.toolsVersion = teamToolsVersion
  }
  // A new terminal: its input line is empty (a draft typed in the old one is
  // gone), so reminders and restarts are not held back by it.
  setDraft(leafId, false)
  // The workspace it is in now (it may have been moved during the wait).
  const ws = wsOfLeaf(leafId)
  if (!ws) {
    window.shellApi.killPty(leafId)
    return false
  }
  ws.tree = replaceNode(ws.tree, leafId, () => fresh)
  return true
}

// --- Agent sleep (Settings > Agents, after Orca's) ---------------------------------
// An agent idle for a while (its conversation saved, not in a team, nothing
// typed in it, not the pane you are in) has its terminal stopped to free
// memory; its pane stays, marked asleep. Opening the pane wakes it: the agent
// starts again in the same pane and resumes its conversation. Checked every
// minute; a pane must qualify twice in a row (a minute apart).
const SLEEP_TICK_MS = 60 * 1000
const sleepCandidates = {} // leafId -> signature seen at the last check
function sleepSignature(leaf) {
  const t = trackedState[leaf.id]
  return `${leaf.sessionId}|${t ? t.since : ''}|${lastUserKey[leaf.id] || 0}`
}
const sleepWhy = {} // leafId -> why it stays awake ('' when it may sleep)
// -> '' when this pane may sleep now, else why not.
function canSleep(leaf, ws, now) {
  const info = agentStates.value[leaf.id]
  const t = trackedState[leaf.id]
  return sleepBlocker({
    leaf: { ...leaf, inTeam: !!(leaf.team && teamById(leaf.team)) },
    resumable: !!sessionKind({ id: leaf.agentId }) && safeSessionId(leaf.sessionId),
    state: info ? info.state : null,
    // Only a state the agent's own hooks confirmed (never one estimated
    // from its screen): stopping a terminal needs that proof.
    confirmed: !!(leaf.agentLaunchToken && agentStateKnown(leaf.id, leaf.agentLaunchToken)),
    trackedState: t ? t.state : null,
    since: t ? t.since : NaN,
    lastKey: lastUserKey[leaf.id] || 0,
    draft: !!(userDraft[leaf.id] || draftUnknown[leaf.id]),
    // The pane you are in (the shown workspace's active pane) stays awake,
    // even with Tessel in the background (opening a pane is what wakes it).
    active: ws.id === currentWsId.value && leaf.id === activeId.value,
    restarting: restartingLeaves.has(leaf.id),
    minutes: settings.agentSleepMinutes,
    now
  })
}
async function sleepTick() {
  if (!settings.agentSleep) {
    for (const k of Object.keys(sleepCandidates)) delete sleepCandidates[k]
    return
  }
  const now = Date.now()
  for (const ws of workspaces.value) {
    forEachLeaf(ws.tree, (leaf) => {
      const why = canSleep(leaf, ws, now)
      // Why an agent stays awake, in the log when it changes (agents only).
      if (leaf.kind === 'agent' && sleepWhy[leaf.id] !== why) {
        sleepWhy[leaf.id] = why
        if (why && window.shellApi.log) window.shellApi.log('info', `agent sleep: ${paneLabel(leaf)} stays awake: ${why}`)
      }
      if (why) {
        delete sleepCandidates[leaf.id]
        return
      }
      const sig = sleepSignature(leaf)
      if (sleepCandidates[leaf.id] === sig) {
        delete sleepCandidates[leaf.id]
        putToSleep(leaf)
      } else sleepCandidates[leaf.id] = sig
    })
  }
}
function putToSleep(leaf) {
  leaf.sleeping = { at: Date.now() }
  window.shellApi.killPty(leaf.id)
  if (window.shellApi.log) window.shellApi.log('info', `agent sleep: ${paneLabel(leaf)} asleep (idle ${settings.agentSleepMinutes} min)`)
}
// Opening a sleeping pane (or its Wake button): the same pane, the
// conversation resumed.
async function wakeLeaf(leafId) {
  const leaf = findLeaf(leafId)
  if (!leaf || !leaf.sleeping || restartingLeaves.has(leafId)) return
  const ok = await restartInPlace(leafId, { resume: true })
  if (!ok && findLeaf(leafId) === leaf) showToast(t('app.sleep.wakeFailed', '{{name}} could not be woken: try Wake again.', { name: leaf.title }), { kind: 'error', timeout: 8000 })
}
// A sleeping pane you open wakes up.
watch(
  () => {
    const leaf = activeId.value ? findLeaf(activeId.value) : null
    return leaf && leaf.sleeping ? leaf.id : null
  },
  (id) => {
    if (id) wakeLeaf(id)
  }
)
const sleepTimer = setInterval(sleepTick, SLEEP_TICK_MS)
onBeforeUnmount(() => clearInterval(sleepTimer))

// Safe wake-up: an idle agent does not read its team messages by itself (it
// reads them when it works). When messages have waited 10 s, Tessel types
// ONE short reminder line into its terminal, only when the agent is quiet
// (no approval, no usage limit, nothing else being typed there) and the user
// is not in that pane nor typed there in the last 30 s. The messages
// themselves stay in the background. One reminder per batch: a new one only
// after the agent has read everything.
const WAKE_AFTER_MS = 10000 // an idle agent does not read by itself: remind it soon
const USER_AWAY_MS = 30000
// A reminder that did not work (the messages are still unread 5 minutes
// later, say its team tools were down) is sent again; an agent restarted
// since (gen) gets one at once.
const REWAKE_AFTER_MS = 5 * 60 * 1000
const WAKE_AFTER_RESTART_MS = 2 * 60 * 1000
// The reminder's own words, to find one left in an input line.
const WAKE_LINE = /\[Tessel\] You have \d+ new team messages?/
const wakeState = {} // leafId -> { since, woken, wokenAt, gen }
// The user is not in this pane, has no line in progress there, and has not
// typed there for 30 s. anyState: also when its state is not confirmed
// (Settings > Orchestration, wake agents even without confirmation).
function wakeAllowed(id, anyState = false) {
  const leaf = findLeaf(id)
  if (!anyState && leaf?.agentLaunchToken && !agentStateKnown(id, leaf.agentLaunchToken)) return false
  if (id === activeId.value && document.hasFocus()) return false
  // A draft Codex's screen proves gone (its empty-prompt placeholder is back:
  // sent, cleared, or never a draft at all) no longer holds reminders back.
  if (userDraft[id] && Date.now() - (lastUserKey[id] || 0) >= USER_AWAY_MS && inputShownEmpty(id)) setDraft(id, false)
  if (userDraft[id]) return false
  // Unknown line: shown empty on screen now = known empty from here on (the
  // user's next key is tracked again by noteUserInput).
  if (draftUnknown[id]) {
    if (!inputShownEmpty(id)) return false
    setDraft(id, false) // proven empty: recorded as known empty
  }
  return Date.now() - (lastUserKey[id] || 0) >= USER_AWAY_MS
}

// Proof on screen that an agent's input line is empty: Codex shows its
// placeholder "Ask Codex to do anything" only when nothing is typed there.
// (Claude Code has no such sign: an unknown line there stays unknown.)
function inputShownEmpty(id) {
  const leaf = findLeaf(id)
  const pane = getPane(id)
  if (!leaf || leaf.agentId !== 'codex' || !pane || !pane.promptShowsPlaceholder) return false
  // Read from the terminal itself, not from text: the cursor's line is the
  // "›" prompt, the cursor sits at its start (nothing typed) and what follows
  // is drawn dim (the placeholder, not the same words typed).
  return pane.promptShowsPlaceholder('›')
}
// Messages wait for an agent whose state Tessel cannot confirm (a Codex
// relaunched in place reports nothing before its next turn): Tessel does not
// type into it on its own, it asks you once (a toast with a button), unless
// Settings > Orchestration says to wake agents even without confirmation.
function offerWake(leaf, count) {
  if (!settings.teamWakeUps || leaf.kind !== 'agent' || !leaf.teamTools) return
  const w = (wakeState[leaf.id] = wakeState[leaf.id] || { since: Date.now(), woken: false, gen: leaf.gen || 0 })
  if (w.offered || Date.now() - w.since < WAKE_AFTER_MS) return
  w.offered = true
  const launchToken = leaf.agentLaunchToken
  const sessionId = leaf.sessionId
  const reminder = `[Tessel] You have ${count} new team message${count > 1 ? 's' : ''}: read ${count > 1 ? 'them' : 'it'} with team_inbox.` // i18n-ignore
  showToast(
    t('app.team.wakeOffer', '{{name}} has team messages waiting, but Tessel cannot confirm it is idle (it was just restarted), so it did not type anything.', {
      name: paneLabel(leaf)
    }),
    {
      kind: 'attention',
      timeout: 30000,
      action: {
        label: t('app.team.wakeOfferAction', 'Send it the reminder'),
        run: () => {
          // Checked at the click AND again right before it is typed (it can
          // wait while you type): the same launch, session and team,
          // messages still unread, nothing to approve, no line of yours
          // waiting there. Stale by then: dropped, never typed elsewhere.
          const team = leaf.team
          const stillFine = () => {
            const now = findLeaf(leaf.id)
            if (!now || now.agentLaunchToken !== launchToken || now.sessionId !== sessionId || now.team !== team) return false
            return !!(teamUnread[leaf.id] || 0) && !approvals[leaf.id] && !awaitingApproval(leaf.id) && !userDraft[leaf.id] && !unsent[leaf.id]
          }
          if (!stillFine()) return
          deliverToAgent(leaf.id, reminder, { source: 'user', scope: 'wake', teamId: team, guard: stillFine, dropIfNotNow: true })
          if (window.shellApi.log) window.shellApi.log('info', `team tools: reminder sent to ${paneLabel(leaf)} (${leaf.id}) at the user's request`)
        }
      }
    }
  )
}
// A Claude Code whose state is not confirmed yet (just started, no turn):
// its own inbox queues the reminder inside Claude (nothing typed), so it
// is used when it belongs to the pane's current session. Its state stays
// unconfirmed; a failed inbox never falls back to typing (the toast asks
// you instead). One try per episode, again after REWAKE_AFTER_MS.
function inboxWake(leaf, count) {
  if (!settings.teamWakeUps || leaf.agentId !== 'claude' || !leaf.teamTools) return false
  if (!leaf.sessionId || agentInboxes[leaf.id] !== leaf.sessionId || !window.shellApi.agentInbox) return false
  if (Date.now() - (inboxDownAt[leaf.id] || 0) < REWAKE_AFTER_MS) return false
  const w = (wakeState[leaf.id] = wakeState[leaf.id] || { since: Date.now(), woken: false, gen: leaf.gen || 0 })
  if (w.inboxAt && Date.now() - w.inboxAt < REWAKE_AFTER_MS) return true
  if (Date.now() - w.since < WAKE_AFTER_MS) return true
  w.inboxAt = Date.now()
  const sessionId = leaf.sessionId
  const reminder = `[Tessel] You have ${count} new team message${count > 1 ? 's' : ''}: read ${count > 1 ? 'them' : 'it'} with team_inbox.` // i18n-ignore
  window.shellApi
    .agentInbox({ paneId: leaf.id, sessionId, text: reminder })
    .then((res) => {
      if (res && res.ok) {
        if (window.shellApi.log) window.shellApi.log('info', `team tools: reminded ${paneLabel(leaf)} (${leaf.id}) of ${count} waiting message(s) through its inbox (state not confirmed yet)`)
        return
      }
      inboxDownAt[leaf.id] = Date.now()
      offerWake(leaf, count)
    })
    .catch(() => {
      inboxDownAt[leaf.id] = Date.now()
      offerWake(leaf, count)
    })
  return true
}
// Tessel launched this pane with a first prompt about its waiting messages
// (createLeaf, opts.wake): that was its reminder for them, so neither a
// typed one nor the toast follows for the same messages (a new one only
// after it has read everything, or REWAKE_AFTER_MS later if they still wait).
function noteLaunchWake(id, gen) {
  const now = Date.now()
  wakeState[id] = { since: now, woken: true, wokenAt: now, gen: gen || 0, offered: true, launchPrompt: true }
}
// How many team messages wait for a pane Tessel is about to launch: the
// last count seen, else (Tessel just started, nothing polled yet) its
// team's channel read now. 0 when unknown.
async function unreadAtLaunch(id, teamId) {
  if (teamUnread[id]) return teamUnread[id]
  const team = teamId ? teams.value.find((x) => x.id === teamId) : null
  const dir = team && team.channelDir
  if (!dir || !window.shellApi.channel || !window.shellApi.channel.poll) return 0
  try {
    // availableIds []: only the counts, nothing handed out for delivery.
    const res = await window.shellApi.channel.poll({ dir, teamId: team.id, availableIds: [] })
    return (res && res.ok && res.unreadCounts && res.unreadCounts[id]) || 0
  } catch {
    return 0
  }
}
function wakeIfNeeded(leaf) {
  if (leaf.agentLaunchToken && !agentStateKnown(leaf.id, leaf.agentLaunchToken)) {
    const waiting = teamUnread[leaf.id] || 0
    if (!waiting) delete wakeState[leaf.id]
    else if (inboxWake(leaf, waiting)) return
    // Settings > Orchestration: typed like for a confirmed agent (the same
    // checks, again right before typing), else the user is asked.
    else if (settings.teamWakeUnconfirmed) typeWake(leaf, waiting, true)
    else offerWake(leaf, waiting)
    return
  }
  const count = teamUnread[leaf.id] || 0
  if (!count) {
    delete wakeState[leaf.id]
    return
  }
  typeWake(leaf, count, false)
}
// The reminder typed into the agent's terminal. unconfirmed: its state is
// not confirmed by its hooks (only with the setting on): it must not look
// busy on screen, gets no inbox try (inboxWake had it) and waits a moment
// after its launch.
function typeWake(leaf, count, unconfirmed) {
  // Off in Settings: the messages stay in the background, never typed into
  // the terminal; the agent reads them when it next works.
  if (!settings.teamWakeUps) return
  const w = (wakeState[leaf.id] = wakeState[leaf.id] || { since: Date.now(), woken: false, gen: leaf.gen || 0 })
  if (w.woken && ((leaf.gen || 0) !== w.gen || Date.now() - (w.wokenAt || 0) >= REWAKE_AFTER_MS)) {
    w.woken = false
    w.gen = leaf.gen || 0
  }
  if (w.woken || Date.now() - w.since < WAKE_AFTER_MS) return
  // Only an agent that has the team tools to read them.
  if (leaf.kind !== 'agent' || !leaf.teamTools) return
  const t = trackedState[leaf.id]
  if (unconfirmed) {
    // Not confirmed: at least nothing on its screen says it is working,
    // waiting for an approval or out of usage.
    if (t && !['idle', 'unknown'].includes(t.state)) return
    if (awaitingApproval(leaf.id)) return
  } else if (!t || t.state !== 'idle') return
  if (approvals[leaf.id] || limits[leaf.id] || pendingMessages[leaf.id] || unsent[leaf.id] || delivering.has(leaf.id)) return
  if (restartingLeaves.has(leaf.id)) return // being restarted right now
  const reminder = `[Tessel] You have ${count} new team message${count > 1 ? 's' : ''}: read ${count > 1 ? 'them' : 'it'} with team_inbox.` // i18n-ignore
  // Claude Code with its own inbox: the reminder goes there (it starts a turn
  // by itself), so the user's input line and prompts are never touched. It
  // failed lately (older Claude Code, process gone): typed as before.
  if (
    !unconfirmed &&
    leaf.agentId === 'claude' &&
    leaf.sessionId &&
    agentInboxes[leaf.id] === leaf.sessionId &&
    window.shellApi.agentInbox &&
    Date.now() - (inboxDownAt[leaf.id] || 0) >= REWAKE_AFTER_MS
  ) {
    w.woken = true
    w.wokenAt = Date.now()
    const failed = (why) => {
      inboxDownAt[leaf.id] = Date.now()
      if (wakeState[leaf.id]) wakeState[leaf.id].woken = false // typed on the next round
      if (window.shellApi.log) window.shellApi.log('warn', `team tools: ${paneLabel(leaf)} (${leaf.id}) inbox unreachable (${why}); the reminder is typed instead`)
    }
    window.shellApi
      .agentInbox({ paneId: leaf.id, sessionId: leaf.sessionId, text: reminder })
      .then((res) => {
        if (!res || !res.ok) return failed((res && res.error) || 'no answer')
        if (window.shellApi.log) window.shellApi.log('info', `team tools: reminded ${paneLabel(leaf)} (${leaf.id}) of ${count} waiting message(s) through its inbox`)
      })
      .catch((err) => failed(err && err.message))
    return
  }
  if (!wakeAllowed(leaf.id, unconfirmed)) return
  // Just restarted: it is still loading (a line typed now can stay unsent).
  // Not confirmed: also just after any launch.
  const startedAt = unconfirmed ? leaf.restartedAt || leaf.launchedAt : leaf.restartedAt
  if (startedAt && Date.now() - startedAt < WAKE_AFTER_RESTART_MS) return
  w.woken = true
  w.wokenAt = Date.now()
  // A reminder typed before is still in its input line, not sent: send that
  // one (Enter) instead of typing a second one on top of it.
  const pane = getPane(leaf.id)
  const bottom = pane && pane.screenText ? pane.screenText(4) : ''
  if (pane && WAKE_LINE.test(bottom) && !(leaf.agentId === 'codex' && inputShownEmpty(leaf.id))) {
    pane.submit()
    if (window.shellApi.log) window.shellApi.log('info', `team tools: sent the waiting reminder in ${paneLabel(leaf)} (${leaf.id})`)
    return
  }
  // At the moment it is typed. Not confirmed: also the same launch, session
  // and team, nothing to approve, no line left unsent.
  const launchToken = leaf.agentLaunchToken
  const sessionId = leaf.sessionId
  const team = leaf.team
  const samePane = () => {
    // Both switches still on, and no usage limit or work under way (waitIdle
    // waits for a busy screen, not for a quota).
    if (!settings.teamWakeUps || (unconfirmed && !settings.teamWakeUnconfirmed)) return false
    if (limits[leaf.id] || ['limited', 'working', 'approval'].includes(trackedState[leaf.id] && trackedState[leaf.id].state)) return false
    if (!unconfirmed) return true
    const now = findLeaf(leaf.id)
    if (!now || now.agentLaunchToken !== launchToken || now.sessionId !== sessionId || now.team !== team) return false
    return !!settings.teamWakeUnconfirmed && !approvals[leaf.id] && !awaitingApproval(leaf.id) && !userDraft[leaf.id] && !unsent[leaf.id]
  }
  deliverToAgent(
    leaf.id,
    reminder,
    {
      source: 'tessel',
      scope: 'wake',
      teamId: leaf.team,
      waitIdle: true,
      // Still unread and still safe at the moment it is typed; otherwise the
      // reminder (and its count) is dropped, and a fresh one comes later if
      // messages still wait.
      guard: () => (teamUnread[leaf.id] || 0) > 0 && samePane() && wakeAllowed(leaf.id, unconfirmed),
      dropIfNotNow: true,
      onDropped: () => {
        if (wakeState[leaf.id]) wakeState[leaf.id].woken = false
      }
    }
  )
  if (window.shellApi.log) window.shellApi.log('info', `team tools: reminded ${paneLabel(leaf)} (${leaf.id}) of ${count} waiting message(s)${unconfirmed ? ' (state not confirmed, typed as set in Settings)' : ''}`)
}

const restartedForTools = new Set()
let restarting = false
async function restartForTeamTools() {
  if (!teamToolsReady || restarting) return
  const now = Date.now()
  for (const team of teams.value) {
    for (const leaf of teamMembers(team.id)) {
      if (leaf.kind !== 'agent' || hasCurrentTools(leaf) || restartedForTools.has(leaf.id)) continue
      // Only an agent that gets the tools (Claude Code, Codex) and whose
      // conversation Tessel can resume for sure: a quiet terminal is no proof
      // there is nothing to keep. Otherwise it is left running, and it says so.
      if (!['claude', 'codex'].includes(leaf.agentId) || !leaf.sessionId) {
        // Decided once: this agent is never restarted in this session.
        {
          restartedForTools.add(leaf.id)
          const why = ['claude', 'codex'].includes(leaf.agentId) ? 'its conversation could not be found to resume it' : 'it does not use the team tools'
          if (window.shellApi.log) window.shellApi.log('info', `team tools: left ${paneLabel(leaf)} (${leaf.id}) running: ${why}`)
        }
        continue
      }
      const tracked = trackedState[leaf.id]
      const quiet = tracked && tracked.state === 'idle' && now - tracked.since > 60000
      // Nor over a line that may hold an unsent draft: not known to be empty
      // (after a reload, or history recalled) and not proven empty on screen.
      const draftMaybe = !!userDraft[leaf.id] || (!!draftUnknown[leaf.id] && !inputShownEmpty(leaf.id))
      const inUse = (leaf.id === activeId.value && document.hasFocus()) || userIsTyping(leaf.id) || draftMaybe
      if (!quiet || inUse || approvals[leaf.id] || pendingMessages[leaf.id] || unsent[leaf.id] || delivering.has(leaf.id)) continue
      if (leaf.agentLaunchToken && !agentStateKnown(leaf.id, leaf.agentLaunchToken)) continue
      // A reminder was typed there a moment ago: its Enter could reach the
      // new agent (Codex took one as "Update now").
      if (wakeState[leaf.id] && now - (wakeState[leaf.id].wokenAt || 0) < 60000) continue
      restarting = true
      restartedForTools.add(leaf.id)
      const title = paneLabel(leaf)
      try {
        const ok = await restartInPlace(leaf.id, { forTools: true })
        if (window.shellApi.log)
          window.shellApi.log(ok ? 'info' : 'error', `team tools: ${ok ? 'restarted' : 'could not restart'} ${title} (${leaf.id}) in place`)
        if (ok) showToast(t('app.team.toolsRestarted', 'Restarted {{pane}} so it has the latest team tools. Its conversation continues.', { pane: title }), { timeout: 6000 })
      } finally {
        restarting = false
      }
      return // one at a time
    }
  }
}

// --- Agent CLI updates (Settings > Agents) ------------------------------------------
// The main process finds which installed agents have a newer version
// (agentUpdates.js). An update runs in the background in the main process
// (agentUpdateRunner.js: output in the install log, result reported, kept in
// the update history), or in a new pane when asked (Run in a terminal). Panes running that agent then restart in
// place with their conversation resumed, each only at a safe moment (idle,
// nothing typed, no approval or limit, not the pane you are in: see
// src/shared/agentUpdatePlan.js); until then they wait, and you are told
// which. On Windows a running CLI can lock its own files (npm EBUSY/EPERM):
// then Tessel waits until every pane running it is safe to stop, stops them,
// runs the update again and relaunches each one in place, resumed.
const agentUpdateInfo = ref(null) // { checkedAt, agents: { id: row } }
const agentUpdateJobs = reactive({}) // agentId -> job (see startAgentUpdate)
const agentUpdateHistory = ref({ entries: [], last: {} }) // main's agentUpdateHistory.js
const restartAfterUpdate = reactive({}) // leafId -> { agentId, version }
const UPDATE_TICK_MS = 10 * 1000
const autoUpdateTried = {} // agentId -> version tried automatically (once)
let updateTickBusy = false

function agentPanesOf(agentId) {
  const out = []
  for (const ws of workspaces.value) {
    forEachLeaf(ws.tree, (leaf) => {
      if (leaf.kind === 'agent' && leaf.agentId === agentId && leaf.agentCommand) out.push({ leaf, ws })
    })
  }
  return out
}
function paneUpdateBlocker(leaf, ws, now = Date.now()) {
  const info = agentStates.value[leaf.id]
  const t = trackedState[leaf.id]
  const w = wakeState[leaf.id]
  return updateBlocker({
    pane: leaf,
    resumable: !!sessionKind({ id: leaf.agentId }) && safeSessionId(leaf.sessionId),
    managed: !!leaf.agentLaunchToken,
    confirmed: !!(leaf.agentLaunchToken && agentStateKnown(leaf.id, leaf.agentLaunchToken)),
    state: info ? info.state : null,
    trackedState: t ? t.state : null,
    since: t ? t.since : NaN,
    approval: !!approvals[leaf.id] || awaitingApproval(leaf.id),
    limited: !!limits[leaf.id],
    draft: !!userDraft[leaf.id] || (!!draftUnknown[leaf.id] && !inputShownEmpty(leaf.id)),
    lastKey: lastUserKey[leaf.id] || 0,
    focused: ws.id === currentWsId.value && leaf.id === activeId.value && document.hasFocus(),
    delivering: delivering.has(leaf.id) || !!pendingMessages[leaf.id] || !!unsent[leaf.id],
    recentReminder: !!(w && now - (w.wokenAt || 0) < 60000),
    restarting: restartingLeaves.has(leaf.id),
    now
  })
}
function updatePlanFor(agentId) {
  const now = Date.now()
  return planUpdate(
    agentPanesOf(agentId).map(({ leaf, ws }) => ({
      id: leaf.id,
      label: paneLabel(leaf),
      sleeping: !!leaf.sleeping,
      blocker: paneUpdateBlocker(leaf, ws, now)
    }))
  )
}
// Updates running now (the status bar shows them).
const agentUpdatingNow = computed(() =>
  Object.values(agentUpdateJobs)
    .filter((j) => ['updating', 'retrying'].includes(j.phase))
    .map((j) => ({ id: j.agentId, name: j.name }))
)
const agentUpdateCount = computed(() => {
  const rows = agentUpdateInfo.value ? Object.values(agentUpdateInfo.value.agents || {}) : []
  return rows.filter((r) => r.update).length
})

function applyAgentUpdateInfo(r, { announce = true } = {}) {
  if (!r || !r.agents) return
  agentUpdateInfo.value = { checkedAt: r.checkedAt, agents: r.agents }
  // Told once per new version (the main process remembers which).
  const found = announce && Array.isArray(r.newlyFound) ? r.newlyFound : []
  if (!found.length) return
  const list = found.map((f) => `${f.name} ${f.installed} → ${f.latest}`).join(', ')
  inboxNote('info', found.length === 1 ? t('app.agentUpdate.availableFor', 'Update available for {{name}}', { name: found[0].name }) : t('app.agentUpdate.availableCount', '{{count}} agent updates available', { count: found.length }), list, null)
  showToast(found.length === 1 ? t('app.agentUpdate.availableOne', 'Agent update available: {{list}}.', { list }) : t('app.agentUpdate.availableMany', 'Agent updates available: {{list}}.', { list }), {
    kind: 'attention',
    timeout: 12000,
    action: { label: t('app.common.show', 'Show'), run: () => openSettingsAt('agents') }
  })
}
async function checkAgentUpdates({ force = true, quiet = false } = {}) {
  const api = window.shellApi.agentUpdates
  if (!api) return null
  const r = await api.check({ force }).catch((err) => ({ error: err && err.message }))
  if (r && r.error && !quiet) showToast(t('app.agentUpdate.checkFailed', 'Could not check for agent updates: {{error}}', { error: r.error }), { kind: 'error', timeout: 8000 })
  if (r && !r.error && !quiet) {
    const n = Object.values(r.agents || {}).filter((a) => a.update).length
    if (!n) showToast(t('app.agentUpdate.upToDate', 'Your agents are up to date.'), { timeout: 4000 })
  }
  return r
}
if (window.shellApi.agentUpdates) {
  window.shellApi.agentUpdates.status().then((r) => r && applyAgentUpdateInfo(r, { announce: false })).catch(() => {})
  const off = window.shellApi.agentUpdates.onChanged((r) => applyAgentUpdateInfo(r))
  onBeforeUnmount(() => off && off())
  // The update history (Settings > Agents), kept by the main process.
  if (window.shellApi.agentUpdates.history) {
    window.shellApi.agentUpdates.history().then((h) => h && (agentUpdateHistory.value = h)).catch(() => {})
    const offHistory = window.shellApi.agentUpdates.onHistory((h) => h && (agentUpdateHistory.value = h))
    onBeforeUnmount(() => offHistory && offHistory())
  }
}

function logUpdate(level, text) {
  if (window.shellApi.log) window.shellApi.log(level, `agent update: ${text}`)
}

// Update one agent (Update button, Update all, or automatically). A job:
// { agentId, name, phase, from, target, via, paneId, retried, paused,
//   waiting, manual, auto, toldWaiting, kind, detail, file, inUse }. Phases:
// updating, waiting-stop (its files are locked: waiting until every pane
// running it may be stopped), retrying (stopped, updating again), restarting
// (updated; panes waiting for a safe moment to restart), done, failed.
// via: 'background' (the main process runs it, no pane: agentUpdateRunner.js)
// or 'pane' (Run in a terminal, for troubleshooting).
async function startAgentUpdate(agentId, { auto = false, pane = false } = {}) {
  const row = agentUpdateInfo.value && agentUpdateInfo.value.agents[agentId]
  if (!row || !row.update || !Array.isArray(row.steps) || !row.steps.length) return false
  const job = agentUpdateJobs[agentId]
  if (job && !['done', 'failed'].includes(job.phase)) {
    if (!auto) showToast(t('app.agentUpdate.already', '{{name}} is already being updated.', { name: row.name }), { timeout: 4000 })
    return false
  }
  const background = !pane && !!(window.shellApi.agentUpdates && window.shellApi.agentUpdates.run)
  agentUpdateJobs[agentId] = {
    agentId,
    name: row.name,
    phase: 'updating',
    from: row.installed,
    target: row.latest,
    via: background ? 'background' : 'pane',
    startedAt: Date.now(),
    paneId: null,
    retried: false,
    paused: [],
    waiting: [],
    manual: [],
    auto,
    toldWaiting: false
  }
  logUpdate('info', `${row.name} ${row.installed} -> ${row.latest}${auto ? ' (automatic)' : ''}${background ? '' : ' (in a pane)'}`)
  let ok = false
  try {
    ok = await runUpdate(agentId)
  } catch (err) {
    logUpdate('error', `${row.name}: ${err && err.message}`)
  }
  if (!ok) {
    Object.assign(agentUpdateJobs[agentId], {
      phase: 'failed',
      error: background ? t('app.agentUpdate.err.noStart', 'it could not be started') : t('app.agentUpdate.err.noPane', 'could not open a pane')
    })
    return false
  }
  return true
}
// Run (or run again, after its panes were stopped) the job's update, the way
// it was started. -> true once it runs.
function runUpdate(agentId) {
  const job = agentUpdateJobs[agentId]
  return job && job.via === 'pane' ? runUpdatePane(agentId) : runUpdateBackground(agentId)
}
// In the background: the main process runs it; its result comes back here.
async function runUpdateBackground(agentId) {
  const job = agentUpdateJobs[agentId]
  const api = window.shellApi.agentUpdates
  if (!job || !api || !api.run) return false
  job.phase = job.retried ? 'retrying' : 'updating'
  if (!job.retried && !job.auto)
    showToast(t('app.agentUpdate.updatingBackground', 'Updating {{name}} in the background. Tessel tells you when it has finished.', { name: job.name }), { timeout: 5000 })
  api
    .run({ agentId, auto: !!job.auto })
    .catch((err) => ({ ok: false, kind: 'failed', reason: (err && err.message) || '' }))
    .then((r) => {
      job.file = (r && r.file) || job.file || null
      if (r && r.kind === 'busy') {
        // Another run was going on in the main process (not one this window
        // started): try again later with Update.
        job.phase = 'failed'
        job.error = t('app.agentUpdate.err.busy', 'another agent was being updated')
        return
      }
      return onAgentUpdateResult(agentId, r || { ok: false })
    })
    .catch((err) => logUpdate('error', `${job.name}: ${err && err.message}`))
    .finally(() => startQueuedUpdate())
  return true
}
async function runUpdatePane(agentId) {
  const job = agentUpdateJobs[agentId]
  const row = agentUpdateInfo.value && agentUpdateInfo.value.agents[agentId]
  if (!job || !row) return false
  const shellId = selectedShell.value
  const leaf = await openPaneBelow(shellId)
  if (!leaf) return false
  const label = t('app.agentUpdate.paneTitle', 'Update {{name}}', { name: row.name })
  leaf.title = label
  job.paneId = leaf.id
  installRuns[leaf.id] = { label, agent: null, update: agentId }
  // Plain strings (a reactive array cannot be sent to the main process).
  const steps = Array.from(row.steps, String)
  const agentUpdate = { agentId, from: String(job.from || ''), to: String(job.target || '') }
  if (window.shellApi.installLogStart) {
    await window.shellApi.installLogStart({ paneId: leaf.id, name: label, shell: shellId, steps, agentUpdate }).catch(() => {})
  }
  const line = installChain(steps, null, shellId)
  setTimeout(() => window.shellApi.writePty(leaf.id, `${line}\r`), 700)
  if (!job.retried) showToast(t('app.agentUpdate.updating', 'Updating {{name}} below. Tessel tells you when it has finished.', { name: row.name }), { timeout: 6000 })
  return true
}

// Open an update's log in Tessel's editor (with the system's app when there
// is no workspace to show it in).
function openUpdateLog(file) {
  if (!file) return
  closeSettings()
  if (!openInTesselEditor({ file, preview: true })) window.shellApi.openInstallLog(file)
}
function logAction(file) {
  return file ? { label: t('app.common.openLog', 'Open log'), run: () => openUpdateLog(file) } : null
}
// Files in use by panes Tessel runs: stop them when idle, update again,
// reopen them with their conversation (the waiting-stop flow).
function closeAndReopenForUpdate(agentId) {
  const job = agentUpdateJobs[agentId]
  if (!job || job.phase !== 'failed' || !job.inUse) return
  job.inUse = false
  job.error = ''
  job.phase = 'waiting-stop'
  job.toldWaiting = false
  const queued = updateQueue.indexOf(agentId)
  if (queued >= 0) updateQueue.splice(queued, 1)
  logUpdate('info', `${job.name}: closing and reopening its panes to finish the update`) // i18n-ignore
  agentUpdateTick()
}

// The update ended (background: the main process's answer; pane:
// installLog.js told the result). r: { ok, kind?, detail?, reason, file,
// locked?, row? }.
async function onAgentUpdateResult(agentId, r) {
  const job = agentUpdateJobs[agentId]
  if (!job) return
  job.file = r.file || job.file || null
  job.kind = r.kind || (r.ok === true ? 'ok' : r.locked ? 'in-use' : 'failed')
  job.detail = r.detail || ''
  if (r.ok === true) {
    await loadAgents(true)
    // The main process checked the version after a background update.
    const res = r.row ? null : await checkAgentUpdates({ force: false, quiet: true })
    const row = r.row || (res && res.agents ? res.agents[agentId] : null)
    const version = (row && row.installed) || job.target
    job.version = version
    // The command succeeded but the version it reports did not change (a
    // copy elsewhere on PATH runs first, or the update did nothing): no pane
    // is restarted for nothing; stopped ones are relaunched as they were.
    if (row && row.installed && job.from && row.installed === job.from) {
      logUpdate('warn', `${job.name}: the update finished but it still reports ${version}`) // i18n-ignore
      if (job.paused.length) await relaunchPaused(job, 'resumed (still on the same version)', t('app.agentUpdate.what.sameVersion', 'resumed (still on the same version)')) // i18n-ignore
      job.phase = 'failed'
      job.kind = 'same-version'
      job.error = t('app.agentUpdate.err.sameVersion', 'the update finished, but {{name}} still reports {{version}}', { name: job.name, version })
      const text = `${t('app.agentUpdate.sameVersion', 'The update of {{name}} finished, but it still reports version {{version}}.', { name: job.name, version })} ${job.report || ''}`.trim()
      inboxNote('attention', t('app.agentUpdate.notUpdatedTitle', '{{name}} was not updated', { name: job.name }), text, null)
      showToast(text, { kind: 'attention', timeout: 15000, action: logAction(r.file) })
      return
    }
    logUpdate('info', `${job.name} updated to ${version}`) // i18n-ignore
    if (job.paused.length) {
      await relaunchPaused(job, `updated to ${version} and resumed`, t('app.agentUpdate.what.updated', 'updated to {{version}} and resumed', { version })) // i18n-ignore
      job.phase = 'done'
      inboxNote('done', t('app.agentUpdate.updatedTo', '{{name}} updated to {{version}}', { name: job.name, version }), job.report || '', null)
      return
    }
    // Panes running the old version: restarted in place when each is safe.
    const plan = updatePlanFor(agentId)
    for (const id of plan.running) if (!plan.manual.some((m) => m.id === id)) restartAfterUpdate[id] = { agentId, version }
    job.manual = plan.manual
    job.phase = plan.running.length > plan.manual.length ? 'restarting' : 'done'
    const manualList = plan.manual.map((m) => m.label).join(', ')
    const tail = plan.manual.length
      ? ' ' +
        (plan.manual.length === 1
          ? t('app.agentUpdate.manualOne', '{{list}} still runs the old version: restart it yourself when it suits you (no conversation Tessel can resume).', { list: manualList })
          : t('app.agentUpdate.manualMany', '{{list}} still run the old version: restart them yourself when it suits you (no conversation Tessel can resume).', { list: manualList }))
      : ''
    showToast(
      t('app.agentUpdate.updatedToDot', '{{name}} updated to {{version}}.', { name: job.name, version }) +
        (job.phase === 'restarting' ? ' ' + t('app.agentUpdate.panesRestart', 'Its panes restart with their conversation as soon as each is idle.') : '') +
        tail,
      {
        timeout: tail ? 15000 : 7000
      }
    )
    inboxNote('done', t('app.agentUpdate.updatedTo', '{{name}} updated to {{version}}', { name: job.name, version }), tail.trim(), null)
    agentUpdateTick()
    return
  }
  // Its files are in use by the agents running it: stop them (when safe),
  // update again, relaunch them. Asked first (a button), unless the update
  // is automatic (you chose that it happens by itself at a safe moment).
  if ((r.locked || job.kind === 'in-use') && !job.retried) {
    job.kind = 'in-use'
    const plan = updatePlanFor(agentId)
    const title = t('app.agentUpdate.notUpdatedTitle', '{{name}} was not updated', { name: job.name })
    if (!plan.running.length) {
      job.phase = 'failed'
      job.error = t('app.agentUpdate.err.inUseOutside', 'its files are in use by a program outside Tessel')
      const text = updateFailureText('in-use', job.name, { panes: 0 })
      inboxNote('attention', title, text, null)
      showToast(text, { kind: 'error', timeout: 20000, action: logAction(r.file) })
      return
    }
    if (plan.manual.length) {
      job.phase = 'failed'
      job.manual = plan.manual
      job.error = t('app.agentUpdate.err.inUse', 'its files are in use')
      const list = plan.manual.map((m) => m.label).join(', ')
      const text =
        plan.manual.length === 1
          ? t('app.agentUpdate.inUseManualOne', '{{name}} was not updated: its files are in use by {{list}}, which Tessel cannot restart without losing its conversation. Close it, then click Update again.', { name: job.name, list })
          : t('app.agentUpdate.inUseManualMany', '{{name}} was not updated: its files are in use by {{list}}, which Tessel cannot restart without losing their conversation. Close them, then click Update again.', { name: job.name, list })
      inboxNote('attention', title, text, null)
      showToast(text, { kind: 'error', timeout: 20000 })
      return
    }
    if (!job.auto) {
      job.phase = 'failed'
      job.inUse = true
      job.error = t('app.agentUpdate.err.inUsePanes', 'its files are in use by its panes')
      const text = updateFailureText('in-use', job.name, { panes: plan.running.length })
      inboxNote('attention', title, text, null)
      showToast(text, {
        kind: 'attention',
        timeout: 30000,
        action: { label: t('app.agentUpdate.closeReopen', 'Close and reopen them'), run: () => closeAndReopenForUpdate(agentId) }
      })
      return
    }
    job.phase = 'waiting-stop'
    logUpdate('info', `${job.name}: files in use; waiting to stop ${plan.running.length} pane(s) safely`) // i18n-ignore
    showToast(
      plan.running.length === 1
        ? t('app.agentUpdate.stopOne', "{{name}}'s files are in use by its running agents. Tessel stops it when idle, updates, then resumes its conversation.", { name: job.name })
        : t('app.agentUpdate.stopMany', "{{name}}'s files are in use by its running agents. Tessel stops them when idle, updates, then resumes each conversation.", { name: job.name }),
      { timeout: 9000 }
    )
    agentUpdateTick()
    return
  }
  job.phase = 'failed'
  const why = updateFailureText(job.kind, job.name, { panes: 0 })
  job.error = r.ok === false ? updateKindLabel(job.kind) : t('app.agentUpdate.err.unfinished', 'the update did not finish')
  if (job.paused.length) await relaunchPaused(job, 'resumed (not updated)', t('app.agentUpdate.what.notUpdated', 'resumed (not updated)')) // i18n-ignore
  const text = `${t('app.agentUpdate.notUpdatedShort', '{{name}} was not updated.', { name: job.name })} ${why}${job.report ? ` ${job.report}` : ''}`
  inboxNote('attention', t('app.agentUpdate.notUpdatedTitle', '{{name}} was not updated', { name: job.name }), `${why}${job.detail ? `\n${job.detail}` : ''}`, null)
  showToast(text, { kind: 'error', timeout: 20000, action: logAction(r.file) })
}

// Stop every pane running this agent (each checked safe at this very
// moment), wait until their processes really ended, then update again.
// They are relaunched once it ends, whatever the result. If one does not
// end in time: no update and no relaunch; they stay stopped for you to
// restart (agentUpdateRetry.js).
async function stopAndRetryUpdate(job) {
  const plan = updatePlanFor(job.agentId)
  if (!plan.allReady || plan.manual.length) return
  // Nothing else restarts or types into them meanwhile.
  for (const id of plan.ready) restartingLeaves.add(id)
  const label = (id) => paneLabel(findLeaf(id))
  await stopThenRetry(job, plan.ready, {
    stopAndWait: (ids, timeoutMs) => window.shellApi.stopPtysAndWait(ids, timeoutMs),
    runUpdate: () => runUpdate(job.agentId),
    relaunch: relaunchPaused,
    release: (ids) => ids.forEach((id) => restartingLeaves.delete(id)),
    log: logUpdate,
    label,
    onStuck: (r) => {
      const text = stuckMessage(r, label)
      inboxNote('attention', t('app.agentUpdate.notUpdatedTitle', '{{name}} was not updated', { name: job.name }), text, r.stuck[0] || null)
      showToast(text, {
        kind: 'error',
        timeout: 30000,
        action: {
          label: t('app.common.restart', 'Restart'),
          // Same pane, conversation resumed (its session id is kept).
          run: async () => {
            for (const id of r.stopped) if (findLeaf(id)) await restartInPlace(id, { resume: true })
          }
        }
      })
    }
  })
}

// Relaunch the panes stopped for an update, in place, conversation resumed.
// what: for the log (English); whatText: the same, for the person.
async function relaunchPaused(job, what, whatText = what) {
  const done = []
  const failed = []
  for (const id of job.paused) {
    restartingLeaves.delete(id)
    const leaf = findLeaf(id)
    if (!leaf) continue
    const label = paneLabel(leaf)
    const ok = await restartInPlace(id, { resume: true })
    ;(ok ? done : failed).push(label)
    logUpdate(ok ? 'info' : 'error', `${label} ${ok ? what : 'could not be relaunched'}`)
    if (ok) showToast(t('app.agentUpdate.relaunched', '{{list}} {{what}}.', { list: label, what: whatText }), { timeout: 7000 })
  }
  job.paused = []
  const failedList = failed.join(', ')
  job.report = [
    done.length ? t('app.agentUpdate.relaunched', '{{list}} {{what}}.', { list: done.join(', '), what: whatText }) : '',
    failed.length
      ? failed.length === 1
        ? t('app.agentUpdate.relaunchFailedOne', '{{list}} could not be relaunched: use Restart on it.', { list: failedList })
        : t('app.agentUpdate.relaunchFailedMany', '{{list}} could not be relaunched: use Restart on them.', { list: failedList })
      : ''
  ]
    .filter(Boolean)
    .join(' ')
  if (failed.length)
    showToast(
      failed.length === 1
        ? t('app.agentUpdate.relaunchAfterFailedOne', '{{list}} could not be relaunched after the update: use Restart on it.', { list: failedList })
        : t('app.agentUpdate.relaunchAfterFailedMany', '{{list}} could not be relaunched after the update: use Restart on them.', { list: failedList }),
      { kind: 'error', timeout: 12000 }
    )
}

async function agentUpdateTick() {
  if (updateTickBusy) return
  updateTickBusy = true
  try {
    if (updateQueue.length) await startQueuedUpdate()
    const now = Date.now()
    // Panes still on the old version: one restart per tick, when safe.
    for (const id of Object.keys(restartAfterUpdate)) {
      const q = restartAfterUpdate[id]
      const leaf = findLeaf(id)
      const ws = leaf && wsOfLeaf(id)
      // Closed, asleep (it wakes on the new version) or another agent now.
      if (!leaf || !ws || leaf.sleeping || leaf.agentId !== q.agentId) {
        delete restartAfterUpdate[id]
        continue
      }
      const why = paneUpdateBlocker(leaf, ws, now)
      q.why = why
      if (why) continue
      delete restartAfterUpdate[id]
      const label = paneLabel(leaf)
      const ok = await restartInPlace(id, { resume: true })
      logUpdate(ok ? 'info' : 'error', `${label} ${ok ? `restarted on ${q.version}, conversation resumed` : 'could not be restarted'}`) // i18n-ignore
      if (ok) {
        showToast(t('app.agentUpdate.paneResumedDot', '{{pane}} updated to {{version}} and resumed.', { pane: label, version: q.version }), { timeout: 7000 })
        inboxNote('done', t('app.agentUpdate.paneResumed', '{{pane}} updated to {{version}} and resumed', { pane: label, version: q.version }), '', id)
      } else showToast(t('app.agentUpdate.paneRestartFailed', '{{pane}} could not be restarted on the new version: use Restart on it.', { pane: label }), { kind: 'error', timeout: 10000 })
      break
    }
    for (const job of Object.values(agentUpdateJobs)) {
      if (job.phase === 'restarting') {
        const left = Object.entries(restartAfterUpdate).filter(([, q]) => q.agentId === job.agentId)
        job.waiting = left.map(([id, q]) => ({ id, label: paneLabel(findLeaf(id)), why: q.why || 'waiting' }))
        if (!left.length) job.phase = 'done'
        else if (!job.toldWaiting && left.every(([, q]) => q.why)) {
          job.toldWaiting = true
          showToast(t('app.agentUpdate.waitingRestart', '{{name}} is updated. Waiting to restart: {{list}}.', { name: job.name, list: describeWaiting(job.waiting) }), { timeout: 9000 })
        }
      } else if (job.phase === 'waiting-stop') {
        const plan = updatePlanFor(job.agentId)
        job.waiting = plan.waiting
        if (!plan.running.length || (plan.allReady && !plan.manual.length)) {
          await stopAndRetryUpdate(job)
        } else if (!job.toldWaiting) {
          job.toldWaiting = true
          showToast(t('app.agentUpdate.waitsFor', '{{name}} update waits for: {{list}}.', { name: job.name, list: describeWaiting(plan.waiting) }), { timeout: 9000 })
        }
      }
    }
    // Automatic updates (off by default): one agent at a time, at a safe
    // moment, each new version tried once.
    if (settings.autoUpdateAgents && agentUpdateInfo.value && !Object.values(agentUpdateJobs).some((j) => !['done', 'failed'].includes(j.phase))) {
      const lastAnyKey = Math.max(0, ...Object.values(lastUserKey))
      for (const row of Object.values(agentUpdateInfo.value.agents || {})) {
        if (!row.update || autoUpdateTried[row.id] === row.latest) continue
        const why = autoUpdateMoment({ plan: updatePlanFor(row.id), lastAnyKey, now })
        if (why) continue
        autoUpdateTried[row.id] = row.latest
        await startAgentUpdate(row.id, { auto: true })
        break
      }
    }
  } finally {
    updateTickBusy = false
  }
}
const agentUpdateTimer = setInterval(agentUpdateTick, UPDATE_TICK_MS)
onBeforeUnmount(() => clearInterval(agentUpdateTimer))

// Update all: one npm install at a time (two at once can clash in npm's
// global folder); the next starts when the previous pane has finished.
const updateQueue = reactive([]) // agent ids waiting for their turn
function updateRunning() {
  return Object.values(agentUpdateJobs).some((j) => ['updating', 'retrying', 'waiting-stop'].includes(j.phase))
}
async function updateAllAgents() {
  const rows = agentUpdateInfo.value ? Object.values(agentUpdateInfo.value.agents || {}).filter((r) => r.update) : []
  for (const r of rows) if (!updateQueue.includes(r.id)) updateQueue.push(r.id)
  await startQueuedUpdate()
}
const updateInPane = new Set() // queued ids to run in a pane (Run in a terminal)
async function startQueuedUpdate() {
  while (updateQueue.length && !updateRunning()) {
    const id = updateQueue.shift()
    await startAgentUpdate(id, { pane: updateInPane.delete(id) })
  }
}
// The Update button of one agent (in the background), or its Run in a
// terminal (pane: true, to see the output as it goes).
async function requestAgentUpdate(agentId, { pane = false } = {}) {
  const job = agentUpdateJobs[agentId]
  if (updateQueue.includes(agentId) || (job && !['done', 'failed'].includes(job.phase))) return
  if (pane) updateInPane.add(agentId)
  updateQueue.push(agentId)
  if (updateRunning()) showToast(t('app.agentUpdate.queued', 'Another agent is being updated: this one follows.'), { timeout: 4000 })
  await startQueuedUpdate()
}
// Stop waiting (the update itself, if it already ran, stays).
function cancelAgentUpdate(agentId) {
  const job = agentUpdateJobs[agentId]
  if (!job) return
  for (const id of Object.keys(restartAfterUpdate)) if (restartAfterUpdate[id].agentId === agentId) delete restartAfterUpdate[id]
  if (job.phase === 'waiting-stop' || job.phase === 'restarting') {
    job.phase = job.phase === 'restarting' ? 'done' : 'failed'
    job.error = job.phase === 'failed' ? t('app.agentUpdate.err.cancelled', 'cancelled') : job.error
    job.waiting = []
  }
}

// Team messages are NOT typed into terminals any more: the user works in those
// same terminals, and typing there interfered with them. Messages stay on
// disk (pending) until they reach agents another way.
const TEAM_MESSAGES_IN_TERMINALS = false

// Messages between agents go in the Activity timeline (who to whom, the
// text, read or not yet), so you can follow what the team says to itself.
// Each channel message is logged once (msgId), then marked read when its
// recipient has read it. Tessel's own delivery receipts are left out.
let teamMsgEvents = null // msgId -> activity event (built once the log is loaded)
function logTeamMessages(team, res) {
  if (!activityLoaded || !Array.isArray(res.history)) return
  if (!teamMsgEvents) {
    teamMsgEvents = new Map()
    for (const e of activity) if (e.type === 'message' && e.msgId) teamMsgEvents.set(e.msgId, e)
  }
  const who = (id) => {
    const leaf = findLeaf(id)
    if (leaf) return paneLabel(leaf)
    const p = (res.participants || []).find((x) => x.id === id)
    return p ? `${p.num ? `#${p.num} ` : ''}${p.title || t('app.pane.agent', 'Agent')}` : t('app.task.anAgent', 'An agent')
  }
  let changed = false
  for (const m of res.history) {
    if (!m || !m.id || typeof m.text !== 'string' || m.fromId === 'tessel') continue
    const read = m.status === 'delivered'
    const known = teamMsgEvents.get(m.id)
    if (known) {
      if (read && known.status !== 'read') {
        known.status = 'read'
        changed = true
      }
      continue
    }
    const to = findLeaf(m.toId)
    const event = {
      t: m.createdAt || Date.now(),
      type: 'message',
      msgId: m.id,
      paneId: m.toId,
      agent: to ? agentInfo(to) : { title: who(m.toId), agentId: null },
      status: read ? 'read' : 'unread',
      source: 'agent',
      from: who(m.fromId),
      scope: 'team-chat',
      teamId: team.id,
      wsId: teamWsId(team.id),
      preview: m.text.replace(/\s+/g, ' ').slice(0, 160),
      text: m.text.slice(0, 8000)
    }
    recordActivity(event)
    teamMsgEvents.set(m.id, activity[activity.length - 1])
  }
  if (changed) activityChanged()
}

// The task board for the agents of a team (team_tasks / team_task_add /
// team_task_move, src/main/teamTasks.js): their requests are applied here,
// Tessel being the board's only writer, and the team's cards (those of its
// workspace) are published back for them to read. A refused request is
// told to its agent in the background.
function syncTeamBoard(team, dir, members, round = teamRound) {
  writeTeamRoster(team, dir, members)
  return syncBoard({ key: team.id, dir, target: { teamId: team.id }, wsId: teamWsId(team.id), members, teamId: team.id }, round)
}

// Agents in no team use their workspace's board the same way
// (.tessel/board/<workspace>, see src/main/teamTasks.js): Tessel says which
// agents work alone where, applies their requests and publishes the cards.
const soloBoardsSeen = new Set() // workspaces whose board was published
async function syncSoloBoards(round) {
  if (!window.shellApi.team || !window.shellApi.team.boardPanes) return
  const byDir = {}
  for (const ws of workspaces.value) {
    if (!ws.cwd) continue
    const solo = []
    forEachLeaf(ws.tree, (l) => {
      if (l.kind === 'agent' && l.num && !(l.team && teamById(l.team))) solo.push(l)
    })
    const panes = (byDir[ws.cwd] = byDir[ws.cwd] || {})
    for (const l of solo) panes[l.id] = { ws: ws.id, num: l.num }
    if (!solo.length && !soloBoardsSeen.has(ws.id)) continue
    soloBoardsSeen.add(ws.id)
    await syncBoard({ key: `ws/${ws.id}`, dir: ws.cwd, target: { board: ws.id }, wsId: ws.id, members: solo, teamId: null }, round) // i18n-ignore
    if (roundGone(round)) return
  }
  for (const [dir, panes] of Object.entries(byDir)) {
    await window.shellApi.team.boardPanes({ dir, panes })
    if (roundGone(round)) return
  }
}

// --- Orchestration on the board --------------------------------------------------
// A card's report (team_task_done): kept on the card; succeeded moves it to
// Done. Whoever gave the card is told, in the background.
function applyReport(task, r, from, teamId) {
  // Kept on the card; but a card that still waits (cards before it, your
  // decision) does not go to Done on a report.
  const blocked = r.outcome === 'succeeded' && blockedReason(task)
  updateTask(task.id, {
    report: { outcome: r.outcome, summary: r.summary, files: r.files || [], by: from.id, at: Date.now() },
    ...(r.outcome === 'succeeded' && !blocked ? { column: 'done' } : {})
  })
  if (blocked && teamId && from.team === teamId)
    tellAgents([from], `[Tessel] Your report on card ${task.id} is kept, but the card stays in ${task.column}: ${blocked}.`, teamId) // i18n-ignore
  recordActivity({
    type: 'task',
    action: 'reported',
    paneId: from.id,
    agent: agentInfo(from),
    title: task.title,
    wsId: task.wsId,
    by: paneLabel(from),
    detail: r.outcome === 'succeeded' ? 'succeeded' : 'failed'
  })
  const giver = task.createdBy && task.createdBy !== from.id ? findLeaf(task.createdBy) : null
  if (giver && teamId && giver.team === teamId) {
    const files = r.files && r.files.length ? `
Files: ${r.files.slice(0, 20).join(', ')}${r.files.length > 20 ? ' …' : ''}` : '' // i18n-ignore
    tellAgents([giver], `[Tessel] ${paneLabel(from)} finished card ${task.id} "${task.title}": ${r.outcome}.
${r.summary}${files}`, teamId) // i18n-ignore
  }
  if (r.outcome === 'failed') {
    inboxNote('attention', t('app.board.couldNotFinish', '{{pane}} could not finish "{{title}}"', { pane: paneLabel(from), title: task.title }), r.summary.slice(0, 200), from.id)
  }
}

// A decision only the user makes (team_task_gate): shown on the card with
// its choices; the answer goes back to the agent that asked.
function askDecision(task, r, from) {
  updateTask(task.id, { gate: { question: r.question, options: r.options || [], status: 'pending', by: from.id, askedAt: Date.now() } })
  recordActivity({ type: 'task', action: 'gate', paneId: from.id, agent: agentInfo(from), title: task.title, wsId: task.wsId, by: paneLabel(from), detail: r.question })
  const needs = t('app.board.needsDecision', '{{pane}} needs your decision', { pane: paneLabel(from) })
  inboxNote('attention', needs, r.question, from.id)
  const text = t('app.board.needsDecisionOn', '{{pane}} needs your decision on "{{title}}": {{question}}', { pane: paneLabel(from), title: task.title, question: r.question })
  if (document.hasFocus() && settings.inAppAlerts)
    showToast(text, { kind: 'attention', timeout: 12000, action: { label: t('app.board.showBoard', 'Show the board'), run: () => showSideTab('tasks') } })
  nativeNotify({ title: needs, body: r.question, paneId: from.id })
}

function resolveDecision(taskId, answer) {
  const task = boardTasks.find((t) => t.id === taskId)
  const text = String(answer || '').trim()
  if (!task || !task.gate || task.gate.status !== 'pending' || !text) return
  updateTask(task.id, { gate: { ...task.gate, status: 'resolved', answer: text.slice(0, 500), resolvedAt: Date.now() } })
  recordActivity({ type: 'task', action: 'decided', paneId: task.gate.by, title: task.title, wsId: task.wsId, detail: text })
  const asker = task.gate.by ? findLeaf(task.gate.by) : null
  if (asker) {
    const msg = `[Tessel] The user decided on card ${task.id} "${task.title}" (${task.gate.question}): ${text}` // i18n-ignore
    if (asker.team && teamById(asker.team)) tellAgents([asker], msg, asker.team)
    // Alone (no team channel): nothing is typed into its terminal; you
    // pass it on (the text is copied).
    else {
      if (navigator.clipboard) navigator.clipboard.writeText(msg.replace(/^\[Tessel\] /, '')).catch(() => {})
      showToast(t('app.board.tellDecision', 'Tell {{name}} your decision (copied): {{text}}', { name: asker.title, text }), {
        timeout: 12000,
        action: { label: t('app.common.show', 'Show'), run: () => focusPane(asker.id) }
      })
    }
  }
  scheduleTaskSave()
}
provide('resolveDecision', resolveDecision)

// --- Orchestration: coordinators and workers --------------------------------------
// A team's lead starts workers in new panes (team_worker_start and the other
// worker tools); src/renderer/src/orchestrator.js keeps their records
// (team.workers), limits and queue. Here: how Tessel does each step.
const workersSigs = {} // team id -> the workers list last published
// A task's own copy of the project (git worktree), for a worker or an
// automation's run. -> { worktree } | { error }
async function makeTaskCopy(ws, title) {
  const res = await window.shellApi.createWorktree(ws.cwd, title, worktreeSettings()).catch((err) => ({ ok: false, error: err && err.message }))
  if (!res || !res.ok) return { error: (res && res.error) || t('app.common.unknownError', 'unknown error') }
  if (res.setup && res.setup.ran && !res.setup.ok)
    showToast(t('app.task.setupFailed', 'The copy is ready, but .tessel/setup.ps1 failed: {{error}}.', { error: res.setup.error || t('app.task.seeScript', 'see the script') }), { kind: 'error', timeout: 9000 })
  return { worktree: { path: res.path, branch: res.branch, baseBranch: res.baseBranch || null, root: res.root || ws.cwd } }
}
// A new pane in a workspace (its largest pane is split), launched with the
// user's settings for that agent (permissions, Yolo, account): a worker, or
// an automation's run. The pane you are in stays the active one.
async function openBackgroundAgentPane({ ws, agent, worktree, launchOptions, automationLaunch = null }) {
  if (!workspaces.value.includes(ws)) return null
  const keep = ws.activeId
  const target = ws.tree ? largestLeaf(ws.tree) : null
  const extra = { launchOptions, ...(automationLaunch ? { automationLaunch } : {}) }
  const leaf =
    target && target.id
      ? await splitLeaf(target.id, target.dir, agent, selectedShell.value, worktree, extra)
      : await createLeaf(selectedShell.value, agent, ws.cwd, worktree, wsLeafOpts(ws, extra))
  if (!leaf) return null
  if (!ws.tree) {
    ws.tree = leaf
    ws.activeId = leaf.id
  } else if (keep && findLeaf(keep)) ws.activeId = keep
  numberPanes()
  return leaf
}
const orchestrator = createOrchestrator({
  settings,
  // One scheduler for every team (the global cap and queue).
  teams: () => teams.value,
  findLeaf,
  label: paneLabel,
  isLead: (team, id) => team.leadId === id && !!teamLead(team.id),
  wsOfLeaf,
  agentAvailable: (id) => (launchableAgents.value.some((a) => a.id === id && a.available !== false) ? agentById(id) : null),
  cardColumn: (id) => boardTasks.find((x) => x.id === id)?.column ?? null,
  createCard({ title, brief, wsId, by, teamId, deps, workerId }) {
    // On the team's board (the one its tools read).
    const task = addTask({ title, wsId: teamWsId(teamId) || wsId })
    updateTask(task.id, { brief, column: 'todo', createdBy: by, teamId, worker: workerId, ...(deps && deps.length ? { deps: [...deps] } : {}) })
    scheduleTaskSave()
    return task.id
  },
  updateCard(id, patch) {
    const task = boardTasks.find((x) => x.id === id)
    if (!task) return
    updateTask(id, patch.column === 'doing' && task.column !== 'doing' ? { ...patch, startedAt: Date.now(), doingSince: Date.now() } : patch)
    scheduleTaskSave()
  },
  removeCard(id) {
    if (boardTasks.some((x) => x.id === id)) removeTask(id)
  },
  reportCard(id, report, from, teamId) {
    const task = boardTasks.find((x) => x.id === id)
    if (!task) return
    applyReport(task, report, from, teamId)
    // Its own copy: the work waits in Review for the user to merge it.
    if (report.outcome === 'succeeded' && task.worktree && !task.mergedAt && task.column === 'done') updateTask(task.id, { column: 'review', doneAt: Date.now() })
    scheduleTaskSave()
  },
  createWorktree: makeTaskCopy,
  openWorkerPane: openBackgroundAgentPane,
  async joinTeam(leaf, team) {
    leaf.team = team.id
    logMembership(leaf, team.id)
    await syncChannel(team, { quiet: [leaf.id] })
    await publishCurrentTeams()
  },
  closePane: (id, { byUser } = {}) => closeLeaf(id, byUser ? {} : { force: true }),
  notice: (leaves, text, teamId) => noticeAgents(leaves, text, teamId),
  // Sealed in the main process for the requester only (src/main/teamAuth.js).
  answer(team, rid, ok, text, toId) {
    const dir = channelDir(team)
    if (dir && window.shellApi.team && window.shellApi.team.answer) window.shellApi.team.answer({ dir, teamId: team.id, rid, ok, text, toId }).catch(() => {})
  },
  readScreen(id, lines) {
    const pane = findLeaf(id) ? getPane(id) : null
    return pane && pane.screenText ? pane.screenText(Math.max(20, lines)) : null
  },
  activity(e) {
    recordActivity({ ...e, agent: agentInfo(findLeaf(e.paneId)) })
  },
  attention(title, body, paneId) {
    inboxNote('attention', title, body, paneId)
    nativeNotify({ title, body, paneId })
  },
  toast(text, opts = {}) {
    showToast(text, {
      kind: opts.kind,
      timeout: opts.timeout,
      ...(opts.showTasks ? { action: { label: t('app.board.showBoard', 'Show the board'), run: () => showSideTab('tasks') } } : {})
    })
  },
  publish(team, payload) {
    const dir = channelDir(team)
    if (!dir || !window.shellApi.team || !window.shellApi.team.workers) return
    const sig = JSON.stringify(payload)
    if (workersSigs[team.id] === sig) return
    // Only when it changed: remembered once written.
    window.shellApi.team
      .workers({ dir, teamId: team.id, ...JSON.parse(sig) })
      .then((res) => {
        if (res && res.ok) workersSigs[team.id] = sig
      })
      .catch(() => {})
  }
})

// --- Scheduled automations -------------------------------------------------------
// The scheduler runs in the main process (src/main/automations.js) while
// Tessel is open; here each run opens its agent's pane like a worker's (a
// new pane in the project, the user's settings for that agent, its first
// prompt on the command line) with a card on the board (automationRunner.js).
function automationWorkspace(a) {
  const ws = wsById(a.wsId)
  if (!ws) return null
  if (a.remote) return ws.remote && ws.remote.hostId === a.remote.hostId && ws.remote.path === a.remote.path ? ws : null
  return !ws.remote && ws.cwd && samePath(ws.cwd, a.projectCwd) ? ws : null
}
function automationAgent(id) {
  if (!AUTOMATION_AGENTS.includes(id)) return null
  return launchableAgents.value.some((a) => a.id === id && a.available !== false) ? agentById(id) : null
}
const automationRunner = createAutomationRunner({
  findWorkspace: automationWorkspace,
  agentFor: automationAgent,
  shellFor: () => selectedShell.value,
  permissionSig: automationPermissionSig,
  // Panes left open by its previous runs, and copies not merged or
  // discarded yet (their cards not Done).
  openPanesOf: (id) => boardTasks.filter((x) => x.automation && x.automation.id === id && x.paneId && findLeaf(x.paneId)).length,
  copiesOf: (id) => boardTasks.filter((x) => x.automation && x.automation.id === id && x.worktree && !x.mergedAt && x.column !== 'done').length,
  createWorktree: makeTaskCopy,
  // A copy made for a run that did not start: nothing in it yet.
  async removeCopy(wt) {
    const res = await window.shellApi.review
      .remove({ root: wt.root, path: wt.path, branch: wt.branch, target: wt.baseBranch || 'main', force: true })
      .catch((err) => ({ ok: false, error: err && err.message }))
    if ((!res || res.ok === false) && window.shellApi.log) window.shellApi.log('warn', `automation copy not removed: ${wt.path}: ${(res && res.error) || '?'}`)
  },
  runStatus: (runId) => (window.shellApi.automations && window.shellApi.automations.status ? window.shellApi.automations.status(runId) : Promise.resolve('dispatching')),
  // The run's pane: a new pane of the project, the one you are in stays active.
  openPane: openBackgroundAgentPane,
  createCard({ title, brief, wsId, paneId, worktree, automation }) {
    const task = addTask({ title, wsId })
    updateTask(task.id, { brief, column: 'doing', paneId, startedAt: Date.now(), doingSince: Date.now(), automation, ...(worktree ? { worktree } : {}) })
    scheduleTaskSave()
    const leaf = findLeaf(paneId)
    recordActivity({ type: 'task', action: 'started', taskId: task.id, title, paneId, agent: agentInfo(leaf), wsId, branch: worktree ? worktree.branch : null })
    return task.id
  },
  updateCard(id, patch) {
    if (!boardTasks.some((x) => x.id === id)) return
    updateTask(id, patch.column === 'review' || patch.column === 'done' ? { ...patch, doneAt: Date.now() } : patch)
    scheduleTaskSave()
  },
  cardOf: (id) => boardTasks.find((x) => x.id === id) || null,
  removeCard(id) {
    if (boardTasks.some((x) => x.id === id)) removeTask(id)
    scheduleTaskSave()
  },
  findLeaf,
  agentProbe: automationAgentProbe,
  // What its pane's screen shows of the agent (TerminalPane's agentObservation).
  screenProbe: (id) => {
    const pane = findLeaf(id) ? getPane(id) : null
    return pane && pane.agentObservation ? pane.agentObservation() : null
  },
  // After the pane has shown its last answer (and outside its own callback).
  closePane: (id) => setTimeout(() => findLeaf(id) && closeLeaf(id, { force: true }), 1500),
  report: (result) => (window.shellApi.automations ? window.shellApi.automations.markResult(result).catch(() => null) : Promise.resolve(null)),
  notify({ kind, title, body, paneId }) {
    inboxNote(kind, title, body, paneId)
    nativeNotify({ title, body, paneId })
    if (document.hasFocus() && settings.inAppAlerts)
      showToast(title, { kind: kind === 'attention' ? 'attention' : undefined, timeout: 8000, ...(paneId ? { action: { label: t('app.common.show', 'Show'), run: () => focusPane(paneId) } } : {}) })
  },
  automationById: (id) => automationsState.automations.find((a) => a.id === id) || null
})
// Is a run's agent there? (probeRunAgent, automationRunner.js)
function automationAgentProbe(id) {
  const leaf = findLeaf(id)
  return probeRunAgent({
    leaf,
    managed: !!leaf && managedAgentStatus(leaf),
    state: leaf ? getAgentState(id, leaf.agentLaunchToken) : null,
    busy: agentStatus[id] === 'busy',
    waiting: !!approvals[id] || !!limits[id],
    now: Date.now(),
    runningWork: () => probeRunningWork(id)
  })
}
// TerminalPane: an agent ended its turn.
function automationTurnDone(paneId) {
  return automationRunner.turnDone(paneId)
}
watch(
  () => Object.keys(approvals).filter((id) => approvals[id] && automationRunner.runOfPane(id)),
  (ids) => {
    for (const id of ids) automationRunner.approval(id, true)
  }
)
// The fingerprint of what an agent runs with now (compared with the one you
// confirmed for an automation).
function automationPermissionSig(agentId) {
  const agent = agentById(agentId)
  if (!agent) return ''
  return permissionFingerprint(launchSignature(effectiveAgent(agent, settings.agentPrefs, settings.agentPermissions)))
}
// What Settings > Automations shows and does (AutomationsPage.vue).
function automationPermissions(agentId) {
  const agent = agentById(agentId)
  if (!agent) return null
  const launch = effectiveAgent(agent, settings.agentPrefs, settings.agentPermissions)
  const own = typeof (settings.agentPrefs[agentId] || {}).args === 'string' ? settings.agentPrefs[agentId].args.trim() : ''
  return { yolo: launchIsYolo(agentId, launch), args: launch.args || '', ownArgs: !!own, mode: settings.agentPermissions, sig: automationPermissionSig(agentId) }
}
provide('automations', {
  projects: computed(() =>
    workspaces.value
      .filter((ws) => ws.cwd || ws.remote)
      .map((ws) => ({
        wsId: ws.id,
        name: ws.name,
        cwd: ws.remote ? null : ws.cwd,
        remote: ws.remote ? { hostId: ws.remote.hostId, path: ws.remote.path } : null,
        hostLabel: ws.remote ? remoteHostLabel(ws.remote.hostId) : ''
      }))
  ),
  agents: computed(() =>
    launchableAgents.value.filter((a) => AUTOMATION_AGENTS.includes(a.id)).map((a) => ({ id: a.id, name: a.name, accent: a.accent || null, available: a.available !== false }))
  ),
  permissions: automationPermissions,
  paneOpen: (id) => !!(id && findLeaf(id)),
  cardOpen: (id) => !!(id && boardTasks.some((x) => x.id === id)),
  showPane(id) {
    settingsOpen.value = false
    focusPane(id)
  },
  showCard(id) {
    const task = boardTasks.find((x) => x.id === id)
    if (!task) return
    settingsOpen.value = false
    if (task.wsId) selectWorkspace(task.wsId)
    showSideTab('tasks')
  },
  openAgentSettings: () => openSettingsAt('agents')
})
let automationCheckTimer = 0
onBeforeUnmount(() => clearInterval(automationCheckTimer))
// The tessel command (cliRequests.js): what it asks the window, once the
// workspaces and the board are back.
const cliRequests = createCliRequests({
  workspaces: () => workspaces.value,
  currentWs: () => currentWs.value,
  selectWorkspace,
  addProjects,
  openInEditor: ({ file, line, col, ws }) => openInTesselEditor({ file, line, col, preview: false, ws }),
  viewFile,
  agentFor: (id) => launchableAgents.value.find((a) => a.id === id && a.available !== false) || null,
  agentIds: () => launchableAgents.value.filter((a) => a.available !== false).map((a) => a.id),
  modelsFor,
  shellFor: (id) => (shells.value.some((s) => s.id === id) ? id : null),
  async openPane({ ws, agent, shellId, sessionOptions }) {
    if (!workspaces.value.includes(ws)) return null
    const shell = shellId || selectedShell.value
    const target = ws.tree ? largestLeaf(ws.tree) : null
    const opts = sessionOptions ? { sessionOptions } : {}
    let leaf
    if (target && target.id) leaf = await splitLeaf(target.id, target.dir, agent, shell, null, opts)
    else {
      leaf = await createLeaf(shell, agent, ws.cwd, null, wsLeafOpts(ws, opts))
      if (leaf && !ws.tree) {
        ws.tree = leaf
        ws.activeId = leaf.id
      }
    }
    numberPanes()
    return leaf || null
  },
  focusPane,
  paneLabel,
  forEachLeaf,
  agentState: (id) => (agentStates.value[id] ? agentStates.value[id].state : null),
  addCard({ title, note, ws }) {
    if (boardLocked) throw new CliRequestError('board_locked', t('app.board.lockedAtStart', 'The saved board could not be read at start.'))
    const task = addTask({ title, wsId: ws ? ws.id : null })
    if (note) updateTask(task.id, { brief: note })
    scheduleTaskSave()
    return task
  },
  notify: (text) => showToast(text, { timeout: 5000 })
})
function startCliRequests() {
  const api = window.shellApi.cli
  if (!api) return
  api.onRequest(async (req) => {
    if (!req || typeof req.id !== 'string') return
    let msg
    try {
      msg = { id: req.id, ok: true, result: await cliRequests.handle(req) }
    } catch (err) {
      msg = { id: req.id, ok: false, error: { code: (err && err.code) || 'failed', message: (err && err.message) || '' } }
    }
    api.reply(msg).catch(() => {})
  })
  api.ready().catch(() => {})
}
async function startAutomations() {
  const api = window.shellApi.automations
  if (!api) return
  subscribeAutomations()
  api.onDispatch((payload) => {
    automationRunner.dispatch(payload).catch((err) => {
      if (window.shellApi.log) window.shellApi.log('error', `automation run could not start: ${err && err.message}`)
    })
  })
  try {
    const ids = []
    forEachWsLeaf((l) => !hasNoTerminal(l) && ids.push(l.id))
    automationRunner.resume(await api.reconcile(ids))
    applyAutomations(await api.windowReady())
  } catch (err) {
    if (window.shellApi.log) window.shellApi.log('error', `automations: ${err && err.message}`)
  }
  // A run's pane closed before its agent finished, its agent exited or never
  // showed up: that run failed.
  watch(workspaces, () => automationRunner.check(), { deep: true })
  automationCheckTimer = setInterval(() => automationRunner.check(), 10000)
}

// A sidebar row's worker mark: { id, label, status } of its coordinator.
function workerOfRow(leaf) {
  if (leaf.kind !== 'agent' || !leaf.team) return null
  let info = null
  try {
    info = orchestrator.workerInfo(teamById(leaf.team), leaf.id)
  } catch {
    return null // asked before the orchestrator is set up (setup order)
  }
  const coord = info ? findLeaf(info.coordinatorId) : null
  return info ? { id: info.coordinatorId, label: coord ? paneLabel(coord) : '', num: coord ? coord.num || null : null, status: info.status } : null
}

// The Tasks panel's orchestration card (OrchestrationCard.vue): each team of
// a workspace that has workers, and the user's actions on them.
const orchestrationView = computed(() =>
  teams.value.filter((tm) => Array.isArray(tm.workers) && tm.workers.length).map((tm) => ({ ...orchestrator.summary(tm), wsId: teamWsId(tm.id) }))
)
provide('orchestration', {
  view: orchestrationView,
  allow: (teamId, id) => teamById(teamId) && orchestrator.allow(teamById(teamId), id, teams.value),
  refuse: (teamId, id) => teamById(teamId) && orchestrator.refuse(teamById(teamId), id),
  stop: (teamId, id) => teamById(teamId) && orchestrator.stopByUser(teamById(teamId), id),
  focus: (paneId) => paneId && findLeaf(paneId) && focusPane(paneId)
})

// Dependencies: a card whose prerequisite cards are all done can start; its
// agent is told once (in the background in a team).
const waitingOn = (task) => (task.deps || []).filter((d) => {
  const dep = boardTasks.find((t) => t.id === d)
  // Deleted from the board: still not done (you decide: remove the wait, or
  // move the card yourself).
  return !dep || dep.column !== 'done'
})
// Why an agent cannot move a card on yet ('' when it can).
function blockedReason(task) {
  const waiting = waitingOn(task)
  if (waiting.length) return `it waits for ${waiting.join(', ')}` // i18n-ignore
  if (task.gate && task.gate.status === 'pending') return `it waits for the user's decision (${task.gate.question})` // i18n-ignore
  return ''
}
watch(
  () => boardTasks.map((t) => `${t.id}:${t.column}`).join('|'),
  () => {
    for (const t of boardTasks) {
      if (!t.deps || !t.deps.length) continue
      const waiting = waitingOn(t)
      const key = waiting.join(',')
      if (t.waitingKey === key) continue
      const wasWaiting = !!t.waitingKey
      updateTask(t.id, { waitingKey: key })
      if (!waiting.length && wasWaiting && t.column === 'todo' && t.paneId) {
        const leaf = findLeaf(t.paneId)
        recordActivity({ type: 'task', action: 'ready', paneId: t.paneId, title: t.title, wsId: t.wsId })
        if (leaf && leaf.team && teamById(leaf.team))
          tellAgents([leaf], `[Tessel] Card ${t.id} "${t.title}" can start now: the cards it waited for are done.`, leaf.team) // i18n-ignore
      }
    }
  }
)

// Who is who in a team, for its tools: each member's agent, model and state
// ("@codex", "@idle", team_members). Written when it changes.
const rosterSigs = {}
function writeTeamRoster(team, dir, members) {
  if (!window.shellApi.team || !window.shellApi.team.roster) return
  const out = {}
  for (const m of members) {
    const st = agentStates.value[m.id]
    out[m.id] = { agent: m.agentId || null, model: paneModels[m.id] || null, state: st ? st.state : null }
  }
  const key = `${dir}|${team.id}`
  const sig = JSON.stringify(out)
  if (rosterSigs[key] === sig || rosterPending.has(key)) return
  rosterPending.add(key)
  // Remembered only once written: a failed write is tried again next round.
  window.shellApi.team
    .roster({ dir, teamId: team.id, members: out })
    .then((res) => {
      if (res && res.ok) rosterSigs[key] = sig
    })
    .catch(() => {})
    .finally(() => rosterPending.delete(key))
}
const rosterPending = new Set()

// b: { key (ledger and cache key), dir, target ({ teamId } or { board }),
// wsId, members (agents allowed to ask), teamId (null: alone) }
async function syncBoard(b, round = teamRound) {
  if (!window.shellApi.team || !window.shellApi.team.requests) return
  // The board shown is only its previous copy (never saved): agents' requests
  // wait in their files and nothing is published as the current board.
  if (boardLocked) return
  const { key: boardKey, dir, target, wsId, members } = b
  const byNum = (n) => members.find((m) => m.num === Number(String(n).slice(1))) || null
  const res = await window.shellApi.team.requests({ dir, ...target })
  // Replaced meanwhile: these requests are the new round's to apply (their
  // reservations released, so it reads them again).
  if (roundGone(round)) {
    const files = res && res.ok ? (res.requests || []).map((r) => r.file) : []
    if (files.length && window.shellApi.team.requestsRelease) window.shellApi.team.requestsRelease({ dir, ...target, files }).catch(() => {})
    return
  }
  const refusals = []
  const applied = [] // request files, removed once the board is saved
  if (res && res.ok) {
    for (const r of res.refused || []) refusals.push({ fromId: r.fromId, text: `Your board request was not done: ${r.error}.` }) // i18n-ignore
    for (const r of res.requests || []) {
      const from = members.find((m) => m.id === r.fromId)
      applied.push(r.file)
      if (!from) continue // not (or no longer) in this team
      // Already applied (Tessel stopped before its file was removed): never
      // again, so a later change (or a card deleted since) is not undone.
      const key = `${boardKey}/${r.file}`
      if (appliedRequests.has(key)) continue
      appliedRequests.add(key)
      // Orchestration: workers started, stopped, read; their reports and
      // heartbeats (src/renderer/src/orchestrator.js). Only in a team.
      if (/^worker-|^heartbeat$/.test(r.action)) {
        const team = b.teamId ? teamById(b.teamId) : null
        if (team) orchestrator.handleRequest(team, from, r, { teams: teams.value })
        else refusals.push({ fromId: from.id, text: 'Workers belong to a team: you are in none.' }) // i18n-ignore
        continue
      }
      if (r.action === 'add') {
        const who = r.assignee ? byNum(r.assignee) : from
        if (!who) {
          refusals.push({ fromId: from.id, text: `The card "${r.title}" was not added: ${r.assignee} is not in your team.` }) // i18n-ignore
          continue
        }
        const unknown = (r.deps || []).filter((d) => !boardTasks.some((t) => t.id === d && t.wsId === wsId))
        if (unknown.length) {
          refusals.push({ fromId: from.id, text: `The card "${r.title}" was not added: no card ${unknown.join(', ')} on your team's board to wait for (see team_tasks).` }) // i18n-ignore
          continue
        }
        // A card that waits for cards not done yet starts in To do.
        const pendingDeps = (r.deps || []).filter((d) => boardTasks.find((t) => t.id === d).column !== 'done')
        const column = pendingDeps.length && r.column !== 'todo' ? 'todo' : r.column
        const task = addTask({ title: r.title, wsId })
        updateTask(task.id, { paneId: who.id, column, createdBy: from.id })
        // Cards it waits for.
        if (r.deps && r.deps.length) updateTask(task.id, { deps: [...r.deps] })
        if (column !== r.column)
          refusals.push({
            fromId: from.id,
            text: `The card "${r.title}" (${task.id}) was put in To do, not ${r.column}: it waits for ${pendingDeps.join(', ')}.` // i18n-ignore
          })
        recordActivity({ type: 'task', action: 'added', paneId: who.id, agent: agentInfo(who), title: r.title, wsId, by: paneLabel(from) })
      } else if (r.action === 'report' || r.action === 'gate') {
        const task = boardTasks.find((t) => t.id === r.id)
        if (!task || task.wsId !== wsId) {
          refusals.push({ fromId: from.id, text: `No card ${r.id} on your team's board (see team_tasks).` }) // i18n-ignore
          continue
        }
        if (r.action === 'report') applyReport(task, r, from, b.teamId)
        else askDecision(task, r, from)
      } else if (r.action === 'move') {
        const task = boardTasks.find((t) => t.id === r.id)
        if (!task || task.wsId !== wsId) {
          refusals.push({ fromId: from.id, text: `No card ${r.id} on your team's board (see team_tasks).` }) // i18n-ignore
          continue
        }
        if (task.column === r.column) continue
        const blocked = (r.column === 'doing' || r.column === 'review' || r.column === 'done') && blockedReason(task)
        if (blocked) {
          refusals.push({ fromId: from.id, text: `Card ${task.id} "${task.title}" stays in ${task.column}: ${blocked}.` }) // i18n-ignore
          continue
        }
        updateTask(task.id, { column: r.column })
        const owner = task.paneId ? findLeaf(task.paneId) : null
        recordActivity({
          type: 'task',
          action: 'moved',
          paneId: owner ? owner.id : from.id,
          agent: agentInfo(owner || from),
          title: task.title,
          wsId,
          by: paneLabel(from),
          detail: { todo: t('app.board.col.todo', 'To do'), doing: t('app.board.col.doing', 'Doing'), review: t('app.board.col.review', 'Review'), done: t('app.board.col.done', 'Done') }[r.column]
        })
      }
    }
  }
  // The board and the ledger of applied requests are saved together, then
  // the request files removed; a request is dropped from the ledger only once
  // its file is surely gone (it can never come back then).
  if (applied.length) {
    const saved = await saveBoard().catch(() => null)
    // Replaced meanwhile: the new round saves and removes them (the ledger
    // already has them: not applied twice).
    if (roundGone(round)) return
    if (saved && saved.ok) {
      const done = await window.shellApi.team.requestsDone({ dir, ...target, files: applied }).catch(() => null)
      if (roundGone(round)) return
      for (const f of (done && done.removed) || []) appliedRequests.delete(`${boardKey}/${f}`)
      scheduleTaskSave()
    }
  }
  // Told in the background to a team's agents; an agent alone has no such
  // channel (never typed into its terminal): only logged.
  for (const r of refusals) {
    const leaf = findLeaf(r.fromId)
    if (leaf && b.teamId) tellAgents([leaf], `[Tessel] ${r.text}`, b.teamId)
    else if (leaf && window.shellApi.log) window.shellApi.log('info', `board: ${paneLabel(leaf)}: ${r.text}`)
  }
  const label = (paneId) => {
    const leaf = paneId ? findLeaf(paneId) : null
    return leaf && leaf.num ? `#${leaf.num}` : null
  }
  const cards = boardTasks
    .filter((t) => t.wsId === wsId)
    .map((t) => ({
      id: t.id,
      title: t.title,
      column: t.column,
      assignee: label(t.paneId),
      since: t.doingSince || null,
      // Orchestration: what it waits for, a decision, its report.
      ...(t.deps && t.deps.length ? { deps: t.deps, waitingOn: waitingOn(t) } : {}),
      ...(t.gate ? { gate: { question: t.gate.question, options: t.gate.options, status: t.gate.status, answer: t.gate.answer } } : {}),
      ...(t.report ? { report: { outcome: t.report.outcome, summary: t.report.summary, files: t.report.files } } : {})
    }))
  const sig = JSON.stringify(cards)
  if (boardSigs[boardKey] === sig) return
  // A plain copy: the cards' lists are reactive and cannot cross to main.
  const pub = await window.shellApi.team.tasks({ dir, ...target, tasks: JSON.parse(sig) })
  if (!roundGone(round) && pub && pub.ok) boardSigs[boardKey] = sig
}
const boardSigs = {} // board key -> the cards last published

// A message logged unread that is no longer in the recent history (200
// entries) is looked up in the channel itself, every 10 s at most.
const unreadCheckAt = {} // teamId -> time of the next look-up
async function refreshOldUnread(team, dir, history, round = teamRound) {
  if (!teamMsgEvents || !window.shellApi.team || !window.shellApi.team.messageStatus) return
  if (Date.now() < (unreadCheckAt[team.id] || 0)) return
  unreadCheckAt[team.id] = Date.now() + 10000
  const recent = new Set((Array.isArray(history) ? history : []).map((m) => m && m.id))
  const ids = []
  for (const [id, e] of teamMsgEvents) if (e.status === 'unread' && e.teamId === team.id && !recent.has(id)) ids.push(id)
  if (!ids.length) return
  let changed = false
  // All of them, 500 per look-up.
  for (let i = 0; i < ids.length; i += 500) {
    const part = ids.slice(i, i + 500)
    const res = await window.shellApi.team.messageStatus({ dir, teamId: team.id, ids: part })
    if (roundGone(round) || !res || !res.ok) break
    for (const id of part) {
      // 'gone': the channel keeps only so many read messages.
      if (res.statuses[id] === 'delivered' || res.statuses[id] === 'gone') {
        teamMsgEvents.get(id).status = 'read'
        changed = true
      }
    }
  }
  if (changed) activityChanged()
}

async function deliverChannel(team, members, round = teamRound) {
  const dir = channelDir(team)
  if (!dir || !window.shellApi.channel || !channelBoxes[team.id]) return
  if (!TEAM_MESSAGES_IN_TERMINALS) {
    // Agents read and send with the team tools (src/main/teamMcp/server.cjs):
    // Tessel only takes their outboxes in and turns read notes into receipts.
    teamStepIs('read notes', team)
    if (window.shellApi.channel.acks) await window.shellApi.channel.acks({ dir, teamId: team.id })
    if (roundGone(round)) return
    teamStepIs('channel read', team)
    const res = await window.shellApi.channel.poll({ dir, teamId: team.id, availableIds: members.map((m) => m.id) })
    if (roundGone(round)) return
    if (res && res.ok) {
      // Complete counts per member from the channel (the delivery list is
      // capped, so a long backlog for one member would hide another's).
      let counts = res.unreadCounts
      if (!counts) {
        counts = {}
        for (const d of [...(res.deliveries || []), ...(res.held || [])]) {
          if (d.fromId === 'tessel' && /^Delivered to /.test(d.text)) continue
          counts[d.toId] = (counts[d.toId] || 0) + 1
        }
      }
      for (const m of members) {
        if (counts[m.id]) teamUnread[m.id] = counts[m.id]
        else delete teamUnread[m.id]
      }
      for (const m of members) wakeIfNeeded(m)
      logTeamMessages(team, res)
      teamStepIs('read status', team)
      await refreshOldUnread(team, dir, res.history, round)
      if (roundGone(round)) return
    }
    teamStepIs('task board', team)
    await syncTeamBoard(team, dir, members, round)
    return
  }
  const res = await window.shellApi.channel.poll({ dir, teamId: team.id, availableIds: members.map((m) => m.id) })
  if (!res || !res.ok) return
  const who = Object.fromEntries((res.participants || []).map((p) => [p.id, p]))
  const textOf = (d) => {
    const from = who[d.fromId]
    return d.fromId === 'tessel'
      ? `[Tessel] ${d.text}`
      : `[From #${from ? from.num : '?'} ${from ? from.title : 'teammate'}, team "${team.name}", message ${d.id}${d.replyTo ? `, reply to ${d.replyTo}` : ''}] ${d.text}` // i18n-ignore
  }
  const api = window.shellApi.channel
  const where = { dir, teamId: team.id }
  // What happens to a delivery, on disk: held in flight before it is typed,
  // uncertain if the agent did not visibly take it, released to try again,
  // acknowledged once taken.
  const hooks = (d, key) => ({
    beforePaste: async () => {
      const r = await api.hold({ ...where, id: d.id, toId: d.toId, state: 'inflight' })
      return !!(r && r.ok)
    },
    onDelivered: () => ackChannel(dir, team.id, d, key),
    onFailed: async () => {
      // Nothing was typed: it can go again later.
      await api.release({ ...where, id: d.id, toId: d.toId })
      channelQueued.delete(key)
    },
    // Not held (the recipient has another unresolved message): left as it
    // is on disk, tried again by a later poll.
    onRefused: () => channelQueued.delete(key),
    onUncertain: () => api.hold({ ...where, id: d.id, toId: d.toId, state: 'uncertain' }),
    // The user says it was sent: acknowledged on disk (true when recorded).
    confirmSent: async () => {
      const r = await api.ack({ ...where, id: d.id, toId: d.toId }).catch(() => null)
      return !!(r && r.ok)
    },
    // The user cleared the draft and asked for another try: true once
    // released on disk, null if that failed.
    onRetry: async () => {
      const r = await api.release({ ...where, id: d.id, toId: d.toId }).catch(() => null)
      if (!r || !r.ok) return null
      channelQueued.delete(key)
      return true
    }
  })
  // Held on disk but not handled in this session: Tessel stopped or reloaded
  // while it was being typed or checked. Never typed again blindly: the pane
  // shows "message not confirmed" and the user decides.
  for (const d of res.held || []) {
    const key = `${team.id}:${d.id}:${d.toId}`
    if (channelQueued.has(key) || !findLeaf(d.toId) || unsent[d.toId]) continue
    channelQueued.add(key)
    unsent[d.toId] = {
      item: { text: textOf(d), held: false, meta: { source: 'agent', scope: 'team', teamId: team.id, ...hooks(d, key) } },
      at: d.heldAt || Date.now()
    }
  }
  for (const d of res.deliveries) {
    const key = `${team.id}:${d.id}:${d.toId}`
    if (channelQueued.has(key)) continue
    if (d.fromId === 'tessel' && /^Delivered to /.test(d.text)) {
      channelQueued.add(key)
      ackChannel(dir, team.id, d, key)
      continue
    }
    // Out of usage: it stays on disk until the agent can read it.
    if (limits[d.toId] || !findLeaf(d.toId)) continue
    channelQueued.add(key)
    const from = who[d.fromId]
    deliverToAgent(d.toId, textOf(d), {
      source: d.fromId === 'tessel' ? 'tessel' : 'agent',
      scope: 'team',
      teamId: team.id,
      from: from ? from.title : null,
      waitIdle: true,
      ...hooks(d, key)
    })
  }
}
const leadTimer = setInterval(pollTeams, 2500)
onBeforeUnmount(() => clearInterval(leadTimer))

// --- Teams ----------------------------------------------------------------------
function isTeam(t) {
  return (
    t &&
    typeof t.id === 'string' &&
    typeof t.name === 'string' &&
    typeof t.color === 'string' &&
    /^#[0-9a-f]{6}$/i.test(t.color)
  )
}

function teamById(id) {
  return (id && teams.value.find((t) => t.id === id)) || null
}

function teamMembers(teamId) {
  const out = []
  forEachWsLeaf((l) => l.team === teamId && out.push(l))
  return out
}

// Teams nobody belongs to any more go away.
function pruneTeams() {
  const used = new Set()
  forEachWsLeaf((l) => l.team && used.add(l.team))
  teams.value = teams.value.filter((t) => used.has(t.id))
}

function createTeam(leafIds) {
  const ids = (leafIds || []).filter((id) => findLeaf(id)?.kind === 'agent' && !findLeaf(id).team)
  if (!ids.length) return null
  const names = new Set(teams.value.map((t) => t.name))
  let n = 1
  const teamName = (i) => t('app.team.defaultName', 'Team {{n}}', { n: i })
  while (names.has(teamName(n))) n++
  const used = new Set(teams.value.map((x) => x.color))
  const color = TEAM_COLORS.find((c) => !used.has(c)) || TEAM_COLORS[n % TEAM_COLORS.length]
  const team = { id: newId('team'), name: teamName(n), color }
  teams.value.push(team)
  // Agents taken from another team: that team hears they left.
  const leftFrom = new Map()
  for (const id of ids) {
    const leaf = findLeaf(id)
    if (leaf.team) leftFrom.set(leaf.team, [...(leftFrom.get(leaf.team) || []), leaf.title])
    leaf.team = team.id
    logMembership(leaf, team.id)
  }
  pruneTeams()
  for (const [oldId, names] of leftFrom) {
    if (teamById(oldId)) tellTeam(oldId, `${names.join(', ')} left the team.`) // i18n-ignore
  }
  recordActivity({
    type: 'team',
    action: 'created',
    teamId: team.id,
    wsId: teamWsId(team.id),
    name: team.name,
    detail: ids.map((id) => findLeaf(id)?.title).join(', ')
  })
  tellTeam(team.id, null, { welcome: true })
  return team
}

// Add free agents to a team: they get the welcome, the others hear who joined.
function addToTeam(teamId, leafIds) {
  const team = teamById(teamId)
  if (!team) return
  const joining = (leafIds || []).map(findLeaf).filter((l) => l && l.kind === 'agent' && !l.team)
  if (!joining.length) return
  const before = teamMembers(teamId)
  for (const leaf of joining) {
    leaf.team = teamId
    logMembership(leaf, teamId)
  }
  const names = joining.map((l) => l.title).join(', ')
  recordActivity({ type: 'team', action: 'joined', teamId, wsId: teamWsId(teamId), name: team.name, detail: names })
  if (before.length) {
    tellAgents(before, `[Tessel] Team "${team.name}": ${names} joined the team.`, teamId) // i18n-ignore
  }
  tellTeam(teamId, null, { welcome: true, only: joining.map((l) => l.id) })
}

function renameTeam(teamId, name) {
  const team = teamById(teamId)
  const clean = String(name || '')
    .trim()
    .slice(0, 40)
  if (!team || !clean || clean === team.name) return
  const old = team.name
  team.name = clean
  recordActivity({ type: 'team', action: 'renamed', teamId, wsId: teamWsId(teamId), name: clean, detail: old })
  tellTeam(teamId, `The team "${old}" is now called "${clean}".`) // i18n-ignore
}

function leaveTeam(leafId) {
  const leaf = findLeaf(leafId)
  if (!leaf || !leaf.team) return
  const teamId = leaf.team
  const name = teamById(teamId)?.name || 'the team' // i18n-ignore
  const wsId = wsOfLeaf(leaf.id)?.id || null
  leaf.team = null
  logMembership(leaf, null)
  pruneTeams()
  tellAgents([leaf], `[Tessel] You are no longer in team "${name}".`, teamId) // i18n-ignore
  recordActivity({ type: 'team', action: 'left', teamId, wsId, name, detail: leaf.title })
  if (teamById(teamId)) tellTeam(teamId, `${leaf.title} left the team.`) // i18n-ignore
}

// "Ungroup": the team goes away at once, its panes stay where they are. For a
// few seconds a toast offers Undo; only then are the agents told and the
// change logged, so an Undo leaves no trace.
const UNGROUP_UNDO_MS = 8000
function disbandTeam(teamId) {
  const team = teamById(teamId)
  if (!team) return
  const members = teamMembers(teamId)
  const wsId = teamWsId(teamId)
  for (const leaf of members) leaf.team = null
  teams.value = teams.value.filter((t) => t.id !== teamId)
  let undone = false
  const commit = setTimeout(() => {
    if (undone) return
    // Only agents still open and still in no team: one that joined another
    // team meanwhile is not told it works alone.
    const still = members.filter((l) => {
      const leaf = findLeaf(l.id)
      return leaf && !leaf.team
    })
    for (const leaf of still) logMembership(leaf, null)
    tellAgents(still, `[Tessel] Team "${team.name}" was ungrouped: you now work on your own.`, teamId) // i18n-ignore
    recordActivity({ type: 'team', action: 'ungrouped', teamId, wsId, name: team.name })
    const home = wsById(wsId)
    for (const id of Object.keys(team.inboxes || {})) dropInbox(team, id, home && home.cwd)
    team.leadId = null
    handOffLeadReviews(teamId)
  }, UNGROUP_UNDO_MS)
  showToast(t('app.team.ungrouped', '{{name}} ungrouped. Its sessions stay where they are.', { name: team.name }), {
    timeout: UNGROUP_UNDO_MS,
    action: {
      label: t('app.common.undo', 'Undo'),
      run: () => {
        undone = true
        clearTimeout(commit)
        if (!teams.value.some((t) => t.id === team.id)) teams.value.push(team)
        // Members still open and not moved to another team meanwhile come back.
        for (const m of members) {
          const leaf = findLeaf(m.id)
          if (leaf && !leaf.team) leaf.team = team.id
        }
        pruneTeams()
      }
    }
  })
}

// Tell a team's agents what changed. With { welcome: true }, each member
// hears who its teammates are and where the shared notes are (created once in
// the project folder; see shareProjectNotes).
async function tellTeam(teamId, text, opts = {}) {
  const team = teamById(teamId)
  if (!team) return
  const members = teamMembers(teamId).filter((l) => l.kind === 'agent')
  if (!members.length) return
  if (!opts.welcome) {
    tellAgents(members, `[Tessel] Team "${team.name}": ${text}`, teamId) // i18n-ignore
    return
  }
  const boxes = (await syncChannel(team, { quiet: members.map((l) => l.id) })) || {}
  const ws = wsOfLeaf(members[0].id)
  const dir = (ws && ws.cwd) || members[0].startDir
  let notes = ''
  if (dir && window.shellApi.projectNotes) {
    const res = await window.shellApi.projectNotes({ dir, content: projectNotesTemplate(ws) })
    if (res && res.ok) notes = res.path
  }
  for (const leaf of members) {
    if (opts.only && !opts.only.includes(leaf.id)) continue
    const mates = members.filter((l) => l.id !== leaf.id).map(agentLabel)
    const box = boxes[leaf.id]
    tellAgents(
      [leaf],
      `[Tessel] You are now in team "${team.name}"` + // i18n-ignore
        (mates.length ? ` with ${mates.join(', ')}.` : ' (no other agent yet).') + // i18n-ignore
        (notes
          ? ` Shared notes: ${notes} . Read them, agree there on who does what, and add a dated line to their Journal for each notable change.` // i18n-ignore
          : '') +
        ' Before editing a file a teammate may be editing, check with them. Do not commit the notes file.' + // i18n-ignore
        (box ? `\nTalk to your teammates directly through the team channel, not through the user.\n${box.guide}` : ''), // i18n-ignore
      teamId
    )
  }
  const told = members.filter((l) => !limits[l.id] && (!opts.only || opts.only.includes(l.id))).length
  showToast(told === 1 ? t('app.team.toldOne', 'Told 1 agent they are in {{team}}.', { team: team.name }) : t('app.team.told', 'Told {{count}} agents they are in {{team}}.', { count: told, team: team.name }), {
    timeout: 3000
  })
}

// A note from Tessel to some agents. For a team it is a background notice
// (read with the team tools, never typed into a terminal); outside a team,
// ones out of usage are skipped.
function tellAgents(list, text, teamId = null) {
  const meta = { source: 'tessel', scope: 'team-change', teamId }
  if (teamId) {
    noticeAgents(list, text, teamId, meta)
    return
  }
  for (const leaf of list) {
    if (leaf.kind !== 'agent') continue
    if (limits[leaf.id]) logMessage(leaf.id, 'skipped', text, meta)
    else deliverToAgent(leaf.id, text, meta)
  }
}

// Background notices to agents of a team (notices.json, read with the team
// tools). Without a project folder there is nowhere to keep them: skipped,
// and still never typed.
function noticeAgents(list, text, teamId, meta = { source: 'tessel', scope: 'team', teamId }) {
  const team = teamById(teamId)
  const dir = team ? channelDir(team) : null
  const agents = list.filter((l) => l && l.kind === 'agent')
  if (!dir || !window.shellApi.team) {
    for (const l of agents) logMessage(l.id, 'skipped', text, meta)
    return false
  }
  // Each notice has its own id: a retry after a failed write can never add
  // it twice. It counts as sent only once the notices file really has it.
  const notices = agents.map((l) => ({ id: noticeId(), toId: l.id, text }))
  sendNotices({ dir, teamId, notices, text, meta, tries: 0 })
  return true
}
const noticeId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
const NOTICE_RETRY_MS = 5000
const NOTICE_TRIES = 60 // 5 minutes, then said failed in the activity log
function sendNotices(job) {
  const retry = (why) => {
    if (++job.tries >= NOTICE_TRIES) {
      for (const n of job.notices) logMessage(n.toId, 'unconfirmed', job.text, job.meta)
      if (window.shellApi.log) window.shellApi.log('error', `team notice not written after ${NOTICE_TRIES} tries: ${why}`)
      return
    }
    setTimeout(() => sendNotices(job), NOTICE_RETRY_MS)
  }
  Promise.resolve(window.shellApi.team.notice({ dir: job.dir, teamId: job.teamId, notices: job.notices }))
    .then((res) => {
      if (res && res.ok) for (const n of job.notices) logMessage(n.toId, 'sent', job.text, job.meta)
      else retry((res && res.error) || 'no answer')
    })
    .catch((err) => retry(err && err.message))
}

function messageTeam(teamId, text) {
  const team = teamById(teamId)
  if (team) messageAgents(teamMembers(teamId), text, team.name, { scope: 'team', teamId })
}

// Send one message to every agent of a workspace (never to plain shells,
// which would run it as a command).
function messageWorkspace(wsId, text) {
  const ws = wsById(wsId)
  if (ws) messageAgents(wsAgents(wsId), text, ws.name, { scope: 'workspace' })
}

function messageAgents(list, text, where, meta = {}) {
  const body = String(text || '').trim()
  if (!body) return
  const agents = list.filter((l) => l.kind === 'agent')
  if (!agents.length) {
    showToast(t('app.message.noAgent', '{{where}} has no agent to message.', { where }), { kind: 'error' })
    return
  }
  // Agents out of usage would not act on it: skip them and say so.
  const limited = agents.filter((l) => limits[l.id])
  const reached = agents.filter((l) => !limits[l.id])
  for (const leaf of reached) deliverToAgent(leaf.id, body, meta)
  for (const leaf of limited) logMessage(leaf.id, 'skipped', body, meta)
  const held = reached.filter((l) => pendingMessages[l.id])
  const names = (list) => list.map((l) => l.title).join(', ')
  const parts = [t('app.message.sent', 'Sent to {{sent}} of {{count}} agents.', { sent: reached.length - held.length, count: agents.length })]
  if (held.length) {
    parts.push(
      held.length === 1
        ? t('app.message.heldOne', '{{names}} is waiting for your approval and will get it right after.', { names: names(held) })
        : t('app.message.heldMany', '{{names}} are waiting for your approval and will get it right after.', { names: names(held) })
    )
  }
  if (limited.length) {
    parts.push(
      t('app.message.skipped', 'Skipped {{list}}: usage limit reached.', { list: limited.map((l) => `${l.title}${limitWhen(l.id)}`).join(', ') })
    )
  }
  showToast(parts.join(' '), {
    kind: limited.length ? 'attention' : undefined,
    timeout: limited.length ? 8000 : 4000
  })
}

// " (resets 8:47 PM)" for an agent at its usage limit, else ''.
function limitWhen(leafId) {
  const reset = limits[leafId] && limits[leafId].reset
  if (!reset) return ''
  return ' ' + (/^in /.test(reset) ? t('app.limit.resets', '(resets {{when}})', { when: reset }) : t('app.limit.resetsAt', '(resets at {{when}})', { when: reset }))
}

// An agent just stopped because it hit its usage limit.
function notifyAgentLimit(node, hit) {
  const ws = wsOfLeaf(node.id)
  const when = limitWhen(node.id) || (hit && hit.reset ? ' ' + t('app.limit.resets', '(resets {{when}})', { when: hit.reset }) : '')
  const others = ws ? wsAgents(ws.id).filter((l) => l.id !== node.id && !limits[l.id]) : []
  const handOver = others.length
    ? ' ' + t('app.limit.takeOver', '{{names}} can take over.', { names: others.map((l) => l.title).join(', ') })
    : ''
  const hitTitle = t('app.limit.hit', '{{name}} hit its usage limit', { name: node.title })
  const text = t('app.limit.hitWhen', '{{name}} hit its usage limit{{when}}.', { name: node.title, when }) + handOver
  inboxNote('limit', hitTitle, `${when.trim()}${handOver}`.trim(), node.id)
  if (document.hasFocus())
    showToast(text, {
      kind: 'attention',
      timeout: 10000,
      action: { label: t('app.common.show', 'Show'), run: () => focusPane(node.id) }
    })
  nativeNotify({
    title: hitTitle,
    body: `${when.trim()}${ws ? ' ' + t('app.limit.workspace', 'Workspace: {{name}}.', { name: ws.name }) : ''}${handOver}`.trim(),
    paneId: node.id
  })
}

function slugify(name) {
  return String(name || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

function projectNotesTemplate(ws) {
  const today = new Date().toISOString().slice(0, 10)
  const members = wsAgents(ws.id)
    .map((l) => `- ${agentLabel(l)}`)
    .join('\n')
  // The notes file is written for the agents: English.
  return `# Project notes: ${ws.name}

Shared notes of the agents working in this project (made by Tessel). Every
agent reads this file before working and writes here what it does.

## Agents

${members || '- (none yet)'}

## Who does what

(Agree on it here: which agent owns which files or tasks.)

## Rules

- Edit only the files assigned to you above. To touch another agent's file,
  say so in the journal first.
- Commit only your own files (\`git add <file>\`, never \`git add -A\`). No
  \`git checkout\`, \`reset\` or \`stash\` on shared work.
- Do not commit this file.

## Journal

- ${today} Tessel: notes created.
` // i18n-ignore
}

// Create the workspace's shared notes file (once) and tell each agent who the
// others are and where the file is.
async function shareProjectNotes(wsId) {
  const ws = wsById(wsId)
  if (!ws) return
  const agents = wsAgents(wsId)
  if (!agents.length) {
    showToast(t('app.notes.openAgentFirst', 'Open an agent in {{name}} first.', { name: ws.name }), { kind: 'error' })
    return
  }
  const dir = ws.cwd || agents[0].startDir
  if (!dir) {
    showToast(t('app.notes.needFolder', 'Set a project folder for "{{name}}" first.', { name: ws.name }), { kind: 'error' })
    return
  }
  if (!window.shellApi.projectNotes) {
    showToast(t('app.notes.restart', 'Restart Tessel to enable project notes.'), { kind: 'error' })
    return
  }
  const res = await window.shellApi.projectNotes({ dir, content: projectNotesTemplate(ws) })
  if (!res || !res.ok) {
    showToast(t('app.notes.createFailed', 'Could not create the project notes: {{error}}', { error: (res && res.error) || t('app.common.unknownError', 'unknown error') }), {
      kind: 'error'
    })
    return
  }
  for (const leaf of agents) {
    if (limits[leaf.id]) continue // out of usage: it would not act on it
    const others = agents
      .filter((l) => l.id !== leaf.id)
      .map(agentLabel)
      .join(', ')
    deliverToAgent(
      leaf.id,
      `[Tessel] Other agents in this project: ${others || 'none yet'}.` + // i18n-ignore
        ` Shared notes: ${res.path} . Read that file now, agree there on who does what, ` + // i18n-ignore
        'and add a dated line to its Journal section for each notable change. ' + // i18n-ignore
        'Before editing a file another agent may be editing, check the notes. Do not commit that file.', // i18n-ignore
      { source: 'tessel', scope: 'notes' }
    )
  }
  const limited = agents.filter((l) => limits[l.id])
  const told = agents.length - limited.length
  showToast(
    (res.created
      ? told === 1
        ? t('app.notes.createdOne', 'Created the project notes with 1 agent. {{path}}', { path: res.path })
        : t('app.notes.created', 'Created the project notes with {{count}} agents. {{path}}', { count: told, path: res.path })
      : told === 1
        ? t('app.notes.sharedOne', 'Shared the project notes with 1 agent. {{path}}', { path: res.path })
        : t('app.notes.shared', 'Shared the project notes with {{count}} agents. {{path}}', { count: told, path: res.path })) +
      (limited.length
        ? ' ' + t('app.message.skipped', 'Skipped {{list}}: usage limit reached.', { list: limited.map((l) => `${l.title}${limitWhen(l.id)}`).join(', ') })
        : ''),
    { timeout: limited.length ? 8000 : 5000 }
  )
}

// The notes view inside Tessel (NotesPanel), for a workspace.
const notesView = ref(null) // { wsId, dir, wsName, template }
function openNotesView(wsId) {
  const ws = wsById(wsId)
  if (!ws) return
  const dir = ws.cwd || wsAgents(wsId)[0]?.startDir
  if (!dir) {
    showToast(t('app.notes.needFolder', 'Set a project folder for "{{name}}" first.', { name: ws.name }), { kind: 'error' })
    return
  }
  closeMenus()
  notesView.value = { wsId, dir, wsName: ws.name, template: projectNotesTemplate(ws) }
}

// Open the workspace's notes file in the user's text editor (created if missing).
async function openProjectNotes(wsId) {
  const ws = wsById(wsId)
  if (!ws) return
  const dir = ws.cwd || wsAgents(wsId)[0]?.startDir
  if (!dir) {
    showToast(t('app.notes.needFolder', 'Set a project folder for "{{name}}" first.', { name: ws.name }), { kind: 'error' })
    return
  }
  if (!window.shellApi.openProjectNotes) {
    showToast(t('app.notes.restartOpen', 'Restart Tessel to open the project notes.'), { kind: 'error' })
    return
  }
  const res = await window.shellApi.openProjectNotes({ dir, content: projectNotesTemplate(ws) })
  if (!res || !res.ok) {
    showToast(t('app.notes.openFailed', 'Could not open the project notes: {{error}}', { error: (res && res.error) || t('app.common.unknownError', 'unknown error') }), {
      kind: 'error'
    })
  }
}

// Open the sidebar's message box under a workspace.
function startWsMessage(wsId) {
  if (sidebarCollapsed.value) toggleSidebar()
  nextTick(() => sidebarEl.value && sidebarEl.value.startMessage(wsId))
}

// A pane's agent state for the sidebar: 'approval' (asks you to approve
// something) | 'limited' (usage limit reached) | 'working' | 'waiting' (done,
// waiting for you) | 'ready'.
function paneState(leaf) {
  if (leaf.kind !== 'agent') return 'ready'
  if (approvals[leaf.id]) return 'approval'
  if (limits[leaf.id]) return 'limited'
  if (childrenRunning[leaf.id]) return 'working'
  if (leaf.agentLaunchToken && agentStatus[leaf.id] === 'unknown') return 'unknown'
  if (attention[leaf.id]) return 'waiting'
  return agentStatus[leaf.id] === 'busy' ? 'working' : 'ready'
}

// The status bar's left side (Tessel's former footer): where typing goes,
// the current workspace's panes, its folder.
const statusInfo = computed(() => {
  const items = []
  forEachLeaf(tree.value, (leaf) => {
    if (hasNoTerminal(leaf)) return
    items.push({ state: paneState(leaf), title: leaf.title || leaf.shellName || t('app.pane.terminal', 'Terminal'), active: leaf.id === activeId.value })
  })
  const count = (state) => items.filter((s) => s.state === state).length
  const parts = [items.length === 1 ? t('app.status.paneOne', '1 pane') : t('app.status.panes', '{{count}} panes', { count: items.length })]
  if (count('working')) parts.push(t('app.status.working', '{{count}} working', { count: count('working') }))
  if (count('waiting')) parts.push(t('app.status.waiting', '{{count}} waiting for you', { count: count('waiting') }))
  const active = items.find((s) => s.active)
  let target = active ? t('app.status.input', 'Input → {{name}}', { name: active.title }) : ''
  if (broadcast.value) {
    let n = 0
    forEachLeaf(tree.value, (leaf) => leaf.broadcast && n++)
    target = n === 1 ? t('app.status.broadcastOne', 'Broadcast → 1 pane') : t('app.status.broadcast', 'Broadcast → {{count}} panes', { count: n })
  }
  return { target, summary: parts.join(' · '), path: currentWs.value?.cwd || '' }
})

// Live terminals (not asleep) for the Resource Manager, grouped by workspace.
const statusTerminals = computed(() => {
  const out = []
  for (const p of sidebarProjects.value) {
    for (const card of buildProjectCards(p)) {
      for (const r of card.panes) {
        if (r.sleeping || !r.pid) continue
        out.push({
          id: r.id,
          pid: r.pid,
          label: `${r.num ? '#' + r.num + ' ' : ''}${r.title}`,
          group: `${p.name} / ${card.title}`,
          groupKey: card.key
        })
      }
    }
  }
  return out
})

// Ports per workspace for the status bar popover.
const statusPortGroups = computed(() => {
  const groups = []
  for (const p of sidebarProjects.value) {
    for (const card of buildProjectCards(p)) {
      const ports = portScanner.state.byCard[card.key] || []
      if (ports.length) groups.push({ key: card.key, name: `${p.name} / ${card.title}`, ports })
    }
  }
  return groups
})

function closeMenus() {
  launcher.open = false
  openMenu.value = null
}

function onDocPointerDown(e) {
  if (
    e.target.closest('.menu-group') ||
    e.target.closest('.toolbar-menu') ||
    e.target.closest('.launch-menu') ||
    e.target.closest('.launch-trigger')
  )
    return
  closeMenus()
}

function selectedShellName() {
  return shells.value.find((shell) => shell.id === selectedShell.value)?.name || 'Shell'
}

// An overlay closes (palette, confirmation, notes, review): the keyboard
// goes back to the pane in use, unless something else took it meanwhile.
function focusActivePane() {
  nextTick(() => {
    const el = document.activeElement
    if (el && el !== document.body && !el.closest('.pal, .help-card, .notes-panel, .review-panel')) return
    focusActiveInput()
  })
}
watch(
  () => [paletteOpen.value, !!confirmState.value, !!notesView.value, !!reviewTask.value, !!imageView.value, !!fileView.value],
  (now, before) => {
    if (before && now.some((v, i) => before[i] && !v)) focusActivePane()
  }
)

// A dialog is open over the panes: the pane shortcuts (split, close, restart,
// broadcast, move focus…) must not act on the terminals behind it.
function dialogOpen() {
  return (
    settingsOpen.value ||
    mcpOpen.value ||
    toolsOpen.value ||
    sessionsOpen.value ||
    helpOpen.value ||
    updateOpen.value ||
    newTaskOpen.value ||
    paletteOpen.value ||
    finderOpen.value ||
    githubOpen.value ||
    linearOpen.value ||
    !!confirmState.value ||
    !!imageView.value ||
    !!fileView.value ||
    launcher.open
  )
}

// Typing in a text field of Tessel (notes, review, a form, the sidebar):
// pane shortcuts must not act on the terminals behind it.
function typingInField(e) {
  const t = e.target
  if (!t || !t.closest) return false
  if (t.closest('.xterm')) return false // a terminal: shortcuts are for it
  // The code editor: its pane hands Tessel's shortcuts over itself
  // (EditorPane's capture handler, opts.fromEditor below).
  if (t.closest('.monaco-editor, .editor-pane')) return true
  return !!t.closest('input, textarea, select, [contenteditable="true"]')
}

function onKey(e, opts = {}) {
  if (!opts.fromEditor && typingInField(e) && e.key !== 'Escape' && e.key !== 'F1') return
  if (dialogOpen()) {
    // Ctrl+, and F1 close their own dialog; they never open one over another.
    if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key === ',') {
      e.preventDefault()
      settingsOpen.value = false
    } else if (e.key === 'F1') {
      e.preventDefault()
      helpOpen.value = false
    }
    // Escape is left to the dialog itself (and to the closing code below).
    if (e.key !== 'Escape') return
  }
  if (e.ctrlKey && e.shiftKey) {
    const k = e.key.toLowerCase()
    if (k === 'e') {
      e.preventDefault()
      splitActive('row')
    } else if (k === 'o') {
      e.preventDefault()
      splitActive('col')
    } else if (k === 'w') {
      e.preventDefault()
      closeActive()
    } else if (k === 'b') {
      e.preventDefault()
      toggleBroadcast()
    } else if (k === 'k') {
      e.preventDefault()
      toggleTaskPanel()
    } else if (k === 'x') {
      e.preventDefault()
      toggleExplorer()
    } else if (k === 'g') {
      // Orca's Show Source Control (Mod+Shift+G).
      e.preventDefault()
      toggleSideTab('changes')
    } else if (k === 'n') {
      e.preventDefault()
      createWorkspace()
    } else if (k === 't') {
      e.preventDefault()
      newDefaultTerminal()
    } else if (k === ' ') {
      e.preventDefault()
      openLauncherCentered()
    } else if (k === 'r') {
      e.preventDefault()
      restartActive()
    } else if (k === 'p') {
      e.preventDefault()
      togglePalette()
    } else if (k === 'j') {
      e.preventDefault()
      openFinder()
    }
  }
  if (e.ctrlKey && !e.shiftKey && !e.altKey) {
    if (e.key === '=' || e.key === '+') {
      e.preventDefault()
      zoom(1)
    } else if (e.key === '-') {
      e.preventDefault()
      zoom(-1)
    } else if (e.key === '0') {
      e.preventDefault()
      zoom(0)
    }
  }
  if (e.altKey && !e.ctrlKey && !e.shiftKey && e.key.startsWith('Arrow')) {
    e.preventDefault()
    moveFocus(e.key.slice(5).toLowerCase())
  }
  if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key === ',') {
    e.preventDefault()
    settingsOpen.value = !settingsOpen.value
  }
  if (e.key === 'F1') {
    e.preventDefault()
    helpOpen.value = !helpOpen.value
  }
  // Ctrl+PageUp / Ctrl+PageDown switch workspaces. (Ctrl+Alt is avoided: on
  // many European layouts it is AltGr, used to type characters like @ and {.)
  if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === 'PageUp' || e.key === 'PageDown')) {
    e.preventDefault()
    cycleWorkspace(e.key === 'PageUp' ? -1 : 1)
  }
  if (e.key === 'Escape') {
    // Escape always restores a maximized pane — a safety net so a maximized
    // pane can never become a dead-end if its Restore button is obscured.
    if (maximizedId.value) maximizedId.value = null
    helpOpen.value = false
    settingsOpen.value = false
    mcpOpen.value = false
    toolsOpen.value = false
    sessionsOpen.value = false
    if (!githubBusy.value) githubOpen.value = false
    if (!linearBusy.value) linearOpen.value = false
    closeMenus()
  }
}

// Output saved when the app last closed, by pane id (read once at startup).
let savedOutput = {}

async function restoreOrSeedLayout() {
  if (window.shellApi.loadScrollback) {
    try {
      savedOutput = (await window.shellApi.loadScrollback()) || {}
    } catch {
      savedOutput = {}
    }
  }
  const def = shells.value.find((s) => s.id === 'powershell') || shells.value[0]
  selectedShell.value = def ? def.id : null

  let saved = null
  try {
    saved = await loadUnlocked(() => window.shellApi.loadLayout())
  } catch {
    saved = null
  }
  // Still locked (another program holds the file): start, but never save
  // over the user's saved workspaces during this session.
  if (saved && saved.locked === true) {
    layoutLocked = true
    // The previous copy is shown when there is one; nothing is saved.
    saved = saved.backup && typeof saved.backup === 'object' ? saved.backup : null
    showToast(t('app.layout.locked', 'Your saved workspaces could not be read (the file is in use by another program). Tessel shows its previous copy and will not save the layout until it is restarted, so the file stays intact.'), { kind: 'error', timeout: 20000 })
  }

  if (saved) {
    if (saved.selectedShell && shells.value.some((s) => s.id === saved.selectedShell)) {
      selectedShell.value = saved.selectedShell
    }
    broadcast.value = !!saved.broadcast
    sidebarCollapsed.value = !!saved.sidebarCollapsed
    // The task board opens again if it was open.
    if (saved.taskPanelOpen === true) taskPanelOpen.value = true
    // The side panel's tab (the file explorer was a panel of its own before).
    if (SIDE_TABS.includes(saved.sidePanelTab)) sideTab.value = saved.sidePanelTab
    else if (saved.explorerOpen === true && saved.taskPanelOpen !== true) {
      sideTab.value = 'files'
      taskPanelOpen.value = true
    }
    if (Number.isFinite(saved.taskPanelWidth))
      taskPanelWidth.value = Math.round(Math.min(TASK_PANEL_MAX, Math.max(TASK_PANEL_MIN, saved.taskPanelWidth)))
    if (Number.isFinite(saved.sidebarWidth)) {
      sidebarWidth.value = Math.min(500, Math.max(220, saved.sidebarWidth))
    }
    // Older saves kept only the font size at the top level.
    loadSettings(
      saved.settings || (Number.isFinite(saved.fontSize) ? { fontSize: saved.fontSize } : null)
    )
    // (A saved "new workspace" from before is now Right: it has its own button.)
    if (['left', 'right', 'down'].includes(saved.placement)) placement.value = saved.placement
    if (Array.isArray(saved.teams)) teams.value = saved.teams.filter(isTeam)
    // v2 stores a list of workspaces; v1 stored a single tree.
    const snaps = !settings.restoreWorkspaces
      ? []
      : Array.isArray(saved.workspaces)
        ? saved.workspaces
        : saved.tree
          ? [{ name: defaultWorkspaceName(1), tree: saved.tree }]
          : []
    for (const snap of snaps) {
      const ws = makeWorkspace(snap.name || nextWorkspaceName())
      // Keep the saved id: task boards are linked to their workspace by it.
      if (
        typeof snap.id === 'string' &&
        /^ws-[\w-]+$/.test(snap.id) &&
        !workspaces.value.some((w) => w.id === snap.id)
      )
        ws.id = snap.id
      ws.cwd = typeof snap.cwd === 'string' && snap.cwd ? snap.cwd : null
      ws.remote = savedRemote(snap.remote)
      if (ws.remote) ws.cwd = null
      ws.group = savedGroup(snap.group)
      try {
        ws.tree = await deserializeNode(snap.tree, ws.cwd)
      } catch {
        ws.tree = null
      }
      if (!ws.tree) {
        const leaf = await createLeaf(selectedShell.value, null, ws.cwd, null, wsLeafOpts(ws))
        if (!leaf) continue
        ws.tree = leaf
      }
      ws.activeId = firstLeafId(ws.tree)
      workspaces.value.push(ws)
    }
    if (workspaces.value.length) {
      const idx = Math.min(Math.max(0, saved.currentIndex || 0), workspaces.value.length - 1)
      currentWsId.value = workspaces.value[idx].id
      return
    }
  }

  const ws = makeWorkspace(defaultWorkspaceName(1))
  workspaces.value.push(ws)
  currentWsId.value = ws.id
  await buildGrid(3, 2, ws)
}

// Startup that never finishes leaves teams off (teamsReady): logged, with
// the step it is at.
let startStep = 'shells'
const startWatch = setTimeout(() => {
  if (!teamsReady && window.shellApi.log)
    window.shellApi.log('error', `startup not finished after 60 s, at "${startStep}": team work is waiting for it`)
}, 60000)
onBeforeUnmount(() => clearTimeout(startWatch))

onMounted(async () => {
  shells.value = await window.shellApi.listShells()
  startStep = 'agents list'
  agents.value = await window.shellApi.listAgents()
  // The model lists the agents' CLIs gave last time (before any launch, so a
  // pane's model flags are the same at launch and when compared later).
  startStep = 'model lists'
  await loadModelLists()
  startStep = 'layout'
  await restoreOrSeedLayout()
  startStep = 'terminals'
  if (window.shellApi.reconcilePtys) {
    const ids = []
    forEachWsLeaf((l) => !hasNoTerminal(l) && ids.push(l.id))
    window.shellApi.reconcilePtys(ids)
  }
  loadVoiceLanguages()
  // Settings (incl. your own agents) are loaded now; detect agents with them.
  startStep = 'agent detection'
  await loadAgents()
  watch(
    () => settings.customAgents.map((a) => a.command).join('|'),
    () => loadAgents(),
    {}
  )

  // Persist on any structural / size / title / broadcast change (debounced).
  pruneTeams()
  loadActivity().then(hydrateTracking)
  persistReady = !layoutLocked
  watch(
    [
      workspaces,
      currentWsId,
      selectedShell,
      broadcast,
      sidebarCollapsed,
      sidebarWidth,
      taskPanelWidth,
      taskPanelOpen,
      sideTab,
      settings,
      placement,
      teams
    ],
    scheduleSave,
    {
      deep: true
    }
  )
  // Also capture the initial (seeded or restored) state so an untouched
  // workspace still persists across launches.
  scheduleSave()

  // Hydrate the task board from its own persisted store, then debounce-save on
  // any change. The watch is registered AFTER hydration so loading the saved
  // tasks doesn't immediately trigger a redundant save.
  try {
    startStep = 'task board'
    // The layout already waited for its lock: no second long wait.
    const saved = await loadUnlocked(() => window.shellApi.taskBoard.load({ withLedger: true }), layoutLocked ? 2 : 10)
    if (saved && saved.locked === true) {
      boardLocked = true
      if (Array.isArray(saved.tasks)) setTasks(saved.tasks) // its previous copy, shown only
      showToast(t('app.board.locked', 'Your task board could not be read (the file is in use by another program). Tessel shows its previous copy and will not save it until it is restarted, so the file stays intact.'), { kind: 'error', timeout: 20000 })
    } else {
      const savedTasks = Array.isArray(saved) ? saved : saved && saved.tasks
      if (Array.isArray(savedTasks)) setTasks(savedTasks)
      for (const k of (saved && saved.appliedRequests) || []) appliedRequests.add(k)
    }
  } catch {
    /* start with an empty board if persisted tasks can't be read */
  }
  // Drop assignments to panes that didn't survive into this session, then start
  // saving. Reconciling before the watch is registered keeps it from writing the
  // file back on every launch (the cleanup is idempotent and persists on the
  // next real change).
  reconcileTaskPanes()
  if (!boardLocked) watch(boardTasks, scheduleTaskSave, { deep: true })
  teamsReady = true
  // Scheduled automations start only now: panes, agents and the board are
  // there to run them (and to follow the runs still going).
  startStep = 'automations'
  await startAutomations()
  // The tessel command's requests (open, new pane, status, card) from now on.
  startCliRequests()

  window.addEventListener('keydown', onKey)
  window.addEventListener('pointerdown', onDocPointerDown, true)
  // The code editor: its notices, files changed on disk, and closing the
  // window with unsaved files (the main process asks through here).
  setEditorHooks({ toast: (text, opts) => showToast(text, opts) })
  startDiskWatch()
  watch(() => [settings.editorAutoSave, settings.editorAutoSaveDelayMs], autoSaveSettingsChanged)
  if (window.shellApi.editor && window.shellApi.editor.onConfirmClose) {
    unsubEditorClose = window.shellApi.editor.onConfirmClose(async () => {
      const dirty = Object.values(editorDocs)
        .filter((d) => d.dirty)
        .map((d) => d.path)
      if (dirty.length && !(await askEditorClose(dirty))) return
      saveLayoutNow()
      window.shellApi.editor.closeWindow()
    })
  }
  unsubFocusPane = window.shellApi.onFocusPane
    ? window.shellApi.onFocusPane(({ paneId }) => focusPane(paneId))
    : null
  initUpdates()
})

let unsubFocusPane = null
let unsubEditorClose = null

// A saved file another program holds for a moment (antivirus, backup): the
// main process answers { locked: true }; tried again every second (about 15 s
// in all, each try also waits briefly in the main process) before giving up.
// Given up: the file is left alone (never saved over).
let layoutLocked = false
let boardLocked = false
async function loadUnlocked(load, tries = 10) {
  let res = await load()
  for (let i = 1; i < tries && res && res.locked === true; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    res = await load()
  }
  return res
}

// Closing or reloading the window: what is waiting to be saved (layout,
// board, activity; saved a moment after each change) is written now, so the
// last change before closing is not lost.
function flushSaves() {
  saveLayoutNow()
  if (taskSaveTimer) {
    clearTimeout(taskSaveTimer)
    taskSaveTimer = null
    saveBoard()
  }
  saveActivityNow()
}
window.addEventListener('beforeunload', flushSaves)
window.addEventListener('pagehide', flushSaves)

onBeforeUnmount(() => {
  if (unsubFocusPane) unsubFocusPane()
  if (unsubEditorClose) unsubEditorClose()
  if (unsubUpdate) unsubUpdate()
  flushSaves()
  window.removeEventListener('beforeunload', flushSaves)
  window.removeEventListener('pagehide', flushSaves)
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('pointerdown', onDocPointerDown, true)
})
</script>

<template>
  <div class="app">
    <div class="toolbar">
      <!-- Left: who and where (app, then the workspace switcher). -->
      <div class="tb-left">
        <div class="brand" :class="{ dev: isDev }">
          <svg
            class="brand-logo"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
          >
            <rect
              x="2"
              y="3"
              width="20"
              height="18"
              rx="4"
              stroke="currentColor"
              stroke-width="1.8"
            />
            <path d="M12 3v18M12 12h10" stroke="currentColor" stroke-width="1.8" />
            <path
              d="M5.5 8.5l2 1.8-2 1.8"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
          <span class="brand-name">Tessel</span>
          <span v-if="isDev" class="brand-dev" :title="t('app.toolbar.devBuild', 'Development build (npm run dev)')">{{ t('app.toolbar.dev', 'dev') }}</span>
        </div>
        <span class="tb-slash">/</span>
        <div class="menu-group" @pointerdown.stop>
          <button
            class="tb-ws"
            :class="{ open: openMenu === 'workspaces' }"
            :title="t('app.toolbar.switchWorkspace', 'Switch workspace (Ctrl+PageUp / Ctrl+PageDown)')"
            aria-haspopup="menu"
            @click="toggleMenu('workspaces')"
          >
            <span class="tb-ws-name">{{ currentWs ? currentWs.name : t('app.toolbar.workspace', 'Workspace') }}</span>
            <svg
              class="chev"
              width="10"
              height="10"
              viewBox="0 0 16 16"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M4 6l4 4 4-4"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </button>
          <div v-if="openMenu === 'workspaces'" class="toolbar-menu ws-menu" role="menu">
            <div class="menu-label">{{ t('app.toolbar.workspaces', 'Workspaces') }}</div>
            <button
              v-for="w in workspaces"
              :key="w.id"
              class="toolbar-menu-item"
              :class="{ selected: w.id === currentWsId }"
              role="menuitem"
              @click="menuAction(() => selectWorkspace(w.id))"
            >
              <span class="menu-item-name">{{ w.name }}</span>
              <span v-if="w.cwd" class="menu-shortcut ws-path">{{ w.cwd }}</span>
              <svg
                v-if="w.id === currentWsId"
                class="check"
                width="12"
                height="12"
                viewBox="0 0 16 16"
                fill="none"
                aria-hidden="true"
              >
                <path
                  d="M3 8.5l3.2 3L13 4.5"
                  stroke="currentColor"
                  stroke-width="1.8"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
            </button>
            <div class="menu-sep"></div>
            <button class="toolbar-menu-item" role="menuitem" @click="menuAction(createWorkspace)">
              <span class="menu-item-name">{{ t('app.toolbar.newWorkspace', 'New workspace') }}</span>
              <span class="menu-shortcut">Ctrl+Shift+N</span>
            </button>
          </div>
        </div>
      </div>

      <!-- Middle: one search box that finds panes, workspaces and commands. -->
      <div class="tb-center">
        <button class="tb-command" :title="t('app.toolbar.palette', 'Command palette (Ctrl+Shift+P)')" @click="openPalette">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <circle cx="7" cy="7" r="4.6" stroke="currentColor" stroke-width="1.4" />
            <path
              d="M10.4 10.4L14 14"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linecap="round"
            />
          </svg>
          <span class="tb-command-text">{{ t('app.toolbar.search', 'Search panes, run a command') }}</span>
          <kbd class="tb-command-kbd">Ctrl+Shift+P</kbd>
        </button>
      </div>

      <!-- Right: create, then icon-only toggles with tooltips. -->
      <div class="tb-right">
        <button
          v-if="updateStatus.state === 'ready'"
          class="tb-update"
          :title="t('app.toolbar.updateReady', 'Tessel {{version}} is ready: restart to update', { version: updateStatus.version })"
          @click="updateOpen = true"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M8 12.5V3.5M4.2 7.3L8 3.5l3.8 3.8"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
          {{ updateLabel }}
        </button>

        <div class="tb-newsplit launch-trigger" @pointerdown.stop>
          <button
            class="tb-icon"
            :title="t('app.toolbar.newShell', 'New {{name}} (Ctrl+Shift+T)', { name: selectedShellName() })"
            :aria-label="t('app.toolbar.newTerminal', 'New terminal')"
            @click="newDefaultTerminal"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M8 3.2v9.6M3.2 8h9.6"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
              />
            </svg>
          </button>
          <button
            class="tb-icon tb-icon-narrow"
            :class="{ open: launcher.open }"
            :title="t('app.toolbar.launcher', 'Open a terminal or an agent (Ctrl+Shift+Space)')"
            aria-haspopup="menu"
            :aria-expanded="launcher.open"
            @click="toggleLauncher"
          >
            <svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M4 6l4 4 4-4"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </button>
        </div>

        <span class="toolbar-sep"></span>

        <UsageMenu @details="openSettingsAt('stats')" @accounts="openSettingsAt('accounts')" />
        <NotificationsMenu @focus-pane="focusPane" />
        <div class="menu-group" @pointerdown.stop>
          <button class="tb-icon" :aria-label="t('app.toolbar.issues', 'Issues')" :title="t('app.toolbar.issuesTitle', 'GitHub and Linear issues')" aria-haspopup="menu" :aria-expanded="openMenu === 'issues'" @click="toggleMenu('issues')">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="5.7" stroke="currentColor" stroke-width="1.3" /><path d="M8 4.5v4M8 11h.01" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg>
          </button>
          <div v-if="openMenu === 'issues'" class="toolbar-menu align-right" role="menu">
            <button class="toolbar-menu-item" role="menuitem" @click="openGitHub()">{{ t('app.toolbar.githubIssues', 'GitHub issues and PRs') }}</button>
            <button class="toolbar-menu-item" role="menuitem" @click="openLinear">{{ t('app.toolbar.linearIssues', 'Linear issues') }}</button>
          </div>
        </div>
        <button
          class="tb-icon"
          :class="{ on: broadcast, warn: broadcast }"
          :title="broadcast ? t('app.toolbar.broadcastOn', 'Broadcast is on: type once into every pane with write checked (Ctrl+Shift+B)') : t('app.toolbar.broadcastOff', 'Broadcast is off: type once into every pane with write checked (Ctrl+Shift+B)')"
          :aria-label="t('app.toolbar.broadcast', 'Broadcast')"
          :aria-pressed="broadcast"
          @click="toggleBroadcast"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <circle cx="8" cy="8" r="1.5" fill="currentColor" />
            <path
              d="M5.3 5.3a3.8 3.8 0 000 5.4M10.7 5.3a3.8 3.8 0 010 5.4M3.3 3.3a6.6 6.6 0 000 9.4M12.7 3.3a6.6 6.6 0 010 9.4"
              stroke="currentColor"
              stroke-width="1.3"
              stroke-linecap="round"
            />
          </svg>
        </button>
        <button
          class="tb-icon"
          :class="{ on: explorerOpen }"
          :title="t('app.toolbar.files', 'Files (Ctrl+Shift+X)')"
          :aria-label="t('app.toolbar.fileExplorer', 'File explorer')"
          :aria-pressed="explorerOpen"
          data-test="explorer-button"
          @click="toggleExplorer"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M1.8 3.5h4.4l1.4 1.5h6.6v8.5H1.8z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />
          </svg>
        </button>
        <button
          class="tb-icon"
          :class="{ on: taskBoardShown }"
          :title="t('app.toolbar.taskBoardTitle', 'Task board (Ctrl+Shift+K)')"
          :aria-label="t('app.toolbar.taskBoard', 'Task board')"
          :aria-pressed="taskBoardShown"
          data-test="tasks-button"
          @click="toggleTaskPanel"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <rect
              x="2"
              y="2.5"
              width="12"
              height="11"
              rx="2"
              stroke="currentColor"
              stroke-width="1.3"
            />
            <path
              d="M5 6.2l1.3 1.3L8.6 5.2M5 10.3h6"
              stroke="currentColor"
              stroke-width="1.3"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
        <div class="menu-group" @pointerdown.stop>
          <button
            class="tb-icon"
            :class="{ open: openMenu === 'layout' }"
            :title="t('app.toolbar.layoutTitle', 'Layout: split and arrange panes')"
            :aria-label="t('app.toolbar.layout', 'Layout')"
            aria-haspopup="menu"
            @click="toggleMenu('layout')"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <rect
                x="1.8"
                y="2.3"
                width="12.4"
                height="11.4"
                rx="2"
                stroke="currentColor"
                stroke-width="1.3"
              />
              <path d="M8 2.3v11.4M8 8h6.2" stroke="currentColor" stroke-width="1.3" />
            </svg>
          </button>
          <div
            v-if="openMenu === 'layout'"
            class="toolbar-menu align-right layout-menu"
            role="menu"
          >
            <button
              class="toolbar-menu-item"
              role="menuitem"
              @click="menuAction(() => splitActive('row'))"
            >
              <span class="menu-item-name">{{ t('app.toolbar.splitRight', 'Split right') }}</span>
              <span class="menu-shortcut">Ctrl+Shift+E</span>
            </button>
            <button
              class="toolbar-menu-item"
              role="menuitem"
              @click="menuAction(() => splitActive('col'))"
            >
              <span class="menu-item-name">{{ t('app.toolbar.splitDown', 'Split down') }}</span>
              <span class="menu-shortcut">Ctrl+Shift+O</span>
            </button>
            <div class="menu-sep"></div>
            <div class="menu-label">{{ t('app.toolbar.evenGrid', 'Even grid') }}</div>
            <div class="grid-chips">
              <button
                v-for="option in gridOptions"
                :key="option.value"
                class="grid-chip"
                :title="t('app.toolbar.arrangeGrid', 'Arrange this workspace into {{grid}}', { grid: option.label })"
                @click="applyGrid(option.value)"
              >
                {{ option.label }}
              </button>
            </div>
            <div class="menu-sep"></div>
            <button
              class="toolbar-menu-item danger"
              role="menuitem"
              @click="menuAction(closeActive)"
            >
              <span class="menu-item-name">{{ t('app.toolbar.closeActive', 'Close active pane') }}</span>
              <span class="menu-shortcut">Ctrl+Shift+W</span>
            </button>
          </div>
        </div>
        <button
          class="tb-icon"
          :title="t('app.toolbar.settingsTitle', 'Settings (Ctrl+,)')"
          :aria-label="t('app.toolbar.settings', 'Settings')"
          @click="settingsOpen = true"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M12 15a3 3 0 100-6 3 3 0 000 6z" stroke="currentColor" stroke-width="1.6" />
            <path
              d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
      </div>
    </div>

    <div v-if="broadcast" class="broadcast-banner">
      {{ t('app.toolbar.broadcastBanner', 'Broadcast is on. Keystrokes go to every pane with "write" checked.') }}
    </div>

    <div class="workspace">
      <WorkspaceSidebar
        v-if="workspaces.length"
        ref="sidebarEl"
        :projects="sidebarProjects"
        :current-id="currentWsId"
        :collapsed="sidebarCollapsed"
        :width="sidebarWidth"
        :teams="teams"
        :ports="portScanner.state.byCard"
        :now="clock"
        @create-team="createTeam"
        @add-to-team="addToTeam"
        @rename-team="renameTeam"
        @disband-team="disbandTeam"
        @leave-team="leaveTeam"
        @set-lead="setTeamLead"
        @message-team="messageTeam"
        @activity="openActivity"
        @focus-pane="focusPane"
        @message-ws="messageWorkspace"
        @notes-ws="openNotesView"
        @new-task="openNewTask"
        @select="selectWorkspace"
        @create="openAddProject"
        @rename="renameWorkspace"
        @remove="removeWorkspace"
        @folder="setWorkspaceFolder"
        @toggle="toggleSidebar"
        @resize="resizeSidebar"
        @resize-end="refitSoon"
        @search="openPalette"
        @open-card="openCard"
        @mark-read="markPanesRead"
        @mark-unread="markPaneUnread"
        @sleep="sleepPanes"
        @copy="copyText"
        @reveal="revealFolder"
        @delete-task="deleteTask"
        @review-task="openReview"
        @port-open="openPort"
        @port-copy="copyPort"
        @port-stop="stopPort"
      />
      <div class="workspace-main">
        <div
          v-for="ws in workspaces"
          :key="ws.id"
          class="ws-layer"
          :class="{ hidden: ws.id !== currentWsId }"
          :aria-hidden="ws.id !== currentWsId"
        >
          <SplitNode v-if="ws.tree" :node="ws.tree" />
        </div>
        <div v-if="!tree" class="startup-message">
          {{ initError || t('app.main.starting', 'Starting...') }}
        </div>
      </div>
      <aside
        v-if="taskPanelOpen"
        class="task-panel"
        :class="{ resizing: taskResizing }"
        :style="{ flexBasis: taskPanelShown + 'px' }"
      >
        <div
          class="task-resize"
          :title="t('app.main.resizeHint', 'Drag to resize. Double-click to reset.')"
          @pointerdown="startTaskResize"
        ></div>
        <SidePanel
          v-model:tab="sideTab"
          :root="sideRoot"
          :can-insert="canInsertPath"
          :agent-panes="agentPanes"
          :workspace-id="currentWsId"
          :remote="sideRemote"
          @close="closeSidePanel"
          @open="openExplorerFile"
          @open-diff="openScmDiff"
          @create-pr="openCreatePr"
          @open-editor="(file) => openInTesselEditor({ file, preview: false })"
          @open-external="(file) => openExternally({ file })"
          @terminal-here="terminalHere"
          @insert-path="insertPathInPane"
          @toast="(t) => showToast(t, { timeout: 5000 })"
          @new-task="openNewTask"
          @focus-pane="focusPane"
          @review="openReview"
        />
      </aside>
    </div>

    <StatusBar
      v-if="settings.statusBarVisible"
      :info="statusInfo"
      :keep-awake-active="wantAwake"
      :terminals="statusTerminals"
      :port-groups="statusPortGroups"
      :external-ports="portScanner.state.external"
      :ports-refreshing="portScanner.state.refreshing"
      :ports-unavailable="portScanner.state.unavailableReason"
      :agent-updating="agentUpdatingNow"
      @open-agent-updates="openSettingsAt('agents')"
      @focus-pane="focusPane"
      @activate-card="activateCardByKey"
      @port-open="openPort"
      @port-copy="copyPort"
      @port-stop="stopPort"
      @refresh-ports="portScanner.refresh()"
    />

    <LaunchMenu
      v-if="launcher.open"
      :shells="shells"
      :agents="launchableAgents"
      :default-shell="selectedShell"
      :placement="placement"
      :target-title="launcherTargetTitle"
      :worktree="worktreeState"
      :use-worktree="useWorktree"
      @worktree="(v) => (useWorktree = v)"
      @tools="openTools"
      @install="installAgent"
      :x="launcher.x"
      :y="launcher.y"
      @launch="onLauncherLaunch"
      @set-default="setDefaultShell"
      @placement="(p) => (placement = p)"
      @close="launcher.open = false"
    />

    <div v-if="paneDrag.active" class="drag-layer">
      <div
        v-if="paneDrag.zoneRect"
        class="drop-zone"
        :style="{
          left: paneDrag.zoneRect.left + 'px',
          top: paneDrag.zoneRect.top + 'px',
          width: paneDrag.zoneRect.width + 'px',
          height: paneDrag.zoneRect.height + 'px'
        }"
      >
        <span class="drop-zone-label">{{ paneDrag.label }}</span>
      </div>
      <div
        class="drag-ghost"
        :style="{ left: paneDrag.x + 14 + 'px', top: paneDrag.y + 14 + 'px' }"
      >
        <BrandIcon :kind="paneDrag.kind || ''" :size="14" />
        <span>{{ paneDrag.title }}</span>
      </div>
    </div>

    <SessionsDialog
      v-if="sessionsOpen"
      :cwd="currentWs ? currentWs.cwd : null"
      :open-ids="openSessionIds"
      @resume="resumeSession"
      @show="
        (id) => {
          sessionsOpen = false
          focusPane(id)
        }
      "
      @copied="showToast(t('app.sessions.copied', 'Session ID copied.'), { timeout: 2000 })"
      @close="closeSessions"
    />

    <ToolsDialog
      v-if="toolsOpen"
      :agents="agents"
      @run="runInPane"
      @install-agent="installAgent"
      @refresh="loadAgents(true)"
      @close="closeTools"
    />

    <McpDialog
      v-if="mcpOpen"
      :initial-tab="mcpTab"
      :cwd="currentWs ? currentWs.cwd : null"
      :agents="agents"
      @run="
        (job) => {
          mcpOpen = false
          runInPane(job)
        }
      "
      @tools="
        () => {
          mcpOpen = false
          openTools()
        }
      "
      @close="closeMcp"
    />

    <UpdateDialog
      v-if="updateOpen"
      :status="updateStatus"
      :panes="paneCount()"
      :installing="updateInstalling"
      @install="installUpdate"
      @close="updateOpen = false"
    />

    <CommandPalette v-if="paletteOpen" :commands="paletteCommands" @close="paletteOpen = false" />
    <AddProjectDialog
      v-if="addProjectOpen"
      :project-count="workspaces.length"
      @add="addProjects"
      @manage-hosts="manageHostsFromAddProject"
      @close="addProjectOpen = false"
    />
    <GitHubDialog v-if="githubOpen" :cwd="issueWorkspace?.cwd || ''" :pr-cwd="githubTaskContext?.cwd || ''" :pr-base="githubTaskContext?.base || ''" :initial-mode="githubTaskContext ? 'createPr' : ''" :agents="taskAgentKinds" :default-agent="settings.defaultAgent || ''" :start-issue="prepareLinkedIssue" @busy="githubBusy = $event" @close="githubOpen = false" />
    <LinearDialog v-if="linearOpen" :cwd="issueWorkspace?.cwd || ''" :agents="taskAgentKinds" :default-agent="settings.defaultAgent || ''" :start-issue="prepareLinkedIssue" @busy="linearBusy = $event" @close="linearOpen = false" />
    <FileFinder
      v-if="finderOpen"
      :root="finderRoot()"
      :can-insert="canInsertPath"
      @open="openFoundFile"
      @insert="insertFoundPath"
      @close="finderOpen = false"
    />

    <FileViewer
      v-if="fileView"
      :file="fileView.file"
      :label="fileView.label"
      :line="fileView.line"
      @open-editor="openViewedInEditor"
      @open-external="openExternally"
      @open="openFromViewer"
      @close="fileView = null"
    />

    <ImageViewer
      v-if="imageView"
      :src="imageView.src"
      :title="imageView.title"
      :file="imageView.file"
      @close="imageView = null"
    />

    <ConfirmDialog
      v-if="confirmState"
      :title="confirmState.title"
      :text="confirmState.text || ''"
      :confirm-label="confirmState.confirmLabel || 'OK'"
      :alt-label="confirmState.altLabel || ''"
      :danger="!!confirmState.danger"
      @answer="answerConfirm"
    />

    <NewTaskDialog
      v-if="newTaskOpen"
      :ws-name="currentWs ? currentWs.name : ''"
      :cwd="currentWs && currentWs.cwd ? currentWs.cwd : ''"
      :agent-kinds="taskAgentKinds"
      :open-agents="taskOpenAgents"
      :isolation="worktreeState"
      @start="startTask"
      @close="newTaskOpen = false"
    />

    <ReviewPanel
      v-if="reviewTask"
      :key="reviewTask.id"
      :task="reviewTask"
      :agent-label="reviewAgentLabel"
      :actions="reviewActions"
      @close="reviewTaskId = null"
    />

    <NotesPanel
      v-if="notesView"
      :key="notesView.wsId"
      :dir="notesView.dir"
      :ws-name="notesView.wsName"
      :template="notesView.template"
      @open-external="openProjectNotes(notesView.wsId)"
      @close="notesView = null"
    />

    <ActivityPanel
      v-if="activityOpen"
      v-model:scope="activityScope"
      :events="activity"
      :live="agentStates"
      :scopes="activityScopes"
      @focus-pane="(id) => ((activityOpen = false), focusPane(id))"
      @close="activityOpen = false"
    />

    <SettingsDialog
      v-if="settingsOpen"
      :shells="shells"
      :default-shell="selectedShell"
      :update-status="updateStatus"
      :section="settingsSection"
      :agents="agents"
      :worktree-paths="usageWorktreePaths"
      :agent-updates="agentUpdateInfo"
      :agent-update-jobs="agentUpdateJobs"
      :agent-update-queue="updateQueue"
      @detect-agents="(done) => loadAgents(true).finally(done)"
      @check-agent-updates="(done) => checkAgentUpdates({ force: true }).finally(done)"
      :agent-update-history="agentUpdateHistory"
      @update-agent="requestAgentUpdate"
      @update-agent-in-pane="(id) => requestAgentUpdate(id, { pane: true })"
      @close-reopen-agent-update="closeAndReopenForUpdate"
      @open-update-log="openUpdateLog"
      @update-all-agents="updateAllAgents"
      @cancel-agent-update="cancelAgentUpdate"
      @open-connections="((settingsOpen = false), (mcpTab = 'connections'), (mcpOpen = true))"
      @check-updates="checkForUpdates"
      @open-update="((settingsOpen = false), (updateOpen = true))"
      @set-default-shell="setDefaultShell"
      @test-notification="sendTestNotification"
      @close="closeSettings"
    />

    <SshPasswordDialog />

    <div class="toasts" aria-live="polite">
      <UpdateCard :status="updateStatus" :release-url="updateReleaseUrl" @update="updateOpen = true" />
      <div v-for="toast in toasts" :key="toast.id" class="toast" :class="toast.kind">
        <span class="toast-text">{{ toast.text }}</span>
        <button v-if="toast.action" class="toast-action" @click="runToastAction(toast)">
          {{ toast.action.label }}
        </button>
        <button class="toast-close" :title="t('app.toast.dismiss', 'Dismiss')" @click="dismissToast(toast.id)">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M4 4l8 8M12 4l-8 8"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
            />
          </svg>
        </button>
      </div>
    </div>

    <div v-if="helpOpen" class="help-backdrop" @pointerdown.self="helpOpen = false">
      <div
        ref="helpCardEl"
        class="help-card"
        role="dialog"
        :aria-label="t('app.help.title', 'Keyboard shortcuts')"
        tabindex="-1"
        @keydown.escape.prevent.stop="helpOpen = false"
      >
        <div class="help-head">
          <span>{{ t('app.help.title', 'Keyboard shortcuts') }}</span>
          <button class="tb-icon" :title="t('app.help.close', 'Close (Esc)')" @click="helpOpen = false">
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
        <div class="help-grid">
          <section v-for="group in shortcuts" :key="group.title">
            <h3>{{ group.title }}</h3>
            <div v-for="row in group.rows" :key="row[1]" class="help-row">
              <span>{{ row[1] }}</span>
              <span class="help-keys">
                <kbd v-for="k in row[0].split(' ')" :key="k">{{ k }}</kbd>
              </span>
            </div>
          </section>
        </div>
        <div class="help-logs">
          <span class="set-hint">{{ t('app.help.logsHint', 'Something wrong? Logs help find the cause.') }}</span>
          <button class="exit-btn" @click="openLogs">{{ t('app.help.openLogs', 'Open logs folder') }}</button>
          <button class="exit-btn" @click="copyDiagnostics">{{ t('app.help.copyDiagnostics', 'Copy diagnostics') }}</button>
        </div>
        <p class="help-foot">
          {{ t('app.help.foot', 'Drop files on a pane to paste their paths. Select text to copy it, right-click to paste. Shift+right-click a pane for more.') }}
        </p>
      </div>
    </div>
  </div>
</template>
