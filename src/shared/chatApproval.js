// What a chat approval card shows of a tool call (main and window agree on
// it): Bash's command, else the whole input as pretty JSON. The main process
// sends the first MAX_DETAIL characters with the count of those hidden, so
// the card can say how much it does not show (and fetch the rest).

export const MAX_DETAIL = 8000

// Codex command approvals: what widens the request, shown as its own line
// (protocol names, the same in every language).
const COMMAND_EXTRAS = ['proposedExecpolicyAmendment', 'additionalPermissions', 'networkApprovalContext', 'grantRoot']

function lineValue(v) {
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v) ?? String(v)
  } catch {
    return String(v)
  }
}

// A command input: what runs first (Codex's rawCommand, the whole shell
// line, when it has one), then where it runs, then Codex's parsed reading of
// it and what the request adds. Claude's Bash input has only `command`.
function commandText(value) {
  const raw = typeof value.rawCommand === 'string' && value.rawCommand ? value.rawCommand : value.command
  const lines = [raw]
  if (typeof value.cwd === 'string' && value.cwd) lines.push(`cwd: ${value.cwd}`)
  if (raw !== value.command && value.command) lines.push(`parsed: ${value.command}`)
  for (const k of COMMAND_EXTRAS) if (value[k] != null) lines.push(`${k}: ${lineValue(value[k])}`)
  return lines.join('\n')
}

// The whole text, never cut. `value` is the tool input (an object, or text).
export function approvalText(value) {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'object' && !Array.isArray(value) && typeof value.command === 'string') return commandText(value)
  try {
    return JSON.stringify(value, null, 2) ?? ''
  } catch {
    return String(value)
  }
}

// -> { detail, hidden }: the first `max` characters and how many follow.
// An input whose changes are unknown (a Codex file approval with no known
// item) counts as not all seen: Allow waits for "Show all".
export function approvalPreview(value, max = MAX_DETAIL) {
  const text = approvalText(value)
  const unknown = !!(value && typeof value === 'object' && value.changesUnknown === true)
  if (text.length <= max) return { detail: text, hidden: unknown ? 1 : 0 }
  return { detail: text.slice(0, max), hidden: text.length - max }
}
