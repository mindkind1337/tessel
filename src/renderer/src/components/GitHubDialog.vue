<script setup>
import ThemedSelect from './ui/ThemedSelect.vue'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { t } from '../i18n'
import {
  buildFixChecksPrompt,
  buildResolveCommentsPrompt,
  failingChecks,
  unresolvedThreads
} from '../prAgentPrompts'

const props = defineProps({
  // (item) -> [{ id, label }]: agent panes already working on this PR.
  prAgents: { type: Function, default: null },
  // ({ item, prompt, target }) -> { ok, error }: sends a prompt the user saw.
  sendPrompt: { type: Function, default: null },
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
  if (!result?.ok) throw new Error(result?.error || t('github.requestFailed', 'GitHub request failed.'))
  return result
}
const errorText = (err) => err?.message || t('github.requestFailed', 'GitHub request failed.')
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
      error.value = t('github.openFailed', 'Could not open this link.')
    }
  }
}
async function copy(value, label = t('github.linkCopied', 'Link copied.')) {
  try {
    await window.shellApi.writeClipboard(String(value))
    notice.value = label
  } catch {
    error.value = t('github.copyFailed', 'Could not copy to the clipboard.')
  }
}
function copyIssue() {
  const item = selected.value
  copy(
    `#${item.number} ${item.title}\n${item.url}\n\n${item.body || ''}`,
    isPr.value ? t('github.prCopied', 'Pull request copied.') : t('github.issueCopied', 'Issue copied.')
  )
}
async function loadStatus() {
  const request = ++statusRequest
  loading.value = true
  error.value = ''
  try {
    if (!window.shellApi.github)
      throw new Error(t('github.unavailable', 'GitHub integration is not available in this version.'))
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
  agentDraft.value = null
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
  agentDraft.value = null
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
    notice.value = isPr.value ? t('github.prCreated', 'Pull request created.') : t('github.issueCreated', 'Issue created.')
    await loadList()
  } catch (err) {
    if (alive) error.value = errorText(err)
  } finally {
    if (alive) busy.value = false
  }
}
function askAction(action) {
  confirmation.value = action
  agentDraft.value = null
  error.value = ''
}
// Text with {{placeholders}} is built here: in the template, "}}" would end
// the interpolation.
function confirmText(action, number) {
  if (action === 'autoMerge')
    return t('github.confirm.autoMerge', 'Enable auto-merge for #{{number}}? GitHub may merge immediately if its requirements are already met.', { number })
  if (action === 'close') return t('github.confirm.close', 'Close #{{number}} on GitHub?', { number })
  if (action === 'reopen') return t('github.confirm.reopen', 'Reopen #{{number}} on GitHub?', { number })
  if (action === 'merge') return t('github.confirm.merge', 'Merge pull request on GitHub?')
  if (action === 'rerunFailed') return t('github.confirm.rerunFailed', 'Rerun failed checks on GitHub?')
  if (action === 'rerunAll') return t('github.confirm.rerunAll', 'Rerun all checks on GitHub?')
  return ''
}
const fromHint = (path) => t('github.create.from', 'From {{path}}. Push this branch before creating the pull request.', { path })
const filesTab = (count) => t('github.detail.files', 'Files ({{count}})', { count })
const checksTab = (count) => t('github.detail.checks', 'Checks ({{count}})', { count })
function closeLabel(state, pr) {
  if (String(state).toUpperCase() === 'CLOSED')
    return pr ? t('github.reopenPr', 'Reopen pull request') : t('github.reopenIssue', 'Reopen issue')
  return pr ? t('github.closePr', 'Close pull request') : t('github.closeIssue', 'Close issue')
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
    notice.value = action === 'comment' ? t('github.commentPosted', 'Comment posted.') : t('github.updated', 'GitHub updated.')
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
// "Fix failing checks" / "Resolve review comments": the prompt is built from
// fresh GitHub data, shown for review, and sent only when the user confirms
// it and the agent (an agent already on this PR, or a new one).
const agentDraft = ref(null) // { purpose, prompt, target, targets }
const failingCount = computed(() => (isPr.value ? failingChecks(selected.value?.checks).length : 0))
const openThreads = computed(() => (isPr.value ? unresolvedThreads(selected.value?.reviewThreads) : []))
const threadsTitle = (count) => t('github.threads.title', 'Unresolved review threads ({{count}})', { count })
const threadPlace = (thread) => (thread.line ? `${thread.path}:${thread.line}` : thread.path) // i18n-ignore
function draftTargets(item) {
  let panes = []
  try {
    panes = props.prAgents ? props.prAgents(item) || [] : []
  } catch {
    panes = []
  }
  return [
    ...panes.map((pane) => ({ value: 'pane:' + pane.id, label: pane.label, target: { kind: 'pane', id: pane.id } })),
    ...props.agents.map((agent) => ({
      value: 'new:' + agent.id,
      label: t('github.agent.newAgent', 'New agent: {{name}}', { name: agent.name || agent.id }),
      target: { kind: 'new', agentId: agent.id }
    }))
  ]
}
async function prepareAgentPrompt(purpose) {
  if (busy.value || !selected.value || !props.sendPrompt) return
  const item = selected.value
  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    let prompt
    if (purpose === 'checks') {
      const result = failed(await api().failingLogs({ cwd: props.cwd, number: item.number }))
      prompt = buildFixChecksPrompt({ pr: item, checks: result.checks || [] })
    } else {
      const result = failed(await api().reviewThreads({ cwd: props.cwd, number: item.number }))
      if (alive && selected.value === item) selected.value = { ...item, reviewThreads: result.threads || [] }
      prompt = buildResolveCommentsPrompt({ pr: item, threads: result.threads || [] })
    }
    if (!alive || selected.value?.number !== item.number) return
    const targets = draftTargets(item)
    const preferred =
      targets.find((option) => option.target.kind === 'pane') ||
      targets.find((option) => option.value === 'new:' + agentId.value) ||
      targets[0]
    confirmation.value = null
    agentDraft.value = { purpose, prompt, targets, target: preferred?.value || '' }
  } catch (err) {
    if (alive) error.value = errorText(err)
  } finally {
    if (alive) busy.value = false
  }
}
async function sendAgentDraft() {
  const draft = agentDraft.value
  if (busy.value || !draft || !selected.value || !draft.prompt.trim()) return
  const option = draft.targets.find((candidate) => candidate.value === draft.target)
  if (!option) return
  busy.value = true
  error.value = ''
  try {
    failed(await props.sendPrompt({ provider: 'github', item: selected.value, prompt: draft.prompt, target: option.target }))
    if (alive) {
      agentDraft.value = null
      emit('close')
    }
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
      notice.value = t('github.startRequested', 'Task preparation requested.')
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
          <p>{{ connection?.repo?.nameWithOwner || cwd || t('github.chooseWorkspace', 'Choose a project workspace') }}</p>
        </div>
        <button class="issue-btn" :aria-label="t('github.close', 'Close GitHub')" :disabled="busy" @click="close">
          ✕
        </button>
      </header>
      <div class="issue-dialog-body">
        <p v-if="error" class="issue-error" role="alert">
          {{ error }}
          <button v-if="selected" class="issue-link" :disabled="busy" @click="loadDetail()">
            {{ t('github.retryDetails', 'Retry details') }}
          </button>
        </p>
        <p v-if="notice" class="issue-notice" role="status">
          {{ notice }}
          <button v-if="createdUrl" class="issue-link" @click="openUrl(createdUrl)">
            {{ t('github.openOnGitHub', 'Open on GitHub') }}
          </button>
        </p>
        <div v-if="!connected" class="issue-empty">
          <p v-if="loading">{{ t('github.checking', 'Checking GitHub…') }}</p>
          <template v-else
            ><p>
              {{
                connection?.available === false
                  ? t('github.needCli', 'Install GitHub CLI to connect this project.')
                  : connection?.authenticated === false
                    ? t('github.needSignIn', 'Sign in with gh auth login in a terminal, then refresh.')
                    : t('github.loadFailed', 'GitHub could not be loaded for this project.')
              }}
            </p>
            <button class="issue-btn" data-test="github-connect-refresh" @click="loadStatus">
              {{ t('github.refreshConnection', 'Refresh connection') }}
            </button></template
          >
        </div>
        <template v-else>
          <div v-if="!selected && !composer" class="issue-toolbar">
            <div class="issue-segments" role="group" :aria-label="t('github.itemType', 'GitHub item type')">
              <button
                v-for="value in ['issues', 'prs']"
                :key="value"
                :aria-pressed="kind === value"
                :data-test="'github-' + value"
                :disabled="busy"
                @click="kind = value"
              >
                {{ value === 'issues' ? t('github.issues', 'Issues') : t('github.prs', 'Pull requests') }}
              </button>
            </div>
            <button class="issue-btn" :disabled="loading || busy" @click="loadList">
              {{ t('github.refresh', 'Refresh') }}</button
            ><button class="issue-btn primary" data-test="github-new" @click="beginCreate">
              {{ isPr ? t('github.newPr', 'New pull request') : t('github.newIssue', 'New issue') }}
            </button>
          </div>
          <template v-if="composer">
            <button class="issue-link" :disabled="busy" @click="back">
              {{ t('github.back', '← Back') }}
            </button>
            <h3>{{ isPr ? t('github.newPr', 'New pull request') : t('github.newIssue', 'New issue') }}</h3>
            <form class="issue-form" @submit.prevent="create">
              <label
                >{{ t('github.create.title', 'Title') }}<input
                  v-model="title"
                  data-test="github-title"
                  maxlength="256"
                  required
                  :disabled="busy" /></label
              ><label
                >{{ t('github.create.description', 'Description') }}<textarea
                  v-model="body"
                  data-test="github-body"
                  rows="6"
                  :disabled="busy"
                ></textarea></label
              ><template v-if="isPr"
                ><p class="issue-hint">
                  {{ fromHint(prCwd || cwd) }}
                </p>
                <div class="issue-form-pair">
                  <label
                    >{{ t('github.create.base', 'Base branch') }}<input
                      v-model="base"
                      :aria-label="t('github.create.base', 'Base branch')"
                      :disabled="busy" /></label
                  ><label
                    >{{ t('github.create.head', 'Head branch')
                    }}<input v-model="head" :placeholder="t('github.create.headPlaceholder', 'Current branch')" :disabled="busy"
                  /></label>
                </div>
                <label class="issue-checkbox"
                  ><input v-model="draft" type="checkbox" />{{ t('github.create.draft', 'Create as draft') }}</label
                ></template
              >
              <div class="issue-actions">
                <button type="button" class="issue-btn" :disabled="busy" @click="back">
                  {{ t('github.cancel', 'Cancel') }}</button
                ><button
                  class="issue-btn primary"
                  data-test="github-create-submit"
                  :disabled="busy || !title.trim() || (isPr && !base.trim())"
                >
                  {{
                    busy
                      ? t('github.create.creating', 'Creating…')
                      : isPr
                        ? t('github.create.pr', 'Create pull request')
                        : t('github.create.issue', 'Create issue')
                  }}
                </button>
              </div>
            </form>
          </template>
          <template v-else-if="selected">
            <div class="issue-toolbar">
              <button class="issue-link" :disabled="busy" @click="back">
                {{ isPr ? t('github.backToPrs', '← Pull requests') : t('github.backToIssues', '← Issues') }}</button
              ><span class="issue-spacer"></span
              ><button class="issue-btn" @click="openUrl(selected.url)">
                {{ t('github.open', 'Open') }}</button
              ><button class="issue-btn" @click="copy(selected.url)">
                {{ t('github.copyLink', 'Copy link') }}
              </button>
            </div>
            <h3 class="issue-item-title">
              <span class="issue-id">#{{ selected.number }}</span> {{ selected.title }}
            </h3>
            <p class="issue-hint">
              {{ selected.state
              }}<span v-if="selected.author?.login"> · {{ selected.author.login }}</span
              ><span v-if="selected.isDraft"> · {{ t('github.draft', 'Draft') }}</span>
            </p>
            <div class="issue-labels">
              <span v-for="label in selected.labels || []" :key="label.name" class="issue-tag">{{
                label.name
              }}</span>
            </div>
            <p v-if="selected.truncated" class="issue-hint">
              {{ t('github.detail.limited', 'Some details are limited. Open this item on GitHub to see everything.') }}
            </p>
            <p v-if="detailLoading" class="issue-empty" role="status">
              {{ t('github.detail.reading', 'Reading details…') }}
            </p>
            <template v-else>
              <div
                class="issue-segments issue-detail-tabs"
                role="group"
                :aria-label="t('github.detail.label', 'Pull request details')"
              >
                <button :aria-pressed="tab === 'conversation'" @click="tab = 'conversation'">
                  {{ t('github.detail.conversation', 'Conversation') }}</button
                ><template v-if="isPr"
                  ><button :aria-pressed="tab === 'files'" @click="tab = 'files'">
                    {{ filesTab(selected.files?.length || 0) }}</button
                  ><button :aria-pressed="tab === 'checks'" @click="tab = 'checks'">
                    {{ checksTab(selected.checks?.length || 0) }}
                  </button></template
                >
              </div>
              <div v-if="tab === 'conversation'" class="issue-conversation">
                <pre class="issue-prose">{{ selected.body || t('github.detail.noDescription', 'No description.') }}</pre>
                <article
                  v-for="(entry, index) in selected.comments || []"
                  :key="entry.id || index"
                  class="issue-comment"
                >
                  <strong>{{ entry.author?.login || t('github.detail.user', 'GitHub user') }}</strong>
                  <pre class="issue-prose">{{ entry.body }}</pre>
                </article>
                <section v-if="openThreads.length" class="issue-threads" data-test="github-threads">
                  <h4>{{ threadsTitle(openThreads.length) }}</h4>
                  <div v-for="(thread, index) in openThreads" :key="thread.id || index" class="issue-check">
                    <span
                      ><code>{{ threadPlace(thread) }}</code>
                      <span v-if="thread.isOutdated" class="issue-tag">{{ t('github.threads.outdated', 'Outdated') }}</span></span
                    ><span class="issue-hint">{{ thread.comments?.[0]?.author || '' }}</span>
                  </div>
                  <p v-if="selected.reviewThreadsTruncated" class="issue-hint">
                    {{ t('github.threads.truncated', 'Some review threads or comments are limited. Open the pull request on GitHub to see everything.') }}
                  </p>
                  <div v-if="sendPrompt" class="issue-actions">
                    <button
                      class="issue-btn"
                      data-test="github-resolve-comments"
                      :disabled="busy"
                      @click="prepareAgentPrompt('comments')"
                    >
                      {{ t('github.threads.resolve', 'Resolve review comments') }}
                    </button>
                  </div>
                </section>
                <p v-else-if="selected.reviewThreadsError" class="issue-hint">{{ selected.reviewThreadsError }}</p>
                <label class="issue-field"
                  >{{ t('github.detail.addComment', 'Add a comment') }}<textarea v-model="comment" rows="3" :disabled="busy" />
                </label>
                <div class="issue-actions">
                  <button
                    class="issue-btn"
                    data-test="github-comment"
                    :disabled="busy || !comment.trim()"
                    @click="runAction('comment', { body: comment })"
                  >
                    {{ t('github.detail.postComment', 'Post comment') }}
                  </button>
                </div>
              </div>
              <div v-else-if="tab === 'files'" class="issue-files">
                <p v-if="!selected.files?.length" class="issue-empty">
                  {{ t('github.detail.noFiles', 'No changed files reported.') }}
                </p>
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
                  <span class="issue-hint">{{ t('github.checks.latest', 'Latest reported checks') }}</span
                  ><button class="issue-btn" :disabled="busy" @click="refreshChecks">
                    {{ t('github.checks.refresh', 'Refresh checks') }}
                  </button>
                </div>
                <p v-if="selected.checksError" class="issue-error" role="alert">
                  {{ selected.checksError }}
                </p>
                <p v-if="!selected.checks?.length" class="issue-empty">
                  {{ t('github.checks.none', 'No checks reported.') }}
                </p>
                <div
                  v-for="(check, index) in selected.checks || []"
                  :key="check.name + index"
                  class="issue-check"
                >
                  <span>{{ check.name }}</span
                  ><span class="issue-tag">{{
                    check.conclusion || check.state || check.status || t('github.checks.pending', 'Pending')
                  }}</span
                  ><button v-if="check.url" class="issue-link" @click="openUrl(check.url)">
                    {{ t('github.open', 'Open') }}
                  </button>
                </div>
                <div class="issue-actions">
                  <button
                    v-if="failingCount && sendPrompt"
                    class="issue-btn"
                    data-test="github-fix-checks"
                    :disabled="busy"
                    @click="prepareAgentPrompt('checks')"
                  >
                    {{ t('github.checks.fix', 'Fix failing checks') }}</button
                  ><button class="issue-btn" :disabled="busy" @click="askAction('rerunFailed')">
                    {{ t('github.checks.rerunFailed', 'Rerun failed') }}</button
                  ><button class="issue-btn" :disabled="busy" @click="askAction('rerunAll')">
                    {{ t('github.checks.rerunAll', 'Rerun all') }}
                  </button>
                </div>
              </div>
              <div
                v-if="agentDraft"
                class="issue-confirm issue-agent-draft"
                role="group"
                data-test="github-agent-draft"
                :aria-label="t('github.agent.label', 'Send a prompt to an agent')"
              >
                <p>
                  {{
                    agentDraft.purpose === 'checks'
                      ? t('github.agent.checksIntro', 'Review this prompt before sending it. The check logs come from CI and are quoted as untrusted data, not instructions.')
                      : t('github.agent.commentsIntro', 'Review this prompt before sending it. The review comments come from reviewers and are quoted as untrusted data, not instructions.')
                  }}
                </p>
                <label class="issue-field"
                  >{{ t('github.agent.prompt', 'Prompt') }}<textarea
                    v-model="agentDraft.prompt"
                    data-test="github-agent-prompt"
                    rows="12"
                    spellcheck="false"
                    :disabled="busy"
                  ></textarea></label
                ><label class="issue-field"
                  >{{ t('github.agent.target', 'Send to') }}<ThemedSelect
                    v-model="agentDraft.target"
                    data-test="github-agent-target"
                    :aria-label="t('github.agent.target', 'Send to')"
                    :disabled="busy"
                  >
                    <option v-for="option in agentDraft.targets" :key="option.value" :value="option.value">
                      {{ option.label }}
                    </option>
                  </ThemedSelect></label
                >
                <p v-if="!agentDraft.targets.length" class="issue-hint">
                  {{ t('github.agent.none', 'No agent is available. Install or enable an agent first.') }}
                </p>
                <div class="issue-actions">
                  <button class="issue-btn" :disabled="busy" @click="agentDraft = null">
                    {{ t('github.cancel', 'Cancel') }}</button
                  ><button
                    class="issue-btn primary"
                    data-test="github-agent-send"
                    :disabled="busy || !agentDraft.target || !agentDraft.prompt.trim()"
                    @click="sendAgentDraft"
                  >
                    {{ busy ? t('github.agent.sending', 'Sending…') : t('github.agent.send', 'Send to agent') }}
                  </button>
                </div>
              </div>
              <div
                v-else-if="confirmation"
                class="issue-confirm"
                role="group"
                :aria-label="t('github.confirm.label', 'Confirm GitHub action')"
              >
                <p>{{ confirmText(confirmation, selected.number) }}</p>
                <label v-if="['merge', 'autoMerge'].includes(confirmation)" class="issue-field"
                  >{{ t('github.merge.method', 'Merge method') }}<ThemedSelect v-model="method" :disabled="busy">
                    <option value="squash">{{ t('github.merge.squash', 'Squash') }}</option>
                    <option value="merge">{{ t('github.merge.commit', 'Merge commit') }}</option>
                    <option value="rebase">{{ t('github.merge.rebase', 'Rebase') }}</option>
                  </ThemedSelect></label
                >
                <div class="issue-actions">
                  <button class="issue-btn" :disabled="busy" @click="confirmation = null">
                    {{ t('github.cancel', 'Cancel') }}</button
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
                    {{ busy ? t('github.confirm.updating', 'Updating…') : t('github.confirm.button', 'Confirm') }}
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
                  {{ closeLabel(selected.state, isPr) }}</button
                ><template v-if="isPr && String(selected.state).toUpperCase() === 'OPEN'"
                  ><button class="issue-btn" :disabled="busy" @click="askAction('autoMerge')">
                    {{ t('github.autoMerge', 'Enable auto-merge') }}</button
                  ><button
                    class="issue-btn primary"
                    :disabled="busy"
                    data-test="github-merge"
                    @click="askAction('merge')"
                  >
                    {{ t('github.mergeButton', 'Merge…') }}
                  </button></template
                >
              </div>
              <div class="issue-start">
                <h4>{{ isPr ? t('github.start.titlePr', 'Work on this pull request') : t('github.start.titleIssue', 'Work on this issue') }}</h4>
                <div class="issue-start-row">
                  <label class="issue-field"
                    >{{ t('github.start.agent', 'Agent') }}<ThemedSelect
                      v-model="agentId"
                      :aria-label="t('github.start.agentLabel', 'Agent for GitHub issue')"
                      :disabled="busy"
                    >
                      <option v-for="agent in agents" :key="agent.id" :value="agent.id">
                        {{ agent.name || agent.id }}
                      </option>
                    </ThemedSelect></label
                  ><label class="issue-checkbox"
                    ><input v-model="worktree" type="checkbox" :disabled="busy || isPr" />{{
                      t('github.start.ownCopy', 'Own Git copy')
                    }}</label
                  >
                </div>
                <div class="issue-actions">
                  <button class="issue-btn" @click="copyIssue">
                    {{ isPr ? t('github.copyPr', 'Copy pull request') : t('github.copyIssue', 'Copy issue') }}</button
                  ><button
                    class="issue-btn primary"
                    data-test="github-start"
                    :disabled="busy || !agentId"
                    @click="start"
                  >
                    {{ busy ? t('github.start.preparing', 'Preparing…') : t('github.start.button', 'Start task') }}
                  </button>
                </div>
              </div>
            </template>
          </template>
          <template v-else>
            <form class="issue-filters" @submit.prevent="loadList">
              <label
                >{{ t('github.filter.show', 'Show')
                }}<ThemedSelect v-model="preset" :aria-label="t('github.filter.label', 'GitHub issue filter')">
                  <option value="all">{{ t('github.filter.allOpen', 'All open') }}</option>
                  <option value="mine">
                    {{ isPr ? t('github.filter.createdByMe', 'Created by me') : t('github.filter.assignedToMe', 'Assigned to me') }}
                  </option>
                  <option v-if="isPr" value="review">{{ t('github.filter.review', 'Review requested') }}</option>
                </ThemedSelect></label
              ><label class="issue-search"
                >{{ t('github.search.label', 'Search')
                }}<input
                  v-model="query"
                  :placeholder="t('github.search.placeholder', 'Title, label, or GitHub search')"
                  :aria-label="t('github.search.aria', 'Search GitHub')" /></label
              ><button class="issue-btn" type="submit">{{ t('github.search.button', 'Search') }}</button>
            </form>
            <p v-if="loading" class="issue-empty" role="status">
              {{ isPr ? t('github.list.readingPrs', 'Reading pull requests…') : t('github.list.readingIssues', 'Reading issues…') }}
            </p>
            <p v-else-if="!items.length && !error" class="issue-empty">
              {{ isPr ? t('github.list.noPrs', 'No pull requests match this view.') : t('github.list.noIssues', 'No issues match this view.') }}
            </p>
            <p v-if="truncated" class="issue-hint">
              {{ t('github.list.truncated', 'Results are limited. Narrow your search to find more.') }}
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
                  ><span v-if="item.isDraft"> · {{ t('github.draft', 'Draft') }}</span></span
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
