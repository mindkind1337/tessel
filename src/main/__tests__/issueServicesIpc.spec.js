// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
vi.mock('../githubService', () => ({ createGithubService: vi.fn() }))
vi.mock('../linearService', () => ({ createLinearService: vi.fn() }))
import { registerIssueServices } from '../issueServicesIpc'

describe('issue integration IPC boundary', () => {
  it('records only successful PR creation and never fails a created PR when statistics fail', async () => {
    const handlers = new Map()
    const onPrCreated = vi.fn(async () => {
      throw new Error('Statistics unavailable')
    })
    const createPr = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: 'Not created' })
      .mockResolvedValueOnce({ ok: true, url: 'https://github.com/o/r/pull/9' })
    registerIssueServices({
      ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
      github: { createPr },
      linear: {},
      onPrCreated
    })
    expect((await handlers.get('github:createPr')(null, {})).ok).toBe(false)
    expect(onPrCreated).not.toHaveBeenCalled()
    expect((await handlers.get('github:createPr')(null, {})).ok).toBe(true)
    expect(onPrCreated).toHaveBeenCalledExactlyOnceWith('https://github.com/o/r/pull/9')
  })
  it('registers explicit methods and forwards a click request without exposing arbitrary execution', async () => {
    const handlers = new Map()
    const createPr = vi.fn(async (query) => ({
      ok: true,
      url: `https://github.com/o/r/pull/${query.number || 9}`
    }))
    const connect = vi.fn(async () => ({ ok: true, configured: true }))
    registerIssueServices({
      ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
      github: { createPr },
      linear: { connect }
    })
    expect(handlers.has('github:exec')).toBe(false)
    expect(handlers.has('linear:graphql')).toBe(false)
    expect(handlers.size).toBe(17) // github: +failingLogs, +reviewThreads (read only)
    const query = {
      cwd: 'C:/project/copy',
      title: 'Fix navigation',
      body: 'Checks passed.',
      draft: true
    }
    expect(await handlers.get('github:createPr')(null, query)).toMatchObject({ ok: true })
    expect(createPr).toHaveBeenCalledWith(query)
    expect(connect).not.toHaveBeenCalled()
    expect(await handlers.get('linear:connect')(null, { key: 'private-test-key' })).toEqual({
      ok: true,
      configured: true
    })
    expect(connect).toHaveBeenCalledWith({ key: 'private-test-key' })
  })
  it('never returns an unexpected credential-bearing exception from a service', async () => {
    const handlers = new Map()
    const error = new Error('Authorization: lin_api_private-test-key')
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      registerIssueServices({
        ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
        github: {},
        linear: {
          connect: async () => {
            throw error
          }
        }
      })
      const result = await handlers.get('linear:connect')(null, { key: 'private-test-key' })
      expect(result).toEqual({ ok: false, error: 'Linear could not complete this request.' })
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})
