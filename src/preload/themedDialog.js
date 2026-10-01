// Preload of the themed dialog window (src/main/themedDialog.js), sandboxed:
// it draws the question the main process sends and answers with the button
// chosen. The page exposes only answer(index); the main process accepts it
// from this window alone, once.
import { contextBridge, ipcRenderer } from 'electron'
import { renderDialog } from './themedDialogView'

let content = null
let answered = false

function answer(index) {
  if (answered || !content) return
  if (!Number.isInteger(index) || index < 0 || index >= content.buttons.length) return
  answered = true
  ipcRenderer.send('themed-dialog:answer', index)
}

contextBridge.exposeInMainWorld('tesselDialog', { answer: (index) => answer(Number(index)) })

ipcRenderer.on('themed-dialog:content', (_event, data) => {
  if (content || !data || !Array.isArray(data.buttons)) return
  content = data
  const draw = () => {
    const height = renderDialog(document, content, answer)
    ipcRenderer.send('themed-dialog:ready', height)
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', draw, { once: true })
  else draw()
})
