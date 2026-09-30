// Why a pane waits before an agent update restarts it (agentUpdatePlan.js
// gives the reason in English, for the log): in the app's language.
import { t } from './i18n'

const REASONS = {
  'not an agent pane': () => t('app.agentUpdate.wait.notAgent', 'not an agent pane'),
  'being restarted': () => t('app.agentUpdate.wait.restarting', 'being restarted'),
  'its conversation cannot be resumed': () => t('app.agentUpdate.wait.noResume', 'its conversation cannot be resumed'),
  'waiting for an approval': () => t('app.agentUpdate.wait.approval', 'waiting for an approval'),
  'at its usage limit': () => t('app.agentUpdate.wait.limit', 'at its usage limit'),
  'its idle state is not confirmed yet': () => t('app.agentUpdate.wait.unconfirmed', 'not yet confirmed idle'),
  working: () => t('app.agentUpdate.wait.working', 'working'),
  'idle time unknown': () => t('app.agentUpdate.wait.idleUnknown', 'idle time unknown'),
  'just finished working': () => t('app.agentUpdate.wait.justFinished', 'just finished working'),
  'something is typed in it': () => t('app.agentUpdate.wait.draft', 'something is typed in it'),
  'you typed there lately': () => t('app.agentUpdate.wait.typedLately', 'you typed there lately'),
  'you are in this pane': () => t('app.agentUpdate.wait.focused', 'you are in this pane'),
  'a team message is being delivered': () => t('app.agentUpdate.wait.delivering', 'a team message is being delivered'),
  'a reminder was just typed there': () => t('app.agentUpdate.wait.reminder', 'a reminder was just typed there'),
  waiting: () => t('app.agentUpdate.wait.waiting', 'waiting')
}

export function updateWhyText(why) {
  const known = REASONS[why]
  if (known) return known()
  const state = /^state (.+)$/.exec(String(why || ''))
  return state ? t('app.agentUpdate.wait.state', 'state: {{state}}', { state: state[1] }) : String(why || '')
}

// "Bohr (working), Ada (you are in this pane)".
export function describeWaitingText(list) {
  return (Array.isArray(list) ? list : []).map((w) => `${w.label} (${updateWhyText(w.why)})`).join(', ')
}
