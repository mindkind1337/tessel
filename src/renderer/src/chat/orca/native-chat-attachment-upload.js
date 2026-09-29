/*
 * MIT License
 *
 * Copyright (c) 2026 Lovecast Inc.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import { toast } from 'sonner';
import { t } from "../../i18n/index.js";
import { extractIpcErrorMessage } from '@/lib/ipc-error';
import { getConnectionIdFromState } from '@/lib/connection-context';
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner';
import { reportTerminalDropUploadSkipsAndFailures } from '../terminal-pane/terminal-drop-upload-report';
import { findTerminalTabWorktreeId, resolveNativeChatFileLinkContext } from "./native-chat-file-link.js";
import { captureDirectSshMutationExpectation } from '@/lib/ssh-mutation-expectation';
export function resolveNativeChatAttachmentOwner(state, terminalTabId) {
    const worktreeId = findTerminalTabWorktreeId(state.tabsByWorktree, terminalTabId);
    if (!worktreeId) {
        return {
            kind: 'not-ready'
        };
    }
    return resolveNativeChatAttachmentOwnerForWorktree(state, worktreeId, terminalTabId);
}
export function resolveNativeChatAttachmentOwnerForWorktree(state, worktreeId, terminalTabId) {
    if (getRuntimeEnvironmentIdForWorktree(state, worktreeId)) {
        return {
            kind: 'runtime'
        };
    }
    const connectionId = getConnectionIdFromState(state, worktreeId);
    if (connectionId === undefined) {
        return {
            kind: 'not-ready'
        };
    }
    if (connectionId === null) {
        return {
            kind: 'local'
        };
    }
    const worktreePath = terminalTabId ? resolveNativeChatFileLinkContext(state, terminalTabId)?.worktreePath : state.getKnownWorktreeById(worktreeId)?.path;
    if (!worktreePath) {
        return {
            kind: 'not-ready'
        };
    }
    try {
        return {
            kind: 'ssh',
            connectionId,
            worktreePath,
            ...captureDirectSshMutationExpectation(state, connectionId)
        };
    } catch  {
        return {
            kind: 'not-ready'
        };
    }
}
export function nativeChatWorktreeNotReadyNotice() {
    return t('chat.orca.composer.worktreeNotReady', 'Worktree not ready — try again in a moment.');
}
export function nativeChatAttachmentOwnerChangedNotice() {
    return t('chat.orca.composer.attachmentOwnerChanged', 'This workspace changed hosts while attaching — drop the files again.');
}
export function nativeChatAttachmentUnreadableNotice() {
    return t('chat.orca.composer.attachmentUnreadable', "Couldn't read the dropped files.");
}
export function nativeChatLocalAttachmentUnsupportedNotice() {
    return t('chat.orca.composer.localAttachmentUnsupported', 'Local attachments are not available for remote sessions.');
}
export async function uploadNativeChatAttachmentPaths(paths, owner) {
    const pending = toast.loading(t('chat.orca.composer.uploadingAttachments', 'Uploading {{value0}} file(s) to remote…', {
        value0: paths.length
    }));
    try {
        const { resolvedPaths, skipped, failed } = await window.api.fs.resolveDroppedPathsForAgent({
            paths,
            worktreePath: owner.worktreePath,
            connectionId: owner.connectionId,
            expectedExecutionHostId: owner.expectedExecutionHostId,
            expectedSshTargetId: owner.expectedSshTargetId,
            expectedSshConnectionGeneration: owner.expectedSshConnectionGeneration
        });
        reportTerminalDropUploadSkipsAndFailures(skipped, failed);
        return resolvedPaths;
    } catch (err) {
        toast.error(extractIpcErrorMessage(err, t("chat.orca.copy.failed_to_upload_files", "Failed to upload files.")));
        return null;
    } finally{
        toast.dismiss(pending);
    }
}
