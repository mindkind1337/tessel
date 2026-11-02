// What shows as nothing, in one place: whatever a card, an account's name or a fence takes out, they
// take out the same. (Nothing is imported here, so connections.js and shared.js can both use it.)

// Letters that show as nothing, which a pattern does not take for a space.
export const BLANK_LETTERS = /ᅟ|ᅠ|឴|឵|⠀|ㅤ|ﾠ/g
// Format characters, surrogates alone, private use, what is not assigned, variation selectors, tags.
const UNSEEN = /[\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Default_Ignorable_Code_Point}]/gu

const ZWNJ = '‌'
const ZWJ = '‍'
const VS16 = '️'
const KEYCAP = '⃣'
const EMOJI = /[\p{Extended_Pictographic}\p{Emoji_Modifier}]/u
const EMOJI_BASE = /\p{Emoji}/u
const KEYCAP_BASE = /^[0-9#*]$/
// Alphabets where a joiner between two letters means nothing, so all it can do there is carry a
// message nobody sees. Elsewhere (Persian, Hindi...) it changes how a word is written.
const NO_JOINERS = /[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{Script=Armenian}\p{Script=Georgian}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
const JOINS_AFTER = /[\p{L}\p{M}]/u
const JOINS_BEFORE = /\p{L}/u

const charBefore = (s, at) => {
  if (at <= 0) return ''
  const low = s.charCodeAt(at - 1)
  return low >= 0xdc00 && low <= 0xdfff && at >= 2 ? s.slice(at - 2, at) : s[at - 1]
}
const charAt = (s, at) => (at < s.length ? String.fromCodePoint(s.codePointAt(at)) : '')
const emojiBefore = (s, at) => {
  const prev = charBefore(s, at)
  return EMOJI.test(prev) || (prev === VS16 && EMOJI.test(charBefore(s, at - 1)))
}

// The three that real text needs, only where they do something: in a family emoji, a keycap, a
// Persian or Hindi word. Anywhere else they would only hide something.
function needed(c, at, s) {
  const prev = charBefore(s, at)
  const next = charAt(s, at + c.length)
  if (c === VS16) return KEYCAP_BASE.test(prev) ? next === KEYCAP : EMOJI_BASE.test(prev)
  if (c === ZWJ && emojiBefore(s, at) && EMOJI.test(next)) return true
  if (c !== ZWJ && c !== ZWNJ) return false
  return JOINS_AFTER.test(prev) && !NO_JOINERS.test(prev) && JOINS_BEFORE.test(next) && !NO_JOINERS.test(next)
}

export const withoutUnseen = (value) => String(value).replace(UNSEEN, (c, at, s) => (needed(c, at, s) ? c : ''))
// On one line, as a person would read it.
export const seenLine = (value) => withoutUnseen(String(value).replace(BLANK_LETTERS, ' ')).replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim()
