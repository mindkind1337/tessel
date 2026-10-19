// Live Share: images pasted into a host's panes.
//
// Host: a guest with the type right pasted an image into one of your panes.
// Main checked it, made it a new PNG and saved it with your pasted images
// (main/liveShare/sharePaste.js); here its path is pasted into the pane as
// your own image paste would (TerminalPane.vue pasteImageFile: Claude Code's
// "[Image #N]", an SSH host's copy), once the request still stands.
//
// Guest: what the host's answer means, in words, for the toast on a pane
// whose image was not pasted.
import { t } from './i18n'
import { getPane } from './paneRegistry'

// req: main's { request, id (your pane), project, file, guest }; stands(): the
// guest still in, with the type right, seeing that project; check(): main
// still waits for it and the access model still says yes (asked again right
// before the path is pasted: an SSH host's copy can take a while);
// answer(ok, code).
export async function pasteForGuest(req, { stands, check = null, answer }) {
  const pane = req && typeof req.id === 'string' ? getPane(req.id) : null
  if (!req || typeof req.file !== 'string' || !stands()) return answer(false, 'revoked')
  if (!pane || typeof pane.pasteImageFile !== 'function') return answer(false, 'not-found')
  let res = null
  try {
    res = await pane.pasteImageFile(req.file, async () => stands() && (!check || (await check()) === true))
  } catch {
    res = null
  }
  if (res && res.ok) return answer(true)
  return answer(false, (res && res.code) || 'failed')
}

// The toast's text for an image the host did not take (code: main's).
export function pasteFailText(code, host) {
  const name = host || '?'
  switch (code) {
    case 'forbidden':
    case 'revoked':
      return t('liveShare.paste.forbidden', '{{host}} has not let you type in this pane: the image was not pasted.', { host: name })
    case 'too-large':
      return t('liveShare.paste.tooLarge', 'The image is too large to send (10 MB, 8000 pixels a side and 25 megapixels at most).')
    case 'not-image':
      return t('liveShare.paste.notImage', 'That is not an image Tessel can read.')
    case 'no-image':
      return t('liveShare.paste.noImage', 'The clipboard has no image.')
    case 'busy':
      return t('liveShare.paste.busy', 'Images are being sent too fast: try again in a moment.')
    case 'outdated':
    case 'bad-op':
      return t('liveShare.paste.outdated', '{{host}}’s Tessel can’t take pasted images yet (it needs an update).', { host: name })
    case 'not-found':
      return t('liveShare.paste.notFound', 'This pane is no longer shared with you.')
    default:
      return t('liveShare.paste.failed', 'The image could not be pasted on {{host}}’s side.', { host: name })
  }
}
