// Local audit only: never store credentials, confirmation tokens or raw responses.
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { t } from './i18n'

const LIMIT = 500
const MAX_BYTES = 1024 * 1024
const outcomes = new Set([
  'pending',
  'reset',
  'nothing_to_reset',
  'no_credit',
  'already_redeemed',
  'error'
])
const clean = (v, n = 120) =>
  typeof v === 'string' ? v.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, n) : ''
const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null)
const stamp = (v) => (Number.isFinite(v) && v > 0 && v <= 8.64e15 ? v : null)
function entry(value) {
  if (
    !value ||
    !['codex', 'claude'].includes(value.provider) ||
    !outcomes.has(value.outcome) ||
    !stamp(value.at)
  )
    return null
  return {
    id: clean(value.id, 80),
    at: value.at,
    completedAt: stamp(value.completedAt),
    provider: value.provider,
    accountId:
      typeof value.accountId === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value.accountId)
        ? value.accountId
        : null,
    accountLabel: clean(value.accountLabel) || 'System default',
    outcome: value.outcome,
    uncertain: value.uncertain === true || value.outcome === 'pending',
    code: /^[a-z_]{1,32}$/.test(value.code || '') ? value.code : null,
    creditsBefore: count(value.creditsBefore),
    creditsAfter: count(value.creditsAfter),
    windows: (Array.isArray(value.windows) ? value.windows : []).slice(0, 8).map((w) => ({
      label: clean(w?.label, 40),
      usedPct:
        typeof w?.usedPct === 'number' && Number.isFinite(w.usedPct)
          ? Math.min(100, Math.max(0, w.usedPct))
          : null,
      resetsAt: stamp(w?.resetsAt)
    }))
  }
}

export function createResetHistory({ file, log, clock = Date.now, io = fs } = {}) {
  function load() {
    try {
      if (io.statSync(file).size > MAX_BYTES) throw new Error('size')
      const data = JSON.parse(io.readFileSync(file, 'utf8'))
      if (data.version !== 1 || !Array.isArray(data.entries)) throw new Error('format')
      return data.entries.map(entry).filter(Boolean).slice(-LIMIT)
    } catch (error) {
      if (error.code === 'ENOENT') return []
      throw new Error(t('main.reset.historyUnreadable', 'Reset history could not be read. Existing history was preserved.'))
    }
  }
  return {
    record(value) {
      const row = entry({ at: clock(), ...value })
      if (!row?.id) throw new Error('Invalid reset history entry.') // i18n-ignore internal: callers show their own message
      const rows = load().filter((old) => old.id !== row.id)
      rows.push(row)
      rows.sort((a, b) => a.at - b.at)
      while (rows.length > LIMIT || Buffer.byteLength(JSON.stringify(rows)) > MAX_BYTES - 100)
        rows.shift()
      io.mkdirSync(path.dirname(file), { recursive: true })
      const tmp = `${file}.${randomUUID()}.tmp`
      try {
        io.writeFileSync(tmp, JSON.stringify({ version: 1, entries: rows }), {
          mode: 0o600,
          flag: 'wx'
        })
        io.renameSync(tmp, file)
      } finally {
        try {
          io.unlinkSync(tmp)
        } catch {
          /* rename succeeded, or original is untouched */
        }
      }
      // Whitelisted audit fields only; no raw provider exceptions or tokens.
      try {
        log?.info('reset', JSON.stringify(row))
      } catch {
        /* logging is best effort */
      }
      return row
    },
    read({ provider, accountId } = {}) {
      try {
        if (provider !== undefined && !['codex', 'claude'].includes(provider))
          throw new Error('Invalid provider.') // i18n-ignore caught below
        if (
          accountId !== undefined &&
          accountId !== null &&
          (typeof accountId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(accountId))
        )
          throw new Error('Invalid account.') // i18n-ignore caught below
        return {
          ok: true,
          limit: LIMIT,
          entries: load()
            .filter(
              (row) =>
                (provider === undefined || row.provider === provider) &&
                (accountId === undefined || row.accountId === accountId)
            )
            .sort((a, b) => b.at - a.at)
        }
      } catch {
        return {
          ok: false,
          error: t('main.reset.historyUnreadable', 'Reset history could not be read. Existing history was preserved.')
        }
      }
    }
  }
}
