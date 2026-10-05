// Which command lines an agent may run in its own terminal without asking
// the user (Settings > Agents > Terminal commands), and which always ask.
//
// Ported from Visual Studio Code's chat terminal tools. Copyright (c)
// Microsoft Corporation. Licensed under the MIT License
// (https://github.com/microsoft/vscode/blob/main/LICENSE.txt):
// - src/vs/workbench/contrib/terminalContrib/chatAgentTools/browser/tools/
//   commandLineAnalyzer/autoApprove/commandLineAutoApprover.ts (rules to
//   regular expressions, deny first, the session rules, transient variables)
// - .../commandLineAnalyzer/commandLineAutoApproveAnalyzer.ts (every
//   sub-command or the whole line approved, none denied)
// - .../browser/runInTerminalHelpers.ts (generateAutoApproveActions: the
//   rules offered on the approval card, and the commands never offered)
// - .../common/terminalChatAgentToolsConfiguration.ts and
//   src/vs/platform/terminal/common/autoApprove/{git,powershell,sort}
//   AutoApproveRules.ts (the default rules)
// VS Code splits a command line into sub-commands with tree-sitter; Tessel
// has no tree-sitter, so splitCommandLine below is a careful hand-written
// splitter for bash and PowerShell that marks the line unanalyzable (never
// auto-approved: the user is asked) whenever it is not sure.
//
// A rule is a key and a value, as in VS Code's chat.tools.terminal.autoApprove:
//   "git status": true          a prefix (the sub-command starts with it, then a word boundary)
//   "/^npm (ls|view)\\b/": true  a regular expression, /pattern/flags
//   "rm": false                 always ask
//   "rm": null                  unset a rule of a lower scope (a default)
//   "/\\.ps1/i": { approve: false, matchCommandLine: true }   on the whole line
// Scopes, lowest first: the defaults, the user's rules ("always"), the
// project's ("this workspace"), and the agent's session (in memory).
//
// Best effort, as VS Code says of its own defaults: they do not aim to
// stop every dangerous command. The user's approval and Stop protect them.

// --- The default rules (VS Code's, as of 2026-10) --------------------------------
const GIT = '/^git(\\s+(-(?-i:C)\\s+\\S+|--no-pager))*\\s+'
export const DEFAULT_RULES = Object.freeze({
  // Generally safe and common read-only commands
  cd: true,
  echo: true,
  ls: true,
  dir: true,
  pwd: true,
  cat: true,
  head: true,
  tail: true,
  findstr: true,
  wc: true,
  tr: true,
  cut: true,
  cmp: true,
  which: true,
  basename: true,
  dirname: true,
  realpath: true,
  readlink: true,
  stat: true,
  file: true,
  od: true,
  du: true,
  df: true,
  sleep: true,
  nl: true,
  grep: true,
  // git: read-only sub-commands (gitAutoApproveRules.ts)
  [`${GIT}status\\b/`]: true,
  [`${GIT}log\\b/`]: true,
  [`${GIT}log\\b.*\\s--output(=|\\s|$)/`]: false,
  [`${GIT}show\\b/`]: true,
  [`${GIT}show\\b.*\\s--output(=|\\s|$)/`]: false,
  [`${GIT}diff\\b/`]: true,
  [`${GIT}diff\\b.*\\s--[^\\w\\s]*o[^\\w\\s]*u[^\\w\\s]*t[^\\w\\s]*p[^\\w\\s]*u[^\\w\\s]*t[^\\w\\s]*(=|\\s|$)/`]: false,
  [`${GIT}ls-files\\b/`]: true,
  [`${GIT}grep\\b/`]: true,
  [`${GIT}grep\\b.*\\s(?-i:-[aIivwhHEGPFnlLqzco]*[^\\w\\s]*O\\S*)(\\s|$)/`]: false,
  [`${GIT}grep\\b.*\\s(?-i:--[^\\w\\s]*o[^\\w\\s]*p\\S*)(\\s|$)/`]: false,
  [`${GIT}branch\\b/`]: true,
  [`${GIT}branch\\b.*\\s-(d|D|m|M|-delete|-force)\\b/`]: false,
  // docker: read-only sub-commands
  '/^docker\\s+(ps|images|info|version|inspect|logs|top|stats|port|diff|search|events)\\b/': true,
  '/^docker\\s+(container|image|network|volume|context|system)\\s+(ls|ps|inspect|history|show|df|info)\\b/': true,
  '/^docker\\s+compose\\s+(ps|ls|top|logs|images|config|version|port|events)\\b/': true,
  // PowerShell (powershellAutoApproveRules.ts): explicit cmdlets, no Verb-* wildcards
  'Get-ChildItem': true,
  'Get-Content': true,
  'Get-Date': true,
  'Get-Random': true,
  'Get-Location': true,
  'Set-Location': true,
  'Write-Host': true,
  'Write-Output': true,
  'Out-String': true,
  'Split-Path': true,
  'Join-Path': true,
  'Start-Sleep': true,
  'Where-Object': true,
  'Select-Object': true,
  'Select-String': true,
  'Measure-Object': true,
  'Compare-Object': true,
  'Format-List': true,
  'Format-Table': true,
  'Sort-Object': true,
  // npm, yarn, pnpm: read-only commands
  '/^npm\\s+(ls|list|outdated|view|info|show|explain|why|root|prefix|bin|search|doctor|fund|repo|bugs|docs|home|help(-search)?)\\b/': true,
  '/^npm\\s+config\\s+(list|get)\\b/': true,
  '/^npm\\s+pkg\\s+get\\b/': true,
  '/^npm\\s+audit$/': true,
  '/^npm\\s+cache\\s+verify\\b/': true,
  '/^yarn\\s+(list|outdated|info|why|bin|help|versions)\\b/': true,
  '/^yarn\\s+licenses\\b/': true,
  '/^yarn\\s+audit\\b(?!.*\\bfix\\b)/': true,
  '/^yarn\\s+config\\s+(list|get)\\b/': true,
  '/^yarn\\s+cache\\s+dir\\b/': true,
  '/^pnpm\\s+(ls|list|outdated|why|root|bin|doctor)\\b/': true,
  '/^pnpm\\s+licenses\\b/': true,
  '/^pnpm\\s+audit\\b(?!.*\\bfix\\b)/': true,
  '/^pnpm\\s+config\\s+(list|get)\\b/': true,
  // Lockfile-only installs
  'npm ci': true,
  '/^npm\\s+ci\\s+\\S/': false,
  '/^yarn\\s+install\\s+--frozen-lockfile\\b/': true,
  '/^yarn\\s+install\\s+--frozen-lockfile\\s+\\S/': false,
  '/^pnpm\\s+install\\s+--frozen-lockfile\\b/': true,
  '/^pnpm\\s+install\\s+--frozen-lockfile\\s+\\S/': false,
  // Safe, with some arguments always asking
  column: true,
  '/^column\\b.*\\s-c\\s+[0-9]{4,}/': false,
  date: true,
  '/^date\\b.*\\s(-s|--set)\\b/': false,
  find: true,
  '/^find\\b.*\\s-(delete|exec|execdir|fprint\\w*|fprintf|fls|ok|okdir)\\b/': false,
  rg: true,
  '/^rg\\b.*\\s(--pre|--hostname-bin)\\b/': false,
  sed: true,
  // Tessel: editing a file in place (VS Code catches it with its file-write analyzer).
  '/^sed\\b.*\\s(-[a-zA-Z]*i|--in-place)/': false,
  '/^sed\\b.*\\s(-[a-zA-Z]*(e|f)[a-zA-Z]*|--expression|--file)\\b/': false,
  '/^sed\\b.*s\\/.*\\/.*\\/[ew]/': false,
  "/^sed\\b(?:\\s+(?:(?:-l|--line-length)\\s+\\S+|--line-length=\\S+|-\\S+))*\\s+(['\"])\\s*(?:(?:\\d+|\\$|\\/(?:\\\\.|[^\\/])*\\/)(?:\\s*,\\s*(?:\\d+|\\$|\\/(?:\\\\.|[^\\/])*\\/))?)?\\s*!?\\s*[erRwW](?:\\s|\\1)/": false,
  "/^sed\\b(?:\\s+(?:(?:-l|--line-length)\\s+\\S+|--line-length=\\S+|-\\S+))*\\s+(['\"])(?:\\\\.|(?!\\1).)*[;{]\\s*(?:(?:\\d+|\\$|\\/(?:\\\\.|[^\\/])*\\/)(?:\\s*,\\s*(?:\\d+|\\$|\\/(?:\\\\.|[^\\/])*\\/))?)?\\s*!?\\s*[erRwW](?:\\s|\\1|[;}])/": false,
  '/^sed\\b(?:\\s+(?:(?:-l|--line-length)\\s+\\S+|--line-length=\\S+|-\\S+))*\\s+(?:(?:\\d+|\\$|\\/(?:\\\\.|[^\\/])*\\/)(?:\\s*,\\s*(?:\\d+|\\$|\\/(?:\\\\.|[^\\/])*\\/))?)?\\s*!?\\s*[erRwW](?:\\s|$)/': false,
  // sort (sortAutoApproveRules.ts)
  '/^sort\\b(?!-)/': true,
  '/^sort\\b.*\\s-(o|S)\\b/': false,
  // Tessel: joined short options too (-no out, -oFILE).
  '/^sort\\b.*\\s-[a-zA-Z]*o/': false,
  "/^sort\\b.*\\s(?:\\$?['\"]|\\\\)*-(?:\\$?['\"]|\\\\)*-(?:\\$?['\"]|\\\\)*c(?:\\$?['\"]|\\\\)*o/": false,
  tree: true,
  '/^tree\\b.*\\s-o\\b/': false,
  '/^tree\\b.*\\s-[a-zA-Z]*o/': false,
  '/^xxd$/': true,
  '/^xxd\\b(\\s+-\\S+)*\\s+[^-\\s]\\S*$/': true,
  // Dangerous commands: always ask
  rm: false,
  rmdir: false,
  del: false,
  'Remove-Item': false,
  ri: false,
  rd: false,
  erase: false,
  dd: false,
  kill: false,
  ps: false,
  top: false,
  'Stop-Process': false,
  spps: false,
  taskkill: false,
  'taskkill.exe': false,
  curl: false,
  wget: false,
  'Invoke-RestMethod': false,
  'Invoke-WebRequest': false,
  irm: false,
  iwr: false,
  chmod: false,
  chown: false,
  'Set-ItemProperty': false,
  sp: false,
  'Set-Acl': false,
  jq: false,
  xargs: false,
  eval: false,
  'Invoke-Expression': false,
  iex: false
})

// Shells and interpreters, evaluation, elevation and downloads: never offered
// as a prefix rule on the approval card (the exact line still can be).
export const NEVER_SUGGEST = new Set([
  'bash', 'sh', 'zsh', 'fish', 'ksh', 'csh', 'tcsh', 'dash',
  'pwsh', 'powershell', 'powershell.exe', 'cmd', 'cmd.exe',
  'python', 'python3', 'node', 'ruby', 'perl', 'php', 'lua',
  'eval', 'exec', 'source', 'sudo', 'su', 'doas',
  'curl', 'wget', 'invoke-restmethod', 'invoke-webrequest', 'irm', 'iwr'
]) // prettier-ignore
const WITH_SUBCOMMANDS = new Set(['git', 'npm', 'npx', 'yarn', 'docker', 'kubectl', 'cargo', 'dotnet', 'mvn', 'gradle'])
const WITH_SUB_SUBCOMMANDS = new Set(['npm run', 'yarn run'])
// Commands that fetch web content: the card warns about prompt injection.
const WEB_COMMANDS = ['curl', 'wget']
const WEB_COMMANDS_PWSH = ['invoke-restmethod', 'invoke-webrequest', 'irm', 'iwr']

const NEVER_MATCH = /(?!.*)/
const TRANSIENT_ENV = /^[A-Z_][A-Z0-9_]*=/i
export const MAX_RULES = 1000
export const MAX_RULE_KEY = 2000

function escapeRegExp(s) {
  return s.replace(/[\\{}*+?|^$.[\]()]/g, '\\$&')
}
// A regular expression that matches the empty string at its first place
// forever (VS Code's regExpLeadsToEndlessLoop).
function endlessLoop(re) {
  if (re.source === '^' || re.source === '^$' || re.source === '$' || re.source === '^\\s*$') return false
  const m = re.exec('')
  return !!(m && re.lastIndex === 0) && re.global
}

// A rule's key -> its regular expression (VS Code's _doConvertAutoApproveEntryToRegex).
export function ruleRegex(key) {
  const value = String(key)
  const m = /^\/(.+)\/([dgimsuvy]*)$/.exec(value)
  if (m) {
    const flags = (m[2] || '').replace(/g/g, '')
    if (m[1] === '.*') return new RegExp(m[1])
    try {
      const re = new RegExp(m[1], flags || undefined)
      return endlessLoop(re) ? NEVER_MATCH : re
    } catch {
      // An engine without inline modifiers ((?-i:C), Node before 23): in a
      // case-sensitive expression the group means the same without them.
      if (!flags.includes('i') && m[1].includes('(?-i:')) {
        try {
          return new RegExp(m[1].replace(/\(\?-i:/g, '(?:'), flags || undefined)
        } catch {
          return NEVER_MATCH
        }
      }
      return NEVER_MATCH
    }
  }
  if (value === '') return NEVER_MATCH
  let pattern
  if (value.includes('/') || value.includes('\\')) {
    // A path: either separator, and an optional ./ in front.
    pattern = escapeRegExp(value.replace(/[/\\]/g, '%%PATH_SEP%%')).replace(/%%PATH_SEP%%*/g, '[/\\\\]')
    pattern = `^(?:\\.[/\\\\])?${pattern}`
  } else pattern = `^${escapeRegExp(value)}`
  return new RegExp(`${pattern}\\b`)
}
function ruleOf(key, value, source, isDefault) {
  const regex = ruleRegex(key)
  let ci = regex
  if (!regex.flags.includes('i')) {
    // The key's own source (with its (?-i:...) groups), case-insensitive.
    const m = /^\/(.+)\/([dgimsuvy]*)$/.exec(String(key))
    try {
      ci = new RegExp(m ? m[1] : regex.source, `${regex.flags}i`)
    } catch {
      // No inline modifiers here: never matches rather than matching -c for -C.
      ci = m && m[1].includes('(?-i:') ? NEVER_MATCH : regex
    }
  }
  return { key, regex, regexCaseInsensitive: ci, source, isDefault, approve: value === true || (value && value.approve === true), matchCommandLine: !!(value && typeof value === 'object' && value.matchCommandLine === true) }
}

// A rules object as stored (key -> true | false | null | { approve, matchCommandLine }) -> clean.
export function cleanRules(raw) {
  const out = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  let n = 0
  for (const [k, v] of Object.entries(raw)) {
    if (typeof k !== 'string' || !k || k.length > MAX_RULE_KEY || ++n > MAX_RULES) continue
    if (v === true || v === false || v === null) out[k] = v
    else if (v && typeof v === 'object' && typeof v.approve === 'boolean') out[k] = { approve: v.approve, ...(v.matchCommandLine === true ? { matchCommandLine: true } : {}) }
  }
  return out
}

// The rules in force: the defaults (unless ignored), then the user's, then
// the project's (a higher scope's value for a key replaces the lower one; null
// unsets it). -> { deny, allow, denyLine, allowLine } (lists of rules).
export function buildRules({ user = {}, workspace = {}, ignoreDefaults = false } = {}) {
  const merged = new Map()
  if (!ignoreDefaults) for (const [k, v] of Object.entries(DEFAULT_RULES)) merged.set(k, { v, source: 'default' })
  for (const [k, v] of Object.entries(cleanRules(user))) merged.set(k, { v, source: 'user' })
  for (const [k, v] of Object.entries(cleanRules(workspace))) merged.set(k, { v, source: 'workspace' })
  return listsOf([...merged].map(([k, { v, source }]) => [k, v, source]))
}
function listsOf(entries) {
  const lists = { deny: [], allow: [], denyLine: [], allowLine: [] }
  for (const [k, v, source] of entries) {
    if (v === null || v === undefined) continue
    if (typeof v !== 'boolean' && !(v && typeof v.approve === 'boolean')) continue
    const r = ruleOf(k, v, source, source === 'default')
    const list = r.matchCommandLine ? (r.approve ? lists.allowLine : lists.denyLine) : r.approve ? lists.allow : lists.deny
    list.push(r)
  }
  return lists
}
// An agent's session rules (only approving ones exist): key -> true | { approve, matchCommandLine }.
export function sessionRules(raw) {
  return listsOf(Object.entries(cleanRules(raw)).map(([k, v]) => [k, v, 'session']))
}

function matches(rule, command, isPwsh) {
  // PowerShell is case-insensitive; "(Get-Content x) | ..." is matched without its "(".
  if ((isPwsh ? rule.regexCaseInsensitive : rule.regex).test(command)) return true
  return isPwsh && command.startsWith('(') && rule.regexCaseInsensitive.test(command.slice(1))
}

// One sub-command -> { result: 'approved' | 'denied' | 'noMatch', rule?, reason }.
export function commandApproval(command, rules, session, isPwsh) {
  if (TRANSIENT_ENV.test(command)) return { result: 'denied', reason: `'${command}' sets an environment variable for one command` }
  for (const rule of rules.deny) if (matches(rule, command, isPwsh)) return { result: 'denied', rule, reason: `'${command}' is denied by rule ${rule.key}` }
  for (const rule of session.allow) if (matches(rule, command, isPwsh)) return { result: 'approved', rule, reason: `'${command}' is approved by session rule ${rule.key}` }
  for (const rule of rules.allow) if (matches(rule, command, isPwsh)) return { result: 'approved', rule, reason: `'${command}' is approved by rule ${rule.key}` }
  return { result: 'noMatch', reason: `'${command}' has no matching rule` }
}
export function commandLineApproval(line, rules, session) {
  for (const rule of rules.denyLine) if (rule.regex.test(line)) return { result: 'denied', rule, reason: `the command line is denied by rule ${rule.key}` }
  for (const rule of session.allowLine) if (rule.regex.test(line)) return { result: 'approved', rule, reason: `the command line is approved by session rule ${rule.key}` }
  for (const rule of rules.allowLine) if (rule.regex.test(line)) return { result: 'approved', rule, reason: `the command line is approved by rule ${rule.key}` }
  return { result: 'noMatch', reason: 'the command line has no matching rule' }
}

// --- Splitting a command line into sub-commands ----------------------------------------
// -> { subCommands, hasUnanalyzableSyntax, fileWrites, reason }
// Like VS Code's tree-sitter query "(command) @command", a command inside
// $(...), backticks, <(...), (...) or { ... } is a sub-command of its own,
// besides the command that holds it. Unanalyzable (never auto-approved):
// a parse it is not sure of, a standalone assignment or declaration, a
// PowerShell call (&) or dot-source, control flow, a here-document or
// here-string, arithmetic, a hashtable.
const BASH_KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'function', 'select', 'coproc', 'time', '[[', ']]', '!', '{', '}'])
const PWSH_KEYWORDS = new Set(['if', 'elseif', 'else', 'foreach', 'for', 'while', 'do', 'until', 'switch', 'function', 'filter', 'workflow', 'try', 'catch', 'finally', 'trap', 'param', 'begin', 'process', 'end', 'class', 'enum', 'using', 'return', 'throw', 'break', 'continue', 'exit', 'data', 'dynamicparam'])
const BASH_DECLARATIONS = new Set(['export', 'declare', 'typeset', 'local', 'readonly'])
const NULL_TARGETS = /^(?:\/dev\/null|\$null|nul)$/i

// PowerShell reads the typographic quotes as quotes, and en / em dashes as
// the dash of a parameter.
const SMART_SINGLE = /[‘-‛]/g
const SMART_DOUBLE = /[“-„]/g
const ODD_QUOTE_OR_DASH = /[‐-‟′-‷−«»‹›＂＇－]/

export function splitCommandLine(commandLine, lang = 'bash') {
  const pwsh = lang === 'powershell'
  const raw = String(commandLine == null ? '' : commandLine)
  const s = pwsh ? raw.replace(SMART_SINGLE, "'").replace(SMART_DOUBLE, '"') : raw
  const subCommands = []
  const fileWrites = []
  let why = null
  const unsure = (reason) => {
    if (!why) why = reason
  }
  // Fail closed on what a shell may read differently from this splitter: more
  // than one line, a comment, a typographic quote or dash.
  if (/[\r\n]/.test(raw)) unsure('several lines')
  if (raw.includes('#')) unsure('a # (comment)')
  if (ODD_QUOTE_OR_DASH.test(raw)) unsure('a typographic quote or dash')

  // Scans from i until `closer` (')', '}', '`' or null for the end) at this
  // level. Returns the index after the closer.
  function scan(i, closer) {
    let segStart = i
    let order = subCommands.length // where this segment's own command goes (before its nested ones)
    // A group at the start of the segment ((...) or { ... }): when it is the
    // whole segment it is no command of its own, only its commands are.
    let group = null
    const finish = (end) => {
      const text = s.slice(segStart, end).trim()
      const wholeGroup = group && group.start === segStart + (s.slice(segStart).length - s.slice(segStart).trimStart().length) && !s.slice(group.end, end).trim()
      group = null
      if (text && !wholeGroup) {
        checkSegment(text)
        subCommands.splice(order, 0, text)
      }
    }
    const next = (end, after) => {
      finish(end)
      segStart = after
      order = subCommands.length
    }
    while (i < s.length) {
      const c = s[i]
      const c2 = s[i + 1]
      // The closer of this level.
      if (closer && c === closer && (closer !== '}' || pwsh || atCommandStart(segStart, i))) {
        finish(i)
        return i + 1
      }
      // A comment: # at the start of a word, to the end of the line.
      if (c === '#' && (i === 0 || /[\s;|&(){}]/.test(s[i - 1]))) {
        if (pwsh && s[i - 1] === '<') unsure('block comment')
        const nl = s.indexOf('\n', i)
        next(i, nl < 0 ? s.length : nl + 1)
        i = nl < 0 ? s.length : nl + 1
        continue
      }
      if (pwsh && c === '`') {
        i += 2 // an escaped character
        continue
      }
      if (!pwsh && c === '\\') {
        i += 2
        continue
      }
      if (c === "'") {
        if (pwsh && s[i - 1] === '@') {
          unsure('here-string')
        }
        const end = pwsh ? endOfPwshSingle(i) : s.indexOf("'", i + 1)
        if (end < 0) {
          unsure('unclosed quote')
          return s.length
        }
        i = end + 1
        continue
      }
      if (c === '"') {
        if (pwsh && s[i - 1] === '@') unsure('here-string')
        const end = doubleQuoted(i + 1)
        if (end < 0) {
          unsure('unclosed quote')
          return s.length
        }
        i = end + 1
        continue
      }
      if (!pwsh && c === '`') {
        i = scan(i + 1, '`')
        continue
      }
      if (c === '$' && c2 === '(') {
        if (!pwsh && s[i + 2] === '(') {
          unsure('arithmetic')
          i = skipBalanced(i + 2)
          continue
        }
        i = scan(i + 2, ')')
        continue
      }
      if (!pwsh && c === '$' && c2 === '{') {
        const end = s.indexOf('}', i + 2)
        if (end < 0) {
          unsure('unclosed ${')
          return s.length
        }
        if (/[`$(]/.test(s.slice(i + 2, end))) unsure('expansion inside ${...}')
        i = end + 1
        continue
      }
      if (pwsh && c === '@' && c2 === '(') {
        i = scan(i + 2, ')')
        continue
      }
      if (pwsh && c === '@' && c2 === '{') {
        unsure('hashtable')
        i = skipBalanced(i + 1)
        continue
      }
      if (!pwsh && (c === '<' || c === '>') && c2 === '(') {
        i = scan(i + 2, ')')
        continue
      }
      if (c === '(') {
        // PowerShell: a grouping expression; bash: a subshell at the start of a command.
        if (pwsh || atCommandStart(segStart, i)) {
          const start = i
          const first = atCommandStart(segStart, i)
          i = scan(i + 1, ')')
          if (first) group = { start, end: i }
          continue
        }
        unsure('unexpected (')
        i++
        continue
      }
      if (c === '{') {
        if (pwsh || (atCommandStart(segStart, i) && /\s/.test(c2 || ''))) {
          // A script block / a group: its commands are sub-commands.
          const start = i
          const first = atCommandStart(segStart, i)
          i = scan(i + 1, '}')
          if (first) group = { start, end: i }
          continue
        }
        i++
        continue
      }
      if (c === ')' || c === '}') {
        // A closer of no level here.
        if (!closer || c !== closer) unsure(`unexpected ${c}`)
        i++
        continue
      }
      if (c === '\n' || c === ';') {
        next(i, i + 1)
        i++
        continue
      }
      if (c === '|' || c === '&') {
        if (c2 === c) {
          next(i, i + 2)
          i += 2
          continue
        }
        if (c === '&') {
          // 2>&1, >&2, &> file: a redirection.
          if (s[i - 1] === '>' || c2 === '>') {
            i = redirection(i, c2 === '>' ? i + 2 : i + 1)
            continue
          }
          if (pwsh) {
            if (atCommandStart(segStart, i)) unsure('call operator')
            else unsure('background job')
            i++
            continue
          }
          // bash: run in the background, then the next command.
          next(i, i + 1)
          i++
          continue
        }
        // A pipe (bash |& too).
        next(i, c2 === '&' && !pwsh ? i + 2 : i + 1)
        i += c2 === '&' && !pwsh ? 2 : 1
        continue
      }
      if (c === '<' && c2 === '<') {
        unsure('here-document')
        i += 2
        continue
      }
      if (c === '>') {
        i = redirection(i, i + (c2 === '>' ? 2 : 1))
        continue
      }
      i++
    }
    if (closer) unsure(`unclosed ${closer === '`' ? 'backtick' : closer === ')' ? '(' : '{'}`)
    finish(s.length)
    return s.length
  }

  function atCommandStart(segStart, i) {
    return !s.slice(segStart, i).trim()
  }
  function endOfPwshSingle(i) {
    for (let j = i + 1; j < s.length; j++) {
      if (s[j] === "'") {
        if (s[j + 1] === "'") {
          j++
          continue
        }
        return j
      }
    }
    return -1
  }
  // Inside "...": $(...) and (bash) backticks are commands too. -> index of the closing ".
  function doubleQuoted(i) {
    while (i < s.length) {
      const c = s[i]
      if ((pwsh && c === '`') || (!pwsh && c === '\\')) {
        i += 2
        continue
      }
      if (c === '"') {
        if (pwsh && s[i + 1] === '"') {
          i += 2
          continue
        }
        return i
      }
      if (c === '$' && s[i + 1] === '(') {
        if (!pwsh && s[i + 2] === '(') {
          unsure('arithmetic')
          i = skipBalanced(i + 2)
          continue
        }
        i = scan(i + 2, ')')
        continue
      }
      if (!pwsh && c === '`') {
        i = scan(i + 1, '`')
        continue
      }
      i++
    }
    return -1
  }
  function skipBalanced(i) {
    const open = s[i]
    const close = open === '(' ? ')' : '}'
    let depth = 0
    for (let j = i; j < s.length; j++) {
      if (s[j] === open) depth++
      else if (s[j] === close && --depth === 0) return j + 1
    }
    unsure('unbalanced')
    return s.length
  }
  // A redirection's target: a file written (not /dev/null, $null, nul, &1).
  function redirection(at, i) {
    while (s[i] === ' ' || s[i] === '\t') i++
    if (s[i] === '&') return i + 2
    let j = i
    let target = ''
    while (j < s.length && !/[\s;|&<>()]/.test(s[j])) {
      if (s[j] === '"' || s[j] === "'") {
        const end = s[j] === "'" ? s.indexOf("'", j + 1) : doubleQuoted(j + 1)
        if (end < 0) {
          unsure('unclosed quote')
          return s.length
        }
        target += s.slice(j + 1, end)
        j = end + 1
        continue
      }
      target += s[j]
      j++
    }
    if (!target) unsure('redirection without a target')
    else if (!NULL_TARGETS.test(target)) fileWrites.push(target)
    return j
  }
  function checkSegment(text) {
    const first = text.split(/\s+/)[0]
    if (pwsh) {
      if (PWSH_KEYWORDS.has(first.toLowerCase())) unsure(`statement ${first}`)
      if (/^\$[\w:{}]+(?:\[[^\]]*\])?\s*(?:[-+*/%]|\?\?)?=(?!=)/.test(text)) unsure('assignment')
      if (/^[&.]\s/.test(text) || /^[&.](?=['"$])/.test(text)) unsure('call operator')
    } else {
      if (BASH_KEYWORDS.has(first)) unsure(`keyword ${first}`)
      if (BASH_DECLARATIONS.has(first)) unsure(`declaration ${first}`)
      // Only assignments, no command after them.
      if (/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S*)\s*)+$/.test(text)) unsure('assignment')
    }
  }

  scan(0, null)
  return { subCommands, hasUnanalyzableSyntax: !!why, fileWrites, reason: why }
}

// "  && " -> ";" for Windows PowerShell 5.1, which has no && (VS Code's
// commandLinePwshChainOperatorRewriter does it with tree-sitter). Only when
// the line splits cleanly; || is left alone (no plain equivalent).
export function rewritePwshChain(commandLine) {
  const s = String(commandLine || '')
  if (!s.includes('&&')) return s
  const { hasUnanalyzableSyntax } = splitCommandLine(s, 'powershell')
  if (hasUnanalyzableSyntax) return s
  let out = ''
  let quote = null
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quote) {
      out += c
      if (c === '`') {
        out += s[i + 1] || ''
        i++
      } else if (c === quote) quote = null
      continue
    }
    if (c === "'" || c === '"') quote = c
    if (c === '`') {
      out += c + (s[i + 1] || '')
      i++
      continue
    }
    if (c === '&' && s[i + 1] === '&') {
      out = `${out.replace(/\s+$/, '')}; `
      i++
      while (s[i + 1] === ' ') i++
      continue
    }
    out += c
  }
  return out
}

// --- The decision (VS Code's CommandLineAutoApproveAnalyzer) ---------------------------
// opts: { lang: 'bash' | 'powershell', rules (buildRules), session: { allowAll, rules }, enabled }
// -> { isAutoApproved, isAutoApproveAllowed, isDenied, info, disclaimers, actions, subCommands }
export function analyzeCommandLine(commandLine, { lang = 'bash', rules = buildRules(), session = {}, enabled = false } = {}) {
  const isPwsh = lang === 'powershell'
  const line = String(commandLine || '').trimStart()
  const sess = sessionRules(session.rules)
  // A shell Tessel cannot read (cmd, fish, an SSH host's unknown shell):
  // nothing is auto-approved, no rule is offered.
  if (lang !== 'bash' && lang !== 'powershell') return { isAutoApproved: false, isAutoApproveAllowed: false, isDenied: false, info: null, disclaimers: ['unanalyzable'], actions: [], subCommands: [], reason: 'unknown shell' }
  if (enabled && session.allowAll) return { isAutoApproved: true, isAutoApproveAllowed: true, isDenied: false, info: 'Allowed for this session', disclaimers: [], actions: [], subCommands: [] }
  const parsed = splitCommandLine(line, lang)
  const subCommands = parsed.subCommands
  if (!subCommands.length) return { isAutoApproved: false, isAutoApproveAllowed: false, isDenied: false, info: null, disclaimers: [], actions: [], subCommands }
  const subResults = subCommands.map((c) => commandApproval(c, rules, sess, isPwsh))
  const lineResult = commandLineApproval(line, rules, sess)
  let isAutoApproved = false
  let isDenied = false
  let info = null
  const label = (r) => `${r.rule.key}${r.rule.source === 'default' ? ' (default)' : r.rule.source === 'session' ? ' (session)' : r.rule.source === 'workspace' ? ' (project)' : ''}`
  const denied = subResults.find((r) => r.result === 'denied')
  if (denied) {
    isDenied = true
    info = denied.rule ? `Auto approval denied by rule ${label(denied)}` : `Auto approval denied: ${denied.reason}`
  } else if (lineResult.result === 'denied') {
    isDenied = true
    info = `Auto approval denied by rule ${label(lineResult)}`
  } else if (subResults.every((r) => r.result === 'approved')) {
    isAutoApproved = true
    const keys = [...new Set(subResults.map(label))]
    info = `Auto approved by rule${keys.length > 1 ? 's' : ''} ${keys.join(', ')}`
  } else if (lineResult.result === 'approved') {
    isAutoApproved = true
    info = `Auto approved by rule ${label(lineResult)}`
  }
  // A file written (other than /dev/null): VS Code blocks auto approval for
  // writes outside the workspace; Tessel asks for every one.
  const blocked = parsed.hasUnanalyzableSyntax || parsed.fileWrites.length > 0
  // Not approved after all: the card does not say it was.
  if ((blocked || !enabled) && isAutoApproved) {
    isAutoApproved = false
    info = null
  }
  const disclaimers = []
  const firstWords = subCommands.map((c) => c.split(' ')[0].toLowerCase())
  if (!isAutoApproved && (firstWords.some((w) => WEB_COMMANDS.includes(w)) || (isPwsh && firstWords.some((w) => WEB_COMMANDS_PWSH.includes(w)))))
    disclaimers.push('web')
  if (parsed.fileWrites.length) disclaimers.push('fileWrite')
  if (parsed.hasUnanalyzableSyntax) disclaimers.push('unanalyzable')
  const actions = !isAutoApproved && !parsed.hasUnanalyzableSyntax ? autoApproveActions(line, subCommands, { subResults, lineResult }) : []
  return { isAutoApproved, isAutoApproveAllowed: !parsed.hasUnanalyzableSyntax, isDenied, info, disclaimers, actions, subCommands, reason: parsed.reason }
}

// The rules the approval card offers (VS Code's generateAutoApproveActions):
// -> [{ kind: 'prefix', keys, scope }, { kind: 'exact', key, scope }, { kind: 'session' }]
export function autoApproveActions(commandLine, subCommands, { subResults, lineResult }) {
  const actions = []
  const canCreate = subResults.every((r) => r.result !== 'denied') && lineResult.result !== 'denied'
  if (canCreate) {
    const unapproved = subCommands.filter((_, i) => subResults[i].result !== 'approved')
    const nextNonFlag = (parts, from) => {
      for (let i = from; i < parts.length; i++) if (!parts[i].startsWith('-')) return i
      return undefined
    }
    const suggest = []
    for (const command of unapproved) {
      const parts = command.trim().split(/\s+/)
      const base = parts[0].toLowerCase()
      // A word shaped like a /regex/ would be stored as one (/./s matches everything).
      if (NEVER_SUGGEST.has(base) || isRegexKey(parts[0])) continue
      let key
      if (WITH_SUBCOMMANDS.has(base)) {
        const sub = nextNonFlag(parts, 1)
        if (sub === undefined) continue
        if (WITH_SUB_SUBCOMMANDS.has(`${parts[0]} ${parts[sub]}`.toLowerCase())) {
          const subSub = nextNonFlag(parts, sub + 1)
          if (subSub === undefined) continue
          key = parts.slice(0, subSub + 1).join(' ')
        } else key = parts.slice(0, sub + 1).join(' ')
      } else key = parts[0]
      if (!suggest.includes(key)) suggest.push(key)
    }
    if (suggest.length) for (const scope of ['session', 'workspace', 'user']) actions.push({ kind: 'prefix', keys: suggest, scope })
    const firstWord = unapproved.length ? unapproved[0].split(' ')[0] : ''
    if (firstWord !== commandLine && !WITH_SUBCOMMANDS.has(commandLine) && !WITH_SUB_SUBCOMMANDS.has(commandLine)) {
      const key = `/^${escapeRegExp(commandLine)}$/`
      for (const scope of ['session', 'workspace', 'user']) actions.push({ kind: 'exact', key, scope })
    }
  }
  actions.push({ kind: 'session' })
  return actions
}

// The rules an action adds: [{ key, value, scope }].
export function rulesOfAction(action) {
  if (!action || typeof action !== 'object') return []
  if (action.kind === 'prefix' && Array.isArray(action.keys)) return action.keys.filter((k) => typeof k === 'string' && k && !isRegexKey(k)).map((key) => ({ key, value: true, scope: action.scope }))
  if (action.kind === 'exact' && typeof action.key === 'string') return [{ key: action.key, value: { approve: true, matchCommandLine: true }, scope: action.scope }]
  return []
}

// A rule key read as a regular expression (/pattern/flags).
export function isRegexKey(key) {
  return /^\/.+\/[a-z]*$/.test(String(key || ''))
}
