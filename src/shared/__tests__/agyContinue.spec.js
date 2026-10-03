import { describe, it, expect } from 'vitest'
import { agyContinueLaunchArgs } from '../agyContinue'

describe('agyContinueLaunchArgs', () => {
  const file = 'C:\\Users\\Ann Lee\\AppData\\Roaming\\Tessel\\agy-continue\\11111111-2222-4333-8444-555555555555.md'
  it('points agy at the prompt file with its first-prompt flag', () => {
    const args = agyContinueLaunchArgs(file, 'powershell')
    expect(args.startsWith(' --prompt-interactive "Tessel: continue an earlier Antigravity IDE conversation.')).toBe(true)
    expect(args).toContain(`Read the file ${file},`)
    expect(args.endsWith('"')).toBe(true)
  })
  it('gives WSL its /mnt path', () => {
    expect(agyContinueLaunchArgs(file, 'wsl')).toContain('/mnt/c/Users/Ann Lee/AppData/Roaming/Tessel/agy-continue/')
  })
  it('refuses a path a shell could misread', () => {
    for (const bad of ['C:\\a\\$(x).md', 'C:\\a\\"b.md', 'C:\\a\\b&c.md', 'C:\\a\\%PATH%.md', 'C:\\a\\`b.md', 'relative.md', '', null])
      expect(agyContinueLaunchArgs(bad, 'powershell')).toBe('')
  })
})
