<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

const props = defineProps({
  cwd: { type: String, default: '' },
  prCwd: { type: String, default: '' },
  prBase: { type: String, default: '' },
  agents: { type: Array, default: () => [] },
  defaultAgent: { type: String, default: '' },
  startIssue: { type: Function, default: null },
  initialMode: { type: String, default: '' }
})
const emit = defineEmits(['close', 'start', 'busy'])
const card = ref(null)
const connection = ref(null)
const kind = ref(props.initialMode === 'createPr' ? 'prs' : 'issues')
const preset = ref('all')
const query = ref('')
const items = ref([])
const truncated = ref(false)
const selected = ref(null)
const tab = ref('conversation')
const loading = ref(true)
const detailLoading = ref(false)
const busy = ref(false)
const error = ref('')
const notice = ref('')
const createdUrl = ref('')
const composer = ref(props.initialMode === 'createPr')
const title = ref('')
const body = ref('')
const base = ref(props.prBase)
const head = ref('')
const draft = ref(true)
const comment = ref('')
const confirmation = ref(null)
const method = ref('squash')
const agentId = ref(props.defaultAgent || props.agents[0]?.id || '')
const worktree = ref(true)
let alive = true
let listRequest = 0
let detailRequest = 0
let statusRequest = 0
let previousFocus
const connected = computed(() => connection.value?.available && connection.value?.authenticated)
const isPr = computed(() => kind.value === 'prs')
const api = () => window.shellApi.github
const failed = (result) => {
  if (!result?.ok) throw new Error(result?.error || 'GitHub request failed.')
  return result
}
const errorText = (err) => err?.message || 'GitHub request failed.'
function close() {
  if (!busy.value) emit('close')
}
function safeUrl(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}
async function openUrl(value) {
  const url = safeUrl(value)
  if (url) {
    try {
      await window.shellApi.openExternal(url)
    } catch {
      error.value = 'Could not open this link.'
    }
  }
}
async function copy(value, label = 'Link copied.') {
  try {
    await window.shellApi.writeClipboard(String(value))
    notice.value = label
  } catch {
    error.value = 'Could not copy to the clipboard.'
  }
}
function copyIssue() {
  const item = selected.value
  copy(
    `#${item.number} ${item.title}\n${item.url}\n\n${item.body || ''}`,
    isPr.value ? 'Pull request copied.' : 'Issue copied.'
  )
}
async function loadStatus() {
  const request = ++statusRequest
  loading.value = true
  error.value = ''
  try {
    if (!window.shellApi.github)
      throw new Error('GitHub integration is not available in this version.')
    const result = failed(await api().status({ cwd: props.cwd }))
    if (!alive || request !== statusRequest) return
    connection.value = result
    if (!base.value) base.value = result.repo?.defaultBranch || ''
    if (connected.value && !composer.value) await loadList()
  } catch (err) {
    if (alive && request === statusRequest) error.value = errorText(err)
  } finally {
    if (alive && request === statusRequest && (!connected.value || composer.value))
      loading.value = false
  }
}
async function loadList() {
  if (!connected.value) return
  const request = ++listRequest
  loading.value = true
  error.value = ''
  try {
    const result = failed(
      await api().list({
        cwd: props.cwd,
        kind: kind.value,
        preset: preset.value,
        query: query.value.trim()
      })
    )
    if (alive && request === listRequest) {
      items.value = result.items || []
      truncated.value = !!result.truncated
    }
  } catch (err) {
    if (alive && request === listRequest) error.value = errorText(err)
  } finally {
    if (alive && request === listRequest) loading.value = false
  }
}
async function loadDetail(item = selected.value) {
  if (!item) return
  const request = ++detailRequest
  selected.value = item
  detailLoading.value = true
  error.value = ''
  tab.value = 'conversation'
  if (isPr.value) worktree.value = true
  try {
    const result = failed(
      await api().detail({ cwd: props.cwd, kind: kind.value, number: item.number })
    )
    if (alive && request === detailRequest) selected.value = { ...item, ...result.item }
  } catch (err) {
    if (alive && request === detailRequest) error.value = errorText(err)
  } finally {
    if (alive && request === detailRequest) detailLoading.value = false
  }
}
function back() {
  if (busy.value) return
  detailRequest++
  selected.value = null
  composer.value = false
  confirmation.value = null
  comment.value = ''
  error.value = ''
  detailLoading.value = false
}
function beginCreate() {
  composer.value = true
  selected.value = null
  title.value = ''
  body.value = ''
  head.value = ''
  draft.value = true
  error.value = ''
  notice.value = ''
}
async function create() {
  if (!title.value.trim() || busy.value || (isPr.value && !base.value.trim())) return
  busy.value = true
  error.value = ''
  try {
    const result = failed(
      await (isPr.value
        ? api().createPr({
            cwd: props.prCwd || props.cwd,
            title: title.value.trim(),
            body: body.value,
            base: base.value.trim(),
            ...(head.value.trim() ? { head: head.value.trim() } : {}),
            draft: draft.value
          })
        : api().createIssue({ cwd: props.cwd, title: title.value.trim(), body: body.value }))
    )
    if (!alive) return
    composer.value = false
    createdUrl.value = result.url || ''
    notice.value = isPr.value ? 'Pull request created.' : 'Issue created.'
    await loadList()
  } catch (err) {
    if (alive) error.value = errorText(err)
  } finally {
    if (alive) busy.value = false
  }
}
function askAction(action) {
  confirmation.value = action
  error.value = ''
}
const actionLabels = {
  close: 'Close',
  reopen: 'Reopen',
  merge: 'Merge pull request',
  autoMerge: 'Enable auto-merge',
  rerunFailed: 'Rerun failed checks',
  rerunAll: 'Rerun all checks'
}
async function runAction(action, extra = {}) {
  if (busy.value || !selected.value) return
  busy.value = true
  error.value = ''
  try {
    failed(
      await api().action({
        cwd: props.cwd,
        kind: kind.value,
        number: selected.value.number,
        action,
        ...extra
      })
    )
    if (!alive) return
    confirmation.value = null
    comment.value = ''
    notice.value = action === 'comment' ? 'Comment posted.' : 'GitHub updated.'
    await loadDetail()
  } catch (err) {
    if (alive) error.value = errorText(err)
  } finally {
    if (alive) busy.value = false
  }
}
async function refreshChecks() {
  if (!selected.value || busy.value) return
  busy.value = true
  error.value = ''
  try {
    const result = failed(await api().checks({ cwd: props.cwd, number: selected.value.number }))
    if (alive) selected.value = { ...selected.value, checks: result.checks || [] }
  } catch (err) {
    if (alive) error.value = errorText(err)
  } finally {
    if (alive) busy.value = false
  }
}
async function start() {
  if (busy.value || !agentId.value || !selected.value) return
  const request = {
    provider: 'github',
    item: selected.value,
    agentId: agentId.value,
    worktree: isPr.value ? true : worktree.value
  }
  busy.value = true
  error.value = ''
  try {
    if (!props.startIssue) {
      emit('start', request)
      notice.value = 'Task preparation requested.'
      return
    }
    failed(await props.startIssue(request))
    if (alive) emit('close')
  } catch (err) {
    if (alive) error.value = errorText(err)
  } finally {
    if (alive) busy.value = false
  }
}
function onKey(event) {
  if (event.key === 'Escape') {
    event.stopPropagation()
    close()
    return
  }
  if (event.key !== 'Tab') return
  const controls = [...card.value.querySelectorAll('button,input,select,textarea,a[href]')].filter(
    (el) => !el.disabled
  )
  const first = controls[0],
    last = controls.at(-1)
  if (
    document.activeElement === card.value ||
    (event.shiftKey && document.activeElement === first)
  ) {
    event.preventDefault()
    ;(event.shiftKey ? last : first)?.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first?.focus()
  }
}
watch([kind, preset], () => {
  if (kind.value === 'issues' && preset.value === 'review') {
    preset.value = 'all'
    return
  }
  back()
  loadList()
})
watch(
  () => props.cwd,
  () => {
    back()
    listRequest++
    connection.value = null
    items.value = []
    loadStatus()
  }
)
watch(busy, (value) => emit('busy', value), { flush: 'sync' })
onMounted(() => {
  previousFocus = document.activeElement
  nextTick(() => card.value?.focus())
  loadStatus()
})
onBeforeUnmount(() => {
  alive = false
  previousFocus?.focus?.()
})
</script>

<template>
  <div class="help-backdrop issue-backdrop" @pointerdown.self="close">
    <div
      ref="card"
      class="issue-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="github-dialog-title"
      tabindex="-1"
      @keydown="onKey"
    >
      <header class="issue-dialog-head">
        <div>
          <h2 id="github-dialog-title">GitHub</h2>
          <p>{{ connection?.repo?.nameWithOwner || cwd || 'Choose a project workspace' }}</p>
        </div>
        <button class="issue-btn" aria-label="Close GitHub" :disabled="busy" @click="close">
          ✕
        </button>
      </header>
      <div class="issue-dialog-body">
        <p v-if="error" class="issue-error" role="alert">
          {{ error }}
          <button v-if="selected" class="issue-link" :disabled="busy" @click="loadDetail()">
            Retry details
          </button>
        </p>
        <p v-if="notice" class="issue-notice" role="status">
          {{ notice }}
          <button v-if="createdUrl" class="issue-link" @click="openUrl(createdUrl)">
            Open on GitHub
          </button>
        </p>
        <div v-if="!connected" class="issue-empty">
          <p v-if="loading">Checking GitHub…</p>
          <template v-else
            ><p>
              {{
                connection?.available === false
                  ? 'Install GitHub CLI to connect this project.'
                  : connection?.authenticated === false
                    ? 'Sign in with gh auth login in a terminal, then refresh.'
                    : 'GitHub could not be loaded for this project.'
              }}
            </p>
            <button class="issue-btn" data-test="github-connect-refresh" @click="loadStatus">
              Refresh connection
            </button></template
          >
        </div>
        <template v-else>
          <div v-if="!selected && !composer" class="issue-toolbar">
            <div class="issue-segments" role="group" aria-label="GitHub item type">
              <button
                v-for="value in ['issues', 'prs']"
                :key="value"
                :aria-pressed="kind === value"
                :data-test="'github-' + value"
                :disabled="busy"
                @click="kind = value"
              >
                {{ value === 'issues' ? 'Issues' : 'Pull requests' }}
              </button>
            </div>
            <button class="issue-btn" :disabled="loading || busy" @click="loadList">Refresh</button
            ><button class="issue-btn primary" data-test="github-new" @click="beginCreate">
              {{ isPr ? 'New pull request' : 'New issue' }}
            </button>
          </div>
          <template v-if="composer">
            <button class="issue-link" :disabled="busy" @click="back">← Back</button>
            <h3>{{ isPr ? 'New pull request' : 'New issue' }}</h3>
            <form class="issue-form" @submit.prevent="create">
              <label
                >Title<input
                  v-model="title"
                  data-test="github-title"
                  maxlength="256"
                  required
                  :disabled="busy" /></label
              ><label
                >Description<textarea
                  v-model="body"
                  data-test="github-body"
                  rows="6"
                  :disabled="busy"
                ></textarea></label
              ><template v-if="isPr"
                ><p class="issue-hint">
                  From {{ prCwd || cwd }}. Push this branch before creating the pull request.
                </p>
                <div class="issue-form-pair">
                  <label
                    >Base branch<input
                      v-model="base"
                      aria-label="Base branch"
                      :disabled="busy" /></label
                  ><label
                    >Head branch<input v-model="head" placeholder="Current branch" :disabled="busy"
                  /></label>
                </div>
                <label class="issue-checkbox"
                  ><input v-model="draft" type="checkbox" />Create as draft</label
                ></template
              >
              <div class="issue-actions">
                <button type="button" class="issue-btn" :disabled="busy" @click="back">
                  Cancel</button
                ><button
                  class="issue-btn primary"
                  data-test="github-create-submit"
                  :disabled="busy || !title.trim() || (isPr && !base.trim())"
                >
                  {{ busy ? 'Creating…' : isPr ? 'Create pull request' : 'Create issue' }}
                </button>
              </div>
            </form>
          </template>
          <template v-else-if="selected">
            <div class="issue-toolbar">
              <button class="issue-link" :disabled="busy" @click="back">
                ← {{ isPr ? 'Pull requests' : 'Issues' }}</button
              ><span class="issue-spacer"></span
              ><button class="issue-btn" @click="openUrl(selected.url)">Open</button
              ><button class="issue-btn" @click="copy(selected.url)">Copy link</button>
            </div>
            <h3 class="issue-item-title">
              <span class="issue-id">#{{ selected.number }}</span> {{ selected.title }}
            </h3>
            <p class="issue-hint">
              {{ selected.state
              }}<span v-if="selected.author?.login"> · {{ selected.author.login }}</span
              ><span v-if="selected.isDraft"> · Draft</span>
            </p>
            <div class="issue-labels">
              <span v-for="label in selected.labels || []" :key="label.name" class="issue-tag">{{
                label.name
              }}</span>
            </div>
            <p v-if="selected.truncated" class="issue-hint">
              Some details are limited. Open this item on GitHub to see everything.
            </p>
            <p v-if="detailLoading" class="issue-empty" role="status">Reading details…</p>
            <template v-else>
              <div
                class="issue-segments issue-detail-tabs"
                role="group"
                aria-label="Pull request details"
              >
                <button :aria-pressed="tab === 'conversation'" @click="tab = 'conversation'">
                  Conversation</button
                ><template v-if="isPr"
                  ><button :aria-pressed="tab === 'files'" @click="tab = 'files'">
                    Files ({{ selected.files?.length || 0 }})</button
                  ><button :aria-pressed="tab === 'checks'" @click="tab = 'checks'">
                    Checks ({{ selected.checks?.length || 0 }})
                  </button></template
                >
              </div>
              <div v-if="tab === 'conversation'" class="issue-conversation">
                <pre class="issue-prose">{{ selected.body || 'No description.' }}</pre>
                <article
                  v-for="(entry, index) in selected.comments || []"
                  :key="entry.id || index"
                  class="issue-comment"
                >
                  <strong>{{ entry.author?.login || 'GitHub user' }}</strong>
                  <pre class="issue-prose">{{ entry.body }}</pre>
                </article>
                <label class="issue-field"
                  >Add a comment<textarea v-model="comment" rows="3" :disabled="busy" />
                </label>
                <div class="issue-actions">
                  <button
                    class="issue-btn"
                    data-test="github-comment"
                    :disabled="busy || !comment.trim()"
                    @click="runAction('comment', { body: comment })"
                  >
                    Post comment
                  </button>
                </div>
              </div>
              <div v-else-if="tab === 'files'" class="issue-files">
                <p v-if="!selected.files?.length" class="issue-empty">No changed files reported.</p>
                <div v-for="file in selected.files || []" :key="file.path" class="issue-file">
                  <div>
                    <code>{{ file.path }}</code
                    ><span class="issue-file-count"
                      >+{{ file.additions || 0 }} −{{ file.deletions || 0 }}</span
                    >
                  </div>
                  <pre v-if="file.patch" class="issue-prose issue-patch">{{ file.patch }}</pre>
                </div>
              </div>
              <div v-else>
                <div class="issue-toolbar">
                  <span class="issue-hint">Latest reported checks</span
                  ><button class="issue-btn" :disabled="busy" @click="refreshChecks">
                    Refresh checks
                  </button>
                </div>
                <p v-if="selected.checksError" class="issue-error" role="alert">
                  {{ selected.checksError }}
                </p>
                <p v-if="!selected.checks?.length" class="issue-empty">No checks reported.</p>
                <div
                  v-for="(check, index) in selected.checks || []"
                  :key="check.name + index"
                  class="issue-check"
                >
                  <span>{{ check.name }}</span
                  ><span class="issue-tag">{{
                    check.conclusion || check.state || check.status || 'Pending'
                  }}</span
                  ><button v-if="check.url" class="issue-link" @click="openUrl(check.url)">
                    Open
                  </button>
                </div>
                <div class="issue-actions">
                  <button class="issue-btn" :disabled="busy" @click="askAction('rerunFailed')">
                    Rerun failed</button
                  ><button class="issue-btn" :disabled="busy" @click="askAction('rerunAll')">
                    Rerun all
                  </button>
                </div>
              </div>
              <div
                v-if="confirmation"
                class="issue-confirm"
                role="group"
                aria-label="Confirm GitHub action"
              >
                <p v-if="confirmation === 'autoMerge'">
                  Enable auto-merge for #{{ selected.number }}? GitHub may merge immediately if its
                  requirements are already met.
                </p>
                <p v-else>
                  {{ actionLabels[confirmation]
                  }}{{ ['close', 'reopen'].includes(confirmation) ? ` #${selected.number}` : '' }}
                  on GitHub?
                </p>
                <label v-if="['merge', 'autoMerge'].includes(confirmation)" class="issue-field"
                  >Merge method<select v-model="method" :disabled="busy">
                    <option value="squash">Squash</option>
                    <option value="merge">Merge commit</option>
                    <option value="rebase">Rebase</option>
                  </select></label
                >
                <div class="issue-actions">
                  <button class="issue-btn" :disabled="busy" @click="confirmation = null">
                    Cancel</button
                  ><button
                    class="issue-btn primary"
                    data-test="github-confirm-action"
                    :disabled="busy"
                    @click="
                      runAction(
                        confirmation,
                        ['merge', 'autoMerge'].includes(confirmation) ? { method } : {}
                      )
                    "
                  >
                    {{ busy ? 'Updating…' : 'Confirm' }}
                  </button>
                </div>
              </div>
              <div v-else class="issue-actions issue-maintenance">
                <button
                  class="issue-btn"
                  :disabled="busy || selected.state === 'MERGED'"
                  @click="
                    askAction(
                      String(selected.state).toUpperCase() === 'CLOSED' ? 'reopen' : 'close'
                    )
                  "
                >
                  {{ String(selected.state).toUpperCase() === 'CLOSED' ? 'Reopen' : 'Close' }}
                  {{ isPr ? 'pull request' : 'issue' }}</button
                ><template v-if="isPr && String(selected.state).toUpperCase() === 'OPEN'"
                  ><button class="issue-btn" :disabled="busy" @click="askAction('autoMerge')">
                    Enable auto-merge</button
                  ><button
                    class="issue-btn primary"
                    :disabled="busy"
                    data-test="github-merge"
                    @click="askAction('merge')"
                  >
                    Merge…
                  </button></template
                >
              </div>
              <div class="issue-start">
                <h4>{{ isPr ? 'Work on this pull request' : 'Work on this issue' }}</h4>
                <div class="issue-start-row">
                  <label class="issue-field"
                    >Agent<select
                      v-model="agentId"
                      aria-label="Agent for GitHub issue"
                      :disabled="busy"
                    >
                      <option v-for="agent in agents" :key="agent.id" :value="agent.id">
                        {{ agent.name || agent.id }}
                      </option>
                    </select></label
                  ><label class="issue-checkbox"
                    ><input v-model="worktree" type="checkbox" :disabled="busy || isPr" />Own Git
                    copy</label
                  >
                </div>
                <div class="issue-actions">
                  <button class="issue-btn" @click="copyIssue">
                    {{ isPr ? 'Copy pull request' : 'Copy issue' }}</button
                  ><button
                    class="issue-btn primary"
                    data-test="github-start"
                    :disabled="busy || !agentId"
                    @click="start"
                  >
                    {{ busy ? 'Preparing…' : 'Start task' }}
                  </button>
                </div>
              </div>
            </template>
          </template>
          <template v-else>
            <form class="issue-filters" @submit.prevent="loadList">
              <label
                >Show<select v-model="preset" aria-label="GitHub issue filter">
                  <option value="all">All open</option>
                  <option value="mine">{{ isPr ? 'Created by me' : 'Assigned to me' }}</option>
                  <option v-if="isPr" value="review">Review requested</option>
                </select></label
              ><label class="issue-search"
                >Search<input
                  v-model="query"
                  placeholder="Title, label, or GitHub search"
                  aria-label="Search GitHub" /></label
              ><button class="issue-btn" type="submit">Search</button>
            </form>
            <p v-if="loading" class="issue-empty" role="status">
              Reading {{ isPr ? 'pull requests' : 'issues' }}…
            </p>
            <p v-else-if="!items.length && !error" class="issue-empty">
              No {{ isPr ? 'pull requests' : 'issues' }} match this view.
            </p>
            <p v-if="truncated" class="issue-hint">
              Results are limited. Narrow your search to find more.
            </p>
            <div class="issue-list">
              <button
                v-for="item in items"
                :key="item.number"
                class="issue-row"
                data-test="github-item"
                :disabled="busy || loading"
                @click="loadDetail(item)"
              >
                <span class="issue-row-heading"
                  ><span class="issue-id">#{{ item.number }}</span
                  ><strong>{{ item.title }}</strong></span
                ><span class="issue-row-meta"
                  >{{ item.state }}<span v-if="item.author?.login"> · {{ item.author.login }}</span
                  ><span v-if="item.isDraft"> · Draft</span></span
                ><span v-if="item.labels?.length" class="issue-labels"
                  ><span v-for="label in item.labels" :key="label.name" class="issue-tag">{{
                    label.name
                  }}</span></span
                >
              </button>
            </div>
          </template>
        </template>
      </div>
    </div>
  </div>
</template>
