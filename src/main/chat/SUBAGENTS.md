# Subagent events

The main-process normalizers observe provider frames; they do not start agents,
answer approvals, or change session permissions.

`subagents` is a full roster snapshot:

```json
{"type":"subagents","groupId":"root-turn","agents":[{"id":"child","label":"Inspect fixtures","state":"working","startedAt":1000}]}
{"type":"assistantDelta","messageId":"child-message","text":"Reading","agentId":"child","parentToolUseId":"spawn-tool"}
{"type":"subagents","groupId":"root-turn","agents":[{"id":"child","label":"Inspect fixtures","state":"completed","tokens":25,"startedAt":1000,"settledAt":1500}]}
```

The journal persists these snapshots and provenance unchanged for replay,
except `subagent` `progress` events that carry a `tool` (tool-level progress
is live only; replay rebuilds the roster from snapshots and start/end).

Snapshot volume: a snapshot is sent at once on a child's start, end and any
state change, and on description/type/model changes. A working child's
token- or duration-only change is throttled to one `progress` event and one
group snapshot per second per group (`SUBAGENT_THROTTLE_MS`); a held-back
change is carried by the group's next snapshot, which the adapters' timer
(`tracker.deliverTo`) sends once the window has passed, so the latest
metrics always arrive (and the end snapshot always has them). Consumers must
therefore read tokens from snapshots or `end`, not expect one `progress` per
provider update. Snapshot labels are at most 120 characters (with the
` (2)` suffix for duplicates); `subagent` events keep the full description.
`subagent` events additionally carry `phase` (`start`, `progress`, `end`),
`id`, `groupId`, `status`, and observed description/type/model, timestamps,
duration, token total, or tool update. Missing provider metrics remain absent.
Tokens are the latest reported total, never a sum of successive snapshots.
Times are local observation times in epoch milliseconds.

Claude ids are Task/Agent tool-use ids; background task ids alias to them.
Groups use the root command UUID when observed, otherwise its first assistant
message id. Codex ids are child thread ids; groups use the spawning turn id
(parent item id only when no turn id is available). Known children retain their
original group on late updates. A parent Task/Agent or collab call remains a
regular tool row. Child content adds `agentId` and `parentToolUseId`.
Codex child item ids (tool ids, message ids) are namespaced as
`<agentId>:<itemId>` so they never meet the parent's or a sibling's ids;
Claude rows are keyed by agentId + messageId in the session.

Until the chat UI groups children, the renderer's reducer (`chatModel.js`)
drops `assistantDelta`, `assistant` and `thinking` events that carry an
`agentId`, so a child's text never reads as the main agent's reply (also in a
worker's `team_worker_read` transcript). Child `tool`/`toolResult` rows are
shown as before. The events themselves are still emitted and journaled.

At the parent's turn end, open tools with an `agentId` are not swept (a
background child goes on); they are closed when their child's `end` event
arrives, or when the process stops. Child message merge state is kept too.

Only `working` is in flight. `idle`, `completed`, `failed`, and `stopped` are
latched. `unverifiable` can be corrected by an authoritative terminal status,
but never returns to `working`. At parent turn end, remaining working children
become `stopped` on interruption, otherwise `unverifiable`. For Codex this
covers the ended turn's group and every child first seen while that turn was
open, whatever its group. Process exit also settles all leftovers.

In Manual, a linked Codex child's `thread/settings/updated` is checked like the
parent's (`manualPostureProblem`): a mismatch interrupts and closes the chat. A completed spawn/wait *call* alone does not complete a child.
Resuming an already settled child does not reopen its original roster entry.

Tracking is bounded to 32 groups, 64 children per group, 128 recent tools per
child, 512-character identifiers/labels/metadata, and 4096 Claude aliases,
stream ids and background ids. Old tracker groups are evicted in insertion
order; already journaled snapshots remain historical records.

## Validation and protocol sources

`__tests__/subagents.spec.js` contains synthetic, non-private fixtures. The
Codex shapes follow the locally generated app-server v2 `ThreadItem.ts`,
`CollabAgentTool.ts`, `CollabAgentStatus.ts`, and `SubAgentActivityKind.ts`
schemas examined in the chat spike. Supported items are
`collabAgentToolCall` (spawnAgent/sendInput/resumeAgent/wait/closeAgent and
related tools) and `subAgentActivity`, plus notifications for explicitly linked
child threads. Unlinked thread traffic is ignored. Claude fixtures use
stream-json Task/Agent blocks, `parent_tool_use_id`, tool results and system
`task_started`, `task_updated`, `task_progress`, `task_notification` frames.
Task notifications without a known tool id cannot establish canonical identity
and are ignored; unrelated task kinds do not create subagents.

No real agents were launched to generate these fixtures. The existing recorded
provider fixtures remain unchanged. The sessions spec verifies child message
isolation, journal persistence, replay, and provenance on unfinished tools.
