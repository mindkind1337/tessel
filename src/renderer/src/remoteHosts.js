// Remote hosts over SSH in the interface: the saved hosts, their live state
// and the add/edit form's logic. Ported from Orca (MIT, Copyright (c) 2026
// Lovecast Inc.): components/settings/ssh-target-draft.ts,
// ssh-target-save-payload.ts, SshTargetCard.tsx (STATUS_LABELS, statusColor),
// status-bar/remote-host-connection-status.ts and ssh/ssh-connect-verb.ts.
// The main process (src/main/remoteHosts.js) checks everything again.
import { reactive } from 'vue'
import { t } from './i18n'

// needsConnect: hostId -> true while a remote project's Files / Changes
// were refused because the host is not connected (nothing signs in by
// itself, src/main/remoteFs.js): the remote badge offers Connect.
export const remoteHostsState = reactive({ targets: [], states: {}, loaded: false, error: '', needsConnect: {} })

// The host's shared ssh2 connection is signed in: a terminal or the Files
// session opened now asks nothing.
export function hostShared(id, states = remoteHostsState.states) {
  const s = states && states[id]
  return !!(s && s.shared)
}
function clearNeeds(states) {
  for (const id of Object.keys(remoteHostsState.needsConnect)) if (hostShared(id, states)) delete remoteHostsState.needsConnect[id]
}

function api() {
  return typeof window !== 'undefined' && window.shellApi ? window.shellApi.remoteHosts || null : null
}

export async function refreshRemoteHosts() {
  const a = api()
  if (!a) return
  try {
    const res = await a.list()
    if (res && res.ok) {
      remoteHostsState.targets = Array.isArray(res.targets) ? res.targets : []
      remoteHostsState.states = res.states && typeof res.states === 'object' ? res.states : {}
      clearNeeds(remoteHostsState.states)
      remoteHostsState.error = ''
    } else remoteHostsState.error = t('remote.pane.loadFailed', 'Failed to load SSH targets')
  } catch {
    remoteHostsState.error = t('remote.pane.loadFailed', 'Failed to load SSH targets')
  }
  remoteHostsState.loaded = true
}

// Passive ~/.ssh/config sync (Orca syncs when the SSH pane opens), then list.
export async function syncRemoteHosts() {
  const a = api()
  if (!a) return
  try {
    await a.importConfig(false)
  } catch {
    // Surfaced on demand through the Import button.
  }
  await refreshRemoteHosts()
}

// A remote project's session: refused (not connected), or signed in.
export function noteRemoteActivity(a) {
  if (!a || typeof a.hostId !== 'string') return
  if (a.needsConnect) remoteHostsState.needsConnect[a.hostId] = true
  else if (a.state === 'ready' || a.state === 'busy') delete remoteHostsState.needsConnect[a.hostId]
}

let unsubscribe = null
let unsubscribeFs = null
export function initRemoteHosts() {
  const a = api()
  if (!a || unsubscribe) return
  if (typeof a.onState === 'function') {
    unsubscribe = a.onState((states) => {
      remoteHostsState.states = states && typeof states === 'object' ? states : {}
      clearNeeds(remoteHostsState.states)
    })
  }
  const fs = typeof window !== 'undefined' && window.shellApi ? window.shellApi.remoteFs : null
  if (fs && typeof fs.onActivity === 'function' && !unsubscribeFs) unsubscribeFs = fs.onActivity(noteRemoteActivity)
  return syncRemoteHosts()
}

// Connect for a remote project's Files / Changes (the remote badge): signs in
// (asking what it must). -> { ok } | { ok: false, error, cancelled? }
export async function connectRemoteFiles(hostId) {
  const fs = typeof window !== 'undefined' && window.shellApi ? window.shellApi.remoteFs : null
  if (!fs || typeof fs.connect !== 'function') return { ok: false, error: '' }
  let res
  try {
    res = await fs.connect(hostId)
  } catch (err) {
    res = { ok: false, error: (err && err.message) || '' }
  }
  if (res && res.ok) delete remoteHostsState.needsConnect[hostId]
  return res || { ok: false, error: '' }
}

// App.vue says how to open a pane on a host and Settings > SSH Hosts.
const handlers = { connect: null, openSettings: null }
export function setRemoteHostHandlers(next) {
  Object.assign(handlers, next || {})
}
export async function connectRemoteHost(target) {
  if (!target || !handlers.connect) return false
  return handlers.connect(target)
}
export function manageRemoteHosts() {
  if (handlers.openSettings) handlers.openSettings()
}
export async function disconnectRemoteHost(id) {
  const a = api()
  if (!a) return { ok: false }
  return a.disconnect(id)
}

export function hostStatus(id, states = remoteHostsState.states) {
  const s = states && states[id]
  return (s && s.status) || 'disconnected'
}
export function hostError(id, states = remoteHostsState.states) {
  const s = states && states[id]
  return (s && s.error) || ''
}

// --- Status words and colors (Orca's STATUS_LABELS / statusColor) ------------
export function statusLabel(status) {
  switch (status) {
    case 'connected':
      return t('remote.status.connected', 'Connected')
    case 'connecting':
      return t('remote.status.connecting', 'Connecting…')
    case 'auth-failed':
      return t('remote.status.authFailed', 'Auth failed')
    case 'reconnecting':
      return t('remote.status.reconnecting', 'Reconnecting…')
    case 'reconnection-failed':
      return t('remote.status.reconnectionFailed', 'Reconnection failed')
    case 'error':
      return t('remote.status.error', 'Error')
    default:
      return t('remote.status.disconnected', 'Disconnected')
  }
}

// A class: rh-dot-ok (emerald), rh-dot-busy (yellow), rh-dot-bad (red), rh-dot-off.
export function statusTone(status) {
  if (status === 'connected') return 'ok'
  if (status === 'connecting' || status === 'reconnecting' || status === 'deploying-relay') return 'busy'
  if (status === 'auth-failed' || status === 'reconnection-failed' || status === 'error') return 'bad'
  return 'off'
}

export function isConnectingStatus(status) {
  return statusTone(status) === 'busy'
}
export function canConnectStatus(status) {
  return ['disconnected', 'auth-failed', 'reconnection-failed', 'error'].includes(status || 'disconnected')
}

// Orca's sshConnectVerb.
export function connectVerb(status) {
  if (status === 'auth-failed') return t('remote.verb.reconnect', 'Reconnect')
  if (status === 'error' || status === 'reconnection-failed') return t('remote.verb.retry', 'Retry')
  return t('remote.verb.connect', 'Connect')
}

// Orca's overallStatus over the hosts' statuses.
export function overallStatus(statuses) {
  if (!statuses.length) return 'disconnected'
  if (statuses.every((s) => s === 'connected')) return 'connected'
  if (statuses.some((s) => isConnectingStatus(s))) return 'connecting'
  if (statuses.some((s) => s === 'connected')) return 'partial'
  return 'disconnected'
}

export function connectedHostCountLabel(count) {
  return count === 1
    ? t('remote.statusBar.hostCount_one', '{{count}} host', { count })
    : t('remote.statusBar.hostCount', '{{count}} hosts', { count })
}

export function endpointOf(target) {
  if (!target) return ''
  return target.username ? `${target.username}@${target.host}:${target.port}` : `${target.host}:${target.port}`
}

// --- The add / edit form (Orca's ssh-target-draft.ts) ------------------------
export const EMPTY_FORM = Object.freeze({
  label: '',
  configHost: '',
  host: '',
  port: '22',
  username: '',
  identityFile: '',
  proxyCommand: '',
  jumpHost: ''
})

export function emptyForm() {
  return { ...EMPTY_FORM }
}

export function formFromTarget(target) {
  // A hand-made host keeps its host as configHost: cleared on edit, so a new
  // Host recomputes the alias instead of keeping a stale one.
  const configHost = target.configHost && target.configHost !== target.host ? target.configHost : ''
  return {
    label: target.label || '',
    configHost,
    // The host the alias stood for when the form opened (not a field): a
    // different Host on save means a new destination, and the alias goes.
    aliasHost: configHost ? target.host || '' : '',
    host: target.host || '',
    port: String(target.port || 22),
    username: target.username || '',
    identityFile: target.identityFile || '',
    proxyCommand: target.proxyCommand || '',
    jumpHost: target.jumpHost || ''
  }
}

// "server", "deploy@server:2222", "ssh://deploy@server:2222", "[::1]:22".
export function parseSshHostInput(rawInput) {
  const input = String(rawInput || '').trim()
  if (!input) return null
  if (/^ssh:\/\//i.test(input)) return parseSshUrl(input)
  const at = input.lastIndexOf('@')
  const username = at > 0 ? input.slice(0, at).trim() : undefined
  const hostPort = at > 0 ? input.slice(at + 1).trim() : input
  const parsed = parseHostAndOptionalPort(hostPort)
  if (!parsed.host) return null
  return { host: parsed.host, username, port: parsed.port, invalidPort: parsed.invalidPort, configHost: parsed.host }
}

export function applyParsedSshHostInput(draft) {
  const parsed = parseSshHostInput(draft.host)
  if (!parsed || parsed.invalidPort) return draft
  return {
    ...draft,
    host: parsed.host,
    configHost: draft.configHost.trim() || parsed.configHost,
    username: draft.username.trim() || parsed.username || '',
    port: parsed.port !== undefined && isDefaultPortDraft(draft.port) ? String(parsed.port) : draft.port
  }
}

export function draftConnectionFields(draft) {
  const parsed = parseSshHostInput(draft.host)
  const host = parsed?.host ?? draft.host.trim()
  const configHost = draft.configHost.trim() || parsed?.configHost || host
  const username = draft.username.trim() || parsed?.username || ''
  const typedPort = /^\s*\d+\s*$/.test(draft.port) ? Number.parseInt(draft.port, 10) : draft.port.trim() ? Number.NaN : 22
  const port =
    parsed?.invalidPort === true
      ? Number.NaN
      : parsed?.port !== undefined && isDefaultPortDraft(draft.port)
        ? parsed.port
        : typedPort
  return { host, configHost, username, port }
}

export function hasAdvancedValues(form) {
  return form.proxyCommand.trim().length > 0 || form.jumpHost.trim().length > 0
}

export function isFormDirty(current, baseline) {
  return Object.keys(EMPTY_FORM).some((k) => current[k] !== baseline[k])
}

// -> { ok: true, target } | { ok: false, error } (Orca's buildSshTargetSavePayload)
export function buildSavePayload(form) {
  const fields = draftConnectionFields(form)
  const { host, username, port } = fields
  // An imported alias stays only while its Host is untouched: a Host typed
  // over it is connected to as shown, not through the old alias.
  const aliasKept = form.configHost && form.aliasHost !== undefined && host === form.aliasHost
  const configHost = form.configHost && form.aliasHost !== undefined && !aliasKept ? host : fields.configHost
  if (!host) return { ok: false, error: t('remote.pane.hostRequired', 'Host or SSH config alias is required') }
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    return { ok: false, error: t('remote.pane.portInvalid', 'Port must be between 1 and 65535') }
  return {
    ok: true,
    target: {
      label: form.label.trim() || (username ? `${username}@${host}` : configHost),
      configHost,
      host,
      port,
      username,
      // Empty strings clear what an edit removed.
      identityFile: form.identityFile.trim(),
      proxyCommand: form.proxyCommand.trim(),
      jumpHost: form.jumpHost.trim()
    }
  }
}

// The main process's error codes, in words.
export function remoteErrorText(code, fallback) {
  switch (code) {
    case 'host-required':
      return t('remote.pane.hostRequired', 'Host or SSH config alias is required')
    case 'host-invalid':
      return t('remote.error.hostInvalid', 'This host or alias has characters ssh cannot take.')
    case 'port-invalid':
      return t('remote.pane.portInvalid', 'Port must be between 1 and 65535')
    case 'user-invalid':
      return t('remote.error.userInvalid', 'This username has characters ssh cannot take.')
    case 'identity-invalid':
      return t('remote.error.identityInvalid', 'This identity file path is not valid.')
    case 'jump-invalid':
      return t('remote.error.jumpInvalid', 'This jump host is not valid.')
    case 'proxy-invalid':
      return t('remote.error.proxyInvalid', 'This proxy command is not valid.')
    case 'too-many':
      return t('remote.error.tooMany', 'Too many SSH targets.')
    case 'not-found':
      return t('remote.error.notFound', 'This SSH target no longer exists.')
    default:
      return typeof code === 'string' && code && code !== 'failed' ? code : fallback
  }
}

function parseSshUrl(input) {
  try {
    const url = new URL(input)
    if (url.protocol !== 'ssh:' || !url.hostname) return null
    const host = url.hostname.replace(/^\[|\]$/g, '')
    const port = url.port ? parsePort(url.port) : undefined
    const username = decodeUser(url.username)
    if (url.port && port === undefined) return { host, username, configHost: host, invalidPort: true }
    return { host, username, port, configHost: host }
  } catch {
    const m = input.match(/^ssh:\/\/(?:([^@/?#]*)@)?(\[[^\]]+\]|[^:/?#]+):([^/?#]*)(?:[/?#]|$)/i)
    if (!m) return null
    const rawHost = m[2]
    const host = rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : rawHost
    if (parsePort(m[3]) !== undefined) return null
    return { host, username: decodeUser(m[1] || ''), configHost: host, invalidPort: true }
  }
}

function decodeUser(value) {
  if (!value) return undefined
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function parseHostAndOptionalPort(input) {
  if (input.startsWith('[')) {
    const close = input.indexOf(']')
    if (close > 1) {
      const host = input.slice(1, close)
      const suffix = input.slice(close + 1)
      if (suffix.startsWith(':')) {
        const port = parsePort(suffix.slice(1))
        return port === undefined ? { host, invalidPort: true } : { host, port }
      }
      return { host }
    }
  }
  const first = input.indexOf(':')
  if (first !== -1 && first === input.lastIndexOf(':')) {
    const host = input.slice(0, first)
    const port = parsePort(input.slice(first + 1))
    if (host) return port === undefined ? { host, invalidPort: true } : { host, port }
  }
  return { host: input }
}

function parsePort(value) {
  if (!/^\d+$/.test(value)) return undefined
  const port = Number(value)
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : undefined
}

function isDefaultPortDraft(value) {
  const v = String(value || '').trim()
  return v === '' || v === '22'
}
