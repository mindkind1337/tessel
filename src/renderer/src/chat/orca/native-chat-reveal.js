// Tessel: Show in Folder from the chat (a file link's menu, a path block).
// Main checks the path again and answers { ok } or { ok: false, reason }; a
// path it would not show (gone, a network path, not valid) is said in a
// toast, never a click that does nothing.
import { t } from '../../i18n'

export async function revealChatPath(path, toast) {
  const api = typeof window !== 'undefined' && window.shellApi && window.shellApi.chatFiles
  if (!path || !api || typeof api.reveal !== 'function') return false
  let res
  try {
    res = await api.reveal(path)
  } catch (err) {
    res = { ok: false, reason: 'error', error: err }
  }
  if (res && res.ok) return true
  const value0 = path
  const reason = res && res.reason
  const message =
    reason === 'missing'
      ? t('chat.orca.fileLinks.missing', 'Not found: {{value0}}', { value0 })
      : reason === 'network'
        ? t('chat.orca.fileLinks.network', 'Network and device paths never open from the chat: {{value0}}', { value0 })
        : reason === 'invalid'
          ? t('chat.orca.fileLinks.invalid', 'This path is not valid: {{value0}}', { value0 })
          : t('chat.orca.fileLinks.unverifiable', 'Could not verify {{value0}}: {{value1}}', { value0, value1: String((res && (res.error?.message || res.error || res.reason)) || '') })
  if (typeof toast === 'function') toast(message, { kind: 'error' })
  return false
}
