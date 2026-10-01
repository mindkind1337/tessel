// OpenSSH's default key files and "~" paths (no ssh2 here: the app's main
// process uses these without loading the SSH client).
import os from 'os'
import { join } from 'path'

const DEFAULT_KEY_NAMES = ['id_rsa', 'id_ecdsa', 'id_ecdsa_sk', 'id_ed25519', 'id_ed25519_sk', 'id_xmss', 'id_dsa']

export function defaultIdentityFiles(home = os.homedir()) {
  return DEFAULT_KEY_NAMES.map((n) => join(home, '.ssh', n))
}

// '~/x' and '~\x' from the home folder.
export function expandHome(p, home = os.homedir()) {
  const s = String(p || '')
  if (s === '~') return home
  if (s.startsWith('~/') || s.startsWith('~\\')) return join(home, ...s.slice(2).split(/[\\/]+/).filter(Boolean))
  return s
}
