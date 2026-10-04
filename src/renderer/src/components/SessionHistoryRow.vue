<script setup>
// One past conversation in the Agent Session History panel: its title, agent,
// time and folder; hover actions (jump to the pane it is open in, or resume
// it), its details when expanded (first prompt, latest turns, sub-agents,
// working directory) and its action menu (also on right-click): resume, open
// or reveal its log, open its folder, copy its id or log path, delete it.
// After Orca's AiVaultSessionRow.tsx, SessionRowTrailingActions.tsx,
// AiVaultSessionActionMenuItems.tsx, AiVaultSessionDetails.tsx,
// ai-vault-first-prompt-card.tsx, AiVaultSessionSubagents.tsx and
// AiVaultSearchEvidence.tsx (MIT, Copyright (c) 2026 Lovecast Inc.).
import { computed, inject, onBeforeUnmount, ref, watch } from 'vue'
import { Bot, Check, ChevronDown, Copy, FileJson, Folder, FolderOpen, LoaderCircle, LocateFixed, MessageSquare, MoreHorizontal, Play, SquareTerminal, TextCursorInput, Trash2 } from 'lucide-vue-next'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from './chat/orca/ui/index.js'
import BrandIcon from './BrandIcon.vue'
import { maskSecrets } from '../chat/chatModel'
import { acquireChildren, childDotState, listsChildren } from '../agentChildrenFeed'
import { childTime } from '../agentChildrenView'
import { agentLabel, deleteBlockedReason, folderLabel, hasLog, roleLabel, timeAgo } from '../sessionHistory'
import { t } from '../i18n'

const props = defineProps({
  session: { type: Object, required: true },
  // The pane this conversation is open in, if any.
  paneId: { type: String, default: null },
  scope: { type: String, default: 'all' },
  expanded: { type: Boolean, default: false },
  // The clock, so the times move with the panel's.
  now: { type: Number, default: () => Date.now() }
})
const emit = defineEmits(['toggle', 'resume', 'focus-pane', 'open-log', 'toast', 'deleted'])
const askConfirm = inject('askConfirm', null)
const api = () => (typeof window !== 'undefined' && window.shellApi) || null

const s = computed(() => props.session)
const title = computed(() => maskSecrets(s.value.title || '') || t('app.sessions.untitled', 'Untitled conversation'))
// An Antigravity IDE conversation: continued in a new Antigravity CLI one,
// also when its folder is unknown (the IDE does not always record it): then
// in the folder a new pane opens in.
const fromIde = computed(() => s.value.agent === 'antigravity' && s.value.origin === 'ide')
const canResume = computed(() => !!s.value.id && (!!s.value.cwd || fromIde.value))
const actionText = computed(() => (fromIde.value ? t('sessionHistory.row.continueInCli', 'Continue in CLI') : t('sessionHistory.row.resumeInNewPane', 'Resume in New Pane')))
const resumeLabel = computed(() => {
  if (!canResume.value) return t('app.sessions.resumeUnavailable', 'The saved project folder is unavailable. You can still copy the session ID.')
  if (fromIde.value && !s.value.cwd)
    return t('sessionHistory.row.continueInCliNoFolderHint', 'Its folder is unknown: start a new Antigravity CLI conversation in the current folder, from the end of this IDE conversation')
  return fromIde.value
    ? t('sessionHistory.row.continueInCliHint', 'Start a new Antigravity CLI conversation in its folder, from the end of this IDE conversation')
    : actionText.value
})
const detailsTooltip = computed(() => (props.expanded ? t('sessionHistory.row.hideDetails', 'Hide Details') : t('sessionHistory.row.showDetails', 'Show Details')))
const detailsId = computed(() => `sh-details-${String(s.value.id).replace(/[^A-Za-z0-9_-]/g, '-')}`) // i18n-ignore
const when = computed(() => timeAgo(s.value.updated, props.now))
const messagesLabel = computed(() => {
  const n = details.value && Number.isFinite(details.value.messageCount) ? details.value.messageCount : s.value.messageCount
  return Number.isFinite(n) ? t('sessionHistory.row.messageCount', '{{n}} msgs', { n }) : ''
})
const showFolder = computed(() => props.scope !== 'workspace' && !!s.value.cwd)
const deleteReason = computed(() => deleteBlockedReason(s.value, props.paneId ? { [s.value.id]: props.paneId } : {}))
const logActions = computed(() => hasLog(s.value.agent))

// --- Details (loaded when expanded) -------------------------------------------------
const details = ref(null) // { ok, file, firstPrompt, turns, messageCount }
const detailsLoading = ref(false)
let detailsPromise = null
function loadDetails() {
  if (detailsPromise) return detailsPromise
  const a = api()
  if (!logActions.value || !a || !a.sessionDetails) return Promise.resolve(null)
  detailsLoading.value = true
  detailsPromise = a
    .sessionDetails({ agent: s.value.agent, id: s.value.id, ...(s.value.accountId !== undefined ? { accountId: s.value.accountId } : {}) })
    .then((res) => {
      details.value = res && res.ok ? res : { ok: false }
      return details.value
    })
    .catch(() => {
      details.value = { ok: false }
      return details.value
    })
    .finally(() => {
      detailsLoading.value = false
      // Left for a later try when it failed.
      if (!details.value || !details.value.ok) detailsPromise = null
    })
  return detailsPromise
}
const promptText = computed(() => maskSecrets((details.value && details.value.firstPrompt) || s.value.title || '').trim())
const promptFull = computed(() => !!(details.value && details.value.firstPrompt))
const promptLabel = computed(() => (promptFull.value ? t('sessionHistory.details.firstPrompt', 'First prompt') : t('sessionHistory.details.prompt', 'Prompt')))
const turns = computed(() => (details.value && details.value.ok ? details.value.turns.map((x) => ({ ...x, text: maskSecrets(x.text || '') })) : []))
const copied = ref(false)
let copiedTimer = 0
function copyPrompt() {
  const a = api()
  if (!a || !promptText.value) return
  a.writeClipboard(promptText.value)
  copied.value = true
  clearTimeout(copiedTimer)
  copiedTimer = setTimeout(() => (copied.value = false), 1400)
  emit('toast', promptFull.value ? t('sessionHistory.details.firstPromptCopied', 'First prompt copied') : t('sessionHistory.details.promptCopied', 'Prompt copied'))
}

// --- Sub-agents (Claude Code, Codex, OpenCode, Cline) ---------------------------
const children = ref(null) // from acquireChildren, while expanded
const childRows = computed(() => (children.value ? children.value.state.list : []))
const childrenKnown = computed(() => listsChildren(s.value.agent))
const subagentsLabel = computed(() => t('sessionHistory.subagents.count', 'Subagents ({{count}})', { count: childRows.value.length }))
function childLine(c) {
  return childTime(c, props.now)
}
watch(
  () => props.expanded,
  (open) => {
    if (open) {
      loadDetails()
      if (childrenKnown.value && !children.value)
        children.value = acquireChildren({ agent: s.value.agent, sessionId: s.value.id, ...(s.value.accountId !== undefined ? { accountId: s.value.accountId } : {}) })
    } else if (children.value) {
      children.value.release()
      children.value = null
    }
  },
  { immediate: true }
)
onBeforeUnmount(() => {
  clearTimeout(copiedTimer)
  if (children.value) children.value.release()
})

// --- Actions ---------------------------------------------------------------------------
const menuOpen = ref(false)
function copyText(text, what) {
  const a = api()
  if (!a || !text) return
  a.writeClipboard(text)
  emit('toast', t('sessionHistory.valueCopied', '{{value}} copied', { value: what }))
}
const copyId = () => copyText(s.value.id, t('sessionHistory.sessionId', 'Session ID'))
async function copyPath() {
  const d = await loadDetails()
  if (d && d.ok && d.file) copyText(d.file, t('sessionHistory.logPath', 'Log path'))
  else emit('toast', t('sessionHistory.row.logUnavailable', 'The transcript file was not found.'))
}
async function openLog() {
  const d = await loadDetails()
  if (d && d.ok && d.file) emit('open-log', d.file)
  else emit('toast', t('sessionHistory.row.logUnavailable', 'The transcript file was not found.'))
}
async function revealLog() {
  const a = api()
  if (!a || !a.revealSessionLog) return
  const res = await a.revealSessionLog({ agent: s.value.agent, id: s.value.id, ...(s.value.accountId !== undefined ? { accountId: s.value.accountId } : {}) }).catch(() => null)
  if (!res || !res.ok) emit('toast', t('sessionHistory.row.logUnavailable', 'The transcript file was not found.'))
}
async function openCwd() {
  const a = api()
  if (!a || !a.chatFiles || !s.value.cwd) return
  const res = await a.chatFiles.open(s.value.cwd).catch(() => null)
  if (!res || !res.ok) emit('toast', t('sessionHistory.row.folderUnavailable', 'The working directory was not found.'))
}
async function requestDelete() {
  if (deleteReason.value) return
  const a = api()
  if (!a || !a.deleteSession) return
  const question = {
    title: t('sessionHistory.delete.title', 'Delete this session?'),
    text: t('sessionHistory.delete.text', '"{{title}}" will be deleted. Once deleted, it will no longer be resumable from {{agent}}\'s own command line either.', {
      title: title.value,
      agent: agentLabel(s.value.agent)
    }),
    confirmLabel: t('sessionHistory.delete.confirm', 'Delete'),
    danger: true
  }
  const ok = askConfirm ? await askConfirm(question) : window.confirm(question.title)
  if (ok !== true) return
  const res = await a.deleteSession({ agent: s.value.agent, id: s.value.id, ...(s.value.accountId !== undefined ? { accountId: s.value.accountId } : {}) }).catch(() => null)
  if (res && res.ok) {
    emit('toast', t('sessionHistory.delete.done', 'Session deleted'))
    emit('deleted')
  } else emit('toast', t('sessionHistory.delete.failed', "Couldn't delete the session"))
}
function onRowClick(event) {
  // The menus are teleported out of the row; a click in one must not toggle it.
  if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return
  emit('toggle')
}
</script>

<template>
  <div
    class="sh-row"
    :class="{ expanded }"
    data-test="session-row"
    :data-session="session.id"
    @click="onRowClick"
    @contextmenu.prevent.stop="menuOpen = true"
  >
    <div class="sh-row-top">
      <div class="sh-row-title" :class="expanded ? 'clamp2' : 'clamp1'" :title="title">{{ title }}</div>
      <div class="sh-row-actions" @pointerdown.stop @click.stop @dblclick.stop>
        <div class="sh-hover">
          <button v-if="paneId" class="sh-icon-btn" :title="t('sessionHistory.row.jumpToOriginalPane', 'Jump to Original Pane')" :aria-label="t('sessionHistory.row.jumpToOriginalPane', 'Jump to Original Pane')" data-test="session-jump" @click="emit('focus-pane', paneId)">
            <LocateFixed :size="14" aria-hidden="true" />
          </button>
          <button v-else class="sh-icon-btn" :disabled="!canResume" :title="resumeLabel" :aria-label="resumeLabel" data-test="session-resume" @click="emit('resume')">
            <SquareTerminal v-if="fromIde" :size="14" aria-hidden="true" /><Play v-else :size="14" aria-hidden="true" />
          </button>
        </div>
        <button
          class="sh-icon-btn"
          :title="detailsTooltip"
          :aria-label="t('sessionHistory.row.toggleDetails', '{{agent}} session details', { agent: agentLabel(session.agent) })"
          :aria-expanded="expanded ? 'true' : 'false'"
          :aria-controls="detailsId"
          data-test="session-toggle"
          @click="emit('toggle')"
        >
          <ChevronDown :size="14" class="sh-chevron" :class="{ open: expanded }" aria-hidden="true" />
        </button>
        <DropdownMenu v-model:open="menuOpen">
          <DropdownMenuTrigger as-child>
            <button class="sh-icon-btn" :title="t('sessionHistory.row.moreActions', 'More Actions')" :aria-label="t('sessionHistory.row.moreSessionActions', 'More Session Actions')" data-test="session-more">
              <MoreHorizontal :size="14" aria-hidden="true" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" :side-offset="4" class="sh-menu">
            <DropdownMenuItem v-if="paneId" data-test="menu-jump" @select="emit('focus-pane', paneId)"><LocateFixed :size="14" /> {{ t('sessionHistory.row.jumpToOriginalPane', 'Jump to Original Pane') }}</DropdownMenuItem>
            <DropdownMenuItem v-else :disabled="!canResume" data-test="menu-resume" @select="emit('resume')"><SquareTerminal v-if="fromIde" :size="14" /><Play v-else :size="14" /> {{ actionText }}</DropdownMenuItem>
            <template v-if="logActions || session.cwd">
              <DropdownMenuSeparator />
              <DropdownMenuItem v-if="logActions" data-test="menu-open-log" @select="openLog"><FileJson :size="14" /> {{ t('sessionHistory.row.openLog', 'Open Log') }}</DropdownMenuItem>
              <DropdownMenuItem v-if="logActions" data-test="menu-reveal-log" @select="revealLog"><FolderOpen :size="14" /> {{ t('sessionHistory.row.revealLog', 'Reveal Log') }}</DropdownMenuItem>
              <DropdownMenuItem v-if="session.cwd" data-test="menu-open-cwd" @select="openCwd"><FolderOpen :size="14" /> {{ t('sessionHistory.row.openWorkingDirectory', 'Open Working Directory') }}</DropdownMenuItem>
            </template>
            <DropdownMenuSeparator />
            <DropdownMenuItem data-test="menu-copy-id" @select="copyId">{{ t('sessionHistory.row.copySessionId', 'Copy Session ID') }}</DropdownMenuItem>
            <DropdownMenuItem v-if="logActions" data-test="menu-copy-path" @select="copyPath">{{ t('sessionHistory.row.copyLogPath', 'Copy Log Path') }}</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" :disabled="!!deleteReason" :title="deleteReason || undefined" :aria-label="deleteReason ? `${t('sessionHistory.row.delete', 'Delete')}. ${deleteReason}` : undefined" data-test="menu-delete" @select="requestDelete">
              <Trash2 :size="14" /> {{ t('sessionHistory.row.delete', 'Delete') }}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>

    <!-- A search result: the passage that matched. -->
    <div v-if="session.evidence" class="sh-row-preview" data-test="session-evidence">
      <span class="sh-role">{{ roleLabel(session.evidence.role) }}</span>:
      <template v-for="(part, i) in session.evidence.parts" :key="i"><mark v-if="part.match">{{ part.text }}</mark><template v-else>{{ part.text }}</template></template>
    </div>

    <div class="sh-meta" data-test="session-meta">
      <span class="sh-meta-icon"><BrandIcon :kind="session.agent" :size="14" /></span>
      <span class="sh-meta-line">
        <span class="sh-meta-agent">{{ agentLabel(session.agent) }}</span>
        <template v-if="fromIde"><span class="sh-sep">·</span><span class="sh-meta-origin" data-test="session-origin">{{ t('sessionHistory.row.ideOrigin', 'IDE') }}</span></template>
        <template v-if="messagesLabel"><span class="sh-sep">·</span><span class="sh-nums">{{ messagesLabel }}</span></template>
        <span class="sh-sep">·</span><span class="sh-nums" :title="new Date(session.updated).toLocaleString()">{{ when }}</span>
        <template v-if="session.accountLabel"><span class="sh-sep">·</span><span class="sh-meta-account" :title="session.accountLabel">{{ session.accountLabel }}</span></template>
      </span>
      <div v-if="showFolder" class="sh-folder-line">
        <span class="sh-badge" :title="session.cwd">{{ folderLabel(session.cwd) }}</span>
      </div>
    </div>

    <div v-if="expanded" :id="detailsId" class="sh-details" data-test="session-details" @pointerdown.stop @click.stop @dblclick.stop>
      <div class="sh-details-actions">
        <button v-if="paneId" class="exit-btn" data-test="details-jump" @click="emit('focus-pane', paneId)"><LocateFixed :size="13" aria-hidden="true" /> {{ t('sessionHistory.row.jumpToOriginalPane', 'Jump to Original Pane') }}</button>
        <button v-else class="exit-btn primary" :disabled="!canResume" :title="resumeLabel" data-test="details-resume" @click="emit('resume')"><SquareTerminal v-if="fromIde" :size="13" aria-hidden="true" /><Play v-else :size="13" aria-hidden="true" /> {{ actionText }}</button>
        <button v-if="logActions" class="exit-btn subtle" data-test="details-view-log" @click="openLog"><FileJson :size="13" aria-hidden="true" /> {{ t('sessionHistory.details.viewLog', 'View Log') }}</button>
      </div>
      <div class="sh-details-body">
        <section class="sh-section">
          <div class="sh-section-head"><TextCursorInput :size="12" aria-hidden="true" /><span>{{ promptLabel }}</span></div>
          <div class="sh-card sh-card-user">
            <div class="sh-card-head">
              <span class="sh-card-role">{{ t('sessionHistory.role.user', 'You') }} <LoaderCircle v-if="detailsLoading" :size="12" class="sh-spin" aria-hidden="true" /></span>
              <button class="sh-copy" :disabled="!promptText" :aria-label="promptFull ? t('sessionHistory.details.copyFirstPrompt', 'Copy first prompt') : t('sessionHistory.details.copyPrompt', 'Copy prompt')" data-test="details-copy-prompt" @click="copyPrompt">
                <Check v-if="copied" :size="12" aria-hidden="true" /><Copy v-else :size="12" aria-hidden="true" />
                {{ copied ? t('sessionHistory.details.copied', 'Copied') : t('sessionHistory.details.copy', 'Copy') }}
              </button>
            </div>
            <p v-if="promptText" class="sh-card-text" data-test="details-prompt">{{ promptText }}</p>
            <p v-else-if="detailsLoading" class="sh-card-empty">{{ t('sessionHistory.details.loadingFirstPrompt', 'Loading first prompt…') }}</p>
            <p v-else class="sh-card-empty">{{ t('sessionHistory.details.noFirstPrompt', 'No first prompt available') }}</p>
          </div>
        </section>
        <section v-if="logActions" class="sh-section">
          <div class="sh-section-head"><MessageSquare :size="12" aria-hidden="true" /><span>{{ t('sessionHistory.details.latestTurns', 'Latest turns') }}</span></div>
          <div v-if="turns.length" class="sh-turns" data-test="details-turns">
            <div v-for="(turn, i) in turns" :key="i" class="sh-card" :class="turn.role === 'user' ? 'sh-card-user' : 'sh-card-agent'">
              <div class="sh-card-role">{{ roleLabel(turn.role) }}</div>
              <p class="sh-card-text clamp4">{{ turn.text }}</p>
            </div>
          </div>
          <div v-else-if="detailsLoading" class="sh-empty-box">{{ t('app.sessions.loading', 'Loading…') }}</div>
          <div v-else class="sh-empty-box">{{ t('sessionHistory.details.noPreview', 'No conversation preview available') }}</div>
        </section>
        <section v-if="childrenKnown" class="sh-section" data-test="details-subagents">
          <div class="sh-section-head"><Bot :size="12" aria-hidden="true" /><span>{{ subagentsLabel }}</span></div>
          <p v-if="children && !children.state.at" class="sh-card-empty" role="status">{{ t('sessionHistory.subagents.loading', 'Loading subagents…') }}</p>
          <p v-else-if="!childRows.length" class="sh-card-empty">{{ t('sessionHistory.subagents.empty', 'No subagents found.') }}</p>
          <div v-else class="sh-turns">
            <div v-for="c in childRows" :key="c.id" class="sh-child">
              <div class="sh-child-top">
                <span class="sh-dot" :class="'is-' + childDotState(c)" aria-hidden="true"></span>
                <span class="sh-child-title" :title="c.title">{{ maskSecrets(c.title || c.type || c.id) }}</span>
              </div>
              <div class="sh-child-meta">
                <span v-if="c.type" class="sh-badge">{{ c.type }}</span>
                <span class="sh-nums">{{ childLine(c) }}</span>
              </div>
            </div>
          </div>
        </section>
        <section v-if="session.cwd" class="sh-section">
          <div class="sh-section-head"><Folder :size="12" aria-hidden="true" /><span>{{ t('sessionHistory.details.workingDirectory', 'Working directory') }}</span></div>
          <div class="sh-path" :title="session.cwd">{{ session.cwd }}</div>
        </section>
      </div>
    </div>
  </div>
</template>
