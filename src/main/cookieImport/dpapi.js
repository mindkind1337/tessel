// Unsealing a Chromium browser's cookie key on Windows (DPAPI, this Windows
// user only), through PowerShell's [System.Security.Cryptography.
// ProtectedData]: Tessel has no native DPAPI module, and Electron's
// safeStorage only opens what Tessel sealed itself.
//
// The sealed blob goes in through stdin and the key comes back on stdout, in
// memory only: neither is on the command line, in a file or in a log.
import { spawn } from 'child_process'
import { join } from 'path'

const TIMEOUT_MS = 20000

const SCRIPT = [
  '$ErrorActionPreference = "Stop"',
  'Add-Type -AssemblyName System.Security',
  '$in = [Console]::In.ReadToEnd().Trim()',
  '$out = [System.Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($in), $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
  '[Console]::Out.Write([Convert]::ToBase64String($out))'
].join('; ')

export function powershellPath(env = process.env) {
  const root = env.SystemRoot || env.windir || 'C:\\Windows'
  return join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

// blob (Buffer) -> Promise<Buffer> (the key). spawnFn for tests.
export function unprotectDpapi(blob, { spawnFn = spawn, timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawnFn(powershellPath(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SCRIPT], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (err) {
      reject(err)
      return
    }
    const out = []
    let done = false
    const finish = (err, value) => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (err) reject(err)
      else resolve(value)
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {}
      finish(new Error('DPAPI timed out'))
    }, timeoutMs)
    child.stdout.on('data', (d) => out.push(d))
    // stderr is drained, never shown (it could echo input in some errors).
    child.stderr.on('data', () => {})
    child.on('error', (err) => finish(err))
    child.on('close', (code) => {
      if (code !== 0) return finish(new Error(`DPAPI failed (${code})`))
      const text = Buffer.concat(out).toString('utf8').trim()
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) return finish(new Error('DPAPI gave nothing'))
      finish(null, Buffer.from(text, 'base64'))
    })
    child.stdin.on('error', () => {})
    child.stdin.end(Buffer.from(blob).toString('base64'))
  })
}
