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
import { isRootAgentJournalItem } from "./agent-session-journal-producer.js";
import { AGENT_JOURNAL_THREAD_GOAL_STATUSES } from "./agent-session-journal-types.js";
const GOAL_FRAME_KINDS = new Set([
    'notification:thread/goal/updated',
    'notification:thread/goal/cleared'
]);
export function isAgentJournalThreadGoalStatus(value) {
    return AGENT_JOURNAL_THREAD_GOAL_STATUSES.some((status)=>status === value);
}
export function isAgentSessionThreadGoalFrame(frame) {
    return frame?.provider === 'codex' && GOAL_FRAME_KINDS.has(frame.kind);
}
export function isAgentJournalThreadGoalRow(body) {
    return body.kind === 'status' && (body.threadGoal !== undefined || isAgentSessionThreadGoalFrame(body.providerFrame));
}
function goalFromRow(body) {
    if (body.kind !== 'status' || body.threadGoal?.state !== 'set') {
        return null;
    }
    return isAgentJournalThreadGoalStatus(body.threadGoal.goal.status) ? body.threadGoal.goal : null;
}
function isGoalTransition(item) {
    return isRootAgentJournalItem(item) && isAgentJournalThreadGoalRow(item.body);
}
export function currentAgentSessionThreadGoal(items) {
    for(let index = items.length - 1; index >= 0; index -= 1){
        const item = items[index];
        if (item && isGoalTransition(item)) {
            return goalFromRow(item.body);
        }
    }
    return undefined;
}
export function currentAgentSessionThreadGoalBySequence(items) {
    let latest = null;
    for (const item of items){
        if (isGoalTransition(item) && (latest === null || item.sequence > latest.sequence)) {
            latest = item;
        }
    }
    return latest === null ? undefined : goalFromRow(latest.body);
}
export function isAgentSessionThreadGoalOpen(goal) {
    return goal !== null && goal.status !== 'complete';
}
export function agentSessionThreadGoalStatusChange(status) {
    switch(status){
        case 'active':
            return 'paused';
        case 'paused':
        case 'blocked':
        case 'usageLimited':
            return 'active';
        case 'budgetLimited':
        case 'complete':
            return null;
    }
}
export function agentSessionThreadGoalElapsedSeconds(goal, now, runningTurn) {
    const reported = Math.max(0, goal.timeUsedSeconds);
    if (goal.status !== 'active' || runningTurn === null) {
        return reported;
    }
    const since = Math.max(goal.updatedAt, runningTurn.startedAt ?? goal.updatedAt);
    return reported + Math.max(0, Math.floor((now - since) / 1000));
}
