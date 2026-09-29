// Small DOM queries for the lot 4 specs (tool rows, diffs, tasks): the
// reference tests used @testing-library/react's screen.getByText & co.
// Text matching is on an element's own full text (trimmed), like getByText.

function matches(text, matcher) {
  const value = (text ?? '').replace(/\s+/g, ' ').trim()
  return matcher instanceof RegExp ? matcher.test(value) : value === matcher
}

/** Elements whose text content matches and that have no child element matching too. */
export function allByText(root, matcher, selector = '*') {
  const found = [...root.querySelectorAll(selector)].filter((element) => matches(element.textContent, matcher))
  return found.filter((element) => !found.some((other) => other !== element && element.contains(other)))
}

export function queryByText(root, matcher, selector) {
  return allByText(root, matcher, selector)[0] ?? null
}

export function byText(root, matcher, selector) {
  const element = queryByText(root, matcher, selector)
  if (!element) throw new Error(`no element with text ${matcher}`)
  return element
}

export function byTitle(root, title) {
  const element = [...root.querySelectorAll('[title]')].find((node) => node.getAttribute('title') === title)
  if (!element) throw new Error(`no element titled ${title}`)
  return element
}

export function queryByTitle(root, title) {
  return [...root.querySelectorAll('[title]')].find((node) => node.getAttribute('title') === title) ?? null
}

/** The lucide name of an svg ("check" for lucide-check), skipping the "-icon" alias class. */
export function lucideName(svg) {
  const classes = (svg?.getAttribute('class') ?? '').split(/\s+/)
  const name = classes.find((name) => name.startsWith('lucide-') && !name.endsWith('-icon'))
  return name ? name.slice('lucide-'.length) : null
}

/** The first glyph of every button: the run header, then each tool line. */
export function leadingGlyphs(root) {
  return [...root.querySelectorAll('button')].map((button) => lucideName(button.querySelector('svg')))
}

/** A button by its aria-label or text. */
export function buttonNamed(root, matcher) {
  const button = [...root.querySelectorAll('button')].find(
    (node) => matches(node.getAttribute('aria-label') ?? '', matcher) || matches(node.textContent, matcher)
  )
  if (!button) throw new Error(`no button named ${matcher}`)
  return button
}

export function clickEvent(target) {
  target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
}
