// After Orca's use-native-chat-file-link-click.ts (MIT, Copyright (c) 2026 Lovecast Inc.)
// context/options accept values, refs/computed or getters. Local contexts only.
// openFile({file,line,col}, event) defaults to Tessel's injected viewFile.
// Returns a computed click handler; onOpenFailure({verdict,path,error}) is optional.
import { computed, inject, toValue, unref } from 'vue'
import { routeNativeChatHref } from '../shared/native-chat-href-routing.js'
import {
  parseExplicitFileLinkTarget,
  resolveExplicitFileLinkTarget,
} from '../lib/explicit-file-link-target.js'
import { t } from '../../../i18n/index.js'

export function useNativeChatFileLinkClick(context, options = {}) {
  const panel = inject('panelCtx', null)
  const callback = (name) => unref(toValue(options)[name])
  function failure(verdict, path, error = '') {
    if (callback('onOpenFailure')) return callback('onOpenFailure')({ verdict, path, error })
    const message =
      verdict === 'unresolved'
        ? t('chat.orca.fileLinks.unresolved', 'Could not resolve {{value0}} in this workspace', {
            value0: path,
          })
        : t('chat.orca.fileLinks.unverifiable', 'Could not verify {{value0}}: {{value1}}', {
            value0: path,
            value1: String(error?.message || error),
          })
    panel?.toast?.(message, { kind: 'error' })
  }
  async function onLinkClick(event, href) {
    const route = routeNativeChatHref(href)
    if (route.kind !== 'file') return
    event.preventDefault()
    event.stopPropagation()
    const owner = toValue(context)
    const parsed = parseExplicitFileLinkTarget(route.pathText, { allowRelativeDirectoryPath: true })
    const target =
      owner?.worktreePath && !owner.remote && !owner.runtimeEnvironmentId && parsed
        ? resolveExplicitFileLinkTarget(parsed, owner.worktreePath, owner.homePath)
        : null
    if (!target) return failure('unresolved', route.pathText)
    if (
      /[\0\r\n]/.test(target.absolutePath) ||
      /\.(?:exe|com|bat|cmd|msi|app|ps1|sh)$/i.test(target.absolutePath)
    )
      return failure('unresolved', route.pathText)
    const open = callback('openFile') || panel?.viewFile
    if (!open) return failure('unresolved', route.pathText)
    try {
      const result = await open(
        { file: target.absolutePath, line: target.line ?? route.line, col: target.column },
        event,
      )
      if (result === false || result?.ok === false)
        failure('unverifiable', target.absolutePath, result?.error)
    } catch (error) {
      failure('unverifiable', target.absolutePath, error)
    }
  }
  return computed(() => onLinkClick)
}
