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
import { canRunNativeChatSplitTarget, resolveActiveNativeChatSplitTarget } from "../native-chat-layout-actions.js";
function stateWithActiveTab(tab, tabOrder = [
    'chat',
    'other'
]) {
    return {
        groupsByWorktree: {
            workspace: [
                {
                    id: 'group',
                    worktreeId: 'workspace',
                    activeTabId: 'chat',
                    tabOrder
                }
            ]
        },
        unifiedTabsByWorktree: {
            workspace: [
                {
                    id: 'chat',
                    entityId: 'session',
                    groupId: 'group',
                    worktreeId: 'workspace',
                    ...tab
                }
            ]
        }
    };
}
describe('native chat layout actions', ()=>{
    it('resolves structured chats to the reusable workspace-tab move path', ()=>{
        const state = stateWithActiveTab({
            contentType: 'agent-session'
        });
        const target = resolveActiveNativeChatSplitTarget(state, 'workspace', 'group');
        expect(target).toEqual({
            kind: 'workspace-tab',
            unifiedTabId: 'chat',
            groupId: 'group'
        });
        expect(canRunNativeChatSplitTarget(state, target)).toBe(true);
        expect(canRunNativeChatSplitTarget(stateWithActiveTab({
            contentType: 'agent-session'
        }, [
            'chat'
        ]), target)).toBe(false);
    });
    it('resolves terminal-backed chat mode to the existing pane split path', ()=>{
        const state = stateWithActiveTab({
            contentType: 'terminal',
            viewMode: 'chat'
        });
        expect(resolveActiveNativeChatSplitTarget(state, 'workspace', 'group')).toEqual({
            kind: 'terminal-pane',
            terminalTabId: 'session'
        });
        expect(resolveActiveNativeChatSplitTarget(stateWithActiveTab({
            contentType: 'terminal',
            viewMode: 'terminal'
        }), 'workspace', 'group')).toBeNull();
    });
});
