// Claude Code on an SSH host signed in as root: it refuses its Yolo flag
// ("--dangerously-skip-permissions cannot be used with root/sudo privileges")
// and never starts. Tessel starts it in Accept edits instead, says so once in
// the pane, and never shows it as Yolo. Where root was not known before, the
// refusal in its output starts it once more without the flag.
// Run on App.vue's own code (createLeaf, agentStartLine), as missingAgentPane.spec.js does.
import { describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import vm from 'vm'
import { join } from 'path'
import { reactive } from 'vue'
import {
  claudeStartChoice,
  codexResumes,
  needsRemoteAgentCheck,
  remoteAgentLine,
  hostRunsAsRoot,
  hasClaudeYoloFlag,
  rootSafeClaudeArgs,
  rootRefusalWatcher
} from '../remoteAgentLaunch'
import { remoteAgentFound } from '../projectLauncher'
import { effectiveAgent, launchSignature, launchIsYolo, launchSessionValues, launchPermissions } from '../../../shared/agentPrefs'
import { launchPermissionMode, canCycleToYolo } from '../chat/terminalChatBridge'

const source = fs.readFileSync(join(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')
function slice(from, to) {
  const a = source.indexOf(from)
  const b = source.indexOf(to, a)
  if (a < 0 || b < 0) throw new Error(`App.vue changed: ${from}`)
  return source.slice(a, b)
}

const HOST = 'ssh-box'
const SID = '11111111-2222-4333-8444-555555555555'
const NOTE = 'Claude Code refuses Yolo as root: started in Accept edits mode. Use a non-root account on Box for Yolo.'

function load({ username = 'root', status = { hostId: HOST, claude: '/usr/local/bin/claude', codex: '/usr/local/bin/codex' }, prefs = {}, permissions = 'yolo' } = {}) {
  const listeners = []
  const later = []
  const shellApi = {
    attachPty: vi.fn(async () => ({ ok: false })),
    createPty: vi.fn(async (o) => ({ ok: true, shell: { id: 'pwsh', name: 'PowerShell' }, backend: 'ssh', pid: null, cwd: '/srv/app', remoteHost: { id: o.remoteHostId, label: 'Box' } })),
    killPty: vi.fn(),
    writePty: vi.fn(),
    remoteAgentSessionExists: vi.fn(async () => false),
    remoteAgents: { check: vi.fn(async () => status) },
    onData: vi.fn((fn) => {
      listeners.push(fn)
      return () => listeners.splice(listeners.indexOf(fn), 1)
    })
  }
  const tree = { value: null }
  const ctx = {
    t: (k, en, vars) => en.replace(/\{\{(\w+)\}\}/g, (_, n) => (vars && vars[n] != null ? vars[n] : '')),
    reactive,
    watch: () => {},
    newId: () => 'pane-new',
    newUuid: () => SID,
    seedBuffer: () => {},
    validPaneSessionOptions: () => null,
    launchSessionValues: () => null,
    modelsFor: () => null,
    effectiveAgent,
    launchSignature,
    launchIsYolo,
    launchPermissions,
    MANUAL_CLAUDE_MODES: ['acceptEdits', 'plan'],
    hostShared: () => true,
    remoteHostLabel: () => 'Box',
    remoteHostsState: { targets: [{ id: HOST, label: 'Box', host: 'box.example', username }] },
    remoteAgentName: (id) => (id === 'codex' ? 'Codex CLI' : 'Claude Code'),
    remoteAgentTools: reactive({ [HOST]: status }),
    askHostAgents: async () => status,
    validSavedFiles: () => [],
    savedOutput: {},
    readDrafts: () => ({}),
    userDraft: {},
    draftUnknown: {},
    needsRemoteAgentCheck,
    remoteAgentLine,
    remoteAgentFound,
    hostRunsAsRoot,
    hasClaudeYoloFlag,
    rootSafeClaudeArgs,
    rootRefusalWatcher,
    claudeStartChoice,
    codexResumes,
    sessionKind: (a) => a && a.id,
    quoteGlobArgs: (s) => s,
    settings: { resumeAgents: true, yoloFolders: [], agentPermissions: permissions, agentPrefs: prefs, teamWakeUps: false },
    FOUND_AFTER_START: [],
    watchFoundSession: () => {},
    teamToolsReady: false,
    teamToolsVersion: null,
    showToast: vi.fn(),
    initError: { value: '' },
    findLeaf: (id) => (tree.value && tree.value.id === id ? tree.value : null),
    // Short delays (the launch, the retry) run now; the watch's end waits.
    setTimeout: (fn, ms) => (ms && ms > 1000 ? later.push(fn) : fn()),
    Promise,
    Object,
    Number,
    window: { shellApi }
  }
  vm.createContext(ctx)
  vm.runInContext(
    slice('function serializeNode(node)', '// Rebuild a live tree') +
      slice('async function agentStartLine(', '\n// Codex, OpenCode, Cline and Copilot pick') +
      slice('async function createLeaf(shellId, agent = null', 'function replaceNode(') +
      slice("// Claude Code's Yolo as root (createLeaf)", 'async function remoteAgentCommand(') +
      slice('async function remoteAgentCommand(', '// Install agent `id` on the host') +
      '\nthis.api = { createLeaf, serializeNode }',
    ctx
  )
  const emit = (data) => [...listeners].forEach((fn) => fn({ id: 'pane-1', data }))
  const typed = () => shellApi.writePty.mock.calls.map((c) => c[1])
  const start = async (agent = claude) => {
    const leaf = await ctx.api.createLeaf('pwsh', agent, null, null, { id: 'pane-1', remoteHostId: HOST, remotePath: '/srv/app' })
    tree.value = leaf
    return leaf
  }
  return { ctx, shellApi, listeners, later, emit, typed, start }
}

const claude = { id: 'claude', name: 'Claude Code', command: 'claude' }
const codex = { id: 'codex', name: 'Codex CLI', command: 'codex' }

describe('Claude Code in Yolo on a root host', () => {
  it('starts without the Yolo flag, in Accept edits, with a one-time note; never shown as Yolo', async () => {
    const env = load()
    const leaf = await env.start()
    expect(env.typed()).toEqual([`'/usr/local/bin/claude' --session-id ${SID} --permission-mode acceptEdits\r`])
    expect(leaf.launchYolo).toBe(false)
    expect(leaf.rootNoYolo).toBe(true)
    expect(leaf.rootNoYoloNote).toBe(NOTE)
    // No IS_SANDBOX or any other bypass.
    expect(JSON.stringify(env.shellApi.createPty.mock.calls[0][0])).not.toMatch(/IS_SANDBOX/)
    // Kept with the layout.
    expect(env.ctx.api.serializeNode(leaf).rootNoYolo).toBe(true)
    // Nothing to watch for: the flag was never typed.
    expect(env.listeners).toHaveLength(0)
    // Restarted in the same pane: started the same way, the note not again.
    const again = await env.start()
    expect(env.typed()[1]).not.toContain('--dangerously-skip-permissions')
    expect(again.rootNoYolo).toBe(true)
    expect(again.rootNoYoloNote).toBeUndefined()
  })

  it('root known from the agent found in /root (VS Code\'s copy), the saved user empty', async () => {
    const env = load({ username: '', status: { hostId: HOST, claude: false, vscodeClaude: '/root/.vscode-server/extensions/anthropic.claude-code-2.1.288-linux-x64/resources/native-binary/claude' } })
    const leaf = await env.start()
    expect(env.typed()[0]).not.toContain('--dangerously-skip-permissions')
    expect(env.typed()[0]).toContain('--permission-mode acceptEdits')
    expect(leaf.launchYolo).toBe(false)
  })

  it('a permission mode of your own arguments is kept (no Accept edits added)', async () => {
    const env = load({ prefs: { claude: { args: '--permission-mode plan --dangerously-skip-permissions' } } })
    await env.start()
    expect(env.typed()[0]).toBe(`'/usr/local/bin/claude' --session-id ${SID} --permission-mode plan\r`)
  })

  it('asking first on a root host: unchanged, no note', async () => {
    const env = load({ permissions: 'manual' })
    const leaf = await env.start()
    expect(env.typed()[0]).toBe(`'/usr/local/bin/claude' --session-id ${SID}\r`)
    expect(leaf.rootNoYolo).toBeUndefined()
  })

  it('Codex on a root host keeps its own Yolo flag (it has no root check)', async () => {
    const env = load()
    const leaf = await env.start(codex)
    expect(env.typed()[0]).toContain('--dangerously-bypass-approvals-and-sandbox')
    expect(leaf.launchYolo).toBe(true)
    expect(leaf.rootNoYolo).toBeUndefined()
  })
})

describe('a non-root host', () => {
  it('Claude Code starts in Yolo as before', async () => {
    const env = load({ username: 'deploy', status: { hostId: HOST, claude: '/home/deploy/.local/bin/claude' } })
    const leaf = await env.start()
    expect(env.typed()).toEqual([`'/home/deploy/.local/bin/claude' --session-id ${SID} --dangerously-skip-permissions\r`])
    expect(leaf.launchYolo).toBe(true)
    expect(leaf.rootNoYolo).toBeUndefined()
    expect(leaf.rootNoYoloNote).toBeUndefined()
    // Its output is watched for the refusal a while, then no more.
    expect(env.listeners).toHaveLength(1)
    env.later.forEach((fn) => fn())
    expect(env.listeners).toHaveLength(0)
  })
})

describe('the safety net: the refusal seen in the output', () => {
  it('starts it once more without the flag, in Accept edits, with the note', async () => {
    // Signed in as root, but nothing told it (no saved user, the agent on PATH).
    const env = load({ username: '', status: { hostId: HOST, claude: true } })
    const leaf = await env.start()
    expect(env.typed()[0]).toBe(`claude --session-id ${SID} --dangerously-skip-permissions\r`)
    // The typed command echoed back is not the refusal.
    env.emit(`claude --session-id ${SID} --dangerously-skip-permissions\r\n`)
    expect(env.typed()).toHaveLength(1)
    // Coloured and wrapped by the terminal, in two pieces.
    env.emit('\x1b[31m--dangerously-skip-permissions cannot be used with root/su')
    env.emit('do\r\n privileges for security reasons\x1b[0m\r\nroot@38403:/var/www/html/browse# ')
    expect(env.typed()).toEqual([
      `claude --session-id ${SID} --dangerously-skip-permissions\r`,
      `claude --session-id ${SID} --permission-mode acceptEdits\r`
    ])
    expect(leaf.launchYolo).toBe(false)
    expect(leaf.rootNoYolo).toBe(true)
    expect(leaf.rootNoYoloNote).toBe(NOTE)
    // Once only.
    expect(env.listeners).toHaveLength(0)
    env.emit('--dangerously-skip-permissions cannot be used with root/sudo privileges')
    expect(env.typed()).toHaveLength(2)
  })

  it('another pane\'s output is not this one\'s', async () => {
    const env = load({ username: '', status: { hostId: HOST, claude: true } })
    await env.start()
    env.listeners[0]({ id: 'pane-2', data: '--dangerously-skip-permissions cannot be used with root/sudo privileges' })
    expect(env.typed()).toHaveLength(1)
  })
})

describe('the helpers', () => {
  it('hostRunsAsRoot', () => {
    expect(hostRunsAsRoot({ username: 'root' })).toBe(true)
    expect(hostRunsAsRoot({ username: 'deploy' })).toBe(false)
    expect(hostRunsAsRoot({ status: { uid: 0 } })).toBe(true)
    expect(hostRunsAsRoot({ status: { uid: 1000 } })).toBe(false)
    expect(hostRunsAsRoot({ command: "'/root/.local/bin/claude'" })).toBe(true)
    expect(hostRunsAsRoot({ command: "'/home/rootless/claude'" })).toBe(false)
  })
  it('rootSafeClaudeArgs', () => {
    expect(rootSafeClaudeArgs('--dangerously-skip-permissions')).toBe('--permission-mode acceptEdits')
    expect(rootSafeClaudeArgs('--model opus --dangerously-skip-permissions')).toBe('--model opus --permission-mode acceptEdits')
    expect(rootSafeClaudeArgs('--dangerously-skip-permissions', 'plan')).toBe('--permission-mode plan')
    expect(rootSafeClaudeArgs('--permission-mode default --dangerously-skip-permissions')).toBe('--permission-mode default')
    expect(hasClaudeYoloFlag('--allow-dangerously-skip-permissions')).toBe(false)
  })
  it('the chat view\'s mode: Accept edits, never Yolo', () => {
    const node = { agentId: 'claude', rootNoYolo: true, launchYolo: false, permissions: 'yolo', launchSig: JSON.stringify(['claude', '--dangerously-skip-permissions', []]) }
    expect(launchPermissionMode(node)).toBe('acceptEdits')
    expect(canCycleToYolo(node)).toBe(false)
  })
})
