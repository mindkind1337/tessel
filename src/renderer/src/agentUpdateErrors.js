// Why an agent update failed, in plain words (Settings > Agents, toasts,
// notifications). kind comes from the main process (agentUpdateRunner.js
// classifyFailure, agentUpdateHistory.js): 'ok', 'same-version', 'in-use',
// 'permission', 'network', 'not-found', 'timeout', 'busy', 'failed'.
import { t } from './i18n'

// A short label (the history list).
export function updateKindLabel(kind) {
  switch (kind) {
    case 'ok':
      return t('settings.agents.kind.ok', 'Updated')
    case 'same-version':
      return t('settings.agents.kind.sameVersion', 'Still the old version')
    case 'in-use':
      return t('settings.agents.kind.inUse', 'Files in use')
    case 'permission':
      return t('settings.agents.kind.permission', 'Permission denied')
    case 'network':
      return t('settings.agents.kind.network', 'Network error')
    case 'not-found':
      return t('settings.agents.kind.notFound', 'Not found')
    case 'timeout':
      return t('settings.agents.kind.timeout', 'Timed out')
    case 'busy':
      return t('settings.agents.kind.busy', 'Another update was running')
    default:
      return t('settings.agents.kind.failed', 'Failed')
  }
}

// A sentence: what went wrong and what to do. panes: how many Tessel panes run
// that agent (for files in use).
export function updateFailureText(kind, name, { panes = 0 } = {}) {
  switch (kind) {
    case 'in-use':
      return panes > 0
        ? t('app.agentUpdate.why.inUsePanes', '{{name}} is running in other panes, so its files are in use. Tessel can close and reopen them (conversations kept) to finish the update.', { name })
        : t('app.agentUpdate.why.inUseOutside', "{{name}}'s files are in use by a program outside Tessel (another terminal?). Close it there, then try again.", { name })
    case 'permission':
      return t('app.agentUpdate.why.permission', "Tessel may not write to npm's global folder. Run the update in a terminal opened as administrator, or set npm's global prefix to a folder of yours.")
    case 'network':
      return t('app.agentUpdate.why.network', 'The download server could not be reached (network, proxy or firewall). Check your connection, then try again.')
    case 'not-found':
      return t('app.agentUpdate.why.notFound', 'The update command or the package was not found: npm (or {{name}}) is not on PATH, or the package has moved.', { name })
    case 'timeout':
      return t('app.agentUpdate.why.timeout', 'The update did not finish within 10 minutes, so Tessel stopped it.')
    case 'same-version':
      return t('app.agentUpdate.why.sameVersion', 'The update ran, but {{name}} still reports the old version: another copy may come first on PATH.', { name })
    case 'busy':
      return t('app.agentUpdate.why.busy', 'Another agent was being updated. Try again when it has finished.')
    default:
      return t('app.agentUpdate.why.failed', 'The update failed. The log shows what went wrong.')
  }
}
