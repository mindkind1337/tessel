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
import { createStructuredAgentSessionOutboxEntry, parseStructuredAgentSessionOutboxEntry } from "./shared/structured-agent-session-outbox.js";
import { createStructuredAgentSessionOperationId } from "./shared/structured-agent-session-mutation.js";
import { createBrowserUuid } from '@/lib/browser-uuid';
const OUTBOX_PREFIX = 'orca:desktopStructuredAgentSessionOutbox:v1:';
function storageKey(sessionId) {
    return `${OUTBOX_PREFIX}${encodeURIComponent(sessionId)}`;
}
export function readOutbox(sessionId, options = {}) {
    const recoverDispatching = options.recoverDispatching !== false;
    try {
        const value = JSON.parse(localStorage.getItem(storageKey(sessionId)) ?? '[]');
        return Array.isArray(value) ? value.map((entry)=>parseStructuredAgentSessionOutboxEntry(entry, sessionId)).filter((entry)=>entry !== null).map((entry)=>recoverDispatching && entry.state === 'dispatching' ? {
                ...entry,
                state: 'unconfirmed'
            } : entry).sort((left, right)=>left.queuedAt - right.queuedAt) : [];
    } catch  {
        return [];
    }
}
const undeliveredSessions = new Map();
function publishUndelivered(sessionId, undelivered) {
    const subscription = undeliveredSessions.get(sessionId);
    if (!subscription || subscription.undelivered === undelivered) {
        return;
    }
    subscription.undelivered = undelivered;
    for (const listener of subscription.listeners){
        listener();
    }
}
export function hasUndeliveredStructuredAgentSessionOutbox(sessionId) {
    return undeliveredSessions.get(sessionId)?.undelivered ?? readOutbox(sessionId).length > 0;
}
export function subscribeToUndeliveredStructuredAgentSessionOutbox(sessionId, listener) {
    let subscription = undeliveredSessions.get(sessionId);
    if (!subscription) {
        subscription = {
            undelivered: readOutbox(sessionId).length > 0,
            listeners: new Set()
        };
        undeliveredSessions.set(sessionId, subscription);
    }
    const owned = subscription;
    owned.listeners.add(listener);
    return ()=>{
        owned.listeners.delete(listener);
        if (owned.listeners.size === 0 && undeliveredSessions.get(sessionId) === owned) {
            undeliveredSessions.delete(sessionId);
        }
    };
}
export function resetUndeliveredStructuredAgentSessionOutboxForTests() {
    undeliveredSessions.clear();
}
export function writeOutbox(sessionId, entries) {
    try {
        if (entries.length === 0) {
            localStorage.removeItem(storageKey(sessionId));
        } else {
            localStorage.setItem(storageKey(sessionId), JSON.stringify(entries));
        }
        publishUndelivered(sessionId, entries.length > 0);
        return true;
    } catch  {
        return false;
    }
}
export function enqueueStructuredAgentSessionLaunchPrompt(sessionId, text) {
    const entry = {
        ...createStructuredAgentSessionOutboxEntry({
            clientMessageId: createStructuredAgentSessionOperationId(createBrowserUuid),
            sessionId,
            text,
            attachments: [],
            queuedAt: Date.now()
        }),
        source: 'launch'
    };
    return writeOutbox(sessionId, [
        ...readOutbox(sessionId),
        entry
    ]) ? entry : null;
}
export function discardStructuredAgentSessionLaunchOutbox(sessionId) {
    writeOutbox(sessionId, []);
}
export function mutateStructuredAgentSessionLaunchPrompt(sessionId, clientMessageId, update) {
    const current = readOutbox(sessionId);
    let matched = false;
    const next = current.flatMap((entry)=>{
        if (entry.clientMessageId !== clientMessageId) {
            return [
                entry
            ];
        }
        matched = true;
        const replacement = update(entry);
        return replacement ? [
            replacement
        ] : [];
    });
    return matched && writeOutbox(sessionId, next);
}
