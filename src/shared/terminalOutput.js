// What a terminal's output says about its command, for the agents' terminal
// tools: a prompt is back, the program waits for an answer, it asks for a
// secret; the command's output without its echo and the next prompt; an
// output too large for an answer.
//
// Ported from Visual Studio Code's chat terminal tools. Copyright (c)
// Microsoft Corporation. Licensed under the MIT License
// (https://github.com/microsoft/vscode/blob/main/LICENSE.txt):
// - src/vs/workbench/contrib/terminalContrib/chatAgentTools/browser/
//   executeStrategy/executeStrategy.ts (detectsCommonPromptPattern)
// - .../executeStrategy/strategyHelpers.ts (stripCommandEchoAndPrompt,
//   findCommandEcho, stripNewLinesAndBuildMapping)
// - .../tools/monitoring/outputMonitor.ts (getLastLine,
//   detectsHighConfidenceInputPattern, detectsLikelyInputRequiredPattern,
//   detectsSensitiveInputPrompt, detectsNonInteractiveHelpPattern,
//   detectsGenericPressAnyKeyPattern)
// - .../browser/outputHelpers.ts (MAX_OUTPUT_LENGTH, truncateLargeOutput)
// - .../browser/runInTerminalHelpers.ts (truncateOutputKeepingTail)

export const MAX_OUTPUT_LENGTH = 20000
const PREVIEW_CHARS = 500
// get_terminal_output: the tail only.
export const MAX_POLL_OUTPUT = 8000

// Does the cursor's line look like a shell waiting for a command?
export function detectsCommonPromptPattern(cursorLine) {
  const s = String(cursorLine || '')
  if (!s.trim()) return false
  return (
    /PS\s+[A-Z]:\\.*>\s*$/.test(s) || // PowerShell: PS C:\>
    /^[A-Z]:\\.*>\s*$/.test(s) || // cmd: C:\path>
    /\$\s*$/.test(s) || // bash-style
    /#\s*$/.test(s) || // root
    /^>>>\s*$/.test(s) || // Python REPL
    /\u276f\s*$/.test(s) || // starship
    /[>%]\s*$/.test(s) // generic
  )
}

export function getLastLine(output) {
  if (!output) return ''
  const trimmed = String(output).replace(/[\r\n]+$/, '')
  if (!trimmed) return ''
  const lf = trimmed.lastIndexOf('\n')
  const line = lf === -1 ? trimmed : trimmed.slice(lf + 1)
  const cr = line.lastIndexOf('\r')
  return cr === -1 ? line : line.slice(cr + 1)
}

// Patterns specific enough to say a program waits for an answer.
export function detectsHighConfidenceInputPattern(cursorLine) {
  return [
    /\s*(?:\[[^\]]\][^[]*)+(?:\(default is\s+"[^"]+"\):)?\s+$/,
    /(?:\(|\[)\s*(?:y(?:es)?\s*\/\s*n(?:o)?|n(?:o)?\s*\/\s*y(?:es)?)\s*(?:\]|\))\s+$/i,
    /[?:]\s*(?:\(|\[)?\s*y(?:es)?\s*\/\s*n(?:o)?\s*(?:\]|\))?\s+$/i,
    /\(y\) +$/i,
    /:\s+\([^)]*\) +$/,
    /\(END\)$/,
    /password(?: for [^:]+)?:\s*$/i,
    /press a(?:ny)? key/i,
    // eslint-disable-next-line no-control-regex
    /^(?:\s|\x1b\[[0-9;]*m)*\?.*[\u203a\u276f\u25b8\u25b6]\s*$/
  ].some((e) => e.test(cursorLine))
}

// The same, plus a bare ": " or "? " at the end: only when the command is
// known to be still running.
export function detectsLikelyInputRequiredPattern(cursorLine) {
  if (detectsHighConfidenceInputPattern(cursorLine)) return true
  return [/: +$/, /\? *(?:\([a-z\s]+\))? +$/i].some((e) => e.test(cursorLine))
}

// A question for a secret: the agent never answers it, the user types it.
export function detectsSensitiveInputPrompt(cursorLine) {
  return /(password|passphrase|token|api\s*key|secret|verification code|otp\b|one[\s-]?time (?:code|password)|2fa|mfa|pin\s*(?:code|number)?[: ]?\s*$|authentication code)/i.test(String(cursorLine || ''))
}
// "sudo -S" reading its password from stdin is the command's own design.
export function isCanonicalSudoSPrompt(command, prompt) {
  return /(?:^|\s)sudo\s+-S(?:\s|$)/.test(String(command || '')) && /^\[sudo\]\s+password for .+:\s*$/i.test(String(prompt || ''))
}

// A dev server's "press h for help": not a question.
export function detectsNonInteractiveHelpPattern(cursorLine) {
  return [
    /press [h?]\s*(?:\+\s*enter)?\s*to (?:show|open|display|get|see)\s*(?:available )?(?:help|commands|options)/i,
    /press h\s*(?:or\s*\?)?\s*(?:\+\s*enter)?\s*for (?:help|commands|options)/i,
    /press \?\s*(?:\+\s*enter)?\s*(?:to|for)?\s*(?:help|commands|options|list)/i,
    /type\s*[h?]\s*(?:\+\s*enter)?\s*(?:for|to see|to show)\s*(?:help|commands|options)/i,
    /hit\s*[h?]\s*(?:\+\s*enter)?\s*(?:for|to see|to show)\s*(?:help|commands|options)/i,
    /press o\s*(?:\+\s*enter)?\s*(?:to|for)?\s*(?:open|launch)(?:\s*(?:the )?(?:app|application|browser)|\s+in\s+(?:the\s+)?browser)?/i,
    /press r\s*(?:\+\s*enter)?\s*(?:to|for)?\s*(?:restart|reload|refresh)(?:\s*(?:the )?(?:server|dev server|service))?/i,
    /press q\s*(?:\+\s*enter)?\s*(?:to|for)?\s*(?:quit|exit|stop)(?:\s*(?:the )?(?:server|app|process))?/i,
    /press u\s*(?:\+\s*enter)?\s*(?:to|for)?\s*(?:show|print|display)\s*(?:the )?(?:server )?urls?/i
  ].some((e) => e.test(cursorLine))
}

// What the line at the cursor says, once the output has been quiet:
// 'sensitive' | 'input' | null. running: the command is known to still run.
export function inputNeeded(cursorLine, { command = '', running = null } = {}) {
  const line = String(cursorLine || '')
  if (!line.trim()) return null
  if (detectsNonInteractiveHelpPattern(line)) return null
  let input = detectsHighConfidenceInputPattern(line)
  if (!input && running === true && detectsLikelyInputRequiredPattern(line)) input = true
  if (!input) return null
  if (detectsSensitiveInputPrompt(line) && !isCanonicalSudoSPrompt(command, line.trim())) return 'sensitive'
  return 'input'
}

// --- The command's output ---------------------------------------------------------------
export function stripNewLinesAndBuildMapping(output) {
  const indexMapping = []
  const chars = []
  for (let i = 0; i < output.length; i++) {
    if (output[i] !== '\n') {
      chars.push(output[i])
      indexMapping.push(i)
    }
  }
  return { strippedOutput: chars.join(''), indexMapping }
}

export function findCommandEcho(output, commandLine, allowSuffixMatch = false) {
  const command = String(commandLine || '').trim()
  if (!command) return undefined
  const { strippedOutput, indexMapping } = stripNewLinesAndBuildMapping(output)
  const matchIndex = strippedOutput.indexOf(command)
  let matchEnd
  let contentBefore
  if (matchIndex !== -1) {
    contentBefore = strippedOutput.substring(0, matchIndex).trim()
    matchEnd = matchIndex + command.length - 1
  } else if (allowSuffixMatch) {
    let suffixLen = 0
    for (let len = command.length - 1; len >= 1; len--) {
      const suffix = command.substring(command.length - len)
      if (strippedOutput.startsWith(suffix)) {
        const before = command[command.length - len - 1]
        if (before !== undefined && before !== ' ' && before !== '\t') suffixLen = len
        break
      }
    }
    if (!suffixLen) return undefined
    contentBefore = ''
    matchEnd = suffixLen - 1
  } else return undefined
  const originalEnd = indexMapping[matchEnd]
  const lines = output.split('\n')
  let echoEndLine = 0
  let offset = 0
  for (let i = 0; i < lines.length; i++) {
    const lineEnd = offset + lines[i].length
    if (offset <= originalEnd && originalEnd <= lineEnd) {
      echoEndLine = i + 1
      break
    }
    offset = lineEnd + 1
  }
  return { contentBefore, linesAfter: lines.slice(echoEndLine) }
}

function stripOnce(output, commandLine) {
  const echo = findCommandEcho(output, commandLine, true)
  const lines = echo ? echo.linesAfter : output.split('\n')
  const before = echo ? echo.contentBefore : ''
  const isUnixAt = /\w+@[\w.-]+:/.test(before)
  const isUnixHost = !isUnixAt && /[\w.-]+:\S/.test(before)
  const isUnix = isUnixAt || isUnixHost
  const isPowerShell = /^PS\s/i.test(before)
  const isCmd = !isPowerShell && /^[A-Z]:\\/.test(before)
  const isStarship = /\u276f/.test(before)
  const isPython = />>>/.test(before)
  const known = isUnix || isPowerShell || isCmd || isStarship || isPython
  let end = lines.length
  let stripped = 0
  while (end > 0) {
    const line = lines[end - 1].trimEnd()
    if (!line.length) {
      end--
      continue
    }
    if (stripped >= 2) break
    const complete =
      ((!known || isUnixAt) && /^\s*\w+@[\w.-]+:.*[#$]\s*$/.test(line)) ||
      ((!known || isUnixHost) && /^\s*[\w.-]+:\S.*\s\w+[#$]\s*$/.test(line)) ||
      ((!known || isPowerShell) && /^PS\s+[A-Z]:\\.*>\s*$/.test(line)) ||
      ((!known || isCmd) && /^[A-Z]:\\.*>\s*$/.test(line)) ||
      ((!known || isStarship) && /\u276f\s*$/.test(line)) ||
      ((!known || isPython) && /^>>>\s*$/.test(line))
    const fragment =
      ((!known || isUnix) && /^\s*[\w/.-]+[#$]\s*$/.test(line)) ||
      ((!known || isUnix) && /^\[\s*[\w.-]+(@[\w.-]+)?:[~/]/.test(line)) ||
      ((!known || isUnix) && stripped > 0 && /^\s*[\w][-\w.]*(@[\w.-]+)?:\S/.test(line)) ||
      ((!known || isUnix) && /\]\s*[#$]\s*$/.test(line))
    if (complete) {
      end--
      stripped++
      break
    } else if (fragment) {
      end--
      stripped++
    } else break
  }
  return lines.slice(0, end).join('\n')
}

// The output without the echoed command line(s) and the next prompt.
export function stripCommandEchoAndPrompt(output, commandLine) {
  const result = stripOnce(String(output || ''), commandLine)
  if (result.trim().length > 0 && findCommandEcho(result, commandLine)) return stripOnce(result, commandLine)
  return result
}

// An output over MAX_OUTPUT_LENGTH: a preview of its start and its tail, and
// where the whole of it was saved (when it was).
export function truncateLargeOutput(output, filePath) {
  const total = output.length
  const preview = output.slice(0, Math.min(PREVIEW_CHARS, total))
  const sizeKB = Math.ceil(total / 1024)
  const header = filePath
    ? `[Output too large (${sizeKB}KB). Full output saved to: ${filePath}]\n[Use your file reading or search tools to examine the full output.]\n\n`
    : `[Output too large (${sizeKB}KB). Showing preview and tail.]\n\n`
  const separator = '\n\n[... middle of output truncated ...]\n\n'
  const forTail = MAX_OUTPUT_LENGTH - header.length - preview.length - separator.length
  if (forTail <= 0) return (header + preview).slice(0, MAX_OUTPUT_LENGTH)
  return header + preview + separator + output.slice(-forTail)
}

export const TRUNCATION_MESSAGE = '\n\n[... PREVIOUS OUTPUT TRUNCATED ...]\n\n'
export function truncateOutputKeepingTail(output, maxLength) {
  const s = String(output || '')
  if (s.length <= maxLength) return s
  if (TRUNCATION_MESSAGE.length >= maxLength) return TRUNCATION_MESSAGE.slice(TRUNCATION_MESSAGE.length - maxLength)
  return TRUNCATION_MESSAGE + s.slice(-(maxLength - TRUNCATION_MESSAGE.length))
}

// Back-compat name for the window's screen reader.
export const looksLikePrompt = detectsCommonPromptPattern
