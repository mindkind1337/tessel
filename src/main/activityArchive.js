// The settled part of the agents' activity log (see "Stored in pieces" in
// src/shared/activity.js): one line per event in activity-archive/<day>.jsonl
// in userData, appended once and never rewritten. activity.json keeps only
// the recent events, so the file written every few seconds while agents work
// is small instead of 8 MB.
import fs from 'fs'
import { join } from 'path'
import { archiveDay, isEvent, MAX_AGE_MS } from '../shared/activity'

export const ARCHIVE_DIRNAME = 'activity-archive'
// A day's file is deleted once all its events are older than the log keeps.
const KEEP_DAYS = Math.ceil(MAX_AGE_MS / 86400000) + 1

export function createActivityArchive(userDataDir, log = { warn() {} }) {
  const dir = join(userDataDir, ARCHIVE_DIRNAME)
  const live = join(userDataDir, 'activity.json')
  let chain = Promise.resolve()
  let backedUp = false

  // The first archiving of this process: activity.json as the previous
  // version wrote it (the whole log) is kept once, before it is cut down to
  // the recent events.
  async function backupOnce() {
    if (backedUp) return
    backedUp = true
    const copy = `${live}.before-archive`
    try {
      await fs.promises.access(copy)
    } catch {
      try {
        await fs.promises.copyFile(live, copy)
      } catch (err) {
        if (err.code !== 'ENOENT') log.warn('activity', `backup failed: ${err.message}`)
      }
    }
  }

  // events: a list (already checked). One append at a time, in order.
  function append(events) {
    const run = async () => {
      const byDay = new Map()
      for (const e of events) {
        if (!isEvent(e)) continue
        const day = archiveDay(e.t)
        const lines = byDay.get(day)
        if (lines) lines.push(JSON.stringify(e))
        else byDay.set(day, [JSON.stringify(e)])
      }
      if (!byDay.size) return { ok: true, count: 0 }
      await backupOnce()
      await fs.promises.mkdir(dir, { recursive: true })
      // A leading newline: a line cut by a kill never joins the next one.
      for (const [day, lines] of byDay) await fs.promises.appendFile(join(dir, `${day}.jsonl`), `\n${lines.join('\n')}\n`, 'utf8')
      return { ok: true, count: events.length }
    }
    const result = chain.then(run, run).catch((err) => {
      log.warn('activity', `archive failed: ${err.message}`)
      return { ok: false, error: err.message }
    })
    chain = result
    return result
  }

  // The archive's lines, oldest day first; days older than the log keeps are
  // deleted. -> text
  async function read(now = Date.now()) {
    let names
    try {
      names = (await fs.promises.readdir(dir)).filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort()
    } catch (err) {
      if (err.code !== 'ENOENT') log.warn('activity', `archive list failed: ${err.message}`)
      return ''
    }
    const oldest = archiveDay(now - KEEP_DAYS * 86400000)
    const parts = []
    for (const name of names) {
      if (name.slice(0, 10) < oldest) {
        fs.promises.unlink(join(dir, name)).catch(() => {})
        continue
      }
      try {
        parts.push(await fs.promises.readFile(join(dir, name), 'utf8'))
      } catch (err) {
        log.warn('activity', `archive read failed (${name}): ${err.message}`)
      }
    }
    return parts.join('\n')
  }

  return { append, read, dir }
}
