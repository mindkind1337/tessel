// Settings > General > Tessel CLI: the tessel command.
//
// Register writes a small tessel.cmd in %LOCALAPPDATA%\Tessel\bin (the dev
// build: tessel-dev.cmd) and adds that folder to the user PATH
// (HKCU\Environment, never the system PATH, no administrator). Remove deletes
// the command and takes the folder off the user PATH again (when no other
// Tessel command is left in it). The shim starts Tessel's own executable as
// Node (ELECTRON_RUN_AS_NODE) with the command's script (out/main/cli.js,
// unpacked from the app archive), so nothing else needs to be installed.
//
// The user PATH is read and written through `registry` ({ read(), write() }):
// the real one runs PowerShell (createUserPathRegistry below), tests pass a
// fake. A write is a compare-and-swap: it changes nothing when the PATH
// changed since it was read, and it keeps the value's kind (REG_EXPAND_SZ
// stays expandable, so %USERPROFILE%\… entries keep working).
import fs from 'fs'
import path from 'path'
import { execFile } from 'child_process'
import { t } from './i18n'

export const SHIM_MARK = 'rem Tessel command line (Settings > General > Tessel CLI).'

export function cliCommandName(isPackaged) {
  return isPackaged ? 'tessel' : 'tessel-dev'
}

export function cliBinDir(env = process.env, home = '') {
  const local = env.LOCALAPPDATA || path.join(home || env.USERPROFILE || '', 'AppData', 'Local')
  return path.join(local, 'Tessel', 'bin')
}

// The command's script next to the main bundle, outside the app archive.
export function cliScriptPath(mainDir) {
  return path.join(String(mainDir || '').replace(/([\\/])app\.asar([\\/]|$)/, '$1app.asar.unpacked$2'), 'cli.js')
}

// cmd.exe reads % in a batch file as a variable: doubled, it stays a %.
const batchValue = (v) => String(v || '').replace(/%/g, '%%')

export function shimText({ execPath, scriptPath, userData, appPath = '', name = 'tessel', lang = 'en' }) {
  for (const v of [execPath, scriptPath, userData, appPath]) {
    if (/["\r\n]/.test(String(v || ''))) throw new Error(t('main.cli.badInstallPath', 'Tessel’s folder has a character the command cannot use.'))
  }
  return [
    '@echo off',
    SHIM_MARK,
    'rem Written by Tessel; Remove in the same place deletes it.',
    'setlocal',
    'set "ELECTRON_RUN_AS_NODE=1"',
    `set "TESSEL_CLI_NAME=${batchValue(name)}"`,
    `set "TESSEL_CLI_USER_DATA=${batchValue(userData)}"`,
    // Tessel's language, for messages while it is closed (it tells its own when open).
    `set "TESSEL_CLI_LANG=${lang === 'fr' ? 'fr' : 'en'}"`,
    // How the command starts Tessel when it is not running (empty: it asks you to).
    `set "TESSEL_CLI_APP=${batchValue(appPath)}"`,
    `"${batchValue(execPath)}" "${batchValue(scriptPath)}" %*`,
    'exit /b %ERRORLEVEL%',
    ''
  ].join('\r\n')
}

// --- PATH values ---------------------------------------------------------------------

export function splitPath(value) {
  return String(value || '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
}

function expand(entry, env) {
  return entry.replace(/%([^%]+)%/g, (m, name) => {
    const key = Object.keys(env || {}).find((k) => k.toLowerCase() === name.toLowerCase())
    return key ? env[key] : m
  })
}

export function samePathEntry(entry, dir, env = process.env) {
  const norm = (p) =>
    expand(String(p).replace(/^"(.*)"$/, '$1'), env)
      .replace(/\//g, '\\')
      .replace(/\\+$/, '')
      .toLowerCase()
  return norm(entry) === norm(dir)
}

export function hasPathEntry(value, dir, env) {
  return splitPath(value).some((e) => samePathEntry(e, dir, env))
}

// The value with `dir` added at the end (unchanged when it is there).
export function addPathEntry(value, dir, env) {
  if (hasPathEntry(value, dir, env)) return String(value || '')
  const current = String(value || '').replace(/;+\s*$/, '')
  return current ? `${current};${dir}` : dir
}

// The value without `dir`; the other entries stay exactly as they were.
export function removePathEntry(value, dir, env) {
  return String(value || '')
    .split(';')
    .filter((e) => !(e.trim() && samePathEntry(e.trim(), dir, env)))
    .join(';')
    .replace(/^;+|;+$/g, '')
}

// --- The installer -------------------------------------------------------------------

export function createCliInstaller({
  binDir,
  name,
  shim, // () => shim text
  registry,
  fsImpl = fs,
  env = process.env,
  platform = process.platform
}) {
  const commandPath = path.join(binDir, `${name}.cmd`)
  const writePath = async (change) => {
    try {
      await registry.write(change)
    } catch (err) {
      if (err && err.code === 'EDENIED')
        throw new Error(t('main.cli.pathDenied', 'Windows blocked the change to your user PATH (access denied); your organization may manage it. Add this folder to your PATH yourself: {{dir}}', { dir: binDir }))
      throw err
    }
  }

  const shimOnDisk = () => {
    try {
      return fsImpl.readFileSync(commandPath, 'utf8')
    } catch {
      return null
    }
  }
  // Another Tessel command (the installed app's or the dev build's) in the folder.
  const otherShims = () => {
    try {
      return fsImpl
        .readdirSync(binDir)
        .filter((f) => /\.cmd$/i.test(f) && f.toLowerCase() !== `${name}.cmd`.toLowerCase())
        .filter((f) => {
          try {
            return fsImpl.readFileSync(path.join(binDir, f), 'utf8').includes(SHIM_MARK)
          } catch {
            return false
          }
        })
    } catch {
      return []
    }
  }

  async function status() {
    const base = { supported: platform === 'win32', name, commandPath, dir: binDir }
    if (!base.supported) return { ...base, state: 'unsupported', onPath: false, shim: false }
    const text = shimOnDisk()
    const shim = text != null && text.includes(SHIM_MARK)
    let onPath = null
    let detail = null
    try {
      const cur = await registry.read()
      onPath = hasPathEntry(cur.value, binDir, env)
    } catch (err) {
      detail = (err && err.message) || null
    }
    const state = shim && onPath ? 'installed' : shim || onPath ? 'partial' : 'not_installed'
    // current: the command points at this Tessel (false: refresh() rewrites it).
    return { ...base, state, onPath, shim, current: shim ? text === safeShim() : false, detail }
  }

  function safeShim() {
    try {
      return shim()
    } catch {
      return null
    }
  }

  async function install() {
    if (platform !== 'win32') throw new Error(t('main.cli.unsupported', 'The tessel command is available on Windows only.'))
    const text = shim()
    fsImpl.mkdirSync(binDir, { recursive: true })
    const existing = shimOnDisk()
    if (existing != null && !existing.includes(SHIM_MARK))
      throw new Error(t('main.cli.notOurs', '{{path}} exists and was not written by Tessel. Nothing was changed.', { path: commandPath }))
    fsImpl.writeFileSync(commandPath, text)
    const cur = await registry.read()
    if (!hasPathEntry(cur.value, binDir, env)) {
      await writePath({ expected: cur, value: addPathEntry(cur.value, binDir, env), kind: cur.exists ? cur.kind : 'ExpandString' })
    }
    return status()
  }

  async function uninstall() {
    if (platform !== 'win32') throw new Error(t('main.cli.unsupported', 'The tessel command is available on Windows only.'))
    const existing = shimOnDisk()
    if (existing != null && existing.includes(SHIM_MARK)) fsImpl.unlinkSync(commandPath)
    // The folder stays on the PATH while another Tessel command uses it.
    if (!otherShims().length) {
      const cur = await registry.read()
      if (hasPathEntry(cur.value, binDir, env)) {
        await writePath({ expected: cur, value: removePathEntry(cur.value, binDir, env), kind: cur.kind || 'ExpandString' })
      }
      try {
        if (!fsImpl.readdirSync(binDir).length) fsImpl.rmdirSync(binDir)
      } catch {
        /* not empty, or gone */
      }
    }
    return status()
  }

  // At startup: a registered command points at this Tessel again (after an
  // update moved it, or another dev folder). Never touches the PATH.
  function refresh() {
    const existing = shimOnDisk()
    if (existing == null || !existing.includes(SHIM_MARK)) return false
    const text = shim()
    if (existing === text) return false
    fsImpl.writeFileSync(commandPath, text)
    return true
  }

  return { status, install, uninstall, refresh, commandPath }
}

// --- The real user PATH (PowerShell, HKCU\Environment) ---------------------------------

const PS_READ = `
$ErrorActionPreference = 'Stop'
$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')
$o = @{ exists = $false; value = ''; kind = 'ExpandString' }
if ($k) {
  $n = $k.GetValueNames() | Where-Object { $_ -ieq 'Path' } | Select-Object -First 1
  if ($n) {
    $o.exists = $true
    $o.value = [string]$k.GetValue($n, '', 'DoNotExpandEnvironmentNames')
    $o.kind = $k.GetValueKind($n).ToString()
  }
}
[Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($o | ConvertTo-Json -Compress))))
`

// The new value and the one it expects come in variables (base64), never in
// the script's text. "CHANGED": the PATH changed since it was read.
// Setting an unused variable to $null afterwards makes Windows tell running
// programs (Explorer) that the environment changed, so new terminals see it.
const PS_WRITE = `
$ErrorActionPreference = 'Stop'
function Dec($s) { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($s)) }
$k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
$n = $k.GetValueNames() | Where-Object { $_ -ieq 'Path' } | Select-Object -First 1
$exists = [bool]$n
if (-not $n) { $n = 'Path' }
$cur = if ($exists) { [string]$k.GetValue($n, '', 'DoNotExpandEnvironmentNames') } else { '' }
$wantExists = $env:TESSEL_PATH_OLD_EXISTS -eq '1'
if ($exists -ne $wantExists -or ($exists -and $cur -cne (Dec $env:TESSEL_PATH_OLD))) { [Console]::Out.Write('CHANGED'); exit 0 }
$new = Dec $env:TESSEL_PATH_NEW
if ($new -eq '') { if ($exists) { $k.DeleteValue($n, $false) } }
else {
  $kind = if ($env:TESSEL_PATH_KIND -eq 'String') { [Microsoft.Win32.RegistryValueKind]::String } else { [Microsoft.Win32.RegistryValueKind]::ExpandString }
  $k.SetValue($n, $new, $kind)
}
$k.Close()
[Environment]::SetEnvironmentVariable('TESSEL_PATH_CHANGED', $null, 'User')
[Console]::Out.Write('OK')
`

const encodeCommand = (script) => Buffer.from(script, 'utf16le').toString('base64')
const b64 = (s) => Buffer.from(String(s || ''), 'utf8').toString('base64')

function powershellExe(env) {
  const root = env.SystemRoot || env.windir || 'C:\\Windows'
  return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

export function createUserPathRegistry({ execFileImpl = execFile, env = process.env } = {}) {
  const run = (script, extraEnv = {}) =>
    new Promise((resolve, reject) => {
      execFileImpl(
        powershellExe(env),
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodeCommand(script)],
        { windowsHide: true, timeout: 20000, env: { ...env, ...extraEnv } },
        (err, stdout) => (err ? reject(err) : resolve(String(stdout || '').trim()))
      )
    })
  const denied = (err) => /denied|unauthori[sz]ed|security/i.test(String((err && err.message) || ''))
  return {
    async read() {
      let out
      try {
        out = await run(PS_READ)
        const o = JSON.parse(Buffer.from(out, 'base64').toString('utf8'))
        return { exists: !!o.exists, value: String(o.value || ''), kind: o.kind === 'String' ? 'String' : 'ExpandString' }
      } catch {
        throw new Error(t('main.cli.pathUnreadable', 'Tessel could not read your user PATH. Nothing was changed.'))
      }
    },
    async write({ expected, value, kind }) {
      let out
      try {
        out = await run(PS_WRITE, {
          TESSEL_PATH_OLD_EXISTS: expected && expected.exists ? '1' : '0',
          TESSEL_PATH_OLD: b64(expected && expected.value),
          TESSEL_PATH_NEW: b64(value),
          TESSEL_PATH_KIND: kind === 'String' ? 'String' : 'ExpandString'
        })
      } catch (err) {
        const e = new Error(t('main.cli.pathWriteFailed', 'Tessel could not change your user PATH. Nothing was changed.'))
        if (denied(err)) e.code = 'EDENIED'
        throw e
      }
      if (out === 'CHANGED') throw new Error(t('main.cli.pathChanged', 'Your user PATH changed meanwhile. Nothing was changed; try again.'))
      if (out !== 'OK') throw new Error(t('main.cli.pathWriteFailed', 'Tessel could not change your user PATH. Nothing was changed.'))
    }
  }
}
