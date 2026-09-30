# Chat questions

This changes the main-process question/answer transport. The Vue card and its
renderer projection are integrated separately. It does not change approval
handling, launch arguments, permission modes, sandbox policy or auto-review.
No real agent was started for development or verification.

## Renderer contract

`chat:event` carries this journaled event (all displayed strings are plain text):

```js
{
  type: 'question',
  requestId: 'question_<uuid>',
  status: 'pending',
  questions: [{
    id: 'q0',
    header: 'Format',
    question: 'Which format?',
    multiSelect: false,
    options: [{ id: 'o0', label: 'Summary', description: 'Brief overview' }],
    freeTextQuestionId: 'q0' // present only when free text is accepted
  }]
}
```

Use `shellApi.chat.answer({paneId, requestId, answers})`, where `answers` is:

```js
[{ questionId: 'q0', optionIds: ['o0'] }]
// Or, if freeTextQuestionId is present:
[{ questionId: 'q0', optionIds: [], other: 'My own answer' }]
```

Every question must be answered exactly once. The main process validates both
the IPC request and the provider adapter's response against the stored questions:
unknown or duplicate question/option ids, empty/incomplete answers, unsupported
free text, oversized values, and multiple choices for a single-select question
are rejected. For single-select, an option plus free text is also rejected.
Option labels may be identical: their positional ids remain distinct.
Extra renderer fields cannot change the stored questions or provider input.

Explicit cancellation uses `shellApi.chat.answer({paneId, requestId, cancel:true})`
without `answers`. It never turns into a selected default. Replies return
`{ok:true}` or `{ok:false, code, error}`. Invalid answers leave the request pending;
failed writes cancel it, since replaying an ambiguously delivered response would
be unsafe. Double clicks while a write is pending are refused.

Each request settles once with a journaled event:

```js
{ type: 'questionStatus', requestId, status: 'answered', answers }
{ type: 'questionStatus', requestId, status: 'cancelled' }
```

`chat:history.questions` is the authoritative array of currently pending question
events, including questions that no longer fit in the journal tail. After a main
process restart it is empty. The renderer must reconcile historical cards against
this array so it never offers an answer to a request from a dead process. UUID
request ids also prevent stale clicks from resolving a request in a replacement
session. No response can be routed to another pane's pending map. `chat:answer`
uses the existing global `ipcGuard` main-frame sender check.

## Claude

The official [Agent SDK user-input guide](https://code.claude.com/docs/en/agent-sdk/user-input)
routes `AskUserQuestion` through `canUseTool`. Selected labels go into an answers
record keyed by the original question text. The original questions accompany the
reply; multi-select labels can be comma-joined, and custom text can be an answer.
Cancellation is a deny result. Tessel implements this contract on its existing
`--permission-prompt-tool stdio` control channel, without adding the SDK.

Input fixture:

```js
{ type: 'control_request', request_id: 'raw-1', request: {
  subtype: 'can_use_tool', tool_name: 'AskUserQuestion',
  input: { questions: [{ question: 'Which format?', header: 'Format',
    options: [{ label: 'Summary', description: 'Brief overview' }], multiSelect: false }] }
} }
```

Response fixture:

```js
{ type: 'control_response', response: {
  subtype: 'success', request_id: 'raw-1', response: {
    behavior: 'allow', updatedInput: {
      questions: originalQuestions,
      answers: { 'Which format?': 'Summary' }
    }
  }
} }
```

Cancellation uses the same envelope with
`{behavior:'deny', message:'The user declined to answer.'}`. No permission update
or session rule accompanies an answer. A normal tool approval cannot be answered
through `chat:answer`, and a question cannot be approved through `chat:approve`.
Duplicate question texts are refused because Claude's answer map cannot represent
two distinct answers under the same key. Original question metadata, including
any preview, stays in main; preview HTML is not passed to the renderer.

## Codex

Checked against the locally generated `codex-cli 0.158.0` app-server v2 schema:
`ToolRequestUserInputParams`, `ToolRequestUserInputQuestion`,
`ToolRequestUserInputOption`, `ToolRequestUserInputAnswer`, and
`ToolRequestUserInputResponse` in the chat-spike `codex-schema-ts/v2` fixture.

`item/tool/requestUserInput` is a server JSON-RPC request with `threadId`,
`turnId`, `itemId`, `questions`, and `isBlocking` (plus deprecated
`autoResolutionMs`). Each question has `id`, `header`, `question`, `isOther`,
`isSecret`, and nullable `options`. This schema has no multi-select field; the
normalized question is single-select. A question without options accepts text;
with options, custom text is accepted only when `isOther:true`.

```js
// Request
{ id: 7, method: 'item/tool/requestUserInput', params: {
  threadId: 'thread', turnId: 'turn', itemId: 'item', isBlocking: true,
  questions: [{ id: 'format', header: 'Format', question: 'Which format?',
    isOther: false, isSecret: false,
    options: [{ label: 'Summary', description: 'Brief overview' }] }]
} }
// User chose Summary
{ id: 7, result: { answers: { format: { answers: ['Summary'] } } } }
// User cancelled (no dedicated cancellation variant in this schema)
{ id: 7, result: { answers: {} } }
```

Foreign threads, mismatched or settled turns, malformed questions, and secret
questions are answered empty without displaying a card. `isSecret:true` is not
supported: the current card and journal are not a secret-entry channel. No timer
selects an answer; the server's `serverRequest/resolved` notification cancels its
card. A thread-idle fallback cannot settle a turn while a question is pending.
Normal `turn/completed` still settles it, including nonblocking questions.

## OpenCode

Checked against the OpenAPI spec served by opencode 1.18.32 (`QuestionRequest`,
`QuestionInfo`, `QuestionOption`, `QuestionAnswer`). `question.asked` on the SSE
bus carries `{id:'que_…', sessionID, questions:[{question, header, options:
[{label, description}], multiple?, custom?}], tool?}`. Questions have no ids:
they get `q<i>` / `o<j>`; `multiple` is multi-select, and free text is accepted
unless `custom:false`. An answer is `POST /question/:id/reply {answers}` with
one array of chosen labels per question, in order; a cancellation is
`POST /question/:id/reject`. Only the chat's own session, during an open turn,
gets a card; other sessions' questions are rejected. `question.replied` /
`question.rejected` cancel a card answered elsewhere. The chat's strict config
allows the question tool (it asks, and runs nothing). No real question was
recorded: the shapes come from the spec and the fake server.

## Lifetime and bounds

- Up to 8 pending requests, each with 8 questions and 32 options per question.
- Question/header/description: 2 KiB each; option label: 512 bytes; identifiers:
  120 bytes; custom answer: 8 KiB UTF-8 per question. Oversize values are refused,
  not silently truncated. Claude's original questions are capped at 1 MiB.
- At most 4096 question request ids are tracked per adapter process, including
  completed ids to ignore retransmissions. Further requests are cancelled.
- Invalid raw request ids receive a cancellation reply as well; only a duplicate
  already-seen id is ignored. Session-level cancellation also asks the adapter to
  cancel, even if its provider turn id did not match the turn that just ended.
- Requests stay pending until a user response, provider cancellation, turn end,
  interrupt, close or process exit. Late asynchronous writes cannot resurrect them.
- A pending question prevents idle sleep and delivery of another queued user/team
  turn. It does not add an approval or modify the permission posture.
- User answers are ordinary conversation data in the journal. Secret-entry
  questions are refused; raw provider request ids never reach the renderer.
  Both question events and answer-status events use the journal's recursive
  8 KiB string clipping, in addition to validation at the live question boundary.

## Verification

`questions.spec.js` covers bounds, Unicode bytes, ids, required answers, free-text
rules, duplicate labels, request caps, cancellation/write races, and failed pipes.
`questionAdapters.spec.js` uses in-memory fake stdio to assert complete provider
envelopes, approval separation, thread isolation and every terminal path.
`sessions.spec.js` covers IPC sender validation, pane isolation, journaling,
authoritative history, duplicate submission, queues, idle sleep and late results.
The existing fake-process Codex suite explicitly cancels a request rather than
expecting it to be silently answered at receipt.

Run tests with `TESSEL_TEAM_SECRET` and `TESSEL_PANE_ID` removed from the environment:

```powershell
npx vitest run --maxWorkers=3 --testTimeout=60000 --reporter=dot
npm run build
```

Validation on 2026-09-29: full suite, 420 files passed / 39 skipped;
5456 tests passed, 1 existing expected failure, 2 skipped and 38 existing todos.
After the final system-error and malformed-secret-flag checks, the five affected
adapter/session/question suites passed again (222 tests). Final build:
`check-bundle: ok (4 files)`. No unexpected failures.

Review follow-up: provider cancellation is also sent from session teardown;
malformed raw ids get explicit replies; question journal fields and free-text
answers are bounded at 8 KiB. Validation after these corrections: 144 targeted
tests, then the complete suite (420 files, 5468 passed; the same 1 expected
failure, 2 skipped and 38 todos). Build: `check-bundle: ok (4 files)`.
