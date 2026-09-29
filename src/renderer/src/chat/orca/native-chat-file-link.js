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
import { routeNativeChatHref } from "./shared/native-chat-href-routing.js";
import { parseExplicitFileLinkTarget, resolveExplicitFileLinkTarget } from '@/lib/explicit-file-link-target';
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner';
import { parseWorkspaceKey } from "./shared/workspace-scope.js";
export function findTerminalTabWorktreeId(tabsByWorktree, terminalTabId) {
    for (const [worktreeId, tabs] of Object.entries(tabsByWorktree)){
        if (tabs.some((tab)=>tab.id === terminalTabId)) {
            return worktreeId;
        }
    }
    return null;
}
function findStructuredTabWorktreeId(unifiedTabsByWorktree, tabId) {
    for (const [worktreeId, tabs] of Object.entries(unifiedTabsByWorktree ?? {})){
        if (tabs.some((tab)=>tab.id === tabId && tab.contentType === 'agent-session')) {
            return worktreeId;
        }
    }
    return null;
}
function findWorktreeFallback(worktreesByRepo, worktreeId) {
    for (const worktrees of Object.values(worktreesByRepo)){
        const worktree = worktrees.find((entry)=>entry.id === worktreeId);
        if (worktree) {
            return worktree;
        }
    }
    return null;
}
export function resolveNativeChatFileLinkContext(state, terminalTabId) {
    const worktreeId = findTerminalTabWorktreeId(state.tabsByWorktree, terminalTabId) ?? findStructuredTabWorktreeId(state.unifiedTabsByWorktree, terminalTabId);
    if (!worktreeId) {
        return null;
    }
    const knownWorktree = state.getKnownWorktreeById(worktreeId);
    const worktree = knownWorktree?.path ? knownWorktree : findWorktreeFallback(state.worktreesByRepo, worktreeId);
    const workspaceScope = parseWorkspaceKey(worktreeId);
    const worktreePath = worktree?.path ?? (workspaceScope?.type === 'folder' ? state.folderWorkspaces.find((workspace)=>workspace.id === workspaceScope.folderWorkspaceId)?.folderPath ?? null : null);
    if (!worktreePath) {
        return null;
    }
    return {
        worktreeId,
        worktreePath,
        runtimeEnvironmentId: getRuntimeEnvironmentIdForWorktree(state, worktreeId)
    };
}
function resolvePathText(pathText, fallbackLine, context) {
    const parsed = parseExplicitFileLinkTarget(pathText, {
        allowRelativeDirectoryPath: true
    });
    if (!parsed) {
        return null;
    }
    const resolved = resolveExplicitFileLinkTarget(parsed, context.worktreePath);
    if (!resolved) {
        return null;
    }
    return {
        absolutePath: resolved.absolutePath,
        line: resolved.line ?? fallbackLine,
        column: resolved.column
    };
}
export function resolveNativeChatFileLink(href, context) {
    if (!context) {
        return null;
    }
    const route = routeNativeChatHref(href);
    if (route.kind !== 'file') {
        return null;
    }
    return resolvePathText(route.pathText, route.line, context);
}
