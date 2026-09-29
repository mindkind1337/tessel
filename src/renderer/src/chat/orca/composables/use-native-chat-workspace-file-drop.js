// After Orca's use-native-chat-workspace-file-drop.ts (MIT, Copyright (c) 2026 Lovecast Inc.)
// options/data fields accept refs or getters; callbacks remain ordinary functions.
// Bind both capture handlers to the pane surface; supports Tessel explorer and OS files.
// insertText(text) or attachResolvedPaths(paths,undefined,{targetOwnerIsCurrent}) inserts only text.
import { toValue, unref } from 'vue'
import {
  validateNativeFileDropPaths,
  NATIVE_FILE_DROP_MAX_PATHS,
} from '../shared/native-file-drop.js'
import { t } from '../../../i18n/index.js'

const PATH_MIME = 'text/x-tessel-path'
export function useNativeChatWorkspaceFileDrop(options) {
  const data = (key) => toValue(toValue(options)[key])
  const callback = (key) => unref(toValue(options)[key])
  const recognized = (transfer) =>
    Array.from(transfer?.types || []).some((type) => type === PATH_MIME || type === 'Files')
  const disabled = () => data('disabled') || data('remote')
  const ownerKey = () =>
    JSON.stringify([
      data('paneKey'),
      data('structuredWorktreeId'),
      data('terminalTabId'),
      data('sessionId'),
    ])
  function claim(event) {
    event.preventDefault()
    event.stopPropagation()
    const transfer = event.dataTransfer
    const allowsCopy = [
      'all',
      'copy',
      'copyLink',
      'copyMove',
      'uninitialized',
      undefined,
      '',
    ].includes(transfer.effectAllowed)
    transfer.dropEffect = disabled() || !allowsCopy ? 'none' : 'copy'
    return transfer.dropEffect === 'copy'
  }
  function notice() {
    // prettier-ignore
    const message = t('chat.orca.composer.fileDropFailed', 'Could not insert these file paths. Drop up to 256 local files.')
    callback('setNotice')?.(message)
  }
  function onDragOverCapture(event) {
    if (recognized(event.dataTransfer)) claim(event)
  }
  function onDropCapture(event) {
    if (!recognized(event.dataTransfer) || !claim(event)) return
    const owner = ownerKey()
    const targetOwnerIsCurrent = () => !disabled() && ownerKey() === owner
    try {
      const transfer = event.dataTransfer
      const path = transfer.getData(PATH_MIME)
      const files = Array.from(transfer.files || [])
      if (!path && files.length > NATIVE_FILE_DROP_MAX_PATHS) return notice()
      const toPath = callback('pathForFile') || globalThis.window?.shellApi?.pathForFile
      const paths = path ? [path] : files.map((file) => toPath?.(file))
      if (!paths.length) return
      if (
        paths.some(
          (value) =>
            typeof value !== 'string' ||
            !value.trim() ||
            /[\0\r\n]/.test(value) ||
            !/^(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(value),
        ) ||
        validateNativeFileDropPaths(paths).status === 'rejected'
      )
        return notice()
      if (!targetOwnerIsCurrent()) return
      const attach = callback('attachResolvedPaths')
      const result = attach
        ? attach(paths, undefined, { targetOwnerIsCurrent })
        : callback('insertText')?.(
            paths.map((value) => (/\s/.test(value) ? JSON.stringify(value) : value)).join(' ') +
              ' ',
          )
      if (result?.catch)
        result.catch(() => {
          if (targetOwnerIsCurrent()) notice()
        })
    } catch {
      if (targetOwnerIsCurrent()) notice()
    }
  }
  return { onDragOverCapture, onDropCapture }
}
