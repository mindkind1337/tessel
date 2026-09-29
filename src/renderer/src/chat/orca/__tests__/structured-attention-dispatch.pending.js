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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { structuredAgentSessionPaneKey } from "../shared/structured-agent-session-projection.js";
import { createTestStore, makeTabGroup, makeUnifiedTab, makeWorktree, TEST_REPO } from '@/store/slices/store-test-helpers';
import { isStructuredTab } from "../structured-agent-session-tabs.js";
vi.mock('@/store', ()=>({
        useAppStore: {
            getState: ()=>store.getState()
        }
    }));
vi.mock('@/lib/desktop-notification-sound', ()=>({
        playDesktopNotificationSound: vi.fn(async ()=>false)
    }));
vi.mock('@/lib/blocked-notification-fallback', ()=>({
        showBlockedNotificationFallbackToast: vi.fn()
    }));
const store = createTestStore();
const dispatched = [];
const dismissed = [];
const { dispatchStructuredTurnCompletionAttention } = await import('./structured-attention-dispatch');
const WORKSPACE = 'repo1::/tmp/wt';
const GROUP = 'group-1';
const CHAT_TAB = 'chat-tab';
const SESSION = 'session-1';
function settingsWith(groupAttention) {
    return {
        experimentalTerminalAttention: groupAttention
    };
}
function completion(overrides) {
    return {
        scope: {
            executionHostId: 'local',
            wslDistro: null,
            workspaceId: 'host-side-workspace',
            workspaceKind: 'git-worktree'
        },
        sessionId: SESSION,
        turnId: 'turn-1',
        outcome: 'success',
        completedAt: 1_700,
        ...overrides
    };
}
function seed(overrides) {
    const workspaceId = overrides?.workspaceId ?? WORKSPACE;
    store.setState({
        repos: [
            TEST_REPO
        ],
        worktreesByRepo: {
            repo1: [
                makeWorktree({
                    id: WORKSPACE,
                    repoId: 'repo1'
                })
            ]
        },
        folderWorkspaces: overrides?.folderWorkspaces ?? [],
        unifiedTabsByWorktree: {
            [workspaceId]: overrides?.tabs === false ? [] : [
                makeUnifiedTab({
                    id: CHAT_TAB,
                    worktreeId: workspaceId,
                    groupId: GROUP,
                    contentType: 'agent-session',
                    entityId: overrides?.sessionId ?? SESSION,
                    agentSessionAgent: 'claude'
                })
            ]
        },
        groupsByWorktree: {
            [workspaceId]: [
                makeTabGroup({
                    id: GROUP,
                    worktreeId: workspaceId,
                    activeTabId: overrides?.activeTabId === undefined ? CHAT_TAB : overrides.activeTabId,
                    tabOrder: [
                        CHAT_TAB
                    ]
                })
            ]
        },
        activeGroupIdByWorktree: {
            [workspaceId]: GROUP
        },
        activeWorktreeId: overrides?.activeWorktreeId === undefined ? 'other-workspace' : overrides.activeWorktreeId,
        unreadTerminalTabs: {},
        unreadTerminalPanes: {},
        unreadAgentCompletionPanes: {},
        settings: settingsWith(overrides?.groupAttention ?? true),
        updateFolderWorkspace: async ()=>true
    });
}
function onlyDispatch() {
    expect(dispatched).toHaveLength(1);
    return dispatched[0];
}
function structuredTab(workspaceId = WORKSPACE) {
    const found = (store.getState().unifiedTabsByWorktree[workspaceId] ?? []).find(isStructuredTab);
    if (!found) {
        throw new Error('seed() did not put a structured tab in the store');
    }
    return found;
}
function indicators(workspaceId = WORKSPACE) {
    const state = store.getState();
    const subject = structuredAgentSessionPaneKey(CHAT_TAB, SESSION);
    return {
        workspaceBold: workspaceId === WORKSPACE ? state.worktreesByRepo.repo1?.[0]?.isUnread === true : state.folderWorkspaces[0]?.isUnread === true,
        paneDot: state.unreadAgentCompletionPanes[subject],
        tabDot: state.unreadTerminalTabs[CHAT_TAB],
        surfaceDot: state.unreadTerminalPanes[subject]
    };
}
const NOTHING_LIT = {
    workspaceBold: false,
    paneDot: undefined,
    tabDot: undefined,
    surfaceDot: undefined
};
describe('dispatchStructuredTurnCompletionAttention', ()=>{
    beforeEach(()=>{
        dispatched.length = 0;
        dismissed.length = 0;
        vi.stubGlobal('window', {
            api: {
                notifications: {
                    dispatch: async (request)=>{
                        dispatched.push(request);
                        return {
                            delivered: true
                        };
                    },
                    dismiss: async (ids)=>{
                        dismissed.push(ids);
                        return {
                            dismissed: ids.length
                        };
                    }
                }
            }
        });
        seed();
    });
    afterEach(()=>{
        vi.unstubAllGlobals();
    });
    it('lights workspace bold, the amber pane dot and the tab dot for a successful turn', ()=>{
        dispatchStructuredTurnCompletionAttention(structuredTab(), completion());
        expect(indicators()).toEqual({
            workspaceBold: true,
            paneDot: 'agent-completion',
            tabDot: 'agent-completion',
            surfaceDot: 'agent-completion'
        });
    });
    it.each([
        'failure',
        'cancellation'
    ])('lights the same indicators for a %s outcome, because the user is still being called back', (outcome)=>{
        dispatchStructuredTurnCompletionAttention(structuredTab(), completion({
            outcome
        }));
        expect(indicators()).toEqual({
            workspaceBold: true,
            paneDot: 'agent-completion',
            tabDot: 'agent-completion',
            surfaceDot: 'agent-completion'
        });
    });
    it('lights nothing when the outcome is absent, because absent is UNKNOWN and never a verdict', ()=>{
        const withoutOutcome = completion();
        Reflect.deleteProperty(withoutOutcome, 'outcome');
        dispatchStructuredTurnCompletionAttention(structuredTab(), withoutOutcome);
        expect(indicators()).toEqual(NOTHING_LIT);
        expect(dispatched).toEqual([]);
    });
    it('earns no unread while the user is looking at that chat, but still asks main to deliver', ()=>{
        seed({
            activeWorktreeId: WORKSPACE
        });
        dispatchStructuredTurnCompletionAttention(structuredTab(), completion());
        expect(indicators()).toEqual(NOTHING_LIT);
        expect(onlyDispatch().isActiveWorktree).toBe(true);
    });
    it('still earns unread when the workspace is selected but the chat is hidden behind another tab', ()=>{
        seed({
            activeWorktreeId: WORKSPACE,
            activeTabId: 'other-tab'
        });
        dispatchStructuredTurnCompletionAttention(structuredTab(), completion());
        expect(indicators().paneDot).toBe('agent-completion');
    });
    it('words a successful turn as finished and a stopped one through the shipped interrupted flag', ()=>{
        dispatchStructuredTurnCompletionAttention(structuredTab(), completion());
        expect(onlyDispatch()).toMatchObject({
            source: 'agent-task-complete',
            surface: 'agent-session',
            agentState: 'done',
            agentInterrupted: false
        });
        dispatched.length = 0;
        seed();
        dispatchStructuredTurnCompletionAttention(structuredTab(), completion({
            outcome: 'cancellation',
            turnId: 'turn-2'
        }));
        expect(onlyDispatch()).toMatchObject({
            agentState: 'done',
            agentInterrupted: true
        });
    });
    it('says done even while the status row still reads working, because the host settled the turn', ()=>{
        const paneKey = structuredAgentSessionPaneKey(CHAT_TAB, SESSION);
        store.setState({
            agentStatusByPaneKey: {
                [paneKey]: {
                    state: 'working',
                    prompt: 'do the thing',
                    updatedAt: 5_000,
                    stateStartedAt: 5_000,
                    paneKey,
                    worktreeId: WORKSPACE,
                    agentType: 'claude',
                    stateHistory: []
                }
            }
        });
        dispatchStructuredTurnCompletionAttention(structuredTab(), completion());
        expect(onlyDispatch()).toMatchObject({
            agentState: 'done',
            agentInterrupted: false
        });
    });
    it('delivers an id the acknowledgement round trip dismisses when the user reads the chat', ()=>{
        const paneKey = structuredAgentSessionPaneKey(CHAT_TAB, SESSION);
        store.setState({
            agentStatusByPaneKey: {
                [paneKey]: {
                    state: 'done',
                    prompt: 'do the thing',
                    updatedAt: 5_000,
                    stateStartedAt: 5_000,
                    paneKey,
                    worktreeId: WORKSPACE,
                    agentType: 'claude',
                    stateHistory: []
                }
            }
        });
        dispatchStructuredTurnCompletionAttention(structuredTab(), completion());
        const deliveredId = onlyDispatch().notificationId;
        expect(deliveredId).toBeTruthy();
        store.getState().acknowledgeAgents([
            paneKey
        ]);
        expect(dismissed).toEqual([
            [
                deliveredId
            ]
        ]);
    });
    it('rejects a completion for a session this tab does not own', ()=>{
        seed({
            sessionId: 'session-2'
        });
        dispatchStructuredTurnCompletionAttention(structuredTab(), completion());
        expect(indicators()).toEqual(NOTHING_LIT);
        expect(store.getState().unreadAgentCompletionPanes).toEqual({});
    });
    it('rejects a superseded surface when the tab was rebound after the caller read it', ()=>{
        const staleTab = structuredTab();
        seed({
            sessionId: 'session-2'
        });
        dispatchStructuredTurnCompletionAttention(staleTab, completion());
        expect(indicators()).toEqual(NOTHING_LIT);
    });
    it('rejects an unknown surface when the tab has been closed', ()=>{
        const closedTab = structuredTab();
        seed({
            tabs: false
        });
        dispatchStructuredTurnCompletionAttention(closedTab, completion());
        expect(indicators()).toEqual(NOTHING_LIT);
    });
    it('withholds only the tab dot when group attention is off, keeping the pane dot', ()=>{
        seed({
            groupAttention: false
        });
        dispatchStructuredTurnCompletionAttention(structuredTab(), completion());
        expect(indicators()).toEqual({
            workspaceBold: true,
            paneDot: 'agent-completion',
            tabDot: undefined,
            surfaceDot: undefined
        });
    });
    it('lights a folder workspace, which is not a git worktree', ()=>{
        const folderWorkspaceId = 'folder:fw-1';
        seed({
            workspaceId: folderWorkspaceId,
            folderWorkspaces: [
                {
                    id: 'fw-1',
                    projectGroupId: 'pg-1',
                    name: 'Folder workspace',
                    folderPath: '/tmp/folder',
                    connectionId: null,
                    linkedTask: null,
                    comment: '',
                    isArchived: false,
                    isUnread: false,
                    isPinned: false,
                    sortOrder: 1,
                    lastActivityAt: 0,
                    createdAt: 1,
                    updatedAt: 1
                }
            ]
        });
        dispatchStructuredTurnCompletionAttention(structuredTab(folderWorkspaceId), completion());
        expect(indicators(folderWorkspaceId)).toEqual({
            workspaceBold: true,
            paneDot: 'agent-completion',
            tabDot: 'agent-completion',
            surfaceDot: 'agent-completion'
        });
    });
    it('is idempotent, so a redelivered completion does not stack markers', ()=>{
        dispatchStructuredTurnCompletionAttention(structuredTab(), completion());
        dispatchStructuredTurnCompletionAttention(structuredTab(), completion());
        expect(indicators().paneDot).toBe('agent-completion');
    });
});
