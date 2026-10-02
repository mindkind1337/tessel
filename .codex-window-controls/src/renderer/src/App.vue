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
import { agentStatus, attention, clearAgentStatus, clearAttention } from './agentStatus'
import { dropBuffer, seedBuffer } from './ptyStore'
import { tasks as boardTasks, setTasks, updateTask, removeTask } from './taskBoardStore'

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
const currentWs = computed(() => workspaces.value.find((w) => w.id === currentWsId.value) || null)

// Teams of agents working together (see "Teams" below).
const TEAM_COLORS = ['#e0a526', '#3fb6a8', '#c77dd6', '#5b9df5', '#e2724f', '#8fbf4f']
const teams = ref([]) // [{ id, name, color }]

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
  if (kind === 'codex' && sessionId && resume) {
    return { line: `${agent.command} resume ${sessionId}`, sessionId, resumed: true }
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
      res = await window.shellApi.createPty({ id, shellId, cols: 80, rows: 24, cwd })
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
    exitedAtStart: attached && !!res.exited,
    restoredText,
    broadcast: true
  })
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
  if (node.type === 'leaf') return node.id === targetId ? make(node) : node
  return {
    ...node,
    children: node.children.map((c) => replaceNode(c, targetId, make))
  }
}

function removeLeaf(node, targetId) {
  if (node.type === 'leaf') return node.id === targetId ? null : node
  const kids = node.children.map((c) => removeLeaf(c, targetId)).filter(Boolean)
  if (kids.length === 0) return null
  if (kids.length === 1) return kids[0]
  return { ...node, children: kids }
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
      title: node.title,
      broadcast: node.broadcast !== false,
      kind: node.kind || 'shell',
      agentId: node.agentId || null,
      agentCommand: node.agentCommand || null,
      accent: node.accent || null,
      worktree: node.worktree || null,
      sessionId: node.sessionId || null,
      launchedAt: node.launchedAt || null,
      startDir: node.startDir || null,
      num: node.num || null,
      team: node.team || null
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
  if (!leaf || !ws) return
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
  const hadTeam = !!findLeaf(leafId)?.team
  if (!opts.force && settings.confirmCloseAgent && ws) {
    let leaf = null
    forEachLeaf(ws.tree, (l) => {
      if (l.id === leafId) leaf = l
    })
    if (
      leaf &&
      leaf.kind === 'agent' &&
      !window.confirm(`Close ${leaf.title}? The agent session will end.`)
    ) {
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
    createLeaf(selectedShell.value, null, ws.cwd).then((leaf) => {
      if (leaf) {
        ws.tree = leaf
        ws.activeId = leaf.id
      }
    })
  }
  if (hadTeam) pruneTeams()
}

async function buildGrid(cols, rows, ws = currentWs.value) {
  if (!ws) return
  const oldIds = []
  forEachLeaf(ws.tree, (leaf) => oldIds.push(leaf.id))

  const rowNodes = []
  for (let r = 0; r < rows; r++) {
    const leaves = []
    for (let c = 0; c < cols; c++) {
      const leaf = await createLeaf(selectedShell.value, null, ws.cwd)
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

  ws.tree = root
  ws.activeId = firstLeafId(root)
  maximizedId.value = null

  oldIds.forEach((id) => {
    window.shellApi.killPty(id)
    dropBuffer(id)
    clearAgentStatus(id)
  })
}

function routeInput(sourceId, data) {
  if (broadcast.value) {
    forEachLeaf(tree.value, (leaf) => {
      if (leaf.broadcast) window.shellApi.writePty(leaf.id, data)
    })
  } else {
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
        accent: leaf.accent
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
function scheduleTaskSave() {
  if (taskSaveTimer) clearTimeout(taskSaveTimer)
  taskSaveTimer = setTimeout(() => {
    taskSaveTimer = null
    window.shellApi.taskBoard.save(boardTasks.map((t) => ({ ...t })))
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
  if (taskSaveTimer) {
    clearTimeout(taskSaveTimer)
    taskSaveTimer = null
    try {
      await window.shellApi.taskBoard.save(boardTasks.map((t) => ({ ...t })))
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

// Declared before provide('panelCtx') reads it; the team helpers live further down.

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
  teams,
  teamById,
  newTeam,
  joinTeam,
  leaveTeam,
  gatherTeam,
  disbandTeam,
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

  const active = activeId.value ? findLeaf(activeId.value) : null
  const activeTeam = active ? teamById(active.team) : null
  if (active && !activeTeam) {
    add('Team', 'New team with the active pane', () => newTeam([active.id]))
    for (const t of teams.value) {
      add('Team', `Add the active pane to ${t.name}`, () => joinTeam(active.id, t.id))
    }
  }
  const wsAgents = []
  forEachLeaf(tree.value, (l) => l.kind === 'agent' && !l.team && wsAgents.push(l.id))
  if (wsAgents.length > 1) {
    add('Team', 'New team with every agent in this workspace', () => newTeam(wsAgents), {
      hint: `${wsAgents.length} agents`
    })
  }
  if (activeTeam) add('Team', `Remove the active pane from ${activeTeam.name}`, () => leaveTeam(active.id))
  for (const t of teams.value) {
    const n = teamMembers(t.id).length
    add('Team', `Gather ${t.name}`, () => gatherTeam(t.id), {
      hint: `Side by side in their own workspace (${n} ${n === 1 ? 'pane' : 'panes'})`
    })
    add('Team', `Disband ${t.name}`, () => disbandTeam(t.id), { hint: 'Panes stay where they are' })
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
  if (mode === 'review') {
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

function closeSettings() {
  settingsOpen.value = false
  nextTick(() => {
    const ta = document.querySelector('.ws-layer:not(.hidden) .pane.active .xterm-helper-textarea')
    if (ta) ta.focus()
  })
}

function setDefaultShell(id) {
  selectedShell.value = id
  const shell = shells.value.find((s) => s.id === id)
  if (shell) showToast(`${shell.name} is now the default shell.`)
}

// Replace a pane with a fresh process of the same kind, in the same spot.
async function restartLeaf(leafId) {
  const ws = wsOfLeaf(leafId)
  if (!ws) return
  let old = null
  forEachLeaf(ws.tree, (l) => {
    if (l.id === leafId) old = l
  })
  if (!old) return
  const agent =
    old.kind === 'agent' && old.agentCommand
      ? { id: old.agentId, name: old.title, command: old.agentCommand, accent: old.accent }
      : null
  const fresh = await createLeaf(old.shellId, agent, ws.cwd, old.worktree, {
    sessionId: old.sessionId,
    resume: settings.resumeAgents
  })
  if (!fresh) return
  fresh.title = old.title
  fresh.broadcast = old.broadcast
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

function removeWorkspace(id) {
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
  if (
    lost.length &&
    !window.confirm(`Delete "${ws.name}"? ${what[0]?.toUpperCase()}${what.slice(1)}.`)
  )
    return
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
    forEachLeaf(w.tree, (leaf) => {
      paneCount++
      if (leaf.kind === 'agent') {
        if (leaf.agentId) agentIds.push(leaf.agentId)
        if (agentStatus[leaf.id] === 'busy') busy = true
        if (attention[leaf.id]) needsYou = true
      }
    })
    return {
      id: w.id,
      name: w.name,
      paneCount,
      agents: agentIds,
      busy,
      needsYou,
      folder: w.cwd ? folderName(w.cwd) : '',
      cwd: w.cwd || ''
    }
  })
)

// --- Teams: agents that work together -------------------------------------------
// A team is a name and a colour; each member pane keeps the team id (leaf.team),
// so it survives moves between workspaces and is saved with the layout.
// (TEAM_COLORS and the teams ref are declared above provide('panelCtx').)

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
  forEachWsLeaf((l) => {
    if (l.team === teamId) out.push(l)
  })
  return out
}

// Teams nobody belongs to any more (their panes were closed) go away.
function pruneTeams() {
  const used = new Set()
  forEachWsLeaf((l) => l.team && used.add(l.team))
  teams.value = teams.value.filter((t) => used.has(t.id))
}

function newTeam(leafIds) {
  const names = new Set(teams.value.map((t) => t.name))
  let n = 1
  while (names.has(`Team ${n}`)) n++
  const colors = new Set(teams.value.map((t) => t.color))
  const color = TEAM_COLORS.find((c) => !colors.has(c)) || TEAM_COLORS[n % TEAM_COLORS.length]
  const team = { id: newId('team'), name: `Team ${n}`, color }
  teams.value.push(team)
  for (const id of leafIds) {
    const leaf = findLeaf(id)
    if (leaf) leaf.team = team.id
  }
  return team
}

function joinTeam(leafId, teamId) {
  const leaf = findLeaf(leafId)
  if (!leaf || !teamById(teamId)) return
  const old = leaf.team
  leaf.team = teamId
  if (old && old !== teamId) pruneTeams()
}

function leaveTeam(leafId) {
  const leaf = findLeaf(leafId)
  if (!leaf || !leaf.team) return
  leaf.team = null
  pruneTeams()
}

// "Dissocier": the team goes away, its panes stay where they are.
function disbandTeam(teamId) {
  const team = teamById(teamId)
  if (!team) return
  for (const leaf of teamMembers(teamId)) leaf.team = null
  teams.value = teams.value.filter((t) => t.id !== teamId)
  showToast(`${team.name} disbanded. Its panes stay where they are.`, { timeout: 3000 })
}

// "Réunir": the members side by side in a workspace named after the team.
function gatherTeam(teamId) {
  const team = teamById(teamId)
  const members = teamMembers(teamId)
  if (!team || !members.length) return
  const homes = new Set(members.map((l) => wsOfLeaf(l.id)))
  if (homes.size === 1) {
    const home = [...homes][0]
    let count = 0
    forEachLeaf(home.tree, () => count++)
    if (count === members.length) {
      selectWorkspace(home.id)
      return
    }
  }
  const ws = makeWorkspace(team.name)
  ws.cwd = wsOfLeaf(members[0].id)?.cwd || null
  for (const leaf of members) detachLeaf(wsOfLeaf(leaf.id), leaf.id)
  ws.tree =
    members.length === 1
      ? members[0]
      : reactive({
          type: 'split',
          id: newId('split'),
          dir: 'row',
          sizes: members.map(() => 100 / members.length),
          children: members
        })
  ws.activeId = members[0].id
  workspaces.value.push(ws)
  selectWorkspace(ws.id)
  refitSoon()
}

// Panes of the current workspace with their agent state, for the sidebar's
// session list. Only the Warp theme shows it.
const sessionItems = computed(() => {
  if (settings.theme !== 'warp') return null
  const items = []
  forEachLeaf(tree.value, (leaf) => {
    const isAgent = leaf.kind === 'agent'
    let state = 'ready'
    if (isAgent && attention[leaf.id]) state = 'waiting'
    else if (isAgent && agentStatus[leaf.id] === 'busy') state = 'working'
    items.push({
      id: leaf.id,
      num: leaf.num || 0,
      title: leaf.title || leaf.shellName || 'Terminal',
      kind: leaf.kind || 'shell',
      agentId: leaf.agentId || null,
      shellId: leaf.shellId || null,
      accent: leaf.accent || null,
      team: teamById(leaf.team),
      state,
      active: leaf.id === activeId.value
    })
  })
  return items
})

// Bottom status bar (Warp theme): where typing goes, pane states, folder.
const statusBar = computed(() => {
  const items = sessionItems.value
  if (!items) return null
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

function onKey(e) {
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

onMounted(async () => {
  shells.value = await window.shellApi.listShells()
  agents.value = await window.shellApi.listAgents()
  await restoreOrSeedLayout()
  if (window.shellApi.reconcilePtys) {
    const ids = []
    forEachWsLeaf((l) => ids.push(l.id))
    window.shellApi.reconcilePtys(ids)
  }
  loadVoiceLanguages()
  // Settings (incl. your own agents) are loaded now; detect agents with them.
  await loadAgents()
  watch(
    () => settings.customAgents.map((a) => a.command).join('|'),
    () => loadAgents(),
    {}
  )

  // Persist on any structural / size / title / broadcast change (debounced).
  pruneTeams()
  persistReady = true
  watch(
    [
      workspaces,
      currentWsId,
      selectedShell,
      broadcast,
      sidebarCollapsed,
      sidebarWidth,
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
    const savedTasks = await window.shellApi.taskBoard.load()
    if (Array.isArray(savedTasks)) setTasks(savedTasks)
  } catch {
    /* start with an empty board if persisted tasks can't be read */
  }
  // Drop assignments to panes that didn't survive into this session, then start
  // saving. Reconciling before the watch is registered keeps it from writing the
  // file back on every launch (the cleanup is idempotent and persists on the
  // next real change).
  reconcileTaskPanes()
  watch(boardTasks, scheduleTaskSave, { deep: true })

  window.addEventListener('keydown', onKey)
  window.addEventListener('pointerdown', onDocPointerDown, true)
  unsubFocusPane = window.shellApi.onFocusPane
    ? window.shellApi.onFocusPane(({ paneId }) => focusPane(paneId))
    : null
  initUpdates()
})

let unsubFocusPane = null

onBeforeUnmount(() => {
  if (unsubFocusPane) unsubFocusPane()
  if (unsubUpdate) unsubUpdate()
  if (taskSaveTimer) clearTimeout(taskSaveTimer)
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
        @focus-pane="focusPane"
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
      <aside v-if="taskPanelOpen" class="task-panel">
        <TaskBoard :agent-panes="agentPanes" :workspace-id="currentWsId" />
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
