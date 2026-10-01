// @vitest-environment node
// The permission mode a terminal agent's hook reports: the same lists in the
// hook script (it runs outside the application) and here, and the check the
// main process runs again on what it reads.
import { describe, expect, it } from 'vitest'
import { createRequire } from 'module'
import { join } from 'path'
import { MODE_PROVIDERS, PERMISSION_MODES, eventPermissionMode, validPermissionMode } from '../agentPermissionMode'

const require = createRequire(import.meta.url)
const server = require(join(__dirname, '..', '..', 'main', 'teamMcp', 'server.cjs'))

describe('the permission mode of a hook event', () => {
  it('the hook script keeps the same values and agents', () => {
    expect(server.PERMISSION_MODES).toEqual(PERMISSION_MODES)
    expect(server.MODE_PROVIDERS).toEqual(MODE_PROVIDERS)
  })
  it('only a known value', () => {
    for (const mode of PERMISSION_MODES) expect(validPermissionMode(mode)).toBe(mode)
    for (const bad of ['', 'yolo', 'Default', 'default ', 42, null, undefined, { mode: 'plan' }]) expect(validPermissionMode(bad)).toBeNull()
  })
  it("only a lead's, of an agent with a chat view", () => {
    expect(eventPermissionMode({ provider: 'claude', permissionMode: 'plan' })).toBe('plan')
    expect(eventPermissionMode({ provider: 'codex', permissionMode: 'bypassPermissions' })).toBe('bypassPermissions')
    expect(eventPermissionMode({ provider: 'openclaude', permissionMode: 'acceptEdits' })).toBe('acceptEdits')
    expect(eventPermissionMode({ provider: 'claude', agentId: 'child-1', permissionMode: 'plan' })).toBeNull()
    expect(eventPermissionMode({ provider: 'gemini', permissionMode: 'plan' })).toBeNull()
    expect(eventPermissionMode({ provider: 'claude', permissionMode: 'rm -rf' })).toBeNull()
    expect(eventPermissionMode({ provider: 'claude' })).toBeNull()
    expect(eventPermissionMode(null)).toBeNull()
  })
})
