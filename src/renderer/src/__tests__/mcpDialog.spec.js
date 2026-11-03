import { afterEach, describe, expect, it } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import McpDialog from '../components/McpDialog.vue'
import McpTeamConnections from '../components/mcp/McpTeamConnections.vue'
import { MCP_CATALOG, catalogDocs } from '../mcpCatalog'

const agentsOf = (ids) => ids.map((id) => ({ id, available: true }))
const tabBtn = (w, name) => w.findAll('[role="tab"]').find((b) => b.text().startsWith(name))
const row = (w, name) => w.find(`.sl-item[data-server="${name}"]`)
const openRow = async (w, name) => {
  await row(w, name).get('.sl-row').trigger('click')
  return row(w, name)
}
const sub = (r, agent) => r.find(`.sl-sub[data-agent="${agent}"]`)
const button = (w, text) => w.findAll('button').find((b) => b.text().trim() === text)
const catalogItem = (w, id) => w.find(`.mcpc-item[data-entry="${id}"]`)

describe('MCP servers dialog', () => {
  let previousApi
  let wrapper
  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    window.shellApi = previousApi
  })
  const mountWith = (api, props = {}, provide = {}) => {
    previousApi = window.shellApi
    window.shellApi = { checkTools: async () => ({}), ...api }
    wrapper = mount(McpDialog, { props: { agents: agentsOf(['claude']), ...props }, attachTo: document.body, global: { provide } })
    return wrapper
  }

  it('opens with every agent installed before its server lists arrive (skeleton rows), then shows them', async () => {
    let answer
    const w = mountWith(
      { mcpList: () => new Promise((r) => (answer = r)) },
      { agents: agentsOf(['claude', 'codex', 'gemini', 'qwen', 'copilot', 'opencode', 'cline']) }
    )
    // Drawn while the lists are still being read: must not throw.
    expect(w.findAll('.sl-skeleton').length).toBeGreaterThan(0)
    expect(w.text()).not.toContain('No MCP servers yet')
    answer({ claude: [], codex: [], others: { cline: { servers: [{ name: 'tessel_team', type: 'stdio', target: 'node s.cjs' }] } } })
    await flushPromises()
    expect(w.find('.sl-skeleton').exists()).toBe(false)
    expect(row(w, 'tessel_team').exists()).toBe(true)
  })

  it('a failed check for node and uvx is no unhandled rejection, and flags nothing as missing', async () => {
    const w = mountWith({
      mcpList: async () => ({ claude: [], codex: [] }),
      checkTools: async () => {
        throw new Error('ipc closed')
      }
    })
    await flushPromises()
    await tabBtn(w, 'Catalog').trigger('click')
    await catalogItem(w, 'fetch').get('.mcpc-row').trigger('click')
    expect(w.text()).not.toMatch(/needs uv|needs node/i)
  })

  it('shows one row per server, never one per server and agent, with the icons of the agents that have it', async () => {
    const s = (name, type = 'stdio') => ({ name, scope: 'user', type, target: type === 'stdio' ? `npx ${name}` : `https://${name}/mcp` })
    const w = mountWith(
      {
        mcpList: async () => ({
          claude: [s('context7', 'http'), s('playwright')],
          codex: [s('context7'), s('playwright')],
          others: { gemini: { servers: [s('playwright'), s('memory')] } }
        })
      },
      { agents: agentsOf(['claude', 'codex', 'gemini']) }
    )
    await flushPromises()
    expect(w.findAll('.sl-list > .sl-item').map((r) => r.attributes('data-server'))).toEqual(['context7', 'memory', 'playwright'])
    expect(row(w, 'playwright').findAll('.sl-icons svg').length).toBeGreaterThanOrEqual(3)
    expect(row(w, 'playwright').get('.sl-icons').attributes('aria-label')).toContain('Gemini CLI')
    // Agents disagree on the transport: both tags.
    expect(row(w, 'context7').findAll('.mcpi-transport').map((x) => x.text())).toEqual(['http', 'stdio'])
    expect(w.text()).toContain('3 servers')
    // A filter by agent.
    await w.find('.chip[data-agent="gemini"]').trigger('click')
    expect(w.findAll('.sl-list > .sl-item').map((r) => r.attributes('data-server'))).toEqual(['memory', 'playwright'])
  })

  it("details: one line per agent with its scope, Test and Remove (asks first); the dot shows the last test", async () => {
    const tested = []
    const removed = []
    const w = mountWith(
      {
        mcpList: async () => ({
          claude: [{ name: 'ctx', scope: 'project', type: 'http', target: 'https://ctx/mcp' }],
          codex: [{ name: 'ctx', scope: 'user', type: 'http', target: 'https://ctx/mcp', enabled: false }],
          others: {}
        }),
        mcpTest: async ({ agent }) => {
          tested.push(agent)
          return agent === 'codex' ? { status: 'error', error: 'ECONNREFUSED raw' } : { status: 'connected', tools: ['a', 'b'] }
        },
        mcpRemove: async (spec) => {
          removed.push(spec)
          return { ok: true }
        }
      },
      { agents: agentsOf(['claude', 'codex']) },
      { askConfirm: async () => true }
    )
    await flushPromises()
    expect(row(w, 'ctx').find('.mcpi-dot.none').exists()).toBe(true)
    const r = await openRow(w, 'ctx')
    expect(sub(r, 'claude').text()).toContain('This project (shared)')
    expect(sub(r, 'codex').text()).toContain('Turned off')
    await button(sub(r, 'claude'), 'Test').trigger('click')
    await flushPromises()
    expect(sub(r, 'claude').find('.tag-ok').text()).toBe('Connected · 2 tools')
    expect(row(w, 'ctx').find('.mcpi-dot.ok').exists()).toBe(true)
    // Test for every agent at once; a failure: red dot, the raw error behind Details.
    await button(r.get('.sl-section-head'), 'Test').trigger('click')
    await flushPromises()
    expect(tested).toEqual(['claude', 'claude', 'codex'])
    expect(row(w, 'ctx').find('.mcpi-dot.error').exists()).toBe(true)
    expect(sub(r, 'codex').get('.tag-danger').text()).toBe('Failed')
    expect(sub(r, 'codex').get('details summary').text()).toBe('Details')
    expect(sub(r, 'codex').get('details').text()).toContain('ECONNREFUSED raw')
    // Needs attention: the failing server.
    expect(w.find('.mcpi-attention').text()).toContain('1')
    await sub(r, 'codex').get('.exit-btn.danger').trigger('click')
    await flushPromises()
    expect(removed).toEqual([{ agent: 'codex', name: 'ctx', scope: 'user', cwd: null }])
  })

  it('a remote server the probe cannot enter: "Signs in from the agent" (not "Needs sign-in"), one Sign in on the card that runs each CLI sign-in in turn and tells the rest how, in the card', async () => {
    const s = (scope = 'user') => ({ name: 'cf', scope, type: 'http', target: 'https://mcp.cloudflare.com/mcp' })
    const w = mountWith(
      {
        mcpList: async () => ({
          claude: [s('project')],
          codex: [s()],
          others: { gemini: { servers: [s()] }, opencode: { servers: [s()] }, cursor: { servers: [s()] } }
        }),
        mcpTest: async () => ({ ok: false, status: 'auth', error: 'needs you to sign in' })
      },
      { agents: agentsOf(['claude', 'codex', 'gemini', 'opencode', 'cursor']) }
    )
    await flushPromises()
    const r = await openRow(w, 'cf')
    // Before a test: no Sign in anywhere.
    expect(button(r, 'Sign in')).toBeUndefined()
    await button(r.get('.sl-section-head'), 'Test').trigger('click')
    await flushPromises()
    // The honest tag, with why, and the amber dot; the per-agent lines have no Sign in of their own.
    const tag = sub(r, 'claude').get('.tag-warn')
    expect(tag.text()).toBe('Signs in from the agent')
    expect(tag.attributes('title')).toContain('cannot tell whether the agent has already signed in')
    expect(row(w, 'cf').get('.mcpi-dot').attributes('title')).toBe('Last test: signs in from the agent')
    expect(w.text()).not.toContain('Needs sign-in')
    expect(r.findAll('.sl-sub').every((line) => !button(line, 'Sign in'))).toBe(true)
    // One Sign in on the card: Codex then OpenCode in one pane, the others told how, in the card.
    await r.get('.sl-section-head .mcpi-signin').trigger('click')
    expect(w.emitted('run')).toHaveLength(1)
    expect(w.emitted('run')[0][0]).toEqual({ label: 'Sign in: cf', steps: ['codex mcp login cf', 'opencode mcp auth cf'] })
    const card = r.get('.mcpi-card-message')
    expect(card.text()).toContain('in a Claude Code pane, type /mcp, pick "cf" and choose Authenticate; in a Gemini CLI pane, type /mcp auth cf')
    expect(card.text()).toContain('Cursor CLI sign in from their own pane; Tessel cannot do it for them.')
    // Not in the top callout, which is off-screen from a card.
    expect(w.find('.mcpd-message').exists()).toBe(false)
    // Dismissed by its ×, and gone with the next action on that server.
    await card.get('.mcpi-dismiss').trigger('click')
    expect(r.find('.mcpi-card-message').exists()).toBe(false)
    await r.get('.sl-section-head .mcpi-signin').trigger('click')
    expect(r.find('.mcpi-card-message').exists()).toBe(true)
    await button(sub(r, 'gemini'), 'Test').trigger('click')
    expect(r.find('.mcpi-card-message').exists()).toBe(false)
  })

  it('a local server never gets the card Sign in: its probe runs the command itself', async () => {
    const w = mountWith(
      {
        mcpList: async () => ({ claude: [{ name: 'fs', scope: 'user', type: 'stdio', target: 'npx fs' }], codex: [] }),
        mcpTest: async () => ({ ok: false, status: 'auth', error: 'odd' })
      },
      { agents: agentsOf(['claude']) }
    )
    await flushPromises()
    const r = await openRow(w, 'fs')
    await button(r.get('.sl-section-head'), 'Test').trigger('click')
    await flushPromises()
    expect(r.find('.mcpi-signin').exists()).toBe(false)
  })

  it('"Add to…" is one menu with the installed agents that lack the server', async () => {
    const copies = []
    const w = mountWith(
      {
        mcpList: async () => ({
          claude: [{ name: 'figma', scope: 'user', type: 'http', target: 'https://figma/mcp' }],
          codex: [],
          others: { gemini: { servers: [] }, cursor: { servers: [] }, opencode: { servers: [], error: 'Unexpected token' } }
        }),
        mcpCopy: async (spec) => {
          copies.push(spec)
          return { ok: true }
        }
      },
      // Cursor is not installed, OpenCode's settings can't be read: not offered.
      { agents: [...agentsOf(['claude', 'codex', 'gemini', 'opencode']), { id: 'cursor', available: false }] }
    )
    await flushPromises()
    const r = await openRow(w, 'figma')
    // No "Add to <agent>" button per agent any more.
    expect(r.findAll('button').filter((b) => /^Add to [A-Z]/.test(b.text()))).toEqual([])
    const menuBtn = r.get('[aria-haspopup="menu"]')
    expect(menuBtn.text()).toContain('Add to…')
    await menuBtn.trigger('click')
    const items = r.findAll('[role="menuitem"]')
    expect(items.map((i) => i.text())).toEqual(['Codex', 'Gemini CLI'])
    await items[1].trigger('click')
    await flushPromises()
    expect(copies).toEqual([{ from: 'claude', to: 'gemini', name: 'figma', scope: 'user', cwd: null }])
    expect(r.find('[role="menu"]').exists()).toBe(false)
  })

  it('shows env and header names only, their values masked', async () => {
    const w = mountWith({
      mcpList: async () => ({
        claude: [{ name: 'brave', scope: 'user', type: 'stdio', target: 'npx brave', envKeys: ['BRAVE_API_KEY'] }],
        codex: [],
        others: { gemini: { servers: [{ name: 'brave', scope: 'user', type: 'stdio', target: 'npx brave', envKeys: ['BRAVE_API_KEY', 'REGION'] }] } }
      })
    }, { agents: agentsOf(['claude', 'gemini']) })
    await flushPromises()
    const r = await openRow(w, 'brave')
    const secrets = r.findAll('.mcpi-secret')
    expect(secrets.map((s) => s.get('code').text())).toEqual(['BRAVE_API_KEY', 'REGION'])
    expect(secrets.every((s) => s.get('.mcpi-mask').text() === '••••••')).toBe(true)
  })

  it('Catalog: two panes, the chosen server on the right; Added ✓ on the ones every agent has; several added in one go', async () => {
    const added = []
    const have = { claude: [{ name: 'context7', scope: 'user', type: 'http', target: 'https://mcp.context7.com/mcp' }], codex: [{ name: 'context7', scope: 'user', type: 'http', target: 'x' }] }
    const w = mountWith(
      {
        mcpList: async () => ({ claude: have.claude, codex: have.codex, others: {} }),
        mcpAdd: async (spec) => {
          added.push(`${spec.name}>${spec.agent}`)
          have[spec.agent].push({ name: spec.name, scope: 'user', type: spec.transport, target: 'x' })
          return { ok: true }
        },
        mcpTest: async () => ({ status: 'connected', tools: [] })
      },
      { agents: agentsOf(['claude', 'codex']) }
    )
    await flushPromises()
    await tabBtn(w, 'Catalog').trigger('click')
    expect(catalogItem(w, 'context7').text()).toContain('Added ✓')
    expect(catalogItem(w, 'context7').get('[role="checkbox"]').attributes('disabled')).toBeDefined()
    // Secondary buttons only: the one primary is the bar's Add.
    expect(w.findAll('.exit-btn.primary')).toHaveLength(1)
    await catalogItem(w, 'memory').get('.mcpc-row').trigger('click')
    expect(w.get('.mcpc-detail h3').text()).toBe('Memory')
    expect(w.get('.mcp-addbar-add').text()).toBe('Add Memory')
    await catalogItem(w, 'memory').get('[role="checkbox"]').trigger('click')
    await catalogItem(w, 'sequential-thinking').get('[role="checkbox"]').trigger('click')
    expect(w.get('.mcp-addbar-add').text()).toBe('Add 2 servers')
    // Codex off for this add.
    await w.get('.mcp-addbar .chip[data-agent="codex"]').trigger('click')
    await w.get('.mcp-addbar-add').trigger('click')
    await flushPromises()
    await flushPromises()
    // In the catalog's order, to Claude Code only.
    expect(added).toEqual(['memory>claude', 'sequential-thinking>claude'])
    expect(w.get('.mcpd-message').text()).toContain('Restart running agent panes')
    expect(w.findAll('.mcpc-check[aria-checked="true"]')).toHaveLength(0)
  })

  it('Catalog: a server missing an answer is shown with what it lacks, and nothing is added', async () => {
    const added = []
    const w = mountWith({ mcpList: async () => ({ claude: [], codex: [], others: {} }), mcpAdd: async (s) => (added.push(s), { ok: true }) })
    await flushPromises()
    await tabBtn(w, 'Catalog').trigger('click')
    const brave = MCP_CATALOG.find((e) => e.id === 'brave-search')
    await catalogItem(w, 'memory').get('[role="checkbox"]').trigger('click')
    await catalogItem(w, 'brave-search').get('[role="checkbox"]').trigger('click')
    await catalogItem(w, 'memory').get('.mcpc-row').trigger('click')
    // Nothing flagged before Add.
    expect(w.find('.mcpc-invalid').exists()).toBe(false)
    await w.get('.mcp-addbar-add').trigger('click')
    await flushPromises()
    expect(added).toEqual([])
    expect(w.get('.mcpc-detail h3').text()).toBe(brave.name)
    expect(w.get('.mcpc-invalid').text()).toBe('Required')
    expect(w.get('.mcp-addbar-error').text()).toBe(`${brave.name}: enter ${brave.inputs[0].label}.`)
  })

  it('Catalog: adds to every chosen agent even when one fails; Needs sign-in with Sign in; the raw error behind Details', async () => {
    const have = { claude: [], codex: [], gemini: [] }
    const added = []
    const w = mountWith(
      {
        mcpList: async () => ({ claude: have.claude, codex: have.codex, others: { gemini: { servers: have.gemini } } }),
        mcpAdd: async (spec) => {
          added.push(spec.agent)
          if (spec.agent === 'claude') return { ok: false, error: 'boom' }
          have[spec.agent].push({ name: spec.name, scope: 'user', type: 'http', target: spec.url })
          return { ok: true }
        },
        mcpTest: async ({ agent }) =>
          agent === 'codex' ? { ok: false, status: 'auth', error: 'needs you to sign in' } : { ok: true, status: 'connected', tools: ['a'] }
      },
      { agents: agentsOf(['claude', 'codex', 'gemini']) }
    )
    await flushPromises()
    await tabBtn(w, 'Catalog').trigger('click')
    await catalogItem(w, 'context7').get('.mcpc-row').trigger('click')
    await w.get('.mcp-addbar-add').trigger('click')
    await flushPromises()
    await flushPromises()
    expect(added).toEqual(['claude', 'codex', 'gemini'])
    // Not "Added ✓" while Claude Code lacks it.
    expect(catalogItem(w, 'context7').text()).not.toContain('Added ✓')
    const results = w.findAll('.mcpc-results .sl-sub')
    expect(results.map((r) => r.get('.tag').text())).toEqual(['Failed', 'Needs sign-in', 'Added'])
    expect(results[0].get('details').text()).toContain('boom')
    await button(results[1], 'Sign in').trigger('click')
    expect(w.emitted('run')[0][0].command).toBe('codex mcp login context7')
  })

  it('Catalog: lists the Antigravity CLI servers, one it turned off marked so, and adds to it', async () => {
    const added = []
    const w = mountWith(
      {
        mcpList: async () => ({
          claude: [],
          codex: [],
          others: {
            antigravity: {
              servers: [
                { name: 'tessel_team', scope: 'user', type: 'stdio', target: 'node s.cjs' },
                { name: 'figma', scope: 'user', type: 'http', target: 'https://x/mcp', enabled: false }
              ]
            }
          }
        }),
        mcpAdd: async (spec) => (added.push(spec.agent), { ok: true }),
        mcpTest: async () => ({ ok: true, status: 'connected', tools: [] })
      },
      { agents: agentsOf(['claude', 'antigravity']) }
    )
    await flushPromises()
    expect(row(w, 'figma').text()).toContain('Turned off')
    expect(row(w, 'tessel_team').text()).not.toContain('Turned off')
    const r = await openRow(w, 'tessel_team')
    expect(sub(r, 'antigravity').text()).toContain('Antigravity CLI')
    await tabBtn(w, 'Catalog').trigger('click')
    await catalogItem(w, 'context7').get('.mcpc-row').trigger('click')
    await w.get('.mcp-addbar-add').trigger('click')
    await flushPromises()
    expect(added).toEqual(['claude', 'antigravity'])
  })

  it('Custom: agent chips that wrap, not checkboxes; what is wrong shows once typed or on Add, never before', async () => {
    const added = []
    const w = mountWith({ mcpList: async () => ({ claude: [], codex: [], others: {} }), mcpAdd: async (s) => (added.push(s), { ok: true }) }, {
      agents: agentsOf(['claude', 'codex', 'gemini', 'qwen', 'copilot', 'opencode', 'cline', 'kimi', 'cursor', 'antigravity', 'muse'])
    })
    await flushPromises()
    await tabBtn(w, 'Custom').trigger('click')
    expect(w.find('form input[type="checkbox"]').exists()).toBe(false)
    const chips = w.findAll('.mcp-addbar-chips .chip')
    expect(chips).toHaveLength(11)
    expect(chips.every((c) => c.attributes('aria-pressed') === 'true')).toBe(true)
    // Nothing flagged on the empty form.
    expect(w.find('.mcpf-invalid').exists()).toBe(false)
    const name = w.get('#mcpf-name')
    await name.setValue('my server')
    expect(w.get('.mcpf-invalid').text()).toContain('no spaces')
    await name.setValue('my-server')
    expect(w.find('.mcpf-invalid').exists()).toBe(false)
    // A URL is judged when you leave it, not while you type it.
    await button(w, 'HTTP').trigger('click')
    const url = w.get('#mcpf-url')
    await url.setValue('ftp')
    expect(w.find('.mcpf-invalid').exists()).toBe(false)
    await url.trigger('blur')
    expect(w.get('.mcpf-invalid').text()).toBe('Start with http:// or https://')
    // SSE: the agents without it can't be chosen.
    await button(w, 'SSE').trigger('click')
    expect(w.get('.mcp-addbar .chip[data-agent="codex"]').attributes('disabled')).toBeDefined()
    // Back to a command: an empty one is said only on Add.
    await button(w, 'Command').trigger('click')
    expect(w.find('.mcpf-invalid').exists()).toBe(false)
    await w.get('.mcp-addbar-add').trigger('click')
    expect(w.get('.mcpf-invalid').text()).toBe('Enter the command that starts the server.')
    expect(added).toEqual([])
  })

  it('Custom: variables are masked rows, tested before adding, then added to the chosen agents', async () => {
    const added = []
    const tried = []
    const w = mountWith({
      mcpList: async () => ({ claude: [], codex: [], others: {} }),
      mcpAdd: async (s) => (added.push(s), { ok: true }),
      mcpTestSpec: async (s) => (tried.push(s), { status: 'connected', tools: ['x', 'y'] }),
      mcpTest: async () => ({ status: 'connected', tools: [] })
    }, { agents: agentsOf(['claude', 'codex']) })
    await flushPromises()
    await tabBtn(w, 'Custom').trigger('click')
    await w.get('#mcpf-name').setValue('mine')
    await w.get('#mcpf-command').setValue('npx -y mine-mcp')
    await button(w, 'Add a variable').trigger('click')
    const [key, value] = w.findAll('.mcpkv-row input')
    await key.setValue('API_KEY')
    await value.setValue('s3cret')
    expect(value.attributes('type')).toBe('password')
    await w.get('.mcpkv-row [aria-pressed]').trigger('click')
    expect(w.findAll('.mcpkv-row input')[1].attributes('type')).toBe('text')
    await button(w, 'Test before adding').trigger('click')
    await flushPromises()
    expect(tried[0]).toMatchObject({ transport: 'stdio', commandLine: 'npx -y mine-mcp', env: 'API_KEY=s3cret' })
    expect(w.get('.mcpf-tried').text()).toContain('Connected · 2 tools')
    await w.get('.mcp-addbar .chip[data-agent="codex"]').trigger('click')
    await w.get('.mcp-addbar-add').trigger('click')
    await flushPromises()
    expect(added.map((s) => [s.agent, s.name, s.env, s.scope])).toEqual([['claude', 'mine', 'API_KEY=s3cret', 'user']])
    // Back on Installed, which shows its test.
    expect(tabBtn(w, 'Installed').attributes('aria-selected')).toBe('true')
  })

  it('a failed read shows what went wrong with Retry (raw message behind Details); a failed tool check is harmless', async () => {
    let fail = true
    const w = mountWith({
      checkTools: async () => {
        throw new Error('no tools')
      },
      mcpList: async () => {
        if (fail) throw new Error('EPERM raw')
        return { claude: [{ name: 'ctx', scope: 'user', type: 'http', target: 'https://x' }], codex: [], others: {} }
      }
    })
    await flushPromises()
    expect(w.get('[data-test="panel-error-text"]').text()).toBe('The servers could not be read.')
    expect(w.get('.mcpi-raw').text()).toContain('EPERM raw')
    fail = false
    await w.get('[data-test="panel-retry"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-test="panel-error"]').exists()).toBe(false)
    expect(row(w, 'ctx').exists()).toBe(true)
  })

  it("an agent's unreadable settings: a warning with the raw message behind Details; empty: one sentence and Browse the catalog", async () => {
    const w = mountWith(
      { mcpList: async () => ({ claude: [], codex: [], codexError: 'Codex is not installed.', others: { cursor: { servers: [], error: 'Unexpected token } at 312' } } }) },
      { agents: agentsOf(['claude', 'cursor']) }
    )
    await flushPromises()
    // Codex is not installed here: no warning for it.
    const warns = w.findAll('.mcpi-read-error')
    expect(warns.map((x) => x.attributes('data-agent'))).toEqual(['cursor'])
    expect(warns[0].get('.set-callout-text').text()).not.toContain('Unexpected')
    expect(warns[0].get('details').text()).toContain('Unexpected token')
    expect(w.get('.mcpi-empty').text()).toContain('No MCP servers yet')
    await button(w, 'Browse the catalog').trigger('click')
    expect(tabBtn(w, 'Catalog').attributes('aria-selected')).toBe('true')
  })

  it('as a window, Escape and the backdrop close it; embedded (a Settings page), nothing does; the team connections are in Orchestration', async () => {
    const api = { mcpList: async () => ({ claude: [{ name: 'context7', scope: 'user', type: 'http', target: 'https://x' }], codex: [], others: {} }) }
    const modal = mountWith(api)
    await flushPromises()
    expect(modal.find('.help-head').exists()).toBe(true)
    await modal.get('[role="dialog"]').trigger('keydown', { key: 'Escape' })
    await modal.trigger('pointerdown')
    expect(modal.emitted('close')).toHaveLength(2)
    modal.unmount()
    wrapper = null

    // The old Team connections tab is gone: asked for, it opens Installed.
    const page = mountWith(api, { embedded: true, initialTab: 'connections' })
    await flushPromises()
    for (const sel of ['.help-backdrop', '.help-card', '.help-head', '[role="dialog"]']) expect(page.find(sel).exists(), sel).toBe(false)
    expect(page.find('.mcp-connections').exists()).toBe(false)
    expect(page.findAll('[role="tab"]').map((b) => b.text())).toEqual(['Installed1', 'Catalog', 'Custom'])
    expect(tabBtn(page, 'Installed').attributes('aria-selected')).toBe('true')
    expect(page.text()).toContain('context7')
    await page.get('.mcp-embedded-body').trigger('keydown', { key: 'Escape' })
    await page.trigger('pointerdown')
    expect(page.emitted('close')).toBeUndefined()
    await page.get('.mcp-skills-link').trigger('click')
    expect(page.emitted('skills')).toHaveLength(1)
    await page.get('.mcp-orchestration-link').trigger('click')
    expect(page.emitted('orchestration')).toHaveLength(1)
    // Arrow keys move between the tabs.
    await page.get('[role="tablist"]').trigger('keydown', { key: 'ArrowRight' })
    expect(tabBtn(page, 'Catalog').attributes('aria-selected')).toBe('true')
  })

  it('the team connections stand alone (for Orchestration): each agent\'s hooks, Check again, Set up again', async () => {
    let reads = 0
    let setups = 0
    previousApi = window.shellApi
    window.shellApi = {
      teamHooksStatus: async () => {
        reads++
        return { agents: [{ id: 'claude', hooks: 'installed', lastSignal: { at: Date.now() - 5000 }, inbox: true }, { id: 'codex', hooks: 'installed', approval: 'needs-approval' }] }
      },
      installTeamTools: async () => (setups++, { errors: ['Codex: config locked'] })
    }
    wrapper = mount(McpTeamConnections, { props: { agents: agentsOf(['claude', 'codex', 'gemini']) }, attachTo: document.body })
    await flushPromises()
    expect(reads).toBe(1)
    const names = wrapper.findAll('.mcp-server .mcp-name').map((n) => n.text())
    expect(names).toEqual(['Claude Code', 'Codex', 'No hooks yet'])
    expect(wrapper.text()).toContain('Needs your approval')
    await button(wrapper, 'Check again').trigger('click')
    await button(wrapper, 'Set up again').trigger('click')
    await flushPromises()
    expect([reads, setups]).toEqual([3, 1])
    expect(wrapper.get('.mcp-error').text()).toBe('Codex: config locked')
  })

  it('account services go to Connections: no client fields here and nothing to add', async () => {
    const w = mountWith({ mcpList: async () => ({ claude: [], codex: [], others: {} }) }, { agents: agentsOf(['claude', 'codex']) })
    await flushPromises()
    await tabBtn(w, 'Catalog').trigger('click')
    await catalogItem(w, 'google-workspace').get('.mcpc-row').trigger('click')
    expect(w.find('.mcpc-input').exists()).toBe(false)
    expect(catalogItem(w, 'google-workspace').get('[role="checkbox"]').attributes('disabled')).toBeDefined()
    expect(w.get('.mcp-addbar-add').attributes('disabled')).toBeDefined()
    await w.get('.mcpc-connections').trigger('click')
    expect(w.emitted('connections')).toHaveLength(1)
    // The others keep their fields.
    await catalogItem(w, 'brave-search').get('.mcpc-row').trigger('click')
    expect(w.find('.mcpc-input').exists()).toBe(true)
    expect(w.find('.mcpc-connections').exists()).toBe(false)
  })

  it("links each catalog server to its docs: its own, else its npm or PyPI package", () => {
    const byId = (id) => MCP_CATALOG.find((e) => e.id === id)
    expect(catalogDocs(byId('context7'))).toBe('https://github.com/upstash/context7')
    expect(catalogDocs(byId('playwright'))).toBe('https://www.npmjs.com/package/@playwright/mcp')
    expect(catalogDocs(byId('memory'))).toBe('https://www.npmjs.com/package/@modelcontextprotocol/server-memory')
    expect(catalogDocs(byId('fetch'))).toBe('https://pypi.org/project/mcp-server-fetch/')
    expect(MCP_CATALOG.every((e) => catalogDocs(e))).toBe(true)
  })
})
