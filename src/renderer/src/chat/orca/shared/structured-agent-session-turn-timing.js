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
import { agentJournalSubmissionKey } from "./agent-session-journal-item-key.js";
import { readAgentJournalTurn } from "./agent-session-turn-record.js";
function readTiming(item) {
    const turn = readAgentJournalTurn(item.body);
    if (!turn) {
        return null;
    }
    const { state, startedAt, requestedAt, completedAt, durationMs } = turn;
    if (startedAt === undefined || !Number.isFinite(startedAt) || startedAt <= 0) {
        return null;
    }
    const requested = requestedAt !== undefined && Number.isFinite(requestedAt) && requestedAt > 0 ? requestedAt : undefined;
    const end = completedAt !== undefined && Number.isFinite(completedAt) && completedAt >= startedAt ? completedAt : undefined;
    const measured = durationMs !== undefined && Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : undefined;
    return {
        state,
        startedAt,
        ...requested !== undefined ? {
            requestedAt: requested
        } : {},
        ...end !== undefined ? {
            completedAt: end
        } : {},
        ...measured !== undefined ? {
            durationMs: measured
        } : {},
        observedAt: item.observedAt
    };
}
export function selectStructuredAgentTurnTimings(items, submissions = []) {
    const itemIds = new Set(items.map((item)=>item.itemId));
    const aliases = new Map();
    for (const submission of submissions){
        if (submission.providerItemId && !aliases.has(submission.providerItemId)) {
            aliases.set(submission.providerItemId, agentJournalSubmissionKey(submission.clientMessageId));
        }
    }
    const timings = new Map();
    let precedingUserItemId = null;
    for (const item of items){
        if (item.body.kind === 'message' && item.body.role === 'user') {
            precedingUserItemId = item.itemId;
            continue;
        }
        const turn = readAgentJournalTurn(item.body);
        const timing = readTiming(item);
        if (!timing && turn?.state !== 'unverifiable') {
            continue;
        }
        const key = turn?.userItemId;
        const userItemId = key === undefined ? precedingUserItemId : itemIds.has(key) ? key : aliases.get(key) ?? null;
        if (userItemId !== null) {
            timings.set(userItemId, timing);
        }
    }
    return timings;
}
export function selectStructuredAgentRunningTurnTiming(items, turnId) {
    for(let index = items.length - 1; index >= 0; index -= 1){
        const item = items[index];
        if (item && readAgentJournalTurn(item.body)?.turnId === turnId) {
            return readTiming(item);
        }
    }
    return null;
}
export function structuredAgentTurnOrigin(timing) {
    return timing.requestedAt ?? timing.startedAt;
}
export function completedStructuredAgentTurnSeconds(timing) {
    if (!timing || timing.state !== 'completed' && timing.state !== 'interrupted') {
        return null;
    }
    if (timing.requestedAt !== undefined && timing.completedAt !== undefined) {
        return Math.max(0, Math.floor((timing.completedAt - timing.requestedAt) / 1000));
    }
    if (timing.durationMs !== undefined) {
        return Math.floor(timing.durationMs / 1000);
    }
    return timing.completedAt !== undefined ? Math.max(0, Math.floor((timing.completedAt - structuredAgentTurnOrigin(timing)) / 1000)) : null;
}
export function structuredAgentTurnLocalStartedAt(timing, firstSeenAt, hostNow) {
    const origin = structuredAgentTurnOrigin(timing);
    const hostElapsed = hostNow !== undefined && Number.isFinite(hostNow) ? hostNow - origin : timing.observedAt - origin;
    return firstSeenAt - Math.max(0, hostElapsed);
}
export function selectStructuredAgentSettledTurns(items, submissions = []) {
    const settled = new Map();
    for (const [userItemId, timing] of selectStructuredAgentTurnTimings(items, submissions)){
        const workedSeconds = completedStructuredAgentTurnSeconds(timing);
        settled.set(userItemId, workedSeconds === null || timing === null ? null : {
            startedAt: timing.startedAt,
            workedSeconds
        });
    }
    for (const submission of submissions){
        const userItemId = agentJournalSubmissionKey(submission.clientMessageId);
        if (submission.dispatchState === 'rejected' && !settled.has(userItemId)) {
            settled.set(userItemId, null);
        }
    }
    return settled;
}
