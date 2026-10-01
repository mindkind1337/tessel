// The themed dialog's page (src/main/themedDialog.js): draws the question the
// main process sent, as text only (textContent, never HTML), and handles the
// keyboard. Used by its preload (themedDialog.js); kept apart for the tests.

const HEX = /^#[0-9a-f]{3,8}$/i
// Clicks and Enter wait this long after the question appears, so a key the
// user was already pressing in Tessel does not answer it (Esc always works).
export const ARM_DELAY_MS = 400

// content: { type, title, message, detail, buttons, defaultId, cancelId, vars }
// answer(index): sends the choice (once). Returns the height the page needs.
export function renderDialog(doc, content, answer, now = () => Date.now()) {
  const root = doc.documentElement
  for (const [name, value] of Object.entries(content.vars || {})) {
    if (/^--[a-z0-9-]+$/.test(name) && HEX.test(String(value))) root.style.setProperty(name, String(value))
  }
  root.dataset.theme = content.theme === 'warp' ? 'warp' : 'classic'
  doc.body.classList.toggle('cover', content.cover === true)
  const byId = (id) => doc.getElementById(id)
  byId('icon')?.setAttribute('class', `icon ${['warning', 'error', 'question'].includes(content.type) ? content.type : 'info'}`)
  byId('title').textContent = String(content.title || '')
  byId('message').textContent = String(content.message || '')
  byId('detail').textContent = String(content.detail || '')
  doc.title = String(content.title || '')

  const labels = Array.isArray(content.buttons) ? content.buttons.map((b) => String(b)) : []
  const cancelId = content.cancelId
  const defaultId = Number.isInteger(content.defaultId) ? content.defaultId : cancelId
  const armedAt = now() + ARM_DELAY_MS
  const choose = (index, { safe = false } = {}) => {
    if (!safe && index !== cancelId && now() < armedAt) return
    answer(index)
  }

  // Tessel's order: Cancel first, the other choices after it (on the right).
  const order = [cancelId, ...labels.map((_, i) => i).filter((i) => i !== cancelId)]
  const actions = byId('actions')
  actions.textContent = ''
  const buttons = []
  for (const index of order) {
    if (index < 0 || index >= labels.length) continue
    const button = doc.createElement('button')
    button.type = 'button'
    button.textContent = labels[index]
    button.dataset.index = String(index)
    if (index !== cancelId) button.className = content.type === 'warning' || content.type === 'error' ? 'primary danger' : 'primary'
    button.addEventListener('click', () => choose(index))
    actions.appendChild(button)
    buttons.push(button)
  }

  const indexOf = (el) => (el && buttons.includes(el) ? Number(el.dataset.index) : -1)
  doc.body.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        choose(cancelId, { safe: true })
      } else if (event.key === 'Enter') {
        event.preventDefault()
        if (event.repeat) return
        const focused = indexOf(doc.activeElement)
        choose(focused >= 0 ? focused : defaultId)
      } else if (event.key === 'Tab') {
        event.preventDefault()
        doc.body.classList.add('kbd')
        if (!buttons.length) return
        const at = buttons.indexOf(doc.activeElement)
        const next = at < 0 ? 0 : (at + (event.shiftKey ? buttons.length - 1 : 1)) % buttons.length
        buttons[next].focus()
      }
    },
    true
  )
  // The safe choice has the focus: the default button (Cancel for a question
  // about trust).
  const first = buttons.find((b) => Number(b.dataset.index) === defaultId) || buttons[0]
  first?.focus()
  // Over Tessel's window, a click beside the card is Cancel (as in Tessel).
  const backdrop = doc.querySelector('.backdrop')
  backdrop?.addEventListener('pointerdown', (event) => {
    if (content.cover === true && event.target === backdrop) choose(cancelId, { safe: true })
  })
  // The height the card needs (a window of its own is sized to it).
  const card = doc.querySelector('.card')
  return Math.ceil((card ? card.scrollHeight : 0) + 2)
}
