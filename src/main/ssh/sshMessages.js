// The words for SSH connection outcomes (codes from sshConnection.js /
// sshManager.js), in the interface's language. Main builds the templates with
// t() (placeholders left in); the terminal host, which has no language of its
// own, receives them with each remote terminal and fills them in.
import { keygenRemoveTarget } from './hostKeyDecision'

export function sshTemplates(t) {
  return {
    lost: t('main.ssh.lost', 'Connection to {{host}} lost. Reconnecting…'),
    reconnected: t('main.ssh.reconnected', 'Reconnected to {{host}}: a new shell was started.'),
    gaveUp: t('main.ssh.gaveUp', 'Could not reconnect to {{host}}.'),
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
      'hostkey-revoked': t('main.ssh.hostKeyRevoked', 'The host key of {{host}} is marked as revoked in known_hosts: Tessel refused to connect.'),
      'hostkey-unknown-strict': t('main.ssh.hostKeyStrict', '{{host}} is not in your known_hosts file and StrictHostKeyChecking is on: Tessel refused to connect. Connect once with ssh to add it.'),
      'hostkey-unreadable': t('main.ssh.hostKeyUnreadable', '{{host}} offered a host key Tessel could not read: not connected.'),
      failed: t('main.ssh.failed', 'Could not connect to {{host}}: {{detail}}')
    }
  }
}

function fill(template, vars) {
  return String(template || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (m, name) => (vars[name] !== undefined && vars[name] !== null ? String(vars[name]) : m))
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

export function formatSshText(template, vars = {}) {
  return fill(template, vars)
}
