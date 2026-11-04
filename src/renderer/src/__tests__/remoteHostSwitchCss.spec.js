import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const css = readFileSync(resolve(__dirname, '../components/remote/remoteHosts.css'), 'utf8')
const form = readFileSync(resolve(__dirname, '../components/remote/RemoteHostForm.vue'), 'utf8')

describe('SSH host form: the switches of Advanced', () => {
  it('the text field rules leave .set-switch alone (a 32px high, bordered box otherwise)', () => {
    expect(form).toMatch(/type="checkbox" class="set-switch"/)
    expect(css).toMatch(/\.rh-field input:not\(\.set-switch\) \{/)
    expect(css).toMatch(/\.rh-field input:not\(\.set-switch\):focus \{/)
    expect(css).not.toMatch(/\.rh-field input(:focus)? \{/)
  })
})
