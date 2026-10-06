// The "Agents use a separate browser session" choice: an agent-opened page's
// webview gets the agents' partition, a normal page the main one; the setting
// is off by default.
import { describe, it, expect } from 'vitest'
import { createWebview, MAIN_PARTITION, AGENT_PARTITION } from '../browser/pageHost'
import { DEFAULT_SETTINGS } from '../settings'

describe('browser session partition', () => {
  it('a normal page uses the main browser session', () => {
    expect(createWebview('about:blank').getAttribute('partition')).toBe(MAIN_PARTITION)
  })
  it('an agent page uses the agents\' separate session', () => {
    expect(createWebview('about:blank', AGENT_PARTITION).getAttribute('partition')).toBe(AGENT_PARTITION)
  })
  it('an unknown partition falls back to the main session', () => {
    expect(createWebview('about:blank', 'persist:somethingelse').getAttribute('partition')).toBe(MAIN_PARTITION)
  })
  it('agents share the one session by default', () => {
    expect(DEFAULT_SETTINGS.browserAgentSeparateSession).toBe(false)
  })
})
