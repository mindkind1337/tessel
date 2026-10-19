// The folders a commit link may ask git about (links/commitLinks.js in the
// window, scm:resolveCommit in main): the open projects (this computer's,
// an SSH host's ssh://…, a Live Share host's lshare://…), the folder the
// side panel shows and the task / pane worktree copies. A folder a terminal
// reports (its shell's OSC 7 / OSC 633 current folder: anything a program
// prints) is only asked about when it is inside one of them, so text on
// screen never makes git run in a folder of its choosing.
// Never a network share (\\server\share, //server/…: reading it could hand
// your Windows sign-in to that server), only WSL's own (\\wsl.localhost\…,
// \\wsl$\…); never a path with a ".." part.

const MAX_ROOTS = 1000
const MAX_PATH = 4096
const CONTROL = /[\u0000-\u001f\u007f]/
const WSL_SHARE = /^[\\/]{2}wsl(?:\$|\.localhost)[\\/][\w.-]+(?:[\\/]|$)/i
const VIRTUAL = /^(?:ssh|lshare):\/\//i

// A network share other than WSL's.
export const isForeignShare = (p) => typeof p === 'string' && /^[\\/]{2}/.test(p) && !WSL_SHARE.test(p)

export function validCommitRoot(p) {
  if (typeof p !== 'string' || !p || p.length > MAX_PATH || CONTROL.test(p)) return false
  if (isForeignShare(p)) return false
  const rest = VIRTUAL.test(p) ? p.replace(VIRTUAL, '') : p
  return !/(^|[\\/])\.\.([\\/]|$)/.test(rest)
}

function norm(p) {
  if (VIRTUAL.test(p)) {
    const m = VIRTUAL.exec(p)
    return m[0].toLowerCase() + p.slice(m[0].length).replace(/\/+/g, '/').replace(/\/+$/, '')
  }
  return p.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()
}

// The list kept: valid, each once, at most MAX_ROOTS.
export function cleanCommitRoots(list) {
  const out = []
  const seen = new Set()
  for (const p of Array.isArray(list) ? list : []) {
    if (!validCommitRoot(p)) continue
    const k = norm(p)
    if (!k || seen.has(k)) continue
    seen.add(k)
    out.push(p)
    if (out.length >= MAX_ROOTS) break
  }
  return out
}

// root is one of them or inside one.
export function commitRootAllowed(root, roots) {
  if (!validCommitRoot(root)) return false
  const a = norm(root)
  if (!a) return false
  for (const r of Array.isArray(roots) ? roots : []) {
    if (!validCommitRoot(r)) continue
    const b = norm(r)
    if (b && (a === b || a.startsWith(`${b}/`))) return true
  }
  return false
}

// p is the folder `base` or inside it (a shell's folder under the pane's).
export function insideFolder(p, base) {
  return validCommitRoot(p) && validCommitRoot(base) && commitRootAllowed(p, [base])
}
