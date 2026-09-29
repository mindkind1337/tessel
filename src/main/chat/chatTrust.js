// Folders the user trusted for chat agents.
//
// Why: `claude -p` (the chat pane's process) skips Claude Code's own "trust
// this folder" dialog, yet still runs the project's .claude/settings.json
// hooks and .mcp.json servers. So Tessel asks once per folder itself.
// Exact folders only: trusting C:\code does not trust every repository in
// it. A caller that knows a worktree's project root passes it in
// `alsoTrusted` (a worktree of a trusted project is trusted).
//
// File: { version: 1, folders: { [normalized path]: { trusted: true, at } } }
import { isAbsolute, resolve } from 'path'
import { readJsonSafe, writeJsonSafe } from '../safeJson.js'

export const MAX_FOLDERS = 2000

// One key per folder: absolute, resolved, lower case (Windows paths ignore
// case), no trailing separator (except a drive root).
export function trustKey(dir) {
  if (typeof dir !== 'string' || !dir || dir.length > 4096 || dir.includes('\0') || !isAbsolute(dir))
    return null
  let key = resolve(dir).toLowerCase()
  if (key.length > 3) key = key.replace(/[\\/]+$/, '')
  return key
}

const validFile = (data) =>
  !!data && typeof data === 'object' && data.version === 1 && !!data.folders && typeof data.folders === 'object'

export function createChatTrust({ file, ask = null, now = Date.now, max = MAX_FOLDERS } = {}) {
  let folders = null

  function load() {
    if (folders) return folders
    folders = {}
    try {
      const { data } = readJsonSafe(file, validFile)
      if (data) {
        for (const [k, v] of Object.entries(data.folders)) {
          if (trustKey(k) === k && v && v.trusted === true && Number.isFinite(v.at))
            folders[k] = { trusted: true, at: v.at }
        }
      }
    } catch {
      // Unreadable (locked): nothing is trusted this time; saving stays
      // refused by writeJsonSafe until a read succeeds.
    }
    return folders
  }

  function isTrusted(dir, alsoTrusted = []) {
    const all = load()
    const keys = [dir, ...(Array.isArray(alsoTrusted) ? alsoTrusted : [])].map(trustKey)
    return keys.some((k) => k && all[k]?.trusted === true)
  }

  function trust(dir) {
    const key = trustKey(dir)
    if (!key) return false
    const all = load()
    all[key] = { trusted: true, at: now() }
    const kept = Object.entries(all)
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, max)
    folders = Object.fromEntries(kept)
    try {
      writeJsonSafe(file, { version: 1, folders })
      return true
    } catch {
      // Trusted for this run; asked again after a restart.
      return true
    }
  }

  // Asks the user (index.js shows a dialog); a yes is remembered.
  async function askTrust(dir) {
    if (!trustKey(dir) || typeof ask !== 'function') return false
    let yes = false
    try {
      yes = (await ask({ dir })) === true
    } catch {
      yes = false
    }
    if (yes) trust(dir)
    return yes
  }

  return { isTrusted, trust, ask: askTrust, list: () => Object.keys(load()) }
}
