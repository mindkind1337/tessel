// A link or image in a file, resolved from that file's folder (Windows
// paths): "../docs/a.md#part" next to C:\p\README.md -> C:\docs\a.md.
// null for what is not a local file (a web address, an empty link).
export function resolveFrom(file, href) {
  let h = String(href || '').trim()
  if (!h || /^(https?|mailto|data|javascript):/i.test(h)) return null
  if (/^file:/i.test(h)) {
    h = h.replace(/^file:\/*/i, '')
    if (/^[A-Za-z]:/.test(h)) h = h.replace(/\//g, '\\')
    else return null
  }
  h = h.replace(/[?#].*$/, '')
  try {
    h = decodeURI(h)
  } catch {
    // keep it as written
  }
  if (!h) return null
  const abs = /^[A-Za-z]:[\\/]/.test(h) || /^\\\\/.test(h)
  const dir = String(file || '').replace(/[\\/][^\\/]*$/, '')
  const joined = abs ? h : `${dir}\\${h}`
  const m = /^([A-Za-z]:|\\\\[^\\/]+[\\/][^\\/]+)(.*)$/.exec(joined.replace(/\//g, '\\'))
  if (!m) return null
  const out = []
  for (const part of m[2].split('\\')) {
    if (!part || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return `${m[1]}\\${out.join('\\')}`
}
