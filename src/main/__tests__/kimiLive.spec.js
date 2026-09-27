// @vitest-environment node
// Explicit opt-in only: real Kimi executable, disposable home, loopback model.
// No login, real API or real user configuration is used by this integration test.
import { describe, it, expect, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import http from 'http'
import { spawn } from 'child_process'
import { join, resolve, sep } from 'path'
import { installKimiHooks } from '../teamInstall'
import { validateKimiConfig } from '../kimiHooks'
import { ensureTeamChannel, pollTeamChannel } from '../teamChannel'
import { writeCurrentTeams } from '../teamNotices'
import { setJsonAgentServer, teamToolsEntry } from '../jsonAgents'

const executable = process.env.TESSEL_TEST_KIMI_EXE
describe.skipIf(!executable)('actual Kimi Code hooks against a local model', () => {
  it.each([false, true])(
    'validates TOML and delivers one Stop continuation into the actual agent loop (MCP=%s)',
    async (withMcp) => {
      const home = fs.mkdtempSync(join(os.tmpdir(), 'tessel-kimi-live-'))
      const project = join(home, 'project')
      const kimiHome = join(home, 'kimi-home')
      fs.mkdirSync(project)
      fs.mkdirSync(kimiHome)
      const requests = []
      const sender = { id: 'claude', num: 1, title: 'Claude' }
      const receiver = { id: 'kimi-live', num: 2, title: 'Kimi' }
      const teamId = 'team-live'
      const channel = ensureTeamChannel({ dir: project, teamId, members: [sender, receiver] })
      writeCurrentTeams({
        dir: project,
        panes: { claude: { team: teamId, num: 1 }, 'kimi-live': { team: teamId, num: 2 } }
      })
      const message = 'KIMI-STOP-LOCAL-TEST: confirm you received this team message.'
      const api = http.createServer((req, res) => {
        let body = ''
        req.on('data', (chunk) => {
          body += chunk
        })
        req.on('end', () => {
          if (!req.url.endsWith('/chat/completions')) {
            res.writeHead(404)
            res.end()
            return
          }
          requests.push(JSON.parse(body))
          if (requests.length === 1) {
            fs.writeFileSync(
              join(channel.outboxes[0].outbox, 'test.json'),
              JSON.stringify({ to: '#2', text: message })
            )
            pollTeamChannel({ dir: project, teamId })
          }
          const sendTool =
            withMcp && requests.length === 1
              ? requests[0].tools?.find((t) => t.function?.name?.endsWith('team_send'))
              : null
          const text =
            requests.length === (withMcp ? 3 : 2) ? 'Team message received.' : 'First answer.'
          const base = {
            id: 'chatcmpl-test',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'gpt-4o'
          }
          res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' })
          if (sendTool) {
            res.write(
              `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call-team-test', type: 'function', function: { name: sendTool.function.name, arguments: JSON.stringify({ to: '#1', text: 'KIMI-MCP-ID-OK' }) } }] }, finish_reason: null }] })}\n\n`
            )
            res.write(
              `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`
            )
            res.end('data: [DONE]\n\n')
            return
          }
          res.write(
            `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] })}\n\n`
          )
          res.write(
            `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`
          )
          res.end('data: [DONE]\n\n')
        })
      })
      await new Promise((done) => api.listen(0, '127.0.0.1', done))
      try {
        const original = `default_model = "test"\n[providers.local]\ntype = "openai"\nbase_url = "http://127.0.0.1:${api.address().port}/v1"\napi_key = "local-test-only"\n[models.test]\nprovider = "local"\nmodel = "gpt-4o"\nmax_context_size = 32000\n`
        const file = join(kimiHome, 'config.toml')
        fs.writeFileSync(file, original)
        expect(await validateKimiConfig(original, executable)).toEqual({ ok: true })
        // Exercise the same executable lookup used by team:install on Windows.
        if (
          process.platform === 'win32' &&
          resolve(executable) === resolve(join(os.homedir(), '.kimi-code', 'bin', 'kimi.exe'))
        )
          expect(await validateKimiConfig(original)).toEqual({ ok: true })
        expect((await validateKimiConfig('hooks = "wrong-shape"', executable)).ok).toBe(false)
        const script = join(__dirname, '..', 'teamMcp', 'server.cjs')
        if (withMcp) {
          vi.stubEnv('KIMI_CODE_HOME', kimiHome)
          const entry = teamToolsEntry('kimi', script)
          expect(entry.env).toBeUndefined()
          expect(setJsonAgentServer('kimi', 'tessel-team', entry, home).ok).toBe(true)
        }
        expect(
          await installKimiHooks(script, home, {
            kimiHome,
            validate: (text) => validateKimiConfig(text, executable)
          })
        ).toEqual({ changed: true })
        expect(fs.readFileSync(file + '.before-tessel', 'utf8')).toBe(original)
        const result = await new Promise((done, reject) => {
          const child = spawn(
            executable,
            ['-p', 'Reply with a short answer.', '--output-format', 'stream-json'],
            {
              cwd: project,
              windowsHide: true,
              env: {
                ...process.env,
                KIMI_CODE_HOME: kimiHome,
                TESSEL_PROJECT_DIR: project,
                TESSEL_PANE_ID: receiver.id,
                TESSEL_SESSIONS_DIR: join(home, 'reports'),
                NO_PROXY: '127.0.0.1,localhost'
              }
            }
          )
          let stdout = '',
            stderr = ''
          const timeout = setTimeout(() => {
            child.kill()
            reject(new Error('Isolated Kimi did not finish within 45 seconds.'))
          }, 45000)
          child.stdout.on('data', (data) => {
            stdout += data
          })
          child.stderr.on('data', (data) => {
            stderr += data
          })
          child.once('error', (error) => {
            clearTimeout(timeout)
            reject(error)
          })
          child.once('close', (code) => {
            clearTimeout(timeout)
            done({ code, stdout, stderr })
          })
          child.stdin.end()
        })
        expect(result.code, JSON.stringify(result)).toBe(0)
        if (withMcp)
          expect(requests[0].tools.map((t) => t.function.name)).toEqual(
            expect.arrayContaining([expect.stringMatching(/team_send$/)])
          )
        expect(requests.length, JSON.stringify(result)).toBe(withMcp ? 3 : 2)
        expect(JSON.stringify(requests[0].messages)).not.toContain(message)
        expect(JSON.stringify(requests.at(-1).messages)).toContain(message)
        expect(result.stdout).toContain('Team message received.')
        const report = JSON.parse(fs.readFileSync(join(home, 'reports', 'kimi-live.json'), 'utf8'))
        expect(report.agent).toBe('kimi')
        expect(report.sessionId).toBeTruthy()
        const ackDir = join(project, '.tessel', 'team-channel', teamId, 'acks')
        expect(fs.readdirSync(ackDir).filter((n) => n.endsWith('.json'))).toHaveLength(1)
        if (withMcp) {
          pollTeamChannel({ dir: project, teamId })
          const state = JSON.parse(
            fs.readFileSync(join(project, '.tessel', 'team-channel', teamId, 'state.json'), 'utf8')
          )
          expect(state.messages.find((m) => m.text === 'KIMI-MCP-ID-OK')).toMatchObject({
            fromId: receiver.id,
            toId: sender.id
          })
        }
      } finally {
        vi.unstubAllEnvs()
        api.closeAllConnections()
        await new Promise((done) => api.close(done))
        const target = resolve(home)
        if (!target.startsWith(resolve(os.tmpdir()) + sep) || !target.includes('tessel-kimi-live-'))
          throw new Error('Unexpected cleanup path')
        fs.rmSync(target, { recursive: true, force: true })
      }
    },
    90000
  )
})
