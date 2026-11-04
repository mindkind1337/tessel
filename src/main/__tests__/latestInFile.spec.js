// @vitest-environment node
// latestInFile: the newest line of a log that names something, remembered
// per file, read again when the file is not the one read before.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { latestInFile } from '../latestInFile'

const parse = (text) => {
  let found = null
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const m = JSON.parse(line).model
      if (typeof m === 'string') found = m
    } catch {
      /* not a record */
    }
  }
  return found
}
const line = (model) => JSON.stringify({ model }) + '\n'

describe('latestInFile', () => {
  let dir
  beforeEach(() => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-latest-'))
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('names the newest model, and a grown file keeps the old one when the new part names nothing', () => {
    const file = join(dir, 'a.jsonl')
    const read = latestInFile(parse)
    fs.writeFileSync(file, line('alpha'))
    expect(read(file)).toBe('alpha')
    fs.appendFileSync(file, line('bravo'))
    expect(read(file)).toBe('bravo')
    fs.appendFileSync(file, JSON.stringify({ text: 'x'.repeat(100) }) + '\n')
    expect(read(file)).toBe('bravo')
    expect(read(file)).toBe('bravo')
  })

  it('a file replaced by another of the same size is read again (the old answer is not kept)', () => {
    const file = join(dir, 'b.jsonl')
    const read = latestInFile(parse)
    fs.writeFileSync(file, line('alpha'))
    expect(read(file)).toBe('alpha')
    fs.renameSync(file, join(dir, 'b.old'))
    fs.writeFileSync(file, line('bravo'))
    expect(fs.statSync(file).size).toBe(fs.statSync(join(dir, 'b.old')).size)
    expect(read(file)).toBe('bravo')
  })

  it('a file rewritten in place with the same size is read again once its modification time moves', () => {
    const file = join(dir, 'c.jsonl')
    const read = latestInFile(parse)
    fs.writeFileSync(file, line('alpha'))
    expect(read(file)).toBe('alpha')
    const before = fs.statSync(file)
    fs.writeFileSync(file, line('bravo'))
    // Same second on a coarse clock: move the time by hand, as a later write would.
    fs.utimesSync(file, new Date(before.mtimeMs + 2000), new Date(before.mtimeMs + 2000))
    expect(read(file)).toBe('bravo')
  })

  it('a file replaced by a larger one is read from its start, not from where the old one stopped', () => {
    const file = join(dir, 'd.jsonl')
    const read = latestInFile(parse)
    fs.writeFileSync(file, line('alpha') + JSON.stringify({ text: 'tail' }) + '\n')
    expect(read(file)).toBe('alpha')
    fs.renameSync(file, join(dir, 'd.old'))
    // Longer, and its only model line sits before where the old file's last line began.
    fs.writeFileSync(file, line('bravo') + JSON.stringify({ text: 'y'.repeat(200) }) + '\n')
    expect(read(file)).toBe('bravo')
  })

  it('a file rewritten in place, longer, on the same inode: read from its start (its model line sits before where the old file stopped)', () => {
    const file = join(dir, 'f.jsonl')
    const read = latestInFile(parse)
    fs.writeFileSync(file, line('alpha'))
    expect(read(file)).toBe('alpha')
    const ino = fs.statSync(file).ino
    fs.writeFileSync(file, line('bravo') + JSON.stringify({ tool: 'long output without a model '.repeat(8) }) + '\n')
    expect(fs.statSync(file).ino).toBe(ino)
    expect(read(file)).toBe('bravo')
    // Grown by an append afterwards: still read from where it stopped, and the model kept.
    fs.appendFileSync(file, JSON.stringify({ tool: 'more' }) + '\n')
    expect(read(file)).toBe('bravo')
  })

  it('a shrunk file is read again', () => {
    const file = join(dir, 'e.jsonl')
    const read = latestInFile(parse)
    fs.writeFileSync(file, line('alpha') + line('bravo'))
    expect(read(file)).toBe('bravo')
    fs.writeFileSync(file, line('charlie'))
    expect(read(file)).toBe('charlie')
  })

  it('a missing file is null', () => {
    expect(latestInFile(parse)(join(dir, 'none.jsonl'))).toBeNull()
  })
})
