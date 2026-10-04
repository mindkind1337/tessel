// @vitest-environment node
// Agents on an SSH host, end to end against a real sshd (REMOTE_AGENTS.md):
// skipped unless TESSEL_WSL_SMOKE=1. The host comes from TESSEL_WSL_HOST
// (default tessel-wsl-test), resolved with `ssh -G` from ~/.ssh/config
// (key authentication only). Run it alone:
//   TESSEL_WSL_SMOKE=1 npx vitest run src/main/remoteAgent/__tests__/remoteAgentsWsl.spec.js --maxWorkers=1
//
// 1. The real install: the Files session over the shared ssh2 connection
//    runs __t_ragent with the real shim (~/.tessel-server 0700, VERSION, the
//    install's JSON line, the Claude / Codex config written).
// 2. A remote-agent pane on the same connection, its remoteAgent built like
//    index.js does (real node, a copy of server.cjs, scratch project and
//    agent-state folders, random team secret, TESSEL_REMOTE=1).
// 3. In the pane: the env file is gone, the TESSEL_* variables are set; MCP
//    initialize + tools/list through the shim list the team tools; the hook
//    command the install wrote leaves an event file on this computer.
// 4. A wrong token and a closed pane's token are refused.
// 5. The ssh2 connection killed: the socket is bound again, hooks work again.
// The account's ~/.tessel-server, ~/.claude*, ~/.codex are moved aside first
// and put back after; everything this made is removed.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import crypto from 'crypto'
import { join, resolve as pathResolve } from 'path'
import { execFileSync } from 'child_process'
import { createSshHostBridge, validateSpec } from '../../ssh/sshHostBridge'
import { createSshRemote } from '../../ssh/sshRemote'
import { createRemoteFs } from '../../remoteFs'
import { createShimInstaller, remoteServerEnv, newRemoteToken, instanceName, shimVersion } from '../remoteAgentSetup'

const RUN = process.env.TESSEL_WSL_SMOKE === '1'
const SSH_HOST = process.env.TESSEL_WSL_HOST || 'tessel-wsl-test'
const HOST = 'ssh-wsl-smoke'
const SRC = pathResolve(__dirname, '..', '..')
const t = (_k, english, vars) => String(english).replace(/\{\{\s*(\w+)\s*\}\}/g, (m, n) => (vars && n in vars ? String(vars[n]) : m))

// The host from ~/.ssh/config (ssh -G). -> ssh2 spec fields
function resolveHost() {
  const out = execFileSync('ssh', ['-G', SSH_HOST], { encoding: 'utf8' })
  const get = (k) => (out.match(new RegExp(`^${k} (.+)$`, 'm')) || [])[1]
  const idf = String(get('identityfile') || '').replace(/^~(?=[\\/])/, os.homedir())
  return { host: get('hostname'), port: Number(get('port') || 22), username: get('user'), identityFile: idf }
}

// Plain ssh (setup, checks, cleanup): never through the code under test.
const sshRun = (command, input) => execFileSync('ssh', ['-T', '-o', 'BatchMode=yes', SSH_HOST, command], { encoding: 'utf8', input: input || '', stdio: ['pipe', 'pipe', 'pipe'] })

function until(fn, ms = 30000, label = '') {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const tick = () => {
      let v
      try {
        v = fn()
      } catch {
        v = null
      }
      if (v) return resolve(v)
      if (Date.now() - start > ms) return reject(new Error(`timed out waiting ${label || fn}`)) // i18n-ignore test
      setTimeout(tick, 50)
    }
    tick()
  })
}

const BACKUP = '.tessel-smoke-backup'
const SETUP = `set -e; cd "$HOME"
[ ! -e ${BACKUP} ] || { echo "a previous run left ${BACKUP}: restore it first" >&2; exit 3; }
mkdir -m 700 ${BACKUP}
for f in .tessel-server .claude.json .claude .codex tessel-smoke; do if [ -e "$f" ] || [ -L "$f" ]; then mv "$f" ${BACKUP}/; fi; done
: > ${BACKUP}/.complete
mkdir -p .claude .codex tessel-smoke`
// Only once SETUP moved everything aside (.complete): what this run made
// goes, the originals come back.
const TEARDOWN = `cd "$HOME"
[ -f ${BACKUP}/.complete ] || { echo "no complete backup: nothing removed" >&2; exit 3; }
pkill -u "$(id -u)" -f '[t]essel-shim[.]cjs' 2>/dev/null || true
rm -rf .tessel-server .claude.json .claude .codex tessel-smoke
rm -f ${BACKUP}/.complete
for f in ${BACKUP}/.[!.]* ${BACKUP}/*; do [ -e "$f" ] || [ -L "$f" ] || continue; mv "$f" .; done
rmdir ${BACKUP} && echo restored`

// The MCP exchange, run in the pane: initialize, initialized, tools/list,
// then a summary line of the tool names.
const MCP_SCRIPT = `#!/bin/sh
out="$HOME/tessel-smoke/mcp.out"
{
  printf '%s\\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}'
  sleep 2
  printf '%s\\n' '{"jsonrpc":"2.0","method":"notifications/initialized"}'
  printf '%s\\n' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
  sleep 4
} | node "$HOME/.tessel-server/bin/tessel-shim.cjs" mcp > "$out" 2> "$out.err"
echo "MCPRC=$?"
node -e '
const lines = require("fs").readFileSync(process.argv[1], "utf8").split("\\n").filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } })
const init = lines.find((m) => m && m.id === 1)
const list = lines.find((m) => m && m.id === 2)
const names = list && list.result && list.result.tools ? list.result.tools.map((x) => x.name) : []
console.log("INIT=" + (init && init.result ? "ok" : "none") + " TOOLS=" + names.join(","))
' "$out"
`

describe.skipIf(!RUN)('remote agents on a real sshd (WSL smoke test)', () => {
  let base
  let target
  let spec
  let bridge
  let ssh
  let rfs
  let install
  let stateDir
  let projectDir
  let script
  const logs = []
  const sent = []
  const panes = []
  let backedUp = false

  beforeAll(async () => {
    target = resolveHost()
    base = fs.mkdtempSync(join(os.tmpdir(), 'tessel-wsl-smoke-'))
    stateDir = join(base, 'agent-state')
    projectDir = join(base, 'project')
    fs.mkdirSync(stateDir)
    fs.mkdirSync(projectDir)
    script = join(base, 'server.cjs')
    fs.copyFileSync(join(SRC, 'teamMcp', 'server.cjs'), script)
    sshRun(SETUP)
    backedUp = true
    sshRun('cat > "$HOME/tessel-smoke/mcp.sh" && chmod 700 "$HOME/tessel-smoke/mcp.sh"', MCP_SCRIPT)
    sshRun('cat > "$HOME/tessel-smoke/stop.json"', JSON.stringify({ hook_event_name: 'Stop', session_id: 'smoke-session-1', stop_hook_active: false }))

    spec = { host: target.host, port: target.port, username: target.username, identityFiles: [target.identityFile], identitiesOnly: true, knownHostsFiles: [join(base, 'known_hosts')], strictHostKeyChecking: 'ask' }
    // The terminal host's pipe, in process (as remoteFsSsh2.spec.js).
    const sock = {
      destroyed: false,
      writableLength: 0,
      write: (line) => {
        ssh.onEvent(JSON.parse(line))
        return true
      },
      once() {}
    }
    bridge = createSshHostBridge({
      hostKeyFile: join(base, 'ssh-host-keys.json'),
      log: (level, msg) => logs.push(`${level} ${msg}`),
      broadcast: (m) => sock.write(JSON.stringify(m))
    })
    const host = {
      connected: true,
      features: { ssh: true },
      ensure: async () => ({}),
      request: async (op, body) => new Promise((resolve) => bridge.handle(sock, { op, ...body }, resolve)),
      send: (op, body) => bridge.handle(sock, { op, ...body }, () => {})
    }
    const hosts = {
      get: () => ({ id: HOST, label: 'WSL smoke', host: target.host }),
      sharedConnected: () => true,
      launchFor: () => ({ ok: false, error: 'the system ssh is not used here' }),
      paneStarted() {},
      paneConnected() {},
      paneClosing() {},
      paneExited() {},
      connectionState() {}
    }
    const send = (channel, payload) => {
      sent.push([channel, payload])
      if (channel === 'ssh:credential-request') setTimeout(() => ssh.submit({ paneId: payload.paneId, promptId: payload.promptId, value: payload.kind === 'hostkey' ? 'yes' : null }), 5)
    }
    ssh = createSshRemote({ host, hosts, send, t, resolver: { resolve: async () => ({ ok: true, spec }) } })
    rfs = createRemoteFs({ hosts, ssh, send })
  }, 120000)

  afterAll(async () => {
    for (const p of panes) {
      try {
        p.pty.kill()
      } catch {
        /* gone */
      }
    }
    await new Promise((r) => setTimeout(r, 500))
    if (rfs) rfs.close()
    if (bridge) bridge.shutdown()
    let restored = ''
    if (backedUp) restored = sshRun(TEARDOWN)
    expect(restored).toContain('restored')
    if (base) fs.rmSync(base, { recursive: true, force: true })
  }, 120000)

  const source = () => fs.readFileSync(join(SRC, 'remoteAgent', 'tessel-shim.cjs'), 'utf8')

  it('installs the shim through the Files session (real __t_ragent)', async () => {
    install = createShimInstaller({ install: (hostId, o) => rfs.installAgentShim(hostId, o), source: source() })
    const res = await install.ensure(HOST)
    expect(res.ok, JSON.stringify(res)).toBe(true)
    expect(res.result).toBeTruthy()
    const check = sshRun('stat -c "%a %U" "$HOME/.tessel-server" "$HOME/.tessel-server/bin" "$HOME/.tessel-server/run"; cat "$HOME/.tessel-server/bin/VERSION"; id -un')
    const lines = check.trim().split('\n')
    const me = lines[lines.length - 1]
    expect(lines.slice(0, 3)).toEqual([`700 ${me}`, `700 ${me}`, `700 ${me}`])
    expect(lines[3]).toBe(shimVersion(source()))
    const settings = JSON.parse(sshRun('cat "$HOME/.claude/settings.json"'))
    expect(JSON.stringify(settings.hooks.Stop)).toContain('tessel-shim.cjs')
    expect(sshRun('cat "$HOME/.codex/config.toml"')).toContain('[mcp_servers.tessel-team]')
  }, 120000)

  // A remote-agent pane as index.js prepareRemoteAgent makes it.
  function openPane(id) {
    const launch = crypto.randomBytes(16).toString('hex')
    const env = remoteServerEnv(process.env, {
      TESSEL_PANE_ID: id,
      TESSEL_TEAM_SECRET: crypto.randomBytes(32).toString('hex'),
      TESSEL_RUNTIME_DIR: base,
      TESSEL_AGENT_PROVIDER: 'claude',
      TESSEL_AGENT_LAUNCH: launch,
      TESSEL_AGENT_STATE_DIR: stateDir,
      TESSEL_PROJECT_DIR: projectDir,
      TESSEL_REMOTE: '1',
      TESSEL_REMOTE_HOST: 'WSL smoke'
    })
    const remoteAgent = { token: newRemoteToken(), instance: instanceName('tessel-smoke', HOST, 'feedfacefeedface'), provider: 'claude', env, node: process.execPath, script }
    const pty = bridge.createPty({
      hostId: HOST,
      spec: validateSpec(spec),
      texts: { label: 'wsl', lost: 'LOST-CONNECTION', reconnected: 'RECONNECTED-OK', gaveUp: 'GAVE-UP', codes: {} },
      cols: 200,
      rows: 50,
      paneId: id,
      remoteAgent
    })
    const out = { text: '', exit: null }
    pty.onData((d) => (out.text += d))
    pty.onExit((e) => (out.exit = e))
    const pane = { id, pty, out, remoteAgent }
    panes.push(pane)
    return pane
  }

  // The shell's prompt is up (after the title / colour sequences).
  const plain = (s) => s.replace(/\x1b\][^\x07]*\x07/g, '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
  const prompted = (pane, from = 0) => /[$#] $/.test(plain(pane.out.text.slice(from)))

  // Runs a command line in the pane; resolves with its output (after the
  // echo of the line itself) once `<mark>-2` is printed.
  let seq = 0
  async function inPane(pane, line, ms = 60000) {
    const mark = `SMOKE${++seq}`
    const from = pane.out.text.length
    pane.pty.write(`${line}; echo ${mark}-$((1+1))\n`)
    await until(() => pane.out.text.slice(from).includes(`${mark}-2`), ms, mark)
    const text = pane.out.text.slice(from)
    return text.slice(0, text.indexOf(`${mark}-2`))
  }

  let paneA
  it('opens an agent pane: env file gone, variables set', async () => {
    paneA = openPane('smoke-a')
    await until(() => bridge.tunnel.isBound(HOST), 60000, 'bound')
    await until(() => prompted(paneA), 30000, 'prompt')
    const out = await inPane(paneA, 'ls -A "$HOME/.tessel-server/run"; echo "PANE=$TESSEL_PANE_ID PROV=$TESSEL_AGENT_PROVIDER TOKLEN=${#TESSEL_REMOTE_TOKEN} SOCK=$TESSEL_REMOTE_SOCK"')
    expect(out).toContain(`PANE=smoke-a PROV=claude TOKLEN=64 SOCK=`)
    expect(out).toContain(`/.tessel-server/run/${paneA.remoteAgent.instance}.sock`)
    expect(out).not.toContain('smoke-a.env')
    expect(out).not.toContain(paneA.remoteAgent.token)
  }, 120000)

  it('MCP initialize + tools/list through the shim', async () => {
    const out = await inPane(paneA, 'sh "$HOME/tessel-smoke/mcp.sh"')
    expect(out).toContain('MCPRC=0')
    const tools = ((out.match(/TOOLS=([^\r\n]*)/) || [])[1] || '').split(',').filter(Boolean)
    expect(out).toContain('INIT=ok')
    expect(tools).toContain('team_send')
    expect(tools).toContain('team_inbox')
    // A remote pane has no browser tools on this computer (TESSEL_REMOTE).
    expect(tools.filter((n) => n.startsWith('browser_'))).toEqual([])
  }, 120000)

  const events = () => {
    try {
      return fs.readdirSync(join(stateDir, 'events'))
    } catch {
      return []
    }
  }
  async function runStopHook(pane) {
    const settings = JSON.parse(sshRun('cat "$HOME/.claude/settings.json"'))
    const cmd = settings.hooks.Stop.flatMap((g) => g.hooks || []).map((h) => h.command).find((c) => String(c).includes('tessel-shim.cjs'))
    expect(cmd).toBeTruthy()
    return inPane(pane, `${cmd} < "$HOME/tessel-smoke/stop.json"; echo "HOOKRC=$?"`)
  }

  it('the hook command the install wrote leaves an event file here', async () => {
    const before = events().length
    const out = await runStopHook(paneA)
    expect(out).toContain('HOOKRC=0')
    await until(() => events().length > before, 10000, 'event file')
    const ev = JSON.parse(fs.readFileSync(join(stateDir, 'events', events().find(Boolean)), 'utf8'))
    expect(ev).toMatchObject({ paneId: 'smoke-a', provider: 'claude', sessionId: 'smoke-session-1', event: 'Stop' })
  }, 120000)

  it('refuses a wrong token and a closed pane token', async () => {
    const shim = '"$HOME/.tessel-server/bin/tessel-shim.cjs"'
    const bad = await inPane(paneA, `TESSEL_REMOTE_TOKEN=${'0'.repeat(64)} node ${shim} mcp </dev/null; echo "BADRC=$?"`)
    expect(bad).toMatch(/bad-token/)
    expect(bad).toContain('BADRC=1')
    // A second pane, closed: its token no longer opens anything.
    const paneB = openPane('smoke-b')
    await until(() => prompted(paneB), 30000, 'pane b prompt')
    const tokenB = paneB.remoteAgent.token
    paneB.pty.kill()
    await until(() => paneB.out.exit, 10000, 'pane b exit')
    const closed = await inPane(paneA, `TESSEL_PANE_ID=smoke-b TESSEL_REMOTE_TOKEN=${tokenB} node ${shim} mcp </dev/null; echo "CLOSEDRC=$?"`)
    expect(closed).toMatch(/unknown-pane/)
    expect(closed).toContain('CLOSEDRC=1')
    // The pane A socket is still there (another pane on the host).
    expect(bridge.tunnel.isBound(HOST)).toBe(true)
  }, 120000)

  it('binds the socket again after the ssh2 connection is killed', async () => {
    const { client, release } = await bridge.manager.open(HOST, validateSpec(spec), 'exec', { command: 'true' })
    release()
    const forwardsBefore = logs.filter((l) => l.includes('remote agent socket bound')).length
    client._sock.destroy()
    await until(() => paneA.out.text.includes('RECONNECTED-OK'), 90000, 'pane reconnect')
    const back = paneA.out.text.lastIndexOf('RECONNECTED-OK')
    await until(() => bridge.tunnel.isBound(HOST) && logs.filter((l) => l.includes('remote agent socket bound')).length > forwardsBefore, 60000, 'rebound')
    await until(() => prompted(paneA, back), 30000, 'prompt again')
    const before = events().length
    const out = await runStopHook(paneA)
    expect(out).toContain('HOOKRC=0')
    await until(() => events().length > before, 10000, 'event file after reconnect')
    // The new shell's env file is gone too.
    const ls = await inPane(paneA, 'ls -A "$HOME/.tessel-server/run"')
    expect(ls).not.toContain('smoke-a.env')
  }, 180000)

  it('no token in a log line or a message', () => {
    const everything = [...logs, ...sent.map(([c, p]) => `${c} ${JSON.stringify(p)}`)].join('\n')
    for (const p of panes) expect(everything).not.toContain(p.remoteAgent.token)
  })
})
