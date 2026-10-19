// Live Share: "Agents guests may use" (liveShareAgents.js), the rule that
// rides with rights: its defaults, how records saved before it read, what it
// allows, how each change keeps the other agents as they were, agents added
// later, and the /model switches typed in a pane.
import { describe, it, expect } from 'vitest'
import {
  cleanAgentRule,
  effectiveAgentRule,
  agentAllowed,
  allowedModels,
  modelAllowed,
  paneTypeAllowed,
  agentsForGuest,
  setAgentAllowed,
  setAgentLater,
  setAgentModels,
  sameAgentRule,
  followTypedLine,
  refusedModelSwitch
} from '../liveShareAgents'
import { cleanRights, sameRights, setRight, withAgents, NO_RIGHTS } from '../liveShareRights'

const HOST = ['claude', 'codex', 'grok']

describe('agents rule: defaults and old records', () => {
  it('reads no rule (and anything that is not one) as none: every agent and model', () => {
    for (const r of [null, undefined, 'all', 3, [], true]) expect(cleanAgentRule(r)).toBe(null)
    expect(agentAllowed(null, 'claude')).toBe(true)
    expect(modelAllowed(null, 'claude', 'opus')).toBe(true)
    expect(allowedModels(null, 'claude')).toBe(null)
    expect(paneTypeAllowed(null, { agent: 'claude', model: 'opus' })).toBe(true)
  })

  it('loads rights saved before rules as all allowed, with no agents key', () => {
    const old = { type: true, open: true }
    const r = cleanRights(old)
    expect(r).toEqual({ ...NO_RIGHTS, type: true, open: true })
    expect(Object.hasOwn(r, 'agents')).toBe(false)
    expect(agentAllowed(effectiveAgentRule(r.agents, null), 'claude')).toBe(true)
  })

  it('keeps a rule through cleanRights, setRight and sameRights', () => {
    const rule = setAgentAllowed(null, 'claude', false, HOST)
    const r = withAgents({ type: true }, rule)
    expect(cleanRights(r).agents).toEqual(rule)
    expect(setRight(r, 'open', true).agents).toEqual(rule)
    expect(sameRights(r, { ...r })).toBe(true)
    expect(sameRights(r, cleanRights({ type: true }))).toBe(false)
    expect(Object.hasOwn(withAgents(r, null), 'agents')).toBe(false)
  })

  it('cleans what a peer or a file gives: bad ids, sizes, "later" on unless exactly false', () => {
    const r = cleanAgentRule({ deny: ['claude', 'bad id', 'claude', 7], known: ['codex', '../x'], later: 'no', models: { claude: ['opus', 'with space', ''], 'b a d': ['x'], codex: 'gpt' }, extra: 1 })
    expect(r).toEqual({ deny: ['claude'], later: true, known: ['codex'], models: { claude: ['opus'] } })
    expect(cleanAgentRule({ deny: Array.from({ length: 200 }, (_, i) => `a${i}`) }).deny).toHaveLength(64)
  })

  it('takes a guest’s own rule over the share’s, and the share’s over none', () => {
    const share = setAgentAllowed(null, 'grok', false, HOST)
    const own = setAgentAllowed(null, 'claude', false, HOST)
    expect(effectiveAgentRule(null, share)).toEqual(share)
    expect(effectiveAgentRule(own, share)).toEqual(own)
    expect(effectiveAgentRule(null, null)).toBe(null)
  })
})

describe('agents rule: what it allows', () => {
  it('refuses a left-out agent and keeps the others', () => {
    const r = setAgentAllowed(null, 'claude', false, HOST)
    expect(agentAllowed(r, 'claude')).toBe(false)
    expect(agentAllowed(r, 'codex')).toBe(true)
    expect(agentAllowed(setAgentAllowed(r, 'claude', true, HOST), 'claude')).toBe(true)
  })

  it('limits models per agent; an empty model (not known yet) passes, an agent with no model left does not', () => {
    const r = setAgentModels(null, 'claude', ['sonnet', 'haiku'], HOST)
    expect(modelAllowed(r, 'claude', 'sonnet')).toBe(true)
    expect(modelAllowed(r, 'claude', 'SONNET')).toBe(true)
    expect(modelAllowed(r, 'claude', 'opus')).toBe(false)
    expect(modelAllowed(r, 'claude', '')).toBe(true)
    expect(modelAllowed(r, 'codex', 'anything')).toBe(true)
    expect(paneTypeAllowed(r, { agent: 'claude', model: 'opus' })).toBe(false)
    expect(paneTypeAllowed(r, { agent: null, model: '' })).toBe(true)
    expect(agentAllowed(setAgentModels(null, 'claude', [], HOST), 'claude')).toBe(false)
    expect(allowedModels(setAgentModels(r, 'claude', null, HOST), 'claude')).toBe(null)
  })

  it('lists for the guest’s menu only the allowed agents, with their allowed models', () => {
    const list = [
      { id: 'claude', name: 'Claude Code', models: [{ id: 'opus', label: 'Opus' }, { id: 'sonnet', label: 'Sonnet' }] },
      { id: 'codex', name: 'Codex', models: [{ id: 'gpt-5', label: 'GPT-5' }] },
      { id: 'grok', name: 'Grok' }
    ]
    let r = setAgentAllowed(null, 'codex', false, HOST)
    r = setAgentModels(r, 'claude', ['sonnet'], HOST)
    expect(agentsForGuest(r, list)).toEqual([
      { id: 'claude', name: 'Claude Code', models: [{ id: 'sonnet', label: 'Sonnet' }] },
      { id: 'grok', name: 'Grok' }
    ])
    expect(agentsForGuest(null, list).map((a) => a.id)).toEqual(['claude', 'codex', 'grok'])
    expect(agentsForGuest(null, list)[0].models).toBeUndefined()
  })
})

describe('agents rule: agents the host adds later', () => {
  it('allows a newly installed agent while "Allow agents I add later" is on', () => {
    const r = setAgentAllowed(null, 'claude', false, HOST)
    expect(r.later).toBe(true)
    expect(agentAllowed(r, 'gemini')).toBe(true)
  })

  it('refuses a newly installed agent while it is off, and keeps refusing it after another change', () => {
    const r = setAgentLater(null, false, HOST)
    expect(agentAllowed(r, 'claude')).toBe(true)
    expect(agentAllowed(r, 'gemini')).toBe(false)
    // Gemini installed since: a change to Claude does not let it in.
    const after = setAgentAllowed(r, 'claude', false, [...HOST, 'gemini'])
    expect(agentAllowed(after, 'gemini')).toBe(false)
    expect(agentAllowed(after, 'codex')).toBe(true)
    // Ticked by hand: allowed.
    expect(agentAllowed(setAgentAllowed(after, 'gemini', true, [...HOST, 'gemini']), 'gemini')).toBe(true)
    // "Later" back on: agents installed after that are allowed again.
    expect(agentAllowed(setAgentLater(after, true, [...HOST, 'gemini']), 'muse')).toBe(true)
  })

  it('compares rules by content', () => {
    const a = setAgentAllowed(null, 'claude', false, HOST)
    const b = cleanAgentRule({ ...a, known: [...a.known].reverse() })
    expect(sameAgentRule(a, b)).toBe(true)
    expect(sameAgentRule(a, null)).toBe(false)
    expect(sameAgentRule(null, undefined)).toBe(true)
  })
})

describe('agents rule: /model typed in a pane', () => {
  it('follows the typed line: keys, Backspace, Ctrl+C, escape sequences, Enter', () => {
    let s = followTypedLine('', '/mo')
    s = followTypedLine(s.line, 'dx\x7fel')
    expect(s).toEqual({ line: '/model', submitted: [] })
    s = followTypedLine(s.line, ' opus\x1b[D\r')
    expect(s.submitted).toEqual(['/model opus'])
    expect(s.line).toBe('')
    expect(followTypedLine('abc', '\x03x').line).toBe('x')
  })

  it('refuses a switch to a model left out, or the picker, only for an agent whose models are limited', () => {
    const r = setAgentModels(null, 'claude', ['sonnet'], HOST)
    expect(refusedModelSwitch(r, 'claude', '/model opus')).toBe(true)
    expect(refusedModelSwitch(r, 'claude', '/model')).toBe(true)
    expect(refusedModelSwitch(r, 'claude', '  /MODEL Sonnet')).toBe(false)
    expect(refusedModelSwitch(r, 'claude', 'explain /model opus')).toBe(false)
    expect(refusedModelSwitch(r, 'codex', '/model gpt-4')).toBe(false)
    expect(refusedModelSwitch(null, 'claude', '/model opus')).toBe(false)
  })
})
