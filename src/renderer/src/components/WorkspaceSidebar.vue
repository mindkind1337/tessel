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
import { buildSidebarRows, neighborCard, cardTargetPane, isAgentPane } from '../sidebarModel'
import { t } from '../i18n'

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
    bg = `color-mix(in srgb, ${settings.leftSidebarTintColor} ${pct}%, var(--surface))` // i18n-ignore
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
  return props.teams.find((team) => team.id === id) || null
}
function teamName(id) {
  return teamById(id)?.name || t('sidebar.team.aTeam', 'a team')
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
  if (row.kind !== 'agent') return t('sidebar.team.noTerminals', 'Terminals cannot be in a team')
  if (row.team) return t('sidebar.team.alreadyIn', 'Already in {{team}}. To move it, use Leave Team in its menu first.', { team: teamName(row.team) })
  return t('sidebar.team.tickToAdd', 'Tick to put it in the team')
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
  return projectPanes(wsId).filter((p) => isAgentPane(p) && !p.team).length
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

function sortOptions() {
  return [
    { id: 'name', label: t('sidebar.options.sortName', 'Name') },
    {
      id: 'smart',
      label: t('sidebar.options.sortSmart', 'Agent Activity'),
      description: t('sidebar.options.sortSmartHint', 'Agents that need attention, then most recent activity.')
    },
    { id: 'recent', label: t('sidebar.options.recent', 'Recent') },
    { id: 'repo', label: t('sidebar.options.project', 'Project') },
    {
      id: 'manual',
      label: t('sidebar.options.manual', 'Manual'),
      description: t('sidebar.options.sortManualHint', 'The project folder first, then each task copy as it was made.')
    }
  ]
}
function projectOrderOptions() {
  return [
    {
      id: 'manual',
      label: t('sidebar.options.manual', 'Manual'),
      description: t('sidebar.options.orderManualHint', 'Drag projects to arrange them')
    },
    {
      id: 'recent',
      label: t('sidebar.options.recent', 'Recent'),
      description: t('sidebar.options.orderRecentHint', 'Most recent workspace activity')
    }
  ]
}

// Orca's useWorkspaceOptionsFilterBadge.
const filterBadge = computed(() => {
  const selected = props.projects.filter((p) => settings.sidebarFilterRepoIds.includes(p.id)).length
  const sleeping = settings.showSleepingWorkspaces !== true
  const exemption = !settings.showSleepingWorkspaces && !settings.alwaysShowDefaultBranchWorkspace
  const count = (sleeping ? 1 : 0) + (settings.hideDefaultBranchWorkspace ? 1 : 0) + (exemption ? 1 : 0) + selected
  return {
    count,
    label:
      count === 1
        ? t('sidebar.options.filterCount', '{{count}} filter', { count })
        : t('sidebar.options.filterCount', '{{count}} filters', { count })
  }
})

function projectFilterLabel() {
  const sel = props.projects.filter((p) => settings.sidebarFilterRepoIds.includes(p.id))
  if (!sel.length) return t('sidebar.options.allProjects', 'All projects')
  if (sel.length === 1) return sel[0].name
  return t('sidebar.options.projectCount', '{{count}} projects', { count: sel.length })
}

function optionsItems() {
  const items = [{ type: 'label', label: t('sidebar.options.title', 'Workspace options'), className: 'orca-menu-title' }]
  if (props.projects.length > 1) {
    const filter = settings.sidebarFilterRepoIds
    items.push({ type: 'label', label: t('sidebar.options.show', 'Show') })
    items.push({
      type: 'sub',
      label: t('sidebar.options.projects', 'Projects'),
      hint: projectFilterLabel(),
      width: 256,
      children: [
        {
          type: 'item',
          label: t('sidebar.options.clear', 'Clear'),
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
  items.push({ type: 'label', label: t('sidebar.options.groupBy', 'Group by') })
  items.push({
    type: 'segmented',
    label: t('sidebar.options.groupBy', 'Group by'),
    value: settings.sidebarGroupBy,
    options: [
      { id: 'none', label: t('sidebar.options.groupNone', 'None') },
      { id: 'repo', label: t('sidebar.options.project', 'Project') }
    ],
    onChange: (v) => (settings.sidebarGroupBy = v)
  })
  items.push({ type: 'separator' })
  items.push({
    type: 'sub',
    label: t('sidebar.options.sortBy', 'Sort by'),
    hint: sortOptions().find((o) => o.id === settings.sidebarSortBy)?.label || t('sidebar.options.sort', 'Sort'),
    width: 176,
    children: sortOptions().map((o) => ({
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
      label: t('sidebar.options.projectOrder', 'Project order'),
      hint:
        projectOrderOptions().find((o) => o.id === settings.sidebarProjectOrderBy)?.label ||
        t('sidebar.options.manual', 'Manual'),
      width: 176,
      children: projectOrderOptions().map((o) => ({
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
    label: t('sidebar.options.cardLayout', 'Card layout'),
    hint: settings.compactWorktreeCards ? t('sidebar.options.compact', 'Compact') : t('sidebar.options.detailed', 'Detailed'),
    width: 176,
    children: [
      { id: false, label: t('sidebar.options.detailed', 'Detailed') },
      { id: true, label: t('sidebar.options.compact', 'Compact') }
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
    label: t('sidebar.options.showProperties', 'Show properties'),
    hint: settings.compactWorktreeCards ? t('sidebar.options.hover', 'Hover') : props_.length ? String(props_.length) : '',
    width: 192,
    children: [
      {
        type: 'checkbox',
        label: t('sidebar.options.ports', 'Ports'),
        checked: props_.includes('ports'),
        onSelect: () => toggleProp('ports')
      },
      {
        type: 'checkbox',
        label: t('sidebar.options.agentActivity', 'Agent activity'),
        checked: props_.includes('inline-agents'),
        onSelect: () => toggleProp('inline-agents')
      },
      { type: 'separator' },
      { type: 'label', label: t('sidebar.options.agentActivityLayout', 'Agent activity layout') },
      ...[
        { id: 'compact', label: t('sidebar.options.compact', 'Compact') },
        { id: 'full', label: t('sidebar.options.fullList', 'Full list') }
      ].map((o) => ({
        type: 'radio',
        label: o.label,
        checked: settings.agentActivityDisplayMode === o.id,
        onSelect: () => (settings.agentActivityDisplayMode = o.id)
      }))
    ]
  })
  items.push({ type: 'separator' })
  items.push({ type: 'label', label: t('sidebar.options.filters', 'Filters') })
  items.push({
    type: 'switch',
    icon: Moon,
    label: t('sidebar.options.hideSleeping', 'Hide sleeping'),
    checked: !settings.showSleepingWorkspaces,
    onChange: (hide) => (settings.showSleepingWorkspaces = !hide)
  })
  if (!settings.showSleepingWorkspaces) {
    items.push({
      type: 'switch',
      icon: GitBranch,
      indented: true,
      label: t('sidebar.options.exceptDefault', 'Except default branch'),
      ariaLabel: t('sidebar.options.exceptDefaultHint', 'Keep the default branch visible while hiding sleeping workspaces'),
      checked: settings.alwaysShowDefaultBranchWorkspace,
      onChange: (v) => (settings.alwaysShowDefaultBranchWorkspace = v)
    })
  }
  items.push({
    type: 'switch',
    icon: GitBranch,
    label: t('sidebar.options.hideDefault', 'Hide default branch'),
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
    { type: 'item', icon: Pencil, label: t('sidebar.project.rename', 'Rename'), onSelect: () => startRename(project) },
    {
      type: 'item',
      icon: FolderOpen,
      label: project.cwd
        ? t('sidebar.project.changeFolder', 'Change Project Folder…')
        : t('sidebar.project.setFolder', 'Set Project Folder…'),
      title: project.cwd
        ? t('sidebar.project.folder', 'Project folder: {{path}}', { path: project.cwd })
        : t('sidebar.project.folderHint', 'New panes start in the project folder'),
      onSelect: () => emit('folder', wsId)
    },
    { type: 'separator' },
    {
      type: 'item',
      icon: ListPlus,
      label: t('sidebar.project.newTask', 'New Task…'),
      onSelect: () => {
        emit('select', wsId)
        emit('new-task')
      }
    },
    {
      type: 'item',
      icon: MessageSquare,
      label: t('sidebar.project.messageAll', 'Message All Agents…'),
      disabled: !projectPanes(wsId).some((p) => isAgentPane(p)),
      onSelect: () => startMessage(wsId, wsId)
    },
    {
      type: 'item',
      icon: Users,
      label: t('sidebar.team.new', 'New Team…'),
      disabled: pickableCount(wsId) < 2,
      title: pickableCount(wsId) < 2 ? t('sidebar.team.needsTwo', 'A team needs at least two agents that are in no team yet') : '',
      onSelect: () => startPicking(wsId, 'new')
    },
    { type: 'item', icon: StickyNote, label: t('sidebar.project.notes', 'Project Notes'), onSelect: () => emit('notes-ws', wsId) },
    {
      type: 'item',
      icon: Activity,
      label: t('sidebar.project.activity', 'Activity'),
      onSelect: () => {
        emit('select', wsId)
        emit('activity', 'workspace')
      }
    },
    { type: 'separator' },
    { type: 'item', icon: Trash2, label: t('sidebar.project.remove', 'Remove Project'), danger: true, onSelect: () => emit('remove', wsId) }
  ]
}

function cardMenuItems(card) {
  const items = [{ type: 'label', label: t('sidebar.card.workspace', 'Workspace') }]
  if (card.path) {
    items.push({ type: 'item', icon: FolderOpen, label: t('sidebar.card.openInExplorer', 'Open in File Explorer'), onSelect: () => emit('reveal', card.path) })
    items.push({ type: 'item', icon: Copy, label: t('sidebar.card.copyPath', 'Copy Path'), onSelect: () => emit('copy', card.path, 'path') })
  }
  items.push({
    type: 'item',
    icon: Copy,
    label: t('sidebar.card.copyName', 'Copy Worktree Name'),
    onSelect: () => emit('copy', card.branch || card.title, 'name')
  })
  items.push({ type: 'separator' })
  items.push({
    type: 'item',
    icon: card.isUnread ? BellOff : Bell,
    label: card.isUnread ? t('sidebar.card.menuMarkRead', 'Mark Read') : t('sidebar.card.menuMarkUnread', 'Mark Unread'),
    disabled: !card.panes.length,
    onSelect: () => toggleRead(card)
  })
  if (card.taskId) {
    items.push({ type: 'item', icon: GitCompare, label: t('sidebar.card.review', 'Review Changes…'), onSelect: () => emit('review-task', card.taskId) })
  }
  items.push({ type: 'separator' })
  // A chat agent has no terminal to stop (it stops by itself when idle).
  const sleepable = card.panes.filter((r) => r.kind === 'agent' && !r.chat && !r.sleeping).map((r) => r.id)
  items.push({
    type: 'item',
    icon: Moon,
    label: t('sidebar.card.sleep', 'Sleep'),
    title: t('sidebar.card.sleepHint', 'Close all active panels in this workspace to free up memory and CPU.'),
    disabled: !sleepable.length,
    onSelect: () => emit('sleep', sleepable)
  })
  if (card.isMain) {
    items.push({
      type: 'item',
      icon: Trash2,
      label: t('sidebar.card.deleteWorktree', 'Delete Worktree'),
      danger: true,
      disabled: true,
      title: t('sidebar.card.deletePrimaryHint', "Primary worktree — can't be deleted. Remove the project instead.")
    })
    items.push({
      type: 'item',
      icon: Trash2,
      label: t('sidebar.card.removeProject', 'Remove Project from Tessel'),
      danger: true,
      onSelect: () => emit('remove', card.projectId)
    })
  } else {
    items.push({
      type: 'item',
      icon: Trash2,
      label: t('sidebar.card.delete', 'Delete'),
      danger: true,
      disabled: !card.taskId,
      title: card.taskId ? '' : t('sidebar.card.deleteHint', 'Only a task copy can be deleted here'),
      onSelect: () => emit('delete-task', card.taskId)
    })
  }
  return items
}

function rowMenuItems(row, card) {
  const wsId = card.projectId
  const items = [{ type: 'label', label: row.num ? `#${row.num} ${row.title}` : row.title }]
  items.push({ type: 'item', icon: SquareTerminal, label: t('sidebar.row.goToPane', 'Go to Pane'), onSelect: () => focusRow(row.id) })
  if (row.kind === 'agent') {
    items.push({ type: 'separator' })
    const team = row.team ? teamById(row.team) : null
    if (team) {
      const members = projectPanes(wsId).filter((p) => isAgentPane(p) && p.team === team.id)
      items.push({ type: 'label', label: team.name })
      items.push({
        type: 'item',
        icon: MessageSquare,
        label: t('sidebar.team.message', 'Message the Team…'),
        onSelect: () => startMessage('team:' + team.id, wsId)
      })
      items.push({
        type: 'item',
        icon: Users,
        label: t('sidebar.team.addAgents', 'Add Agents…'),
        disabled: !pickableCount(wsId),
        onSelect: () => startPicking(wsId, team.id)
      })
      items.push({ type: 'item', icon: Activity, label: t('sidebar.team.activity', 'Team Activity'), onSelect: () => emit('activity', 'team:' + team.id) })
      if (team.leadId === row.id)
        items.push({ type: 'item', icon: Crown, label: t('sidebar.team.noLead', 'No Lead'), onSelect: () => emit('set-lead', team.id, null) })
      else
        items.push({
          type: 'item',
          icon: Crown,
          label: t('sidebar.team.makeLead', 'Make Lead'),
          title: t('sidebar.team.makeLeadHint', 'The lead gives tasks to the team and reviews them before you merge'),
          onSelect: () => emit('set-lead', team.id, row.id)
        })
      items.push({ type: 'item', icon: LogOut, label: t('sidebar.team.leave', 'Leave Team'), onSelect: () => emit('leave-team', row.id) })
      items.push({ type: 'item', icon: Pencil, label: t('sidebar.team.rename', 'Rename Team…'), onSelect: () => startTeamRename(team, wsId) })
      items.push({
        type: 'item',
        icon: Trash2,
        label: t('sidebar.team.ungroup', 'Ungroup Team'),
        danger: true,
        disabled: members.length === 0,
        onSelect: () => emit('disband-team', team.id)
      })
    } else {
      const wsTeams = props.teams.filter((tm) => projectPanes(wsId).some((p) => p.team === tm.id))
      items.push({
        type: 'item',
        icon: Users,
        label: t('sidebar.team.new', 'New Team…'),
        disabled: pickableCount(wsId) < 2,
        title: pickableCount(wsId) < 2 ? t('sidebar.team.needsTwo', 'A team needs at least two agents that are in no team yet') : '',
        onSelect: () => startPicking(wsId, 'new', row.id)
      })
      if (wsTeams.length) {
        items.push({
          type: 'sub',
          icon: Users,
          label: t('sidebar.team.addTo', 'Add to Team'),
          children: wsTeams.map((tm) => ({ type: 'item', label: tm.name, onSelect: () => emit('add-to-team', tm.id, [row.id]) }))
        })
      }
    }
    if (!row.chat) items.push({ type: 'separator' })
    if (!row.chat) items.push({
      type: 'item',
      icon: Moon,
      label: t('sidebar.card.sleep', 'Sleep'),
      disabled: row.sleeping,
      title: t('sidebar.row.sleepHint', 'Stop its terminal to free memory; opening the pane resumes the conversation.'),
      onSelect: () => emit('sleep', [row.id])
    })
  }
  return items
}

function openOptions(e) {
  optionsOpen.value = optionsOpen.value ? null : rectOf(e)
}
function openProjectActions(project, e) {
  openMenu('project', rectOf(e), projectActionItems(project), {
    align: 'end',
    label: t('sidebar.project.actionsFor', 'Project actions for {{name}}', { name: project.name })
  })
}
function openCardMenu(card, e) {
  openMenu('card', { x: e.clientX, y: e.clientY }, cardMenuItems(card), {
    offset: 0,
    width: 208,
    label: t('sidebar.card.workspace', 'Workspace')
  })
}
function openRowMenu(row, card, e) {
  openMenu('row', { x: e.clientX, y: e.clientY }, rowMenuItems(row, card), { offset: 0, width: 224, label: row.title })
}

function portsOf(card) {
  return props.ports[card.key] || []
}

function wsOptionsLabel(active) {
  const badge = filterBadge.value
  if (!badge.count) return t('sidebar.options.title', 'Workspace options')
  return active
    ? t('sidebar.options.titleActive', 'Workspace options ({{filters}} active)', { filters: badge.label })
    : t('sidebar.options.titleFilters', 'Workspace options ({{filters}})', { filters: badge.label })
}
function sectionTitle(project) {
  if (!project) return ''
  // A project on a remote host (Add a project): its host and folder there.
  if (project.remote)
    return t('project.sidebar.titleRemote', '{{name}}\n{{host}}:{{path}}\nDouble-click to rename', {
      name: project.name,
      host: project.remote.host,
      path: project.remote.path
    })
  if (project.repoCount && project.cwd)
    return t('project.sidebar.titleGroup', '{{name}}\n{{path}}\nGroup of {{count}} repositories\nDouble-click to rename', {
      name: project.name,
      path: project.cwd,
      count: project.repoCount
    })
  return project.cwd
    ? t('sidebar.project.titleWithFolder', '{{name}}\n{{path}}\nDouble-click to rename', { name: project.name, path: project.cwd })
    : t('sidebar.project.titleNoFolder', '{{name}}\nDouble-click to rename', { name: project.name })
}
function pickHint(wsId) {
  if (picked.value.length) return t('sidebar.team.selected', '{{count}} selected', { count: picked.value.length })
  if (!pickableCount(wsId)) return t('sidebar.team.allInTeams', 'Every agent here is already in a team. Use Leave Team in an agent’s menu to free it.')
  return pickTeam.value
    ? t('sidebar.team.tickToAddTo', 'Tick the agents to add to {{team}}', { team: pickTeam.value.name })
    : t('sidebar.team.tickTwo', 'Tick at least two agents that work together')
}
function messagePlaceholder() {
  return messagingId.value && messagingId.value.startsWith('team:')
    ? t('sidebar.message.teamPlaceholder', 'Message every agent of {{team}}… (Enter to send, Shift+Enter for a new line)', { team: teamName(messagingId.value.slice(5)) })
    : t('sidebar.message.workspacePlaceholder', 'Message every agent of this workspace… (Enter to send, Shift+Enter for a new line)')
}

function onDocKey(e) {
  if (e.key === 'Escape' && picking.value) cancelPicking()
}
onMounted(() => window.addEventListener('keydown', onDocKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onDocKey))

// Collapsed rail: each project with its busy / needs-you dot.
const railItems = computed(() =>
  props.projects.map((p) => {
    const agents = (p.panes || []).filter((x) => isAgentPane(x) && !x.sleeping)
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
    :aria-label="t('sidebar.workspaces', 'Workspaces')"
    data-worktree-sidebar=""
  >
    <template v-if="!collapsed">
      <!-- SidebarNav: search. -->
      <div class="osb-nav">
        <button type="button" class="osb-search" :aria-label="t('sidebar.searchLabel', 'Search worktrees and browser tabs')" @click="emit('search')">
          <Search class="osb-search-icon" :size="16" :stroke-width="1.75" aria-hidden="true" />
          <span class="osb-search-label">{{ t('sidebar.search', 'Search') }}</span>
          <span class="osb-search-keys" aria-hidden="true">
            <kbd v-for="k in paletteShortcut.split('+')" :key="k">{{ k }}</kbd>
          </span>
        </button>
      </div>

      <!-- SidebarHeader: section title and actions. -->
      <div class="osb-header">
        <span class="osb-header-title" :data-sidebar-section-title="grouped ? 'projects' : 'workspaces'">{{
          grouped ? t('sidebar.projects', 'Projects') : t('sidebar.workspaces', 'Workspaces')
        }}</span>
        <div class="osb-header-actions" data-sidebar-header-actions="">
          <button
            type="button"
            class="osb-icon-btn"
            :aria-label="t('sidebar.viewActivity', 'View activity')"
            :title="t('sidebar.viewActivity', 'View activity')"
            @click="emit('activity', 'workspace')"
          >
            <Bell :size="14" :stroke-width="2.25" aria-hidden="true" />
          </button>
          <button
            type="button"
            class="osb-icon-btn osb-options-btn"
            :class="{ on: !!optionsOpen }"
            :aria-label="wsOptionsLabel(true)"
            :title="wsOptionsLabel(false)"
            aria-haspopup="menu"
            @click="openOptions"
          >
            <SlidersHorizontal :size="14" :stroke-width="2.25" aria-hidden="true" />
            <span v-if="filterBadge.count" class="osb-filter-badge" aria-hidden="true">{{
              filterBadge.count > 9 ? '9+' : filterBadge.count
            }}</span>
          </button>
          <button
            type="button"
            class="osb-icon-btn"
            :aria-label="t('sidebar.addProject', 'Add project')"
            :title="t('sidebar.addProject', 'Add project')"
            @click="emit('create')"
          >
            <FolderPlus :size="14" :stroke-width="2.25" aria-hidden="true" />
          </button>
          <button
            type="button"
            class="osb-icon-btn"
            :aria-label="t('sidebar.newWorkspace', 'New workspace')"
            :title="t('sidebar.newWorkspace', 'New workspace')"
            @click="emit('new-task')"
          >
            <Plus :size="14" :stroke-width="2.25" aria-hidden="true" />
          </button>
          <button
            type="button"
            class="osb-icon-btn"
            :aria-label="t('sidebar.collapse', 'Collapse sidebar')"
            :title="t('sidebar.collapse', 'Collapse sidebar')"
            @click="emit('toggle')"
          >
            <PanelLeft :size="14" :stroke-width="2" aria-hidden="true" />
          </button>
        </div>
      </div>

      <!-- WorktreeList -->
      <div
        ref="listEl"
        class="osb-list"
        role="listbox"
        :aria-label="t('sidebar.workspaces', 'Workspaces')"
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
                  :aria-label="t('sidebar.project.renameLabel', 'Rename project')"
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
                  :title="sectionTitle(r.project)"
                  @dblclick.stop="r.project && startRename(r.project)"
                  >{{ r.label }}</span
                >
              </div>
              <div class="osb-section-actions" data-repo-header-actions="" @click.stop>
                <button
                  v-if="r.count > 0"
                  type="button"
                  class="osb-collapse"
                  :aria-label="r.collapsed ? t('sidebar.expandGroup', 'Expand {{name}}', { name: r.label }) : t('sidebar.collapseGroup', 'Collapse {{name}}', { name: r.label })"
                  @click.stop="toggleGroup(r.key)"
                >
                  <ChevronDown :size="14" :class="{ collapsed: r.collapsed }" aria-hidden="true" />
                </button>
                <template v-if="r.project">
                  <button
                    type="button"
                    class="osb-header-action"
                    :aria-label="t('sidebar.project.actionsFor', 'Project actions for {{name}}', { name: r.label })"
                    :title="t('sidebar.project.actions', 'Project actions')"
                    aria-haspopup="menu"
                    @click.stop="openProjectActions(r.project, $event)"
                  >
                    <Ellipsis :size="14" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    class="osb-header-action"
                    :aria-label="t('sidebar.project.createWorkspace', 'Create workspace for {{name}}', { name: r.label })"
                    :title="t('sidebar.project.createWorkspace', 'Create workspace for {{name}}', { name: r.label })"
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
                :placeholder="messagePlaceholder()"
                @keydown.enter.exact.prevent="sendMessage"
                @keydown.escape.prevent.stop="messagingId = null"
              ></textarea>
              <div class="osb-inline-actions">
                <button type="button" class="osb-btn" @click="messagingId = null">{{ t('sidebar.cancel', 'Cancel') }}</button>
                <button type="button" class="osb-btn primary" :disabled="!messageDraft.trim()" @click="sendMessage">
                  {{ t('sidebar.message.send', 'Send') }}
                </button>
              </div>
            </div>
            <div v-if="r.project && editingTeam && editingTeam.wsId === r.project.id" class="osb-inline-box">
              <input
                :ref="(el) => el && (teamInputEl = el)"
                v-model="teamDraft"
                class="osb-rename wide"
                maxlength="40"
                :aria-label="t('sidebar.team.name', 'Team name')"
                @blur="commitTeamRename"
                @keydown.enter.prevent.stop="commitTeamRename"
                @keydown.escape.prevent.stop="editingTeam = null"
              />
            </div>
            <div v-if="r.project && picking && picking.wsId === r.project.id" class="osb-inline-box osb-pick-bar">
              <span>{{ pickHint(r.project.id) }}</span>
              <div class="osb-inline-actions">
                <button type="button" class="osb-btn" @click="cancelPicking">{{ t('sidebar.cancel', 'Cancel') }}</button>
                <button
                  type="button"
                  class="osb-btn primary"
                  :disabled="pickTeam ? !picked.length : picked.length < 2"
                  @click="groupPicked"
                >
                  <span
                    v-text="pickTeam ? t('sidebar.team.addToName', 'Add to {{team}}', { team: pickTeam.name }) : t('sidebar.team.group', 'Group as a team')"
                  ></span>
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
          {{ t('sidebar.noMatch', 'No workspaces match these filters.') }}
        </div>
      </div>
    </template>

    <!-- Collapsed: one badge per project. -->
    <template v-else>
      <div class="osb-rail">
        <button
          type="button"
          class="osb-icon-btn"
          :aria-label="t('sidebar.expand', 'Expand sidebar')"
          :title="t('sidebar.expand', 'Expand sidebar')"
          @click="emit('toggle')"
        >
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
          <span v-if="p.needsYou" class="osb-rail-dot attention" :title="t('sidebar.rail.waiting', 'An agent is waiting for you')"></span>
          <span v-else-if="p.busy" class="osb-rail-dot" :title="t('sidebar.rail.working', 'An agent is working')"></span>
        </button>
        <button
          type="button"
          class="osb-icon-btn"
          :aria-label="t('sidebar.addProject', 'Add project')"
          :title="t('sidebar.addProject', 'Add project')"
          @click="emit('create')"
        >
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
      :label="t('sidebar.options.title', 'Workspace options')"
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
      :label="menu ? menu.label || t('sidebar.menu', 'Menu') : t('sidebar.menu', 'Menu')"
      @close="closeMenu"
    />

    <div class="osb-resize" :title="t('sidebar.resizeHint', 'Drag to resize. Double-click to reset.')" @pointerdown="startResize">
      <div class="osb-resize-line"></div>
    </div>
  </nav>
</template>
