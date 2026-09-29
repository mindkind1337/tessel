import { describe, it, expect, vi } from 'vitest'
import { resumeArgs, safeSessionId, OWN_ID_AGENTS } from '../agentResumeLine'

const U = '11111111-2222-4333-8444-555555555555'
const api = (target) => ({ agentResumeTarget: vi.fn().mockResolvedValue(target) })

describe('resume arguments', () => {
  it('are argument arrays from the vendored table, checked by the main process first', async () => {
    expect(await resumeArgs('droid', U, api({}))).toEqual(['--resume', U])
    expect(await resumeArgs('grok', U, api({}))).toEqual(['--resume', U])
    expect(await resumeArgs('devin', 'devin-abc123', api({}))).toEqual(['--resume', 'devin-abc123'])
    expect(await resumeArgs('zcode', 'zc_123456', api({}))).toEqual(['--resume', 'zc_123456'])
    expect(await resumeArgs('antigravity', U, api({}))).toEqual(['--conversation', U])
    expect(await resumeArgs('kimi', 'session_abc123', api({}))).toEqual(['--session', 'session_abc123'])
    expect(await resumeArgs('opencode', 'ses_abcdef', api({}))).toEqual(['--session', 'ses_abcdef'])
    expect(await resumeArgs('copilot', U, api({}))).toEqual([`--resume=${U}`])
    expect(await resumeArgs('cline', '1790450764736_xww6d', api({}))).toEqual(['--id', '1790450764736_xww6d'])
    expect(await resumeArgs('cursor', U, api({}))).toEqual(['--resume', U])
    expect(await resumeArgs('pi', U, api({ transcriptPath: 'C:/Users/x/.pi/agent/sessions/--C--P--/a.jsonl' }))).toEqual([
      '--session',
      'C:/Users/x/.pi/agent/sessions/--C--P--/a.jsonl'
    ])
  })
  it('start fresh when there is nothing to resume or anything is unsafe', async () => {
    expect(await resumeArgs('droid', U, api(null))).toBe(null)
    expect(await resumeArgs('pi', U, api({}))).toBe(null) // Pi needs its file
    expect(await resumeArgs('pi', U, api({ transcriptPath: 'C:/a b/x.jsonl' }))).toBe(null)
    expect(await resumeArgs('pi', U, api({ transcriptPath: 'C:/x.jsonl; calc' }))).toBe(null)
    expect(await resumeArgs('droid', 'a b; rm', api({}))).toBe(null)
    expect(await resumeArgs('droid', '--help-me', api({}))).toBe(null)
    expect(await resumeArgs('claude', U, api({}))).toBe(null) // not this helper's
    expect(await resumeArgs('droid', U, {})).toBe(null) // older main: cannot check
    expect(await resumeArgs('opencode', 'ses_abcdef', {})).toEqual(['--session', 'ses_abcdef'])
  })
  it('ids', () => {
    expect(safeSessionId(U)).toBe(true)
    expect(safeSessionId('-flag')).toBe(false)
    expect(OWN_ID_AGENTS).toContain('zcode')
  })
})
