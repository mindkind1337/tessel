// Renaming a project and moving its folder (App.vue: renameWorkspace,
// setWorkspaceFolder). Pure checks, so they are tested without the window.
import { t } from './i18n'
import { remotePathError, remoteRootRefusal, isBareHome, localRootRefusal, isBareLocalHome, samePath } from './addProject'
import { INVISIBLE } from '../../shared/liveShareLink'

// A project's name: trimmed, no control characters, at most 80 characters
// (what Add a project keeps). '' when nothing usable is left.
export function cleanProjectName(raw) {
  // Control, bidi override/isolate, zero-width and line-separator characters out.
  return String(raw == null ? '' : raw).replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim().slice(0, 80)
}

// The host's answer to listing the chosen folder (remoteFs.browse) -> the
// path to keep, or { error } in words. Another project of this host on the
// same folder, or the same folder again, is refused.
// browsed: { ok, path } | { ok: false, error }; workspaces: every project.
export function checkRemoteFolder({ ws, picked, browsed, workspaces = [] }) {
  const typed = remotePathError(picked)
  if (typed) return { error: typed }
  if (!browsed || browsed.ok !== true) {
    return { error: (browsed && browsed.error) || t('project.error.generic', 'Something went wrong.') }
  }
  const path = String(browsed.path || '')
  // The host gives real absolute paths; anything else is not trusted.
  // eslint-disable-next-line no-control-regex
  if (!path.startsWith('/') || path.length > 1024 || /[\u0000-\u001f\u007f\\]/.test(path) || path.split('/').includes('..')) {
    return { error: t('project.remote.pathInvalid', 'This path has characters that cannot be used.') }
  }
  const refused = remoteRootRefusal(path)
  if (refused) return { error: refused }
  const same = (p) => p.replace(/\/+$/, '') || '/'
  if (ws.remote && same(ws.remote.path) === same(path)) return { error: t('project.remote.folder.same', 'This project already uses this folder.'), same: true }
  const other = workspaces.find((w) => w !== ws && w.remote && w.remote.hostId === ws.remote.hostId && same(w.remote.path) === same(path))
  if (other) return { error: t('project.remote.folder.other', 'The project "{{name}}" already uses this folder.', { name: other.name }) }
  return isBareHome(path) ? { path, confirmHome: true } : { path }
}

// The folder picked for a project on this computer, after main looked at it
// (addProject:checkFolder: it exists and is a folder). Another project on the
// same folder, or the same folder again, is refused; the roots and system
// folders too; a user's whole home folder asks first.
// checked: { ok, path, real } | { ok: false, error }; home: this account's home.
// -> { path } | { path, confirmHome: true } | { error, same? }
export function checkLocalFolder({ ws, checked, workspaces = [], home = '' }) {
  if (!checked || checked.ok !== true) {
    return { error: (checked && checked.error) || t('project.error.generic', 'Something went wrong.') }
  }
  const path = String(checked.path || '')
  const refused = localRootRefusal(path) || (checked.real && checked.real !== path ? localRootRefusal(checked.real) : '')
  if (refused) return { error: refused }
  const sameFolder = (dir) => !!dir && (samePath(dir, path) || (!!checked.real && samePath(dir, checked.real)))
  if (sameFolder(ws.cwd)) return { error: t('project.remote.folder.same', 'This project already uses this folder.'), same: true }
  const other = workspaces.find((w) => w !== ws && !w.remote && !w.liveShare && sameFolder(w.cwd))
  if (other) return { error: t('project.remote.folder.other', 'The project "{{name}}" already uses this folder.', { name: other.name }) }
  return isBareLocalHome(path, home) || (checked.real && isBareLocalHome(checked.real, home)) ? { path, confirmHome: true } : { path }
}
