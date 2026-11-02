import { describe, it, expect } from 'vitest'
import { withoutYolo, YOLO_ARGS, parseEnvText, effectiveAgent, agentEnabled, inYoloFolder, sameFolder, launchPermissions, launchIsYolo } from '../../../shared/agentPrefs'

const claude = { id: 'claude', command: 'claude' }
const goose = { id: 'goose', command: 'goose' }

describe('per-agent settings', () => {
  it('reads NAME=value lines; refuses bad names and Tessel’s own variables', () => {
    expect(parseEnvText('# a comment\nFOO=bar baz\n\nX_1= y ')).toEqual({ env: { FOO: 'bar baz', X_1: 'y' } })
    expect(parseEnvText('1BAD=x').error).toMatch(/not a valid variable name/)
    expect(parseEnvText('no equals').error).toMatch(/NAME=value/)
    expect(parseEnvText('TESSEL_PANE_ID=x').error).toMatch(/set by Tessel/)
    expect(parseEnvText('A='.padEnd(20000, 'x')).error).toMatch(/too large/)
  })

  it('Manual adds nothing; Yolo adds the agent’s own flag, unless you set arguments', () => {
    expect(effectiveAgent(claude, {}, 'manual')).toEqual({ command: 'claude', args: '', env: {} })
    expect(effectiveAgent(claude, {}, 'yolo').args).toBe('--dangerously-skip-permissions')
    expect(effectiveAgent(claude, { claude: { args: '--model sonnet' } }, 'yolo').args).toBe('--model sonnet')
    expect(effectiveAgent(goose, {}, 'yolo').env).toEqual({ GOOSE_MODE: 'auto' })
    expect(effectiveAgent({ id: 'unknown', command: 'x' }, {}, 'yolo').args).toBe('')
  })

  it('a command of your own and variables; turned off agents are not offered', () => {
    const prefs = { claude: { command: 'C:\\tools\\claude.cmd', env: 'ANTHROPIC_MODEL=x', enabled: false } }
    expect(effectiveAgent(claude, prefs, 'manual')).toEqual({ command: 'C:\\tools\\claude.cmd', args: '', env: { ANTHROPIC_MODEL: 'x' } })
    expect(agentEnabled(prefs, 'claude')).toBe(false)
    expect(agentEnabled(prefs, 'codex')).toBe(true)
  })
})

import { launchSignature, launchIsYolo } from '../../../shared/agentPrefs'
describe('how an agent was launched', () => {
  it('Yolo is seen from its flag or its variables; the signature changes with the settings', () => {
    const manual = effectiveAgent(claude, {}, 'manual')
    const yolo = effectiveAgent(claude, {}, 'yolo')
    expect(launchIsYolo('claude', manual)).toBe(false)
    expect(launchIsYolo('claude', yolo)).toBe(true)
    expect(launchIsYolo('goose', effectiveAgent(goose, {}, 'yolo'))).toBe(true)
    expect(launchSignature(manual)).not.toBe(launchSignature(yolo))
    expect(launchSignature(yolo)).toBe(launchSignature(effectiveAgent(claude, {}, 'yolo')))
    // Your own arguments replace Yolo's: not Yolo, and a new signature.
    const own = effectiveAgent(claude, { claude: { args: '--model sonnet' } }, 'yolo')
    expect(launchIsYolo('claude', own)).toBe(false)
    expect(launchSignature(own)).not.toBe(launchSignature(yolo))
    // Variables in any order give the same signature.
    expect(launchSignature({ command: 'x', args: '', env: { B: '1', A: '2' } })).toBe(launchSignature({ command: 'x', args: '', env: { A: '2', B: '1' } }))
  })
})

describe('Yolo folders and a pane\'s own permission mode', () => {
  it('a folder, and folders inside it, count; others do not', () => {
    const folders = ['C:\\Users\\me\\Waveshield\\']
    expect(inYoloFolder('C:\\Users\\me\\Waveshield', folders)).toBe(true)
    expect(inYoloFolder('c:/users/me/waveshield/src', folders)).toBe(true)
    expect(inYoloFolder('C:\\Users\\me\\Waveshield2', folders)).toBe(false)
    expect(inYoloFolder('', folders)).toBe(false)
    expect(sameFolder('C:\\A\\', 'c:/a')).toBe(true)
  })
  it('the pane\'s choice wins, then a Yolo folder, then Settings > Agents', () => {
    const folders = ['C:\\Waveshield']
    expect(launchPermissions(null, ['C:\\Other'], folders, 'manual')).toBe('manual')
    expect(launchPermissions(null, [null, 'C:\\Waveshield\\app'], folders, 'manual')).toBe('yolo')
    expect(launchPermissions('manual', ['C:\\Waveshield'], folders, 'yolo')).toBe('manual')
    expect(launchPermissions('yolo', ['C:\\Other'], [], 'manual')).toBe('yolo')
    expect(launchPermissions('bogus', 'C:\\Other', [], 'yolo')).toBe('yolo')
  })
  it('Claude Code started by hand with --dangerously-skip-permissions counts as Yolo', () => {
    const cmd = '"C:\\npm\\claude-code\\bin\\claude.exe"    --continue --dangerously-skip-permissions'
    expect(launchIsYolo('claude', { args: cmd })).toBe(true)
    expect(launchIsYolo('claude', { args: '"claude.exe" --resume abc' })).toBe(false)
  })

  it('N3: on a first start nothing skips approvals: every agent, its flag alone or among others', () => {
    for (const [id, flag] of Object.entries(YOLO_ARGS)) {
      const agent = { id, command: id }
      expect(effectiveAgent(agent, { [id]: { args: flag } }, 'manual', null, null, { firstStart: true }).args).toBe('')
      expect(effectiveAgent(agent, { [id]: { args: '--keep ' + flag + ' --also' } }, 'manual', null, null, { firstStart: true }).args).toBe('--keep --also')
      expect(effectiveAgent(agent, {}, 'manual', null, null, { firstStart: true }).args).toBe('')
    }
  })

  it('N3: and it is only on a first start: your own arguments stay what they are otherwise', () => {
    expect(effectiveAgent(claude, { claude: { args: '--dangerously-skip-permissions' } }, 'manual').args).toBe('--dangerously-skip-permissions')
  })

  it('N3: a variable that does what the flag does goes too; what is not about it stays', () => {
    const prefs = { goose: { env: 'GOOSE_MODE=auto\nOTHER=x' } }
    expect(effectiveAgent(goose, prefs, 'manual', null, null, { firstStart: true }).env).toEqual({ OTHER: 'x' })
    expect(effectiveAgent(goose, prefs, 'manual').env).toEqual({ GOOSE_MODE: 'auto', OTHER: 'x' })
  })

  it('N3: the other ways of saying it', () => {
    for (const text of ['--permission-mode bypassPermissions', '--permission-mode=bypassPermissions', '--allow-dangerously-skip-permissions', '--approval-mode=yolo', '--yolo', '--full-auto', '--sandbox danger-full-access', '-s danger-full-access', '--ask-for-approval never', '-a never']) {
      expect(withoutYolo('codex', '--keep ' + text)).toBe('--keep')
    }
    expect(withoutYolo('gemini', '-y --keep')).toBe('--keep')
    expect(withoutYolo('claude', '-y --keep')).toBe('-y --keep')
    expect(withoutYolo('claude', '--permission-mode plan --model opus')).toBe('--permission-mode plan --model opus')
  })

  it('N3: a whole flag, never the start of a longer one of yours', () => {
    expect(withoutYolo('cline', '--auto-approve true --keep')).toBe('--keep')
    expect(withoutYolo('cline', '--auto-approve false --keep')).toBe('--auto-approve false --keep')
    expect(withoutYolo('opencode', '--auto --keep')).toBe('--keep')
    expect(withoutYolo('opencode', '--autoupdate --keep')).toBe('--autoupdate --keep')
    expect(withoutYolo('droid', '--auto high --keep')).toBe('--keep')
    expect(withoutYolo('droid', '--auto medium --keep')).toBe('--keep')
    expect(withoutYolo('claude', '--yolo-not --keep')).toBe('--yolo-not --keep')
    expect(withoutYolo('claude', 'some--yolo --keep')).toBe('some--yolo --keep')
  })

  it('N3: quoted, with others right beside it, it goes as well', () => {
    expect(withoutYolo('claude', '"--dangerously-skip-permissions" --keep')).toBe('--keep')
    expect(withoutYolo('claude', "'--dangerously-skip-permissions' --keep")).toBe('--keep')
    expect(withoutYolo('claude', '--yolo --dangerously-skip-permissions --keep --full-auto --yolo')).toBe('--keep')
    expect(withoutYolo('qwen', '--approval-mode   yolo --keep')).toBe('--keep')
    expect(withoutYolo('codex', '--sandbox --yolo danger-full-access --keep')).toBe('--keep')
  })

  it('N3: the same thing, said through what the agent reads as settings', () => {
    expect(withoutYolo('codex', '-c approval_policy=never --keep')).toBe('--keep')
    expect(withoutYolo('codex', '--config "approval_policy=never" --keep')).toBe('--keep')
    expect(withoutYolo('codex', '-c sandbox_mode="danger-full-access" --keep')).toBe('--keep')
    expect(withoutYolo('codex', '-c model=x --keep')).toBe('-c model=x --keep')
    expect(withoutYolo('devin', '--respect-workspace-trust false --keep')).toBe('--keep')
    expect(withoutYolo('continue', '--allow * --keep')).toBe('--keep')
    expect(withoutYolo('continue', "--allow '*' --keep")).toBe('--keep')
    expect(withoutYolo('continue', '--allow Read --keep')).toBe('--allow Read --keep')
    expect(withoutYolo('aider', '--yes --keep')).toBe('--keep')
  })

  it('a Yolo pane of Claude Code starts with --dangerously-skip-permissions', () => {
    const agent = { id: 'claude', command: 'claude' }
    const mode = launchPermissions('yolo', [], [], 'manual')
    expect(effectiveAgent(agent, {}, mode).args).toBe('--dangerously-skip-permissions')
  })
})
