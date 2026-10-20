// The settled part of the agents' activity log (see "Stored in pieces" in
// src/shared/activity.js): one line per event in activity-archive/<day>.jsonl
// in userData, appended once and never rewritten. activity.json keeps only
// the recent events, so the file written every few seconds while agents work
// is small instead of 8 MB.
import fs from 'fs'
import { join } from 'path'
import { archiveDay, isEvent, MAX_AGE_MS, MAX_EVENTS } from '../shared/activity'

export const ARCHIVE_DIRNAME = 'activity-archive'
// A day's file is deleted once all its events are older than the log keeps.
const KEEP_DAYS = Math.ceil(MAX_AGE_MS / 86400000) + 1
// A day's file stops growing past this size (a runaway loop of events must
// not fill the disk); the events are dropped, and said so in the log.
const MAX_DAY_BYTES = 24 * 1024 * 1024
// Days are deleted only while the clock looks right: the newest file is at
// most this old (a computer left alone for months deletes nothing on its
// first start, when the date may still be wrong).
const SANE_GAP_DAYS = 90

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

  // events: a list (already checked). One append at a time, in order. Events
  // with a time outside the log's retention (a clock set wrong) are left out:
  // they could not be read back, and their day's file name would be nonsense.
  function append(events, now = Date.now()) {
    const run = async () => {
      const byDay = new Map()
      const from = now - KEEP_DAYS * 86400000
      const to = now + 86400000
      for (const e of events) {
        if (!isEvent(e) || e.t < from || e.t > to) continue
        let day
        try {
          day = archiveDay(e.t)
        } catch {
          continue
        }
        const lines = byDay.get(day)
        if (lines) lines.push(JSON.stringify(e))
        else byDay.set(day, [JSON.stringify(e)])
      }
      if (!byDay.size) return { ok: true, count: 0 }
      await backupOnce()
      await fs.promises.mkdir(dir, { recursive: true })
      // A leading newline: a line cut by a kill never joins the next one.
      for (const [day, lines] of byDay) {
        const file = join(dir, `${day}.jsonl`)
        let size = 0
        try {
          size = (await fs.promises.stat(file)).size
        } catch {
          /* a new day */
        }
        if (size > MAX_DAY_BYTES) {
          log.warn('activity', `archive of ${day} is full: ${lines.length} events dropped`)
          continue
        }
        await fs.promises.appendFile(file, '\n' + lines.join('\n') + '\n', 'utf8')
      }
      return { ok: true, count: events.length }
    }
    const result = chain.then(run, run).catch((err) => {
      log.warn('activity', `archive failed: ${err.message}`)
      return { ok: false, error: err.message }
    })
    chain = result
    return result
  }

  // The archive's lines, oldest day first, the newest days only as far as the
  // window keeps events (MAX_EVENTS lines): older days are not read. Days
  // older than the log keeps are deleted, unless the clock looks wrong. -> text
  async function read(now = Date.now()) {
    let names
    try {
      names = (await fs.promises.readdir(dir)).filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort()
    } catch (err) {
      if (err.code !== 'ENOENT') log.warn('activity', `archive list failed: ${err.message}`)
      return ''
    }
    const oldest = archiveDay(now - KEEP_DAYS * 86400000)
    const newestTime = names.length ? Date.parse(`${names[names.length - 1].slice(0, 10)}T00:00:00Z`) : NaN
    const clockSane = Number.isFinite(newestTime) && now >= newestTime - 86400000 && now - newestTime <= SANE_GAP_DAYS * 86400000
    const parts = []
    let lines = 0
    for (let i = names.length - 1; i >= 0; i--) {
      const name = names[i]
      if (name.slice(0, 10) < oldest) {
        if (clockSane) fs.promises.unlink(join(dir, name)).catch(() => {})
        continue
      }
      if (lines >= MAX_EVENTS) continue
      try {
        const text = await fs.promises.readFile(join(dir, name), 'utf8')
        parts.push(text)
        for (let at = text.indexOf('\n'); at >= 0; at = text.indexOf('\n', at + 1)) lines++
      } catch (err) {
        log.warn('activity', `archive read failed (${name}): ${err.message}`)
      }
    }
    return parts.reverse().join('\n')
  }

  return { append, read, dir }
}
