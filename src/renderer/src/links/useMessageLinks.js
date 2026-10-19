// Opening what a message outside the chat shares (the Conversations tab,
// its Media view, Past conversations, task card reports, the activity log)
// the way the chat opens it: a path through the chat's file link checks
// (use-native-chat-file-link-click.js: resolved against the folder of the
// pane that wrote it, a worktree copy's when it works in one; refused when it
// is a program, asked first outside that folder; a folder to the Files tab,
// an image to the viewer, a PDF to its window), a web page or a mail address
// through the link router (openTarget.js), a data: image to the viewer.
// A Live Share guest (guest: true) opens web pages only, through the host's
// link filtering (App's openGuestUrl); a host's path never opens here.
import { inject } from 'vue'
import { openTarget } from './openTarget.js'
import { fileLinkContextOf } from '../chat/orca/composables/use-native-chat-file-link-context.js'
import { useNativeChatFileLinkClick } from '../chat/orca/composables/use-native-chat-file-link-click.js'
import { createNativeChatFileHref } from '../chat/orca/shared/native-chat-href-routing.js'
import { formatFileLinkLocation } from '../chat/orca/shared/file-link-location.js'
import { t } from '../i18n/index.js'

const quietEvent = () => ({ preventDefault() {}, stopPropagation() {}, ctrlKey: false, metaKey: false })

export function useMessageLinks() {
  const panel = inject('panelCtx', null)
  let current = null
  const fileClick = useNativeChatFileLinkClick(() => current)
  // One object per folder set, so a rendered message keeps the same context
  // (ChatMarkdown looks its inline code up again when it changes).
  const contexts = new Map()
  function stable(ctx) {
    if (!ctx) return null
    const key = [ctx.worktreeId || '', ctx.worktreePath, ...(ctx.roots || []), ctx.remoteRoot || ''].join('\u0000')
    if (!contexts.has(key)) {
      if (contexts.size > 200) contexts.clear()
      contexts.set(key, ctx)
    }
    return contexts.get(key)
  }
  // The folder a pane's message is read against: its pane open now (its
  // worktree copy, an SSH host's folder), else `folder` (its project's), else
  // none (its paths are not links).
  function contextFor(paneId, { folder = null, remote = false } = {}) {
    const leaf = paneId && panel && typeof panel.findLeaf === 'function' ? panel.findLeaf(paneId) : null
    if (leaf) return stable(fileLinkContextOf(leaf, panel))
    if (remote || typeof folder !== 'string' || !folder) return null
    return stable(fileLinkContextOf({ id: paneId || folder, cwd: folder }, null))
  }
  // A path, read against `context` (none: an absolute path, through the
  // router).
  function openPath({ path, line = null, col = null }, context, event = null) {
    const e = event || quietEvent()
    if (context) {
      current = context
      return fileClick.value(e, createNativeChatFileHref(formatFileLinkLocation({ pathText: path, line: line ?? null, column: col ?? null })))
    }
    if (!/^(?:[A-Za-z]:[\\/]|\/(?!\/)|~[\\/])/.test(path)) {
      panel?.toast?.(t('chat.orca.fileLinks.unresolved', 'Could not resolve {{value0}} in this workspace', { value0: path }), { kind: 'error' })
      return false
    }
    return openTarget({ path, line, col }, { event: e })
  }
  function openUrl(url, event = null, guest = false) {
    if (guest) return panel && typeof panel.openGuestUrl === 'function' ? panel.openGuestUrl(url, {}) : false
    // App's router (panelCtx.openTarget, as the chat's links), else the window's.
    const open = panel && typeof panel.openTarget === 'function' ? panel.openTarget : openTarget
    return open(url, { event: event || quietEvent() })
  }
  // A Media item (messageMedia.js) or a link's href.
  function openItem(item, context, event = null, { guest = false } = {}) {
    if (!item) return false
    if (item.url) return openUrl(item.url, event, guest)
    if (item.src) return openTarget({ src: item.src }, { event: event || quietEvent(), label: item.label || '' })
    if (item.path && !guest) return openPath(item, context, event)
    return false
  }
  return { contextFor, openPath, openUrl, openItem, panel }
}
