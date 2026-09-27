// OSC 52: a program in the terminal (Claude Code, vim, tmux, an SSH session)
// puts text on the clipboard: ESC ] 52 ; <targets> ; <base64> BEL. Only
// writing is allowed: a read request ("?") is never answered, so no program
// can read the user's clipboard. -> the text to copy, or null.
export const OSC52_MAX = 1024 * 1024

export function osc52Text(data) {
  const s = String(data || '')
  const i = s.indexOf(';')
  if (i < 0) return null
  const b64 = s.slice(i + 1).trim()
  if (!b64 || b64 === '?' || b64.length > (OSC52_MAX * 4) / 3 + 4) return null
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) return null
  try {
    const bin = atob(b64)
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
    return text.length ? text : null
  } catch {
    return null
  }
}
