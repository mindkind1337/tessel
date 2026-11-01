// The simulated main process: what the demo answers on window.shellApi, on purpose.
// Everything goes through the calls and events the preload defines (terminal output
// on onData, agent state on onAgentState, the board on team.requests, the chat on
// chat.onEvent), never into Tessel's stores. Anything not here falls to the generic
// default (fakeApi.js).
//
// Nothing here touches the network, the disk, the clipboard or the visitor's data.
import { AgentScreen, ShellScreen } from './screens'
import { AVAILABLE_AGENTS, CHANGES, FILES, GIT, MODELS, ORIGINALS, PANES, PROJECT, SECOND_PROJECT, SHELLS, TEAM_ID, TOOLS_VERSION, createScript, savedLayout } from './scenario'

const TERMINAL_KINDS = ['claude', 'codex', 'gemini']
// The agents the shell knows by their command, for a pane opened from the launcher.
const firstWord = (line) => String(line).trim().split(/\s+/)[0] || ''

const LOCAL_ROOTS = [PROJECT.cwd, SECOND_PROJECT.cwd]
const norm = (p) => String(p || '').replace(/\//g, '\\').replace(/\\+$/, '')
const within = (root, p) => {
  const a = norm(p).toLowerCase()
  const b = norm(root).toLowerCase()
  return a === b || a.startsWith(`${b}\\`)
}
const fullPath = (rel) => `${PROJECT.cwd}\\${rel.replace(/\//g, '\\')}`
const relPath = (p) => norm(p).slice(PROJECT.cwd.length + 1).replace(/\\/g, '/')

export function createSimulator({ lang, uiLanguage, agents = [], notAvailable = '', version = '', build = null, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const script = createScript(lang)
  const subs = { data: new Set(), exit: new Set(), agentState: new Set(), chat: new Set(), focus: new Set() }
  const emit = (set, payload) => {
    for (const fn of [...set]) fn(payload)
  }
  const subscribe = (set, fn) => {
    set.add(fn)
    return () => set.delete(fn)
  }

  // --- The clock: every scripted step waits on it, and it stops while out of sight ---
  let paused = false
  const pending = new Set()
  let intervalId = null
  function after(ms, fn) {
    const job = { fn, left: ms, startedAt: Date.now(), timer: null }
    const arm = () => {
      job.startedAt = Date.now()
      job.timer = setTimer(() => {
        pending.delete(job)
        fn()
      }, job.left)
    }
    job.arm = arm
    pending.add(job)
    if (!paused) arm()
    return job
  }
  function setPaused(value) {
    if (paused === !!value) return
    paused = !!value
    for (const job of pending) {
      if (paused) {
        clearTimer(job.timer)
        job.left = Math.max(0, job.left - (Date.now() - job.startedAt))
      } else job.arm()
    }
  }

  // --- Terminals ---------------------------------------------------------------------
  const terminals = new Map() // pane id -> { screen, kind, cols, rows, pid, token, provider, cwd, shellId }
  let nextPid = 4200
  const output = (id) => (data) => emit(subs.data, { id, data })
  const shellById = (id) => SHELLS.find((s) => s.id === id) || SHELLS[0]
  const promptFor = (entry) => () => {
    const shell = entry.shellId
    if (shell === 'cmd') return `${entry.cwd}>`
    if (shell === 'gitbash' || shell === 'wsl') return `$ `
    return `PS ${entry.cwd}> `
  }

  function shellCommands(entry) {
    return (line, shell) => {
      const cmd = firstWord(line)
      const low = cmd.toLowerCase()
      if (!cmd) return null
      const known = agents.find((a) => firstWord(a.command).toLowerCase() === low && AVAILABLE_AGENTS.includes(a.id))
      if (known) {
        startAgentInShell(entry, known, shell)
        return 'taken'
      }
      if (low === 'help') return { lines: [script.words.shellHelp] }
      if (low === 'cls' || low === 'clear') return { clear: true }
      if (low === 'echo') return { lines: [line.slice(cmd.length).trim()] }
      if (low === 'pwd') return { lines: [entry.cwd] }
      if (low === 'exit') {
        killTerminal(entry.id)
        return 'taken'
      }
      if (low === 'dir' || low === 'ls') {
        const names = new Set(Object.keys(FILES).map((f) => f.split('/')[0]))
        return { lines: [...names].sort() }
      }
      if (low === 'git') {
        if (/^git\s+status/i.test(line)) {
          const short = /--short|-s\b/.test(line)
          const rows = Object.entries(CHANGES).map(([p, s]) => (short ? `${s === 'U' ? '??' : ` ${s}`} ${p}` : `  ${s === 'U' ? 'new file: ' : 'modified: '}${p}`))
          return { lines: short ? rows : [`On branch ${GIT.branch}`, ...rows] }
        }
        if (/^git\s+log/i.test(line)) return { lines: GIT.log }
        if (/^git\s+branch/i.test(line)) return { lines: [`* ${GIT.branch}`] }
      }
      return { lines: [script.words.shellNotFound(cmd)] }
    }
  }

  function addShell(id, { shellId = 'powershell', cwd = PROJECT.cwd, cols = 80, rows = 24 } = {}) {
    const entry = { id, kind: 'shell', shellId, cwd, cols, rows, pid: nextPid++, token: null, provider: null, screen: null }
    entry.screen = new ShellScreen({ emit: output(id), prompt: promptFor(entry), commands: shellCommands(entry), cols, rows })
    entry.screen.log = entry.screen.promptText()
    terminals.set(id, entry)
    return entry
  }

  function startAgentInShell(entry, agent, shell) {
    const provider = agent.id
    entry.kind = 'agent'
    entry.provider = provider
    entry.token = entry.token || `demo-launch-${entry.id}`
    entry.screen = newAgentScreen(entry, provider, MODELS[provider] ? MODELS[provider].model : '')
    shell.emit('')
    output(entry.id)(`\r\n`)
    entry.screen.draw([])
    entry.screen.add({ say: script.words.agentGreeting })
    setState(entry.id, 'idle')
  }

  function newAgentScreen(entry, kind, footerNote = '', placeholder = '') {
    return new AgentScreen({ kind: TERMINAL_KINDS.includes(kind) ? kind : 'claude', emit: output(entry.id), cols: entry.cols, rows: entry.rows, footerNote, placeholder })
  }

  function addScriptedAgent(id) {
    const def = script.agents[id]
    const entry = { id, kind: 'agent', shellId: 'powershell', cwd: id === PANES.emmy ? SECOND_PROJECT.cwd : PROJECT.cwd, cols: 80, rows: 24, pid: nextPid++, provider: def.kind, token: `demo-launch-${id}`, screen: null }
    entry.screen = newAgentScreen(entry, def.kind, def.footerNote, def.placeholder)
    entry.screen.entries.push(...def.start)
    if (def.work) entry.screen.work = { text: def.work, since: Date.now() - 20000 }
    terminals.set(id, entry)
    setState(id, def.state, { quiet: true })
    return entry
  }

  function killTerminal(id, exitCode = 0) {
    const entry = terminals.get(id)
    if (!entry) return
    terminals.delete(id)
    forgetState(id)
    emit(subs.exit, { id, exitCode, pid: entry.pid })
  }

  function attachAnswer(entry) {
    return {
      ok: true,
      shell: shellById(entry.shellId),
      backend: 'conpty',
      windowsBuild: 26100,
      pid: entry.pid,
      cwd: entry.cwd,
      exited: false,
      buffer: entry.screen.snapshot(),
      agentLaunchToken: entry.token,
      remoteHostId: null
    }
  }

  // What the visitor types into a terminal.
  function writeTerminal(id, data) {
    const entry = terminals.get(id)
    if (!entry) return
    if (entry.kind === 'shell') return entry.screen.input(data)
    typeIntoAgent(entry, data)
  }

  function typeIntoAgent(entry, data) {
    const screen = entry.screen
    // eslint-disable-next-line no-control-regex -- a terminal's escape sequences
    const text = String(data).replace(/\x1b\[20[01]~/g, '')
    if (text.startsWith('\x1b')) return
    for (const ch of text) {
      if (ch === '\r' || ch === '\n') {
        const prompt = screen.draft.trim()
        screen.draft = ''
        if (prompt) answerAgentPrompt(entry, prompt)
        else screen.draw()
      } else if (ch === '\x7f' || ch === '\b') {
        screen.draft = screen.draft.slice(0, -1)
        screen.draw()
      } else if (ch >= ' ') {
        screen.draft += ch
        screen.draw()
      }
    }
  }

  function answerAgentPrompt(entry, prompt) {
    const screen = entry.screen
    screen.add({ user: prompt })
    screen.setWork(script.words.agentWorking)
    setState(entry.id, 'working')
    after(2600, () => {
      if (terminals.get(entry.id) !== entry) return
      screen.work = null
      screen.add({ say: script.words.agentReply })
      setState(entry.id, 'idle')
    })
  }

  // --- Agent state: what the main process's agentStateStore publishes ------------------
  const states = {}
  function publicState(id, state) {
    const entry = terminals.get(id) || chats.get(id)
    const now = Date.now()
    return {
      paneId: id,
      provider: (entry && (entry.provider || entry.agent)) || 'claude',
      launchToken: (entry && entry.token) || `demo-launch-${id}`,
      sessionId: null,
      state,
      reason: state === 'working' ? 'processing' : state === 'approval' ? 'permission' : 'ready',
      source: 'hook',
      since: now,
      observedAt: now,
      hookSeen: true,
      confirmed: true,
      stale: false,
      children: [],
      childrenTruncated: false
    }
  }
  function setState(id, state, { quiet = false } = {}) {
    states[id] = publicState(id, state)
    if (!quiet) emit(subs.agentState, { ...states })
  }
  function forgetState(id) {
    delete states[id]
    emit(subs.agentState, { ...states })
  }

  // --- The board: the requests a real agent's team_task_move would leave ---------------
  const boardRequests = []
  let requestNumber = 0
  function moveCard(cardId, column, fromId) {
    boardRequests.push({ file: `demo-${++requestNumber}.json`, action: 'move', id: cardId, column, fromId })
  }

  // --- Chat panes: the events of src/main/chat/sessions.js ------------------------------
  const chats = new Map() // pane id -> { agent, model, sessionId, token, seq, journal, status }
  const chat = script.chat
  const approvalId = 'demo-approval-1'
  const toolId = 'demo-t2'
  let nextSession = 100
  function chatOf(paneId, { agent = 'claude', model = null, sessionId = null } = {}) {
    if (!chats.has(paneId)) {
      chats.set(paneId, {
        agent,
        model: model || (MODELS[agent] && MODELS[agent].model) || null,
        sessionId: sessionId || `00000000-0000-4000-8000-${String(nextSession++).padStart(12, '0')}`,
        token: `demo-launch-${paneId}`,
        seq: 0,
        journal: [],
        status: 'idle'
      })
    }
    return chats.get(paneId)
  }
  function chatEvent(paneId, event, { live = true } = {}) {
    const c = chatOf(paneId)
    const seq = ++c.seq
    c.journal.push({ seq, at: Date.now(), event })
    if (live) emit(subs.chat, { paneId, seq, event })
  }
  function chatState(paneId, state, { live = true } = {}) {
    const c = chatOf(paneId)
    c.status = state
    chatEvent(paneId, { type: 'status', state, agent: c.agent, ...(c.model ? { model: c.model } : {}), sessionId: c.sessionId, launchToken: c.token }, { live })
    states[paneId] = publicState(paneId, state === 'approval' ? 'approval' : state === 'working' ? 'working' : 'idle')
    if (live) emit(subs.agentState, { ...states })
  }
  function seedChat() {
    const id = chat.paneId
    chatOf(id, { agent: 'claude', model: chat.model, sessionId: chat.sessionId })
    chatState(id, 'idle', { live: false })
    for (const event of chat.history) {
      if (event.type === 'user') chatState(id, 'working', { live: false })
      chatEvent(id, event, { live: false })
    }
    chatEvent(id, { type: 'tool', id: toolId, name: 'Bash', input: { command: chat.command }, status: 'running' }, { live: false })
    chatEvent(
      id,
      {
        type: 'approval',
        requestId: approvalId,
        toolName: 'Bash',
        displayName: 'Bash',
        input: { command: chat.command },
        detail: chat.command,
        hidden: 0,
        sessionRules: [{ kind: 'rule', tool: 'Bash', content: chat.command }],
        description: '',
        status: 'pending'
      },
      { live: false }
    )
    chatState(id, 'approval', { live: false })
  }
  let chatAnswered = false
  function answerApproval(decision) {
    if (chatAnswered) return { ok: true }
    chatAnswered = true
    const id = chat.paneId
    const allowed = /allow|accept|approve/i.test(String(decision))
    chatEvent(id, { type: 'approvalStatus', requestId: approvalId, status: allowed ? 'allowed' : 'denied' })
    chatState(id, 'working')
    after(1800, () => {
      if (!chats.has(id)) return
      chatEvent(id, { type: 'toolResult', id: toolId, isError: !allowed, text: allowed ? chat.approved.result : '' })
      chatEvent(id, { type: 'assistant', messageId: 'demo-m3', text: allowed ? chat.approved.say : chat.denied })
      chatEvent(id, { type: 'turnEnd', status: 'completed', durationMs: 42000, costUsd: 0.07 })
      chatState(id, 'idle')
      if (allowed) moveCard(chat.card, 'review', id)
    })
    return { ok: true }
  }
  let chatMessage = 0
  function sendChat({ paneId, text }) {
    const number = ++chatMessage
    const id = `demo-user-${number}`
    const c = chatOf(paneId)
    chatEvent(paneId, { type: 'user', id, text: String(text || ''), status: 'accepted' })
    if (c.status !== 'approval') chatState(paneId, 'working')
    after(2200, () => {
      if (chats.get(paneId) !== c) return
      chatEvent(paneId, { type: 'assistant', messageId: `demo-reply-${number}`, text: chat.reply })
      if (c.status !== 'approval') {
        chatEvent(paneId, { type: 'turnEnd', status: 'completed', durationMs: 2200 })
        chatState(paneId, 'idle')
      }
    })
    return { ok: true, id, queued: false }
  }

  // --- The script ----------------------------------------------------------------------
  let started = false
  function runSteps(paneId, steps, index = 0, entry = terminals.get(paneId)) {
    if (index >= steps.length) return
    const step = steps[index]
    // The visitor closed or restarted it: the script of that terminal is over.
    if (!entry || terminals.get(paneId) !== entry) return
    if (step.wait) return after(step.wait, () => runSteps(paneId, steps, index + 1, entry))
    if (step.type !== undefined) entry.screen.run(step.type)
    if (step.state) setState(paneId, step.state)
    if (step.claim) for (const c of step.claim) moveCard(c, 'doing', paneId)
    if (step.move) moveCard(step.move[0], step.move[1], paneId)
    if (step.work !== undefined) {
      entry.screen.work = step.work ? { text: step.work, since: entry.screen.work ? entry.screen.work.since : Date.now() } : null
    }
    if (step.add) entry.screen.add(step.add)
    else if (step.work !== undefined) entry.screen.draw()
    runSteps(paneId, steps, index + 1, entry)
  }
  function start() {
    if (started) return
    started = true
    for (const [id, def] of Object.entries(script.agents)) after(1200, () => runSteps(id, def.steps))
    for (const [id, def] of Object.entries(script.shells)) after(600, () => runSteps(id, def.steps))
    // The spinners of the agents at work.
    intervalId = setInterval(() => {
      if (paused) return
      for (const entry of terminals.values()) if (entry.kind === 'agent') entry.screen.tick()
    }, 240)
  }
  function stop() {
    if (intervalId) clearInterval(intervalId)
    intervalId = null
    for (const job of pending) clearTimer(job.timer)
    pending.clear()
  }

  // --- Files, editor and source control of the invented project -------------------------
  const files = { ...FILES }
  const fileOf = (p) => (within(PROJECT.cwd, p) ? relPath(p) : null)
  function listDir({ root, dir } = {}) {
    if (!within(PROJECT.cwd, root || dir || '')) return { ok: true, entries: [], truncated: false }
    const base = fileOf(dir || root) || ''
    const prefix = base ? `${base}/` : ''
    const seen = new Map()
    for (const rel of Object.keys(files)) {
      if (!rel.startsWith(prefix)) continue
      const [name, ...more] = rel.slice(prefix.length).split('/')
      if (!seen.has(name)) seen.set(name, more.length > 0)
    }
    const entries = [...seen.entries()]
      .map(([name, isDir]) => ({ name, path: fullPath(prefix + name), dir: isDir }))
      .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
    return { ok: true, entries, truncated: false }
  }
  const signature = (text) => `demo-${String(text).length}`
  function readFile(path) {
    const rel = fileOf(path)
    if (rel === null || files[rel] === undefined) return { ok: false, error: notAvailable, code: 'missing' }
    const text = files[rel]
    return { ok: true, text, bom: false, size: text.length, mtimeMs: 1700000000000, sig: signature(text), hash: signature(text) }
  }
  function changeEntries() {
    return Object.entries(CHANGES).map(([path, letter]) => ({
      path,
      area: letter === 'U' ? 'untracked' : 'unstaged',
      status: letter === 'U' ? '?' : letter,
      added: (files[path] || '').split('\n').length,
      removed: letter === 'U' ? 0 : 2
    }))
  }
  const repoStatus = () => ({
    ok: true,
    repo: true,
    top: PROJECT.cwd,
    branch: GIT.branch,
    detached: false,
    head: GIT.head,
    hasCommits: true,
    upstream: `origin/${GIT.branch}`,
    hasUpstream: true,
    ahead: 0,
    behind: 0,
    operation: null,
    remotes: ['origin'],
    entries: changeEntries()
  })

  // --- A clipboard of the page's own: the visitor's is never read ---------------------
  let clipboard = ''

  // --- The API ---------------------------------------------------------------------------
  const ok = (extra = {}) => Promise.resolve({ ok: true, ...extra })
  const api = {
    isDev: false,
    build: () => Promise.resolve(build ? { ...build, text: `b${build.count} (${build.hash})` } : null),
    pathForFile: () => '',

    // The window and its start.
    listShells: () => Promise.resolve(SHELLS),
    listAgents: () => Promise.resolve(agents),
    refreshAgents: () => Promise.resolve(agents),
    loadLayout: () => Promise.resolve(savedLayout({ uiLanguage })),
    saveLayout: () => {},
    loadScrollback: () => Promise.resolve({}),
    reconcilePtys: () => Promise.resolve({ ok: true }),
    homeDir: () => Promise.resolve('C:\\Projects'),
    systemLocale: () => Promise.resolve(lang),
    windowShown: () => Promise.resolve(true),
    update: {
      status: () => Promise.resolve({ state: 'idle', current: version }),
      justInstalled: () => Promise.resolve(null)
    },

    // Terminals.
    onData: (fn) => subscribe(subs.data, fn),
    onExit: (fn) => subscribe(subs.exit, fn),
    createPty: (opts = {}) => {
      const id = opts.id || `pane-demo-${nextPid}`
      if (terminals.has(id)) terminals.delete(id)
      const entry = addShell(id, { shellId: opts.shellId || 'powershell', cwd: opts.cwd || PROJECT.cwd, cols: opts.cols || 80, rows: opts.rows || 24 })
      if (opts.agentId) {
        entry.token = `demo-launch-${id}-${nextPid}`
        entry.provider = opts.agentId
      }
      after(30, () => terminals.has(id) && entry.kind === 'shell' && output(id)(entry.screen.promptText()))
      return Promise.resolve({ ok: true, shell: shellById(entry.shellId), backend: 'conpty', windowsBuild: 26100, pid: entry.pid, cwd: entry.cwd, agentLaunchToken: entry.token })
    },
    attachPty: (id, opts) => {
      const entry = terminals.get(id)
      if (!entry) return Promise.resolve({ ok: false })
      return Promise.resolve(opts && opts.probe ? { ...attachAnswer(entry), buffer: '' } : attachAnswer(entry))
    },
    writePty: (id, data) => writeTerminal(id, data),
    resizePty: (id, cols, rows) => {
      const entry = terminals.get(id)
      if (!entry) return
      entry.cols = cols
      entry.rows = rows
      entry.screen.resize(cols, rows)
    },
    killPty: (id) => killTerminal(id),
    stopPtysAndWait: (ids) => {
      for (const id of ids || []) killTerminal(id)
      return ok()
    },
    ptyRunningWork: () => Promise.resolve({ running: false, names: [] }),

    // Agent state and models.
    agentStates: () => Promise.resolve({ ...states }),
    onAgentState: (fn) => subscribe(subs.agentState, fn),
    agentModel: (q) => Promise.resolve((q && MODELS[q.agentId]) || null),

    // No account of the visitor's: agents start on the system's own sign-in.
    accounts: {
      list: () => ok({ providers: [] }),
      launchEnv: () => ok({ env: {}, unsetEnv: [], accountId: null }),
      checkPlans: () => ok({ plans: {} }),
      onPlansChanged: () => () => {},
      claudeSwitch: () => Promise.resolve(null)
    },

    // The Usage menu: invented quotas, as a reading of the provider would give them.
    getUsage: () => ok({ agents: Object.values(script.usage).map((u) => ({ ...u })) }),
    providerUsage: {
      capabilities: () => ok({ providers: Object.values(script.usage).map((u) => ({ id: u.id, name: u.name, report: false, quota: true })) }),
      read: (q = {}) => {
        const reading = script.usage[q.provider]
        return reading ? ok({ ...reading, provider: q.provider, accountId: q.accountId ?? null, readAt: Date.now() }) : ok({ provider: q.provider, accountId: q.accountId ?? null, windows: [] })
      },
      autoRefresh: () => ok(),
      resetHistory: () => ok({ entries: [] }),
      creditHistory: () => ok({ entries: [] }),
      onUpdate: () => () => {}
    },
    statsUsage: { summary: () => ok(script.stats) },

    // What Settings reads: its normal empty states, nothing to fix.
    tesselNeeds: () => ok({ rows: script.needs }),
    toolStatus: () => ok({ tools: {} }),
    cli: { installStatus: () => ok({ status: { installed: false, supported: true } }), ready: () => ok() },
    signedIn: { places: () => ok({ places: [] }) },
    providerSettings: { status: () => ok({ secure: true, saved: {}, settings: {} }) },
    skillsList: () => ok({ skills: [], roots: [], updates: null }),
    context: { summary: () => ok({ agents: [] }), mcpMeasures: () => ok({ measures: {} }), tokenizers: () => Promise.resolve({}) },
    teamHooksStatus: () => ok({ agents: [] }),
    remoteHosts: { list: () => Promise.resolve([]), onState: () => () => {} },
    scanPorts: () => ok({ ports: {} }),
    // Answers that are a path or a text in the real API, never a list: as if the
    // visitor cancelled, or the file were empty. (An empty list would read as a path.)
    pickFolder: () => Promise.resolve(null),
    saveClipboardImage: () => Promise.resolve(null),
    readProjectNotes: () => Promise.resolve(''),
    loadNotes: () => ok({ path: `${PROJECT.cwd}\\.tessel\\notes.md`, text: '', mtime: 1700000000000 }),
    saveNotes: () => ok({ mtime: 1700000000000 }),
    keepAwake: (on) => ok({ on: on === true }),
    openFile: () => ok(),
    openExternal: () => ok(),
    listSessions: () => Promise.resolve([]),
    conversations: { terminal: () => ok({ lines: [], rows: [] }), image: () => ok() },

    // The clipboard stays in this page.
    writeClipboard: (text) => {
      clipboard = String(text ?? '')
    },
    readClipboard: () => Promise.resolve(clipboard),
    clipboardHasImage: () => Promise.resolve(false),

    // The board.
    taskBoard: {
      load: () => Promise.resolve({ tasks: script.tasks, appliedRequests: [], deleted: [], history: [] }),
      save: () => ok()
    },
    jobCost: {
      forCards: (ids) => Promise.resolve(Object.fromEntries((ids || []).filter((id) => script.costs[id]).map((id) => [id, script.costs[id]]))),
      forPanes: () => Promise.resolve({}),
      onChanged: () => () => {}
    },
    installTeamTools: () => ok({ version: TOOLS_VERSION, changed: [], errors: [] }),
    prepareAgentStatus: () => ok(),
    team: {
      requests: (q = {}) => {
        if (q.teamId !== TEAM_ID) return ok({ requests: [], refused: [] })
        return ok({ requests: boardRequests.splice(0), refused: [] })
      },
      requestsDone: (q = {}) => ok({ removed: q.files || [] }),
      requestsRelease: () => ok(),
      tasks: () => ok(),
      roster: () => ok(),
      current: () => ok({ teams: [] }),
      retire: () => ok(),
      notice: () => ok(),
      boardPanes: () => ok(),
      toolsAlive: (q = {}) => ok({ alive: Object.fromEntries((q.ids || []).map((id) => [id, true])) }),
      messageStatus: () => ok({ statuses: {} }),
      answer: () => ok(),
      workers: () => ok(),
      forgetTasks: () => ok()
    },
    channel: {
      ensure: (q = {}) => ok({ outboxes: (q.members || []).map((m) => ({ id: m.id, outbox: 'demo', guide: '' })) }),
      poll: () => ok({ deliveries: [], messages: [] }),
      ack: () => ok(),
      acks: () => ok(),
      hold: () => ok(),
      release: () => ok(),
      archive: () => ok()
    },

    // Native chat panes: the scripted one, and any the visitor opens.
    chat: {
      open: (opts = {}) => {
        const isNew = !chats.has(opts.paneId)
        const c = chatOf(opts.paneId, { agent: opts.agent || 'claude', model: opts.model || null })
        if (isNew) chatState(opts.paneId, 'idle')
        return ok({ agent: c.agent, sessionId: c.sessionId, launchToken: c.token, model: c.model })
      },
      history: ({ paneId } = {}) => {
        const c = chats.get(paneId)
        return c ? ok({ events: c.journal.map((item) => ({ ...item })), seq: c.seq, open: true, live: { status: c.status } }) : ok({ events: [], seq: 0, open: false })
      },
      onEvent: (fn) => subscribe(subs.chat, fn),
      approve: ({ paneId, requestId, decision } = {}) => {
        if (paneId !== chat.paneId || requestId !== approvalId) return ok()
        return Promise.resolve(answerApproval(decision))
      },
      approvalInput: () => ok({ input: { command: chat.command } }),
      send: (opts = {}) => Promise.resolve(sendChat(opts)),
      close: ({ paneId, forget } = {}) => {
        if (forget) {
          chats.delete(paneId)
          forgetState(paneId)
        }
        return ok()
      },
      interrupt: () => ok(),
      setOption: () => ok(),
      skills: () => ok({ skills: [] }),
      remoteAvailable: () => Promise.resolve(false)
    },

    // The invented project's files.
    explorer: {
      list: (q) => Promise.resolve(listDir(q)),
      listMany: (q = {}) => Promise.resolve({ ok: true, results: (q.dirs || []).map((dir) => ({ dir, ...listDir({ root: q.root, dir }) })) }),
      status: (q = {}) =>
        Promise.resolve(
          within(PROJECT.cwd, q.root)
            ? { ok: true, repo: true, files: Object.fromEntries(Object.entries(CHANGES).map(([p, s]) => [fullPath(p), s])) }
            : { ok: true, repo: false, files: {} }
        ),
      sparse: () => ok({ sparse: false, dirs: [] }),
      searchNames: (q = {}) => {
        const needle = String(q.query || '').toLowerCase()
        return ok({ results: Object.keys(files).filter((f) => f.toLowerCase().includes(needle)).map((f) => ({ path: fullPath(f), name: f.split('/').pop(), dir: false })), truncated: false })
      },
      searchContent: () => ok({ results: [], truncated: false }),
      watch: () => ok(),
      unwatch: () => ok(),
      onChanged: () => () => {}
    },
    listFiles: (root) => ok({ files: within(PROJECT.cwd, root) ? Object.keys(files) : [], truncated: false }),
    editor: {
      read: (file) => Promise.resolve(readFile(file)),
      stat: (file) => {
        const res = readFile(file)
        return Promise.resolve(res.ok ? { ok: true, size: res.size, mtimeMs: res.mtimeMs, sig: res.sig } : res)
      },
      write: (q = {}) => {
        const rel = fileOf(q.file)
        if (rel !== null && typeof q.text === 'string') files[rel] = q.text
        return ok({ sig: signature(q.text || ''), mtimeMs: Date.now() })
      },
      head: (file) => Promise.resolve(readFile(file)),
      watch: () => ok({ count: 0 }),
      onChanged: () => () => {},
      setDirtyCount: () => {},
      onConfirmClose: () => () => {},
      ackClose: () => {},
      closeWindow: () => {}
    },
    gitInfo: (cwd) => Promise.resolve(LOCAL_ROOTS.some((r) => within(r, cwd)) ? { isRepo: true, root: cwd, branch: GIT.branch, hasCommits: true } : { isRepo: false }),
    gitWorktrees: () => ok({ worktrees: [] }),
    scm: {
      status: (q = {}) => Promise.resolve(within(PROJECT.cwd, q.root) ? repoStatus() : { ok: true, repo: false }),
      history: () => ok({ items: script.commits, hasMore: false, limit: 50 }),
      branchCompare: () => ok({ commits: [], files: [] }),
      fileVersions: (q = {}) => {
        const rel = String(q.path || '').replaceAll('\\', '/')
        return ok({ original: ORIGINALS[rel] || '', modified: files[rel] || '', rel, full: fullPath(rel), exists: false, top: PROJECT.cwd })
      }
    }
  }

  // The scripted panes exist from the start: the window re-attaches to them.
  for (const id of Object.keys(script.agents)) addScriptedAgent(id)
  for (const [id, def] of Object.entries(script.shells)) addShell(id, { cwd: def.cwd })
  seedChat()

  return { api, start, stop, setPaused, terminals, states, boardRequests, script }
}
