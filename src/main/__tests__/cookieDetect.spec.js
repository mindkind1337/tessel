// Detecting browsers and the system default, from fixture folders and a fake
// registry ProgId: no real browser is read.
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import {
  matchesProgId,
  sortWithDefaultFirst,
  readLocalState,
  firefoxProfiles,
  parseIni,
  chromiumProfiles,
  chromiumCookiesPath,
  CHROMIUM_BROWSERS,
  detectBrowsers
} from '../cookieImport/detect'

const chrome = CHROMIUM_BROWSERS.find((b) => b.id === 'chrome')
const edge = CHROMIUM_BROWSERS.find((b) => b.id === 'edge')
const brave = CHROMIUM_BROWSERS.find((b) => b.id === 'brave')

describe('default-browser ProgId mapping', () => {
  it('maps the Windows https ProgId to the right browser', () => {
    expect(matchesProgId(chrome, 'ChromeHTML')).toBe(true)
    expect(matchesProgId(edge, 'MSEdgeHTM')).toBe(true)
    expect(matchesProgId(brave, 'BraveHTML')).toBe(true)
    expect(matchesProgId(chrome, 'MSEdgeHTM')).toBe(false)
  })
  it('matches a Firefox UserChoice id by prefix', () => {
    const firefox = { progIds: ['FirefoxURL'] }
    expect(matchesProgId(firefox, 'FirefoxURL-308046B0AF4A39CB')).toBe(true)
  })
  it('matches nothing when the ProgId is unknown', () => {
    expect(matchesProgId(chrome, 'SomethingElseHTML')).toBe(false)
    expect(matchesProgId(chrome, null)).toBe(false)
  })
})

describe('sortWithDefaultFirst', () => {
  it('puts the default browser first and its default profile first', () => {
    const list = [
      { id: 'chrome', isDefault: false, profiles: [{ dir: 'a', lastUsed: false }, { dir: 'b', lastUsed: true }] },
      { id: 'edge', isDefault: true, profiles: [{ dir: 'c', lastUsed: true }] }
    ]
    const sorted = sortWithDefaultFirst(list)
    expect(sorted[0].id).toBe('edge')
    expect(sorted[1].profiles[0].dir).toBe('b')
  })
  it('keeps order when nothing is the default', () => {
    const list = [{ id: 'chrome', isDefault: false, profiles: [] }, { id: 'edge', isDefault: false, profiles: [] }]
    expect(sortWithDefaultFirst(list).map((b) => b.id)).toEqual(['chrome', 'edge'])
  })
})

describe('readLocalState', () => {
  it('reads profile names and the last-used profile', () => {
    const dir = fs.mkdtempSync(join(os.tmpdir(), 'ls-'))
    try {
      const file = join(dir, 'Local State')
      fs.writeFileSync(file, JSON.stringify({ profile: { info_cache: { Default: { name: 'Personal' }, 'Profile 1': { name: 'Work' } }, last_used: 'Profile 1' } }))
      const info = readLocalState(file)
      expect(info.names).toEqual({ Default: 'Personal', 'Profile 1': 'Work' })
      expect(info.lastUsed).toBe('Profile 1')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('chromiumProfiles', () => {
  it('finds profile folders that hold a Cookies database and marks the last used', () => {
    const dir = fs.mkdtempSync(join(os.tmpdir(), 'ud-'))
    try {
      fs.writeFileSync(join(dir, 'Local State'), JSON.stringify({ profile: { info_cache: { Default: { name: 'Personal' }, 'Profile 1': { name: 'Work' } }, last_used: 'Profile 1' } }))
      for (const p of ['Default', 'Profile 1']) {
        fs.mkdirSync(join(dir, p, 'Network'), { recursive: true })
        fs.writeFileSync(join(dir, p, 'Network', 'Cookies'), 'x')
      }
      const profiles = chromiumProfiles(dir, chrome)
      expect(profiles.map((p) => p.name).sort()).toEqual(['Personal', 'Work'])
      expect(profiles.find((p) => p.name === 'Work').lastUsed).toBe(true)
      expect(chromiumCookiesPath(join(dir, 'Default'))).toBe(join(dir, 'Default', 'Network', 'Cookies'))
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('firefox profiles.ini', () => {
  it('parses sections', () => {
    const sections = parseIni('[Profile0]\nName=default\nPath=abc.default\nDefault=1\n')
    expect(sections[0][0]).toBe('Profile0')
    expect(sections[0][1]).toEqual({ Name: 'default', Path: 'abc.default', Default: '1' })
  })
  it('marks the Default=1 profile', () => {
    const dir = fs.mkdtempSync(join(os.tmpdir(), 'ff-'))
    try {
      fs.writeFileSync(join(dir, 'profiles.ini'), '[Profile0]\nName=dev\nIsRelative=1\nPath=p0.dev\n\n[Profile1]\nName=default\nIsRelative=1\nPath=p1.default\nDefault=1\n')
      for (const p of ['p0.dev', 'p1.default']) {
        fs.mkdirSync(join(dir, p), { recursive: true })
        fs.writeFileSync(join(dir, p, 'cookies.sqlite'), 'x')
      }
      const profiles = firefoxProfiles(dir)
      expect(profiles.find((p) => p.name === 'default').lastUsed).toBe(true)
      expect(profiles.find((p) => p.name === 'dev').lastUsed).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('detectBrowsers end to end on fixtures', () => {
  it('finds a Chromium browser and marks the default from the ProgId', async () => {
    const root = fs.mkdtempSync(join(os.tmpdir(), 'det-'))
    try {
      const userData = join(root, 'Google', 'Chrome', 'User Data')
      fs.mkdirSync(join(userData, 'Default', 'Network'), { recursive: true })
      fs.writeFileSync(join(userData, 'Default', 'Network', 'Cookies'), 'x')
      fs.writeFileSync(join(userData, 'Local State'), JSON.stringify({ profile: { info_cache: { Default: { name: 'Me' } }, last_used: 'Default' } }))
      const env = { LOCALAPPDATA: root, APPDATA: root }
      const browsers = await detectBrowsers({ platform: 'win32', env, defaultProgId: 'ChromeHTML' })
      const found = browsers.find((b) => b.id === 'chrome')
      expect(found).toBeTruthy()
      expect(found.isDefault).toBe(true)
      expect(browsers[0].id).toBe('chrome')
      expect(found.profiles[0].name).toBe('Me')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
