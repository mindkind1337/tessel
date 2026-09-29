// What a chat approval card shows of a tool call (main and window agree on
// it): Bash's command, else the whole input as pretty JSON. The main process
// sends the first MAX_DETAIL characters with the count of those hidden, so
// the card can say how much it does not show (and fetch the rest).

export const MAX_DETAIL = 8000

// The whole text, never cut. `value` is the tool input (an object, or text).
export function approvalText(value) {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'object' && !Array.isArray(value) && typeof value.command === 'string') return value.command
  try {
    return JSON.stringify(value, null, 2) ?? ''
  } catch {
    return String(value)
  }
}

// -> { detail, hidden }: the first `max` characters and how many follow.
export function approvalPreview(value, max = MAX_DETAIL) {
  const text = approvalText(value)
  if (text.length <= max) return { detail: text, hidden: 0 }
  return { detail: text.slice(0, max), hidden: text.length - max }
}
