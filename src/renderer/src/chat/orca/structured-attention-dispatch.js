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
import { AGENT_JOURNAL_TURN_OUTCOMES } from "./shared/agent-session-journal-types.js";
import { buildAgentNotificationId } from "./shared/agent-notification-id.js";
import { structuredAgentSessionPaneKey } from "./shared/structured-agent-session-projection.js";
import { applyAgentAttention, resolveAgentAttention } from '@/attention/agent-attention-policy';
import { deliverAgentAttentionNotification, readAgentAttentionNotificationSound } from '@/attention/agent-attention-notification-delivery';
import { useAppStore } from '@/store';
import { getNotificationWorkspaceLabels } from '../terminal-pane/terminal-notification-state';
import { createStructuredAttentionSurface } from "./structured-attention-surface.js";
export function dispatchStructuredTurnCompletionAttention(tab, completion) {
    if (!AGENT_JOURNAL_TURN_OUTCOMES.includes(completion.outcome)) {
        return;
    }
    if (completion.sessionId !== tab.entityId) {
        return;
    }
    const state = useAppStore.getState();
    const paneKey = structuredAgentSessionPaneKey(tab.id, tab.entityId);
    const decision = resolveAgentAttention({
        subject: {
            workspaceId: tab.worktreeId,
            surfaceKey: paneKey
        },
        reason: 'agent-completion',
        settlesTurn: true,
        hasFreshActivityEvidence: true,
        groupAttentionEnabled: state.settings?.experimentalTerminalAttention === true
    }, createStructuredAttentionSurface(state));
    if (!decision.admitted) {
        return;
    }
    const row = state.agentStatusByPaneKey[paneKey];
    const notificationId = buildAgentNotificationId({
        worktreeId: tab.worktreeId,
        paneKey,
        stateStartedAt: row?.stateStartedAt
    });
    const sound = readAgentAttentionNotificationSound(state.settings ?? {});
    applyAgentAttention(decision, {
        unread: {
            markWorkspaceUnread: state.markWorktreeUnread,
            markSubjectUnread: state.markAgentCompletionPaneUnread,
            markGroupUnread: state.markTerminalTabUnread,
            markSurfaceUnread: state.markTerminalPaneUnread
        },
        requestDelivery: (request)=>{
            deliverAgentAttentionNotification({
                source: 'agent-task-complete',
                surface: 'agent-session',
                ...notificationId ? {
                    notificationId
                } : {},
                worktreeId: request.workspaceId,
                paneKey: request.subjectKey ?? undefined,
                ...getNotificationWorkspaceLabels(state, request.workspaceId, tab.label),
                terminalTitle: tab.label,
                isActiveWorktree: request.workspaceIsActive,
                ...row?.agentType ? {
                    agentType: row.agentType
                } : {},
                agentState: 'done',
                agentInterrupted: completion.outcome !== 'success',
                ...row?.prompt ? {
                    agentPrompt: row.prompt
                } : {},
                ...row?.lastAssistantMessage ? {
                    agentLastAssistantMessage: row.lastAssistantMessage
                } : {}
            }, sound);
        }
    });
}
