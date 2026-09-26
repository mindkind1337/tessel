// The short model name shown in an agent pane's header.

// A short name for the header: "claude-opus-5-5" -> "Opus 5.5",
// "claude-sonnet-4-5-20250929" -> "Sonnet 4.5", "opus[1m]" -> "Opus (1M)";
// "anthropic/claude-sonnet-5" -> "Sonnet 5"; anything else as it is.
export function modelLabel(model) {
  let s = String(model || '').trim()
  if (!s) return ''
  s = s.replace(/^.*\//, '')
  const big = /\[1m\]$/i.test(s)
  s = s.replace(/\[1m\]$/i, '')
  const c = /^(?:claude-)?(opus|sonnet|haiku|fable)(?:-(\d+))?(?:-(\d{1,2}))?(?:-\d{8})?$/i.exec(s)
  if (c) {
    const name = c[1][0].toUpperCase() + c[1].slice(1).toLowerCase()
    const ver = c[2] ? (c[3] ? `${c[2]}.${c[3]}` : c[2]) : ''
    return `${name}${ver ? ' ' + ver : ''}${big ? ' (1M)' : ''}`
  }
  return s + (big ? ' (1M)' : '')
}
