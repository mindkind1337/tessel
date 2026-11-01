// A sub id for the version, so a build is told apart from the release it comes
// after without touching the release's number (package.json's version stays
// 1.17.2 until a release is made):
//
//   b5421 (8a2694c)   the number of commits of the repository, and the
//                     commit: it goes up by itself with every push to
//                     GitHub, for both teams, and the commit is on GitHub.
//
// A development Tessel (npm run dev, started from the repository) reads it
// from git when asked, so it follows the repository as it moves (a push that
// only reloads the page changes it too). An installed Tessel has the one
// its build was made at (electron.vite.config.mjs bakes it in).
import { execFile } from 'child_process'

const CACHE_MS = 3000

// -> { count, hash } | null (not a repository, no git, a shallow copy...)
export function readBuild(root, run = execFile) {
  const git = (args) =>
    new Promise((resolve) => {
      run('git', ['-C', root, ...args], { timeout: 4000, windowsHide: true }, (err, out) => resolve(err ? '' : String(out).trim()))
    })
  return Promise.all([git(['rev-list', '--count', 'HEAD']), git(['rev-parse', '--short=7', 'HEAD'])]).then(([count, hash]) =>
    /^\d{1,9}$/.test(count) && /^[0-9a-f]{7,40}$/.test(hash) ? { count: Number(count), hash } : null
  )
}

export const formatBuild = (b) => (b && Number.isInteger(b.count) && b.hash ? `b${b.count} (${b.hash})` : '')
// The short form for a line of the log or a small label.
export const shortBuild = (b) => (b && Number.isInteger(b.count) ? `b${b.count}` : '')

// baked: { count, hash } set when the installed build was made (or null).
export function createBuildId({ root, packaged, baked = null, run = execFile, now = Date.now } = {}) {
  let cached = null
  let at = 0
  let pending = null
  async function get() {
    if (packaged) return baked && Number.isInteger(baked.count) ? baked : null
    if (cached !== null && now() - at < CACHE_MS) return cached.value
    if (pending) return pending
    pending = readBuild(root, run)
      .then((value) => {
        cached = { value }
        at = now()
        return value
      })
      .finally(() => {
        pending = null
      })
    return pending
  }
  return { get }
}
