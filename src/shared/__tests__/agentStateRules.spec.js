// Agent-state detection rules as data: the built-in JSON files reproduce the
// patterns Tessel hardcoded before them, the override schema is strict, and
// the merge applies the user's fixes over the built-ins.
import { describe, it, expect } from 'vitest'
import {
  BUILTIN_RULE_FILES,
  OVERRIDE_TEMPLATE,
  MAX_SCREEN_TEXT,
  RULE_KINDS,
  compileRuleSet,
  createRuleEngine,
  describeRuleError,
  findUnsafePatternReason,
  mergeRules,
  overrideSize,
  parseJsonc,
  resolveRules,
  validateOverride,
  validateRuleFile
} from '../agentStateRules'

// The patterns as they were hardcoded in agentLimit.js and agentStatus.js
// before they became data (commit 645e3a4), copied verbatim.
const OLD = {
  limit: [
    /you['’]ve hit your usage limit/i,
    /\busage limit reached\b/i,
    /\b(?:5-hour|five-hour|weekly|session|opus|sonnet) limit reached\b/i,
    /you['’]ve reached your (?:usage|weekly|session|5-hour) limit/i,
    /\bquota exceeded\b/i,
    /you have exhausted your (?:daily )?quota/i,
    /\bRESOURCE_EXHAUSTED\b/
  ],
  reset: [
    /(?:try again at|resets? at|resets|reset at)\s+([0-9]{1,2}(?::[0-9]{2})?\s*(?:[ap]m|[ap]\.m\.))/i,
    /(?:try again|resets?) in\s+((?:\d+\s*(?:days?|hours?|hrs?|minutes?|mins?)\s*,?\s*(?:and\s*)?)+)/i,
    /(?:try again on|resets? on|resets)\s+([A-Z][a-z]{2,8}\.? \d{1,2}(?:,? \d{1,2}(?::\d{2})?\s*[ap]m)?)/
  ],
  approval:
    /Would you like to (run|make|apply)|Press enter to confirm|Do you want to (proceed|make|create|allow|run)|Do you trust (the files|the contents|this)|Allow execution|Apply this change|\(y\/n\)|\(y\/n\/p\)|\[y\/N\]|Run this command\?|Allow access to this URL\?|Allow calling this tool\?|Approve this action\?/i,
  footer: /\besc(?:ape)?\s+(?:to\s+)?(?:interrupt|cancel)\b/i,
  running: /\besc(?:ape)?\s+(?:to\s+)?interrupt\b/i,
  working:
    /^\s*[·✢✳✶✻✽*]\s+[A-Za-z][^…()]{0,60}…(?:\s*\((?=[^)]*(?:\d+[hms]\b|\btokens?\b|\bthinking\b|\bthought for\b|\btool\b|\binterrupt\b))[^)]*\)?)?\s*$/,
  interrupted: /\bInterrupted\b\s*(?:by user|·\s*What should Claude do instead)/i,
  codexInterrupted: /\bConversation interrupted\b/i
}

const file = (id) => BUILTIN_RULE_FILES.find((f) => f.id === id)
const ofKind = (id, kind) => file(id).rules.filter((r) => r.kind === kind)
const asRegExp = (r) => new RegExp(r.regex, r.ignoreCase ? 'i' : '')
const same = (rule, re) => {
  const mine = asRegExp(rule)
  expect(mine.source).toBe(re.source)
  expect(mine.flags).toBe(re.flags)
}

describe('built-in rules reproduce the former hardcoded patterns', () => {
  it('limit and reset patterns, in the same order', () => {
    const limit = ofKind('common', 'limit')
    expect(limit).toHaveLength(OLD.limit.length)
    limit.forEach((r, i) => same(r, OLD.limit[i]))
    const reset = ofKind('common', 'limit-reset')
    expect(reset).toHaveLength(OLD.reset.length)
    reset.forEach((r, i) => same(r, OLD.reset[i]))
    // Only the "in 2 hours" form was shown with "in ".
    expect(reset.map((r) => r.prefix || '')).toEqual(['', 'in ', ''])
  })

  it('the approval alternation, split one alternative per rule', () => {
    const approval = ofKind('common', 'approval')
    expect(approval.every((r) => r.ignoreCase)).toBe(true)
    // Added since: the trust questions of today's Claude Code and Codex.
    const added = ['approval-trust-safety-check', 'approval-trust-folder', 'approval-trust-option']
    const former = approval.filter((r) => !added.includes(r.id))
    expect(approval.filter((r) => added.includes(r.id)).map((r) => r.id)).toEqual(added)
    expect(former.map((r) => asRegExp(r).source).join('|')).toBe(OLD.approval.source)
  })

  it('footer, working line and interruption patterns', () => {
    same(ofKind('common', 'busy-footer')[0], OLD.footer)
    same(ofKind('common', 'running-footer')[0], OLD.running)
    same(ofKind('claude', 'working-line')[0], OLD.working)
    same(ofKind('claude', 'interrupted')[0], OLD.interrupted)
    same(ofKind('codex', 'interrupted-screen')[0], OLD.codexInterrupted)
    // Claude-only and Codex-only, as the code gated them by provider before.
    for (const kind of ['working-line', 'interrupted', 'interrupted-screen']) expect(ofKind('common', kind)).toEqual([])
    expect(ofKind('codex', 'working-line')).toEqual([])
    expect(ofKind('claude', 'interrupted-screen')).toEqual([])
  })

  it('every built-in file passes the strict schema', () => {
    for (const f of BUILTIN_RULE_FILES) expect(validateRuleFile(f)).toEqual({ ok: true, error: null })
  })

  it('the user-file safety check only flags the reset-in pattern among the built-ins', () => {
    const flagged = BUILTIN_RULE_FILES.flatMap((f) => f.rules.filter((r) => findUnsafePatternReason(r.regex)).map((r) => `${f.id}/${r.id}`))
    expect(flagged).toEqual(['common/reset-in'])
  })

  it('resolved per agent: common for all, own rules added for claude and codex', () => {
    const merged = mergeRules()
    expect(resolveRules(merged, 'gemini').map((r) => r.id)).toEqual(file('common').rules.map((r) => r.id))
    expect(resolveRules(merged, undefined).map((r) => r.id)).toEqual(file('common').rules.map((r) => r.id))
    expect(resolveRules(merged, 'claude').map((r) => r.id).slice(-2)).toEqual(['working-spinner', 'interrupted'])
    expect(resolveRules(merged, 'codex').at(-1).kind).toBe('interrupted-screen')
  })
})

describe('pattern safety', () => {
  it.each([
    ['(a+)+$', 'repeatedGroup'],
    ['(a|aa)*b', 'repeatedGroup'],
    ['(\\w?)+x', 'repeatedGroup'],
    ['((ab)+c)*', 'repeatedGroup'],
    ['(a)\\1', 'backreference'],
    ['(?<=x)y', 'lookbehind'],
    ['(', 'noCompile']
  ])('%s is refused', (pattern, why) => {
    expect(findUnsafePatternReason(pattern)).toBe(why)
  })

  it.each(['\\busage limit reached\\b', 'Do you want to (proceed|run)', '[(]y/n[)]', '(?:esc)+ to'])('%s is accepted', (pattern) => {
    expect(findUnsafePatternReason(pattern)).toBeNull()
  })
})

const rule = (over = {}) => ({ id: 'mine', kind: 'approval', regex: 'Continue\\? \\(yes/no\\)', ...over })
const override = (agents) => ({ engineVersion: 1, agents })
const err = (value, opts) => describeRuleError(validateOverride(value, { knownAgents: ['claude', 'codex', 'gemini'], ...opts }).error)

describe('override schema', () => {
  it('accepts a valid file', () => {
    const v = override({ common: { rules: [rule()], disable: ['approval-press-enter'] }, claude: { disable: ['working-spinner'] } })
    expect(validateOverride(v, { knownAgents: ['claude'] })).toEqual({ ok: true, error: null, override: v })
  })

  it.each([
    ['not an object', [], 'one JSON object'],
    ['unknown top field', { engineVersion: 1, agents: {}, extra: 1 }, 'unknown field "extra"'],
    ['wrong engine version', { engineVersion: 2, agents: {} }, 'engineVersion must be 1'],
    ['agents missing', { engineVersion: 1 }, 'agents must be an object'],
    ['unknown agent', override({ notanagent: {} }), '"notanagent" is not an agent Tessel knows'],
    ['unknown entry field', override({ claude: { rule: [] } }), 'unknown field "rule"'],
    ['unknown rule field', override({ claude: { rules: [rule({ flags: 'g' })] } }), 'unknown field "flags"'],
    ['unknown kind', override({ claude: { rules: [rule({ kind: 'sleeping' })] } }), 'kind must be one of'],
    ['bad id', override({ claude: { rules: [rule({ id: 'has space' })] } }), 'id must be'],
    ['regex too long', override({ claude: { rules: [rule({ regex: 'a'.repeat(201) })] } }), 'longer than 200'],
    ['catastrophic regex', override({ claude: { rules: [rule({ regex: '(a+)+b' })] } }), 'repeats a group'],
    ['not compiling', override({ claude: { rules: [rule({ regex: '[a-' })] } }), 'does not compile'],
    ['matches empty text', override({ claude: { rules: [rule({ regex: 'x*' })] } }), 'matches empty text'],
    ['ignoreCase not boolean', override({ claude: { rules: [rule({ ignoreCase: 'yes' })] } }), 'ignoreCase'],
    ['prefix on another kind', override({ claude: { rules: [rule({ prefix: 'in ' })] } }), 'prefix is for limit-reset'],
    ['reset without group', override({ claude: { rules: [rule({ kind: 'limit-reset', regex: 'resets soon' })] } }), 'needs a group'],
    ['duplicate id', override({ claude: { rules: [rule(), rule()] } }), 'used twice'],
    ['too many rules', override({ claude: { rules: Array.from({ length: 33 }, (_, i) => rule({ id: `r${i}` })) } }), '32 rules at most'],
    ['disable an unknown rule', override({ claude: { disable: ['nope'] } }), 'no rule "nope"'],
    ['disable another agent rule in common', override({ common: { disable: ['working-spinner'] } }), 'no rule "working-spinner"']
  ])('rejects %s', (_name, value, message) => {
    expect(err(value)).toContain(message)
  })

  it('names where the error is', () => {
    expect(err(override({ claude: { rules: [rule(), rule({ id: 'b', regex: '(a|b)+c' })] } }))).toMatch(/^agents\.claude\.rules\[1\]: regex/)
  })

  // The reason is a code with its values, so each window says it in its
  // language; the place in the file and the parser's own words stay as is.
  it('gives a code and its values, said in the language of the caller', () => {
    const value = override({ claude: { rules: [rule(), rule({ id: 'b', regex: '(a|b)+c' })] } })
    const { error } = validateOverride(value, { knownAgents: ['claude'] })
    expect(error).toEqual({ code: 'unsafeRegex', at: 'agents.claude.rules[1]', why: 'repeatedGroup' })
    const fr = (key, english, vars) =>
      ({
        'main.agentRules.at': '{{at}} : {{reason}}',
        'main.agentRules.unsafeRegex.repeatedGroup': 'la regex répète un groupe qui peut correspondre de plusieurs façons'
      })[key]?.replace(/\{\{(\w+)\}\}/g, (_m, n) => vars[n]) ?? `EN:${english}`
    expect(describeRuleError(error, fr)).toBe('agents.claude.rules[1] : la regex répète un groupe qui peut correspondre de plusieurs façons')
    expect(validateOverride(override({ robot: {} }), { knownAgents: ['claude'] }).error).toEqual({ code: 'unknownAgent', at: 'agents.robot', agent: 'robot' })
    const compile = validateOverride(override({ claude: { rules: [rule({ regex: '[a-' })] } })).error
    expect(compile).toMatchObject({ code: 'regexCompile', at: 'agents.claude.rules[0]' })
    expect(compile.detail).toMatch(/Invalid regular expression/)
    expect(describeRuleError(compile)).toContain('regex does not compile: Invalid regular expression')
  })

  it('an old plain-text reason is shown as it is', () => {
    expect(describeRuleError('agents.x: something')).toBe('agents.x: something')
    expect(describeRuleError(null)).toBe('')
  })

  it('any agent id when the known list is not given (the renderer re-check)', () => {
    expect(validateOverride(override({ someagent: { rules: [rule()] } })).ok).toBe(true)
  })
})

describe('JSON with comments', () => {
  it('strips // and /* */ comments, never inside strings', () => {
    expect(parseJsonc('// top\n{ "a": "x // y", /* c */ "b": "/* z */" } // end')).toEqual({ a: 'x // y', b: '/* z */' })
    expect(parseJsonc('\uFEFF{"q": "say \\"hi\\" // no"}')).toEqual({ q: 'say "hi" // no' })
    expect(() => parseJsonc('{ /* open')).toThrow()
  })

  it('the example file is valid and changes nothing', () => {
    const value = parseJsonc(OVERRIDE_TEMPLATE)
    expect(validateOverride(value, { knownAgents: ['claude'] }).ok).toBe(true)
    expect(overrideSize(value)).toBe(0)
    for (const kind of RULE_KINDS) expect(OVERRIDE_TEMPLATE).toContain(kind)
  })

  it('the commented examples are valid once uncommented', () => {
    const lines = OVERRIDE_TEMPLATE.split('\n')
    const from = lines.findIndex((l) => l.startsWith('// Examples'))
    const body = lines
      .slice(from + 1, lines.indexOf('{'))
      .map((l) => l.slice(3))
      .join('\n')
    const value = { engineVersion: 1, ...JSON.parse(`{${body}}`) }
    expect(validateOverride(value, { knownAgents: ['claude'] })).toMatchObject({ ok: true })
    expect(overrideSize(value)).toBe(3)
  })
})

describe('merge', () => {
  const ids = (list) => list.map((r) => r.id)

  it('a rule with a built-in id replaces it in place; a new id is added last', () => {
    const merged = mergeRules(undefined, override({ common: { rules: [rule({ id: 'busy-esc', kind: 'busy-footer', regex: 'stop with esc' }), rule()] } }))
    const list = resolveRules(merged, 'gemini')
    expect(ids(list)).toEqual([...ids(file('common').rules), 'mine'])
    expect(list.find((r) => r.id === 'busy-esc')).toMatchObject({ regex: 'stop with esc', user: true })
    expect(file('common').rules.find((r) => r.id === 'busy-esc').user).toBeUndefined()
  })

  it('an agent disable turns a common rule off for that agent only', () => {
    const merged = mergeRules(undefined, override({ codex: { disable: ['approval-y-n'] } }))
    expect(ids(resolveRules(merged, 'codex'))).not.toContain('approval-y-n')
    expect(ids(resolveRules(merged, 'claude'))).toContain('approval-y-n')
  })

  it('a common disable turns it off for every agent', () => {
    const merged = mergeRules(undefined, override({ common: { disable: ['approval-y-n'] } }))
    for (const agent of ['codex', 'claude', undefined]) expect(ids(resolveRules(merged, agent))).not.toContain('approval-y-n')
  })

  it("an agent's rule with a common id replaces it for that agent", () => {
    const merged = mergeRules(undefined, override({ gemini: { rules: [rule({ id: 'approval-y-n', regex: 'yes or no' })] } }))
    expect(resolveRules(merged, 'gemini').find((r) => r.id === 'approval-y-n').regex).toBe('yes or no')
    expect(resolveRules(merged, 'codex').find((r) => r.id === 'approval-y-n').regex).toBe('\\(y\\/n\\)')
  })

  it('an engine without override reads screens as before; with one, as fixed', () => {
    const plain = createRuleEngine().forProvider('gemini')
    expect(plain.test('approval', 'Continue? (yes/no)')).toBe(false)
    const fixed = createRuleEngine(override({ gemini: { rules: [rule()] } }))
    expect(fixed.forProvider('gemini').test('approval', 'Continue? (yes/no)')).toBe(true)
    expect(fixed.forProvider('claude').test('approval', 'Continue? (yes/no)')).toBe(false)
  })
})

describe('user rules are bounded', () => {
  it(`read only the screen's last ${MAX_SCREEN_TEXT} characters`, () => {
    const set = compileRuleSet([{ ...rule(), user: true }, { id: 'b', kind: 'limit', regex: 'early', user: false }])
    const text = 'Continue? (yes/no)' + 'x'.repeat(MAX_SCREEN_TEXT)
    expect(set.test('approval', text)).toBe(false)
    expect(set.test('approval', 'x'.repeat(MAX_SCREEN_TEXT) + 'Continue? (yes/no)')).toBe(true)
    // Built-in rules read the whole text, as before.
    expect(set.test('limit', 'early' + 'x'.repeat(MAX_SCREEN_TEXT * 2))).toBe(true)
  })

  it('a slow user rule is turned off and logged', () => {
    let t = 0
    const logs = []
    const set = compileRuleSet([{ ...rule(), user: true }], {
      now: () => (t += 60),
      log: (m) => logs.push(m)
    })
    expect(set.test('approval', 'Continue? (yes/no)')).toBe(true)
    expect(logs[0]).toContain('"mine" took')
    expect(set.test('approval', 'Continue? (yes/no)')).toBe(false)
  })

  it('a built-in rule is never timed or turned off', () => {
    let calls = 0
    const set = compileRuleSet(file('common').rules, { now: () => (calls++, calls * 1000) })
    expect(set.test('approval', '(y/n)')).toBe(true)
    expect(calls).toBe(0)
  })
})
