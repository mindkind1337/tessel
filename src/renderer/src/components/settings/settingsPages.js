// Settings: its pages and the sidebar's groups (SettingsDialog.vue shows
// them; each page is a Settings<Page>.vue beside this file).
import { Cable, Wrench } from 'lucide-vue-next'
import { t } from '../../i18n'

// The pages, grouped as in the sidebar. `icon` is a 16x16 stroke path.
// Titles are getters: read where they are shown, in the interface's language.
export const PAGES = {
  stats: {
    get title() {
      return t('settings.pages.stats.title', 'Stats & Usage')
    },
    get desc() {
      return t('settings.pages.stats.desc', 'The Usage menu, Tessel stats and local agent token analytics.')
    }
  },
  agents: {
    get title() {
      return t('settings.pages.agents.title', 'Agents')
    },
    get desc() {
      return t('settings.pages.agents.desc', 'Which agents Tessel offers, how they start and what they may do.')
    },
    icon: 'M5 5h6a2 2 0 012 2v4a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2zM8 2v3M6 9h.01M10 9h.01'
  },
  accounts: {
    get title() {
      return t('settings.pages.accounts.title', 'AI provider accounts')
    },
    get desc() {
      return t('settings.pages.accounts.desc', 'Your sign-ins and usage keys for each AI provider. Keys and cookies stay encrypted on this computer.')
    },
    icon: 'M8 8a2.75 2.75 0 100-5.5A2.75 2.75 0 008 8zM2.75 13.5c.7-2.3 2.8-3.75 5.25-3.75s4.55 1.45 5.25 3.75'
  },
  // The Skills and MCP servers windows, shown in the page (SkillsDialog.vue
  // and McpDialog.vue, embedded).
  skills: {
    get title() {
      return t('settings.pages.skills.title', 'Skills')
    },
    get desc() {
      return t('settings.pages.skills.desc', 'See, add, update and remove the skills of your agents.')
    },
    icon: 'M8 4.5C6.8 3.6 5 3 2.5 3v9.5c2.5 0 4.3.6 5.5 1.5 1.2-.9 3-1.5 5.5-1.5V3C11 3 9.2 3.6 8 4.5zM8 4.5V14'
  },
  mcp: {
    get title() {
      return t('settings.pages.mcp.title', 'MCP servers')
    },
    get desc() {
      return t('settings.pages.mcp.desc', 'Give your agents extra tools: install, turn on or off and connect MCP servers.')
    },
    icon: 'M6 2v3M10 2v3M4.5 5h7v2.5a3.5 3.5 0 01-7 0zM8 11v3'
  },
  // Your accounts for the agents: one Connect per service (SettingsConnections.vue).
  connections: {
    get title() {
      return t('settings.pages.connections.title', 'Connections')
    },
    get desc() {
      return t('settings.pages.connections.desc', 'Connect Gmail, Outlook, Dropbox and other accounts once, for all your agents.')
    },
    icon: 'M6.5 9.5l3-3M7 4.5l1-1a2.5 2.5 0 013.5 3.5l-1 1M9 11.5l-1 1A2.5 2.5 0 014.5 9l1-1'
  },
  // What each agent loads into its context, in tokens (SettingsContext.vue).
  context: {
    get title() {
      return t('settings.pages.context.title', 'Context')
    },
    get desc() {
      return t('settings.pages.context.desc', 'What each agent loads before you type anything, what it costs in tokens, and what you can turn off.')
    },
    icon: 'M2.5 3.5h11v3h-11zM2.5 8h7M2.5 11h9M2.5 14h5'
  },
  orchestration: {
    get title() {
      return t('settings.pages.orchestration.title', 'Orchestration')
    },
    get desc() {
      return t('settings.pages.orchestration.desc', 'Agents working as a team, followed on the task board.')
    },
    icon: 'M4 5.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3zM12 5.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3zM8 13.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3zM5 5l2.2 5M11 5l-2.2 5M5.5 4h5'
  },
  voice: {
    get title() {
      return t('settings.pages.voice.title', 'Voice typing')
    },
    get desc() {
      return t('settings.pages.voice.desc', 'Dictate into any pane with Windows voice typing.')
    },
    icon: 'M8 2a2 2 0 00-2 2v4a2 2 0 004 0V4a2 2 0 00-2-2zM4 8a4 4 0 008 0M8 12v2'
  },
  general: {
    get title() {
      return t('settings.pages.general.title', 'General')
    },
    get desc() {
      return t('settings.pages.general.desc', 'How Tessel starts and closes.')
    },
    icon: 'M3 4.5h10M3 8h10M3 11.5h10M6 3v3M10 6.5v3M5 10v3'
  },
  appearance: {
    get title() {
      return t('settings.pages.appearance.title', 'Appearance')
    },
    get desc() {
      return t('settings.pages.appearance.desc', 'The language, theme and size of the app, the panes, the left sidebar and the status bar.')
    },
    icon: 'M8 2a6 6 0 100 12A6 6 0 008 2zM8 2v12'
  },
  terminal: {
    get title() {
      return t('settings.pages.terminal.title', 'Terminal')
    },
    get desc() {
      return t('settings.pages.terminal.desc', 'Shell, font and cursor, drawing, copy and paste, mouse.')
    },
    icon: 'M2.5 3.5h11v9h-11zM5 6.5l2 1.5-2 1.5M8.5 10H11'
  },
  editor: {
    get title() {
      return t('settings.pages.editor.title', 'Editor')
    },
    get desc() {
      return t('settings.pages.editor.desc', 'The code editor in Tessel panes, its diffs, and the Files panel.')
    },
    icon: 'M5 4L1.5 8 5 12M11 4l3.5 4-3.5 4M9.5 2.5l-3 11'
  },
  alerts: {
    get title() {
      return t('settings.pages.alerts.title', 'Notifications')
    },
    get desc() {
      return t('settings.pages.alerts.desc', 'Native desktop notifications for agent and terminal events.')
    },
    icon: 'M4 11V7a4 4 0 018 0v4l1 1.5H3zM6.5 14a1.5 1.5 0 003 0'
  },
  browser: {
    get title() {
      return t('settings.pages.browser.title', 'Browser')
    },
    get desc() {
      return t('settings.pages.browser.desc', 'The built-in browser: importing your sign-ins and the session agents use.')
    },
    icon: 'M8 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM1.5 8h13M8 1.5c1.8 1.7 2.8 4 2.8 6.5S9.8 12.8 8 14.5M8 1.5C6.2 3.2 5.2 5.5 5.2 8s1 4.8 2.8 6.5'
  },
  git: {
    get title() {
      return t('settings.pages.git.title', 'Git & Source Control')
    },
    get desc() {
      return t('settings.pages.git.desc', 'Branch naming and Source Control.')
    },
    icon: 'M5 3v7M5 10a2 2 0 100 4 2 2 0 000-4zM11 3a2 2 0 100 4 2 2 0 000-4zM11 7c0 2.5-2 3-6 3'
  },
  // The developer tools agents use (Git, Node.js, …), found or installed
  // with winget: SettingsDevtools.vue (once the Install tools window).
  devtools: {
    get title() {
      return t('settings.pages.devtools.title', 'Developer tools')
    },
    get desc() {
      return t('settings.pages.devtools.desc', 'Git, Node.js and the other tools agents use: install them and finish their setup.')
    },
    lucide: Wrench
  },
  // Scheduled automations (Orca's Automations page): AutomationsPage.vue.
  automations: {
    get title() {
      return t('settings.pages.automations.title', 'Automations')
    },
    get desc() {
      return t('settings.pages.automations.desc', 'Run an agent task on a schedule, while Tessel is open.')
    },
    icon: 'M8 2a6 6 0 100 12A6 6 0 008 2zM8 4.5V8l2.5 1.5'
  },
  'quick-commands': {
    get title() {
      return t('settings.pages.quickCommands.title', 'Quick commands')
    },
    get desc() {
      return t('settings.pages.quickCommands.desc', 'Text you send to the active pane from the command palette.')
    },
    icon: 'M9 1.5L3.5 9H8l-1 5.5L12.5 7H8z'
  },
  // The optional account on tesselcode.com (SettingsTesselAccount.vue). Its id
  // is apart from 'accounts', which are the sign-ins of the AI providers.
  'tessel-account': {
    get title() {
      return t('settings.pages.tessel-account.title', 'Tessel account')
    },
    get desc() {
      return t('settings.pages.tessel-account.desc', 'Your optional account: sign in, sign out or delete it.')
    },
    icon: 'M8 8a2.75 2.75 0 100-5.5A2.75 2.75 0 008 8zM2.75 13.5c.7-2.3 2.8-3.75 5.25-3.75s4.55 1.45 5.25 3.75'
  },
  // About & updates (its id stays 'updates': openSettings('updates')).
  updates: {
    get title() {
      return t('settings.pages.updates.title', 'About & updates')
    },
    get desc() {
      return t('settings.pages.updates.desc', 'Tessel\'s version and updates, help when something goes wrong, and the licenses.')
    },
    icon: 'M13 8a5 5 0 11-1.5-3.55M13 2.5V5h-2.5'
  },
  // Remote Hosts > SSH Hosts (Orca's SshPane; components/remote/).
  ssh: {
    get title() {
      return t('remote.page.title', 'SSH Hosts')
    },
    get desc() {
      return t('remote.page.desc', 'Use existing machines over SSH for files, terminals, Git, and workspaces.')
    },
    lucide: Cable
  }
}

// The sidebar: what the AI does, the workspace it works in, the workflows
// around it, what it used, and Tessel itself.
export const GROUPS = [
  {
    id: 'ai',
    get title() {
      return t('settings.groups.ai', 'AI')
    },
    pages: ['agents', 'accounts', 'skills', 'mcp', 'connections', 'context', 'orchestration']
  },
  {
    id: 'workspace',
    get title() {
      return t('settings.groups.workspace', 'Workspace')
    },
    pages: ['tessel-account', 'general', 'appearance', 'terminal', 'editor', 'browser', 'alerts', 'voice']
  },
  {
    id: 'workflows',
    get title() {
      return t('settings.groups.workflows', 'Workflows')
    },
    pages: ['git', 'devtools', 'automations', 'quick-commands', 'ssh']
  },
  {
    id: 'insights',
    get title() {
      return t('settings.groups.insights', 'Insights')
    },
    pages: ['stats']
  },
  {
    id: 'about',
    get title() {
      return t('settings.groups.about', 'About')
    },
    pages: ['updates']
  }
]
// Pages that moved: their old id still opens where they are now (Settings >
// Text is Terminal's Font group), from a link or the page remembered, and the
// search finds that group by the old page's title (in the interface's
// language or in English) or by its English names.
export const PAGE_ALIASES = {
  text: {
    page: 'terminal',
    anchor: 'set-terminal-font',
    get title() {
      return t('settings.pages.text.title', 'Text')
    },
    namesEn: ['Text', 'Font'] // i18n-ignore
  }
}
// The pages' English titles, so a search in English finds them in any language.
export const PAGE_TITLES_EN = {
  stats: 'Stats & Usage', // i18n-ignore
  agents: 'Agents', // i18n-ignore
  accounts: 'AI provider accounts', // i18n-ignore
  skills: 'Skills', // i18n-ignore
  mcp: 'MCP servers', // i18n-ignore
  connections: 'Connections', // i18n-ignore
  'tessel-account': 'Tessel account', // i18n-ignore
  context: 'Context', // i18n-ignore
  orchestration: 'Orchestration', // i18n-ignore
  voice: 'Voice typing', // i18n-ignore
  general: 'General', // i18n-ignore
  appearance: 'Appearance', // i18n-ignore
  terminal: 'Terminal', // i18n-ignore
  editor: 'Editor', // i18n-ignore
  browser: 'Browser', // i18n-ignore
  alerts: 'Notifications', // i18n-ignore
  git: 'Git & Source Control', // i18n-ignore
  devtools: 'Developer tools', // i18n-ignore
  automations: 'Automations', // i18n-ignore
  'quick-commands': 'Quick commands', // i18n-ignore
  updates: 'About & updates', // i18n-ignore
  ssh: 'SSH Hosts', // i18n-ignore
}
