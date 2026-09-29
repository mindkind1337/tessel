// Read-only subscription quotas. No credentials, network calls or CLI processes.
// Quota UI research: stablyai/orca (MIT), src/main/rate-limits. This reader
// uses the providers' documented fields, not Orca's authenticated fetchers.
// Codex: codex-rs/protocol RateLimitSnapshot, persisted in token_count events.
// Claude: https://code.claude.com/docs/en/statusline#rate-limit-usage
import fs from 'fs/promises'
import os from 'os'
import { join } from 'path'
import { t } from './i18n'

const TAIL_BYTES = 512 * 1024
const MAX_FILES = 32
const MAX_ENTRIES = 10000
const STALE_MS = 15 * 60 * 1000

function iso(value) {
  const time =
    typeof value === 'number' ? value * 1000 : typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isFinite(time) && time > 0 && time <= 8640000000000000
    ? new Date(time).toISOString()
    : null
}

function window(label, usedPct, reset, observedAt, now) {
  if (typeof usedPct !== 'number' || !Number.isFinite(usedPct) || usedPct < 0 || usedPct > 100)
    return null
  const resetsAt = iso(reset)
  return {
    label,
    usedPct,
    resetsAt,
    // An elapsed reset is not evidence of a fresh 0% window.
    stale: now - Date.parse(observedAt) > STALE_MS || (!!resetsAt && Date.parse(resetsAt) <= now)
  }
}

function snapshot(id, windows, observedAt, source) {
  return {
    id,
    windows,
    observedAt,
    source,
    stale: windows.some((w) => w.stale),
    ...(windows.length
      ? {}
      : { error: t('main.usage.noQuotaWindow', 'No supported quota window in the latest local observation.') })
  }
}

function validObserved(value, now) {
  const observed = typeof value === 'string' ? iso(value) : null
  return observed && Date.parse(observed) <= now + 60000 ? observed : null
}

export function parseCodexUsage(text, now = Date.now()) {
  let latest = null
  for (const line of String(text || '').split('\n')) {
    if (!line.includes('"rate_limits"')) continue
    try {
      const row = JSON.parse(line)
      const raw = row.payload?.rate_limits
      if (
        row.type !== 'event_msg' ||
        row.payload?.type !== 'token_count' ||
        !raw ||
        typeof raw !== 'object' ||
        Array.isArray(raw)
      )
        continue
      // Model-specific buckets must not replace the overall Codex quota.
      if (raw.limit_id != null && raw.limit_id !== 'codex') continue
      const observedAt = validObserved(row.timestamp, now)
      if (!observedAt || (latest && observedAt < latest.observedAt)) continue
      const byLabel = new Map()
      for (const w of [raw.primary, raw.secondary]) {
        if (!w || typeof w.window_minutes !== 'number') continue
        // Primary can itself be weekly; position does not define the window.
        const label =
          Math.abs(w.window_minutes - 300) <= 1
            ? '5h'
            : Math.abs(w.window_minutes - 10080) <= 1
              ? 'week'
              : null
        const item = label && window(label, w.used_percent, w.resets_at, observedAt, now)
        if (item) byLabel.set(label, item)
      }
      latest = snapshot(
        'codex',
        ['5h', 'week'].flatMap((k) => (byLabel.has(k) ? [byLabel.get(k)] : [])),
        observedAt,
        'codex-session'
      )
    } catch {
      /* concurrent append or the first truncated line of a tail */
    }
  }
  return latest
}

// Tessel-owned optional snapshot, not a native Claude cache. A future opt-in
// statusLine collector may persist {observedAt, rate_limits}; this reader never
// installs/replaces the user's status line. Token/cost caches are not quotas.
export function parseClaudeUsage(value, now = Date.now()) {
  const observedAt = validObserved(value?.observedAt, now)
  const raw = value?.rate_limits
  if (!observedAt || !raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const windows = []
  for (const [key, label] of [
    ['five_hour', '5h'],
    ['seven_day', 'week']
  ]) {
    const item = window(label, raw[key]?.used_percentage, raw[key]?.resets_at, observedAt, now)
    if (item) windows.push(item)
  }
  return snapshot('claude', windows, observedAt, 'claude-statusline')
}

async function readBounded(file, tail = true) {
  let handle
  try {
    if (!(await fs.lstat(file)).isFile()) return ''
    handle = await fs.open(file, 'r')
    const stat = await handle.stat()
    if (!stat.isFile() || (!tail && stat.size > TAIL_BYTES)) return ''
    const length = Math.min(stat.size, TAIL_BYTES)
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, tail ? stat.size - length : 0)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } catch {
    return ''
  } finally {
    await handle?.close().catch(() => {})
  }
}

// Bound both discovery and file reads. Walk only Codex's year/month/day layout;
// old sessions resumed today are selected by mtime, not their creation date.
async function recentRollouts(root) {
  const files = []
  let remaining = MAX_ENTRIES
  async function visit(dir, depth) {
    let handle
    const dirs = []
    try {
      handle = await fs.opendir(dir)
      for await (const ent of handle) {
        if (--remaining < 0) break
        const file = join(dir, ent.name)
        if (ent.isDirectory() && depth < 3 && /^\d{2,4}$/.test(ent.name)) dirs.push(file)
        if (ent.isFile() && /^rollout-.*\.jsonl$/.test(ent.name)) {
          try {
            files.push({ file, time: (await fs.stat(file)).mtimeMs })
          } catch {
            /* removed */
          }
        }
      }
    } catch {
      /* absent/unreadable directory */
    }
    for (const next of dirs.sort().reverse()) {
      if (remaining <= 0) break
      await visit(next, depth + 1)
    }
  }
  await visit(root, 0)
  return files.sort((a, b) => b.time - a.time).slice(0, MAX_FILES)
}

export async function getUsage({ home = os.homedir(), env = process.env, now = Date.now() } = {}) {
  const codexRoot = env.CODEX_HOME || join(home, '.codex')
  const claudeRoot = env.CLAUDE_CONFIG_DIR || join(home, '.claude')
  const codexRead = async () => {
    let best = null
    for (const { file } of await recentRollouts(join(codexRoot, 'sessions'))) {
      const value = parseCodexUsage(await readBounded(file), now)
      if (value && (!best || value.observedAt > best.observedAt)) best = value
    }
    return (
      best || {
        id: 'codex',
        windows: [],
        source: 'codex-session',
        observedAt: null,
        stale: false,
        error: t('main.usage.noCodexObservation', 'No recent local Codex quota observation. Use Codex to refresh its session log.')
      }
    )
  }
  const claudeRead = async () => {
    try {
      const value = parseClaudeUsage(
        JSON.parse(await readBounded(join(claudeRoot, 'tessel-usage.json'), false)),
        now
      )
      if (value) return value
    } catch {
      /* no optional local snapshot */
    }
    return {
      id: 'claude',
      windows: [],
      source: 'unavailable',
      observedAt: null,
      stale: false,
      error: t(
        'main.usage.noClaudeSnapshot', 'Claude Code does not save subscription quotas in its transcripts. No local usage snapshot is available.'
      )
    }
  }
  return { agents: await Promise.all([claudeRead(), codexRead()]) }
}

// Deduplicate renderer polling and scans from multiple windows. The IPC accepts
// no paths or credentials; only this process chooses the provider directories.
export function createUsageReader({ ttl = 15000, read = getUsage, clock = Date.now } = {}) {
  let pending = null,
    cached = null,
    expires = 0
  return async () => {
    if (cached && clock() < expires) return cached
    if (pending) return pending
    pending = Promise.resolve()
      .then(() => read())
      .then((value) => {
        cached = value
        expires = clock() + ttl
        return value
      })
      .finally(() => {
        pending = null
      })
    return pending
  }
}
