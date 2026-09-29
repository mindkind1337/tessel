// Kimi Code 2.x: keep the user's TOML byte-for-byte outside our marked block.
// Validation is delegated to Kimi itself; never reserialize a user's settings.
import fs from 'fs'
import os from 'os'
import { dirname, join, resolve, sep, delimiter } from 'path'
import { execFile } from 'child_process'
import { writeFileAtomic } from './safeJson'
import { extraToolDirs, withToolDirs } from './toolDirs'
import { cleanEnv } from './cleanEnv'
import { t } from './i18n'

export const KIMI_HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop']
const START = '# tessel:team-hooks:start'
const END = '# tessel:team-hooks:end'
export const kimiConfigFile = (home = os.homedir(), kimiHome = process.env.KIMI_CODE_HOME) =>
  join(kimiHome || join(home, '.kimi-code'), 'config.toml')

// Locate real comment markers, never lookalikes inside a multiline string or
// array. Unfinished syntax is refused, even before calling Kimi's validator.
function managedBlock(text) {
  let quote = '',
    escaped = false,
    depth = 0,
    start = null,
    end = null,
    offset = 0
  for (const raw of text.match(/[^\n]*(?:\n|$)/g) || []) {
    if (!raw) continue
    const line = raw.trim()
    if (!quote && depth === 0 && (line === START || line === END)) {
      if (line === START) {
        if (start !== null || end !== null) throw new Error('Ambiguous Tessel hook block.') // i18n-ignore internal parse error, caught and replaced
        start = offset
      } else {
        if (start === null || end !== null) throw new Error('Ambiguous Tessel hook block.') // i18n-ignore internal parse error, caught and replaced
        end = offset + raw.length
      }
    }
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i]
      if (quote) {
        if (escaped) {
          escaped = false
          continue
        }
        if (quote[0] === '"' && c === '\\') {
          escaped = true
          continue
        }
        if (raw.slice(i, i + quote.length) === quote) {
          i += quote.length - 1
          quote = ''
          continue
        }
        if (c === '\n' && quote.length === 1) throw new Error('Unfinished TOML string.') // i18n-ignore internal parse error, caught and replaced
      } else if (c === '#') break
      else if (c === '"' || c === "'") {
        quote = raw.slice(i, i + 3) === c.repeat(3) ? c.repeat(3) : c
        i += quote.length - 1
      } else if (c === '[' || c === '{') depth++
      else if (c === ']' || c === '}') {
        if (--depth < 0) throw new Error('Unbalanced TOML.') // i18n-ignore internal parse error, caught and replaced
      }
    }
    offset += raw.length
  }
  if (quote || depth || (start !== null && end === null))
    throw new Error('Unfinished TOML or Tessel hook block.') // i18n-ignore internal parse error, caught and replaced
  return start === null ? null : { start, end, text: text.slice(start, end) }
}

// Our block accepts only the four fields supported by Kimi, so an unfamiliar
// edit inside the markers cannot be silently removed on reinstall.
function blockHooks(block) {
  const hooks = []
  let current = null
  for (const line of block.split(/\r?\n/).map((s) => s.trim())) {
    if (!line || line.startsWith('#')) continue
    if (line === '[[hooks]]') {
      current = {}
      hooks.push(current)
      continue
    }
    const m = /^(event|command|matcher|timeout)\s*=\s*(.+)$/.exec(line)
    if (!m || !current || Object.hasOwn(current, m[1]))
      throw new Error('Unrecognized edit in Tessel hook block.') // i18n-ignore internal parse error, caught and replaced
    if (m[1] === 'timeout') {
      if (!/^\d+$/.test(m[2])) throw new Error('Invalid hook timeout.') // i18n-ignore internal parse error, caught and replaced
      current.timeout = Number(m[2])
    } else {
      const value = m[2]
      current[m[1]] = /^'[^']*'$/.test(value) ? value.slice(1, -1) : JSON.parse(value)
      if (typeof current[m[1]] !== 'string') throw new Error('Invalid hook field.') // i18n-ignore internal parse error, caught and replaced
    }
  }
  return hooks
}

export function kimiHookEvents(text, scriptPath) {
  const events = Object.fromEntries(KIMI_HOOK_EVENTS.map((e) => [e, false]))
  const block = managedBlock(text)
  if (!block) return events
  const want = `node "${scriptPath}" --hook --kimi`
  for (const hook of blockHooks(block.text)) {
    if (
      KIMI_HOOK_EVENTS.includes(hook.event) &&
      hook.command === want &&
      (hook.matcher === undefined || hook.matcher === '') &&
      (hook.timeout === undefined || (hook.timeout >= 1 && hook.timeout <= 600))
    )
      events[hook.event] = true
  }
  return events
}

export function validateKimiConfig(text, executable = 'kimi') {
  const home = fs.mkdtempSync(join(os.tmpdir(), 'tessel-kimi-check-'))
  const file = join(home, 'config.toml')
  fs.writeFileSync(file, text, 'utf8')
  const env = cleanEnv(process.env)
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') || 'PATH'
  // Prefer Kimi Code's native install over a legacy pip kimi-cli executable.
  env[pathKey] = withToolDirs(
    extraToolDirs(env).join(delimiter),
    String(env[pathKey] || '').split(delimiter)
  )
  env.KIMI_CODE_HOME = home
  return new Promise((done) => {
    execFile(
      executable,
      ['doctor', 'config', file],
      {
        cwd: home,
        windowsHide: true,
        timeout: 30000,
        maxBuffer: 256 * 1024,
        env
      },
      (error) => {
        // The validator may include settings/secrets in its output: don't return it.
        try {
          const target = resolve(home)
          if (
            target.startsWith(resolve(os.tmpdir()) + sep) &&
            target.includes('tessel-kimi-check-')
          )
            fs.rmSync(target, { recursive: true, force: true })
        } catch {
          /* disposable validation directory */
        }
        done(
          error
            ? {
                ok: false,
                error: t('main.kimi.validateFailed', 'Kimi could not validate config.toml. Run kimi doctor config to inspect it.')
              }
            : { ok: true }
        )
      }
    )
  })
}

export async function installKimiHooks(
  scriptPath,
  home = os.homedir(),
  { kimiHome = process.env.KIMI_CODE_HOME, validate = validateKimiConfig } = {}
) {
  const file = kimiConfigFile(home, kimiHome)
  try {
    // The command is run by a shell. Reject paths requiring a different quoting
    // strategy rather than generating a command that can expand/interpolate.
    if (!scriptPath || /["`$%!\x00-\x1f]/.test(scriptPath))
      return { error: t('main.kimi.pathQuote', 'The hook script path cannot be safely quoted for Kimi.') }
    let before = null
    try {
      before = fs.readFileSync(file, 'utf8')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    const text = before ?? ''
    const old = managedBlock(text)
    if (old) {
      const hooks = blockHooks(old.text)
      if (
        hooks.some(
          (h) =>
            !KIMI_HOOK_EVENTS.includes(h.event) ||
            !/^node "[^"\r\n]+" --hook --kimi$/.test(h.command || '') ||
            (h.matcher !== undefined && h.matcher !== '') ||
            (h.timeout !== undefined && h.timeout !== 30)
        )
      )
        return {
          error: t('main.kimi.customChanges', 'Tessel hook block contains custom changes; config.toml was left unchanged.')
        }
    }
    const nl = text.includes('\r\n') ? '\r\n' : '\n'
    const command = JSON.stringify(`node "${scriptPath}" --hook --kimi`)
    const block = [
      START,
      ...KIMI_HOOK_EVENTS.flatMap((event) => [
        '[[hooks]]',
        `event = "${event}"`,
        `command = ${command}`,
        'matcher = ""',
        'timeout = 30',
        ''
      ]),
      END,
      ''
    ].join(nl)
    const next = old
      ? text.slice(0, old.start) + block + text.slice(old.end)
      : text + (text && !text.endsWith('\n') ? nl : '') + block
    if (next === before) return { changed: false }
    const check = await validate(next)
    if (!check?.ok)
      return {
        error: check?.error || t('main.kimi.rejected', 'Kimi rejected the candidate configuration; nothing changed.')
      }
    // Validation is asynchronous. Never overwrite an edit that arrived meanwhile.
    let current = null
    try {
      current = fs.readFileSync(file, 'utf8')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    if (current !== before)
      return { error: t('main.kimi.changedDuring', 'Kimi configuration changed during validation. Try again.') }
    fs.mkdirSync(dirname(file), { recursive: true })
    if (before !== null) {
      try {
        fs.copyFileSync(file, `${file}.before-tessel`, fs.constants.COPYFILE_EXCL)
      } catch (error) {
        if (error.code !== 'EEXIST') throw error
      }
    }
    writeFileAtomic(file, next)
    return { changed: true }
  } catch {
    return {
      error:
        t('main.kimi.unsafe', 'Kimi config.toml could not be safely read or updated; existing settings were preserved.')
    }
  }
}
