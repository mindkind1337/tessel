// The arguments that resume an agent's conversation, as an array built by the
// vendored agent-session-resume.js (getAgentResumeArgv), for the agents that
// pick their own session id (Claude Code, Codex, Gemini and Qwen are in
// App.vue's agentStartLine). The main process says first whether there is
// something to resume (sessions:resumeTarget). Nothing that could be read by a
// shell as anything else goes on the command line: the id is plain, and every
// argument is checked again here.
import { getAgentResumeArgv } from './chat/orca/shared/agent-session-resume.js'

// Resumable agents that choose their own id, found after they start
// (watchFoundSession) or reported by their hooks (Qoder CLI, DeepSeek Harness).
export const OWN_ID_AGENTS = ['opencode', 'cline', 'copilot', 'kimi', 'droid', 'grok', 'pi', 'omp', 'antigravity', 'devin', 'cursor', 'zcode', 'qoder', 'dsh']
// Of those, the ones whose session is found in their files.
export const FOUND_IN_FILES = ['opencode', 'cline', 'copilot', 'kimi', 'droid', 'grok', 'pi', 'omp', 'antigravity', 'devin', 'cursor', 'zcode']

export const safeSessionId = (id) => typeof id === 'string' && /^[A-Za-z0-9_][A-Za-z0-9_-]{5,79}$/.test(id)
const safeArg = (a) => typeof a === 'string' && /^[A-Za-z0-9_.:=\/-]+$/.test(a)

// Agents the vendored table has no entry for.
const OWN = {
  cline: (id) => ['--id', id],
  cursor: (id) => ['--resume', id]
}

// -> the argument array after the command, or null (start fresh).
export async function resumeArgs(kind, sessionId, api = {}) {
  if (!OWN_ID_AGENTS.includes(kind) || !safeSessionId(sessionId)) return null
  let target = {}
  if (api.agentResumeTarget) {
    target = await api.agentResumeTarget({ agent: kind, sessionId }).catch(() => null)
    if (!target || typeof target !== 'object') return null
  } else if (!['opencode', 'cline', 'copilot', 'kimi'].includes(kind)) {
    return null // an older main process: cannot check, start fresh
  }
  let args
  if (OWN[kind]) args = OWN[kind](sessionId)
  else {
    const session = {
      key: kind === 'antigravity' ? 'conversation_id' : 'session_id',
      id: sessionId,
      ...(typeof target.transcriptPath === 'string' ? { transcriptPath: target.transcriptPath } : {})
    }
    const argv = getAgentResumeArgv(kind, session)
    args = Array.isArray(argv) ? argv.slice(1) : null
  }
  return args && args.length && args.every(safeArg) ? args : null
}
