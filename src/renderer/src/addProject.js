// "Add a project" in the interface: the hosts it can add on, its actions, and
// what a folder scan turns into. Ported from Orca (MIT, Copyright (c) 2026
// Lovecast Inc.): components/sidebar/add-repo-local-start-actions.ts,
// sidebar-host-options.ts (getSidebarHostHealthLabel),
// shared/execution-host.ts (getLocalExecutionHostLabel),
// components/repo/NestedRepoScanLimitNotice.tsx (nestedRepoScanLimitText),
// AddRepoCreateStep / create-project-defaults (joinCreateProjectPath) and
// project-groups/nested-repo-import.ts (only scanned paths are imported).
// The main process (src/main/addProject.js, remoteProject.js) checks
// everything again.
import { FolderOpen, Globe, Plus } from 'lucide-vue-next'
import { t } from './i18n'
import { hostStatus, statusLabel } from './remoteHosts'

export const LOCAL_HOST_ID = 'local'

// Orca's host list: this computer first, then the saved SSH hosts. Tessel has
// no lasting SSH connection (each terminal runs its own ssh), so every saved
// host can be picked; its status is what its open terminals say.
export function buildHostOptions(targets = [], states = {}) {
  const out = [
    {
      id: LOCAL_HOST_ID,
      kind: 'local',
      label: t('project.host.localWindows', 'Local Windows'),
      detail: t('project.host.thisComputer', 'This computer'),
      status: 'local'
    }
  ]
  for (const tg of targets || []) {
    if (!tg || typeof tg.id !== 'string') continue
    out.push({ id: tg.id, kind: 'ssh', label: tg.label || tg.host, detail: 'SSH', status: hostStatus(tg.id, states) })
  }
  return out
}

export function hostStatusText(host) {
  if (!host || host.status === 'local') return t('project.host.local', 'Local')
  return `${statusLabel(host.status)} - ${host.detail}`
}

// The start step's actions (Orca's getAddRepoLocalStartActions). On an SSH
// host, Clone and Create need files on that host: not available yet.
export function startActions(hostKind = 'local') {
  const ssh = hostKind === 'ssh'
  const primary = {
    kind: 'browse',
    icon: FolderOpen,
    title: ssh
      ? t('project.start.sshBrowseTitle', 'Open project on SSH host')
      : t('project.start.browseTitle', 'Browse folder'),
    description: ssh
      ? t('project.start.sshBrowseDescription', 'Existing Git repository or folder on this SSH host')
      : t('project.start.browseDescription', 'Local project, Git repo, or folder with many repos')
  }
  const unavailable = t('project.start.sshUnavailable', 'Not available for SSH hosts yet')
  const clone = {
    kind: 'clone',
    icon: Globe,
    title: t('project.start.cloneTitle', 'Clone from URL'),
    description: ssh ? unavailable : t('project.start.cloneDescription', 'Clone a remote Git repository'),
    disabled: ssh
  }
  const create = {
    kind: 'create',
    icon: Plus,
    title: t('project.start.createTitle', 'Create new project'),
    description: ssh ? unavailable : t('project.start.createDescription', 'Start from an empty folder'),
    disabled: ssh
  }
  return { primary, secondary: [clone, create] }
}

// --- Paths ------------------------------------------------------------------------
export function baseName(path) {
  const trimmed = String(path || '').replace(/[\\/]+$/, '')
  const parts = trimmed.split(/[\\/]/)
  return parts[parts.length - 1] || trimmed
}

// "C:\\projects" + "app" -> "C:\\projects\\app" (the separator the parent uses).
export function joinPath(parent, name) {
  const p = String(parent || '').trim()
  if (!p) return ''
  const sepChar = p.includes('/') && !p.includes('\\') ? '/' : '\\'
  return p.replace(/[\\/]+$/, '') + sepChar + name
}

export function samePath(a, b) {
  if (!a || !b) return false
  const norm = (p) => String(p).replace(/[\\/]+/g, '\\').replace(/\\$/, '').toLowerCase()
  return norm(a) === norm(b)
}

// A remote folder (remoteProject.js checks it again): absolute POSIX, "~" or
// "~/...", no control characters. -> '' when fine, else the reason.
export function remotePathError(raw) {
  const path = String(raw || '').trim()
  if (!path) return t('project.remote.pathRequired', 'Enter the path of a folder on this host.')
  // eslint-disable-next-line no-control-regex
  // A backslash too (the host's login shell reads the path; see remoteProject.js).
  if (path.length > 1024 || /[\u0000-\u001f\u007f\\]/.test(path)) return t('project.remote.pathInvalid', 'This path has characters that cannot be used.')
  if (!(path.startsWith('/') || path === '~' || path.startsWith('~/')))
    return t('project.remote.pathAbsolute', 'Use an absolute path like /home/user/project or ~/project.')
  return ''
}

export function remoteProjectName(path, hostLabel) {
  const p = String(path || '').trim()
  if (p === '~' || p === '~/' || p === '/') return hostLabel || p
  return baseName(p)
}

// A saved layout's project fields, checked (anything odd is dropped).
export function savedRemote(raw) {
  if (!raw || typeof raw !== 'object') return null
  if (typeof raw.hostId !== 'string' || !/^ssh-[\w-]{1,60}$/.test(raw.hostId)) return null
  if (typeof raw.path !== 'string' || !raw.path || remotePathError(raw.path)) return null
  return { hostId: raw.hostId, path: raw.path.trim() }
}
export function savedGroup(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.repos)) return null
  const repos = raw.repos
    .filter((r) => r && typeof r.path === 'string' && r.path && r.path.length <= 1024)
    .slice(0, 500)
    .map((r) => ({ path: r.path, name: typeof r.name === 'string' && r.name ? r.name.slice(0, 200) : baseName(r.path) }))
  return repos.length ? { repos } : null
}

// --- Nested repositories -------------------------------------------------------
export function newScanId() {
  return `scan-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export function repoCountLabel(count) {
  return count === 1
    ? t('project.nested.oneRepo', '1 repository')
    : t('project.nested.repoCount', '{{count}} repositories', { count })
}

export function foundSentence(scan) {
  return t('project.nested.found', 'Found {{repos}} in {{path}}.', { repos: repoCountLabel(scan.repos.length), path: scan.selectedPath })
}

// Orca's nestedRepoScanLimitText, in the interface's language.
export function scanLimitText(scan) {
  const stops = [
    t('project.nested.limitDepth', '{{count}} folder levels', { count: scan.maxDepth }),
    t('project.nested.limitRepos', '{{count}} repositories', { count: scan.maxRepos })
  ]
  if (scan.timeoutMs !== null && scan.timeoutMs !== undefined) {
    stops.push(
      scan.timeoutMs >= 1000 && scan.timeoutMs % 1000 === 0
        ? t('project.nested.limitSeconds', '{{count}} seconds', { count: scan.timeoutMs / 1000 })
        : t('project.nested.limitMs', '{{count}} ms', { count: scan.timeoutMs })
    )
  }
  return t('project.nested.limitText', 'Scan stops after {{limits}}. You can stop scanning early and import repositories found so far.', {
    limits: stops.join(t('project.nested.or', ' or '))
  })
}

// What the choice makes, as Tessel projects (workspaces):
// - separate: one project per selected repository (its folder);
// - group: ONE project on the chosen folder, named after the group, that
//   remembers its repositories (Orca: a project group whose parent folder
//   you work from);
// - folder: one project on the chosen folder, no repositories.
// Only paths the scan found are taken (a stale or forged selection is not).
export function planImport({ scan, selectedPaths, mode, groupName }) {
  const byPath = new Map((scan?.repos || []).map((r) => [r.path, r]))
  const chosen = []
  for (const p of selectedPaths || []) {
    const repo = byPath.get(p)
    if (repo && !chosen.includes(repo)) chosen.push(repo)
  }
  const parent = scan.selectedPath
  if (mode === 'folder') return [{ name: baseName(parent), cwd: parent }]
  if (!chosen.length) return []
  if (mode === 'group') {
    return [
      {
        name: String(groupName || '').trim() || baseName(parent),
        cwd: parent,
        group: { repos: chosen.map((r) => ({ path: r.path, name: r.displayName })) }
      }
    ]
  }
  return chosen.map((r) => ({ name: r.displayName, cwd: r.path }))
}
