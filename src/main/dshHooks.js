// DeepSeek Harness (dsh) reads Claude Code-shaped hooks through its own
// bridge plugin (@deepseek-ai/dsh-hooks-claude-code), loaded from a row of its
// home patch layer ($DSH_HOME/cordis.patch.yml, a YAML list of loader
// patches) that names the hooks file to read. Tessel's status hooks file is
// its own (agentStatusHooks.js); here, only Tessel's marked block in that YAML
// file is added, rewritten or removed, and every other line is kept as it is.
//
// After Orca's src/main/dsh/dsh-home-patch.ts and hook-settings.ts, MIT,
// Copyright (c) 2026 Lovecast Inc.
import fs from 'fs'
import os from 'os'
import { dirname, isAbsolute, join } from 'path'
import { writeFileAtomic } from './safeJson'
import { t } from './i18n'

const START = '# >>> tessel-dsh-status-hooks (managed by Tessel; do not edit) >>>' // i18n-ignore file marker
const END = '# <<< tessel-dsh-status-hooks <<<' // i18n-ignore file marker
const ROW_ID = 'tessel-status-hooks'
const EMPTY = '[]'

// $DSH_HOME (absolute), else ~/.dsh: where dsh itself looks.
export function dshHome(home = os.homedir(), env = process.env) {
  const value = Object.entries(env || {}).find(([key]) => key.toUpperCase() === 'DSH_HOME')?.[1]
  return typeof value === 'string' && value.trim() && isAbsolute(value.trim()) ? value.trim() : join(home, '.dsh')
}
export const dshPatchFile = (home, env) => join(dshHome(home, env), 'cordis.patch.yml')

const lines = (text) => String(text).split('\n')
const blank = (line) => !line.trim()
const comment = (line) => line.trim().startsWith('#')
const body = (list) => list.filter((l) => !blank(l) && !comment(l))
const noComment = (line) => {
  const hash = line.indexOf('#')
  return (hash < 0 ? line : line.slice(0, hash)).trim()
}
const emptyFlow = (list) => {
  const b = body(list)
  return b.length === 1 && noComment(b[0]) === EMPTY
}
const trimEnd = (list) => list.slice(0, list.findLastIndex((l) => !blank(l)) + 1)
const join2 = (list) => {
  const text = list.join('\n')
  return !text || text.endsWith('\n') ? text : `${text}\n`
}

// Tessel's block: the nearest start marker before an end marker (an orphan
// start left by a cut write never swallows the user's rows after it).
export function findDshBlock(text) {
  let start = -1
  for (const [i, line] of lines(text).entries()) {
    if (line.trim() === START) start = i
    else if (line.trim() === END && start >= 0) return { start, end: i }
  }
  return null
}

// A YAML single-quoted scalar: a quote is doubled.
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`
function unquote(value) {
  const v = value.trim()
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replaceAll("''", "'")
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1)
  return v
}
function block(hooksFile) {
  return [
    START,
    '- insert:',
    `    - id: ${ROW_ID}`,
    "      name: '@deepseek-ai/dsh-hooks-claude-code'",
    '      config:',
    `        configPath: ${quote(hooksFile)}`,
    END
  ]
}

// The hooks file Tessel's block points at, or null.
export function dshPointer(text) {
  const found = findDshBlock(text)
  if (!found) return null
  for (const line of lines(text).slice(found.start + 1, found.end)) {
    const m = /^\s*configPath:\s*(.+?)\s*$/.exec(line)
    if (m) return unquote(m[1])
  }
  return null
}

// A non-empty flow list ([a, b]): YAML allows no "- entry" after it, so
// Tessel's block cannot be added without breaking the user's file.
export function dshPatchUnappendable(text) {
  const all = lines(text)
  const b = body(all)
  return b.length > 0 && b[0].trimStart().startsWith('[') && !emptyFlow(all)
}

// The file with Tessel's block (pointing at hooksFile), or null when it
// cannot be changed safely. An empty "[]" list loses its brackets (an entry
// cannot follow them); a comment on that line stays.
export function applyDshPatch(text, hooksFile) {
  const all = lines(text)
  const found = findDshBlock(text)
  if (found) return join2([...all.slice(0, found.start), ...block(hooksFile), ...all.slice(found.end + 1)])
  if (dshPatchUnappendable(text)) return null
  const kept = emptyFlow(all)
    ? all.map((l) => (noComment(l) === EMPTY ? l.slice(l.indexOf(EMPTY) + EMPTY.length) : l))
    : all
  return join2([...trimEnd(kept), ...block(hooksFile)])
}

// The file without Tessel's block; "[]" back when nothing else is left.
export function removeDshPatch(text) {
  const found = findDshBlock(text)
  if (!found) return { text, changed: false }
  const all = lines(text)
  const kept = trimEnd([...all.slice(0, found.start), ...all.slice(found.end + 1)])
  return { text: join2(kept.every((l) => blank(l) || comment(l)) ? [...kept, EMPTY] : kept), changed: true }
}

function read(file) {
  try {
    return { text: fs.readFileSync(file, 'utf8'), exists: true }
  } catch (error) {
    if (error.code === 'ENOENT') return { text: '', exists: false }
    return { error: t('main.hooks.unreadable', '{{file}} could not be read, so Tessel did not change it.', { file }) }
  }
}
const unappendable = (file) =>
  t('main.hooks.dshFlowList', '{{file}} is written as a [...] list: rewrite it with one "- " entry per line so Tessel can add its hooks.', { file })

// Tessel's block in place, pointing at hooksFile. -> { changed } or { error }
export function installDshPatch(hooksFile, { home = os.homedir(), env = process.env } = {}) {
  const file = dshPatchFile(home, env)
  const got = read(file)
  if (got.error) return { error: got.error }
  const next = applyDshPatch(got.text, hooksFile)
  if (next === null) return { error: unappendable(file) }
  if (next === got.text) return { changed: false }
  fs.mkdirSync(dirname(file), { recursive: true })
  // The user's file as it was before Tessel's first change.
  if (got.exists && !fs.existsSync(`${file}.before-tessel`)) fs.copyFileSync(file, `${file}.before-tessel`)
  writeFileAtomic(file, next)
  return { changed: true }
}

// Tessel's block out. -> { changed } or { error }
export function removeDshPatchFile({ home = os.homedir(), env = process.env } = {}) {
  const file = dshPatchFile(home, env)
  const got = read(file)
  if (got.error) return { error: got.error }
  if (!got.exists) return { changed: false }
  const out = removeDshPatch(got.text)
  if (!out.changed) return { changed: false }
  writeFileAtomic(file, out.text)
  try {
    fs.rmSync(`${file}.before-tessel`, { force: true })
  } catch {
    // left in place: harmless
  }
  return { changed: true }
}

// For Settings: 'installed' (its block points at hooksFile), 'missing', or
// { error } (unreadable, or a [...] list Tessel cannot add to).
export function dshPatchStatus(hooksFile, { home = os.homedir(), env = process.env } = {}) {
  const file = dshPatchFile(home, env)
  const got = read(file)
  if (got.error) return { error: got.error }
  if (dshPatchUnappendable(got.text)) return { error: unappendable(file) }
  return dshPointer(got.text) === hooksFile ? 'installed' : 'missing'
}
