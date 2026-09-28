// Monaco is loaded the first time an editor pane needs it (a separate chunk,
// so Tessel's startup bundle does not grow). Every caller shares one load.
let loading = null
let loaded = null

export function loadMonaco() {
  if (!loading) {
    loading = import('./monacoSetup.js').then((m) => {
      loaded = m.monaco
      return loaded
    })
    // A failed load (a missing chunk) can be tried again.
    loading.catch(() => {
      loading = null
    })
  }
  return loading
}

// Monaco when it is already loaded, else null.
export function monacoIfLoaded() {
  return loaded
}
