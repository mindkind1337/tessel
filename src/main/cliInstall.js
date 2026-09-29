// Settings > General > Tessel CLI: the tessel command.
//
// Register copies Tessel's small launcher (out/main/tessel-cli.exe, built from
// src/main/cliLauncher/TesselCli.cs) to %LOCALAPPDATA%\Tessel\bin\tessel.exe
// (the dev build: tessel-dev.exe), writes tessel.ini next to it (where Tessel
// is), and adds that folder to the user PATH (HKCU\Environment, never the
// system PATH, no administrator). Remove deletes both and takes the folder off
// the user PATH again (when no other Tessel command is left in it).
// The launcher starts Tessel's own executable as Node (ELECTRON_RUN_AS_NODE)
// with the command's script (out/main/cli.js, unpacked from the app archive)
// and passes the command line through untouched: no batch file, so cmd.exe
// never reads a card title or a path (| > & % stay text).
//
// The user PATH is read and written through `registry` ({ read(), write() }):
// the real one runs PowerShell (createUserPathRegistry below), tests pass a
// fake. A write is a compare-and-swap: it changes nothing when the PATH
// changed since it was read, and it keeps the value's kind (REG_EXPAND_SZ
// stays expandable, so %USERPROFILE%\… entries keep working).
import fs from 'fs'
import path from 'path'
import { execFile, execFileSync } from 'child_process'
import { t } from './i18n'

export const INI_MARK = '# Tessel command line (Settings > General > Tessel CLI).'
// The batch file an earlier build wrote: removed when met.
export const SHIM_MARK = 'rem Tessel command line (Settings > General > Tessel CLI).'
export const LAUNCHER_EXE = 'tessel-cli.exe'

export function cliCommandName(isPackaged) {
  return isPackaged ? 'tessel' : 'tessel-dev'
}

export function cliBinDir(env = process.env, home = '') {
  const local = env.LOCALAPPDATA || path.join(home || env.USERPROFILE || '', 'AppData', 'Local')
  return path.join(local, 'Tessel', 'bin')
}

const unpacked = (dir) => String(dir || '').replace(/([\\/])app\.asar([\\/]|$)/, '$1app.asar.unpacked$2')

// The command's script and launcher next to the main bundle, outside the app archive.
export function cliScriptPath(mainDir) {
  return path.join(unpacked(mainDir), 'cli.js')
}
export function cliLauncherPath(mainDir) {
  return path.join(unpacked(mainDir), LAUNCHER_EXE)
}

// The launcher's settings (UTF-8, key=value; its first line marks it as Tessel's).
export function iniText({ execPath, scriptPath, userData, appPath = '', name = 'tessel', lang = 'en' }) {
  for (const v of [execPath, scriptPath, userData, appPath, name]) {
    if (/["\r\n\0]/.test(String(v || ''))) throw new Error(t('main.cli.badInstallPath', 'Tessel’s folder has a character the command cannot use.'))
  }
  return [
    INI_MARK,
    '# Written by Tessel; Remove in the same place deletes it.',
    `exec=${execPath}`,
    `script=${scriptPath}`,
    `userData=${userData}`,
    // How the command starts Tessel when it is not running (empty: it asks you to).
    `app=${appPath || ''}`,
    // Tessel's language, for messages while it is closed (it tells its own when open).
    `lang=${lang === 'fr' ? 'fr' : 'en'}`,
    `name=${name}`,
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
  config, // () => the launcher's .ini text
  launcher, // () => path of the launcher to copy (tessel-cli.exe)
  registry,
  fsImpl = fs,
  env = process.env,
  platform = process.platform
}) {
  const commandPath = path.join(binDir, `${name}.exe`)
  const iniPath = path.join(binDir, `${name}.ini`)
  const legacyCmd = path.join(binDir, `${name}.cmd`)
  const writePath = async (change) => {
    try {
      await registry.write(change)
    } catch (err) {
      if (err && err.code === 'EDENIED')
        throw new Error(t('main.cli.pathDenied', 'Windows blocked the change to your user PATH (access denied); your organization may manage it. Add this folder to your PATH yourself: {{dir}}', { dir: binDir }))
      throw err
    }
  }
  const read = (file, enc) => {
    try {
      return fsImpl.readFileSync(file, enc)
    } catch {
      return null
    }
  }
  const exists = (file) => read(file) != null
  const ours = () => {
    const text = read(iniPath, 'utf8')
    return text != null && text.startsWith(INI_MARK)
  }
  const sameBytes = (a, b) => {
    const x = read(a)
    const y = read(b)
    return !!(x && y && x.equals(y))
  }
  const removeLegacy = () => {
    const text = read(legacyCmd, 'utf8')
    if (text != null && text.includes(SHIM_MARK)) fsImpl.unlinkSync(legacyCmd)
  }
  // Another Tessel command (the installed app's or the dev build's) in the folder.
  const otherCommands = () => {
    try {
      return fsImpl
        .readdirSync(binDir)
        .filter((f) => /\.(ini|cmd)$/i.test(f) && f.replace(/\.(ini|cmd)$/i, '').toLowerCase() !== name.toLowerCase())
        .filter((f) => {
          const text = read(path.join(binDir, f), 'utf8') || ''
          return text.startsWith(INI_MARK) || text.includes(SHIM_MARK)
        })
    } catch {
      return []
    }
  }
  // The launcher copied in place (a running copy cannot be replaced: EBUSY).
  const copyLauncher = () => {
    const src = launcher()
    if (!src || !exists(src)) throw new Error(t('main.cli.noLauncher', 'Tessel’s command launcher is missing from this installation.'))
    if (sameBytes(src, commandPath)) return false
    const tmp = `${commandPath}.${process.pid}.tmp`
    fsImpl.copyFileSync(src, tmp)
    try {
      fsImpl.renameSync(tmp, commandPath)
    } catch (err) {
      try {
        fsImpl.unlinkSync(tmp)
      } catch {
        /* gone */
      }
      throw err
    }
    return true
  }

  async function status() {
    const base = { supported: platform === 'win32', name, commandPath, dir: binDir }
    if (!base.supported) return { ...base, state: 'unsupported', onPath: false, shim: false }
    const shim = ours() && exists(commandPath)
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
    let current = false
    if (shim) {
      try {
        current = read(iniPath, 'utf8') === config() && sameBytes(launcher(), commandPath)
      } catch {
        current = false
      }
    }
    return { ...base, state, onPath, shim, current, detail }
  }

  async function install() {
    if (platform !== 'win32') throw new Error(t('main.cli.unsupported', 'The tessel command is available on Windows only.'))
    const text = config()
    fsImpl.mkdirSync(binDir, { recursive: true })
    if ((exists(commandPath) || exists(iniPath)) && !ours())
      throw new Error(t('main.cli.notOurs', '{{path}} exists and was not written by Tessel. Nothing was changed.', { path: exists(commandPath) ? commandPath : iniPath }))
    fsImpl.writeFileSync(iniPath, text)
    copyLauncher()
    removeLegacy()
    const cur = await registry.read()
    if (!hasPathEntry(cur.value, binDir, env)) {
      await writePath({ expected: cur, value: addPathEntry(cur.value, binDir, env), kind: cur.exists ? cur.kind : 'ExpandString' })
    }
    return status()
  }

  async function uninstall() {
    if (platform !== 'win32') throw new Error(t('main.cli.unsupported', 'The tessel command is available on Windows only.'))
    if (ours()) {
      if (exists(commandPath)) fsImpl.unlinkSync(commandPath)
      fsImpl.unlinkSync(iniPath)
    }
    removeLegacy()
    // The folder stays on the PATH while another Tessel command uses it.
    if (!otherCommands().length) {
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

  // At startup and when the language changes: a registered command points at
  // this Tessel again (after an update, another dev folder). Never touches the PATH.
  function refresh() {
    if (!ours()) return false
    let changed = false
    const text = config()
    if (read(iniPath, 'utf8') !== text) {
      fsImpl.writeFileSync(iniPath, text)
      changed = true
    }
    try {
      if (copyLauncher()) changed = true
    } catch {
      /* in use right now: next time */
    }
    try {
      removeLegacy()
    } catch {
      /* kept */
    }
    return changed
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

// Tessel started by the tessel command gets a clean environment without the
// terminal's PATH (src/cli/tessel.js): main takes PATH from the registry, as
// a Start-menu launch has it (machine, then user; expanded). null: unread.
const PS_PATH = `
$m = [Environment]::GetEnvironmentVariable('Path', 'Machine')
$u = [Environment]::GetEnvironmentVariable('Path', 'User')
$v = (@($m, $u) | Where-Object { $_ }) -join ';'
[Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($v)))
`
export function readRegistryPathSync({ execFileSyncImpl = execFileSync, env = process.env } = {}) {
  try {
    const out = execFileSyncImpl(powershellExe(env), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodeCommand(PS_PATH)], {
      windowsHide: true,
      timeout: 10000,
      env
    })
    const value = Buffer.from(String(out || '').trim(), 'base64').toString('utf8')
    return value || null
  } catch {
    return null
  }
}

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
