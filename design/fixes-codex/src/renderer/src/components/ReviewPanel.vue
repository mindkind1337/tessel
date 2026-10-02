<script setup>
// Review a finished task before it reaches the project: what the agent
// changed (files, commits, the diff of each file), whether it can merge into
// the branch it came from, then Merge, Request changes or Discard. Git work
// happens in the main process (src/main/review.js); App.vue does the actions.
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { parseUnifiedDiff } from '../../../shared/diff'

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

async function refresh() {
  if (!args.value) return
  loading.value = true
  let next
  try {
    next = await window.shellApi.review.info(args.value)
  } catch (err) {
    next = { ok: false, error: err.message }
  }
  loading.value = false
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
    : { file, error: (res && res.error) || 'Could not read the diff.' }
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
  if (!i) return [{ kind: 'wait', text: 'Checking the branch…' }]
  if (!i.ok) return [{ kind: 'bad', text: i.error }]
  const out = []
  if (props.task.leadReview === 'approved')
    out.push({ kind: 'ok', text: `Approved by the team lead${props.task.leadNote ? `: ${props.task.leadNote}` : '.'}` })
  else if (props.task.leadReview === 'pending') out.push({ kind: 'info', text: 'The team lead has not reviewed it yet.' })
  if (i.uncommitted.length)
    out.push({
      kind: 'bad',
      text: `${i.uncommitted.length} file${i.uncommitted.length > 1 ? 's' : ''} not committed in the agent's copy: ${short(i.uncommitted)}`
    })
  if (!i.files.length) out.push({ kind: 'warn', text: 'No committed changes on this branch yet.' })
  if (i.mergeCheck === 'failed') out.push({ kind: 'warn', text: i.blocker })
  else if (i.conflicts.length)
    out.push({ kind: 'bad', text: `Conflicts with ${i.target} in ${short(i.conflicts)}.` })
  else if (i.files.length) out.push({ kind: 'ok', text: `No conflicts with ${i.target}.` })
  if (i.behind) out.push({ kind: 'info', text: `${i.target} has ${i.behind} newer commit${i.behind > 1 ? 's' : ''} since this branch started.` })
  if (i.rootBranch !== i.target)
    out.push({ kind: 'bad', text: `The project folder is on branch ${i.rootBranch || '(none)'}; switch it to ${i.target} to merge.` })
  if (i.dirtyOverlap.length)
    out.push({ kind: 'bad', text: `Unsaved changes in the project folder touch the same files: ${short(i.dirtyOverlap)}.` })
  if (i.merging) out.push({ kind: 'bad', text: 'The project folder is in the middle of another merge.' })
  return out
})

function short(list) {
  return list.length > 3 ? `${list.slice(0, 3).join(', ')} and ${list.length - 3} more` : list.join(', ')
}

const canMerge = computed(() => !!(info.value && info.value.ok && !info.value.blocker) && !busy.value)
const mergeTitle = computed(() =>
  info.value && info.value.ok ? info.value.blocker || `Merge ${info.value.branch} into ${info.value.target}` : 'Checking…'
)

function openFeedback() {
  feedbackOpen.value = true
  setTimeout(() => feedbackEl.value && feedbackEl.value.focus(), 0)
}

function sendFeedback() {
  const text = feedback.value.trim()
  if (!text) return
  props.actions.requestChanges(text)
  feedback.value = ''
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

const merge = () => run('merge', () => props.actions.merge(info.value, { cleanup: cleanup.value }))
const discard = () => run('discard', () => props.actions.discard(info.value))

function statusWord(s) {
  return s === 'A' ? 'Added' : s === 'D' ? 'Deleted' : 'Modified'
}

function when(ms) {
  if (!ms) return ''
  const d = new Date(ms)
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
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
</script>

<template>
  <div class="help-backdrop" @pointerdown.self="emit('close')">
    <div ref="cardEl" class="help-card rv-card" role="dialog" aria-labelledby="rv-title" tabindex="-1">
      <div class="help-head">
        <span class="notes-heading">
          <span id="rv-title">Review: {{ task.title }}</span>
          <span class="notes-where">
            {{ agentLabel || 'Agent closed' }}
            <template v-if="wt"> · {{ wt.branch }} → {{ wt.baseBranch || 'main' }}</template>
            <template v-if="info && info.ok">
              · {{ info.commits.length }} commit{{ info.commits.length === 1 ? '' : 's' }} ·
              {{ info.files.length }} file{{ info.files.length === 1 ? '' : 's' }}
              <span class="rv-plus">+{{ totals.added }}</span> <span class="rv-minus">−{{ totals.removed }}</span>
            </template>
          </span>
        </span>
        <span class="notes-tools">
          <span v-if="loading" class="notes-status">Checking…</span>
          <button class="confirm-btn" :disabled="!agentLabel" title="Go to the agent's terminal" @click="actions.focusAgent()">
            Show agent
          </button>
          <button class="tb-icon" title="Close (Esc)" aria-label="Close" @click="emit('close')">
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
            This task was done directly in the project folder, not in its own copy, so there is no branch to merge.
            Check the changes in the project (for example with git diff), then mark it done or ask for changes.
          </p>
        </div>
      </template>

      <template v-else>
        <ul class="rv-checks" aria-label="Checks">
          <li v-for="(c, i) in checks" :key="i" class="rv-check" :class="c.kind">
            <span class="rv-check-mark" aria-hidden="true">{{
              c.kind === 'ok' ? '✓' : c.kind === 'bad' ? '!' : c.kind === 'warn' ? '!' : c.kind === 'wait' ? '…' : 'i'
            }}</span>
            <span>{{ c.text }}</span>
          </li>
        </ul>
        <div v-if="info && info.ok && info.conflicts.length" class="notes-conflict" role="alert">
          <span>The branch cannot merge until the conflicts are resolved in the agent's copy.</span>
          <button class="confirm-btn" :disabled="!agentLabel" @click="actions.resolveConflicts(info)">
            Ask the agent to resolve
          </button>
        </div>

        <div class="rv-body">
          <div class="rv-side">
            <div v-if="task.brief" class="rv-section">
              <div class="rv-section-head">Task</div>
              <p class="rv-brief">{{ task.brief }}</p>
            </div>
            <div class="rv-section">
              <div class="rv-section-head">
                Files <span class="act-count">{{ viewedCount }}/{{ info && info.ok ? info.files.length : 0 }} viewed</span>
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
                    <span v-if="f.binary" class="act-dim">bin</span>
                    <span v-else class="rv-counts"
                      ><span class="rv-plus">+{{ f.added }}</span> <span class="rv-minus">−{{ f.removed }}</span></span
                    >
                  </button>
                  <label class="rv-viewed" :title="viewed[f.path] ? 'Viewed' : 'Mark as viewed'">
                    <input
                      type="checkbox"
                      :checked="!!viewed[f.path]"
                      :aria-label="`Viewed ${f.path}`"
                      @change="setViewed(f, $event.target.checked)"
                    />
                  </label>
                </li>
                <li v-if="info && info.ok && !info.files.length" class="act-none">No files changed.</li>
              </ul>
            </div>
            <div class="rv-section">
              <div class="rv-section-head">Commits</div>
              <ul class="rv-commits">
                <li v-for="c in info && info.ok ? info.commits : []" :key="c.sha" class="rv-commit">
                  <span class="rv-commit-subject">{{ c.subject }}</span>
                  <span class="act-dim">{{ c.sha.slice(0, 7) }} · {{ when(c.time) }}</span>
                  <span v-if="c.body" class="rv-commit-body">{{ c.body }}</span>
                </li>
                <li v-if="info && info.ok && !info.commits.length" class="act-none">No commits yet.</li>
              </ul>
            </div>
          </div>

          <div class="rv-diff" aria-live="polite">
            <p v-if="!selected" class="act-none">{{ info ? 'Nothing to show.' : 'Loading…' }}</p>
            <template v-else>
              <div class="rv-diff-head">
                <span class="rv-path">{{ selected }}</span>
                <span v-if="diffLoading" class="act-dim">Loading…</span>
              </div>
              <p v-if="diff && diff.error" class="act-none">{{ diff.error }}</p>
              <p v-else-if="diff && diff.parsed.binary" class="act-none">Binary file: no text diff.</p>
              <p v-else-if="diff && !diff.parsed.hunks.length" class="act-none">No text changes (mode or empty file).</p>
              <table v-else-if="diff" class="rv-table">
                <tbody v-for="(h, hi) in diff.parsed.hunks" :key="hi">
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
              <p v-if="diff && diff.truncated" class="act-none">The diff is too long to show in full.</p>
            </template>
          </div>
        </div>
      </template>

      <div v-if="feedbackOpen" class="rv-feedback">
        <textarea
          ref="feedbackEl"
          v-model="feedback"
          class="notes-editor rv-feedback-text"
          placeholder="What should the agent change? It gets this with the task, then shows the task for review again."
          aria-label="Changes to request"
          @keydown.ctrl.enter.prevent="sendFeedback"
        ></textarea>
        <div class="confirm-actions">
          <button class="confirm-btn" @click="feedbackOpen = false">Cancel</button>
          <button class="confirm-btn primary" :disabled="!feedback.trim() || !agentLabel" title="Ctrl+Enter" @click="sendFeedback">
            Send to the agent
          </button>
        </div>
      </div>

      <div class="rv-foot">
        <button v-if="wt" class="confirm-btn danger" :disabled="!!busy" @click="discard">
          {{ busy === 'discard' ? 'Discarding…' : 'Discard…' }}
        </button>
        <span class="rv-spacer"></span>
        <label v-if="wt" class="rv-cleanup" title="After merging, close the agent and delete its copy and branch">
          <input v-model="cleanup" type="checkbox" /> Close the agent and remove its copy after merging
        </label>
        <button
          v-if="!feedbackOpen"
          class="confirm-btn"
          :disabled="!agentLabel || !!busy"
          :title="agentLabel ? 'Send your feedback to the agent' : 'The agent was closed'"
          @click="openFeedback"
        >
          Request changes…
        </button>
        <button v-if="!wt" class="confirm-btn primary" @click="actions.markDone()">Mark as done</button>
        <button v-else class="confirm-btn primary" :disabled="!canMerge" :title="mergeTitle" @click="merge">
          {{ busy === 'merge' ? 'Merging…' : `Merge into ${wt.baseBranch || 'main'}` }}
        </button>
      </div>
    </div>
  </div>
</template>
