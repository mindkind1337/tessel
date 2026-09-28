// Where review notes can go: App.vue registers the agent panes of the current
// workspace and how to deliver a message to one (its message queue, which
// never types into an agent that works or waits for an approval). Kept here,
// not provided through Vue, because note cards live in Monaco view zones.
//   targets() -> [{ id, label, stateLabel, disabledReason, hint }]
//   send(paneId, text, { onDelivered, onFailed }) -> void
let impl = null
export function setNotesDelivery(api) {
  impl = api
}
export function notesDelivery() {
  return impl
}
