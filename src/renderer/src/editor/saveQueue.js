// One save at a time per file (after Orca's editor-save-queue.ts, MIT,
// Copyright (c) 2026 Lovecast Inc.): a save asked while another is writing
// the same file waits for it, so two writes never race and the last one
// asked for is the last one on disk. Pure JS (tested without Monaco).
export function createSaveQueue() {
  const chains = new Map() // key -> the last queued save's promise

  // Run task() after the file's previous save (whatever its result).
  // -> task()'s result.
  function run(key, task) {
    const prev = chains.get(key) || Promise.resolve()
    const next = prev.catch(() => undefined).then(() => task())
    const tracked = next.then(
      () => undefined,
      () => undefined
    )
    chains.set(key, tracked)
    tracked.then(() => {
      if (chains.get(key) === tracked) chains.delete(key)
    })
    return next
  }

  // Resolves once every save queued so far for this file has finished.
  function idle(key) {
    return chains.get(key) || Promise.resolve()
  }

  const busy = (key) => chains.has(key)

  return { run, idle, busy }
}
