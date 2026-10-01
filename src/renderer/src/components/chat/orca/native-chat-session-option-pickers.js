// After Orca's NativeChatSessionOptionPickers.tsx (MIT, Copyright (c) 2026 Lovecast Inc.):
// what the pickers read (a snapshot of option descriptors and a surface that
// sets them), built from a Tessel chat pane's facts. The pane owns the rules
// through useNativeChatSessionOptionCommand (its modeBlocked and
// confirmedValues): the snapshot shows the CONFIRMED values only, and each
// permission mode says why it cannot be chosen now (the same rules as
// ChatPane.vue: Yolo only for a chat started in Yolo, not for a capped
// worker, no Auto for one either, Codex: Manual and Yolo, never Yolo during
// a turn). The main process stays the authority.
import { t } from '../../../i18n'
import { getAgentSessionOptionCatalog, modelOptions } from '../../../../../shared/agentSessionOptions.js'
import { modelLabel } from '../../../../../shared/modelLabel.js'

// Each agent's permission modes, in the order ChatPane.vue lists them.
export const TESSEL_PERMISSION_MODES = {
  claude: ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'],
  codex: ['default', 'bypassPermissions'],
  // OpenCode: its session's rules (Manual, Yolo) and its plan agent.
  opencode: ['default', 'plan', 'bypassPermissions']
}

export function permissionModeLabel(mode) {
  switch (mode) {
    case 'acceptEdits':
      return t('chat.mode.acceptEdits', 'Accept edits')
    case 'plan':
      return t('chat.mode.plan', 'Plan')
    case 'auto':
      return t('chat.mode.auto', 'Auto')
    case 'bypassPermissions':
      return t('chat.mode.yolo', 'Yolo')
    default:
      return t('chat.mode.manual', 'Manual')
  }
}

export function permissionModeHint(mode, agent) {
  switch (mode) {
    case 'acceptEdits':
      return t('chat.mode.acceptEditsHint', 'Changes files without asking; still asks before running commands')
    case 'plan':
      return t('chat.mode.planHint', 'Only reads and plans: changes nothing until you accept its plan')
    case 'auto':
      return t('chat.mode.autoHint', 'Claude runs the actions it judges safe and asks for the others')
    case 'bypassPermissions':
      return t('chat.mode.yoloHint', 'Runs commands and changes files without ever asking')
    default:
      if (agent === 'opencode') return t('chat.mode.manualOpencodeHint', 'Asks before running commands, changing files or fetching pages, also for its sub-agents')
      return agent === 'codex'
        ? t('chat.mode.manualCodexHint', 'Works in the project folder; asks before anything outside it or with network access')
        : t('chat.mode.manualHint', 'Asks before running commands or changing files')
  }
}

// -> the descriptors for NativeChatSessionOptionPickers.
// agent: 'claude' | 'codex'; models: agentModels.modelsFor(agent); values:
// the confirmed { model, effort, permissionMode } (useNativeChatSessionOption-
// Command's confirmedValues); modeBlocked(mode) -> '' or why not (the same
// composable's); permissionModes: false to leave the mode picker out.
export function tesselSessionOptionSnapshot({ agent, models = [], values = {}, modeBlocked = () => '', permissionModes = true } = {}) {
  const out = []
  const catalog = getAgentSessionOptionCatalog(agent)
  const effortChoicesFor = (id) => catalog ? (modelOptions(catalog, models, id).find(o => o.id === 'effort' && o.kind?.type === 'select')?.kind.choices || []) : []
  let model = typeof values.model === 'string' && values.model ? values.model : null
  // The agent reports its full id (claude-opus-5-5) where the list has the
  // alias it was chosen by (opus, "Opus 5.5"): that row is the current one.
  // Its 1M-context form ("claude-opus-5-5[1m]") is the same row.
  if (model && !models.some((m) => m.id === model)) {
    const plain = modelLabel(model).replace(/ \(1M\)$/, '')
    const same = models.find((m) => m.label && (m.label === modelLabel(model) || m.label === plain)) || models.find((m) => m.id === model.replace(/\[1m\]$/i, ''))
    if (same) model = same.id
  }
  // The chosen model is listed even when the list does not have it.
  const rows = models.map((m) => ({ value: m.id, label: m.label || m.id, ...(m.description ? { description: m.description } : {}) }))
  if (model && !rows.some((r) => r.value === model)) rows.push({ value: model, label: modelLabel(model) || model })
  out.push({
    id: 'model',
    // Worded by nativeChatSessionOptionLabel (the ids are data).
    label: 'Model', // i18n-ignore
    category: 'model',
    effortByModel: Object.fromEntries(rows.map(row => [row.value, effortChoicesFor(row.value)])),
    kind: { type: 'select', ...(model ? { currentValue: model } : {}), choices: rows },
    valueSource: model ? 'reported' : 'unknown',
    transport: 'agent-session',
    settable: true
  })
  const effort = model && catalog ? modelOptions(catalog, models, model).find((o) => o.id === 'effort' && o.kind && o.kind.type === 'select') : null
  if (effort) {
    const current = typeof values.effort === 'string' && values.effort ? values.effort : null
    out.push({
      id: 'effort',
      label: effort.label || 'Effort', // i18n-ignore
      category: 'thought_level',
      kind: { type: 'select', ...(current ? { currentValue: current } : {}), choices: effort.kind.choices.map((c) => ({ value: c.value, label: c.label })) },
      valueSource: current ? 'reported' : 'unknown',
      transport: 'agent-session',
      settable: true
    })
  }
  const modes = TESSEL_PERMISSION_MODES[agent] || TESSEL_PERMISSION_MODES.claude
  if (permissionModes) {
    const current = modes.includes(values.permissionMode) ? values.permissionMode : 'default'
    out.push({
      id: 'permissionMode',
      label: t('chat.orca.composer.permissionMode', 'Permission mode'),
      category: 'mode',
      kind: {
        type: 'select',
        currentValue: current,
        choices: modes.map((mode) => {
          // The mode it is in is never "blocked" (ChatPane.vue's rule).
          const why = mode === current ? '' : modeBlocked(mode) || ''
          return { value: mode, label: permissionModeLabel(mode), description: permissionModeHint(mode, agent), ...(why ? { disabled: true, disabledReason: why } : {}) }
        })
      },
      valueSource: 'reported',
      transport: 'agent-session',
      settable: true,
      // Tessel: a permission mode may change during a turn (Claude asks the
      // same questions less); the pickers otherwise wait for the turn's end.
      settableWhileWorking: true
    })
  }
  return out
}

// -> the pickers' surface: every choice goes through dispatch({ optionId,
// value }) (useNativeChatSessionOptionCommand's), whose { ok } the pickers
// read. No action rows in Tessel: invokeAction refuses.
export function tesselSessionOptionSurface(dispatch) {
  return {
    setOption: (id, value) => dispatch({ optionId: id, value }),
    setOptions: (values) => dispatch({ values }),
    invokeAction: async () => ({ ok: false, error: t('chat.orca.options.unsupported', 'This option is not available for this agent.') })
  }
}
