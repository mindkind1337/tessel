// Direct GraphQL client: https://linear.app/developers/graphql and /filtering.
// Design reference: Orca's Linear integration (MIT, © 2026 Lovecast Inc.);
// independent implementation, with no plaintext credential fallback.
import fs from 'fs'
import { randomUUID } from 'crypto'
import { dirname, isAbsolute, join, parse, resolve, sep } from 'path'

const ENDPOINT = 'https://api.linear.app/graphql'
const MAX_RESPONSE = 2 * 1024 * 1024
const MAX_FILE = 64 * 1024
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const FILTERS = new Set(['assigned', 'created', 'all', 'completed', 'open'])
const ISSUE_FIELDS = `id identifier title url description priority createdAt updatedAt
  state { id name type color } team { id name key }
  assignee { id name } creator { id name }`
const ME =
  'query TesselLinearConnect { viewer { id name displayName email } organization { id name urlKey } }'
const ISSUES = `query TesselLinearIssues($filter: IssueFilter!) {
  issues(first: 100, orderBy: updatedAt, filter: $filter) {
    nodes { ${ISSUE_FIELDS} } pageInfo { hasNextPage endCursor }
  }
}`
const TEAMS = `query TesselLinearTeams {
  teams(first: 100) { nodes { id name key } pageInfo { hasNextPage endCursor } }
}`
const STATES = `query TesselLinearStates($teamId: String!) {
  team(id: $teamId) { states(first: 100) {
    nodes { id name type position color } pageInfo { hasNextPage endCursor }
  } }
}`
const UPDATE = `mutation TesselLinearSetState($issueId: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $issueId, input: $input) { success issue { ${ISSUE_FIELDS} } }
}`

class LinearError extends Error {}
const fail = (message) => {
  throw new LinearError(message)
}
const clone = (value) => JSON.parse(JSON.stringify(value))
const string = (value, max = 500) => (typeof value === 'string' ? value.slice(0, max) : '')
const validId = (value) => typeof value === 'string' && ID.test(value)
const validKey = (key) => typeof key === 'string' && /^[\x21-\x7e]{8,4096}$/.test(key)
const identifier = (value, label) => {
  if (typeof value !== 'string' || !ID.test(value)) fail(`Choose a valid Linear ${label}.`)
  return value
}
function person(value, detailed = false) {
  if (!value || !validId(value.id) || typeof value.name !== 'string')
    fail('Linear returned incomplete account data.')
  return {
    id: value.id,
    name: string(value.name),
    ...(detailed
      ? {
          displayName: string(value.displayName),
          email: string(value.email)
        }
      : {})
  }
}
function organization(value) {
  if (!value || !validId(value.id) || typeof value.name !== 'string')
    fail('Linear returned incomplete workspace data.')
  return { id: value.id, name: string(value.name), urlKey: string(value.urlKey, 100) }
}
function team(value) {
  if (
    !value ||
    !validId(value.id) ||
    typeof value.name !== 'string' ||
    typeof value.key !== 'string'
  )
    fail('Linear returned incomplete team data.')
  return { id: value.id, name: string(value.name), key: string(value.key, 100) }
}
function state(value) {
  if (
    !value ||
    !validId(value.id) ||
    typeof value.name !== 'string' ||
    typeof value.type !== 'string'
  )
    fail('Linear returned incomplete state data.')
  return {
    id: value.id,
    name: string(value.name),
    type: string(value.type, 50),
    color: string(value.color, 30),
    ...(Number.isFinite(value.position) ? { position: value.position } : {})
  }
}
function issue(value) {
  if (
    !value ||
    !validId(value.id) ||
    typeof value.title !== 'string' ||
    typeof value.identifier !== 'string'
  )
    fail('Linear returned incomplete issue data.')
  let url
  try {
    url = new URL(value.url)
  } catch {
    fail('Linear returned an invalid issue link.')
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'linear.app' ||
    url.username ||
    url.password ||
    url.port
  )
    fail('Linear returned an invalid issue link.')
  return {
    id: value.id,
    identifier: string(value.identifier, 100),
    title: string(value.title, 2000),
    url: url.href,
    description: string(value.description, 200000),
    priority:
      Number.isInteger(value.priority) && value.priority >= 0 && value.priority <= 4
        ? value.priority
        : 0,
    state: state(value.state),
    team: team(value.team),
    assignee: value.assignee ? person(value.assignee) : null,
    creator: value.creator ? person(value.creator) : null,
    createdAt: string(value.createdAt, 50),
    updatedAt: string(value.updatedAt, 50)
  }
}
function connection(value, mapper, field) {
  if (
    !value ||
    !Array.isArray(value.nodes) ||
    value.nodes.length > 100 ||
    typeof value.pageInfo?.hasNextPage !== 'boolean'
  )
    fail('Linear returned an incomplete list. Refresh to try again.')
  return {
    ok: true,
    [field]: value.nodes.map(mapper),
    hasNextPage: value.pageInfo.hasNextPage,
    endCursor:
      typeof value.pageInfo.endCursor === 'string' ? value.pageInfo.endCursor.slice(0, 1024) : null
  }
}

// Do not follow a redirected credential file or an ancestor junction.
function inspect(path, missing = false) {
  const full = resolve(path)
  const base = parse(full).root
  let cursor = base
  const parts = full.slice(base.length).split(sep).filter(Boolean)
  let stat
  for (let index = 0; index < parts.length; index++) {
    cursor = join(cursor, parts[index])
    try {
      stat = fs.lstatSync(cursor)
    } catch (error) {
      if (missing && error.code === 'ENOENT') return null
      throw error
    }
    if (stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory()))
      fail('Linear credential storage is not a regular local location.')
  }
  return stat || fs.lstatSync(base)
}
function directory(path) {
  const found = inspect(path, true)
  if (found) {
    if (!found.isDirectory()) fail('Linear credential storage is not a directory.')
    return
  }
  directory(dirname(path))
  fs.mkdirSync(path, { mode: 0o700 })
  inspect(path)
}

export function createLinearService({
  dir,
  safeStorage,
  fetch: fetcher = globalThis.fetch,
  now = Date.now,
  timeoutMs = 15000
} = {}) {
  if (typeof dir !== 'string' || !isAbsolute(dir))
    throw new TypeError('Linear storage requires an absolute directory.')
  const folder = resolve(dir)
  const file = join(folder, 'credentials.json')
  let loaded = false
  let credentials = null
  let generation = 0
  let issueRevision = 0
  const controllers = new Set()
  const cache = new Map()
  const flights = new Map()
  const timeout = Number.isFinite(timeoutMs) ? Math.max(1, Math.min(timeoutMs, 30000)) : 15000

  function encryption() {
    try {
      if (
        !safeStorage?.isEncryptionAvailable() ||
        safeStorage.getSelectedStorageBackend?.() === 'basic_text'
      )
        fail('Secure credential storage is unavailable. Linear was not connected.')
    } catch {
      fail('Secure credential storage is unavailable. Linear was not connected.')
    }
  }
  function load() {
    if (loaded) return
    try {
      const stat = inspect(file, true)
      if (!stat) {
        loaded = true
        return
      }
      if (!stat.isFile() || stat.size > MAX_FILE || stat.nlink !== 1)
        fail('Linear credential storage is invalid.')
      encryption()
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (
        raw.v !== 1 ||
        typeof raw.ciphertext !== 'string' ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(raw.ciphertext)
      )
        fail('Linear credentials could not be read. Reconnect or disconnect in Settings.')
      const record = JSON.parse(safeStorage.decryptString(Buffer.from(raw.ciphertext, 'base64')))
      if (record.v !== 1 || !validKey(record.key))
        fail('Linear credentials could not be read. Reconnect or disconnect in Settings.')
      credentials = {
        key: record.key,
        viewer: person(record.viewer, true),
        organization: organization(record.organization)
      }
      loaded = true
    } catch (error) {
      if (error instanceof LinearError) throw error
      fail('Linear credentials could not be read. Reconnect or disconnect in Settings.')
    }
  }
  function save(record) {
    let temporary
    let handle
    try {
      encryption()
      const encrypted = safeStorage.encryptString(JSON.stringify({ v: 1, ...record }))
      if (!Buffer.isBuffer(encrypted) || !encrypted.length || encrypted.length > 40000)
        fail('Linear credentials could not be encrypted.')
      directory(folder)
      const existing = inspect(file, true)
      if (existing && (!existing.isFile() || existing.nlink !== 1))
        fail('Linear credential storage is invalid.')
      temporary = join(folder, `credentials-${randomUUID()}.tmp`)
      handle = fs.openSync(temporary, 'wx', 0o600)
      fs.writeFileSync(handle, JSON.stringify({ v: 1, ciphertext: encrypted.toString('base64') }))
      fs.fsyncSync(handle)
      fs.closeSync(handle)
      handle = undefined
      inspect(file, true)
      fs.renameSync(temporary, file)
    } catch (error) {
      if (error instanceof LinearError) throw error
      fail('Linear credentials could not be saved securely. The previous connection was kept.')
    } finally {
      if (handle !== undefined) fs.closeSync(handle)
      if (temporary) {
        try {
          fs.unlinkSync(temporary)
        } catch {
          /* renamed or inaccessible */
        }
      }
    }
  }
  function publicStatus() {
    load()
    return credentials
      ? {
          ok: true,
          configured: true,
          viewer: clone(credentials.viewer),
          organization: clone(credentials.organization)
        }
      : { ok: true, configured: false }
  }
  function changed() {
    generation++
    cache.clear()
    flights.clear()
    for (const controller of controllers) controller.abort()
  }
  function current(expected) {
    if (generation !== expected) fail('The Linear connection changed. Try again.')
  }
  async function request(key, query, variables, expected) {
    current(expected)
    const controller = new AbortController()
    controllers.add(controller)
    let timer
    let reader
    let expired = false
    const bounded = new Promise((_, reject) => {
      timer = setTimeout(() => {
        expired = true
        controller.abort()
        reject(new LinearError('Linear did not respond in time. Try again.'))
      }, timeout)
      controller.signal.addEventListener(
        'abort',
        () =>
          reject(
            new LinearError(
              expired
                ? 'Linear did not respond in time. Try again.'
                : 'The Linear connection changed. Try again.'
            )
          ),
        { once: true }
      )
    })
    const perform = async () => {
      const response = await fetcher(ENDPOINT, {
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: key
        },
        body: JSON.stringify({ query, variables })
      })
      if (controller.signal.aborted) fail('The Linear connection changed. Try again.')
      current(expected)
      if (!response?.ok || response.redirected) {
        if (response?.status === 401 || response?.status === 403)
          fail('Linear refused this key or its permissions. Check the key in Settings.')
        if (response?.status === 429)
          fail('Linear rate limit reached. Wait a moment before refreshing.')
        fail('Linear could not complete the request. Try again later.')
      }
      const length = Number(response.headers?.get('content-length'))
      if (Number.isFinite(length) && length > MAX_RESPONSE)
        fail('Linear returned too much data. Choose a narrower filter.')
      if (!response.body?.getReader) fail('Linear returned an unreadable response.')
      reader = response.body.getReader()
      let size = 0
      const chunks = []
      for (;;) {
        const { value, done } = await reader.read()
        if (controller.signal.aborted) fail('The Linear connection changed. Try again.')
        if (done) break
        size += value.byteLength
        if (size > MAX_RESPONSE) fail('Linear returned too much data. Choose a narrower filter.')
        chunks.push(Buffer.from(value))
      }
      let data
      try {
        data = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        fail('Linear returned an unreadable response.')
      }
      if (data.errors != null && (!Array.isArray(data.errors) || data.errors.length))
        fail('Linear rejected the request. Check this key’s permissions and try again.')
      if (!data.data || typeof data.data !== 'object')
        fail('Linear returned an incomplete response.')
      current(expected)
      return data.data
    }
    try {
      return await Promise.race([perform(), bounded])
    } catch (error) {
      if (error instanceof LinearError) throw error
      fail('Unable to reach Linear. Check your connection and try again.')
    } finally {
      clearTimeout(timer)
      controllers.delete(controller)
      if (reader) Promise.resolve(reader.cancel()).catch(() => {})
      controller.abort()
    }
  }
  function account() {
    load()
    if (!credentials) fail('Connect Linear in Settings first.')
    return { ...credentials, generation }
  }
  async function cached(name, variables, refresh, ttl, query, map) {
    const session = account()
    const revision = name === 'issues' ? issueRevision : 0
    const key = `${session.generation}/${revision}/${name}/${JSON.stringify(variables)}`
    const hit = cache.get(key)
    if (!refresh && hit && now() - hit.at < ttl) return clone(hit.value)
    if (flights.has(key)) return clone(await flights.get(key))
    const pending = (async () => {
      const raw = await request(session.key, query, variables, session.generation)
      current(session.generation)
      if (name === 'issues' && revision !== issueRevision)
        fail('Linear issues changed. Refresh to see the latest state.')
      const value = map(raw)
      cache.set(key, { at: now(), value })
      while (cache.size > 128) cache.delete(cache.keys().next().value)
      return value
    })()
    flights.set(key, pending)
    try {
      return clone(await pending)
    } finally {
      if (flights.get(key) === pending) flights.delete(key)
    }
  }
  const safe =
    (work) =>
    async (...args) => {
      try {
        return await work(...args)
      } catch (error) {
        return {
          ok: false,
          error:
            error instanceof LinearError
              ? error.message
              : 'Linear could not complete this operation. Try again.'
        }
      }
    }
  return {
    status: safe(publicStatus),
    connect: safe(async ({ key } = {}) => {
      key = typeof key === 'string' ? key.trim() : ''
      if (!validKey(key)) fail('Enter a valid Linear personal API key.')
      encryption()
      changed()
      const expected = generation
      const data = await request(key, ME, {}, expected)
      const record = {
        key,
        viewer: person(data.viewer, true),
        organization: organization(data.organization)
      }
      current(expected)
      save(record)
      // Reads started while validation was pending still used the previous
      // account. Their responses must not populate the new account's cache.
      changed()
      credentials = record
      loaded = true
      return publicStatus()
    }),
    disconnect: safe(() => {
      changed()
      try {
        const stat = inspect(file, true)
        if (stat) {
          if (!stat.isFile() || stat.nlink !== 1) fail('Linear credential storage is invalid.')
          fs.unlinkSync(file)
        }
      } catch (error) {
        if (error instanceof LinearError) throw error
        fail('Linear credentials could not be removed. The connection was kept; try again.')
      }
      credentials = null
      loaded = true
      return { ok: true, configured: false }
    }),
    issues: safe(
      async ({ filter = 'assigned', teamId, stateId, priority, refresh = false } = {}) => {
        if (!FILTERS.has(filter)) fail('Choose a valid Linear issue filter.')
        const session = account()
        const selection = {}
        if (filter === 'assigned') selection.assignee = { id: { eq: session.viewer.id } }
        if (filter === 'created') selection.creator = { id: { eq: session.viewer.id } }
        if (filter === 'completed') selection.state = { type: { eq: 'completed' } }
        if (filter === 'open') selection.state = { type: { nin: ['completed', 'canceled'] } }
        if (teamId) selection.team = { id: { eq: identifier(teamId, 'team') } }
        if (stateId)
          selection.state = { ...selection.state, id: { eq: identifier(stateId, 'state') } }
        if (priority != null && priority !== '') {
          if (!Number.isInteger(priority) || priority < 0 || priority > 4)
            fail('Choose a Linear priority from 0 to 4.')
          selection.priority = { eq: priority }
        }
        return cached('issues', { filter: selection }, refresh, 60000, ISSUES, (raw) =>
          connection(raw.issues, issue, 'items')
        )
      }
    ),
    teams: safe(({ refresh = false } = {}) =>
      cached('teams', {}, refresh, 600000, TEAMS, (raw) => connection(raw.teams, team, 'teams'))
    ),
    states: safe(({ teamId, refresh = false } = {}) =>
      cached('states', { teamId: identifier(teamId, 'team') }, refresh, 600000, STATES, (raw) => {
        const result = connection(raw.team?.states, state, 'states')
        result.states.sort((a, b) => (a.position || 0) - (b.position || 0))
        return result
      })
    ),
    setState: safe(async ({ issueId, stateId } = {}) => {
      identifier(issueId, 'issue')
      identifier(stateId, 'state')
      const session = account()
      issueRevision++
      const raw = await request(
        session.key,
        UPDATE,
        { issueId, input: { stateId } },
        session.generation
      )
      current(session.generation)
      if (raw.issueUpdate?.success !== true)
        fail('Linear did not update the issue. Refresh before trying again.')
      const updated = issue(raw.issueUpdate.issue)
      issueRevision++
      return { ok: true, issue: updated }
    })
  }
}
