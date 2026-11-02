// Live Share, on a guest's computer: a command the host's agent asks to run
// here (src/main/liveShare/guestCommand.js). The window asks the person on a
// card, and keeps what ran in sight (HostCommandsPanel.vue), with a way to stop it.
import { reactive } from 'vue'

const KEEP = 5

// deps: api() (shellApi.liveShare), approve(card) -> Promise<answer>,
// expire(cardId) (the card ends: the session did), allowed() (the setting).
export function createHostCommands({ api, approve, expire, allowed }) {
  const runs = reactive([])
  const find = (id) => runs.find((r) => r.id === id)

  async function onAsk(ask) {
    const a = api()
    if (!a || !ask || typeof ask.id !== 'string') return
    if (!allowed()) return a.commandAnswer({ id: ask.id, allow: false, off: true })
    const answer = await approve({
      kind: 'hostRun',
      cardId: ask.id,
      agentLabel: ask.agent,
      hostName: ask.host,
      project: ask.project,
      command: ask.command,
      explanation: ask.why,
      goal: ask.goal,
      own: false,
      info: null,
      disclaimers: [],
      actions: []
    })
    const yes = !!answer && answer.allow === true
    if (yes) {
      runs.push({ id: ask.id, hostName: ask.host, agent: ask.agent, command: ask.command, state: 'running', exitCode: null, output: '' })
      for (let i = 0; runs.length > KEEP && i < runs.length; ) {
        if (runs[i].state === 'running') i++
        else runs.splice(i, 1)
      }
    }
    const taken = await a.commandAnswer({ id: ask.id, allow: yes, block: !!(answer && answer.block), timedOut: !!(answer && answer.timedOut) })
    // Too late (the session ended behind the card): nothing ran.
    if (yes && taken === false) dismiss(ask.id)
  }

  function onRun(ev) {
    if (!ev || typeof ev.id !== 'string') return
    if (ev.state === 'gone') return expire(ev.id)
    const r = find(ev.id)
    if (!r) return
    r.state = String(ev.state || 'failed')
    r.exitCode = Number.isInteger(ev.exitCode) ? ev.exitCode : null
    r.output = String(ev.output || '')
  }

  // A window that reloaded while a command runs: it keeps a way to stop it.
  async function restore() {
    const running = await api()
      ?.commandRunning?.()
      .catch(() => null)
    // (Only a real run: an answer without its id is no command, and would show as an empty one.)
    if (!running || typeof running.id !== 'string' || find(running.id)) return
    runs.push({ id: running.id, hostName: running.host, agent: running.agent, command: running.command, state: 'running', exitCode: null, output: '' })
  }

  const stop = (id) => api()?.commandStop(id)
  function dismiss(id) {
    const i = runs.findIndex((r) => r.id === id)
    if (i >= 0) runs.splice(i, 1)
  }

  return { runs, onAsk, onRun, restore, stop, dismiss }
}
