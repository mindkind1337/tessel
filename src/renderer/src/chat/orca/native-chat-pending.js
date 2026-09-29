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
import { setBoundedScopeCacheEntry } from "./native-chat-composer-scope-cache.js";
import { advancedNativeChatUserContentCounts, advancedNativeChatUserRows, assignNativeChatPendingOccurrence, matchingNativeChatUserContentCounts, matchingNativeChatUserRows, nativeChatPendingContentKey, nativeChatPendingMatchKey, nativeChatPendingMatchingAfter, nativeChatPendingOccurrence, selectPendingIndicesRepresentedByUserRows } from "./native-chat-pending-occurrence.js";
const PENDING_SEND_LIMIT = 8;
const pendingSendCache = new Map();
let pendingSendCounter = 0;
function pendingSendScopeKey(scope) {
    return `${scope.paneKey}\0${scope.agent}`;
}
export function readPendingSendCache(scope) {
    return [
        ...pendingSendCache.get(pendingSendScopeKey(scope)) ?? []
    ];
}
export function writePendingSendCache(scope, pending) {
    const next = pending.slice(-PENDING_SEND_LIMIT);
    const key = pendingSendScopeKey(scope);
    if (next.length === 0) {
        pendingSendCache.delete(key);
    } else {
        setBoundedScopeCacheEntry(pendingSendCache, key, next);
    }
    return [
        ...next
    ];
}
export function appendPendingSendCache(scope, entry) {
    const existing = readPendingSendCache(scope);
    const next = assignNativeChatPendingOccurrence(existing, entry);
    return writePendingSendCache(scope, [
        ...existing,
        next
    ]);
}
export function clearPendingSendCacheForTests() {
    pendingSendCache.clear();
    pendingSendCounter = 0;
}
function messagesAfterPendingBoundary(messages, pending) {
    if (pending.afterMessageId === undefined) {
        return messages;
    }
    if (pending.afterMessageId === null) {
        return messages.filter((message)=>messageIsAfterPendingTimestamp(message, pending));
    }
    const boundaryIndex = messages.findIndex((message)=>message.id === pending.afterMessageId);
    if (boundaryIndex !== -1) {
        return messages.slice(boundaryIndex + 1);
    }
    return messages.filter((message)=>messageIsAfterPendingTimestamp(message, pending));
}
function messageIsAfterPendingTimestamp(message, pending) {
    if (message.timestamp === null) {
        return true;
    }
    const boundary = nativeChatPendingMatchingAfter(pending);
    return pending.afterMessageTimestamp == null ? message.timestamp >= boundary : message.timestamp > boundary;
}
function gluedCandidateRows(messages, open, rowsOf) {
    const [oldest, ...newer] = open.map((entry)=>entry.afterMessageId === undefined ? {
            ...entry,
            afterMessageId: null
        } : entry);
    if (!oldest || newer.length === 0) {
        return [];
    }
    const newerRowIds = newer.map((entry)=>new Set(rowsOf(messagesAfterPendingBoundary(messages, entry)).map((row)=>row.id)));
    return rowsOf(messagesAfterPendingBoundary(messages, oldest)).map((row)=>{
        const representablePendingIndices = new Set([
            0
        ]);
        newerRowIds.forEach((ids, index)=>{
            if (ids.has(row.id)) {
                representablePendingIndices.add(index + 1);
            }
        });
        return {
            text: row.text,
            representablePendingIndices
        };
    });
}
export function prunePendingSends(pending, messages) {
    if (pending.length === 0) {
        return pending;
    }
    const consumed = new Map();
    const exactKeep = pending.map((entry)=>{
        const contentKey = nativeChatPendingContentKey(entry);
        const key = nativeChatPendingMatchKey(entry);
        const available = advancedNativeChatUserContentCounts(messagesAfterPendingBoundary(messages, entry)).get(contentKey) ?? 0;
        const used = consumed.get(key) ?? 0;
        const occurrence = nativeChatPendingOccurrence(entry, used);
        consumed.set(key, Math.max(used, occurrence));
        return occurrence > available;
    });
    const stillOpen = pending.filter((_, index)=>exactKeep[index]);
    const gluedRepresented = selectPendingIndicesRepresentedByUserRows(stillOpen, gluedCandidateRows(messages, stillOpen, advancedNativeChatUserRows));
    const next = pending.filter((entry, index)=>{
        if (!exactKeep[index]) {
            return false;
        }
        const openIndex = stillOpen.indexOf(entry);
        return openIndex === -1 || !gluedRepresented.has(openIndex);
    });
    return next.length === pending.length ? pending : next;
}
export function pendingSendsAsMessages(pending, existingMessages = []) {
    if (pending.length === 0) {
        return [];
    }
    const consumed = new Map();
    const exactVisible = pending.map((entry)=>{
        const contentKey = nativeChatPendingContentKey(entry);
        const key = nativeChatPendingMatchKey(entry);
        const represented = matchingNativeChatUserContentCounts(messagesAfterPendingBoundary(existingMessages, entry)).get(contentKey) ?? 0;
        const used = consumed.get(key) ?? 0;
        const occurrence = nativeChatPendingOccurrence(entry, used);
        consumed.set(key, Math.max(used, occurrence));
        return occurrence > represented;
    });
    const stillVisible = pending.filter((_, index)=>exactVisible[index]);
    const gluedRepresented = selectPendingIndicesRepresentedByUserRows(stillVisible, gluedCandidateRows(existingMessages, stillVisible, matchingNativeChatUserRows));
    return pending.filter((entry, index)=>{
        if (!exactVisible[index]) {
            return false;
        }
        const openIndex = stillVisible.indexOf(entry);
        return openIndex === -1 || !gluedRepresented.has(openIndex);
    }).map((entry)=>({
            id: `pending:${entry.id}`, // i18n-ignore
            role: 'user',
            blocks: [
                ...(entry.imagePaths ?? []).map((path)=>({
                        type: 'image-ref',
                        path
                    })),
                ...entry.text.trim().length > 0 ? [
                    {
                        type: 'text',
                        text: entry.text
                    }
                ] : []
            ],
            timestamp: entry.sentAt,
            source: 'scrape'
        }));
}
export function isPendingMessageId(id) {
    return id.startsWith('pending:');
}
export function launchPromptAsMessage(entry, existingMessages = []) {
    if (!entry) {
        return null;
    }
    const represented = matchingNativeChatUserContentCounts(existingMessages.filter((message)=>message.timestamp === null || message.timestamp >= entry.createdAt));
    if ((represented.get(nativeChatPendingContentKey(entry)) ?? 0) > 0) {
        return null;
    }
    return {
        id: `launch-pending:${entry.tabId}`, // i18n-ignore
        role: 'user',
        blocks: entry.text.trim().length > 0 ? [
            {
                type: 'text',
                text: entry.text
            }
        ] : [],
        timestamp: entry.createdAt,
        source: 'scrape'
    };
}
export function shouldPruneLaunchPrompt(entry, messages) {
    const relevant = messages.filter((message)=>message.timestamp === null || message.timestamp >= entry.createdAt);
    return (advancedNativeChatUserContentCounts(relevant).get(nativeChatPendingContentKey(entry)) ?? 0) > 0;
}
export function nextNativeChatPendingSendId(now = Date.now()) {
    pendingSendCounter += 1;
    return `${now}-${pendingSendCounter}`;
}
export function isLaunchPromptMessageId(id) {
    return id.startsWith('launch-pending:');
}
