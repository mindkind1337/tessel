import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const src = fs.readFileSync(path.resolve(__dirname, '../App.vue'), 'utf8')

describe('a new pane on an SSH host and the host agent check', () => {
  it('waits a few seconds at most (the check stays queued behind the host\'s other work), a restored pane that must know keeps the long wait', () => {
    expect(src).toMatch(/const REMOTE_LAUNCH_CHECK_MS = 4000/)
    expect(src).toMatch(/const waitMs = newPane \? REMOTE_LAUNCH_CHECK_MS : REMOTE_CHECK_MS/)
    expect(src).toMatch(/askHostAgents\(hostId, \{ newPane: !strict && !restore \}\)/)
    // A restored pane (reopened with its id) keeps the long wait.
    expect(src).toMatch(/restore: !!opts\.id/)
    expect(REMOTE_LAUNCH < REMOTE_LONG).toBe(true)
  })
})
const REMOTE_LAUNCH = Number(/const REMOTE_LAUNCH_CHECK_MS = (\d+)/.exec(src)[1])
const REMOTE_LONG = Number(/const REMOTE_CHECK_MS = (\d+)/.exec(src)[1])

describe('a pane on an SSH host asks the host its questions together', () => {
  it('whether its conversation is still there is asked before the agent check, and agentStartLine takes that answer', () => {
    const leaf = src.slice(src.indexOf('async function createLeaf('), src.indexOf('function replaceNode('))
    const ahead = leaf.indexOf('const hostAhead = ')
    expect(ahead).toBeGreaterThan(0)
    expect(ahead).toBeLessThan(leaf.indexOf('launchCommand = await remoteAgentCommand('))
    expect(leaf).toMatch(/hostId: opts\.remoteHostId \|\| null,\s*hostAhead\s*\}/)
    const line = src.slice(src.indexOf('async function agentStartLine('), src.indexOf("if (kind === 'claude' || kind === 'openclaude')"))
    expect(line).toMatch(/hostAhead && hostAhead\.which === which\s*\?\s*await hostAhead\.exists/)
  })
  it('asks ahead exactly when agentStartLine would ask', () => {
    const fn = src.slice(src.indexOf('function hostSessionAhead('), src.indexOf('\n// Codex, OpenCode, Cline and Copilot pick'))
    expect(fn).toMatch(/if \(!hostId \|\| !sessionId \|\| known \|\| !window\.shellApi\.remoteAgentSessionExists\) return null/)
    expect(fn).toMatch(/kind === 'claude' \? 'claude' : kind === 'codex' && resume \? 'codex' : null/)
  })
})

describe('main starts the host agent check with an agent pane', () => {
  it('createSshPane asks for the host agents before the shim wait', () => {
    const main = fs.readFileSync(path.resolve(__dirname, '../../../main/index.js'), 'utf8')
    const fn = main.slice(main.indexOf('async function createSshPane('), main.indexOf('async function createSshPane(') + 3000)
    const early = fn.indexOf('if (opts.agentId) void remoteAgentCheck.hostStarted(target.id)')
    expect(early).toBeGreaterThan(0)
    expect(early).toBeLessThan(fn.indexOf('await prepareRemoteAgent('))
  })
})
