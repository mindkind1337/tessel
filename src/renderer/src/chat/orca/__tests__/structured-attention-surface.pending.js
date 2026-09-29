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
import { createStructuredAttentionSurface } from "../structured-attention-surface.js";
import { createTestStore, makeTabGroup, makeUnifiedTab } from '@/store/slices/store-test-helpers';
import { structuredAgentSessionPaneKey } from "../shared/structured-agent-session-projection.js";
import { makePaneKey } from "../shared/stable-pane-id.js";
const WORKSPACE = 'wt-1';
const GROUP = 'group-1';
const CHAT_TAB = 'chat-tab';
const SESSION = 'session-1';
const CHAT_SUBJECT = structuredAgentSessionPaneKey(CHAT_TAB, SESSION);
function seedChatTab(overrides) {
    const store = createTestStore();
    store.setState({
        unifiedTabsByWorktree: {
            [WORKSPACE]: [
                makeUnifiedTab({
                    id: CHAT_TAB,
                    worktreeId: WORKSPACE,
                    groupId: GROUP,
                    contentType: 'agent-session',
                    entityId: overrides?.sessionId ?? SESSION,
                    agentSessionAgent: 'claude'
                })
            ]
        },
        groupsByWorktree: {
            [WORKSPACE]: [
                makeTabGroup({
                    id: GROUP,
                    worktreeId: WORKSPACE,
                    activeTabId: overrides?.activeTabId === undefined ? CHAT_TAB : overrides.activeTabId,
                    tabOrder: [
                        CHAT_TAB
                    ]
                })
            ]
        },
        activeGroupIdByWorktree: {
            [WORKSPACE]: GROUP
        }
    });
    return store;
}
function surfaceFor(store) {
    return createStructuredAttentionSurface(store.getState());
}
describe('createStructuredAttentionSurface', ()=>{
    it('addresses a session by its published pane key and reports the unified tab as the container', ()=>{
        const surface = surfaceFor(seedChatTab());
        expect(surface.hasLiveSession({
            workspaceId: WORKSPACE,
            surfaceKey: CHAT_SUBJECT
        })).toBe(true);
        expect(surface.admitSurface({
            workspaceId: WORKSPACE,
            surfaceKey: CHAT_SUBJECT
        }, {
            hasLiveSession: true,
            hasFreshActivityEvidence: false
        })).toEqual({
            admitted: true,
            groupId: CHAT_TAB
        });
        expect(surface.resolveViewedSubjectKey(CHAT_TAB)).toBe(CHAT_SUBJECT);
    });
    it('rejects a key for the same tab whose session has moved on as superseded', ()=>{
        const store = seedChatTab({
            sessionId: 'session-2'
        });
        expect(surfaceFor(store).admitSurface({
            workspaceId: WORKSPACE,
            surfaceKey: CHAT_SUBJECT
        }, {
            hasLiveSession: true,
            hasFreshActivityEvidence: false
        })).toEqual({
            admitted: false,
            cause: 'superseded-surface'
        });
    });
    it('rejects a terminal pane key as a surface it does not own', ()=>{
        const surface = surfaceFor(seedChatTab());
        expect(surface.admitSurface({
            workspaceId: WORKSPACE,
            surfaceKey: makePaneKey('tab-1', CHAT_SUBJECT.split(':')[1])
        }, {
            hasLiveSession: true,
            hasFreshActivityEvidence: false
        })).toEqual({
            admitted: false,
            cause: 'unknown-surface'
        });
        expect(surface.resolveViewedSubjectKey('tab-1')).toBeNull();
    });
    it('rejects a surface key that is not a pane key', ()=>{
        expect(surfaceFor(seedChatTab()).admitSurface({
            workspaceId: WORKSPACE,
            surfaceKey: 'not-a-pane-key'
        }, {
            hasLiveSession: true,
            hasFreshActivityEvidence: false
        })).toEqual({
            admitted: false,
            cause: 'unknown-surface'
        });
    });
    it('treats the session as viewed only while its tab is the focused group active tab', ()=>{
        const store = seedChatTab();
        store.setState({
            activeWorktreeId: WORKSPACE
        });
        expect(surfaceFor(store).isSurfaceViewed({
            workspaceId: WORKSPACE,
            surfaceKey: CHAT_SUBJECT
        })).toBe(true);
        const hidden = seedChatTab({
            activeTabId: 'other-tab'
        });
        hidden.setState({
            activeWorktreeId: WORKSPACE
        });
        expect(surfaceFor(hidden).isSurfaceViewed({
            workspaceId: WORKSPACE,
            surfaceKey: CHAT_SUBJECT
        })).toBe(false);
    });
    it('collects the unread completion marker its live tab still owns', ()=>{
        const store = seedChatTab();
        store.setState({
            unreadAgentCompletionPanes: {
                [CHAT_SUBJECT]: 'agent-completion'
            },
            unreadTerminalTabs: {
                [CHAT_TAB]: 'agent-completion'
            }
        });
        expect(surfaceFor(store).collectWorkspaceAttentionRemainder(WORKSPACE)).toEqual({
            hasSurfaces: true,
            unreadSubjectKeys: [
                CHAT_SUBJECT
            ],
            unreadGroupIds: [
                CHAT_TAB
            ]
        });
    });
    it('ignores a marker left behind by a session the tab no longer runs', ()=>{
        const store = seedChatTab({
            sessionId: 'session-2'
        });
        store.setState({
            unreadAgentCompletionPanes: {
                [CHAT_SUBJECT]: 'agent-completion'
            }
        });
        expect(surfaceFor(store).collectWorkspaceAttentionRemainder(WORKSPACE)).toEqual({
            hasSurfaces: true,
            unreadSubjectKeys: [],
            unreadGroupIds: []
        });
    });
    it('reports a workspace with no structured tabs as owning no surfaces', ()=>{
        const store = createTestStore();
        store.setState({
            unreadAgentCompletionPanes: {
                [CHAT_SUBJECT]: 'agent-completion'
            }
        });
        expect(surfaceFor(store).collectWorkspaceAttentionRemainder(WORKSPACE)).toEqual({
            hasSurfaces: false,
            unreadSubjectKeys: [],
            unreadGroupIds: []
        });
    });
    it('ignores structured tabs owned by another workspace', ()=>{
        const store = seedChatTab();
        store.setState({
            unreadAgentCompletionPanes: {
                [CHAT_SUBJECT]: 'agent-completion'
            }
        });
        expect(surfaceFor(store).collectWorkspaceAttentionRemainder('wt-2')).toEqual({
            hasSurfaces: false,
            unreadSubjectKeys: [],
            unreadGroupIds: []
        });
    });
});
