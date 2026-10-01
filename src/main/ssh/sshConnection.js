// One SSH connection with the ssh2 library: the handshake, the host key
// check and the sign-in. Modelled on Orca's SshConnection (MIT, Copyright (c)
// 2026 Lovecast Inc.: src/main/ssh/ssh-connection.ts,
// ssh-private-key-authentication.ts, ssh-keyboard-interactive.ts,
// ssh-host-key-verifier.ts), with one difference in shape: the questions
// (passphrase, password, challenge, unknown host key) are asked INSIDE the
// handshake (ssh2's authHandler and hostVerifier wait for the answer), so one
// TCP connection carries the whole sign-in and a wrong password is simply
// asked again, as ssh does.
//
// The sign-in ladder, in OpenSSH's order, each step only when the server
// still takes that method:
//   none -> the agent -> the IdentityFile keys (an encrypted key's
//   passphrase is asked, checked locally, and kept) -> keyboard-interactive
//   (a password prompt is answered with the kept password once, else asked)
//   -> password (the kept one once, else asked; 3 tries).
// A password the server accepted is kept (creds, in memory, by the caller);
// a kept password the server rejects is forgotten and asked again.
//
// Secrets: the password, passphrases and challenge answers only go to ssh2.
// No error, log line or state carries them.
import ssh2 from 'ssh2'
import ssh2Constants from 'ssh2/lib/protocol/constants.js'
import { readHostKeyType, hostKeyFingerprint, matchKnownHosts, loadKnownHostsEvidence, orderServerHostKeyAlgorithms } from './knownHosts'
import { decideHostKey } from './hostKeyDecision'
import { loadIdentityKeys, agentFor, passphraseOpens } from './sshAuth'

const { Client } = ssh2

export const CONNECT_TIMEOUT_MS = 30_000
export const KEEPALIVE_INTERVAL_MS = 15_000
export const KEEPALIVE_COUNT_MAX = 3
const MAX_PASSWORD_TRIES = 3
const MAX_PASSPHRASE_TRIES = 3
const MAX_KBD_ATTEMPTS = 3
const MAX_KBD_ROUNDS = 10
const MAX_KBD_PROMPTS = 10
const MAX_PARTIAL_STAGES = 4
const PROMPT_DETAIL_MAX = 4096
const TRANSIENT = new Set(['ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN', 'EPIPE', 'ECONNABORTED'])

// A connection error: code (what main turns into words), params (public
// values only: host, port, fingerprint...), transient (worth retrying).
export function sshError(code, params = {}, transient = false) {
  const e = new Error(`ssh ${code}`) // i18n-ignore internal: main translates by code
  e.code = code
  e.params = params
  e.transient = transient
  return e
}

// Keyboard-interactive: a password-looking prompt goes through the password
// path (and its cache); a one-time code never does.
export function isPasswordPrompt(p) {
  return !!p && p.echo !== true && /password/i.test(String(p.prompt || '')) && !/one.?time|otp/i.test(String(p.prompt || ''))
}

function promptText(...parts) {
  return parts
    .map((s) => String(s || '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, PROMPT_DETAIL_MAX)
}

// The algorithms offered. Without settings from ssh -G: ssh2's defaults
// minus SHA-1 (the ssh-rsa host key signature, hmac-sha1 MACs). With them
// (HostKeyAlgorithms, KexAlgorithms, Ciphers, MACs): the user's lists, in
// their order, limited to what ssh2 supports; a list with nothing ssh2 can
// do is an error (never a silent fallback to other algorithms).
const SHA1_DEFAULTS = new Set(['ssh-rsa', 'hmac-sha1', 'hmac-sha1-etm@openssh.com'])
const CATEGORIES = [
  ['kex', 'DEFAULT_KEX', 'SUPPORTED_KEX'],
  ['serverHostKey', 'DEFAULT_SERVER_HOST_KEY', 'SUPPORTED_SERVER_HOST_KEY'],
  ['cipher', 'DEFAULT_CIPHER', 'SUPPORTED_CIPHER'],
  ['hmac', 'DEFAULT_MAC', 'SUPPORTED_MAC']
]
const stringList = (v) => (Array.isArray(v) && v.every((a) => typeof a === 'string') ? v : null)

// -> { kex, serverHostKey, cipher, hmac } | { error: category }
export function effectiveAlgorithms(fromConfig = null, constants = ssh2Constants) {
  const out = {}
  for (const [name, defKey, supKey] of CATEGORIES) {
    const defaults = stringList(constants && constants[defKey])
    const supported = stringList(constants && constants[supKey])
    if (!defaults || !supported) continue // an unexpected ssh2: its own defaults
    const wanted = fromConfig && stringList(fromConfig[name])
    if (wanted && wanted.length) {
      const list = wanted.filter((a) => supported.includes(a))
      if (!list.length) return { error: name }
      out[name] = list
    } else out[name] = defaults.filter((a) => !SHA1_DEFAULTS.has(a))
  }
  return out
}

// spec: { host, port, username, identityFiles, identitiesOnly, identityAgent,
//         strictHostKeyChecking, knownHostsFiles, hostKeyAlias }
// creds: { password: string|null, passphrases: Map<path, string> } (kept by
//        the caller for the app session; updated here)
// ask(prompt) -> Promise<string|null>: { kind: 'password' | 'passphrase' |
//        'keyboard-interactive' | 'hostkey', detail, retry, echo, hostKey }
// hostKeys: hostKeyStore.js. -> Promise<ssh2 Client> (ready), or rejects with sshError().
export function connectSsh({
  spec,
  creds,
  ask,
  hostKeys,
  agent,
  ClientImpl = Client,
  timers = { setTimeout, clearTimeout },
  connectTimeoutMs = CONNECT_TIMEOUT_MS,
  keepaliveMs = KEEPALIVE_INTERVAL_MS,
  log = () => {},
  loadKeys = loadIdentityKeys,
  loadKnownHosts = loadKnownHostsEvidence,
  makeAgent = agentFor
}) {
  const host = spec.host
  const port = spec.port || 22
  const username = spec.username || ''
  const lookupHost = spec.hostKeyAlias || host
  const isHostKeyAlias = !!spec.hostKeyAlias

  return (async () => {
    const evidence = await loadKnownHosts(spec.knownHostsFiles || [])
    const records = hostKeys ? hostKeys.records() : []
    const keys = loadKeys(spec.identityFiles || [])
    const agentToOffer = spec.pubkeyAuthentication === false ? null : agent !== undefined ? agent : makeAgent(spec)
    const algorithms = effectiveAlgorithms(spec.algorithms)
    if (algorithms.error) throw sshError('algorithms', { host, port, detail: algorithms.error })
    if (algorithms.serverHostKey) {
      algorithms.serverHostKey =
        orderServerHostKeyAlgorithms(
          evidence.entries,
          lookupHost,
          port,
          algorithms.serverHostKey,
          hostKeys ? hostKeys.storedKeyTypes(records, lookupHost, port) : [],
          isHostKeyAlias
        ) || algorithms.serverHostKey
    }

    return new Promise((resolve, reject) => {
      const client = new ClientImpl()
      let settled = false
      let timer = null
      let prompting = 0
      let rejection = null // a refused host key
      let cancelled = false
      let timedOut = false
      let connected = false
      let acceptedKey = null // the host key accepted for this connection
      // Whether that key was checked (known_hosts, Tessel's store, the
      // user's Yes, or the key pinned at this endpoint's first unchecked
      // connection): a kept password is only ever sent to a checked key.
      let hostVerified = false

      const clearTimer = () => {
        if (timer) timers.clearTimeout(timer)
        timer = null
      }
      const arm = () => {
        clearTimer()
        if (settled || prompting) return
        timer = timers.setTimeout(() => {
          timedOut = true
          fail(new Error('timeout')) // i18n-ignore internal: classified below
        }, connectTimeoutMs)
      }
      function classify(err) {
        if (rejection) return rejection
        if (cancelled) return sshError('auth-cancelled', { host, port })
        if (timedOut) return sshError('timeout', { host, port }, true)
        if (err && err.level === 'client-authentication') return sshError('auth-failed', { host, port, user: username })
        const code = err && typeof err.code === 'string' ? err.code : ''
        if (code === 'ENOTFOUND') return sshError('dns', { host, port })
        if (TRANSIENT.has(code)) return sshError('network', { host, port, detail: code }, true)
        if (err && err.level === 'client-timeout') return sshError('timeout', { host, port }, true)
        // The text may come from the server (a disconnect reason): no control characters.
        return sshError('failed', { host, port, detail: promptText((err && err.message) || '').replace(/\n/g, ' ').slice(0, 300) })
      }
      function fail(err) {
        if (settled) return
        settled = true
        clearTimer()
        try {
          client.end()
        } catch {
          /* closing anyway */
        }
        reject(classify(err))
      }
      // A question to the user: the timer waits meanwhile; an answer that
      // comes after the attempt ended is dropped.
      async function question(prompt) {
        if (settled) return null
        prompting++
        clearTimer()
        let value = null
        try {
          value = await ask({ ...prompt, host, port, user: username })
        } catch {
          value = null
        } finally {
          prompting--
        }
        if (settled) return null
        arm()
        return typeof value === 'string' ? value : null
      }

      // --- Host key ------------------------------------------------------
      const hostVerifier = (key, verify) => {
        // A later key exchange (re-key) on this connection: the same key only.
        if (connected) {
          verify(!!acceptedKey && Buffer.isBuffer(key) && key.equals(acceptedKey))
          return
        }
        Promise.resolve()
          .then(async () => {
            const keyType = readHostKeyType(key)
            if (!keyType) {
              rejection = sshError('hostkey-unreadable', { host: lookupHost, port })
              return false
            }
            const fingerprint = hostKeyFingerprint(key)
            const params = { host: lookupHost, port, keyType, fingerprint, storeFile: hostKeys ? hostKeys.file : '' }
            const decision = decideHostKey({
              knownHostsOutcome: matchKnownHosts(evidence.entries, { host: lookupHost, port, keyType, key, isHostKeyAlias }),
              storeOutcome: hostKeys ? hostKeys.match(records, { host: lookupHost, port, keyType, key }) : 'unknown',
              strictHostKeyChecking: spec.strictHostKeyChecking || 'ask',
              knownHostsUnreadable: evidence.unreadableFileCount > 0
            })
            if (decision.action === 'reject') {
              log('warn', `ssh host key refused for ${lookupHost}:${port} (${decision.code}, ${keyType} ${fingerprint})`)
              rejection = sshError(`hostkey-${decision.code}`, params)
              return false
            }
            if (decision.action === 'prompt') {
              const answer = await question({ kind: 'hostkey', hostKey: { host: lookupHost, port, keyType, fingerprint } })
              if (answer !== 'yes') {
                rejection = sshError('hostkey-declined', params)
                return false
              }
              hostVerified = true
            } else if (decision.verified) {
              hostVerified = true
            } else if (creds.pinnedKey) {
              // Accepted unchecked (StrictHostKeyChecking no, accept-new):
              // this endpoint's first key is pinned in memory, another one
              // is refused.
              if (!creds.pinnedKey.equals(key)) {
                log('warn', `ssh host key differs from the pinned one for ${lookupHost}:${port} (${keyType} ${fingerprint})`)
                rejection = sshError('hostkey-changed-pinned', params)
                return false
              }
              hostVerified = true
            } else {
              creds.pinnedKey = Buffer.from(key)
            }
            if (decision.remember && hostKeys) hostKeys.trust({ host: lookupHost, port, keyType, key })
            acceptedKey = Buffer.from(key)
            return true
          })
          .catch(() => {
            rejection = rejection || sshError('hostkey-unreadable', { host: lookupHost, port })
            return false
          })
          .then((ok) => {
            if (settled) return verify(false)
            verify(ok)
          })
      }

      // --- Sign-in ladder ----------------------------------------------------
      let triedNone = false
      let agentTried = false
      let keyIndex = 0
      let kbdAttempts = 0
      let kbdRounds = 0
      let passwordTries = 0
      let cachedPasswordUsed = false
      let passwordRejected = false
      let typedPassword = null
      let last = null // the attempt in flight: { type, password: 'cache' | 'typed' | null }
      let partialStages = 0
      // The kept password, only for a checked host key.
      const keptPassword = () => (hostVerified ? creds.password : null)

      function failedAttempt(partial) {
        if (!last || partial) return
        if (last.password) {
          passwordRejected = true
          // The kept password was refused: forgotten, asked next.
          if (last.password === 'cache') creds.password = null
          else typedPassword = null
        }
      }

      async function encryptedKeyAuth(k) {
        const kept = creds.passphrases.get(k.path)
        if (kept && passphraseOpens(k.contents, kept)) return { type: 'publickey', username, key: k.contents, passphrase: kept }
        if (kept) creds.passphrases.delete(k.path)
        for (let i = 0; i < MAX_PASSPHRASE_TRIES; i++) {
          const v = await question({ kind: 'passphrase', detail: k.path, retry: i > 0 })
          // Cancel: this key is skipped, the next method follows (as ssh).
          if (v == null || settled) return null
          if (passphraseOpens(k.contents, v)) {
            creds.passphrases.set(k.path, v)
            return { type: 'publickey', username, key: k.contents, passphrase: v }
          }
        }
        return null
      }

      function kbdPrompt(name, instructions, _lang, prompts, finish) {
        if (!Array.isArray(prompts) || prompts.length === 0) return finish([])
        if (prompts.length > MAX_KBD_PROMPTS || ++kbdRounds > MAX_KBD_ROUNDS) return finish([])
        ;(async () => {
          const answers = []
          for (const p of prompts) {
            if (isPasswordPrompt(p)) {
              const kept = keptPassword()
              if (kept != null && !cachedPasswordUsed) {
                cachedPasswordUsed = true
                if (last) last.password = 'cache'
                answers.push(kept)
                continue
              }
              const v = await question({ kind: 'password', detail: `${username}@${host}`, retry: passwordRejected })
              if (v == null) {
                cancelled = true
                return finish([])
              }
              typedPassword = v
              if (last) last.password = 'typed'
              answers.push(v)
            } else {
              const v = await question({ kind: 'keyboard-interactive', detail: promptText(name, instructions, p.prompt), echo: p.echo === true })
              if (v == null) {
                cancelled = true
                return finish([])
              }
              answers.push(v)
            }
          }
          finish(answers)
        })().catch(() => finish([]))
      }

      async function nextAuth(methodsLeft, partial) {
        const offered = (m) => !Array.isArray(methodsLeft) || methodsLeft.includes(m)
        failedAttempt(partial)
        if (partial && partialStages < MAX_PARTIAL_STAGES) {
          // A stage was accepted and another method is required: a fresh
          // ladder, limited to what the server still takes.
          partialStages++
          agentTried = false
          keyIndex = 0
          kbdAttempts = 0
          passwordTries = 0
        }
        last = null
        if (cancelled || settled) return false
        if (!triedNone) {
          triedNone = true
          return { type: 'none', username }
        }
        if (offered('publickey') && spec.pubkeyAuthentication !== false) {
          if (!agentTried && agentToOffer) {
            agentTried = true
            return { type: 'agent', username, agent: agentToOffer }
          }
          while (keyIndex < keys.length) {
            const k = keys[keyIndex++]
            if (!k.encrypted) return { type: 'publickey', username, key: k.contents }
            const auth = await encryptedKeyAuth(k)
            if (settled) return false
            if (auth) return auth
          }
        }
        if (offered('keyboard-interactive') && spec.kbdInteractiveAuthentication !== false && kbdAttempts < MAX_KBD_ATTEMPTS) {
          kbdAttempts++
          last = { type: 'keyboard-interactive', password: null }
          return { type: 'keyboard-interactive', username, prompt: kbdPrompt }
        }
        if (offered('password') && spec.passwordAuthentication !== false && passwordTries < MAX_PASSWORD_TRIES) {
          passwordTries++
          const kept = keptPassword()
          if (kept != null && !cachedPasswordUsed) {
            cachedPasswordUsed = true
            last = { type: 'password', password: 'cache' }
            return { type: 'password', username, password: kept }
          }
          const v = await question({ kind: 'password', detail: `${username}@${host}`, retry: passwordRejected })
          if (v == null) {
            cancelled = true
            return false
          }
          typedPassword = v
          last = { type: 'password', password: 'typed' }
          return { type: 'password', username, password: v }
        }
        return false
      }

      const authHandler = (methodsLeft, partial, next) => {
        arm()
        nextAuth(methodsLeft, partial)
          .then((auth) => {
            if (settled) return
            arm()
            next(auth || false)
          })
          .catch(() => {
            if (!settled) next(false)
          })
      }

      client.on('ready', () => {
        if (settled) {
          try {
            client.end()
          } catch {
            /* gone */
          }
          return
        }
        settled = true
        connected = true
        clearTimer()
        // The password the server just accepted is kept for reconnects.
        if (typedPassword != null) creds.password = typedPassword
        typedPassword = null
        resolve(client)
      })
      client.on('error', (err) => {
        // An agent that is not running is not a failure: the ladder goes on.
        if (err && err.level === 'agent') return
        if (!settled) fail(err)
      })
      client.on('close', () => {
        if (!settled) fail(sshError('closed'))
      })
      // A server asking for a new password: not supported here (use a terminal).
      client.on('change password', () => fail(sshError('auth-failed', { host, port, user: username })))

      const config = {
        host,
        port,
        username,
        readyTimeout: 0, // Tessel's own timer (it waits while a question is open)
        keepaliveInterval: keepaliveMs,
        keepaliveCountMax: KEEPALIVE_COUNT_MAX,
        tryKeyboard: true,
        hostVerifier,
        authHandler
      }
      if (Object.keys(algorithms).length) config.algorithms = algorithms
      arm()
      try {
        client.connect(config)
      } catch (err) {
        fail(err)
      }
    })
  })()
}
