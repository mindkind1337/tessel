// What to do with the host key a server presents. Adapted from Orca (MIT,
// Copyright (c) 2026 Lovecast Inc.: src/main/ssh/ssh-host-key-decision.ts),
// with the question Orca had not shipped yet: an unknown key is shown to the
// user (fingerprint dialog) instead of being trusted on first use.
//
//   known_hosts or Tessel's store has this exact key   -> accept
//   a DIFFERENT key (same type) is on file             -> reject, never asked
//   only a key of another type is on file              -> reject (a downgrade)
//   the key is @revoked                                -> reject
//   unknown, StrictHostKeyChecking yes                 -> reject
//   unknown, StrictHostKeyChecking no / off            -> accept, not remembered (as ssh)
//   unknown, StrictHostKeyChecking accept-new          -> accept and remember (as ssh)
//   unknown, a known_hosts file could not be read      -> ask, not remembered
//   unknown otherwise (ask, the default)               -> ask; Yes remembers it
//
// known_hosts outranks Tessel's store when it MATCHES: that is the state the
// remedy for a legitimate key change leaves (ssh-keygen -R, reconnect with
// ssh), and an attacker able to rewrite known_hosts has won already.

const STRICT = new Set(['true', 'yes', 'always'])
const LAX = new Set(['false', 'no', 'off'])

// -> { action: 'accept' | 'prompt' | 'reject', remember: boolean, verified?, code? }
// verified: the key matched a record (an 'accept' without it was not checked:
// sshConnection.js pins it and never sends a kept password to it unpinned).
// code (a rejection): 'revoked' | 'changed' | 'changed-store' | 'changed-type' | 'unknown-strict'
export function decideHostKey({ knownHostsOutcome, storeOutcome, strictHostKeyChecking = 'ask', knownHostsUnreadable = false }) {
  const strict = String(strictHostKeyChecking || 'ask').trim().toLowerCase()
  if (knownHostsOutcome === 'revoked') return { action: 'reject', remember: false, code: 'revoked' }
  if (knownHostsOutcome === 'mismatch') return { action: 'reject', remember: false, code: 'changed' }
  if (knownHostsOutcome === 'match') return { action: 'accept', remember: false, verified: true }
  if (storeOutcome === 'mismatch') return { action: 'reject', remember: false, code: 'changed-store' }
  if (storeOutcome === 'match') return { action: 'accept', remember: false, verified: true }
  if (knownHostsOutcome === 'unknown-type-known-host') return { action: 'reject', remember: false, code: 'changed-type' }
  if (storeOutcome === 'unknown-type-known-host') return { action: 'reject', remember: false, code: 'changed-type-store' }
  // Unknown from here (a CA-only host included: ssh2 cannot check
  // certificates, and OpenSSH treats a plain key there as first contact).
  if (STRICT.has(strict)) return { action: 'reject', remember: false, code: 'unknown-strict' }
  if (LAX.has(strict)) return { action: 'accept', remember: false }
  if (knownHostsUnreadable) return { action: 'prompt', remember: false }
  if (strict === 'accept-new') return { action: 'accept', remember: true }
  return { action: 'prompt', remember: true }
}

// The name `ssh-keygen -R` must be given for this endpoint.
export function keygenRemoveTarget(host, port) {
  return port === 22 ? host : `'[${host}]:${port}'`
}
