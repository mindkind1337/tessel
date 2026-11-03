// @vitest-environment node
// The old community Google server leaves once Google is connected in Tessel, once for each agent.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { createRetireOldGoogle, OLD_GOOGLE_SERVER } from '../tesselApps/retireOldGoogle'

const NEW = 'tessel_apps'
let dir
let file
let google
let servers
let removals
let refuse

const agentsWith = (name) => Object.keys(servers).filter((agent) => servers[agent].includes(name))
async function remove(agent, name) {
  removals.push(agent)
  if (refuse[agent]) {
    if (refuse[agent] === 'throw') throw new Error('no such program')
    return { ok: false, error: 'refused' }
  }
  servers[agent] = servers[agent].filter((s) => s !== name)
  return { ok: true }
}
// One run of Tessel: what is kept in the file carries over to the next one.
const start = () => createRetireOldGoogle({ file, replacement: NEW, connected: () => google, agentsWith, remove })

beforeEach(() => {
  dir = fs.mkdtempSync(join(os.tmpdir(), 'retire-old-google-'))
  file = join(dir, 'tessel-apps', 'old-google-retired.json')
  google = true
  servers = { claude: [OLD_GOOGLE_SERVER, NEW], codex: [OLD_GOOGLE_SERVER, NEW] }
  removals = []
  refuse = {}
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('retiring the old Google server', () => {
  it('leaves everything alone while Google is not connected', async () => {
    google = false
    expect(await start().check()).toEqual({ removed: [], failed: [] })
    expect(removals).toEqual([])
    expect(fs.existsSync(file)).toBe(false)
  })

  it('removes it at a start when Google was connected before (the case that stayed behind)', async () => {
    expect((await start().check()).removed).toEqual(['claude', 'codex'])
    expect(servers).toEqual({ claude: [NEW], codex: [NEW] })
  })

  it('removes only that server', async () => {
    servers.claude.push('keep-me')
    await start().check()
    expect(servers.claude).toEqual([NEW, 'keep-me'])
  })

  it('leaves one added back from the MCP dialog, at the next change and the next start', async () => {
    const run = start()
    await run.check()
    servers.claude.push(OLD_GOOGLE_SERVER)
    await run.check()
    await start().check()
    expect(removals).toEqual(['claude', 'codex'])
    expect(servers.claude).toContain(OLD_GOOGLE_SERVER)
  })

  it('removes it again when Google is connected again', async () => {
    const run = start()
    await run.check()
    servers.claude.push(OLD_GOOGLE_SERVER)
    google = false
    await run.check()
    google = true
    expect((await run.check()).removed).toEqual(['claude'])
    expect(servers.claude).toEqual([NEW])
  })

  it('removes it the moment Google is connected in this run', async () => {
    google = false
    const run = start()
    await run.check()
    expect(removals).toEqual([])
    google = true
    expect((await run.check()).removed).toEqual(['claude', 'codex'])
  })

  it("never takes it from an agent without Tessel's tools, and does when it gets them", async () => {
    servers.cursor = [OLD_GOOGLE_SERVER]
    await start().check()
    expect(servers.cursor).toEqual([OLD_GOOGLE_SERVER])
    servers.cursor.push(NEW)
    expect((await start().check()).removed).toEqual(['cursor'])
  })

  it('counts an agent with nothing to remove as done, so one added later stays', async () => {
    servers.claude = [NEW]
    await start().check()
    servers.claude.push(OLD_GOOGLE_SERVER)
    await start().check()
    expect(servers.claude).toContain(OLD_GOOGLE_SERVER)
  })

  it('asks again at the next start after a refusal, not at every change', async () => {
    refuse.codex = true
    const run = start()
    const first = await run.check()
    expect(first.removed).toEqual(['claude'])
    expect(first.failed).toEqual([{ agent: 'codex', error: 'refused' }])
    await run.check()
    expect(removals).toEqual(['claude', 'codex'])
    refuse.codex = false
    expect((await start().check()).removed).toEqual(['codex'])
    expect(servers.codex).toEqual([NEW])
  })

  it('takes a remove that throws for a failure and goes on', async () => {
    refuse.claude = 'throw'
    const { removed, failed } = await start().check()
    expect(failed).toEqual([{ agent: 'claude', error: 'no such program' }])
    expect(removed).toEqual(['codex'])
  })

  it('does not run twice at once', async () => {
    const run = start()
    await Promise.all([run.check(), run.check()])
    expect(removals).toEqual(['claude', 'codex'])
  })

  it('starts over when its file is damaged', async () => {
    fs.mkdirSync(join(dir, 'tessel-apps'), { recursive: true })
    fs.writeFileSync(file, 'not json')
    expect((await start().check()).removed).toEqual(['claude', 'codex'])
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(['claude', 'codex'])
  })
})
