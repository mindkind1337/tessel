// The model Codex's own footer names, read from its screen: the line under
// its input box, "GPT-6-Luna medium fast · C:\Tessel" (older versions:
// "gpt-5.5-codex high · 100% context left · ~/proj"). It is what the session
// runs right now, a /model or a "switch model?" answer included, before its
// next turn writes it to the rollout.
//
// Only the footer counts: the last block of lines under the input box ("›"),
// after the blank line that closes the box. A line of the conversation, and
// a line of the draft typed in the box (a Live Share guest's included, which
// could otherwise pass for the model), is never taken for it; no input box
// on screen (a picker or an approval drawn over it): null, what the pane
// showed stays.

const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const SEGMENT = /^([A-Za-z][\w.:/-]*(?: [A-Za-z0-9][\w.:/-]*){0,2}?)(?:\s+(none|minimal|low|medium|high|xhigh|max))?(?:\s+fast)?$/i
const FAMILY = /^(?:gpt|o\d|codex)[\w.-]*$/i

const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, '-')

// lines: the screen's last lines, top to bottom. models: Codex's listed
// models ({ id, label }), optional. -> { model, name?, effort } or null.
export function codexModelOnScreen(lines, models = []) {
  const rows = (lines || []).map((l) => String(l || '').replace(/\s+$/, ''))
  let prompt = -1
  for (let i = rows.length - 1; i >= 0; i--) {
    if (/^\s*›/.test(rows[i])) {
      prompt = i
      break
    }
  }
  if (prompt === -1) return null
  // The footer: after the last blank line under the box (blank lines at the
  // bottom of the screen aside), its first two lines.
  let end = rows.length
  while (end > prompt + 1 && !rows[end - 1].trim()) end--
  let blank = -1
  for (let i = end - 1; i > prompt; i--) {
    if (!rows[i].trim()) {
      blank = i
      break
    }
  }
  if (blank === -1) return null
  const list = Array.isArray(models) ? models.filter((m) => m && typeof m.id === 'string') : []
  for (let i = blank + 1; i < Math.min(end, blank + 3); i++) {
    const first = rows[i].trim().split(/\s+·\s+/)[0]
    const m = SEGMENT.exec(first)
    if (!m) continue
    const name = m[1]
    const key = norm(name)
    const listed = list.find((x) => norm(x.id) === key || (typeof x.label === 'string' && norm(x.label) === key))
    // A model's name: listed, else one word of OpenAI's families or with a
    // digit (a local model); never a hint such as "tab to queue message".
    if (!listed && (/\s/.test(name) || !(FAMILY.test(key) || (/\d/.test(name) && /[-:]/.test(name))))) continue
    const effort = m[2] ? m[2].toLowerCase() : null
    return { model: listed ? listed.id : key, ...(listed && listed.label ? { name: listed.label } : {}), effort: EFFORTS.includes(effort) ? effort : null }
  }
  return null
}
