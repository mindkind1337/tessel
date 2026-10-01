# Links, file drops and font scale

Reference: Orca, MIT, Copyright (c) 2026 Lovecast Inc. Vue adaptation for Tessel.

All data inputs accept values, refs/computed or getters. Options can also be a
ref/getter. Callbacks are ordinary functions (or refs to functions). Call hooks
in component setup; computed values are read with `.value` outside templates.

## API for the Markdown and composer lots

- `useNativeChatFileLinkContext(pane, options?)` returns a computed context or
  null. Pass the Tessel leaf, not just its id. `options.resolveContext(pane)` can
  override resolution; otherwise `panelCtx.paneFolder(pane)` supplies the working
  directory, then leaf `projectDir`, `cwd`, `startDir`. Context fields are
  `worktreeId`, `worktreePath`, optional `homePath`. Remote contexts are refused.
- `useNativeChatFileLinkClick(context, options?)` returns a computed
  `async (event, href) => void`. `options.openFile({file,line,col}, event)` defaults
  to injected `panelCtx.viewFile`. Relative paths, file URIs, line/column suffixes
  and encoded literal paths resolve without invoking a shell. Shift does not
  open a file externally. Programs, scripts, network/UNC/device paths and
  control characters are refused (src/shared/chatFileLinks.js); existence is
  checked through `shellApi.chatFiles.stat` (or `options.statPath`). Outside the
  chat's folders Tessel asks first (injected `askConfirm`, or
  `options.confirmOpen`). Folders and media/documents open with the system
  through `shellApi.chatFiles.open` (or `options.openSystem`), re-checked in main
  (src/main/chatFileOpen.js); images open in Tessel's lightbox
  (`shellApi.viewImage` + `panelCtx.showImage`, or `options.viewImage` /
  `options.showImage`) when it can show them; text and code open in Tessel's editor.
  Optional `onOpenFailure({verdict,path,error})` receives resolution/open failures;
  otherwise Tessel's toast is used. A missing context still consumes file clicks
  and reports an unresolved target, avoiding document navigation.
- `useNativeChatLinkActions(context, rootRef, scope?, options?)` returns
  `{onLinkClick, linkActionRequest, closeLinkActions}`. `onLinkClick` is computed;
  request is a null ref because Tessel has no destination popover. Web links use
  `options.openWeb(url,event)` when supplied (the integrated browser can inject
  its opener), otherwise `panelCtx.openExternal` / `shellApi.openExternal`.
  Only HTTP(S) URLs are accepted by the web opener. `file:` goes exclusively to
  the viewer. Other schemes, including mailto, are refused. Fragment anchors
  keep their normal behavior. `scope.isVisible=false` disables dispatch.
- `useNativeChatWorkspaceFileDrop(options)` returns
  `{onDragOverCapture,onDropCapture}`. Bind these on the pane surface with
  `@dragover.capture` and `@drop.capture`. Recognizes `text/x-tessel-path` and OS
  `Files` resolved through `pathForFile(file)` or `shellApi.pathForFile`.
  `insertText(text)` inserts space-separated paths, quoting paths with spaces.
  Alternatively supply `attachResolvedPaths(paths, undefined,
  {targetOwnerIsCurrent})`; despite the retained name, this callback MUST insert
  text only and check the guard after delayed/IME work. It never uploads.
  `disabled`, `remote`, `paneKey`, `structuredWorktreeId`, `terminalTabId`, and
  `sessionId` are reactive. `setNotice(text)` displays bounded/rejected drops.
  Disabled recognized drops are consumed, preventing parent terminal insertion.
- `useNativeChatFontScale(enabled, options?)` returns
  `{scale, fontScale, increase,decrease,reset}`; scale and fontScale are the same
  ref. Enable ONLY for the active visible pane. Reference Cmd/Ctrl +/-/0 and
  Ctrl+wheel change the scale in [0.8, 1.6]. `options.target` optionally scopes
  the wheel listener to a DOM ref; otherwise window is used. Keyboard capture
  remains on window. `options.isMac` overrides platform detection for tests.
  Storage key defaults to `tessel.chat.fontScale`, overridable by `storageKey`.
  Storage failures are harmless; listeners are removed on disable/unmount.

## Dependencies and intentional differences

New pure helpers: `lib/explicit-file-link-target.js`,
`lib/terminal-path-normalization.js`, `shared/file-link-location.js`.
Existing runtime-dependent `native-chat-file-link.js` is not imported or edited.
The new path helper corrects the reference's premature normalization of `../`:
parent segments now traverse the base, while preserving drive/UNC roots.

Orca store/runtime, remote/SSH owners, mobile routing, upload and destination
popover are excluded. Tessel explorer payloads have no source workspace stamp;
local absolute paths from another local folder may be inserted as text. This
does not claim that the engine can access those paths. No engine/permission
changes, executable launching, or system file opener is involved.

The file-link source test cases for path resolution are adapted to Vue and the
viewer callback. Markdown linkification/underline DOM assertions belong to the
Markdown component lot and are not exercised here. Remote-host failure UI is
excluded. Source destination-menu tests are replaced by direct injected opener
tests; mailto now refuses per the lead's explicit requirement. Focus fallback,
local file routing, URL suffixes, file URIs and literal `#` paths are covered.
The new shared module's original tests are retained. Drop/font/context tests
add local integrations, reactive guard, listener cleanup and storage coverage.

## New translation key (lead owns fr/chat.json)

- `chat.orca.composer.fileDropFailed`
  - English: `Could not insert these file paths. Drop up to 256 local files.`
  - French: `Impossible d’insérer ces chemins. Déposez au maximum 256 fichiers locaux.`
