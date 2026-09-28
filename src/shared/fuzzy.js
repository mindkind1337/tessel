// Fuzzy file search (Jump to file): the letters typed, in order, anywhere in
// the path; better when they are in the file name, next to each other, or at
// the start of a word. -> a score (higher is better) or -1 when it does not
// match.
export function fuzzyScore(query, path) {
  const q = String(query || '').toLowerCase().replace(/\s+/g, '')
  if (!q) return 0
  const p = String(path || '')
  const lower = p.toLowerCase()
  const nameStart = Math.max(lower.lastIndexOf('/'), lower.lastIndexOf('\\')) + 1
  let score = 0
  let at = -1
  let run = 0
  for (const ch of q) {
    const i = lower.indexOf(ch, at + 1)
    if (i < 0) return -1
    run = i === at + 1 ? run + 1 : 0
    score += 1 + run * 3
    if (i >= nameStart) score += 2
    if (i === 0 || /[\\/._\-\s]/.test(p[i - 1]) || (p[i] !== lower[i] && p[i - 1] === lower[i - 1])) score += 3
    at = i
  }
  // The whole query inside the file name: best of all, above all when it is
  // the name itself (App.vue for "app"); then shorter paths first.
  const name = lower.slice(nameStart)
  if (name.includes(q)) score += 20
  if (name.replace(/\.[^.]*$/, '') === q) score += 10
  return score - lower.length * 0.01
}

// [paths] -> the best `limit` matches, best first.
export function fuzzyFilter(query, paths, limit = 50) {
  if (!String(query || '').trim()) return paths.slice(0, limit)
  const out = []
  for (const path of paths) {
    const s = fuzzyScore(query, path)
    if (s >= 0) out.push({ path, s })
  }
  out.sort((a, b) => b.s - a.s)
  return out.slice(0, limit).map((r) => r.path)
}
