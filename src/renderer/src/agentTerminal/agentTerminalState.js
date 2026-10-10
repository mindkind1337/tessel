// Which agent uses which terminal now (the pane's "Ada is using this
// terminal · Stop" badge) and what agents ran in each terminal (the badge's
// log), from src/main/agentTerminal.js's events. Kept until the window
// reloads; the main process also keeps a log file.
import { reactive } from 'vue'

export const LOG_KEEP = 50

// paneId -> { agent, agentPane } while an agent uses it
export const terminalControl = reactive({})
// paneId -> [{ at, agent, kind: 'run' | 'keys' | 'read', text, yolo }] (yolo: ran without a card, its agent in Yolo)
export const terminalLog = reactive({})

export function onTerminalControl(ev) {
  if (!ev || typeof ev.paneId !== 'string') return
  if (ev.active) terminalControl[ev.paneId] = { agent: String(ev.agent || '').slice(0, 60), agentPane: String(ev.agentPane || '') }
  else delete terminalControl[ev.paneId]
}

export function onTerminalLog(ev) {
  if (!ev || typeof ev.paneId !== 'string') return
  const list = terminalLog[ev.paneId] || (terminalLog[ev.paneId] = [])
  list.push({ at: Number(ev.at) || Date.now(), agent: String(ev.agent || '').slice(0, 60), kind: ev.kind === 'keys' || ev.kind === 'read' ? ev.kind : 'run', text: String(ev.text || '').slice(0, 2000), yolo: ev.yolo === true })
  if (list.length > LOG_KEEP) list.splice(0, list.length - LOG_KEEP)
}

export function forgetTerminal(paneId) {
  delete terminalControl[paneId]
  delete terminalLog[paneId]
}
