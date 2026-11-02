// @vitest-environment node
// tessel_apps: Microsoft, GitHub, Dropbox, Notion, Linear, Atlassian, Sentry, Vercel and Stripe, each
// against a fake of the service: the request each tool sends, where it goes, what a hostile id does,
// what a card says, which are asked each time, and a renewal and a refused token for every provider.
// No real service is ever asked.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { createAllTools, createTesselApps, SERVICE_LABELS } from '../tesselApps'
import { AppError, createCall, fileText } from '../tesselApps/shared'
import { headerJson } from '../tesselApps/dropbox'

const safeStorage = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => 'dpapi',
  encryptString: (s) => Buffer.from(`sealed:${s}`),
  decryptString: (b) => b.toString().replace(/^sealed:/, '')
}
const answer = (body, status = 200) => ({ status, ok: status < 400, body })
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const SITE_A = '11111111-2222-3333-4444-555555555555'
const SITE_B = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

let dir
let server
let calls
let asked
let respond
let apps

function make() {
  return createTesselApps({
    dir,
    safeStorage,
    scheme: 'tessel-dev',
    accountUrl: 'https://tesselcode.com',
    openExternal: async () => {},
    signedRequest: async (path, init) => {
      calls.push({ path, body: JSON.parse(init.body) })
      return server(path, JSON.parse(init.body))
    },
    fetchFn: async (url, init) => {
      asked.push({ url: String(url), init })
      return respond(String(url), init)
    }
  })
}
async function connect(service, extra = {}) {
  calls.length = 0
  server = async (path) => (path === '/api/connect/start' ? answer({ url: `https://tesselcode.com/connect/${service}?flow=abc` }) : answer({ service, access_token: 'ACCESS-SECRET', refresh_token: 'REFRESH-SECRET', grant: 'GRANT', expires_in: 3600, account: 'Someone at Acme', ...extra }))
  await apps.connections.connect(service)
  const state = calls.find((c) => c.path === '/api/connect/start').body.state
  await apps.connections.handleLink(`tessel-dev://connect?state=${state}&pickup=the-pickup-secret`)
}
const onlyHosts = (hosts) => asked.forEach((a) => expect(hosts).toContain(new URL(a.url).host))
const lastUrl = () => new URL(asked.at(-1).url)
const lastBody = () => JSON.parse(asked.at(-1).init.body)

beforeEach(() => {
  dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-apps-more-'))
  calls = []
  asked = []
  server = async () => answer({})
  respond = async () => {
    throw new Error('unexpected call')
  }
  apps = make()
})
afterEach(() => {
  apps.connections.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

// Every provider: which of its tools answers, on what, with what.
const PROVIDERS = {
  microsoft: { host: 'graph.microsoft.com', probe: ['outlook_calendar_list', {}], ok: { value: [{ id: 'c1', name: 'Main', isDefaultCalendar: true }] }, says: 'c1: Main (main)' },
  github: { host: 'api.github.com', probe: ['github_list_repos', {}], ok: [{ full_name: 'acme/tools' }], says: 'acme/tools' },
  dropbox: { host: 'api.dropboxapi.com', probe: ['dropbox_search', { query: 'plan' }], ok: { matches: [{ metadata: { metadata: { '.tag': 'file', id: 'id:1', name: 'plan.txt' } } }] }, says: 'id: id:1' },
  notion: { host: 'api.notion.com', probe: ['notion_search', { query: 'plan' }], ok: { results: [{ object: 'page', id: 'p1', properties: { Name: { type: 'title', title: [{ plain_text: 'Plan' }] } } }] }, says: 'Plan' },
  linear: { host: 'api.linear.app', probe: ['linear_list_teams', {}], ok: { data: { teams: { nodes: [{ id: 't1', key: 'ENG', name: 'Engineering' }] } } }, says: 't1: ENG Engineering' },
  atlassian: { host: 'api.atlassian.com', probe: ['jira_search', { jql: 'project = ABC' }], ok: [{ id: SITE_A, name: 'Acme', url: 'https://acme.atlassian.net', scopes: ['read:jira-work', 'write:jira-work'] }], says: 'No issue found' },
  sentry: { host: 'sentry.io', probe: ['sentry_list_projects', {}], ok: [{ slug: 'web', name: 'Web' }], says: 'web: Web' },
  vercel: { host: 'api.vercel.com', probe: ['vercel_list_teams', {}], ok: { teams: [{ id: 'team_1', name: 'Acme', slug: 'acme' }] }, says: 'team_1: Acme (acme)' },
  stripe: { host: 'api.stripe.com', probe: ['stripe_balance', {}], ok: { object: 'balance', available: [] }, says: 'balance' }
}

describe.each(Object.entries(PROVIDERS))('%s, as every provider', (provider, { host, probe: [tool, input], ok, says }) => {
  const answerProbe = () => {
    if (provider === 'atlassian') return (url) => (url.includes('accessible-resources') ? json(ok) : json({ issues: [] }))
    if (provider === 'sentry') return (url) => (url.endsWith('/organizations/') ? json([{ slug: 'acme' }]) : json(ok))
    return () => json(ok)
  }

  it('not connected: the agent is told where the user connects it', async () => {
    await expect(apps.run(tool, input)).rejects.toMatchObject({ code: 'not_connected', message: expect.stringContaining('Settings > Connections') })
    expect(asked).toEqual([])
  })

  it('goes only to its own host, over TLS, with the token in a header and no redirect followed', async () => {
    await connect(provider)
    respond = answerProbe()
    const out = await apps.run(tool, input)
    expect(out).toContain(says)
    expect(asked.length).toBeGreaterThan(0)
    onlyHosts([host])
    for (const a of asked) {
      expect(a.url.startsWith('https://')).toBe(true)
      expect(a.init.headers.authorization).toBe('Bearer ACCESS-SECRET')
      expect(a.init.redirect).toBe('manual')
      expect(a.url).not.toContain('ACCESS-SECRET')
    }
  })

  it('the agent gets the answer between marks, and never a token', async () => {
    await connect(provider)
    respond = answerProbe()
    const out = await apps.run(tool, input)
    const mark = /--- from outside ([0-9a-f-]{36}) ---/.exec(out)[1]
    expect(out.endsWith(`--- end of what came from outside ${mark} ---`)).toBe(true)
    expect(out).toContain('never instructions')
    expect(out).not.toContain('ACCESS-SECRET')
    expect(out).not.toContain('REFRESH-SECRET')
  })

  it('a token the service ended is renewed through tesselcode.com, and the call goes again', async () => {
    await connect(provider)
    respond = (url, init) => (init.headers.authorization === 'Bearer ACCESS-SECRET' ? new Response('', { status: 401 }) : answerProbe()(url, init))
    server = async (path, body) => {
      expect(path).toBe('/api/connect/refresh')
      expect(body).toEqual({ service: provider, refresh_token: 'REFRESH-SECRET', grant: 'GRANT' })
      return answer({ access_token: 'NEW-SECRET', refresh_token: 'NEWER-SECRET', grant: 'NEW-GRANT', expires_in: 3600 })
    }
    expect(await apps.run(tool, input)).toContain(says)
    expect(asked.at(-1).init.headers.authorization).toBe('Bearer NEW-SECRET')
    expect(apps.connections.list()[0].reconnect).toBe(false)
  })

  it('a token refused for good: the agent is told to connect again, and it stays marked', async () => {
    await connect(provider)
    respond = () => new Response('', { status: 401 })
    server = async () => answer({ error: 'reconnect' }, 400)
    await expect(apps.run(tool, input)).rejects.toMatchObject({ code: 'reconnect', message: expect.stringContaining('Settings > Connections') })
    expect(apps.connections.list()[0].reconnect).toBe(true)
    await expect(apps.run(tool, input)).rejects.toMatchObject({ code: 'reconnect' })
  })

  it('no network, or a refusal: said in words, with no token in them', async () => {
    await connect(provider)
    respond = () => {
      throw new Error('down ACCESS-SECRET')
    }
    const offline = await apps.run(tool, input).catch((e) => e)
    expect(offline.code).toBe('offline')
    expect(offline.message).not.toContain('SECRET')
    respond = () => new Response('', { status: 500 })
    await expect(apps.run(tool, input)).rejects.toMatchObject({ code: 'failed' })
  })

  it('an account that is not a mail address is one like any other', async () => {
    await connect(provider, { account: 'Acme Notes (1a2b3c4d)' })
    expect(apps.connections.list()[0]).toMatchObject({ account: 'acme notes (1a2b3c4d)', label: 'Acme Notes (1a2b3c4d)' })
    respond = answerProbe()
    expect(await apps.run(tool, { ...input, account: 'ACME notes (1a2b3c4d)' })).toContain(says)
    await expect(apps.run(tool, { ...input, account: 'someone else' })).rejects.toMatchObject({ code: 'unknown_account' })
  })
})

describe('an account\'s name', () => {
  it('stays on one line, with nothing that hides or turns text around, and bounded', async () => {
    await connect('notion', { account: `  Acme\u202e\n\n  Notes\u200b ${'x'.repeat(400)}` })
    const [c] = apps.connections.list()
    expect(c.label.startsWith('Acme Notes x')).toBe(true)
    expect(c.label.length).toBe(320)
    expect(c.account).toBe(c.label.toLowerCase())
  })

  it('with nothing left of it, nothing is kept', async () => {
    await connect('notion', { account: '\u202e  \n' })
    expect(apps.connections.view()).toMatchObject({ connections: [], error: 'failed' })
  })
})

describe('the tool table', () => {
  const tools = createAllTools({ connections: {} })
  const names = Object.keys(tools)

  it('every tool has a service with a name and a provider, and no name inherited counts', () => {
    for (const name of names) {
      const spec = apps.tool(name)
      expect(spec.label, name).toBe(SERVICE_LABELS[tools[name].service])
      expect(spec.provider, name).toBeTruthy()
    }
    expect(apps.tool('constructor')).toBeNull()
    expect(apps.tool('toString')).toBeNull()
  })

  it('nothing that sends mail, deploys, moves money or deletes a repository exists at all', () => {
    expect(names.filter((n) => /send|(^|_)deploy(_|$)|merge|refund|payout_|transfer|charge_|delete_repo|repo_delete|push|workflow/.test(n))).toEqual([])
    const deletes = names.filter((n) => /delete|remove/.test(n))
    expect(deletes.sort()).toEqual(['calendar_delete_event', 'outlook_calendar_delete_event'])
  })

  it('Stripe, Sentry, Vercel and Dropbox only read', () => {
    for (const name of names) if (/^(stripe|sentry|vercel|dropbox)_/.test(name)) expect(tools[name].writes, name).toBeFalsy()
  })

  it('every write has a card, and these are the writes', () => {
    const writes = names.filter((n) => tools[n].writes)
    for (const n of writes) expect(tools[n].describe, n).toBeTypeOf('function')
    expect(writes.filter((n) => !/^(gmail|calendar)_/.test(n)).sort()).toEqual(
      ['outlook_mail_create_draft', 'outlook_calendar_create_event', 'outlook_calendar_update_event', 'outlook_calendar_delete_event', 'github_create_issue', 'github_comment', 'notion_create_page', 'linear_create_issue', 'linear_comment', 'jira_create', 'jira_comment'].sort()
    )
  })

  it('anything someone else can read, anything shared, and any delete is asked each time', () => {
    for (const n of ['github_create_issue', 'github_comment', 'notion_create_page', 'linear_create_issue', 'linear_comment', 'jira_create', 'jira_comment', 'outlook_calendar_update_event', 'outlook_calendar_delete_event']) expect(apps.tool(n).eachTime({}), n).toBe(true)
    // Only for the person, until it is sent or put somewhere others see.
    expect(apps.tool('outlook_mail_create_draft').eachTime({})).toBe(false)
    expect(apps.tool('outlook_calendar_create_event').eachTime({})).toBe(false)
    expect(apps.tool('outlook_calendar_create_event').eachTime({ calendar: 'someone-elses' })).toBe(true)
    for (const n of names.filter((x) => !tools[x].writes)) expect(apps.tool(n).eachTime({}), n).toBe(false)
  })
})

describe('the one way a token leaves', () => {
  const connections = { access: async () => ({ token: 'T', refreshed: async () => 'T2' }) }
  const callOf = (fetchFn) => createCall({ connections, provider: 'x', name: 'X', hosts: ['api.x.test'], fetchFn })

  it('refuses any other host, plain http, and a look-alike, before asking for a token', async () => {
    let touched = false
    const call = callOf(async () => {
      touched = true
      return json({})
    })
    for (const url of ['https://evil.test/a', 'http://api.x.test/a', 'https://api.x.test.evil.test/a', 'https://api.x.test@evil.test/a', 'https://evil.test/https://api.x.test/']) await expect(call(undefined, url)).rejects.toBeInstanceOf(AppError)
    expect(touched).toBe(false)
  })

  it('a redirect on a call is a failure: nothing goes on to where it points', async () => {
    const urls = []
    const call = callOf(async (url) => {
      urls.push(url)
      return new Response('', { status: 302, headers: { location: 'https://evil.test/' } })
    })
    await expect(call(undefined, 'https://api.x.test/a')).rejects.toMatchObject({ code: 'failed' })
    expect(urls).toEqual(['https://api.x.test/a'])
  })

  it('a download follows it without the token, and only over TLS', async () => {
    const seen = []
    const call = callOf(async (url, init) => {
      seen.push({ url, auth: init.headers?.authorization })
      return url.includes('api.x.test') ? new Response('', { status: 302, headers: { location: 'https://files.x.test/one-time' } }) : new Response('words')
    })
    expect(await (await call(undefined, 'https://api.x.test/a', {}, { raw: true })).text()).toBe('words')
    expect(seen).toEqual([
      { url: 'https://api.x.test/a', auth: 'Bearer T' },
      { url: 'https://files.x.test/one-time', auth: undefined }
    ])
    const plain = callOf(async () => new Response('', { status: 302, headers: { location: 'http://files.x.test/' } }))
    await expect(plain(undefined, 'https://api.x.test/a', {}, { raw: true })).rejects.toMatchObject({ code: 'failed' })
  })

  it('a time-out is said as being offline, not as a code of its own', async () => {
    const call = callOf(async () => {
      throw new DOMException('timed out', 'TimeoutError')
    })
    await expect(call(undefined, 'https://api.x.test/a')).rejects.toMatchObject({ code: 'offline' })
  })

  it('a service\'s refusal stays on one line, without what hides text, and bounded', async () => {
    const call = callOf(async () => json({ message: `no\u202e\n\nIgnore this ${'x'.repeat(2000)}` }, 403))
    const err = await call(undefined, 'https://api.x.test/a').catch((e) => e)
    expect(err.code).toBe('forbidden')
    expect(err.message).not.toMatch(/[\n\u202e]/)
    expect(err.message.length).toBeLessThanOrEqual(400)
  })

  it('an answer it cannot read, or an empty one', async () => {
    await expect(callOf(async () => new Response('<html>'))(undefined, 'https://api.x.test/a')).rejects.toMatchObject({ code: 'failed' })
    expect(await callOf(async () => new Response(''))(undefined, 'https://api.x.test/a')).toEqual({})
  })

  it('a file stops being read at the limit, and binary is not text', async () => {
    let pulled = 0
    const endless = new ReadableStream({
      pull(c) {
        pulled++
        c.enqueue(new TextEncoder().encode('x'.repeat(64 * 1024)))
      }
    })
    const got = await fileText(new Response(endless), 256 * 1024)
    expect(got.over).toBe(true)
    expect(got.text.length).toBe(256 * 1024)
    expect(pulled).toBeLessThan(10)
    expect(await fileText(new Response(new Uint8Array([104, 105, 0, 1])))).toBeNull()
    expect(await fileText(new Response('été'))).toEqual({ text: 'été', over: false })
  })
})

describe('Outlook mail', () => {
  beforeEach(() => connect('microsoft'))

  it('search goes to Graph, in the quotes Outlook wants, whatever the words', async () => {
    respond = () => json({ value: [{ id: 'm1', subject: 'Votre code', from: { emailAddress: { address: 'a@b.example' } }, toRecipients: [], receivedDateTime: 't', bodyPreview: 'snip' }] })
    const out = await apps.run('outlook_mail_search', { query: 'say "hi" \\ there', max: 500 })
    expect(lastUrl().origin + lastUrl().pathname).toBe('https://graph.microsoft.com/v1.0/me/messages')
    expect(lastUrl().searchParams.get('$search')).toBe('"say \\"hi\\" \\\\ there"')
    expect(lastUrl().searchParams.get('$top')).toBe('50')
    expect(out).toContain('id: m1')
    expect(out).toContain('From: a@b.example')
    expect(out).toContain('Subject: Votre code')
  })

  it('with no words, the latest', async () => {
    respond = () => json({ value: [] })
    expect(await apps.run('outlook_mail_search', {})).toContain('No message found.')
    expect(lastUrl().searchParams.get('$orderby')).toBe('receivedDateTime desc')
    expect(lastUrl().searchParams.has('$search')).toBe(false)
  })

  it('reads in text, an HTML mail too, and lists attachments', async () => {
    respond = () => json({ id: 'm1', subject: 'S', from: { emailAddress: { address: 'a@b.example' } }, body: { contentType: 'html', content: '<p>Code: <b>123</b></p><script>x()</script>' }, attachments: [{ name: 'f.pdf', contentType: 'application/pdf', size: 9 }] })
    const out = await apps.run('outlook_mail_read', { id: 'm1' })
    expect(asked[0].init.headers.prefer).toBe('outlook.body-content-type="text"')
    expect(out).toContain('Code: 123')
    expect(out).not.toContain('x()')
    expect(out).toContain('f.pdf (application/pdf, 9 bytes)')
  })

  it('an id stays one segment, and cannot mean the folder above', async () => {
    respond = () => json({ id: 'm', body: {} })
    await apps.run('outlook_mail_read', { id: '../../users/boss/messages' })
    expect(asked[0].url).toContain('/me/messages/..%2F..%2Fusers%2Fboss%2Fmessages?')
    onlyHosts(['graph.microsoft.com'])
    asked.length = 0
    for (const id of ['.', '..']) await expect(apps.run('outlook_mail_read', { id })).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(asked).toEqual([])
  })

  it('a draft is saved in Drafts, never sent', async () => {
    respond = () => json({ id: 'd1' }, 201)
    const out = await apps.run('outlook_mail_create_draft', { to: 'Ana <ana@b.example>; c@d.example', cc: 'e@f.example', subject: 'Été', body: 'Allô' })
    expect(asked).toHaveLength(1)
    expect(lastUrl().pathname).toBe('/v1.0/me/messages')
    expect(asked[0].init.method).toBe('POST')
    expect(lastBody()).toEqual({ subject: 'Été', body: { contentType: 'text', content: 'Allô' }, toRecipients: [{ emailAddress: { address: 'ana@b.example' } }, { emailAddress: { address: 'c@d.example' } }], ccRecipients: [{ emailAddress: { address: 'e@f.example' } }] })
    expect(out).toContain('not sent')
    expect(asked[0].url).not.toMatch(/send/i)
  })

  it('what is not an address is refused, not sent on', async () => {
    await expect(apps.run('outlook_mail_create_draft', { to: 'x@y.example Bcc: evil@y.example' })).rejects.toMatchObject({ code: 'invalid_argument' })
    await expect(apps.run('outlook_mail_create_draft', {})).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(asked).toEqual([])
  })

  it('a draft\'s card says who and what', async () => {
    expect(await apps.tool('outlook_mail_create_draft').describe({ to: 'a@b.example', cc: 'c@d.example', subject: 'Hi' })).toBe('To: a@b.example\nCc: c@d.example\nSubject: Hi')
  })
})

describe('Outlook Calendar', () => {
  beforeEach(() => connect('microsoft'))
  const card = async (tool, input) => (await apps.tool(tool).describe({ account: 'someone at acme', ...input })).split('\n')
  const event = (attendees = []) => ({ id: 'e1', subject: 'Review', start: { dateTime: '2026-11-03T10:00:00' }, attendees })

  it('lists from now for 30 days by default, on the main calendar or a named one', async () => {
    respond = () => json({ value: [{ id: 'e1', subject: 'Dentiste', start: { dateTime: 'a', timeZone: 'UTC' }, end: { dateTime: 'b', timeZone: 'UTC' }, location: { displayName: 'Room' }, attendees: [{ emailAddress: { address: 'x@y.example' } }] }] })
    const out = await apps.run('outlook_calendar_events', {})
    expect(lastUrl().pathname).toBe('/v1.0/me/calendarView')
    const from = Date.parse(lastUrl().searchParams.get('startDateTime'))
    expect(Date.parse(lastUrl().searchParams.get('endDateTime')) - from).toBe(30 * 24 * 3600 * 1000)
    expect(out).toContain('Dentiste')
    expect(out).toContain('With: x@y.example')
    await apps.run('outlook_calendar_events', { calendar: 'c/1' })
    expect(asked.at(-1).url).toContain('/me/calendars/c%2F1/calendarView?')
    await expect(apps.run('outlook_calendar_events', { from: 'soon' })).rejects.toMatchObject({ code: 'invalid_argument' })
  })

  it('creates with a time and a zone apart, and a day alone is a day-long event', async () => {
    respond = () => json({ id: 'e', webLink: 'https://outlook.example/e' }, 201)
    await apps.run('outlook_calendar_create_event', { summary: 'Congé', start: '2026-12-24', end: '2026-12-26', timeZone: 'America/Toronto', description: 'd', location: 'l' })
    expect(lastBody()).toEqual({ subject: 'Congé', body: { contentType: 'text', content: 'd' }, location: { displayName: 'l' }, start: { dateTime: '2026-12-24T00:00:00', timeZone: 'America/Toronto' }, end: { dateTime: '2026-12-26T00:00:00', timeZone: 'America/Toronto' }, isAllDay: true })
    await apps.run('outlook_calendar_create_event', { summary: 'x', start: '2026-12-24T10:00:00-05:00', end: '2026-12-24T11:00:00', timeZone: 'America/Toronto' })
    expect(lastBody().start).toEqual({ dateTime: '2026-12-24T15:00:00', timeZone: 'UTC' })
    expect(lastBody().end).toEqual({ dateTime: '2026-12-24T11:00:00', timeZone: 'America/Toronto' })
    await expect(apps.run('outlook_calendar_create_event', { summary: 'x' })).rejects.toMatchObject({ code: 'invalid_argument' })
  })

  it('an event with guests is not made: Outlook would mail them', async () => {
    for (const attendees of [['a@b.example'], []]) {
      const err = await apps.run('outlook_calendar_create_event', { summary: 'x', start: '2026-12-24', end: '2026-12-25', attendees }).catch((e) => e)
      expect(err.code).toBe('invalid_argument')
      expect(err.message).toContain('no tool that sends mail')
      await expect(apps.run('outlook_calendar_update_event', { id: 'e1', attendees })).rejects.toMatchObject({ code: 'invalid_argument' })
    }
    expect(asked).toEqual([])
  })

  it('an event that has guests is left alone, changed or deleted: Outlook would mail them', async () => {
    respond = (_url, init) => (init.method ? new Response(null, { status: 204 }) : json(event([{ emailAddress: { address: 'a@b.example' } }])))
    await expect(apps.run('outlook_calendar_update_event', { id: 'e1', summary: 'New' })).rejects.toMatchObject({ code: 'has_guests' })
    await expect(apps.run('outlook_calendar_delete_event', { id: 'e1' })).rejects.toMatchObject({ code: 'has_guests', message: expect.stringContaining('no tool that sends mail') })
    expect(asked.filter((a) => a.init.method)).toEqual([])
  })

  it('without guests it changes or deletes, by id', async () => {
    respond = (_url, init) => (init.method === 'DELETE' ? new Response(null, { status: 204 }) : json(event()))
    expect(await apps.run('outlook_calendar_update_event', { id: 'e/1', summary: 'New' })).toContain('Event changed')
    expect(asked.at(-1).init.method).toBe('PATCH')
    expect(asked.at(-1).url).toContain('/me/events/e%2F1')
    expect(await apps.run('outlook_calendar_delete_event', { id: 'e/1', calendar: 'c1' })).toContain('Event deleted.')
    expect(asked.at(-1).init.method).toBe('DELETE')
    expect(asked.at(-1).url).toContain('/me/calendars/c1/events/e%2F1')
  })

  it('a card names the event, read for the person, and another calendar', async () => {
    respond = () => json({ ...event([{ emailAddress: { address: 'a@b.example' } }]), type: 'seriesMaster' })
    expect((await card('outlook_calendar_delete_event', { id: 'e1', calendar: 'theirs' }))).toEqual(['Delete the event: Review, 2026-11-03T10:00:00, 1 guests, repeating event', 'Calendar: theirs'])
    const changed = await card('outlook_calendar_update_event', { id: 'e1', location: 'Elsewhere', description: 'd'.repeat(300) })
    expect(changed[0]).toContain('Event: Review')
    expect(changed).toContain('Where: Elsewhere')
    expect(changed.at(-1)).toContain('[100 more characters]')
    respond = () => new Response('', { status: 500 })
    expect((await card('outlook_calendar_delete_event', { id: 'e1' }))[0]).toBe('Delete the event: e1 (could not be read)')
    expect(await card('outlook_calendar_create_event', { summary: 'x', calendar: 'theirs' })).toEqual(['Calendar: theirs', 'Title: x'])
  })
})

describe('OneDrive', () => {
  beforeEach(() => connect('microsoft'))

  it('search keeps quotes and slashes inside the words', async () => {
    respond = () => json({ value: [{ id: 'f1', name: 'Plan', size: 3, file: { mimeType: 'text/plain' }, lastModifiedDateTime: 't', webUrl: 'https://x' }] })
    const out = await apps.run('onedrive_search', { query: "l'été/../x" })
    expect(asked[0].url).toContain("/me/drive/root/search(q='l''%C3%A9t%C3%A9%2F..%2Fx')?")
    expect(out).toContain('id: f1')
  })

  it('reads a text file through the one-time address, which never gets the token', async () => {
    respond = (url) => {
      if (url.endsWith('/content')) return new Response('', { status: 302, headers: { location: 'https://public.dm.files.example/one-time' } })
      if (url.startsWith('https://public.dm')) return new Response('the words')
      return json({ id: 'f', name: 'T.txt', size: 9, file: { mimeType: 'text/plain' } })
    }
    expect(await apps.run('onedrive_read', { id: 'f!1' })).toContain('the words')
    expect(asked[1].url).toContain('/me/drive/items/f!1/content')
    expect(asked[2].url).toBe('https://public.dm.files.example/one-time')
    expect(asked[2].init.headers).toBeUndefined()
  })

  it('says when it cannot, without fetching it', async () => {
    const files = { folder: { name: 'F', folder: {} }, pdf: { name: 'P', file: { mimeType: 'application/pdf' } }, big: { name: 'B', size: 99999999, file: { mimeType: 'text/plain' } } }
    respond = (url) => json(files[/items\/([a-z]+)/.exec(url)[1]])
    expect(await apps.run('onedrive_read', { id: 'folder' })).toContain('is a folder')
    expect(await apps.run('onedrive_read', { id: 'pdf' })).toContain('is not text')
    expect(await apps.run('onedrive_read', { id: 'big' })).toContain('too big')
    expect(asked.filter((a) => a.url.includes('/content'))).toEqual([])
    await expect(apps.run('onedrive_read', { id: '..' })).rejects.toMatchObject({ code: 'invalid_argument' })
  })
})

describe('GitHub', () => {
  beforeEach(() => connect('github'))
  const card = async (tool, input) => (await apps.tool(tool).describe({ account: 'someone at acme', ...input })).split('\n')

  it('sends what GitHub asks of every call', async () => {
    respond = () => json([])
    await apps.run('github_list_repos', {})
    expect(asked[0].init.headers).toMatchObject({ 'user-agent': 'Tessel', accept: 'application/vnd.github+json' })
  })

  it('search says issues or pull requests, as a GitHub App must', async () => {
    respond = () => json({ items: [{ number: 7, state: 'open', title: 'Bug', user: { login: 'ana' }, updated_at: 't', repository_url: 'https://api.github.com/repos/acme/tools' }] })
    expect(await apps.run('github_search', { query: 'crash repo:acme/tools' })).toContain('acme/tools#7 [open] Bug')
    expect(lastUrl().pathname).toBe('/search/issues')
    expect(lastUrl().searchParams.get('q')).toBe('crash repo:acme/tools is:issue')
    await apps.run('github_search', { query: 'crash', kind: 'prs' })
    expect(lastUrl().searchParams.get('q')).toBe('crash is:pr')
    await apps.run('github_search', { query: 'is:pr crash' })
    expect(lastUrl().searchParams.get('q')).toBe('is:pr crash')
    await apps.run('github_search', { query: 'x', kind: 'repos' })
    expect(lastUrl().pathname).toBe('/search/repositories')
    await apps.run('github_search', { query: 'x', kind: 'code' })
    expect(lastUrl().pathname).toBe('/search/code')
    await expect(apps.run('github_search', { query: 'x', kind: 'users' })).rejects.toMatchObject({ code: 'invalid_argument' })
  })

  it('reads an issue with its comments, and a pull request with its files', async () => {
    respond = (url) => {
      if (url.includes('/comments')) return json([{ user: { login: 'bo' }, created_at: 't', body: 'A comment' }])
      if (url.includes('/files')) return json([{ status: 'modified', filename: 'a.js', additions: 1, deletions: 2, patch: '@@ x' }])
      return json({ number: 7, state: 'open', title: 'T', user: { login: 'ana' }, updated_at: 't', body: 'Words', head: { label: 'a:b' }, base: { label: 'a:main' } })
    }
    const issue = await apps.run('github_read_issue', { repo: 'acme/tools', number: 7 })
    expect(asked[0].url).toBe('https://api.github.com/repos/acme/tools/issues/7')
    expect(issue).toContain('Words')
    expect(issue).toContain('A comment')
    const pr = await apps.run('github_read_pr', { repo: 'acme/tools', number: '7' })
    expect(pr).toContain('modified a.js (+1 -2)')
    expect(pr).toContain('From a:b into a:main')
  })

  it('reads a file, lists a folder, and says when it cannot', async () => {
    respond = () => json({ type: 'file', path: 'src/a.js', encoding: 'base64', content: Buffer.from('let a').toString('base64') })
    expect(await apps.run('github_read_file', { repo: 'acme/tools', path: 'src/a b.js', ref: 'dev' })).toContain('let a')
    expect(lastUrl().pathname).toBe('/repos/acme/tools/contents/src/a%20b.js')
    expect(lastUrl().searchParams.get('ref')).toBe('dev')
    respond = () => json([{ type: 'dir', path: 'src' }, { type: 'file', path: 'b.txt' }])
    expect(await apps.run('github_read_file', { repo: 'acme/tools' })).toContain('src/\nb.txt')
    respond = () => json({ type: 'file', path: 'big', encoding: 'none', size: 9e7 })
    expect(await apps.run('github_read_file', { repo: 'acme/tools', path: 'big' })).toContain('too big')
    respond = () => json({ type: 'file', path: 'b', encoding: 'base64', content: Buffer.from([0, 1, 2]).toString('base64') })
    expect(await apps.run('github_read_file', { repo: 'acme/tools', path: 'b' })).toContain('not text')
  })

  it('a hostile repo, path or number goes nowhere', async () => {
    respond = () => json({})
    for (const input of [{ repo: '../../user' }, { repo: '../x' }, { repo: 'a/..' }, { repo: 'a' }, { repo: 'a/b/c' }, { repo: 'https://evil.test/x' }]) await expect(apps.run('github_read_repo', input)).rejects.toMatchObject({ code: 'invalid_argument' })
    for (const path of ['../../../user', 'a/../../b', '..']) await expect(apps.run('github_read_file', { repo: 'a/b', path })).rejects.toMatchObject({ code: 'invalid_argument' })
    for (const number of ['1/../../x', '-1', '0', 'x', 1.5]) await expect(apps.run('github_read_issue', { repo: 'a/b', number })).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(asked).toEqual([])
    await apps.run('github_read_repo', { repo: 'a b/c%2Fd' })
    expect(asked[0].url).toBe('https://api.github.com/repos/a%20b/c%252Fd')
  })

  it('a private repository it cannot see says what to do', async () => {
    respond = () => json({ message: 'Not Found' }, 404)
    await expect(apps.run('github_read_repo', { repo: 'acme/secret' })).rejects.toMatchObject({ code: 'not_found', message: expect.stringContaining('install Tessel\'s GitHub app') })
  })

  it('creates an issue and a comment, and nothing else', async () => {
    respond = () => json({ number: 8, html_url: 'https://github.com/acme/tools/issues/8' }, 201)
    expect(await apps.run('github_create_issue', { repo: 'acme/tools', title: 'T', body: 'B' })).toContain('#8')
    expect(asked[0].url).toBe('https://api.github.com/repos/acme/tools/issues')
    expect(lastBody()).toEqual({ title: 'T', body: 'B' })
    await apps.run('github_comment', { repo: 'acme/tools', number: 8, body: 'C' })
    expect(asked[1].url).toBe('https://api.github.com/repos/acme/tools/issues/8/comments')
    await expect(apps.run('github_create_issue', { repo: 'acme/tools' })).rejects.toMatchObject({ code: 'invalid_argument' })
    await expect(apps.run('github_comment', { repo: 'acme/tools', number: 8 })).rejects.toMatchObject({ code: 'invalid_argument' })
  })

  it('a card says who can read it, and names the issue, read for the person', async () => {
    respond = () => json({ private: false })
    expect(await card('github_create_issue', { repo: 'acme/tools', title: 'T', body: 'B' })).toEqual(['Repository: acme/tools (public: anyone can read this)', 'Title: T', 'Text: B'])
    respond = (url) => json(url.includes('/issues/') ? { number: 8, title: 'The bug' } : { private: true })
    expect(await card('github_comment', { repo: 'acme/tools', number: 8, body: 'C'.repeat(300) })).toEqual(['Repository: acme/tools (private: whoever has access can read this)', 'Comment on: #8: The bug', `Text: ${'C'.repeat(200)} [100 more characters]`])
    respond = () => new Response('', { status: 500 })
    expect((await card('github_create_issue', { repo: 'acme/tools', title: 'T' }))[0]).toBe('Repository: acme/tools (could not be read)')
    // A hostile repo: the card shows what was asked, and the call refuses it.
    expect((await card('github_create_issue', { repo: '../../user', title: 'T' }))[0]).toContain('could not be read')
  })
})

describe('Dropbox', () => {
  beforeEach(() => connect('dropbox'))

  it('searches, and a file\'s id stays in the body, never the address', async () => {
    respond = () => json({ matches: [] })
    expect(await apps.run('dropbox_search', { query: 'plan', max: 900 })).toContain('No file found.')
    expect(asked[0].url).toBe('https://api.dropboxapi.com/2/files/search_v2')
    expect(lastBody()).toEqual({ query: 'plan', options: { max_results: 100 } })
    await expect(apps.run('dropbox_search', {})).rejects.toMatchObject({ code: 'invalid_argument' })
  })

  it('reads through the content host, with its argument safe for a header', async () => {
    respond = (url) => (url.includes('get_metadata') ? json({ '.tag': 'file', name: 'é.txt', path_display: '/é.txt', size: 5 }) : new Response('words'))
    expect(await apps.run('dropbox_read', { id: '/été\r\nX-Evil: 1.txt' })).toContain('words')
    expect(asked[1].url).toBe('https://content.dropboxapi.com/2/files/download')
    const arg = asked[1].init.headers['dropbox-api-arg']
    expect(arg).toBe('{"path":"/\\u00e9t\\u00e9\\r\\nX-Evil: 1.txt"}')
    expect(arg).toMatch(/^[\x20-\x7e]+$/)
    expect(JSON.parse(arg)).toEqual({ path: '/été\r\nX-Evil: 1.txt' })
    expect(headerJson({ path: 'a\u007fb' })).toBe('{"path":"a\\u007fb"}')
    onlyHosts(['api.dropboxapi.com', 'content.dropboxapi.com'])
  })

  it('only an id or a path, and says when it cannot read it', async () => {
    for (const id of ['https://evil.test/x', '../x', 'x']) await expect(apps.run('dropbox_read', { id })).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(asked).toEqual([])
    respond = () => json({ '.tag': 'folder', name: 'F' })
    expect(await apps.run('dropbox_read', { id: 'id:1' })).toContain('is a folder')
    respond = () => json({ '.tag': 'file', name: 'B', size: 9e8 })
    expect(await apps.run('dropbox_read', { id: 'id:1' })).toContain('too big')
    respond = (url) => (url.includes('get_metadata') ? json({ '.tag': 'file', name: 'P', size: 3 }) : new Response(new Uint8Array([1, 0, 2])))
    expect(await apps.run('dropbox_read', { id: 'id:1' })).toContain('not text')
  })

  it('its refusals come through in words', async () => {
    respond = () => json({ error_summary: 'path/not_found/..', error: { '.tag': 'path' } }, 409)
    await expect(apps.run('dropbox_read', { id: 'id:1' })).rejects.toMatchObject({ message: 'path/not_found/..' })
  })
})

describe('Notion', () => {
  beforeEach(() => connect('notion'))

  it('says which version of Notion it speaks', async () => {
    respond = () => json({ results: [] })
    expect(await apps.run('notion_search', {})).toContain('The user chooses which pages')
    expect(asked[0].init.headers['notion-version']).toBe('2026-03-11')
    expect(asked[0].url).toBe('https://api.notion.com/v1/search')
  })

  it('reads a page as text, a bounded number of times', async () => {
    let rounds = 0
    respond = (url) => {
      if (url.includes('/pages/')) return json({ url: 'https://notion.example/p', properties: { Name: { type: 'title', title: [{ plain_text: 'Plan' }] } } })
      rounds++
      return json({ has_more: true, next_cursor: `c${rounds}`, results: [{ id: 'b', type: 'heading_2', heading_2: { rich_text: [{ plain_text: 'Title' }] } }, { id: 'b2', type: 'paragraph', has_children: true, paragraph: { rich_text: [{ plain_text: 'Words' }] } }, { id: 'b3', type: 'child_page', child_page: { title: 'Below' } }, { id: 'b4', type: 'image', image: {} }] })
    }
    const out = await apps.run('notion_read_page', { id: 'p1' })
    expect(out).toContain('Plan')
    expect(out).toContain('## Title')
    expect(out).toContain('Words [has more inside: read id b2]')
    expect(out).toContain('[page: Below, id b3]')
    expect(out).toContain('[image, id b4]')
    expect(out).toContain('[the rest of the page is cut]')
    expect(rounds).toBe(5)
    expect(asked.at(-1).url).toContain('start_cursor=c4')
  })

  it('a hostile id stays in one segment, and a block with no page of its own is still read', async () => {
    respond = (url) => (url.includes('/pages/') ? new Response('', { status: 404 }) : json({ results: [] }))
    await apps.run('notion_read_page', { id: '../../users/me' })
    expect(asked[0].url).toBe('https://api.notion.com/v1/pages/..%2F..%2Fusers%2Fme')
    onlyHosts(['api.notion.com'])
    await expect(apps.run('notion_read_page', { id: '..' })).rejects.toMatchObject({ code: 'invalid_argument' })
  })

  it('creates a page, its parent only in the body, its words cut to what Notion takes', async () => {
    respond = () => json({ id: 'n1', url: 'https://notion.example/n1' })
    await apps.run('notion_create_page', { parent: '../evil', title: 'T', content: `one\n${'x'.repeat(2500)}` })
    expect(asked[0].url).toBe('https://api.notion.com/v1/pages')
    const body = lastBody()
    expect(body.parent).toEqual({ page_id: '../evil' })
    expect(body.properties.title.title[0].text.content).toBe('T')
    expect(body.children.map((b) => b.paragraph.rich_text[0].text.content.length)).toEqual([3, 2000, 500])
    await expect(apps.run('notion_create_page', { parent: 'p', title: 'T', content: 'x\n'.repeat(200) })).rejects.toMatchObject({ code: 'invalid_argument' })
    await expect(apps.run('notion_create_page', { parent: 'p' })).rejects.toMatchObject({ code: 'invalid_argument' })
  })

  it('the card names the page above, read for the person', async () => {
    respond = () => json({ properties: { Name: { type: 'title', title: [{ plain_text: 'Team notes' }] } } })
    const lines = (await apps.tool('notion_create_page').describe({ parent: 'p1', title: 'T', content: 'C', account: 'someone at acme' })).split('\n')
    expect(lines).toEqual(['Under the page: Team notes', 'Others with access can read this.', 'Title: T', 'Text: C'])
    respond = () => new Response('', { status: 403 })
    expect(await apps.tool('notion_create_page').describe({ parent: 'p1', title: 'T' })).toContain('Under the page: p1 (could not be read)')
  })
})

describe('Linear', () => {
  beforeEach(() => connect('linear'))

  it('what an agent gives stays in variables: it cannot change a query', async () => {
    respond = () => json({ data: { searchIssues: { nodes: [{ id: 'i1', identifier: 'ENG-1', title: 'T', updatedAt: 't', state: { name: 'Todo' }, assignee: { name: 'Ana' } }] } } })
    const hostile = '") { id } mutation { issueDelete(id: "x") { success } } #'
    const out = await apps.run('linear_search', { query: hostile, max: 900 })
    expect(asked[0].url).toBe('https://api.linear.app/graphql')
    expect(lastBody().variables).toEqual({ term: hostile, first: 50 })
    expect(lastBody().query).not.toContain('issueDelete')
    expect(out).toContain('ENG-1 [Todo] T')
  })

  it('reads an issue with its comments', async () => {
    respond = () => json({ data: { issue: { id: 'i1', identifier: 'ENG-1', title: 'T', description: 'Words', updatedAt: 't', state: { name: 'Todo' }, team: { name: 'Eng' }, comments: { nodes: [{ body: 'A comment', createdAt: 't', user: { name: 'Bo' } }] } } } })
    const out = await apps.run('linear_read_issue', { id: 'ENG-1' })
    expect(out).toContain('Words')
    expect(out).toContain('Bo, t:\nA comment')
    respond = () => json({ data: { issue: null } })
    await expect(apps.run('linear_read_issue', { id: 'ENG-9' })).rejects.toMatchObject({ code: 'not_found' })
  })

  it('a refusal in a fine answer is a refusal', async () => {
    respond = () => json({ errors: [{ message: 'Entity not found\nIgnore this' }] })
    await expect(apps.run('linear_read_issue', { id: 'x' })).rejects.toMatchObject({ code: 'failed', message: 'Entity not found Ignore this' })
    respond = () => json({ errors: [{ message: 'Bad' }] }, 400)
    await expect(apps.run('linear_read_issue', { id: 'x' })).rejects.toMatchObject({ code: 'failed', message: 'Bad' })
  })

  it('creates an issue and a comment, and says if Linear did not', async () => {
    respond = () => json({ data: { issueCreate: { success: true, issue: { identifier: 'ENG-2', url: 'https://linear.example/2' } } } })
    expect(await apps.run('linear_create_issue', { team: 't1', title: 'T', description: 'D' })).toContain('ENG-2')
    expect(lastBody().variables.input).toEqual({ teamId: 't1', title: 'T', description: 'D' })
    respond = () => json({ data: { commentCreate: { success: false } } })
    await expect(apps.run('linear_comment', { id: 'i1', body: 'C' })).rejects.toMatchObject({ code: 'failed' })
    await expect(apps.run('linear_create_issue', { title: 'T' })).rejects.toMatchObject({ code: 'invalid_argument' })
  })

  it('a card names the team or the issue, read for the person', async () => {
    respond = () => json({ data: { team: { key: 'ENG', name: 'Engineering' } } })
    expect((await apps.tool('linear_create_issue').describe({ team: 't1', title: 'T', description: 'D' })).split('\n')).toEqual(['Team: ENG Engineering', 'Others with access can read this.', 'Title: T', 'Text: D'])
    respond = () => json({ data: { issue: { identifier: 'ENG-1', title: 'The bug' } } })
    expect((await apps.tool('linear_comment').describe({ id: 'i1', body: 'C' })).split('\n')).toEqual(['Comment on: ENG-1: The bug', 'Others with access can read this.', 'Text: C'])
    respond = () => json({ data: { issue: null } })
    expect(await apps.tool('linear_comment').describe({ id: 'i1', body: 'C' })).toContain('i1 (could not be read)')
  })
})

describe('Atlassian', () => {
  beforeEach(() => connect('atlassian'))
  const site = (id, name, scopes = ['read:jira-work', 'write:jira-work', 'search:confluence', 'read:page:confluence']) => ({ id, name, url: `https://${name.toLowerCase()}.atlassian.net`, scopes })
  const sites = (list, rest = () => json({ issues: [] })) => (url, init) => (url.includes('accessible-resources') ? json(list) : rest(url, init))

  it('the site comes only from Atlassian\'s own list, and every call stays on one host', async () => {
    respond = sites([site(SITE_A, 'Acme')])
    await apps.run('jira_search', { jql: 'project = ABC', max: 900 })
    expect(asked[0].url).toBe('https://api.atlassian.com/oauth/token/accessible-resources')
    expect(lastUrl().pathname).toBe(`/ex/jira/${SITE_A}/rest/api/2/search/jql`)
    expect(lastUrl().searchParams.get('jql')).toBe('project = ABC')
    expect(lastUrl().searchParams.get('maxResults')).toBe('50')
    onlyHosts(['api.atlassian.com'])
  })

  it('an agent cannot name a host, or a site the person did not allow', async () => {
    respond = sites([site(SITE_A, 'Acme')])
    for (const named of ['evil.test', 'https://evil.test', SITE_B, `../${SITE_A}`, 'acme.atlassian.net.evil.test']) {
      asked.length = 0
      await expect(apps.run('jira_search', { jql: 'x', site: named })).rejects.toMatchObject({ code: 'unknown_site' })
      expect(asked.map((a) => a.url)).toEqual(['https://api.atlassian.com/oauth/token/accessible-resources'])
    }
  })

  it('a site is named by its name or its address, and several must be told apart', async () => {
    respond = sites([site(SITE_A, 'Acme'), site(SITE_B, 'Other')])
    await expect(apps.run('jira_search', { jql: 'x' })).rejects.toMatchObject({ code: 'which_site', message: expect.stringContaining('"Other"') })
    await apps.run('jira_search', { jql: 'x', site: 'OTHER' })
    expect(lastUrl().pathname).toContain(SITE_B)
    await apps.run('jira_search', { jql: 'x', site: 'acme.atlassian.net' })
    expect(lastUrl().pathname).toContain(SITE_A)
  })

  it('what is not an id in the service\'s answer is not used, nor a site for the other product', async () => {
    respond = sites([{ id: '../../evil', name: 'Bad', url: 'https://evil.test', scopes: ['read:jira-work'] }, { id: `${SITE_A}/x`, name: 'Bad2', url: 'https://evil.test', scopes: ['read:jira-work'] }])
    await expect(apps.run('jira_search', { jql: 'x' })).rejects.toMatchObject({ code: 'not_found', message: expect.stringContaining('Settings > Connections') })
    respond = sites([site(SITE_A, 'Acme', ['read:jira-work'])])
    await expect(apps.run('confluence_read', { id: '1' })).rejects.toMatchObject({ code: 'not_found' })
  })

  it('a key is a key: nothing else reaches an address', async () => {
    respond = sites([site(SITE_A, 'Acme')], () => json({}))
    for (const key of ['../../myself', 'ABC-1/../../x', 'ABC', '..']) await expect(apps.run('jira_read', { key })).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(asked.every((a) => a.url.includes('accessible-resources'))).toBe(true)
  })

  it('reads an issue, and creates one and a comment', async () => {
    const issue = { key: 'ABC-1', fields: { summary: 'S', description: 'Words', status: { name: 'Open' }, issuetype: { name: 'Bug' }, project: { key: 'ABC' }, updated: 't', labels: ['x'], reporter: { displayName: 'Ana' }, comment: { comments: [{ author: { displayName: 'Bo' }, created: 't', body: 'A comment' }] } } }
    respond = sites([site(SITE_A, 'Acme')], () => json(issue))
    const out = await apps.run('jira_read', { key: 'ABC-1' })
    expect(lastUrl().pathname).toBe(`/ex/jira/${SITE_A}/rest/api/2/issue/ABC-1`)
    expect(out).toContain('ABC-1 [Open] S')
    expect(out).toContain('Words')
    expect(out).toContain('Bo, t:\nA comment')
    respond = sites([site(SITE_A, 'Acme')], () => json({ key: 'ABC-2' }, 201))
    expect(await apps.run('jira_create', { project: 'ABC', summary: 'S', description: 'D' })).toContain('ABC-2')
    expect(lastBody()).toEqual({ fields: { project: { key: 'ABC' }, issuetype: { name: 'Task' }, summary: 'S', description: 'D' } })
    await apps.run('jira_comment', { key: 'ABC-1', body: 'C' })
    expect(lastUrl().pathname).toBe(`/ex/jira/${SITE_A}/rest/api/2/issue/ABC-1/comment`)
    expect(lastBody()).toEqual({ body: 'C' })
    await expect(apps.run('jira_create', { project: 'ABC' })).rejects.toMatchObject({ code: 'invalid_argument' })
  })

  it('Jira\'s refusals come through in words', async () => {
    respond = sites([site(SITE_A, 'Acme')], () => json({ errorMessages: ['No project could be found.'], errors: {} }, 400))
    await expect(apps.run('jira_create', { project: 'NOPE', summary: 'S' })).rejects.toMatchObject({ message: 'No project could be found.' })
    respond = sites([site(SITE_A, 'Acme')], () => json({ errorMessages: [], errors: { summary: 'Summary is required.' } }, 400))
    await expect(apps.run('jira_create', { project: 'ABC', summary: 'S' })).rejects.toMatchObject({ message: 'Summary is required.' })
  })

  it('a card names the site, as Atlassian does, and the issue', async () => {
    respond = sites([site(SITE_A, 'Acme')], () => json({ key: 'ABC-1', fields: { summary: 'The bug' } }))
    expect((await apps.tool('jira_create').describe({ project: 'ABC', summary: 'S', description: 'D' })).split('\n')).toEqual(['Site: Acme (acme.atlassian.net)', 'Others with access can read this.', 'Project: ABC', 'Type: Task', 'Title: S', 'Text: D'])
    expect((await apps.tool('jira_comment').describe({ key: 'ABC-1', body: 'C' })).split('\n')).toEqual(['Site: Acme (acme.atlassian.net)', 'Comment on: ABC-1: The bug', 'Others with access can read this.', 'Text: C'])
    expect(await apps.tool('jira_create').describe({ project: 'ABC', summary: 'S', site: 'evil.test' })).toContain('Site: evil.test (could not be read)')
    expect(await apps.tool('jira_comment').describe({ key: '../x', body: 'C' })).toContain('../x (could not be read)')
  })

  it('Confluence: plain words or its own language, and a page as text', async () => {
    respond = sites([site(SITE_A, 'Acme')], () => json({ results: [{ title: 'Plan', lastModified: 't', excerpt: '<b>Words</b>', content: { id: '42' } }] }))
    const out = await apps.run('confluence_search', { query: 'l"été\\' })
    expect(lastUrl().pathname).toBe(`/ex/confluence/${SITE_A}/wiki/rest/api/search`)
    expect(lastUrl().searchParams.get('cql')).toBe('text ~ "l\\"été\\\\"')
    expect(out).toContain('id: 42')
    expect(out).toContain('Words')
    await apps.run('confluence_search', { query: 'space = X', raw: true })
    expect(lastUrl().searchParams.get('cql')).toBe('space = X')
    respond = sites([site(SITE_A, 'Acme')], () => json({ title: 'Plan', body: { storage: { value: '<p>Some <b>words</b></p><script>x()</script>' } } }))
    const page = await apps.run('confluence_read', { id: '42' })
    expect(lastUrl().pathname).toBe(`/ex/confluence/${SITE_A}/wiki/api/v2/pages/42`)
    expect(lastUrl().searchParams.get('body-format')).toBe('storage')
    expect(page).toContain('Some words')
    expect(page).not.toContain('x()')
    await apps.run('confluence_read', { id: '../../../evil' })
    expect(asked.at(-1).url).toContain('/pages/..%2F..%2F..%2Fevil?')
    await expect(apps.run('confluence_read', { id: '..' })).rejects.toMatchObject({ code: 'invalid_argument' })
  })
})

describe('Sentry', () => {
  beforeEach(() => connect('sentry'))
  const withOrg = (rest) => (url) => (url.endsWith('/organizations/') ? json([{ slug: 'acme' }]) : rest(url))

  it('the organization comes from Sentry unless one is named, and only ever goes in a path', async () => {
    respond = withOrg(() => json([{ id: '1', shortId: 'WEB-1', title: 'Boom', level: 'error', status: 'unresolved', count: '3', userCount: 2, lastSeen: 't', project: { slug: 'web' } }]))
    const out = await apps.run('sentry_issues', { query: 'is:unresolved', period: '14d', project: 'web', max: 900 })
    expect(lastUrl().origin + lastUrl().pathname).toBe('https://sentry.io/api/0/organizations/acme/issues/')
    expect(lastUrl().searchParams.get('limit')).toBe('100')
    expect(lastUrl().searchParams.get('statsPeriod')).toBe('14d')
    expect(out).toContain('[error, unresolved] Boom')
    await apps.run('sentry_issues', { organization: 'acme' })
    expect(lastUrl().pathname).toBe('/api/0/organizations/acme/issues/')
  })

  it('an organization that Sentry did not name goes nowhere, however it is written', async () => {
    respond = withOrg(() => json([]))
    for (const organization of ['../../evil', '..', 'other', 'https://evil.test']) {
      asked.length = 0
      await expect(apps.run('sentry_issues', { organization })).rejects.toMatchObject({ code: 'unknown_organization', message: expect.stringContaining('acme') })
      expect(asked.map((a) => a.url)).toEqual(['https://sentry.io/api/0/organizations/'])
    }
  })

  it('several organizations must be told apart, and none is said', async () => {
    respond = () => json([{ slug: 'one' }, { slug: 'two' }])
    await expect(apps.run('sentry_issues', {})).rejects.toMatchObject({ code: 'which_organization', message: expect.stringContaining('one, two') })
    respond = () => json([])
    await expect(apps.run('sentry_issues', {})).rejects.toMatchObject({ code: 'not_found' })
  })

  it('reads an issue, its events, and an event with its stack', async () => {
    respond = withOrg(() => json({ id: '1', title: 'Boom' }))
    expect(await apps.run('sentry_read_issue', { id: '1' })).toContain('Boom')
    expect(asked.at(-1).url).toBe('https://sentry.io/api/0/organizations/acme/issues/1/')
    respond = withOrg(() => json([{ eventID: 'ev1', title: 'Boom', dateCreated: 't' }]))
    expect(await apps.run('sentry_issue_events', { id: '1' })).toContain('id: ev1')
    respond = withOrg(() => json({ eventID: 'ev1', title: 'Boom', culprit: 'app.js', tags: [{ key: 'env', value: 'prod' }], entries: [{ type: 'exception', data: { values: [{ type: 'TypeError', value: 'x is null', stacktrace: { frames: [{ filename: 'a.js', lineNo: 3, function: 'f' }] } }] } }, { type: 'request', data: {} }] }))
    const out = await apps.run('sentry_read_event', { id: '1' })
    expect(asked.at(-1).url).toBe('https://sentry.io/api/0/organizations/acme/issues/1/events/latest/')
    expect(out).toContain('TypeError: x is null')
    expect(out).toContain('a.js:3 in f')
    expect(out).toContain('env=prod')
    await apps.run('sentry_read_event', { id: '1/../2', event: '../../x' })
    expect(asked.at(-1).url).toContain('/issues/1%2F..%2F2/events/..%2F..%2Fx/')
    onlyHosts(['sentry.io'])
  })
})

describe('Vercel', () => {
  beforeEach(() => connect('vercel'))

  it('lists projects and deployments, a team\'s id only in a query', async () => {
    respond = (url) => (url.includes('/v2/teams') ? json({ teams: [{ id: 'team_1', slug: 'acme' }] }) : json({ projects: [{ id: 'prj_1', name: 'Site', framework: 'vite' }] }))
    expect(await apps.run('vercel_list_projects', { team: 'acme', query: 's', max: 900 })).toContain('Site (vite)')
    expect(lastUrl().origin + lastUrl().pathname).toBe('https://api.vercel.com/v10/projects')
    expect(lastUrl().searchParams.get('teamId')).toBe('team_1')
    expect(lastUrl().searchParams.get('limit')).toBe('100')
    await apps.run('vercel_list_projects', {})
    expect(lastUrl().searchParams.has('teamId')).toBe(false)
    respond = () => json({ deployments: [{ uid: 'dpl_1', name: 'Site', state: 'READY', target: 'production', url: 'site.example', created: 1700000000000, meta: { githubCommitMessage: 'Fix' } }] })
    const out = await apps.run('vercel_list_deployments', { project: 'prj_1', state: 'READY' })
    expect(lastUrl().pathname).toBe('/v7/deployments')
    expect(out).toContain('id: dpl_1')
    expect(out).toContain('Commit: Fix')
    expect(out).toContain('2023-11-14')
  })

  it('reads a deployment and its build log, not a stream of it', async () => {
    respond = () => json({ uid: 'dpl_1', name: 'Site', readyState: 'ERROR', errorMessage: 'Build failed', createdAt: 'never' })
    const one = await apps.run('vercel_read_deployment', { id: 'dpl_1' })
    expect(lastUrl().pathname).toBe('/v13/deployments/dpl_1')
    expect(one).toContain('Error: Build failed')
    expect(one).toContain('Created ?')
    respond = () => json([{ created: 1700000000000, text: 'Second' }, { created: 1600000000000, payload: { text: 'First' } }])
    const log = await apps.run('vercel_logs', { id: 'dpl_1', max: 9000 })
    expect(lastUrl().pathname).toBe('/v3/deployments/dpl_1/events')
    expect(lastUrl().searchParams.get('follow')).toBe('0')
    expect(lastUrl().searchParams.get('limit')).toBe('1000')
    expect(log.indexOf('First')).toBeLessThan(log.indexOf('Second'))
  })

  it('a team that Vercel did not name goes nowhere, however it is written', async () => {
    respond = () => json({ teams: [{ id: 'team_1', slug: 'acme' }] })
    for (const team of ['https://evil.test/../x', 'team_2', '../..']) {
      asked.length = 0
      await expect(apps.run('vercel_list_projects', { team })).rejects.toMatchObject({ code: 'unknown_team', message: expect.stringContaining('acme') })
      await expect(apps.run('vercel_logs', { id: 'd', team })).rejects.toMatchObject({ code: 'unknown_team' })
      expect(asked.every((a) => a.url.includes('/v2/teams'))).toBe(true)
    }
  })

  it('a hostile id stays in one segment', async () => {
    respond = () => json([])
    await apps.run('vercel_logs', { id: '../../../v2/user' })
    expect(asked[0].url).toContain('/v3/deployments/..%2F..%2F..%2Fv2%2Fuser/events?')
    onlyHosts(['api.vercel.com'])
    await expect(apps.run('vercel_read_deployment', { id: '..' })).rejects.toMatchObject({ code: 'invalid_argument' })
  })
})

describe('Stripe', () => {
  beforeEach(() => connect('stripe', { refresh_token: 'REFRESH-SECRET' }))

  it('only reads: every request is a GET', async () => {
    respond = () => json({ data: [{ id: 'cus_1', email: 'a@b.example' }], has_more: true })
    const out = await apps.run('stripe_list', { kind: 'customers', email: 'a@b.example', customer: 'ignored', max: 900 })
    expect(lastUrl().origin + lastUrl().pathname).toBe('https://api.stripe.com/v1/customers')
    expect(lastUrl().searchParams.get('limit')).toBe('100')
    expect(lastUrl().searchParams.get('email')).toBe('a@b.example')
    expect(lastUrl().searchParams.has('customer')).toBe(false)
    expect(out).toContain('cus_1')
    expect(out).toContain('there are more')
    await apps.run('stripe_list', { kind: 'charges', customer: 'cus_1' })
    expect(lastUrl().searchParams.get('customer')).toBe('cus_1')
    respond = () => json({ id: 'ch_1' })
    await apps.run('stripe_read', { kind: 'charges', id: 'ch_1' })
    expect(lastUrl().pathname).toBe('/v1/charges/ch_1')
    await apps.run('stripe_balance', {})
    expect(lastUrl().pathname).toBe('/v1/balance')
    for (const a of asked) expect(a.init.method).toBeUndefined()
  })

  it('only the kinds it knows reach an address, and a hostile id stays in one segment', async () => {
    for (const kind of ['accounts', 'payouts/../transfers', '../v2', 'transfers', 'refunds', 'constructor', '']) await expect(apps.run('stripe_list', { kind })).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(asked).toEqual([])
    respond = () => json({})
    await apps.run('stripe_read', { kind: 'charges', id: '../../v1/payouts' })
    expect(asked[0].url).toBe('https://api.stripe.com/v1/charges/..%2F..%2Fv1%2Fpayouts')
    await expect(apps.run('stripe_read', { kind: 'charges', id: '..' })).rejects.toMatchObject({ code: 'invalid_argument' })
  })
})

describe('what is said after disconnecting', () => {
  it('a service with a way to end it is asked, with which kind of token', async () => {
    await connect('github')
    calls.length = 0
    server = async () => answer({ ok: true })
    const view = await apps.connections.disconnect('github', 'someone at acme')
    expect(calls).toEqual([{ path: '/api/connect/revoke', body: { service: 'github', token: 'REFRESH-SECRET', kind: 'refresh' } }])
    expect(view).toMatchObject({ error: null, notEnded: [] })
  })

  it('a token with no refresh token is sent as what it is', async () => {
    await connect('notion', { refresh_token: null, grant: null, expires_in: null })
    calls.length = 0
    server = async () => answer({ ok: true })
    await apps.connections.disconnect('notion', 'someone at acme')
    expect(calls[0].body).toEqual({ service: 'notion', token: 'ACCESS-SECRET', kind: 'access' })
  })

  it.each(['microsoft', 'atlassian', 'sentry', 'stripe'])('%s gives apps no way: nothing is sent, the token is gone here, and the person is told', async (service) => {
    await connect(service)
    calls.length = 0
    const view = await apps.connections.disconnect(service, 'someone at acme')
    expect(calls).toEqual([])
    expect(view).toMatchObject({ connections: [], error: null, notEnded: [{ service, how: 'byHand' }] })
    expect(fs.readFileSync(join(dir, 'connections.json'), 'utf8')).not.toContain('REFRESH')
    expect(make().connections.list()).toEqual([])
  })

  it('a service that could not be told says which', async () => {
    await connect('dropbox')
    server = async () => answer({ error: 'failed' }, 502)
    expect(await apps.connections.disconnect('dropbox', 'someone at acme')).toMatchObject({ error: 'notRevoked', notEnded: [{ service: 'dropbox', how: 'notTold' }] })
  })

  it('signing out says each one that is left', async () => {
    await connect('microsoft')
    await connect('dropbox')
    await connect('github')
    server = async (_path, body) => (body.service === 'dropbox' ? answer({}, 502) : answer({ ok: true }))
    const view = await apps.connections.disconnectAll()
    expect(view.connections).toEqual([])
    expect(view.error).toBe('notRevoked')
    expect(view.notEnded).toEqual(expect.arrayContaining([{ service: 'microsoft', how: 'byHand' }, { service: 'dropbox', how: 'notTold' }]))
    expect(view.notEnded).toHaveLength(2)
  })

  it('it is forgotten when something new starts', async () => {
    await connect('microsoft')
    await apps.connections.disconnect('microsoft', 'someone at acme')
    await connect('microsoft')
    expect(apps.connections.view().notEnded).toEqual([])
  })

  it('a token that ended with nothing to renew it says so in the panel too', async () => {
    await connect('notion', { refresh_token: null, grant: null, expires_in: null })
    respond = () => new Response('', { status: 401 })
    await expect(apps.run('notion_search', {})).rejects.toMatchObject({ code: 'reconnect' })
    expect(apps.connections.list()[0].reconnect).toBe(true)
    expect(make().connections.list()[0].reconnect).toBe(true)
  })
})

describe('which services can be connected', () => {
  const withPublic = (publicRequest) => createTesselApps({ dir, safeStorage, scheme: 'tessel-dev', openExternal: async () => {}, signedRequest: async () => ({ error: 'signedOut' }), publicRequest })

  it('the server says, signed in or not', async () => {
    const asks = []
    const a = withPublic(async (path) => {
      asks.push(path)
      return answer({ services: ['google', 'github', 7] })
    })
    expect(await a.connections.services()).toEqual({ services: ['google', 'github'] })
    expect(asks).toEqual(['/api/connect/services'])
  })

  it('when it cannot be asked, nothing is said either way', async () => {
    expect(await withPublic(async () => ({ error: 'offline' })).connections.services()).toEqual({ services: null })
    expect(await withPublic(async () => answer({}, 500)).connections.services()).toEqual({ services: null })
    expect(await withPublic(async () => answer({ services: 'all' })).connections.services()).toEqual({ services: null })
    expect(
      await withPublic(async () => {
        throw new Error('down')
      }).connections.services()
    ).toEqual({ services: null })
  })
})
