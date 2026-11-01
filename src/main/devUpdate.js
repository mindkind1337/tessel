// A development Tessel (npm run dev, started from a copy of the repository) is
// not updated by the installer: it is the repository. This tells when GitHub
// has builds this copy does not (the build number goes up with every push, see
// buildId.js), and brings them in when that is safe: a fast-forward of a copy
// with no change of its own. An installed Tessel never runs this: it has the
// updater (updater.js).
//
// Nothing here changes the working copy but apply(), and apply() only
// fast-forwards: no merge, no stash, no reset, no install of packages (a
// change to package.json is said, the user runs npm install themselves).
import { execFile } from 'child_process'

export const FIRST_CHECK_MS = 90 * 1000
export const CHECK_EVERY_MS = 30 * 60 * 1000
const FETCH_TIMEOUT_MS = 30 * 1000
const LIST_MAX = 8
const SAFE_NAME = /^[A-Za-z0-9._/-]{1,100}$/

// run(args) -> Promise<{ ok, out }>: git in the repository, never asking for a
// password (a copy that needs one cannot be checked, it says so).
export function gitRunner(root, run = execFile) {
  return (args, timeout = 8000) =>
    new Promise((resolve) => {
      run('git', ['-C', root, ...args], { timeout, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', GCM_INTERACTIVE: 'never' } }, (err, out) =>
        resolve({ ok: !err, out: err ? '' : String(out).trim() })
      )
    })
}

// What the user sees: the line of each new commit is only text.
const oneLine = (s) => String(s || '').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim().slice(0, 140)

// What a restart is needed for: the code the running app loaded when it started.
// The renderer reloads by itself; these are read once at start.
export const MAIN_PATHS = ['src/main', 'src/preload', 'launch.mjs', 'electron.vite.config.mjs']
const RESTART_CACHE_MS = 5000
const RESTART_LIST = 6

export function createDevUpdate({ root, packaged = false, send = () => {}, git = gitRunner(root), now = Date.now, log = { info() {}, warn() {} } } = {}) {
  let status = { state: packaged ? 'disabled' : 'idle' }
  let busy = false
  // The commit the running app started from (read once, at start).
  const startHead = packaged ? Promise.resolve('') : git(['rev-parse', 'HEAD']).then((r) => (/^[0-9a-f]{40}$/.test(r.out) ? r.out : ''))
  let restartCache = null
  const set = (next) => {
    status = { ...next, checkedAt: next.checkedAt || status.checkedAt || null }
    send('devUpdate:status', status)
    return status
  }

  // -> the situation of this copy against what it follows (no network).
  async function look() {
    const up = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
    // A copy that follows nothing (a detached head, a branch with no upstream) is not checked.
    if (!up.ok || !SAFE_NAME.test(up.out) || !up.out.includes('/')) return { none: 'not-following' }
    const [counts, newest, dirty, list, files, upCount] = await Promise.all([
      git(['rev-list', '--left-right', '--count', 'HEAD...@{u}']),
      git(['rev-parse', '--short=7', '@{u}']),
      git(['status', '--porcelain', '--untracked-files=no']),
      git(['log', `-n${LIST_MAX}`, '--format=%h%x09%s', 'HEAD..@{u}']),
      git(['diff', '--name-only', 'HEAD..@{u}']),
      git(['rev-list', '--count', '@{u}'])
    ])
    const m = /^(\d+)\s+(\d+)$/.exec(counts.out)
    if (!m) return { none: 'unreadable' }
    const names = files.out ? files.out.split('\n') : []
    return {
      upstream: up.out,
      ahead: Number(m[1]),
      behind: Number(m[2]),
      dirty: dirty.out !== '',
      newest: /^[0-9a-f]{7,40}$/.test(newest.out) ? newest.out : '',
      newBuild: /^\d{1,9}$/.test(upCount.out) ? Number(upCount.out) : null,
      commits: list.out
        ? list.out
            .split('\n')
            .map((l) => l.split('\t'))
            .filter((p) => /^[0-9a-f]{7,40}$/.test(p[0]))
            .map((p) => ({ hash: p[0], subject: oneLine(p.slice(1).join(' ')) }))
        : [],
      depsChanged: names.some((n) => n === 'package.json' || n === 'package-lock.json'),
      mainChanged: names.some((n) => n.startsWith('src/main/') || n.startsWith('src/preload/') || n === 'electron.vite.config.mjs')
    }
  }

  function describe(s) {
    if (s.none) return { state: 'none', reason: s.none, checkedAt: now() }
    const base = { upstream: s.upstream, ahead: s.ahead, behind: s.behind, newBuild: s.newBuild, newest: s.newest, commits: s.commits, depsChanged: s.depsChanged, mainChanged: s.mainChanged, checkedAt: now() }
    if (s.behind <= 0) return { state: 'none', ...base }
    // Why it cannot be brought in by itself: the user does it (or not).
    const blocked = s.dirty ? 'dirty' : s.ahead > 0 ? 'ahead' : ''
    return { state: 'available', ...base, blocked }
  }

  async function check() {
    if (packaged || busy) return status
    busy = true
    try {
      const up = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
      if (up.ok && SAFE_NAME.test(up.out) && up.out.includes('/')) {
        const remote = up.out.split('/')[0]
        const branch = up.out.slice(remote.length + 1)
        // Only the branch that is followed, no tags: a small request.
        const f = await git(['fetch', '--quiet', '--no-tags', remote, `${branch}:refs/remotes/${up.out}`], FETCH_TIMEOUT_MS)
        if (!f.ok) {
          log.warn('dev-update', 'fetch failed: GitHub not reached or a sign-in is needed') // i18n-ignore
          return set({ state: 'error', reason: 'fetch', checkedAt: now() })
        }
      }
      const next = describe(await look())
      if (next.state === 'available') log.info('dev-update', `${next.behind} new build${next.behind === 1 ? '' : 's'} on ${next.upstream}${next.newBuild ? ` (b${next.newBuild})` : ''}${next.blocked ? `, cannot update by itself: ${next.blocked}` : ''}`) // i18n-ignore
      return set(next)
    } catch (err) {
      log.warn('dev-update', `check failed: ${err.message}`) // i18n-ignore
      return set({ state: 'error', reason: 'check', checkedAt: now() })
    } finally {
      busy = false
    }
  }

  // Fast-forward to what was fetched: only a copy with no change of its own.
  async function apply() {
    if (packaged || busy) return { ok: false, reason: 'busy' }
    busy = true
    try {
      const s = await look()
      if (s.none) return { ok: false, reason: s.none }
      if (s.behind <= 0) return { ok: false, reason: 'current' }
      if (s.dirty) return { ok: false, reason: 'dirty' }
      if (s.ahead > 0) return { ok: false, reason: 'ahead' }
      const r = await git(['merge', '--ff-only', '--quiet', '@{u}'], 60000)
      if (!r.ok) return { ok: false, reason: 'merge' }
      log.info('dev-update', `updated ${s.behind} build${s.behind === 1 ? '' : 's'} to ${s.newest}`) // i18n-ignore
      const done = { ok: true, behind: s.behind, newBuild: s.newBuild, newest: s.newest, depsChanged: s.depsChanged, mainChanged: s.mainChanged }
      set({ state: 'updated', ...done, checkedAt: now() })
      return done
    } catch (err) {
      log.warn('dev-update', `update failed: ${err.message}`) // i18n-ignore
      return { ok: false, reason: 'merge' }
    } finally {
      busy = false
    }
  }

  // Has the background code changed on disk (committed, merged or edited) since this
  // app started? The app does not restart by itself in dev (launch.mjs), so the
  // window shows a banner. -> { needed, count, files }
  async function restartNeeded() {
    if (packaged) return { needed: false, count: 0, files: [] }
    if (restartCache && now() - restartCache.at < RESTART_CACHE_MS) return restartCache.value
    const head = await startHead
    let value = { needed: false, count: 0, files: [] }
    if (head) {
      const r = await git(['diff', '--name-only', head, '--', ...MAIN_PATHS])
      const names = r.ok && r.out ? r.out.split('\n').filter(Boolean) : []
      value = { needed: names.length > 0, count: names.length, files: names.slice(0, RESTART_LIST).map(oneLine) }
    }
    restartCache = { at: now(), value }
    return value
  }

  function start() {
    if (packaged) return
    setTimeout(check, FIRST_CHECK_MS).unref()
    setInterval(check, CHECK_EVERY_MS).unref()
  }

  return {
    start,
    check,
    apply,
    restartNeeded,
    get status() {
      return status
    }
  }
}
