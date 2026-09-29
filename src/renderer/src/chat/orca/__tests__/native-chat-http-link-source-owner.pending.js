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
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canNativeChatOpenOwnedBrowser, resolveNativeChatHttpLinkSourceOwner } from "../native-chat-http-link-source-owner.js";
const mocks = vi.hoisted(()=>({
        getRuntimeEnvironmentIdForWorktree: vi.fn(),
        getConnectionIdFromState: vi.fn(),
        canOpenWorkspaceBrowserTabOnRuntime: vi.fn(),
        canOpenWorkspaceBrowserTabOnSsh: vi.fn()
    }));
vi.mock('@/lib/worktree-runtime-owner', ()=>({
        getRuntimeEnvironmentIdForWorktree: mocks.getRuntimeEnvironmentIdForWorktree
    }));
vi.mock('@/lib/connection-owner-resolution', ()=>({
        getConnectionIdFromState: mocks.getConnectionIdFromState
    }));
vi.mock('@/lib/workspace-browser-tab-open', ()=>({
        canOpenWorkspaceBrowserTabOnRuntime: mocks.canOpenWorkspaceBrowserTabOnRuntime,
        canOpenWorkspaceBrowserTabOnSsh: mocks.canOpenWorkspaceBrowserTabOnSsh
    }));
const state = {};
afterEach(()=>{
    vi.clearAllMocks();
});
describe('resolveNativeChatHttpLinkSourceOwner', ()=>{
    it('prefers the workspace runtime owner', ()=>{
        mocks.getRuntimeEnvironmentIdForWorktree.mockReturnValue('env-1');
        expect(resolveNativeChatHttpLinkSourceOwner(state, 'wt-1')).toEqual({
            kind: 'runtime',
            runtimeEnvironmentId: 'env-1'
        });
        expect(mocks.getConnectionIdFromState).not.toHaveBeenCalled();
    });
    it('falls back to the SSH connection that owns the workspace', ()=>{
        mocks.getRuntimeEnvironmentIdForWorktree.mockReturnValue(null);
        mocks.getConnectionIdFromState.mockReturnValue('ssh-1');
        expect(resolveNativeChatHttpLinkSourceOwner(state, 'wt-1')).toEqual({
            kind: 'ssh',
            connectionId: 'ssh-1'
        });
    });
    it('reads a null connection as local', ()=>{
        mocks.getRuntimeEnvironmentIdForWorktree.mockReturnValue(null);
        mocks.getConnectionIdFromState.mockReturnValue(null);
        expect(resolveNativeChatHttpLinkSourceOwner(state, 'wt-1')).toEqual({
            kind: 'local'
        });
    });
    it('reports an unresolved owner as unknown', ()=>{
        mocks.getRuntimeEnvironmentIdForWorktree.mockReturnValue(null);
        mocks.getConnectionIdFromState.mockReturnValue(undefined);
        expect(resolveNativeChatHttpLinkSourceOwner(state, 'wt-1')).toEqual({
            kind: 'unknown'
        });
    });
});
describe('canNativeChatOpenOwnedBrowser', ()=>{
    it('asks the runtime browser-route check for a runtime owner', ()=>{
        mocks.canOpenWorkspaceBrowserTabOnRuntime.mockReturnValue(true);
        expect(canNativeChatOpenOwnedBrowser(state, 'wt-1', {
            kind: 'runtime',
            runtimeEnvironmentId: 'env-1'
        })).toBe(true);
        expect(mocks.canOpenWorkspaceBrowserTabOnRuntime).toHaveBeenCalledWith(state, 'wt-1', 'env-1');
    });
    it('asks the SSH browser-route check for an SSH owner', ()=>{
        mocks.canOpenWorkspaceBrowserTabOnSsh.mockReturnValue(false);
        expect(canNativeChatOpenOwnedBrowser(state, 'wt-1', {
            kind: 'ssh',
            connectionId: 'ssh-1'
        })).toBe(false);
        expect(mocks.canOpenWorkspaceBrowserTabOnSsh).toHaveBeenCalledWith(state, 'wt-1', 'ssh-1');
    });
    it('never claims an owned browser for local or unknown owners', ()=>{
        expect(canNativeChatOpenOwnedBrowser(state, 'wt-1', {
            kind: 'local'
        })).toBe(false);
        expect(canNativeChatOpenOwnedBrowser(state, 'wt-1', {
            kind: 'unknown'
        })).toBe(false);
    });
});
