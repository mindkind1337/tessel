// The agent-state detection rules in use (src/shared/agentStateRules.js):
// the built-in ones until the main process sends the user's override file
// (shellApi.agentRules), then those merged over them. The renderer never
// reads the file itself.
//   rulesFor(provider)   -> the compiled rule set agentLimit.js and
//                           agentStatus.js read a screen with
//   agentRulesStatus     -> { state: 'builtin' | 'override' | 'invalid',
//                             reason, problem, file, size } for Settings > Agents
//   agentRulesReason(t)  -> why the file is ignored, in the interface's language
import { reactive } from 'vue'
import { createRuleEngine, describeRuleError, validateOverride } from '../../shared/agentStateRules'

const warn = (text) => {
  try {
    console.warn(`[agent-rules] ${text}`)
  } catch {
    /* no console */
  }
}

let engine = createRuleEngine(null, { log: warn })

export const agentRulesStatus = reactive({ state: 'builtin', reason: '', problem: null, file: '', size: 0 })

export function rulesFor(provider) {
  return engine.forProvider(provider)
}

// payload: { state, reason, problem, file, size, override } from the main
// process (problem: a code with its values; reason: main's own text).
// Checked again here: anything not a valid override keeps the built-ins.
export function applyAgentStateRules(payload) {
  const p = payload && typeof payload === 'object' ? payload : {}
  let override = null
  let state = p.state === 'invalid' ? 'invalid' : 'builtin'
  let reason = p.state === 'invalid' ? String(p.reason || '') : ''
  let problem = p.state === 'invalid' && p.problem && typeof p.problem === 'object' ? p.problem : null
  if (p.state === 'override' && p.override) {
    const checked = validateOverride(p.override)
    if (checked.ok) {
      override = checked.override
      state = 'override'
    } else {
      state = 'invalid'
      problem = checked.error
      reason = describeRuleError(problem)
    }
  }
  engine = createRuleEngine(override, { log: warn })
  agentRulesStatus.state = state
  agentRulesStatus.reason = reason
  agentRulesStatus.problem = problem
  agentRulesStatus.file = String(p.file || '')
  agentRulesStatus.size = state === 'override' ? Number(p.size) || 0 : 0
  return agentRulesStatus
}

// Why the rules file is ignored, said with the interface's t(): from its
// code when the main process sent one, else its text as it came.
export function agentRulesReason(t) {
  return agentRulesStatus.problem ? describeRuleError(agentRulesStatus.problem, t) : agentRulesStatus.reason
}
