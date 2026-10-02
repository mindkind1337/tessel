// Developer tools the Tools dialog can detect and install. `bin` is the command
// looked up on PATH; `install` runs in a new pane (winget ships with Windows).
// `actions` are extra one-click commands once the tool is installed.
const winget = (id) =>
  `winget install --id ${id} --exact --source winget --accept-package-agreements --accept-source-agreements`

export const DEV_TOOLS = [
  {
    id: 'git',
    name: 'Git',
    bin: 'git',
    desc: 'Version control. Needed for separate agent copies and code review.',
    accent: '#f05032',
    install: winget('Git.Git'),
    actions: [
      {
        label: 'Set name & email',
        doneLabel: 'Change',
        shell: 'powershell',
        command:
          "git config --global user.name (Read-Host 'Your name'); git config --global user.email (Read-Host 'Your email')"
      }
    ]
  },
  {
    id: 'gh',
    name: 'GitHub CLI',
    bin: 'gh',
    desc: 'Sign in to GitHub, open pull requests and issues from the terminal.',
    accent: '#e6edf3',
    install: winget('GitHub.cli'),
    actions: [{ label: 'Sign in to GitHub', doneLabel: 'Switch account', command: 'gh auth login' }]
  },
  {
    id: 'node',
    name: 'Node.js (LTS)',
    bin: 'node',
    desc: 'Runs npm and npx. Needed by most agents and MCP servers.',
    accent: '#5fa04e',
    install: winget('OpenJS.NodeJS.LTS')
  },
  {
    id: 'python',
    name: 'Python 3.12',
    bin: 'python',
    desc: 'Needed by Aider and Python-based MCP servers.',
    accent: '#3776ab',
    install: winget('Python.Python.3.12')
  },
  {
    id: 'uv',
    name: 'uv',
    bin: 'uv',
    desc: 'Fast Python package manager. Provides uvx for Python MCP servers.',
    accent: '#de5fe9',
    install: winget('astral-sh.uv')
  },
  {
    id: 'rg',
    name: 'ripgrep',
    bin: 'rg',
    desc: 'Very fast code search that coding agents use when available.',
    accent: '#c7a26b',
    install: winget('BurntSushi.ripgrep.MSVC')
  },
  {
    id: 'pwsh',
    name: 'PowerShell 7',
    bin: 'pwsh',
    desc: 'The modern PowerShell. Appears as a shell choice once installed.',
    accent: '#5391fe',
    install: winget('Microsoft.PowerShell')
  },
  {
    id: 'code',
    name: 'Visual Studio Code',
    bin: 'code',
    desc: 'Code editor, handy for reviewing what agents changed.',
    accent: '#23a9f2',
    install: winget('Microsoft.VisualStudioCode')
  },
  {
    id: 'docker',
    name: 'Docker Desktop',
    bin: 'docker',
    desc: 'Containers. Some MCP servers and projects run in Docker.',
    accent: '#1d63ed',
    install: winget('Docker.DockerDesktop')
  },
  {
    id: 'bun',
    name: 'Bun',
    bin: 'bun',
    desc: 'Fast JavaScript runtime and package manager.',
    accent: '#f9f1e1',
    install: winget('Oven-sh.Bun')
  },
  {
    id: 'jq',
    name: 'jq',
    bin: 'jq',
    desc: 'Command-line JSON processor, often used in scripts.',
    accent: '#8a93a6',
    install: winget('jqlang.jq')
  }
]
