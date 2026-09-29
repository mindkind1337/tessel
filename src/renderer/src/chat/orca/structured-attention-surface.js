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
import { parsePaneKey } from "./shared/stable-pane-id.js";
import { structuredAgentSessionPaneKey } from "./shared/structured-agent-session-projection.js";
import { isOrcaWindowForegroundFocused } from '../terminal-pane/terminal-notification-pane-visibility';
import { isStructuredTab } from "./structured-agent-session-tabs.js";
function structuredTabsIn(state, workspaceId) {
    return (state.unifiedTabsByWorktree[workspaceId] ?? []).filter(isStructuredTab);
}
function findSubjectTab(state, workspaceId, surfaceKey) {
    const parsed = parsePaneKey(surfaceKey);
    if (!parsed) {
        return null;
    }
    const tab = structuredTabsIn(state, workspaceId).find((candidate)=>candidate.id === parsed.tabId);
    if (!tab || structuredAgentSessionPaneKey(tab.id, tab.entityId) !== surfaceKey) {
        return null;
    }
    return tab;
}
function admitStructuredSession(state, subject) {
    const parsed = parsePaneKey(subject.surfaceKey);
    if (!parsed) {
        return {
            admitted: false,
            cause: 'unknown-surface'
        };
    }
    const tab = structuredTabsIn(state, subject.workspaceId).find((candidate)=>candidate.id === parsed.tabId);
    if (!tab) {
        return {
            admitted: false,
            cause: 'unknown-surface'
        };
    }
    return structuredAgentSessionPaneKey(tab.id, tab.entityId) === subject.surfaceKey ? {
        admitted: true,
        groupId: tab.id
    } : {
        admitted: false,
        cause: 'superseded-surface'
    };
}
function isViewedStructuredTab(state, workspaceId, tab) {
    if (!isOrcaWindowForegroundFocused() || state.activeWorktreeId !== workspaceId) {
        return false;
    }
    const activeGroupId = state.activeGroupIdByWorktree[workspaceId];
    const group = (state.groupsByWorktree[workspaceId] ?? []).find((candidate)=>candidate.id === activeGroupId);
    return group?.activeTabId === tab.id;
}
function collectStructuredAttentionRemainder(state, workspaceId) {
    const tabs = structuredTabsIn(state, workspaceId);
    if (tabs.length === 0) {
        return {
            hasSurfaces: false,
            unreadSubjectKeys: [],
            unreadGroupIds: []
        };
    }
    const unreadSubjectKeys = [];
    const unreadGroupIds = [];
    for (const tab of tabs){
        const subjectKey = structuredAgentSessionPaneKey(tab.id, tab.entityId);
        if (state.unreadAgentCompletionPanes[subjectKey]) {
            unreadSubjectKeys.push(subjectKey);
        }
        if (state.unreadTerminalTabs[tab.id]) {
            unreadGroupIds.push(tab.id);
        }
    }
    return {
        hasSurfaces: true,
        unreadSubjectKeys,
        unreadGroupIds
    };
}
export function createStructuredAttentionSurface(state) {
    return {
        hasLiveSession: (subject)=>subject.surfaceKey === undefined ? structuredTabsIn(state, subject.workspaceId).length > 0 : findSubjectTab(state, subject.workspaceId, subject.surfaceKey) !== null,
        admitSurface: (subject)=>admitStructuredSession(state, subject),
        isSurfaceViewed: (subject)=>{
            const tab = findSubjectTab(state, subject.workspaceId, subject.surfaceKey);
            return tab !== null && isViewedStructuredTab(state, subject.workspaceId, tab);
        },
        isWorkspaceViewed: (workspaceId)=>state.activeWorktreeId === workspaceId && isOrcaWindowForegroundFocused(),
        isWorkspaceActive: (workspaceId)=>state.activeWorktreeId === workspaceId,
        resolveViewedSubjectKey: (groupId)=>{
            const tab = Object.values(state.unifiedTabsByWorktree).flat().find((candidate)=>candidate.id === groupId);
            return tab && isStructuredTab(tab) ? structuredAgentSessionPaneKey(tab.id, tab.entityId) : null;
        },
        collectWorkspaceAttentionRemainder: (workspaceId)=>collectStructuredAttentionRemainder(state, workspaceId)
    };
}
