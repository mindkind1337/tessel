# Commands and skill discovery

Two interfaces serve the native compose menu, as agreed with its adapter.
Neither changes approvals, permissions, or the text sent by the user.

## Session commands

```json
{"type":"commands","commands":[{"name":"compact","kind":"command","kindUnspecified":true,"description":"Compact the conversation"},{"name":"review","kind":"skill"}]}
```

Each event is a full replacement, including an empty array. Names have no leading
slash, are unique and limited to 128 characters; descriptions and argument hints
are optional, limited to 512 characters. At most 512 entries are retained.
Invalid names and controls are rejected or stripped. A name-only entry is
`kind: command` with `kindUnspecified: true`; an explicitly reported skill is
`kind: skill`. Agent definitions are not skills.

Claude emits initialize-response commands at startup, including resume. Root
`system/init` updates replace the advertised names, preserve known help text,
classify names listed in `skills`, and exclude `terminal_slash_commands`. Child
initialization cannot replace the parent catalog. Duplicate catalogs are omitted.
Codex emits an empty command array: its inspected app-server v2 schema has no
general slash-command or custom-prompt catalog. Skills use the second interface.
OpenCode emits its `GET /command` catalog at startup (`source: 'skill'` rows
are `kind: skill`, `hints` become the argument hint). A message `/name args`
whose name is in that catalog runs through `POST /session/:id/command`;
anything else is ordinary prompt text.

Events are journaled. The latest normalized array is also persisted as
`commands.json` next to the pane journal and returned as `chat:history.commands`,
so journal rotation or a short history tail cannot hide it. New startup/resume
replaces the snapshot. Forgetting a pane removes it with the journal.

## Skill discovery

`window.shellApi.chat.skills({ paneId, refresh?: boolean })` invokes `chat:skills`.
The result is `{ok:true, result:{skills, sources, scannedAt}}`, or `{ok:false,
error}`. A skill looks like:

```json
{"id":"skill-opaque-id","name":"review","description":"Review changes","providers":["claude"],"sourceKind":"repo","sourceLabel":"Project skills","rootPath":"source-opaque-id","directoryPath":"directory-opaque-id/review","skillFilePath":"skill-opaque-id","installed":true,"updatedAt":1790700000000}
```

Sources contain `id`, `label`, `path`, `sourceKind`, `providers`, `owner`, `exists`
and optional `skippedReason` (`missing` or `unavailable`). Source labels are localized.
Absolute filesystem paths stay in main's private cache. Public `id`, `rootPath`,
`rootPaths`, `skillFilePath` and source `path` fields are opaque keyed references,
stable during the main-process lifetime, including refreshes. The same root always
has the same reference. `directoryPath` keeps only an opaque prefix and the actual
folder basename needed by the picker. References are for comparison only: the UI
neither opens them nor inserts them in a prompt. They are not filesystem handles.
`scannedAt` and `updatedAt` are epoch milliseconds; provider-only modification
times are `null`. The menu handles loading, retry and insertion (`/name` for
Claude, `$name` for Codex).

Only an existing chat session with a currently trusted cwd can request discovery.
The main-window sender gate (`ipcGuard`, installed before chat registration)
protects the handler. Renderer paths, agents, roots and home directories are
ignored. Main takes cwd/projectDir from the session and home from the OS; an
additional project directory must also pass trust. Concurrent requests share one
pending result per pane; successful results are cached until `refresh:true` or a
new session. Both cwd and projectDir trust are checked again for cached results
and after the scan. Revoking cwd trust blocks the result; revoking an additional
project removes its sources and skills from the private cache and public result,
while independently approved cwd skills remain available.

Claude reads `.claude/skills`, `.claude/commands` and `.agents/skills` under cwd,
an approved project directory, and home. Shared `.agents` sources have owner
`null` and provider `agent-skills`. Legacy command Markdown files are supported.
Only frontmatter `name` and `description` are returned, never the body. Missing
names fall back to directory/file names. The small parser supports plain/quoted
scalars and folded/literal descriptions, not arbitrary YAML or executable tags.
No code is run. Links/junctions and multiply hard-linked files are skipped; root
components and canonical paths are checked before reading. After opening a file,
its device/inode must match the prior lstat, and its link count must still be one.
POSIX opens use O_NONBLOCK as well as O_NOFOLLOW. Frontmatter lines above 2 KiB
are ignored; scalar comments are stripped in linear time. Limits are 512 skills, 1024 directories, 4096 directory
entries, depth 4, 64 KiB per file and 2 seconds per scan. Sources that exceed a
limit are `unavailable`. A timeout stops scheduling further filesystem work; already pending OS operations
may complete later, with results discarded and opened handles closed. One global
scan lock remains held until that real work finishes, not merely until the response
timeout. While it is held, later requests get their trust-checked cache or an
unavailable response instead of starting more filesystem work. Partial results are
returned for available sources.

Codex queries the running app-server `skills/list` with exactly the session cwd
and `forceReload: refresh`. Its `SkillMetadata` is converted to the same result;
disabled skills, malformed/relative paths and other cwd entries are discarded.
User/repo/system-or-admin scopes map to home/repo/bundled. Provider paths are
metadata only and are never opened by Tessel. No disk fallback invents a catalog
when app-server is unavailable; timeout/method-not-found returns `ok:false` and
the chat remains usable. Query timeout is 1500 ms by default.

OpenCode queries the running server's `GET /skill` for the session's folder.
Only name, description and the SKILL.md location are kept (never the body);
a location inside the chat's folder is `repo`, inside home `home`, else
`bundled`. Owner and provider are `opencode`; `/name` inserts it.

## Command dispatch and verification

Claude's documented SDK command surface accepts `/<name>` in ordinary prompt
text. The real recorded 2.1.284 initialize/system-init fixtures provide discovery
evidence; the adapter test checks that `/compact preserve API details` is written
unchanged as the user text block in stream-json. No live command was executed.
Unknown or terminal-only command behavior belongs to the installed CLI; discovery
does not promise that every command succeeds in every session. See the official
[command discovery and dispatch documentation](https://code.claude.com/docs/en/agent-sdk/slash-commands#commands-in-agent-sdk-sessions).

Codex shapes follow the locally generated app-server v2 `SkillsListParams`,
`SkillsListResponse`, `SkillMetadata`, `SkillInterface` and `SkillScope` schemas.
Tests use temporary filesystem fixtures and the fake JSONL adapters only.
