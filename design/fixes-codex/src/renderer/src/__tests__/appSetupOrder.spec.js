// App.vue hands many refs to panes through provide(). A `const` declared after
// that call is not initialised yet when provide() runs, which crashes the app
// on startup ("Cannot access 'x' before initialization"). Catch it here.
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import { join } from 'path'

const src = fs.readFileSync(join(process.cwd(), 'src', 'renderer', 'src', 'App.vue'), 'utf8')

describe('App.vue setup order', () => {
  it('declares every provided value before provide()', () => {
    const at = src.indexOf("provide('panelCtx', {")
    expect(at).toBeGreaterThan(0)
    const body = src.slice(at, src.indexOf('})', at))
    const names = [...body.matchAll(/^\s+(\w+),?\s*$/gm)].map((m) => m[1])
    expect(names.length).toBeGreaterThan(5)
    const late = names.filter((n) => {
      const decl = new RegExp(`^(const|let) ${n}\\b`, 'm').exec(src)
      return decl && decl.index > at
    })
    expect(late).toEqual([])
  })
})
