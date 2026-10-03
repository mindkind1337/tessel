<script setup>
import PaneActionsMenu from './PaneActionsMenu.vue'
import { unref } from 'vue'
import { teamNumber } from '../teamNumber'
import { ref, reactive, inject, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { SearchAddon } from '@xterm/addon-search'
import { WebglAddon } from '@xterm/addon-webgl'
import { getBuffer } from '../ptyStore'
import BrandIcon from './BrandIcon.vue'
import { settings, fontStack } from '../settings'
import { terminalTheme } from '../themes'

// Mouse-reporting modes (X10, normal, button, any-event, UTF-8, SGR, urxvt).
const MOUSE_MODES = [9, 1000, 1002, 1003, 1005, 1006, 1015]
import { registerPane, unregisterPane, getPane } from '../paneRegistry'
import {
  setAgentStatus,
  setAttention,
  clearAttention,
  attention,
  limits,
  setLimit,
  clearLimit,
  setApproval,
  approvals,
  agentStates,
  getAgentState,
  managedAgentStatus,
  agentScreenObservation,
  claudeInputImages,
  codexInputImages,
  createAgentActivityMonitor,
  turnEndedSince,
  paneMonitoring,
  monitoring
} from '../agentStatus'
import { promptShowsPlaceholder } from '../promptCheck'
import { detectTaskDone } from '../agentLimit'
import { modelLabel } from '../../../shared/modelLabel'
import { modelFromScreen, modelFromSwitchLine } from '../../../shared/screenModel'
import { findFileRefs } from '../../../shared/fileLinks'
import { osc52Text } from '../../../shared/osc52'
import { stripTerminalSelectionGutter } from '../../../shared/terminalSelectionGutter'
import { buildInputModeReset } from '../../../shared/terminalModeReset'
import { terminalSettingOptions, composeTerminalTheme, useWebgl, METRIC_OPTIONS } from '../terminalOptions'
import { cacheCountdown } from '../promptCache'
import { isViewed } from '../../../shared/fileKinds'
import { effectiveAgent, launchSignature, launchSessionValues, inYoloFolder, YOLO_ARGS, YOLO_ENV } from '../../../shared/agentPrefs'
import { getAgentSessionOptionCatalog, modelOptions, resolveSessionOptionDefaults, composedModelId, listedModelValues, valuesOnListedRow } from '../../../shared/agentSessionOptions'
import { cursorContextOnScreen, cursorModelOnScreen, cursorPickerFilter, cursorPickerShown } from '../../../shared/cursorModels'
import { paneModels } from '../paneModels'
import { modelsFor, refreshIfStale } from '../agentModels'
import { modelChoiceLabel, sessionPillLabel } from '../sessionOptionLabels'
import { switchClaudeModel, typeCommand } from '../claudeModelSwitch'
import SessionOptionPicker from './SessionOptionPicker.vue'
import AgentChildren from './AgentChildren.vue'
import NativeChatTranscriptView from './chat/orca/NativeChatTranscriptView.vue'
import {
  KEY_SHIFT_TAB,
  canCycleToYolo,
  canShowChatView,
  chatViewTakesImages,
  composerAgent,
  launchArgsOf,
  launchPermissionMode,
  permissionModeFromScreen,
  shownPermissionMode,
  stepToPermissionMode
} from '../chat/terminalChatBridge'
import { promptSuggestionOnScreen, suggestionScreenRows } from '../chat/terminalChatExtras'
import { listsChildren } from '../agentChildrenFeed'
import HoverCardContent from './hover/HoverCardContent.vue'
import PaneHoverDetails from './PaneHoverDetails.vue'
import { useHoverCard } from './hover/useHoverCard'
import { agentStateLabel } from '../sidebarModel'
import { t, intlLocale } from '../i18n'
import { remoteHostsState } from '../remoteHosts'
import { nativeChatSessionChoiceLabel } from '../chat/orca/native-chat-session-option-labels'

const props = defineProps({
  node: { type: Object, required: true }
})

const ctx = inject('panelCtx')
const hostEl = ref(null)
const exited = ref(false)
// False once the pane is gone (checked after awaits).
let mounted = true
const exitCode = ref(null)
// Scrolled up into history? Then offer a button back to the latest output.
const scrolledUp = ref(false)
const newBelow = ref(false)
const MIN_COLS = 40
const MIN_ROWS = 10

const isActive = computed(() => ctx.activeId.value === props.node.id)
const isMember = computed(() => ctx.broadcast.value && props.node.broadcast)
const isMaximized = computed(() => ctx.maximizedId.value === props.node.id)
const isAgent = computed(() => props.node.kind === 'agent')
// An agent pane asks for its model list (missing or a day old) once it
// opens: its pickers (header, chat view, Settings) all list from it, not
// only the pane menu's.
watch(
  () => (props.node.kind === 'agent' ? props.node.agentId : null),
  (agentId) => {
    if (agentId) refreshIfStale(agentId)
  },
  { immediate: true }
)

/// The model the agent uses, shown in the header: read from its conversation
// file (so a /model change shows up), its command or its settings, else from
// its screen (status bar or banner, for agents Tessel has no file for). The
// model chosen for it (Tessel added the flag, or /model was applied) shows
// until its conversation answers with another model. Checked every 20 s, each
// time it finishes working, and when one of those files changes.
const agentModel = ref(null) // { model, effort, source } | null
// Cursor: the context its status line shows ({ usedTokens, windowTokens }), for the chat view's ring.
const screenContext = ref(null)
// Claude Code: the next message it suggests, greyed in its empty prompt (the
// chat view's placeholder; Tab takes it there too).
const promptSuggestion = ref('')
function readPromptSuggestion() {
  if (props.node.agentId !== 'claude') return ''
  // (Also called before the terminal exists: term is declared further down.)
  try {
    return term ? suggestionRows() : ''
  } catch {
    return ''
  }
}
function suggestionRows() {
  return promptSuggestionOnScreen(suggestionScreenRows(term.buffer.active, term.rows))
}
// An effort in the app's language, as the chat's composer says it ("Moyen").
const effortName = (effort) => nativeChatSessionChoiceLabel({ value: effort, label: effort })
const modelText = computed(() => {
  const m = agentModel.value
  if (!m || !m.model) return ''
  return (m.name || modelLabel(m.model)) + (m.effort ? ` · ${effortName(m.effort)}` : '')
})
// For the team roster (team_members): the model this pane shows.
watch(
  modelText,
  (text) => {
    if (text) paneModels[props.node.id] = text
    else delete paneModels[props.node.id]
  },
  { immediate: true }
)
onBeforeUnmount(() => delete paneModels[props.node.id])
const modelTitle = computed(() => {
  const m = agentModel.value
  if (!m) return ''
  const from =
    m.source === 'session'
      ? t('pane.model.fromSession', 'from its latest answer')
      : m.source === 'command'
        ? t('pane.model.fromCommand', 'from its command')
        : m.source === 'picked'
          ? t('pane.model.fromPicked', 'the model last picked in it')
          : m.source === 'chosen'
            ? t('pane.model.fromChosen', 'chosen in Tessel (pane menu > Model, or Settings > Agents)')
            : m.source === 'screen'
              ? t('pane.model.fromScreen', 'read from its screen (status bar or banner)')
              : m.source === 'running'
                ? t('pane.model.fromRunning', 'the only model Ollama has running')
              : t('pane.model.fromSettings', 'from its settings (a change inside the agent may not show)')
  const head = m.effort
    ? t('pane.model.titleEffort', 'Model: {{model}} (reasoning {{effort}})', { model: m.model, effort: effortName(m.effort) })
    : t('pane.model.title', 'Model: {{model}}', { model: m.model })
  return `${head}\n${from}`
})
// The model this pane was given ({ model, effort, seen }): seen is the model
// its conversation showed first after that (an older answer), so a newer
// answer with another model takes over.
function chosenShown(n, res) {
  // Launched with a model of its own (--model from the pane's choice,
  // saved with the layout): that one until its session says otherwise.
  if ((!n.modelChoice || !n.modelChoice.model) && n.sessionOptions && typeof n.sessionOptions.model === 'string' && n.sessionOptions.model) {
    if (res && res.source === 'session' && res.model) return res
    const effort = typeof n.sessionOptions.effort === 'string' ? n.sessionOptions.effort : (res && res.chosenEffort) || null
    return { model: modelChoiceLabel(modelsFor(n.agentId), n.sessionOptions.model), effort, source: 'chosen' }
  }
  const c = n.modelChoice
  if (!c || !c.model) return res
  if (res && res.source === 'session') {
    // An answer written after the pick: the session says what runs now
    // (a later /model or /effort in the agent included).
    if (res.at && c.at && res.at > c.at) {
      delete n.modelChoice
      return res
    }
    if (c.seen === undefined) c.seen = res.model
    else if (res.model !== c.seen) {
      delete n.modelChoice
      return res
    }
  }
  return { model: modelChoiceLabel(modelsFor(n.agentId), c.model), effort: c.effort || (res && (res.chosenEffort || res.effort)) || null, source: 'chosen' }
}
// { model } with a bare family name ("opus", "Opus", "opus[1m]"): the full id
// of the same family from the agent's own report, when it has one.
function withModelVersion(shown, ...reported) {
  const bare = /^(opus|sonnet|haiku|fable)(\[1m\])?$/i.exec(String(shown.model || '').trim())
  if (!bare) return shown
  const family = bare[1].toLowerCase()
  const full = reported.find((m) => typeof m === 'string' && new RegExp(`^(?:claude-)?${family}-\\d`, 'i').test(m.trim()))
  return full ? { ...shown, model: full.trim() + (bare[2] && !/\[1m\]$/i.test(full) ? '[1m]' : '') } : shown
}
let modelBusy = false
let modelAgain = false // asked while a check ran: one more after it
async function refreshModel() {
  if (!isAgent.value || !window.shellApi.agentModel) {
    if (!isAgent.value) agentModel.value = null
    return
  }
  if (modelBusy) {
    modelAgain = true
    return
  }
  modelBusy = true
  promptSuggestion.value = readPromptSuggestion()
  try {
    const n = props.node
    // Cursor: the line under its prompt says what this session runs
    // ("GPT-5.6 Sol 272K High Fast"), a pick in its own picker included;
    // while that picker is open, what it showed stays.
    if (n.agentId === 'cursor' && term) {
      const lines = screenText(8).split('\n')
      // Kept while its status line is out of sight; gone in a new conversation.
      const ctx = cursorContextOnScreen(lines, modelsFor('cursor'))
      if (ctx) screenContext.value = ctx.none ? null : ctx
      if (cursorPickerShown(lines) && agentModel.value) return
      const seen = cursorModelOnScreen(lines, modelsFor('cursor'))
      if (seen) {
        delete n.modelChoice
        agentModel.value = { model: seen.model, name: seen.name, effort: seen.effort, source: 'screen' }
        return
      }
    }
    let res = await window.shellApi.agentModel({
      agentId: n.agentId,
      sessionId: n.sessionId,
      // Its launch arguments too: a --model or --effort Tessel added (a
      // default from Settings > Agents) beats its settings file.
      command: [n.agentCommand, launchArgsOf(n), n.detectedCommand].filter(Boolean).join(' '),
      cwd: n.startDir,
      launchedAt: n.launchedAt || 0,
      chosenModel:
        n.sessionOptions && typeof n.sessionOptions.model === 'string'
          ? n.sessionOptions.model
          : n.modelChoice && typeof n.modelChoice.model === 'string'
            ? n.modelChoice.model
            : undefined
    })
    if ((!res || !res.model) && !n.modelChoice) {
      const seen = modelOnScreen()
      // The effort its settings give still shows (res.chosenEffort).
      if (seen) res = { model: seen, effort: (res && res.chosenEffort) || null, source: 'screen' }
    }
    // Only a default from its settings (no conversation written yet): a
    // model switched in the session (/model → "Set model to …") is newer.
    if (res && res.source === 'settings' && !n.modelChoice) {
      const switched = modelSwitchedOnScreen()
      if (switched) res = { model: switched, effort: res.effort || null, source: 'screen' }
    }
    // A name without its version (an alias such as "opus", chosen in the pane
    // or by /model): the version comes from what the agent itself reports,
    // its latest answer or its /model line ("claude-opus-5-5" -> Opus 5.5).
    const shown = chosenShown(n, res)
    agentModel.value = shown && n.agentId === 'claude' ? withModelVersion(shown, res && res.source === 'session' ? res.model : null, modelSwitchedOnScreen()) : shown
  } catch {
    /* keep what it showed */
  } finally {
    modelBusy = false
    if (modelAgain) {
      modelAgain = false
      refreshModel()
    }
  }
}
// The model the agent prints: its status bar (last lines on screen) or
// its welcome banner (first lines of its output).
// The last "Set model to <name>" Claude Code printed (its /model result),
// from the lines on screen and the recent scrollback; display only.
function modelSwitchedOnScreen() {
  if (!term || props.node.agentId !== 'claude') return null
  const buf = term.buffer.active
  const from = Math.max(0, buf.length - 400)
  for (let y = buf.length - 1; y >= from; y--) {
    const line = buf.getLine(y)
    const text = line ? line.translateToString(true) : ''
    const m = modelFromSwitchLine(text)
    if (m) return m
  }
  return null
}
function modelOnScreen() {
  if (!term) return null
  const buf = term.buffer.active
  const top = []
  for (let y = 0; y < Math.min(buf.length, 30); y++) {
    const line = buf.getLine(y)
    if (line) top.push(line.translateToString(true))
  }
  return modelFromScreen({ bottom: screenText(6).split('\n'), top })
}

// Pane menu > Model: Orca's per-session picker (SessionOptionPicker). The
// pane keeps its own choice (node.sessionOptions, saved with the layout);
// none = the agent's default from Settings > Agents, or its own.
// In a running agent a pick applies the way Orca does it: Claude Code's
// model with /model (its "Switch model?" question answered, the result read
// from its screen), its effort with /effort, fast mode with /fast; an agent
// that changes model in its own picker (Codex) gets /model typed for you;
// the rest applies at the next start (Restart to apply).
const modelMenu = reactive({ visible: false, x: 0, y: 0, pending: false })
const modelMenuEl = ref(null)
const hasModelChoice = computed(() => isAgent.value && !props.node.detected && !!getAgentSessionOptionCatalog(props.node.agentId))
const paneModelList = computed(() => (hasModelChoice.value ? modelsFor(props.node.agentId) : []))
// The listed model the agent runs with (what it shows, else the list's
// default): its effort can be chosen without picking a model first.
const effectiveModelId = computed(() => {
  const list = paneModelList.value
  if (!list.length) return null
  const shown = agentModel.value && agentModel.value.model
  if (shown) {
    const exact = list.find((m) => m.id === shown) || list.find((m) => m.label === shown)
    if (exact) return exact.id
    // A Cursor variant id (gpt-5.3-codex-high-fast): its model's row.
    const listed = listedModelValues(list, shown)
    if (listed) return listed.model
    const alias = list.find((m) => shown.includes(`-${m.id}-`) || shown.endsWith(`-${m.id}`))
    if (alias) return alias.id
  }
  const byDefault = list.find((m) => m.isDefault)
  return (byDefault || list[0]).id
})
// The menu's checked values: the pane's own choice; a running Cursor, what
// its status line shows (a pick in its own picker included).
const paneMenuValues = computed(() => {
  const m = agentModel.value
  if (props.node.agentId === 'cursor' && paneRunning.value && m && m.source === 'screen') return listedModelValues(paneModelList.value, m.model) || props.node.sessionOptions || null
  return props.node.sessionOptions || null
})
// What the pane uses: its own choice, else the default from Settings.
const paneValues = computed(() => launchSessionValues(props.node.sessionOptions, settings.agentSessionOptions, props.node.agentId))
const settingsDefault = computed(() => resolveSessionOptionDefaults(settings.agentSessionOptions, props.node.agentId))
const paneRunning = computed(() => isAgent.value && !exited.value && !props.node.sleeping && !props.node.failed && !props.node.notConnected)
const paneBusy = computed(() => shownState.value === 'working' || agentStatus.value === 'busy' || asksApproval.value)
const modelDefaultLabel = computed(() =>
  settingsDefault.value
    ? t('pane.sessionOptions.settingsDefault', 'Default from Settings ({{model}})', {
        model: sessionPillLabel(paneModelList.value, settingsDefault.value)
      })
    : t('pane.sessionOptions.agentDefault', "Agent's own default")
)
const modelMenuNote = computed(() => {
  if (!paneRunning.value) return t('pane.sessionOptions.appliesAtStart', 'Applies when the agent starts.')
  const catalog = getAgentSessionOptionCatalog(props.node.agentId)
  const mid = catalog && catalog.modelApply.midSession
  if (mid && mid.kind === 'picker-filter') return t('pane.sessionOptions.cursorLive', 'A model chosen here switches at once; its effort or Fast opens its own picker in the terminal (Tab on the model).')
  return mid && mid.kind === 'command' ? '' : t('pane.sessionOptions.appliesAtRestart', 'A model picked here applies when the agent restarts.')
})
const modelBusyReason = computed(() =>
  paneRunning.value && paneBusy.value ? t('pane.sessionOptions.waitIdle', 'It is working: its model can change once it is idle.') : ''
)
// The header's model chip: the short name in use (the session's, else the
// launch choice), with its effort whenever it is known (medium included:
// the user wants to see it).
const headerModelText = computed(() => {
  const m = agentModel.value
  if (!isAgent.value || !m || !m.model) return ''
  const name = m.name || modelLabel(m.model)
  return m.effort ? `${name} · ${effortName(m.effort)}` : name
})
function openModelMenuAtChip(e) {
  const r = e.currentTarget.getBoundingClientRect()
  openModelMenuAt(r.left, r.bottom + 2)
}
function menuModel() {
  const x = ctxMenu.x
  const y = ctxMenu.y
  closeCtxMenu()
  openModelMenuAt(x, y)
}
async function openModelMenuAt(x, y) {
  headerHover.dismiss()
  modelMenu.x = x
  modelMenu.y = y
  modelMenu.visible = true
  await nextTick()
  const el = modelMenuEl.value
  if (!el) return
  el.focus({ preventScroll: true })
  const r = el.getBoundingClientRect()
  if (modelMenu.x + r.width > window.innerWidth) modelMenu.x = window.innerWidth - r.width - 4
  if (modelMenu.y + r.height > window.innerHeight) modelMenu.y = window.innerHeight - r.height - 4
  modelMenu.x = Math.max(4, modelMenu.x)
  modelMenu.y = Math.max(4, modelMenu.y)
}
function closeModelMenu(refocus = false) {
  modelMenu.visible = false
  if (refocus && term) termFocus()
}
// The pane's values after this pick (null = back to the default).
function nextPaneValues(optionId, value) {
  // A running Cursor: from the model its status line shows.
  const base = (props.node.agentId === 'cursor' && paneRunning.value && paneMenuValues.value) || paneValues.value
  const current = valuesOnListedRow(paneModelList.value, base)
  if (optionId === 'model') {
    if (!value) return null
    const next = { model: value }
    const catalog = getAgentSessionOptionCatalog(props.node.agentId)
    // An effort the new model also offers is kept.
    const effort = current && current.effort
    const offers = modelOptions(catalog, paneModelList.value, value).some(
      (o) => o.id === 'effort' && o.kind.type === 'select' && o.kind.choices.some((c) => c.value === effort)
    )
    if (effort && offers) next.effort = effort
    return next
  }
  if (!current || !current.model) {
    // No model chosen: an effort keeps the model the agent runs with.
    const model = effectiveModelId.value
    if (!model || value === null || value === undefined) return current
    return { model, [optionId]: value }
  }
  const next = { ...current }
  if (value === null || value === undefined) delete next[optionId]
  else next[optionId] = value
  return next
}
// A change applied in the running agent: it now runs with these values, so
// no restart is asked for them (unless other settings changed already).
function adoptLive(next) {
  const n = props.node
  const wasCurrent = !!n.launchSig && signatureNow(n) === n.launchSig
  setPaneChoice(next)
  if (wasCurrent) n.launchSig = signatureNow(n)
  if (next && next.model) n.modelChoice = { model: next.model, effort: typeof next.effort === 'string' ? next.effort : null, at: Date.now() }
  refreshModel()
}
function setPaneChoice(next) {
  const n = props.node
  if (next) n.sessionOptions = next
  else delete n.sessionOptions
}
function optionApply(catalog, optionId, modelId) {
  if (optionId === 'model') return catalog.modelApply
  const option = modelOptions(catalog, paneModelList.value, modelId).find((o) => o.id === optionId)
  // An option that is part of the model's id (Cursor's effort, Fast,
  // Thinking) changes the model: /model with the new id.
  if (option && option.apply.composedIntoModel && catalog.composeModelValue) return catalog.modelApply
  return option ? option.apply : null
}
let pickRefresh = null // reads Cursor's status line again after a pick
// A pick applied: the same path for this menu and for the chat view's
// pickers, so both agree. -> null (no catalog) | 'saved' (kept for the next
// start) | 'busy' | 'applied' | 'sent' (typed, not confirmed) | 'rejected' |
// 'unknown'
async function applyModelPick({ optionId, value }) {
  const n = props.node
  const catalog = getAgentSessionOptionCatalog(n.agentId)
  if (!catalog) return null
  const next = nextPaneValues(optionId, value)
  const apply = optionApply(catalog, optionId, next && next.model)
  const mid = apply && apply.midSession
  // Cursor: its /model <text> filters its own picker by name and switches
  // at once when one model matches ("/model Codex 5.3"); an id or an effort
  // in the text matches nothing. A model: /model with its name (sent, then
  // its status line tells what runs). An effort or Fast: its picker, where
  // Tab on the model sets them. Nothing is kept for the next start (Cursor
  // remembers its last pick itself).
  if (paneRunning.value && value !== null && value !== undefined && mid && mid.kind === 'picker-filter') {
    if (paneBusy.value || modelMenu.pending) return 'busy'
    const row = optionId === 'model' ? paneModelList.value.find((m) => m.id === value) : null
    const filter = cursorPickerFilter(row)
    modelMenu.pending = true
    try {
      await typeCommand(n.id, mid.build(filter))
    } finally {
      modelMenu.pending = false
    }
    clearTimeout(pickRefresh)
    pickRefresh = setTimeout(refreshModel, 1500)
    return filter ? 'sent' : 'picker'
  }
  // Not running, a value going back to a default, or a change the running
  // session takes only in its own picker: kept for the next start.
  if (!paneRunning.value || value === null || value === undefined || !mid || mid.kind !== 'command') {
    setPaneChoice(next)
    if (!paneRunning.value) refreshModel()
    return 'saved'
  }
  if (paneBusy.value || modelMenu.pending) return 'busy'
  modelMenu.pending = true
  try {
    if (mid.detectAgentInteraction === 'claude-model-switch-confirmation') {
      const outcome = await switchClaudeModel(n.id, value, modelChoiceLabel(paneModelList.value, value))
      if (outcome === 'applied') adoptLive(next)
      else if (outcome !== 'rejected') setPaneChoice(next)
      return outcome === 'applied' || outcome === 'rejected' ? outcome : 'unknown'
    }
    // The exact id the agent takes: Cursor's row and options compose into
    // one of the ids it listed (gpt-5.3-codex + High + Fast ->
    // gpt-5.3-codex-high-fast).
    const sent = catalog.composeModelValue && apply === catalog.modelApply ? composedModelId(n.agentId, next, paneModelList.value) : value
    await typeCommand(n.id, mid.build(sent), { delivery: mid.delivery === 'type' ? 'type' : 'write' })
    adoptLive(next)
    return 'sent'
  } finally {
    modelMenu.pending = false
  }
}
async function onModelPick(pick) {
  const outcome = await applyModelPick(pick).catch(() => 'unknown')
  if (outcome === null || outcome === 'saved' || outcome === 'busy') return
  if (outcome === 'picker') {
    // Its picker is in the terminal: the chat view gives way to it.
    if (props.node.chatView) props.node.chatView = undefined
    ctx.toast && ctx.toast(t('pane.sessionOptions.pickerOpened', 'Its model picker is open in the terminal: Tab on the model changes its effort or Fast.'), { timeout: 6000 })
  } else if (outcome === 'rejected') ctx.toast && ctx.toast(t('pane.sessionOptions.kept', 'Claude kept the current model.'), { kind: 'error' })
  else if (outcome === 'unknown') ctx.toast && ctx.toast(t('pane.sessionOptions.unverified', 'Could not verify the model change; open the terminal to check.'), { kind: 'error', timeout: 8000 })
  else if (outcome === 'sent') ctx.toast && ctx.toast(t('pane.sessionOptions.sentNotConfirmed', 'Sent to the agent — not confirmed'), { timeout: 3000 })
  closeModelMenu(true)
}
// The chat view's model and effort pickers: what this pane's menu offers
// (Claude Code: /model, /effort typed into it; Codex: its own picker, which
// the chat view opens in the terminal), with the values its header shows.
const chatSessionOptions = computed(() => {
  if (!hasModelChoice.value || !chatViewAvailable.value) return null
  const m = agentModel.value
  // A Cursor variant id it reports carries its effort (gpt-5.3-codex-high-fast).
  const listed = m && m.model ? listedModelValues(paneModelList.value, m.model) : null
  const effort = (m && m.effort) || (listed && listed.effort) || (paneValues.value && paneValues.value.effort) || null
  return { models: paneModelList.value, values: { ...(effectiveModelId.value ? { model: effectiveModelId.value } : {}), ...(effort ? { effort } : {}) } }
})
// { model } | { effort } from the chat view -> { ok, error }: applied the way
// this pane's model menu applies it (applyModelPick), never while it works
// or while a line is typed in its terminal.
async function chatSetOption(payload) {
  const optionId = Object.keys(payload || {})[0]
  const value = optionId ? payload[optionId] : undefined
  const unsupported = t('chat.orca.options.unsupported', 'This option is not available for this agent.')
  if (!chatSessionOptions.value || !['model', 'effort'].includes(optionId) || typeof value !== 'string' || !value) return { ok: false, error: unsupported }
  // An effort for a model that has none (Haiku): said so, not "at restart".
  if (optionId === 'effort' && !modelHasEffort(effectiveModelId.value)) return { ok: false, error: t('pane.sessionOptions.noEffort', 'This model has no reasoning effort to choose.') }
  if (!paneRunning.value) return { ok: false, error: t('pane.sessionOptions.appliesAtStart', 'Applies when the agent starts.') }
  if (paneBusy.value || modelMenu.pending) return { ok: false, error: t('pane.sessionOptions.waitIdle', 'It is working: its model can change once it is idle.') }
  if (ctx.paneUserTyping && ctx.paneUserTyping(props.node.id)) return { ok: false, error: t('pane.chatView.typedLine', 'A line is typed in its terminal: send or clear it there first.') }
  const outcome = await applyModelPick({ optionId, value }).catch(() => 'unknown')
  if (outcome === 'applied' || outcome === 'sent') return { ok: true }
  if (outcome === 'picker') return { ok: true, picker: true }
  if (outcome === 'rejected') return { ok: false, error: t('pane.sessionOptions.kept', 'Claude kept the current model.') }
  if (outcome === 'unknown') return { ok: false, error: t('pane.sessionOptions.unverified', 'Could not verify the model change; open the terminal to check.') }
  if (outcome === 'busy') return { ok: false, error: t('pane.sessionOptions.waitIdle', 'It is working: its model can change once it is idle.') }
  return { ok: false, error: t('pane.sessionOptions.appliesAtRestart', 'A model picked here applies when the agent restarts.') }
}
// The model offers a reasoning effort (the catalog's options for it).
function modelHasEffort(modelId) {
  const catalog = getAgentSessionOptionCatalog(props.node.agentId)
  return !!catalog && modelOptions(catalog, paneModelList.value, modelId).some((o) => o.id === 'effort')
}
// A flip-only option (/fast) or the agent's own picker (Codex's /model).
async function onModelAction({ optionId }) {
  const n = props.node
  const catalog = getAgentSessionOptionCatalog(n.agentId)
  if (!catalog || !paneRunning.value || paneBusy.value) return
  const apply = optionApply(catalog, optionId, paneValues.value && paneValues.value.model)
  const mid = apply && apply.midSession
  if (!mid || (mid.kind !== 'toggle-command' && mid.kind !== 'agent-picker')) return
  closeModelMenu(true)
  await typeCommand(n.id, mid.command, { delivery: mid.delivery === 'type' ? 'type' : 'write' })
}

// Every 20 s while the window is on screen (a file read per agent pane; a
// change of its model files is also told right away, below).
const modelTimer = setInterval(() => document.visibilityState !== 'hidden' && refreshModel(), 20000)
// Tessel watches the agents' model files: a change shows right away.
const stopModelChanged = window.shellApi.onAgentModelChanged
  ? window.shellApi.onAgentModelChanged((agentId) => {
      if (isAgent.value && agentId === props.node.agentId) refreshModel()
    })
  : null
onBeforeUnmount(() => {
  clearInterval(modelTimer)
  clearTimeout(pickRefresh)
  if (stopModelChanged) stopModelChanged()
})
watch(
  () => [props.node.kind, props.node.agentId, props.node.sessionId, props.node.detectedCommand],
  () => refreshModel(),
  { immediate: true }
)

// Hook observations own supported launches. Older panes and other providers
// retain their explicitly estimated output-based display.
const agentStatus = ref(managedAgentStatus(props.node) ? 'unknown' : 'idle')
let pendingScreenWrites = 0
let hasLiveScreen = false
const observedState = computed(() => managedAgentStatus(props.node) ? getAgentState(props.node.id, props.node.agentLaunchToken) : null)
const estimatedState = computed(() => !managedAgentStatus(props.node) || !observedState.value?.hookSeen)
const shownState = computed(() => {
  const observed = observedState.value
  return observed?.confirmed && !observed.stale
    ? observed.state
    : agentStatus.value === 'busy' ? 'working' : agentStatus.value === 'idle' ? 'idle' : 'unknown'
})
// Where the shown state comes from (hooks, or guessed from the screen).
const statusSource = computed(() =>
  shownState.value === 'unknown'
    ? t('pane.status.noFresh', 'No fresh status is confirmed for this agent.')
    : estimatedState.value
      ? t('pane.status.estimated', 'Estimated from terminal output; hooks have not confirmed it.')
      : t('pane.status.confirmed', 'Confirmed by agent events and terminal readiness.')
)
const statusTitle = computed(() => {
  const state = shownState.value
  const source = statusSource.value
  const line = managedAgentStatus(props.node)
    ? t('pane.status.mainState', 'Main agent state: {{state}}. {{source}}', { state: stateWord(state), source })
    : t('pane.status.agentState', 'Agent state: {{state}}. {{source}}', { state: stateWord(state), source })
  return props.node.sessionId ? `${line}\n${t('pane.status.session', 'Session {{id}}', { id: props.node.sessionId })}` : line
})
// The state's word in the interface's language (an unknown one as it is).
function stateWord(state) {
  switch (state) {
    case 'working':
      return t('pane.state.working', 'working')
    case 'idle':
      return t('pane.state.idle', 'idle')
    case 'unknown':
      return t('pane.state.unknown', 'unknown')
    case 'approval':
      return t('pane.state.approval', 'approval')
    case 'waiting':
      return t('pane.state.waiting', 'waiting')
    case 'done':
      return t('pane.state.done', 'done')
    case 'limited':
      return t('pane.state.limited', 'limited')
  }
  return state
}
// The suggestion's look 3 s after a turn: cancelled by a new turn (it would
// read the screen mid-turn) and when the pane closes.
let suggestionTimer = null
watch(agentStatus, (v) => {
  setAgentStatus(props.node.id, v, props.node.agentLaunchToken)
  if (v === 'idle') refreshModel() // an answer just ended
  // Its suggestion comes a moment after the answer: looked at again then.
  clearTimeout(suggestionTimer)
  suggestionTimer = null
  if ((v === 'idle' || v === 'done') && props.node.agentId === 'claude') suggestionTimer = setTimeout(() => (promptSuggestion.value = readPromptSuggestion()), 3000)
  else if (v === 'busy') promptSuggestion.value = ''
})
onBeforeUnmount(() => clearTimeout(suggestionTimer))
// Output that answers something done here (a click that focuses the pane, a
// resize, a key typed) is the agent redrawing or echoing, not working: it does
// not count as activity for this long after it.
const REDRAW_MS = 700
let redrawUntil = 0
function expectRedraw() {
  redrawUntil = Date.now() + REDRAW_MS
}
function markActivity() {
  if (!isAgent.value) return
  activityMonitor.output({ redraw: Date.now() < redrawUntil })
}

// The last `lines` non-empty lines on screen as plain text (a tall pane can
// have its content at the top and blank rows below). A line the terminal
// wrapped over several rows (a narrow pane) comes back whole, so a word like
// TASK_COMPLETE is never cut in two.
function screenText(lines = 20) {
  if (!term) return ''
  const buf = term.buffer.active
  const out = []
  let tail = ''
  for (let y = buf.baseY + term.rows - 1; y >= 0 && out.length < lines; y--) {
    const line = buf.getLine(y)
    if (!line) continue
    tail = line.translateToString(!tail) + tail
    // This row continues the one above it: keep collecting.
    if (line.isWrapped && y > 0) continue
    if (tail.trim()) out.unshift(tail)
    tail = ''
    if (y <= buf.baseY) break
  }
  return out.join('\n')
}

// Prompt cache countdown (Settings > Agents): from Claude's last answer.
const cacheStartedAt = ref(0)
const activityMonitor = createAgentActivityMonitor({
  getNode: () => props.node,
  readScreen: () => pendingScreenWrites || !hasLiveScreen
    ? { screen: '', ready: false, busy: false, approval: false, limit: null }
    : agentScreenObservation(term, props.node.agentId, screenText(12)),
  report: (event) => window.shellApi.reportAgentScreen?.(event),
  onStatus: (status) => { agentStatus.value = status },
  onWorking: () => { cacheStartedAt.value = 0 },
  onApproval: (on) => setApproval(props.node.id, on),
  onLimit: (hit) => {
    const isNew = !limits[props.node.id]
    setApproval(props.node.id, false)
    setLimit(props.node.id, hit)
    if (isNew) ctx.notifyAgentLimit(props.node, hit)
  },
  onCompleted: ({ at, screen }) => {
    clearLimit(props.node.id)
    if (props.node.agentId === 'claude') cacheStartedAt.value = at
    // A successful turn boundary is not a completed task: keep the explicit
    // standalone TASK_COMPLETE signal as the separate task contract.
    if (detectTaskDone(screen) && ctx.agentReportedDone) ctx.agentReportedDone(props.node.id)
    // A scheduled automation's run ends with its agent's turn (it tells you
    // itself, in place of the usual notice).
    const automationRun = ctx.automationTurnDone ? ctx.automationTurnDone(props.node.id) : false
    // Settings > Notifications, "Suppress While Focused": nothing for the
    // pane you are looking at (off: you are told there too).
    const looking = isActive.value && document.hasFocus()
    if (!looking || settings.notifySuppressWhenFocused === false) {
      if (!looking) setAttention(props.node.id)
      if (!automationRun) ctx.notifyAgentDone(props.node)
    }
  }
})
// Watch the identity as well as the snapshot, so a late old-process event
// cannot label a new process that happens to reuse this pane id.
watch(() => [props.node.agentLaunchToken, agentStates[props.node.id]], () => {
  activityMonitor.stateChanged(observedState.value)
}, { flush: 'sync' })
const cacheNow = ref(Date.now())
let cacheClock = 0
const cacheShown = computed(() => settings.promptCacheTimer && props.node.agentId === 'claude' && cacheStartedAt.value > 0)
// Ticks once a second, only while shown and the window is visible.
function syncCacheClock() {
  const run = cacheShown.value && document.visibilityState === 'visible'
  if (run && !cacheClock) {
    cacheNow.value = Date.now()
    cacheClock = setInterval(() => (cacheNow.value = Date.now()), 1000)
  } else if (!run && cacheClock) {
    clearInterval(cacheClock)
    cacheClock = 0
  }
}
watch(cacheShown, syncCacheClock)
document.addEventListener('visibilitychange', syncCacheClock)
onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', syncCacheClock)
  clearInterval(cacheClock)
  activityMonitor.dispose()
})
const cache = computed(() => (cacheShown.value ? cacheCountdown(cacheStartedAt.value, settings.promptCacheTtlMs, cacheNow.value) : null))

// A pane on an SSH host reopened when Tessel started: it waits for Connect
// (or Enter in the pane) before signing in.
const remoteHostName = computed(() => {
  const id = props.node.remoteHostId
  const target = id ? remoteHostsState.targets.find((x) => x.id === id) : null
  return (target && (target.label || target.host)) || id || ''
})
function notConnectedText() {
  return t('pane.remote.notConnected', '{{host}} — not connected', { host: remoteHostName.value })
}
function connectRemote() {
  if (props.node.notConnected && !props.node.connecting && ctx.connectLeaf) ctx.connectLeaf(props.node.id)
}

const sleptAt = computed(() =>
  props.node.sleeping ? new Date(props.node.sleeping.at).toLocaleTimeString(intlLocale(), { hour: '2-digit', minute: '2-digit' }) : ''
)

// How this agent was launched vs Settings > Agents now: Yolo shown, and a
// restart offered when its settings changed since (Yolo on/off, arguments,
// command, variables). Agents started by hand in a shell are not known.
// The model chosen for it (its own, else Settings > Agents) counts too.
function signatureNow(n, choice = n.sessionOptions) {
  const values = launchSessionValues(choice, settings.agentSessionOptions, n.agentId)
  return launchSignature(effectiveAgent({ id: n.agentId, command: n.agentCommand }, settings.agentPrefs, ctx.permissionsOf ? ctx.permissionsOf(n) : settings.agentPermissions, values, modelsFor(n.agentId)))
}
const launchStale = computed(() => {
  const n = props.node
  if (n.kind !== 'agent' || !n.launchSig || !n.agentCommand || n.detected) return false
  return signatureNow(n) !== n.launchSig
})
// Pane menu > Restart in Yolo / Restart asking first (an agent Tessel
// started, with a known skip-approvals option and no arguments of your own,
// which would replace it), and Yolo in this folder.
const canSwitchYolo = computed(() => {
  const n = props.node
  if (n.kind !== 'agent' || !n.agentCommand || n.detected || n.remoteHostId) return false
  if (!YOLO_ARGS[n.agentId] && !YOLO_ENV[n.agentId]) return false
  const own = (settings.agentPrefs[n.agentId] || {}).args
  return !(typeof own === 'string' && own.trim())
})
const yoloFolder = computed(() => (ctx.paneFolder ? ctx.paneFolder(props.node) : null))
const yoloFolderOn = computed(() => !!yoloFolder.value && inYoloFolder(yoloFolder.value, settings.yoloFolders))
const folderName = (dir) => String(dir || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop()
function menuSwitchYolo() {
  closeCtxMenu()
  if (ctx.restartWithPermissions) ctx.restartWithPermissions(props.node.id, props.node.launchYolo ? 'manual' : 'yolo')
}
// Pane menu > Switch to chat view (and the header's chat button): Claude
// Code, OpenClaude and Codex agents Tessel started on this computer show
// their conversation as a chat over the terminal, the agent still running in
// it (src/renderer/src/chat/terminalChatBridge.js): nothing is stopped or
// restarted, the switch is the pane's chatView flag (saved with the layout).
const chatViewAvailable = computed(() => canShowChatView(props.node))
const chatShown = computed(() => {
  const n = props.node
  return !!n.chatView && chatViewAvailable.value && !exited.value && !n.failed && !n.notConnected
})
function toggleChatView() {
  closeCtxMenu()
  if (!chatViewAvailable.value) return
  props.node.chatView = !props.node.chatView || undefined
}
// The chat covers the terminal: the terminal gives up the keyboard (keys
// would reach the agent unseen), and gets it back with the terminal view.
watch(chatShown, (shown) => {
  if (shown) {
    if (term && term.textarea) term.textarea.blur()
    nextTick(() => isActive.value && chatViewEl.value && chatViewEl.value.focus())
  } else if (isActive.value) nextTick(() => termFocus())
})
const chatViewEl = ref(null)
// Every focus of the terminal goes through here: with the chat shown, its
// composer takes it instead.
function termFocus() {
  if (!term) return
  if (chatShown.value) {
    if (chatViewEl.value) chatViewEl.value.focus()
    return
  }
  term.focus()
}
// What the chat view shows of the agent: working, waiting for an approval,
// a question (its hooks say a question tool waits; ask: the question itself,
// only while it waits).
const chatWorking = computed(() => shownState.value === 'working')
// Its hooks say it is compacting (Claude Code's PreCompact).
const chatCompacting = computed(() => {
  const o = observedState.value
  return !!(o && o.state === 'working' && o.reason === 'compacting')
})
const chatWaiting = computed(() => {
  const o = observedState.value
  const input = !!(o && o.state === 'approval' && o.reason === 'input')
  const ask = o && o.state === 'approval' && o.ask ? o.ask : null
  const approval = asksApproval.value || shownState.value === 'approval' || input
  // Which approval (when the pane went into it): an answered one's card
  // stays hidden until another one comes.
  const approvalKey = approval ? (o && o.state === 'approval' && Number.isFinite(o.since) ? o.since : 'screen') : null
  return { approval, input, ask, approvalKey }
})
// Why a message sent from the chat still waits to be typed (Tessel's delivery
// holds it): '' when nothing holds it that the pane can tell.
function chatSendHeldReason() {
  if (ctx.paneUserTyping && ctx.paneUserTyping(props.node.id)) return t('pane.chatView.heldTyped', 'Waiting: a line is typed in its terminal (send or clear it there).')
  if (chatWaiting.value.approval) return t('pane.chatView.heldApproval', 'Waiting: it asks for your approval first.')
  return ''
}
// The chat view's right-click menu: this pane's own actions.
const chatPaneActions = computed(() => ({
  ...(ctx.splitLeaf ? { onSplitRight: () => ctx.splitLeaf(props.node.id, 'row'), onSplitDown: () => ctx.splitLeaf(props.node.id, 'col') } : {}),
  ...(ctx.toggleMaximize ? { isPaneExpanded: isMaximized.value, onToggleExpand: () => ctx.toggleMaximize(props.node.id) } : {}),
  ...(ctx.closeLeaf ? { onClosePane: () => ctx.closeLeaf(props.node.id) } : {})
}))
// What the agent's last Stop listed as still running in the background (ids,
// when): the chat view's dock drops the tasks it no longer lists.
const chatBackground = computed(() => {
  const o = observedState.value
  return o && Array.isArray(o.backgroundIds) ? { ids: o.backgroundIds, listedAt: o.backgroundListedAt } : null
})
const chatDisabledReason = computed(() =>
  props.node.sleeping ? t('pane.chatView.asleep', 'Asleep: it wakes up when you open this pane, then you can write to it.') : ''
)
// What you write in the chat: typed into the terminal by Tessel's delivery
// (held while it works, asks for approval or you have a line typed there:
// a card above the composer until then); with
// images (their files' paths pasted first) or as a slash command
// (callbacks: { images, command, onDelivered, onFailed, onQueued, onTyped }).
function chatSend(text, callbacks) {
  if (ctx.sendFromChatView) ctx.sendFromChatView(props.node.id, text, callbacks)
  else if (callbacks && callbacks.onFailed) callbacks.onFailed()
}
// The cards' keys (Allow, Deny, Stop, a question's answer), only on a click.
function chatKeys(bytes) {
  if (chatShown.value && !props.node.sleeping) window.shellApi.writePty(props.node.id, bytes)
}
// The chat view's permission mode picker: the mode the agent's hook said last
// (permission_mode), or what Tessel saw on its screen after switching it,
// whichever is newer; before either, how it was launched.
const modeSeen = ref(null) // { mode, at }: after a switch from the chat view
watch(() => props.node.agentLaunchToken, () => (modeSeen.value = null))
const chatPermissionMode = computed(() => {
  const o = observedState.value
  return shownPermissionMode({
    hookMode: o ? o.permissionMode : null,
    hookAt: o && Number.isFinite(o.permissionModeAt) ? o.permissionModeAt : 0,
    localMode: modeSeen.value && modeSeen.value.mode,
    localAt: modeSeen.value ? modeSeen.value.at : 0,
    launchMode: launchPermissionMode(props.node)
  })
})
// Why a mode cannot be picked here (Claude Code, OpenClaude: Shift+Tab never
// reaches Yolo in a session started without it, nor Don't ask).
function chatModeBlocked(mode) {
  if (composerAgent(props.node.agentId) === 'codex') return ''
  if (mode === 'bypassPermissions' && !canCycleToYolo(props.node))
    return canSwitchYolo.value
      ? t('pane.chatView.yoloRestart', 'Started without Yolo: pane menu > Restart in Yolo')
      : t('pane.chatView.yoloAtStart', 'Started without Yolo: only a restart with Yolo (Settings > Agents) allows it')
  if (mode === 'dontAsk') return t('pane.chatView.modeAtStart', 'Only when it starts (--permission-mode)')
  return ''
}
// Why no key may be typed into it now ('' when one may).
function chatKeysBlocked() {
  const id = props.node.id
  if (!chatShown.value || !paneRunning.value) return t('pane.chatView.notRunning', 'It is not running.')
  if (chatWaiting.value.approval) return t('pane.chatView.modeApproval', 'It asks for your approval: answer it first.')
  if (chatWorking.value || agentStatus.value === 'busy') return t('pane.chatView.modeWorking', 'It is working: its mode can change once it is idle.')
  if (ctx.paneUserTyping && ctx.paneUserTyping(id)) return t('pane.chatView.typedLine', 'A line is typed in its terminal: send or clear it there first.')
  if (ctx.paneDelivering && ctx.paneDelivering(id)) return t('pane.chatView.modeDelivering', 'A message is being typed into it: try again in a moment.')
  return ''
}
// Claude Code, OpenClaude: Shift+Tab one press at a time, each one checked on
// its screen's footer, until it shows the mode asked (at most 6 presses).
let modeSwitching = false
async function chatSetPermissionMode(mode) {
  if (composerAgent(props.node.agentId) === 'codex') return { ok: false }
  const why = chatModeBlocked(mode) || chatKeysBlocked()
  if (why) return { ok: false, error: why }
  if (modeSwitching) return { ok: false, error: t('pane.chatView.modeSwitching', 'Its mode is already changing.') }
  modeSwitching = true
  let res
  try {
    res = await stepToPermissionMode({
      target: mode,
      read: () => permissionModeFromScreen(screenText(6)),
      press: () => window.shellApi.writePty(props.node.id, KEY_SHIFT_TAB),
      blocked: chatKeysBlocked
    })
  } finally {
    modeSwitching = false
  }
  if (res.presses > 0 || res.ok) modeSeen.value = { mode: res.mode, at: Date.now() }
  if (res.ok) return { ok: true }
  if (res.code === 'blocked') return { ok: false, error: res.error }
  if (res.code === 'unavailable') return { ok: false, error: t('pane.chatView.modeUnavailable', 'It does not offer this mode now (Shift+Tab never reached it).') }
  return { ok: false, error: t('pane.chatView.modeUnconfirmed', 'Could not confirm the mode on its screen; open the terminal to check.') }
}
// The chat view's "@" menu: the files of the folder the agent works in.
async function chatListFiles() {
  const folder = ctx.paneFolder ? ctx.paneFolder(props.node) : props.node.startDir || props.node.cwd
  if (!folder || !window.shellApi.listFiles) return []
  const res = await window.shellApi.listFiles(folder)
  return res && res.ok && Array.isArray(res.files) ? res.files : []
}
// The chat view's mic: Windows voice typing into its composer.
function chatDictate() {
  if (chatViewEl.value) chatViewEl.value.focus()
  if (ctx.voiceTyping) ctx.voiceTyping(props.node.id)
}
const chatDictationTitle = computed(() =>
  ctx.voiceName && ctx.voiceName.value
    ? t('pane.voice.label', 'Voice typing ({{language}})', { language: ctx.voiceName.value })
    : t('chat.orca.composer.startDictation', 'Start dictation')
)
// The agent really ended (not a restart, a sleep or a wake): back to the
// terminal, where its shell is.
const agentEnded = computed(() => {
  const o = observedState.value
  return !!(o && o.state === 'closed' && o.reason === 'ended')
})
let endedTimer = null
function chatViewEnded() {
  clearTimeout(endedTimer)
  endedTimer = null
  if (!props.node.chatView || !mounted) return
  if (ctx.chatViewEnded) ctx.chatViewEnded(props.node.id)
}
watch(exited, (gone) => {
  if (gone) chatViewEnded()
})
// Claude Code's /clear also ends its session for a moment (a new one starts
// right after): only an end that lasts counts.
watch(agentEnded, (ended) => {
  clearTimeout(endedTimer)
  endedTimer = ended ? setTimeout(() => agentEnded.value && chatViewEnded(), 4000) : null
}, { immediate: true })
onBeforeUnmount(() => clearTimeout(endedTimer))
// Pane menu > Open as chat: an OpenCode agent with a known conversation goes
// on in a chat pane of its own (no terminal), in the same place.
const canOpenAsChat = computed(() => {
  const n = props.node
  if (chatViewAvailable.value) return true
  if (n.kind !== 'agent' || n.agentId !== 'opencode' || !n.sessionId || n.detected || n.remoteHostId || !ctx.switchToChat) return false
  // OpenCode's chat resumes its own session ids only (ses_…).
  return /^ses_[A-Za-z0-9]{20,40}$/.test(n.sessionId)
})
// Pane menu > See the conversation: an agent with no chat of its own (Grok,
// OMP) whose conversation is known: its session file shown as a chat,
// read-only, over the terminal (typing stays in the terminal).
const TRANSCRIPT_VIEW_AGENTS = ['grok', 'omp']
const transcriptOpen = ref(false)
const canViewTranscript = computed(() => {
  const n = props.node
  return n.kind === 'agent' && TRANSCRIPT_VIEW_AGENTS.includes(n.agentId) && !!n.sessionId && !n.remoteHostId
})
function menuViewTranscript() {
  closeCtxMenu()
  if (transcriptOpen.value) closeTranscript()
  else transcriptOpen.value = true
}
function closeTranscript() {
  transcriptOpen.value = false
  nextTick(() => term && termFocus())
}
watch(canViewTranscript, (can) => {
  if (!can) transcriptOpen.value = false
})
// OpenCode has no chat view over its terminal: its header button opens the
// conversation in a chat pane of its own (Open as chat), once Tessel knows it.
const opencodeAgent = computed(() => props.node.kind === 'agent' && props.node.agentId === 'opencode' && !props.node.remoteHostId)
const chatToggleTitle = computed(() => {
  if (chatViewAvailable.value) return chatShown.value ? t('pane.chatView.showTerminal', 'Show terminal') : t('pane.chatView.showChat', 'Show chat view')
  return canOpenAsChat.value
    ? t('pane.chatView.openAsChat', 'Continue this conversation in a chat pane')
    : t('pane.chatView.noOpencodeSession', 'Send a first message here: the chat opens once OpenCode has a conversation')
})
function menuOpenAsChat() {
  closeCtxMenu()
  if (chatViewAvailable.value) toggleChatView()
  else if (ctx.switchToChat) ctx.switchToChat(props.node.id)
}
function menuYoloFolder() {
  closeCtxMenu()
  if (ctx.toggleYoloFolder) ctx.toggleYoloFolder(yoloFolder.value)
}
function restartToApply() {
  if (ctx.restartLeaf) ctx.restartLeaf(props.node.id)
}

const needsYou = computed(() => !!attention[props.node.id])
const limit = computed(() => limits[props.node.id] || null)

const asksApproval = computed(() => !!approvals[props.node.id])
// How it is doing (src/shared/tracking.js), when it may be stuck.
const track = computed(() => (ctx.trackOf ? ctx.trackOf(props.node.id) : null))
// Sub-agents of this conversation running now (AgentChildren reports them):
// the pane is at work even while the main agent waits for them.
const subRunning = ref(0)
// Its turn ended, its own background work (shells, sub-agents, monitors)
// still runs: how many tasks, by its hooks (0 = none).
const backgroundRunning = computed(() => (isAgent.value && paneMonitoring(props.node) ? monitoring[props.node.id] || 0 : 0))
// When its agent ended its turn: sub-agents silent since then are not running.
const turnEndedAt = computed(() => (managedAgentStatus(props.node) ? turnEndedSince(props.node.id, props.node.agentLaunchToken) : null))
function onSubRunning(n) {
  subRunning.value = n
  if (ctx.setChildrenRunning) ctx.setChildrenRunning(props.node.id, n)
}
const stuck = computed(
  () => isAgent.value && !subRunning.value && !!track.value && (track.value.level === 'warn' || track.value.level === 'alert') && !asksApproval.value && !limit.value
)
const unsent = computed(() => isAgent.value && !!(ctx.unsent && ctx.unsent[props.node.id]))
const limitTitle = computed(() =>
  !limit.value
    ? ''
    : limit.value.reset
      ? /^in /.test(limit.value.reset)
        ? t('pane.limit.resetsIn', 'This agent hit its usage limit. It resets {{reset}}.', { reset: limit.value.reset })
        : t('pane.limit.resetsAt', 'This agent hit its usage limit. It resets at {{reset}}.', { reset: limit.value.reset })
      : t('pane.limit.hit', 'This agent hit its usage limit.')
)
const cacheTitle = computed(() =>
  !cache.value
    ? ''
    : cache.value.level === 'expired'
      ? t('pane.cache.expired', 'Prompt cache expired: the next message re-sends the whole conversation uncached')
      : t('pane.cache.expiresIn', 'Prompt cache expires in {{time}}: a message before then reuses it (faster, cheaper)', { time: cache.value.label })
)
function yoloTitle() {
  return t('pane.yolo.title', 'Started in Yolo: this agent runs commands and changes files without asking you')
}
function applyTitle() {
  return t('pane.apply.titleModel', 'Settings > Agents or its model changed since this agent started (Yolo, arguments, variables or model). Restart it to apply them: same pane, its conversation resumed')
}

// Like Orca's pane header, the header shows only what matters: the status
// dot, the icon, the title and at most ONE state badge, the most urgent one.
// Everything else (model, branch, team, Yolo, the other states, voice
// language...) is in the pane's menu (… or Shift+right-click) and tooltips.
const badge = computed(() => {
  if (props.node.sleeping) return 'asleep'
  if (exited.value) return 'exited'
  if (!isAgent.value) return null
  // A question it asks you is not an approval.
  if (asksApproval.value) return chatWaiting.value.input ? 'question' : 'approval'
  if (limit.value) return 'limit'
  if (unsent.value) return 'unsent'
  if (stuck.value) return 'stuck'
  if (launchStale.value) return 'apply'
  if (agentStatus.value === 'busy') return 'working'
  if (backgroundRunning.value) return 'monitoring'
  if (subRunning.value) return 'working'
  if (agentStatus.value === 'unknown') return 'unknown'
  // "Needs you" is also the status dot and the pane's glow; the prompt cache
  // countdown is shown nowhere else, so it goes first.
  if (cache.value) return 'cache'
  if (needsYou.value) return 'needs'
  return null
})

// What the header no longer shows, in one place, for screen readers (the
// hover card below shows it to the eye).
const titleDescription = computed(() => {
  const lines = [
    autoTitle.value
      ? t('pane.title.namedAfter', '{{name}}: {{title}} (named after its conversation)', { name: paneTitle.value, title: autoTitle.value })
      : paneTitle.value
  ]
  if (isAgent.value && modelText.value) lines.push(t('pane.model.title', 'Model: {{model}}', { model: modelText.value }))
  if (props.node.worktree) lines.push(t('pane.title.branch', 'Branch: {{branch}} (separate copy)', { branch: props.node.worktree.branch }))
  if (team.value)
    lines.push(
      isLead.value
        ? t('sidebar.card.teamLead', 'Team: {{team}} (lead)', { team: team.value.name })
        : t('sidebar.card.team', 'Team: {{team}}', { team: team.value.name })
    )
  if (isAgent.value && props.node.launchYolo) lines.push(t('pane.title.yolo', 'Yolo: runs without asking you'))
  if (headerState.value) lines.push(headerState.value.label)
  lines.push(t('pane.title.hint', 'Double-click to rename. Drag the header to move the pane. More in the … menu'))
  return lines.join('\n')
})

// The header's hover card (Orca's hover card, like the sidebar's agent rows)
// instead of native tooltips on the number, icon, title and state badge.
// Orca's pane tab titles show a tooltip after its TooltipProvider's 400 ms,
// below the title (side bottom, 6 px away, at most w-80): the same here.
const headerHover = useHoverCard({
  openDelay: 400,
  disabled: () =>
    editingTitle.value ||
    modelMenu.visible ||
    ctxMenu.visible ||
    (typeof document !== 'undefined' && document.body.classList.contains('pane-dragging')),
  // Badges that keep their own one-line tooltip close the card.
  ignore: '.pane-approval, .pane-limit, .pane-unsent, .pane-stuck, .pane-apply, .pane-cache, .exit-tag[title], input'
})
// The agent's own name (the pane can be renamed), or the shell's.
const agentName = computed(() => {
  const n = props.node
  if (!isAgent.value) return n.shellName || ''
  const list = ctx.agents && ctx.agents.value
  const found = Array.isArray(list) ? list.find((a) => a && a.id === n.agentId) : null
  return (found && found.name) || (!n.titleSet && n.title) || n.agentId || ''
})
// The state the header's dot and badge show, as the sidebar's dot and words.
const headerState = computed(() => {
  if (props.node.sleeping) return { dot: 'sleeping', label: t('sidebar.status.sleeping', 'Sleeping') }
  if (exited.value) return { dot: 'failed', label: t('pane.hover.exited', 'Exited') }
  if (!isAgent.value) return null
  if (asksApproval.value) return { dot: 'waiting', label: t('sidebar.row.asksApproval', 'Asks your approval') }
  if (limit.value) return { dot: 'blocked', label: limitTitle.value }
  if (agentStatus.value === 'busy') return { dot: 'working', label: agentStateLabel('working') }
  if (backgroundRunning.value) return { dot: 'monitoring', label: agentStateLabel('monitoring') }
  if (subRunning.value) return { dot: 'working', label: agentStateLabel('working') }
  if (agentStatus.value === 'unknown') return { dot: 'unverifiable', label: agentStateLabel('unverifiable') }
  if (needsYou.value) return { dot: 'done', label: agentStateLabel('done') }
  return { dot: 'idle', label: agentStateLabel('idle') }
})
const hoverInfo = computed(() => {
  const n = props.node
  const agent = isAgent.value
  const live = agent && !n.sleeping && !exited.value
  return {
    heading: paneTitle.value,
    agentName: agentName.value,
    iconKind: agent ? n.agentId : n.shellId,
    accent: agent ? n.accent : null,
    model: agent ? modelText.value : '',
    conversation: autoTitle.value,
    branch: n.worktree ? n.worktree.branch : '',
    state: headerState.value,
    stateDetail: live && !asksApproval.value && !limit.value ? statusSource.value : '',
    warn: stuck.value && track.value ? track.value.reason : '',
    yolo: agent && n.launchYolo ? yoloTitle() : '',
    team: team.value ? { name: team.value.name, lead: isLead.value } : null,
    num: n.num || 0,
    session: agent ? n.sessionId || '' : ''
  }
})

// The team this pane is in (a named, coloured group of agents), if any.
// (Checked: in the dev build this file can reload before App.vue provides it.)
// This pane leads its team.
const isLead = computed(() => !!(team.value && team.value.leadId === props.node.id))
const team = computed(() => (ctx.teamById ? ctx.teamById(props.node.team) : null))
const paneStyle = computed(() => {
  const style = {}
  if (isAgent.value) style['--accent'] = props.node.accent
  if (team.value) style['--team'] = team.value.color
  return style
})

function acknowledge() {
  clearAttention(props.node.id)
}

let term = null
let fit = null
let search = null
let ro = null
let unsubData = null
let unsubExit = null
let lastCols = 0
let lastRows = 0

// Resize strategy: wait until the size has settled, then resize the VIEW and
// the PTY together, once. Resizing on every pixel of a divider drag sends the
// shell a storm of size changes; full-screen programs (Claude Code, Codex, vim)
// then redraw at sizes that are already stale while xterm reflows underneath
// them, which leaves broken, duplicated or hidden lines. Keeping xterm and the
// PTY at the same size, changed in one step, avoids that. setTimeout (not rAF)
// so panes still refit while the window is unfocused or occluded.
const RESIZE_SETTLE_MS = 90
let fitTimer = 0
// Following the latest output: true while the pane is at the bottom. Only
// you (the wheel, scroll keys, the scrollbar, a click-drag) or a search move
// it up; a resize, a sidebar opening or a program's redraw never do. (When
// its box changes size, xterm can shift the view a line up at once, before
// Tessel refits the pane: that must not show "New output".)
let following = true
let handAt = 0 // last scroll by hand in the terminal
const HAND_MS = 1000
let restickQueued = false

function atBottom() {
  const buf = term.buffer.active
  return buf.viewportY >= buf.baseY
}

// Set when the terminal opens: refresh the "Latest / New output" button.
let refreshScrolled = () => {}
// Back to the latest output, and again on the next frame and a moment later:
// right after a resize, xterm syncs its view on the next frame and can put
// it one line up again (seen with Ollama, Cline, OpenCode...). A scroll made
// by code does not refresh the button by itself.
function stickToBottom() {
  if (!term) return
  term.scrollToBottom()
  refreshScrolled()
  const again = () => {
    if (!term || !following) return
    if (!atBottom()) term.scrollToBottom()
    refreshScrolled()
  }
  requestAnimationFrame(again)
  setTimeout(again, 150)
}

function doFit() {
  if (!term || !fit) return
  try {
    const dims = fit.proposeDimensions()
    if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) return
    // Never shrink to nothing (e.g. while the pane is momentarily unmeasurable).
    if (dims.cols < 2 || dims.rows < 1) return
    if (dims.cols !== term.cols || dims.rows !== term.rows) {
      expectRedraw()
      const wasFollowing = following || atBottom()
      term.resize(dims.cols, dims.rows)
      if (wasFollowing) {
        following = true
        stickToBottom()
      }
    }
    notifyPtySize()
  } catch {
    /* element not measurable yet */
  }
}

// Tell the PTY its new size, only when it really changed.
function notifyPtySize() {
  if (!term || term.cols < 1 || term.rows < 1) return
  if (term.cols === lastCols && term.rows === lastRows) return
  lastCols = term.cols
  lastRows = term.rows
  window.shellApi.resizePty(props.node.id, term.cols, term.rows)
}

function scheduleFit() {
  if (fitTimer) clearTimeout(fitTimer)
  fitTimer = setTimeout(() => {
    fitTimer = 0
    doFit()
  }, RESIZE_SETTLE_MS)
}

function publishMinSize() {
  if (!term || !hostEl.value || term.cols < 1 || term.rows < 1) return
  const screen = hostEl.value.querySelector('.xterm-screen')
  if (!screen) return
  const rect = screen.getBoundingClientRect()
  const minWidth = Math.ceil((rect.width / term.cols) * MIN_COLS) + 14
  const minHeight = Math.ceil((rect.height / term.rows) * MIN_ROWS) + 42
  hostEl.value.style.setProperty('--terminal-min-width', `${minWidth}px`)
  hostEl.value.style.setProperty('--terminal-min-height', `${minHeight}px`)
}

function onLayoutChange() {
  scheduleFit()
}

function windowsPtyOptions() {
  // A terminal on an SSH host's ssh2 connection: a Unix PTY, not Windows'.
  if (props.node.backend === 'ssh') return undefined
  if (props.node.backend === 'conpty') {
    return { backend: 'conpty', buildNumber: props.node.windowsBuild }
  }
  return { backend: 'winpty' }
}

function focusTerm() {
  ctx.setActive(props.node.id)
  acknowledge()
  if (term) termFocus()
}

// --- Find in terminal (Ctrl+Shift+F) ----------------------------------------
const findOpen = ref(false)
const findQuery = ref('')
const findInputEl = ref(null)
const findResult = reactive({ index: -1, count: 0 })
const FIND_DECORATIONS = {
  matchBackground: '#4a3f1a',
  matchBorder: '#8a7432',
  matchOverviewRuler: '#8a7432',
  activeMatchBackground: '#b8860b',
  activeMatchBorder: '#ffd166',
  activeMatchColorOverviewRuler: '#ffd166'
}

function openFind() {
  findOpen.value = true
  const sel = term ? term.getSelection() : ''
  if (sel && !sel.includes('\n')) findQuery.value = sel
  nextTick(() => {
    if (findInputEl.value) {
      findInputEl.value.focus()
      findInputEl.value.select()
    }
    if (findQuery.value) findNext()
  })
}

function closeFind() {
  findOpen.value = false
  if (search) search.clearDecorations()
  if (term) {
    term.clearSelection()
    termFocus()
  }
}

function findNext() {
  following = false
  if (search && findQuery.value) search.findNext(findQuery.value, { decorations: FIND_DECORATIONS })
}

function findPrev() {
  following = false
  if (search && findQuery.value)
    search.findPrevious(findQuery.value, { decorations: FIND_DECORATIONS })
}

function onFindInput() {
  if (!findQuery.value) {
    if (search) search.clearDecorations()
    findResult.index = -1
    findResult.count = 0
    return
  }
  // Incremental: re-search from the current match as you type.
  following = false
  if (search) search.findNext(findQuery.value, { incremental: true, decorations: FIND_DECORATIONS })
}

// --- Drag & drop files: type their paths into this pane ---------------------
const dropping = ref(false)

function quotePath(path) {
  const shell = props.node.shellId
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(path)
  if ((shell === 'wsl' || shell === 'gitbash') && m) {
    const rest = m[2].replace(/\\/g, '/')
    const unix =
      shell === 'wsl' ? `/mnt/${m[1].toLowerCase()}/${rest}` : `/${m[1].toLowerCase()}/${rest}` // i18n-ignore
    return `'${unix.replace(/'/g, `'\\''`)}'`
  }
  // PowerShell expands $var and $(...) inside "…" and in bare words: a
  // single-quoted path is taken as it is (its quotes doubled).
  if ((shell === 'powershell' || shell === 'pwsh') && !isAgent.value && /[\s&()'^;,$`{}@#[\]‘’‚‛]/.test(path)) {
    return `'${path.replace(/['‘’‚‛]/g, (q) => q + q)}'`
  }
  return /[\s&()'^;,%]/.test(path) ? `"${path}"` : path
}

// Files from Windows, or a path dragged from Tessel's file explorer.
const TESSEL_PATH = 'text/x-tessel-path'
// The chat view over the terminal takes its own drops (its composer attaches
// them): nothing dropped on it is typed into the terminal.
const onChatView = (e) => chatShown.value && !!(e.target && e.target.closest && e.target.closest('[data-test="terminal-chat-view"]'))
function onDragOver(e) {
  if (!e.dataTransfer || onChatView(e)) return
  const types = [...e.dataTransfer.types]
  if (!types.includes('Files') && !types.includes(TESSEL_PATH)) return
  e.preventDefault()
  e.dataTransfer.dropEffect = 'copy'
  dropping.value = true
}

function onDragLeave(e) {
  if (!e.currentTarget.contains(e.relatedTarget)) dropping.value = false
}

function onDrop(e) {
  dropping.value = false
  if (onChatView(e)) {
    e.preventDefault()
    return
  }
  const dragged = e.dataTransfer ? e.dataTransfer.getData(TESSEL_PATH) : ''
  if (dragged) {
    e.preventDefault()
    window.shellApi.writePty(props.node.id, quotePath(dragged) + ' ')
    focusTerm()
    return
  }
  const files = e.dataTransfer ? [...e.dataTransfer.files] : []
  if (!files.length) return
  e.preventDefault()
  const toPath = window.shellApi.pathForFile || (() => '')
  const paths = files.map((f) => toPath(f)).filter(Boolean)
  if (!paths.length) return
  window.shellApi.writePty(props.node.id, paths.map(quotePath).join(' ') + ' ')
  focusTerm()
}

// Keys the app handles itself; the terminal must not also send them to the
// shell (Alt+Arrow would otherwise type escape sequences, for example).
function isAppShortcut(e) {
  const k = e.key
  if (e.ctrlKey && e.shiftKey && !e.altKey) {
    return ['e', 'o', 'w', 'b', 'k', 'n', 'f', 'r', 'p', 'x', 'g'].includes(k.toLowerCase())
  }
  if (e.ctrlKey && !e.shiftKey && !e.altKey) {
    return ['=', '+', '-', '0', ',', 'PageUp', 'PageDown'].includes(k)
  }
  if (e.altKey && !e.ctrlKey && !e.shiftKey) {
    return ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(k)
  }
  return k === 'F1'
}

// The selection as copied to the clipboard: without the left gutter agent
// output is painted behind (Settings > Terminal, "Trim Gutter on Copy").
function selectionText() {
  const sel = term ? term.getSelection() : ''
  return settings.copyTrimsGutter === false ? sel : stripTerminalSelectionGutter(sel)
}

// The theme of this pane's terminal, with the cursor's opacity.
function paneTheme() {
  return composeTerminalTheme(terminalTheme(settings.theme), settings.cursorOpacity)
}

function copySelection() {
  if (!term) return false
  const sel = selectionText()
  if (sel && sel.length) {
    window.shellApi.writeClipboard(sel)
    return true
  }
  return false
}

async function pasteClipboard() {
  const text = await window.shellApi.readClipboard()
  if (text) requestPaste(text)
  else if (window.shellApi.clipboardHasImage && (await window.shellApi.clipboardHasImage()))
    pasteImage()
}

// An image can't be typed into a terminal. Claude Code attaches an image
// whose file path is pasted, so we save the clipboard image and paste its
// path: instant, where Claude's own Alt+V takes seconds on Windows (it starts
// PowerShell to read the clipboard). Other programs read the clipboard
// themselves on Ctrl+V (Codex does it quickly).
async function pasteImage() {
  if (props.node.agentId === 'claude') {
    let file = null
    try {
      file = await window.shellApi.saveClipboardImage()
    } catch {
      /* fall back to Claude's own key */
    }
    if (file && term) {
      const before = Math.max(0, ...imageNumbersOnScreen())
      term.paste(file)
      rememberPastedImage(file, before)
    } else window.shellApi.writePty(props.node.id, '\x1bv')
  } else {
    window.shellApi.writePty(props.node.id, '\x16')
  }
  if (term) termFocus()
}

// The agents whose input shows a pasted image path as "[Image #N]"
// (deliver.js waits for it). Cursor and Antigravity: not read here.
function inputImages() {
  if (!term) return null
  const agent = props.node.agentId
  if (agent === 'claude' || agent === 'openclaude') return claudeInputImages(term)
  if (agent === 'codex') return codexInputImages(term)
  return null
}

// "[Image #N]" in a Claude Code pane opens that image (a click on it).
// The images pasted here: Claude shows the path as "[Image #N]" a moment
// later, the first number above those on screen before is this one. Images
// already sent are found in the pane's conversation (main process).
const pastedImages = {} // n -> file
const IMAGE_TAG = /\[Image #(\d+)\]/g
function imageNumbersOnScreen() {
  return [...screenText(40).matchAll(IMAGE_TAG)].map((m) => Number(m[1]))
}
function rememberPastedImage(file, before) {
  let tries = 0
  const look = () => {
    const fresh = imageNumbersOnScreen().filter((n) => n > before && !pastedImages[n])
    if (fresh.length) pastedImages[Math.min(...fresh)] = file
    else if (++tries < 25) setTimeout(look, 200)
  }
  setTimeout(look, 150)
}
async function openImage(n) {
  const res = window.shellApi.getPastedImage
    ? await window.shellApi
        .getPastedImage({ file: pastedImages[n] || null, sessionId: props.node.sessionId || null, n })
        .catch(() => null)
    : null
  if (res && res.ok && ctx.showImage) {
    ctx.showImage({ src: res.src, file: res.file, title: t('pane.image.title', 'Image #{{n}}', { n }) })
    return
  }
  if ((!res || !res.ok) && ctx.toast) {
    ctx.toast(t('pane.image.notFound', 'Image #{{n}} was not found (only images pasted in this pane or sent in its conversation can be opened).', { n }), { timeout: 5000 })
  }
}

// File references clicked in the terminal (see the link provider below).
const fileLinkCache = new Map() // "<cwd>\n<path>" -> { file, at }
// Markdown, diagrams, tables, JSON, images and PDFs show in Tessel's viewer;
// code opens in Tessel's editor at its line; Shift+click opens it in VS
// Code (or the file's own program).
async function openFileRef(file, ref, event) {
  const outside = !!(event && event.shiftKey)
  if (ctx.viewFile && isViewed(file) && !outside) {
    ctx.viewFile({ file, label: ref.path, line: ref.line || null })
    return
  }
  if (ctx.openInEditor && !outside) {
    ctx.openInEditor({ file, line: ref.line || null, col: ref.col || null })
    return
  }
  const res = await window.shellApi.openFile({ file, line: ref.line, col: ref.col }).catch(() => null)
  if ((!res || !res.ok) && ctx.toast)
    ctx.toast(
      res && res.error
        ? t('pane.file.openFailedWhy', 'Could not open {{path}}: {{error}}', { path: ref.path, error: res.error })
        : t('pane.file.openFailed', 'Could not open {{path}}', { path: ref.path }),
      { timeout: 5000 }
    )
}

// Pasting goes through xterm's paste(), which wraps the text as a bracketed
// paste when the program supports it (so several lines arrive as one block
// instead of running line by line) and sends it to the pane (or to every pane
// in broadcast). Text with line breaks waits for a confirmation first, so an
// accidental right-click can't run a pile of commands.
const pasteAsk = ref(null) // { text, lines, preview, more }
const pasteAskEl = ref(null)
const PREVIEW_LINES = 500

function requestPaste(text) {
  if (!text || !term) return
  if (settings.confirmMultilinePaste && /[\r\n]/.test(text)) {
    const all = text.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n')
    pasteAsk.value = {
      text,
      lines: all.length,
      preview: all.slice(0, PREVIEW_LINES).join('\n'),
      more: Math.max(0, all.length - PREVIEW_LINES)
    }
    nextTick(() => pasteAskEl.value && pasteAskEl.value.focus())
    return
  }
  term.paste(text)
  termFocus()
}

function confirmPaste() {
  const ask = pasteAsk.value
  pasteAsk.value = null
  if (ask && term) term.paste(ask.text)
  if (term) termFocus()
}

function cancelPaste() {
  pasteAsk.value = null
  if (term) termFocus()
}

// Ctrl+V: the browser pastes into xterm's hidden text box. Catch it first so
// it gets the same confirmation.
function onPasteEvent(e) {
  if (!e.target || !e.target.classList || !e.target.classList.contains('xterm-helper-textarea'))
    return
  e.preventDefault()
  e.stopPropagation()
  const data = e.clipboardData
  const text = data ? data.getData('text/plain') : ''
  if (text) requestPaste(text)
  else if (data && [...data.items].some((i) => i.type.startsWith('image/'))) pasteImage()
}

// Editable pane title — stored on the node so it survives layout changes and
// is captured by workspace persistence.
const paneTitle = ref(props.node.paneName || props.node.title || props.node.shellName)
const editingTitle = ref(false)
// Keep the shown title in sync when it's changed from elsewhere (e.g. an
// install pane renamed right after it opens), unless you're editing it.
watch(
  () => props.node.paneName || props.node.title,
  (title) => {
    if (!editingTitle.value && title) paneTitle.value = title
  }
)
const titleInputEl = ref(null)

function startEditTitle(e) {
  e.stopPropagation()
  editingTitle.value = true
  nextTick(() => { titleInputEl.value?.focus(); titleInputEl.value?.select() })
}

// An agent pane is named after its conversation (Settings > Agents) until
// you name it yourself; emptying your name goes back to that.
const autoTitle = computed(() =>
  settings.autoTitles && isAgent.value && !props.node.titleSet && props.node.autoTitle ? props.node.autoTitle : ''
)

function saveTitle() {
  if (isAgent.value && ctx.renameAgent) {
    if (!ctx.renameAgent(props.node.id, paneTitle.value)) return
    editingTitle.value = false
    if (term) termFocus()
    return
  }
  if (!paneTitle.value.trim()) {
    if (isAgent.value && props.node.titleSet) {
      props.node.titleSet = false
      paneTitle.value = props.node.title
      editingTitle.value = false
      if (term) termFocus()
      return
    }
    paneTitle.value = props.node.shellName
  }
  if (paneTitle.value !== props.node.title) props.node.titleSet = true
  props.node.title = paneTitle.value
  editingTitle.value = false
  if (term) termFocus()
}

function cancelEditTitle() {
  paneTitle.value = props.node.paneName || props.node.title || props.node.shellName
  editingTitle.value = false
  if (term) termFocus()
}

const ctxMenu = reactive({ visible: false, x: 0, y: 0, hasSelection: false })
const ctxMenuEl = ref(null)

async function onContextMenu(e) {
  e.preventDefault()
  // The chat view over the terminal has its own menu: a right-click there
  // never pastes into the terminal under it.
  if (onChatView(e)) return
  // Right-click pastes, like PuTTY and Linux terminals: select text, then
  // right-click to paste it at the prompt. Shift+right-click (or the ⋯
  // button) opens the menu.
  if (settings.rightClickPaste && !e.shiftKey) {
    const sel = selectionText()
    if (sel) {
      window.shellApi.writeClipboard(sel)
      term.clearSelection()
      requestPaste(sel)
    } else {
      pasteClipboard()
    }
    return
  }
  otherPanes.value = ctx.otherPanes(props.node.id)
  const sel = term ? term.getSelection() : ''
  ctxMenu.hasSelection = sel.length > 0
  ctxMenu.x = e.clientX
  ctxMenu.y = e.clientY
  ctxMenu.visible = true
  await nextTick()
  keepCtxMenuInWindow()
}

// The menu stays inside the window (it scrolls when taller than it).
function keepCtxMenuInWindow(alignRight = null) {
  if (!ctxMenuEl.value) return
  ctxMenuEl.value.focus({ preventScroll: true })
  const r = ctxMenuEl.value.getBoundingClientRect()
  if (alignRight !== null) ctxMenu.x = alignRight - r.width
  if (ctxMenu.x + r.width > window.innerWidth) ctxMenu.x = window.innerWidth - r.width - 4
  if (ctxMenu.y + r.height > window.innerHeight) ctxMenu.y = window.innerHeight - r.height - 4
  ctxMenu.x = Math.max(4, ctxMenu.x)
  ctxMenu.y = Math.max(4, ctxMenu.y)
}

// The menu takes keyboard focus while open, so Esc closes it instead of
// being sent to the program running in the terminal.
function closeCtxMenuAndRefocus() {
  closeCtxMenu()
  if (term) termFocus()
}

function closeCtxMenu() {
  ctxMenu.visible = false
  ctx.highlightId.value = null
}

async function openMenuAtBtn(e) {
  e.stopPropagation()
  otherPanes.value = ctx.otherPanes(props.node.id)
  const sel = term ? term.getSelection() : ''
  ctxMenu.hasSelection = sel.length > 0
  const rect = e.currentTarget.getBoundingClientRect()
  ctxMenu.x = rect.left
  ctxMenu.y = rect.bottom + 2
  ctxMenu.visible = true
  await nextTick()
  // Under the … button, its right edge on the button's (like Orca's menus).
  keepCtxMenuInWindow(rect.right)
}

function menuCopy() {
  copySelection()
  term && term.clearSelection()
  closeCtxMenu()
}
function menuPaste() {
  pasteClipboard()
  closeCtxMenu()
}

function menuCopyOutput() {
  if (!term) return closeCtxMenu()
  const buf = term.buffer.active
  const lines = []
  for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '')
  window.shellApi.writeClipboard(lines.join('\n').trimEnd())
  closeCtxMenu()
}

function menuClear() {
  if (term) term.clear()
  closeCtxMenu()
}
// Reset Terminal: a program that crashed can leave mouse tracking, bracketed
// paste, application keys or the alternate screen on, so clicks and keys type
// garbage. Clears them in this pane and in the host's copy of the screen (so a
// re-attach does not bring them back); the program itself is not touched.
// After Orca's terminal-input-mode-reset.ts (MIT, Copyright (c) 2026 Lovecast Inc.).
function resetInputModes() {
  if (!term) return
  // A local ConPTY keeps focus reporting on for the terminal's whole life.
  term.write(buildInputModeReset({ keepFocusReporting: props.node.backend === 'conpty' }))
  window.shellApi.resetPtyModes?.(props.node.id)
}
function menuResetTerminal() {
  resetInputModes()
  closeCtxMenuAndRefocus()
}
function menuSplit(dir) {
  ctx.splitLeaf(props.node.id, dir)
  closeCtxMenu()
}
function menuClose() {
  ctx.closeLeaf(props.node.id)
  closeCtxMenu()
}
// Clicking the header focuses the terminal. preventDefault stops the browser
// from then moving focus to the (non-focusable) header, which left the pane
// unable to receive typing until you clicked inside it again.
function onNavMouseDown(e) {
  if (!e.target.closest('input, label')) e.preventDefault()
  focusTerm()
}

// Drag the header to move the pane (buttons and inputs stay clickable; a click without movement is not a drag).
function onNavPointerDown(e) {
  // A press in the header (a drag, a double-click to rename, a button)
  // closes its hover card until the pointer leaves.
  headerHover.dismiss()
  if (e.button !== 0) return
  if (e.target.closest('button, input, label')) return
  ctx.beginPaneDrag(props.node.id, e)
}

// --- Hand text to another pane -------------------------------------------------
const otherPanes = ref([])
let paneApi = null

function pasteText(text) {
  if (!text) return
  // Bracketed paste when the program asked for it (Claude Code, Codex, modern
  // shells), so multi-line text arrives as one paste instead of many commands.
  const bracketed = term && term.modes && term.modes.bracketedPasteMode
  // Control sequences in the text (from another terminal or agent) could end
  // the paste early and run the rest as keystrokes: they are removed.
  text = String(text).replace(/\x1b\[20[01]~/g, '').replace(/\x1b/g, '')
  const data = bracketed ? `\x1b[200~${text}\x1b[201~` : text.replace(/\r?\n/g, '\r')
  window.shellApi.writePty(props.node.id, data)
}

function menuSendSelection(targetId) {
  const text = selectionText()
  closeCtxMenu()
  if (text) ctx.sendToPane(props.node.id, targetId, 'selection', text)
}

function menuAskReview(targetId) {
  closeCtxMenu()
  ctx.sendToPane(props.node.id, targetId, 'review')
}

function menuOpenHere() {
  const x = ctxMenu.x
  const y = ctxMenu.y
  closeCtxMenu()
  ctx.openLauncherAt({ left: x, bottom: y }, props.node.id)
}
function jumpToBottom() {
  if (!term) return
  following = true
  term.scrollToBottom()
  scrolledUp.value = false
  newBelow.value = false
  termFocus()
}

// Pane menu > Speak in: pick the voice typing language and start dictation.
function menuPickVoice(tip) {
  closeCtxMenu()
  ctx.voiceTypingIn(props.node.id, tip)
}
function menuVoice() {
  closeCtxMenu()
  ctx.voiceTyping(props.node.id)
}
function menuRestartApply() {
  closeCtxMenu()
  restartToApply()
}
function menuResolveUnsent() {
  closeCtxMenu()
  if (ctx.resolveUnsent) ctx.resolveUnsent(props.node.id)
}
function menuCopySession() {
  closeCtxMenu()
  if (!props.node.sessionId) return
  window.shellApi.writeClipboard(props.node.sessionId)
  ctx.copied(t('pane.menu.sessionIdLabel', 'Session ID'))
}
function menuFind() {
  closeCtxMenu()
  openFind()
}
function menuRestart() {
  closeCtxMenu()
  ctx.restartLeaf(props.node.id)
}

// Text with a number or a name in it, for the template.
function quietFor(minutes) {
  return t('pane.badge.quiet', 'quiet {{minutes}} min', { minutes })
}
function asleepText() {
  return t('pane.sleep.overlay', 'Asleep since {{time}}: its terminal was stopped to free memory. Its conversation is kept.', { time: sleptAt.value })
}
function exitedText() {
  return exitCode.value !== null
    ? t('pane.exit.withCode', 'Process exited with code {{code}}.', { code: exitCode.value })
    : t('pane.exit.plain', 'Process exited.')
}
function pasteTitle(count) {
  return count === 1
    ? t('pane.paste.title', 'Paste {{count}} line?', { count })
    : t('pane.paste.title', 'Paste {{count}} lines?', { count })
}
function pasteMore(count) {
  return count === 1
    ? t('pane.paste.more', 'and {{count}} more line', { count })
    : t('pane.paste.more', 'and {{count}} more lines', { count })
}
function findCount() {
  if (!findQuery.value) return ''
  return findResult.count
    ? t('pane.find.count', '{{index}} of {{count}}', { index: findResult.index + 1, count: findResult.count })
    : t('pane.find.none', 'No results')
}
function limitState() {
  return limit.value && limit.value.reset
    ? t('pane.state.limitResets', 'usage limit · resets {{reset}}', { reset: limit.value.reset })
    : t('pane.state.limit', 'usage limit')
}
function cacheLeft() {
  return cache.value.level === 'expired'
    ? t('pane.cache.expiredShort', 'expired')
    : t('pane.cache.left', '{{time}} left', { time: cache.value.label })
}
function teamFactTitle() {
  return isLead.value
    ? t('pane.team.factLead', 'Team: {{team}} (this agent leads it) (manage it under Sessions)', { team: team.value.name })
    : t('pane.team.fact', 'Team: {{team}} (manage it under Sessions)', { team: team.value.name })
}
function leadToggleText() {
  return isLead.value
    ? t('pane.team.stopLeading', 'Stop leading {{team}}', { team: team.value.name })
    : t('pane.team.makeLeadOf', 'Make lead of {{team}}', { team: team.value.name })
}
function leaveTeamText() {
  return t('pane.team.leave', 'Leave {{team}}', { team: team.value.name })
}

function onDocPointerDownMenu(e) {
  if (ctxMenu.visible && ctxMenuEl.value && !ctxMenuEl.value.contains(e.target)) closeCtxMenu()
  if (modelMenu.visible && modelMenuEl.value && !modelMenuEl.value.contains(e.target)) closeModelMenu()
}
function onEscapeMenu(e) {
  if (e.key === 'Escape' && ctxMenu.visible) closeCtxMenu()
  if (e.key === 'Escape' && modelMenu.visible) closeModelMenu()
}

// A clicked link opens in the system browser (the main process only lets
// http, https and mailto through).
function openLink(uri) {
  if (window.shellApi.openExternal) window.shellApi.openExternal(uri)
  else window.open(uri)
}

// Draw with the graphics card (much faster with busy agents and many panes),
// like VS Code: Settings > Terminal, GPU Acceleration (Auto / On / Off).
// Falls back to the normal renderer if WebGL fails or its context is lost.
let webgl = null
// A pane off screen (in a hidden workspace) for a while gives its WebGL
// context back: each one holds graphics memory, and Chromium keeps only 16
// per window (the oldest is lost beyond that). It comes back when the pane is
// shown again. After Orca's src/renderer/src/lib/pane-manager/
// pane-rendering-control.ts and pane-webgl-renderer.ts (MIT, Copyright (c)
// 2026 Lovecast Inc.).
const WEBGL_RELEASE_MS = 30000
let webglReleased = false
let onScreen = true
let releaseTimer = null
let screenObserver = null
// The same, reactive (the conversation view watches its file only while shown).
const paneOnScreen = ref(true)
function setOnScreen(visible) {
  paneOnScreen.value = visible
  if (visible === onScreen) return
  onScreen = visible
  clearTimeout(releaseTimer)
  releaseTimer = null
  if (visible) {
    if (webglReleased) {
      webglReleased = false
      applyRenderer()
    }
    return
  }
  // Off screen only because the window is minimized: kept (no rebuild of
  // every terminal's drawing when you bring the window back).
  const windowHidden = () => document.documentElement.classList.contains('window-hidden')
  if (windowHidden()) return
  const release = () => {
    releaseTimer = null
    if (onScreen || !webgl) return
    // Minimized meanwhile: asked again later (the pane is in a hidden
    // workspace, it will not be shown by bringing the window back).
    if (windowHidden()) {
      releaseTimer = setTimeout(release, WEBGL_RELEASE_MS)
      return
    }
    webglReleased = true
    applyRenderer()
  }
  releaseTimer = setTimeout(release, WEBGL_RELEASE_MS)
}
// xterm removes its canvas on dispose, but Windows (ANGLE) can keep the
// driver's context alive a while longer: let it go now (Orca's
// releaseXtermWebglContext).
function releaseWebglContext(addon) {
  try {
    const renderer = addon && addon._renderer
    const gl = renderer && renderer._gl
    const lose = gl && gl.getExtension && gl.getExtension('WEBGL_lose_context')
    if (lose) lose.loseContext()
    if (renderer && renderer._canvas) {
      renderer._canvas.width = 0
      renderer._canvas.height = 0
    }
  } catch {
    /* the normal dispose still runs */
  }
}
function applyRenderer() {
  if (!term) return
  const want = useWebgl(settings.gpuAcceleration) && !webglReleased
  if (want && !webgl) {
    try {
      const gl = new WebglAddon()
      if (gl.onContextLoss)
        gl.onContextLoss(() => {
          try {
            gl.dispose()
          } catch {
            /* already gone */
          }
          if (webgl === gl) webgl = null
        })
      term.loadAddon(gl)
      webgl = gl
    } catch {
      /* no WebGL: keep the default renderer */
    }
  } else if (!want && webgl) {
    const gl = webgl
    webgl = null
    releaseWebglContext(gl)
    try {
      gl.dispose()
    } catch {
      /* already gone */
    }
  }
}

// Hide the mouse pointer while you type in the pane; it comes back as soon
// as the mouse moves (Settings > Appearance, like Orca's).
let mouseHidden = false
function hideMouseOnType() {
  if (!settings.hideMouseWhileTyping || !hostEl.value || mouseHidden) return
  mouseHidden = true
  hostEl.value.classList.add('mouse-hidden')
}
function showMouse() {
  if (!mouseHidden || !hostEl.value) return
  mouseHidden = false
  hostEl.value.classList.remove('mouse-hidden')
}

// Focus follows mouse (Settings > Terminal): hovering a pane makes it the
// active one, never while a button is held (a drag, a selection) nor when
// Tessel is in the background or a menu is open.
function onPaneMouseEnter(e) {
  if (!settings.focusFollowsMouse || isActive.value || e.buttons) return
  if (!document.hasFocus() || ctxMenu.visible || editingTitle.value) return
  const el = document.activeElement
  if (el && el.closest && !el.closest('.pane') && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return
  focusTerm()
}

// A bell from the program (BEL): a notification when you aren't looking
// (Settings > Notifications, Terminal Bell).
function onTerminalBell() {
  if (ctx.terminalBell) ctx.terminalBell(props.node, { visible: isActive.value && document.hasFocus() })
}

onMounted(() => {
  const theme = paneTheme()
  term = new Terminal({
    fontFamily: fontStack(settings.fontFamily),
    fontSize: paneFontSize(),
    cursorBlink: settings.cursorBlink,
    cursorStyle: settings.cursorStyle,
    scrollback: settings.scrollback,
    allowProposedApi: true,
    windowsPty: windowsPtyOptions(),
    theme,
    ...terminalSettingOptions(settings, theme),
    // Links a program writes with a text of their own (OSC 8: Claude Code,
    // Codex and others print their links this way). Without this, xterm
    // asks in a browser popup "WARNING: This link could potentially be
    // dangerous" and opens it in a new Electron window.
    linkHandler: { activate: (_e, uri) => openLink(uri), allowNonHttpProtocols: false }
  })
  fit = new FitAddon()
  term.loadAddon(fit)
  // A link written as plain text: the same.
  term.loadAddon(new WebLinksAddon((_e, uri) => openLink(uri)))
  // OSC 52: a program copies text to the clipboard (writing only, never read).
  // Settings > Terminal, "Allow TUI Clipboard Writes (OSC 52)": off, it is
  // ignored.
  term.parser.registerOscHandler(52, (data) => {
    if (settings.allowOsc52Clipboard === false) return true
    const text = osc52Text(data)
    if (text && window.shellApi.writeClipboard) {
      window.shellApi.writeClipboard(text)
      if (ctx.toast)
        ctx.toast(
          text.length > 60
            ? t('pane.osc52.copiedChars', 'Copied {{count}} characters', { count: text.length })
            : t('pane.osc52.copiedText', 'Copied "{{text}}"', { text: text.replace(/\s+/g, ' ').trim() }),
          { timeout: 2500 }
        )
    }
    return true
  })
  // [Image #N] in Claude Code: click to open the image.
  term.registerLinkProvider({
    provideLinks(y, callback) {
      if (props.node.agentId !== 'claude' || !term) return callback(undefined)
      const line = term.buffer.active.getLine(y - 1)
      const text = line ? line.translateToString(true) : ''
      const links = []
      for (const m of text.matchAll(IMAGE_TAG)) {
        const n = Number(m[1])
        links.push({
          range: { start: { x: m.index + 1, y }, end: { x: m.index + m[0].length, y } },
          text: m[0],
          decorations: { underline: true, pointerCursor: true },
          activate: () => openImage(n)
        })
      }
      callback(links.length ? links : undefined)
    }
  })
  // A file path (src/app.js:12:5, C:\x\y.ts:3...) that exists: a click opens
  // it at that line (VS Code when installed). Checked on disk, relative to
  // the pane's folder; answers are kept 30 s so hovering stays instant.
  term.registerLinkProvider({
    provideLinks(y, callback) {
      if (!term || !window.shellApi.resolveFiles) return callback(undefined)
      const line = term.buffer.active.getLine(y - 1)
      const refs = findFileRefs(line ? line.translateToString(true) : '')
      if (!refs.length) return callback(undefined)
      const cwd = props.node.startDir || null
      const key = (p) => `${cwd}\n${p}`
      const now = Date.now()
      const unknown = [...new Set(refs.map((r) => r.path))].filter((p) => {
        const c = fileLinkCache.get(key(p))
        return !c || now - c.at > 30000
      })
      const build = () =>
        callback(
          refs
            .filter((r) => (fileLinkCache.get(key(r.path)) || {}).file)
            .map((r) => ({
              range: { start: { x: r.index + 1, y }, end: { x: r.index + r.text.length, y } },
              text: r.text,
              decorations: { underline: true, pointerCursor: true },
              activate: (event) => openFileRef(fileLinkCache.get(key(r.path)).file, r, event)
            }))
        )
      if (!unknown.length) return build()
      window.shellApi
        .resolveFiles({ cwd, paths: unknown })
        .then((res) => {
          for (const p of unknown) fileLinkCache.set(key(p), { file: (res && res[p]) || null, at: Date.now() })
          build()
        })
        .catch(() => callback(undefined))
    }
  })
  const updateScrolled = () => {
    if (!term) return
    const buf = term.buffer.active
    const up = buf.viewportY < buf.baseY
    if (!up) {
      following = true
      newBelow.value = false
    } else if (following && Date.now() - handAt < HAND_MS) following = false
    // Moved up without you (a resize): back to the bottom, no button.
    if (up && following && !restickQueued) {
      restickQueued = true
      requestAnimationFrame(() => {
        restickQueued = false
        if (following) stickToBottom()
      })
    }
    scrolledUp.value = up && !following
  }
  refreshScrolled = updateScrolled
  term.onScroll(updateScrolled)
  term.onWriteParsed(() => {
    if (!term) return
    const buf = term.buffer.active
    // Following the output: stay at the bottom; scrolled up by you: say so.
    const up = buf.viewportY < buf.baseY
    if (up && following && Date.now() - handAt < HAND_MS) following = false
    if (up && following) stickToBottom()
    else if (up) newBelow.value = true
    updateScrolled()
  })

  search = new SearchAddon()
  term.loadAddon(search)
  // "Always select with the mouse": some programs (GitHub Copilot CLI, htop,
  // vim with mouse on) ask the terminal to send them clicks, and then dragging
  // no longer selects text unless you hold Shift. With the setting on, those
  // requests are ignored. (Only requests that set nothing but mouse modes, so
  // other modes in the same sequence still apply.)
  term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => {
    if (!settings.alwaysSelect) return false
    const modes = params.map((p) => (Array.isArray(p) ? p[0] : p))
    return modes.length > 0 && modes.every((m) => MOUSE_MODES.includes(m))
  })
  search.onDidChangeResults(({ resultIndex, resultCount }) => {
    findResult.index = resultIndex
    findResult.count = resultCount
  })
  term.open(hostEl.value)
  // Scrolling by hand in the terminal (the wheel, Shift+PageUp and other
  // scroll keys, the scrollbar, a click-drag): the view may then leave the
  // bottom and stay there. Typing does not count.
  // (xterm does not report a scroll made with the wheel or the keys: the
  // button is refreshed just after.)
  const byHand = (e) => {
    if (e.type === 'keydown' && !e.shiftKey && !/^(PageUp|PageDown|Home|End)$/.test(e.key)) return
    if (e.type === 'pointermove' && !e.buttons) return
    handAt = Date.now()
    setTimeout(refreshScrolled, 60)
  }
  for (const ev of ['wheel', 'keydown', 'pointerdown', 'pointermove'])
    hostEl.value.addEventListener(ev, byHand, { passive: true, capture: true })
  applyRenderer()
  // A copy xterm makes itself (Ctrl+Insert): without the gutter too.
  if (term.element)
    term.element.addEventListener(
      'copy',
      (event) => {
        if (!term || !term.hasSelection || !term.hasSelection() || !event.clipboardData) return
        event.clipboardData.setData('text/plain', selectionText())
        event.preventDefault()
        event.stopImmediatePropagation()
      },
      { capture: true }
    )
  hostEl.value.addEventListener('mousemove', showMouse, { passive: true })
  if (term.onBell) term.onBell(onTerminalBell)

  doFit()

  // Output saved when the app last closed: write it, a divider, then enough
  // blank lines to move it all into the scrollback, so the new shell (which
  // clears the visible screen as it starts) draws below it without erasing it.
  if (props.node.restoredText) {
    const rows = Math.max(1, term.rows)
    term.write(
      props.node.restoredText +
        // Reset, leave any full-screen mode and jump to the bottom row, so
        // the screen drawn by the saved output scrolls up intact.
        '\x1b[0m\x1b[?1049l\x1b[?25h\x1b[999;1H\r\n' +
        `\x1b[2m──── ${t('pane.restored', 'restored from your last session (scroll up to see it)')} ────\x1b[0m` +
        '\r\n'.repeat(rows)
    )
    props.node.restoredText = ''
  }

  // Replay any buffered history (e.g. after this pane was re-parented by a split).
  // Old output can hold questions to the terminal (cursor position, device
  // attributes): xterm would answer them again while replaying, and those
  // answers would reach the program as typed input. Nothing goes out until
  // the replay is parsed (it takes a moment; nobody types in it).
  let replaying = false
  const history = getBuffer(props.node.id)
  if (history) {
    replaying = true
    term.write(history, () => {
      replaying = false
    })
  }

  // User input → routed through App (handles broadcast / multi-write).
  term.onData((data) => {
    if (replaying) return
    // Not connected yet (a restored remote pane): nothing to type into; Enter
    // connects.
    if (props.node.notConnected) {
      if (data.includes('\r')) connectRemote()
      return
    }
    hideMouseOnType()
    expectRedraw()
    ctx.routeInput(props.node.id, data)
  })
  // Focus in or out (a click on the pane): the agent may redraw its screen.
  if (term.textarea) {
    term.textarea.addEventListener('focus', expectRedraw)
    term.textarea.addEventListener('blur', expectRedraw)
  }
  // onResize fires only when cols/rows actually change → debounce-notify the PTY.
  term.onResize(() => {
    publishMinSize()
    notifyPtySize()
  })
  notifyPtySize() // sync the PTY to the initial fitted size
  publishMinSize()

  // Selecting text copies it; Ctrl+Shift+C / Ctrl+Shift+V copy & paste.
  term.onSelectionChange(() => {
    if (settings.copyOnSelect) copySelection()
  })
  term.attachCustomKeyEventHandler((e) => {
    if (e.type === 'keydown' && e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'f') {
      openFind()
      return false
    }
    if (isAppShortcut(e)) return false
    // Shift+Enter in an agent: a new line in the message, not sending it. The
    // terminal sends the same Enter for both, so each agent gets the key it
    // reads as "new line": Alt+Enter for Claude Code, Ctrl+J for the others.
    if (
      e.type === 'keydown' &&
      e.key === 'Enter' &&
      e.shiftKey &&
      !e.ctrlKey &&
      !e.altKey &&
      !e.metaKey &&
      isAgent.value
    ) {
      e.preventDefault()
      ctx.routeInput(props.node.id, props.node.agentId === 'claude' ? '\x1b\r' : '\n')
      return false
    }
    // xterm leaves a plain Space to the browser's keypress/input events, but
    // Windows sometimes stops delivering the character (seen after using
    // dictation): the keydown arrives and nothing follows, so spaces vanish
    // while letters (handled on keydown) still type. Send it on keydown.
    if (
      e.type === 'keydown' &&
      e.key === ' ' &&
      e.keyCode === 32 &&
      !e.ctrlKey &&
      !e.altKey &&
      !e.metaKey &&
      !e.isComposing
    ) {
      e.preventDefault()
      ctx.routeInput(props.node.id, ' ')
      return false
    }
    // Ctrl+V pastes (text or image, see onPasteEvent) instead of sending the
    // raw Ctrl+V key: let the browser raise its paste event.
    if (
      e.type === 'keydown' &&
      e.ctrlKey &&
      !e.shiftKey &&
      !e.altKey &&
      e.key.toLowerCase() === 'v'
    )
      return false
    if (e.type === 'keydown' && e.ctrlKey && e.shiftKey) {
      const k = e.key.toLowerCase()
      if (k === 'c') {
        copySelection()
        return false
      }
      if (k === 'v') {
        pasteClipboard()
        return false
      }
    }
    return true
  })

  // Live output for this pane only.
  unsubData = window.shellApi.onData(({ id, data }) => {
    if (id === props.node.id && term) {
      const outputTerm = term
      pendingScreenWrites++
      outputTerm.write(data, () => {
        pendingScreenWrites = Math.max(0, pendingScreenWrites - 1)
        if (mounted && term === outputTerm) {
          hasLiveScreen = true
          markActivity()
        }
      })
    }
  })
  unsubExit = window.shellApi.onExit(async ({ id, exitCode: code, pid }) => {
    if (id !== props.node.id || !term) return
    // A pane restarted in place keeps its id: the end of the process it
    // replaced is not this pane's end (a late notice from the old one).
    if (pid && props.node.pid && pid !== props.node.pid) return
    // No pid (a terminal host started by an older Tessel): a pane restarted
    // in place asks the host whether its own terminal still runs.
    if (!pid && (props.node.gen || props.node.restartedAt)) {
      const gen = props.node.gen
      const a = await window.shellApi.attachPty(id).catch(() => null)
      if (!mounted || props.node.gen !== gen || !term) return
      if (a && a.ok && !a.exited && (!a.pid || !props.node.pid || a.pid === props.node.pid)) return
    }
    // Put to sleep (Settings > Agents): not an end; the pane shows it asleep.
    if (props.node.sleeping) return
    exited.value = true
    activityMonitor.dispose()
    exitCode.value = code
    term.write(`\r\n\x1b[33m[${t('pane.exitedWithCode', 'process exited with code {{code}}', { code })}]\x1b[0m\r\n`)
  })

  // Refit whenever the pane is resized (divider drag, window resize, splits).
  ro = new ResizeObserver(() => scheduleFit())
  ro.observe(hostEl.value)
  ro.observe(hostEl.value.parentElement)
  // On screen or not (a hidden workspace is moved off screen, style.css): an
  // off-screen pane gives its WebGL context back after a while.
  if (typeof IntersectionObserver !== 'undefined') {
    screenObserver = new IntersectionObserver((entries) => {
      const last = entries[entries.length - 1]
      if (last) setOnScreen(last.isIntersecting)
    })
    screenObserver.observe(hostEl.value)
  }
  window.addEventListener('resize', onLayoutChange)
  window.addEventListener('terminal-layout-change', onLayoutChange)
  window.addEventListener('pointerdown', onDocPointerDownMenu, true)
  window.addEventListener('keydown', onEscapeMenu)

  paneApi = {
    paste: pasteText,
    // Did the program ask for bracketed paste? Without it, each line of a
    // multi-line paste runs as its own command (null: no terminal yet).
    bracketedPaste: () => (term && term.modes ? !!term.modes.bracketedPasteMode : null),
    submit: () => window.shellApi.writePty(props.node.id, '\r'),
    // A command typed key by key (Codex takes a fast write as pasted prose);
    // printable characters only.
    typeKeys: async (text) => {
      for (const ch of String(text || '').replace(/[\x00-\x1f\x7f]/g, '')) {
        window.shellApi.writePty(props.node.id, ch)
        await new Promise((r) => setTimeout(r, 15))
      }
    },
    // Codex only: backspace n times (deliver.js: a pasted image path Codex
    // left as plain text is erased before it is pasted again).
    ...(props.node.agentId === 'codex'
      ? {
          erase: (n) => {
            if (Number.isInteger(n) && n > 0 && n <= 4096) window.shellApi.writePty(props.node.id, '\x7f'.repeat(n))
          }
        }
      : {}),
    getSelection: () => (term ? term.getSelection() : ''),
    resetInputModes,
    screenText,
    // Is its input prompt empty (see promptCheck.js)?
    promptShowsPlaceholder: (promptChar) => promptShowsPlaceholder(term, promptChar),
    // What the screen shows of its agent: { busy, ready, approval, limit }
    // (an automation's run where no hooks report, e.g. on a remote host).
    agentObservation: () => (term ? agentScreenObservation(term, props.node.agentId, screenText(12)) : null),
    // How many "[Image #N]" its input shows (Claude Code, OpenClaude,
    // Codex: each pasted image path becomes one), or null: not known for
    // this agent or not readable now (deliver.js then waits a fixed time).
    imageMarkers: () => inputImages()
  }
  registerPane(props.node.id, paneApi)

  if (isAgent.value) activityMonitor.stateChanged(observedState.value)

  if (props.node.exitedAtStart) exited.value = true
  if (isActive.value) termFocus()
})

watch(isActive, (a) => {
  if (a && term) termFocus()
  if (a && document.hasFocus()) acknowledge()
})

// Live settings. Text metrics changes refit right away.
watch(
  () => [settings.theme, settings.cursorOpacity],
  () => {
    if (term) term.options.theme = paneTheme()
  }
)
// Weights, line height, scroll speed, contrast, word separators: applied to
// open panes right away (a refit when the grid's size may change).
watch(
  () => [
    settings.theme,
    settings.fontWeight,
    settings.fontWeightBold,
    settings.lineHeight,
    settings.scrollSensitivity,
    settings.fastScrollSensitivity,
    settings.minimumContrastRatio,
    settings.wordSeparator
  ],
  () => {
    if (!term) return
    const next = terminalSettingOptions(settings, paneTheme())
    let refit = false
    for (const [k, v] of Object.entries(next)) {
      if (term.options[k] === v) continue
      term.options[k] = v
      if (METRIC_OPTIONS.includes(k)) refit = true
    }
    if (refit) doFit()
  }
)
watch(() => settings.gpuAcceleration, applyRenderer)
watch(
  () => settings.hideMouseWhileTyping,
  (on) => !on && showMouse()
)
// This pane's font size: Settings' size plus its own zoom (Ctrl+= / Ctrl+-).
function paneFontSize() {
  return Math.min(28, Math.max(8, settings.fontSize + (props.node.fontZoom || 0)))
}
watch(
  () => [paneFontSize(), settings.fontFamily],
  ([size, family]) => {
    if (!term) return
    term.options.fontSize = size
    term.options.fontFamily = fontStack(family)
    doFit()
  }
)
watch(
  () => [settings.cursorStyle, settings.cursorBlink],
  ([style, blink]) => {
    if (!term) return
    term.options.cursorStyle = style
    term.options.cursorBlink = blink
  }
)

// Turning it on also releases a mouse a program already took.
watch(
  () => settings.alwaysSelect,
  (on) => {
    if (on && term) term.write(MOUSE_MODES.map((m) => `\x1b[?${m}l`).join(''))
  }
)

watch(isMaximized, () => {
  nextTick(() => scheduleFit())
})

onBeforeUnmount(() => {
  mounted = false
  if (ro) ro.disconnect()
  if (screenObserver) screenObserver.disconnect()
  clearTimeout(releaseTimer)
  if (fitTimer) clearTimeout(fitTimer)
  window.removeEventListener('resize', onLayoutChange)
  window.removeEventListener('terminal-layout-change', onLayoutChange)
  window.removeEventListener('pointerdown', onDocPointerDownMenu, true)
  window.removeEventListener('keydown', onEscapeMenu)
  unregisterPane(props.node.id, paneApi)
  if (unsubData) unsubData()
  if (unsubExit) unsubExit()
  if (term) term.dispose()
  term = null
  webgl = null
  // NOTE: the PTY is intentionally NOT killed here — the pane may merely be
  // re-mounting after a layout change. App.closeLeaf() owns PTY termination.
})
const paneMenuBindings = computed(() => ({
  ctxMenu: unref(ctxMenu),
  paneTitle: unref(paneTitle),
  closeCtxMenuAndRefocus: unref(closeCtxMenuAndRefocus),
  node: props.node,
  team: unref(team),
  teamFactTitle: unref(teamFactTitle),
  isLead: unref(isLead),
  isAgent: unref(isAgent),
  yoloTitle: unref(yoloTitle),
  statusTitle: unref(statusTitle),
  exited: unref(exited),
  asksApproval: unref(asksApproval),
  limit: unref(limit),
  limitState: unref(limitState),
  agentStatus: unref(agentStatus),
  estimatedState: unref(estimatedState),
  needsYou: unref(needsYou),
  stuck: unref(stuck),
  track: unref(track),
  cache: unref(cache),
  cacheTitle: unref(cacheTitle),
  cacheLeft: unref(cacheLeft),
  unsent: unref(unsent),
  launchStale: unref(launchStale),
  menuResolveUnsent: unref(menuResolveUnsent),
  applyTitle: unref(applyTitle),
  menuRestartApply: unref(menuRestartApply),
  menuCopy: unref(menuCopy),
  menuPaste: unref(menuPaste),
  menuCopyOutput: unref(menuCopyOutput),
  menuClear: unref(menuClear),
  menuResetTerminal: unref(menuResetTerminal),
  menuCopySession: unref(menuCopySession),
  menuFind: unref(menuFind),
  hasModelChoice: unref(hasModelChoice),
  modelTitle: unref(modelTitle),
  menuModel: unref(menuModel),
  modelText: unref(modelText),
  sessionPillLabel: unref(sessionPillLabel),
  paneModelList: unref(paneModelList),
  paneValues: unref(paneValues),
  ctx: unref(ctx),
  menuVoice: unref(menuVoice),
  settings: unref(settings),
  menuPickVoice: unref(menuPickVoice),
  otherPanes: unref(otherPanes),
  menuSendSelection: unref(menuSendSelection),
  menuAskReview: unref(menuAskReview),
  closeCtxMenu: unref(closeCtxMenu),
  leadToggleText: unref(leadToggleText),
  leaveTeamText: unref(leaveTeamText),
  startEditTitle: unref(startEditTitle),
  isMaximized: unref(isMaximized),
  menuOpenHere: unref(menuOpenHere),
  menuSplit: unref(menuSplit),
  menuRestart: unref(menuRestart),
  canViewTranscript: unref(canViewTranscript),
  menuViewTranscript: unref(menuViewTranscript),
  transcriptOpen: unref(transcriptOpen),
  canOpenAsChat: unref(canOpenAsChat),
  menuOpenAsChat: unref(menuOpenAsChat),
  chatViewAvailable: unref(chatViewAvailable),
  canSwitchYolo: unref(canSwitchYolo),
  menuSwitchYolo: unref(menuSwitchYolo),
  yoloFolder: unref(yoloFolder),
  yoloFolderOn: unref(yoloFolderOn),
  menuYoloFolder: unref(menuYoloFolder),
  folderName: unref(folderName),
  menuClose: unref(menuClose)
}))
</script>

<template>
  <div
    class="pane"
    :class="{
      active: isActive,
      'broadcast-member': isMember,
      maximized: isMaximized,
      agent: isAgent,
      'needs-you': needsYou,
      highlighted: ctx.highlightId.value === node.id,
      'in-team': !!team,
      dropping
    }"
    :style="paneStyle"
    :data-pane-id="node.id"
    @mouseenter="onPaneMouseEnter"
    @mousedown="focusTerm"
    @contextmenu="onContextMenu"
    @paste.capture="onPasteEvent"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <!-- The pane header, like Orca's: status and icon, title, at most one
         state badge; then a few actions. The rest is in the … menu. -->
    <div
      class="pane-nav"
      :class="{ agent: isAgent, busy: isAgent && (agentStatus === 'busy' || subRunning > 0) }"
      :style="isAgent ? { '--accent': node.accent } : null"
      data-test="pane-header"
      @mousedown.stop="onNavMouseDown"
      @pointerdown="onNavPointerDown"
    >
      <!-- Resting on the number, icon, title or state shows the hover card
           (a press, Esc or a right-click closes it). -->
      <div class="pane-nav-left" data-test="pane-hover-trigger" v-on="headerHover.triggerListeners">
        <!-- Its team, as a number (the lead's in the accent); named in the hover card. -->
        <span v-if="team" class="pane-team-num" :class="{ lead: isLead }" data-test="pane-team-num" aria-hidden="true">{{ teamNumber(team.name) }}</span>
        <span
          class="pane-icon"
          :class="isAgent ? ['agent', agentStatus === 'busy' ? 'busy' : backgroundRunning ? 'monitoring' : needsYou ? 'attention' : subRunning > 0 ? 'busy' : agentStatus, { yolo: node.launchYolo }] : null"
          :style="isAgent ? { '--accent': node.accent } : null"
          :aria-label="agentName"
          :aria-description="isAgent ? statusTitle : undefined"
        >
          <BrandIcon
            :kind="isAgent ? node.agentId : node.shellId"
            :accent="isAgent ? node.accent : null"
            :label="isAgent ? node.title : null"
            :size="15"
          />
          <span v-if="isAgent" class="pane-status-dot"></span>
        </span>
        <input
          v-if="editingTitle"
          ref="titleInputEl"
          v-model="paneTitle"
          class="pane-tab-input"
          :aria-label="t('pane.renameAgent', 'Agent name')"
          @blur="saveTitle"
          @keydown.enter.prevent="saveTitle"
          @keydown.escape.prevent="cancelEditTitle"
          @mousedown.stop
          @click.stop
        />
        <span
          v-if="!editingTitle"
          class="pane-title"
          data-test="pane-title"
          :aria-description="titleDescription"
          tabindex="0"
          @keydown.enter.prevent="startEditTitle"
          @dblclick="startEditTitle"
          >{{ paneTitle }}</span
        >
        <!-- The header shows only the agent's name: the conversation's title
             is in the hover card. Then the model it uses, one dim chip (the
             model picker on a click; hidden when the pane is narrow). -->
        <button
          v-if="headerModelText && hasModelChoice"
          class="pane-model-chip"
          type="button"
          data-test="pane-model-chip"
          :aria-label="t('pane.sessionOptions.chipLabel', 'Model: {{model}}. Choose the model', { model: headerModelText })"
          @mousedown.stop
          @click.stop="openModelMenuAtChip"
        >
          {{ headerModelText }}
        </button>
        <span
          v-else-if="headerModelText"
          class="pane-model-chip static"
          data-test="pane-model-chip"
          :aria-label="t('pane.sessionOptions.chipStatic', 'Model: {{model}}', { model: headerModelText })"
          >{{ headerModelText }}</span
        >
        <!-- One badge: the most urgent state (all of them are in the … menu). -->
        <span v-if="badge === 'asleep'" class="exit-tag" data-test="pane-badge" :title="t('pane.badge.asleepHint', 'Asleep: open the pane to wake it')">{{ t('pane.badge.asleep', 'asleep') }}</span>
        <span v-else-if="badge === 'exited'" class="exit-tag" data-test="pane-badge">{{ t('pane.badge.exited', 'exited') }}</span>
        <span v-else-if="badge === 'approval'" class="pane-approval" data-test="pane-badge" :title="t('pane.badge.approvalHint', 'This agent is asking you to approve something')">{{ t('pane.badge.approval', 'approve?') }}</span>
        <span v-else-if="badge === 'question'" class="pane-approval" data-test="pane-badge" :title="t('pane.badge.questionHint', 'This agent asks you a question')">{{ t('pane.badge.question', 'question?') }}</span>
        <span v-else-if="badge === 'limit'" class="pane-limit" data-test="pane-badge" :title="limitTitle">{{ t('pane.badge.limit', 'limit') }}{{ limit.reset ? ` · ${limit.reset}` : '' }}</span>
        <button
          v-else-if="badge === 'unsent'"
          class="pane-unsent"
          data-test="pane-badge"
          :title="t('pane.badge.unsentHint', 'A message was pasted but not seen taken: click to say what happened')"
          @click.stop="ctx.resolveUnsent(node.id)"
        >
          {{ t('pane.badge.unsent', 'not confirmed') }}
        </button>
        <span v-else-if="badge === 'stuck'" class="pane-stuck" :class="track.level" data-test="pane-badge" :title="track.reason">{{ quietFor(track.minutes) }}</span>
        <button
          v-else-if="badge === 'apply'"
          class="pane-apply"
          type="button"
          data-test="pane-restart-apply"
          :title="applyTitle()"
          @click.stop="restartToApply"
        >
          {{ t('pane.badge.apply', 'Restart to apply') }}
        </button>
        <span v-else-if="badge === 'working'" class="pane-working pane-badge-sr" data-test="pane-badge" :aria-description="statusTitle">{{ estimatedState ? t('pane.badge.workingEstimated', 'working · estimated') : t('pane.badge.working', 'working') }}</span>
        <span v-else-if="badge === 'monitoring'" class="pane-working pane-monitoring pane-badge-sr" data-test="pane-badge" :aria-description="statusTitle">{{ t('pane.badge.monitoring', 'monitoring') }}</span>
        <span v-else-if="badge === 'unknown'" class="pane-working pane-badge-sr" data-test="pane-badge" :aria-description="statusTitle">{{ t('pane.badge.unknown', 'unknown') }}</span>
        <span v-else-if="badge === 'needs'" class="pane-needs-you" data-test="pane-badge">{{ t('pane.badge.needs', 'needs you') }}</span>
        <span v-else-if="badge === 'cache'" class="pane-cache" :class="cache.level" data-test="pane-badge" :title="cacheTitle">
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <circle cx="8" cy="9" r="5.5" stroke="currentColor" stroke-width="1.4" />
            <path d="M8 6v3l2 1.5M6.5 1.5h3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
          </svg>
          <template v-if="cache.level !== 'expired'">{{ cache.label }}</template>
        </span>
      </div>
      <HoverCardContent :hc="headerHover" side="bottom" align="start" :side-offset="6" class="pane-hover-card" data-test="pane-hover-card">
        <PaneHoverDetails :info="hoverInfo" />
      </HoverCardContent>
      <div class="pane-nav-actions" @mousedown.stop>
        <label
          v-if="ctx.broadcast.value"
          class="bc-toggle"
          :class="{ member: node.broadcast }"
          :title="t('pane.broadcast.hint', 'Include this pane in multi-write')"
        >
          <input v-model="node.broadcast" type="checkbox" />
          {{ t('pane.broadcast.write', 'write') }}
        </label>
        <!-- sub-agents: a compact count; click for the list -->
        <AgentChildren
          v-if="isAgent && listsChildren(node.agentId) && node.sessionId && !node.sleeping"
          :agent-id="node.agentId"
          :session-id="node.sessionId"
          :account-id="node.accountId"
          :parent-idle-since="turnEndedAt"
          @running="onSubRunning"
        />
        <!-- chat view <-> terminal (the agent keeps running: nothing restarts) -->
        <button
          v-if="chatViewAvailable || opencodeAgent"
          class="pane-nav-btn"
          :class="{ on: chatShown }"
          data-test="pane-chat-toggle"
          :disabled="!chatViewAvailable && !canOpenAsChat"
          :title="chatToggleTitle"
          :aria-label="chatShown ? t('pane.chatView.showTerminal', 'Show terminal') : t('pane.chatView.showChat', 'Show chat view')"
          :aria-pressed="chatShown"
          @click="chatViewAvailable ? toggleChatView() : menuOpenAsChat()"
        >
          <svg v-if="chatShown" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <rect x="1.8" y="2.5" width="12.4" height="11" rx="1.6" stroke="currentColor" stroke-width="1.4" />
            <path d="M4.5 6.2l2 1.8-2 1.8M8 10h3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          <svg v-else width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M2.5 3.5h11v7.2H7l-3 2.6v-2.6H2.5z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
          </svg>
        </button>
        <!-- voice typing (its language: in the … menu) -->
        <button
          class="pane-nav-btn mic-btn"
          data-test="pane-voice"
          :title="t('pane.voice.hint', 'Speak instead of typing ({{language}}). Windows voice typing, Win+H. Language: … menu', { language: ctx.voiceName.value })"
          :aria-label="t('pane.voice.label', 'Voice typing ({{language}})', { language: ctx.voiceName.value })"
          @click="ctx.voiceTyping(node.id)"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <rect x="5.5" y="1.8" width="5" height="8" rx="2.5" stroke="currentColor" stroke-width="1.4" />
            <path d="M3.3 7.5a4.7 4.7 0 009.4 0M8 12.2v2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
          </svg>
        </button>
        <!-- ellipsis / more options: everything the header no longer shows -->
        <button
          class="pane-nav-btn"
          data-test="pane-menu-btn"
          :title="t('pane.moreHint', 'More options (or Shift+right-click in the pane)')"
          :aria-label="t('pane.more', 'More options')"
          aria-haspopup="menu"
          :aria-expanded="ctxMenu.visible"
          @click="openMenuAtBtn"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="3" cy="8" r="1.4" fill="currentColor" />
            <circle cx="8" cy="8" r="1.4" fill="currentColor" />
            <circle cx="13" cy="8" r="1.4" fill="currentColor" />
          </svg>
        </button>
        <!-- maximize / restore -->
        <button
          class="pane-nav-btn"
          :title="isMaximized ? t('pane.restore', 'Restore pane') : t('pane.maximize', 'Maximize pane')"
          :aria-label="isMaximized ? t('pane.restore', 'Restore pane') : t('pane.maximize', 'Maximize pane')"
          @click="ctx.toggleMaximize(node.id)"
        >
          <svg v-if="isMaximized" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M6 2v4H2M14 6h-4V2M10 14v-4h4M2 10h4v4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          <svg v-else width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
        <!-- close -->
        <button
          class="pane-nav-btn close"
          :title="t('pane.closeHint', 'Close pane (Ctrl+Shift+W)')"
          :aria-label="t('pane.close', 'Close pane')"
          @click="ctx.closeLeaf(node.id)"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
          </svg>
        </button>
      </div>
    </div>

    <div ref="hostEl" class="term-host"></div>
    <div v-if="chatShown" class="term-transcript" data-test="terminal-chat-view" @mousedown.stop="ctx.setActive(node.id)">
      <NativeChatTranscriptView
        ref="chatViewEl"
        :agent="node.agentId"
        :session-id="node.sessionId || ''"
        :agent-name="paneTitle"
        :node="node"
        :is-visible="paneOnScreen"
        :is-active="isActive"
        interactive
        :pane-id="node.id"
        :account-id="typeof node.accountId === 'string' || node.accountId === null ? node.accountId : undefined"
        :working="chatWorking"
        :compacting="chatCompacting"
        :waiting="chatWaiting"
        :disabled-reason="chatDisabledReason"
        :send-message="chatSend"
        :write-keys="chatKeys"
        :allow-images="chatViewTakesImages(node.agentId)"
        :session-options="chatSessionOptions"
        :set-option="chatSetOption"
        :list-files="chatListFiles"
        :context-model="(agentModel && agentModel.model) || ''"
        :screen-context="node.agentId === 'cursor' ? screenContext : null"
        :prompt-suggestion="promptSuggestion"
        :permission-mode="chatPermissionMode"
        :mode-blocked="chatModeBlocked"
        :set-permission-mode="chatSetPermissionMode"
        :dictate="chatDictate"
        :dictation-title="chatDictationTitle"
        :pane-actions="chatPaneActions"
        :background="chatBackground"
        :send-held-reason="chatSendHeldReason"
        @close="toggleChatView"
      />
    </div>
    <div v-else-if="transcriptOpen && canViewTranscript" class="term-transcript" @mousedown.stop="ctx.setActive(node.id)">
      <NativeChatTranscriptView
        :agent="node.agentId"
        :session-id="node.sessionId"
        :agent-name="paneTitle"
        :node="node"
        :is-visible="paneOnScreen"
        @close="closeTranscript"
      />
    </div>

    <div v-if="findOpen" class="find-bar" @mousedown.stop>
      <input
        ref="findInputEl"
        v-model="findQuery"
        class="find-input"
        :placeholder="t('pane.find.placeholder', 'Find')"
        spellcheck="false"
        @input="onFindInput"
        @keydown.enter.exact.prevent="findNext"
        @keydown.shift.enter.prevent="findPrev"
        @keydown.escape.prevent="closeFind"
      />
      <span class="find-count">{{ findCount() }}</span>
      <button class="pane-nav-btn" :title="t('pane.find.previous', 'Previous (Shift+Enter)')" @click="findPrev">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M4 10l4-4 4 4"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </button>
      <button class="pane-nav-btn" :title="t('pane.find.next', 'Next (Enter)')" @click="findNext">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M4 6l4 4 4-4"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </button>
      <button class="pane-nav-btn" :title="t('pane.find.close', 'Close (Esc)')" @click="closeFind">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M4 4l8 8M12 4l-8 8"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
          />
        </svg>
      </button>
    </div>

    <button
      v-if="scrolledUp && !exited"
      class="jump-bottom"
      :class="{ fresh: newBelow }"
      :title="newBelow ? t('pane.jump.newHint', 'New output below. Jump to the latest') : t('pane.jump.hint', 'Jump to the latest output')"
      @mousedown.stop
      @click="jumpToBottom"
    >
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
          d="M8 2.5v10M3.5 8.5L8 13l4.5-4.5"
          stroke="currentColor"
          stroke-width="1.7"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
      {{ newBelow ? t('pane.jump.new', 'New output') : t('pane.jump.latest', 'Latest') }}
    </button>

    <div v-if="node.failed" class="exit-overlay failed" @mousedown.stop>
      <span :title="node.failed">{{ t('pane.failed', "This terminal couldn't start.") }}</span>
      <button class="exit-btn primary" @click="ctx.restartLeaf(node.id)">{{ t('pane.retry', 'Retry') }}</button>
      <button class="exit-btn" @click="ctx.closeLeaf(node.id, { force: true })">{{ t('pane.close', 'Close pane') }}</button>
    </div>

    <div v-else-if="node.notConnected" class="exit-overlay remote-idle" data-test="remote-connect-overlay" @mousedown.stop>
      <span>{{ notConnectedText() }}</span>
      <button class="exit-btn primary" data-test="remote-connect" :disabled="!!node.connecting" @click="connectRemote">
        {{ node.connecting ? t('pane.remote.connecting', 'Connecting…') : t('pane.remote.connect', 'Connect') }}
      </button>
    </div>

    <div v-else-if="node.sleeping && !chatShown" class="exit-overlay sleeping" data-test="sleep-overlay" @mousedown.stop>
      <span>{{ asleepText() }}</span>
      <button class="exit-btn primary" @click="ctx.wakeLeaf && ctx.wakeLeaf(node.id)">{{ t('pane.sleep.wake', 'Wake it') }}</button>
    </div>

    <div v-else-if="exited" class="exit-overlay" @mousedown.stop>
      <span>{{ exitedText() }}</span>
      <button class="exit-btn primary" @click="ctx.restartLeaf(node.id)">{{ t('pane.restart', 'Restart') }}</button>
      <button class="exit-btn" @click="ctx.closeLeaf(node.id, { force: true })">{{ t('pane.close', 'Close pane') }}</button>
    </div>

    <div v-if="dropping" class="drop-hint">{{ t('pane.dropHint', 'Drop to paste the file path') }}</div>

    <div
      v-if="pasteAsk"
      ref="pasteAskEl"
      class="paste-ask"
      tabindex="-1"
      role="dialog"
      :aria-label="t('pane.paste.confirm', 'Confirm paste')"
      @mousedown.stop
      @contextmenu.stop.prevent
      @keydown.enter.stop="
        (e) => !e.target.closest('button') && (e.preventDefault(), confirmPaste())
      "
      @keydown.escape.prevent.stop="cancelPaste"
    >
      <div class="paste-ask-title">
        {{ pasteTitle(pasteAsk.lines) }}
      </div>
      <pre class="paste-ask-preview">{{ pasteAsk.preview }}</pre>
      <div v-if="pasteAsk.more" class="paste-ask-more">
        {{ pasteMore(pasteAsk.more) }}
      </div>
      <div class="paste-ask-actions">
        <button class="exit-btn" @click="cancelPaste">{{ t('pane.paste.cancel', 'Cancel') }} <kbd>Esc</kbd></button>
        <button class="exit-btn primary" @click="confirmPaste">{{ t('pane.paste.paste', 'Paste') }} <kbd>Enter</kbd></button>
      </div>
    </div>
  </div>

  <Teleport to="body">
    <PaneActionsMenu ref="ctxMenuEl" v-bind="paneMenuBindings" />
    <!-- Pane menu > Model: the model, effort and fast mode of this agent. -->
    <div
      v-if="modelMenu.visible"
      ref="modelMenuEl"
      class="ctx-menu pane-model-menu"
      data-test="pane-model-menu"
      :style="{ left: modelMenu.x + 'px', top: modelMenu.y + 'px' }"
      tabindex="-1"
      @mousedown.stop
      @keydown.escape.prevent.stop="closeModelMenu(true)"
    >
      <SessionOptionPicker
        :agent-id="node.agentId"
        :models="paneModelList"
        :values="paneMenuValues"
        :default-label="modelDefaultLabel"
        :fallback-model="effectiveModelId"
        :live="paneRunning"
        :note="modelMenuNote"
        :disabled-reason="modelBusyReason"
        :pending="modelMenu.pending"
        @set="onModelPick"
        @action="onModelAction"
      />
    </div>
  </Teleport>
</template>
