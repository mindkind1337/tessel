// After Orca's src/shared/native-chat-session-options.ts (MIT, Copyright (c) 2026 Lovecast Inc.)
// The runtime part of the session-option types (the rest are types only).
//
// A descriptor: { id, label, description?, category?: 'model' | 'thought_level'
//   | 'model_config' | 'mode', kind: { type: 'select', currentValue?, choices:
//   [{ value, label, description? }] } | { type: 'boolean', currentValue },
//   valueSource: 'applied' | 'dispatched' | 'reported' | 'default' | 'unknown',
//   transport: 'catalog' | 'agent-session', settable, disabledReason?,
//   action?: { type: 'agent-picker' | 'toggle-command' } }.

// A value we typed at the agent and have never read back. Both lanes write
// `dispatched` on a set, so the source alone does not name one: the transport
// check limits the caption to the terminal, where reading the screen back is
// the only confirmation available.
export function sessionOptionDispatchUnconfirmed(descriptor) {
  return descriptor.valueSource === 'dispatched' && descriptor.transport === 'catalog'
}

// Display-only: labels a rendered value ('default' | 'unreported' | null) and
// never gates what is sent.
export function sessionOptionValueMarker(descriptor) {
  if (descriptor.valueSource === 'default') return 'default'
  return descriptor.valueSource === 'unknown' ? 'unreported' : null
}
