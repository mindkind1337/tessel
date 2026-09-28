// i18n-pending: text here does not go through t() yet
// The git status the Changes tab shows, shared by the side panel (its count
// badge), the Changes tab and the diff tabs (which read their sides again
// after a stage, a discard or a commit). One request per folder at a time;
// an answer for a folder asked again since, or no longer shown, is dropped.
import { reactive } from 'vue'

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

export async function refreshStatus(root) {
  if (!root || !api()) return null
  const k = rootKey(root)
  const my = (seqs[k] = (seqs[k] || 0) + 1)
  if (!scmStatus[k]) scmStatus[k] = { loading: true, loaded: false, error: '', data: null }
  else scmStatus[k].loading = true
  let res = null
  let failed = ''
  try {
    res = await api().status({ root })
  } catch (err) {
    failed = (err && err.message) || 'Git status failed.'
  }
  if (seqs[k] !== my || !scmStatus[k]) return null // a newer request, or forgotten
  const s = scmStatus[k]
  s.loading = false
  s.loaded = true
  if (!res || !res.ok) {
    // Never a clean copy without a status that worked.
    s.error = (res && res.error) || failed || 'Git status failed.'
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
