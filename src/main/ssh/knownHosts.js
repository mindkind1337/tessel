// OpenSSH known_hosts parsing and matching, ported from Orca (MIT, Copyright
// (c) 2026 Lovecast Inc.: src/main/ssh/ssh-known-hosts.ts and
// ssh-known-hosts-source.ts). Behaviour follows OpenSSH: the two lookup
// passes ([host]:port, then the bare host), revoked keys first, hashed
// (|1|salt|hash) lines, negated patterns, and a strict base64 rule (a line
// OpenSSH itself would ignore is ignored here too).
//
// Tessel only READS the user's known_hosts files; keys the user accepts in
// Tessel go to Tessel's own store (hostKeyStore.js).
import { createHash, createHmac, timingSafeEqual } from 'crypto'
import { readFile } from 'fs/promises'
import { join } from 'path'
import os from 'os'

const HASH_MAGIC = '|1|'
const SHA1_DIGEST_BYTES = 20
const MAX_KEY_TYPE_BYTES = 64
// A known_hosts file larger than this is not read (it would only be a
// mistake or an attack on the app's memory).
export const MAX_KNOWN_HOSTS_BYTES = 8 * 1024 * 1024

// The algorithm name from the key blob's own length-prefixed header.
export function readHostKeyType(key) {
  if (!Buffer.isBuffer(key) || key.length < 4) return undefined
  const length = key.readUInt32BE(0)
  if (length === 0 || length > MAX_KEY_TYPE_BYTES || 4 + length > key.length) return undefined
  return key.subarray(4, 4 + length).toString('utf8')
}

// The blob is exactly a run of length-prefixed fields (what ssh parses).
function isWellFormedHostKeyBlob(key) {
  let offset = 0
  while (offset < key.length) {
    if (offset + 4 > key.length) return false
    const fieldLength = key.readUInt32BE(offset)
    offset += 4
    if (fieldLength > key.length - offset) return false
    offset += fieldLength
  }
  return offset === key.length
}

// SHA256:... exactly as ssh-keygen -lf prints it.
export function hostKeyFingerprint(key) {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`
}

// Buffer.from never throws on bad base64 (it skips characters): the field
// must re-encode to exactly itself, as OpenSSH's b64_pton demands.
function decodeCanonicalBase64(raw) {
  const decoded = Buffer.from(raw, 'base64')
  if (decoded.length === 0) return undefined
  return decoded.toString('base64') === raw ? decoded : undefined
}

function parseHashedPatterns(field) {
  const parts = field.split('|')
  if (parts.length !== 4 || parts[0] !== '' || parts[1] !== '1') return undefined
  const salt = decodeCanonicalBase64(parts[2] || '')
  const hash = decodeCanonicalBase64(parts[3] || '')
  if (!salt || !hash || salt.length !== SHA1_DIGEST_BYTES || hash.length !== SHA1_DIGEST_BYTES) return undefined
  return { salt, hash }
}

// One line -> entry, or undefined (blank, comment, malformed). Never throws.
export function parseKnownHostsLine(line) {
  const trimmed = String(line).trim()
  if (trimmed.length === 0 || trimmed.startsWith('#')) return undefined
  const fields = trimmed.split(/\s+/)
  let index = 0
  let marker
  if (fields[index] && fields[index].startsWith('@')) {
    const raw = fields[index]
    if (raw === '@revoked') marker = 'revoked'
    else if (raw === '@cert-authority') marker = 'cert-authority'
    // An unknown marker may restrict the line in a way not modelled here.
    else return undefined
    index += 1
  }
  const hostField = fields[index]
  const keyType = fields[index + 1]
  const keyBase64 = fields[index + 2]
  if (!hostField || !keyType || !keyBase64) return undefined
  const key = decodeCanonicalBase64(keyBase64)
  if (!key || readHostKeyType(key) !== keyType || !isWellFormedHostKeyBlob(key)) return undefined
  if (hostField.startsWith(HASH_MAGIC)) {
    const hashed = parseHashedPatterns(hostField)
    return hashed ? { ...(marker ? { marker } : {}), patterns: [], negations: [], hashed, keyType, key } : undefined
  }
  const patterns = []
  const negations = []
  for (const raw of hostField.split(',')) {
    const pattern = raw.trim().toLowerCase()
    if (!pattern) continue
    if (pattern.startsWith('!')) negations.push(pattern.slice(1))
    else patterns.push(pattern)
  }
  if (patterns.length === 0 && negations.length === 0) return undefined
  return { ...(marker ? { marker } : {}), patterns, negations, keyType, key }
}

export function parseKnownHosts(contents) {
  const entries = []
  for (const line of String(contents).split(/\r?\n/)) {
    const entry = parseKnownHostsLine(line)
    if (entry) entries.push(entry)
  }
  return entries
}

function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^${escaped.replace(/\*/g, '.*').replace(/\?/g, '.')}$`)
}

function patternMatches(pattern, candidate) {
  return pattern.includes('*') || pattern.includes('?') ? globToRegExp(pattern).test(candidate) : pattern === candidate
}

function entryMatchesCandidate(entry, candidate) {
  if (entry.hashed) {
    const digest = createHmac('sha1', entry.hashed.salt).update(candidate).digest()
    return digest.length === entry.hashed.hash.length && timingSafeEqual(digest, entry.hashed.hash)
  }
  // One negation vetoes the whole line.
  if (entry.negations.some((p) => patternMatches(p, candidate))) return false
  return entry.patterns.some((p) => patternMatches(p, candidate))
}

// The candidate forms, in OpenSSH's order: [host]:port first on a non-default
// port, then the bare host. A HostKeyAlias is looked up bare only.
export function hostCandidatePasses(host, port, isHostKeyAlias = false) {
  const lower = String(host).toLowerCase()
  return port === 22 || isHostKeyAlias ? [[lower]] : [[`[${lower}]:${port}`], [lower]]
}

// query: { host, port, keyType, key, isHostKeyAlias }
// -> 'match' | 'mismatch' | 'revoked' | 'ca-only' | 'unknown-type-known-host' | 'unknown'
export function matchKnownHosts(entries, query) {
  const passes = hostCandidatePasses(query.host, query.port, query.isHostKeyAlias)
  const matchesHost = (entry, candidates) => candidates.some((c) => entryMatchesCandidate(entry, c))
  // Revocation first, across every pass.
  for (const candidates of passes) {
    for (const entry of entries) {
      if (entry.marker === 'revoked' && matchesHost(entry, candidates) && entry.key.equals(query.key)) return 'revoked'
    }
  }
  let sawCertAuthority = false
  for (let passIndex = 0; passIndex < passes.length; passIndex += 1) {
    const candidates = passes[passIndex]
    let sawSameTypeForHost = false
    let sawPlainEntryForHost = false
    for (const entry of entries) {
      if (entry.marker === 'revoked' || !matchesHost(entry, candidates)) continue
      if (entry.marker === 'cert-authority') {
        sawCertAuthority = true
        continue
      }
      if (entry.key.equals(query.key)) return 'match'
      sawPlainEntryForHost = true
      sawSameTypeForHost ||= entry.keyType === query.keyType
    }
    // The first pass decides when it knows the host at all (OpenSSH runs the
    // bare-host fallback only when the port-qualified lookup found nothing).
    if (passIndex === 0 && sawPlainEntryForHost) return sawSameTypeForHost ? 'mismatch' : 'unknown-type-known-host'
  }
  return sawCertAuthority ? 'ca-only' : 'unknown'
}

export function defaultKnownHostsFiles(home = os.homedir()) {
  return [join(home, '.ssh', 'known_hosts'), join(home, '.ssh', 'known_hosts2')]
}

// The entries of every file, unioned. unreadable: files that EXIST but could
// not be read (an absent file is normal and means "nothing known there").
export async function loadKnownHostsEvidence(files, { readFileImpl = readFile } = {}) {
  const perFile = await Promise.all(
    (files || []).map(async (path) => {
      try {
        const buf = await readFileImpl(path)
        if (buf.length > MAX_KNOWN_HOSTS_BYTES) return { entries: [], unreadable: true }
        return { entries: parseKnownHosts(buf.toString('utf8')), unreadable: false }
      } catch (err) {
        return { entries: [], unreadable: !(err && err.code === 'ENOENT') }
      }
    })
  )
  return {
    entries: perFile.flatMap((f) => f.entries),
    unreadableFileCount: perFile.filter((f) => f.unreadable).length
  }
}

// Host key algorithms to propose, the types already known for this host
// first (RFC 4253: the client's order wins), so a server cannot pick another
// type to turn a changed key into a first contact. undefined: nothing known,
// ssh2's own order.
export function orderServerHostKeyAlgorithms(entries, host, port, supported, storedKeyTypes = [], isHostKeyAlias = false) {
  if (!Array.isArray(supported) || supported.length === 0) return undefined
  const known = new Set(storedKeyTypes)
  for (const entry of entries) {
    if (entry.marker) continue
    if (matchKnownHosts([entry], { host, port, keyType: entry.keyType, key: entry.key, isHostKeyAlias }) === 'match') known.add(entry.keyType)
  }
  if (known.size === 0) return undefined
  const preferred = supported.filter((a) => known.has(a) || (known.has('ssh-rsa') && a.startsWith('rsa-sha2-')))
  if (preferred.length === 0) return undefined
  const set = new Set(preferred)
  return [...preferred, ...supported.filter((a) => !set.has(a))]
}
