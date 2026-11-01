// @vitest-environment node
// `npm run dev`: packages a copy's code needs, installed when they are missing (scripts/devDeps.mjs).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ensureDeps, staleDeps } from '../../../scripts/devDeps.mjs'

let root
const put = (name, version) => {
  const dir = path.join(root, 'node_modules', name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version }))
}
const lockWith = (packages) => fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': { name: 'tessel' }, ...packages } }))
const quiet = { log: () => {}, warn: () => {} }

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tessel-deps-'))
  fs.mkdirSync(path.join(root, 'node_modules'))
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

describe('what is out of date', () => {
  it('a package absent, or of another version', () => {
    put('old', '1.0.0')
    put('fine', '2.0.0')
    expect(staleDeps(root, { packages: { 'node_modules/gone': { version: '1.0.0' }, 'node_modules/old': { version: '1.1.0' }, 'node_modules/fine': { version: '2.0.0' } } })).toEqual({ missing: ['gone'], different: ['old'] })
  })

  it('names a nested package by its own name', () => {
    expect(staleDeps(root, { packages: { 'node_modules/a/node_modules/b': { version: '1.0.0' } } }).missing).toEqual(['b'])
  })

  it('an optional package, one for another system, or a link may be absent', () => {
    expect(staleDeps(root, { packages: { 'node_modules/opt': { version: '1.0.0', optional: true }, 'node_modules/peer': { version: '1.0.0', peer: true }, 'node_modules/local': { link: true } } })).toEqual({ missing: [], different: [] })
  })
})

describe('at the start', () => {
  it('the case that broke a copy: a package the code now imports is missing, and gets installed', () => {
    lockWith({ 'node_modules/pdfjs-dist': { version: '6.4.299' } })
    const install = vi.fn(() => {
      put('pdfjs-dist', '6.4.299')
      return true
    })
    expect(ensureDeps(root, { install, ...quiet })).toBe('installed')
    expect(install).toHaveBeenCalledTimes(1)
  })

  it('all there: no install, and next time it does not look again', () => {
    put('a', '1.0.0')
    lockWith({ 'node_modules/a': { version: '1.0.0' } })
    const install = vi.fn()
    expect(ensureDeps(root, { install, ...quiet })).toBe('current')
    expect(install).not.toHaveBeenCalled()
    fs.rmSync(path.join(root, 'node_modules', 'a'), { recursive: true })
    expect(ensureDeps(root, { install, ...quiet })).toBe('current')
    expect(install).not.toHaveBeenCalled()
  })

  it('a new lock file is looked at again', () => {
    put('a', '1.0.0')
    lockWith({ 'node_modules/a': { version: '1.0.0' } })
    ensureDeps(root, quiet)
    lockWith({ 'node_modules/a': { version: '2.0.0' } })
    const install = vi.fn(() => {
      put('a', '2.0.0')
      return true
    })
    expect(ensureDeps(root, { install, ...quiet })).toBe('installed')
    expect(install).toHaveBeenCalledTimes(1)
  })

  it('an install that fails or throws: said, not remembered, and it never stops the start', () => {
    lockWith({ 'node_modules/a': { version: '1.0.0' } })
    const warn = vi.fn()
    expect(ensureDeps(root, { install: () => false, log: () => {}, warn })).toBe('failed')
    expect(warn.mock.calls[0][0]).toContain('npm install')
    expect(ensureDeps(root, { install: () => { throw new Error('no npm') }, log: () => {}, warn })).toBe('failed')
    expect(fs.existsSync(path.join(root, 'node_modules', '.tessel-deps'))).toBe(false)
  })

  it('an install that says it worked but left a package out is no success', () => {
    lockWith({ 'node_modules/a': { version: '1.0.0' } })
    expect(ensureDeps(root, { install: () => true, ...quiet })).toBe('failed')
  })

  it('an install that left an old version behind is no success, and is looked at again', () => {
    put('a', '1.0.0')
    lockWith({ 'node_modules/a': { version: '2.0.0' } })
    expect(ensureDeps(root, { install: () => true, ...quiet })).toBe('failed')
    expect(fs.existsSync(path.join(root, 'node_modules', '.tessel-deps'))).toBe(false)
  })

  it('no lock file, or a broken one: nothing to compare with', () => {
    const install = vi.fn()
    expect(ensureDeps(root, { install, ...quiet })).toBe('nothing')
    fs.writeFileSync(path.join(root, 'package-lock.json'), '{ not json')
    expect(ensureDeps(root, { install, ...quiet })).toBe('nothing')
    expect(install).not.toHaveBeenCalled()
  })

  it('no node_modules at all: installs', () => {
    fs.rmSync(path.join(root, 'node_modules'), { recursive: true })
    lockWith({ 'node_modules/a': { version: '1.0.0' } })
    const install = vi.fn(() => {
      put('a', '1.0.0')
      return true
    })
    expect(ensureDeps(root, { install, ...quiet })).toBe('installed')
  })
})
