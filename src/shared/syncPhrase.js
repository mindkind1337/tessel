// A sync phrase made for the person (Settings > Tessel account > Your settings everywhere): 25
// characters from an alphabet with nothing that reads like something else, in groups to copy by
// hand: about 124 bits. The computer's own randomness, in the window where the phrase is typed anyway.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'
const GROUPS = 5
const GROUP_SIZE = 5

export function suggestPhrase(random = (bytes) => globalThis.crypto.getRandomValues(bytes)) {
  const out = []
  // Bytes above the last whole round of the alphabet are dropped, so each character is as likely.
  const limit = 256 - (256 % ALPHABET.length)
  const wanted = GROUPS * GROUP_SIZE
  while (out.length < wanted) {
    for (const byte of random(new Uint8Array(wanted * 2))) {
      if (byte < limit && out.length < wanted) out.push(ALPHABET[byte % ALPHABET.length])
    }
  }
  const groups = []
  for (let i = 0; i < GROUPS; i++) groups.push(out.slice(i * GROUP_SIZE, (i + 1) * GROUP_SIZE).join(''))
  return groups.join('-')
}
