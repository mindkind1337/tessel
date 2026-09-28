<script setup>
// Review a finished task before it reaches the project: what the agent
// changed (files, commits, the diff of each file), whether it can merge into
// the branch it came from, then Merge, Request changes or Discard. Git work
// happens in the main process (src/main/review.js); App.vue does the actions.
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { parseUnifiedDiff } from '../../../shared/diff'
import { reviewMessage, commentLocation } from '../../../shared/reviewComments'
import { t, intlLocale } from '../i18n'

const props = defineProps({
  task: { type: Object, required: true },
  // '#2 Codex CLI', or '' when the agent pane is closed.
  agentLabel: { type: String, default: '' },
  // Functions from App.vue: requestChanges(text), resolveConflicts(info),
  // merge(info, { cleanup }) -> Promise<bool>, discard(info) -> Promise<bool>,
  // markDone(), focusAgent().
  actions: { type: Object, required: true }
})
const emit = defineEmits(['close'])

const wt = computed(() => props.task.worktree || null)
const args = computed(() =>
  wt.value
    ? { root: wt.value.root, path: wt.value.path, branch: wt.value.branch, target: wt.value.baseBranch || 'main' }
    : null
)

const info = ref(null)
const loading = ref(false)
const selected = ref('')
const diff = ref(null) // { file, parsed, truncated, error }
const diffLoading = ref(false)
const feedbackOpen = ref(false)
const feedback = ref('')
const cleanup = ref(true)
const busy = ref('')
const cardEl = ref(null)
const feedbackEl = ref(null)

// "Viewed" marks survive closing the panel (not a restart). A file whose
// content changes in a new commit is unmarked.
const viewed = viewedStore(props.task.id)

// Comments on diff lines (a click on a line number): kept like the viewed
// marks, all sent to the agent in one message with "Request changes".
const comments = commentsStore(props.task.id)
const draft = ref(null) // { file, line, side, code, text }
const draftEl = ref(null)
function lineRef(l) {
  // A removed line has only its old number; others point at the new file.
  return l.kind === 'del' ? { line: l.old, side: 'old' } : { line: l.new, side: 'new' }
}
function startComment(l) {
  if (!diff.value || l.kind === 'hunk') return
  const at = lineRef(l)
  if (!at.line) return
  draft.value = { file: diff.value.file, ...at, code: l.text, text: '' }
  setTimeout(() => draftEl.value && draftEl.value.focus(), 0)
}
function isDraftAt(l) {
  const d = draft.value
  if (!d || !diff.value || d.file !== diff.value.file) return false
  const at = lineRef(l)
  return d.line === at.line && d.side === at.side
}
function saveDraft() {
  const d = draft.value
  if (!d || !d.text.trim()) return
  comments.push({ file: d.file, line: d.line, side: d.side, code: d.code, text: d.text.trim(), id: `c${Date.now().toString(36)}` })
  draft.value = null
}
function commentsAt(l) {
  if (!diff.value) return []
  const at = lineRef(l)
  return comments.filter((c) => c.file === diff.value.file && c.line === at.line && c.side === at.side)
}
function removeComment(id) {
  const i = comments.findIndex((c) => c.id === id)
  if (i >= 0) comments.splice(i, 1)
}
const commentCount = computed(() => comments.length)

// One refresh at a time (the 5 s poll skips while one runs), so an older
// answer can never land after a newer one.
let refreshing = false
async function refresh() {
  if (!args.value || refreshing) return
  refreshing = true
  loading.value = true
  let next
  try {
    next = await window.shellApi.review.info(args.value)
  } catch (err) {
    next = { ok: false, error: err.message }
  } finally {
    refreshing = false
  }
  loading.value = false
  if (!next) next = { ok: false, error: t('review.noAnswer', 'No answer.') }
  const headChanged = !info.value || info.value.head !== next.head
  info.value = next
  if (!next.ok) return
  for (const f of next.files) {
    if (viewed[f.path] && viewed[f.path] !== sig(f)) delete viewed[f.path]
  }
  if (!next.files.some((f) => f.path === selected.value)) selected.value = next.files[0] ? next.files[0].path : ''
  else if (headChanged) loadDiff(selected.value)
}

function setViewed(f, on) {
  if (on) viewed[f.path] = sig(f)
  else delete viewed[f.path]
}

// A file's content id (git blob); without one, any new commit unmarks it.
function sig(f) {
  return f.blob ? `${f.status}:${f.blob}` : `${f.status}:${f.added}:${f.removed}:${info.value && info.value.head}`
}

async function loadDiff(file) {
  if (!file || !args.value) {
    diff.value = null
    return
  }
  diffLoading.value = true
  const res = await window.shellApi.review.diff({ ...args.value, file })
  diffLoading.value = false
  if (selected.value !== file) return
  diff.value = res && res.ok
    ? { file, parsed: parseUnifiedDiff(res.text), truncated: res.truncated }
    : { file, error: (res && res.error) || t('review.diffError', 'Could not read the diff.') }
}

watch(selected, (f) => loadDiff(f))

const totals = computed(() => {
  const files = (info.value && info.value.files) || []
  return {
    added: files.reduce((n, f) => n + f.added, 0),
    removed: files.reduce((n, f) => n + f.removed, 0)
  }
})
const viewedCount = computed(() =>
  info.value && info.value.ok ? info.value.files.filter((f) => viewed[f.path]).length : 0
)

// The state lines at the top: never green for something not checked.
const checks = computed(() => {
  const i = info.value
  if (!i) return [{ kind: 'wait', text: t('review.check.checking', 'Checking the branch…') }]
  if (!i.ok) return [{ kind: 'bad', text: i.error }]
  const out = []
  if (props.task.leadReview === 'approved')
    out.push({
      kind: 'ok',
      text: props.task.leadNote
        ? t('review.check.leadApprovedNote', 'Approved by the team lead: {{note}}', { note: props.task.leadNote })
        : t('review.check.leadApproved', 'Approved by the team lead.')
    })
  else if (props.task.leadReview === 'pending')
    out.push({ kind: 'info', text: t('review.check.leadPending', 'The team lead has not reviewed it yet.') })
  if (i.uncommitted.length) {
    const n = i.uncommitted.length
    out.push({
      kind: 'bad',
      text: t(
        'review.check.uncommitted',
        n > 1 ? "{{count}} files not committed in the agent's copy: {{files}}" : "{{count}} file not committed in the agent's copy: {{files}}",
        { count: n, files: short(i.uncommitted) }
      )
    })
  }
  if (!i.files.length) out.push({ kind: 'warn', text: t('review.check.noChanges', 'No committed changes on this branch yet.') })
  if (i.mergeCheck === 'failed') out.push({ kind: 'warn', text: i.blocker })
  else if (i.conflicts.length)
    out.push({
      kind: 'bad',
      text: t('review.check.conflicts', 'Conflicts with {{target}} in {{files}}.', { target: i.target, files: short(i.conflicts) })
    })
  else if (i.files.length) out.push({ kind: 'ok', text: t('review.check.noConflicts', 'No conflicts with {{target}}.', { target: i.target }) })
  if (i.behind)
    out.push({
      kind: 'info',
      text: t(
        'review.check.behind',
        i.behind > 1
          ? '{{target}} has {{count}} newer commits since this branch started.'
          : '{{target}} has {{count}} newer commit since this branch started.',
        { target: i.target, count: i.behind }
      )
    })
  if (i.rootBranch !== i.target)
    out.push({
      kind: 'bad',
      text: t('review.check.wrongBranch', 'The project folder is on branch {{branch}}; switch it to {{target}} to merge.', {
        branch: i.rootBranch || t('review.check.noBranch', '(none)'),
        target: i.target
      })
    })
  if (i.dirtyOverlap.length)
    out.push({
      kind: 'bad',
      text: t('review.check.dirtyOverlap', 'Unsaved changes in the project folder touch the same files: {{files}}.', {
        files: short(i.dirtyOverlap)
      })
    })
  if (i.merging) out.push({ kind: 'bad', text: t('review.check.merging', 'The project folder is in the middle of another merge.') })
  return out
})

function short(list) {
  return list.length > 3
    ? t('review.shortList', '{{first}} and {{count}} more', { first: list.slice(0, 3).join(', '), count: list.length - 3 })
    : list.join(', ')
}

const canMerge = computed(() => !!(info.value && info.value.ok && !info.value.blocker) && !busy.value)
const mergeTitle = computed(() =>
  info.value && info.value.ok
    ? info.value.blocker || t('review.mergeHint', 'Merge {{branch}} into {{target}}', { branch: info.value.branch, target: info.value.target })
    : t('review.checking', 'Checking…')
)

function openFeedback() {
  feedbackOpen.value = true
  setTimeout(() => feedbackEl.value && feedbackEl.value.focus(), 0)
}

function sendFeedback() {
  const text = reviewMessage(feedback.value, comments)
  if (!text) return
  props.actions.requestChanges(text)
  feedback.value = ''
  comments.splice(0)
  feedbackOpen.value = false
}

async function run(kind, fn) {
  if (busy.value) return
  busy.value = kind
  try {
    return await fn()
  } finally {
    busy.value = ''
  }
}

// Commit what the agent left uncommitted in its copy; push the branch to
// origin (for a pull request). The outcome shows under the checks.
const notice = ref(null) // { kind: 'ok'|'bad', text }
const commitOpen = ref(false)
const commitMsg = ref('')
async function commitCopy() {
  const message = commitMsg.value.trim()
  if (!message || !window.shellApi.review.commit) return
  const res = await run('commit', () => window.shellApi.review.commit({ ...args.value, message }))
  notice.value =
    res && res.ok
      ? { kind: 'ok', text: t('review.committed', "Committed in the agent's copy ({{sha}}).", { sha: res.sha.slice(0, 7) }) }
      : { kind: 'bad', text: (res && res.error) || t('review.commitFailed', 'Commit failed.') }
  if (res && res.ok) {
    commitOpen.value = false
    commitMsg.value = ''
  }
  refresh()
}
async function pushBranch() {
  if (!window.shellApi.review.push) return
  const res = await run('push', () => window.shellApi.review.push(args.value))
  notice.value =
    res && res.ok
      ? { kind: 'ok', text: t('review.pushed', 'Pushed {{branch}} to origin.', { branch: res.branch }) }
      : { kind: 'bad', text: (res && res.error) || t('review.pushFailed', 'Push failed.') }
}

const merge = () => run('merge', () => props.actions.merge(info.value, { cleanup: cleanup.value }))
const discard = () => run('discard', () => props.actions.discard(info.value))

function statusWord(s) {
  return s === 'A' ? t('review.status.added', 'Added') : s === 'D' ? t('review.status.deleted', 'Deleted') : t('review.status.modified', 'Modified')
}

function when(ms) {
  if (!ms) return ''
  const d = new Date(ms)
  return d.toLocaleString(intlLocale(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

// Header and labels with counts (kept out of the template: {{ }} placeholders).
function reviewTitle() {
  return t('review.title', 'Review: {{title}}', { title: props.task.title })
}
function countsText() {
  const c = info.value.commits.length
  const f = info.value.files.length
  const commits = t('review.commits', c === 1 ? '{{count}} commit' : '{{count}} commits', { count: c })
  const files = t('review.files', f === 1 ? '{{count}} file' : '{{count}} files', { count: f })
  return `· ${commits} · ${files}`
}
function viewedText() {
  return t('review.viewedCount', '{{viewed}}/{{total}} viewed', {
    viewed: viewedCount.value,
    total: info.value && info.value.ok ? info.value.files.length : 0
  })
}
function commentPlaceholder() {
  return t('review.commentPlaceholder', 'Comment on {{where}} (sent with Request changes)', { where: commentLocation(draft.value) })
}
function withCommentsText() {
  const count = commentCount.value
  return count > 1
    ? t('review.withComments', 'With your {{count}} comments on lines, each tied to its file and line.', { count })
    : t('review.withComment', 'With your {{count}} comment on lines, each tied to its file and line.', { count })
}
function mergeLabel() {
  return busy.value === 'merge'
    ? t('review.merging', 'Merging…')
    : t('review.mergeInto', 'Merge into {{branch}}', { branch: (wt.value && wt.value.baseBranch) || 'main' })
}

function onKey(e) {
  if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('.confirm-card')) return
  e.preventDefault()
  if (feedbackOpen.value && feedback.value.trim()) return
  if (feedbackOpen.value) feedbackOpen.value = false
  else emit('close')
}

let poll = null
onMounted(() => {
  window.addEventListener('keydown', onKey)
  if (cardEl.value) cardEl.value.focus()
  refresh()
  // The agent may still commit (after "Request changes", or late work).
  poll = setInterval(() => !busy.value && refresh(), 5000)
})
onBeforeUnmount(() => {
  clearInterval(poll)
  window.removeEventListener('keydown', onKey)
})
</script>

<script>
import { reactive } from 'vue'

const viewedByTask = new Map()
function viewedStore(taskId) {
  if (!viewedByTask.has(taskId)) viewedByTask.set(taskId, reactive({}))
  return viewedByTask.get(taskId)
}
const commentsByTask = new Map()
function commentsStore(taskId) {
  if (!commentsByTask.has(taskId)) commentsByTask.set(taskId, reactive([]))
  return commentsByTask.get(taskId)
}
</script>

<template>
  <div class="help-backdrop" @pointerdown.self="emit('close')">
    <div ref="cardEl" class="help-card rv-card" role="dialog" aria-labelledby="rv-title" tabindex="-1">
      <div class="help-head">
        <span class="notes-heading">
          <span id="rv-title">{{ reviewTitle() }}</span>
          <span class="notes-where">
            {{ agentLabel || t('review.agentClosed', 'Agent closed') }}
            <template v-if="wt"> · {{ wt.branch }} → {{ wt.baseBranch || 'main' }}</template>
            <template v-if="info && info.ok">
              {{ countsText() }}
              <span class="rv-plus">+{{ totals.added }}</span> <span class="rv-minus">−{{ totals.removed }}</span>
            </template>
          </span>
        </span>
        <span class="notes-tools">
          <span v-if="loading" class="notes-status">{{ t('review.checking', 'Checking…') }}</span>
          <button class="confirm-btn" :disabled="!agentLabel" :title="t('review.showAgentHint', 'Go to the agent\'s terminal')" @click="actions.focusAgent()">
            {{ t('review.showAgent', 'Show agent') }}
          </button>
          <button class="tb-icon" :title="t('review.closeEsc', 'Close (Esc)')" :aria-label="t('review.close', 'Close')" @click="emit('close')">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
            </svg>
          </button>
        </span>
      </div>

      <!-- A task done in the project folder itself: nothing to merge. -->
      <template v-if="!wt">
        <div class="rv-plain">
          <p v-if="task.brief" class="rv-brief">{{ task.brief }}</p>
          <p class="act-none">
            {{
              t(
                'review.direct',
                "This task was done directly in the project folder, not in its own copy, so there is no branch to merge. Its changes are the project's: review them in the Changes tab (each file's diff, review notes for the agent), then mark the task done or ask for changes."
              )
            }}
          </p>
          <button class="confirm-btn primary" data-test="rv-open-changes" @click="actions.openChanges && actions.openChanges()">
            {{ t('review.openChanges', 'Open the changes') }}
          </button>
        </div>
      </template>

      <template v-else>
        <ul class="rv-checks" :aria-label="t('review.checks', 'Checks')">
          <li v-for="(c, i) in checks" :key="i" class="rv-check" :class="c.kind">
            <span class="rv-check-mark" aria-hidden="true">{{
              c.kind === 'ok' ? '✓' : c.kind === 'bad' ? '!' : c.kind === 'warn' ? '!' : c.kind === 'wait' ? '…' : 'i'
            }}</span>
            <span>{{ c.text }}</span>
          </li>
        </ul>
        <div v-if="info && info.ok && info.uncommitted.length" class="rv-commit-bar">
          <template v-if="commitOpen">
            <input
              v-model="commitMsg"
              class="set-number rv-commit-msg"
              :placeholder="t('review.commitMessage', 'Commit message')"
              :aria-label="t('review.commitMessage', 'Commit message')"
              spellcheck="false"
              @keydown.enter.prevent="commitCopy"
            />
            <button class="confirm-btn" @click="commitOpen = false">{{ t('review.cancel', 'Cancel') }}</button>
            <button class="confirm-btn primary" :disabled="!commitMsg.trim() || !!busy" @click="commitCopy">
              {{ busy === 'commit' ? t('review.committing', 'Committing…') : t('review.commit', 'Commit') }}
            </button>
          </template>
          <button v-else class="confirm-btn" :disabled="!!busy" @click="commitOpen = true">{{ t('review.commitFiles', 'Commit these files…') }}</button>
        </div>
        <p v-if="notice" class="rv-notice" :class="notice.kind" role="status">{{ notice.text }}</p>
        <div v-if="info && info.ok && info.conflicts.length" class="notes-conflict" role="alert">
          <span>{{ t('review.conflictsBlock', "The branch cannot merge until the conflicts are resolved in the agent's copy.") }}</span>
          <button class="confirm-btn" :disabled="!agentLabel" @click="actions.resolveConflicts(info)">
            {{ t('review.askResolve', 'Ask the agent to resolve') }}
          </button>
        </div>

        <div class="rv-body">
          <div class="rv-side">
            <div v-if="task.brief" class="rv-section">
              <div class="rv-section-head">{{ t('review.task', 'Task') }}</div>
              <p class="rv-brief">{{ task.brief }}</p>
            </div>
            <div class="rv-section">
              <div class="rv-section-head">
                {{ t('review.filesHead', 'Files') }} <span class="act-count">{{ viewedText() }}</span>
              </div>
              <ul class="rv-files">
                <li
                  v-for="f in info && info.ok ? info.files : []"
                  :key="f.path"
                  class="rv-file"
                  :class="{ on: f.path === selected, viewed: viewed[f.path] }"
                >
                  <button class="rv-file-btn" :title="f.path" @click="selected = f.path">
                    <span class="rv-status" :class="'s-' + f.status" :title="statusWord(f.status)">{{ f.status }}</span>
                    <span class="rv-path">{{ f.path }}</span>
                    <span v-if="f.binary" class="act-dim">{{ t('review.bin', 'bin') }}</span>
                    <span v-else class="rv-counts"
                      ><span class="rv-plus">+{{ f.added }}</span> <span class="rv-minus">−{{ f.removed }}</span></span
                    >
                  </button>
                  <label class="rv-viewed" :title="viewed[f.path] ? t('review.viewed', 'Viewed') : t('review.markViewed', 'Mark as viewed')">
                    <input
                      type="checkbox"
                      :checked="!!viewed[f.path]"
                      :aria-label="t('review.viewedFile', 'Viewed {{path}}', { path: f.path })"
                      @change="setViewed(f, $event.target.checked)"
                    />
                  </label>
                </li>
                <li v-if="info && info.ok && !info.files.length" class="act-none">{{ t('review.noFiles', 'No files changed.') }}</li>
              </ul>
            </div>
            <div class="rv-section">
              <div class="rv-section-head">{{ t('review.commitsHead', 'Commits') }}</div>
              <ul class="rv-commits">
                <li v-for="c in info && info.ok ? info.commits : []" :key="c.sha" class="rv-commit">
                  <span class="rv-commit-subject">{{ c.subject }}</span>
                  <span class="act-dim">{{ c.sha.slice(0, 7) }} · {{ when(c.time) }}</span>
                  <span v-if="c.body" class="rv-commit-body">{{ c.body }}</span>
                </li>
                <li v-if="info && info.ok && !info.commits.length" class="act-none">{{ t('review.noCommits', 'No commits yet.') }}</li>
              </ul>
            </div>
          </div>

          <div class="rv-diff" aria-live="polite">
            <p v-if="!selected" class="act-none">{{ info ? t('review.nothing', 'Nothing to show.') : t('review.loading', 'Loading…') }}</p>
            <template v-else>
              <div class="rv-diff-head">
                <span class="rv-path">{{ selected }}</span>
                <span v-if="diffLoading" class="act-dim">{{ t('review.loading', 'Loading…') }}</span>
              </div>
              <p v-if="diff && diff.error" class="act-none">{{ diff.error }}</p>
              <p v-else-if="diff && diff.parsed.binary" class="act-none">{{ t('review.binary', 'Binary file: no text diff.') }}</p>
              <p v-else-if="diff && !diff.parsed.hunks.length" class="act-none">{{ t('review.noTextChanges', 'No text changes (mode or empty file).') }}</p>
              <table v-else-if="diff" class="rv-table">
                <tbody v-for="(h, hi) in diff.parsed.hunks" :key="hi">
                  <tr class="rv-hunk">
                    <td colspan="3">{{ h.header }}</td>
                  </tr>
                  <template v-for="(l, li) in h.lines" :key="li">
                    <tr class="rv-line" :class="l.kind">
                      <td class="rv-num rv-num-click" :title="t('review.commentLine', 'Comment on this line')" @click="startComment(l)">{{ l.old }}</td>
                      <td class="rv-num rv-num-click" :title="t('review.commentLine', 'Comment on this line')" @click="startComment(l)">{{ l.new }}</td>
                      <td class="rv-code"><span class="rv-sign">{{ l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' ' }}</span>{{ l.text }}</td>
                    </tr>
                    <tr v-for="c in commentsAt(l)" :key="c.id" class="rv-comment-row">
                      <td colspan="3">
                        <div class="rv-comment" data-test="line-comment">
                          <span class="rv-comment-text">{{ c.text }}</span>
                          <button class="rv-comment-del" :title="t('review.removeCommentHint', 'Remove this comment')" @click="removeComment(c.id)">{{ t('review.remove', 'Remove') }}</button>
                        </div>
                      </td>
                    </tr>
                    <tr v-if="isDraftAt(l)" class="rv-comment-row">
                      <td colspan="3">
                        <div class="rv-comment-draft">
                          <textarea
                            :ref="(el) => el && (draftEl = el)"
                            v-model="draft.text"
                            class="notes-editor rv-comment-input"
                            :placeholder="commentPlaceholder()"
                            :aria-label="t('review.commentLine', 'Comment on this line')"
                            @keydown.ctrl.enter.prevent="saveDraft"
                            @keydown.escape.stop.prevent="draft = null"
                          ></textarea>
                          <div class="confirm-actions">
                            <button class="confirm-btn" @click="draft = null">{{ t('review.cancel', 'Cancel') }}</button>
                            <button class="confirm-btn primary" :disabled="!draft.text.trim()" title="Ctrl+Enter" @click="saveDraft">{{ t('review.addComment', 'Add comment') }}</button>
                          </div>
                        </div>
                      </td>
                    </tr>
                  </template>
                </tbody>
              </table>
              <p v-if="diff && diff.truncated" class="act-none">{{ t('review.truncated', 'The diff is too long to show in full.') }}</p>
            </template>
          </div>
        </div>
      </template>

      <div v-if="feedbackOpen" class="rv-feedback">
        <textarea
          ref="feedbackEl"
          v-model="feedback"
          class="notes-editor rv-feedback-text"
          :placeholder="t('review.feedbackPlaceholder', 'What should the agent change? It gets this with the task, then shows the task for review again.')"
          :aria-label="t('review.feedbackLabel', 'Changes to request')"
          @keydown.ctrl.enter.prevent="sendFeedback"
        ></textarea>
        <p v-if="commentCount" class="rv-comment-note">
          {{ withCommentsText() }}
        </p>
        <div class="confirm-actions">
          <button class="confirm-btn" @click="feedbackOpen = false">{{ t('review.cancel', 'Cancel') }}</button>
          <button class="confirm-btn primary" :disabled="(!feedback.trim() && !commentCount) || !agentLabel" title="Ctrl+Enter" @click="sendFeedback">
            {{ t('review.send', 'Send to the agent') }}
          </button>
        </div>
      </div>

      <div class="rv-foot">
        <button v-if="wt" class="confirm-btn danger" :disabled="!!busy" @click="discard">
          {{ busy === 'discard' ? t('review.discarding', 'Discarding…') : t('review.discard', 'Discard…') }}
        </button>
        <button
          v-if="wt"
          class="confirm-btn"
          :disabled="!!busy || !(info && info.ok && info.commits.length)"
          :title="t('review.pushHint', 'Push the task branch to origin (to open a pull request)')"
          @click="pushBranch"
        >
          {{ busy === 'push' ? t('review.pushing', 'Pushing…') : t('review.push', 'Push branch') }}
        </button>
        <button v-if="wt && actions.createPr" class="confirm-btn" :disabled="!!busy" :title="t('review.createPrHint', 'Create a GitHub pull request from this task\'s copy')" @click="actions.createPr()">{{ t('review.createPr', 'Create PR…') }}</button>
        <span class="rv-spacer"></span>
        <label v-if="wt" class="rv-cleanup" :title="t('review.cleanupHint', 'After merging, close the agent and delete its copy and branch')">
          <input v-model="cleanup" type="checkbox" /> {{ t('review.cleanup', 'Close the agent and remove its copy after merging') }}
        </label>
        <button
          v-if="!feedbackOpen"
          class="confirm-btn"
          :disabled="!agentLabel || !!busy"
          :title="agentLabel ? t('review.feedbackHint', 'Send your feedback to the agent') : t('review.agentWasClosed', 'The agent was closed')"
          @click="openFeedback"
        >
          {{ t('review.requestChanges', 'Request changes…') }}<span v-if="commentCount" class="mcp-count" data-test="comment-count">{{ commentCount }}</span>
        </button>
        <button v-if="!wt" class="confirm-btn primary" @click="actions.markDone()">{{ t('review.markDone', 'Mark as done') }}</button>
        <button v-else class="confirm-btn primary" :disabled="!canMerge" :title="mergeTitle" @click="merge">
          {{ mergeLabel() }}
        </button>
      </div>
    </div>
  </div>
</template>
