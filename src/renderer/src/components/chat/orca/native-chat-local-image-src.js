// The attachment preview's on-disk image source (the reference's
// components/editor/useLocalImageSrc). Tessel's chat is text-only today and
// has no renderer API that turns a local path into an image URL, so this
// yields nothing: previews show the clipboard thumbnail or the image icon.
// Kept as its own module so a later loader (and specs) can replace it.
import { computed, toValue } from 'vue'

// eslint-disable-next-line no-unused-vars
export function useLocalImageSrc(src, _path, _connectionId) {
  return computed(() => {
    toValue(src)
    return undefined
  })
}
