// The key an agent reads as "new line" in its input box, for Shift+Enter: the
// terminal sends the same Enter with or without Shift. Alt+Enter for Claude Code.
// Codex in a Windows console ignores Ctrl+J and takes Alt+Enter (tested on 0.166);
// Ctrl+J stays for the other agents and for a Codex on another system.
export function agentNewlineKey(agentId, { remote = false, windows = false } = {}) {
  if (agentId === 'claude') return '\x1b\r'
  if (agentId === 'codex' && windows && !remote) return '\x1b\r'
  return '\n'
}
