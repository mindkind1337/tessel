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
import { describe, expect, it } from 'vitest';
import { shallow } from 'zustand/shallow';
import { resolveNativeChatImageRuntimeContext, selectNativeChatImageOwnerState } from './native-chat-image-runtime-context';
function state() {
    const tab = {
        id: 'tab-1',
        ptyId: null,
        worktreeId: 'wt-1',
        title: 'Terminal 1',
        customTitle: null,
        color: null,
        sortOrder: 0,
        createdAt: 0
    };
    const worktree = {
        id: 'wt-1',
        repoId: 'repo',
        path: '/repo/worktree',
        hostId: 'local'
    };
    return {
        activeWorkspaceExecutionHostId: 'local',
        activeWorktreeId: 'wt-1',
        detectedWorktreesByRepo: {},
        folderWorkspaces: [],
        getKnownWorktreeById: ()=>worktree,
        projectGroups: [],
        removedRuntimeEnvironmentIds: new Set(),
        repos: [
            {
                id: 'repo',
                path: '/repo'
            }
        ],
        restoredRuntimeHostIdByWorkspaceSessionKey: {},
        runtimeEnvironmentCatalogHydrated: true,
        runtimeEnvironments: [],
        settings: {
            activeRuntimeEnvironmentId: null
        },
        sshConnectionStates: {},
        sshStateByEnvironment: {},
        tabsByWorktree: {
            'wt-1': [
                tab
            ]
        },
        unifiedTabsByWorktree: {},
        worktreesByRepo: {
            repo: [
                worktree
            ]
        }
    };
}
describe('resolveNativeChatImageRuntimeContext', ()=>{
    it('keeps unrelated store writes out of the image-owner selector', ()=>{
        const storeState = state();
        const first = selectNativeChatImageOwnerState(storeState);
        const second = selectNativeChatImageOwnerState({
            ...storeState,
            agentStatusByPaneKey: {}
        });
        expect(shallow(second, first)).toBe(true);
    });
    it('reuses derived settings when owner inputs are unchanged', ()=>{
        const storeState = state();
        const first = resolveNativeChatImageRuntimeContext(storeState, 'tab-1');
        const second = resolveNativeChatImageRuntimeContext(storeState, 'tab-1');
        expect(first).not.toBeNull();
        expect(second?.settings).toBe(first?.settings);
        expect(shallow(second, first)).toBe(true);
    });
    it('derives a runtime host from an owner-only route during paired hydration', ()=>{
        const storeState = state();
        const ownerOnlyWorktree = {
            id: 'wt-1',
            repoId: 'repo',
            path: '/repo/worktree',
            runtimeOwnerEnvironmentId: 'owner-a'
        };
        const ownerState = {
            ...storeState,
            activeWorktreeId: null,
            activeWorkspaceExecutionHostId: null,
            getKnownWorktreeById: ()=>ownerOnlyWorktree,
            worktreesByRepo: {
                repo: [
                    ownerOnlyWorktree
                ]
            },
            runtimeEnvironments: [
                {
                    id: 'owner-a'
                }
            ]
        };
        const context = resolveNativeChatImageRuntimeContext(ownerState, 'tab-1');
        expect(context).toMatchObject({
            worktreeId: 'wt-1',
            worktreePath: '/repo/worktree',
            expectedExecutionHostId: 'local',
            settings: {
                activeRuntimeEnvironmentId: 'owner-a'
            }
        });
    });
});
