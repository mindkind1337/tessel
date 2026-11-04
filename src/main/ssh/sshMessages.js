// The words for SSH connection outcomes (codes from sshConnection.js /
// sshManager.js), in the interface's language. Main builds the templates with
// t() (placeholders left in); the terminal host, which has no language of its
// own, receives them with each remote terminal and fills them in.
import { keygenRemoveTarget } from './hostKeyDecision'

export function sshTemplates(t) {
  return {
    lost: t('main.ssh.lost', 'Connection to {{host}} lost. Reconnecting…'),
    reconnected: t('main.ssh.reconnected', 'Reconnected to {{host}}: a new shell was started.'),
    reconnectedSame: t('main.ssh.reconnectedSame', 'Reconnected to {{host}}: back in the same session.'),
    noTmux: t('main.ssh.noTmux', 'tmux is not installed on {{host}}: this session will not survive a lost connection.'),
    // A host without tmux where Tessel puts its own copy (ssh/remoteTmux.js).
    noTmuxSoon: t('main.ssh.noTmuxSoon', 'tmux is not installed on {{host}}: this session will not survive a lost connection. Tessel is putting its own copy there for the next sessions.'),
    noTmuxBundled: t('main.ssh.noTmuxBundled', 'tmux is not installed on {{host}} and Tessel’s own copy could not be put there ({{reason}}): this session will not survive a lost connection.'),
    tmuxReasons: {
      'no-arch': t('main.ssh.tmuxNoArch', 'no copy for this kind of machine, {{arch}}'),
      noexec: t('main.ssh.tmuxNoExec', 'the home folder there refuses to run programs'),
      checksum: t('main.ssh.tmuxChecksum', 'the copy did not arrive intact'),
      upload: t('main.ssh.tmuxUpload', 'the upload failed'),
      failed: t('main.ssh.tmuxFailed', 'it could not be set up')
    },
    gaveUp: t('main.ssh.gaveUp', 'Could not reconnect to {{host}}.'),
    notConnected: t('main.ssh.notConnected', 'Not connected to {{host}}: what you type is not sent until the new shell starts.'),
    codes: {
      'auth-failed': t('main.ssh.authFailed', 'Sign-in to {{host}} failed (permission denied).'),
      'auth-cancelled': t('main.ssh.authCancelled', 'Sign-in to {{host}} was cancelled.'),
      timeout: t('main.ssh.timeout', 'The connection to {{host}} timed out.'),
      dns: t('main.ssh.dns', 'The host name {{host}} could not be found.'),
      network: t('main.ssh.network', 'Could not reach {{host}} on port {{port}} ({{detail}}).'),
      closed: t('main.ssh.closed', '{{host}} closed the connection during sign-in.'),
      lost: t('main.ssh.lostShort', 'The connection to {{host}} was lost.'),
      channel: t('main.ssh.channel', '{{host}} refused to open another session: {{detail}}'),
      'hostkey-declined': t('main.ssh.hostKeyDeclined', 'The host key of {{host}} was not accepted: not connected.'),
      'hostkey-changed': t(
        'main.ssh.hostKeyChanged',
        'WARNING: the host key of {{host}} has CHANGED ({{keyType}} {{fingerprint}}). It does not match your known_hosts file: someone could be impersonating this host. Tessel refused to connect. If the host was really reinstalled, remove the old key with: ssh-keygen -R {{remove}}'
      ),
      'hostkey-changed-store': t(
        'main.ssh.hostKeyChangedStore',
        'WARNING: the host key of {{host}} has CHANGED since you accepted it ({{keyType}} {{fingerprint}}): someone could be impersonating this host. Tessel refused to connect. If the host was really reinstalled, remove its entry from {{storeFile}}.'
      ),
      'hostkey-changed-type': t(
        'main.ssh.hostKeyChangedType',
        'WARNING: {{host}} offered a {{keyType}} host key while a key of another type is on file in known_hosts: someone could be impersonating this host. Tessel refused to connect. If the host was really reinstalled, run: ssh-keygen -R {{remove}}'
      ),
      'hostkey-changed-type-store': t(
        'main.ssh.hostKeyChangedTypeStore',
        'WARNING: {{host}} offered a {{keyType}} host key while you accepted a key of another type: someone could be impersonating this host. Tessel refused to connect. If the host was really reinstalled, remove its entry from {{storeFile}}.'
      ),
      'hostkey-changed-pinned': t(
        'main.ssh.hostKeyChangedPinned',
        'WARNING: {{host}} presented a different host key ({{keyType}} {{fingerprint}}) than at the first connection of this session, and StrictHostKeyChecking does not check it: someone could be impersonating this host. Tessel refused to connect.'
      ),
      algorithms: t('main.ssh.algorithms', 'The algorithms set for {{host}} in your SSH configuration ({{detail}}) are not supported by Tessel’s SSH client.'),
      'hostkey-revoked': t('main.ssh.hostKeyRevoked', 'The host key of {{host}} is marked as revoked in known_hosts: Tessel refused to connect.'),
      'hostkey-unknown-strict': t('main.ssh.hostKeyStrict', '{{host}} is not in your known_hosts file and StrictHostKeyChecking is on: Tessel refused to connect. Connect once with ssh to add it.'),
      'hostkey-unreadable': t('main.ssh.hostKeyUnreadable', '{{host}} offered a host key Tessel could not read: not connected.'),
      failed: t('main.ssh.failed', 'Could not connect to {{host}}: {{detail}}')
    }
  }
}

// Values may come from the server (a disconnect reason): never a control
// character (no terminal escape sequence) in the pane or the status.
const clean = (v) => String(v).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')

function fill(template, vars) {
  return String(template || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (m, name) => (vars[name] !== undefined && vars[name] !== null ? clean(vars[name]) : m))
}

// code + params (public values) -> one line of text.
export function formatSshError(templates, code, params = {}, label = '') {
  const p = params && typeof params === 'object' ? params : {}
  const host = label || p.host || ''
  const port = p.port || 22
  const vars = {
    host,
    port,
    keyType: p.keyType || '',
    fingerprint: p.fingerprint || '',
    storeFile: p.storeFile || '',
    detail: p.detail || code || '',
    remove: p.host ? keygenRemoveTarget(p.host, port) : host
  }
  const codes = (templates && templates.codes) || {}
  return fill(codes[code] || codes.failed || '{{host}}: {{detail}}', vars)
}

// The pane's "no tmux" line for what main found out about Tessel's own tmux
// on the host (ssh/remoteTmux.js forPane -> { ok, source?, reason?, arch? }),
// with {{host}} left for the terminal host to fill. null: the plain line
// (tmux there, or no copy in this build, or nothing known).
export function tmuxMissingText(templates, tmux) {
  if (!templates || !tmux || tmux.ok) return null
  const reasons = templates.tmuxReasons || {}
  switch (tmux.reason) {
    case 'not-connected':
    case 'slow':
      return templates.noTmuxSoon || null
    case 'no-arch':
    case 'noexec':
    case 'checksum':
    case 'upload':
    case 'failed':
      return templates.noTmuxBundled ? fill(templates.noTmuxBundled, { reason: fill(reasons[tmux.reason] || reasons.failed || tmux.reason, { arch: tmux.arch || '?' }) }) : null
    default:
      return null
  }
}

export function formatSshText(template, vars = {}) {
  return fill(template, vars)
}
