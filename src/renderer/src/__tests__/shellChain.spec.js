import { describe, it, expect } from 'vitest'
import { chainCommands, describeSteps, installChain, MARK_OK, MARK_FAILED } from '../shellChain'

describe('installChain', () => {
  it('Windows PowerShell and pwsh: a marker for success, one for each failure', () => {
    const line = installChain(['npm i -g a', 'setup-a'], 'a', 'powershell')
    expect(line).toBe(
      "npm i -g a; if ($?) { setup-a; if ($?) { Write-Host ('TESSEL-INSTALL' + '-OK'); a } else { Write-Host ('TESSEL-INSTALL' + '-FAILED') } } else { Write-Host ('TESSEL-INSTALL' + '-FAILED') }"
    )
    expect(installChain(['x'], null, 'pwsh')).toBe("x; if ($?) { Write-Host ('TESSEL-INSTALL' + '-OK') } else { Write-Host ('TESSEL-INSTALL' + '-FAILED') }")
  })
  it('cmd, bash, wsl: && then || for the failure', () => {
    expect(installChain(['npm i -g a'], 'a', 'cmd')).toBe('npm i -g a && echo TESSEL-INSTALL^-OK && a || echo TESSEL-INSTALL^-FAILED')
    expect(installChain(['npm i -g a'], '', 'gitbash')).toBe('npm i -g a && echo TESSEL-INSTALL"-OK" || echo TESSEL-INSTALL"-FAILED"')
  })
  it('the typed line never contains a marker (only running it prints one)', () => {
    for (const shell of ['powershell', 'pwsh', 'cmd', 'gitbash', 'wsl']) {
      const line = installChain(['npm i -g a'], 'a', shell)
      expect(line).not.toContain(MARK_OK)
      expect(line).not.toContain(MARK_FAILED)
    }
  })
})

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
