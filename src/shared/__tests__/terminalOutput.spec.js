import { describe, it, expect } from 'vitest'
import {
  detectsCommonPromptPattern,
  detectsHighConfidenceInputPattern,
  detectsSensitiveInputPrompt,
  inputNeeded,
  stripCommandEchoAndPrompt,
  truncateLargeOutput,
  truncateOutputKeepingTail,
  getLastLine,
  MAX_OUTPUT_LENGTH
} from '../terminalOutput'

describe('prompts', () => {
  it('knows the common shell prompts', () => {
    for (const p of ['PS C:\\Users\\me> ', 'C:\\proj>', 'me@box:~/x$ ', 'root@box:/# ', '>>> ', '~/x ❯ ', 'zsh% ']) expect(detectsCommonPromptPattern(p)).toBe(true)
    expect(detectsCommonPromptPattern('Compiling 12 files...')).toBe(false)
    expect(detectsCommonPromptPattern('   ')).toBe(false)
  })
})

describe('a program waiting for an answer', () => {
  it('high-confidence questions (trailing space: the cursor waits)', () => {
    for (const l of ['Continue? (y/n) ', 'Overwrite [Y/n] ', 'package name: (demo) ', '(END)', 'Password:', 'Press any key to continue', '? Pick a color › ', '[Y] Yes  [N] No  [?] Help (default is "Y"): '])
      expect(detectsHighConfidenceInputPattern(l)).toBe(true)
    expect(detectsHighConfidenceInputPattern('Build finished (y/n)')).toBe(false)
    expect(detectsHighConfidenceInputPattern('➜  repo git:(main) ')).toBe(false)
  })
  it('a secret is never answered by the agent', () => {
    expect(detectsSensitiveInputPrompt('Enter passphrase for key /home/me/.ssh/id: ')).toBe(true)
    expect(detectsSensitiveInputPrompt('[sudo] password for me: ')).toBe(true)
    expect(inputNeeded('[sudo] password for me: ')).toBe('sensitive')
    expect(inputNeeded('[sudo] password for me:', { command: 'echo x | sudo -S ls' })).toBe('input')
    expect(inputNeeded('Continue? (y/n) ')).toBe('input')
    expect(inputNeeded('Press h + enter to show help')).toBe(null)
    // Broad patterns only while the command is known to run.
    expect(inputNeeded('Your name: ')).toBe(null)
    expect(inputNeeded('Your name: ', { running: true })).toBe('input')
  })
})

describe('the output of a command', () => {
  it('drops the echoed command line and the next prompt', () => {
    expect(stripCommandEchoAndPrompt('PS C:\\p> echo hi\nhi\nPS C:\\p> ', 'echo hi')).toBe('hi')
    expect(stripCommandEchoAndPrompt('me@box:~$ ls\na\nb\nme@box:~$ ', 'ls')).toBe('a\nb')
    // A long command wrapped over two lines.
    const cmd = 'echo ' + 'x'.repeat(30)
    expect(stripCommandEchoAndPrompt(`me@box:~$ ${cmd.slice(0, 20)}\n${cmd.slice(20)}\n${'y'.repeat(30)}\nme@box:~$ `, cmd)).toBe('y'.repeat(30))
    expect(stripCommandEchoAndPrompt('out only', 'zzz')).toBe('out only')
  })
  it('keeps a large output\'s start and tail, and the file it went to', () => {
    const big = 'A'.repeat(600) + 'B'.repeat(50000) + 'THE END'
    const r = truncateLargeOutput(big, 'C:\\tmp\\o.txt')
    expect(r.length).toBeLessThanOrEqual(MAX_OUTPUT_LENGTH)
    expect(r).toContain('Full output saved to: C:\\tmp\\o.txt')
    expect(r.endsWith('THE END')).toBe(true)
    expect(r).toContain('[... middle of output truncated ...]')
    expect(truncateOutputKeepingTail('abcdef', 100)).toBe('abcdef')
    expect(truncateOutputKeepingTail('x'.repeat(9000), 8000)).toMatch(/^\n\n\[\.\.\. PREVIOUS OUTPUT TRUNCATED \.\.\.\]/)
    expect(getLastLine('a\nb\r\n')).toBe('b')
  })
})
