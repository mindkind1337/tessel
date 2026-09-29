// Git settings a repository carries in its own config that run programs:
// core.fsmonitor (run by git status / diff), filter.<x>.clean / smudge /
// process (run on files git reads or writes), diff.<x>.textconv / command
// (run to show a diff), core.hooksPath (hooks on commit, merge...),
// core.sshCommand (run by push / pull / fetch). A folder copied from
// elsewhere (a tarball, a shared drive, a server) can bring them, and Tessel
// reads a project's git status by itself, without a click.
//
// So:
// - every git call Tessel makes turns core.fsmonitor off (SAFE_ARGS);
// - before the first git call on a repository, its local config is read
//   (git config --local --includes); when it sets any of the above, the user
//   is asked once whether to trust it (the answer is kept per repository and
//   per the exact settings: a change asks again). Until trusted, git runs
//   with those settings overridden to nothing (neutralize()).
// The user's own global settings (git-lfs and the like) are not the
// repository's: they are left alone.
import fs from 'fs'
import crypto from 'crypto'
import { dirname } from 'path'
import { run } from './agentTools'

export const SAFE_ARGS = ['-c', 'core.fsmonitor=false']
export const RISKY_PATTERN = '^(core\\.fsmonitor|core\\.hookspath|core\\.sshcommand|filter\\..+\\.(clean|smudge|process)|diff\\..+\\.(textconv|command))$'
const RISKY_RE = new RegExp(RISKY_PATTERN, 'i')
// The git arguments that list them (the repository's own config file and
// what it includes).
export const RISKY_CONFIG_ARGS = ['config', '--local', '--includes', '-z', '--get-regexp', RISKY_PATTERN]
const MAX_STORED = 2000

// `git config -z --get-regexp` ("key\nvalue\0"...) -> [{ key, value }] of
// settings that run something (core.fsmonitor=false or empty does not).
export function parseRisky(out) {
  const list = []
  for (const rec of String(out || '').split('\0')) {
    if (!rec) continue
    const nl = rec.indexOf('\n')
    const key = (nl < 0 ? rec : rec.slice(0, nl)).trim()
    const value = nl < 0 ? '' : rec.slice(nl + 1)
    if (!RISKY_RE.test(key)) continue
    if (/^core\.fsmonitor$/i.test(key) && /^(false|no|off|0|)$/i.test(value.trim())) continue
    if (!value.trim()) continue
    list.push({ key, value })
  }
  return list
}

export function riskHash(list) {
  const text = list
    .map((r) => `${r.key.toLowerCase()}=${r.value}`)
    .sort()
    .join('\n')
  return crypto.createHash('sha256').update(text).digest('hex')
}

// -c overrides that turn the listed settings off. hooksDir: a folder with no
// hooks (never created), for core.hooksPath.
export function neutralize(list, { hooksDir } = {}) {
  const out = [...SAFE_ARGS]
  const seen = new Set()
  const add = (k, v) => {
    if (seen.has(k)) return
    seen.add(k)
    out.push('-c', `${k}=${v}`)
  }
  for (const { key } of list) {
    const k = key.toLowerCase()
    let m
    if ((m = /^filter\.(.+)\.(clean|smudge|process)$/i.exec(key))) {
      const name = m[1]
      add(`filter.${name}.clean`, '')
      add(`filter.${name}.smudge`, '')
      add(`filter.${name}.process`, '')
      add(`filter.${name}.required`, 'false')
    } else if ((m = /^diff\.(.+)\.(textconv|command)$/i.exec(key))) {
      add(`diff.${m[1]}.textconv`, '')
      add(`diff.${m[1]}.command`, '')
    } else if (k === 'core.hookspath') add('core.hooksPath', hooksDir || '/nonexistent-tessel-no-hooks')
    else if (k === 'core.sshcommand') add('core.sshCommand', 'ssh')
  }
  return out
}

// The decisions, kept in a small JSON file: { "<repo key>": { hash, trusted } }.
// ask({ key, name, where, risky }) -> Promise<boolean> (the dialog).
export function createGitTrust({ file = null, ask = null, fsApi = fs } = {}) {
  let store = null
  const pending = new Map() // key\nhash -> Promise<boolean>
  let queue = Promise.resolve()

  function load() {
    if (store) return store
    store = {}
    if (file) {
      try {
        const data = JSON.parse(fsApi.readFileSync(file, 'utf8'))
        if (data && typeof data === 'object' && data.repos && typeof data.repos === 'object') store = data.repos
      } catch {
        store = {}
      }
    }
    return store
  }
  function save() {
    if (!file) return
    try {
      const keys = Object.keys(store)
      if (keys.length > MAX_STORED) for (const k of keys.slice(0, keys.length - MAX_STORED)) delete store[k]
      fsApi.mkdirSync(dirname(file), { recursive: true })
      fsApi.writeFileSync(file, JSON.stringify({ version: 1, repos: store }, null, 2))
    } catch {
      /* not remembered: asked again next time */
    }
  }

  // -> true when the repository may run its settings.
  // mayAsk: false for calls nobody asked for (a known answer, else no).
  function decide(key, risky, { name = '', where = '', mayAsk = true } = {}) {
    if (!risky.length) return Promise.resolve(true)
    const hash = riskHash(risky)
    const known = load()[key]
    if (known && known.hash === hash) return Promise.resolve(!!known.trusted)
    if (!mayAsk || typeof ask !== 'function') return Promise.resolve(false)
    const pk = `${key}\n${hash}`
    if (!pending.has(pk)) {
      // One dialog at a time.
      const p = (queue = queue.then(async () => {
        let trusted = false
        try {
          trusted = !!(await ask({ key, name, where, risky }))
        } catch {
          trusted = false
        }
        load()[key] = { hash, trusted, at: Date.now() }
        save()
        return trusted
      }))
      pending.set(pk, p)
      p.finally(() => pending.delete(pk))
    }
    return pending.get(pk)
  }

  return { decide, forget: (key) => (delete load()[key], save()) }
}

// The process-wide trust (index.js sets it with its dialog and file; tests
// and other callers without it: never trusted, never asked).
let current = createGitTrust()
export function setGitTrust(trust) {
  current = trust || createGitTrust()
}
export function gitTrust() {
  return current
}

// A local repository: the -c arguments every git call on it gets (core.fsmonitor
// off, and its risky settings off until trusted). top: its top folder.
// ask: false for calls nobody asked for (never opens the dialog then).
const localCache = new Map() // top -> { at, args }
const LOCAL_TTL_MS = 5000
export async function localGitArgs(top, { ask = true, hooksDir } = {}) {
  const key = `local:${String(top).toLowerCase()}`
  const hit = localCache.get(key)
  if (hit && Date.now() - hit.at < LOCAL_TTL_MS) return hit.args
  const res = await run('git', ['-C', top, ...RISKY_CONFIG_ARGS], { timeout: 10000 })
  // Exit 1: none set. Anything else unreadable: treated as risky settings off.
  const risky = res.ok ? parseRisky(res.stdout) : []
  let args
  if (!risky.length) args = [...SAFE_ARGS]
  else {
    const trusted = await gitTrust().decide(key, risky, { name: top, where: '', mayAsk: ask })
    args = trusted ? [...SAFE_ARGS] : neutralize(risky, { hooksDir })
  }
  localCache.set(key, { at: Date.now(), args })
  if (localCache.size > 500) localCache.delete(localCache.keys().next().value)
  return args
}
