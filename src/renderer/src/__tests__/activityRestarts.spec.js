// @vitest-environment node
// The activity log across restarts, window (activityStore.js) and main process
// (activityArchive.js + the live file) together, on disk. Team messages are
// logged with the time they were sent, often hours before: the earlier version
// counted "the first n events" as archived, and every start after such a
// message sent thousands of archived events to the archive again (a user's
// archive held each day up to five times; the copies then took the place of
// whole days in what a start reads back).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { createActivityArchive } from '../../../main/activityArchive'
import { mergeSavedActivity, isEvent } from '../../../shared/activity'

const HOUR = 3600 * 1000
let dir
beforeEach(() => {
  dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-restarts-'))
  vi.resetModules()
})
afterEach(() => {
  delete globalThis.window
  fs.rmSync(dir, { recursive: true, force: true })
})

// One run of Tessel: a main process (its archive) and a window (a fresh store).
async function start() {
  vi.resetModules()
  const archive = createActivityArchive(dir)
  const liveFile = join(dir, 'activity.json')
  globalThis.window = {
    shellApi: {
      activity: {
        load: async () => ({ text: fs.existsSync(liveFile) ? fs.readFileSync(liveFile, 'utf8') : '', archive: await archive.read() }),
        save: async (text) => (fs.writeFileSync(liveFile, text), { ok: true }),
        archive: async (text) => archive.append(JSON.parse(text).filter(isEvent))
      }
    }
  }
  const store = await import('../activityStore')
  await store.loadActivity()
  return { store, archive }
}

function archivedLines() {
  const d = join(dir, 'activity-archive')
  if (!fs.existsSync(d)) return []
  return fs.readdirSync(d).flatMap((n) => fs.readFileSync(join(d, n), 'utf8').split('\n').filter(Boolean))
}

describe('the activity log across restarts', () => {
  it('team messages logged late never send the archive to itself again; every event is read back once', async () => {
    const now = Date.now()
    // The first run: two days of events, archived.
    let run = await start()
    for (let i = 0; i < 400; i++) run.store.activity.push({ t: now - 48 * HOUR + i * 6 * 60000, type: 'task', action: 'x', n: i })
    await run.store.saveActivityNow()
    expect(archivedLines()).toHaveLength(400)
    // Then, each run, team messages logged with the time they were sent
    // (yesterday), among the archived events, and a few new events.
    for (let r = 0; r < 5; r++) {
      run = await start()
      for (let k = 0; k < 3; k++) {
        run.store.recordActivity({ t: now - 30 * HOUR + r * 1000 + k, type: 'message', msgId: `m-${r}-${k}`, status: 'read', scope: 'team-chat' })
        run.store.recordActivity({ type: 'task', action: 'y', n: `r${r}-${k}` })
      }
      await run.store.saveActivityNow()
    }
    // A run's late messages were recorded less than an hour before it ended:
    // the next start archives them (their time is a day old). So the next
    // start archives the last run's three, and the following ones nothing.
    run = await start()
    await run.store.saveActivityNow()
    expect(archivedLines()).toHaveLength(415)
    for (let r = 0; r < 5; r++) {
      run = await start()
      await run.store.saveActivityNow()
    }
    expect(archivedLines()).toHaveLength(415)
    // Each archived line once.
    expect(new Set(archivedLines()).size).toBe(archivedLines().length)
    // Read back: the 400, the 15 messages and the 15 recent events, once each.
    const back = mergeSavedActivity(fs.readFileSync(join(dir, 'activity.json'), 'utf8'), await createActivityArchive(dir).read(), Date.now())
    expect(back.events).toHaveLength(430)
    expect(run.store.activity).toHaveLength(430)
  })

  it('an hour later, the late messages and the recent events are archived once and leave activity.json', async () => {
    const now = Date.now()
    let run = await start()
    run.store.recordActivity({ t: now - 30 * HOUR, type: 'message', msgId: 'late', status: 'unread' })
    run.store.recordActivity({ type: 'task', action: 'y' })
    await run.store.saveActivityNow()
    expect(archivedLines()).toHaveLength(0)
    vi.useFakeTimers({ now: now + HOUR + 60000, toFake: ['Date'] })
    try {
      run = await start()
      await run.store.saveActivityNow()
      expect(archivedLines()).toHaveLength(2)
      expect(JSON.parse(fs.readFileSync(join(dir, 'activity.json'), 'utf8'))).toEqual([])
      run = await start()
      await run.store.saveActivityNow()
      expect(archivedLines()).toHaveLength(2)
      expect(run.store.activity).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
