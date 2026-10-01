// The transcript's words for a model or effort change (the engine's 'option'
// event: { option: 'model' | 'effort', value, ok }), in the same words as the
// composer's pills: the model's name from its list, the effort as the options
// pill says it. Like the reference's notice rows (NativeChatNoticeRow).
import { t } from '../../i18n'
import { modelLabel } from '../../../../shared/modelLabel'
import { modelsFor } from '../../agentModels'
import { nativeChatSessionChoiceLabel } from './native-chat-session-option-labels.js'

// The model's name as its list gives it ("opus" -> "Opus 5.5"), else the short
// name read from its id.
export function chatModelName(agent, id) {
  const list = agent ? modelsFor(agent) : []
  const short = modelLabel(id)
  const listed = list.find((x) => x.id === id) || list.find((x) => x.label && x.label === short)
  return listed && listed.label ? listed.label : short || String(id || '')
}

export function chatOptionNoticeText(ev, agent) {
  if (!ev || (ev.option !== 'model' && ev.option !== 'effort')) return ''
  const value = String(ev.value ?? '')
  const from = typeof ev.from === 'string' && ev.from && ev.from !== value ? ev.from : ''
  if (ev.option === 'model') {
    const name = chatModelName(agent, value)
    if (ev.ok === false) return t('chat.option.modelFailed', 'Model not changed: {{name}}', { name })
    return from
      ? t('chat.option.modelChange', 'Model: {{from}} → {{to}}', { from: chatModelName(agent, from), to: name })
      : t('chat.option.model', 'Model: {{name}}', { name })
  }
  const name = nativeChatSessionChoiceLabel({ value, label: value })
  if (ev.ok === false) return t('chat.option.effortFailed', 'Effort not changed: {{name}}', { name })
  return from
    ? t('chat.option.effortChange', 'Effort: {{from}} → {{to}}', { from: nativeChatSessionChoiceLabel({ value: from, label: from }), to: name })
    : t('chat.option.effort', 'Effort: {{name}}', { name })
}
