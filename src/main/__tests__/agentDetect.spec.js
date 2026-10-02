// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { agentOf, agentsUnderShells } from '../agentDetect'

const win = String.raw

describe('which agent runs in a shell pane', () => {
  it('recognises the agent CLIs from their process', () => {
    expect(
      agentOf({
        name: 'claude.exe',
        cmd: win`"C:\Users\u\AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe" --resume x`
      })
    ).toBe('claude')
    expect(
      agentOf({
        name: 'node.exe',
        cmd: win`"node"   "C:\Users\u\AppData\Roaming\npm\node_modules\@openai\codex\bin\codex.js" resume 01a0`
      })
    ).toBe('codex')
    expect(
      agentOf({
        name: 'node.exe',
        cmd: win`node C:\npm\node_modules\@google\gemini-cli\dist\index.js`
      })
    ).toBe('gemini')
    expect(agentOf({ name: 'opencode.exe', cmd: 'opencode' })).toBe('opencode')
    expect(
      agentOf({ name: 'node.exe', cmd: win`node C:\npm\node_modules\@github\copilot\index.js` })
    ).toBe('copilot')
    // Cline: its node launcher, then the compiled program it starts.
    expect(
      agentOf({
        name: 'node.exe',
        cmd: win`"node" "C:\Users\u\AppData\Roaming\npm\node_modules\cline\bin\cline"`
      })
    ).toBe('cline')
    expect(
      agentOf({
        name: 'cline.exe',
        cmd: win`C:\npm\node_modules\@cline\cli-windows-x64\bin\cline.exe`
      })
    ).toBe('cline')
    expect(agentOf({ name: 'amp.exe', cmd: 'amp' })).toBe('amp')
    expect(agentOf({ name: 'aider.exe', cmd: 'aider --model x' })).toBe('aider')
  })

  it('does not mistake other programs for agents', () => {
    expect(agentOf({ name: 'node.exe', cmd: win`node C:\Tessel-claude\scripts\build.js` })).toBe(
      null
    )
    expect(
      agentOf({
        name: 'node.exe',
        cmd: win`node C:\Users\u\AppData\Roaming\tessel-team\tessel-team-mcp.cjs`
      })
    ).toBe(null)
    expect(agentOf({ name: 'powershell.exe', cmd: 'powershell -NoLogo' })).toBe(null)
    expect(agentOf({ name: 'node.exe', cmd: win`node C:\proj\scripts\incline.js` })).toBe(null)
    expect(agentOf({ name: 'git.exe', cmd: 'git commit -m "ask claude"' })).toBe(null)
  })

  it.each([
    ['cursor', 'cursor-agent'],
    ['grok', 'grok'],
    ['pi', 'pi'],
    ['droid', 'droid'],
    ['crush', 'crush'],
    ['goose', 'goose'],
    ['auggie', 'auggie']
  ])('recognises the native %s CLI without reading its prompt', (id, executable) => {
    expect(
      agentOf({ name: `${executable}.exe`, cmd: `"C:\\Tools\\${executable}.exe" "ask claude"` })
    ).toBe(id)
    expect(
      agentOf({ name: `/usr/local/bin/${executable}`, cmd: `${executable} "ask claude"` })
    ).toBe(id)
  })

  it.each([
    ['pi', win`C:\npm\node_modules\@mariozechner\pi-coding-agent\dist\cli.js`],
    ['pi', win`C:\npm\node_modules\@earendil-works\pi-coding-agent\dist\bundle\cli.js`],
    ['amp', win`C:\npm\node_modules\@sourcegraph\amp\dist\cli.js`],
    ['droid', win`C:\npm\node_modules\@factory\cli\bin\droid`],
    ['crush', win`C:\npm\node_modules\@charmland\crush\run-crush.js`],
    ['auggie', win`C:\npm\node_modules\@augmentcode\auggie\augment.mjs`]
  ])('recognises the %s package only as a runtime entrypoint', (id, script) => {
    expect(
      agentOf({
        name: 'node.exe',
        cmd: `"C:\\Program Files\\nodejs\\node.exe" "${script}" "ask grok"`
      })
    ).toBe(id)
    expect(agentOf({ name: 'bun', cmd: `bun '${script.replaceAll('\\', '/')}'` })).toBe(id)
    expect(agentOf({ name: 'git.exe', cmd: `git "${script}"` })).toBe(null)
    expect(agentOf({ name: 'node.exe', cmd: `node -e "${script}"` })).toBe(null)
    expect(agentOf({ name: 'node.exe', cmd: `node app.js "${script}"` })).toBe(null)
  })

  it.each([
    ['openclaude', 'openclaude'],
    ['antigravity', 'agy'],
    ['kilo', 'kilo'],
    ['kiro', 'kiro-cli'],
    ['continue', 'cn'],
    ['codebuff', 'codebuff'],
    ['vibe', 'vibe'],
    ['vibe', 'mistral-vibe'],
    ['rovo', 'rovo'],
    ['hermes', 'hermes'],
    ['devin', 'devin'],
    ['trae', 'traecli'],
    ['zcode', 'zcode'],
    ['zcode', 'zcode-cli'],
    ['autohand', 'autohand'],
    ['commandcode', 'command-code'],
    ['openclaw', 'openclaw'],
    ['kimi', 'kimi-code'],
    ['ante', 'ante'],
    ['omp', 'omp'],
    ['muse', 'muse'],
    ['muse', 'muse-bin-1.3.0'],
    ['opencode2', 'opencode2'],
    ['mimocode', 'mimo'],
    ['primeagent', 'prime-agent'],
    ['qoder', 'qodercli'],
    ['qoder', 'qodercli-1.1.64'],
    ['freebuff', 'freebuff'],
    ['dsh', 'dsh-tui'],
    ['dsh', 'dst'],
    ['dsh', 'dsh']
  ])('recognises %s from its command %s', (id, executable) => {
    expect(
      agentOf({ name: `${executable}.exe`, cmd: `"C:\Tools\${executable}.exe" "ask claude"` })
    ).toBe(id)
    expect(agentOf({ name: executable, cmd: `/usr/local/bin/${executable} --x` })).toBe(id)
  })

  it.each([
    ['openclaude', win`C:\npm\node_modules\@gitlawb\openclaude\bin\openclaude`],
    ['continue', win`C:\npm\node_modules\@continuedev\cli\dist\index.js`],
    ['kilo', win`C:\npm\node_modules\@kilocode\cli\bin\kilo.js`],
    ['zcode', win`C:\npm\node_modules\@zcode\cli\dist\zcode.cjs`],
    ['primeagent', win`C:\npm\node_modules\prime-agent\dist\bundle\cli.js`],
    ['openclaw', '/usr/lib/node_modules/openclaw/bin/openclaw'],
    ['qoder', win`C:\npm\node_modules\@qoder-ai\qodercli\bundle\qodercli.js`],
    ['freebuff', win`C:\npm\node_modules\freebuff\index.js`],
    ['dsh', win`C:\npm\node_modules\@deepseek-ai\dsh\lib\bin.js`],
    ['dsh', win`C:\npm\node_modules\@deepseek-harness-tui\dsh-tui\bin\dsh-tui.js`]
  ])('recognises the %s npm install as a runtime entrypoint', (id, script) => {
    expect(agentOf({ name: 'node.exe', cmd: `node "${script}" chat` })).toBe(id)
    expect(agentOf({ name: 'git.exe', cmd: `git "${script}"` })).toBe(null)
  })

  it("takes dsh's web, headless and SDK profiles, plugin and dumps for no agent pane", () => {
    const bin = win`C:\npm\node_modules\@deepseek-ai\dsh\lib\bin.js`
    expect(agentOf({ name: 'dsh.exe', cmd: 'dsh --profile dsh-tui --resume abc123' })).toBe('dsh')
    expect(agentOf({ name: 'node.exe', cmd: `node "${bin}" --profile dsh-tui` })).toBe('dsh')
    for (const cmd of ['dsh --profile web', 'dsh --profile=headless', 'dsh web', 'dsh plugin add x', 'dsh --dump-config', `node "${bin}" --profile sdk`])
      expect(agentOf({ name: 'dsh.exe', cmd })).toBe(null)
    // The launcher's argv belongs to the app: a folder named "web" is a folder.
    expect(agentOf({ name: 'dsh-tui.exe', cmd: 'dsh-tui web' })).toBe('dsh')
    expect(agentOf({ name: 'dsh.exe', cmd: 'dsh --profile dsh-tui web' })).toBe('dsh')
    // Freebuff is not Codebuff, and the Qoder IDE is not its CLI.
    expect(agentOf({ name: 'codebuff.exe', cmd: 'codebuff' })).toBe('codebuff')
    expect(agentOf({ name: 'Qoder.exe', cmd: 'Qoder.exe' })).toBe(null)
  })

  it('keeps the short command names from matching other programs', () => {
    expect(agentOf({ name: 'cmd.exe', cmd: 'cmd /c continue' })).toBe(null)
    expect(agentOf({ name: 'node.exe', cmd: win`node C:\proj\cn` })).toBe(null)
    expect(agentOf({ name: 'node.exe', cmd: win`node C:\proj\scripts\omp.js` })).toBe(null)
    expect(agentOf({ name: 'antelope.exe', cmd: 'antelope' })).toBe(null)
    expect(agentOf({ name: 'museum.exe', cmd: 'museum' })).toBe(null)
    expect(agentOf({ name: 'opencode.exe', cmd: 'opencode' })).toBe('opencode')
    expect(agentOf({ name: 'kimi.exe', cmd: 'kimi' })).toBe('kimi')
  })

  it('recognises the current native Amp distribution', () => {
    expect(
      agentOf({ name: 'amp.exe', cmd: win`"C:\npm\node_modules\@ampcode\cli\bin\amp.exe"` })
    ).toBe('amp')
    expect(agentOf({ name: 'amp.exe', cmd: win`"C:\Users\u\.amp\bin\amp.exe"` })).toBe('amp')
  })

  it('requires a distinctive install path for the shared agent executable alias', () => {
    expect(
      agentOf({ name: 'agent.exe', cmd: win`"C:\Users\u\AppData\Local\cursor-agent\agent.exe"` })
    ).toBe('cursor')
    expect(
      agentOf({
        name: 'agent.exe',
        cmd: win`"C:\Users\u\AppData\Local\cursor-agent\versions\2026.09.26\agent.exe"`
      })
    ).toBe('cursor')
    expect(agentOf({ name: 'agent.exe', cmd: win`"C:\Users\u\.grok\bin\agent.exe"` })).toBe('grok')
    expect(agentOf({ name: 'agent.exe', cmd: 'agent.exe' })).toBe(null)
    expect(agentOf({ name: 'agent.exe', cmd: win`"C:\Other\agent.exe" cursor-agent` })).toBe(null)
    expect(
      agentOf({
        name: 'agent.exe',
        cmd: win`"C:\Other\agent.exe" "C:\Users\u\.grok\bin\agent.exe"`
      })
    ).toBe(null)
    expect(agentOf({ name: 'agent.exe', cmd: win`"C:\Other\my-cursor-agent\agent.exe"` })).toBe(
      null
    )
    expect(
      agentOf({
        name: 'Cursor.exe',
        cmd: win`"C:\Users\u\AppData\Local\Programs\cursor\Cursor.exe"`
      })
    ).toBe(null)
  })

  it.each([
    ['git.exe', 'git pi'],
    ['git.exe', 'git cursor-agent'],
    ['node.exe', 'node grok'],
    ['node.exe', win`node C:\npm\node_modules\grok-dev\dist\index.js`],
    [
      'node.exe',
      win`node C:\npm\node_modules\@earendil-works\pi-coding-agent-tools\dist\bundle\cli.js`
    ],
    ['node.exe', win`node C:\npm\node_modules\@augmentcode\auggie\examples\demo.mjs`],
    ['python.exe', 'python pi'],
    ['crush-helper.exe', 'crush-helper.exe'],
    ['auggie-helper.exe', 'auggie-helper.exe']
  ])('ignores arguments and lookalike programs: %s %s', (name, cmd) => {
    expect(agentOf({ name, cmd })).toBe(null)
  })

  it('keeps the nearest new agent and its command when it starts another agent', () => {
    const procs = [
      {
        pid: 11,
        ppid: 10,
        name: 'node.exe',
        cmd: win`node C:\npm\node_modules\@augmentcode\auggie\augment.mjs`
      },
      { pid: 12, ppid: 11, name: 'claude.exe', cmd: 'claude' }
    ]
    const commands = {}
    expect(agentsUnderShells(procs, { pane: 10 }, commands)).toEqual({ pane: 'auggie' })
    expect(commands.pane).toBe(procs[0].cmd)
  })

  it('finds the agent closest under each pane shell, and nothing once it is gone', () => {
    const procs = [
      { pid: 10, ppid: 1, name: 'powershell.exe', cmd: 'powershell' },
      {
        pid: 11,
        ppid: 10,
        name: 'node.exe',
        cmd: win`node C:\npm\node_modules\@openai\codex\bin\codex.js`
      },
      { pid: 12, ppid: 11, name: 'codex.exe', cmd: 'codex.exe' },
      { pid: 13, ppid: 12, name: 'node.exe', cmd: win`node C:\x\tessel-team-mcp.cjs` },
      { pid: 20, ppid: 1, name: 'cmd.exe', cmd: 'cmd' },
      { pid: 21, ppid: 20, name: 'git.exe', cmd: 'git status' }
    ]
    expect(agentsUnderShells(procs, { 'pane-1': 10, 'pane-2': 20, 'pane-3': 99 })).toEqual({
      'pane-1': 'codex',
      'pane-2': null,
      'pane-3': null
    })
  })

  it('Ollama: its menu, a chat or an agent it launches; never its server', () => {
    const O = 'C:/Programs/Ollama/ollama.exe'
    expect(agentOf({ name: 'ollama.exe', cmd: `"${O}" run glm-5.2:cloud` })).toBe('ollama')
    expect(agentOf({ name: 'ollama.exe', cmd: 'ollama' })).toBe('ollama')
    expect(agentOf({ name: 'ollama.exe', cmd: 'ollama launch cline --model glm' })).toBe('ollama')
    expect(agentOf({ name: 'ollama.exe', cmd: 'ollama serve' })).toBe(null)
    expect(agentOf({ name: 'ollama.exe', cmd: 'ollama list' })).toBe(null)
    // ollama launch claude: the pane is Claude Code, with Ollama's command line too.
    const procs = [
      { pid: 10, ppid: 1, name: 'pwsh.exe', cmd: 'pwsh' },
      { pid: 11, ppid: 10, name: 'ollama.exe', cmd: 'ollama launch claude --model glm-5.2:cloud' },
      { pid: 12, ppid: 11, name: 'claude.exe', cmd: 'claude' },
      { pid: 20, ppid: 1, name: 'pwsh.exe', cmd: 'pwsh' },
      { pid: 21, ppid: 20, name: 'ollama.exe', cmd: 'ollama run qwen3:8b' }
    ]
    const commands = {}
    expect(agentsUnderShells(procs, { a: 10, b: 20 }, commands)).toEqual({
      a: 'claude',
      b: 'ollama'
    })
    expect(commands.a).toBe('claude ollama launch claude --model glm-5.2:cloud')
    expect(commands.b).toBe('ollama run qwen3:8b')
  })
})
