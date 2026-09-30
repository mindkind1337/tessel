// The query side of session search: how typed words become FTS5 expressions.
// After Orca's src/main/ai-vault-search/session-search-query-planner.ts and
// session-search-identifier-split.ts (MIT, Copyright (c) 2026 Lovecast Inc.).

// Identifier shadow terms: `resolveTerminalPath` -> `resolve terminal path`,
// `src/main/foo-bar.ts` -> `src main foo bar ts`. Stored in their own FTS
// column, so part of an identifier still matches.
const RAW_TOKEN = /[A-Za-z0-9_./-]+/g
const CAMEL_PIECE = /[A-Z]+(?![a-z])|[A-Z][a-z0-9]*|[a-z0-9]+/g
const SEPARATOR = /[_./-]+/
// Worth shadowing: has a separator, a camel boundary, or is SCREAMING_CASE.
const INTERESTING = /[_./-]|[a-z0-9][A-Z]|^[A-Z]{2,}[0-9_]*$/

export function identifierShadowTerms(text, limit = 4000) {
  const out = []
  const seen = new Set()
  for (const match of String(text).matchAll(RAW_TOKEN)) {
    const token = match[0]
    if (token.length < 3 || token.length > 120 || !INTERESTING.test(token)) continue
    const parts = []
    for (const piece of token.split(SEPARATOR)) {
      if (!piece) continue
      parts.push(piece)
      if (/[a-z]/.test(piece) && /[A-Z]/.test(piece)) parts.push(...(piece.match(CAMEL_PIECE) ?? []))
    }
    for (const part of parts) {
      const lowered = part.toLowerCase()
      if (lowered.length < 2 || seen.has(lowered)) continue
      seen.add(lowered)
      out.push(lowered)
      if (out.length >= limit) return out
    }
  }
  return out
}
export const identifierShadowText = (text, limit) => identifierShadowTerms(text, limit).join(' ')

// Tokens as the unicode61 tokenizer with `_ . - / +` tokenchars emits them.
const INDEX_TOKEN = /[\p{L}\p{N}\p{M}\p{Co}_./+-]+/gu
const STOP_WORDS = new Set(
  (
    'a an and are as at be but by for from how i if in into is it its of on or that the this to ' +
    'was were what when where which who why with you your we my me do does did not no can could ' +
    'should would about our us they them there their has have had been being so such then than ' +
    "these those there's im ive dont " +
    // French, as the interface is bilingual.
    'le la les un une des du de et ou mais pour par dans sur avec sans que qui quoi est sont ce cet cette ces ' +
    'il elle ils elles je tu nous vous on ne pas plus au aux en y se sa son ses mon ma mes'
  ).split(' ')
)
const MAX_BODY_TERMS = 48
const MAX_TERMS = 64

// A query that quotes something from a transcript: camelCase, SCREAMING_SNAKE,
// a dotted or snake_case name, a path, a file name, a number reference, a
// ticket, code punctuation, or an error word.
const LITERAL_PATTERN =
  /[A-Za-z0-9_]*[a-z][A-Z][A-Za-z0-9_]*|\b[A-Z][A-Z0-9]{2,}(_[A-Z0-9]+)+\b|\b\w{2,}[._]\w{2,}\b|\b[\w.-]+\/[\w/.-]+\b|\b\w+\.(ts|tsx|js|jsx|vue|py|rs|go|json|md|sh|yml|yaml|toml|c|cc|h|java|sql)\b|#\d{3,}|\b[A-Z]{2,6}-\d{2,}\b|[(){};=]|::|->|--\w|\b(Error|Exception|Traceback|error:|warning:)\b/
const QUOTED = /"[^"]{3,}"|'[^']{3,}'/

export const isLiteralQuery = (query) => QUOTED.test(query) || LITERAL_PATTERN.test(query)

export function indexTokens(query, limit = Infinity) {
  const out = []
  for (const match of String(query).matchAll(INDEX_TOKEN)) {
    // Separators alone (`--`, `...`) are a token to FTS5 but never a search term.
    if (/[\p{L}\p{N}\p{Co}]/u.test(match[0])) {
      out.push(match[0])
      if (out.length >= limit) break
    }
  }
  return out
}

// -> { literal, truncated, terms (for the OR fallback, with identifier
// pieces), body (without stop words for prose), phrase (as typed) }
export function planQuery(query, literal = isLiteralQuery(query)) {
  const overCap = indexTokens(query, MAX_BODY_TERMS + 1)
  const truncated = overCap.length > MAX_BODY_TERMS
  const raw = overCap.slice(0, MAX_BODY_TERMS)
  let body = literal ? raw : raw.filter((token) => !STOP_WORDS.has(token.toLowerCase()))
  if (body.length < 2) body = raw
  const terms = [...new Set(body)]
  const extra = []
  for (const term of terms) {
    for (const piece of identifierShadowTerms(term, 12)) {
      if (!terms.includes(piece) && !STOP_WORDS.has(piece) && !extra.includes(piece)) extra.push(piece)
    }
  }
  return { literal, truncated, terms: [...terms, ...extra].slice(0, MAX_TERMS), body, phrase: raw }
}

// `cli.mjs`, `foo-bar` and `C++` are FTS5 syntax errors unquoted.
export const quoteFtsTerm = (term) => `"${String(term).replaceAll('"', '""')}"`
export const phraseExpression = (terms) => quoteFtsTerm(terms.join(' '))
export const andExpression = (terms) => terms.map(quoteFtsTerm).join(' AND ')
export const orExpression = (terms) => terms.map(quoteFtsTerm).join(' OR ')
