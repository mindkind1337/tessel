// After Orca's use-native-chat-link-actions.ts (MIT, Copyright (c) 2026 Lovecast Inc.)
// Context, rootRef, scope/options accept refs or getters; callbacks are plain functions.
// openWeb(url,event) can select Tessel's integrated browser; default opens externally.
// Stable object with computed onLinkClick and nullable linkActionRequest ref (no menu).
import { computed, inject, ref, toValue, unref } from 'vue'
import { routeNativeChatHref } from '../shared/native-chat-href-routing.js'
import { useNativeChatFileLinkClick } from './use-native-chat-file-link-click.js'

export function useNativeChatLinkActions(context, rootRef, scope = {}, options = {}) {
  const panel = inject('panelCtx', null)
  const onFileClick = useNativeChatFileLinkClick(context, options)
  const linkActionRequest = ref(null)
  async function onLinkClick(event, href) {
    if (toValue(toValue(scope)?.isVisible) === false) return
    const route = routeNativeChatHref(href)
    if (route.kind === 'file') return onFileClick.value(event, href)
    // Prevent document navigation even for unsupported schemes.
    if (!String(href).startsWith('#')) event.preventDefault()
    if (route.kind !== 'web' || !/^https?:\/\//i.test(route.url)) return
    try {
      new URL(route.url)
    } catch {
      return
    }
    event.preventDefault()
    event.stopPropagation()
    const open =
      unref(toValue(options).openWeb) ||
      panel?.openExternal ||
      globalThis.window?.shellApi?.openExternal
    try {
      const result = await open?.(route.url, event)
      if (result === false || result?.ok === false)
        unref(toValue(options).onOpenFailure)?.({
          verdict: 'unverifiable',
          path: route.url,
          error: result?.error,
        })
    } catch (error) {
      unref(toValue(options).onOpenFailure)?.({ verdict: 'unverifiable', path: route.url, error })
    }
  }
  function closeLinkActions(dismissed = false) {
    const anchor = linkActionRequest.value?.anchor
    linkActionRequest.value = null
    if (dismissed)
      (anchor?.isConnected ? anchor : toValue(rootRef))?.focus?.({ preventScroll: true })
  }
  return { onLinkClick: computed(() => onLinkClick), linkActionRequest, closeLinkActions }
}
