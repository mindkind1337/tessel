// A file read whole for a view of its own (a workbook, a document, slides,
// audio, video): the main process gives it as a data URL (files:viewImage,
// the same size cap and project checks as an image), turned back into bytes.
// -> { bytes: Uint8Array, mime } | { error }
export async function loadBytes(file) {
  let r
  try {
    r = window.shellApi && window.shellApi.viewImage ? await window.shellApi.viewImage(file) : null
  } catch (err) {
    r = { ok: false, error: err && err.message }
  }
  if (!r || !r.ok || !r.dataUrl) return { error: (r && r.error) || '' }
  const m = /^data:([^;,]*)[^,]*,/.exec(r.dataUrl)
  const bin = atob(r.dataUrl.slice(m ? m[0].length : 0))
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return { bytes, mime: m ? m[1] : '' }
}
