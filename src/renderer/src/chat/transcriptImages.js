// The images of a terminal agent's chat view (src/main/chat/transcriptView.js):
// the main process sends an image's bytes (dataUrl) to a view only once, then
// only its key. The view keeps the bytes it was given for the images of the
// latest page, fills them back into each read, and names the keys it lacks
// (a send it missed) so it can ask for them (transcriptView:images).
const DATA_IMAGE = /^data:image\/(?:png|jpeg|gif|webp);base64,/

export function createTranscriptImages() {
  let kept = new Map() // key -> dataUrl

  // events (as read) -> { events (images filled), missing: [key] }. An image
  // whose bytes are missing stays (its name shows) until they come.
  function apply(events) {
    const next = new Map()
    const missing = []
    const out = (Array.isArray(events) ? events : []).map((ev) => {
      if (!ev || !Array.isArray(ev.images) || !ev.images.some((img) => img && typeof img.key === 'string')) return ev
      const images = ev.images.map((img) => {
        if (!img || typeof img.key !== 'string') return img
        const data = typeof img.dataUrl === 'string' && DATA_IMAGE.test(img.dataUrl) ? img.dataUrl : kept.get(img.key) || next.get(img.key)
        if (!data) {
          if (!missing.includes(img.key)) missing.push(img.key)
          return img
        }
        next.set(img.key, data)
        return img.dataUrl === data ? img : { ...img, dataUrl: data }
      })
      return { ...ev, images }
    })
    // Only the latest page's images are kept (the main process sends again
    // one that leaves the page and comes back).
    kept = next
    return { events: out, missing }
  }
  // { key: dataUrl } the main process sent again.
  function add(images) {
    for (const [key, data] of Object.entries(images && typeof images === 'object' ? images : {}))
      if (typeof data === 'string' && DATA_IMAGE.test(data)) kept.set(key, data)
  }
  function clear() {
    kept = new Map()
  }
  return { apply, add, clear, size: () => kept.size }
}
