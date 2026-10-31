// @vitest-environment node
import { it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { withDatabaseCopy, databaseReadCode } from '../cookieImport/chromium'

it('reads committed WAL changes while the source remains open, without uncommitted data', async () => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-cookie-snapshot-'))
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
  const file = join(dir, 'Cookies')
  const writer = new DatabaseSync(file)
  try {
    writer.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE fixture(id INTEGER); INSERT INTO fixture VALUES(1); BEGIN; INSERT INTO fixture VALUES(2)')
    expect(fs.existsSync(file + '-wal')).toBe(true)
    await withDatabaseCopy(file, (copy) => {
      const snapshot = new DatabaseSync(copy, { readOnly: true })
      try { expect(snapshot.prepare('SELECT id FROM fixture').all().map((r) => r.id)).toEqual([1]) } finally { snapshot.close() }
    }, { tmpRoot: join(dir, 'copies') })
    writer.exec('COMMIT')
    await withDatabaseCopy(file, (copy) => {
      const snapshot = new DatabaseSync(copy, { readOnly: true })
      try { expect(snapshot.prepare('SELECT COUNT(*) AS n FROM fixture').get().n).toBe(2) } finally { snapshot.close() }
    }, { tmpRoot: join(dir, 'copies') })
    expect(fs.readdirSync(join(dir, 'copies'))).toEqual([])
  } finally { writer.close(); fs.rmSync(dir, { recursive: true, force: true }) }
})

it('reports a real exclusive lock and cleans up the failed snapshot', async () => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-cookie-lock-'))
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
  const file = join(dir, 'Cookies')
  const writer = new DatabaseSync(file)
  try {
    writer.exec('CREATE TABLE fixture(id INTEGER); BEGIN EXCLUSIVE; INSERT INTO fixture VALUES(1)')
    await expect(withDatabaseCopy(file, () => {}, { tmpRoot: join(dir, 'copies') })).rejects.toMatchObject({ code: 'locked' })
    expect(fs.readdirSync(join(dir, 'copies'))).toEqual([])
    writer.exec('ROLLBACK')
  } finally { writer.close(); fs.rmSync(dir, { recursive: true, force: true }) }
})

it('does not label permissions, corruption or missing files as browser locks', () => {
  expect(databaseReadCode({ code: 'EACCES' })).toBe('access-denied')
  expect(databaseReadCode({ code: 'EPERM' })).toBe('access-denied')
  expect(databaseReadCode({ code: 'ENOENT' })).toBe('missing')
  expect(databaseReadCode({ errcode: 26 })).toBe('unreadable')
  expect(databaseReadCode({ code: 'EBUSY' })).toBe('locked')
  expect(databaseReadCode({ errcode: 5 })).toBe('locked')
})
