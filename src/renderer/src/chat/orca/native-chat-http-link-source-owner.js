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
import { getConnectionIdFromState } from '@/lib/connection-owner-resolution';
import { canOpenWorkspaceBrowserTabOnRuntime, canOpenWorkspaceBrowserTabOnSsh } from '@/lib/workspace-browser-tab-open';
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner';
export function resolveNativeChatHttpLinkSourceOwner(state, worktreeId) {
    const runtimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(state, worktreeId);
    if (runtimeEnvironmentId) {
        return {
            kind: 'runtime',
            runtimeEnvironmentId
        };
    }
    const connectionId = getConnectionIdFromState(state, worktreeId);
    if (connectionId === undefined) {
        return {
            kind: 'unknown'
        };
    }
    return connectionId === null ? {
        kind: 'local'
    } : {
        kind: 'ssh',
        connectionId
    };
}
export function canNativeChatOpenOwnedBrowser(state, worktreeId, sourceOwner) {
    if (sourceOwner.kind === 'runtime') {
        return canOpenWorkspaceBrowserTabOnRuntime(state, worktreeId, sourceOwner.runtimeEnvironmentId);
    }
    return sourceOwner.kind === 'ssh' && canOpenWorkspaceBrowserTabOnSsh(state, worktreeId, sourceOwner.connectionId);
}
