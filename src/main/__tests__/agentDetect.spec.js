// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { agentOf, agentsUnderShells } from '../agentDetect'

const win = String.raw

describe('which agent runs in a shell pane', () => {
  it('recognises the agent CLIs from their process', () => {
    expect(agentOf({ name: 'claude.exe', cmd: win`"C:\Users\u\AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe" --resume x` })).toBe('claude')
    expect(agentOf({ name: 'node.exe', cmd: win`"node"   "C:\Users\u\AppData\Roaming\npm\node_modules\@openai\codex\bin\codex.js" resume 01a0` })).toBe('codex')
    expect(agentOf({ name: 'node.exe', cmd: win`node C:\npm\node_modules\@google\gemini-cli\dist\index.js` })).toBe('gemini')
    expect(agentOf({ name: 'opencode.exe', cmd: 'opencode' })).toBe('opencode')
    expect(agentOf({ name: 'node.exe', cmd: win`node C:\npm\node_modules\@github\copilot\index.js` })).toBe('copilot')
    // Cline: its node launcher, then the compiled program it starts.
    expect(agentOf({ name: 'node.exe', cmd: win`"node" "C:\Users\u\AppData\Roaming\npm\node_modules\cline\bin\cline"` })).toBe('cline')
    expect(agentOf({ name: 'cline.exe', cmd: win`C:\npm\node_modules\@cline\cli-windows-x64\bin\cline.exe` })).toBe('cline')
    expect(agentOf({ name: 'amp.exe', cmd: 'amp' })).toBe('amp')
    expect(agentOf({ name: 'aider.exe', cmd: 'aider --model x' })).toBe('aider')
  })

  it('does not mistake other programs for agents', () => {
    expect(agentOf({ name: 'node.exe', cmd: win`node C:\Tessel-claude\scripts\build.js` })).toBe(null)
    expect(agentOf({ name: 'node.exe', cmd: win`node C:\Users\u\AppData\Roaming\tessel-team\tessel-team-mcp.cjs` })).toBe(null)
    expect(agentOf({ name: 'powershell.exe', cmd: 'powershell -NoLogo' })).toBe(null)
    expect(agentOf({ name: 'node.exe', cmd: win`node C:\proj\scripts\incline.js` })).toBe(null)
    expect(agentOf({ name: 'git.exe', cmd: 'git commit -m "ask claude"' })).toBe(null)
  })

  it('finds the agent closest under each pane shell, and nothing once it is gone', () => {
    const procs = [
      { pid: 10, ppid: 1, name: 'powershell.exe', cmd: 'powershell' },
      { pid: 11, ppid: 10, name: 'node.exe', cmd: win`node C:\npm\node_modules\@openai\codex\bin\codex.js` },
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
    expect(agentsUnderShells(procs, { a: 10, b: 20 }, commands)).toEqual({ a: 'claude', b: 'ollama' })
    expect(commands.a).toBe('claude ollama launch claude --model glm-5.2:cloud')
    expect(commands.b).toBe('ollama run qwen3:8b')
  })
})
