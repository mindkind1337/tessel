// Running one command line in a terminal pane and knowing when it is done,
// for the agents' run_in_terminal (agentTerminalTargets.js).
//
// Ported from Visual Studio Code's chat terminal tools. Copyright (c)
// Microsoft Corporation. Licensed under the MIT License
// (https://github.com/microsoft/vscode/blob/main/LICENSE.txt):
// src/vs/workbench/contrib/terminalContrib/chatAgentTools/browser/
// executeStrategy/{executeStrategy,richExecuteStrategy,basicExecuteStrategy,
// noneExecuteStrategy,strategyHelpers}.ts and tools/monitoring/outputMonitor.ts.
// Three strategies, by what the shell reports (its shell integration):
// - rich: the shell reports each command's end reliably (OSC 633 with
//   HasRichCommandDetection): done when it says so;
// - basic: it reports command ends that may misfire: done at the end event
//   followed by a short idle on the prompt, or a longer idle on the prompt;
// - none: no reports: done after the output idles and the cursor's line looks
//   like a prompt, or after a longer wait.
// Events instead of VS Code's services: the terminal adapter `t` (made by
// TerminalPane.vue, faked in the tests):
//   onData(fn) -> off              output written to the terminal
//   onUserInput(fn) -> off         the user typed in it
//   registerMarker() -> marker     at the cursor ({ line, isDisposed, dispose, onDispose })
//   getOutput(start, end) -> text  screen text between two markers
//   cursorLine() -> text           the cursor's line up to the cursor
//   isAltBuffer(), onBufferChange(fn) -> off
//   shell: createShellIntegration() (screenRead.js)
//   sendText(text)                 the line, then Enter on its own
//   write(data)                    raw keys
//   exitCode() -> number | null, onExit(fn) -> off, isDisposed(), onDispose(fn) -> off
import { detectsCommonPromptPattern, stripCommandEchoAndPrompt, inputNeeded } from '../../../shared/terminalOutput'

export const IDLE_POLL_MS = 1000

// A bag of things to undo at the end of a run.
export function createStore() {
  const fns = []
  let disposed = false
  return {
    add(fn) {
      if (typeof fn !== 'function') return fn
      if (disposed) fn()
      else fns.push(fn)
      return fn
    },
    timer(fn, ms) {
      const id = setTimeout(fn, ms)
      this.add(() => clearTimeout(id))
      return id
    },
    get isDisposed() {
      return disposed
    },
    dispose() {
      disposed = true
      for (const fn of fns.splice(0)) {
        try {
          fn()
        } catch {
          // already gone
        }
      }
    }
  }
}

// A timer that can be (re)scheduled and cancelled (VS Code's RunOnceScheduler).
function scheduler(store, fn, ms) {
  let id = null
  const cancel = () => {
    if (id != null) clearTimeout(id)
    id = null
  }
  store.add(cancel)
  return {
    schedule(delay = ms) {
      cancel()
      if (!store.isDisposed) id = setTimeout(() => ((id = null), fn()), delay)
    },
    cancel
  }
}

// Resolves once no output came for `ms`.
export function waitForIdle(t, ms) {
  return new Promise((resolve) => {
    const store = createStore()
    const s = scheduler(
      store,
      () => {
        store.dispose()
        resolve()
      },
      ms
    )
    store.add(t.onData(() => s.schedule()))
    s.schedule()
  })
}

// Resolves when the terminal is idle on a prompt after a command ran
// (VS Code's trackIdleOnPrompt): the shell's A after its C or D, then
// `idleMs` without output; fallbacks when the sequences never come.
export function trackIdleOnPrompt(t, idleMs, store, promptFallbackMs = 1000, { disableFallbacks = false } = {}) {
  return new Promise((resolve) => {
    let state = 'initial' // initial | prompt | executing | promptAfterExecuting
    const done = scheduler(store, () => resolve(), idleMs)
    const promptFallback = scheduler(
      store,
      () => {
        if (state === 'executing' || state === 'promptAfterExecuting') return
        state = 'promptAfterExecuting'
        done.schedule()
      },
      promptFallbackMs
    )
    const initialFallback = scheduler(
      store,
      () => {
        if (state === 'executing' || state === 'promptAfterExecuting') return
        state = 'promptAfterExecuting'
        done.schedule()
      },
      10000
    )
    if (!disableFallbacks) initialFallback.schedule()
    const executingFallback = scheduler(
      store,
      () => {
        if (state !== 'executing') return
        state = 'promptAfterExecuting'
        done.schedule()
      },
      30000
    )
    const hardCap = scheduler(
      store,
      () => {
        if (state !== 'initial' && state !== 'prompt') return
        state = 'promptAfterExecuting'
        done.schedule()
      },
      60000
    )
    if (!disableFallbacks) hardCap.schedule()
    store.add(
      t.shell.onSequence((type) => {
        if (type === 'A') {
          if (state === 'initial') state = 'prompt'
          else if (state === 'executing') {
            state = 'promptAfterExecuting'
            executingFallback.cancel()
          }
        } else if (type === 'C' || type === 'D') {
          state = 'executing'
          if (!disableFallbacks) executingFallback.schedule()
        }
      })
    )
    store.add(
      t.onData(() => {
        initialFallback.cancel()
        if (state === 'promptAfterExecuting') {
          promptFallback.cancel()
          executingFallback.cancel()
          done.schedule()
        } else {
          done.cancel()
          if (state === 'initial' || state === 'prompt') {
            if (!disableFallbacks) promptFallback.schedule()
          } else {
            promptFallback.cancel()
            if (!disableFallbacks) executingFallback.schedule()
          }
        }
      })
    )
  })
}

// After the output idles, the cursor's line must look like a prompt; else
// wait more, up to `extendedMs` (VS Code's waitForIdleWithPromptHeuristics).
export async function waitForIdleWithPromptHeuristics(t, intervalMs, extendedMs) {
  await waitForIdle(t, intervalMs)
  const start = Date.now()
  while (Date.now() - start < extendedMs) {
    if (detectsCommonPromptPattern(t.cursorLine())) return { detected: true }
    await waitForIdle(t, Math.max(1, Math.min(intervalMs, extendedMs - (Date.now() - start))))
  }
  return { detected: detectsCommonPromptPattern(t.cursorLine()) }
}

function altBufferPromise(t, store) {
  return new Promise((resolve) => {
    if (t.isAltBuffer()) return resolve()
    store.add(t.onBufferChange(() => t.isAltBuffer() && resolve()))
  })
}
const once = (subscribe, store) => new Promise((resolve) => store.add(subscribe((v) => resolve(v))))

// Sends the line and waits for it to be done. opts:
//   idlePollMs, cancelled (a promise that resolves when the run is stopped),
//   hasUserInput() -> bool: the user typed in this terminal since it was
//   last used (their line is cleared first, Ctrl+U), onStartMarker(marker),
//   syncMode: no fallbacks that give up on a command still running.
// -> { output, exitCode, additionalInformation, didEnterAltBuffer, strategy, startMarker }
export async function executeCommand(t, commandLine, opts = {}) {
  const idle = opts.idlePollMs || IDLE_POLL_MS
  const store = createStore()
  const strategy = t.shell.quality()
  try {
    if (t.isDisposed()) throw new Error('The terminal was closed')
    const exit = t.exitCode()
    if (exit != null) return { output: undefined, exitCode: exit, additionalInformation: `Command exited with code ${exit}`, strategy } // i18n-ignore
    const cancelled = opts.cancelled ? opts.cancelled.then(() => ({ type: 'cancelled' })) : new Promise(() => {})
    const disposed = once((fn) => t.onDispose(fn), store).then(() => ({ type: 'disposal' }))
    const exited = once((fn) => t.onExit(fn), store).then((code) => ({ type: 'processExit', exitCode: Number.isInteger(code) ? code : undefined }))
    const altBuffer = altBufferPromise(t, store).then(() => ({ type: 'alternateBuffer' }))

    // A command still running from before: its end must not be taken for
    // ours (VS Code filters it by its marker).
    let stale = t.shell.executing() ? 1 : 0
    const ours = (fn) => (c) => {
      if (stale > 0) {
        stale--
        return
      }
      fn(c)
    }
    let done
    if (strategy === 'rich') {
      const finished = new Promise((resolve) => store.add(t.shell.onCommandFinished(ours((c) => resolve({ type: 'success', command: c })))))
      done = Promise.race([finished, cancelled, disposed, exited])
    } else if (strategy === 'basic') {
      const idlePrompt = trackIdleOnPrompt(t, idle, store, idle)
      const finished = new Promise((resolve) => store.add(t.shell.onCommandFinished(ours((c) => resolve(c))))).then((c) => idlePrompt.then(() => ({ type: 'success', command: c })))
      done = Promise.race([finished, cancelled, disposed, exited, trackIdleOnPrompt(t, idle * 3, store, idle).then(() => ({ type: 'idle' }))])
    }

    // Quiet before typing; the user's own line cleared (Ctrl+U), or the
    // command still running interrupted (Ctrl+C), as VS Code does.
    await waitForIdle(t, strategy === 'rich' ? Math.min(idle, 300) : idle)
    if (opts.hasUserInput && opts.hasUserInput()) {
      t.write(t.shell.executing() ? '\x03' : '\x15')
      await waitForIdle(t, 100)
    }
    const startMarker = t.registerMarker()
    if (opts.onStartMarker) opts.onStartMarker(startMarker)
    const startLine = startMarker ? startMarker.line : -1
    t.sendText(commandLine)

    let result
    if (strategy === 'none') {
      // The cursor leaves the start line, then idle with a prompt in sight.
      await Promise.race([
        new Promise((resolve) => {
          const off = t.onData(() => {
            if (startMarker && startMarker.line !== startLine) return resolve()
            const line = t.cursorRow ? t.cursorRow() : null
            if (line != null && line > startLine) resolve()
          })
          store.add(off)
        }),
        new Promise((r) => store.timer(r, 1000))
      ])
      result = await Promise.race([waitForIdleWithPromptHeuristics(t, idle, idle * 10).then(() => ({ type: 'idle' })), cancelled, disposed, exited, altBuffer])
    } else {
      result = await Promise.race([done, altBuffer])
    }
    if (result.type === 'cancelled') return { output: t.getOutput(startMarker, null), exitCode: undefined, cancelled: true, strategy, startMarker }
    if (result.type === 'disposal') throw new Error('The terminal was closed')
    if (result.type === 'alternateBuffer') return { output: undefined, exitCode: undefined, error: 'alternateBuffer', didEnterAltBuffer: true, strategy, startMarker }
    if (result.type !== 'processExit') await waitForIdle(t, strategy === 'rich' ? Math.min(idle, 300) : idle)

    const info = []
    let output
    const command = result.type === 'success' ? result.command : null
    if (command && command.executedMarker && command.endMarker && !command.executedMarker.isDisposed) output = t.getOutput(command.executedMarker, command.endMarker)
    if (output === undefined) output = t.getOutput(startMarker, null)
    output = stripCommandEchoAndPrompt(output, commandLine)
    if (startMarker && (startMarker.isDisposed || startMarker.line < 0)) info.push('Output exceeded terminal scrollback; beginning of output was lost') // i18n-ignore
    if (!output.trim()) info.push('Command produced no output') // i18n-ignore
    let exitCode = command ? command.exitCode : undefined
    if (exitCode == null && result.type === 'processExit') exitCode = result.exitCode
    if (Number.isInteger(exitCode) && exitCode > 0) info.push(`Command exited with code ${exitCode}`) // i18n-ignore
    return { output, exitCode: Number.isInteger(exitCode) ? exitCode : undefined, additionalInformation: info.length ? info.join('\n') : undefined, strategy, startMarker }
  } finally {
    store.dispose()
  }
}

// Watches a running command for a question (VS Code's OutputMonitor, in
// short): each time the output idles, the cursor's line is checked. ->
// Promise<'input' | 'sensitive'>, never resolves when nothing asks; stop()
// ends the watch. A key the user types meanwhile resets it (they answer).
export function watchForInput(t, { command = '', idlePollMs = IDLE_POLL_MS } = {}) {
  const store = createStore()
  let typed = false
  store.add(t.onUserInput(() => (typed = true)))
  const promise = new Promise((resolve) => {
    let last = null
    const check = scheduler(
      store,
      () => {
        if (store.isDisposed) return
        if (typed) {
          typed = false
          return
        }
        const line = t.cursorLine()
        if (line === last) return
        const kind = inputNeeded(line, { command, running: t.shell.quality() === 'none' ? null : t.shell.executing() })
        if (kind) {
          last = line
          resolve(kind)
        }
      },
      idlePollMs
    )
    store.add(t.onData(() => check.schedule()))
    check.schedule()
  })
  return { promise, stop: () => store.dispose() }
}
