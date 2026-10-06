// The git status the Changes tab shows, shared by the side panel (its count
// badge), the Changes tab and the diff tabs (which read their sides again
// after a stage, a discard or a commit). One request per folder at a time;
// an answer for a folder asked again since, or no longer shown, is dropped.
import { reactive } from 'vue'
import { t } from './i18n'

const api = () => window.shellApi && window.shellApi.scm

// key (lowercased path) -> { loading, loaded, error, data }
export const scmStatus = reactive({})
// Bumped after anything that changes the files or the index: diff tabs
// showing a side read from git load it again.
export const scmRevision = reactive({ value: 0 })

export const rootKey = (p) =>
  String(p || '')
    .replace(/[\\/]+/g, '\\')
    .replace(/\\+$/, '')
    .toLowerCase()

const seqs = {}
export function statusOf(root) {
  return root ? scmStatus[rootKey(root)] || null : null
}

// At most one status request per folder runs at a time, and at most one
// more waits behind it: refreshes asked meanwhile (focus, a change notice,
// a poll, two panels) share that next one. On a slow host (a remote
// project) they would otherwise pile up behind each other there.
const runs = {} // key -> { running, next }
function startRun(k, root) {
  const entry = { running: null, next: null }
  runs[k] = entry
  entry.running = readStatus(root).finally(() => {
    if (runs[k] === entry && !entry.next) delete runs[k]
  })
  return entry.running
}
export function refreshStatus(root) {
  if (!root || !api()) return Promise.resolve(null)
  const k = rootKey(root)
  const r = runs[k]
  if (!r) return startRun(k, root)
  // Asked after the running one started (a stage, a save…): its answer may
  // be stale, so the next run is the one that counts.
  if (!r.next) r.next = r.running.catch(() => null).then(() => startRun(k, root))
  return r.next
}

async function readStatus(root) {
  const k = rootKey(root)
  const my = (seqs[k] = (seqs[k] || 0) + 1)
  if (!scmStatus[k]) scmStatus[k] = { loading: true, loaded: false, error: '', data: null }
  else scmStatus[k].loading = true
  let res = null
  let failed = ''
  try {
    res = await api().status({ root })
  } catch (err) {
    failed = (err && err.message) || t('changes.status.failed', 'Git status failed.')
  }
  if (seqs[k] !== my || !scmStatus[k]) return null // a newer request, or forgotten
  const s = scmStatus[k]
  s.loading = false
  s.loaded = true
  if (!res || !res.ok) {
    // Never a clean copy without a status that worked.
    s.error = (res && res.error) || failed || t('changes.status.failed', 'Git status failed.')
    s.data = null
    return null
  }
  s.error = ''
  s.data = res
  return res
}

// Nothing more for this folder: a late answer is dropped.
export function forgetStatus(root) {
  const k = rootKey(root)
  seqs[k] = (seqs[k] || 0) + 1
  delete scmStatus[k]
}

export function bumpRevision() {
  scmRevision.value++
}

// The count on the Changes tab: every row the tab lists.
export function changeCount(data) {
  return data && data.repo && Array.isArray(data.entries) ? data.entries.length : 0
}
