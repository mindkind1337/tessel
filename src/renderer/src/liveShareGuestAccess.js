// What a Live Share guest may do in each host project it sees, for the panels
// that show that project (Files, Changes, the editor, Jump to file): the Live
// Share window sets it from the host's rights, and the panels read it for
// lshare:// paths (src/shared/liveSharePath.js). Local and SSH paths are never
// limited by it.
//
// Every right is off until the window says otherwise (the host gives each
// one), so a panel the window has not told anything yet stays read-only. A
// host's answer can only take away more: one saying readOnly (res.readOnly)
// keeps that panel read-only whatever this says.
//
//   lshareAccess[project] = { edit, git, tasks, state }
//     edit:  save, create, rename, move to the Recycle Bin
//     git:   stage, unstage, discard, commit
//     tasks: add, move, edit, delete cards, answer questions
//     state: 'ok' | 'no-access' (taken away) | 'outdated-host' (the host's
//            Tessel does not share this) | 'remote' (the project's folder
//            is on the host's SSH server: no files to share, nothing lost)
//            | 'ended' (the session is over)
import { reactive } from 'vue'
import { isLsharePath, parseLsharePath } from '../../shared/liveSharePath'
import { t } from './i18n'

export const ACCESS_STATES = ['ok', 'no-access', 'outdated-host', 'remote', 'ended']
const NONE = Object.freeze({ edit: false, git: false, tasks: false, state: 'ok' })

export const lshareAccess = reactive({})

// The window's word for one project (only the fields given change).
export function setLshareAccess(project, patch = {}) {
  if (typeof project !== 'string' || !project) return
  const cur = lshareAccess[project] || { ...NONE }
  const next = { ...cur }
  for (const k of ['edit', 'git', 'tasks']) if (typeof patch[k] === 'boolean') next[k] = patch[k]
  if (ACCESS_STATES.includes(patch.state)) next.state = patch.state
  lshareAccess[project] = next
}

// The session ended: every project's tabs keep their text, read-only and
// disconnected.
export function endLshareSession() {
  for (const p of Object.keys(lshareAccess)) lshareAccess[p] = { ...lshareAccess[p], edit: false, git: false, tasks: false, state: 'ended' }
}

// Forgotten (one project, or all of them).
export function forgetLshareAccess(project) {
  for (const p of Object.keys(lshareAccess)) if (project === undefined || p === project) delete lshareAccess[p]
}

// A path's access: null for a path of this computer (or an SSH host's).
export function accessOf(path) {
  if (!isLsharePath(path)) return null
  const p = parseLsharePath(path)
  if (!p) return { project: null, ...NONE, state: 'no-access' }
  return { project: p.project, ...(lshareAccess[p.project] || NONE) }
}

// A host's answer that says why it refused (guestFs.js codes): the state it
// means, or null. 'no-project': the project is not this guest's any more;
// 'bad-op': the host's Tessel does not know the request; 'remote-project':
// the project's folder is not one the host can share (an SSH host's).
export function stateOfAnswer(res) {
  const code = res && typeof res.code === 'string' ? res.code : ''
  if (code === 'remote-project') return 'remote'
  if (code === 'no-access' || code === 'no-project') return 'no-access'
  if (code === 'outdated-host' || code === 'bad-op') return 'outdated-host'
  return null
}

// What a panel says instead of the host's files ('' when it shows them).
export function accessStateText(state) {
  if (state === 'no-access') return t('liveShare.access.noAccess', 'You no longer have access to this project.')
  if (state === 'outdated-host') return t('liveShare.access.outdatedHost', 'The host’s Tessel is too old for this: the host needs to update Tessel.')
  if (state === 'remote') return t('liveShare.access.remote', 'This isn’t shared for a project on the host’s SSH server (guests get its files, not its Changes).')
  if (state === 'ended') return t('liveShare.access.ended', 'The Live Share session ended.')
  return ''
}

// How a panel shows that text: 'info' (calm) when nothing was lost,
// 'error' otherwise.
export const accessStateKind = (state) => (state === 'remote' ? 'info' : 'error')

// Actions that would run on this computer (reveal, open outside Tessel, a
// terminal here, VS Code, the PDF window, generating a commit message) mean
// nothing for a host's file.
export const localOnlyText = () => t('liveShare.access.localOnly', 'This works only on the host’s computer.')
