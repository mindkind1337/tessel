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
    // Cursor CLI's input line while its approval prompt waits.
    expect(detectApproval('Run this command?\n → Run (once) (y)\n\n → Waiting for decision (y/n/p)...')).toBe(true)
  })

  // Codex 0.160's menu after a Plan-mode turn, as its screen shows it.
  const planMenu = [
    '  2. Check the diff confirms exactly one added line and no other changes.',
    '─ Worked for 12s • 1:45 AM ──────────────────────────────────────────',
    '  Implement this plan?',
    '',
    '› 1. Yes, implement this plan           Switch to Default and start coding',
    '  2. Yes, clear context and implement  Start a fresh thread (current context: 2% used)',
    '  3. No, stay in Plan mode              Continue planning with the model',
    '',
    '  enter select · esc back'
  ]

  it("spots Codex's 'Implement this plan?' menu while it is open", () => {
    expect(detectApproval(planMenu.join('\n'))).toBe(true)
    expect(detectApproval(planMenu.join('\r\n') + '\n\n')).toBe(true)
    // Painted by cell diff, the text copy can lose its spaces.
    expect(detectApproval('Implementthisplan?\n3.No,stayinPlanmode\nenterselect·escback')).toBe(true)
  })

  it("does not count the plan menu once it is answered or only mentioned", () => {
    // Answered: the composer (or Codex's work) is under the menu's old text.
    expect(detectApproval([...planMenu, '', '› Ask Codex to do anything', '  ? for shortcuts'].join('\n'))).toBe(false)
    expect(detectApproval([...planMenu, '• Working (3s • esc to interrupt)'].join('\n'))).toBe(false)
    // An agent's answer that names the menu.
    expect(detectApproval('Codex asks "Implement this plan?" after a Plan-mode turn.')).toBe(false)
    expect(detectApproval('Implement this plan?\n  enter select · esc back')).toBe(false)
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
