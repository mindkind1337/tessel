// Shared code (src/shared) runs in the main process and in the interface,
// which each have their own t(key, english, vars). Shared functions that
// return text take that t() as a parameter; without it they fall back to
// this one: the English, with its {{placeholders}} filled.
export function english(_key, text, vars) {
  const s = String(text ?? '')
  if (!vars) return s
  return s.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, name) => (name in vars ? String(vars[name]) : m))
}
