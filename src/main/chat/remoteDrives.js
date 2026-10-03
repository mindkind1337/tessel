// Windows drive letters that are network drives (a mapped share): a path on
// one is never read for the chat view's images, since touching it can hang
// for as long as the server takes and could send the user's credentials
// there. Asked from Windows itself (Win32_LogicalDisk, DriveType 4: the same
// answer whatever the system's language), in a child process, again at most
// every few minutes (a drive mapped later is seen then). Any failure: no
// drive is taken for a network one, and the view's own deadline still holds.
import { execFile } from 'child_process'

const QUERY = "Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=4' | ForEach-Object { $_.DeviceID }"
const MAX_AGE_MS = 5 * 60 * 1000

function defaultRun() {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', QUERY], { windowsHide: true, timeout: 8000, maxBuffer: 64 * 1024 }, (err, stdout) =>
      resolve(err ? [] : String(stdout).split(/\r?\n/))
    )
  })
}

// -> { isRemote(path) -> Promise<boolean> }
export function createRemoteDrives({ platform = process.platform, run = defaultRun, now = Date.now } = {}) {
  let letters = null
  let at = 0
  let pending = null
  function load() {
    if (letters && now() - at < MAX_AGE_MS) return Promise.resolve(letters)
    if (!pending)
      pending = Promise.resolve()
        .then(run)
        .catch(() => [])
        .then((list) => {
          letters = new Set((Array.isArray(list) ? list : []).map((l) => /^\s*([A-Za-z]):\s*$/.exec(String(l))?.[1]?.toUpperCase()).filter(Boolean))
          at = now()
          pending = null
          return letters
        })
    return pending
  }
  async function isRemote(path) {
    if (platform !== 'win32') return false
    const m = /^([A-Za-z]):/.exec(String(path || ''))
    if (!m) return false
    return (await load()).has(m[1].toUpperCase())
  }
  return { isRemote }
}
