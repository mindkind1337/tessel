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
import { selectNativeChatRuntimeEnvironmentId } from "../native-chat-runtime-owner.js";
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
function worktreeRecord(hostId) {
    return {
        repo: [
            {
                id: 'wt-1',
                repoId: 'repo',
                hostId
            }
        ]
    };
}
function state(overrides = {}) {
    return {
        folderWorkspaces: [],
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
        worktreesByRepo: worktreeRecord('local'),
        ...overrides
    };
}
describe('selectNativeChatRuntimeEnvironmentId', ()=>{
    it('returns null for a local-owned worktree', ()=>{
        expect(selectNativeChatRuntimeEnvironmentId(state(), 'tab-1')).toBeNull();
    });
    it('returns the decoded environment id for a runtime-owned worktree', ()=>{
        expect(selectNativeChatRuntimeEnvironmentId(state({
            worktreesByRepo: worktreeRecord('runtime:env-1')
        }), 'tab-1')).toBe('env-1');
    });
    it('returns null for an ssh-connection worktree (Model A stays local)', ()=>{
        expect(selectNativeChatRuntimeEnvironmentId(state({
            worktreesByRepo: worktreeRecord('ssh:conn-1')
        }), 'tab-1')).toBeNull();
    });
    it('returns null when the terminal tab matches no tab in tabsByWorktree', ()=>{
        expect(selectNativeChatRuntimeEnvironmentId(state({
            tabsByWorktree: {}
        }), 'tab-1')).toBeNull();
    });
    it('returns the owner id even when the worktree record has no resolvable path', ()=>{
        expect(selectNativeChatRuntimeEnvironmentId(state({
            worktreesByRepo: worktreeRecord('runtime:env-1')
        }), 'tab-1')).toBe('env-1');
    });
});
