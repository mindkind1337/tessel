<script setup>
// The left sidebar, rebuilt on Orca's (MIT, Copyright (c) 2026 Lovecast
// Inc.; src/renderer/src/components/sidebar/: index.tsx, SidebarNav,
// SidebarHeader, sidebar-header-actions, SidebarWorkspaceOptionsMenu,
// WorktreeList and its SectionHeader, WorktreeCard, WorktreeContextMenu):
// projects (Tessel workspaces) -> workspaces (the project folder and each
// task copy, with its branch) -> the agents and terminals working in each,
// with their live state; the pane you are in is highlighted. The sidebar only
// renders and emits intents: App owns the state.
import { ref, computed, nextTick, onMounted, onBeforeUnmount } from 'vue'
import {
  Activity,
  Bell,
  BellOff,
  ChevronDown,
  Copy,
  Ellipsis,
  Folder,
  FolderOpen,
  FolderPlus,
  GitBranch,
  GitCompare,
  ListPlus,
  MessageSquare,
  Moon,
  PanelLeft,
  Pencil,
  Plus,
  Search,
  SlidersHorizontal,
  SquareTerminal,
  StickyNote,
  Trash2,
  Users,
  LogOut,
  Crown
} from 'lucide-vue-next'
import OrcaMenu from './OrcaMenu.vue'
import WorktreeCard from './sidebar/WorktreeCard.vue'
import { settings } from '../settings'
import { buildSidebarRows, neighborCard, cardTargetPane } from '../sidebarModel'

const props = defineProps({
  // Tessel workspaces as projects: [{ id, name, cwd, branch, panes: [...],
  //   copies: [{ path, branch, title, taskId }] }] (see sidebarModel.js).
  projects: { type: Array, required: true },
  currentId: { type: String, default: null },
  collapsed: { type: Boolean, default: false },
  width: { type: Number, default: 280 },
  // Teams (groups of agents): [{ id, name, color, leadId }]; a pane's `team` is an id.
  teams: { type: Array, default: () => [] },
  // Live ports by card key (sidebarModel's card.key).
  ports: { type: Object, default: () => ({}) },
  // A clock (ms) so ages ("3m") refresh.
  now: { type: Number, default: () => Date.now() },
  paletteShortcut: { type: String, default: 'Ctrl+Shift+P' }
})

const emit = defineEmits([
  'focus-pane',
  'message-ws',
  'notes-ws',
  'create-team',
  'new-task',
  'add-to-team',
  'rename-team',
  'disband-team',
  'leave-team',
  'set-lead',
  'message-team',
  'activity',
  'folder',
  'select',
  'create',
  'rename',
  'remove',
  'toggle',
  'resize',
  'resize-end',
  'search',
  'open-card',
  'mark-read',
  'mark-unread',
  'sleep',
  'copy',
  'reveal',
  'delete-task',
  'review-task',
  'port-open',
  'port-copy',
  'port-stop'
])

// --- Options (persisted in settings, Orca's defaults) -------------------------
const options = computed(() => ({
  groupBy: settings.sidebarGroupBy,
  sortBy: settings.sidebarSortBy,
  projectOrderBy: settings.sidebarProjectOrderBy,
  showSleepingWorkspaces: settings.showSleepingWorkspaces,
  alwaysShowDefaultBranchWorkspace: settings.alwaysShowDefaultBranchWorkspace,
  hideDefaultBranchWorkspace: settings.hideDefaultBranchWorkspace,
  filterRepoIds: settings.sidebarFilterRepoIds,
  collapsedGroups: settings.sidebarCollapsedGroups
}))
const rows = computed(() => buildSidebarRows(props.projects, options.value, props.now))
const grouped = computed(() => settings.sidebarGroupBy !== 'none')
const showPorts = computed(() => settings.worktreeCardProperties.includes('ports'))
const showAgents = computed(() => settings.worktreeCardProperties.includes('inline-agents'))
const projectNames = computed(() => Object.fromEntries(props.projects.map((p) => [p.id, p.name])))
const activeCard = computed(() => rows.value.find((r) => r.type === 'card' && r.card.isActive)?.card || null)

function toggleGroup(key) {
  const list = settings.sidebarCollapsedGroups
  settings.sidebarCollapsedGroups = list.includes(key) ? list.filter((k) => k !== key) : [...list, key]
}

// "N agents" summaries: open or closed per card; the card you are in starts open.
const expandedState = ref({})
function isExpanded(card) {
  const v = expandedState.value[card.key]
  return v === undefined ? card.isActive : v
}
function toggleExpanded(key) {
  const card = rows.value.find((r) => r.key === key)?.card
  expandedState.value = { ...expandedState.value, [key]: !(card ? isExpanded(card) : false) }
}

// --- Drag the right edge to resize ---------------------------------------------
const MIN_WIDTH = 220 // Orca's
const MAX_WIDTH = 500
const DEFAULT_WIDTH = 280
const COLLAPSE_BELOW = 110 // dragging this far left collapses the sidebar
const navEl = ref(null)
const resizing = ref(false)
let lastDown = 0

function startResize(e) {
  if (e.button !== 0) return
  e.preventDefault()
  const now = Date.now()
  if (now - lastDown < 400) {
    lastDown = 0
    resetWidth()
    return
  }
  lastDown = now
  const left = navEl.value ? navEl.value.getBoundingClientRect().left : 0
  resizing.value = true
  document.body.classList.add('ws-resizing')
  let wantsCollapse = false
  const startWidth = props.width
  const move = (ev) => {
    const raw = ev.clientX - left
    if (props.collapsed) {
      if (raw > COLLAPSE_BELOW) emit('toggle')
      return
    }
    wantsCollapse = raw < COLLAPSE_BELOW
    emit('resize', Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, raw))))
  }
  const up = () => {
    resizing.value = false
    document.body.classList.remove('ws-resizing')
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    if (wantsCollapse && !props.collapsed) {
      emit('resize', startWidth)
      emit('toggle')
    }
    emit('resize-end')
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}

function resetWidth() {
  if (props.collapsed) emit('toggle')
  emit('resize', DEFAULT_WIDTH)
  emit('resize-end')
}

// Settings > Appearance > Left Sidebar Appearance (Orca's resolveLeftSidebarStyleVariables).
const sidebarStyle = computed(() => {
  const s = props.collapsed ? {} : { flexBasis: props.width + 'px' }
  const mode = settings.leftSidebarAppearanceMode
  let bg = null
  if (mode === 'match-terminal') bg = 'var(--term)'
  else if (mode === 'tinted') {
    const pct = Number((settings.leftSidebarTintOpacity * 100).toFixed(2))
    bg = `color-mix(in srgb, ${settings.leftSidebarTintColor} ${pct}%, var(--surface))`
  }
  if (bg) s['--wts'] = bg
  return s
})

// --- Rename a project in place (double-click its name) -------------------------
const editingId = ref(null)
const draft = ref('')
const inputEls = {}

function startRename(item) {
  editingId.value = item.id
  draft.value = item.name
  nextTick(() => {
    const el = inputEls[item.id]
    if (el) el.select()
  })
}
function commitRename() {
  if (!editingId.value) return
  const name = draft.value.trim()
  if (name) emit('rename', editingId.value, name)
  editingId.value = null
}

function initials(name) {
  const words = (name || '?').trim().split(/\s+/)
  const s = words.length > 1 ? words[0][0] + words[1][0] : words[0].slice(0, 2)
  return s.toUpperCase()
}

// --- One message to every agent of a project, or of a team ----------------------
const messagingId = ref(null) // project id | 'team:<id>'
const messagingWs = ref(null) // where the box shows
const messageDraft = ref('')
let messageEl = null

function startMessage(target, wsId) {
  messagingId.value = messagingId.value === target ? null : target
  messagingWs.value = wsId || target
  messageDraft.value = ''
  nextTick(() => messageEl && messageEl.focus())
}
function sendMessage() {
  const text = messageDraft.value.trim()
  const target = messagingId.value || ''
  if (text && target.startsWith('team:')) emit('message-team', target.slice(5), text)
  else if (text) emit('message-ws', target, text)
  messagingId.value = null
  messageDraft.value = ''
}
function teamById(id) {
  return props.teams.find((t) => t.id === id) || null
}
function teamName(id) {
  return teamById(id)?.name || 'a team'
}

// --- Tick agents to make a team, or add them to one --------------------------
// Only agents in no team can be ticked: moving one to another team goes
// through "Leave Team" first, so no team changes by surprise.
const picking = ref(null) // { wsId, target: 'new' | team id }
const picked = ref([])
function projectPanes(wsId) {
  return props.projects.find((p) => p.id === wsId)?.panes || []
}
function canPick(row) {
  return row.kind === 'agent' && !row.team
}
function pickWhy(row) {
  if (row.kind !== 'agent') return 'Terminals cannot be in a team'
  if (row.team) return `Already in ${teamName(row.team)}. To move it, use Leave Team in its menu first.`
  return 'Tick to put it in the team'
}
function startPicking(wsId, target = 'new', first = null) {
  picking.value = { wsId, target }
  picked.value = first ? [first] : []
}
function cancelPicking() {
  picking.value = null
  picked.value = []
}
function togglePicked(id) {
  picked.value = picked.value.includes(id) ? picked.value.filter((x) => x !== id) : [...picked.value, id]
}
function groupPicked() {
  const p = picking.value
  if (p && picked.value.length) {
    if (p.target !== 'new') emit('add-to-team', p.target, picked.value.slice())
    else emit('create-team', picked.value.slice())
  }
  cancelPicking()
}
const pickTeam = computed(() => (picking.value && picking.value.target !== 'new' ? teamById(picking.value.target) : null))
function pickingFor(wsId) {
  if (!picking.value || picking.value.wsId !== wsId) return null
  return { active: true, picked: picked.value, canPick, why: pickWhy }
}
function pickableCount(wsId) {
  return projectPanes(wsId).filter((p) => p.kind === 'agent' && !p.team).length
}

// Rename a team (from its menu).
const editingTeam = ref(null) // { id, wsId }
const teamDraft = ref('')
let teamInputEl = null
function startTeamRename(team, wsId) {
  editingTeam.value = { id: team.id, wsId }
  teamDraft.value = team.name
  nextTick(() => teamInputEl && teamInputEl.select())
}
function commitTeamRename() {
  if (!editingTeam.value) return
  const name = teamDraft.value.trim()
  if (name) emit('rename-team', editingTeam.value.id, name)
  editingTeam.value = null
}

// --- Clicks ------------------------------------------------------------------
function activateCard(card) {
  const target = cardTargetPane(card)
  if (target) emit('focus-pane', target)
  else emit('open-card', { wsId: card.projectId, path: card.path, isMain: card.isMain })
}
function focusRow(id) {
  emit('focus-pane', id)
}
function onPick(id) {
  togglePicked(id)
}
function toggleRead(card) {
  if (card.isUnread) emit('mark-read', card.panes.filter((r) => r.unvisited).map((r) => r.id))
  else {
    const first = card.panes.find((r) => r.kind === 'agent') || card.panes[0]
    if (first) emit('mark-unread', first.id)
  }
}

// Arrow keys in the focused list move between workspaces (Orca's
// navigateWorktree); Enter goes to the pane.
const listEl = ref(null)
function onListKey(e) {
  if (e.target !== e.currentTarget) return
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    e.preventDefault()
    const card = neighborCard(rows.value, activeCard.value?.key || null, e.key === 'ArrowUp' ? 'up' : 'down')
    if (card) {
      activateCard(card)
      nextTick(() => {
        const el = listEl.value && [...listEl.value.querySelectorAll('[data-card-key]')].find((n) => n.dataset.cardKey === card.key)
        if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' })
        if (listEl.value) listEl.value.focus()
      })
    }
  } else if (e.key === 'Enter') {
    e.preventDefault()
    const card = activeCard.value
    const target = card && cardTargetPane(card)
    if (target) emit('focus-pane', target)
  }
}

// --- Menus -------------------------------------------------------------------
const menu = ref(null) // { kind, anchor, side, align, items, width, label }
function openMenu(kind, anchor, items, extra = {}) {
  menu.value = { kind, anchor, items, side: 'bottom', align: 'start', ...extra }
}
function closeMenu() {
  menu.value = null
}
function rectOf(e) {
  const r = e.currentTarget.getBoundingClientRect()
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
}

const SORT_OPTIONS = [
  { id: 'name', label: 'Name' },
  { id: 'smart', label: 'Agent Activity', description: 'Agents that need attention, then most recent activity.' },
  { id: 'recent', label: 'Recent' },
  { id: 'repo', label: 'Project' },
  { id: 'manual', label: 'Manual', description: 'The project folder first, then each task copy as it was made.' }
]
const PROJECT_ORDER_OPTIONS = [
  { id: 'manual', label: 'Manual', description: 'Drag projects to arrange them' },
  { id: 'recent', label: 'Recent', description: 'Most recent workspace activity' }
]

// Orca's useWorkspaceOptionsFilterBadge.
const filterBadge = computed(() => {
  const selected = props.projects.filter((p) => settings.sidebarFilterRepoIds.includes(p.id)).length
  const sleeping = settings.showSleepingWorkspaces !== true
  const exemption = !settings.showSleepingWorkspaces && !settings.alwaysShowDefaultBranchWorkspace
  const count = (sleeping ? 1 : 0) + (settings.hideDefaultBranchWorkspace ? 1 : 0) + (exemption ? 1 : 0) + selected
  return { count, label: `${count} ${count === 1 ? 'filter' : 'filters'}` }
})

function projectFilterLabel() {
  const sel = props.projects.filter((p) => settings.sidebarFilterRepoIds.includes(p.id))
  if (!sel.length) return 'All projects'
  if (sel.length === 1) return sel[0].name
  return `${sel.length} projects`
}

function optionsItems() {
  const items = [{ type: 'label', label: 'Workspace options', className: 'orca-menu-title' }]
  if (props.projects.length > 1) {
    const filter = settings.sidebarFilterRepoIds
    items.push({ type: 'label', label: 'Show' })
    items.push({
      type: 'sub',
      label: 'Projects',
      hint: projectFilterLabel(),
      width: 256,
      children: [
        {
          type: 'item',
          label: 'Clear',
          disabled: !filter.length,
          keepOpen: true,
          onSelect: () => (settings.sidebarFilterRepoIds = [])
        },
        { type: 'separator' },
        ...props.projects.map((p) => ({
          type: 'checkbox',
          label: p.name,
          checked: filter.includes(p.id),
          onSelect: () =>
            (settings.sidebarFilterRepoIds = filter.includes(p.id) ? filter.filter((x) => x !== p.id) : [...filter, p.id])
        }))
      ]
    })
    items.push({ type: 'separator' })
  }
  items.push({ type: 'label', label: 'Group by' })
  items.push({
    type: 'segmented',
    label: 'Group by',
    value: settings.sidebarGroupBy,
    options: [
      { id: 'none', label: 'None' },
      { id: 'repo', label: 'Project' }
    ],
    onChange: (v) => (settings.sidebarGroupBy = v)
  })
  items.push({ type: 'separator' })
  items.push({
    type: 'sub',
    label: 'Sort by',
    hint: SORT_OPTIONS.find((o) => o.id === settings.sidebarSortBy)?.label || 'Sort',
    width: 176,
    children: SORT_OPTIONS.map((o) => ({
      type: 'radio',
      label: o.label,
      title: o.description || '',
      checked: settings.sidebarSortBy === o.id,
      onSelect: () => (settings.sidebarSortBy = o.id)
    }))
  })
  if (settings.sidebarGroupBy === 'repo') {
    items.push({
      type: 'sub',
      label: 'Project order',
      hint: PROJECT_ORDER_OPTIONS.find((o) => o.id === settings.sidebarProjectOrderBy)?.label || 'Manual',
      width: 176,
      children: PROJECT_ORDER_OPTIONS.map((o) => ({
        type: 'radio',
        label: o.label,
        title: o.description,
        checked: settings.sidebarProjectOrderBy === o.id,
        onSelect: () => (settings.sidebarProjectOrderBy = o.id)
      }))
    })
  }
  items.push({
    type: 'sub',
    label: 'Card layout',
    hint: settings.compactWorktreeCards ? 'Compact' : 'Detailed',
    width: 176,
    children: [
      { id: false, label: 'Detailed' },
      { id: true, label: 'Compact' }
    ].map((o) => ({
      type: 'radio',
      label: o.label,
      checked: settings.compactWorktreeCards === o.id,
      onSelect: () => (settings.compactWorktreeCards = o.id)
    }))
  })
  const props_ = settings.worktreeCardProperties
  const toggleProp = (id) =>
    (settings.worktreeCardProperties = props_.includes(id) ? props_.filter((x) => x !== id) : [...props_, id])
  items.push({
    type: 'sub',
    label: 'Show properties',
    hint: settings.compactWorktreeCards ? 'Hover' : props_.length ? String(props_.length) : '',
    width: 192,
    children: [
      { type: 'checkbox', label: 'Ports', checked: props_.includes('ports'), onSelect: () => toggleProp('ports') },
      {
        type: 'checkbox',
        label: 'Agent activity',
        checked: props_.includes('inline-agents'),
        onSelect: () => toggleProp('inline-agents')
      },
      { type: 'separator' },
      { type: 'label', label: 'Agent activity layout' },
      ...[
        { id: 'compact', label: 'Compact' },
        { id: 'full', label: 'Full list' }
      ].map((o) => ({
        type: 'radio',
        label: o.label,
        checked: settings.agentActivityDisplayMode === o.id,
        onSelect: () => (settings.agentActivityDisplayMode = o.id)
      }))
    ]
  })
  items.push({ type: 'separator' })
  items.push({ type: 'label', label: 'Filters' })
  items.push({
    type: 'switch',
    icon: Moon,
    label: 'Hide sleeping',
    checked: !settings.showSleepingWorkspaces,
    onChange: (hide) => (settings.showSleepingWorkspaces = !hide)
  })
  if (!settings.showSleepingWorkspaces) {
    items.push({
      type: 'switch',
      icon: GitBranch,
      indented: true,
      label: 'Except default branch',
      ariaLabel: 'Keep the default branch visible while hiding sleeping workspaces',
      checked: settings.alwaysShowDefaultBranchWorkspace,
      onChange: (v) => (settings.alwaysShowDefaultBranchWorkspace = v)
    })
  }
  items.push({
    type: 'switch',
    icon: GitBranch,
    label: 'Hide default branch',
    checked: settings.hideDefaultBranchWorkspace,
    onChange: (v) => (settings.hideDefaultBranchWorkspace = v)
  })
  return items
}
// The options menu is rebuilt on every change so its checks stay live.
const optionsOpen = ref(null) // anchor rect
const optionsMenuItems = computed(() => (optionsOpen.value ? optionsItems() : []))

function projectActionItems(project) {
  const wsId = project.id
  return [
    { type: 'item', icon: Pencil, label: 'Rename', onSelect: () => startRename(project) },
    {
      type: 'item',
      icon: FolderOpen,
      label: project.cwd ? 'Change Project Folder…' : 'Set Project Folder…',
      title: project.cwd ? `Project folder: ${project.cwd}` : 'New panes start in the project folder',
      onSelect: () => emit('folder', wsId)
    },
    { type: 'separator' },
    {
      type: 'item',
      icon: ListPlus,
      label: 'New Task…',
      onSelect: () => {
        emit('select', wsId)
        emit('new-task')
      }
    },
    {
      type: 'item',
      icon: MessageSquare,
      label: 'Message All Agents…',
      disabled: !projectPanes(wsId).some((p) => p.kind === 'agent'),
      onSelect: () => startMessage(wsId, wsId)
    },
    {
      type: 'item',
      icon: Users,
      label: 'New Team…',
      disabled: pickableCount(wsId) < 2,
      title: pickableCount(wsId) < 2 ? 'A team needs at least two agents that are in no team yet' : '',
      onSelect: () => startPicking(wsId, 'new')
    },
    { type: 'item', icon: StickyNote, label: 'Project Notes', onSelect: () => emit('notes-ws', wsId) },
    {
      type: 'item',
      icon: Activity,
      label: 'Activity',
      onSelect: () => {
        emit('select', wsId)
        emit('activity', 'workspace')
      }
    },
    { type: 'separator' },
    { type: 'item', icon: Trash2, label: 'Remove Project', danger: true, onSelect: () => emit('remove', wsId) }
  ]
}

function cardMenuItems(card) {
  const items = [{ type: 'label', label: 'Workspace' }]
  if (card.path) {
    items.push({ type: 'item', icon: FolderOpen, label: 'Open in File Explorer', onSelect: () => emit('reveal', card.path) })
    items.push({ type: 'item', icon: Copy, label: 'Copy Path', onSelect: () => emit('copy', card.path, 'path') })
  }
  items.push({
    type: 'item',
    icon: Copy,
    label: 'Copy Worktree Name',
    onSelect: () => emit('copy', card.branch || card.title, 'name')
  })
  items.push({ type: 'separator' })
  items.push({
    type: 'item',
    icon: card.isUnread ? BellOff : Bell,
    label: card.isUnread ? 'Mark Read' : 'Mark Unread',
    disabled: !card.panes.length,
    onSelect: () => toggleRead(card)
  })
  if (card.taskId) {
    items.push({ type: 'item', icon: GitCompare, label: 'Review Changes…', onSelect: () => emit('review-task', card.taskId) })
  }
  items.push({ type: 'separator' })
  const sleepable = card.panes.filter((r) => r.kind === 'agent' && !r.sleeping).map((r) => r.id)
  items.push({
    type: 'item',
    icon: Moon,
    label: 'Sleep',
    title: 'Close all active panels in this workspace to free up memory and CPU.',
    disabled: !sleepable.length,
    onSelect: () => emit('sleep', sleepable)
  })
  if (card.isMain) {
    items.push({
      type: 'item',
      icon: Trash2,
      label: 'Delete Worktree',
      danger: true,
      disabled: true,
      title: "Primary worktree — can't be deleted. Remove the project instead."
    })
    items.push({ type: 'item', icon: Trash2, label: 'Remove Project from Tessel', danger: true, onSelect: () => emit('remove', card.projectId) })
  } else {
    items.push({
      type: 'item',
      icon: Trash2,
      label: 'Delete',
      danger: true,
      disabled: !card.taskId,
      title: card.taskId ? '' : 'Only a task copy can be deleted here',
      onSelect: () => emit('delete-task', card.taskId)
    })
  }
  return items
}

function rowMenuItems(row, card) {
  const wsId = card.projectId
  const items = [{ type: 'label', label: row.num ? `#${row.num} ${row.title}` : row.title }]
  items.push({ type: 'item', icon: SquareTerminal, label: 'Go to Pane', onSelect: () => focusRow(row.id) })
  if (row.kind === 'agent') {
    items.push({ type: 'separator' })
    const team = row.team ? teamById(row.team) : null
    if (team) {
      const members = projectPanes(wsId).filter((p) => p.kind === 'agent' && p.team === team.id)
      items.push({ type: 'label', label: team.name })
      items.push({ type: 'item', icon: MessageSquare, label: 'Message the Team…', onSelect: () => startMessage('team:' + team.id, wsId) })
      items.push({
        type: 'item',
        icon: Users,
        label: 'Add Agents…',
        disabled: !pickableCount(wsId),
        onSelect: () => startPicking(wsId, team.id)
      })
      items.push({ type: 'item', icon: Activity, label: 'Team Activity', onSelect: () => emit('activity', 'team:' + team.id) })
      if (team.leadId === row.id) items.push({ type: 'item', icon: Crown, label: 'No Lead', onSelect: () => emit('set-lead', team.id, null) })
      else
        items.push({
          type: 'item',
          icon: Crown,
          label: 'Make Lead',
          title: 'The lead gives tasks to the team and reviews them before you merge',
          onSelect: () => emit('set-lead', team.id, row.id)
        })
      items.push({ type: 'item', icon: LogOut, label: 'Leave Team', onSelect: () => emit('leave-team', row.id) })
      items.push({ type: 'item', icon: Pencil, label: 'Rename Team…', onSelect: () => startTeamRename(team, wsId) })
      items.push({
        type: 'item',
        icon: Trash2,
        label: 'Ungroup Team',
        danger: true,
        disabled: members.length === 0,
        onSelect: () => emit('disband-team', team.id)
      })
    } else {
      const wsTeams = props.teams.filter((t) => projectPanes(wsId).some((p) => p.team === t.id))
      items.push({
        type: 'item',
        icon: Users,
        label: 'New Team…',
        disabled: pickableCount(wsId) < 2,
        title: pickableCount(wsId) < 2 ? 'A team needs at least two agents that are in no team yet' : '',
        onSelect: () => startPicking(wsId, 'new', row.id)
      })
      if (wsTeams.length) {
        items.push({
          type: 'sub',
          icon: Users,
          label: 'Add to Team',
          children: wsTeams.map((t) => ({ type: 'item', label: t.name, onSelect: () => emit('add-to-team', t.id, [row.id]) }))
        })
      }
    }
    items.push({ type: 'separator' })
    items.push({
      type: 'item',
      icon: Moon,
      label: 'Sleep',
      disabled: row.sleeping,
      title: 'Stop its terminal to free memory; opening the pane resumes the conversation.',
      onSelect: () => emit('sleep', [row.id])
    })
  }
  return items
}

function openOptions(e) {
  optionsOpen.value = optionsOpen.value ? null : rectOf(e)
}
function openProjectActions(project, e) {
  openMenu('project', rectOf(e), projectActionItems(project), { align: 'end', label: `Project actions for ${project.name}` })
}
function openCardMenu(card, e) {
  openMenu('card', { x: e.clientX, y: e.clientY }, cardMenuItems(card), { offset: 0, width: 208, label: 'Workspace' })
}
function openRowMenu(row, card, e) {
  openMenu('row', { x: e.clientX, y: e.clientY }, rowMenuItems(row, card), { offset: 0, width: 224, label: row.title })
}

function portsOf(card) {
  return props.ports[card.key] || []
}

function onDocKey(e) {
  if (e.key === 'Escape' && picking.value) cancelPicking()
}
onMounted(() => window.addEventListener('keydown', onDocKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onDocKey))

// Collapsed rail: each project with its busy / needs-you dot.
const railItems = computed(() =>
  props.projects.map((p) => {
    const agents = (p.panes || []).filter((x) => x.kind === 'agent' && !x.sleeping)
    return {
      id: p.id,
      name: p.name,
      needsYou: agents.some((x) => x.state === 'approval' || x.attention),
      busy: agents.some((x) => x.state === 'working')
    }
  })
)

defineExpose({
  startRename: (id) => {
    const p = props.projects.find((i) => i.id === id)
    if (p) startRename(p)
  },
  startMessage: (wsId) => {
    if (messagingId.value !== wsId) startMessage(wsId, wsId)
  }
})
</script>

<template>
  <nav
    ref="navEl"
    class="osb"
    :class="{ collapsed, resizing }"
    :style="sidebarStyle"
    aria-label="Workspaces"
    data-worktree-sidebar=""
  >
    <template v-if="!collapsed">
      <!-- SidebarNav: search. -->
      <div class="osb-nav">
        <button type="button" class="osb-search" aria-label="Search worktrees and browser tabs" @click="emit('search')">
          <Search class="osb-search-icon" :size="16" :stroke-width="1.75" aria-hidden="true" />
          <span class="osb-search-label">Search</span>
          <span class="osb-search-keys" aria-hidden="true">
            <kbd v-for="k in paletteShortcut.split('+')" :key="k">{{ k }}</kbd>
          </span>
        </button>
      </div>

      <!-- SidebarHeader: section title and actions. -->
      <div class="osb-header">
        <span class="osb-header-title" :data-sidebar-section-title="grouped ? 'projects' : 'workspaces'">{{
          grouped ? 'Projects' : 'Workspaces'
        }}</span>
        <div class="osb-header-actions" data-sidebar-header-actions="">
          <button type="button" class="osb-icon-btn" aria-label="View activity" title="View activity" @click="emit('activity', 'workspace')">
            <Bell :size="14" :stroke-width="2.25" aria-hidden="true" />
          </button>
          <button
            type="button"
            class="osb-icon-btn osb-options-btn"
            :class="{ on: !!optionsOpen }"
            :aria-label="filterBadge.count ? `Workspace options (${filterBadge.label} active)` : 'Workspace options'"
            :title="filterBadge.count ? `Workspace options (${filterBadge.label})` : 'Workspace options'"
            aria-haspopup="menu"
            @click="openOptions"
          >
            <SlidersHorizontal :size="14" :stroke-width="2.25" aria-hidden="true" />
            <span v-if="filterBadge.count" class="osb-filter-badge" aria-hidden="true">{{
              filterBadge.count > 9 ? '9+' : filterBadge.count
            }}</span>
          </button>
          <button type="button" class="osb-icon-btn" aria-label="Add project" title="Add project" @click="emit('create')">
            <FolderPlus :size="14" :stroke-width="2.25" aria-hidden="true" />
          </button>
          <button type="button" class="osb-icon-btn" aria-label="New workspace" title="New workspace" @click="emit('new-task')">
            <Plus :size="14" :stroke-width="2.25" aria-hidden="true" />
          </button>
          <button type="button" class="osb-icon-btn" aria-label="Collapse sidebar" title="Collapse sidebar" @click="emit('toggle')">
            <PanelLeft :size="14" :stroke-width="2" aria-hidden="true" />
          </button>
        </div>
      </div>

      <!-- WorktreeList -->
      <div
        ref="listEl"
        class="osb-list"
        role="listbox"
        aria-label="Workspaces"
        tabindex="0"
        @keydown="onListKey"
      >
        <template v-for="r in rows" :key="r.key">
          <div v-if="r.type === 'header'" class="osb-group" :class="{ first: r === rows[0] }">
            <div
              class="osb-section-header"
              :class="{ current: r.project && r.project.id === currentId, flat: !r.project }"
              role="button"
              tabindex="0"
              :aria-expanded="r.count > 0 ? !r.collapsed : undefined"
              :data-repo-header-id="r.project ? r.project.id : undefined"
              :data-ws-drop-id="r.project ? r.project.id : undefined"
              @click="toggleGroup(r.key)"
              @keydown.enter.prevent="toggleGroup(r.key)"
              @keydown.space.prevent="toggleGroup(r.key)"
              @contextmenu.prevent="r.project && openProjectActions(r.project, $event)"
            >
              <div class="osb-section-title">
                <span v-if="r.project" class="osb-section-icon">
                  <Folder :size="14" aria-hidden="true" />
                </span>
                <input
                  v-if="r.project && editingId === r.project.id"
                  :ref="(el) => (inputEls[r.project.id] = el)"
                  v-model="draft"
                  class="osb-rename"
                  aria-label="Rename project"
                  @click.stop
                  @dblclick.stop
                  @keydown.stop
                  @blur="commitRename"
                  @keydown.enter.prevent.stop="commitRename"
                  @keydown.escape.prevent.stop="editingId = null"
                />
                <span
                  v-else
                  class="osb-section-label"
                  :title="r.project ? (r.project.cwd ? `${r.project.name}\n${r.project.cwd}\nDouble-click to rename` : `${r.project.name}\nDouble-click to rename`) : ''"
                  @dblclick.stop="r.project && startRename(r.project)"
                  >{{ r.label }}</span
                >
              </div>
              <div class="osb-section-actions" data-repo-header-actions="" @click.stop>
                <button
                  v-if="r.count > 0"
                  type="button"
                  class="osb-collapse"
                  :aria-label="r.collapsed ? `Expand ${r.label}` : `Collapse ${r.label}`"
                  @click.stop="toggleGroup(r.key)"
                >
                  <ChevronDown :size="14" :class="{ collapsed: r.collapsed }" aria-hidden="true" />
                </button>
                <template v-if="r.project">
                  <button
                    type="button"
                    class="osb-header-action"
                    :aria-label="`Project actions for ${r.label}`"
                    title="Project actions"
                    aria-haspopup="menu"
                    @click.stop="openProjectActions(r.project, $event)"
                  >
                    <Ellipsis :size="14" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    class="osb-header-action"
                    :aria-label="`Create workspace for ${r.label}`"
                    :title="`Create workspace for ${r.label}`"
                    @click.stop="emit('select', r.project.id), emit('new-task')"
                  >
                    <Plus :size="12" aria-hidden="true" />
                  </button>
                </template>
              </div>
            </div>

            <!-- Message box / team picking / team rename, under its project. -->
            <div v-if="r.project && messagingId && messagingWs === r.project.id" class="osb-inline-box">
              <textarea
                :ref="(el) => el && (messageEl = el)"
                v-model="messageDraft"
                rows="3"
                :placeholder="
                  messagingId.startsWith('team:')
                    ? `Message every agent of ${teamName(messagingId.slice(5))}… (Enter to send, Shift+Enter for a new line)`
                    : 'Message every agent of this workspace… (Enter to send, Shift+Enter for a new line)'
                "
                @keydown.enter.exact.prevent="sendMessage"
                @keydown.escape.prevent.stop="messagingId = null"
              ></textarea>
              <div class="osb-inline-actions">
                <button type="button" class="osb-btn" @click="messagingId = null">Cancel</button>
                <button type="button" class="osb-btn primary" :disabled="!messageDraft.trim()" @click="sendMessage">Send</button>
              </div>
            </div>
            <div v-if="r.project && editingTeam && editingTeam.wsId === r.project.id" class="osb-inline-box">
              <input
                :ref="(el) => el && (teamInputEl = el)"
                v-model="teamDraft"
                class="osb-rename wide"
                maxlength="40"
                aria-label="Team name"
                @blur="commitTeamRename"
                @keydown.enter.prevent.stop="commitTeamRename"
                @keydown.escape.prevent.stop="editingTeam = null"
              />
            </div>
            <div v-if="r.project && picking && picking.wsId === r.project.id" class="osb-inline-box osb-pick-bar">
              <span>{{
                picked.length
                  ? `${picked.length} selected`
                  : pickableCount(r.project.id)
                    ? pickTeam
                      ? `Tick the agents to add to ${pickTeam.name}`
                      : 'Tick at least two agents that work together'
                    : 'Every agent here is already in a team. Use Leave Team in an agent’s menu to free it.'
              }}</span>
              <div class="osb-inline-actions">
                <button type="button" class="osb-btn" @click="cancelPicking">Cancel</button>
                <button
                  type="button"
                  class="osb-btn primary"
                  :disabled="pickTeam ? !picked.length : picked.length < 2"
                  @click="groupPicked"
                >
                  {{ pickTeam ? `Add to ${pickTeam.name}` : 'Group as a team' }}
                </button>
              </div>
            </div>
          </div>

          <WorktreeCard
            v-else
            :card="r.card"
            :grouped="grouped"
            :compact-cards="settings.compactWorktreeCards"
            :show-ports="showPorts"
            :show-agents="showAgents"
            :agent-mode="settings.agentActivityDisplayMode"
            :expanded="isExpanded(r.card)"
            :ports="portsOf(r.card)"
            :project-name="projectNames[r.card.projectId] || ''"
            :show-project-badge="!grouped && !settings.compactWorktreeCards"
            :picking="pickingFor(r.card.projectId)"
            :team-name="teamName"
            @activate="activateCard"
            @context="openCardMenu"
            @toggle-expanded="toggleExpanded"
            @focus-pane="focusRow"
            @row-context="openRowMenu"
            @toggle-read="toggleRead"
            @pick="onPick"
            @port-open="emit('port-open', $event)"
            @port-copy="emit('port-copy', $event)"
            @port-stop="emit('port-stop', $event)"
          />
        </template>
        <div v-if="!rows.some((x) => x.type === 'card') && projects.length" class="osb-empty">
          No workspaces match these filters.
        </div>
      </div>
    </template>

    <!-- Collapsed: one badge per project. -->
    <template v-else>
      <div class="osb-rail">
        <button type="button" class="osb-icon-btn" aria-label="Expand sidebar" title="Expand sidebar" @click="emit('toggle')">
          <PanelLeft :size="14" :stroke-width="2" aria-hidden="true" />
        </button>
        <button
          v-for="p in railItems"
          :key="p.id"
          type="button"
          class="osb-rail-item"
          :class="{ current: p.id === currentId }"
          :title="p.name"
          :aria-label="p.name"
          @click="emit('select', p.id)"
        >
          {{ initials(p.name) }}
          <span v-if="p.needsYou" class="osb-rail-dot attention" title="An agent is waiting for you"></span>
          <span v-else-if="p.busy" class="osb-rail-dot" title="An agent is working"></span>
        </button>
        <button type="button" class="osb-icon-btn" aria-label="Add project" title="Add project" @click="emit('create')">
          <FolderPlus :size="14" :stroke-width="2.25" aria-hidden="true" />
        </button>
      </div>
    </template>

    <OrcaMenu
      :open="!!optionsOpen"
      :anchor="optionsOpen"
      side="right"
      :offset="8"
      :width="288"
      :items="optionsMenuItems"
      label="Workspace options"
      @close="optionsOpen = null"
    />
    <OrcaMenu
      :open="!!menu"
      :anchor="menu && menu.anchor"
      :side="menu ? menu.side : 'bottom'"
      :align="menu ? menu.align : 'start'"
      :offset="menu && menu.offset !== undefined ? menu.offset : 6"
      :width="menu && menu.width"
      :items="menu ? menu.items : []"
      :label="menu ? menu.label || 'Menu' : 'Menu'"
      @close="closeMenu"
    />

    <div class="osb-resize" title="Drag to resize. Double-click to reset." @pointerdown="startResize">
      <div class="osb-resize-line"></div>
    </div>
  </nav>
</template>
