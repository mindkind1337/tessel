<script setup>
import { ref, reactive, provide, watch, computed, nextTick, onMounted, onBeforeUnmount } from 'vue'
import SplitNode from './components/SplitNode.vue'
import BrandIcon from './components/BrandIcon.vue'
import TaskBoard from './components/TaskBoard.vue'
import WorkspaceSidebar from './components/WorkspaceSidebar.vue'
import LaunchMenu from './components/LaunchMenu.vue'
import SettingsDialog from './components/SettingsDialog.vue'
import UpdateDialog from './components/UpdateDialog.vue'
import { settings, loadSettings, DEFAULT_SETTINGS } from './settings'
import { THEMES } from './themes'
import McpDialog from './components/McpDialog.vue'
import CommandPalette from './components/CommandPalette.vue'
import ToolsDialog from './components/ToolsDialog.vue'
import SessionsDialog from './components/SessionsDialog.vue'
import { getPane } from './paneRegistry'
import { chainCommands } from './shellChain'
import {
  agentStatus,
  attention,
  limits,
  approvals,
  clearAgentStatus,
  clearAttention
} from './agentStatus'
import { detectApproval } from './agentLimit'
import { activity, recordActivity, loadActivity, saveActivityNow, activityChanged } from './activityStore'
import ActivityPanel from './components/ActivityPanel.vue'
import ConfirmDialog from './components/ConfirmDialog.vue'
import NotesPanel from './components/NotesPanel.vue'
import NewTaskDialog from './components/NewTaskDialog.vue'
import ReviewPanel from './components/ReviewPanel.vue'
import { parseLeadRequest, findTaskRef, leadGuide, memberGuide } from '../../shared/leadRequests'
import { trackAgent } from '../../shared/tracking'
import { pasteAndConfirm } from './deliver'
import { dropBuffer, seedBuffer } from './ptyStore'
import { tasks as boardTasks, setTasks, updateTask, removeTask, addTask } from './taskBoardStore'

const shells = ref([])
const agents = ref([])
const selectedShell = ref(null)
const broadcast = ref(false)

// --- Workspaces --------------------------------------------------------------
// Each workspace is an independent split tree with its own active pane. All
// workspaces stay mounted (hidden ones are invisible but keep their size), so
// switching never kills or resizes a running shell or agent.
const workspaces = ref([]) // [{ id, name, tree, activeId }]
const currentWsId = ref(null)
const sidebarCollapsed = ref(false)
const sidebarWidth = ref(216)

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
  return l ? l.name : 'current keyboard language'
})

// Hovering a pane in a menu outlines it, so you can see which one you pick.
const highlightId = ref(null)
const settingsOpen = ref(false)
const mcpOpen = ref(false)
const toolsOpen = ref(false)
const sessionsOpen = ref(false)
// Launcher's "separate copy" (git worktree) option for agents.
const useWorktree = ref(false)
const worktreeState = reactive({ available: false, reason: null, checking: false })

// Where the launcher opens new panes: 'right' | 'down' | 'workspace'. Saved.
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
    } else {
      const ta = document.querySelector(
        '.ws-layer:not(.hidden) .pane.active .xterm-helper-textarea'
      )
      if (ta) ta.focus()
    }
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
const currentWs = computed(() => workspaces.value.find((w) => w.id === currentWsId.value) || null)

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

const SHORTCUTS = [
  {
    title: 'Panes',
    rows: [
      ['Ctrl+Shift+T', 'New terminal (default shell)'],
      ['Ctrl+Shift+Space', 'Open a terminal or agent'],
      ['Ctrl+Shift+P', 'Command palette: find panes, workspaces, commands'],
      ['Ctrl+Shift+E', 'Split right'],
      ['Ctrl+Shift+O', 'Split down'],
      ['Ctrl+Shift+W', 'Close pane'],
      ['Ctrl+Shift+R', 'Restart pane'],
      ['Alt+Arrow', 'Move between panes'],
      ['Esc', 'Restore a maximized pane']
    ]
  },
  {
    title: 'Workspaces',
    rows: [
      ['Ctrl+Shift+N', 'New workspace'],
      ['Ctrl+PageUp', 'Previous workspace'],
      ['Ctrl+PageDown', 'Next workspace']
    ]
  },
  {
    title: 'Terminal',
    rows: [
      ['Ctrl+Shift+F', 'Find'],
      ['Ctrl+Shift+C', 'Copy'],
      ['Ctrl+Shift+V', 'Paste'],
      ['Ctrl+=', 'Bigger text'],
      ['Ctrl+-', 'Smaller text'],
      ['Ctrl+0', 'Reset text size'],
      ['Shift+PageUp', 'Scroll up in the pane'],
      ['Shift+PageDown', 'Scroll down in the pane']
    ]
  },
  {
    title: 'App',
    rows: [
      ['Ctrl+Shift+B', 'Broadcast typing to all panes'],
      ['Ctrl+Shift+K', 'Task board'],
      ['Ctrl+,', 'Settings'],
      ['Win+H', 'Voice typing (Windows)'],
      ['F1', 'This help']
    ]
  }
]

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

// Which agents we can resume, and how.
function sessionKind(agent) {
  return agent && (agent.id === 'claude' || agent.id === 'codex') ? agent.id : null
}

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
async function agentStartLine(agent, sessionId, resume) {
  const kind = sessionKind(agent)
  if (kind === 'claude') {
    if (sessionId && resume) {
      // Resume if the conversation exists. If we can't check (older app
      // version), try resuming anyway rather than reusing an id in use.
      const exists = window.shellApi.claudeSessionExists
        ? await window.shellApi.claudeSessionExists(sessionId)
        : true
      if (exists)
        return { line: `${agent.command} --resume ${sessionId}`, sessionId, resumed: true }
    }
    // No transcript yet (you never messaged it): start fresh, same id.
    const id = sessionId || newUuid()
    return { line: `${agent.command} --session-id ${id}`, sessionId: id, resumed: false }
  }
  if (kind === 'codex') {
    // Without Codex's shared daemon: with it, the team tools lose the pane's
    // identity and are closed after start (see codexSupportsNoDaemon).
    const own = window.shellApi.codexNoDaemon && (await window.shellApi.codexNoDaemon().catch(() => false)) ? ' --no-daemon' : ''
    if (sessionId && resume) return { line: `${agent.command} resume ${sessionId}${own}`, sessionId, resumed: true }
    return { line: `${agent.command}${own}`, sessionId: null, resumed: false }
  }
  return { line: agent.command, sessionId: null, resumed: false }
}

// Codex picks its own session id; find it from its session files shortly after
// the pane starts, so the pane can resume it next time.
function watchCodexSession(leaf) {
  if (!window.shellApi.findCodexSession || !leaf.startDir) return
  let tries = 0
  const tick = async () => {
    if (leaf.sessionId || !findLeaf(leaf.id) || ++tries > 60) return
    const exclude = []
    forEachWsLeaf((l) => {
      if (l.sessionId) exclude.push(l.sessionId)
    })
    try {
      const id = await window.shellApi.findCodexSession({
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
  if (!attached) {
    try {
      res = await window.shellApi.createPty({ id, shellId, cols: 80, rows: 24, cwd, projectDir })
    } catch (err) {
      res = { ok: false, error: err && err.message }
    }
    // The terminal stopped when the app closed: the pane shows what it last
    // printed above the new session (see TerminalPane).
    restoredText = res && res.ok ? opts.savedOutput || '' : ''
  }
  if (!res || !res.ok) {
    const msg = (res && res.error) || 'Could not start the terminal.'
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
    title: agent ? agent.name : res.shell.name,
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
    launchedAt: Date.now(),
    teamTools: !attached && teamToolsReady,
    toolsVersion: !attached && teamToolsReady ? teamToolsVersion : null,
    exitedAtStart: attached && !!res.exited,
    restoredText,
    broadcast: true
  })
  leaf.attached = attached
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
    if (sessionKind(agent) === 'codex' && !leaf.sessionId) watchCodexSession(leaf)
    return leaf
  }
  // Launch the agent CLI once the shell has had a moment to print its prompt.
  if (agent && agent.command) {
    const start = await agentStartLine(agent, opts.sessionId || null, !!opts.resume)
    leaf.sessionId = start.sessionId
    const line = opts.wrap ? opts.wrap(start.line) : start.line
    setTimeout(() => window.shellApi.writePty(id, `${line}\r`), 600)
    if (sessionKind(agent) === 'codex' && !leaf.sessionId) watchCodexSession(leaf)
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

// The workspace whose tree contains a pane. Pane operations target the owning
// workspace, so an async PTY spawn still lands in the right place even if the
// user switched workspaces meanwhile.
function wsOfLeaf(leafId) {
  return (
    workspaces.value.find((w) => {
      let found = false
      forEachLeaf(w.tree, (l) => {
        if (l.id === leafId) found = true
      })
      return found
    }) || null
  )
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
      launchedAt: node.launchedAt || null,
      startDir: node.startDir || null,
      num: node.num || null,
      team: node.team || null,
      teamTools: !!node.teamTools,
      toolsVersion: node.toolsVersion || null
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
    const leaf = await createLeaf(snap.shellId, agent, cwd, snap.worktree || null, {
      id: typeof snap.id === 'string' && /^pane-[\w-]+$/.test(snap.id) ? snap.id : null,
      savedOutput: snap.id ? savedOutput[snap.id] || '' : '',
      sessionId: snap.sessionId || null,
      launchedAt: Number.isFinite(snap.launchedAt) ? snap.launchedAt : null,
      startDir: typeof snap.startDir === 'string' ? snap.startDir : null,
      resume: settings.resumeAgents,
      keepOnFailure: true
    })
    if (!leaf) return null
    if (Number.isInteger(snap.num) && snap.num > 0) leaf.num = snap.num
    if (snap.teamTools) leaf.teamTools = true
    if (typeof snap.toolsVersion === 'string') leaf.toolsVersion = snap.toolsVersion
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
      tree: serializeNode(w.tree)
    }))
  }
  try {
    window.shellApi.saveLayout(JSON.parse(JSON.stringify(snapshot)))
  } catch (err) {
    console.error('Could not save the layout', err)
  }
}

async function splitLeaf(
  leafId,
  dir,
  agent = null,
  shellId = selectedShell.value,
  worktree = null,
  opts = {}
) {
  const ws = wsOfLeaf(leafId) || currentWs.value
  const leaf = await createLeaf(shellId, agent, opts.cwd || (ws && ws.cwd), worktree, opts)
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
      ? reactive({ type: 'split', id: newId('split'), dir, sizes: [50, 50], children: [ws.tree, leaf] })
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
      children: [orig, leaf]
    })
  )
  ws.activeId = leaf.id
  return leaf
}

function closeLeaf(leafId, opts = {}) {
  const ws = wsOfLeaf(leafId)
  const closing = findLeaf(leafId)
  const hadTeam = closing?.team || null
  const closingTitle = closing?.title || 'An agent'
  if (!opts.force && settings.confirmCloseAgent && ws) {
    let leaf = null
    forEachLeaf(ws.tree, (l) => {
      if (l.id === leafId) leaf = l
    })
    if (leaf && leaf.kind === 'agent') {
      askConfirm({
        title: `Close ${leaf.title}?`,
        text: 'The agent session will end. Its conversation can be resumed later from Agent sessions.',
        confirmLabel: 'Close',
        danger: true
      }).then((ok) => ok && closeLeaf(leafId, { ...opts, force: true }))
      return
    }
  }
  window.shellApi.killPty(leafId)
  dropBuffer(leafId)
  clearAgentStatus(leafId)
  if (!ws) return
  if (maximizedId.value === leafId) maximizedId.value = null
  const next = removeLeaf(ws.tree, leafId)
  if (next) {
    ws.tree = next
    if (ws.activeId === leafId) ws.activeId = firstLeafId(next)
  } else {
    ws.tree = null
    ws.activeId = null
    createLeaf(selectedShell.value, null, ws.cwd).then((leaf) => {
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
      tellTeam(hadTeam, `${closingTitle} was closed and left the team.`)
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
      const leaf = kept.length ? kept.shift() : await createLeaf(selectedShell.value, null, ws.cwd)
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

function findLeafIn(node, id) {
  let found = null
  forEachLeaf(node, (l) => {
    if (l.id === id) found = l
  })
  return found
}

// A terminal's own answer to a program's question (cursor position, device
// attributes, focus in/out): it goes back to that terminal only, never to
// the other panes.
const TERMINAL_REPLY = /^\x1b\[[?>]?[\d;]*[cRn]$|^\x1b\[[IO]$|^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)$/

function routeInput(sourceId, data) {
  // Multi-write: only typing in a pane that takes part (its "write" box
  // ticked), in the workspace on screen, goes to every such pane.
  let source = null
  forEachLeaf(tree.value, (leaf) => {
    if (leaf.id === sourceId) source = leaf
  })
  const fanOut = broadcast.value && source && source.broadcast && !TERMINAL_REPLY.test(String(data))
  if (fanOut) {
    forEachLeaf(tree.value, (leaf) => {
      if (!leaf.broadcast) return
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

function toggleTaskPanel() {
  taskPanelOpen.value = !taskPanelOpen.value
  // Opening/closing the panel changes the terminal area's width — nudge panes to
  // refit with the same event SplitNode dispatches on a divider drag.
  nextTick(() => window.dispatchEvent(new Event('terminal-layout-change')))
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

function scheduleTaskSave() {
  if (taskSaveTimer) clearTimeout(taskSaveTimer)
  taskSaveTimer = setTimeout(() => {
    taskSaveTimer = null
    window.shellApi.taskBoard.save(boardToSave())
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
  updateInstalling.value = true
  // Write everything now instead of waiting for the debounced saves.
  saveLayoutNow()
  await saveActivityNow()
  if (taskSaveTimer) {
    clearTimeout(taskSaveTimer)
    taskSaveTimer = null
    try {
      await window.shellApi.taskBoard.save(boardToSave())
    } catch {
      /* best-effort */
    }
  }
  const ok = await window.shellApi.update.install()
  if (!ok) {
    updateInstalling.value = false
    showToast('The update is not ready to install yet.', { kind: 'error' })
  }
}

async function initUpdates() {
  const api = window.shellApi.update
  if (!api) return
  unsubUpdate = api.onStatus((s) => {
    const wasReady = updateStatus.value.state === 'ready'
    updateStatus.value = s
    if (s.state === 'ready' && !wasReady) {
      showToast(`Tessel ${s.version} is ready to install.`, {
        kind: 'attention',
        timeout: 15000,
        action: { label: 'Update', run: () => (updateOpen.value = true) }
      })
    }
  })
  updateStatus.value = await api.status()
  const done = await api.justInstalled()
  if (done) {
    showToast(`Updated to Tessel ${done.to}. Your panes were restored.`, {
      timeout: 8000
    })
  }
}

provide('panelCtx', {
  broadcast,
  activeId,
  maximizedId,
  shells,
  selectedShell,
  routeInput,
  splitLeaf,
  closeLeaf,
  restartLeaf,
  setActive,
  toggleMaximize,
  fontSize,
  notifyAgentDone,
  notifyAgentLimit,
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
  unsent,
  resolveUnsent,
  agentReportedDone,
  copied: (what) => showToast(`${what} copied.`, { timeout: 2000 })
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
    add('New', `New ${s.name}`, () => launch({ kind: 'shell', id: s.id }), {
      shortcut: s.id === selectedShell.value ? 'Ctrl+Shift+T' : ''
    })
  }
  for (const a of agents.value.filter((x) => x.available)) {
    add('New', `New ${a.name}`, () => launch({ kind: 'agent', id: a.id }), { hint: 'AI agent' })
  }
  add('New', 'New workspace', createWorkspace, { shortcut: 'Ctrl+Shift+N' })

  add('Layout', 'Split right', () => splitActive('row'), { shortcut: 'Ctrl+Shift+E' })
  add('Layout', 'Split down', () => splitActive('col'), { shortcut: 'Ctrl+Shift+O' })
  for (const o of gridOptions) add('Layout', `Even grid ${o.label}`, () => applyGrid(o.value))
  if (activeId.value) {
    const id = activeId.value
    add('Layout', 'Maximize or restore the active pane', () => toggleMaximize(id))
  }
  add('Layout', 'Close the active pane', closeActive, { shortcut: 'Ctrl+Shift+W' })
  add('Layout', sidebarCollapsed.value ? 'Show the sidebar' : 'Hide the sidebar', toggleSidebar)

  add('Agents', 'Resume a session', openSessions, {
    hint: 'Reopen a past Claude or Codex conversation'
  })
  add('Agents', 'MCP servers', () => (mcpOpen.value = true), { hint: 'Give agents extra tools' })
  add('Agents', 'Install tools', openTools, { hint: 'Agents, Git, Node.js and more' })
  add('Agents', broadcast.value ? 'Turn broadcast off' : 'Turn broadcast on', toggleBroadcast, {
    shortcut: 'Ctrl+Shift+B'
  })
  add(
    'Agents',
    taskPanelOpen.value ? 'Hide the task board' : 'Show the task board',
    toggleTaskPanel,
    {
      shortcut: 'Ctrl+Shift+K'
    }
  )

  add('Task', 'New task…', openNewTask, { hint: 'Give an agent a task, in its own copy of the project' })
  if (currentWs.value) {
    const wsId = currentWs.value.id
    add('Workspace', 'Message every agent in this workspace', () => startWsMessage(wsId), {
      hint: 'One message, sent to each agent (never to plain shells)'
    })
    add('Workspace', 'Activity of the agents', () => openActivity('workspace'), {
      hint: 'Messages, approvals, limits and working time'
    })
    add('Workspace', 'Project notes', () => openNotesView(wsId), {
      hint: 'Read or edit the notes the agents of this workspace share'
    })
    add('Workspace', 'Open project notes in a text editor', () => openProjectNotes(wsId))
    add('Workspace', 'Share project notes with the agents', () => shareProjectNotes(wsId), {
      hint: 'Tell each agent where the notes are'
    })
  }

  for (const t of THEMES) {
    if (t.id !== settings.theme) {
      add('Theme', `Theme: ${t.label}`, () => (settings.theme = t.id), { hint: t.description })
    }
  }

  add('Tessel', 'Settings', () => (settingsOpen.value = true), { shortcut: 'Ctrl+,' })
  add('Tessel', 'Keyboard shortcuts and help', () => (helpOpen.value = true), { shortcut: 'F1' })
  if (updateStatus.value.state === 'ready') {
    add('Tessel', `Install update ${updateStatus.value.version}`, () => (updateOpen.value = true))
  } else {
    add('Tessel', 'Check for updates', checkForUpdates)
  }
  add('Tessel', 'Open the logs folder', openLogs)

  for (const w of workspaces.value) {
    if (w.id !== currentWsId.value) {
      add('Go to workspace', w.name, () => selectWorkspace(w.id), { hint: w.cwd || '' })
    }
  }
  for (const w of workspaces.value) {
    forEachLeaf(w.tree, (leaf) => {
      add('Go to pane', paneLabel(leaf), () => focusPane(leaf.id), {
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
async function launch({ kind, id }, targetId = activeId.value, where = placement.value) {
  closeMenus()
  const agent = kind === 'agent' ? agentById(id) : null
  if (kind === 'agent' && (!agent || agent.available === false)) return
  const shellId = kind === 'shell' ? id : selectedShell.value

  // Optionally give the agent its own git worktree + branch.
  let worktree = null
  const baseWs = (targetId && wsOfLeaf(targetId)) || currentWs.value
  if (agent && useWorktree.value && worktreeState.available && baseWs && baseWs.cwd) {
    const res = await window.shellApi.createWorktree(baseWs.cwd, agent.id)
    if (!res || !res.ok) {
      showToast((res && res.error) || 'Could not create a separate copy.', {
        kind: 'error',
        timeout: 8000
      })
      return
    }
    worktree = { path: res.path, branch: res.branch }
    showToast(
      `${agent.name} works on branch ${res.branch} in ${res.path}. When it is done, merge it from the main folder with: git merge ${res.branch}`,
      { timeout: 12000 }
    )
  }

  if (where === 'workspace') {
    const from = currentWs.value
    const ws = makeWorkspace(
      agent ? agent.name.replace(/\s+(CLI|Code)$/i, '') : nextWorkspaceName()
    )
    ws.cwd = from ? from.cwd : null
    workspaces.value.push(ws)
    selectWorkspace(ws.id)
    const leaf = await createLeaf(shellId, agent, ws.cwd, worktree)
    if (leaf) {
      ws.tree = leaf
      ws.activeId = leaf.id
    }
    return
  }

  const ws = (targetId && wsOfLeaf(targetId)) || currentWs.value
  if (targetId && ws && ws.tree) {
    await splitLeaf(targetId, where === 'down' ? 'col' : 'row', agent, shellId, worktree)
    return
  }
  if (!ws) return
  const leaf = await createLeaf(shellId, agent, ws.cwd, worktree)
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
    if (Array.isArray(list)) agents.value = list
  } catch {
    /* keep the previous list */
  }
}

// Open a new pane below the active one (or as the workspace's only pane).
async function openPaneBelow(shellId, agent = null, opts = {}) {
  const ws = currentWs.value
  if (!ws) return null
  if (activeId.value && ws.tree) return splitLeaf(activeId.value, 'col', agent, shellId, null, opts)
  const leaf = await createLeaf(shellId, agent, ws.cwd, null, opts)
  if (leaf) {
    ws.tree = leaf
    ws.activeId = leaf.id
  }
  return leaf
}

// Run a command (or steps) in a new terminal pane (installs, setup). `shell`
// forces a shell, e.g. PowerShell for commands written in PowerShell syntax.
async function runInPane({ label, command, steps, shell }) {
  closeMenus()
  toolsOpen.value = false
  const shellId = shell && shells.value.some((s) => s.id === shell) ? shell : selectedShell.value
  const leaf = await openPaneBelow(shellId)
  if (!leaf) return
  leaf.title = label
  const line = chainCommands(steps || [command], shellId)
  setTimeout(() => window.shellApi.writePty(leaf.id, `${line}\r`), 700)
  showToast(`${label} is running below. When it finishes, open Tools and click Check again.`, {
    timeout: 7000
  })
}

// Install an agent, then start it in the same pane once the install succeeds.
async function installAgent(agent) {
  if (!agent || !agent.install) return
  closeMenus()
  toolsOpen.value = false
  const shellId = selectedShell.value
  // Install first; start the agent (with its session) only if that succeeds.
  const install = [].concat(agent.install)
  const leaf = await openPaneBelow(shellId, agent, {
    wrap: (startLine) => chainCommands([...install, startLine], shellId)
  })
  if (!leaf) return
  showToast(`Installing ${agent.name}. It starts in the new pane when the install finishes.`, {
    timeout: 7000
  })
  // Pick it up in menus once npm is done (checked again whenever menus open).
  setTimeout(() => loadAgents(true), 45000)
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
    name: s.agent === 'claude' ? 'Claude Code' : 'Codex CLI',
    command: s.agent,
    accent: s.agent === 'claude' ? '#d97757' : '#10a37f'
  }
  const ws = currentWs.value
  if (!ws) return
  const opts = { cwd: s.cwd || null, sessionId: s.id, resume: true }
  if (activeId.value && ws.tree) {
    await splitLeaf(
      activeId.value,
      placement.value === 'down' ? 'col' : 'row',
      agent,
      selectedShell.value,
      null,
      opts
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
    const ta = document.querySelector('.ws-layer:not(.hidden) .pane.active .xterm-helper-textarea')
    if (ta) ta.focus()
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
  const ta = document.querySelector('.ws-layer:not(.hidden) .pane.active .xterm-helper-textarea')
  if (ta) ta.focus()
  if (!window.shellApi.voiceTyping) {
    showToast('Restart Tessel to enable voice typing, or press Win+H.', { kind: 'error' })
    return
  }
  const ok = await window.shellApi.voiceTyping({ tip: settings.voiceTip || null })
  if (!ok)
    showToast('Could not start voice typing. Press Win+H to start it yourself.', { kind: 'error' })
}

function openTools() {
  closeMenus()
  toolsOpen.value = true
}

function closeTools() {
  toolsOpen.value = false
  nextTick(() => {
    const ta = document.querySelector('.ws-layer:not(.hidden) .pane.active .xterm-helper-textarea')
    if (ta) ta.focus()
  })
}

function newDefaultTerminal() {
  launch({ kind: 'shell', id: selectedShell.value })
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
    worktreeState.reason = 'Set a project folder on this workspace to use this'
    return
  }
  if (!window.shellApi.gitInfo) {
    worktreeState.reason = 'Restart Tessel to enable this'
    return
  }
  worktreeState.checking = true
  try {
    const info = await window.shellApi.gitInfo(ws.cwd)
    if (!info || !info.isRepo)
      worktreeState.reason = (info && info.error) || 'The project folder is not a git repository'
    else if (!info.hasCommits) worktreeState.reason = 'Make a first git commit to use this'
    else {
      worktreeState.available = true
      worktreeState.reason = null
    }
  } catch {
    worktreeState.reason = 'Could not check the project'
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
    if (l.id !== paneId) {
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
  const el = layer && layer.querySelector(`.pane[data-pane-id="${paneId}"]`)
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
  const who = fromLeaf ? fromLeaf.title : 'another agent'
  const where = dir ? ` in ${dir}` : ''
  const branch = fromLeaf && fromLeaf.worktree ? ` (branch ${fromLeaf.worktree.branch})` : ''
  return (
    `Please review the changes ${who} made${where}${branch}. ` +
    'Run git status and git diff there to see them. Point out bugs, risky changes and missing ' +
    'tests, with file and line references. Do not modify any files; only report.'
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
      mode === 'review' ? `Asked ${paneLabel(to)} to review.` : `Sent to ${paneLabel(to)}.`,
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
    const ta = document.querySelector('.ws-layer:not(.hidden) .pane.active .xterm-helper-textarea')
    if (ta) ta.focus()
  })
}

function openLogs() {
  if (window.shellApi.openLogs) window.shellApi.openLogs()
  else showToast('Restart Tessel to enable logs.', { kind: 'error' })
}

async function copyDiagnostics() {
  if (!window.shellApi.diagnostics) {
    showToast('Restart Tessel to enable diagnostics.', { kind: 'error' })
    return
  }
  const text = await window.shellApi.diagnostics()
  window.shellApi.writeClipboard(text)
  showToast('Diagnostics copied. Paste them into your message.', { timeout: 4000 })
}

// The dialog gives focus back to what had it before (terminal or button).
function closeSettings() {
  settingsOpen.value = false
}

function setDefaultShell(id) {
  selectedShell.value = id
  const shell = shells.value.find((s) => s.id === id)
  if (shell) showToast(`${shell.name} is now the default shell.`)
}

// Replace a pane with a fresh process of the same kind, in the same spot.
const restartingLeaves = new Set()
async function restartLeaf(leafId) {
  let ws = wsOfLeaf(leafId)
  if (!ws) return
  let old = null
  forEachLeaf(ws.tree, (l) => {
    if (l.id === leafId) old = l
  })
  if (!old) return
  // An agent keeps its pane id: its team messages, lead role, tasks and
  // inbox stay addressed to it.
  if (old.kind === 'agent' && old.agentCommand) {
    if (restartingLeaves.has(leafId)) return // already restarting
    const ok = await restartInPlace(leafId, { resume: settings.resumeAgents })
    // Never a new id for an agent (its messages would stay addressed to the
    // old one): if its old terminal would not stop, say so and leave it.
    if (!ok && findLeaf(leafId) === old)
      showToast(`${old.title} could not be restarted: its terminal did not stop. Try again.`, { kind: 'error', timeout: 8000 })
    return
  }
  const agent =
    old.kind === 'agent' && old.agentCommand
      ? { id: old.agentId, name: old.title, command: old.agentCommand, accent: old.accent }
      : null
  const fresh = await createLeaf(old.shellId, agent, old.startDir || ws.cwd, old.worktree, {
    sessionId: old.sessionId,
    resume: settings.resumeAgents
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
}

// An agent finished a stretch of work while you were elsewhere.
function notifyAgentDone(node) {
  const ws = wsOfLeaf(node.id)
  const where = ws && workspaces.value.length > 1 ? ` in ${ws.name}` : ''
  if (document.hasFocus()) {
    if (!settings.inAppAlerts) return
    showToast(`${node.title} finished and is waiting for you${where}.`, {
      kind: 'attention',
      timeout: 8000,
      action: { label: 'Show', run: () => focusPane(node.id) }
    })
  } else if (window.shellApi.notify && settings.desktopNotifications) {
    window.shellApi.notify({
      title: `${node.title} is waiting for you`,
      body: ws ? `Workspace: ${ws.name}` : '',
      paneId: node.id
    })
  }
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
  let found = null
  forEachWsLeaf((l) => {
    if (l.id === id) found = l
  })
  return found
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
      paneDrag.kind = leaf.kind === 'agent' ? leaf.agentId : leaf.shellId
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
  const wsEl = els.find((el) => el.classList && el.classList.contains('ws-item'))
  if (wsEl) {
    const id = wsEl.dataset.wsId
    const src = wsOfLeaf(paneDrag.srcId)
    if (id && (!src || src.id !== id)) {
      const ws = workspaces.value.find((w) => w.id === id)
      const r = wsEl.getBoundingClientRect()
      paneDrag.target = { kind: 'ws', id }
      paneDrag.zoneRect = { left: r.left, top: r.top, width: r.width, height: r.height }
      paneDrag.label = `Move to ${ws ? ws.name : 'workspace'}`
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
  const other = title ? title.textContent.trim() : 'this pane'
  paneDrag.target = { kind: 'pane', id: paneEl.dataset.paneId, zone }
  paneDrag.zoneRect = rect
  paneDrag.label =
    zone === 'center'
      ? `Swap with ${other}`
      : `Place ${zone === 'top' ? 'above' : zone === 'bottom' ? 'below' : zone === 'left' ? 'left of' : 'right of'} ${other}`
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
    createLeaf(selectedShell.value, null, ws.cwd).then((leaf) => {
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
    const dst = workspaces.value.find((w) => w.id === target.id)
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
  return reactive({ id: newId('ws'), name, tree: null, activeId: null, cwd: null })
}

function folderName(path) {
  if (!path) return ''
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || path
}

// Choose the folder new panes in a workspace start in.
async function setWorkspaceFolder(id) {
  const ws = workspaces.value.find((w) => w.id === id)
  if (!ws) return
  if (!window.shellApi.pickFolder) {
    showToast('Restart Tessel to enable project folders.', { kind: 'error' })
    return
  }
  const picked = await window.shellApi.pickFolder({
    title: `Project folder for "${ws.name}"`,
    defaultPath: ws.cwd || undefined
  })
  if (!picked) return
  ws.cwd = picked
  if (/^Workspace \d+$/.test(ws.name)) ws.name = folderName(picked)
  showToast(`New panes in ${ws.name} will open in ${picked}`)
}

function nextWorkspaceName() {
  const taken = new Set(workspaces.value.map((w) => w.name))
  let n = workspaces.value.length + 1
  while (taken.has(`Workspace ${n}`)) n++
  return `Workspace ${n}`
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
  workspaces.value.push(ws)
  selectWorkspace(ws.id)
  // Put the new workspace's name straight into edit mode.
  nextTick(() => sidebarEl.value && sidebarEl.value.startRename(ws.id))
  const leaf = await createLeaf(selectedShell.value, null, ws.cwd)
  if (leaf) {
    ws.tree = leaf
    ws.activeId = leaf.id
  }
}

function renameWorkspace(id, name) {
  const ws = workspaces.value.find((w) => w.id === id)
  if (ws) ws.name = name
}

function removeWorkspace(id, confirmed = false) {
  const idx = workspaces.value.findIndex((w) => w.id === id)
  if (idx < 0) return
  const ws = workspaces.value[idx]
  let count = 0
  forEachLeaf(ws.tree, () => count++)
  const wsTasks = boardTasks.filter((t) => t.wsId === id)
  const lost = []
  if (count) lost.push(`its ${count} ${count === 1 ? 'pane' : 'panes'} will be closed`)
  if (wsTasks.length)
    lost.push(`its ${wsTasks.length} ${wsTasks.length === 1 ? 'task' : 'tasks'} deleted`)
  const what = lost.join(' and ')
  if (lost.length && !confirmed) {
    askConfirm({
      title: `Delete "${ws.name}"?`,
      text: `${what[0]?.toUpperCase()}${what.slice(1)}.`,
      confirmLabel: 'Delete',
      danger: true
    }).then((ok) => ok && removeWorkspace(id, true))
    return
  }
  for (const t of wsTasks) removeTask(t.id)
  forEachLeaf(ws.tree, (leaf) => {
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

// Per-workspace summary for the sidebar: pane count, agent logos, and whether
// any agent in it is currently working.
const workspaceItems = computed(() =>
  workspaces.value.map((w) => {
    let paneCount = 0
    let busy = false
    let needsYou = false
    const agentIds = []
    const members = []
    forEachLeaf(w.tree, (leaf) => {
      paneCount++
      if (leaf.kind === 'agent') {
        if (leaf.agentId) agentIds.push(leaf.agentId)
        if (agentStatus[leaf.id] === 'busy') busy = true
        if (attention[leaf.id] || approvals[leaf.id]) needsYou = true
        members.push({
          id: leaf.id,
          num: leaf.num || 0,
          title: leaf.title || 'Agent',
          agentId: leaf.agentId || null,
          accent: leaf.accent || null,
          state: paneState(leaf),
          reset: limits[leaf.id] ? limits[leaf.id].reset : '',
          held: !!pendingMessages[leaf.id],
          active: w.id === currentWsId.value && leaf.id === w.activeId
        })
      }
    })
    return {
      id: w.id,
      name: w.name,
      paneCount,
      agents: agentIds,
      members,
      busy,
      needsYou,
      folder: w.cwd ? folderName(w.cwd) : '',
      cwd: w.cwd || ''
    }
  })
)

// Every open agent's state, for the activity log and the Activity view.
const agentStates = computed(() => {
  const out = {}
  forEachWsLeaf((leaf) => {
    if (leaf.kind !== 'agent') return
    let state = 'idle'
    if (approvals[leaf.id]) state = 'approval'
    else if (limits[leaf.id]) state = 'limited'
    else if (agentStatus[leaf.id] === 'busy') state = 'working'
    out[leaf.id] = {
      state,
      title: leaf.title || 'Agent',
      agentId: leaf.agentId || null,
      reset: limits[leaf.id] ? limits[leaf.id].reset : '',
      wsId: wsOfLeaf(leaf.id)?.id || null,
      teamId: leaf.team || null
    }
  })
  return out
})

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
  const t = trackedState[leafId]
  if (!t) return null
  const info = agentStates.value[leafId]
  return trackAgent(
    { state: t.state, since: t.since, sinceStart: t.sinceStart, reset: info ? info.reset : '' },
    taskOfPane(leafId),
    clock.value
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
    showToast(`${a.title}: ${a.reason}`, { kind: 'attention', timeout: 12000, action: { label: 'Show', run: () => focusPane(a.id) } })
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
  if (state === 'working') restoreDone[id] = true
  const early = Date.now() - appStartedAt < RESTORE_WINDOW_MS && !restoreDone[id]
  if (state === 'closed') {
    delete trackedState[id]
    delete lastStateEvent[id]
  } else trackedState[id] = { state, since: Date.now(), sinceStart: early }
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
      if (info.state === 'working' && loggedState[id] !== 'working') {
        workingTimers[id] = setTimeout(() => {
          if (agentStates.value[id]?.state === 'working') logState(id, agentStates.value[id], 'working')
        }, 3000)
      } else if (info.state !== 'working') {
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

// --- Activity view -------------------------------------------------------------
const activityOpen = ref(false)
const activityScope = ref('workspace') // 'workspace' | 'team:<id>' | 'all'

// What the Activity view can show: this workspace, one of its teams, or all.
// A scope's panes include agents closed since (found through the log).
const activityScopes = computed(() => {
  const ws = currentWs.value
  const out = []
  if (ws) {
    out.push({ value: 'workspace', label: `Workspace: ${ws.name}`, wsId: ws.id, teamId: null, notesDir: ws.cwd || null })
  }
  for (const t of teams.value) {
    const home = workspaces.value.find((w) => w.id === teamWsId(t.id)) || ws
    out.push({ value: 'team:' + t.id, label: `Team: ${t.name}`, wsId: null, teamId: t.id, notesDir: (home && home.cwd) || null })
  }
  out.push({ value: 'all', label: 'All workspaces', wsId: null, teamId: null, notesDir: (ws && ws.cwd) || null })
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
  const who = leaf ? leaf.title : 'the agent'
  const answer = await askConfirm({
    title: `Did ${who} get the message?`,
    text:
      `Tessel pasted a message and pressed Enter, but ${who} did not visibly take it: "${u.item.text.slice(0, 160)}${u.item.text.length > 160 ? '…' : ''}". ` +
      'Look at its input box. If the message is still there, press Enter in the terminal yourself, then choose "It was sent". ' +
      'If it is gone and was not received, choose "Send again".',
    confirmLabel: 'It was sent',
    altLabel: 'Send again'
  })
  if (!unsent[id] || unsent[id] !== u) return
  const meta = u.item.meta || {}
  if (answer === true) {
    // Recorded first; the pane stays held if that fails.
    const ok = meta.confirmSent ? await meta.confirmSent() : true
    if (!ok) {
      showToast('Tessel could not record that. Try again.', { kind: 'error' })
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
      showToast('Tessel could not record that. Try again.', { kind: 'error' })
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
  return leaf ? { title: leaf.title || 'Agent', agentId: leaf.agentId || null } : null
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
          showToast(`A message to ${leaf ? leaf.title : 'an agent'} may not have been sent. Check its input box.`, {
            kind: 'attention',
            timeout: 15000,
            action: { label: 'Check', run: () => resolveUnsent(id) }
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
  agents.value
    .filter((a) => a.available !== false)
    .map((a) => ({ id: a.id, name: a.name, accent: a.accent || null }))
)

// Agents already open in this workspace, for the dialog.
const taskOpenAgents = computed(() =>
  (currentWs.value ? wsAgents(currentWs.value.id) : []).map((l) => ({
    id: l.id,
    num: l.num || 0,
    title: l.title || 'Agent',
    agentId: l.agentId || null,
    accent: l.accent || null,
    state: paneState(l),
    reset: limits[l.id] ? limits[l.id].reset : '',
    task: taskOfPane(l.id)?.title || null
  }))
)

// Why an open agent cannot take a new task now, or '' if it can.
function busyReason(leaf) {
  const t = taskOfPane(leaf.id)
  if (t) return `already on "${t.title}"`
  if (limits[leaf.id]) return 'at its usage limit'
  if (approvals[leaf.id]) return 'waiting for your approval'
  if (agentStatus[leaf.id] === 'busy') return 'working on something else'
  return ''
}

// The task a pane is working on or waiting to have reviewed.
function taskOfPane(paneId) {
  if (!paneId) return null
  return boardTasks.find((t) => t.paneId === paneId && (t.column === 'doing' || t.column === 'review')) || null
}

function taskPrompt(task, ws) {
  const wt = task.worktree
  const where = wt
    ? `You work in your own copy of the project: ${wt.path} (git branch ${wt.branch}, made from ${wt.baseBranch || 'the main branch'}). ` +
      'Commit your work on that branch (git add the files you changed, then git commit). Do not merge it and do not push: the user reviews and merges it. ' +
      'In your last commit message, list the checks you ran (tests, build) and their results. ' +
      'If the project needs its dependencies installed, install them in this copy (for example npm ci); never link them to another folder.'
    : `You work directly in the project folder ${(ws && ws.cwd) || ''}. Other agents may work there too: check .tessel/notes.md before editing shared files.`
  const lead = task.teamId ? teamLead(task.teamId) : null
  const tm = task.teamId ? teamById(task.teamId) : null
  const box = tm && task.paneId && channelBoxes[tm.id] ? channelBoxes[tm.id][task.paneId] : null
  const team = tm
    ? `You are in team "${tm.name}"` +
      (lead ? `, led by ${paneLabel(lead)}: it gave you this task and reviews your work when you finish. Ask it if something is unclear.` : '.') +
      (box ? `\n${box.guide}` : '') +
      '\n\n'
    : ''
  return (
    `[Tessel task] ${task.title}\n\n` +
    (task.brief ? `${task.brief}\n\n` : '') +
    team +
    `${where}\n\n` +
    'When the task is complete and checked, end your last message with a line that contains only the words TASK and COMPLETE joined by an underscore, and nothing else on that line.'
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
      showToast(`${leaf ? leaf.title : 'That agent'} cannot take this task: ${why}.`, { kind: 'error', timeout: 7000 })
      return { error: `${leaf ? paneLabel(leaf) : 'that agent'} cannot take it: ${why}` }
    }
  } else {
    const agent = agentById(spec.agent.id)
    if (!agent) {
      removeTask(task.id)
      showToast('That agent is not available.', { kind: 'error' })
      return { error: 'that agent kind is not available' }
    }
    let worktree = null
    if (spec.isolated) {
      const res = await window.shellApi.createWorktree(ws.cwd, spec.title)
      if (!res || !res.ok) {
        updateTask(task.id, { column: 'todo' })
        showToast(`Could not make a separate copy: ${(res && res.error) || 'unknown error'}. The task stays in To do.`, {
          kind: 'error',
          timeout: 9000
        })
        return { error: `could not make a separate copy: ${(res && res.error) || 'unknown error'}` }
      }
      worktree = { path: res.path, branch: res.branch, baseBranch: res.baseBranch || null, root: res.root || ws.cwd }
      updateTask(task.id, { worktree })
    }
    const target =
      opts.roomy && ws.tree ? largestLeaf(ws.tree).id : ws.activeId && findLeaf(ws.activeId) ? ws.activeId : null
    leaf = target
      ? await splitLeaf(target, opts.roomy ? largestLeaf(ws.tree).dir : 'row', agent, selectedShell.value, worktree)
      : await createLeaf(selectedShell.value, agent, ws.cwd, worktree)
    if (leaf && !target) {
      ws.tree = leaf
      ws.activeId = leaf.id
    }
    fresh = true
  }
  if (!leaf) {
    updateTask(task.id, { column: 'todo' })
    showToast('Could not start the agent. The task stays in To do.', { kind: 'error' })
    return { error: 'could not start the agent' }
  }
  // A new agent started by a lead joins its team (told in the task itself).
  if (fresh && opts.teamId && teamById(opts.teamId)) {
    const before = teamMembers(opts.teamId)
    leaf.team = opts.teamId
    logMembership(leaf, opts.teamId)
    await syncChannel(teamById(opts.teamId), { quiet: [leaf.id] })
    tellAgents(before, `[Tessel] Team "${teamById(opts.teamId).name}": ${paneLabel(leaf)} joined the team.`, opts.teamId)
  }
  updateTask(task.id, { paneId: leaf.id })
  const t = boardTasks.find((x) => x.id === task.id)
  recordActivity({
    type: 'task',
    action: 'started',
    taskId: task.id,
    title: task.title,
    paneId: leaf.id,
    agent: agentInfo(leaf),
    wsId: ws.id,
    branch: t.worktree ? t.worktree.branch : null
  })
  deliverToAgent(leaf.id, taskPrompt(t, ws), {
    source: 'tessel',
    scope: 'task',
    // A new agent needs a moment to start (and may ask to trust the folder).
    notBefore: fresh ? Date.now() + 6000 : 0
  })
  if (!taskPanelOpen.value) toggleTaskPanel()
  showToast(
    t.worktree
      ? `${leaf.title} started "${task.title}" on branch ${t.worktree.branch}.`
      : `${leaf.title} started "${task.title}".`,
    { timeout: 5000 }
  )
  return { task: t, leaf }
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
    detail: lead && lead.id !== paneId ? `${lead.title} (lead) reviews it first` : ''
  })
  if (lead && lead.id !== paneId) {
    updateTask(task.id, { leadReview: 'pending', teamId: task.teamId || leaf.team })
    noticeAgents([lead], leadReviewPrompt(task, leaf), leaf.team, { source: 'tessel', scope: 'lead', teamId: leaf.team })
    showToast(`${leaf.title} finished "${task.title}". ${lead.title} (lead) reviews it first.`, { timeout: 6000 })
    return
  }
  showToast(`${leaf ? leaf.title : 'An agent'} finished "${task.title}". It is ready for your review.`, {
    kind: 'attention',
    timeout: 10000,
    action: task.worktree
      ? { label: 'Review', run: () => openReview(task.id) }
      : { label: 'Show', run: () => focusPane(paneId) }
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
    agent: leaf ? agentInfo(leaf) : { title: 'the agent' },
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
    showToast('The agent of this task was closed. Start a new task instead.', { kind: 'error' })
    return false
  }
  const wt = task.worktree
  deliverToAgent(
    leaf.id,
    `[Tessel review] ${task.title}\n\n${text}\n\n` +
      (wt ? `Work in ${wt.path} on branch ${wt.branch}, commit the changes there (say which checks you ran in the commit message), and do not merge. ` : '') +
      'When it is done and checked, end your last message with a line that contains only the words TASK and COMPLETE joined by an underscore.',
    by ? { source: 'lead', scope: 'task', from: by } : { source: 'you', scope: 'task' }
  )
  // Back in Doing: a new period starts.
  updateTask(task.id, { column: 'doing', leadReview: null, doingSince: Date.now() })
  taskEvent(task, action, detail, by)
  reviewTaskId.value = null
  showToast(`Sent to ${leaf.title}. "${task.title}" is back in Doing.`, { timeout: 5000 })
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
    title: `Delete "${task.title}"?`,
    text: wt
      ? `${leaf ? leaf.title + ' closes, and ' : ''}its copy (${wt.path}) and branch ${wt.branch} are deleted with any work not merged yet. To keep the work, open Review and merge it first. This cannot be undone.`
      : 'The card is removed from the board.',
    confirmLabel: 'Delete',
    danger: !!wt
  })
  if (!ok) return
  if (wt) {
    const rm = await removeTaskCopy(task, true)
    if (!rm || !rm.ok) {
      showToast(`The card was kept: its copy could not be deleted (${(rm && rm.error) || 'unknown error'}).`, { kind: 'error', timeout: 9000 })
      return
    }
  }
  removeTask(task.id)
}
provide('deleteTask', deleteTask)

const reviewActions = {
  requestChanges(text) {
    const task = reviewTask.value
    if (task) sendBackToAgent(task, `Changes requested by the user:\n${text}`, 'changes', text.length > 80 ? text.slice(0, 80) + '…' : text)
  },
  resolveConflicts(info) {
    const task = reviewTask.value
    if (!task || !info) return
    sendBackToAgent(
      task,
      `Your branch ${info.branch} conflicts with ${info.target} in: ${info.conflicts.join(', ')}. ` +
        `Merge ${info.target} into your branch (git merge ${info.target}), resolve the conflicts keeping both intents, run the checks again, and commit.`,
      'resolve',
      info.conflicts.join(', ')
    )
  },
  async merge(info, { cleanup } = {}) {
    const task = reviewTask.value
    if (!task || !info || !info.ok) return false
    const leaf = findLeaf(task.paneId)
    const ok = await askConfirm({
      title: `Merge "${task.title}" into ${info.target}?`,
      text:
        `${info.commits.length} commit${info.commits.length === 1 ? '' : 's'} and ${info.files.length} file${info.files.length === 1 ? '' : 's'} from ${info.branch} go into ${info.target} in ${info.repo}.` +
        (cleanup ? ` Then ${leaf ? leaf.title + ' closes and ' : ''}its copy and branch are deleted.` : ''),
      confirmLabel: 'Merge'
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
      showToast(`Not merged: ${(res && res.error) || 'unknown error'}`, { kind: 'error', timeout: 9000 })
      return false
    }
    updateTask(task.id, { column: 'done', mergedAt: Date.now(), mergeSha: res.sha })
    taskEvent(task, 'merged', `${res.commits} commit${res.commits === 1 ? '' : 's'} into ${info.target}`)
    reviewTaskId.value = null
    let note = ''
    if (cleanup) {
      const rm = await removeTaskCopy(task, false)
      if (rm && rm.ok) updateTask(task.id, { paneId: null })
      else note = ` Its copy was kept: ${(rm && rm.error) || 'could not remove it'}.`
    }
    showToast(`Merged "${task.title}" into ${info.target}.${note}`, { kind: note ? 'error' : undefined, timeout: note ? 9000 : 5000 })
    return true
  },
  async discard(info) {
    const task = reviewTask.value
    if (!task || !task.worktree) return false
    const leaf = findLeaf(task.paneId)
    const n = info && info.ok ? info.commits.length : 0
    const ok = await askConfirm({
      title: `Discard "${task.title}"?`,
      text:
        `${leaf ? leaf.title + ' closes, and ' : ''}its copy (${task.worktree.path}) and branch ${task.worktree.branch} are deleted` +
        (n ? `, with its ${n} unmerged commit${n === 1 ? '' : 's'}` : '') +
        '. This cannot be undone.',
      confirmLabel: 'Discard',
      danger: true
    })
    if (!ok) return false
    const rm = await removeTaskCopy(task, true)
    if (!rm || !rm.ok) {
      showToast(`Could not delete the copy: ${(rm && rm.error) || 'unknown error'}`, { kind: 'error', timeout: 9000 })
      return false
    }
    taskEvent(task, 'discarded', task.worktree.branch)
    reviewTaskId.value = null
    removeTask(task.id)
    showToast(`Discarded "${task.title}".`, { timeout: 5000 })
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
  }
}

// The agents (not plain shells) of a workspace.
function wsAgents(wsId) {
  const ws = workspaces.value.find((w) => w.id === wsId)
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
    showToast('Set a project folder on this workspace first: the lead works from it.', { kind: 'error' })
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
      showToast(`Could not make ${leaf.title}'s inbox, so it is not the lead. Check that the project folder can be written to.`, {
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
    tellAgents([old], `[Tessel] You no longer lead the team "${team.name}". Your inbox now takes messages only.`, teamId)
  }
  if (!leaf) {
    handOffLeadReviews(teamId)
    if (old) {
      recordActivity({ type: 'team', action: 'lead-removed', teamId, wsId: teamWsId(teamId), name: team.name, detail: old.title })
      tellAgents(teamMembers(teamId).filter((l) => l.id !== old.id), `[Tessel] Team "${team.name}": ${paneLabel(old)} no longer leads the team.`, teamId)
    }
    return
  }
  recordActivity({ type: 'team', action: 'lead', teamId, wsId: teamWsId(teamId), name: team.name, detail: leaf.title })
  tellAgents([leaf], `[Tessel] ${box.guide}`, teamId)
  tellAgents(
    teamMembers(teamId).filter((l) => l.id !== leaf.id),
    `[Tessel] Team "${team.name}": ${paneLabel(leaf)} now leads the team. It may give you tasks; when you finish one, it reviews your work first.`,
    teamId
  )
  showToast(`${leaf.title} now leads ${team.name}.`, { timeout: 4000 })
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
  tellAgents([leaf], `[Tessel] Your lead inbox was made again. ${box.guide}`, team.id)
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
    showToast(`"${task.title}" is ready for your review: its team has no lead any more.`, {
      kind: 'attention',
      timeout: 10000,
      action: task.worktree ? { label: 'Review', run: () => openReview(task.id) } : { label: 'Show', run: () => focusPane(task.paneId) }
    })
  }
}

function leadReviewPrompt(task, worker) {
  const wt = task.worktree
  const where = wt
    ? `in its own copy ${wt.path} (branch ${wt.branch}, from ${wt.baseBranch || 'main'}). See the changes with: git -C "${wt.path}" log ${wt.baseBranch || 'main'}..HEAD and git -C "${wt.path}" diff ${wt.baseBranch || 'main'}...HEAD`
    : 'in the project folder (see git status and git diff there)'
  return (
    `[Tessel] ${paneLabel(worker)} finished the task "${task.title}" (task id ${task.id}) ${where}.\n` +
    'Review it: correctness, scope, tests. Do not edit its files. Then write to your lead inbox either ' +
    `{"action":"approve","task":"${task.id}","note":"..."} or {"action":"changes","task":"${task.id}","text":"what to fix"}.`
  )
}

// Carry out one request from a lead; returns the line to answer it with.
async function runLeadRequest(team, lead, req) {
  const ws = wsOfLeaf(lead.id)
  const member = (num) => teamMembers(team.id).find((l) => l.num === num && l.id !== lead.id) || null
  if (req.action === 'task') {
    const active = boardTasks.filter((t) => t.teamId === team.id && (t.column === 'doing' || t.column === 'review')).length
    if (active >= LEAD_MAX_ACTIVE) return `Not started "${req.title}": the team already has ${active} tasks in progress (limit ${LEAD_MAX_ACTIVE}).`
    let spec
    if (req.num != null) {
      const m = member(req.num)
      if (!m) return `Not started "${req.title}": #${req.num} is not in your team.`
      spec = { title: req.title, brief: req.brief, agent: { kind: 'pane', id: m.id }, isolated: false }
    } else {
      const kind = taskAgentKinds.value.find((a) => a.id === req.kind)
      if (!kind) return `Not started "${req.title}": unknown agent kind "${req.kind}". Use one of: ${taskAgentKinds.value.map((a) => a.id).join(', ')}.`
      if (req.ownCopy) {
        const info = ws && ws.cwd ? await window.shellApi.gitInfo(ws.cwd) : null
        if (!info || !info.isRepo || !info.hasCommits) {
          const why = !ws || !ws.cwd ? 'the workspace has no project folder' : !info || !info.isRepo ? 'the project folder is not a git repository' : 'the repository has no commits yet'
          return `Not started "${req.title}": ${why}, so the new agent cannot have its own copy. Add "own_copy": false to let it work in the project folder.`
        }
      }
      spec = { title: req.title, brief: req.brief, agent: { kind: 'new', id: kind.id }, isolated: req.ownCopy }
    }
    const res = await startTask(spec, { ws, roomy: true, teamId: team.id })
    if (!res || res.error) return `Not started "${req.title}": ${(res && res.error) || 'unknown error'}.`
    return `Started "${req.title}" (task id ${res.task.id}) with ${paneLabel(res.leaf)}${res.task.worktree ? ` on branch ${res.task.worktree.branch}` : ''}.`
  }
  if (req.action === 'message') return runMemberMessage(team, lead, req)
  const inReview = boardTasks.filter((t) => t.teamId === team.id && t.column === 'review')
  const found = findTaskRef(inReview, req.task)
  const task = found.task
  if (!task) {
    if (found.error) return `Not done: ${found.error}.`
    return (
      `No task of your team waits for review under "${req.task}".` +
      (inReview.length ? ` In review: ${inReview.map((t) => `${t.id} "${t.title}"`).join(', ')}.` : '')
    )
  }
  if (req.action === 'approve') {
    updateTask(task.id, { leadReview: 'approved', leadNote: req.text || '' })
    taskEvent(task, 'approved', req.text, lead.title)
    showToast(`${lead.title} (lead) approved "${task.title}". It is ready for you to merge.`, {
      kind: 'attention',
      timeout: 10000,
      action: task.worktree ? { label: 'Review', run: () => openReview(task.id) } : { label: 'Show', run: () => focusPane(task.paneId) }
    })
    return `Approved "${task.title}". The user was told it is ready to merge.`
  }
  const ok = sendBackToAgent(task, `Your lead ${paneLabel(lead)} asks for changes:\n${req.text}`, 'changes', req.text.slice(0, 80), lead.title)
  return ok ? `Sent your changes for "${task.title}" back to its agent.` : `The agent of "${task.title}" was closed.`
}

// A message from one team member to others (to: "#3", "team" or "lead").
// Delivered straight into their terminals; '' when it went through.
const MESSAGE_BUDGET = { max: 30, perMs: 10 * 60 * 1000 }
const sentLog = {}
function runMemberMessage(team, from, req) {
  const now = Date.now()
  const log = (sentLog[from.id] = (sentLog[from.id] || []).filter((t) => now - t < MESSAGE_BUDGET.perMs))
  if (log.length >= MESSAGE_BUDGET.max) return 'Not sent: too many messages in the last 10 minutes. Wait a little.'
  const others = teamMembers(team.id).filter((l) => l.id !== from.id && l.kind === 'agent')
  const lead = teamLead(team.id)
  const to =
    req.to === 'team'
      ? others
      : req.to === 'lead'
        ? others.filter((l) => lead && l.id === lead.id)
        : others.filter((l) => l.num === req.num)
  if (!to.length) {
    if (req.to === 'team') return 'Nobody else is in your team yet.'
    if (req.to === 'lead') return 'Your team has no lead.'
    return `#${req.num} is not in your team. Teammates: ${others.map(paneLabel).join(', ') || 'none'}.`
  }
  log.push(now)
  const isLead = lead && lead.id === from.id
  const head = isLead ? `[From your lead ${paneLabel(from)}]` : `[From ${paneLabel(from)}, team "${team.name}"]`
  const meta = { source: isLead ? 'lead' : 'agent', scope: 'team', teamId: team.id, from: from.title, waitIdle: true }
  const skipped = []
  for (const l of to) {
    if (limits[l.id]) {
      logMessage(l.id, 'skipped', req.text, meta)
      skipped.push(paneLabel(l))
    } else noticeAgents([l], `${head} ${req.text}`, team.id, meta)
  }
  return skipped.length ? `Not delivered to ${skipped.join(', ')}: usage limit reached.` : ''
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
        tellTeam(team.id, 'The team has no lead any more.')
        handOffLeadReviews(team.id)
      }
      const members = teamMembers(team.id).filter((l) => l.kind === 'agent')
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
          if (!req.ok) answers.push(`${item.file}: not done, ${req.error}.`)
          else if (req.action === 'message') answers.push(runMemberMessage(team, leaf, req))
          else if (!isLead) answers.push(`${item.file}: only the team lead can use "${req.action}". Send a message instead.`)
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
    const MCP_AGENTS = ['claude', 'codex', 'gemini', 'qwen', 'copilot', 'opencode', 'cline']
    if (agents.value.some((a) => MCP_AGENTS.includes(a.id) && a.available)) installTeamToolsOnce()
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
    tellAgents([m], `[Tessel] Team "${team.name}": talk to your teammates directly through the team channel, not through the user.\n${box.guide}`, team.id)
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
          showToast(`${paneLabel(m)}: its team tools (tessel-team) are not connected, so it cannot read or send team messages. Restart it (right-click its pane, Restart).`, {
            kind: 'attention',
            timeout: 15000,
            action: { label: 'Restart', run: () => restartLeaf(m.id) }
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
async function detectShellAgents() {
  if (!teamsReady || detectBusy || !window.shellApi.detectAgents) return
  const now = Date.now()
  const shells = {}
  const watched = {}
  forEachWsLeaf((l) => {
    if (!l.pid) return
    const watch = l.detected || (l.kind !== 'agent' && (!detectedAtStart || now - (shellEnterAt[l.id] || 0) < 60000))
    if (watch) {
      shells[l.id] = l.pid
      watched[l.id] = l
    }
  })
  detectedAtStart = true
  if (!Object.keys(shells).length) return
  detectBusy = true
  try {
    const res = await window.shellApi.detectAgents({ shells })
    if (!res || !res.ok) return
    for (const [id, agentId] of Object.entries(res.agents || {})) {
      const l = findLeaf(id)
      if (!l || l !== watched[id]) continue // closed or replaced meanwhile
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
  clearAgentStatus(leaf.id)
}
const detectTimer = setInterval(detectShellAgents, 4000)
onBeforeUnmount(() => clearInterval(detectTimer))

// The team tools' version now (server.cjs VERSION), once they are set up.
let teamToolsVersion = null
// Started with the team tools as they are now (an older version: restarted).
function hasCurrentTools(leaf) {
  return !!leaf.teamTools && (!teamToolsVersion || leaf.toolsVersion === teamToolsVersion)
}
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
    if (res.changed && res.changed.length)
      showToast('Team messages now go in the background, never into your terminals (MCP servers: tessel-team).', { timeout: 10000 })
    return
  }
  // Not (fully) set up: say so once per failure, and try again in 5 minutes.
  teamToolsNextTry = Date.now() + 5 * 60 * 1000
  const why = (res && res.errors && res.errors[0]) || 'unknown error'
  if (why !== teamToolsFailed) {
    teamToolsFailed = why
    showToast(`Team messages are not set up yet: ${why} Tessel will try again in 5 minutes.`, { kind: 'error', timeout: 12000 })
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
    resume: !!old.sessionId && opts.resume !== false
  })
  if (!fresh) return false
  if (findLeaf(leafId) !== old) {
    // Closed while it was starting: do not leave its terminal running.
    window.shellApi.killPty(leafId)
    return false
  }
  Object.assign(fresh, {
    title: old.title,
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
const wakeState = {} // leafId -> { since, woken, wokenAt, gen }
// The user is not in this pane, has no line in progress there, and has not
// typed there for 30 s.
function wakeAllowed(id) {
  if (id === activeId.value && document.hasFocus()) return false
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
function wakeIfNeeded(leaf) {
  const count = teamUnread[leaf.id] || 0
  if (!count) {
    delete wakeState[leaf.id]
    return
  }
  const w = (wakeState[leaf.id] = wakeState[leaf.id] || { since: Date.now(), woken: false, gen: leaf.gen || 0 })
  if (w.woken && ((leaf.gen || 0) !== w.gen || Date.now() - (w.wokenAt || 0) >= REWAKE_AFTER_MS)) {
    w.woken = false
    w.gen = leaf.gen || 0
  }
  if (w.woken || Date.now() - w.since < WAKE_AFTER_MS) return
  // Only an agent that has the team tools to read them.
  if (leaf.kind !== 'agent' || !leaf.teamTools) return
  const t = trackedState[leaf.id]
  if (!t || t.state !== 'idle') return
  if (approvals[leaf.id] || limits[leaf.id] || pendingMessages[leaf.id] || unsent[leaf.id] || delivering.has(leaf.id)) return
  if (!wakeAllowed(leaf.id)) return
  w.woken = true
  w.wokenAt = Date.now()
  deliverToAgent(
    leaf.id,
    `[Tessel] You have ${count} new team message${count > 1 ? 's' : ''}: read ${count > 1 ? 'them' : 'it'} with team_inbox.`,
    {
      source: 'tessel',
      scope: 'wake',
      teamId: leaf.team,
      waitIdle: true,
      // Still unread and still safe at the moment it is typed; otherwise the
      // reminder (and its count) is dropped, and a fresh one comes later if
      // messages still wait.
      guard: () => (teamUnread[leaf.id] || 0) > 0 && wakeAllowed(leaf.id),
      dropIfNotNow: true,
      onDropped: () => {
        if (wakeState[leaf.id]) wakeState[leaf.id].woken = false
      }
    }
  )
  if (window.shellApi.log) window.shellApi.log('info', `team tools: reminded ${paneLabel(leaf)} (${leaf.id}) of ${count} waiting message(s)`)
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
      const t = trackedState[leaf.id]
      const quiet = t && t.state === 'idle' && now - t.since > 60000
      // Nor over a line that may hold an unsent draft: not known to be empty
      // (after a reload, or history recalled) and not proven empty on screen.
      const draftMaybe = !!userDraft[leaf.id] || (!!draftUnknown[leaf.id] && !inputShownEmpty(leaf.id))
      const inUse = (leaf.id === activeId.value && document.hasFocus()) || userIsTyping(leaf.id) || draftMaybe
      if (!quiet || inUse || approvals[leaf.id] || pendingMessages[leaf.id] || unsent[leaf.id] || delivering.has(leaf.id)) continue
      restarting = true
      restartedForTools.add(leaf.id)
      const title = paneLabel(leaf)
      try {
        const ok = await restartInPlace(leaf.id, { forTools: true })
        if (window.shellApi.log)
          window.shellApi.log(ok ? 'info' : 'error', `team tools: ${ok ? 'restarted' : 'could not restart'} ${title} (${leaf.id}) in place`)
        if (ok) showToast(`Restarted ${title} so it has the latest team tools. Its conversation continues.`, { timeout: 6000 })
      } finally {
        restarting = false
      }
      return // one at a time
    }
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
    return p ? `${p.num ? `#${p.num} ` : ''}${p.title || 'Agent'}` : 'An agent'
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
    await syncBoard({ key: `ws/${ws.id}`, dir: ws.cwd, target: { board: ws.id }, wsId: ws.id, members: solo, teamId: null }, round)
    if (roundGone(round)) return
  }
  for (const [dir, panes] of Object.entries(byDir)) {
    await window.shellApi.team.boardPanes({ dir, panes })
    if (roundGone(round)) return
  }
}

// b: { key (ledger and cache key), dir, target ({ teamId } or { board }),
// wsId, members (agents allowed to ask), teamId (null: alone) }
async function syncBoard(b, round = teamRound) {
  if (!window.shellApi.team || !window.shellApi.team.requests) return
  const { key: boardKey, dir, target, wsId, members } = b
  const byNum = (n) => members.find((m) => m.num === Number(String(n).slice(1))) || null
  const res = await window.shellApi.team.requests({ dir, ...target })
  // Replaced meanwhile: these requests are the new round's to apply.
  if (roundGone(round)) return
  const refusals = []
  const applied = [] // request files, removed once the board is saved
  if (res && res.ok) {
    for (const r of res.refused || []) refusals.push({ fromId: r.fromId, text: `Your board request was not done: ${r.error}.` })
    for (const r of res.requests || []) {
      const from = members.find((m) => m.id === r.fromId)
      applied.push(r.file)
      if (!from) continue // not (or no longer) in this team
      // Already applied (Tessel stopped before its file was removed): never
      // again, so a later change (or a card deleted since) is not undone.
      const key = `${boardKey}/${r.file}`
      if (appliedRequests.has(key)) continue
      appliedRequests.add(key)
      if (r.action === 'add') {
        const who = r.assignee ? byNum(r.assignee) : from
        if (!who) {
          refusals.push({ fromId: from.id, text: `The card "${r.title}" was not added: ${r.assignee} is not in your team.` })
          continue
        }
        const task = addTask({ title: r.title, wsId })
        updateTask(task.id, { paneId: who.id, column: r.column, createdBy: from.id })
        recordActivity({ type: 'task', action: 'added', paneId: who.id, agent: agentInfo(who), title: r.title, wsId, by: paneLabel(from) })
      } else if (r.action === 'move') {
        const task = boardTasks.find((t) => t.id === r.id)
        if (!task || task.wsId !== wsId) {
          refusals.push({ fromId: from.id, text: `No card ${r.id} on your team's board (see team_tasks).` })
          continue
        }
        if (task.column === r.column) continue
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
          detail: { todo: 'To do', doing: 'Doing', review: 'Review', done: 'Done' }[r.column]
        })
      }
    }
  }
  // The board and the ledger of applied requests are saved together, then
  // the request files removed; a request is dropped from the ledger only once
  // its file is surely gone (it can never come back then).
  if (applied.length) {
    const saved = await window.shellApi.taskBoard.save(boardToSave()).catch(() => null)
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
    .map((t) => ({ id: t.id, title: t.title, column: t.column, assignee: label(t.paneId), since: t.doingSince || null }))
  const sig = JSON.stringify(cards)
  if (boardSigs[boardKey] === sig) return
  const pub = await window.shellApi.team.tasks({ dir, ...target, tasks: cards })
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
    installTeamToolsOnce() // runs on its own (Claude and Codex take a while)
    restartForTeamTools()
    return
  }
  const res = await window.shellApi.channel.poll({ dir, teamId: team.id, availableIds: members.map((m) => m.id) })
  if (!res || !res.ok) return
  const who = Object.fromEntries((res.participants || []).map((p) => [p.id, p]))
  const textOf = (d) => {
    const from = who[d.fromId]
    return d.fromId === 'tessel'
      ? `[Tessel] ${d.text}`
      : `[From #${from ? from.num : '?'} ${from ? from.title : 'teammate'}, team "${team.name}", message ${d.id}${d.replyTo ? `, reply to ${d.replyTo}` : ''}] ${d.text}`
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
  while (names.has(`Team ${n}`)) n++
  const used = new Set(teams.value.map((t) => t.color))
  const color = TEAM_COLORS.find((c) => !used.has(c)) || TEAM_COLORS[n % TEAM_COLORS.length]
  const team = { id: newId('team'), name: `Team ${n}`, color }
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
    if (teamById(oldId)) tellTeam(oldId, `${names.join(', ')} left the team.`)
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
    tellAgents(before, `[Tessel] Team "${team.name}": ${names} joined the team.`, teamId)
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
  tellTeam(teamId, `The team "${old}" is now called "${clean}".`)
}

function leaveTeam(leafId) {
  const leaf = findLeaf(leafId)
  if (!leaf || !leaf.team) return
  const teamId = leaf.team
  const name = teamById(teamId)?.name || 'the team'
  const wsId = wsOfLeaf(leaf.id)?.id || null
  leaf.team = null
  logMembership(leaf, null)
  pruneTeams()
  tellAgents([leaf], `[Tessel] You are no longer in team "${name}".`, teamId)
  recordActivity({ type: 'team', action: 'left', teamId, wsId, name, detail: leaf.title })
  if (teamById(teamId)) tellTeam(teamId, `${leaf.title} left the team.`)
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
    tellAgents(still, `[Tessel] Team "${team.name}" was ungrouped: you now work on your own.`, teamId)
    recordActivity({ type: 'team', action: 'ungrouped', teamId, wsId, name: team.name })
    const home = workspaces.value.find((w) => w.id === wsId)
    for (const id of Object.keys(team.inboxes || {})) dropInbox(team, id, home && home.cwd)
    team.leadId = null
    handOffLeadReviews(teamId)
  }, UNGROUP_UNDO_MS)
  showToast(`${team.name} ungrouped. Its sessions stay where they are.`, {
    timeout: UNGROUP_UNDO_MS,
    action: {
      label: 'Undo',
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
    tellAgents(members, `[Tessel] Team "${team.name}": ${text}`, teamId)
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
      `[Tessel] You are now in team "${team.name}"` +
        (mates.length ? ` with ${mates.join(', ')}.` : ' (no other agent yet).') +
        (notes
          ? ` Shared notes: ${notes} . Read them, agree there on who does what, and add a dated line to their Journal for each notable change.`
          : '') +
        ' Before editing a file a teammate may be editing, check with them. Do not commit the notes file.' +
        (box ? `\nTalk to your teammates directly through the team channel, not through the user.\n${box.guide}` : ''),
      teamId
    )
  }
  const told = members.filter((l) => !limits[l.id] && (!opts.only || opts.only.includes(l.id))).length
  showToast(`Told ${told} ${told === 1 ? 'agent' : 'agents'} they are in ${team.name}.`, {
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
  window.shellApi.team.notice({ dir, teamId, notices: agents.map((l) => ({ toId: l.id, text })) })
  for (const l of agents) logMessage(l.id, 'sent', text, meta)
  return true
}

function messageTeam(teamId, text) {
  const team = teamById(teamId)
  if (team) messageAgents(teamMembers(teamId), text, team.name, { scope: 'team', teamId })
}

// Send one message to every agent of a workspace (never to plain shells,
// which would run it as a command).
function messageWorkspace(wsId, text) {
  const ws = workspaces.value.find((w) => w.id === wsId)
  if (ws) messageAgents(wsAgents(wsId), text, ws.name, { scope: 'workspace' })
}

function messageAgents(list, text, where, meta = {}) {
  const body = String(text || '').trim()
  if (!body) return
  const agents = list.filter((l) => l.kind === 'agent')
  if (!agents.length) {
    showToast(`${where} has no agent to message.`, { kind: 'error' })
    return
  }
  // Agents out of usage would not act on it: skip them and say so.
  const limited = agents.filter((l) => limits[l.id])
  const reached = agents.filter((l) => !limits[l.id])
  for (const leaf of reached) deliverToAgent(leaf.id, body, meta)
  for (const leaf of limited) logMessage(leaf.id, 'skipped', body, meta)
  const held = reached.filter((l) => pendingMessages[l.id])
  const names = (list) => list.map((l) => l.title).join(', ')
  const parts = [`Sent to ${reached.length - held.length} of ${agents.length} agents.`]
  if (held.length) {
    parts.push(
      `${names(held)} ${held.length === 1 ? 'is' : 'are'} waiting for your approval and will get it right after.`
    )
  }
  if (limited.length) {
    parts.push(
      `Skipped ${limited.map((l) => `${l.title}${limitWhen(l.id)}`).join(', ')}: usage limit reached.`
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
  return /^in /.test(reset) ? ` (resets ${reset})` : ` (resets at ${reset})`
}

// An agent just stopped because it hit its usage limit.
function notifyAgentLimit(node, hit) {
  const ws = wsOfLeaf(node.id)
  const when = limitWhen(node.id) || (hit && hit.reset ? ` (resets ${hit.reset})` : '')
  const others = ws ? wsAgents(ws.id).filter((l) => l.id !== node.id && !limits[l.id]) : []
  const handOver = others.length
    ? ` ${others.map((l) => l.title).join(', ')} can take over.`
    : ''
  const text = `${node.title} hit its usage limit${when}.${handOver}`
  if (document.hasFocus()) {
    showToast(text, {
      kind: 'attention',
      timeout: 10000,
      action: { label: 'Show', run: () => focusPane(node.id) }
    })
  } else if (window.shellApi.notify && settings.desktopNotifications) {
    window.shellApi.notify({
      title: `${node.title} hit its usage limit`,
      body: `${when.trim()}${ws ? ` Workspace: ${ws.name}.` : ''}${handOver}`.trim(),
      paneId: node.id
    })
  }
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
`
}

// Create the workspace's shared notes file (once) and tell each agent who the
// others are and where the file is.
async function shareProjectNotes(wsId) {
  const ws = workspaces.value.find((w) => w.id === wsId)
  if (!ws) return
  const agents = wsAgents(wsId)
  if (!agents.length) {
    showToast(`Open an agent in ${ws.name} first.`, { kind: 'error' })
    return
  }
  const dir = ws.cwd || agents[0].startDir
  if (!dir) {
    showToast(`Set a project folder for "${ws.name}" first.`, { kind: 'error' })
    return
  }
  if (!window.shellApi.projectNotes) {
    showToast('Restart Tessel to enable project notes.', { kind: 'error' })
    return
  }
  const res = await window.shellApi.projectNotes({ dir, content: projectNotesTemplate(ws) })
  if (!res || !res.ok) {
    showToast(`Could not create the project notes: ${(res && res.error) || 'unknown error'}`, {
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
      `[Tessel] Other agents in this project: ${others || 'none yet'}.` +
        ` Shared notes: ${res.path} . Read that file now, agree there on who does what, ` +
        'and add a dated line to its Journal section for each notable change. ' +
        'Before editing a file another agent may be editing, check the notes. Do not commit that file.',
      { source: 'tessel', scope: 'notes' }
    )
  }
  const limited = agents.filter((l) => limits[l.id])
  const told = agents.length - limited.length
  showToast(
    `${res.created ? 'Created' : 'Shared'} the project notes with ${told} ${told === 1 ? 'agent' : 'agents'}. ${res.path}` +
      (limited.length
        ? ` Skipped ${limited.map((l) => `${l.title}${limitWhen(l.id)}`).join(', ')}: usage limit reached.`
        : ''),
    { timeout: limited.length ? 8000 : 5000 }
  )
}

// The notes view inside Tessel (NotesPanel), for a workspace.
const notesView = ref(null) // { wsId, dir, wsName, template }
function openNotesView(wsId) {
  const ws = workspaces.value.find((w) => w.id === wsId)
  if (!ws) return
  const dir = ws.cwd || wsAgents(wsId)[0]?.startDir
  if (!dir) {
    showToast(`Set a project folder for "${ws.name}" first.`, { kind: 'error' })
    return
  }
  closeMenus()
  notesView.value = { wsId, dir, wsName: ws.name, template: projectNotesTemplate(ws) }
}

// Open the workspace's notes file in the user's text editor (created if missing).
async function openProjectNotes(wsId) {
  const ws = workspaces.value.find((w) => w.id === wsId)
  if (!ws) return
  const dir = ws.cwd || wsAgents(wsId)[0]?.startDir
  if (!dir) {
    showToast(`Set a project folder for "${ws.name}" first.`, { kind: 'error' })
    return
  }
  if (!window.shellApi.openProjectNotes) {
    showToast('Restart Tessel to open the project notes.', { kind: 'error' })
    return
  }
  const res = await window.shellApi.openProjectNotes({ dir, content: projectNotesTemplate(ws) })
  if (!res || !res.ok) {
    showToast(`Could not open the project notes: ${(res && res.error) || 'unknown error'}`, {
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
  if (attention[leaf.id]) return 'waiting'
  return agentStatus[leaf.id] === 'busy' ? 'working' : 'ready'
}

// Panes of the current workspace with their agent state, for the sidebar's
// session list. Only the Warp theme shows it.
const sessionItems = computed(() => {
  const items = []
  forEachLeaf(tree.value, (leaf) => {
    const state = paneState(leaf)
    items.push({
      id: leaf.id,
      num: leaf.num || 0,
      title: leaf.title || leaf.shellName || 'Terminal',
      kind: leaf.kind || 'shell',
      agentId: leaf.agentId || null,
      shellId: leaf.shellId || null,
      accent: leaf.accent || null,
      state,
      reset: limits[leaf.id] ? limits[leaf.id].reset : '',
      held: !!pendingMessages[leaf.id],
      typingHold: !!pendingMessages[leaf.id] && !!userDraft[leaf.id],
      teamUnread: teamUnread[leaf.id] || 0,
      toolsDown: !!toolsDown[leaf.id],
      team: leaf.team || null,
      lead: !!(leaf.team && teamById(leaf.team)?.leadId === leaf.id),
      task: taskOfPane(leaf.id)?.title || null,
      review: taskOfPane(leaf.id)?.column === 'review',
      leadReview: taskOfPane(leaf.id)?.leadReview || null,
      track: leaf.kind === 'agent' ? trackOf(leaf.id) : null,
      active: leaf.id === activeId.value
    })
  })
  return items
})

// Bottom status bar (Warp theme): where typing goes, pane states, folder.
const statusBar = computed(() => {
  if (settings.theme !== 'warp') return null
  const items = sessionItems.value
  const count = (state) => items.filter((s) => s.state === state).length
  const parts = [`${items.length} ${items.length === 1 ? 'pane' : 'panes'}`]
  if (count('working')) parts.push(`${count('working')} working`)
  if (count('waiting')) parts.push(`${count('waiting')} waiting for you`)
  const active = items.find((s) => s.active)
  let target = active ? `Input → ${active.title}` : ''
  if (broadcast.value) {
    let n = 0
    forEachLeaf(tree.value, (leaf) => leaf.broadcast && n++)
    target = `Broadcast → ${n} ${n === 1 ? 'pane' : 'panes'}`
  }
  return { target, summary: parts.join(' · '), path: currentWs.value?.cwd || '' }
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
    const ta = document.querySelector('.ws-layer:not(.hidden) .pane.active .xterm-helper-textarea')
    if (ta) ta.focus()
  })
}
watch(
  () => [paletteOpen.value, !!confirmState.value, !!notesView.value, !!reviewTask.value],
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
    !!confirmState.value ||
    launcher.open
  )
}

// Typing in a text field of Tessel (notes, review, a form, the sidebar):
// pane shortcuts must not act on the terminals behind it.
function typingInField(e) {
  const t = e.target
  if (!t || !t.closest) return false
  if (t.closest('.xterm')) return false // a terminal: shortcuts are for it
  return !!t.closest('input, textarea, select, [contenteditable="true"]')
}

function onKey(e) {
  if (typingInField(e) && e.key !== 'Escape' && e.key !== 'F1') return
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
    saved = await window.shellApi.loadLayout()
  } catch {
    saved = null
  }

  if (saved) {
    if (saved.selectedShell && shells.value.some((s) => s.id === saved.selectedShell)) {
      selectedShell.value = saved.selectedShell
    }
    broadcast.value = !!saved.broadcast
    sidebarCollapsed.value = !!saved.sidebarCollapsed
    // The task board opens again if it was open.
    if (saved.taskPanelOpen === true) taskPanelOpen.value = true
    if (Number.isFinite(saved.taskPanelWidth))
      taskPanelWidth.value = Math.round(Math.min(TASK_PANEL_MAX, Math.max(TASK_PANEL_MIN, saved.taskPanelWidth)))
    if (Number.isFinite(saved.sidebarWidth)) {
      sidebarWidth.value = Math.min(480, Math.max(160, saved.sidebarWidth))
    }
    // Older saves kept only the font size at the top level.
    loadSettings(
      saved.settings || (Number.isFinite(saved.fontSize) ? { fontSize: saved.fontSize } : null)
    )
    if (['right', 'down', 'workspace'].includes(saved.placement)) placement.value = saved.placement
    if (Array.isArray(saved.teams)) teams.value = saved.teams.filter(isTeam)
    // v2 stores a list of workspaces; v1 stored a single tree.
    const snaps = !settings.restoreWorkspaces
      ? []
      : Array.isArray(saved.workspaces)
        ? saved.workspaces
        : saved.tree
          ? [{ name: 'Workspace 1', tree: saved.tree }]
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
      try {
        ws.tree = await deserializeNode(snap.tree, ws.cwd)
      } catch {
        ws.tree = null
      }
      if (!ws.tree) {
        const leaf = await createLeaf(selectedShell.value, null, ws.cwd)
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

  const ws = makeWorkspace('Workspace 1')
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
  startStep = 'layout'
  await restoreOrSeedLayout()
  startStep = 'terminals'
  if (window.shellApi.reconcilePtys) {
    const ids = []
    forEachWsLeaf((l) => ids.push(l.id))
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
  persistReady = true
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
    const saved = await window.shellApi.taskBoard.load({ withLedger: true })
    const savedTasks = Array.isArray(saved) ? saved : saved && saved.tasks
    if (Array.isArray(savedTasks)) setTasks(savedTasks)
    for (const k of (saved && saved.appliedRequests) || []) appliedRequests.add(k)
  } catch {
    /* start with an empty board if persisted tasks can't be read */
  }
  // Drop assignments to panes that didn't survive into this session, then start
  // saving. Reconciling before the watch is registered keeps it from writing the
  // file back on every launch (the cleanup is idempotent and persists on the
  // next real change).
  reconcileTaskPanes()
  watch(boardTasks, scheduleTaskSave, { deep: true })
  teamsReady = true

  window.addEventListener('keydown', onKey)
  window.addEventListener('pointerdown', onDocPointerDown, true)
  unsubFocusPane = window.shellApi.onFocusPane
    ? window.shellApi.onFocusPane(({ paneId }) => focusPane(paneId))
    : null
  initUpdates()
})

let unsubFocusPane = null

// Closing or reloading the window: what is waiting to be saved (layout,
// board, activity; saved a moment after each change) is written now, so the
// last change before closing is not lost.
function flushSaves() {
  saveLayoutNow()
  if (taskSaveTimer) {
    clearTimeout(taskSaveTimer)
    taskSaveTimer = null
    window.shellApi.taskBoard.save(boardToSave())
  }
  saveActivityNow()
}
window.addEventListener('beforeunload', flushSaves)
window.addEventListener('pagehide', flushSaves)

onBeforeUnmount(() => {
  if (unsubFocusPane) unsubFocusPane()
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
          <span v-if="isDev" class="brand-dev" title="Development build (npm run dev)">dev</span>
        </div>
        <span class="tb-slash">/</span>
        <div class="menu-group" @pointerdown.stop>
          <button
            class="tb-ws"
            :class="{ open: openMenu === 'workspaces' }"
            title="Switch workspace (Ctrl+PageUp / Ctrl+PageDown)"
            aria-haspopup="menu"
            @click="toggleMenu('workspaces')"
          >
            <span class="tb-ws-name">{{ currentWs ? currentWs.name : 'Workspace' }}</span>
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
            <div class="menu-label">Workspaces</div>
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
              <span class="menu-item-name">New workspace</span>
              <span class="menu-shortcut">Ctrl+Shift+N</span>
            </button>
          </div>
        </div>
      </div>

      <!-- Middle: one search box that finds panes, workspaces and commands. -->
      <div class="tb-center">
        <button class="tb-command" title="Command palette (Ctrl+Shift+P)" @click="openPalette">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <circle cx="7" cy="7" r="4.6" stroke="currentColor" stroke-width="1.4" />
            <path
              d="M10.4 10.4L14 14"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linecap="round"
            />
          </svg>
          <span class="tb-command-text">Search panes, run a command</span>
          <kbd class="tb-command-kbd">Ctrl+Shift+P</kbd>
        </button>
      </div>

      <!-- Right: create, then icon-only toggles with tooltips. -->
      <div class="tb-right">
        <button
          v-if="updateStatus.state === 'ready'"
          class="tb-update"
          :title="`Tessel ${updateStatus.version} is ready: restart to update`"
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
          Update {{ updateStatus.version }}
        </button>

        <div class="tb-newsplit launch-trigger" @pointerdown.stop>
          <button
            class="tb-icon"
            :title="`New ${selectedShellName()} (Ctrl+Shift+T)`"
            aria-label="New terminal"
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
            title="Open a terminal or an agent (Ctrl+Shift+Space)"
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

        <button
          class="tb-icon"
          :class="{ on: broadcast, warn: broadcast }"
          :title="`Broadcast is ${broadcast ? 'on' : 'off'}: type once into every pane with write checked (Ctrl+Shift+B)`"
          aria-label="Broadcast"
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
          :class="{ on: taskPanelOpen }"
          title="Task board (Ctrl+Shift+K)"
          aria-label="Task board"
          :aria-pressed="taskPanelOpen"
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
            title="Layout: split and arrange panes"
            aria-label="Layout"
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
              <span class="menu-item-name">Split right</span>
              <span class="menu-shortcut">Ctrl+Shift+E</span>
            </button>
            <button
              class="toolbar-menu-item"
              role="menuitem"
              @click="menuAction(() => splitActive('col'))"
            >
              <span class="menu-item-name">Split down</span>
              <span class="menu-shortcut">Ctrl+Shift+O</span>
            </button>
            <div class="menu-sep"></div>
            <div class="menu-label">Even grid</div>
            <div class="grid-chips">
              <button
                v-for="option in gridOptions"
                :key="option.value"
                class="grid-chip"
                :title="`Arrange this workspace into ${option.label}`"
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
              <span class="menu-item-name">Close active pane</span>
              <span class="menu-shortcut">Ctrl+Shift+W</span>
            </button>
          </div>
        </div>
        <button
          class="tb-icon"
          title="Settings (Ctrl+,)"
          aria-label="Settings"
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
      Broadcast is on. Keystrokes go to every pane with "write" checked.
    </div>

    <div class="workspace">
      <WorkspaceSidebar
        v-if="workspaces.length"
        ref="sidebarEl"
        :items="workspaceItems"
        :current-id="currentWsId"
        :collapsed="sidebarCollapsed"
        :width="sidebarWidth"
        :sessions="sessionItems"
        :teams="teams"
        @create-team="createTeam"
        @add-to-team="addToTeam"
        @rename-team="renameTeam"
        @disband-team="disbandTeam"
        @set-lead="setTeamLead"
        @message-team="messageTeam"
        @activity="openActivity"
        @focus-pane="focusPane"
        @message-ws="messageWorkspace"
        @notes-ws="openNotesView"
        @new-task="openNewTask"
        @select="selectWorkspace"
        @create="createWorkspace"
        @rename="renameWorkspace"
        @remove="removeWorkspace"
        @folder="setWorkspaceFolder"
        @toggle="toggleSidebar"
        @resize="resizeSidebar"
        @resize-end="refitSoon"
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
          {{ initError || 'Starting...' }}
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
          title="Drag to resize. Double-click to reset."
          @pointerdown="startTaskResize"
        ></div>
        <TaskBoard
          :agent-panes="agentPanes"
          :workspace-id="currentWsId"
          @new-task="openNewTask"
          @focus-pane="focusPane"
          @review="openReview"
        />
      </aside>
    </div>

    <footer v-if="statusBar" class="statusbar">
      <span class="statusbar-target">{{ statusBar.target }}</span>
      <span class="statusbar-summary">{{ statusBar.summary }}</span>
      <span class="statusbar-path" :title="statusBar.path">{{ statusBar.path }}</span>
    </footer>

    <LaunchMenu
      v-if="launcher.open"
      :shells="shells"
      :agents="agents"
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
      @copied="showToast('Session ID copied.', { timeout: 2000 })"
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
      @check-updates="checkForUpdates"
      @open-update="((settingsOpen = false), (updateOpen = true))"
      @set-default-shell="setDefaultShell"
      @close="closeSettings"
    />

    <div class="toasts" aria-live="polite">
      <div v-for="t in toasts" :key="t.id" class="toast" :class="t.kind">
        <span class="toast-text">{{ t.text }}</span>
        <button v-if="t.action" class="toast-action" @click="runToastAction(t)">
          {{ t.action.label }}
        </button>
        <button class="toast-close" title="Dismiss" @click="dismissToast(t.id)">
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
        aria-label="Keyboard shortcuts"
        tabindex="-1"
        @keydown.escape.prevent.stop="helpOpen = false"
      >
        <div class="help-head">
          <span>Keyboard shortcuts</span>
          <button class="tb-icon" title="Close (Esc)" @click="helpOpen = false">
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
          <section v-for="group in SHORTCUTS" :key="group.title">
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
          <span class="set-hint">Something wrong? Logs help find the cause.</span>
          <button class="exit-btn" @click="openLogs">Open logs folder</button>
          <button class="exit-btn" @click="copyDiagnostics">Copy diagnostics</button>
        </div>
        <p class="help-foot">
          Drop files on a pane to paste their paths. Select text to copy it, right-click to paste.
          Shift+right-click a pane for more.
        </p>
      </div>
    </div>
  </div>
</template>
