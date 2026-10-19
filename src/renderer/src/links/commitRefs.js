// Commit hashes in text an agent (or you) wrote: "pushed to GitHub
// (`1f6ccc70`)", "commit abc1234", "abc1234..def5678". Found here by their
// look only; each one becomes a link once its pane's repository says it is
// a commit there (commitLinks.js), never before: a hash that is not one
// stays plain text.
//
// What counts as a hash:
//   - 7 to 40 hex characters, lower case (as git prints them), with at least
//     one digit and one letter a-f: "deadbeef", "1234567" and words like
//     "defaced" are not hashes;
//   - a whole token: no letter, digit or "_" touching it; nor "/" "\" "#"
//     "-" "@" "=" "?" "&" (a path, a URL, a colour, a UUID, an e-mail, a
//     query string);
//   - a "." before it only as a range's ("abc1234..def5678",
//     "abc1234...def5678"); a "." after it only to end a sentence or start a
//     range (never "abc1234.js").
// -> [{ index, length, hash }] (at most MAX_REFS per text).

export const MAX_REFS = 40
const MAX_TEXT = 20000
const HEX_RUN = /[0-9a-f]+/g
const WORD = /[0-9A-Za-z_]/
const NOT_BEFORE = new Set(['/', '\\', '#', '-', '@', '=', '?', '&'])
const NOT_AFTER = new Set(['/', '\\', '#', '-', '@', '=', '?', '&'])

// A hash as people write one (the link router's check: hex only, so it is
// never read as an option or anything but a commit name).
export const isCommitHash = (v) => typeof v === 'string' && /^[0-9a-f]{7,40}$/.test(v)

// One that reads like a hash in prose (a digit and a letter in it).
export const looksLikeCommitHash = (v) => isCommitHash(v) && /[0-9]/.test(v) && /[a-f]/.test(v)

export function findCommitRefs(text, max = MAX_REFS) {
  const s = String(text || '').slice(0, MAX_TEXT)
  if (s.length < 7) return []
  const out = []
  for (const m of s.matchAll(HEX_RUN)) {
    const hash = m[0]
    if (!looksLikeCommitHash(hash)) continue
    const i = m.index
    const end = i + hash.length
    const before = i > 0 ? s[i - 1] : ''
    const after = end < s.length ? s[end] : ''
    if ((before && (WORD.test(before) || NOT_BEFORE.has(before))) || (after && (WORD.test(after) || NOT_AFTER.has(after)))) continue
    if (before === '.' && !/[0-9a-f]\.{2,3}$/.test(s.slice(Math.max(0, i - 4), i))) continue
    if (after === '.' && end + 1 < s.length && WORD.test(s[end + 1])) continue
    out.push({ index: i, length: hash.length, hash })
    if (out.length >= max) break
  }
  return out
}
