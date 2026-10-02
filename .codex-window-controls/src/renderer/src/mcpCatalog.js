// Popular MCP servers for the catalog. Every package and URL here was checked
// to exist. `inputs` are asked for before adding; `{key}` placeholders in the
// command, URL or header are replaced with the answers.
//   input.kind: 'folder' (with Browse), 'secret' (masked), 'text'
//   input.as:   'arg' (in the command), 'env' (environment variable),
//               'header' (HTTP header for Claude Code)
// `requires` names a command that must be installed (see Tools).
// `auth: 'oauth'` means the server asks you to sign in on first use.

export const MCP_CATEGORIES = ['All', 'Browser', 'Docs', 'Code', 'Data', 'Services', 'Utility']

export const MCP_CATALOG = [
  {
    id: 'playwright',
    name: 'Playwright',
    category: 'Browser',
    accent: '#2ead33',
    desc: 'Lets agents open web pages, click, type and take screenshots in a real browser.',
    transport: 'stdio',
    command: 'npx -y @playwright/mcp@latest',
    requires: 'node'
  },
  {
    id: 'chrome-devtools',
    name: 'Chrome DevTools',
    category: 'Browser',
    accent: '#4285f4',
    desc: 'Debug a live Chrome: console, network, performance traces.',
    transport: 'stdio',
    command: 'npx -y chrome-devtools-mcp@latest',
    requires: 'node'
  },
  {
    id: 'context7',
    name: 'Context7',
    category: 'Docs',
    accent: '#10b981',
    desc: 'Up-to-date documentation and code examples for thousands of libraries.',
    transport: 'http',
    url: 'https://mcp.context7.com/mcp'
  },
  {
    id: 'deepwiki',
    name: 'DeepWiki',
    category: 'Docs',
    accent: '#3b82f6',
    desc: 'Ask questions about any public GitHub repository and read its generated docs.',
    transport: 'http',
    url: 'https://mcp.deepwiki.com/mcp'
  },
  {
    id: 'cloudflare-docs',
    name: 'Cloudflare Docs',
    category: 'Docs',
    accent: '#f38020',
    desc: 'Search Cloudflare developer documentation.',
    transport: 'http',
    url: 'https://docs.mcp.cloudflare.com/mcp'
  },
  {
    id: 'huggingface',
    name: 'Hugging Face',
    category: 'Docs',
    accent: '#ffd21e',
    desc: 'Search models, datasets, papers and Spaces on Hugging Face.',
    transport: 'http',
    url: 'https://huggingface.co/mcp'
  },
  {
    id: 'github',
    name: 'GitHub',
    category: 'Code',
    accent: '#e6edf3',
    desc: 'Issues, pull requests, code search and Actions on GitHub.',
    transport: 'http',
    url: 'https://api.githubcopilot.com/mcp/',
    headers: 'Authorization: Bearer {token}',
    bearerEnvVar: 'GITHUB_PERSONAL_ACCESS_TOKEN',
    inputs: [
      {
        key: 'token',
        label: 'Personal access token',
        kind: 'secret',
        as: 'header',
        help: 'Create one at github.com/settings/tokens. Codex reads it from the GITHUB_PERSONAL_ACCESS_TOKEN environment variable.'
      }
    ]
  },
  {
    id: 'git',
    name: 'Git',
    category: 'Code',
    accent: '#f05032',
    desc: 'Read history, diffs and branches of a local repository.',
    transport: 'stdio',
    command: 'uvx mcp-server-git --repository "{folder}"',
    requires: 'uvx',
    inputs: [{ key: 'folder', label: 'Repository folder', kind: 'folder', as: 'arg' }]
  },
  {
    id: 'filesystem',
    name: 'Filesystem',
    category: 'Utility',
    accent: '#8a93a6',
    desc: 'Read and write files inside one folder you choose.',
    transport: 'stdio',
    command: 'npx -y @modelcontextprotocol/server-filesystem "{folder}"',
    requires: 'node',
    inputs: [{ key: 'folder', label: 'Allowed folder', kind: 'folder', as: 'arg' }]
  },
  {
    id: 'memory',
    name: 'Memory',
    category: 'Utility',
    accent: '#a78bfa',
    desc: 'A small knowledge graph the agent can remember facts in across sessions.',
    transport: 'stdio',
    command: 'npx -y @modelcontextprotocol/server-memory',
    requires: 'node'
  },
  {
    id: 'sequential-thinking',
    name: 'Sequential Thinking',
    category: 'Utility',
    accent: '#f472b6',
    desc: 'Helps the agent break hard problems into steps.',
    transport: 'stdio',
    command: 'npx -y @modelcontextprotocol/server-sequential-thinking',
    requires: 'node'
  },
  {
    id: 'fetch',
    name: 'Fetch',
    category: 'Utility',
    accent: '#22d3ee',
    desc: 'Fetch a web page and turn it into clean text for the agent.',
    transport: 'stdio',
    command: 'uvx mcp-server-fetch',
    requires: 'uvx'
  },
  {
    id: 'time',
    name: 'Time',
    category: 'Utility',
    accent: '#94a3b8',
    desc: 'Current time and time-zone conversions.',
    transport: 'stdio',
    command: 'uvx mcp-server-time',
    requires: 'uvx'
  },
  {
    id: 'brave-search',
    name: 'Brave Search',
    category: 'Data',
    accent: '#fb542b',
    desc: 'Web and local search through the Brave Search API.',
    transport: 'stdio',
    command: 'npx -y @brave/brave-search-mcp-server',
    requires: 'node',
    inputs: [{ key: 'BRAVE_API_KEY', label: 'Brave API key', kind: 'secret', as: 'env' }]
  },
  {
    id: 'firecrawl',
    name: 'Firecrawl',
    category: 'Data',
    accent: '#ff6b00',
    desc: 'Crawl and scrape websites into clean data.',
    transport: 'stdio',
    command: 'npx -y firecrawl-mcp',
    requires: 'node',
    inputs: [{ key: 'FIRECRAWL_API_KEY', label: 'Firecrawl API key', kind: 'secret', as: 'env' }]
  },
  {
    id: 'supabase',
    name: 'Supabase',
    category: 'Data',
    accent: '#3ecf8e',
    desc: 'Manage Supabase projects, tables and queries.',
    transport: 'stdio',
    command: 'npx -y @supabase/mcp-server-supabase@latest',
    requires: 'node',
    inputs: [
      { key: 'SUPABASE_ACCESS_TOKEN', label: 'Supabase access token', kind: 'secret', as: 'env' }
    ]
  },
  {
    id: 'sentry',
    name: 'Sentry',
    category: 'Services',
    accent: '#8d5bd6',
    desc: 'Look up errors, issues and releases in Sentry.',
    transport: 'http',
    url: 'https://mcp.sentry.dev/mcp',
    auth: 'oauth'
  },
  {
    id: 'notion',
    name: 'Notion',
    category: 'Services',
    accent: '#e6e6e6',
    desc: 'Search and edit pages and databases in your Notion workspace.',
    transport: 'http',
    url: 'https://mcp.notion.com/mcp',
    auth: 'oauth'
  },
  {
    id: 'linear',
    name: 'Linear',
    category: 'Services',
    accent: '#5e6ad2',
    desc: 'Create and update Linear issues and projects.',
    transport: 'http',
    url: 'https://mcp.linear.app/mcp',
    auth: 'oauth'
  },
  {
    id: 'atlassian',
    name: 'Atlassian',
    category: 'Services',
    accent: '#2684ff',
    desc: 'Jira issues and Confluence pages.',
    transport: 'http',
    url: 'https://mcp.atlassian.com/v1/mcp',
    auth: 'oauth'
  },
  {
    id: 'stripe',
    name: 'Stripe',
    category: 'Services',
    accent: '#635bff',
    desc: 'Customers, payments and docs from your Stripe account.',
    transport: 'http',
    url: 'https://mcp.stripe.com',
    auth: 'oauth'
  },
  {
    id: 'vercel',
    name: 'Vercel',
    category: 'Services',
    accent: '#e6e6e6',
    desc: 'Projects, deployments and logs on Vercel.',
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
