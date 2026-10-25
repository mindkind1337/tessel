// The settled part of the agents' activity log (see "Stored in pieces" in
// src/shared/activity.js): one line per event in activity-archive/<day>.jsonl
// in userData, appended and never rewritten (but to remove exact copies, see
// read). activity.json keeps only the recent events, so the file written every
// few seconds while agents work is small instead of 8 MB.
import fs from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'
import { archiveDay, archiveKey, isEvent, MAX_AGE_MS, MAX_EVENTS } from '../shared/activity'
import { writeFileAtomic } from './safeJson'

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
// The days whose events this process knows (to append each event once), the
// most recently used kept: today's, and a few older ones a late event went to.
const MAX_INDEXED_DAYS = 4
// A temp file of a rewrite older than this was left by a process that died.
const STALE_TMP_MS = 60 * 1000

// The archive holds each event once: what identifies a line (see archiveKey;
// a line without a message id by a hash of its text, which takes no parse).
function keyOf(line, event = null) {
  if (event || line.includes('"msgId"')) {
    try {
      const k = archiveKey(event || JSON.parse(line))
      if (k) return k
    } catch {
      /* a line cut by a kill: its text */
    }
  }
  return createHash('sha1').update(line).digest('base64')
}

// A day file's lines without exact copies, in order. -> { lines, copies }
function uniqueLines(text) {
  const seen = new Set()
  const lines = []
  let copies = 0
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    if (seen.has(line)) {
      copies++
      continue
    }
    seen.add(line)
    lines.push(line)
  }
  return { lines, copies }
}

export function createActivityArchive(userDataDir, log = { warn() {} }) {
  const dir = join(userDataDir, ARCHIVE_DIRNAME)
  const live = join(userDataDir, 'activity.json')
  let chain = Promise.resolve()
  let backedUp = false
  const indexes = new Map() // day -> Set of the keys of its lines

  // Everything that writes the archive runs here, one at a time, in order.
  function serial(fn) {
    const result = chain.then(fn, fn)
    chain = result.catch(() => {})
    return result
  }

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

  // The keys of a day's lines, read from its file the first time (a file that
  // cannot be read fails the append: retried by the window's next save).
  async function indexOf(day, file) {
    let keys = indexes.get(day)
    if (keys) {
      indexes.delete(day)
      indexes.set(day, keys)
      return keys
    }
    keys = new Set()
    let text = ''
    try {
      text = await fs.promises.readFile(file, 'utf8')
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
    }
    for (const line of text.split('\n')) if (line.trim()) keys.add(keyOf(line))
    indexes.set(day, keys)
    while (indexes.size > MAX_INDEXED_DAYS) indexes.delete(indexes.keys().next().value)
    return keys
  }

  // events: a list (already checked). One append at a time, in order. An
  // event the archive holds already is not written again (a window that sends
  // an event twice, a save cut off between the archive and activity.json).
  // Events with a time outside the log's retention (a clock set wrong) are
  // left out: they could not be read back, and their day's file name would be
  // nonsense.
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
        const line = JSON.stringify(e)
        const entry = { line, key: keyOf(line, e) }
        const lines = byDay.get(day)
        if (lines) lines.push(entry)
        else byDay.set(day, [entry])
      }
      if (!byDay.size) return { ok: true, count: 0, rejectedDays: [] }
      await backupOnce()
      await fs.promises.mkdir(dir, { recursive: true })
      let count = 0
      const rejectedDays = []
      for (const [day, entries] of byDay) {
        const file = join(dir, `${day}.jsonl`)
        const keys = await indexOf(day, file)
        const fresh = []
        const added = new Set()
        for (const { line, key } of entries) {
          if (keys.has(key) || added.has(key)) continue
          added.add(key)
          fresh.push(line)
        }
        if (!fresh.length) continue
        let size = 0
        try {
          size = (await fs.promises.stat(file)).size
        } catch {
          /* a new day */
        }
        // Full: refused, said so (rejectedDays): the window keeps them in activity.json.
        if (size > MAX_DAY_BYTES) {
          log.warn('activity', `archive of ${day} is full: ${fresh.length} events left in activity.json`)
          rejectedDays.push(day)
          continue
        }
        // A leading newline: a line cut by a kill never joins the next one.
        await fs.promises.appendFile(file, '\n' + fresh.join('\n') + '\n', 'utf8')
        for (const key of added) keys.add(key)
        count += fresh.length
      }
      return { ok: true, count, rejectedDays }
    }
    return serial(run).catch((err) => {
      log.warn('activity', `archive failed: ${err.message}`)
      return { ok: false, error: err.message }
    })
  }

  // A day's file without its exact copies (earlier versions appended the
  // same events again at each start): read again and rewritten whole, in
  // turn with the appends so none is lost, only when it has copies.
  function compact(name) {
    return serial(async () => {
      const file = join(dir, name)
      const { lines, copies } = uniqueLines(await fs.promises.readFile(file, 'utf8'))
      if (!copies) return
      writeFileAtomic(file, '\n' + lines.join('\n') + '\n')
      indexes.delete(name.slice(0, 10))
      log.warn('activity', `archive of ${name.slice(0, 10)}: ${copies} copies removed`)
    }).catch((err) => log.warn('activity', `archive compaction failed (${name}): ${err.message}`))
  }

  // The archive's lines, oldest day first, the newest days only as far as the
  // window keeps events (MAX_EVENTS events): older days are not read. Days
  // older than the log keeps are deleted, unless the clock looks wrong. Exact
  // copies of a line are left out (and removed from their file). -> text
  async function read(now = Date.now()) {
    let all
    try {
      all = await fs.promises.readdir(dir)
    } catch (err) {
      if (err.code !== 'ENOENT') log.warn('activity', `archive list failed: ${err.message}`)
      return ''
    }
    // A rewrite cut by a kill leaves its temp file (<day>.jsonl.<pid>.tmp):
    // removed once it is surely not being written any more.
    for (const name of all.filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl\.\d+\.tmp$/.test(n))) {
      const file = join(dir, name)
      fs.promises
        .stat(file)
        .then((st) => (now - st.mtimeMs > STALE_TMP_MS ? fs.promises.unlink(file) : null))
        .catch(() => {})
    }
    const names = all.filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort()
    const oldest = archiveDay(now - KEEP_DAYS * 86400000)
    const newestTime = names.length ? Date.parse(`${names[names.length - 1].slice(0, 10)}T00:00:00Z`) : NaN
    const clockSane = Number.isFinite(newestTime) && now >= newestTime - 86400000 && now - newestTime <= SANE_GAP_DAYS * 86400000
    const parts = []
    let count = 0
    for (let i = names.length - 1; i >= 0; i--) {
      const name = names[i]
      if (name.slice(0, 10) < oldest) {
        if (clockSane) fs.promises.unlink(join(dir, name)).catch(() => {})
        continue
      }
      if (count >= MAX_EVENTS) continue
      try {
        const { lines, copies } = uniqueLines(await fs.promises.readFile(join(dir, name), 'utf8'))
        if (copies) void compact(name)
        parts.push(lines.join('\n'))
        count += lines.length
      } catch (err) {
        log.warn('activity', `archive read failed (${name}): ${err.message}`)
      }
    }
    return parts.reverse().join('\n')
  }

  return { append, read, dir }
}
