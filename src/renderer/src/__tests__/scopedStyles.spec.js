// Scoped component styles must stay scoped. In a scoped <style>,
// `:global(body.pane-dragging) .bp-webview` compiles to plain
// `body.pane-dragging` (Vue drops everything after :global()), so BrowserPane's
// "no pointer on the page while dragging" rule put pointer-events: none on the
// whole body: a pane drag found no pane under the pointer and did nothing.
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { parse, compileStyle } from '@vue/compiler-sfc'
import postcss from 'postcss'

const root = join(__dirname, '..')

function vueFiles(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '__tests__') continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...vueFiles(path))
    else if (name.endsWith('.vue')) out.push(path)
  }
  return out
}

// Selectors of a scoped style block that came out without the component's
// scope attribute (rules inside @keyframes are not selectors).
function unscopedSelectors(file) {
  const { descriptor } = parse(readFileSync(file, 'utf8'), { filename: file })
  const id = 'data-v-test'
  const found = []
  for (const block of descriptor.styles) {
    if (!block.scoped || block.lang) continue
    const { code } = compileStyle({ source: block.content, filename: file, id, scoped: true })
    postcss.parse(code).walkRules((rule) => {
      if (rule.parent && rule.parent.type === 'atrule' && /keyframes$/.test(rule.parent.name)) return
      for (const sel of rule.selectors) if (!sel.includes(`[${id}]`)) found.push(sel)
    })
  }
  return found
}

// Compiling the scoped styles of every component is CPU work that a fully
// loaded machine can stretch past the default 5 s; nothing here is timed.
describe('scoped component styles', { timeout: 30_000 }, () => {
  it('BrowserPane keeps its drag rule on the webview, not on the body', () => {
    const file = join(root, 'components', 'BrowserPane.vue')
    const { descriptor } = parse(readFileSync(file, 'utf8'), { filename: file })
    const css = descriptor.styles
      .filter((s) => s.scoped)
      .map((s) => compileStyle({ source: s.content, filename: file, id: 'data-v-test', scoped: true }).code)
      .join('\n')
    const bodyRules = []
    postcss.parse(css).walkRules((rule) => {
      if (rule.selectors.some((sel) => /body\.(pane-dragging|ws-resizing)/.test(sel))) bodyRules.push(rule)
    })
    expect(bodyRules.length).toBeGreaterThan(0)
    for (const rule of bodyRules) {
      for (const sel of rule.selectors) expect(sel).toMatch(/\.bp-webview\[data-v-test\]$/)
    }
  })

  it('no scoped rule escapes its component', () => {
    const offenders = []
    for (const file of vueFiles(root)) {
      for (const sel of unscopedSelectors(file)) offenders.push(`${relative(root, file)}: ${sel}`)
    }
    expect(offenders).toEqual([])
  })
})
