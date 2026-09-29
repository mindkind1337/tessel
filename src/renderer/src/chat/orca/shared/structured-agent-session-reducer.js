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
import { backgroundTaskStatesEqual } from "./agent-session-background-task-state-equality.js";
import { agentJournalSubmissionKey } from "./agent-session-journal-item-key.js";
import { readAgentJournalTurn } from "./agent-session-turn-record.js";
const MAX_RETAINED_SUBMISSIONS = 256;
const MAX_RETAINED_ITEMS = 1024;
export const EMPTY_STRUCTURED_AGENT_SESSION = {
    epoch: null,
    cursor: null,
    fence: null,
    items: [],
    submissions: [],
    retainedItemLimit: MAX_RETAINED_ITEMS,
    hasOlder: false,
    status: 'idle'
};
function hostClockField(hostNow, receivedAt, previous) {
    const hostClock = hostNow !== undefined ? {
        hostNow,
        receivedAt
    } : previous;
    return hostClock ? {
        hostClock
    } : {};
}
function replacePage(page, fence, backgroundTasks, activity) {
    return {
        epoch: page.epoch,
        cursor: page.liveCursor ?? page.window.nextCursor,
        fence,
        items: [
            ...page.items
        ].sort((left, right)=>left.sequence - right.sequence),
        submissions: page.submissions,
        retainedItemLimit: Math.max(MAX_RETAINED_ITEMS, page.items.length),
        hasOlder: page.hasOlder,
        status: 'ready',
        activity: activity ?? null,
        ...backgroundTasks !== undefined ? {
            backgroundTasks
        } : page.backgroundTasks !== undefined ? {
            backgroundTasks: page.backgroundTasks
        } : {}
    };
}
function mergeItems(current, incoming, removedIds) {
    const removed = new Set(removedIds);
    const byId = new Map(current.filter((item)=>!removed.has(item.itemId)).map((item)=>[
            item.itemId,
            item
        ]));
    for (const item of incoming){
        const prior = byId.get(item.itemId);
        if (!prior || item.revision >= prior.revision) {
            byId.set(item.itemId, item);
        }
    }
    return [
        ...byId.values()
    ].sort((left, right)=>left.sequence - right.sequence);
}
function liveItemsWithinWindow(state, incoming) {
    const head = state.items[0];
    if (!head || !state.hasOlder) {
        return incoming;
    }
    return incoming.filter((item)=>item.sequence >= head.sequence);
}
function trimRetainedItems(items, limit) {
    return items.length <= limit ? items : items.slice(items.length - limit);
}
function mergeSubmissions(current, incoming, items) {
    const byId = new Map(current.map((submission)=>[
            submission.clientMessageId,
            submission
        ]));
    for (const submission of incoming){
        byId.set(submission.clientMessageId, submission);
    }
    const sorted = [
        ...byId.values()
    ].sort((left, right)=>left.submittedAt - right.submittedAt);
    const itemIds = new Set(items.filter((item)=>item.body.kind === 'message' && item.body.role === 'user').map((item)=>item.itemId));
    return sorted.filter((submission, index)=>index >= sorted.length - MAX_RETAINED_SUBMISSIONS || itemIds.has(agentJournalSubmissionKey(submission.clientMessageId)));
}
export function reduceStructuredAgentSession(state, action, receivedAt = Date.now()) {
    if (action.type === 'loading') {
        return {
            ...state,
            status: 'loading',
            error: undefined
        };
    }
    if (action.type === 'error') {
        return {
            ...state,
            status: 'error',
            error: action.message
        };
    }
    if (action.type === 'history-page') {
        return {
            ...replacePage(action.page, action.page.fence ?? null, state.backgroundTasks, state.activity),
            commands: state.commands,
            ...hostClockField(action.page.hostNow, receivedAt, state.hostClock)
        };
    }
    if (action.type === 'older-page') {
        const requested = action.requestedCursor;
        if (state.epoch !== requested.epoch || action.page.epoch !== requested.epoch) {
            return state;
        }
        const head = state.items[0];
        if (head && head.sequence > requested.sequence) {
            return state;
        }
        const items = mergeItems(state.items, action.page.items, action.page.removedItemIds);
        return {
            ...state,
            items,
            retainedItemLimit: Math.max(state.retainedItemLimit, items.length),
            submissions: mergeSubmissions(state.submissions, action.page.submissions, items),
            hasOlder: action.page.hasOlder,
            ...hostClockField(action.page.hostNow, receivedAt, state.hostClock)
        };
    }
    const event = action.event;
    if (event.type === 'end') {
        return state;
    }
    if (event.type === 'snapshot' || event.type === 'reset') {
        return {
            ...replacePage(event.page, event.fence, event.backgroundTasks, event.activity),
            commands: event.commands,
            ...hostClockField(event.hostNow, receivedAt, state.hostClock)
        };
    }
    if (state.epoch !== event.batch.cursor.epoch) {
        return state;
    }
    if (state.cursor && event.batch.cursor.sequence < state.cursor.sequence) {
        return state;
    }
    const backgroundTasks = event.backgroundTasks !== undefined ? event.backgroundTasks : state.backgroundTasks;
    const activity = event.activity !== undefined ? event.activity : state.activity;
    const liveItems = liveItemsWithinWindow(state, event.batch.items);
    const journalUnchanged = liveItems.length === 0 && event.batch.removedItemIds.length === 0 && event.batch.submissions.length === 0;
    if (event.batch.cursor.sequence === state.cursor?.sequence && journalUnchanged && (event.fence === undefined || event.fence === state.fence) && (event.commands === undefined || event.commands === state.commands) && backgroundTaskStatesEqual(backgroundTasks, state.backgroundTasks) && activity?.turnId === state.activity?.turnId && activity?.text === state.activity?.text && state.status === 'ready' && state.error === undefined) {
        return state;
    }
    const merged = journalUnchanged ? state.items : mergeItems(state.items, liveItems, event.batch.removedItemIds);
    const items = trimRetainedItems(merged, state.retainedItemLimit);
    const outsideWindow = [
        ...liveItems.length < event.batch.items.length ? event.batch.items.filter((item)=>!liveItems.includes(item)) : [],
        ...merged.slice(0, merged.length - items.length)
    ];
    const lostTurnRow = outsideWindow.some((item)=>readAgentJournalTurn(item.body) !== null);
    return {
        ...state,
        cursor: event.batch.cursor,
        fence: event.fence ?? state.fence,
        items,
        hasOlder: items.length < merged.length ? true : state.hasOlder,
        submissions: event.batch.submissions.length === 0 && event.batch.removedItemIds.length === 0 ? state.submissions : mergeSubmissions(state.submissions, event.batch.submissions, items),
        status: 'ready',
        error: undefined,
        commands: event.commands !== undefined ? event.commands : state.commands,
        ...backgroundTasks !== undefined ? {
            backgroundTasks
        } : {},
        ...activity !== undefined ? {
            activity
        } : {},
        ...lostTurnRow ? {
            unloadedTurnRevisions: (state.unloadedTurnRevisions ?? 0) + 1
        } : {},
        ...hostClockField(event.hostNow, receivedAt, state.hostClock)
    };
}
export function oldestStructuredAgentSessionCursor(state) {
    const oldest = state.items[0];
    return state.epoch && oldest ? {
        epoch: state.epoch,
        sequence: oldest.sequence
    } : null;
}
