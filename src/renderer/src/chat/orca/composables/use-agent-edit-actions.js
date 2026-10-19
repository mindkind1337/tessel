// Tessel: an agent's file tools, opened like an agentic IDE does: the file a
// Read / Edit / Write / apply_patch names, at the line it read or first
// changed (Tessel's link router, panelCtx.openTarget: the editor, the image
// viewer, the PDF window); an edit's before / after in an editor diff tab
// (panelCtx.openAgentDiff); a turn's changes in Review or Source Control
// (panelCtx.reviewPaneChanges). The pure part is chat/agentEdits.js.
//
// Paths are read against the chat's file-link context (provided by the chat
// views as 'nativeChatFileLinkContext'): the pane's folder or worktree copy, an
// SSH host's files by their ssh:// path. A conversation from elsewhere (a Live
// Share host's, read by a guest) has none: its paths stay plain text.
import { computed, inject, toValue } from 'vue'
import { t } from '../../../i18n'
import {
  editSteps,
  firstChangedLine,
  isInputPath,
  locateSteps,
  resolveToolPath,
  revertSteps,
  snippetSides
} from '../../agentEdits.js'

// Bigger than this, a side of the diff tab is the edit's own snippet.
const MAX_DIFF_TEXT = 5 * 1024 * 1024

function editorApi() {
  return globalThis.window?.shellApi?.editor || null
}
async function readText(file) {
  const api = editorApi()
  if (!api || typeof api.read !== 'function') return null
  try {
    const r = await api.read(file)
    return r && r.ok && typeof r.text === 'string' ? r.text : null
  } catch {
    return null
  }
}
async function headText(file) {
  const api = editorApi()
  if (!api || typeof api.head !== 'function') return null
  try {
    const r = await api.head(file)
    return r && r.ok && typeof r.text === 'string' ? r.text : null
  } catch {
    return null
  }
}

// A short, stable id for a diff tab (its path suffix).
function tabKey(parts) {
  let h = 5381
  for (const ch of parts.join('\n')) h = ((h << 5) + h + ch.charCodeAt(0)) | 0
  return (h >>> 0).toString(36)
}

export function useAgentEditActions() {
  const panel = inject('panelCtx', null)
  const linkContext = inject('nativeChatFileLinkContext', null)
  const context = computed(() => toValue(linkContext) || null)

  // edit: { block, file? } -> the path to open, or null (plain text).
  function pathOf(block, path) {
    const fromPatch = !isInputPath(block, path)
    return resolveToolPath(path, { block, context: context.value, fromPatch })
  }

  // Whether this chat's paths open at all (and the router is there).
  const canOpen = computed(() => !!context.value && typeof panel?.openTarget === 'function')
  const canDiff = computed(() => !!context.value && typeof panel?.openAgentDiff === 'function')
  const canReview = computed(() => !!context.value && !!context.value.worktreeId && typeof panel?.reviewPaneChanges === 'function')

  // The line to open at: one the agent recorded or the card numbers, else
  // found in the file as it is now.
  async function lineFor(target, edits, line) {
    if (line) return line
    const known = edits
      .map((e) => firstChangedLine(e.file) || (Number.isSafeInteger(e.block?.editLine) && e.block.editLine > 0 ? e.block.editLine : null))
      .filter(Boolean)
    if (known.length) return Math.min(...known)
    const steps = edits.flatMap((e) => editSteps(e.block, e.file || null, e.resultText || '') || [])
    if (!steps.length) return null
    const text = await readText(target)
    return text === null ? null : locateSteps(text, steps)
  }

  // Opens `path` (as the tool named it) at `line` or at the edits' first change.
  // edits: [{ block, file?, resultText? }] (the first one's block reads the path).
  async function openAt({ path, edits = [], line = null } = {}, event) {
    if (!canOpen.value || !edits.length) return false
    const target = pathOf(edits[0].block, path)
    if (!target) {
      panel?.toast?.(t('chat.agentEdits.cannotOpen', 'This file cannot be opened from here: {{path}}', { path }), { kind: 'error' })
      return false
    }
    const at = await lineFor(target, edits, line)
    return panel.openTarget({ path: target, line: at }, { event })
  }

  // An editor diff tab of the edits to one file: its whole before / after when
  // the file still holds what they wrote, else the edits' own snippets.
  async function openDiff({ path, edits = [], title = '' } = {}) {
    if (!canDiff.value || !edits.length) return false
    const target = pathOf(edits[0].block, path)
    const steps = edits.flatMap((e) => editSteps(e.block, e.file || null, e.resultText || '') || [])
    if (!target || !steps.length) {
      panel?.toast?.(t('chat.agentEdits.noDiff', 'No diff to show for {{path}}', { path }), { kind: 'error' })
      return false
    }
    const deleted = steps[steps.length - 1].kind === 'deleted'
    const current = deleted ? '' : await readText(target)
    let original = current === null ? null : revertSteps(current, steps)
    // A file written whole over an older one: the committed version stands for its before.
    if (original === null && current !== null && steps.length === 1 && steps[0].kind === 'write') original = await headText(target)
    let modified = current
    let snippet = false
    if (original === null || modified === null || original.length > MAX_DIFF_TEXT || modified.length > MAX_DIFF_TEXT) {
      ;({ original, modified } = snippetSides(steps))
      snippet = true
    }
    const key = tabKey([target, ...edits.map((e) => String(e.block?.callId || e.block?.name || '')), String(edits.length)])
    const line = await lineFor(target, edits, null).catch(() => null)
    return !!panel.openAgentDiff({ file: target, original, modified, snippet, key, title, line: snippet ? null : line })
  }

  // The pane's changes: its task's Review (a worktree copy), else Source Control.
  function reviewAll() {
    if (!canReview.value) return false
    return panel.reviewPaneChanges(context.value.worktreeId)
  }

  return { canOpen, canDiff, canReview, pathOf, openAt, openDiff, reviewAll }
}
