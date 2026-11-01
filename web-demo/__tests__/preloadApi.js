// The real window.shellApi, as src/preload/index.js builds it: the preload is run with
// a stand-in for Electron, and what it exposes is read back. Nothing is parsed from the
// source, so a method added there is here by itself.
import { vi } from 'vitest'

// What each of its calls last spoke on: [channel, ...].
export const heard = []

// (A module runs once: the same API for every test of a file.)
let exposed = null
export async function loadPreloadApi() {
  if (exposed) return exposed
  vi.doMock('electron', () => ({
    contextBridge: {
      exposeInMainWorld: (_name, api) => {
        exposed = api
      }
    },
    ipcRenderer: {
      invoke: (channel) => {
        heard.push(channel)
        return Promise.resolve()
      },
      send: (channel) => void heard.push(channel),
      on: (channel) => void heard.push(channel),
      removeListener: () => {}
    },
    webUtils: { getPathForFile: () => '' },
    webFrame: { setZoomLevel: () => {} }
  }))
  await import('../../src/preload/index.js')
  vi.doUnmock('electron')
  return exposed
}

// Every leaf of an API: [{ path: 'chat.onEvent', kind: 'function' | 'boolean' ... }].
export function leaves(node, prefix = []) {
  const out = []
  for (const [key, value] of Object.entries(node)) {
    const path = [...prefix, key]
    if (value && typeof value === 'object') out.push(...leaves(value, path))
    else out.push({ path: path.join('.'), kind: typeof value })
  }
  return out
}

export const at = (root, path) => path.split('.').reduce((node, key) => node[key], root)
