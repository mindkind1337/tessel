// The renderer's detection rules: with no override, detectLimit and
// detectApproval answer exactly as the hardcoded patterns did; the rules the
// main process sends apply at once (live reload) and an invalid payload
// keeps the built-ins.
import { describe, it, expect, afterEach } from 'vitest'
import { detectApproval, detectLimit } from '../agentLimit'
import { agentScreenObservation } from '../agentStatus'
import { agentRulesStatus, applyAgentStateRules } from '../agentStateRules'

// The former implementation (commit 645e3a4), verbatim.
const OLD_LIMIT = [
  /you['’]ve hit your usage limit/i,
  /\busage limit reached\b/i,
  /\b(?:5-hour|five-hour|weekly|session|opus|sonnet) limit reached\b/i,
  /you['’]ve reached your (?:usage|weekly|session|5-hour) limit/i,
  /\bquota exceeded\b/i,
  /you have exhausted your (?:daily )?quota/i,
  /\bRESOURCE_EXHAUSTED\b/
]
const OLD_RESET = [
  /(?:try again at|resets? at|resets|reset at)\s+([0-9]{1,2}(?::[0-9]{2})?\s*(?:[ap]m|[ap]\.m\.))/i,
  /(?:try again|resets?) in\s+((?:\d+\s*(?:days?|hours?|hrs?|minutes?|mins?)\s*,?\s*(?:and\s*)?)+)/i,
  /(?:try again on|resets? on|resets)\s+([A-Z][a-z]{2,8}\.? \d{1,2}(?:,? \d{1,2}(?::\d{2})?\s*[ap]m)?)/
]
function oldDetectLimit(text) {
  const s = String(text || '')
  if (!OLD_LIMIT.some((re) => re.test(s))) return null
  for (const re of OLD_RESET) {
    const m = re.exec(s)
    if (m) {
      const when = m[1].replace(/\s+/g, ' ').replace(/[\s,]+$/, '').trim()
      return { reset: re === OLD_RESET[1] ? `in ${when}` : when }
    }
  }
  return { reset: '' }
}
const OLD_APPROVAL =
  /Would you like to (run|make|apply)|Press enter to confirm|Do you want to (proceed|make|create|allow|run)|Do you trust (the files|the contents|this)|Allow execution|Apply this change|\(y\/n\)|\(y\/n\/p\)|\[y\/N\]|Run this command\?|Allow access to this URL\?|Allow calling this tool\?|Approve this action\?/i
const oldDetectApproval = (text) => OLD_APPROVAL.test(String(text || ''))

const CORPUS = [
  '',
  null,
  'hello',
  "You've hit your usage limit. Upgrade to Pro or try again at 8:47 PM.",
  'You’ve hit your usage limit. try again in 2 days 3 hours, and 5 minutes.',
  'Claude usage limit reached. Your limit will reset at 5pm',
  '5-hour limit reached ∙ resets 3pm (America/Toronto)',
  'Weekly limit reached ∙ resets Oct 3, 9am',
  'Opus limit reached, try again on Nov 12',
  "You've reached your weekly limit",
  'Quota exceeded for quota metric',
  'You have exhausted your daily quota',
  'RESOURCE_EXHAUSTED',
  'resource_exhausted',
  'usage limit reached. resets at 11:30 a.m.',
  'we talk about usage limits here',
  'Would you like to run the following command?',
  'Do you want to proceed?\n❯ 1. Yes',
  'Do you trust the files in this folder?',
  'Allow execution of: rm?',
  'Apply this change?',
  'Overwrite (y/n)',
  'Waiting for decision (y/n/p)...',
  'Continue? [y/N]',
  'Continue? [Y/n]',
  'Run this command?',
  'Allow access to this URL?',
  'Allow calling this tool?',
  'Approve this action?',
  'press ENTER to confirm',
  'nothing to approve'
]

afterEach(() => applyAgentStateRules({ state: 'builtin' }))

describe('no override: identical to the hardcoded patterns', () => {
  it.each(CORPUS.map((s) => [s]))('%j', (text) => {
    for (const provider of [undefined, 'claude', 'codex', 'gemini', 'freebuff']) {
      expect(detectLimit(text, provider)).toEqual(oldDetectLimit(text))
      expect(detectApproval(text, provider)).toBe(oldDetectApproval(text))
    }
  })

  it('status says built-in', () => {
    expect(agentRulesStatus.state).toBe('builtin')
  })
})

const payload = (agents, extra = {}) => ({
  state: 'override',
  file: 'C:/x/agent-state-rules.json',
  size: 1,
  override: { engineVersion: 1, agents },
  ...extra
})

describe('override from the main process', () => {
  it('a new approval phrase applies at once, and goes when the file does', () => {
    expect(detectApproval('Continue? (yes/no)', 'gemini')).toBe(false)
    applyAgentStateRules(payload({ gemini: { rules: [{ id: 'yes-no', kind: 'approval', regex: '\\(yes/no\\)' }] } }))
    expect(agentRulesStatus).toMatchObject({ state: 'override', size: 1, reason: '' })
    expect(detectApproval('Continue? (yes/no)', 'gemini')).toBe(true)
    expect(detectApproval('Continue? (yes/no)', 'claude')).toBe(false)
    applyAgentStateRules({ state: 'builtin' })
    expect(detectApproval('Continue? (yes/no)', 'gemini')).toBe(false)
  })

  it('a disabled rule stops matching; a fixed reset phrase is read', () => {
    applyAgentStateRules(
      payload({
        common: {
          disable: ['approval-y-n'],
          rules: [{ id: 'reset-back', kind: 'limit-reset', regex: 'back at (\\d+h)', prefix: '~' }]
        }
      })
    )
    expect(detectApproval('Overwrite (y/n)')).toBe(false)
    expect(detectLimit('Quota exceeded, back at 14h')).toEqual({ reset: '~14h' })
  })

  it('reads the footer and working line with the fixed rules', () => {
    const screen = 'some output\n✻ Pondering…\n'
    expect(agentScreenObservation(null, 'claude', screen).busy).toBe(true)
    applyAgentStateRules(payload({ claude: { disable: ['working-spinner'] } }))
    expect(agentScreenObservation(null, 'claude', screen).busy).toBe(false)
    applyAgentStateRules(payload({ codex: { rules: [{ id: 'busy-new', kind: 'busy-footer', regex: 'working hard' }] } }))
    expect(agentScreenObservation(null, 'codex', 'x\nworking hard').busy).toBe(true)
    expect(agentScreenObservation(null, 'gemini', 'x\nworking hard').busy).toBe(false)
  })

  it('an invalid file keeps the built-ins and says why', () => {
    applyAgentStateRules({ state: 'invalid', reason: 'agents.claude.rules[0]: regex repeats a group', file: 'f' })
    expect(agentRulesStatus).toMatchObject({ state: 'invalid', reason: 'agents.claude.rules[0]: regex repeats a group', size: 0 })
    expect(detectApproval('Overwrite (y/n)')).toBe(true)
  })

  it('an override that fails the re-check here is refused too', () => {
    applyAgentStateRules(payload({ claude: { rules: [{ id: 'bad', kind: 'approval', regex: '(a+)+$' }] } }))
    expect(agentRulesStatus.state).toBe('invalid')
    expect(agentRulesStatus.reason).toContain('repeats a group')
    expect(detectApproval('aaaa', 'claude')).toBe(false)
  })

  it('garbage payloads mean built-in', () => {
    for (const p of [null, 'x', 42, { state: 'override' }]) {
      applyAgentStateRules(p)
      expect(agentRulesStatus.state).toBe('builtin')
    }
  })
})
