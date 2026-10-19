// A commit to show in Source Control (a commit link clicked: openTarget.js's
// 'commit' kind, App's openCommit): the Changes tab picks the repository it
// was found in (the project, or the task copy it is in) and its Commits
// section opens with that commit selected and its files shown
// (ChangesPanel.vue, ScmHistoryPanel.vue). One request at a time; each one
// is taken once, so a panel built again later does not show it again.
import { shallowRef } from 'vue'

export const commitFocusRequest = shallowRef(null) // { root, commit, n, taken }
let n = 0

export function requestCommitFocus({ root, commit }) {
  commitFocusRequest.value = { root, commit, n: ++n, taken: false }
}

// -> { root, commit, n } once, then null.
export function takeCommitFocus() {
  const req = commitFocusRequest.value
  if (!req || req.taken) return null
  req.taken = true
  return { root: req.root, commit: req.commit, n: req.n }
}
