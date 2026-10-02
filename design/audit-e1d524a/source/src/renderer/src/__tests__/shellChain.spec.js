import { describe, it, expect } from 'vitest'
import { chainCommands, describeSteps } from '../shellChain'

describe('chainCommands', () => {
  it('returns a single step unchanged', () => {
    expect(chainCommands(['npm install -g x'], 'cmd')).toBe('npm install -g x')
    expect(chainCommands('copilot', 'powershell')).toBe('copilot')
  })
  it('uses && for cmd, pwsh, bash and wsl', () => {
    for (const shell of ['cmd', 'pwsh', 'gitbash', 'wsl']) {
      expect(chainCommands(['a', 'b', 'c'], shell)).toBe('a && b && c')
    }
  })
  it('nests if ($?) for Windows PowerShell 5.1', () => {
    expect(chainCommands(['a', 'b'], 'powershell')).toBe('a; if ($?) { b }')
    expect(chainCommands(['a', 'b', 'c'], 'powershell')).toBe('a; if ($?) { b; if ($?) { c } }')
  })
  it('ignores empty steps', () => {
    expect(chainCommands(['', 'a', '  ', 'b'], 'cmd')).toBe('a && b')
    expect(chainCommands([], 'cmd')).toBe('')
  })
})

describe('describeSteps', () => {
  it('reads naturally', () => {
    expect(describeSteps(['python -m pip install aider-install', 'aider-install'])).toBe(
      'python -m pip install aider-install, then aider-install'
    )
  })
})
