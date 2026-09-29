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
import { parseExecutionHostId } from "./shared/execution-host.js";
import { getExplicitRuntimeEnvironmentIdForWorktree, getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner';
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context';
import { parseWorkspaceKey } from "./shared/workspace-scope.js";
export function selectNativeChatSkillStateInputs(state) {
    return {
        activeRepoId: state.activeRepoId,
        activeWorktreeId: state.activeWorktreeId,
        folderWorkspaces: state.folderWorkspaces,
        projectGroups: state.projectGroups,
        projects: state.projects,
        repos: state.repos,
        restoredRuntimeHostIdByWorkspaceSessionKey: state.restoredRuntimeHostIdByWorkspaceSessionKey,
        settings: state.settings,
        tabsByWorktree: state.tabsByWorktree,
        unifiedTabsByWorktree: state.unifiedTabsByWorktree,
        worktreesByRepo: state.worktreesByRepo
    };
}
export function resolveNativeChatSkillDiscoveryCwd(state, terminalTabId) {
    const found = findNativeChatTab(state, terminalTabId);
    if (!found) {
        return null;
    }
    const startupCwd = found.tab.startupCwd?.trim();
    if (startupCwd) {
        return startupCwd;
    }
    for (const worktrees of Object.values(state.worktreesByRepo)){
        const worktree = worktrees.find((entry)=>entry.id === found.worktreeId);
        if (worktree) {
            return worktree.path;
        }
    }
    return null;
}
export function resolveNativeChatSkillDiscoveryContext(state, terminalTabId) {
    const worktreeId = findNativeChatTab(state, terminalTabId)?.worktreeId ?? null;
    if (!worktreeId) {
        return null;
    }
    const workspaceScope = parseWorkspaceKey(worktreeId);
    const cwd = resolveNativeChatSkillDiscoveryCwd(state, terminalTabId) ?? (workspaceScope?.type === 'folder' ? state.folderWorkspaces.find((workspace)=>workspace.id === workspaceScope.folderWorkspaceId)?.folderPath : null);
    if (!cwd) {
        return null;
    }
    const hostId = getExecutionHostIdForWorktree(state, worktreeId);
    const parsedHost = parseExecutionHostId(hostId);
    if (parsedHost?.kind === 'ssh') {
        return {
            key: JSON.stringify([
                'ssh',
                hostId,
                cwd
            ]),
            cwd,
            executionHostKind: 'ssh',
            runtimeTarget: {
                kind: 'local'
            },
            discoveryTarget: {
                cwd,
                worktreeId
            }
        };
    }
    const runtimeEnvironmentId = getExplicitRuntimeEnvironmentIdForWorktree(state, worktreeId);
    if (parsedHost?.kind === 'runtime' && !runtimeEnvironmentId) {
        return null;
    }
    const runtimeTarget = runtimeEnvironmentId ? {
        kind: 'environment',
        environmentId: runtimeEnvironmentId
    } : {
        kind: 'local'
    };
    const projectRuntime = runtimeEnvironmentId ? undefined : getLocalProjectExecutionRuntimeContext(state, worktreeId);
    const projectRuntimeKey = projectRuntime?.status === 'resolved' ? projectRuntime.runtime.cacheKey : projectRuntime?.repair.cacheKey;
    return {
        key: JSON.stringify([
            runtimeTarget.kind,
            runtimeTarget.kind === 'environment' ? runtimeTarget.environmentId : null,
            hostId,
            projectRuntimeKey ?? null,
            cwd
        ]),
        cwd,
        executionHostKind: runtimeEnvironmentId ? 'runtime' : 'local',
        runtimeTarget,
        discoveryTarget: {
            cwd,
            worktreeId,
            ...projectRuntime ? {
                projectRuntime
            } : {}
        }
    };
}
function findNativeChatTab(state, tabId) {
    return findTerminalTab(state.tabsByWorktree, tabId) ?? findTerminalTab(state.unifiedTabsByWorktree ?? {}, tabId);
}
function findTerminalTab(tabsByWorktree, terminalTabId) {
    for (const [worktreeId, tabs] of Object.entries(tabsByWorktree)){
        const tab = tabs.find((entry)=>entry.id === terminalTabId);
        if (tab) {
            return {
                worktreeId,
                tab
            };
        }
    }
    return null;
}
