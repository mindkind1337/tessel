# Composer and session-option hooks

Reference: Orca native-chat hooks, MIT, Copyright (c) 2026 Lovecast Inc.
Vue adaptation for Tessel's text-only structured chat. No React, bridge or PTY
input. All hooks run in setup. Data options accept plain values, refs/computed
or getters, including a reactive options object. Callback options remain plain
functions (or refs to functions). DOM refs use `.value`.

## Composer wiring

1. `useNativeChatDraft(scopeKey)` returns `{draft, setDraft}`. `draft` is a ref;
   the setter accepts a string/updater and writes through the bounded scope
   cache. Pane switches synchronously restore their own text.
2. `useNativeChatCanSend(options)` returns a computed boolean. The old PTY-id
   argument is replaced by `{draft,disabled,disabledReason,sendBlockedReason,
   isSending}`. Starting blocks sending, not typing. Whitespace cannot send.
3. `useNativeChatStructuredComposerSend(options)` returns async
   `send(text, attachments=[])`; `send.isSending` is a ref. Supply `send(text)`
   or `structuredTransport.send(text)`, which MUST return `{ok:true}` to confirm.
   An empty/false/accepted-only reply is a refusal. The transport receives one
   text argument, no attachment payload. Any image attachments refuse the send.
   `setDraft`, `setCaret`, `clearSkillOrigin`, `clearImageAttachments` run only
   after confirmation and only if the submitted draft is unchanged. History
   records confirmed sends even if the user has already typed their next draft.
   Optional `onAccepted(text)` is the integration point for user takeover.
   Failures use `onError`, transport `onError`, or `setNotice`.
   Typed `/model value`, `/effort value` and `/permissionMode value` route
   through the same guarded `setOption` callback (direct or on the transport).
   Bare option commands invoke `onOptionCommand(name)` and require `{ok:true}`
   before clearing; missing callbacks preserve the draft rather than sending
   the command as prompt text. Pass the same permission guard inputs as below.
4. `useNativeChatComposerSubmit(options)` returns `{send,goalMode}`. Pass the
   confirmed sender as `sendStructured`, not the raw IPC callback. Goal mode
   exposes `active` (computed), `exit`, `interceptPick(pick)`. It exists only
   with explicit `structuredTransport.threadGoal.setObjective(objective)`;
   that optional callback also requires `{ok:true}`. Tessel currently supplies
   no goal controller. `/goal` remains ordinary agent text without one.
5. `useNativeChatComposerKeyDown(options)` returns a native event handler.
   Reference autocomplete/history setters are retained. Add reactive
   `isWorking` (or `busy`), `menuOpen`, `closeMenu`, `disabledReason`, and
   `sendBlockedReason`. Plain Enter sends, Shift+Enter stays native, modifier
   Enter does not send. IME composition, native `isComposing`, and keyCode 229
   never dispatch. IME Enter keeps its native default, matching Tessel's
   existing input. Escape first closes an open menu/autocomplete; it interrupts
   only a working agent. Already prevented events are ignored.
6. `useNativeChatComposerInterrupt(options)` returns the callback invoking
   `onStop()` only when working and no menu/autocomplete is open. It deliberately
   does not cancel Tessel's queued messages. No ESC bytes are written.
7. `useNativeChatTypedInsertion(options)` returns `{insertTypedText,focus}`.
   It uses the current input selection, resets history recall, and restores the
   caret after Vue updates. Disabled inputs, stale scopes and unmounts are
   respected. Supply draft/caret refs and the reference setter callbacks.
8. `useNativeChatComposerPaste(options)` returns `{handlePaste,pasteFromClipboard}`.
   Bind paste to the input/pane: every handled paste prevents rich HTML insertion
   and reads `text/plain` only. `insertTypedText(text)` owns the insertion.
   Menu paste uses injected `readClipboardText()` or `shellApi.readClipboard()`.
   Async reads recheck disabled/scope state. Image-only paste shows text-only
   notice; no image is saved/uploaded, even when attachment chips are enabled.
9. `useNativeChatComposerAttachments(options)` returns the reference chip and
   queue methods, with `imageAttachments` as a ref. `allowImages` defaults false.
   Resolved file paths insert as text (all paths, including image paths by
   default). An explicit opt-in retains pending/settled image chip state for
   future use, but the sender still refuses image payloads. Only settled chips
   are cached; previews are revoked and never cached. Connection/remote paths
   are excluded. IME insertions are bounded to 256 paths/256 KiB, preserve order,
   recheck the supplied `targetOwnerIsCurrent` and are discarded on scope or
   disabled transitions. Wire the previous lot's file-drop callback to this
   `attachResolvedPaths(paths, undefined, ownership)` method. Setters can be
   replaced by `insertTypedText(text)` for the editor's selection/undo behavior.
10. `useNativeChatSendLifecycle(paneId,sessionId,onPendingSendCanceled?)` tracks
    cancellable async handles with the original `cancelPendingSends` and
    `trackPendingSend(handle,id?)`. It cancels owned unfinished work on target
    changes/unmount. Settled promises, including rejected ones, are removed.
    Keep this distinct from the interrupt button's current-turn cancellation.
11. `useNativeChatComposerRevealFocus(options)` retains six deferred attempts
    with injectable `scheduleFrame`. Only visible, focused, ready composers
    claim focus. Existing editable focus, pointer/Tab intent and unmount win.

Always pass a stable reactive scope (`scopeKey`, `draftScopeKey`, `terminalTabId`
or `sessionId`) to async hooks. The common accessor invalidates work even after
a scope switch away and back. Mutation callbacks read current option values;
they are never evaluated as data getters.

## Catalog, picker and options

- `useNativeChatComposerCatalog(agent,transport)` returns computed
  `agentCommands` and `sessionSkillNames`. Session-reported catalogs, including
  empty ones, win. Fallback host actions are only offered when the callback or
  conversation capability is present; text-driven agent commands remain.
- `useNativeChatPickerState(options)` retains autocomplete, completion,
  dismissal, skill-origin classification and caret methods. `autocomplete` is
  computed; `listboxId` is a string. Supply the reference setters/input ref.
  Dismissals reset on pane/agent changes. `skillsOptions` injects discovery.
- `useNativeChatPickerCommandDispatch(options)` returns an async command handler.
  Supply `sendStructured` from the confirmed sender above. Bare model/effort/
  permissionMode picks call `onOptionCommand(name)` to open a UI picker; they
  never become prompt text. Other commands go through confirmed sending.
- `useNativeChatSessionOptionCommand(options)` returns `{dispatch,isDispatching,
  confirmedValues,modeBlocked}`. Dispatch accepts `{optionId,value}` or
  `/model value`, `/effort value`, `/permissionMode value`. Its injected
  `setOption({[optionId]:value})` MUST use Tessel's `ctx.chatSetOption` path and
  return `{ok:true}` before UI confirmation. Supply `values`/`permissionMode`
  for externally confirmed snapshots. Bind UI display to those snapshots or
  `confirmedValues`; never preemptively write the requested value to the leaf.
  `onConfirmed(optionId,value)` can update an integration-owned snapshot.
  `isDispatching`/`confirmedValues` are refs. Failure calls `setNotice`/`onError`.
  `modeBlocked` enforces `chatLaunchYolo`, `maxPermissions`, `agent`, and
  `isWorking`/`busy` (or leaf `node` for launch/cap/agent data). Claude's Auto and
  Yolo are blocked for manually capped workers; Codex supports Manual/Yolo only,
  and cannot enter Yolo mid-turn. The main process remains the authority.
- `useNativeChatSkills(agent,pane,enabled,options?)` returns refs
  `status,skills,error,errorKind` and `retry()`. `options.discover({agent,pane,
  refresh,signal})` supplies `{skills,sources}` from an existing local provider.
  No store/runtime service is invented. Missing provider/remote ownership is
  unavailable; discovery is lazy, cached per instance/context, retries with
  refresh, times out, and discards stale results. `contextKey` can distinguish
  changes within a pane, `timeoutMs` defaults to 18000. The reference's pure
  agent/source filtering is retained. Session-reported skill names work without
  a disk provider. Global host scan sharing remains the provider's concern.
- `useNativeChatContextUsageSummary(transport)` and
  `useStructuredAgentSessionContextUsage(journalItems,support)` return computed
  values using the reference pure summary/journal selector. Unknown is null;
  loaded facts take precedence over host facts for unloaded history.

## Source coverage and exclusions

Ported original keydown, send lifecycle, submit goal, pure skill-filter and
shared context-usage cases. Goal test callbacks now return Tessel's strict
`{ok:true}` instead of source booleans. The PTY submit case is excluded.
Attachments, paste, structured sender, catalog, picker dispatch, skill discovery
and option cases are adapted to local callback behavior and augmented with
Tessel guard tests. Remote/SSH/runtime upload and selection ownership cases,
PTY command delivery/confirmation observers, telemetry, mobile, and host RPC
context resolution are excluded. Clipboard image saving/thumbnail probes are
replaced by refusal/text-only tests. Markdown/component behavior is tested by
their component lots, not these hooks.

The optional composer app-menu selection hook is not added: no equivalent
Tessel app-menu selection event exists. Native select-all remains the editor's
responsibility. No PTY composer-send, interactive-send or paste-bridge is ported.

Added `lib/locale-text-collators.js` and corrected the one existing import in
`native-chat-picker-items.js`, with the lead's permission. Added strip-only
`shared/structured-agent-session-context-usage.js` and its original tests.
No other existing module, component or locale file is changed by this lot.

## New French keys

Eleven keys were sent to the lead, who added them to `fr/chat.json`:
`chat.orca.catalog.{model,effort,clear,compact}`,
`chat.orca.composer.{textOnly,sendRejected}`,
`chat.orca.options.{unsupported,unavailable,rejected}`,
`chat.orca.skills.{unavailable,timeout}`.
