import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import ConnectionsPanel from '../components/settings/ConnectionsPanel.vue'

const AGENTS = [
  { id: 'claude', available: true },
  { id: 'codex', available: true }
]
const TARGET = {
  'google-workspace': 'uvx workspace-mcp --permissions gmail:drafts calendar:full drive:readonly',
  outlook: 'cmd /c npx -y @softeria/ms-365-mcp-server --discovery',
  dropbox: 'https://mcp.dropbox.com/mcp'
}
const server = (name, more = {}) => ({ name, scope: 'user', type: name === 'dropbox' ? 'http' : 'stdio', target: TARGET[name], envKeys: [], headerKeys: [], ...more })

function api(overrides = {}) {
  return {
    mcpList: vi.fn(async () => ({ claude: [], codex: [], others: {} })),
    checkTools: vi.fn(async () => ({ node: true, uvx: true })),
    mcpAdd: vi.fn(async () => ({ ok: true })),
    mcpCopy: vi.fn(async () => ({ ok: true })),
    mcpTest: vi.fn(async () => ({ status: 'auth' })),
    mcpSignInStart: vi.fn(async () => ({ ok: true, id: 's1', page: 'https://accounts.google.com/x', code: null })),
    mcpSignInStatus: vi.fn(async () => ({ state: 'waiting' })),
    mcpSignInActive: vi.fn(async () => []),
    mcpSignInCancel: vi.fn(async () => ({ ok: true })),
    mcpSignInState: vi.fn(async () => ({ signedIn: false, account: null })),
    openExternal: vi.fn(),
    ...overrides
  }
}
const row = (w, id) => w.get(`[data-service="${id}"]`)
async function mountPanel(shellApi) {
  window.shellApi = shellApi
  const w = mount(ConnectionsPanel, { props: { agents: AGENTS, cwd: 'C:\\p' }, global: { provide: { askConfirm: async () => true } } })
  await flushPromises()
  return w
}
const open = async (w, id) => {
  await row(w, id).get('.sl-row').trigger('click')
  await flushPromises()
}

describe("Settings > Connections with a Tessel account", () => {
  let w
  const google = () => row(w, 'google-workspace')
  const account = (over = {}) => ({
    status: vi.fn(async () => ({ signedIn: true, user: { email: 'me@gmail.com' } })),
    googleClient: vi.fn(async () => ({ clientId: 'tessel-id', clientSecret: 'tessel-secret' })),
    ...over
  })
  afterEach(() => {
    if (w) w.unmount()
    w = null
    delete window.shellApi
  })

  it('needs nothing set up: the address is filled in, one press adds the server with Tessel\'s Google app and signs in', async () => {
    const list = { claude: [], codex: [], others: {} }
    const shellApi = api({
      tesselAccount: account(),
      mcpList: vi.fn(async () => list),
      mcpAdd: vi.fn(async (spec) => {
        list[spec.agent].push(server('google-workspace'))
        return { ok: true }
      })
    })
    w = await mountPanel(shellApi)
    await open(w, 'google-workspace')
    expect(google().find('#conn-google-workspace-GOOGLE_OAUTH_CLIENT_ID').exists()).toBe(false)
    expect(google().text()).toContain('Nothing to set up')
    expect(google().text()).toContain('not verified')
    expect(google().get('#conn-google-workspace-email').element.value).toBe('me@gmail.com')
    expect(shellApi.tesselAccount.googleClient).not.toHaveBeenCalled()
    await google().get('.conn-connect').trigger('click')
    await flushPromises()
    expect(shellApi.tesselAccount.googleClient).toHaveBeenCalledTimes(1)
    expect(shellApi.mcpAdd.mock.calls[0][0].env).toBe('GOOGLE_OAUTH_CLIENT_ID=tessel-id\nGOOGLE_OAUTH_CLIENT_SECRET=tessel-secret')
    expect(shellApi.mcpSignInStart).toHaveBeenCalled()
  })

  it.each([
    ['offline', 'could not reach its server'],
    ['failed', 'not available right now'],
    ['signedOut', 'session ended']
  ])('adds nothing when the app cannot be had: %s', async (error, text) => {
    const shellApi = api({ tesselAccount: account({ googleClient: vi.fn(async () => ({ error })) }) })
    w = await mountPanel(shellApi)
    await open(w, 'google-workspace')
    await google().get('.conn-connect').trigger('click')
    await flushPromises()
    expect(google().text()).toContain(text)
    expect(shellApi.mcpAdd).not.toHaveBeenCalled()
  })

  it('still allows your own Google client, and going back', async () => {
    const shellApi = api({ tesselAccount: account() })
    w = await mountPanel(shellApi)
    await open(w, 'google-workspace')
    await google().get('.conn-own-client').trigger('click')
    expect(google().find('#conn-google-workspace-GOOGLE_OAUTH_CLIENT_ID').exists()).toBe(true)
    await google().get('.conn-back-to-account').trigger('click')
    expect(google().find('#conn-google-workspace-GOOGLE_OAUTH_CLIENT_ID').exists()).toBe(false)
  })

  it('signed out: asks for your own client, and points to the account', async () => {
    const shellApi = api({ tesselAccount: account({ status: vi.fn(async () => ({ signedIn: false, user: null })) }) })
    w = await mountPanel(shellApi)
    await open(w, 'google-workspace')
    expect(google().find('#conn-google-workspace-GOOGLE_OAUTH_CLIENT_ID').exists()).toBe(true)
    await google().get('.conn-to-account').trigger('click')
    expect(w.emitted('open-account')).toHaveLength(1)
  })
})

describe('Settings > Connections', () => {
  let w
  beforeEach(() => {
    vi.useRealTimers()
  })
  afterEach(() => {
    if (w) w.unmount()
    w = null
    vi.useRealTimers()
    delete window.shellApi
  })

  it('lists the account services, Gmail first, with nothing added yet and no checks run', async () => {
    const shellApi = api()
    w = await mountPanel(shellApi)
    expect(w.findAll('[data-service]').map((r) => r.attributes('data-service'))).toEqual(['google-workspace', 'outlook', 'dropbox', 'todoist', 'airtable', 'clickup', 'monday'])
    expect(row(w, 'google-workspace').text()).toContain('Gmail')
    expect(w.findAll('.conn-status')).toHaveLength(0)
    expect(shellApi.mcpSignInState).not.toHaveBeenCalled()
  })

  it('Google: asks for the client and the address, adds it to every agent, then opens the sign-in', async () => {
    const list = { claude: [], codex: [], others: {} }
    const shellApi = api({
      mcpList: vi.fn(async () => list),
      mcpAdd: vi.fn(async (spec) => {
        list[spec.agent] = [server(spec.name)]
        return { ok: true }
      })
    })
    w = await mountPanel(shellApi)
    await open(w, 'google-workspace')
    const google = () => row(w, 'google-workspace')

    await google().get('.conn-connect').trigger('click')
    await flushPromises()
    expect(google().get('.conn-error').text()).toBe('Enter Google OAuth client ID.')
    expect(shellApi.mcpAdd).not.toHaveBeenCalled()

    await google().get('#conn-google-workspace-GOOGLE_OAUTH_CLIENT_ID').setValue('id1')
    await google().get('#conn-google-workspace-GOOGLE_OAUTH_CLIENT_SECRET').setValue('s1')
    for (const bad of ['', 'me']) {
      await google().get('#conn-google-workspace-email').setValue(bad)
      await google().get('.conn-connect').trigger('click')
      await flushPromises()
      expect(google().get('.conn-error').text()).toBe('Enter your full address, like you@gmail.com.')
    }
    // Nothing written to any agent before everything is valid.
    expect(shellApi.mcpAdd).not.toHaveBeenCalled()

    await google().get('#conn-google-workspace-email').setValue('me@gmail.com')
    await google().get('.conn-connect').trigger('click')
    await flushPromises()
    expect(shellApi.mcpAdd.mock.calls.map(([s]) => s.agent)).toEqual(['claude', 'codex'])
    expect(shellApi.mcpAdd.mock.calls[0][0].env).toBe('GOOGLE_OAUTH_CLIENT_ID=id1\nGOOGLE_OAUTH_CLIENT_SECRET=s1')
    expect(shellApi.mcpSignInStart).toHaveBeenCalledWith({ agent: 'claude', name: 'google-workspace', scope: 'user', cwd: 'C:\\p', email: 'me@gmail.com' })
    expect(google().get('.conn-session').text()).toContain('A sign-in page opened in your browser')
    expect(google().get('.conn-connect').attributes('disabled')).toBeDefined()
    await google().get('.conn-open-page').trigger('click')
    expect(shellApi.openExternal).toHaveBeenCalledWith('https://accounts.google.com/x')
  })

  it('an agent already has it: no questions but the address, copied to the others, secrets never typed', async () => {
    const list = { claude: [server('google-workspace')], codex: [], others: {} }
    const shellApi = api({
      mcpList: vi.fn(async () => list),
      mcpCopy: vi.fn(async ({ to, name }) => {
        list[to] = [server(name)]
        return { ok: true }
      })
    })
    w = await mountPanel(shellApi)
    await open(w, 'google-workspace')
    const google = row(w, 'google-workspace')
    expect(google.find('#conn-google-workspace-GOOGLE_OAUTH_CLIENT_ID').exists()).toBe(false)
    await google.get('#conn-google-workspace-email').setValue('me@gmail.com')
    await google.get('.conn-connect').trigger('click')
    await flushPromises()
    expect(shellApi.mcpAdd).not.toHaveBeenCalled()
    expect(shellApi.mcpCopy).toHaveBeenCalledWith({ from: 'claude', to: 'codex', name: 'google-workspace', scope: 'user', cwd: 'C:\\p' })
    expect(shellApi.mcpSignInStart).toHaveBeenCalled()
  })

  it.each([
    ['another server under the same name', 'outlook', server('outlook', { target: 'node evil.js' })],
    ["a repository's server, even naming the package", 'outlook', server('outlook', { scope: 'project' })],
    ['a hosted server at another address', 'dropbox', server('dropbox', { target: 'https://evil.example/mcp' })]
  ])('%s: never copied to other agents, never started', async (_what, id, theirs) => {
    const list = { claude: [theirs], codex: [], others: {} }
    const shellApi = api({ mcpList: vi.fn(async () => list) })
    w = await mountPanel(shellApi)
    expect(shellApi.mcpSignInState).not.toHaveBeenCalled()
    await open(w, id)
    await row(w, id).get('.conn-connect').trigger('click')
    await flushPromises()
    expect(row(w, id).get('.conn-error').text()).toContain('A different server already uses this name')
    expect(shellApi.mcpCopy).not.toHaveBeenCalled()
    expect(shellApi.mcpAdd).not.toHaveBeenCalled()
    expect(shellApi.mcpSignInStart).not.toHaveBeenCalled()
  })

  it('Microsoft: shows the code, opens the page in the outside browser, and Connected when the sign-in ends', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const list = { claude: [server('outlook')], codex: [server('outlook')], others: {} }
    const shellApi = api({
      mcpList: vi.fn(async () => list),
      mcpSignInStart: vi.fn(async () => ({ ok: true, id: 's2', page: 'https://www.microsoft.com/link', code: 'C9AKESZZ' })),
      mcpSignInStatus: vi.fn(async () => ({ state: 'done', account: null }))
    })
    w = await mountPanel(shellApi)
    await open(w, 'outlook')
    await row(w, 'outlook').get('.conn-connect').trigger('click')
    await flushPromises()
    expect(row(w, 'outlook').get('.conn-code').text()).toBe('C9AKESZZ')
    expect(shellApi.mcpAdd).not.toHaveBeenCalled()
    await row(w, 'outlook').get('.conn-open-page').trigger('click')
    expect(shellApi.openExternal).toHaveBeenCalledWith('https://www.microsoft.com/link')
    vi.advanceTimersByTime(2600)
    await flushPromises()
    expect(row(w, 'outlook').find('.conn-session').exists()).toBe(false)
    expect(row(w, 'outlook').get('.conn-status').text()).toBe('Connected')
    expect(w.get('.mcp-notice').text()).toContain('Outlook, OneDrive is connected')
  })

  it('Microsoft already signed in: Connected at once, no error', async () => {
    const list = { claude: [server('outlook')], codex: [], others: {} }
    const shellApi = api({
      mcpList: vi.fn(async () => list),
      mcpSignInStart: vi.fn(async () => ({ ok: true, alreadySignedIn: true })),
      mcpCopy: vi.fn(async ({ to, name }) => {
        list[to] = [server(name)]
        return { ok: true }
      })
    })
    w = await mountPanel(shellApi)
    await open(w, 'outlook')
    await row(w, 'outlook').get('.conn-connect').trigger('click')
    await flushPromises()
    expect(row(w, 'outlook').get('.conn-status').text()).toBe('Connected')
    expect(row(w, 'outlook').find('.conn-error').exists()).toBe(false)
  })

  it('Google: shows the account Google really signed in', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const list = { claude: [server('google-workspace')], codex: [server('google-workspace')], others: {} }
    const shellApi = api({ mcpList: vi.fn(async () => list), mcpSignInStatus: vi.fn(async () => ({ state: 'done', account: 'other@gmail.com' })) })
    w = await mountPanel(shellApi)
    await open(w, 'google-workspace')
    await row(w, 'google-workspace').get('#conn-google-workspace-email').setValue('me@gmail.com')
    await row(w, 'google-workspace').get('.conn-connect').trigger('click')
    await flushPromises()
    vi.advanceTimersByTime(2600)
    await flushPromises()
    expect(row(w, 'google-workspace').get('.conn-account').text()).toContain('other@gmail.com')
  })

  it('says why a sign-in failed, ended or was cancelled', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const list = { claude: [server('outlook')], codex: [server('outlook')], others: {} }
    const shellApi = api({
      mcpList: vi.fn(async () => list),
      mcpSignInStart: vi.fn(async () => ({ ok: false, reason: 'noAnswer' }))
    })
    w = await mountPanel(shellApi)
    await open(w, 'outlook')
    const connect = () => row(w, 'outlook').get('.conn-connect').trigger('click')
    await connect()
    await flushPromises()
    expect(row(w, 'outlook').get('.conn-error').text()).toContain('did not answer')

    shellApi.mcpSignInStart.mockResolvedValue({ ok: true, id: 's3', page: 'https://www.microsoft.com/link', code: 'AB12CD34' })
    shellApi.mcpSignInStatus.mockResolvedValue({ state: 'expired' })
    await connect()
    await flushPromises()
    vi.advanceTimersByTime(2600)
    await flushPromises()
    expect(row(w, 'outlook').get('.conn-error').text()).toContain('took too long')

    shellApi.mcpSignInStatus.mockResolvedValue({ state: 'waiting' })
    await connect()
    await flushPromises()
    await row(w, 'outlook').get('.conn-cancel').trigger('click')
    await flushPromises()
    expect(shellApi.mcpSignInCancel).toHaveBeenCalledWith('s3')
    expect(row(w, 'outlook').find('.conn-session').exists()).toBe(false)
  })

  it('checks local sign-ins when the page opens: connected, one that ended, one that cannot be told', async () => {
    const list = { claude: [server('google-workspace'), server('outlook')], codex: [], others: {} }
    const shellApi = api({
      mcpList: vi.fn(async () => list),
      mcpSignInState: vi.fn(async ({ name }) => (name === 'outlook' ? { signedIn: true, account: null } : { signedIn: false, account: 'me@gmail.com' }))
    })
    w = await mountPanel(shellApi)
    await flushPromises()
    expect(row(w, 'outlook').get('.conn-status').text()).toBe('Connected')
    expect(row(w, 'google-workspace').get('.conn-status').text()).toBe('Sign-in needed')
    await open(w, 'google-workspace')
    expect(row(w, 'google-workspace').get('#conn-google-workspace-email').element.value).toBe('me@gmail.com')
    w.unmount()
    shellApi.mcpSignInState.mockResolvedValue({ signedIn: null, account: null, reason: 'noAnswer' })
    w = await mountPanel(shellApi)
    await flushPromises()
    expect(row(w, 'outlook').get('.conn-status').text()).toBe('Could not check')
  })

  it('comes back to a sign-in that went on while the page was closed, without starting another', async () => {
    const list = { claude: [server('outlook')], codex: [server('outlook')], others: {} }
    const shellApi = api({
      mcpList: vi.fn(async () => list),
      mcpSignInActive: vi.fn(async () => [{ id: 's9', name: 'outlook', page: 'https://www.microsoft.com/link', code: 'ZZ11YY22' }])
    })
    w = await mountPanel(shellApi)
    await flushPromises()
    expect(row(w, 'outlook').get('.conn-code').text()).toBe('ZZ11YY22')
    expect(shellApi.mcpSignInStart).not.toHaveBeenCalled()
    expect(shellApi.mcpSignInState).not.toHaveBeenCalledWith(expect.objectContaining({ name: 'outlook' }))
  })

  it('stops asking once the page is closed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const list = { claude: [server('outlook')], codex: [server('outlook')], others: {} }
    const shellApi = api({ mcpList: vi.fn(async () => list), mcpSignInStart: vi.fn(async () => ({ ok: true, id: 's4', page: 'https://www.microsoft.com/link', code: 'AB12CD34' })) })
    w = await mountPanel(shellApi)
    await open(w, 'outlook')
    await row(w, 'outlook').get('.conn-connect').trigger('click')
    await flushPromises()
    w.unmount()
    w = null
    vi.advanceTimersByTime(10000)
    await flushPromises()
    expect(shellApi.mcpSignInStatus).not.toHaveBeenCalled()
    expect(shellApi.mcpSignInCancel).not.toHaveBeenCalled()
  })

  it('a hosted service: added to every agent, each with its own Sign in, never claimed as connected', async () => {
    const list = { claude: [], codex: [], others: {} }
    const shellApi = api({
      mcpList: vi.fn(async () => list),
      mcpAdd: vi.fn(async (spec) => {
        list[spec.agent] = [server(spec.name)]
        return { ok: true }
      }),
      mcpTest: vi.fn(async () => ({ status: 'connected', tools: ['x'] }))
    })
    w = await mountPanel(shellApi)
    await open(w, 'dropbox')
    await row(w, 'dropbox').get('.conn-connect').trigger('click')
    await flushPromises()
    expect(shellApi.mcpAdd.mock.calls.map(([s]) => [s.agent, s.url])).toEqual([
      ['claude', 'https://mcp.dropbox.com/mcp'],
      ['codex', 'https://mcp.dropbox.com/mcp']
    ])
    expect(shellApi.mcpSignInStart).not.toHaveBeenCalled()
    expect(shellApi.mcpTest).not.toHaveBeenCalled()
    expect(row(w, 'dropbox').get('.conn-status').text()).toBe('Added')
    expect(row(w, 'dropbox').findAll('.sl-sub .exit-btn').map((b) => b.text())).toEqual(['Sign in', 'Sign in'])
    expect(row(w, 'dropbox').find('.conn-connect').exists()).toBe(false)
  })

  it('the page is newer than its background code: asks for a restart, adds nothing', async () => {
    const shellApi = api({ mcpList: vi.fn(async () => ({ claude: [server('outlook')], codex: [], others: {} })) })
    delete shellApi.mcpSignInStart
    delete shellApi.mcpSignInState
    delete shellApi.mcpSignInActive
    w = await mountPanel(shellApi)
    await open(w, 'outlook')
    await row(w, 'outlook').get('.conn-connect').trigger('click')
    await flushPromises()
    expect(row(w, 'outlook').get('.conn-error').text()).toContain('Restart Tessel')
    expect(shellApi.mcpCopy).not.toHaveBeenCalled()
  })

  it('says so when the agents do not list it after adding, and shows the whole description', async () => {
    const shellApi = api()
    w = await mountPanel(shellApi)
    await open(w, 'dropbox')
    expect(row(w, 'dropbox').get('.conn-desc').text()).toContain('OpenCode')
    await row(w, 'dropbox').get('.conn-connect').trigger('click')
    await flushPromises()
    expect(row(w, 'dropbox').get('.conn-error').text()).toContain('do not list it')
    expect(row(w, 'dropbox').get('.conn-connect').attributes('disabled')).toBeUndefined()
  })

  it('reports an agent that refused it, and still signs in with the others', async () => {
    const list = { claude: [], codex: [], others: {} }
    const shellApi = api({
      mcpList: vi.fn(async () => list),
      mcpAdd: vi.fn(async (spec) => {
        if (spec.agent === 'codex') return { ok: false, error: 'config locked' }
        list[spec.agent] = [server(spec.name)]
        return { ok: true }
      })
    })
    w = await mountPanel(shellApi)
    await open(w, 'outlook')
    await row(w, 'outlook').get('.conn-connect').trigger('click')
    await flushPromises()
    expect(row(w, 'outlook').get('.conn-error').text()).toBe('Codex: config locked')
    expect(shellApi.mcpSignInStart).toHaveBeenCalled()
  })
})
