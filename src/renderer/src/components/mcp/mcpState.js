// The state of Settings > MCP servers, shared by its tabs (McpDialog.vue
// makes one and hands it to McpInstalled, McpCatalog and McpCustom): every
// agent's servers, the tests, and the actions that change an agent's
// settings. Claude Code and Codex stdio servers are changed through their own
// CLI; Codex HTTP servers and the other agents in their settings file, in the
// format each expects (src/main/jsonAgents.js, codexMcpConfig.js).
import { ref, reactive, computed, inject } from 'vue'
import { t } from '../../i18n'
import { MCP_CATALOG } from '../../mcpCatalog'
import { ALL_AGENTS, AGENT_NAME, agentList, testState } from './mcpShared'

export function useMcpState(props, emit) {
  // One (empty until read) list per agent: the page draws before the lists
  // arrive, so every agent it names must have one.
  const lists = reactive(Object.fromEntries(ALL_AGENTS.map((a) => [a, []])))
  const listOf = (agent) => (Array.isArray(lists[agent]) ? lists[agent] : [])
  const listErrors = reactive({}) // agent -> why its servers could not be read
  const loadError = ref('') // the whole read failed
  const loading = ref(true)
  const loaded = ref(false) // a first read has answered
  const busy = ref('') // key of the action in progress
  const message = reactive({ text: '', kind: 'ok', detail: '' })
  // A message about one server, shown in its own card (the top callout is
  // off-screen when the user is down at a card): name -> { text, kind, detail }.
  const cardMessage = reactive({})
  const tests = reactive({}) // "agent:scope:name" -> result
  const haveCmd = reactive({}) // 'node' / 'uvx' -> bool

  const installed = computed(() =>
    Object.fromEntries(ALL_AGENTS.map((id) => [id, !!props.agents.find((a) => a.id === id && a.available)]))
  )
  // The agents shown: installed here, or already holding servers (Claude Code
  // and Codex when nothing is detected, so the page is never empty).
  const AGENTS = computed(() => {
    const shown = ALL_AGENTS.filter((a) => installed.value[a] || listOf(a).length)
    return shown.length ? shown : ['claude', 'codex']
  })
  // The agents installed here (the add bars' chips), and those a server can
  // be added to: not one whose settings could not be read (a write would
  // fail, or worse).
  const addable = computed(() => AGENTS.value.filter((a) => installed.value[a]))
  const writable = computed(() => addable.value.filter((a) => !listErrors[a]))

  const catalogById = Object.fromEntries(MCP_CATALOG.map((e) => [e.id, e]))

  // One row per server name: which agents have it, and what they run.
  const rows = computed(() => {
    const map = new Map()
    for (const agent of AGENTS.value) {
      for (const s of listOf(agent)) {
        if (!map.has(s.name)) {
          map.set(s.name, { name: s.name, target: s.target, type: s.type, by: {}, agents: [], types: [], envKeys: [], headerKeys: [], entry: catalogById[s.name] || null })
        }
        const row = map.get(s.name)
        row.by[agent] = s
        row.agents.push(agent)
        if (!row.types.includes(s.type)) row.types.push(s.type)
        for (const k of s.envKeys || []) if (!row.envKeys.includes(k)) row.envKeys.push(k)
        for (const k of s.headerKeys || []) if (!row.headerKeys.includes(k)) row.headerKeys.push(k)
      }
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name))
  })

  function say(text, kind = 'ok', detail = '') {
    message.text = text
    message.kind = kind
    message.detail = detail || ''
  }
  // The same, in the card of server `name` (empty text clears it). A card's
  // message goes away with the next action on that server.
  function sayCard(name, text, kind = 'ok', detail = '') {
    if (!text) delete cardMessage[name]
    else cardMessage[name] = { text, kind, detail: detail || '' }
  }

  async function refresh() {
    loading.value = true
    try {
      const res = await window.shellApi.mcpList(props.cwd)
      loadError.value = ''
      lists.claude = (res && res.claude) || []
      lists.codex = (res && res.codex) || []
      if (res && res.codexError) listErrors.codex = res.codexError
      else delete listErrors.codex
      for (const [agent, r] of Object.entries((res && res.others) || {})) {
        lists[agent] = (r && r.servers) || []
        if (r && r.error) listErrors[agent] = r.error
        else delete listErrors[agent]
      }
    } catch (err) {
      loadError.value = (err && err.message) || String(err)
    } finally {
      loading.value = false
      loaded.value = true
    }
  }

  // Whether node / uvx are installed (a catalog server may need one). Never
  // throws: a failed check leaves the warning out.
  async function checkTools() {
    if (!window.shellApi.checkTools) return
    try {
      Object.assign(haveCmd, (await window.shellApi.checkTools(['node', 'uvx'])) || {})
    } catch {
      // unknown: no warning
    }
  }

  const testKey = (agent, s) => `${agent}:${s.scope}:${s.name}`
  const testOf = (agent, s) => (s ? tests[testKey(agent, s)] : null)

  async function test(agent, s) {
    const key = testKey(agent, s)
    sayCard(s.name, '')
    tests[key] = { status: 'testing' }
    try {
      tests[key] = await window.shellApi.mcpTest({ agent, name: s.name, scope: s.scope, cwd: props.cwd })
    } catch (err) {
      tests[key] = { status: 'error', error: err.message }
    }
  }
  const testServer = (row) => Promise.all(row.agents.map((a) => test(a, row.by[a])))
  const testAll = () => Promise.all(rows.value.map(testServer))

  // A server's dot: the worst of its last tests (none until one ran).
  function rowState(row) {
    const states = row.agents.map((a) => testState(testOf(a, row.by[a]))).filter(Boolean)
    if (!states.length) return null
    for (const s of ['testing', 'error', 'auth']) if (states.includes(s)) return s
    return 'ok'
  }
  // A remote server (http / sse): the one kind whose probe can answer "sign
  // in" (a 401 / 403), since Tessel's probe carries no token.
  const isRemote = (row) => row.types.some((ty) => ty && ty !== 'stdio')
  // Whether an agent's last test of this server asked for a sign-in.
  const needsSignIn = (row) => row.agents.some((a) => testState(testOf(a, row.by[a])) === 'auth')

  async function copyTo(row, to) {
    // From an agent that has it (the first one shown).
    const from = row.agents.find((a) => a !== to)
    if (!from) return
    sayCard(row.name, '')
    busy.value = `copy:${row.name}:${to}` // i18n-ignore
    try {
      const res = await window.shellApi.mcpCopy({ from, to, name: row.name, scope: row.by[from].scope, cwd: props.cwd })
      if (res && res.ok) {
        say(
          t('mcp.copy.added', 'Added "{{name}}" to {{agent}}.{{note}} Restart running {{agent}} panes to load it.', {
            name: row.name,
            agent: AGENT_NAME[to],
            note: res.note ? ' ' + res.note : ''
          })
        )
      } else {
        say(t('mcp.copy.failedFor', 'Could not add "{{name}}" to {{agent}}.', { name: row.name, agent: AGENT_NAME[to] }), 'error', res && res.error)
      }
    } catch (err) {
      say(t('mcp.copy.failedFor', 'Could not add "{{name}}" to {{agent}}.', { name: row.name, agent: AGENT_NAME[to] }), 'error', err && err.message)
    } finally {
      busy.value = ''
    }
    refresh()
  }

  // Tessel's own confirmation (falls back to the system one outside the app).
  const askConfirm = inject('askConfirm', (o) => Promise.resolve(window.confirm(o.title)))

  async function remove(agent, s) {
    const ok = await askConfirm({
      title: t('mcp.remove.confirm', 'Remove "{{name}}" from {{agent}}?', { name: s.name, agent: AGENT_NAME[agent] }),
      confirmLabel: t('mcp.remove.button', 'Remove'),
      danger: true
    })
    if (!ok) return
    sayCard(s.name, '')
    busy.value = `rm:${agent}:${s.name}` // i18n-ignore
    try {
      const res = await window.shellApi.mcpRemove({ agent, name: s.name, scope: s.scope, cwd: props.cwd })
      if (res && res.ok) say(t('mcp.remove.done', 'Removed "{{name}}" from {{agent}}.', { name: s.name, agent: AGENT_NAME[agent] }))
      else say(t('mcp.remove.failedFor', 'Could not remove "{{name}}" from {{agent}}.', { name: s.name, agent: AGENT_NAME[agent] }), 'error', res && res.error)
    } catch (err) {
      say(t('mcp.remove.failedFor', 'Could not remove "{{name}}" from {{agent}}.', { name: s.name, agent: AGENT_NAME[agent] }), 'error', err && err.message)
    } finally {
      busy.value = ''
    }
    delete tests[testKey(agent, s)]
    refresh()
  }

  // Signing in opens a browser and waits for its redirect: it runs in a pane
  // the user sees (never in a hidden process), for the CLIs that have a
  // command for it. Names are letters, digits, - and _ (checked when added).
  // Each CLI keeps its own token: Tessel cannot sign in once for all of them.
  const SIGN_IN_COMMAND = {
    codex: (name) => `codex mcp login ${name}`, // i18n-ignore
    opencode: (name) => `opencode mcp auth ${name}` // i18n-ignore
  }
  // The agents with a slash command for it, in their own pane.
  const SLASH_SIGN_IN = ['claude', 'gemini', 'qwen']
  const signInLabel = (name) => t('mcp.signIn.pane', 'Sign in: {{name}}', { name })

  function signIn(agent, name) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(name))) return
    if (SIGN_IN_COMMAND[agent]) {
      emit('run', { label: signInLabel(name), command: SIGN_IN_COMMAND[agent](name) })
    } else if (agent === 'gemini' || agent === 'qwen') {
      say(t('mcp.signIn.gemini', 'In a {{agent}} pane, type /mcp auth {{name}}. Your browser opens to sign in.', { name, agent: AGENT_NAME[agent] }))
    } else if (agent !== 'claude') {
      say(t('mcp.signIn.other', 'Sign in to "{{name}}" from a {{agent}} pane (its own MCP command), or set the server\'s API key.', { name, agent: AGENT_NAME[agent] }))
    } else {
      say(t('mcp.signIn.claude', 'In a Claude Code pane, type /mcp, pick "{{name}}" and choose Authenticate. Your browser opens to sign in.', { name }))
    }
  }

  // The card's one Sign in button: every agent that has the server. Those
  // with a command (Codex, OpenCode) sign in one after the other in one pane
  // (one 'run' with steps); the others are told how, in the card.
  function signInAll(row) {
    const name = row.name
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(name))) return
    const steps = row.agents.filter((a) => SIGN_IN_COMMAND[a]).map((a) => SIGN_IN_COMMAND[a](name))
    const slash = row.agents.filter((a) => SLASH_SIGN_IN.includes(a))
    const rest = row.agents.filter((a) => !SIGN_IN_COMMAND[a] && !SLASH_SIGN_IN.includes(a))
    const lines = []
    if (slash.length) {
      const how = []
      if (slash.includes('claude')) how.push(t('mcp.signIn.howClaude', 'in a Claude Code pane, type /mcp, pick "{{name}}" and choose Authenticate', { name }))
      const geminiLike = slash.filter((a) => a !== 'claude').map((a) => AGENT_NAME[a])
      if (geminiLike.length) how.push(t('mcp.signIn.howGemini', 'in a {{agents}} pane, type /mcp auth {{name}}', { name, agents: agentList(geminiLike) }))
      lines.push(t('mcp.signIn.slash', 'To sign in: {{how}}. Your browser opens to sign in.', { how: how.join('; ') }))
    }
    if (rest.length) {
      lines.push(t('mcp.signIn.rest', '{{agents}} sign in from their own pane; Tessel cannot do it for them.', { agents: agentList(rest.map((a) => AGENT_NAME[a])) }))
    }
    // The pane opens over Settings; the card's text waits for the user's return.
    sayCard(name, lines.join('\n'))
    if (steps.length) emit('run', { label: signInLabel(name), steps })
  }

  // The agents that already have a server of this name.
  const addedTo = (name) => AGENTS.value.filter((a) => listOf(a).some((s) => s.name === name))
  // "Added" only when every agent it can be added to has it.
  function fullyAdded(name) {
    const has = addedTo(name)
    return writable.value.length > 0 && writable.value.every((a) => has.includes(a))
  }
  // agent -> why the add bars cannot choose it ({} when all can).
  const unwritable = computed(() =>
    Object.fromEntries(addable.value.filter((a) => listErrors[a]).map((a) => [a, t('mcp.addbar.unreadable', 'Its MCP settings could not be read')]))
  )

  // Each chosen agent in turn; one failing never stops the others.
  //   -> { agent: { state: 'added'|'failed', error } }
  async function addToAgents(chosen, specFor) {
    const out = {}
    for (const agent of chosen) {
      let res
      try {
        res = await window.shellApi.mcpAdd(specFor(agent))
      } catch (err) {
        res = { ok: false, error: err && err.message }
      }
      out[agent] = res && res.ok ? { state: 'added' } : { state: 'failed', error: (res && res.error) || t('mcp.addFailed', 'failed') }
    }
    return out
  }
  const addedNames = (out) =>
    Object.keys(out)
      .filter((a) => out[a].state !== 'failed')
      .map((a) => AGENT_NAME[a])
  const failuresText = (out) =>
    Object.entries(out)
      .filter(([, r]) => r.state === 'failed')
      .map(([a, r]) => `${AGENT_NAME[a]}: ${r.error}`)
      .join('\n')

  // After adding: test the server for each agent that has it; one that
  // answers only after a sign-in shows "Needs sign-in" (with Sign in).
  async function checkAdded(name, out) {
    await refresh()
    await Promise.all(
      Object.keys(out)
        .filter((a) => out[a].state === 'added')
        .map(async (agent) => {
          const s = listOf(agent).find((x) => x.name === name)
          if (!s) {
            out[agent] = { state: 'failed', error: t('mcp.addNotListed', '{{agent}} does not list it.', { agent: AGENT_NAME[agent] }) }
            return
          }
          await test(agent, s)
          const r = tests[testKey(agent, s)]
          if (r && r.status === 'auth') out[agent] = { state: 'auth', error: r.error }
        })
    )
  }

  // reactive(): its refs read as plain values in the tabs' templates.
  return reactive({
    lists,
    listOf,
    listErrors,
    loadError,
    loading,
    loaded,
    busy,
    message,
    cardMessage,
    tests,
    haveCmd,
    installed,
    AGENTS,
    addable,
    writable,
    unwritable,
    rows,
    catalogById,
    say,
    sayCard,
    refresh,
    checkTools,
    testKey,
    testOf,
    test,
    testServer,
    testAll,
    rowState,
    isRemote,
    needsSignIn,
    copyTo,
    remove,
    signIn,
    signInAll,
    addedTo,
    fullyAdded,
    addToAgents,
    addedNames,
    failuresText,
    checkAdded,
    agentList
  })
}
