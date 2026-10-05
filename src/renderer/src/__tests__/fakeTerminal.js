// A fake terminal for the agents' terminal tools' specs (not a spec itself).
import { createShellIntegration } from '../agentTerminal/screenRead'

// A terminal as executeStrategy.js sees it: rows of text, markers on rows,
// the shell's sequences fed to its shell integration.
export function fakeTerminal({ quality = 'none', prompt = 'PS C:\\p> ' } = {}) {
  const fns = { data: new Set(), input: new Set(), buf: new Set(), exit: new Set(), dispose: new Set() }
  const sub = (set) => (fn) => (set.add(fn), () => set.delete(fn))
  const rows = [prompt]
  const marker = () => ({ line: rows.length - 1, isDisposed: false, dispose() {} })
  const shell = createShellIntegration({ registerMarker: marker })
  let alt = false
  let exit = null
  const t = {
    rows,
    sent: [],
    written: [],
    shell,
    onData: sub(fns.data),
    onUserInput: sub(fns.input),
    onBufferChange: sub(fns.buf),
    onExit: sub(fns.exit),
    onDispose: sub(fns.dispose),
    registerMarker: marker,
    getOutput: (start, end) => rows.slice(start ? start.line : 0, end ? end.line + 1 : undefined).join('\n'),
    cursorLine: () => rows[rows.length - 1],
    cursorRow: () => rows.length - 1,
    isAltBuffer: () => alt,
    exitCode: () => exit,
    isDisposed: () => false,
    hasOutput: () => true,
    appCursorKeys: () => false,
    write: (d) => t.written.push(d),
    sendText(text) {
      t.sent.push(text)
      if (t.onSend) t.onSend(text)
    },
    // The program prints: the first piece continues the cursor's row.
    print(text) {
      const parts = String(text).split('\n')
      rows[rows.length - 1] += parts[0]
      for (const p of parts.slice(1)) rows.push(p)
      for (const fn of [...fns.data]) fn()
    },
    osc(seq) {
      shell.feed(seq)
      for (const fn of [...fns.data]) fn()
    },
    enterAlt() {
      alt = true
      for (const fn of [...fns.buf]) fn()
    },
    type() {
      for (const fn of [...fns.input]) fn()
    }
  }
  if (quality === 'rich') shell.feed('P;HasRichCommandDetection=True')
  if (quality === 'basic') shell.feed('A')
  return t
}

