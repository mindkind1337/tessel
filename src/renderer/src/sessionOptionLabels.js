// Words of the model pickers in the interface's language, after Orca's
// native-chat-session-option-labels.ts (github.com/stablyai/orca, MIT,
// Copyright (c) 2026 Lovecast Inc.): the catalog's labels are English
// (shared/agentSessionOptions.js), shown through t() here.
import { t } from './i18n'

export function sessionOptionLabel(option) {
  switch (option && option.id) {
    case 'model': // i18n-ignore
      return t('pane.sessionOptions.model', 'Model')
    case 'effort': // i18n-ignore
      return option.label === 'Reasoning effort' // i18n-ignore
        ? t('pane.sessionOptions.reasoningEffort', 'Reasoning effort')
        : t('pane.sessionOptions.effort', 'Effort')
    case 'fastMode': // i18n-ignore
      return t('pane.sessionOptions.fastMode', 'Fast mode')
    case 'thinking': // i18n-ignore
      return t('pane.sessionOptions.thinking', 'Thinking')
    default:
      return (option && option.label) || ''
  }
}

export function sessionChoiceLabel(choice) {
  switch (choice && choice.value) {
    case 'off': // i18n-ignore
      return t('pane.sessionOptions.value.off', 'Off')
    case 'minimal': // i18n-ignore
      return t('pane.sessionOptions.value.minimal', 'Minimal')
    case 'low': // i18n-ignore
      return t('pane.sessionOptions.value.low', 'Low')
    case 'medium': // i18n-ignore
      return t('pane.sessionOptions.value.medium', 'Medium')
    case 'high': // i18n-ignore
      return t('pane.sessionOptions.value.high', 'High')
    case 'xhigh': // i18n-ignore
      return t('pane.sessionOptions.value.xhigh', 'Extra high')
    case 'max': // i18n-ignore
      return t('pane.sessionOptions.value.max', 'Max')
    case 'ultra': // i18n-ignore
      return t('pane.sessionOptions.value.ultra', 'Ultra')
    default:
      return (choice && (choice.label || choice.value)) || ''
  }
}

// The seed's descriptions (the CLI's own ones are shown as it gives them).
export function modelDescription(model) {
  const d = model && model.description
  switch (d) {
    case 'Most capable for the hardest, longest-running tasks': // i18n-ignore
      return t('pane.sessionOptions.describe.fable', 'Most capable for the hardest, longest-running tasks')
    case 'Best for everyday, complex tasks': // i18n-ignore
      return t('pane.sessionOptions.describe.opus', 'Best for everyday, complex tasks')
    case 'Efficient for routine tasks': // i18n-ignore
      return t('pane.sessionOptions.describe.sonnet', 'Efficient for routine tasks')
    case 'Fastest for quick answers': // i18n-ignore
      return t('pane.sessionOptions.describe.haiku', 'Fastest for quick answers')
    case "xAI's latest frontier model": // i18n-ignore
      return t('pane.sessionOptions.describe.grokLatest', "xAI's latest frontier model")
    case "xAI's previous frontier model": // i18n-ignore
      return t('pane.sessionOptions.describe.grokPrevious', "xAI's previous frontier model")
    default:
      return d || ''
  }
}

// A model id -> its name in a list (the id itself when the list lacks it).
export function modelChoiceLabel(models, id) {
  const m = (models || []).find((x) => x.id === id)
  return m ? m.label : id || ''
}

// The pill's text (Orca's nativeChatModelPillLabel / nativeChatOptionsPillLabel):
// the values only ("Opus · High"); "Model" when nothing is chosen.
export function sessionPillLabel(models, values) {
  if (!values || !values.model) return t('pane.sessionOptions.model', 'Model')
  const parts = [modelChoiceLabel(models, values.model)]
  if (typeof values.effort === 'string') parts.push(sessionChoiceLabel({ value: values.effort }))
  if (values.fastMode === true) parts.push(t('pane.sessionOptions.value.fast', 'Fast'))
  return parts.join(' · ')
}

// Why a probe gave no list, in words.
export function probeErrorText(error, agentName) {
  if (!error) return ''
  switch (error.reason) {
    case 'not-found': // i18n-ignore
      return t('pane.sessionOptions.probe.notFound', '{{agent}} was not found on this computer.', { agent: agentName })
    case 'timeout': // i18n-ignore
      return t('pane.sessionOptions.probe.timeout', '{{agent}} did not list its models within 60 s.', { agent: agentName })
    case 'too-much': // i18n-ignore
      return t('pane.sessionOptions.probe.tooMuch', '{{agent}} returned too much model data.', { agent: agentName })
    case 'empty': // i18n-ignore
      return t('pane.sessionOptions.probe.empty', '{{agent}} listed no models; the built-in list stays.', { agent: agentName })
    case 'unsupported': // i18n-ignore
      return t('pane.sessionOptions.probe.unsupported', '{{agent}} cannot list its models.', { agent: agentName })
    default:
      return error.detail
        ? t('pane.sessionOptions.probe.failedDetail', '{{agent}} could not list its models: {{detail}}', { agent: agentName, detail: error.detail })
        : t('pane.sessionOptions.probe.failed', '{{agent}} could not list its models.', { agent: agentName })
  }
}
