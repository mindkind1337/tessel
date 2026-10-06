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

import { inheritsAgentSession, afterCookieImport } from '../browser/agentSession'
import { settings, resetSettings } from '../settings'

describe('a new pane from an agent page', () => {
  it('inherits the agents\' session from the page it came from', () => {
    expect(inheritsAgentSession({ kind: 'browser', agentSession: true })).toBe(true)
    expect(inheritsAgentSession({ kind: 'browser' })).toBe(false)
    expect(inheritsAgentSession(null)).toBe(false)
  })
})

describe('the first cookie import', () => {
  it('turns the separate agent session on, once', () => {
    resetSettings()
    expect(settings.browserAgentSeparateSession).toBe(false)
    expect(afterCookieImport(settings)).toBe(true)
    expect(settings.browserAgentSeparateSession).toBe(true)
    expect(settings.cookiesImportedOnce).toBe(true)
    // The user turns it off again: later imports leave it off.
    settings.browserAgentSeparateSession = false
    expect(afterCookieImport(settings)).toBe(false)
    expect(settings.browserAgentSeparateSession).toBe(false)
    resetSettings()
  })

  it('says nothing when it was already on', () => {
    resetSettings()
    settings.browserAgentSeparateSession = true
    expect(afterCookieImport(settings)).toBe(false)
    expect(settings.cookiesImportedOnce).toBe(true)
    resetSettings()
  })
})
