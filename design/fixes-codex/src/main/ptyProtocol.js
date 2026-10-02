// Shared bits of the app <-> terminal host protocol.
//
// Bump PROTOCOL when messages change incompatibly: the app then asks an old
// host to shut down and starts a new one (only on a real protocol change).
export const PROTOCOL = 1

// (The host now replays a serialized screen instead of raw output.)
export const HOST_BUFFER_BYTES = 256 * 1024

// Keep the last `max` characters, cut at a line start when possible so the
// replay doesn't begin in the middle of an escape sequence.
export function trimBuffer(text, max) {
  if (text.length <= max) return text
  let cut = text.length - max
  const nl = text.indexOf('\n', cut)
  if (nl >= 0 && nl - cut < 4096) cut = nl + 1
  return text.slice(cut)
}

// Named pipe for this user and app flavour (dev and installed app use
// separate hosts).
export function pipeName(user, channel) {
  const safe = (s) => String(s || 'user').replace(/[^A-Za-z0-9_.-]/g, '_')
  return `\\\\.\\pipe\\tessel-${safe(user)}-${safe(channel)}`
}
