import { describe, it, expect } from 'vitest'
import { detectLimit, detectApproval, detectTaskDone } from '../agentLimit'

describe('detectLimit', () => {
  it('spots Codex hitting its limit and the reset time', () => {
    const screen = `■ You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit
https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 8:47 PM.`
    expect(detectLimit(screen)).toEqual({ reset: '8:47 PM' })
  })

  it('spots Claude Code limits', () => {
    expect(detectLimit('Claude usage limit reached. Your limit will reset at 5pm')).toEqual({
      reset: '5pm'
    })
    expect(detectLimit('5-hour limit reached ∙ resets 3pm (America/Toronto)')).toEqual({
      reset: '3pm'
    })
    expect(detectLimit('Weekly limit reached · resets Oct 3, 9am')).toEqual({ reset: 'Oct 3, 9am' })
  })

  it('spots Gemini quota errors', () => {
    expect(detectLimit('Error: Quota exceeded for quota metric')).toEqual({ reset: '' })
    expect(detectLimit('You have exhausted your daily quota on this model.')).toEqual({ reset: '' })
  })

  it('reads relative reset times', () => {
    expect(detectLimit("You've hit your usage limit. Try again in 2 days 3 hours.")).toEqual({
      reset: 'in 2 days 3 hours'
    })
  })

  it('ignores an agent merely talking about limits', () => {
    expect(detectLimit('I can detect when the other agent hits its usage limit.')).toBeNull()
    expect(detectLimit('Rate limits apply to the API; see the docs.')).toBeNull()
    expect(detectLimit('')).toBeNull()
  })
})

describe('detectApproval', () => {
  it('spots approval prompts', () => {
    expect(detectApproval('  Would you like to run the following command?\n  $ npm ci')).toBe(true)
    expect(detectApproval('Do you want to proceed?\n❯ 1. Yes')).toBe(true)
    expect(detectApproval('Press enter to confirm or esc to cancel')).toBe(true)
  })

  it('ignores ordinary output', () => {
    expect(detectApproval('Ran npm test: 120 passed')).toBe(false)
    expect(detectApproval('')).toBe(false)
  })
})

describe('trust prompts and the task signal', () => {
  it('treats a "do you trust this folder" screen as an approval', () => {
    expect(detectApproval('Do you trust the files in this folder?\n❯ 1. Yes, proceed')).toBe(true)
    expect(detectApproval('Do you trust the contents of this directory?')).toBe(true)
  })

  it('spots TASK_COMPLETE, not the instruction that spells it in parts', () => {
    expect(detectTaskDone('All tests pass.\nTASK_COMPLETE')).toBe(true)
    expect(detectTaskDone('● TASK_COMPLETE.')).toBe(true)
    expect(detectTaskDone('end with the words TASK and COMPLETE joined by an underscore')).toBe(false)
    expect(detectTaskDone('MY_TASK_COMPLETED_FLAG')).toBe(false)
  })
})

describe('the task signal must stand alone on its line', () => {
  it('ignores a sentence that mentions it', () => {
    expect(detectTaskDone('I will print TASK_COMPLETE when finished.')).toBe(false)
    expect(detectTaskDone('Next: tests, then TASK_COMPLETE')).toBe(false)
  })
  it('accepts it alone, with a bullet or a period', () => {
    expect(detectTaskDone('Tests pass.\n⏺ TASK_COMPLETE')).toBe(true)
    expect(detectTaskDone('  TASK_COMPLETE.  ')).toBe(true)
  })
})
