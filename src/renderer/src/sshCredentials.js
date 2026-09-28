// SSH password / passphrase prompts in the interface: the queue of prompts
// main found in a remote host pane (src/main/sshPrompts.js), like Orca's
// sshCredentialQueue (MIT, Copyright (c) 2026 Lovecast Inc.). The secret is
// never kept here: the dialog sends it straight through submitSshCredential.
import { reactive } from 'vue'

export const sshCredentialState = reactive({ queue: [] })

function api() {
  return typeof window !== 'undefined' && window.shellApi ? window.shellApi.sshCredentials || null : null
}

const KINDS = ['password', 'passphrase', 'keyboard-interactive']

export function addSshCredentialRequest(req) {
  if (!req || typeof req.paneId !== 'string' || typeof req.promptId !== 'string' || !KINDS.includes(req.kind)) return
  // One prompt per pane: a newer one replaces it.
  const rest = sshCredentialState.queue.filter((r) => r.paneId !== req.paneId)
  rest.push({
    paneId: req.paneId,
    promptId: req.promptId,
    hostId: typeof req.hostId === 'string' ? req.hostId : '',
    label: typeof req.label === 'string' ? req.label : '',
    kind: req.kind,
    detail: typeof req.detail === 'string' ? req.detail : '',
    retry: req.retry === true
  })
  sshCredentialState.queue = rest
}

export function removeSshCredentialRequest(promptId) {
  sshCredentialState.queue = sshCredentialState.queue.filter((r) => r.promptId !== promptId)
}

// value: the secret, or null to cancel. -> { ok, error? }
export async function submitSshCredential(req, value) {
  const a = api()
  if (!a || !req) return { ok: false, error: 'unavailable' }
  const res = await a.submit(req.paneId, req.promptId, value)
  if (res && res.ok) removeSshCredentialRequest(req.promptId)
  else if (res && res.error === 'stale') removeSshCredentialRequest(req.promptId)
  return res || { ok: false }
}

let unsubs = null
export function initSshCredentials() {
  const a = api()
  if (!a || unsubs) return
  unsubs = [
    a.onRequest((req) => addSshCredentialRequest(req)),
    a.onResolved((r) => r && removeSshCredentialRequest(r.promptId))
  ]
}
export function stopSshCredentials() {
  if (!unsubs) return
  for (const u of unsubs) u && u()
  unsubs = null
}
