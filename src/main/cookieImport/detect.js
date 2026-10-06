// Which browsers and profiles this computer has, and which one is the
// system's default. After Orca's browser-cookie-detection.ts (MIT,
// Copyright (c) 2026 Lovecast Inc.), with Windows' default browser read from
// the https association (UserChoice ProgId).
//
// Only folders, "Local State" (profile names, the last used one) and
// profiles.ini are read here; cookie databases are not opened.
import fs from 'fs'
import os from 'os'
import { join, sep } from 'path'
import { execFile } from 'child_process'

// Chromium browsers: id, name, where their "User Data" folder is under
// LOCALAPPDATA (Windows), ~/Library/Application Support (macOS) or ~/.config
// (Linux). progId: the Windows https-association id that marks it the default.
export const CHROMIUM_BROWSERS = [
  { id: 'chrome', name: 'Google Chrome', win: ['Google', 'Chrome', 'User Data'], mac: ['Google', 'Chrome'], linux: ['google-chrome'], progIds: ['ChromeHTML'] },
  { id: 'edge', name: 'Microsoft Edge', win: ['Microsoft', 'Edge', 'User Data'], mac: ['Microsoft Edge'], linux: ['microsoft-edge'], progIds: ['MSEdgeHTM', 'MSEdgeDHTML', 'AppXq0fevzme2pys62n3e0fbqa7peapykr8v'] },
  { id: 'brave', name: 'Brave', win: ['BraveSoftware', 'Brave-Browser', 'User Data'], mac: ['BraveSoftware', 'Brave-Browser'], linux: ['BraveSoftware', 'Brave-Browser'], progIds: ['BraveHTML', 'BraveFile'] },
  { id: 'vivaldi', name: 'Vivaldi', win: ['Vivaldi', 'User Data'], mac: ['Vivaldi'], linux: ['vivaldi'], progIds: ['VivaldiHTM'] },
  { id: 'opera', name: 'Opera', win: ['Opera Software', 'Opera Stable'], mac: ['com.operasoftware.Opera'], linux: ['opera'], single: true, progIds: ['OperaStable'] },
  { id: 'opera-gx', name: 'Opera GX', win: ['Opera Software', 'Opera GX Stable'], mac: ['com.operasoftware.OperaGX'], linux: ['opera-gx'], single: true, progIds: ['OperaGXStable'] },
  { id: 'arc', name: 'Arc', win: ['Arc', 'User Data'], mac: ['Arc', 'User Data'], linux: [], progIds: ['ArcHTML'] }
]

// Firefox-family browsers: their profiles live under APPDATA/Roaming
// (Windows) or ~/.mozilla etc.
export const FIREFOX_BROWSERS = [
  { id: 'firefox', name: 'Firefox', win: ['Mozilla', 'Firefox'], mac: ['Firefox'], linux: ['.mozilla', 'firefox'], roaming: true, progIds: ['FirefoxURL', 'FirefoxHTML'] },
  { id: 'zen', name: 'Zen Browser', win: ['zen'], mac: ['zen'], linux: ['.zen'], roaming: true, progIds: ['ZenURL'] },
  { id: 'librewolf', name: 'LibreWolf', win: ['librewolf'], mac: ['LibreWolf'], linux: ['.librewolf'], roaming: true, progIds: ['LibreWolfURL'] },
  { id: 'waterfox', name: 'Waterfox', win: ['Waterfox'], mac: ['Waterfox'], linux: ['.waterfox'], roaming: true, progIds: ['WaterfoxURL'] }
]

function homedir(env) {
  return env.HOME || os.homedir()
}

// The base folder a Chromium browser's "User Data" sits in, for this OS.
export function chromiumUserDataDir(browser, { platform = process.platform, env = process.env } = {}) {
  if (platform === 'win32') {
    const base = browser.win && browser.win[0] === 'Opera Software' ? env.APPDATA : env.LOCALAPPDATA
    if (!base || !browser.win.length) return null
    return join(base, ...browser.win)
  }
  if (platform === 'darwin') {
    if (!browser.mac || !browser.mac.length) return null
    return join(homedir(env), 'Library', 'Application Support', ...browser.mac)
  }
  if (!browser.linux || !browser.linux.length) return null
  return join(homedir(env), '.config', ...browser.linux)
}

export function firefoxProfilesDir(browser, { platform = process.platform, env = process.env } = {}) {
  if (platform === 'win32') {
    if (!env.APPDATA) return null
    return join(env.APPDATA, ...browser.win)
  }
  if (platform === 'darwin') return join(homedir(env), 'Library', 'Application Support', ...browser.mac)
  return join(homedir(env), ...browser.linux)
}

// A profile: { dir (absolute, where the Cookies database is), name (shown),
// lastUsed }. Reads the "User Data" folder's "Local State" for the names and
// the last-used profile.
export function chromiumProfiles(userDataDir, browser) {
  if (!userDataDir || !safeIsDir(userDataDir)) return []
  if (browser.single) {
    // Opera: the folder itself is the one profile (its Cookies is in Network/).
    return hasCookies(userDataDir) ? [{ dir: userDataDir, name: browser.name, lastUsed: true }] : []
  }
  const info = readLocalState(join(userDataDir, 'Local State'))
  const names = info.names
  const out = []
  let entries = []
  try {
    entries = fs.readdirSync(userDataDir, { withFileTypes: true })
  } catch {
    return []
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    if (e.name !== 'Default' && !/^Profile[ _]?\d+$/i.test(e.name) && !/^Profile /i.test(e.name)) continue
    const dir = join(userDataDir, e.name)
    if (!hasCookies(dir)) continue
    out.push({ dir, profileDir: e.name, name: names[e.name] || e.name, lastUsed: info.lastUsed === e.name })
  }
  // If none was marked, the first is the default.
  if (out.length && !out.some((p) => p.lastUsed)) out[0].lastUsed = true
  return out
}

function hasCookies(profileDir) {
  return safeIsFile(join(profileDir, 'Network', 'Cookies')) || safeIsFile(join(profileDir, 'Cookies'))
}

// The Cookies database path of a Chromium profile folder (Network/ first).
export function chromiumCookiesPath(profileDir) {
  const network = join(profileDir, 'Network', 'Cookies')
  if (safeIsFile(network)) return network
  const flat = join(profileDir, 'Cookies')
  return safeIsFile(flat) ? flat : network
}

// "Local State" -> { names: { 'Profile 1': 'Work', ... }, lastUsed }.
export function readLocalState(file) {
  let data
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return { names: {}, lastUsed: null }
  }
  const names = {}
  const cache = data && data.profile && data.profile.info_cache
  if (cache && typeof cache === 'object') {
    for (const [dir, info] of Object.entries(cache)) if (info && typeof info.name === 'string') names[dir] = info.name
  }
  const lastUsed = (data && data.profile && typeof data.profile.last_used === 'string' && data.profile.last_used) || null
  return { names, lastUsed }
}

// profiles.ini -> [{ dir, name, lastUsed }]. Default=1 (or the [Install...]
// section's Default=) marks the default profile.
export function firefoxProfiles(profilesDir) {
  const iniPath = join(profilesDir, 'profiles.ini')
  let text
  try {
    text = fs.readFileSync(iniPath, 'utf8')
  } catch {
    return []
  }
  const sections = parseIni(text)
  let installDefault = null
  for (const [name, kv] of sections) if (/^Install/i.test(name) && kv.Default) installDefault = kv.Default
  const out = []
  for (const [name, kv] of sections) {
    if (!/^Profile\d+$/i.test(name) || !kv.Path) continue
    const dir = kv.IsRelative === '0' ? kv.Path : join(profilesDir, kv.Path.replace(/\//g, sep))
    if (!safeIsFile(join(dir, 'cookies.sqlite'))) continue
    out.push({ dir, name: kv.Name || name, lastUsed: kv.Default === '1' || (!!installDefault && kv.Path === installDefault) })
  }
  if (out.length && !out.some((p) => p.lastUsed)) out[0].lastUsed = true
  return out
}

export function parseIni(text) {
  const sections = []
  let current = null
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith(';') || line.startsWith('#')) continue
    const sec = line.match(/^\[(.+)\]$/)
    if (sec) {
      current = [sec[1], {}]
      sections.push(current)
      continue
    }
    const eq = line.indexOf('=')
    if (current && eq > 0) current[1][line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
  }
  return sections
}

function safeIsDir(p) {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}
function safeIsFile(p) {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

// Every detected browser: { id, name, family: 'chromium'|'firefox',
// profiles: [{ dir, name, lastUsed, cookiesPath }], default: bool }. The
// system default (if known) is marked and sorted first, its last-used (or
// first) profile marked default too.
export async function detectBrowsers({ platform = process.platform, env = process.env, defaultProgId = null } = {}) {
  const progId = defaultProgId != null ? defaultProgId : platform === 'win32' ? await readWindowsDefaultProgId().catch(() => null) : null
  const found = []
  for (const b of CHROMIUM_BROWSERS) {
    const dir = chromiumUserDataDir(b, { platform, env })
    const profiles = chromiumProfiles(dir, b).map((p) => ({ ...p, cookiesPath: chromiumCookiesPath(p.dir) }))
    if (profiles.length) found.push({ id: b.id, name: b.name, family: 'chromium', localStatePath: dir ? join(dir, 'Local State') : null, profiles, isDefault: matchesProgId(b, progId) })
  }
  for (const b of FIREFOX_BROWSERS) {
    const dir = firefoxProfilesDir(b, { platform, env })
    const profiles = dir ? firefoxProfiles(dir).map((p) => ({ ...p, cookiesPath: join(p.dir, 'cookies.sqlite') })) : []
    if (profiles.length) found.push({ id: b.id, name: b.name, family: 'firefox', profiles, isDefault: matchesProgId(b, progId) })
  }
  return sortWithDefaultFirst(found)
}

export function matchesProgId(browser, progId) {
  if (!progId || !browser.progIds) return false
  const p = String(progId)
  return browser.progIds.some((id) => p === id || p.startsWith(id))
}

// The default browser first; if none is the system default, order is kept.
export function sortWithDefaultFirst(browsers) {
  const list = [...browsers]
  const idx = list.findIndex((b) => b.isDefault)
  if (idx > 0) list.unshift(list.splice(idx, 1)[0])
  // The default browser's default profile sits first in its own list.
  for (const b of list) {
    const d = b.profiles.findIndex((p) => p.lastUsed)
    if (d > 0) b.profiles.unshift(b.profiles.splice(d, 1)[0])
  }
  return list
}

// Windows' default https handler ProgId, from the user's choice in the
// registry (HKCU\...\UrlAssociations\https\UserChoice, ProgId).
export function readWindowsDefaultProgId({ execFileFn = execFile } = {}) {
  return new Promise((resolve) => {
    const key = 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice'
    execFileFn('reg', ['query', key, '/v', 'ProgId'], { windowsHide: true, timeout: 8000 }, (err, stdout) => {
      if (err) return resolve(null)
      const m = String(stdout).match(/ProgId\s+REG_SZ\s+(\S+)/i)
      resolve(m ? m[1] : null)
    })
  })
}
