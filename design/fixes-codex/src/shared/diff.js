// Pure helpers for the review screen: read git's output about a task branch
// (changed files, commits, conflicts, a file's diff) into plain data. No git,
// no DOM, so the main process and the tests share them.

// `git diff --name-status --no-renames` + `git diff --numstat --no-renames`
// (+ `git diff --raw --no-abbrev` for each file's content id)
// -> [{ path, status: 'A'|'M'|'D', added, removed, binary, blob }], sorted by path.
export function parseChangedFiles(nameStatus, numstat, raw = '') {
  const byPath = new Map()
  for (const line of String(nameStatus || '').split(/\r?\n/)) {
    const m = /^([AMDTUX])\t(.+)$/.exec(line)
    if (!m) continue
    byPath.set(m[2], { path: m[2], status: m[1] === 'T' ? 'M' : m[1], added: 0, removed: 0, binary: false })
  }
  for (const line of String(numstat || '').split(/\r?\n/)) {
    const m = /^(-|\d+)\t(-|\d+)\t(.+)$/.exec(line)
    if (!m) continue
    const f = byPath.get(m[3]) || { path: m[3], status: 'M', added: 0, removed: 0, binary: false }
    if (m[1] === '-') f.binary = true
    else {
      f.added = Number(m[1])
      f.removed = Number(m[2])
    }
    byPath.set(m[3], f)
  }
  // `:100644 100644 <old> <new> M<tab>path`: the new content's id (the old
  // one for a deleted file), so a new commit to a file is noticed even when
  // its line counts stay the same.
  for (const line of String(raw || '').split(/\r?\n/)) {
    const m = /^:\d+ \d+ ([0-9a-f]+) ([0-9a-f]+) ([A-Z])\d*\t(.+)$/.exec(line)
    const f = m && byPath.get(m[4])
    if (f) f.blob = m[3] === 'D' ? m[1] : m[2]
  }
  for (const f of byPath.values()) if (!f.blob) f.blob = ''
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path))
}

// Commits listed with --format=%H%x1f%an%x1f%ct%x1f%s%x1f%b%x1e
// -> [{ sha, author, time (ms), subject, body }], newest first.
export function parseCommits(text) {
  return String(text || '')
    .split('\x1e')
    .map((rec) => rec.replace(/^\s+/, ''))
    .filter(Boolean)
    .map((rec) => {
      const [sha, author, ct, subject, body] = rec.split('\x1f')
      return {
        sha: (sha || '').trim(),
        author: author || '',
        time: Number(ct) * 1000 || 0,
        subject: subject || '',
        body: (body || '').trim()
      }
    })
    .filter((c) => /^[0-9a-f]{7,64}$/.test(c.sha))
}

// `git merge-tree --write-tree --name-only --no-messages A B`: the first line
// is the resulting tree; with conflicts, the conflicted files follow.
export function parseMergeTree(text) {
  const lines = String(text || '').split(/\r?\n/)
  const out = []
  for (const line of lines.slice(1)) {
    if (!line.trim()) break
    if (!out.includes(line)) out.push(line)
  }
  return out
}

// `git status --porcelain=v1` -> the paths it lists (renames: the new path).
export function parseStatusPaths(text) {
  const out = []
  for (const line of String(text || '').split(/\r?\n/)) {
    if (line.length < 4) continue
    let p = line.slice(3)
    const arrow = p.indexOf(' -> ')
    if (arrow !== -1) p = p.slice(arrow + 4)
    if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1)
    out.push(p)
  }
  return out
}

// A unified diff of one file -> { binary, hunks: [{ header, lines }] } where
// each line is { kind: 'add'|'del'|'ctx'|'note', text, old, new } with the
// old/new line numbers ('' where the side has no line).
export function parseUnifiedDiff(text) {
  const src = String(text || '')
  const result = { binary: /^Binary files .* differ$/m.test(src), hunks: [] }
  let hunk = null
  let oldNo = 0
  let newNo = 0
  for (const line of src.split(/\r?\n/)) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line)
    if (h) {
      oldNo = Number(h[1])
      newNo = Number(h[2])
      hunk = { header: line, lines: [] }
      result.hunks.push(hunk)
      continue
    }
    if (!hunk) continue
    if (line.startsWith('+')) hunk.lines.push({ kind: 'add', text: line.slice(1), old: '', new: newNo++ })
    else if (line.startsWith('-')) hunk.lines.push({ kind: 'del', text: line.slice(1), old: oldNo++, new: '' })
    else if (line.startsWith(' ')) hunk.lines.push({ kind: 'ctx', text: line.slice(1), old: oldNo++, new: newNo++ })
    else if (line.startsWith('\\')) hunk.lines.push({ kind: 'note', text: line.slice(1).trim(), old: '', new: '' })
  }
  return result
}

// Can the task branch be merged now? -> { ok, reason } for the Merge button.
export function mergeBlocker(info) {
  if (!info || !info.ok) return (info && info.error) || 'Could not read the branch.'
  if (info.uncommitted && info.uncommitted.length)
    return `${info.uncommitted.length} file${info.uncommitted.length > 1 ? 's are' : ' is'} not committed in the agent's copy.`
  if (!info.files || !info.files.length) return 'The branch has no changes to merge.'
  if (info.rootBranch !== info.target)
    return `The project folder is on branch ${info.rootBranch || '(none)'}, not ${info.target}.`
  if (info.conflicts && info.conflicts.length) return `Conflicts with ${info.target}.`
  if (info.dirtyOverlap && info.dirtyOverlap.length)
    return `Unsaved changes in the project folder touch the same files: ${info.dirtyOverlap.join(', ')}.`
  return ''
}
