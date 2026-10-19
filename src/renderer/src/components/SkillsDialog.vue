<script setup>
// Agent skills (a folder with a SKILL.md), for every agent CLI that reads
// them, in one place, like the MCP servers window:
//   Installed - one row per skill (its name and where it comes from: the
//               user's own, GitHub, a folder, synced from the Claude account,
//               built into an agent), however many folders hold it; which
//               agents see it, all projects or this project. A click opens its
//               details: the whole description and each copy (its agents,
//               scope and folder); open its folder, update one added from
//               GitHub, remove one copy or all (Recycle Bin or delete). Each
//               copy's history: a version kept whenever its content changed,
//               each compared with the one before, and restored if wanted.
//               "Modified locally" when an added copy was edited, "Update
//               available" when GitHub has newer commits for it (checked
//               about once a day, and by Refresh).
//   Add       - from a GitHub repository or a folder: the source in a
//               compact bar (suggested repositories to start from); a
//               repository of several skills in two panes, its skills (to
//               filter and select) beside the one opened: its description,
//               its SKILL.md to read, formatted or as it is, and its files.
//               Under them, always in view, the agents (chips), the scope
//               and Install: the skills selected in one go, or the one
//               opened. Each is copied into the skill folder of each chosen
//               agent, and the result says, skill by skill and folder by
//               folder, installed, already there (Replace it) or failed and
//               why. Nothing from a skill is ever run: a setup command it
//               mentions is only offered, in a pane the user sees.
//   Antigravity plugins - the Antigravity CLI's plugins, listed like the
//               skills: one row each, its details on a click.
// The work is done in the main process (src/main/skillsManager.js).
import { ref, reactive, computed, watch, nextTick, onMounted, onBeforeUnmount, inject } from 'vue'
import BrandIcon from './BrandIcon.vue'
import SkillTokenTag from './context/SkillTokenTag.vue'
import { t, intlLocale } from '../i18n'
import { openTarget } from '../links/openTarget'
import { isRemotePath } from '../../../shared/remotePath'
import { splitFrontmatter, renderSkillMarkdown } from '../skillPreview'

const props = defineProps({
  cwd: { type: String, default: null }, // current workspace's project folder
  agents: { type: Array, default: () => [] },
  // Shown as a Settings page: no backdrop, card, title bar or Escape to close.
  embedded: { type: Boolean, default: false }
})
const emit = defineEmits(['close', 'run'])

// The agents that read skills (same ids as Settings > Agents).
const ALL_AGENTS = ['claude', 'codex', 'opencode', 'copilot', 'gemini', 'antigravity', 'muse']
const AGENT_NAME = {
  claude: 'Claude Code', // i18n-ignore
  codex: 'Codex', // i18n-ignore
  opencode: 'OpenCode', // i18n-ignore
  copilot: 'Copilot CLI', // i18n-ignore
  gemini: 'Gemini CLI', // i18n-ignore
  antigravity: 'Antigravity CLI', // i18n-ignore
  muse: 'Muse Code' // i18n-ignore
}
const installed = computed(() =>
  Object.fromEntries(ALL_AGENTS.map((id) => [id, !!props.agents.find((a) => a.id === id && a.available)]))
)
// Installed here, and Claude Code and Codex always (the dialog is never empty).
const AGENTS = computed(() => ALL_AGENTS.filter((a) => installed.value[a] || a === 'claude' || a === 'codex'))
// A remote project (ssh://…) has no skill folders on this computer.
const project = computed(() => (props.cwd && !isRemotePath(props.cwd) ? props.cwd : null))

function agentList(names) {
  try {
    return new Intl.ListFormat(intlLocale(), { type: 'conjunction' }).format(names)
  } catch {
    return names.join(', ')
  }
}
const scopeLabel = (scope) =>
  scope === 'project' ? t('skills.scope.project', 'This project') : t('skills.scope.user', 'All projects')
function managedLabel(reason) {
  if (reason === 'synced') return t('skills.managed.synced', 'Synced from your Claude account')
  if (reason === 'system') return t('skills.managed.system', 'Built into the agent')
  return t('skills.managed.nested', 'Managed by the agent')
}
function size(bytes) {
  const n = Number(bytes) || 0
  const fmt = (v) => v.toLocaleString(intlLocale(), { maximumFractionDigits: 1 })
  if (n < 1024) return t('skills.size.bytes', '{{n}} B', { n: fmt(n) })
  if (n < 1024 * 1024) return t('skills.size.kb', '{{n}} KB', { n: fmt(n / 1024) })
  return t('skills.size.mb', '{{n}} MB', { n: fmt(n / 1024 / 1024) })
}
const sourceLabel = (source) =>
  source.kind === 'github'
    ? t('skills.source.github', 'From GitHub: {{repo}}', { repo: `${source.owner}/${source.repo}${source.path ? '/' + source.path : ''}` }) // i18n-ignore path
    : t('skills.source.folder', 'From a folder: {{path}}', { path: source.path })
const skillsLabel = (count) =>
  count === 1
    ? t('skills.installed.count', '{{count}} skill', { count })
    : t('skills.installed.count', '{{count}} skills', { count })
const versionsLabel = (count) => t('skills.details.versions', 'These copies are not all the same: {{count}} different versions.', { count })
// "3 of 20 skills": a search or a filter shows part of the list.
const skillsOfLabel = (shown, count) =>
  count === 1
    ? t('skills.installed.countOf', '{{shown}} of {{count}} skill', { shown, count })
    : t('skills.installed.countOf', '{{shown}} of {{count}} skills', { shown, count })
const filesSizeLabel = (count, bytes) =>
  count === 1
    ? t('skills.preview.files', '{{count}} file, {{size}}', { count: 1, size: size(bytes) })
    : t('skills.preview.files', '{{count}} files, {{size}}', { count, size: size(bytes) })
const filesLabel = (pkg) => filesSizeLabel(pkg.files.length, pkg.totalBytes)
const scriptsLabel = (pkg) =>
  t('skills.preview.scripts', 'It includes scripts or programs ({{names}}). Tessel never runs them, but an agent using the skill may.', {
    names: pkg.scripts.slice(0, 5).map((p) => p.split('/').pop()).join(', ') + (pkg.scripts.length > 5 ? '…' : '')
  })
const installLabel = (pkg) =>
  updating.value ? t('skills.preview.update', 'Update {{name}}', { name: pkg.name }) : t('skills.preview.install', 'Install {{name}}', { name: pkg.name })

function dateTime(ms) {
  if (!ms) return ''
  try {
    return new Intl.DateTimeFormat(intlLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(ms)
  } catch {
    return new Date(ms).toLocaleString()
  }
}
// "3 days ago", in the interface's language.
function ago(ms) {
  if (!ms) return ''
  const secs = Math.min(0, Math.round((ms - Date.now()) / 1000)) // a file dated ahead: now
  const units = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]]
  try {
    const rtf = new Intl.RelativeTimeFormat(intlLocale(), { numeric: 'auto' })
    for (const [unit, size] of units) if (Math.abs(secs) >= size) return rtf.format(Math.round(secs / size), unit)
    return t('skills.time.now', 'just now')
  } catch {
    return dateTime(ms)
  }
}

// Where a copy comes from: the user's own (no record of adding it), GitHub
// or a folder (added by Tessel), or the agent's (synced, built in).
const originOf = (copy) => copy.origin || (copy.managed ? 'agent' : copy.source ? (copy.source.kind === 'github' ? 'github' : 'folder') : 'own')
// The same, as the list shows it (one badge each, and its filters): the
// agent's own copies are either synced from the Claude account or built in.
const KINDS = ['own', 'github', 'folder', 'synced', 'builtin']
function kindOf(copy) {
  if (copy.managed === 'synced') return 'synced'
  const origin = originOf(copy)
  return copy.managed || origin === 'agent' ? 'builtin' : origin
}
// An origin's tag: its kind as a class (origin-own…) and its color.
const ORIGIN_TAGS = { own: 'tag-ok', github: 'tag-info', synced: 'tag-purple' }
function originTag(kind) {
  return ['origin-' + kind, ORIGIN_TAGS[kind]]
}
function kindLabel(kind) {
  if (kind === 'own') return t('skills.kind.own', 'Yours')
  if (kind === 'github') return t('skills.kind.github', 'GitHub')
  if (kind === 'folder') return t('skills.kind.folder', 'Folder')
  if (kind === 'synced') return t('skills.kind.synced', 'Synced')
  return t('skills.kind.builtin', 'Built-in')
}
function originLabel(copy) {
  const origin = originOf(copy)
  if (copy.managed) return managedLabel(copy.managed)
  if (origin === 'github') return t('skills.origin.github', 'From GitHub — {{repo}}', { repo: `${copy.source.owner}/${copy.source.repo}` }) // i18n-ignore path
  if (origin === 'folder') return t('skills.origin.folder', 'Copied from a folder')
  if (origin === 'own') return t('skills.origin.own', 'Your skill')
  return managedLabel('nested')
}
function originTitle(copy) {
  if (copy.managed) return managedLabel(copy.managed)
  if (originOf(copy) === 'own') return t('skills.origin.ownHint', 'Tessel has no record of adding it from GitHub or a folder: made on this computer, or added by another tool.')
  if (!copy.source) return ''
  return sourceLabel(copy.source) + (copy.source.commit ? ` @ ${copy.source.commit.slice(0, 7)}` : '') // i18n-ignore commit
}
// A row's badge tooltip: what its first copy says.
const kindTitle = (group) => originTitle(group.copies[0])
const FILTERS = ['all', ...KINDS]
function filterLabel(f) {
  if (f === 'own') return t('skills.filter.own', 'Yours')
  if (f === 'github') return t('skills.filter.github', 'GitHub')
  if (f === 'folder') return t('skills.filter.folder', 'Folders')
  if (f === 'synced') return t('skills.filter.synced', 'Synced')
  if (f === 'builtin') return t('skills.filter.builtin', 'Built-in')
  return t('skills.filter.all', 'All')
}
const agentsOf = (copy) => ALL_AGENTS.filter((a) => copy.seenBy.includes(a) && AGENTS.value.includes(a))
const agentNames = (agents) => agentList(agents.map((a) => AGENT_NAME[a]))
const seenByNames = (agents) => t('skills.installed.seenBy', 'Seen by {{agents}}', { agents: agentNames(agents) })
const updateTitle = (copy) => {
  const latest = copy.update && copy.update.latest
  return latest ? t('skills.updates.hint', 'Newest change: {{message}} ({{when}})', { message: latest.message, when: dateTime(latest.date) }) : ''
}
const changedLabel = (copy) =>
  copy.history.versions === 1
    ? t('skills.history.summary', 'Changed {{when}} · {{count}} version', { when: ago(copy.history.changedAt), count: 1 })
    : t('skills.history.summary', 'Changed {{when}} · {{count}} versions', { when: ago(copy.history.changedAt), count: copy.history.versions })
function versionSummary(v) {
  if (v.first) return t('skills.history.first', 'First version kept')
  return v.fileCount === 1
    ? t('skills.history.files', '{{count}} file changed', { count: 1 })
    : t('skills.history.files', '{{count}} files changed', { count: v.fileCount })
}
function noteLabel(note) {
  const at = note.commit ? ` @ ${String(note.commit).slice(0, 7)}` : '' // i18n-ignore commit
  if (note.kind === 'restore') return t('skills.history.noteRestore', 'Restored from {{when}}', { when: dateTime(note.fromAt) })
  if (note.kind === 'update') return t('skills.history.noteUpdate', 'Updated from GitHub') + at
  if (note.kind === 'install' && note.from === 'folder') return t('skills.history.noteFolder', 'Copied from a folder')
  if (note.kind === 'install') return t('skills.history.noteInstall', 'Installed from GitHub') + at
  return ''
}
const partialHint = computed(() =>
  t('skills.history.partialHint', 'Too many files (or too large) to keep all of this skill in its history: it cannot be restored, nor updated while it differs from what was installed.')
)
const statusLabel = (s) =>
  s === 'A' ? t('skills.history.added', 'Added') : s === 'D' ? t('skills.history.removed', 'Removed') : t('skills.history.changed', 'Changed')
const changesTitle = (changes) =>
  changes.commits.length === 1
    ? t('skills.update.changes', 'What changed since your version ({{count}} commit)', { count: 1 })
    : t('skills.update.changes', 'What changed since your version ({{count}} commits)', { count: changes.commits.length })

const cardEl = ref(null)
const tab = ref('installed')
const message = reactive({ text: '', kind: 'ok' })
const busy = ref('')
function say(text, kind = 'ok') {
  message.text = text
  message.kind = kind
}
const askConfirm = inject('askConfirm', (o) => Promise.resolve(window.confirm(o.title)))

// ---------------------------------------------------------------- Installed
const loading = ref(true)
const listed = ref({ skills: [], roots: [], updates: null, home: null })
const query = ref('')
const originFilter = ref('all')

// quiet: the list read again without "Loading…" (after a check or a restore).
async function refresh(quiet = false) {
  if (!quiet) loading.value = true
  try {
    // quiet: the main process may reuse a walk of the last minute.
    const res = await window.shellApi.skillsList(project.value, quiet ? { quiet: true } : undefined)
    if (res && res.ok === false) say(res.error, 'error')
    else listed.value = { skills: (res && res.skills) || [], roots: (res && res.roots) || [], updates: (res && res.updates) || null, home: (res && res.home) || null }
  } catch (err) {
    say((err && err.message) || String(err), 'error')
  } finally {
    loading.value = false
  }
}

// Updates of the skills added from GitHub: about once a day when the list
// opens, and by Refresh (force). Nothing is asked without such a skill.
const checking = ref(false)
async function checkUpdates(force = false) {
  if (!window.shellApi.skillsCheckUpdates) return
  if (!listed.value.skills.some((s) => s.source && s.source.kind === 'github')) return
  checking.value = true
  try {
    const res = await window.shellApi.skillsCheckUpdates({ force })
    if (res && res.checked) await refresh(true)
    if (force && res && res.rateLimited)
      say(t('skills.updates.limited', "GitHub's limit for update checks is reached. Next check after {{time}}.", { time: dateTime(res.until) }), 'error')
    else if (force && res && res.ok === false && res.error) say(res.error, 'error')
  } catch (err) {
    if (force) say((err && err.message) || String(err), 'error')
  } finally {
    checking.value = false
  }
}
async function refreshAll() {
  await refresh()
  await checkUpdates(true)
}
const checkedLabel = computed(() => {
  if (checking.value) return t('skills.updates.checking', 'Checking GitHub for updates…')
  const at = listed.value.updates && listed.value.updates.checkedAt
  if (!at || !listed.value.skills.some((s) => s.source && s.source.kind === 'github')) return ''
  return t('skills.updates.checked', 'Updates checked {{when}}', { when: ago(at) })
})

// Two copies hold the same content: the same files (their history's hash)
// or, for the agent's own copies that have no history, the same SKILL.md.
// Nothing to compare: taken for the same (never said to differ unseen).
function sameContent(a, b) {
  if (a.hash && b.hash) return a.hash === b.hash
  if (a.mdHash && b.mdHash) return a.mdHash === b.mdHash
  return true
}
const KIND_ORDER = Object.fromEntries(KINDS.map((k, i) => [k, i]))
const SCOPE_ORDER = { user: 0, project: 1 }
// One skill, however many folders hold it: all projects before this
// project, then by folder.
function makeGroup(key, kind, copies) {
  const sorted = [...copies].sort(
    (a, b) => (SCOPE_ORDER[a.scope] ?? 2) - (SCOPE_ORDER[b.scope] ?? 2) || String(a.dir).localeCompare(String(b.dir))
  )
  const versions = []
  for (const c of sorted) if (!versions.some((v) => sameContent(v, c))) versions.push(c)
  return {
    key,
    name: sorted[0].name,
    description: (sorted.find((c) => c.description) || {}).description || null,
    copies: sorted,
    kind,
    agents: ALL_AGENTS.filter((a) => sorted.some((c) => agentsOf(c).includes(a))),
    scopes: ['user', 'project'].filter((s) => sorted.some((c) => c.scope === s)),
    modified: sorted.some((c) => c.modified),
    update: sorted.find((c) => c.update && c.update.available) || null,
    partial: sorted.some((c) => c.history && c.history.partial),
    removable: sorted.filter((c) => c.removable),
    versions: versions.length,
    text: sorted.map((c) => `${c.name} ${c.description || ''}`).join(' ').toLowerCase()
  }
}

// The list once: one row per skill name and origin. Copies of a skill in
// several folders (each agent's, both of Claude's synced account folders)
// are one row; an agent's built-in skill named like one of the user's is
// another skill, so another row. Each row has one origin, so the tab, the
// filters and the count above the list all count the same rows, and the
// filters add up to All.
const groups = computed(() => {
  const byKey = new Map()
  for (const s of listed.value.skills) {
    const kind = kindOf(s)
    const key = `${kind}:${String(s.name).toLowerCase()}` // i18n-ignore
    if (!byKey.has(key)) byKey.set(key, { kind, copies: [] })
    byKey.get(key).copies.push(s)
  }
  return [...byKey]
    .map(([key, { kind, copies }]) => makeGroup(key, kind, copies))
    .sort((a, b) => a.name.localeCompare(b.name) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind])
})
const counts = computed(() => {
  const out = { all: groups.value.length }
  for (const k of KINDS) out[k] = groups.value.filter((g) => g.kind === k).length
  return out
})
// The filters once the skills come from more than one place.
const showFilter = computed(() => KINDS.filter((k) => counts.value[k]).length > 1 || originFilter.value !== 'all')
const visibleFilters = computed(() => FILTERS.filter((f) => f === 'all' || counts.value[f] || originFilter.value === f))
const shown = computed(() => {
  const q = query.value.trim().toLowerCase()
  return groups.value.filter((g) => (!q || g.text.includes(q)) && (originFilter.value === 'all' || g.kind === originFilter.value))
})
const countLabel = computed(() =>
  shown.value.length === groups.value.length ? skillsLabel(groups.value.length) : skillsOfLabel(shown.value.length, groups.value.length)
)
function showAll() {
  query.value = ''
  originFilter.value = 'all'
}

// The details of one skill, under its row. Arrows move between rows, Enter
// (or a click) opens or closes the details, Escape closes them.
const openKey = ref(null)
const uid = `skills-${Math.random().toString(36).slice(2, 8)}` // i18n-ignore
const rowId = (g) => `${uid}-row-${g.key.replace(/[^a-z0-9_-]/g, '_')}` // i18n-ignore
const detailsId = (g) => `${uid}-details-${g.key.replace(/[^a-z0-9_-]/g, '_')}` // i18n-ignore
const rowEls = []
function toggleGroup(g, open = openKey.value !== g.key) {
  if (!open && historyOpen.value && g.copies.some((c) => c.id === historyOpen.value)) historyOpen.value = null
  openKey.value = open ? g.key : null
}
function focusRow(i) {
  const n = shown.value.length
  if (!n) return
  const el = rowEls[Math.max(0, Math.min(n - 1, i))]
  if (el) el.focus()
}
// The keys of a list of rows (the skills, the skills found, the plugins):
// arrows move between rows, Home and End to its ends; right opens a row,
// left closes it.
function rowKeys(e, els, count, i, open, toggle) {
  const focus = (j) => {
    const el = els[Math.max(0, Math.min(count - 1, j))]
    if (el) el.focus()
  }
  if (e.key === 'ArrowDown') focus(i + 1)
  else if (e.key === 'ArrowUp') focus(i - 1)
  else if (e.key === 'Home') focus(0)
  else if (e.key === 'End') focus(count - 1)
  else if (e.key === 'ArrowRight' && !open) toggle(true)
  else if (e.key === 'ArrowLeft' && open) toggle(false)
  else return
  e.preventDefault()
}
function onRowKey(e, i, g) {
  rowKeys(e, rowEls, shown.value.length, i, openKey.value === g.key, (open) => toggleGroup(g, open))
}
// Escape inside an open skill closes it (and nothing else), back on its row.
function onItemEscape(e, g, i) {
  if (openKey.value !== g.key) return
  e.preventDefault()
  e.stopPropagation()
  toggleGroup(g, false)
  nextTick(() => focusRow(i))
}
// A skill gone from the list (removed) closes.
watch(groups, (list) => {
  if (openKey.value && !list.some((g) => g.key === openKey.value)) openKey.value = null
})

// A copy's folder, short enough to read: the home folder as ~, the
// project's by its name, and an id folder (Claude's synced/<account>_<org>)
// cut to its first characters. The whole path is in its tooltip.
function shortPath(dir) {
  let p = String(dir || '')
  const sep = p.includes('\\') ? '\\' : '/'
  const trim = (base) => String(base).replace(/[\\/]+$/, '')
  const under = (base) => !!base && (p.toLowerCase() === trim(base).toLowerCase() || p.toLowerCase().startsWith(trim(base).toLowerCase() + sep))
  if (project.value && under(project.value)) p = trim(project.value).split(/[\\/]/).pop() + p.slice(trim(project.value).length)
  else if (under(listed.value.home)) p = '~' + p.slice(trim(listed.value.home).length)
  return p
    .split(sep)
    .map((part) => (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(part) || part.length > 32 ? `${part.slice(0, 8)}…` : part)) // i18n-ignore
    .join(sep)
}
const copiedDir = ref('')
let copiedTimer = null
async function copyPath(copy) {
  try {
    if (window.shellApi.writeClipboard) await window.shellApi.writeClipboard(copy.dir)
    else await navigator.clipboard.writeText(copy.dir)
    copiedDir.value = copy.dir
    clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => (copiedDir.value = ''), 1500)
  } catch {
    say(t('skills.details.copyFailed', 'Could not copy the path.'), 'error')
  }
}
onBeforeUnmount(() => clearTimeout(copiedTimer))

async function openFolder(copy) {
  const res = await window.shellApi.skillsOpen({ dir: copy.dir, cwd: project.value })
  if (res && res.ok === false) say(res.error, 'error')
}

async function remove(copy) {
  const answer = await askConfirm({
    title: t('skills.remove.confirm', 'Remove the skill "{{name}}"?', { name: copy.name }),
    text: t('skills.remove.text', '{{agents}} will no longer have it. Running agents notice at their next session.', { agents: agentNames(agentsOf(copy)) }),
    code: copy.dir,
    confirmLabel: t('skills.remove.trash', 'Move to the Recycle Bin'),
    altLabel: t('skills.remove.delete', 'Delete permanently'),
    danger: true
  })
  if (!answer) return
  let mode = 'trash'
  if (answer === 'alt') {
    const sure = await askConfirm({
      title: t('skills.remove.sure', 'Delete "{{name}}" permanently?', { name: copy.name }),
      text: t('skills.remove.sureText', 'Its folder and every file in it are deleted. This cannot be undone.'),
      code: copy.dir,
      confirmLabel: t('skills.remove.delete', 'Delete permanently'),
      danger: true
    })
    if (sure !== true) return
    mode = 'delete'
  }
  busy.value = `rm:${copy.dir}` // i18n-ignore
  try {
    const res = await window.shellApi.skillsRemove({ dir: copy.dir, mode, cwd: project.value })
    if (res && res.ok) say(mode === 'delete' ? t('skills.remove.deleted', 'Deleted "{{name}}".', { name: copy.name }) : t('skills.remove.trashed', 'Moved "{{name}}" to the Recycle Bin.', { name: copy.name }))
    else say((res && res.error) || t('skills.remove.failed', 'It could not be removed.'), 'error')
  } finally {
    busy.value = ''
  }
  refresh()
}

// Every copy that can be removed, after the same two confirmations. A link
// stays (what it points to is not Tessel's to remove); a row of the agent's
// own copies (synced, built in) has nothing to remove, so no Remove all.
async function removeAll(group) {
  const copies = group.removable
  if (!copies.length) return
  const dirs = copies.map((c) => c.dir).join('\n')
  const keeps = group.copies.length > copies.length ? ' ' + t('skills.remove.allKeeps', 'The copies Tessel cannot remove (links) stay.') : ''
  const answer = await askConfirm({
    title: t('skills.remove.allConfirm', 'Remove every copy of "{{name}}"?', { name: group.name }),
    text: t('skills.remove.text', '{{agents}} will no longer have it. Running agents notice at their next session.', { agents: agentNames([...new Set(copies.flatMap(agentsOf))]) }) + keeps,
    code: dirs,
    confirmLabel: t('skills.remove.trash', 'Move to the Recycle Bin'),
    altLabel: t('skills.remove.delete', 'Delete permanently'),
    danger: true
  })
  if (!answer) return
  let mode = 'trash'
  if (answer === 'alt') {
    const sure = await askConfirm({
      title: t('skills.remove.allSure', 'Delete every copy of "{{name}}" permanently?', { name: group.name }),
      text: t('skills.remove.allSureText', 'These folders and every file in them are deleted. This cannot be undone.'),
      code: dirs,
      confirmLabel: t('skills.remove.delete', 'Delete permanently'),
      danger: true
    })
    if (sure !== true) return
    mode = 'delete'
  }
  busy.value = `rm-all:${group.key}` // i18n-ignore
  const failed = []
  try {
    for (const copy of copies) {
      try {
        const res = await window.shellApi.skillsRemove({ dir: copy.dir, mode, cwd: project.value })
        if (!res || !res.ok) failed.push((res && res.error) || t('skills.remove.failed', 'It could not be removed.'))
      } catch (err) {
        failed.push((err && err.message) || String(err))
      }
    }
  } finally {
    busy.value = ''
  }
  if (!failed.length)
    say(
      mode === 'delete'
        ? t('skills.remove.allDeleted', 'Deleted every copy of "{{name}}".', { name: group.name })
        : t('skills.remove.allTrashed', 'Moved every copy of "{{name}}" to the Recycle Bin.', { name: group.name })
    )
  else
    say(t('skills.remove.allPartly', 'Removed {{done}} of {{total}} copies of "{{name}}": {{error}}', { done: copies.length - failed.length, total: copies.length, name: group.name, error: failed[0] }), 'error')
  refresh()
}

// History: the versions kept for one copy, newest first; the chosen one is
// compared with the version before it.
const historyOpen = ref(null) // the copy's id
const history = reactive({ versions: [], loading: false, error: '', selected: null, diff: null, diffLoading: false })
const selectedVersion = computed(() => history.versions.find((v) => v.id === history.selected) || null)
async function toggleHistory(copy, open = historyOpen.value !== copy.id) {
  if (!open) {
    historyOpen.value = null
    return
  }
  historyOpen.value = copy.id
  Object.assign(history, { versions: [], loading: true, error: '', selected: null, diff: null })
  try {
    const res = await window.shellApi.skillsHistory({ dir: copy.dir, cwd: project.value })
    if (historyOpen.value !== copy.id) return
    if (res && res.ok === false) history.error = res.error
    else history.versions = (res && res.versions) || []
  } catch (err) {
    history.error = (err && err.message) || String(err)
  } finally {
    history.loading = false
  }
  if (history.versions.length) showVersion(copy, history.versions[0])
}
async function showVersion(copy, v) {
  history.selected = v.id
  history.diff = null
  history.diffLoading = true
  try {
    const res = await window.shellApi.skillsHistoryDiff({ dir: copy.dir, id: v.id, cwd: project.value })
    if (history.selected !== v.id) return
    history.diff = res && res.ok === false ? { error: res.error, files: [] } : res
  } catch (err) {
    history.diff = { error: (err && err.message) || String(err), files: [] }
  } finally {
    history.diffLoading = false
  }
}
async function restoreVersion(copy, v) {
  const ok = await askConfirm({
    title: t('skills.history.restoreConfirm', 'Restore "{{name}}" to its version of {{when}}?', { name: copy.name, when: dateTime(v.changedAt) }),
    text: t('skills.history.restoreText', 'Its files replace the current ones. The current version is kept in the history first, so you can come back to it.'),
    code: copy.dir,
    confirmLabel: t('skills.history.restore', 'Restore this version')
  })
  if (ok !== true) return
  busy.value = `restore:${copy.dir}` // i18n-ignore
  try {
    const res = await window.shellApi.skillsRestore({ dir: copy.dir, id: v.id, cwd: project.value })
    if (res && res.ok)
      say(
        res.kept && res.kept.length
          ? t('skills.history.restoredKept', 'Restored "{{name}}". Left in place: {{files}} (not in that version, and too large to keep in the history).', { name: copy.name, files: res.kept.slice(0, 3).join(', ') })
          : t('skills.history.restored', 'Restored "{{name}}" to its version of {{when}}.', { name: copy.name, when: dateTime(v.changedAt) })
      )
    else say((res && res.error) || t('skills.history.restoreFailed', 'It could not be restored.'), 'error')
  } finally {
    busy.value = ''
  }
  await refresh(true)
  const again = listed.value.skills.find((s) => s.dir === copy.dir)
  if (again) toggleHistory(again, true)
}

// Update: the same source again, shown in the Add tab before it replaces it.
const updating = ref(null) // the copy being updated
async function update(copy) {
  resetAdd()
  updating.value = copy
  tab.value = 'add'
  const seq = ++lookSeq
  busy.value = 'look'
  try {
    const res = await window.shellApi.skillsForUpdate(copy.dir)
    if (seq !== lookSeq) return
    if (res && res.ok === false) addError.value = res.error
    else preview.value = res
  } catch (err) {
    if (seq === lookSeq) addError.value = errorText(err)
  } finally {
    if (seq === lookSeq) busy.value = ''
  }
}

// ---------------------------------------------------------------- Add
// The source at the top: GitHub or a folder, then, once looked up, one line
// saying what was found, with a way to change it. A repository of several
// skills is browsed in two panes: its skills on the left (filtered, each
// with a box to select it, marked when it is already installed), the one
// opened on the right (its description, its SKILL.md to read, formatted or
// as it is, and its files). One skill (a repository path, a folder, an
// update) is that right pane alone. Under them, always in view, the bar that
// installs: the agents, the scope and Install, for the skills selected (one
// go) or else the one opened. Then the result, skill by skill and folder by
// folder. Narrow (no room for both panes): the list, then the skill opened
// in its place, with a way back.
const from = ref('github') // 'github' | 'folder'
const repoInput = ref('')
const repoEl = ref(null)
const lookedUp = ref('') // the input the skills shown were looked up with
const editingSource = ref(false) // the source form again, over what was found
const candidates = ref(null) // { repo, commit, total, candidates: [{ path, name, description, files, bytes }] }
const pickedPath = ref(null) // the skill of `candidates` opened on the right
const viewing = ref(false) // narrow: the skill opened, shown in place of the list
const selected = ref([]) // the paths of the skills of `candidates` selected to install
const filter = ref('') // the list, filtered by name, description or path
const preview = ref(null) // the package shown before installing
const pickError = ref('') // the skill opened could not be read
const folderDir = ref('') // the folder chosen (From a folder)
const addError = ref('')
const results = ref(null) // one per skill installed: { key, name, path, error, results: [one per folder] }
const progress = ref(null) // { done, total } while several skills are installed
const targets = reactive(Object.fromEntries(ALL_AGENTS.map((a) => [a, false])))
const targetsTouched = ref(false) // chosen by the user: kept from one skill to the next
const scope = ref('user')
// The preview's parts shown: the instructions (formatted, or their source),
// the files (the first ones, or all) and the whole description.
const mdOpen = ref(false)
const mdSource = ref(false)
const filesOpen = ref(false)
const filesAll = ref(false)
const descOpen = ref(false)
const detailEl = ref(null)
const resultsEl = ref(null)
// One lookup at a time: the answer to an older one (another skill clicked
// meanwhile, the source changed) is dropped.
let lookSeq = 0
// Repositories of skills to start from, a click away.
const SUGGESTED = ['anthropics/skills', 'openai/skills', 'huggingface/skills', 'obra/superpowers'] // i18n-ignore
const SKILL_FILE = 'SKILL.md' // i18n-ignore
const FILES_SHOWN = 12 // the files listed before the rest are asked for

// The agents found on this computer; Claude Code when none is (the window is never empty).
function defaultTargets() {
  for (const a of ALL_AGENTS) targets[a] = installed.value[a] || (a === 'claude' && !ALL_AGENTS.some((x) => installed.value[x]))
}
// The agents can arrive after the window opens: the defaults follow them until the user chooses.
watch(installed, () => {
  if (!targetsTouched.value) defaultTargets()
})

function resetPreview() {
  preview.value = null
  pickError.value = ''
  mdOpen.value = false
  mdSource.value = false
  filesOpen.value = false
  filesAll.value = false
  descOpen.value = false
}
function resetAdd() {
  lookSeq++
  candidates.value = null
  pickedPath.value = null
  viewing.value = false
  selected.value = []
  filter.value = ''
  editingSource.value = false
  resetPreview()
  addError.value = ''
  results.value = null
  updating.value = null
}
// The Add tab. A finished update is left behind: Add starts afresh.
function openAdd() {
  if (updating.value && allDone.value) resetAdd()
  tab.value = 'add'
}
function setFrom(kind) {
  if (from.value === kind) return
  from.value = kind
  folderDir.value = ''
  resetAdd()
}
// A suggested repository: looked up at once.
function suggest(repo) {
  repoInput.value = repo
  lookUp()
}
const errorText = (err) => (err && err.message) || String(err)

// The repository (pick: null), or one skill of it (pick: its path), read
// from the commit its list was read at.
async function lookUp(pick = null) {
  const input = pick == null ? repoInput.value.trim() : lookedUp.value
  if (!input) return
  if (pick == null) resetAdd()
  else {
    addError.value = ''
    results.value = null
    resetPreview()
  }
  pickedPath.value = pick
  const seq = ++lookSeq
  busy.value = pick == null ? 'look' : 'pick'
  try {
    const q = { input, pick }
    if (pick != null && candidates.value && candidates.value.commit) q.commit = candidates.value.commit
    const res = await window.shellApi.skillsFromGithub(q)
    if (seq !== lookSeq) return
    if (res && res.ok === false) {
      if (pick == null) addError.value = res.error
      else pickError.value = res.error
    } else if (res && res.candidates) {
      candidates.value = res
      lookedUp.value = input
    } else {
      preview.value = res
      if (pick == null) lookedUp.value = input
    }
  } catch (err) {
    if (seq !== lookSeq) return
    if (pick == null) addError.value = errorText(err)
    else pickError.value = errorText(err)
  } finally {
    if (seq === lookSeq) busy.value = ''
  }
}

// A skill of the list, opened on the right (narrow: in place of the list,
// the focus on the way back).
function pickCandidate(c) {
  viewing.value = true
  if (pickedPath.value !== c.path || (!preview.value && busy.value !== 'pick')) lookUp(c.path)
  nextTick(() => {
    const back = detailEl.value && detailEl.value.querySelector('.skills-back')
    if (back && back.offsetParent !== null) back.focus()
  })
}
function backToList() {
  viewing.value = false
  const i = visibleCandidates.value.findIndex((c) => c.path === pickedPath.value)
  nextTick(() => foundEls[i] && foundEls[i].focus())
}
// Escape in the skill opened: back on its row in the list.
function onDetailEscape(e) {
  if (!candidates.value || !viewing.value) return
  e.preventDefault()
  e.stopPropagation()
  backToList()
}
function changeSource() {
  editingSource.value = true
  nextTick(() => repoEl.value && repoEl.value.focus())
}

async function chooseFolder() {
  const dir = await window.shellApi.pickFolder({
    title: t('skills.add.pickTitle', 'Choose a skill folder (with a SKILL.md)'),
    defaultPath: project.value || undefined
  })
  if (!dir) return
  resetAdd()
  folderDir.value = dir
  const seq = ++lookSeq
  busy.value = 'look'
  try {
    const res = await window.shellApi.skillsFromFolder(dir)
    if (seq !== lookSeq) return
    if (res && res.ok === false) addError.value = res.error
    else preview.value = res
  } catch (err) {
    if (seq === lookSeq) addError.value = errorText(err)
  } finally {
    if (seq === lookSeq) busy.value = ''
  }
}

// The list: filtered, selected (one box each, and one for all those shown).
const visibleCandidates = computed(() => {
  if (!candidates.value) return []
  const q = filter.value.trim().toLowerCase()
  const list = candidates.value.candidates
  return q ? list.filter((c) => [c.name, c.description || '', c.path].some((v) => String(v).toLowerCase().includes(q))) : list
})
const selectedSet = computed(() => new Set(selected.value))
const isSelected = (c) => selectedSet.value.has(c.path)
function toggleSelect(c) {
  selected.value = isSelected(c) ? selected.value.filter((p) => p !== c.path) : [...selected.value, c.path]
}
const allShownSelected = computed(() => visibleCandidates.value.length > 0 && visibleCandidates.value.every(isSelected))
const someShownSelected = computed(() => visibleCandidates.value.some(isSelected))
function selectAllShown() {
  const paths = visibleCandidates.value.map((c) => c.path)
  selected.value = allShownSelected.value ? selected.value.filter((p) => !paths.includes(p)) : [...new Set([...selected.value, ...paths])]
}
const candidateRowId = (c) => `${uid}-cand-${c.path.replace(/[^A-Za-z0-9_-]/g, '_')}` // i18n-ignore
const foundEls = []
function onFoundKey(e, i, c) {
  rowKeys(e, foundEls, visibleCandidates.value.length, i, pickedPath.value === c.path, (open) => open && pickCandidate(c))
}
// "20 skills", "3 of 20 skills" when filtered.
const listTotalLabel = computed(() => {
  const count = candidates.value ? candidates.value.total || candidates.value.candidates.length : 0
  return count === 1 ? t('skills.add.count', '{{count}} skill', { count }) : t('skills.add.count', '{{count}} skills', { count })
})
const listCountLabel = computed(() => {
  if (!candidates.value || !filter.value.trim()) return listTotalLabel.value
  const count = candidates.value.candidates.length
  const shown = visibleCandidates.value.length
  return count === 1
    ? t('skills.add.shownOf', '{{shown}} of {{count}} skill', { shown, count })
    : t('skills.add.shownOf', '{{shown}} of {{count}} skills', { shown, count })
})
// A repository of hundreds: the first ones only (skillsManager.js).
const moreLabel = computed(() =>
  candidates.value
    ? t('skills.add.moreThan', 'Only the first {{shown}} of {{count}} skills are listed. Add a folder of the repository to its address to see the others.', {
        shown: candidates.value.candidates.length,
        count: candidates.value.total
      })
    : ''
)
const selectedLabel = computed(() => {
  const count = selected.value.length
  return count === 1 ? t('skills.add.selectedCount', '{{count}} skill selected', { count }) : t('skills.add.selectedCount', '{{count}} skills selected', { count })
})

// Already installed: added from this repository, from that path. "Update
// available" when GitHub has newer commits for one of its copies.
function installedState(owner, repo, path) {
  const key = `${owner}/${repo}`.toLowerCase()
  let state = null
  for (const s of listed.value.skills) {
    const src = s.source
    if (!src || src.kind !== 'github' || `${src.owner}/${src.repo}`.toLowerCase() !== key || (src.path || '') !== (path || '')) continue
    if (s.update && s.update.available) return 'update'
    state = 'installed'
  }
  return state
}
const candidateStates = computed(() => {
  const out = {}
  if (!candidates.value) return out
  const [owner, repo] = String(candidates.value.repo).split('/')
  for (const c of candidates.value.candidates) out[c.path] = installedState(owner, repo, c.path)
  return out
})
const previewState = computed(() => {
  const p = preview.value
  if (!p || updating.value || !p.source || p.source.kind !== 'github') return null
  return installedState(p.source.owner, p.source.repo, p.source.path)
})
const stateLabel = (state) => (state === 'update' ? t('skills.updates.badge', 'Update available') : t('skills.add.isInstalled', 'Installed'))

// What was found, in one line: "anthropics/skills @ dbd4588", or the folder.
const hasResult = computed(() => !updating.value && (!!candidates.value || !!preview.value))
const sourceWhat = computed(() => {
  if (candidates.value) return candidates.value.repo + (candidates.value.commit ? ` @ ${candidates.value.commit.slice(0, 7)}` : '') // i18n-ignore commit
  return preview.value ? sourceShort(preview.value.source) : ''
})
// "20 skills in owner/repo @ 1a2b3c4".
const foundLabel = computed(() => {
  if (!candidates.value) return ''
  const count = candidates.value.total || candidates.value.candidates.length
  const repo = candidates.value.repo + (candidates.value.commit ? ` @ ${candidates.value.commit.slice(0, 7)}` : '') // i18n-ignore commit
  return count === 1
    ? t('skills.add.found', '{{count}} skill in {{repo}}', { count, repo })
    : t('skills.add.found', '{{count}} skills in {{repo}}', { count, repo })
})
const moreThanShown = computed(() => !!candidates.value && (candidates.value.total || 0) > candidates.value.candidates.length)
const itemSize = (item) => (item.files == null ? '' : filesSizeLabel(item.files, item.bytes || 0))
// Where the preview comes from, short: owner/repo/path @ commit, or the folder.
function sourceShort(source) {
  if (!source) return ''
  if (source.kind !== 'github') return shortPath(source.path)
  return `${source.owner}/${source.repo}${source.path ? '/' + source.path : ''}${source.commit ? ' @ ' + source.commit.slice(0, 7) : ''}` // i18n-ignore path
}
const sourceTitle = (source) => (source ? sourceLabel(source) + (source.commit ? ` @ ${source.commit}` : '') : '') // i18n-ignore commit

// The instructions: the front matter as key/value pairs, the rest formatted
// (only while shown: a SKILL.md can be long), or the file as it is.
const frontmatter = computed(() => (preview.value ? splitFrontmatter(preview.value.skillMd) : { meta: [], body: '' }))
const mdHtml = computed(() => (preview.value && mdOpen.value && !mdSource.value ? renderSkillMarkdown(frontmatter.value.body) : ''))
// The whole description: from the SKILL.md (the one listed is cut at 512
// characters); a long one folded to a few lines, opened on a click.
const description = computed(() => {
  const p = preview.value
  if (!p) return ''
  const fm = frontmatter.value.meta.find((m) => m.key === 'description')
  return (fm && fm.value) || p.description || ''
})
const longDescription = computed(() => description.value.length > 240)
const allFilesLabel = computed(() => (preview.value ? t('skills.preview.allFiles', 'Show all {{count}} files', { count: preview.value.files.length }) : ''))
const shownFiles = computed(() => (!preview.value ? [] : filesAll.value ? preview.value.files : preview.value.files.slice(0, FILES_SHOWN)))
// A link in the instructions: a web page opens in the browser (Tessel's link
// router, links/openTarget.js), never here.
function onMdClick(e) {
  const a = e.target && e.target.closest ? e.target.closest('a[href]') : null
  if (!a) return
  e.preventDefault()
  const href = a.getAttribute('href') || ''
  if (/^https?:\/\//i.test(href)) openTarget(href, { event: e })
}

// The bar: the agents (chips) and the scope.
const chosenAgents = computed(() => AGENTS.value.filter((a) => targets[a]))
const allChosen = computed(() => AGENTS.value.every((a) => targets[a]))
function toggleTarget(a) {
  targets[a] = !targets[a]
  targetsTouched.value = true
}
function chooseAll(on) {
  for (const a of AGENTS.value) targets[a] = on
  targetsTouched.value = true
}
const agentChipLabel = (a) => (installed.value[a] ? AGENT_NAME[a] : t('skills.add.agentMissing', '{{agent}} (not found on this computer)', { agent: AGENT_NAME[a] }))
// The folders agents share, said only when it matters for the agents chosen.
const sharedNote = computed(() => {
  const chosen = chosenAgents.value
  if (scope.value === 'project' && (chosen.includes('codex') || chosen.includes('antigravity')))
    return t('skills.add.sharedProject', "Codex and Antigravity CLI get it in the project's shared .agents folder, which OpenCode, Copilot CLI and Gemini CLI read too.")
  if (scope.value === 'user' && chosen.includes('codex')) return t('skills.add.codexNote', 'Codex gets it in the shared .agents folder, which OpenCode, Copilot CLI and Gemini CLI read too.')
  return ''
})
const projectName = computed(() => (project.value ? String(project.value).replace(/[\\/]+$/, '').split(/[\\/]/).pop() : ''))
watch(project, (p) => {
  if (!p && scope.value === 'project') scope.value = 'user'
})

// What Install installs: the skills selected, or else the one opened (the
// one found, the new version of an update).
const installItems = computed(() => {
  const p = preview.value
  if (!candidates.value) return p ? [{ key: '', name: p.name, path: null, pkg: p }] : []
  if (selected.value.length)
    return candidates.value.candidates.filter(isSelected).map((c) => ({ key: c.path, name: c.name, path: c.path, pkg: p && pickedPath.value === c.path ? p : null }))
  return p && pickedPath.value ? [{ key: pickedPath.value, name: p.name, path: pickedPath.value, pkg: p }] : []
})
// "claude-api · For Claude Code and Codex · All projects"; three agents or
// more by their number (the chips name them).
const installSummary = computed(() => {
  const n = chosenAgents.value.length
  if (!n) return ''
  const agents = n <= 2 ? agentNames(chosenAgents.value) : t('skills.add.agentCount', '{{count}} agents', { count: n })
  return t('skills.add.summary', 'For {{agents}} · {{scope}}', { agents, scope: scopeLabel(scope.value) })
})
const barSubject = computed(() => {
  if (selected.value.length) return selectedLabel.value
  if (installItems.value.length) return installItems.value[0].name
  return candidates.value ? t('skills.add.chooseSkill', 'Choose a skill to install') : t('skills.add.lookFirst', 'Look up a repository or choose a folder')
})
const footSummary = computed(() => {
  if (updating.value) return t('skills.add.updateSummary', 'Replaces the copy in {{path}}', { path: shortPath(updating.value.dir) })
  return installItems.value.length && installSummary.value ? `${barSubject.value} · ${installSummary.value}` : barSubject.value // i18n-ignore
})
const installText = computed(() => {
  if (busy.value === 'install')
    return progress.value && progress.value.total > 1
      ? t('skills.add.installingOf', 'Installing {{done}} of {{total}}…', { done: Math.min(progress.value.done + 1, progress.value.total), total: progress.value.total })
      : t('skills.add.installing', 'Installing…')
  if (updating.value) return preview.value ? installLabel(preview.value) : t('skills.installed.update', 'Update')
  const n = installItems.value.length
  if (n > 1) return t('skills.add.installMany', 'Install {{count}} skills', { count: n })
  if (n === 1) return t('skills.preview.install', 'Install {{name}}', { name: installItems.value[0].name })
  return t('skills.add.install', 'Install')
})
// Nothing left to do: every skill is in every folder, for the skills, agents
// and scope still chosen (another choice brings the Install button back).
const choiceKey = () => `${scope.value}:${chosenAgents.value.join(',')}:${installItems.value.map((i) => i.key).join('|')}` // i18n-ignore
const doneKey = ref('')
const entryOk = (e) => !e.error && e.results.length > 0 && e.results.every((r) => r.ok)
const allDone = computed(() => !!results.value && results.value.length > 0 && results.value.every(entryOk) && (!!updating.value || doneKey.value === choiceKey()))

// A skill's package: the one shown when it is the only one installed, else
// read again from the repository, at the commit of its list (the window
// keeps a few packages only, several installed in one go need their own).
async function packageFor(item, reuse) {
  if (item.pkg && (reuse || !candidates.value)) return item.pkg
  const q = { input: lookedUp.value, pick: item.path }
  if (candidates.value && candidates.value.commit) q.commit = candidates.value.commit
  return window.shellApi.skillsFromGithub(q)
}
async function installOne(item, { replace = null, reuse = true } = {}) {
  const entry = { key: item.key, name: item.name, path: item.path, error: '', results: [] }
  try {
    const pkg = await packageFor(item, reuse)
    if (!pkg || pkg.ok === false || !pkg.id) return { ...entry, error: (pkg && pkg.error) || t('skills.add.notRead', 'It could not be read.') }
    const res = await window.shellApi.skillsInstall({ id: pkg.id, agents: chosenAgents.value, scope: scope.value, cwd: project.value, replace })
    if (!res || (res.ok === false && !res.results)) return { ...entry, name: pkg.name || entry.name, error: (res && res.error) || t('skills.add.notRead', 'It could not be read.') }
    return { ...entry, name: res.name || pkg.name || entry.name, results: res.results }
  } catch (err) {
    return { ...entry, error: errorText(err) }
  }
}

let listing = null // the list read again after an install
async function install() {
  const items = installItems.value
  if (!items.length) return
  addError.value = ''
  const replace = (updating.value && updating.value.dir) || null
  if (!replace && !chosenAgents.value.length) {
    addError.value = t('skills.add.chooseAgent', 'Choose at least one agent.')
    return
  }
  // An edited copy: its changes go (they stay in its history).
  if (updating.value && updating.value.modified) {
    const sure = await askConfirm({
      title: t('skills.update.confirm', 'Replace your changes to "{{name}}"?', { name: updating.value.name }),
      text: t('skills.update.confirmText', 'This copy was changed since it was installed. The update replaces it; your version stays in its history (History, then Restore this version).'),
      code: updating.value.dir,
      confirmLabel: t('skills.update.anyway', 'Update anyway'),
      danger: true
    })
    if (sure !== true) return
  }
  const key = choiceKey()
  busy.value = 'install'
  progress.value = { done: 0, total: items.length }
  const out = []
  try {
    for (const item of items) {
      out.push(await installOne(item, { replace, reuse: items.length === 1 }))
      progress.value = { done: out.length, total: items.length }
    }
  } finally {
    busy.value = ''
    progress.value = null
  }
  listing = refresh()
  // One skill that went nowhere (no folder tried): said at the top.
  if (out.length === 1 && out[0].error && !out[0].results.length) {
    addError.value = out[0].error
    return
  }
  results.value = out
  doneKey.value = key
  announce(out, replace)
  // The result in view: the skill's pane (narrow: in place of the list).
  if (candidates.value) viewing.value = true
  await nextTick()
  if (resultsEl.value && typeof resultsEl.value.scrollIntoView === 'function') resultsEl.value.scrollIntoView({ block: 'nearest' })
  // Nothing left to install (the button is gone): the focus on what comes next.
  const next = allDone.value && resultsEl.value && resultsEl.value.querySelector('[data-test="skills-view-installed"]')
  if (next) next.focus()
}

// Replace it: that folder's line changes, the others stay as they were.
async function replaceIn(entry, r) {
  addError.value = ''
  busy.value = `replace:${r.dir}` // i18n-ignore
  try {
    const shown = entry.path == null || (preview.value && pickedPath.value === entry.path)
    const res = await installOne({ ...entry, pkg: shown ? preview.value : null }, { replace: r.dir, reuse: results.value.length === 1 })
    if (res.error) {
      addError.value = res.error
      return
    }
    results.value = results.value.map((e) => (e.key === entry.key ? { ...e, results: e.results.map((x) => res.results.find((y) => y.dir === x.dir) || x) } : e))
    announce([res], r.dir)
  } finally {
    busy.value = ''
  }
  listing = refresh()
}

// Several skills: the ones now in every folder chosen (the result says the rest).
function announce(out, replace) {
  const done = out.filter((e) => (out.length > 1 ? entryOk(e) : e.results.some((r) => r.ok)))
  if (!done.length) return
  const name = done[0].name
  const agents = agentNames([...new Set(done.flatMap((e) => e.results.filter((r) => r.ok).flatMap((r) => resultAgents(r))))])
  if (replace && done.some((e) => e.results.some((r) => r.trashed)))
    say(t('skills.add.updatedTrashed', 'Updated "{{name}}". The old copy is in the Recycle Bin. Agents use it from their next session.', { name }))
  else if (replace) say(t('skills.add.updated', 'Updated "{{name}}". Agents use it from their next session.', { name }))
  else if (out.length === 1) say(t('skills.add.installed', 'Installed "{{name}}" for {{agents}}. Agents use it from their next session.', { name, agents }))
  else
    say(
      done.length === 1
        ? t('skills.add.installedMany', 'Installed {{count}} skill for {{agents}}. Agents use it from their next session.', { count: 1, agents })
        : t('skills.add.installedMany', 'Installed {{count}} skills for {{agents}}. Agents use them from their next session.', { count: done.length, agents })
    )
}

// Each result: the agents it was for (one folder can be for two: Codex and
// the Antigravity CLI share a project's .agents), and who else reads it.
const resultAgents = (r) => (r.agents && r.agents.length ? r.agents.filter((a) => ALL_AGENTS.includes(a)) : (r.seenBy || []).filter((a) => AGENTS.value.includes(a)))
const alsoSeen = (r) => (r.seenBy || []).filter((a) => AGENTS.value.includes(a) && !resultAgents(r).includes(a))
function resultState(r) {
  if (r.ok) return t('skills.add.done', 'Installed')
  if (r.exists) return t('skills.add.exists', 'Already there')
  return t('skills.add.failed', 'Failed')
}
// A skill of several: installed everywhere, already there somewhere (and
// nothing failed), or failed.
const entryState = (e) => (entryOk(e) ? 'ok' : !e.error && e.results.every((r) => r.ok || r.exists) ? 'exists' : 'failed')
function entrySummary(e) {
  const state = entryState(e)
  const agentsOf = (keep) => agentNames([...new Set(e.results.filter(keep).flatMap((r) => resultAgents(r)))])
  if (state === 'ok') return t('skills.add.installedFor', 'Installed for {{agents}}', { agents: agentsOf((r) => r.ok) })
  if (state === 'exists') return t('skills.add.existsFor', 'Already there for {{agents}}', { agents: agentsOf((r) => r.exists) })
  const failed = (r) => !r.ok && !r.exists
  return e.results.some(failed) ? t('skills.add.failedFor', 'Failed for {{agents}}', { agents: agentsOf(failed) }) : t('skills.add.failed', 'Failed')
}
// One skill: each folder. Several: each skill, with the folders that did not take it.
const linesOf = (e) => (results.value && results.value.length === 1 ? e.results : e.results.filter((r) => !r.ok))
const resultsHead = computed(() => {
  const list = results.value || []
  if (list.length === 1) {
    const lines = list[0].results
    return t('skills.add.resultsDone', '{{done}} of {{total}} done', { done: lines.filter((r) => r.ok).length, total: lines.length })
  }
  return t('skills.add.skillsDone', '{{done}} of {{total}} skills installed', { done: list.filter(entryOk).length, total: list.length })
})
const alsoSeenLabel = (r) => t('skills.add.alsoSeen', 'Also seen by {{agents}}', { agents: agentNames(alsoSeen(r)) })
const updatingTitle = computed(() => (updating.value ? t('skills.add.updatingName', 'Update {{name}}', { name: updating.value.name }) : ''))

// The skill just installed (the first of several), opened in the Installed list.
async function viewInstalled() {
  const entry = (results.value || []).find((e) => e.results.some((r) => r.ok || r.exists))
  const name = String((entry && entry.name) || (preview.value && preview.value.name) || '').toLowerCase()
  const kind = preview.value && preview.value.source && preview.value.source.kind === 'folder' ? 'folder' : 'github'
  query.value = ''
  originFilter.value = 'all'
  tab.value = 'installed'
  if (listing) await listing
  const g = groups.value.find((x) => x.key === `${kind}:${name}`) || groups.value.find((x) => x.name.toLowerCase() === name)
  if (!g) return
  toggleGroup(g, true)
  await nextTick()
  const el = rowEls[shown.value.indexOf(g)]
  if (!el) return
  el.focus()
  if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' })
}
function addAnother() {
  resetAdd()
  folderDir.value = ''
  if (from.value === 'github') {
    repoInput.value = ''
    nextTick(() => repoEl.value && repoEl.value.focus())
  }
}
function cancelUpdate() {
  resetAdd()
  tab.value = 'installed'
}

// A setup command the skill mentions: shown exactly, run only when asked, in
// a pane the user sees (it may ask questions).
async function runSetup(command) {
  const ok = await askConfirm({
    title: t('skills.setup.confirm', "Run this skill's setup in a terminal?"),
    text: t('skills.setup.confirmText', "It downloads and runs a program from npm. Run it only if you trust the skill's author. Answer its questions in the terminal."),
    code: command,
    confirmLabel: t('skills.setup.run', 'Run in a terminal')
  })
  if (ok !== true) return
  emit('run', { label: t('skills.setup.pane', 'Skill setup: {{name}}', { name: preview.value ? preview.value.name : '' }), command })
}

// Icons drawn in several places of the tab.
const GITHUB_ICON =
  'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z' // i18n-ignore
const FOLDER_ICON = 'M2 4.5A1.5 1.5 0 0 1 3.5 3h2.6l1.4 1.5h5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z' // i18n-ignore
const CHECK_ICON = 'M3.5 8.5l3 3 6-7' // i18n-ignore
const STATE_ICON = { ok: 'M5 8.3l2 2 4-4.3', exists: 'M8 4.8v3.8M8 10.9h.01', failed: 'M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4' } // i18n-ignore

// ---------------------------------------------------------------- Plugins
// The Antigravity CLI's plugins (bundles of skills, MCP servers, hooks and
// rules) and Muse Code's (skills, commands, hooks and MCP servers), listed
// like the skills: one row each, its details on a click. Turned on or off and
// uninstalled with each one's own commands (src/main/agyPlugins.js,
// musePlugins.js). Installing one can ask questions (a plugin's settings
// form, its hooks' approval): it runs in a pane the user sees. One tab per
// agent installed here.
const PLUGIN_API = {
  antigravity: { list: 'agyPluginsList', set: 'agyPluginsSet', remove: 'agyPluginsRemove' },
  muse: { list: 'musePluginsList', set: 'musePluginsSet', remove: 'musePluginsRemove' }
}
const pluginAgents = computed(() => Object.keys(PLUGIN_API).filter((id) => installed.value[id] && !!window.shellApi[PLUGIN_API[id].list]))
const showPlugins = computed(() => pluginAgents.value.length > 0)
const pluginAgent = ref('antigravity')
const pluginApi = (op) => window.shellApi[PLUGIN_API[pluginAgent.value][op]]
const musePlugins = computed(() => pluginAgent.value === 'muse')
// Its own words: which agent, its marketplace, its panes.
const pluginWords = {
  intro: () =>
    musePlugins.value
      ? t('skills.musePlugins.intro', 'Muse Code plugins bundle skills, commands, hooks and MCP servers. Browse them with /plugins in a Muse Code pane, or install one here from a folder or by name (name@marketplace). Muse asks you to approve the hooks of a plugin before they run.')
      : t('skills.plugins.intro', 'Antigravity CLI plugins bundle skills, MCP servers, subagents, hooks and rules. Browse its marketplace with /plugin in an Antigravity CLI pane, or install one here by name or from a folder.'),
  placeholder: () => (musePlugins.value ? t('skills.musePlugins.placeholder', 'name@marketplace') : t('skills.plugins.placeholder', 'name@antigravity-plugins-official')),
  empty: () => (musePlugins.value ? t('skills.musePlugins.empty', 'No Muse Code plugins installed.') : t('skills.plugins.empty', 'No Antigravity CLI plugins installed.')),
  turnedOff: (name) =>
    musePlugins.value
      ? t('skills.musePlugins.turnedOff', 'Turned off "{{name}}". Muse Code panes use the change from their next start.', { name })
      : t('skills.plugins.turnedOff', 'Turned off "{{name}}". Antigravity CLI panes use the change from their next start.', { name }),
  turnedOn: (name) =>
    musePlugins.value
      ? t('skills.musePlugins.turnedOn', 'Turned on "{{name}}". Muse Code panes use the change from their next start.', { name })
      : t('skills.plugins.turnedOn', 'Turned on "{{name}}". Antigravity CLI panes use the change from their next start.', { name }),
  failed: () => (musePlugins.value ? t('skills.musePlugins.failed', 'Muse Code could not change it.') : t('skills.plugins.failed', 'The Antigravity CLI could not change it.')),
  removeText: () =>
    musePlugins.value
      ? t('skills.musePlugins.removeText', 'Muse Code deletes its installed copy, with the skills, commands, hooks and MCP servers it brought.')
      : t('skills.plugins.removeText', 'The Antigravity CLI deletes its folder, with the skills, MCP servers and hooks it brought.'),
  installPane: (name) => (musePlugins.value ? t('skills.musePlugins.installPane', 'Muse plugin: {{name}}', { name }) : t('skills.plugins.installPane', 'Antigravity plugin: {{name}}', { name })),
  pickTitle: () =>
    musePlugins.value ? t('skills.musePlugins.pickTitle', 'Choose a plugin folder (with its .muse-plugin or .claude-plugin folder)') : t('skills.plugins.pickTitle', 'Choose a plugin folder (with a plugin.json)'),
  onHint: () => (musePlugins.value ? t('skills.musePlugins.onHint', 'On: Muse Code panes load it when they start.') : t('skills.plugins.onHint', 'On: Antigravity CLI panes load it when they start.')),
  offHint: () => (musePlugins.value ? t('skills.musePlugins.offHint', 'Off: Muse Code panes do not load it.') : t('skills.plugins.offHint', 'Off: Antigravity CLI panes do not load it.'))
}
const plugins = ref([])
const pluginsLoading = ref(false)
const pluginsLoaded = ref(false)
const pluginsError = ref('')
const pluginTarget = ref('')
async function loadPlugins() {
  const list = showPlugins.value ? pluginApi('list') : null
  if (!list) return
  pluginsLoading.value = true
  pluginsError.value = ''
  try {
    const res = await list()
    if (res && res.ok === false) pluginsError.value = res.error
    else {
      plugins.value = (res && res.plugins) || []
      if (res && res.error) pluginsError.value = res.error
    }
  } catch (err) {
    pluginsError.value = errorText(err)
  } finally {
    pluginsLoading.value = false
    pluginsLoaded.value = true
  }
}
function openPlugins(agent = 'antigravity') {
  if (pluginAgent.value !== agent) {
    pluginAgent.value = agent
    plugins.value = []
    pluginsError.value = ''
    pluginsLoaded.value = false
    pluginOpen.value = null
  }
  tab.value = 'plugins'
  loadPlugins()
}
const pluginsCountLabel = computed(() =>
  plugins.value.length === 1
    ? t('skills.plugins.count', '{{count}} plugin', { count: 1 })
    : t('skills.plugins.count', '{{count}} plugins', { count: plugins.value.length })
)
// What a plugin bundles: "2 skills", "1 MCP server"…
function pluginPartList(p) {
  const c = p.counts || {}
  const parts = []
  if (c.skills) parts.push(c.skills === 1 ? t('skills.plugins.skillOne', '1 skill') : t('skills.plugins.skillMany', '{{count}} skills', { count: c.skills }))
  if (c.mcpServers) parts.push(c.mcpServers === 1 ? t('skills.plugins.mcpOne', '1 MCP server') : t('skills.plugins.mcpMany', '{{count}} MCP servers', { count: c.mcpServers }))
  if (c.agents) parts.push(c.agents === 1 ? t('skills.plugins.agentOne', '1 subagent') : t('skills.plugins.agentMany', '{{count}} subagents', { count: c.agents }))
  if (c.hooks) parts.push(t('skills.plugins.hooks', 'hooks'))
  if (c.rules) parts.push(t('skills.plugins.rules', 'rules'))
  if (c.commands) parts.push(c.commands === 1 ? t('skills.plugins.commandOne', '1 command') : t('skills.plugins.commandMany', '{{count}} commands', { count: c.commands }))
  return parts
}
// Where Muse says a plugin came from (its install record's provenance), in words.
function museFrom(source) {
  if (source === 'native-local') return t('skills.musePlugins.fromFolder', 'Installed from a folder')
  if (source === 'foreign-import') return t('skills.musePlugins.fromImport', 'Imported from a Claude Code or Codex plugin')
  if (source === 'marketplace-user-added') return t('skills.musePlugins.fromMarketplace', 'From a marketplace')
  return source ? t('skills.plugins.from', 'From {{source}}', { source }) : ''
}
const pluginFrom = (p) => (musePlugins.value ? museFrom(p.source) : p.source ? t('skills.plugins.from', 'From {{source}}', { source: p.source }) : '')
const pluginParts = (p) => pluginPartList(p).join(' · ') || pluginFrom(p) || t('skills.plugins.nothing', 'Nothing listed in it.')

// One plugin open at a time, with the same keys as the skills list.
const pluginOpen = ref(null)
const pluginEls = []
const pluginRowId = (p) => `${uid}-plugin-${p.name.replace(/[^A-Za-z0-9_-]/g, '_')}` // i18n-ignore
const pluginDetailsId = (p) => `${uid}-plugin-details-${p.name.replace(/[^A-Za-z0-9_-]/g, '_')}` // i18n-ignore
function togglePluginRow(p, open = pluginOpen.value !== p.name) {
  pluginOpen.value = open ? p.name : null
}
function onPluginKey(e, i, p) {
  rowKeys(e, pluginEls, plugins.value.length, i, pluginOpen.value === p.name, (open) => togglePluginRow(p, open))
}
function onPluginEscape(e, p, i) {
  if (pluginOpen.value !== p.name) return
  e.preventDefault()
  e.stopPropagation()
  togglePluginRow(p, false)
  nextTick(() => pluginEls[i] && pluginEls[i].focus())
}
watch(plugins, (list) => {
  if (pluginOpen.value && !list.some((p) => p.name === pluginOpen.value)) pluginOpen.value = null
})

async function togglePlugin(p) {
  busy.value = `plugin:${p.name}` // i18n-ignore
  try {
    const res = await pluginApi('set')({ name: p.name, enabled: !p.enabled })
    if (res && res.ok) say(p.enabled ? pluginWords.turnedOff(p.name) : pluginWords.turnedOn(p.name))
    else say((res && res.error) || pluginWords.failed(), 'error')
  } finally {
    busy.value = ''
  }
  loadPlugins()
}
async function removePlugin(p) {
  const ok = await askConfirm({
    title: t('skills.plugins.removeConfirm', 'Uninstall the plugin "{{name}}"?', { name: p.name }),
    text: pluginWords.removeText(),
    confirmLabel: t('skills.plugins.uninstall', 'Uninstall'),
    danger: true
  })
  if (ok !== true) return
  busy.value = `plugin:${p.name}` // i18n-ignore
  try {
    const res = await pluginApi('remove')({ name: p.name })
    if (res && res.ok) say(t('skills.plugins.removed', 'Uninstalled "{{name}}".', { name: p.name }))
    else say((res && res.error) || pluginWords.failed(), 'error')
  } finally {
    busy.value = ''
  }
  loadPlugins()
}
// A marketplace name (name@antigravity-plugins-official, name@marketplace)
// or a folder: the install runs in a pane the user sees. Only a name or a
// plain path goes on the command line (nothing a shell would read as more).
const PLUGIN_TARGET = /^[A-Za-z0-9][A-Za-z0-9._@/-]{0,150}$/
const PLUGIN_FOLDER = /^[A-Za-z]:\\[^"'`$;&|<>%\r\n]{1,250}$/
function runPluginInstall(target) {
  const command = musePlugins.value ? `muse plugins install "${target}"` : `agy plugin install "${target}"` // i18n-ignore
  emit('run', { label: pluginWords.installPane(target), command })
}
function installPlugin() {
  const target = pluginTarget.value.trim()
  if (!PLUGIN_TARGET.test(target) && !PLUGIN_FOLDER.test(target)) {
    pluginsError.value = t('skills.plugins.badTarget', 'Enter a plugin name (name@marketplace) or a folder path.')
    return
  }
  pluginsError.value = ''
  runPluginInstall(target)
  say(t('skills.plugins.installing', 'Installing in a terminal. Refresh this list when it is done.'))
}
async function installPluginFolder() {
  const dir = await window.shellApi.pickFolder({ title: pluginWords.pickTitle() })
  if (!dir) return
  if (!PLUGIN_FOLDER.test(dir)) {
    pluginsError.value = t('skills.plugins.badFolder', 'This folder path has characters Tessel cannot pass on a command line.')
    return
  }
  pluginsError.value = ''
  runPluginInstall(dir)
  say(t('skills.plugins.installing', 'Installing in a terminal. Refresh this list when it is done.'))
}

// Escape closes the window; embedded in Settings, Settings handles it.
function onEscape(e) {
  if (props.embedded) return
  e.preventDefault()
  e.stopPropagation()
  emit('close')
}

onMounted(async () => {
  if (cardEl.value && !props.embedded) cardEl.value.focus()
  defaultTargets()
  await refresh()
  checkUpdates(false)
})
</script>

<template>
  <div :class="embedded ? 'mcp-embedded' : 'help-backdrop'" @pointerdown.self="embedded || emit('close')">
    <div
      ref="cardEl"
      :class="embedded ? 'mcp-embedded-body' : 'help-card mcp-card'"
      :role="embedded ? undefined : 'dialog'"
      :aria-label="embedded ? undefined : t('skills.title', 'Skills')"
      :tabindex="embedded ? undefined : -1"
      @keydown.escape="onEscape"
    >
      <div v-if="!embedded" class="help-head">
        <span>{{ t('skills.title', 'Skills') }}</span>
        <button class="tb-icon" :title="t('skills.close', 'Close (Esc)')" @click="emit('close')">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
          </svg>
        </button>
      </div>
      <p class="mcp-intro">
        {{
          t('skills.intro', 'Skills are folders of instructions (a SKILL.md) and files that agents load when a task needs them. Each agent reads them from its own skill folders, for all projects or for one project.')
        }}
      </p>

      <div class="mcp-tabbar">
        <div class="launch-seg">
          <button class="launch-seg-btn" :class="{ on: tab === 'installed' }" @click="tab = 'installed'">
            {{ t('skills.tab.installed', 'Installed') }}<span v-if="groups.length" class="mcp-count">{{ groups.length }}</span>
          </button>
          <button class="launch-seg-btn" :class="{ on: tab === 'add' }" data-test="skills-tab-add" @click="openAdd">
            {{ t('skills.tab.add', 'Add') }}
          </button>
          <button
            v-for="id in pluginAgents"
            :key="id"
            class="launch-seg-btn"
            :class="{ on: tab === 'plugins' && pluginAgent === id }"
            :data-test="id === 'muse' ? 'skills-tab-muse-plugins' : 'skills-tab-plugins'"
            @click="openPlugins(id)"
          >
            {{ id === 'muse' ? t('skills.tab.musePlugins', 'Muse plugins') : t('skills.tab.plugins', 'Antigravity plugins') }}
          </button>
        </div>
      </div>

      <p v-if="message.text" :class="message.kind === 'error' ? 'mcp-error' : 'mcp-notice'">{{ message.text }}</p>

      <!-- ================= Installed ================= -->
      <template v-if="tab === 'installed'">
        <div class="mcp-toolbar skills-toolbar">
          <input
            v-model="query"
            class="set-number skills-search"
            :placeholder="t('skills.installed.search', 'Search skills')"
            :aria-label="t('skills.installed.search', 'Search skills')"
            spellcheck="false"
          />
          <span class="set-hint skills-count" aria-live="polite">
            <template v-if="loading">{{ t('skills.loading', 'Loading…') }}</template>
            <template v-else>{{ countLabel }}</template>
            <span v-if="checkedLabel" class="skills-checked">· {{ checkedLabel }}</span>
          </span>
          <button
            type="button"
            class="exit-btn small"
            :disabled="loading || checking"
            :title="t('skills.installed.refreshHint', 'Read the skill folders again and check GitHub for updates')"
            @click="refreshAll"
          >
            {{ t('skills.installed.refresh', 'Refresh') }}
          </button>
        </div>

        <div v-if="showFilter" class="skills-filter" role="group" :aria-label="t('skills.filter.label', 'Show')">
          <button
            v-for="f in visibleFilters"
            :key="f"
            type="button"
            class="chip"
            :class="{ on: originFilter === f }"
            :aria-pressed="originFilter === f"
            :data-filter="f"
            @click="originFilter = f"
          >
            {{ filterLabel(f) }}<span class="chip-count">{{ counts[f] }}</span>
          </button>
        </div>

        <!-- The first read: placeholder rows, the size of real ones. -->
        <ul v-if="loading && !groups.length" class="sl-list" aria-busy="true" :aria-label="t('skills.loading', 'Loading…')">
          <li v-for="n in 3" :key="n" class="sl-item sl-skeleton" aria-hidden="true">
            <span class="sl-skel-icon" />
            <span class="sl-skel-lines"><span /><span /></span>
          </li>
        </ul>

        <div v-else-if="!groups.length" class="mcp-empty">
          {{ t('skills.installed.empty', 'No skills yet.') }}
          <button type="button" class="exit-btn primary small" @click="openAdd">{{ t('skills.installed.addOne', 'Add a skill') }}</button>
        </div>

        <div v-else-if="!shown.length" class="mcp-empty skills-nomatch">
          {{ t('skills.installed.noMatch', 'No skill matches this search or filter.') }}
          <button type="button" class="exit-btn small" @click="showAll">{{ t('skills.installed.showAll', 'Show every skill') }}</button>
        </div>

        <ul v-else class="sl-list" :aria-label="t('skills.installed.listLabel', 'Installed skills')">
          <li
            v-for="(g, i) in shown"
            :key="g.key"
            class="sl-item"
            :class="{ open: openKey === g.key }"
            :data-skill="g.name"
            @keydown.escape="onItemEscape($event, g, i)"
          >
            <button
              :id="rowId(g)"
              :ref="(el) => (rowEls[i] = el)"
              type="button"
              class="sl-row"
              :aria-expanded="openKey === g.key"
              :aria-controls="detailsId(g)"
              @click="toggleGroup(g)"
              @keydown="onRowKey($event, i, g)"
            >
              <BrandIcon class="sl-row-icon" :kind="'skill-' + g.name" accent="#8a93a6" :label="g.name" :size="20" />
              <span class="sl-row-main">
                <span class="sl-row-top">
                  <span class="sl-row-name">{{ g.name }}</span>
                  <span class="tag skills-origin" :class="originTag(g.kind)" :title="kindTitle(g)">{{ kindLabel(g.kind) }}</span>
                  <span v-if="g.modified" class="tag tag-warn" :title="t('skills.modified.hint', 'Changed on this computer since it was installed.')">{{
                    t('skills.modified.badge', 'Modified locally')
                  }}</span>
                  <span v-if="g.update" class="tag tag-update" :title="updateTitle(g.update)">{{ t('skills.updates.badge', 'Update available') }}</span>
                  <span v-if="g.partial" class="tag skills-partial" :title="partialHint">{{ t('skills.history.partialBadge', 'Partly kept') }}</span>
                </span>
                <span class="sl-row-desc" :title="g.description || undefined">{{ g.description || t('skills.installed.noDescription', 'No description.') }}</span>
              </span>
              <span class="sl-row-meta">
                <SkillTokenTag :skill="g" :cwd="project" />
                <span v-if="g.agents.length" class="sl-icons" role="img" :aria-label="seenByNames(g.agents)" :title="seenByNames(g.agents)">
                  <BrandIcon v-for="a in g.agents" :key="a" :kind="a" :size="14" />
                </span>
                <span v-for="s in g.scopes" :key="s" class="tag tag-scope">{{ scopeLabel(s) }}</span>
              </span>
              <svg class="sl-chevron" width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M6 3.5l4.5 4.5L6 12.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </button>

            <!-- Its details: the whole description, then each copy. -->
            <div v-if="openKey === g.key" :id="detailsId(g)" class="sl-details" role="region" :aria-labelledby="rowId(g)">
              <p class="sl-details-desc">{{ g.description || t('skills.installed.noDescription', 'No description.') }}</p>
              <div class="sl-section-head">
                <span>{{ t('skills.details.cost', 'Context cost') }}</span>
              </div>
              <SkillTokenTag :skill="g" :cwd="project" detailed class="skills-cost" />
              <div class="sl-section-head">
                <span>{{ t('skills.details.where', 'Where it is installed') }}</span>
                <button v-if="g.removable.length > 1" type="button" class="exit-btn small danger" :disabled="!!busy" @click="removeAll(g)">
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
                  </svg>
                  {{ t('skills.details.removeAll', 'Remove all') }}
                </button>
              </div>
              <p v-if="g.versions > 1" class="set-hint skills-versions-note">
                {{ versionsLabel(g.versions) }}
              </p>
              <ul class="sl-subs">
                <li v-for="copy in g.copies" :key="copy.id" class="sl-sub" :data-dir="copy.dir">
                  <div class="sl-sub-line">
                    <span v-if="agentsOf(copy).length" class="sl-icons" aria-hidden="true">
                      <BrandIcon v-for="a in agentsOf(copy)" :key="a" :kind="a" :size="14" />
                    </span>
                    <span class="skills-copy-agents" :title="seenByNames(agentsOf(copy))">{{ agentNames(agentsOf(copy)) }}</span>
                    <span class="tag tag-scope">{{ scopeLabel(copy.scope) }}</span>
                    <span class="tag skills-origin" :class="originTag(kindOf(copy))" :title="originTitle(copy)">{{ originLabel(copy) }}</span>
                    <span v-if="copy.link" class="tag muted">{{ t('skills.installed.link', 'Link') }}</span>
                    <span v-if="copy.modified" class="tag tag-warn" :title="t('skills.modified.hint', 'Changed on this computer since it was installed.')">{{
                      t('skills.modified.badge', 'Modified locally')
                    }}</span>
                    <span v-if="copy.update && copy.update.available" class="tag tag-update" :title="updateTitle(copy)">{{
                      t('skills.updates.badge', 'Update available')
                    }}</span>
                    <span v-if="copy.history && copy.history.partial" class="tag skills-partial" :title="partialHint">{{
                      t('skills.history.partialBadge', 'Partly kept')
                    }}</span>
                  </div>
                  <div class="sl-sub-foot">
                    <span class="sl-sub-path">
                      <span class="sl-path" :title="copy.dir">{{ shortPath(copy.dir) }}</span>
                      <button
                        type="button"
                        class="ws-icon-btn small skills-copy-btn"
                        :class="{ on: copiedDir === copy.dir }"
                        :title="copiedDir === copy.dir ? t('skills.details.copied', 'Copied') : t('skills.details.copyPath', 'Copy the path')"
                        :aria-label="t('skills.details.copyPath', 'Copy the path')"
                        @click="copyPath(copy)"
                      >
                        <svg v-if="copiedDir === copy.dir" width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                          <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
                        </svg>
                        <svg v-else width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                          <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" stroke="currentColor" stroke-width="1.2" />
                          <path d="M10.5 3.5V3A1.5 1.5 0 0 0 9 1.5H4A1.5 1.5 0 0 0 2.5 3v5A1.5 1.5 0 0 0 4 9.5h.5" stroke="currentColor" stroke-width="1.2" />
                        </svg>
                      </button>
                    </span>
                    <span class="sl-actions">
                      <button type="button" class="exit-btn small" @click="openFolder(copy)">
                        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                          <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.6l1.4 1.5h5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" />
                        </svg>
                        {{ t('skills.installed.open', 'Open folder') }}
                      </button>
                      <button
                        v-if="copy.removable && copy.source && copy.source.kind === 'github'"
                        type="button"
                        class="exit-btn small"
                        :class="{ primary: copy.update && copy.update.available }"
                        :disabled="!!busy"
                        @click="update(copy)"
                      >
                        {{ t('skills.installed.update', 'Update') }}
                      </button>
                      <button
                        v-if="copy.removable"
                        type="button"
                        class="ws-icon-btn small danger"
                        :title="t('skills.installed.remove', 'Remove')"
                        :aria-label="t('skills.details.removeCopy', 'Remove this copy')"
                        :disabled="!!busy"
                        @click="remove(copy)"
                      >
                        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                          <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
                        </svg>
                      </button>
                    </span>
                  </div>
                  <p v-if="copy.update && copy.update.available && updateTitle(copy)" class="set-hint skills-update-line">{{ updateTitle(copy) }}</p>
                  <div v-if="copy.history && copy.history.versions" class="set-hint skills-history-line">
                    {{ changedLabel(copy) }}
                    <button type="button" class="sl-link" :aria-expanded="historyOpen === copy.id" @click="toggleHistory(copy)">
                      {{ historyOpen === copy.id ? t('skills.history.hide', 'Hide history') : t('skills.history.show', 'History') }}
                    </button>
                  </div>

                  <!-- Its history: the versions kept, the chosen one against the one before. -->
                  <div v-if="historyOpen === copy.id" class="skills-history">
                    <p v-if="history.loading" class="set-hint">{{ t('skills.loading', 'Loading…') }}</p>
                    <p v-else-if="history.error" class="mcp-error">{{ history.error }}</p>
                    <p v-else-if="!history.versions.length" class="set-hint">{{ t('skills.history.none', 'No version kept yet.') }}</p>
                    <template v-else>
                      <p v-if="copy.history && copy.history.partial" class="mcp-about skills-warn">{{ partialHint }}</p>
                      <ul class="skills-versions">
                        <li v-for="v in history.versions" :key="v.id" class="skills-version" :class="{ on: history.selected === v.id }">
                          <button type="button" class="skills-version-pick" @click="showVersion(copy, v)">
                            <span class="skills-version-when">{{ dateTime(v.changedAt) }}</span>
                            <span class="set-hint">
                              {{ versionSummary(v) }}
                              <template v-if="!v.first">
                                · <span class="skills-plus">+{{ v.stats.plus }}</span> <span class="skills-minus">−{{ v.stats.minus }}</span>
                              </template>
                            </span>
                            <span v-if="v.latest" class="launch-tag muted">{{ t('skills.history.current', 'Current') }}</span>
                            <span v-if="v.note && noteLabel(v.note)" class="launch-tag muted">{{ noteLabel(v.note) }}</span>
                          </button>
                          <button
                            v-if="!v.latest && copy.removable && !(copy.history && copy.history.partial)"
                            type="button"
                            class="exit-btn small"
                            :disabled="!!busy"
                            @click="restoreVersion(copy, v)"
                          >
                            {{ t('skills.history.restore', 'Restore this version') }}
                          </button>
                        </li>
                      </ul>
                      <div class="skills-diff" aria-live="polite">
                        <p v-if="history.diffLoading" class="set-hint">{{ t('skills.loading', 'Loading…') }}</p>
                        <p v-else-if="history.diff && history.diff.error" class="mcp-error">{{ history.diff.error }}</p>
                        <template v-else-if="history.diff">
                          <p v-if="selectedVersion && selectedVersion.first" class="set-hint">
                            {{ t('skills.history.firstHint', 'The first version Tessel kept, shown whole.') }}
                          </p>
                          <p v-else-if="selectedVersion && selectedVersion.oldest" class="set-hint">
                            {{ t('skills.history.oldest', 'Older versions were dropped from the history: this one is shown whole.') }}
                          </p>
                          <p v-if="!history.diff.files.length" class="set-hint">{{ t('skills.history.noFiles', 'No file changed.') }}</p>
                          <div v-for="f in history.diff.files" :key="f.path" class="rv-diff skills-diff-file">
                            <div class="rv-diff-head">
                              <span class="rv-path">{{ f.path }}</span>
                              <span class="launch-tag muted">{{ statusLabel(f.status) }}</span>
                              <span v-if="!f.binary && !f.notKept" class="set-hint">
                                <span class="skills-plus">+{{ f.added }}</span> <span class="skills-minus">−{{ f.removed }}</span>
                              </span>
                            </div>
                            <p v-if="f.notKept" class="act-none">{{ t('skills.history.notKept', 'Too large to keep in the history: no diff.') }}</p>
                            <p v-else-if="f.binary" class="act-none">{{ t('skills.history.binary', 'Binary file: no text diff.') }}</p>
                            <p v-else-if="!f.hunks.length && !f.truncated" class="act-none">{{ t('skills.history.noLines', 'No line changed (line endings only).') }}</p>
                            <table v-else class="rv-table">
                              <tbody v-for="(h, hi) in f.hunks" :key="hi">
                                <tr class="rv-hunk">
                                  <td colspan="3">{{ h.header }}</td>
                                </tr>
                                <tr v-for="(l, li) in h.lines" :key="li" class="rv-line" :class="l.kind">
                                  <td class="rv-num">{{ l.old }}</td>
                                  <td class="rv-num">{{ l.new }}</td>
                                  <td class="rv-code"><span class="rv-sign">{{ l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' ' }}</span>{{ l.text }}</td>
                                </tr>
                              </tbody>
                            </table>
                            <p v-if="f.truncated" class="act-none">{{ t('skills.history.truncated', 'The diff is too long to show in full.') }}</p>
                          </div>
                        </template>
                      </div>
                    </template>
                  </div>
                </li>
              </ul>
            </div>
          </li>
        </ul>
      </template>

      <!-- ================= Antigravity / Muse plugins ================= -->
      <template v-else-if="tab === 'plugins'">
        <p class="set-hint skills-plugins-intro">{{ pluginWords.intro() }}</p>
        <form class="skills-plugin-form" @submit.prevent="installPlugin">
          <div class="skills-field" :class="{ invalid: !!pluginsError }">
            <svg class="skills-field-icon" width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M6 2v3M10 2v3M4.5 5h7v2.5a3.5 3.5 0 01-7 0zM8 11v3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
            <input
              v-model="pluginTarget"
              class="skills-field-input"
              :placeholder="pluginWords.placeholder()"
              :aria-label="t('skills.plugins.targetLabel', 'Plugin name or folder')"
              :aria-invalid="pluginsError ? 'true' : undefined"
              spellcheck="false"
              autocomplete="off"
              :data-test="musePlugins ? 'muse-plugin-target' : 'agy-plugin-target'"
            />
            <button class="exit-btn primary small skills-field-btn" type="submit" :disabled="!pluginTarget.trim()">{{ t('skills.plugins.install', 'Install') }}</button>
          </div>
          <button class="exit-btn small skills-plugin-folder" type="button" @click="installPluginFolder">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.6l1.4 1.5h5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" />
            </svg>
            {{ t('skills.plugins.fromFolder', 'From a folder…') }}
          </button>
        </form>
        <p v-if="pluginsError" class="skills-add-error" role="alert">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M8 2.2l6.2 11H1.8zM8 6.5v3.2M8 11.6h.01" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          <span>{{ pluginsError }}</span>
        </p>

        <div class="mcp-toolbar skills-toolbar">
          <span class="set-hint skills-count" aria-live="polite">
            <template v-if="pluginsLoading">{{ t('skills.loading', 'Loading…') }}</template>
            <template v-else-if="pluginsLoaded">{{ pluginsCountLabel }}</template>
          </span>
          <button type="button" class="exit-btn small" :disabled="pluginsLoading" @click="loadPlugins">{{ t('skills.installed.refresh', 'Refresh') }}</button>
        </div>

        <ul v-if="pluginsLoading && !plugins.length" class="sl-list" aria-busy="true" :aria-label="t('skills.loading', 'Loading…')">
          <li v-for="n in 2" :key="n" class="sl-item sl-skeleton" aria-hidden="true">
            <span class="sl-skel-icon" />
            <span class="sl-skel-lines"><span /><span /></span>
          </li>
        </ul>
        <div v-else-if="pluginsLoaded && !plugins.length && !pluginsError" class="mcp-empty">
          {{ pluginWords.empty() }}
        </div>
        <ul v-else-if="plugins.length" class="sl-list" :aria-label="t('skills.plugins.listLabel', 'Installed plugins')">
          <li
            v-for="(p, i) in plugins"
            :key="p.name"
            class="sl-item"
            :class="{ open: pluginOpen === p.name, off: !p.enabled }"
            :data-test="(musePlugins ? 'muse-plugin-' : 'agy-plugin-') + p.name"
            @keydown.escape="onPluginEscape($event, p, i)"
          >
            <button
              :id="pluginRowId(p)"
              :ref="(el) => (pluginEls[i] = el)"
              type="button"
              class="sl-row"
              :aria-expanded="pluginOpen === p.name"
              :aria-controls="pluginDetailsId(p)"
              @click="togglePluginRow(p)"
              @keydown="onPluginKey($event, i, p)"
            >
              <BrandIcon class="sl-row-icon" :kind="'plugin-' + p.name" accent="#8a93a6" :label="p.name" :size="20" />
              <span class="sl-row-main">
                <span class="sl-row-top">
                  <span class="sl-row-name">{{ p.label || p.name }}</span>
                  <span v-if="p.version" class="tag tag-scope">{{ p.version }}</span>
                  <span v-if="!p.enabled" class="tag tag-off">{{ t('skills.plugins.off', 'Turned off') }}</span>
                </span>
                <span class="sl-row-desc">{{ pluginParts(p) }}</span>
              </span>
              <svg class="sl-chevron" width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M6 3.5l4.5 4.5L6 12.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </button>
            <div v-if="pluginOpen === p.name" :id="pluginDetailsId(p)" class="sl-details" role="region" :aria-labelledby="pluginRowId(p)">
              <p v-if="p.description" class="sl-details-desc">{{ p.description }}</p>
              <p v-if="pluginFrom(p)" class="sl-details-desc">{{ pluginFrom(p) }}</p>
              <div class="sl-section-head">
                <span>{{ t('skills.plugins.bundles', 'What it brings') }}</span>
              </div>
              <div class="skills-plugin-parts">
                <span v-for="part in pluginPartList(p)" :key="part" class="tag">{{ part }}</span>
                <span v-if="!pluginPartList(p).length" class="set-hint">{{ t('skills.plugins.nothing', 'Nothing listed in it.') }}</span>
              </div>
              <div class="skills-plugin-foot">
                <span class="set-hint skills-plugin-state">
                  {{ p.enabled ? pluginWords.onHint() : pluginWords.offHint() }}
                </span>
                <span class="sl-actions">
                  <button type="button" class="exit-btn small" :disabled="!!busy" :data-test="musePlugins ? 'muse-plugin-toggle' : 'agy-plugin-toggle'" @click="togglePlugin(p)">
                    {{ p.enabled ? t('skills.plugins.turnOff', 'Turn off') : t('skills.plugins.turnOn', 'Turn on') }}
                  </button>
                  <button type="button" class="exit-btn small danger" :disabled="!!busy" :data-test="musePlugins ? 'muse-plugin-remove' : 'agy-plugin-remove'" @click="removePlugin(p)">
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
                    </svg>
                    {{ t('skills.plugins.uninstall', 'Uninstall') }}
                  </button>
                </span>
              </div>
            </div>
          </li>
        </ul>
      </template>

      <!-- ================= Add ================= -->
      <div v-else class="skills-add" :aria-busy="busy === 'install' ? 'true' : undefined">
        <!-- An update: what is updated, instead of a source to choose. -->
        <section v-if="updating" class="skills-updating" :aria-labelledby="uid + '-step-update'">
          <div class="skills-step-head">
            <h3 :id="uid + '-step-update'" class="skills-step-title">{{ updatingTitle }}</h3>
            <button type="button" class="sl-link skills-step-aside" @click="cancelUpdate">{{ t('skills.add.cancelUpdate', 'Back to the list') }}</button>
          </div>
          <span class="sl-path" :title="updating.dir">{{ shortPath(updating.dir) }}</span>
          <p v-if="busy === 'look'" class="set-hint skills-looking">
            <span class="skills-spinner" aria-hidden="true" />{{ t('skills.add.lookingUpdate', 'Getting the newest version from GitHub…') }}
          </p>
        </section>

        <!-- What was found, in one line, and a way to look somewhere else. -->
        <div v-else-if="hasResult && !editingSource" class="skills-source-summary" data-test="skills-source-summary">
          <svg v-if="from === 'github'" width="13" height="13" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" :d="GITHUB_ICON" /></svg>
          <svg v-else width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path :d="FOLDER_ICON" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" /></svg>
          <span class="skills-source-what" :title="candidates ? foundLabel : sourceTitle(preview.source)">{{ sourceWhat }}</span>
          <span v-if="candidates" class="set-hint skills-source-count">{{ listTotalLabel }}</span>
          <button type="button" class="sl-link skills-source-change" data-test="skills-change-source" @click="changeSource">{{ t('skills.add.changeSource', 'Change source') }}</button>
        </div>

        <!-- Where it comes from: GitHub or a folder, in one compact bar. -->
        <section v-else class="skills-source-bar" :aria-label="t('skills.add.stepSource', 'Where it comes from')">
          <div class="skills-sources" role="group" :aria-label="t('skills.add.sourceLabel', 'Add a skill from')">
            <button type="button" class="skills-source" :class="{ on: from === 'github' }" :aria-pressed="from === 'github'" data-source="github" @click="setFrom('github')">
              <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" :d="GITHUB_ICON" /></svg>
              GitHub
            </button>
            <button type="button" class="skills-source" :class="{ on: from === 'folder' }" :aria-pressed="from === 'folder'" data-source="folder" @click="setFrom('folder')">
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path :d="FOLDER_ICON" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" /></svg>
              {{ t('skills.add.folderTab', 'Folder') }}
            </button>
          </div>

          <form v-if="from === 'github'" class="skills-source-form" @submit.prevent="lookUp()">
            <div class="skills-field" :class="{ invalid: !!addError }">
              <input
                ref="repoEl"
                v-model="repoInput"
                class="skills-field-input"
                :placeholder="t('skills.add.repoPlaceholder', 'owner/repo, owner/repo/path or a github.com address')"
                :aria-label="t('skills.add.repo', 'Repository')"
                :aria-invalid="addError ? 'true' : undefined"
                :aria-describedby="addError ? uid + '-repo-hint ' + uid + '-add-error' : uid + '-repo-hint'"
                spellcheck="false"
                autocomplete="off"
                data-test="skills-repo"
              />
              <button class="exit-btn primary small skills-field-btn" type="submit" :disabled="!!busy || !repoInput.trim()" data-test="skills-look">
                <span v-if="busy === 'look'" class="skills-spinner" aria-hidden="true" />
                {{ busy === 'look' ? t('skills.add.looking', 'Looking…') : t('skills.add.look', 'Look up') }}
              </button>
            </div>
          </form>
          <div v-else class="skills-source-form skills-folder-row">
            <button type="button" class="exit-btn primary small skills-field-btn" :disabled="!!busy" data-test="skills-choose-folder" @click="chooseFolder">
              <span v-if="busy === 'look'" class="skills-spinner" aria-hidden="true" />
              {{ busy === 'look' ? t('skills.add.looking', 'Looking…') : t('skills.add.chooseFolder', 'Choose a folder…') }}
            </button>
            <span v-if="folderDir" class="sl-path" :title="folderDir">{{ shortPath(folderDir) }}</span>
          </div>
          <button v-if="editingSource" type="button" class="sl-link skills-source-cancel" @click="editingSource = false">{{ t('skills.add.keepSource', 'Cancel') }}</button>

          <!-- The empty state: a few repositories to start from. -->
          <div v-if="from === 'github'" :id="uid + '-repo-hint'" class="skills-source-foot">
            <span class="set-hint">{{ t('skills.add.suggestLabel', 'Try one:') }}</span>
            <button v-for="repo in SUGGESTED" :key="repo" type="button" class="chip skills-suggest" :disabled="!!busy" :data-repo="repo" @click="suggest(repo)">{{ repo }}</button>
            <span class="set-hint skills-hint-more">{{ t('skills.add.exampleMore', 'Add a folder path to pick one skill, or paste a github.com address.') }}</span>
          </div>
          <p v-else class="set-hint skills-source-foot">{{ t('skills.add.folderHint', 'A folder with a SKILL.md at its top') }}</p>
        </section>

        <p v-if="addError" :id="uid + '-add-error'" class="skills-add-error" role="alert">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M8 2.2l6.2 11H1.8zM8 6.5v3.2M8 11.6h.01" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          <span>{{ addError }}</span>
        </p>

        <!-- What was found: the list and the skill opened side by side (one
             skill: that skill alone; narrow: one, then the other). -->
        <div v-if="hasResult || (updating && (preview || results))" class="skills-browse" :class="{ single: !candidates, viewing }">
          <div v-if="candidates" class="skills-browse-list">
            <div class="skills-browse-top">
            <div class="skills-browse-head">
              <button
                type="button"
                role="checkbox"
                class="skills-check"
                :class="{ on: allShownSelected, mixed: !allShownSelected && someShownSelected }"
                :aria-checked="allShownSelected ? 'true' : someShownSelected ? 'mixed' : 'false'"
                :aria-label="t('skills.add.selectShown', 'Select all the skills shown')"
                :title="t('skills.add.selectShown', 'Select all the skills shown')"
                :disabled="!visibleCandidates.length"
                data-test="skills-select-all"
                @click="selectAllShown"
              >
                <svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path :d="allShownSelected ? CHECK_ICON : 'M3.5 8h9'" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" /></svg>
              </button>
              <input
                v-model="filter"
                class="skills-browse-filter"
                type="search"
                :placeholder="t('skills.add.filter', 'Filter the skills')"
                :aria-label="t('skills.add.filter', 'Filter the skills')"
                spellcheck="false"
                autocomplete="off"
                data-test="skills-filter"
              />
            </div>
            <p class="set-hint skills-browse-count" aria-live="polite">
              <span class="skills-browse-shown">{{ listCountLabel }}</span>
              <template v-if="selected.length">
                <span aria-hidden="true">·</span>
                <span class="skills-browse-selected">{{ selectedLabel }}</span>
                <button type="button" class="sl-link" data-test="skills-clear-selection" @click="selected = []">{{ t('skills.add.clearSelection', 'Clear') }}</button>
              </template>
            </p>
            </div>
            <ul class="sl-list skills-found" :aria-label="t('skills.add.foundLabel', 'Skills found')">
              <li
                v-for="(c, i) in visibleCandidates"
                :key="c.path"
                class="sl-item skills-cand"
                :class="{ open: pickedPath === c.path, checked: isSelected(c) }"
                :data-skill="c.name"
              >
                <button
                  type="button"
                  role="checkbox"
                  class="skills-check"
                  :class="{ on: isSelected(c) }"
                  :aria-checked="isSelected(c) ? 'true' : 'false'"
                  :aria-label="t('skills.add.selectSkill', 'Select {{name}}', { name: c.name })"
                  @click="toggleSelect(c)"
                >
                  <svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path :d="CHECK_ICON" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" /></svg>
                </button>
                <button
                  :id="candidateRowId(c)"
                  :ref="(el) => (foundEls[i] = el)"
                  type="button"
                  class="sl-row"
                  :aria-current="pickedPath === c.path ? 'true' : undefined"
                  :aria-controls="uid + '-detail'"
                  :title="c.path"
                  @click="pickCandidate(c)"
                  @keydown="onFoundKey($event, i, c)"
                >
                  <span class="sl-row-main">
                    <span class="sl-row-top">
                      <span class="sl-row-name">{{ c.name }}</span>
                      <span v-if="candidateStates[c.path]" class="tag" :class="candidateStates[c.path] === 'update' ? 'tag-update' : 'skills-installed'">{{ stateLabel(candidateStates[c.path]) }}</span>
                      <span class="set-hint skills-row-size">{{ itemSize(c) }}</span>
                    </span>
                    <span class="sl-row-desc">{{ c.description || t('skills.installed.noDescription', 'No description.') }}</span>
                  </span>
                </button>
              </li>
            </ul>
            <p v-if="!visibleCandidates.length" class="set-hint skills-browse-note">{{ t('skills.add.noMatch', 'No skill matches.') }}</p>
            <p v-if="moreThanShown" class="set-hint skills-browse-note">{{ moreLabel }}</p>
          </div>

          <div :id="uid + '-detail'" ref="detailEl" class="skills-browse-detail" role="region" :aria-label="preview ? preview.name : t('skills.add.detailLabel', 'The skill opened')" @keydown.escape="onDetailEscape">
            <button v-if="candidates" type="button" class="sl-link skills-back" data-test="skills-back" @click="backToList">
              <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M10 3.5L5.5 8l4.5 4.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" /></svg>
              {{ t('skills.add.back', 'All skills') }}
            </button>

            <!-- The result: skill by skill (several), folder by folder. -->
            <section v-if="results" ref="resultsEl" class="skills-results" :aria-label="t('skills.add.resultsLabel', 'Result')" aria-live="polite">
              <p class="skills-results-head">{{ resultsHead }}</p>
              <ul class="skills-result-skills">
                <li v-for="e in results" :key="e.key" class="skills-result-skill" :class="entryState(e)" :data-skill="e.name">
                  <div v-if="results.length > 1" class="skills-result-skill-head">
                    <svg class="skills-result-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.3" /><path :d="STATE_ICON[entryState(e)]" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
                    </svg>
                    <span class="skills-result-name">{{ e.name }}</span>
                    <span class="skills-result-state">{{ entrySummary(e) }}</span>
                  </div>
                  <p v-if="e.error" class="skills-result-error">{{ e.error }}</p>
                  <ul v-if="linesOf(e).length" class="skills-result-list">
                    <li v-for="r in linesOf(e)" :key="r.dir" class="skills-result" :class="r.ok ? 'ok' : r.exists ? 'exists' : 'failed'" :data-dir="r.dir">
                      <svg class="skills-result-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                        <circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.3" /><path :d="STATE_ICON[r.ok ? 'ok' : r.exists ? 'exists' : 'failed']" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
                      </svg>
                      <span class="skills-result-main">
                        <span class="skills-result-top">
                          <span class="sl-icons" aria-hidden="true"><BrandIcon v-for="a in resultAgents(r)" :key="a" :kind="a" :size="14" /></span>
                          <span class="skills-result-agents">{{ agentNames(resultAgents(r)) }}</span>
                          <span class="skills-result-state">{{ resultState(r) }}</span>
                        </span>
                        <span class="sl-path" :title="r.dir">{{ shortPath(r.dir) }}</span>
                        <span v-if="!r.ok && !r.exists && r.error" class="skills-result-error">{{ r.error }}</span>
                        <span v-if="r.exists" class="set-hint">{{ t('skills.add.existsHint', 'A skill with this name is already in this folder. Replace it, or keep it as it is.') }}</span>
                        <span v-if="alsoSeen(r).length" class="set-hint">{{ alsoSeenLabel(r) }}</span>
                      </span>
                      <button v-if="r.exists" type="button" class="exit-btn small" :disabled="!!busy" @click="replaceIn(e, r)">
                        <span v-if="busy === 'replace:' + r.dir" class="skills-spinner" aria-hidden="true" />
                        {{ t('skills.add.replace', 'Replace it') }}
                      </button>
                    </li>
                  </ul>
                </li>
              </ul>
              <div class="skills-results-foot">
                <button v-if="results.some((e) => e.results.some((r) => r.ok || r.exists))" type="button" class="exit-btn small" data-test="skills-view-installed" @click="viewInstalled">
                  {{ results.length > 1 ? t('skills.add.viewInstalledMany', 'View them in Installed') : t('skills.add.viewInstalled', 'View it in Installed') }}
                </button>
                <button v-if="!updating" type="button" class="sl-link" @click="addAnother">{{ t('skills.add.another', 'Add another skill') }}</button>
              </div>
            </section>

            <p v-if="candidates && !pickedPath && !results" class="skills-detail-empty">{{ t('skills.add.pickOne', 'Open a skill of the list to read what it does before installing it.') }}</p>
            <p v-else-if="busy === 'pick' && !preview" class="set-hint skills-looking"><span class="skills-spinner" aria-hidden="true" />{{ t('skills.loading', 'Loading…') }}</p>
            <p v-else-if="pickError" class="skills-add-error" role="alert"><span>{{ pickError }}</span></p>
            <div v-else-if="preview" class="skills-preview">
              <div class="skills-detail-head">
                <BrandIcon class="sl-row-icon" :kind="'skill-' + preview.name" accent="#8a93a6" :label="preview.name" :size="22" />
                <span class="skills-detail-title">
                  <h3 class="skills-detail-name">{{ preview.name }}</h3>
                  <span v-if="previewState" class="tag" :class="previewState === 'update' ? 'tag-update' : 'skills-installed'">{{ stateLabel(previewState) }}</span>
                </span>
                <button
                  v-if="candidates && pickedPath"
                  type="button"
                  role="checkbox"
                  class="exit-btn small skills-select-this"
                  :class="{ on: selectedSet.has(pickedPath) }"
                  :aria-checked="selectedSet.has(pickedPath) ? 'true' : 'false'"
                  data-test="skills-select-this"
                  @click="toggleSelect({ path: pickedPath })"
                >
                  <span class="skills-check" :class="{ on: selectedSet.has(pickedPath) }" aria-hidden="true">
                    <svg width="10" height="10" viewBox="0 0 16 16" fill="none"><path :d="CHECK_ICON" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" /></svg>
                  </span>
                  {{ t('skills.add.select', 'Select') }}
                </button>
              </div>
              <p class="sl-details-desc" :class="{ clamped: longDescription && !descOpen }">{{ description || t('skills.installed.noDescription', 'No description.') }}</p>
              <button v-if="longDescription" type="button" class="sl-link skills-desc-more" :aria-expanded="descOpen" @click="descOpen = !descOpen">
                {{ descOpen ? t('skills.preview.less', 'Show less') : t('skills.preview.more', 'Show more') }}
              </button>
              <div class="skills-pv-meta">
                <span class="tag skills-origin" :class="originTag(preview.source.kind === 'github' ? 'github' : 'folder')">{{ kindLabel(preview.source.kind === 'github' ? 'github' : 'folder') }}</span>
                <span class="skills-pv-source" :title="sourceTitle(preview.source)">{{ sourceShort(preview.source) }}</span>
                <button
                  type="button"
                  class="sl-link skills-pv-files"
                  :aria-expanded="filesOpen"
                  :aria-controls="uid + '-files'"
                  :title="t('skills.preview.filesHint', 'Show the files')"
                  @click="filesOpen = !filesOpen"
                >
                  {{ filesLabel(preview) }}
                </button>
              </div>
              <div class="skills-pv-cost">
                <span class="set-hint">{{ t('skills.preview.cost', 'Context cost, for the agents chosen to get it') }}</span>
                <SkillTokenTag :package-id="preview.id" :agents="chosenAgents" :cwd="project" />
              </div>
              <div v-if="filesOpen" :id="uid + '-files'" class="skills-files-box">
                <table class="skills-files">
                  <tbody>
                    <tr v-for="f in shownFiles" :key="f.path">
                      <td class="skills-file-path" :title="f.path">{{ f.path }}</td>
                      <td class="skills-file-size">{{ size(f.size) }}</td>
                    </tr>
                  </tbody>
                </table>
                <button v-if="preview.files.length > FILES_SHOWN" type="button" class="sl-link skills-files-all" data-test="skills-files-all" @click="filesAll = !filesAll">
                  {{ filesAll ? t('skills.preview.fewerFiles', 'Show fewer') : allFilesLabel }}
                </button>
              </div>

              <p v-if="updating && updating.modified" class="skills-callout warn skills-warn">
                {{ t('skills.update.modified', 'You changed this copy since it was installed. Updating replaces your changes; they stay in its history.') }}
              </p>
              <div v-if="updating && preview.changes" class="skills-changes">
                <p class="mcp-about">
                  <strong>{{ changesTitle(preview.changes) }}</strong>
                </p>
                <ul v-if="preview.changes.commits.length" class="skills-commits">
                  <li v-for="c in preview.changes.commits" :key="c.sha">
                    <span class="skills-commit-msg">{{ c.message }}</span>
                    <span class="set-hint">{{ c.author }} · {{ dateTime(c.date) }}</span>
                  </li>
                </ul>
                <p v-if="preview.changes.more" class="set-hint">{{ t('skills.update.more', 'Older commits are not listed: only the 30 newest are shown.') }}</p>
                <p v-if="!preview.changes.commits.length" class="set-hint">{{ t('skills.update.noCommits', 'No new commit touched this skill since your version.') }}</p>
              </div>

              <div class="skills-callout skills-safety">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M8 1.8l5 2v4.1c0 3.1-2.1 5.4-5 6.3-2.9-.9-5-3.2-5-6.3V3.8z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />
                  <path d="M8 5.2v3.3M8 10.6h.01" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
                </svg>
                <span class="skills-callout-text">{{ t('skills.preview.review', 'Read it before installing: an agent follows these instructions.') }}</span>
                <button type="button" class="exit-btn small skills-read-btn" :aria-expanded="mdOpen" :aria-controls="uid + '-md'" data-test="skills-read" @click="mdOpen = !mdOpen">
                  {{ mdOpen ? t('skills.preview.hideInstructions', 'Hide the instructions') : t('skills.preview.readInstructions', 'Read the instructions') }}
                </button>
              </div>
              <div v-if="mdOpen" :id="uid + '-md'" class="skills-md-box">
                <div class="skills-md-bar">
                  <span class="skills-md-file">{{ SKILL_FILE }}</span>
                  <button type="button" class="sl-link" :aria-pressed="mdSource" data-test="skills-source-toggle" @click="mdSource = !mdSource">
                    {{ mdSource ? t('skills.preview.viewFormatted', 'View formatted') : t('skills.preview.viewSource', 'View source') }}
                  </button>
                </div>
                <pre v-if="mdSource" class="skills-md" tabindex="0" :aria-label="t('skills.preview.sourceLabel', 'SKILL.md source')">{{ preview.skillMd }}</pre>
                <template v-else>
                  <dl v-if="frontmatter.meta.length" class="skills-fm">
                    <template v-for="m in frontmatter.meta" :key="m.key">
                      <dt>{{ m.key }}</dt>
                      <dd>{{ m.value }}</dd>
                    </template>
                  </dl>
                  <!-- eslint-disable-next-line vue/no-v-html (sanitized, no raw HTML: skillPreview.js) -->
                  <article class="skills-md-view" tabindex="0" :aria-label="t('skills.preview.instructionsLabel', 'Instructions of the skill')" @click="onMdClick" v-html="mdHtml"></article>
                </template>
              </div>

              <p v-if="preview.scripts.length" class="skills-callout warn skills-warn">{{ scriptsLabel(preview) }}</p>
              <div v-if="preview.setup.length" class="skills-callout skills-setup-box">
                <div class="skills-callout-text">
                  <strong>{{ t('skills.setup.title', 'It comes with a setup command.') }}</strong>
                  {{ t('skills.setup.body', 'Tessel does not run it. If you need it, run it yourself in a terminal and answer its questions there.') }}
                  <div v-for="cmd in preview.setup" :key="cmd" class="skills-setup">
                    <code class="mcp-preview">{{ cmd }}</code>
                    <button type="button" class="exit-btn small" @click="runSetup(cmd)">{{ t('skills.setup.button', 'Run its setup in a terminal') }}</button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Always in view, under what was found: the agents, the scope, and
             Install (the skills selected, or the one opened). -->
        <form class="skills-actionbar" data-test="skills-actionbar" @submit.prevent="install()">
          <div v-if="!updating" class="skills-bar-row">
            <span :id="uid + '-agents'" class="skills-field-label">{{ t('skills.add.agents', 'Agents') }}</span>
            <div class="skills-agent-chips" role="group" :aria-labelledby="uid + '-agents'">
              <button
                v-for="a in AGENTS"
                :key="a"
                type="button"
                class="skills-agent-chip"
                :class="{ on: targets[a], missing: !installed[a] }"
                :aria-pressed="targets[a]"
                :aria-label="agentChipLabel(a)"
                :title="agentChipLabel(a)"
                :data-agent="a"
                @click="toggleTarget(a)"
              >
                <BrandIcon :kind="a" :size="14" />
                <span class="skills-agent-name">{{ AGENT_NAME[a] }}</span>
                <svg class="skills-agent-check" width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path :d="CHECK_ICON" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </button>
            </div>
            <span v-if="chosenAgents.length && sharedNote" class="skills-info skills-shared-note" tabindex="0" role="note" :title="sharedNote" :aria-label="sharedNote">
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <circle cx="8" cy="8" r="6.2" stroke="currentColor" stroke-width="1.2" />
                <path d="M8 7.2v4M8 4.9h.01" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
              </svg>
            </span>
            <button type="button" class="sl-link skills-field-tools" data-test="skills-agents-all" @click="chooseAll(!allChosen)">
              {{ allChosen ? t('skills.add.selectNone', 'Select none') : t('skills.add.selectAll', 'Select all') }}
            </button>
          </div>
          <div class="skills-bar-row skills-bar-foot">
            <template v-if="!updating">
              <span :id="uid + '-scope'" class="skills-field-label">{{ t('skills.add.scope', 'Use it in') }}</span>
              <div class="skills-scopes" role="group" :aria-labelledby="uid + '-scope'">
                <button type="button" class="skills-scope-opt" :class="{ on: scope === 'user' }" :aria-pressed="scope === 'user'" data-scope="user" :title="t('skills.add.userHint', 'Every folder the agents open')" @click="scope = 'user'">
                  <span class="skills-scope-title">{{ t('skills.scope.user', 'All projects') }}</span>
                </button>
                <button
                  type="button"
                  class="skills-scope-opt"
                  :class="{ on: scope === 'project' }"
                  :aria-pressed="scope === 'project'"
                  :disabled="!project"
                  data-scope="project"
                  :title="project || t('skills.add.scopeHint', 'Open a project folder to add it to one project only')"
                  @click="scope = 'project'"
                >
                  <span class="skills-scope-title">{{ t('skills.scope.project', 'This project') }}</span>
                  <span class="skills-scope-sub">{{ projectName || t('skills.add.noProject', 'No project open') }}</span>
                </button>
              </div>
            </template>
            <span v-if="!updating && !chosenAgents.length" class="skills-info warn">{{ t('skills.add.chooseAgent', 'Choose at least one agent.') }}</span>
            <span v-else class="set-hint skills-foot-summary" :class="{ keep: !!updating }" :title="footSummary">{{ footSummary }}</span>
            <button
              v-if="!allDone"
              class="exit-btn primary small skills-install-btn"
              type="submit"
              :disabled="!!busy || !installItems.length || (!updating && !chosenAgents.length)"
              data-test="skills-install"
            >
              <span v-if="busy === 'install'" class="skills-spinner" aria-hidden="true" />
              {{ installText }}
            </button>
          </div>
        </form>
      </div>
    </div>
  </div>
</template>
<style scoped>
.skills-plugins-intro {
  margin: 0 0 8px;
}
.skills-search {
  flex: 1 1 auto;
  max-width: 260px;
}

/* The search, the count and Refresh: the count gives way first. */
.skills-toolbar {
  gap: 8px;
}
.skills-count {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.skills-checked {
  margin-left: 4px;
}

/* Origin filters: small chips, each with its count. */
.skills-filter {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin: 0 0 8px;
}
.skills-versions-note {
  margin: 0 0 6px;
}
.skills-copy-agents {
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  color: var(--text);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.skills-copy-btn {
  flex: 0 0 auto;
}
.skills-copy-btn.on {
  color: #8ff0b8;
}
.skills-update-line {
  margin: 0;
}
.skills-history-line {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

/* A message above the tab's content keeps its distance from it. */
.mcp-notice,
.mcp-error {
  margin-bottom: 6px;
}

/* The Add tab: the source in a compact bar, what was found (two panes for
   a repository of several skills), and the bar that installs, always in
   view. It follows its own width (a narrow page, or zoomed in): under
   760 px the list and the skill opened take turns. */
.skills-add {
  container-type: inline-size;
  container-name: skills-add;
  /* The card's padding around the tab: the install bar reaches its edges. */
  --skills-pad-x: 18px;
  --skills-pad-b: 14px;
  --skills-bar-bg: var(--surface-2);
}
.help-card .skills-add {
  --skills-pad-x: 20px;
  --skills-pad-b: 18px;
  --skills-bar-bg: var(--surface);
}
.skills-step-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  margin: 0 0 6px;
}
.skills-step-title {
  flex: 0 0 auto;
  margin: 0;
  color: var(--text-strong);
  font-size: 12.5px;
  font-weight: 600;
  white-space: nowrap;
}
.skills-step-aside {
  flex: 0 1 auto;
  min-width: 0;
  margin-left: auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.skills-updating {
  padding-top: 4px;
}
.skills-updating .sl-path {
  display: block;
}
.skills-looking {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 8px 0 0;
}

/* The source: GitHub or Folder, the box and its button on one line (the
   box under the tabs when narrow); suggestions and a hint under them. */
.skills-source-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 10px;
  padding-top: 4px;
}
.skills-source-form {
  flex: 1 1 300px;
  min-width: 0;
}
.skills-source-cancel {
  font-size: 12px;
}
.skills-source-foot {
  display: flex;
  flex-basis: 100%;
  flex-wrap: wrap;
  align-items: center;
  gap: 5px 6px;
  margin: 0;
  line-height: 1.5;
}
.skills-suggest {
  font-family: 'Cascadia Mono', Consolas, monospace;
  font-size: 11px;
}
/* Once looked up: what was found, in one line, and Change source. */
.skills-source-summary {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  min-height: 32px;
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--term);
  color: var(--text-dim);
  font-size: 12px;
}
.skills-source-summary > svg {
  flex: 0 0 auto;
}
.skills-source-what {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--text-strong);
  font-family: 'Cascadia Mono', Consolas, monospace;
  font-size: 11.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
  user-select: text;
}
.skills-source-count {
  flex: 0 0 auto;
  white-space: nowrap;
}
.skills-source-count::before {
  content: '· ';
}
.skills-source-change {
  margin-left: auto;
  font-size: 12px;
}

/* Step 1: GitHub or a folder (compact tabs), then one wide box with its
   button inside. */
.skills-sources {
  display: inline-flex;
  gap: 2px;
  flex: 0 0 auto;
  max-width: 100%;
  padding: 2px;
  border-radius: 8px;
  background: var(--term);
}
.skills-source {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 12px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text-dim);
  font: inherit;
  font-size: 12px;
  white-space: nowrap;
  cursor: pointer;
}
.skills-source:hover {
  color: var(--text-strong);
}
.skills-source.on {
  background: var(--surface-3);
  color: var(--text-strong);
  box-shadow: inset 0 0 0 1px var(--border-strong);
}
.skills-source:focus-visible,
.skills-agent-chip:focus-visible,
.skills-scope-opt:focus-visible,
.skills-check:focus-visible,
.skills-info:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.skills-field {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  height: 34px;
  padding: 0 3px 0 10px;
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  background: var(--term);
}
.skills-field:focus-within {
  border-color: var(--accent);
}
.skills-field.invalid {
  border-color: color-mix(in srgb, #ff9b9e 70%, transparent);
}
.skills-field-icon {
  flex: 0 0 auto;
  color: var(--text-dim);
}
.skills-field-input {
  flex: 1 1 auto;
  min-width: 0;
  height: 100%;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--text-strong);
  font: inherit;
  font-size: 12.5px;
  outline: none;
  -webkit-user-select: text;
  user-select: text;
}
.skills-field-input::placeholder {
  color: var(--text-dim);
  opacity: 0.8;
}
.exit-btn.skills-field-btn {
  height: 26px;
  padding: 0 12px;
}
.skills-field-hint {
  margin: 6px 0 0;
  line-height: 1.5;
}
.skills-hint-more {
  margin-left: 4px;
}
.skills-folder-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
  min-width: 0;
}
.skills-folder-row .sl-path {
  flex: 1 1 160px;
}
.skills-add-error {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  margin: 8px 0 0;
  padding: 7px 10px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--danger) 14%, transparent);
  color: #ffb4b6;
  font-size: 12px;
  line-height: 1.45;
  overflow-wrap: anywhere;
}
.skills-add-error svg {
  flex: 0 0 auto;
  margin-top: 2px;
}

/* What was found. A list: its skills (the rows of the Installed list, a
   box to select each) and the skill opened side by side, each scrolling
   on its own, as high as the window allows; narrow, one at a time. */
.skills-browse {
  margin-top: 12px;
}
.skills-browse-list,
.skills-browse-detail {
  min-width: 0;
}
.skills-browse-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 0 6px 8px;
}
.skills-browse-filter {
  flex: 1 1 auto;
  min-width: 0;
  height: 28px;
  padding: 0 9px;
  border: 1px solid var(--border-strong);
  border-radius: 7px;
  background: var(--term);
  color: var(--text-strong);
  font: inherit;
  font-size: 12px;
  outline: none;
}
.skills-browse-filter:focus {
  border-color: var(--accent);
}
.skills-browse-count {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px 6px;
  margin: 0;
  padding: 0 0 6px 8px;
}
.skills-browse-count .sl-link {
  font-size: 11.5px;
}
.skills-browse-note {
  margin: 8px 0;
  padding: 0 8px;
}
/* A box to select a skill (and one for all those shown). */
.skills-check {
  display: inline-grid;
  flex: 0 0 auto;
  place-items: center;
  width: 16px;
  height: 16px;
  padding: 0;
  border: 1.5px solid var(--border-strong);
  border-radius: 4px;
  background: transparent;
  color: #fff;
  cursor: pointer;
}
.skills-check svg {
  visibility: hidden;
}
.skills-check:hover {
  border-color: var(--text-dim);
}
.skills-check.on,
.skills-check.mixed {
  border-color: var(--accent);
  background: var(--accent);
}
.skills-check.on svg,
.skills-check.mixed svg {
  visibility: visible;
}
.skills-check:disabled {
  opacity: 0.4;
  cursor: default;
}
.skills-cand {
  display: flex;
  align-items: center;
  gap: 2px;
  padding-left: 8px;
}
.skills-cand > .sl-row {
  flex: 1 1 0;
  min-width: 0;
  min-height: 42px;
}
.skills-cand.checked > .sl-row:not(:hover) {
  background: color-mix(in srgb, var(--accent) 8%, transparent);
}
.sl-item.skills-cand.open > .sl-row {
  background: var(--surface-3);
  box-shadow: inset 2px 0 0 var(--accent);
}
.skills-cand .sl-row-top {
  flex-wrap: nowrap;
}
.skills-cand .sl-row-name {
  flex: 0 1 auto;
  min-width: 0;
}
.skills-cost {
  margin: 2px 0 8px;
}
.skills-pv-cost {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 8px 0 4px;
}
.skills-row-size {
  flex: 0 0 auto;
  margin-left: auto;
  padding-left: 6px;
  font-size: 11px;
  white-space: nowrap;
}
.skills-installed {
  background: color-mix(in srgb, #3fb950 18%, transparent);
  color: #7ee2a8;
}
/* The skill opened. */
.skills-back {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin: 2px 0 10px;
  font-size: 12px;
}
.skills-detail-empty {
  margin: 0;
  padding: 24px 8px;
  color: var(--text-dim);
  font-size: 12px;
  line-height: 1.5;
  text-align: center;
}
.skills-detail-head {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  margin-bottom: 6px;
}
.skills-detail-title {
  display: flex;
  flex: 1 1 auto;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px 8px;
  min-width: 0;
}
.skills-detail-name {
  min-width: 0;
  max-width: 100%;
  margin: 0;
  overflow: hidden;
  color: var(--text-strong);
  font-size: 15px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.exit-btn.skills-select-this {
  gap: 7px;
}
.skills-select-this .skills-check {
  width: 14px;
  height: 14px;
}
.skills-preview .sl-details-desc {
  margin: 0 0 4px;
}
.sl-details-desc.clamped {
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 4;
}
.skills-desc-more {
  margin-bottom: 8px;
  font-size: 11.5px;
}
.skills-preview .skills-pv-meta {
  margin-top: 6px;
}
.skills-files-box {
  margin: 2px 0 8px;
}
.skills-files-all {
  margin-top: 2px;
  font-size: 11.5px;
}
/* Narrow: the list, or the skill opened in its place. */
@container skills-add (max-width: 759px) {
  .skills-browse.viewing:not(.single) .skills-browse-list,
  .skills-browse:not(.viewing):not(.single) .skills-browse-detail {
    display: none;
  }
}
/* Wide: side by side in one frame, each pane scrolling on its own. */
@container skills-add (min-width: 760px) {
  .skills-browse:not(.single) {
    display: grid;
    grid-template-columns: minmax(250px, 36%) minmax(0, 1fr);
    /* The window's height less what is above and the install bar under it. */
    height: clamp(340px, calc(100vh - 400px), 1100px);
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: 10px;
  }
  .skills-browse:not(.single) .skills-browse-list {
    overflow-y: auto;
    border-right: 1px solid var(--border);
  }
  .skills-browse:not(.single) .skills-browse-top {
    position: sticky;
    top: 0;
    z-index: 1;
    padding-top: 8px;
    border-bottom: 1px solid var(--border);
    background: var(--skills-bar-bg);
  }
  .skills-browse:not(.single) .skills-browse-head,
  .skills-browse:not(.single) .skills-browse-count {
    padding-right: 8px;
    padding-left: 16px;
  }
  .skills-browse:not(.single) .skills-found {
    border-top: 0;
  }
  .skills-browse:not(.single) .skills-cand {
    padding-left: 16px;
  }
  .skills-browse:not(.single) .skills-browse-detail {
    padding: 12px 16px 16px;
    overflow-y: auto;
  }
  .skills-back {
    display: none;
  }
  /* The pane scrolls: the instructions are not a box of their own to scroll. */
  .skills-browse:not(.single) .skills-md-view,
  .skills-browse:not(.single) .skills-md {
    max-height: none;
  }
}
.skills-pv-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  min-width: 0;
  margin-bottom: 6px;
}
.skills-pv-source {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--text-dim);
  font-family: 'Cascadia Mono', Consolas, monospace;
  font-size: 10.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
  user-select: text;
}
.skills-pv-files {
  font-size: 11.5px;
}
.skills-files {
  width: 100%;
  max-width: 560px;
  border-collapse: collapse;
  font-size: 11.5px;
  table-layout: fixed;
}
.skills-files td {
  padding: 2px 0;
}
.skills-file-path {
  padding-right: 18px !important;
  overflow: hidden;
  color: var(--text);
  font-family: 'Cascadia Mono', Consolas, monospace;
  font-size: 10.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.skills-file-size {
  width: 72px;
  color: var(--text-dim);
  text-align: right;
  white-space: nowrap;
}
.skills-callout {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 8px;
  margin: 8px 0 0;
  padding: 7px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text);
  font-size: 12px;
  line-height: 1.45;
}
.skills-callout > svg {
  flex: 0 0 auto;
  color: var(--warn);
}
.skills-callout-text {
  flex: 1 1 220px;
  min-width: 0;
}
.skills-callout.warn {
  border-color: transparent;
  background: color-mix(in srgb, #d29922 14%, transparent);
}
.skills-warn {
  color: #ffd98f;
}
.skills-read-btn {
  margin-left: auto;
}
.skills-md-box {
  margin-top: 6px;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--term);
}
.skills-md-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  height: 28px;
  padding: 0 10px;
  border-bottom: 1px solid var(--border);
  color: var(--text-dim);
  font-size: 11px;
}
.skills-md-file {
  font-family: 'Cascadia Mono', Consolas, monospace;
  font-size: 10.5px;
}
.skills-fm {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 3px 12px;
  margin: 0;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  font-size: 11.5px;
  line-height: 1.45;
}
.skills-fm dt {
  color: var(--text-dim);
  font-family: 'Cascadia Mono', Consolas, monospace;
  font-size: 10.5px;
  line-height: 1.6;
}
.skills-fm dd {
  margin: 0;
  color: var(--text);
  overflow-wrap: anywhere;
  white-space: pre-line;
  user-select: text;
}
.skills-md-view,
.skills-md {
  max-height: 360px;
  overflow: auto;
}
.skills-md-view {
  padding: 4px 14px 10px;
  color: var(--text);
  font-size: 12.5px;
  line-height: 1.55;
  overflow-wrap: anywhere;
  user-select: text;
}
.skills-md-view:focus-visible,
.skills-md:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
.skills-md-view :deep(h1),
.skills-md-view :deep(h2),
.skills-md-view :deep(h3),
.skills-md-view :deep(h4) {
  margin: 1em 0 0.4em;
  color: var(--text-strong);
  line-height: 1.3;
}
.skills-md-view :deep(h1) {
  font-size: 16px;
}
.skills-md-view :deep(h2) {
  font-size: 14px;
}
.skills-md-view :deep(h3),
.skills-md-view :deep(h4) {
  font-size: 12.5px;
}
.skills-md-view :deep(p),
.skills-md-view :deep(ul),
.skills-md-view :deep(ol),
.skills-md-view :deep(blockquote),
.skills-md-view :deep(table) {
  margin: 0.5em 0;
}
.skills-md-view :deep(ul),
.skills-md-view :deep(ol) {
  padding-left: 20px;
}
.skills-md-view :deep(a) {
  color: var(--accent);
  cursor: pointer;
}
.skills-md-view :deep(code) {
  padding: 1px 4px;
  border-radius: 4px;
  background: var(--surface-3);
  font-family: 'Cascadia Mono', Consolas, monospace;
  font-size: 0.9em;
}
.skills-md-view :deep(pre) {
  padding: 8px 10px;
  overflow: auto;
  border-radius: 6px;
  background: var(--surface-2);
}
.skills-md-view :deep(pre code) {
  padding: 0;
  background: none;
}
.skills-md-view :deep(blockquote) {
  padding: 0 12px;
  border-left: 3px solid var(--border-strong);
  color: var(--text-dim);
}
.skills-md-view :deep(table) {
  border-collapse: collapse;
}
.skills-md-view :deep(th),
.skills-md-view :deep(td) {
  padding: 3px 8px;
  border: 1px solid var(--border-strong);
}
.skills-md-view :deep(hr) {
  border: 0;
  border-top: 1px solid var(--border);
}
/* Images are never loaded (their text shows instead). */
.skills-md-view :deep(img) {
  color: var(--text-dim);
  font-style: italic;
}
.skills-md {
  margin: 0;
  padding: 10px 12px;
  color: var(--text);
  font-family: 'Cascadia Mono', Consolas, monospace;
  font-size: 11px;
  white-space: pre-wrap;
  word-break: break-word;
  user-select: text;
}
.skills-setup {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
}
.skills-setup .mcp-preview {
  flex: 1 1 200px;
  min-width: 0;
  margin: 0;
}

/* The install bar: agent chips (the check and the colour say which are
   chosen), the scope as two segments, what Install installs and Install. */
.skills-field-label {
  color: var(--text-dim);
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  white-space: nowrap;
}
.skills-field-tools {
  flex: 0 0 auto;
  font-size: 11.5px;
}
.sl-link:disabled {
  color: var(--text-dim);
  text-decoration: none;
  opacity: 0.6;
  cursor: default;
}
.skills-agent-chips {
  display: flex;
  flex: 0 1 auto;
  flex-wrap: wrap;
  gap: 5px;
  min-width: 0;
}
.skills-agent-chip {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 9px 0 7px;
  border: 1px solid var(--border-strong);
  border-radius: 13px;
  background: transparent;
  color: var(--text-dim);
  font: inherit;
  font-size: 12px;
  white-space: nowrap;
  cursor: pointer;
}
.skills-agent-chip:hover {
  color: var(--text-strong);
  border-color: var(--text-dim);
}
.skills-agent-chip .brand-icon {
  opacity: 0.5;
  filter: grayscale(0.7);
}
.skills-agent-chip.on {
  border-color: color-mix(in srgb, var(--accent) 75%, transparent);
  background: color-mix(in srgb, var(--accent) 16%, transparent);
  color: var(--text-strong);
}
.skills-agent-chip.on .brand-icon {
  opacity: 1;
  filter: none;
}
.skills-agent-check {
  flex: 0 0 auto;
  color: var(--accent);
  visibility: hidden;
}
.skills-agent-chip.on .skills-agent-check {
  visibility: visible;
}
.skills-agent-chip.missing .skills-agent-name {
  font-style: italic;
}
.skills-info {
  display: inline-flex;
  flex: 0 1 auto;
  align-items: center;
  gap: 6px;
  min-width: 0;
  color: var(--text-dim);
  font-size: 11.5px;
  line-height: 1.45;
}
.skills-info svg {
  flex: 0 0 auto;
}
.skills-info.warn {
  color: #ffd98f;
}
.skills-shared-note {
  flex: 0 0 auto;
  border-radius: 50%;
  cursor: help;
}
.skills-scopes {
  display: inline-flex;
  flex: 0 1 auto;
  gap: 2px;
  min-width: 0;
  max-width: 100%;
  padding: 2px;
  border-radius: 8px;
  background: var(--term);
}
.skills-scope-opt {
  display: inline-flex;
  flex: 0 1 auto;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
  height: 24px;
  padding: 0 10px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text-dim);
  font: inherit;
  line-height: 24px;
  cursor: pointer;
}
.skills-scope-opt:hover:not(:disabled) {
  color: var(--text-strong);
}
.skills-scope-opt.on {
  background: var(--surface-3);
  color: var(--text-strong);
  box-shadow: inset 0 0 0 1px var(--border-strong);
}
.skills-scope-opt:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.skills-scope-title {
  flex: 0 0 auto;
  font-size: 12px;
  white-space: nowrap;
}
.skills-scope-sub {
  min-width: 0;
  max-width: 140px;
  overflow: hidden;
  color: var(--text-dim);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* The result: one line per folder; several skills, a line each and under it
   the folders that did not take it. */
.skills-results {
  margin: 0 0 12px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
}
.skills-results-head {
  margin: 0 0 6px;
  color: var(--text-strong);
  font-size: 12px;
  font-weight: 600;
}
.skills-result-skills,
.skills-result-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.skills-result-skill-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  font-size: 12px;
}
.skills-result-skill-head .skills-result-icon {
  margin-top: 0;
}
.skills-result-name {
  flex: 0 0 auto;
  min-width: 0;
  max-width: 50%;
  overflow: hidden;
  color: var(--text-strong);
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.skills-result-skill-head .skills-result-state {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  font-weight: 400;
  text-overflow: ellipsis;
}
.skills-result-skill > .skills-result-list {
  margin-top: 6px;
}
.skills-result-skills > .skills-result-skill:not(:only-child) > .skills-result-list,
.skills-result-skills > .skills-result-skill:not(:only-child) > .skills-result-error {
  padding-left: 22px;
}
.skills-result-skill.ok .skills-result-skill-head,
.skills-result-skill.ok .skills-result-skill-head .skills-result-state {
  color: #7ee2a8;
}
.skills-result-skill.exists .skills-result-skill-head {
  color: #ffd98f;
}
.skills-result-skill.failed .skills-result-skill-head {
  color: #ff9b9e;
}
.skills-result-skill-head .skills-result-name {
  color: var(--text-strong);
}
.skills-result {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 4px 8px;
  min-width: 0;
}
.skills-result-icon {
  flex: 0 0 auto;
  margin-top: 2px;
}
.skills-result.ok .skills-result-icon,
.skills-result.ok .skills-result-state {
  color: #7ee2a8;
}
.skills-result.exists .skills-result-icon,
.skills-result.exists .skills-result-state {
  color: #ffd98f;
}
.skills-result.failed .skills-result-icon,
.skills-result.failed .skills-result-state {
  color: #ff9b9e;
}
.skills-result-main {
  display: flex;
  flex: 1 1 200px;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.skills-result-top {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px 6px;
  font-size: 12px;
}
.skills-result-agents {
  color: var(--text);
  white-space: nowrap;
}
.skills-result-state {
  font-weight: 600;
  white-space: nowrap;
}
.skills-result-error {
  margin: 0;
  color: #ff9b9e;
  font-size: 11.5px;
  overflow-wrap: anywhere;
}
.skills-results-foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 14px;
  margin-top: 10px;
  font-size: 12px;
}
/* Always in view: stuck to the bottom of what scrolls (the Settings page,
   the window), across the card's whole width. */
.skills-actionbar {
  position: sticky;
  bottom: 0;
  z-index: 3;
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 12px calc(-1 * var(--skills-pad-x)) calc(-1 * var(--skills-pad-b));
  padding: 10px var(--skills-pad-x) 12px;
  border-top: 1px solid var(--border);
  border-radius: 0 0 10px 10px;
  background: var(--skills-bar-bg);
  box-shadow: 0 -10px 18px -14px rgba(0, 0, 0, 0.7);
}
.skills-bar-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
  min-width: 0;
}
.skills-foot-summary {
  flex: 1 1 160px;
  min-width: 0;
  overflow: hidden;
  line-height: 1.4;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.exit-btn.skills-install-btn {
  height: 30px;
  max-width: 100%;
  margin-left: auto;
  padding: 0 14px;
  overflow: hidden;
  font-size: 12.5px;
  text-overflow: ellipsis;
}
.skills-spinner {
  display: inline-block;
  flex: 0 0 auto;
  width: 11px;
  height: 11px;
  border: 1.5px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: skills-spin 0.8s linear infinite;
}
@keyframes skills-spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .skills-spinner {
    animation-duration: 2.4s;
  }
}
/* Narrow: a compact bar. The chips show their agent's icon (its name in
   the tooltip), the summary goes (the button says what it installs). */
@container skills-add (max-width: 620px) {
  .skills-agent-name,
  .skills-agent-check,
  .skills-scope-sub,
  .skills-foot-summary:not(.keep) {
    display: none;
  }
  .skills-agent-chip {
    padding: 0 8px;
  }
}

/* The Antigravity plugins tab: the same box as Add, then the same list as Installed. */
.skills-plugin-form {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 8px;
  margin: 0 0 4px;
}
.skills-plugin-form .skills-field {
  flex: 1 1 260px;
}
.exit-btn.skills-plugin-folder {
  height: 34px;
}
.sl-item.off .sl-row-name {
  color: var(--text-dim);
}
.skills-plugin-parts {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 8px;
}
.skills-plugin-foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
}
.skills-plugin-state {
  flex: 1 1 200px;
  min-width: 0;
}

/* A copy's history. */
.skills-history {
  margin: 2px 0 0;
  padding: 8px 10px;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
}
.skills-versions {
  max-height: 200px;
  margin: 0 0 8px;
  padding: 0;
  overflow: auto;
  list-style: none;
}
.skills-version {
  display: flex;
  align-items: center;
  gap: 8px;
  border-radius: 4px;
}
.skills-version.on {
  background: var(--surface-3);
}
.skills-version-pick {
  display: flex;
  flex: 1 1 auto;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 8px;
  min-width: 0;
  padding: 4px 6px;
  border: none;
  background: none;
  color: var(--text);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.skills-version-when {
  font-size: 12px;
}
.skills-plus {
  color: #7ee2a8;
}
.skills-minus {
  color: #ff9a9a;
}
.skills-diff {
  max-height: 420px;
  overflow: auto;
}
.skills-diff-file + .skills-diff-file {
  margin-top: 8px;
}
.skills-diff-file .rv-diff-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.skills-commits {
  max-height: 200px;
  margin: 4px 0;
  padding: 0 0 0 16px;
  overflow: auto;
}
.skills-commits li {
  margin: 2px 0;
}
.skills-commit-msg {
  margin-right: 8px;
}
</style>
