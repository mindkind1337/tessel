// Popular MCP servers for the catalog. Every package and URL here was checked
// to exist. `inputs` are asked for before adding; `{key}` placeholders in the
// command, URL or header are replaced with the answers.
//   input.kind: 'folder' (with Browse), 'secret' (masked), 'text'
//   input.as:   'arg' (in the command), 'env' (environment variable),
//               'header' (HTTP header for Claude Code)
// `requires` names a command that must be installed (see Tools).
// `auth: 'oauth'` means the server asks you to sign in on first use.
// Descriptions, labels and help are getters, so they read in the current
// language when shown.
import { t } from './i18n'

export const MCP_CATEGORIES = ['All', 'Browser', 'Docs', 'Code', 'Data', 'Services', 'Utility']

// The category's name in the interface's language (the value stays English).
export function categoryLabel(category) {
  const labels = {
    All: () => t('mcp.category.all', 'All'),
    Browser: () => t('mcp.category.browser', 'Browser'),
    Docs: () => t('mcp.category.docs', 'Docs'),
    Code: () => t('mcp.category.code', 'Code'),
    Data: () => t('mcp.category.data', 'Data'),
    Services: () => t('mcp.category.services', 'Services'),
    Utility: () => t('mcp.category.utility', 'Utility')
  }
  return labels[category] ? labels[category]() : category
}

export const MCP_CATALOG = [
  {
    id: 'playwright',
    name: 'Playwright', // i18n-ignore
    category: 'Browser',
    accent: '#2ead33',
    get desc() {
      return t('mcp.catalog.playwright.desc', 'Lets agents open web pages, click, type and take screenshots in a real browser.')
    },
    transport: 'stdio',
    command: 'npx -y @playwright/mcp@latest',
    requires: 'node'
  },
  {
    id: 'chrome-devtools',
    name: 'Chrome DevTools', // i18n-ignore
    category: 'Browser',
    accent: '#4285f4',
    get desc() {
      return t('mcp.catalog.chrome-devtools.desc', 'Debug a live Chrome: console, network, performance traces.')
    },
    transport: 'stdio',
    command: 'npx -y chrome-devtools-mcp@latest',
    requires: 'node'
  },
  {
    id: 'context7',
    name: 'Context7', // i18n-ignore
    category: 'Docs',
    accent: '#10b981',
    get desc() {
      return t('mcp.catalog.context7.desc', 'Up-to-date documentation and code examples for thousands of libraries.')
    },
    transport: 'http',
    url: 'https://mcp.context7.com/mcp'
  },
  {
    id: 'deepwiki',
    name: 'DeepWiki', // i18n-ignore
    category: 'Docs',
    accent: '#3b82f6',
    get desc() {
      return t('mcp.catalog.deepwiki.desc', 'Ask questions about any public GitHub repository and read its generated docs.')
    },
    transport: 'http',
    url: 'https://mcp.deepwiki.com/mcp'
  },
  {
    id: 'cloudflare-docs',
    name: 'Cloudflare Docs', // i18n-ignore
    category: 'Docs',
    accent: '#f38020',
    get desc() {
      return t('mcp.catalog.cloudflare-docs.desc', 'Search Cloudflare developer documentation.')
    },
    transport: 'http',
    url: 'https://docs.mcp.cloudflare.com/mcp'
  },
  {
    id: 'huggingface',
    name: 'Hugging Face', // i18n-ignore
    category: 'Docs',
    accent: '#ffd21e',
    get desc() {
      return t('mcp.catalog.huggingface.desc', 'Search models, datasets, papers and Spaces on Hugging Face.')
    },
    transport: 'http',
    url: 'https://huggingface.co/mcp'
  },
  {
    id: 'github',
    name: 'GitHub', // i18n-ignore
    category: 'Code',
    accent: '#e6edf3',
    get desc() {
      return t('mcp.catalog.github.desc', 'Issues, pull requests, code search and Actions on GitHub.')
    },
    transport: 'http',
    url: 'https://api.githubcopilot.com/mcp/',
    headers: 'Authorization: Bearer {token}', // i18n-ignore
    bearerEnvVar: 'GITHUB_PERSONAL_ACCESS_TOKEN',
    inputs: [
      {
        key: 'token',
        get label() {
          return t('mcp.catalog.github.token', 'Personal access token')
        },
        kind: 'secret',
        as: 'header',
        get help() {
          return t('mcp.catalog.github.tokenHelp', 'Create one at github.com/settings/tokens. Codex reads it from the GITHUB_PERSONAL_ACCESS_TOKEN environment variable.')
        }
      }
    ]
  },
  {
    id: 'git',
    name: 'Git', // i18n-ignore
    category: 'Code',
    accent: '#f05032',
    get desc() {
      return t('mcp.catalog.git.desc', 'Read history, diffs and branches of a local repository.')
    },
    transport: 'stdio',
    command: 'uvx mcp-server-git --repository "{folder}"',
    requires: 'uvx',
    inputs: [
      {
        key: 'folder',
        get label() {
          return t('mcp.catalog.git.folder', 'Repository folder')
        },
        kind: 'folder',
        as: 'arg'
      }
    ]
  },
  {
    id: 'filesystem',
    name: 'Filesystem', // i18n-ignore
    category: 'Utility',
    accent: '#8a93a6',
    get desc() {
      return t('mcp.catalog.filesystem.desc', 'Read and write files inside one folder you choose.')
    },
    transport: 'stdio',
    command: 'npx -y @modelcontextprotocol/server-filesystem "{folder}"',
    requires: 'node',
    inputs: [
      {
        key: 'folder',
        get label() {
          return t('mcp.catalog.filesystem.folder', 'Allowed folder')
        },
        kind: 'folder',
        as: 'arg'
      }
    ]
  },
  {
    id: 'memory',
    name: 'Memory', // i18n-ignore
    category: 'Utility',
    accent: '#a78bfa',
    get desc() {
      return t('mcp.catalog.memory.desc', 'A small knowledge graph the agent can remember facts in across sessions.')
    },
    transport: 'stdio',
    command: 'npx -y @modelcontextprotocol/server-memory',
    requires: 'node'
  },
  {
    id: 'sequential-thinking',
    name: 'Sequential Thinking', // i18n-ignore
    category: 'Utility',
    accent: '#f472b6',
    get desc() {
      return t('mcp.catalog.sequential-thinking.desc', 'Helps the agent break hard problems into steps.')
    },
    transport: 'stdio',
    command: 'npx -y @modelcontextprotocol/server-sequential-thinking',
    requires: 'node'
  },
  {
    id: 'fetch',
    name: 'Fetch', // i18n-ignore
    category: 'Utility',
    accent: '#22d3ee',
    get desc() {
      return t('mcp.catalog.fetch.desc', 'Fetch a web page and turn it into clean text for the agent.')
    },
    transport: 'stdio',
    command: 'uvx mcp-server-fetch',
    requires: 'uvx'
  },
  {
    id: 'time',
    name: 'Time', // i18n-ignore
    category: 'Utility',
    accent: '#94a3b8',
    get desc() {
      return t('mcp.catalog.time.desc', 'Current time and time-zone conversions.')
    },
    transport: 'stdio',
    command: 'uvx mcp-server-time',
    requires: 'uvx'
  },
  {
    id: 'brave-search',
    name: 'Brave Search', // i18n-ignore
    category: 'Data',
    accent: '#fb542b',
    get desc() {
      return t('mcp.catalog.brave-search.desc', 'Web and local search through the Brave Search API.')
    },
    transport: 'stdio',
    command: 'npx -y @brave/brave-search-mcp-server',
    requires: 'node',
    inputs: [
      {
        key: 'BRAVE_API_KEY',
        get label() {
          return t('mcp.catalog.brave-search.apiKey', 'Brave API key')
        },
        kind: 'secret',
        as: 'env'
      }
    ]
  },
  {
    id: 'firecrawl',
    name: 'Firecrawl', // i18n-ignore
    category: 'Data',
    accent: '#ff6b00',
    get desc() {
      return t('mcp.catalog.firecrawl.desc', 'Crawl and scrape websites into clean data.')
    },
    transport: 'stdio',
    command: 'npx -y firecrawl-mcp',
    requires: 'node',
    inputs: [
      {
        key: 'FIRECRAWL_API_KEY',
        get label() {
          return t('mcp.catalog.firecrawl.apiKey', 'Firecrawl API key')
        },
        kind: 'secret',
        as: 'env'
      }
    ]
  },
  {
    id: 'elevenlabs',
    name: 'ElevenLabs', // i18n-ignore
    category: 'Services',
    accent: '#8b5cf6',
    get desc() {
      return t('mcp.catalog.elevenlabs.desc', 'Text to speech, voice cloning, transcription and sound effects. Uses your ElevenLabs credits.')
    },
    transport: 'stdio',
    command: 'uvx elevenlabs-mcp',
    requires: 'uvx',
    inputs: [
      {
        key: 'ELEVENLABS_API_KEY',
        get label() {
          return t('mcp.catalog.elevenlabs.apiKey', 'ElevenLabs API key')
        },
        kind: 'secret',
        as: 'env',
        get help() {
          return t('mcp.catalog.elevenlabs.apiKeyHelp', 'Create one at elevenlabs.io/app/settings/api-keys. Audio files are saved to your Desktop.')
        }
      }
    ]
  },
  {
    id: 'supabase',
    name: 'Supabase', // i18n-ignore
    category: 'Data',
    accent: '#3ecf8e',
    get desc() {
      return t('mcp.catalog.supabase.desc', 'Manage Supabase projects, tables and queries.')
    },
    transport: 'stdio',
    command: 'npx -y @supabase/mcp-server-supabase@latest',
    requires: 'node',
    inputs: [
      {
        key: 'SUPABASE_ACCESS_TOKEN',
        get label() {
          return t('mcp.catalog.supabase.token', 'Supabase access token')
        },
        kind: 'secret',
        as: 'env'
      }
    ]
  },
  {
    id: 'sentry',
    name: 'Sentry', // i18n-ignore
    category: 'Services',
    accent: '#8d5bd6',
    get desc() {
      return t('mcp.catalog.sentry.desc', 'Look up errors, issues and releases in Sentry.')
    },
    transport: 'http',
    url: 'https://mcp.sentry.dev/mcp',
    auth: 'oauth'
  },
  {
    id: 'notion',
    name: 'Notion', // i18n-ignore
    category: 'Services',
    accent: '#e6e6e6',
    get desc() {
      return t('mcp.catalog.notion.desc', 'Search and edit pages and databases in your Notion workspace.')
    },
    transport: 'http',
    url: 'https://mcp.notion.com/mcp',
    auth: 'oauth'
  },
  {
    id: 'linear',
    name: 'Linear', // i18n-ignore
    category: 'Services',
    accent: '#5e6ad2',
    get desc() {
      return t('mcp.catalog.linear.desc', 'Create and update Linear issues and projects.')
    },
    transport: 'http',
    url: 'https://mcp.linear.app/mcp',
    auth: 'oauth'
  },
  {
    id: 'atlassian',
    name: 'Atlassian', // i18n-ignore
    category: 'Services',
    accent: '#2684ff',
    get desc() {
      return t('mcp.catalog.atlassian.desc', 'Jira issues and Confluence pages.')
    },
    transport: 'http',
    url: 'https://mcp.atlassian.com/v1/mcp',
    auth: 'oauth'
  },
  {
    id: 'stripe',
    name: 'Stripe', // i18n-ignore
    category: 'Services',
    accent: '#635bff',
    get desc() {
      return t('mcp.catalog.stripe.desc', 'Customers, payments and docs from your Stripe account.')
    },
    transport: 'http',
    url: 'https://mcp.stripe.com',
    auth: 'oauth'
  },
  {
    id: 'vercel',
    name: 'Vercel', // i18n-ignore
    category: 'Services',
    accent: '#e6e6e6',
    get desc() {
      return t('mcp.catalog.vercel.desc', 'Projects, deployments and logs on Vercel.')
    },
    transport: 'http',
    url: 'https://mcp.vercel.com',
    auth: 'oauth'
  }
]

// Build the add-request for one agent from a catalog entry and the answers.
export function catalogSpec(entry, answers, agent) {
  const fill = (text) => String(text || '').replace(/\{(\w+)\}/g, (_, k) => answers[k] || '')
  const spec = { agent, name: entry.id, transport: entry.transport }
  if (entry.transport === 'http') {
    spec.url = fill(entry.url)
    if (agent === 'claude' && entry.headers) spec.headers = fill(entry.headers)
    if (agent === 'codex' && entry.bearerEnvVar) spec.bearerEnvVar = entry.bearerEnvVar
  } else {
    spec.commandLine = fill(entry.command)
    spec.env = (entry.inputs || [])
      .filter((i) => i.as === 'env' && answers[i.key])
      .map((i) => `${i.key}=${answers[i.key]}`)
      .join('\n')
  }
  return spec
}
