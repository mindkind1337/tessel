# Native chat logic port

Source: Orca commit `433986fa3be37911a0f13f7ffd454b831b87a64c`, MIT, Copyright (c) 2026 Lovecast Inc. TypeScript syntax removed with Node stripTypeScriptTypes (transform mode); function names and logic retained. UI translations use Tessel t(). This is a logic port, not a connected chat UI.

## Modules (105)

- `background-task-header-content.js`
- `background-task-roster.js`
- `claude-model-switch-confirmation.js`
- `claude-terminal-session-options.js`
- `native-chat-active-rail-item.js`
- `native-chat-attachment-upload.js`
- `native-chat-autoscroll.js`
- `native-chat-availability.js`
- `native-chat-command-marker.js`
- `native-chat-composer-input.js`
- `native-chat-composer-scope-cache.js`
- `native-chat-composer-state.js`
- `native-chat-composer-target.js`
- `native-chat-composer-types.js`
- `native-chat-context-usage-summary.js`
- `native-chat-diff.js`
- `native-chat-dismiss-key.js`
- `native-chat-draft-cache.js`
- `native-chat-edit-cards.js`
- `native-chat-file-link-toasts.js`
- `native-chat-file-link.js`
- `native-chat-font-scale.js`
- `native-chat-http-link-source-owner.js`
- `native-chat-image-paste.js`
- `native-chat-incremental-assembler.js`
- `native-chat-interactive-prompt.js`
- `native-chat-launch-draft-resolution.js`
- `native-chat-launch-draft-send.js`
- `native-chat-launch-session-options.js`
- `native-chat-layout-actions.js`
- `native-chat-leaf-routing.js`
- `native-chat-live-message-preparation.js`
- `native-chat-live-session-contract.js`
- `native-chat-live-status.js`
- `native-chat-message-grouping.js`
- `native-chat-message-list-projection.js`
- `native-chat-message-list-test-viewport.js`
- `native-chat-message-rail-items.js`
- `native-chat-noise.js`
- `native-chat-pagination.js`
- `native-chat-pane-file-drop.js`
- `native-chat-pane-resolution.js`
- `native-chat-pending-occurrence.js`
- `native-chat-pending.js`
- `native-chat-picker-items.js`
- `native-chat-pinned-rows.js`
- `native-chat-pty-send-queue.js`
- `native-chat-pty-session-options.js`
- `native-chat-read-retry-timer.js`
- `native-chat-reader-scroll-input.js`
- `native-chat-resolution-receipt.js`
- `native-chat-resolved-path-ownership.js`
- `native-chat-row-height-estimate.js`
- `native-chat-runtime-contract.js`
- `native-chat-runtime-image-send.js`
- `native-chat-runtime-owner.js`
- `native-chat-runtime-send.js`
- `native-chat-scrape-fallback.js`
- `native-chat-send-eligibility.js`
- `native-chat-send.js`
- `native-chat-session-assembler.js`
- `native-chat-session-option-apply.js`
- `native-chat-session-option-cache.js`
- `native-chat-session-option-command-dispatch.js`
- `native-chat-session-option-discovery.js`
- `native-chat-session-option-enrichment.js`
- `native-chat-session-option-labels.js`
- `native-chat-session-option-settings-write.js`
- `native-chat-session-option-snapshot.js`
- `native-chat-session-transport.js`
- `native-chat-shortcut.js`
- `native-chat-skill-discovery-context.js`
- `native-chat-split-shortcut.js`
- `native-chat-stream-teardown.js`
- `native-chat-structured-composer-dispatch.js`
- `native-chat-structured-question-test-fixtures.js`
- `native-chat-tab-agent-entry.js`
- `native-chat-task-list-frames.js`
- `native-chat-task-list-history.js`
- `native-chat-task-list-state.js`
- `native-chat-thread-goal-presentation.js`
- `native-chat-thread-goal-rows.js`
- `native-chat-tool-fold.js`
- `native-chat-tool-run-label.js`
- `native-chat-tool-summary.js`
- `native-chat-transcript-slots.js`
- `native-chat-turn-diffs.js`
- `native-chat-typing-indicator.js`
- `native-chat-typing-redirect.js`
- `native-chat-view-state.js`
- `native-chat-view-types.js`
- `native-chat-web-link-actions.js`
- `native-chat-working-suppression.js`
- `structured-agent-question-projection.js`
- `structured-agent-session-message-projection.js`
- `structured-agent-session-outbox-dispatch.js`
- `structured-agent-session-outbox-storage.js`
- `structured-agent-session-rail-outline.js`
- `structured-agent-session-read-owner.js`
- `structured-agent-session-read-transport.js`
- `structured-agent-session-tabs.js`
- `structured-attention-dispatch.js`
- `structured-attention-surface.js`
- `structured-conversation-command-send.js`
- `structured-session-background-tasks-view.js`

## Pure shared dependency closure (136)

- `shared/native-chat-turn-status.js`
- `shared/agent-session-option-catalog.js`
- `shared/agent-session-option-catalog-antigravity.js`
- `shared/agent-cli-flag-detection.js`
- `shared/agent-session-option-agent-args.js`
- `shared/agent-session-option-catalog-claude-codex.js`
- `shared/claude-model-list-probe.js`
- `shared/json-text-structure-limit.js`
- `shared/agent-session-option-catalog-gemini-cursor.js`
- `shared/agent-session-option-catalog-grok.js`
- `shared/grok-model-list-probe.js`
- `shared/model-id-label.js`
- `shared/agent-session-option-catalog-muse.js`
- `shared/agent-session-option-catalog-omp.js`
- `shared/omp-model-list-probe.js`
- `shared/native-chat-types.js`
- `shared/native-chat-merge.js`
- `shared/native-chat-slash-commands.js`
- `shared/native-chat-agent-profiles.js`
- `shared/agent-image-paste.js`
- `shared/image-paste-following-text.js`
- `shared/cross-platform-path.js`
- `shared/wsl-paths.js`
- `shared/file-uri-path.js`
- `shared/native-chat-diff.js`
- `shared/native-chat-ask.js`
- `shared/native-chat-edit-normalize.js`
- `shared/native-chat-begin-patch.js`
- `shared/native-chat-edit-model.js`
- `shared/native-chat-unified-patch.js`
- `shared/native-chat-edit-lcs.js`
- `shared/native-chat-edit-patch-files.js`
- `shared/structured-agent-session-projection.js`
- `shared/agent-status-field-normalization.js`
- `shared/orca-dispatch-status-prompt.js`
- `shared/agent-session-journal-types.js`
- `shared/agent-turn-outcome.js`
- `shared/agent-session-journal-producer.js`
- `shared/agent-session-turn-record.js`
- `shared/agent-turn-lifecycle-text.js`
- `shared/agent-status-types.js`
- `shared/main-agent-status.js`
- `shared/agent-state-history.js`
- `shared/agent-status-freshness.js`
- `shared/native-chat-tool-summary.js`
- `shared/native-chat-tool-preview-prefix.js`
- `shared/structured-agent-session-live-turn.js`
- `shared/structured-agent-session-tool-call-block.js`
- `shared/sha256.js`
- `shared/structured-agent-session-status-started-at.js`
- `shared/structured-agent-session-unanswered-dispatch.js`
- `shared/workspace-scope.js`
- `shared/worktree/host-qualified-identity.js`
- `shared/execution-host.js`
- `shared/native-chat-href-routing.js`
- `shared/native-chat-image-transcript-markers.js`
- `shared/ansi-escape-sequences.js`
- `shared/native-chat-session-option-defaults.js`
- `shared/structured-agent-session-option-codec.js`
- `shared/agent-tui-input-clear.js`
- `shared/native-chat-command-envelope.js`
- `shared/native-chat-streaming.js`
- `shared/native-chat-transcript-projection.js`
- `shared/native-chat-noise.js`
- `shared/harness-injected-user-turns.js`
- `shared/native-chat-tool-fold.js`
- `shared/agent-session-conversation-outline.js`
- `shared/native-chat-row-content.js`
- `shared/native-chat-background-task-row.js`
- `shared/native-chat-subagent-summary.js`
- `shared/native-chat-prose.js`
- `shared/structured-agent-session-message-projection.js`
- `shared/agent-session-journal-item-key.js`
- `shared/structured-agent-session-outbox.js`
- `shared/agent-session-refusal-retry.js`
- `shared/structured-agent-session-mutation.js`
- `shared/structured-agent-session-dispatch-rejection.js`
- `shared/native-file-drop.js`
- `shared/clipboard-text.js`
- `shared/event-loop-yield.js`
- `shared/utf8-byte-limits.js`
- `shared/skill-display-text.js`
- `shared/native-chat-session-option-commands.js`
- `shared/native-chat-session-option-state.js`
- `shared/native-chat-session-option-snapshot.js`
- `shared/agent-session-question-answer.js`
- `shared/native-chat-answer-stepping.js`
- `shared/agent-tui-command-typing.js`
- `shared/commit-message-host-key.js`
- `shared/native-chat-tool-activity.js`
- `shared/native-chat-tool-run-sentence.js`
- `shared/native-chat-tool-icon.js`
- `shared/native-chat-tool-identity.js`
- `shared/keybindings.js`
- `shared/keybindings/types.js`
- `shared/keybindings/definitions.js`
- `shared/tui-agent-display-names.js`
- `shared/keybindings/definitions-core-1.js`
- `shared/keybindings/definitions-support.js`
- `shared/keybindings/definitions-core-2.js`
- `shared/keybindings/definitions-core-3.js`
- `shared/keybindings/definitions-core-4.js`
- `shared/keybindings/parser.js`
- `shared/keybindings/normalization.js`
- `shared/keybindings/input.js`
- `shared/keybindings/effective.js`
- `shared/keybindings/matching-key.js`
- `shared/keybindings/matching.js`
- `shared/keybindings/formatting.js`
- `shared/native-chat-task-list.js`
- `shared/agent-session-thread-goal.js`
- `shared/structured-agent-session-turn-timing.js`
- `shared/native-chat-turn-fold.js`
- `shared/agent-question-answered-intent.js`
- `shared/structured-agent-session-send-disposition.js`
- `shared/agent-session-resume.js`
- `shared/agent-session-wire.js`
- `shared/agent-session-wire-refusals.js`
- `shared/agent-session-record.js`
- `shared/agent-session-rewind.js`
- `shared/agent-session-journal-schemas.js`
- `shared/agent-session-context-usage-schema.js`
- `shared/agent-session-context-usage.js`
- `shared/agent-session-launch-args.js`
- `shared/agent-session-conversation-name.js`
- `shared/surrogate-safe-text-slice.js`
- `shared/agent-session-legacy-handoff-lease.js`
- `shared/agent-session-conversation-command.js`
- `shared/agent-session-provider-handle.js`
- `shared/agent-session-background-task-wire.js`
- `shared/structured-agent-session-reducer.js`
- `shared/agent-session-background-task-state-equality.js`
- `shared/structured-agent-session-coalescer.js`
- `shared/structured-agent-session-read-refusal.js`
- `shared/agent-notification-id.js`
- `shared/stable-pane-id.js`

## Left for Vue port

All use-*.ts hooks and all .tsx components are excluded. The following non-hook files require React/Tiptap:

- `native-chat-disclosure-store.ts`
- `native-chat-image-runtime-context.ts`
- `native-chat-prompt-document.ts`
- `native-chat-prompt-editor.test-support.ts`

## Adapter dependencies (original imports retained; not wired)

Fable owns adapter/. No replacement store, runtime, side effects, or package install is invented. Unresolved modules must not be imported into the application until adapted. Type-only imports were erased.

- `claude-model-switch-confirmation.js` → `../terminal-pane/pty-data-sidecar-subscriptions`, `@/runtime/runtime-terminal-inspection`, `@/runtime/runtime-terminal-stream`
- `native-chat-attachment-upload.js` → `sonner`, `@/lib/ipc-error`, `@/lib/connection-context`, `@/lib/worktree-runtime-owner`, `../terminal-pane/terminal-drop-upload-report`, `@/lib/ssh-mutation-expectation`
- `native-chat-availability.js` → `@/lib/native-chat-supported-agent`
- `native-chat-composer-target.js` → `@/runtime/runtime-terminal-inspection`
- `native-chat-file-link-toasts.js` → `sonner`, `@/lib/ipc-error`
- `native-chat-file-link.js` → `@/lib/explicit-file-link-target`, `@/lib/worktree-runtime-owner`
- `native-chat-http-link-source-owner.js` → `@/lib/connection-owner-resolution`, `@/lib/workspace-browser-tab-open`, `@/lib/worktree-runtime-owner`
- `native-chat-image-paste.js` → `../terminal-pane/terminal-drop-image-path`
- `native-chat-launch-session-options.js` → `@/lib/native-chat-initial-view-mode`
- `native-chat-layout-actions.js` → `@/store`, `@/components/tab-bar/tab-move-to-pane-column`, `@/components/tab-bar/request-active-terminal-pane-split`
- `native-chat-pane-file-drop.js` → `@/lib/workspace-file-drag`
- `native-chat-picker-items.js` → `@/lib/locale-text-collators`
- `native-chat-runtime-image-send.js` → `@/runtime/runtime-terminal-inspection`
- `native-chat-runtime-owner.js` → `@/lib/worktree-runtime-owner`
- `native-chat-runtime-send.js` → `@/runtime/runtime-terminal-inspection`
- `native-chat-send.js` → `../terminal-pane/terminal-bracketed-paste`
- `native-chat-session-option-discovery.js` → `@/lib/agent-paste-draft`, `@/lib/connection-context`, `@/lib/local-preflight-context`, `@/runtime/runtime-git-client`, `@/runtime/structured-agent-session-client`, `@/store`
- `native-chat-session-option-settings-write.js` → `@/runtime/runtime-rpc-client`
- `native-chat-session-transport.js` → `@/lib/web-client-location`, `@/runtime/runtime-rpc-client`, `@/runtime/runtime-protocol-compat`
- `native-chat-skill-discovery-context.js` → `@/lib/worktree-runtime-owner`, `@/lib/local-preflight-context`
- `native-chat-web-link-actions.js` → `@/components/terminal-pane/terminal-link-activation`, `@/lib/http-link-destinations`
- `structured-agent-session-outbox-dispatch.js` → `@/runtime/structured-agent-session-client`, `@/lib/structured-agent-session-launch-prompt`
- `structured-agent-session-outbox-storage.js` → `@/lib/browser-uuid`
- `structured-agent-session-read-owner.js` → `@/runtime/structured-agent-session-client`
- `shared/agent-session-rewind.js` → `zod`
- `shared/agent-session-journal-schemas.js` → `zod`
- `shared/agent-session-context-usage-schema.js` → `zod`
- `structured-agent-session-read-transport.js` → `@/runtime/structured-agent-session-client`
- `structured-attention-dispatch.js` → `@/attention/agent-attention-policy`, `@/attention/agent-attention-notification-delivery`, `@/store`, `../terminal-pane/terminal-notification-state`
- `structured-attention-surface.js` → `../terminal-pane/terminal-notification-pane-visibility`

## Pending test suites

Each pending suite is preserved literally as __tests__/*.pending.js alongside a discoverable *.spec.js it.todo. Vitest does not load the missing imports. Replace the todo with the saved suite once the listed dependencies are adapted. Executable suites are *.spec.js without a pending companion.

- `claude-model-switch-confirmation.test.ts`: `claude-model-switch-confirmation.ts → ../terminal-pane/pty-data-sidecar-subscriptions`; `claude-model-switch-confirmation.ts → @/runtime/runtime-terminal-inspection`; `claude-model-switch-confirmation.ts → @/runtime/runtime-terminal-stream`; `native-chat-send.ts → ../terminal-pane/terminal-bracketed-paste`
- `native-chat-attachment-upload.test.ts`: `native-chat-attachment-upload.ts → sonner`; `native-chat-attachment-upload.ts → @/lib/ipc-error`; `native-chat-attachment-upload.ts → @/lib/connection-context`; `native-chat-attachment-upload.ts → @/lib/worktree-runtime-owner`; `native-chat-attachment-upload.ts → ../terminal-pane/terminal-drop-upload-report`; `native-chat-attachment-upload.ts → @/lib/ssh-mutation-expectation`; `native-chat-file-link.ts → @/lib/explicit-file-link-target`; `native-chat-file-link.ts → @/lib/worktree-runtime-owner`
- `native-chat-availability.test.ts`: `native-chat-availability.test.ts → @/lib/native-chat-transcript-readability`; `native-chat-availability.ts → @/lib/native-chat-supported-agent`
- `native-chat-composer-containment.test.ts`: `Source-shape assertions target original TypeScript / React files`
- `native-chat-composer-state.test.ts`: `native-chat-picker-items.ts → @/lib/locale-text-collators`
- `native-chat-file-link.test.ts`: `native-chat-file-link.ts → @/lib/explicit-file-link-target`; `native-chat-file-link.ts → @/lib/worktree-runtime-owner`
- `native-chat-http-link-source-owner.test.ts`: `native-chat-http-link-source-owner.ts → @/lib/connection-owner-resolution`; `native-chat-http-link-source-owner.ts → @/lib/workspace-browser-tab-open`; `native-chat-http-link-source-owner.ts → @/lib/worktree-runtime-owner`
- `native-chat-image-paste.test.ts`: `native-chat-image-paste.ts → ../terminal-pane/terminal-drop-image-path`
- `native-chat-image-runtime-context.test.ts`: `native-chat-image-runtime-context.test.ts → zustand/shallow`; `native-chat-image-runtime-context.test.ts → ./native-chat-image-runtime-context`
- `native-chat-launch-session-options.test.ts`: `native-chat-launch-session-options.ts → @/lib/native-chat-initial-view-mode`
- `native-chat-layout-actions.test.ts`: `native-chat-layout-actions.ts → @/store`; `native-chat-layout-actions.ts → @/components/tab-bar/tab-move-to-pane-column`; `native-chat-layout-actions.ts → @/components/tab-bar/request-active-terminal-pane-split`
- `native-chat-pane-resolution.test.ts`: `native-chat-availability.ts → @/lib/native-chat-supported-agent`
- `native-chat-retire-persisted-model.test.ts`: `native-chat-retire-persisted-model.test.ts → @testing-library/react`
- `native-chat-runtime-owner.test.ts`: `native-chat-runtime-owner.ts → @/lib/worktree-runtime-owner`; `native-chat-file-link.ts → @/lib/explicit-file-link-target`; `native-chat-file-link.ts → @/lib/worktree-runtime-owner`
- `native-chat-runtime-send-launch-draft.test.ts`: `native-chat-runtime-send.ts → @/runtime/runtime-terminal-inspection`; `native-chat-send.ts → ../terminal-pane/terminal-bracketed-paste`; `native-chat-runtime-image-send.ts → @/runtime/runtime-terminal-inspection`
- `native-chat-runtime-send.test.ts`: `native-chat-runtime-send.ts → @/runtime/runtime-terminal-inspection`; `native-chat-send.ts → ../terminal-pane/terminal-bracketed-paste`; `native-chat-runtime-image-send.ts → @/runtime/runtime-terminal-inspection`
- `native-chat-send.test.ts`: `native-chat-send.ts → ../terminal-pane/terminal-bracketed-paste`
- `native-chat-session-option-enrichment.test.ts`: `native-chat-session-option-discovery.ts → @/lib/agent-paste-draft`; `native-chat-session-option-discovery.ts → @/lib/connection-context`; `native-chat-session-option-discovery.ts → @/lib/local-preflight-context`; `native-chat-session-option-discovery.ts → @/runtime/runtime-git-client`; `native-chat-session-option-discovery.ts → @/runtime/structured-agent-session-client`; `native-chat-session-option-discovery.ts → @/store`
- `native-chat-session-transport.test.ts`: `native-chat-session-transport.test.ts → @/runtime/runtime-rpc-client`; `native-chat-session-transport.test.ts → @/runtime/runtime-protocol-compat`; `native-chat-session-transport.ts → @/lib/web-client-location`; `native-chat-session-transport.ts → @/runtime/runtime-rpc-client`; `native-chat-session-transport.ts → @/runtime/runtime-protocol-compat`
- `native-chat-shared-copy-matches-catalog.test.ts`: `native-chat-shared-copy-matches-catalog.test.ts → @/i18n/locales/en.json`
- `native-chat-stop-layering.test.ts`: `Source-shape assertions target original TypeScript / React files`
- `native-chat-tab-agent-entry.test.ts`: `native-chat-availability.ts → @/lib/native-chat-supported-agent`
- `native-chat-web-link-actions.test.ts`: `native-chat-web-link-actions.ts → @/components/terminal-pane/terminal-link-activation`; `native-chat-web-link-actions.ts → @/lib/http-link-destinations`
- `serialized-screen-background-rows.test.ts`: `serialized-screen-background-rows.test.ts → @/lib/agent-session-fork-context`
- `structured-agent-session-outbox-storage.test.ts`: `structured-agent-session-outbox-storage.ts → @/lib/browser-uuid`
- `structured-agent-session-read-transport.test.ts`: `agent-session-rewind.ts → zod`; `agent-session-journal-schemas.ts → zod`; `agent-session-context-usage-schema.ts → zod`; `structured-agent-session-read-transport.ts → @/runtime/structured-agent-session-client`
- `structured-attention-dispatch.test.ts`: `structured-attention-dispatch.test.ts → @/store/slices/store-test-helpers`
- `structured-attention-surface.test.ts`: `structured-attention-surface.test.ts → @/store/slices/store-test-helpers`; `structured-attention-surface.ts → ../terminal-pane/terminal-notification-pane-visibility`

## Shared tests

66 source suites ported alongside the shared closure; 10 pending for dependencies outside that closure.

- `shared/__tests__/agent-session-option-catalog.spec.js` → `shared/agent-session-option-launch.js`
- `shared/__tests__/agent-session-option-catalog-grok.spec.js` → `shared/agent-session-option-launch.js`
- `shared/__tests__/agent-session-option-catalog-omp.spec.js` → `shared/agent-session-option-launch.js`
- `shared/__tests__/agent-image-paste.spec.js` → `node:url`
- `shared/__tests__/sha256.spec.js` → `node:crypto`
- `shared/__tests__/structured-agent-session-mutation.spec.js` → `shared/agent-session-mutation-envelope.js`
- `shared/__tests__/native-chat-session-option-snapshot.spec.js` → `shared/native-chat-session-options.js`, `shared/agent-session-option-launch.js`
- `shared/__tests__/agent-session-journal-schemas.spec.js` → `zod`
- `shared/__tests__/agent-session-legacy-handoff-lease.spec.js` → `shared/agent-session-record.test-fixture.js`
- `shared/__tests__/structured-agent-session-reducer.spec.js` → `zod`

## Translation boundary

UI labels use t() and lazy label/description getters where catalogs are module constants. Protocol recognition remains byte-for-byte English: native-chat-types interrupted marker, clipboard error classifiers, agent-turn-lifecycle-text and background-task-row (deduplication compares generated sentences). The Vue renderer must translate these only AFTER grouping/recognition; native-chat-protocol-text.js translates fixed markers/errors. Use nativeChatTurnLifecycleText(agent, state) and nativeChatBackgroundTaskText(block) from that same presentation module for lifecycle/background-task rows; never feed localized output back into the transcript model. The tool activity/run/turn-status English constants are fallback catalogs consumed by localized renderer call sites.

## Conversion verification

Node 22.19 transform mode incorrectly printed one logical assignment (`&&=` as `+=` in native-chat-unified-patch). The original operator was restored. AST operator sequences were compared across all 241 source modules; the only remaining difference is the two constructor-property assignments generated for JsonTextStructureLimitError. Original Vitest expectations were retained (only i18n import/mock/key references changed).

The additional native-chat-localization.spec.js checks live language switching and that French presentation preserves English interruption recognition and background-task deduplication.

## Preload dependencies

These original calls also require adapter integration (they are not Tessel shellApi calls):

- `native-chat-attachment-upload.js` -> `window.api.fs.resolveDroppedPathsForAgent`.
- `native-chat-session-transport.js` -> `window.api.nativeChat.readSession`, `window.api.nativeChat.subscribe`, `window.api.runtimeEnvironments.subscribe`.

## Validation

- Full Vitest suite: 4,253 passed, 0 failed, 2 existing skipped tests, 38 explicit adapter/dependency todo suites.
- Command: `vitest run --maxWorkers=3 --testTimeout=60000` with TESSEL_TEAM_SECRET and TESSEL_PANE_ID removed from the child environment.
- `npm run build`: success; `check-bundle: ok (4 files)`. These unattached logic modules are not yet imported by the live chat UI; the build does not validate the unresolved adapters.
- `git diff --cached --check`: clean.
