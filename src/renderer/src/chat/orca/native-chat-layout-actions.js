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
import { useAppStore } from '@/store';
import { canMoveTabToNewPaneColumnFromState, moveTabToNewPaneColumn } from '@/components/tab-bar/tab-move-to-pane-column';
import { requestActiveTerminalPaneSplit } from '@/components/tab-bar/request-active-terminal-pane-split';
export function resolveActiveNativeChatSplitTarget(state, worktreeId, groupId) {
    if (!worktreeId || !groupId) {
        return null;
    }
    const group = (state.groupsByWorktree?.[worktreeId] ?? []).find((entry)=>entry.id === groupId);
    const tab = (state.unifiedTabsByWorktree?.[worktreeId] ?? []).find((entry)=>entry.id === group?.activeTabId && entry.groupId === groupId);
    if (tab?.contentType === 'agent-session') {
        return {
            kind: 'workspace-tab',
            unifiedTabId: tab.id,
            groupId
        };
    }
    if (tab?.contentType === 'terminal' && tab.viewMode === 'chat') {
        return {
            kind: 'terminal-pane',
            terminalTabId: tab.entityId
        };
    }
    return null;
}
export function canRunNativeChatSplitTarget(state, target) {
    if (!target) {
        return false;
    }
    return target.kind === 'terminal-pane' || canMoveTabToNewPaneColumnFromState(state, target.unifiedTabId, target.groupId);
}
export function runNativeChatSplitTarget(target, direction) {
    if (target.kind === 'terminal-pane') {
        requestActiveTerminalPaneSplit({
            tabId: target.terminalTabId,
            direction: direction === 'right' ? 'vertical' : 'horizontal'
        });
        return true;
    }
    return moveTabToNewPaneColumn({
        unifiedTabId: target.unifiedTabId,
        groupId: target.groupId,
        direction
    });
}
export function runActiveNativeChatSplit(worktreeId, groupId, direction) {
    const state = useAppStore.getState();
    const target = resolveActiveNativeChatSplitTarget(state, worktreeId, groupId);
    return target ? runNativeChatSplitTarget(target, direction) : false;
}
