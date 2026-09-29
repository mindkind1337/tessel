// Tessel protection for the ported tool rows (not in Orca): a tool's input is
// masked with chatModel's maskSecrets BEFORE any label, preview, run sentence
// or detail is cut from it, so a clipped line can never leave half a secret
// that the patterns no longer recognise. Diffs (file content) are not masked.
import { maskSecrets } from '../../chatModel.js'
import { isToolCallBlock } from '../shared/native-chat-types.js'

// An object key that names a credential ("apiKey", "access_token", "password").
const SECRET_KEY = /(?:key|token|secret|password|passwd|pwd|auth|authorization|credentials?|signature)$/i
const MAX_DEPTH = 12

function maskValue(value, depth) {
  if (typeof value === 'string') return maskSecrets(value)
  if (depth > MAX_DEPTH || value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((entry) => maskValue(entry, depth + 1))
  const out = {}
  for (const [key, entry] of Object.entries(value)) {
    out[key] = SECRET_KEY.test(key) && typeof entry === 'string' && entry !== '' ? '***' : maskValue(entry, depth + 1)
  }
  return out
}

/** The input with every string masked and credential-named fields hidden. JSON
 *  text (Codex sends arguments as a string) is masked field by field too. */
export function maskToolInput(input) {
  if (typeof input === 'string') {
    const trimmed = input.trim()
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return JSON.stringify(maskValue(JSON.parse(trimmed), 0))
      } catch {
        // Not JSON after all: mask it as text.
      }
    }
    return maskSecrets(input)
  }
  return maskValue(input, 0)
}

/** A tool call with its input masked (other blocks unchanged). */
export function maskToolCallBlock(block) {
  if (!isToolCallBlock(block)) return block
  return { ...block, input: maskToolInput(block.input) }
}

/** maskSecrets for any other agent text shown as a label (task names, commands). */
export function maskToolText(text) {
  return maskSecrets(text)
}
