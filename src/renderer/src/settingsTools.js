// The windows, panels and tools Settings opens (an "Open…" row each, in the
// page they belong to), so every feature of the palette, the toolbar and the
// menus is also reachable from Settings (Skills and MCP servers are pages of
// their own). A row emits `open-tool` with its id; App.vue closes Settings
// and runs the matching action (SETTINGS_TOOL_IDS lists them all, so a spec
// can check App handles each one).
import { t } from './i18n'

const row = (id, title, hint, button) => ({
  id,
  get title() {
    return title()
  },
  get hint() {
    return hint()
  },
  get button() {
    return button()
  }
})
const open = () => t('settings.tools.open', 'Open…')
const show = () => t('settings.tools.show', 'Show')
const copy = () => t('settings.tools.copy', 'Copy')

// Page id -> its rows, in the order shown.
export const SETTINGS_TOOLS = {
  agents: [
    row('dashboard', () => t('settings.tools.dashboard', 'Agent Dashboard'), () => t('app.cmd.agentDashboardHint', 'Every agent of every project at a glance'), show),
    // Past conversations: the side panel's tab (the palette's Resume a past
    // conversation opens the same list in a dialog).
    row('history', () => t('settings.tools.sessionHistory', 'Past conversations'), () => t('app.cmd.sessionHistoryHint', 'Browse, search and resume past agent conversations'), show)
  ],
  orchestration: [
    row('tasks', () => t('settings.tools.taskBoard', 'Task board'), () => t('settings.tools.taskBoardHint', 'The cards of this workspace and who works on them (Ctrl+Shift+K).'), show),
    row('newTask', () => t('settings.tools.newTask', 'New task'), () => t('app.cmd.newTaskHint', 'Give an agent a task, in its own copy of the project'), open),
    row('taskHistory', () => t('settings.tools.taskHistory', 'Task history'), () => t('taskHistory.cmd.hint', 'Finished tasks with their time, tokens and estimated cost'), show),
    row('activity', () => t('app.cmd.activity', 'Activity of the agents'), () => t('app.cmd.activityHint', 'Messages, approvals, limits and working time'), open),
    row('notes', () => t('app.cmd.notes', 'Project notes'), () => t('app.cmd.notesHint', 'Read or edit the notes the agents of this workspace share'), open),
    row('conversations', () => t('conversations.title', 'Conversations'), () => t('conversations.cmd.hint', 'What the agents of a team said to each other and to you'), show),
    row('liveShare', () => t('liveShare.toolbar.label', 'Live Share'), () => t('settings.tools.liveShareHint', "Let others watch the projects you share, live, or join someone else's with an invite code."), open),
    // Live Share's own settings live in its dialog (kept by main, per share).
    row('liveShareSettings', () => t('settings.tools.liveShareSettings', 'Live Share settings'), () => t('settings.tools.liveShareSettingsHint', 'What guests see, finding you again after a restart (ntfy.sh), and the agents guests may use.'), open)
  ],
  terminal: [
    row('floating', () => t('app.toolbar.floating', 'Floating terminal'), () => t('app.cmd.floatingHint', "A terminal over the workspace, in the project's folder; it keeps running when hidden"), show),
    row('ports', () => t('statusBar.ports.name', 'Ports'), () => t('settings.tools.portsHint', 'The ports the programs of your terminals listen on, by workspace: open, copy or stop them (status bar).'), show)
  ],
  editor: [
    row('files', () => t('settings.tools.explorer', 'File explorer'), () => t('settings.tools.explorerHint', "The project's files, with their git status (Ctrl+Shift+X)."), show)
  ],
  browser: [
    row('browser', () => t('settings.tools.browser', 'New browser pane'), () => t('settings.tools.browserHint', 'A web page in a pane; its toolbar has the design mode, to point at an element and send it to an agent.'), open)
  ],
  git: [
    row('changes', () => t('settings.tools.scm', 'Source Control'), () => t('app.cmd.scmHint', 'Stage, commit, push; review diffs and send notes to an agent'), show),
    row('cleanupWorktrees', () => t('settings.tools.cleanup', 'Clean up worktrees'), () => t('app.cmd.cleanupWorktreesHint', "Remove this project's merged or inactive worktrees, with their git state"), open),
    row('github', () => t('app.cmd.github', 'GitHub issues and pull requests'), () => t('app.cmd.githubHint', 'Browse, create, check and start a task from GitHub'), open),
    row('linear', () => t('app.cmd.linear', 'Linear issues'), () => t('app.cmd.linearHint', 'Assigned issues, teams, states and new agent tasks'), open)
  ],
  general: [
    row('help', () => t('app.cmd.help', 'Keyboard shortcuts and help'), () => t('settings.tools.helpHint', 'Every shortcut of Tessel (F1).'), open),
    row('logs', () => t('app.cmd.openLogs', 'Open the logs folder'), () => t('settings.tools.logsHint', "Tessel's log files, to look into a problem."), open),
    row('diagnostics', () => t('app.cmd.copyDiagnostics', 'Copy diagnostics'), () => t('settings.tools.diagnosticsHint', 'Versions and the recent log, to paste into a bug report.'), copy),
    row('resources', () => t('statusBar.resources.title', 'Resource Manager'), () => t('settings.tools.resourcesHint', "Memory and CPU of Tessel and of each workspace's terminals (status bar)."), show)
  ]
}

export const SETTINGS_TOOL_IDS = Object.values(SETTINGS_TOOLS).flatMap((rows) => rows.map((r) => r.id))

// Runs the action of a row: `actions` maps each id to a function (App.vue's).
export function runSettingsTool(id, actions) {
  const action = actions && Object.prototype.hasOwnProperty.call(actions, id) ? actions[id] : null
  if (typeof action !== 'function') return false
  action()
  return true
}
