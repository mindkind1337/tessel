// The task board rule in each agent's persistent memory: the file it reads
// at the start of every session (and again after compacting its
// conversation), so the rule is never forgotten:
//   Claude Code  ~/.claude/CLAUDE.md
//   Codex        ~/.codex/AGENTS.md (CODEX_HOME)
//   Gemini CLI   ~/.gemini/GEMINI.md
//   Qwen Code    ~/.qwen/QWEN.md
//   OpenCode     ~/.config/opencode/AGENTS.md
//   Copilot CLI  ~/.copilot/copilot-instructions.md
//   Cline        ~/Documents/Cline/Rules/tessel-task-board.md (a file of its own)
// Tessel's part sits between two markers and is the only part it writes: the
// rest of the file is the user's and is kept as it is.
import fs from 'fs'
import os from 'os'
import { join, dirname } from 'path'
import { writeFileAtomic } from './safeJson'

export const RULE_START = '<!-- tessel:task-board:start -->'
export const RULE_END = '<!-- tessel:task-board:end -->'

export const BOARD_RULE = [
  '## Tessel task board',
  '',
  "When you run inside Tessel (the tessel-team tools are available to you), the user follows everything you do on Tessel's task board. Keep it up to date yourself, without being asked:",
  '',
  '- Add a card (team_task_add) for every piece of work the moment you start it: what the user asks, each step you decide to take (split bigger work into cards), and each task you give a teammate. Column "doing" for what you start now, "todo" for later.',
  '- Move your cards as they go (team_task_move): "review" when one waits for a review, "done" as soon as it is finished. See their ids with team_tasks.',
  '- Only a quick question or a short answer needs no card.'
].join('\n')

export function memoryFile(agent, home = os.homedir(), env = process.env) {
  switch (agent) {
    case 'claude':
      return join(home, '.claude', 'CLAUDE.md')
    case 'codex':
      return join(env.CODEX_HOME || join(home, '.codex'), 'AGENTS.md')
    case 'gemini':
      return join(home, '.gemini', 'GEMINI.md')
    case 'qwen':
      return join(home, '.qwen', 'QWEN.md')
    case 'opencode':
      return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'opencode', 'AGENTS.md')
    case 'copilot':
      return join(home, '.copilot', 'copilot-instructions.md')
    case 'cline':
      return join(home, 'Documents', 'Cline', 'Rules', 'tessel-task-board.md')
    default:
      return null
  }
}

// The file's text with Tessel's part set to `rule` (added at the end the
// first time, replaced in place after).
export function withRule(text, rule = BOARD_RULE) {
  const block = `${RULE_START}\n${rule}\n${RULE_END}`
  const src = String(text || '')
  const a = src.indexOf(RULE_START)
  const b = src.indexOf(RULE_END)
  if (a >= 0 && b > a) return src.slice(0, a) + block + src.slice(b + RULE_END.length)
  if (!src.trim()) return `${block}\n`
  return `${src.replace(/\s*$/, '')}\n\n${block}\n`
}

// -> { changed, file } or { error }
export function writeBoardRule(agent, home = os.homedir()) {
  const file = memoryFile(agent, home)
  if (!file) return { changed: false, file: null }
  try {
    const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
    const next = withRule(old)
    if (next === old) return { changed: false, file }
    fs.mkdirSync(dirname(file), { recursive: true })
    writeFileAtomic(file, next)
    return { changed: true, file }
  } catch (err) {
    return { error: err.message, file }
  }
}
