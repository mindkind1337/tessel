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
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(()=>({
        toastLoading: vi.fn(()=>'toast-1'),
        toastDismiss: vi.fn(),
        toastError: vi.fn(),
        toastMessage: vi.fn(),
        resolveDroppedPathsForAgent: vi.fn()
    }));
vi.mock('sonner', ()=>({
        toast: {
            loading: mocks.toastLoading,
            dismiss: mocks.toastDismiss,
            error: mocks.toastError,
            message: mocks.toastMessage
        }
    }));
vi.mock('@/i18n/i18n', ()=>({
        translate: (_key, fallback)=>fallback
    }));
import { resolveNativeChatAttachmentOwner, resolveNativeChatAttachmentOwnerForWorktree, uploadNativeChatAttachmentPaths } from "../native-chat-attachment-upload.js";
function terminalTab(overrides = {}) {
    return {
        id: 'tab-1',
        ptyId: null,
        worktreeId: 'wt-1',
        title: 'Terminal 1',
        customTitle: null,
        color: null,
        sortOrder: 0,
        createdAt: 0,
        ...overrides
    };
}
function state(overrides = {}) {
    return {
        folderWorkspaces: [],
        getKnownWorktreeById: (worktreeId)=>worktreeId === 'wt-1' ? {
                id: 'wt-1',
                path: '/repo/worktree'
            } : undefined,
        projectGroups: [],
        repos: [
            {
                id: 'repo',
                connectionId: null
            }
        ],
        settings: {
            activeRuntimeEnvironmentId: null
        },
        sshConnectionStates: new Map(),
        tabsByWorktree: {
            'wt-1': [
                terminalTab()
            ]
        },
        worktreesByRepo: {
            repo: [
                {
                    id: 'wt-1',
                    repoId: 'repo',
                    path: '/repo/worktree'
                }
            ]
        },
        ...overrides
    };
}
describe('resolveNativeChatAttachmentOwner', ()=>{
    it('resolves a local repo worktree to local', ()=>{
        expect(resolveNativeChatAttachmentOwner(state(), 'tab-1')).toEqual({
            kind: 'local'
        });
    });
    it('resolves a structured tab owner directly from its worktree', ()=>{
        expect(resolveNativeChatAttachmentOwnerForWorktree(state(), 'wt-1')).toEqual({
            kind: 'local'
        });
    });
    it('resolves a structured SSH owner directly from its worktree', ()=>{
        expect(resolveNativeChatAttachmentOwnerForWorktree(state({
            repos: [
                {
                    id: 'repo',
                    connectionId: 'conn-1'
                }
            ],
            sshConnectionStates: new Map([
                [
                    'conn-1',
                    {
                        connectionGeneration: 4
                    }
                ]
            ])
        }), 'wt-1')).toMatchObject({
            kind: 'ssh',
            connectionId: 'conn-1',
            worktreePath: '/repo/worktree'
        });
    });
    it('resolves an SSH repo worktree to ssh with the worktree path', ()=>{
        expect(resolveNativeChatAttachmentOwner(state({
            repos: [
                {
                    id: 'repo',
                    connectionId: 'conn-1'
                }
            ],
            sshConnectionStates: new Map([
                [
                    'conn-1',
                    {
                        connectionGeneration: 4
                    }
                ]
            ])
        }), 'tab-1')).toEqual({
            kind: 'ssh',
            connectionId: 'conn-1',
            worktreePath: '/repo/worktree',
            expectedExecutionHostId: 'ssh:conn-1',
            expectedSshTargetId: 'conn-1',
            expectedSshConnectionGeneration: 4
        });
    });
    it('resolves a runtime-owned repo to runtime', ()=>{
        expect(resolveNativeChatAttachmentOwner(state({
            repos: [
                {
                    id: 'repo',
                    connectionId: null,
                    executionHostId: 'runtime:env-1'
                }
            ]
        }), 'tab-1')).toEqual({
            kind: 'runtime'
        });
    });
    it('routes unowned repos to the focused runtime host, matching terminal drops', ()=>{
        expect(resolveNativeChatAttachmentOwner(state({
            settings: {
                activeRuntimeEnvironmentId: 'env-9'
            }
        }), 'tab-1')).toEqual({
            kind: 'runtime'
        });
    });
    it('reports not-ready when the tab has no worktree owner', ()=>{
        expect(resolveNativeChatAttachmentOwner(state({
            tabsByWorktree: {}
        }), 'tab-1')).toEqual({
            kind: 'not-ready'
        });
    });
    it('reports not-ready when the backing repo has not hydrated', ()=>{
        expect(resolveNativeChatAttachmentOwner(state({
            repos: []
        }), 'tab-1')).toEqual({
            kind: 'not-ready'
        });
    });
    it('reports not-ready instead of throwing when the SSH generation is gone', ()=>{
        expect(resolveNativeChatAttachmentOwner(state({
            repos: [
                {
                    id: 'repo',
                    connectionId: 'conn-1'
                }
            ],
            sshConnectionStates: new Map()
        }), 'tab-1')).toEqual({
            kind: 'not-ready'
        });
    });
    it('reports not-ready when an SSH worktree has no known path yet', ()=>{
        expect(resolveNativeChatAttachmentOwner(state({
            repos: [
                {
                    id: 'repo',
                    connectionId: 'conn-1'
                }
            ],
            getKnownWorktreeById: ()=>undefined,
            worktreesByRepo: {
                repo: [
                    {
                        id: 'wt-1',
                        repoId: 'repo'
                    }
                ]
            },
            tabsByWorktree: {
                'wt-1': [
                    terminalTab()
                ]
            }
        }), 'tab-1')).toEqual({
            kind: 'not-ready'
        });
    });
});
describe('uploadNativeChatAttachmentPaths', ()=>{
    const owner = {
        kind: 'ssh',
        connectionId: 'conn-1',
        worktreePath: '/remote/worktree',
        expectedExecutionHostId: 'ssh:conn-1',
        expectedSshTargetId: 'conn-1',
        expectedSshConnectionGeneration: 4
    };
    beforeEach(()=>{
        vi.clearAllMocks();
        vi.stubGlobal('window', {
            api: {
                fs: {
                    resolveDroppedPathsForAgent: mocks.resolveDroppedPathsForAgent
                }
            }
        });
    });
    it('uploads through the terminal drop resolver and returns remote paths', async ()=>{
        mocks.resolveDroppedPathsForAgent.mockResolvedValue({
            resolvedPaths: [
                '/remote/worktree/.orca/drops/a.txt'
            ],
            skipped: [],
            failed: []
        });
        await expect(uploadNativeChatAttachmentPaths([
            '/local/a.txt'
        ], owner)).resolves.toEqual([
            '/remote/worktree/.orca/drops/a.txt'
        ]);
        expect(mocks.resolveDroppedPathsForAgent).toHaveBeenCalledWith({
            paths: [
                '/local/a.txt'
            ],
            worktreePath: '/remote/worktree',
            connectionId: 'conn-1',
            expectedExecutionHostId: 'ssh:conn-1',
            expectedSshTargetId: 'conn-1',
            expectedSshConnectionGeneration: 4
        });
        expect(mocks.toastLoading).toHaveBeenCalledTimes(1);
        expect(mocks.toastDismiss).toHaveBeenCalledWith('toast-1');
    });
    it('surfaces per-file skips and failures through the shared drop toasts', async ()=>{
        mocks.resolveDroppedPathsForAgent.mockResolvedValue({
            resolvedPaths: [],
            skipped: [
                {
                    sourcePath: '/local/link',
                    reason: 'symlink'
                }
            ],
            failed: [
                {
                    sourcePath: '/local/b.txt',
                    reason: 'boom'
                }
            ]
        });
        await expect(uploadNativeChatAttachmentPaths([
            '/local/link',
            '/local/b.txt'
        ], owner)).resolves.toEqual([]);
        expect(mocks.toastMessage).toHaveBeenCalledTimes(1);
        expect(mocks.toastError).toHaveBeenCalledTimes(1);
    });
    it('returns null and reports when the upload IPC fails', async ()=>{
        mocks.resolveDroppedPathsForAgent.mockRejectedValue(new Error('sftp down'));
        await expect(uploadNativeChatAttachmentPaths([
            '/local/a.txt'
        ], owner)).resolves.toBeNull();
        expect(mocks.toastError).toHaveBeenCalledTimes(1);
        expect(mocks.toastDismiss).toHaveBeenCalledWith('toast-1');
    });
});
