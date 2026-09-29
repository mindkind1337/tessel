import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { flatten } from '../i18n'
import frMain from '../../renderer/src/i18n/locales/fr/main.json'

// The main process's audit, like the interface's (renderer __tests__/i18n.spec.js):
// text returned to the window as an error, message, detail, reason, warning
// or note, or thrown with new Error(…), goes through t('main.…', 'English')
// so it follows the interface's language.
//
// Kept English on purpose, so not scanned:
// - files whose text goes to AI agents or stays internal (below);
// - a line ending in "// i18n-ignore <why>", or the line just above it
//   (log lines, git/CLI arguments, ids, errors caught and replaced).

const SKIPPED_FILES = {
  'teamChannel.js': 'team messages and delivery state for agents',
  'teamTasks.js': 'answers to the agents’ task board tools',
  'teamNotices.js': 'notices written for agents',
  'teamAcks.js': 'team channel bookkeeping',
  'teamAuth.js': 'signed request checks answered to agents',
  'ptyHost.js': 'terminal host protocol (a separate process)',
  'ptyClient.js': 'terminal host protocol',
  'agentStateStore.js': 'internal status store errors, never shown',
  'codexUsageScan.js': 'internal cache errors, never shown',
  'taskBoardPersistence.js': 'programming errors',
  'askpassPipeHost.js': 'log lines',
  'agentInbox.js': 'internal: the window falls back to typing the reminder',
  'leadInbox.js': 'internal lead inbox errors',
  'logger.js': 'log lines'
}

const mainDir = join(__dirname, '..')
const TEXT = /(?:\b(?:error|message|detail|reason|warning|note)\s*:\s*|\bnew Error\(\s*)(['"`])((?:\\.|(?!\1)[^\\])*)\1/g

// Reads like words for a person: two words or more ("Invalid folder.",
// "Could not start ${exe}"); template parts do not count as words.
function sentence(text) {
  return /[A-Za-z]{2,}\s+[A-Za-z]{2,}/.test(text.replace(/\$\{[^}]*\}/g, ' '))
}

function untranslated(src, file) {
  const lines = src.split('\n')
  const found = []
  let m
  TEXT.lastIndex = 0
  while ((m = TEXT.exec(src))) {
    if (!sentence(m[2])) continue
    const line = src.slice(0, m.index).split('\n').length
    const here = lines[line - 1] || ''
    const above = lines[line - 2] || ''
    if (/^\s*(\/\/|\*)/.test(here)) continue
    if (here.includes('i18n-ignore') || above.includes('i18n-ignore')) continue
    found.push(`${file}:${line}: ${m[2].slice(0, 80)}`)
  }
  return found
}

describe('main process audit', () => {
  const files = readdirSync(mainDir).filter((f) => f.endsWith('.js') && !SKIPPED_FILES[f])

  it('scans the main process files', () => {
    expect(files.length).toBeGreaterThan(30)
  })

  it('finds text that does not go through t()', () => {
    const sample = [
      "return { ok: false, error: 'The folder is missing.' }",
      "throw new Error(`Could not start ${exe}: ${err.message}`)",
      "return { error: t('main.x.y', 'Fine.') }",
      "return { error: 'Not shown anywhere.' } // i18n-ignore internal",
      "return { error: err.message }",
      "return { reason: 'failed' }"
    ].join('\n')
    expect(untranslated(sample, 'x.js')).toEqual(['x.js:1: The folder is missing.', 'x.js:2: Could not start ${exe}: ${err.message}'])
  })

  it('every user-visible text of the main process goes through t()', () => {
    const found = files.flatMap((f) => untranslated(readFileSync(join(mainDir, f), 'utf8'), f))
    expect(found).toEqual([])
  })
})

// Shared code (src/shared) takes the caller's t() as a parameter: its keys
// need French too, in the main catalog (main.…) or the interface's.
describe('shared text', () => {
  const sharedDir = join(__dirname, '../../shared')
  const rendererDir = join(__dirname, '../../renderer/src/i18n/locales/fr')
  const fr = flatten(frMain)
  for (const f of readdirSync(rendererDir).filter((n) => n.endsWith('.json')))
    Object.assign(fr, flatten(JSON.parse(readFileSync(join(rendererDir, f), 'utf8'))))
  const used = new Map()
  for (const f of readdirSync(sharedDir).filter((n) => n.endsWith('.js'))) {
    const src = readFileSync(join(sharedDir, f), 'utf8')
    const re = /\bt\(\s*(['"])([a-zA-Z][\w.-]+)\1\s*,\s*(['"`])((?:\\.|(?!\3).)*)\3/g
    let m
    while ((m = re.exec(src))) used.set(m[2], { english: m[4], file: f })
  }
  const names = (s) =>
    [...String(s).matchAll(/\{\{\s*(\w+)\s*\}\}/g)]
      .map((x) => x[1])
      .filter((n) => n !== 'count')
      .sort()
      .join(',')

  it('finds the keys', () => {
    expect(used.size).toBeGreaterThan(10)
  })

  it('every key has French with the same placeholders', () => {
    const bad = [...used]
      .filter(([k, { english }]) => {
        const text = fr[k] ?? fr[`${k}_other`]
        return text == null || names(text) !== names(english)
      })
      .map(([k, v]) => `${k} (${v.file})`)
    expect(bad).toEqual([])
  })
})
