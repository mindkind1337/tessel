import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderDialog, ARM_DELAY_MS } from '../themedDialogView'
import { DIALOG_HTML, dialogContent, themeVars } from '../../main/themedDialog'

let clock
const now = () => clock

function load() {
  const parsed = new DOMParser().parseFromString(DIALOG_HTML, 'text/html')
  document.documentElement.innerHTML = parsed.documentElement.innerHTML
}

function draw(opts) {
  const answer = vi.fn()
  const content = dialogContent(opts, themeVars('dracula'))
  renderDialog(document, content, answer, now)
  return answer
}

const key = (k, extra = {}) => (document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra }))
const buttons = () => [...document.querySelectorAll('#actions button')]

const OPTS = {
  type: 'warning',
  title: 'Trust this repository?',
  message: 'The git settings of <b>repo</b> run programs',
  detail: 'hook: <img src=x onerror="window.pwned=1">\n\nTrust it only if you know where this folder comes from.',
  buttons: ['Trust and run them', 'Keep them off'],
  defaultId: 1,
  cancelId: 1
}

beforeEach(() => {
  clock = 1000
  load()
})

describe('renderDialog', () => {
  it('shows the text as text, never as HTML', () => {
    draw(OPTS)
    expect(document.getElementById('title').textContent).toBe('Trust this repository?')
    expect(document.getElementById('message').textContent).toBe(OPTS.message)
    expect(document.getElementById('detail').textContent).toBe(OPTS.detail)
    expect(document.querySelector('#message b')).toBeNull()
    expect(document.querySelector('img')).toBeNull()
    draw({ ...OPTS, buttons: ['<i>x</i>', 'Cancel'] })
    expect(document.querySelector('#actions i')).toBeNull()
    expect(buttons()[1].textContent).toBe('<i>x</i>')
  })

  it('sets the theme colours and the warning icon', () => {
    draw(OPTS)
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#bd93f9')
    expect(document.getElementById('icon').getAttribute('class')).toBe('icon warning')
  })

  it('puts Cancel first, the risky choice after it, and focuses the safe one', () => {
    draw(OPTS)
    const [first, second] = buttons()
    expect(first.textContent).toBe('Keep them off')
    expect(second.textContent).toBe('Trust and run them')
    expect(second.className).toBe('primary danger')
    expect(document.activeElement).toBe(first)
  })

  it('Esc cancels, Enter answers the focused button, Tab moves between them', () => {
    let answer = draw(OPTS)
    key('Escape')
    expect(answer).toHaveBeenLastCalledWith(1)

    load()
    answer = draw(OPTS)
    clock += ARM_DELAY_MS + 1
    key('Enter')
    expect(answer).toHaveBeenLastCalledWith(1)
    key('Tab')
    expect(document.activeElement).toBe(buttons()[1])
    key('Tab')
    expect(document.activeElement).toBe(buttons()[0])
    key('Tab', { shiftKey: true })
    expect(document.activeElement).toBe(buttons()[1])
    key('Enter')
    expect(answer).toHaveBeenLastCalledWith(0)
  })

  it('a held key or an early click does not answer the risky choice', () => {
    const answer = draw(OPTS)
    buttons()[1].click()
    buttons()[1].focus()
    key('Enter')
    expect(answer).not.toHaveBeenCalled()
    clock += ARM_DELAY_MS + 1
    key('Enter', { repeat: true })
    expect(answer).not.toHaveBeenCalled()
    buttons()[1].click()
    expect(answer).toHaveBeenCalledWith(0)
  })
})
