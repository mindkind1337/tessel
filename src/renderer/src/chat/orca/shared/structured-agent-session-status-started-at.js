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
import { readAgentJournalTurn } from "./agent-session-turn-record.js";
import { isUnansweredStructuredAgentSessionDispatch } from "./structured-agent-session-unanswered-dispatch.js";
export function structuredAgentSessionStatusStartedAt(status, items, submissions, currentFence) {
    if (status === 'attention') {
        return oldestPendingPromptAt(items);
    }
    const turnItem = newestTurnItem(items);
    const turn = readAgentJournalTurn(turnItem?.body);
    if (status === 'idle') {
        if (!turnItem || !turn || turn.state === 'running') {
            return undefined;
        }
        return turnItem.recoveredAt ?? turn.completedAt;
    }
    if (turnItem && turn?.state === 'running') {
        return turn.requestedAt ?? turn.startedAt ?? turnItem.observedAt;
    }
    let earliest;
    for (const submission of submissions){
        if (isUnansweredStructuredAgentSessionDispatch(submission, currentFence) && (earliest === undefined || submission.submittedAt < earliest)) {
            earliest = submission.submittedAt;
        }
    }
    return earliest;
}
function newestTurnItem(items) {
    for(let index = items.length - 1; index >= 0; index -= 1){
        const item = items[index];
        if (item && readAgentJournalTurn(item.body)) {
            return item;
        }
    }
    return null;
}
function oldestPendingPromptAt(items) {
    let own;
    let subagent;
    for (const item of items){
        if (item.body.kind !== 'approval' && item.body.kind !== 'question' || item.body.resolution.state !== 'pending') {
            continue;
        }
        if (isRootAgentJournalItem(item)) {
            own = Math.min(own ?? item.observedAt, item.observedAt);
        } else {
            subagent = Math.min(subagent ?? item.observedAt, item.observedAt);
        }
    }
    return own ?? subagent;
}
export function structuredAgentSessionDatedMainAgent(mainAgent, summary) {
    return summary.statusStartedAt === undefined ? mainAgent : {
        ...mainAgent,
        stateStartedAt: summary.statusStartedAt
    };
}
export function structuredAgentSessionRowStateStartedAt(row, summary) {
    return row.state === row.mainAgent.state ? summary.statusStartedAt : undefined;
}
