import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  parseAntigravityUserStatus,
  shortPlan,
  agyAccountEmail,
  createAntigravityPlan
} from '../antigravityPlan'

// A protobuf the way the Antigravity app writes its user status.
const varint = (n) => {
  const out = []
  while (n > 127) {
    out.push((n & 0x7f) | 0x80)
    n = Math.floor(n / 128)
  }
  out.push(n)
  return Buffer.from(out)
}
const field = (n, value) => {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8')
  return Buffer.concat([varint(n * 8 + 2), varint(bytes.length), bytes])
}
const number = (n, value) => Buffer.concat([varint(n * 8), varint(value)])
function userStatus({ email = 'me@example.com', tier = 'g1-pro-tier', name = 'Google AI Pro' } = {}) {
  const tierMsg = Buffer.concat([field(1, tier), field(2, name), field(3, name), field(7, 'https://antigravity.google/g1-upgrade'), field(8, 'You can upgrade.')])
  const account = Buffer.concat([field(3, 'Me'), field(7, email), number(9, 1), field(36, tierMsg)])
  const inner = field(1, field(1, account))
  const outer = field(1, Buffer.concat([field(1, 'userStatusSentinelKey'), field(2, inner.toString('base64'))]))
  return outer.toString('base64')
}

let tmp
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agyplan-'))
})
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe("Antigravity's plan, from the app's saved user status", () => {
  it('finds the tier, its name and the account', () => {
    expect(parseAntigravityUserStatus(userStatus())).toEqual({ tier: 'g1-pro-tier', plan: 'Google AI Pro', email: 'me@example.com' })
    expect(parseAntigravityUserStatus(Buffer.from(userStatus({ tier: 'g1-ultra-tier', name: 'Google AI Ultra' })))).toMatchObject({ plan: 'Google AI Ultra' })
  })
  it('reads nothing from a value that is not a user status', () => {
    for (const value of [null, '', 'not base64 at all!', Buffer.from('{"a":1}').toString('base64'), field(1, 'x').toString('base64')])
      expect(parseAntigravityUserStatus(value)).toBe(null)
  })
  it('names the plan like the other providers', () => {
    expect(shortPlan('Google AI Pro')).toBe('Pro')
    expect(shortPlan('Google AI Ultra')).toBe('Ultra')
    expect(shortPlan('Gemini Code Assist Standard')).toBe('Gemini Code Assist Standard')
    expect(shortPlan('')).toBe(null)
  })
  it("knows the account the Antigravity CLI last signed in as, from its log", () => {
    const log = path.join(tmp, '.gemini', 'antigravity-cli', 'cli.log')
    fs.mkdirSync(path.dirname(log), { recursive: true })
    fs.writeFileSync(log, 'I1015 server_oauth.go:209] OAuth: authenticated successfully as old@example.com\nnoise\nI1015 server_oauth.go:209] OAuth: authenticated successfully as me@example.com\n')
    expect(agyAccountEmail({ home: tmp })).toBe('me@example.com')
    expect(agyAccountEmail({ home: path.join(tmp, 'nobody') })).toBe(null)
  })
  it("keeps only the CLI's account; the folder written last wins", () => {
    const at = { 'Antigravity IDE': 2, Antigravity: 1 }
    const values = { 'Antigravity IDE': userStatus({ email: 'other@example.com', tier: 'g1-ultra-tier', name: 'Google AI Ultra' }), Antigravity: userStatus() }
    const appOf = (file) => path.basename(path.dirname(path.dirname(path.dirname(file))))
    const plan = (email) =>
      createAntigravityPlan({ appData: tmp, home: tmp, email: () => email, mtime: (file) => at[appOf(file)], status: (file) => values[appOf(file)], now: () => 3 }).read()
    expect(plan('me@example.com')).toBe('Pro') // the newer folder is another account's
    expect(plan('ME@example.com')).toBe('Pro')
    expect(plan(null)).toBe('Ultra') // the CLI says nothing: the newest
    expect(plan('third@example.com')).toBe(null)
  })
  it('a plan the app has not written for over a week is not shown (it may have changed since)', () => {
    const day = 24 * 60 * 60 * 1000
    const values = { 'Antigravity IDE': userStatus({ tier: 'g1-ultra-tier', name: 'Google AI Ultra' }), Antigravity: userStatus() }
    const appOf = (file) => path.basename(path.dirname(path.dirname(path.dirname(file))))
    const plan = (at, now) =>
      createAntigravityPlan({ appData: tmp, home: tmp, email: () => 'me@example.com', mtime: (file) => at[appOf(file)], status: (file) => values[appOf(file)], now: () => now }).read()
    const now = 100 * day
    expect(plan({ 'Antigravity IDE': now - 6 * day, Antigravity: now - 30 * day }, now)).toBe('Ultra')
    // The newest is too old: none, not an older one either.
    expect(plan({ 'Antigravity IDE': now - 19 * day, Antigravity: now - 200 * day }, now)).toBe(null)
    // An older folder written lately still counts.
    expect(plan({ 'Antigravity IDE': now - 19 * day, Antigravity: now - day }, now)).toBe('Pro')
  })
  it("reads the app's real state database, read only", () => {
    const sqlite = process.getBuiltinModule?.('node:sqlite')
    if (!sqlite) return
    const file = path.join(tmp, 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const db = new sqlite.DatabaseSync(file)
    db.exec('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)')
    db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run('antigravityUnifiedStateSync.userStatus', userStatus())
    db.close()
    const before = fs.readFileSync(file)
    expect(createAntigravityPlan({ appData: tmp, home: tmp, email: () => 'me@example.com' }).read()).toBe('Pro')
    expect(fs.readFileSync(file).equals(before)).toBe(true)
    expect(createAntigravityPlan({ appData: path.join(tmp, 'none'), home: tmp, email: () => null }).read()).toBe(null)
  })
})
