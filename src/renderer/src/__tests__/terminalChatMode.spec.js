// The permission mode picker of a terminal agent's chat view: the mode it
// started in, the one shown, Claude Code's footer, and Shift+Tab one press at
// a time (src/renderer/src/chat/terminalChatBridge.js).
import { describe, expect, it, vi } from 'vitest'
import {
  KEY_SHIFT_TAB,
  canCycleToYolo,
  launchArgsOf,
  launchPermissionMode,
  permissionModeFromScreen,
  shownPermissionMode,
  stepToPermissionMode
} from '../chat/terminalChatBridge.js'

const sig = (args) => JSON.stringify(['claude', args, []])

describe('the mode a pane started in', () => {
  it('reads its launch arguments from its launch signature, nothing on a broken one', () => {
    expect(launchArgsOf({ launchSig: sig('--model opus --dangerously-skip-permissions') })).toBe('--model opus --dangerously-skip-permissions')
    expect(launchArgsOf({ launchSig: '{broken' })).toBe('')
    expect(launchArgsOf({ launchSig: 'x'.repeat(20001) })).toBe('')
    expect(launchArgsOf({})).toBe('')
  })
  it('Claude Code and OpenClaude: Yolo, a --permission-mode of your own, else default', () => {
    expect(launchPermissionMode({ agentId: 'claude', launchYolo: true })).toBe('bypassPermissions')
    expect(launchPermissionMode({ agentId: 'claude', permissions: 'yolo' })).toBe('bypassPermissions')
    expect(launchPermissionMode({ agentId: 'openclaude', launchSig: sig('--dangerously-skip-permissions') })).toBe('bypassPermissions')
    expect(launchPermissionMode({ agentId: 'claude', launchSig: sig('--permission-mode plan') })).toBe('plan')
    expect(launchPermissionMode({ agentId: 'claude', launchSig: sig('--permission-mode=acceptEdits') })).toBe('acceptEdits')
    expect(launchPermissionMode({ agentId: 'claude', launchSig: sig('--permission-mode bogus') })).toBe('default')
    expect(launchPermissionMode({ agentId: 'claude' })).toBe('default')
    expect(launchPermissionMode(null)).toBe('default')
  })
  it('Codex: its bypass flag (Yolo), else default', () => {
    expect(launchPermissionMode({ agentId: 'codex', launchYolo: true })).toBe('bypassPermissions')
    expect(launchPermissionMode({ agentId: 'codex', launchSig: JSON.stringify(['codex', '--dangerously-bypass-approvals-and-sandbox', []]) })).toBe('bypassPermissions')
    expect(launchPermissionMode({ agentId: 'codex', launchSig: sig('--permission-mode plan') })).toBe('default')
  })
  it('Shift+Tab reaches Yolo only in a session started able to use it', () => {
    expect(canCycleToYolo({ agentId: 'claude', launchYolo: true })).toBe(true)
    expect(canCycleToYolo({ agentId: 'claude', launchSig: sig('--allow-dangerously-skip-permissions') })).toBe(true)
    expect(canCycleToYolo({ agentId: 'claude', launchSig: sig('--permission-mode bypassPermissions') })).toBe(true)
    expect(canCycleToYolo({ agentId: 'claude', launchSig: sig('--model opus') })).toBe(false)
    expect(canCycleToYolo({ agentId: 'codex', launchYolo: true })).toBe(false)
  })
})

describe('the mode shown', () => {
  it('the newer of the hook and what Tessel saw on screen; before either, the launch', () => {
    expect(shownPermissionMode({ launchMode: 'bypassPermissions' })).toBe('bypassPermissions')
    expect(shownPermissionMode({ hookMode: 'plan', hookAt: 10, launchMode: 'bypassPermissions' })).toBe('plan')
    expect(shownPermissionMode({ hookMode: 'plan', hookAt: 10, localMode: 'acceptEdits', localAt: 20 })).toBe('acceptEdits')
    // You pressed Shift+Tab in the terminal since: the hook's later word wins.
    expect(shownPermissionMode({ hookMode: 'default', hookAt: 30, localMode: 'acceptEdits', localAt: 20 })).toBe('default')
    expect(shownPermissionMode({ hookMode: 'evil', hookAt: 30, launchMode: 'nope' })).toBe('default')
  })
})

describe("Claude Code's footer", () => {
  it('reads the mode from the last lines only', () => {
    expect(permissionModeFromScreen('> \n  ⏵⏵ accept edits on (shift+tab to cycle)')).toBe('acceptEdits')
    expect(permissionModeFromScreen('\x1b[38;2;255;107;128m⏵⏵ bypass permissions on \x1b[38;2;153;153;153m(shift+tab to cycle)\x1b[0m')).toBe('bypassPermissions')
    expect(permissionModeFromScreen('  ⏸ plan mode on (shift+tab to cycle)\n  ctx 40%')).toBe('plan')
    expect(permissionModeFromScreen('⏵⏵ auto mode on')).toBe('auto')
    expect(permissionModeFromScreen("⏵⏵ don't ask on")).toBe('dontAsk')
    expect(permissionModeFromScreen('> \n  ? for shortcuts')).toBe('default')
    // In a message, not the footer: not a mode.
    expect(permissionModeFromScreen('I turned plan mode on earlier\n> \n  ? for shortcuts')).toBe('default')
    expect(permissionModeFromScreen('  ⏸ plan mode on\n1\n2\n3\n4')).toBe('default')
  })
})

describe('Shift+Tab one press at a time', () => {
  // A fake Claude Code: each press moves its footer along its cycle.
  function fakeAgent(cycle, start = cycle[0], { lagPresses = 0 } = {}) {
    let i = cycle.indexOf(start)
    let ignored = lagPresses
    const press = vi.fn(() => {
      if (ignored > 0) ignored--
      else i = (i + 1) % cycle.length
    })
    let clock = 0
    return {
      press,
      read: () => cycle[i],
      sleep: async (ms) => {
        clock += ms
      },
      now: () => clock
    }
  }
  const CYCLE = ['default', 'acceptEdits', 'plan']

  it('reaches the target, checking the screen after each press', async () => {
    const agent = fakeAgent(CYCLE)
    const res = await stepToPermissionMode({ target: 'plan', ...agent })
    expect(res).toEqual({ ok: true, mode: 'plan', presses: 2 })
    expect(agent.press).toHaveBeenCalledTimes(2)
    expect(KEY_SHIFT_TAB).toBe('\x1b[Z')
  })
  it('nothing to press when it is there already', async () => {
    const agent = fakeAgent(CYCLE, 'plan')
    expect(await stepToPermissionMode({ target: 'plan', ...agent })).toEqual({ ok: true, mode: 'plan', presses: 0 })
    expect(agent.press).not.toHaveBeenCalled()
  })
  it('stops when the cycle comes back where it started (the mode is not in it)', async () => {
    const agent = fakeAgent(CYCLE, 'acceptEdits')
    const res = await stepToPermissionMode({ target: 'auto', ...agent })
    expect(res).toMatchObject({ ok: false, code: 'unavailable', mode: 'acceptEdits', presses: 3 })
  })
  it('never presses more than the cap', async () => {
    const long = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'target']
    const agent = fakeAgent(long, 'a')
    const res = await stepToPermissionMode({ target: 'target', ...agent, maxPresses: 6 })
    expect(res).toMatchObject({ ok: false, code: 'cap', presses: 6 })
    expect(agent.press).toHaveBeenCalledTimes(6)
  })
  it('a press that changes nothing on screen within its time: stops (unconfirmed)', async () => {
    const agent = fakeAgent(CYCLE, 'default', { lagPresses: 1 })
    const res = await stepToPermissionMode({ target: 'plan', ...agent, stepTimeoutMs: 500 })
    expect(res).toMatchObject({ ok: false, code: 'unconfirmed', mode: 'default', presses: 1 })
  })
  it('stops after its time in all', async () => {
    let clock = 0
    let i = 0
    const modes = ['a', 'b', 'c', 'd', 'e']
    const res = await stepToPermissionMode({
      target: 'zzz',
      read: () => modes[i],
      press: () => {
        clock += 3000
        i++
      },
      now: () => clock,
      sleep: async () => {},
      timeoutMs: 8000
    })
    expect(res).toMatchObject({ ok: false, code: 'timeout', presses: 3 })
  })
  it('checks before each press that no key may land elsewhere (a line typed, an approval)', async () => {
    const agent = fakeAgent(CYCLE)
    const blocked = vi.fn().mockReturnValueOnce('').mockReturnValueOnce('A line is typed')
    const res = await stepToPermissionMode({ target: 'plan', ...agent, blocked })
    expect(res).toEqual({ ok: false, code: 'blocked', error: 'A line is typed', mode: 'acceptEdits', presses: 1 })
    expect(agent.press).toHaveBeenCalledTimes(1)
  })
})
