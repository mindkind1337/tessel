// After Orca's use-native-chat-file-link-click.ts (MIT, Copyright (c) 2026 Lovecast Inc.)
// context/options accept values, refs/computed or getters. Local contexts only.
// openFile({file,line,col}, event) defaults to Tessel's injected viewFile.
// Returns a computed click handler; onOpenFailure({verdict,path,error}) is optional.
//
// Tessel: where a path goes, after the checks (chatFileLinks.js):
//   - a program or a script, a network / UNC / device path, control
//     characters: refused, with why; a path that does not exist: refused;
//   - outside the chat's folders: Tessel asks first (its own dialog,
//     askConfirm), then opens;
//   - a folder: the system's file manager; media and documents: the system's
//     default app (both through shellApi.chatFiles.open, re-checked in main);
//     anything else (text, code): Tessel's editor (openFile / viewFile).
// Options (tests, other hosts): statPath(path) -> 'file' | 'dir' | null,
// openSystem(path) -> { ok, error }, confirmOpen({ path, kind }) -> boolean.
import { computed, inject, toValue, unref } from 'vue'
import { routeNativeChatHref } from '../shared/native-chat-href-routing.js'
import {
  parseExplicitFileLinkTarget,
  resolveExplicitFileLinkTarget,
} from '../lib/explicit-file-link-target.js'
import { t } from '../../../i18n/index.js'
import { isPathInsideOrEqual } from '../shared/cross-platform-path.js'
import { chatPathProblem, isSystemOpenFile } from '../../../../../shared/chatFileLinks.js'
import { fileKind } from '../../../../../shared/fileKinds.js'

function chatFilesApi() {
  return globalThis.window?.shellApi?.chatFiles || null
}

export async function statChatPath(path) {
  const api = chatFilesApi()
  if (!api?.stat) return undefined
  const res = await api.stat([path])
  return res?.[path] ?? null
}

export function useNativeChatFileLinkClick(context, options = {}) {
  const panel = inject('panelCtx', null)
  const askConfirm = inject('askConfirm', null)
  const callback = (name) => unref(toValue(options)[name])
  function failure(verdict, path, error = '') {
    if (callback('onOpenFailure')) return callback('onOpenFailure')({ verdict, path, error })
    const value0 = path
    const message =
      verdict === 'outside'
        ? t('chat.orca.fileLinks.outside', "Only files in this chat's folders open from the chat: {{value0}}", { value0 })
        : verdict === 'unresolved'
        ? t('chat.orca.fileLinks.unresolved', 'Could not resolve {{value0}} in this workspace', { value0 })
        : verdict === 'executable'
        ? t('chat.orca.fileLinks.executable', 'Tessel never opens programs or scripts from the chat: {{value0}}', { value0 })
        : verdict === 'network'
        ? t('chat.orca.fileLinks.network', 'Network and device paths never open from the chat: {{value0}}', { value0 })
        : verdict === 'invalid' || verdict === 'control'
        ? t('chat.orca.fileLinks.invalid', 'This path is not valid: {{value0}}', { value0 })
        : verdict === 'missing'
        ? t('chat.orca.fileLinks.missing', 'Not found: {{value0}}', { value0 })
        : t('chat.orca.fileLinks.unverifiable', 'Could not verify {{value0}}: {{value1}}', {
            value0,
            value1: String(error?.message || error),
          })
    panel?.toast?.(message, { kind: 'error' })
  }
  async function confirmOutside(path, kind) {
    const custom = callback('confirmOpen')
    if (custom) return !!(await custom({ path, kind }))
    if (!askConfirm) return null
    const answer = await askConfirm({
      title:
        kind === 'dir'
          ? t('chat.orca.fileLinks.confirmFolderTitle', 'Open this folder outside the project?')
          : t('chat.orca.fileLinks.confirmTitle', 'Open this file outside the project?'),
      text: path,
      confirmLabel: t('chat.orca.fileLinks.confirmOpen', 'Open'),
    })
    return answer === true
  }
  // An image: Tessel's own viewer (the lightbox) when there is one; false
  // sends it on to the system's app.
  async function showInLightbox(path) {
    const view = callback('viewImage') || globalThis.window?.shellApi?.viewImage
    const show = callback('showImage') || panel?.showImage
    if (!view || !show) return false
    const res = await Promise.resolve()
      .then(() => view(path))
      .catch(() => null)
    if (!res?.ok || typeof res.dataUrl !== 'string' || !res.dataUrl.startsWith('data:image/')) return false
    show({ src: res.dataUrl, title: path.split(/[\\/]/).pop() || path, file: null })
    return true
  }
  async function onLinkClick(event, href) {
    const route = routeNativeChatHref(href)
    if (route.kind !== 'file') return
    event.preventDefault()
    event.stopPropagation()
    const owner = toValue(context)
    // Checked on the text too: a UNC or device path is never resolved nor looked at.
    const early = chatPathProblem(route.pathText, { requireAbsolute: false })
    if (early === 'control' || early === 'network') return failure(early, route.pathText)
    const parsed = parseExplicitFileLinkTarget(route.pathText, { allowRelativeDirectoryPath: true })
    const target =
      owner?.worktreePath && !owner.remote && !owner.runtimeEnvironmentId && parsed
        ? resolveExplicitFileLinkTarget(parsed, owner.worktreePath, owner.homePath)
        : null
    if (!target) return failure('unresolved', route.pathText)
    const path = target.absolutePath
    const problem = chatPathProblem(path)
    if (problem) return failure(problem, path)
    const roots = Array.isArray(owner.roots) && owner.roots.length ? owner.roots : [owner.worktreePath]
    const inside = roots.some((root) => isPathInsideOrEqual(root, path))
    // Never a guess: the main process says whether it exists (and what it is).
    const statPath = callback('statPath') || statChatPath
    let kind
    try {
      kind = await statPath(path)
    } catch (error) {
      return failure('unverifiable', path, error)
    }
    if (kind === undefined) {
      // No way to look (no Tessel main process): only the chat's own folders, in the viewer.
      if (!inside) return failure('outside', route.pathText)
      kind = 'file'
    }
    if (kind !== 'file' && kind !== 'dir') return failure('missing', path)
    if (!inside) {
      const ok = await confirmOutside(path, kind)
      if (ok === null) return failure('outside', route.pathText)
      if (!ok) return
    }
    try {
      if (kind === 'file' && fileKind(path) === 'image' && (await showInLightbox(path))) return
      if (kind === 'dir' || isSystemOpenFile(path)) {
        const openSystem = callback('openSystem') || chatFilesApi()?.open
        if (!openSystem) return failure('unverifiable', path, '')
        const result = await openSystem(path)
        if (!result || result.ok === false)
          failure(result?.reason === 'missing' ? 'missing' : result?.reason === 'executable' ? 'executable' : 'unverifiable', path, result?.error || '')
        return
      }
      const open = callback('openFile') || panel?.viewFile
      if (!open) return failure('unresolved', route.pathText)
      const result = await open({ file: path, line: target.line ?? route.line, col: target.column }, event)
      if (result === false || result?.ok === false) failure('unverifiable', path, result?.error)
    } catch (error) {
      failure('unverifiable', path, error)
    }
  }
  return computed(() => onLinkClick)
}
