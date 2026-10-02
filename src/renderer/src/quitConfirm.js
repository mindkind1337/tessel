// Closing Tessel's window quits it and stops every agent and terminal. With
// Settings > General "Ask before quitting while agents or terminals run" on,
// the window asks first (App.vue, when the main process asks before closing).
import { t } from './i18n'

// What quitting would stop in these panes: { agents, terminals }. An agent
// pane (terminal or chat agent) counts as an agent; any other pane with a
// terminal as a terminal. Not counted: editors and browser pages, panes
// asleep (nothing runs until they are opened), panes not connected yet.
export function countRunning(leaves, { isAgent, noTerminal, asleep = () => false } = {}) {
  let agents = 0
  let terminals = 0
  for (const leaf of leaves || []) {
    if (!leaf || leaf.sleeping || leaf.notConnected || asleep(leaf)) continue
    if (isAgent(leaf)) agents++
    else if (!noTerminal(leaf)) terminals++
  }
  return { agents, terminals }
}

// The question's text, e.g. "3 agents and 6 terminals are running. Quitting
// stops them. Agent conversations can be resumed later."
export function quitText({ agents = 0, terminals = 0 } = {}) {
  const parts = []
  if (agents) parts.push(agents === 1 ? t('app.quit.agentOne', '1 agent') : t('app.quit.agents', '{{count}} agents', { count: agents }))
  if (terminals) parts.push(terminals === 1 ? t('app.quit.terminalOne', '1 terminal') : t('app.quit.terminals', '{{count}} terminals', { count: terminals }))
  const what = parts.length === 2 ? t('app.quit.and', '{{first}} and {{second}}', { first: parts[0], second: parts[1] }) : parts[0] || ''
  const running =
    agents + terminals === 1
      ? t('app.quit.runningOne', '{{what}} is running. Quitting stops it.', { what })
      : t('app.quit.runningMany', '{{what}} are running. Quitting stops them.', { what })
  if (!agents) return running
  return `${running} ${t('app.quit.resume', 'Agent conversations can be resumed later.')}`
}

// Ask (askConfirm from App.vue) before quitting while something runs.
// Resolves true to quit. "Don't ask again" (only kept when Quit is chosen)
// turns the setting off.
export async function askQuitRunning({ settings, leaves, isAgent, noTerminal, asleep, askConfirm }) {
  if (!settings.confirmQuitRunning) return true
  const counts = countRunning(leaves, { isAgent, noTerminal, asleep })
  if (!counts.agents && !counts.terminals) return true
  let dontAsk = false
  const ok = await askConfirm({
    title: t('app.quit.title', 'Quit Tessel?'),
    text: quitText(counts),
    confirmLabel: t('app.quit.confirm', 'Quit'),
    danger: true,
    checkLabel: t('app.quit.dontAsk', "Don't ask again"),
    onCheck: (checked) => {
      dontAsk = checked
    }
  })
  if (ok !== true) return false
  if (dontAsk) settings.confirmQuitRunning = false
  return true
}
