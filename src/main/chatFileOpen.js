// Paths named in the native chat (chatFileLinks.js): which exist, and opening
// a folder or a media / document file with the system. Every call re-checks
// the path here, whatever the window already checked: absolute, local (never
// UNC, \\?\, \\.\ or a device), no control character, not a program or a
// script; a file goes to the system only when its type is media or a
// document (an allowlist, not a blocklist). No Electron import: shell and fs
// are passed in, so this stays testable in Node.
import fsDefault from 'fs'
import { isAbsolute } from 'path'
import { chatPathProblem, isSystemOpenFile, TEXT_ONLY_SCRIPT_EXTENSIONS, chatPathExt } from '../shared/chatFileLinks'
import { t } from './i18n'

export const MAX_STAT_PATHS = 64

function checked(p) {
  if (chatPathProblem(p)) return null
  return isAbsolute(p) ? p : null
}

async function kindOf(p, fsp) {
  try {
    const st = await fsp.stat(p)
    return st.isDirectory() ? 'dir' : st.isFile() ? 'file' : null
  } catch {
    return null
  }
}

// { paths: [...] } -> { [path]: 'file' | 'dir' | null }. At most 64 paths;
// one that fails the checks is null without touching the disk.
export async function statChatPaths(q, { fsp = fsDefault.promises } = {}) {
  const list = Array.isArray(q?.paths) ? q.paths.slice(0, MAX_STAT_PATHS) : []
  const out = {}
  await Promise.all(
    list.map(async (p) => {
      if (typeof p !== 'string') return
      const safePath = checked(p)
      out[p] = safePath ? await kindOf(safePath, fsp) : null
    })
  )
  return out
}

function refused(reason) {
  const error =
    reason === 'executable'
      ? t('main.chatFiles.executable', 'Tessel never opens programs or scripts from the chat.')
      : reason === 'network'
        ? t('main.chatFiles.network', 'Network and device paths never open from the chat.')
        : reason === 'missing'
          ? t('main.error.notFound', 'Not found.')
          : reason === 'type'
            ? t('main.chatFiles.type', 'This kind of file does not open with the system from the chat.')
            : t('main.chatFiles.invalid', 'This path is not valid.')
  return { ok: false, reason, error }
}

// { path } -> { ok, with: 'folder' | 'default' } | { ok: false, reason, error }.
// A folder opens in the file manager; a file only when media or a document.
export async function openChatPath(q, { shell, fsp = fsDefault.promises } = {}) {
  const p = q && typeof q.path === 'string' ? q.path : ''
  const problem = chatPathProblem(p)
  if (problem) return refused(problem === 'control' ? 'invalid' : problem)
  if (!isAbsolute(p)) return refused('invalid')
  const kind = await kindOf(p, fsp)
  if (!kind) return refused('missing')
  if (kind === 'file' && (!isSystemOpenFile(p) || TEXT_ONLY_SCRIPT_EXTENSIONS.has(chatPathExt(p)))) return refused('type')
  const err = await shell.openPath(p)
  return err ? { ok: false, reason: 'failed', error: err } : { ok: true, with: kind === 'dir' ? 'folder' : 'default' }
}
