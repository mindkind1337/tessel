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
import { folderWorkspaceKey } from "../shared/workspace-scope.js";
import { resolveNativeChatFileLink, resolveNativeChatFileLinkContext } from "../native-chat-file-link.js";
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
        repos: [],
        settings: {
            activeRuntimeEnvironmentId: null
        },
        tabsByWorktree: {
            'wt-1': [
                terminalTab()
            ]
        },
        unifiedTabsByWorktree: {},
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
const context = {
    worktreeId: 'wt-1',
    worktreePath: '/repo/worktree',
    runtimeEnvironmentId: null
};
describe('resolveNativeChatFileLinkContext', ()=>{
    it('returns the owner worktree path and runtime for a native chat terminal tab', ()=>{
        expect(resolveNativeChatFileLinkContext(state({
            settings: {
                activeRuntimeEnvironmentId: 'env-1'
            }
        }), 'tab-1')).toEqual({
            worktreeId: 'wt-1',
            worktreePath: '/repo/worktree',
            runtimeEnvironmentId: 'env-1'
        });
    });
    it('returns null when the terminal tab has no worktree owner', ()=>{
        expect(resolveNativeChatFileLinkContext(state({
            tabsByWorktree: {}
        }), 'tab-1')).toBeNull();
    });
    it('resolves the worktree context for a structured session tab', ()=>{
        const structuredTab = {
            id: 'structured-tab-1',
            worktreeId: 'wt-1',
            groupId: 'group-1',
            contentType: 'agent-session',
            entityId: 'session-1',
            label: 'Codex Chat',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 0,
            isPinned: false,
            agentSessionAgent: 'codex'
        };
        expect(resolveNativeChatFileLinkContext(state({
            tabsByWorktree: {},
            unifiedTabsByWorktree: {
                'wt-1': [
                    structuredTab
                ]
            }
        }), structuredTab.id)).toEqual(context);
    });
    it('falls back to repo-scoped worktrees when a known worktree has no path', ()=>{
        expect(resolveNativeChatFileLinkContext(state({
            getKnownWorktreeById: ()=>({
                    id: 'wt-1'
                }),
            worktreesByRepo: {
                repo: [
                    {
                        id: 'wt-1',
                        repoId: 'repo',
                        path: '/repo/fallback'
                    }
                ]
            }
        }), 'tab-1')).toEqual({
            worktreeId: 'wt-1',
            worktreePath: '/repo/fallback',
            runtimeEnvironmentId: null
        });
    });
    it('resolves a folder workspace tab from its folder path when no projected worktree path exists', ()=>{
        const folderId = 'folder-1';
        const folderKey = folderWorkspaceKey(folderId);
        const folderTab = terminalTab({
            worktreeId: folderKey
        });
        expect(resolveNativeChatFileLinkContext(state({
            tabsByWorktree: {
                [folderKey]: [
                    folderTab
                ]
            },
            getKnownWorktreeById: ()=>undefined,
            folderWorkspaces: [
                {
                    id: folderId,
                    folderPath: '/workspace/platform'
                }
            ],
            worktreesByRepo: {}
        }), folderTab.id)).toEqual({
            worktreeId: folderKey,
            worktreePath: '/workspace/platform',
            runtimeEnvironmentId: null
        });
    });
});
describe('resolveNativeChatFileLink', ()=>{
    it('resolves repo-relative file links against the chat worktree', ()=>{
        expect(resolveNativeChatFileLink('docs/guide.md', context)).toEqual({
            absolutePath: '/repo/worktree/docs/guide.md',
            line: null,
            column: null
        });
    });
    it('resolves explicit hrefs for non-markdown file types', ()=>{
        expect(resolveNativeChatFileLink('src/App.tsx#L42', context)).toEqual({
            absolutePath: '/repo/worktree/src/App.tsx',
            line: 42,
            column: null
        });
        expect(resolveNativeChatFileLink('package.json', context)).toEqual({
            absolutePath: '/repo/worktree/package.json',
            line: null,
            column: null
        });
        expect(resolveNativeChatFileLink('assets/logo.png?raw=true', context)).toEqual({
            absolutePath: '/repo/worktree/assets/logo.png',
            line: null,
            column: null
        });
        expect(resolveNativeChatFileLink('CODEOWNERS', context)).toEqual({
            absolutePath: '/repo/worktree/CODEOWNERS',
            line: null,
            column: null
        });
    });
    it('preserves terminal-style line and column suffixes', ()=>{
        expect(resolveNativeChatFileLink('/repo/worktree/src/main.ts:12:4', context)).toEqual({
            absolutePath: '/repo/worktree/src/main.ts',
            line: 12,
            column: 4
        });
    });
    it('resolves encoded file URIs', ()=>{
        expect(resolveNativeChatFileLink('file:///repo/worktree/My%20File.md#L7', context)).toEqual({
            absolutePath: '/repo/worktree/My File.md',
            line: 7,
            column: null
        });
    });
    it('decodes escaped reserved characters in repo-relative hrefs', ()=>{
        expect(resolveNativeChatFileLink('docs/Setup%20%231.md#L3', context)).toEqual({
            absolutePath: '/repo/worktree/docs/Setup #1.md',
            line: 3,
            column: null
        });
    });
    it('ignores http links so normal markdown navigation can handle them', ()=>{
        expect(resolveNativeChatFileLink('https://example.com/docs/guide.md', context)).toBeNull();
    });
});
