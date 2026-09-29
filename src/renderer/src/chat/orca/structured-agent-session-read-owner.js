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
import { agentProviderSessionsEqual } from "./shared/agent-session-resume.js";
import { AGENT_SESSION_HISTORY_MAX_LIMIT } from "./shared/agent-session-wire.js";
import { EMPTY_STRUCTURED_AGENT_SESSION, oldestStructuredAgentSessionCursor, reduceStructuredAgentSession } from "./shared/structured-agent-session-reducer.js";
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client';
import { NATIVE_CHAT_INITIAL_LIMIT } from "./native-chat-pagination.js";
import { startStructuredAgentSessionReadTransport } from "./structured-agent-session-read-transport.js";
const owners = new Map();
const OLDER_PAGE_ANCHOR_ATTEMPTS = 3;
function countsTowardInitialHistory(item) {
    return item.body.kind !== 'status' || !item.body.providerFrame;
}
function ownerKey(sessionId, target) {
    const targetKey = target.kind === 'local' ? 'local' : `environment:${target.environmentId}`; // i18n-ignore
    return `${targetKey}:${sessionId}`;
}
function createReadOwner(key, sessionId, target) {
    let snapshot = {
        state: EMPTY_STRUCTURED_AGENT_SESSION,
        loadingOlder: false,
        olderHistoryGeneration: 0
    };
    let stopActiveRun = null;
    const retiredHistoryRead = ()=>true;
    let captureActiveHistoryReadGuard = ()=>retiredHistoryRead;
    const activations = new Set();
    const listeners = new Set();
    const emit = ()=>{
        for (const listener of listeners){
            listener();
        }
    };
    const setSnapshot = (next)=>{
        if (next === snapshot) {
            return;
        }
        snapshot = next;
        emit();
    };
    const apply = (action)=>{
        const state = reduceStructuredAgentSession(snapshot.state, action, Date.now());
        if (state !== snapshot.state) {
            setSnapshot({
                ...snapshot,
                state
            });
        }
    };
    const setProviderSession = (providerSession)=>{
        if (!agentProviderSessionsEqual(undefined, snapshot.providerSession, providerSession)) {
            setSnapshot({
                ...snapshot,
                providerSession
            });
        }
    };
    const clearLoadingOlder = ()=>{
        if (snapshot.loadingOlder) {
            setSnapshot({
                ...snapshot,
                loadingOlder: false
            });
        }
    };
    const invalidateOlderPages = ()=>{
        setSnapshot({
            ...snapshot,
            loadingOlder: false,
            olderHistoryGeneration: snapshot.olderHistoryGeneration + 1
        });
    };
    const hydrate = async (shouldStop)=>{
        const result = await callStructuredAgentSession(target, 'agentSession.history', {
            sessionId,
            direction: 'tail',
            limit: AGENT_SESSION_HISTORY_MAX_LIMIT
        });
        if (shouldStop()) {
            return;
        }
        setProviderSession(result.providerSession);
        if (!result.ok) {
            if (shouldStop()) {
                return;
            }
            apply({
                type: 'event',
                event: {
                    type: 'reset',
                    sessionId,
                    reset: result.reset,
                    page: result.page,
                    fence: result.fence ?? 0
                }
            });
            return;
        }
        if (shouldStop()) {
            return;
        }
        apply({
            type: 'history-page',
            page: result.page
        });
        if (shouldStop()) {
            return;
        }
        let restored = snapshot.state.items.filter(countsTowardInitialHistory).length;
        let anchorSlides = 0;
        while(snapshot.state.hasOlder && restored < NATIVE_CHAT_INITIAL_LIMIT){
            const oldest = oldestStructuredAgentSessionCursor(snapshot.state);
            if (!oldest || shouldStop()) {
                break;
            }
            const missing = NATIVE_CHAT_INITIAL_LIMIT - restored;
            const older = await callStructuredAgentSession(target, 'agentSession.history', {
                sessionId,
                direction: 'before',
                cursor: oldest,
                limit: Math.min(AGENT_SESSION_HISTORY_MAX_LIMIT, missing)
            });
            if (shouldStop()) {
                return;
            }
            if (!older.ok || older.page.window.oldest?.sequence === oldest.sequence) {
                break;
            }
            if (shouldStop()) {
                return;
            }
            if (oldestStructuredAgentSessionCursor(snapshot.state)?.sequence !== oldest.sequence) {
                anchorSlides += 1;
                if (anchorSlides >= OLDER_PAGE_ANCHOR_ATTEMPTS) {
                    break;
                }
                continue;
            }
            apply({
                type: 'older-page',
                requestedCursor: oldest,
                page: older.page
            });
            if (shouldStop()) {
                return;
            }
            restored = snapshot.state.items.filter(countsTowardInitialHistory).length;
        }
    };
    let olderPage = null;
    const readOlderPage = async (shouldStop)=>{
        try {
            for(let attempt = 0; attempt < OLDER_PAGE_ANCHOR_ATTEMPTS; attempt += 1){
                const cursor = oldestStructuredAgentSessionCursor(snapshot.state);
                if (shouldStop()) {
                    return 'superseded';
                }
                if (!cursor) {
                    return 'exhausted';
                }
                const result = await callStructuredAgentSession(target, 'agentSession.history', {
                    sessionId,
                    direction: 'before',
                    cursor,
                    limit: AGENT_SESSION_HISTORY_MAX_LIMIT
                });
                if (shouldStop()) {
                    return 'superseded';
                }
                if (!result.ok) {
                    return 'failed';
                }
                if (oldestStructuredAgentSessionCursor(snapshot.state)?.sequence === cursor.sequence) {
                    apply({
                        type: 'older-page',
                        requestedCursor: cursor,
                        page: result.page
                    });
                    if (oldestStructuredAgentSessionCursor(snapshot.state)?.sequence !== cursor.sequence) {
                        return 'applied';
                    }
                    return snapshot.state.hasOlder ? 'unchanged' : 'exhausted';
                }
            }
            return 'unchanged';
        } catch  {
            return shouldStop() ? 'superseded' : 'failed';
        }
    };
    const start = ()=>{
        if (snapshot.state.epoch === null) {
            apply({
                type: 'loading'
            });
        }
        const transport = startStructuredAgentSessionReadTransport({
            applyEvent: (event)=>apply({
                    type: 'event',
                    event
                }),
            applyError: (message)=>apply({
                    type: 'error',
                    message
                }),
            getCursor: ()=>snapshot.state.cursor,
            onHistoryReadInvalidated: invalidateOlderPages,
            hydrate: snapshot.state.epoch === null ? hydrate : undefined,
            sessionId,
            target
        });
        captureActiveHistoryReadGuard = transport.captureHistoryReadGuard;
        stopActiveRun = ()=>{
            captureActiveHistoryReadGuard = ()=>retiredHistoryRead;
            transport.dispose();
            stopActiveRun = null;
        };
    };
    let owner;
    const deleteIfUnused = ()=>{
        if (activations.size === 0 && listeners.size === 0 && owners.get(key) === owner) {
            owners.delete(key);
        }
    };
    owner = {
        activate: ()=>{
            const token = Symbol(sessionId);
            activations.add(token);
            if (activations.size === 1) {
                start();
            }
            return ()=>{
                activations.delete(token);
                if (activations.size === 0) {
                    stopActiveRun?.();
                    deleteIfUnused();
                }
            };
        },
        dispose: ()=>{
            activations.clear();
            listeners.clear();
            stopActiveRun?.();
        },
        getSnapshot: ()=>snapshot,
        loadOlder: ()=>{
            if (olderPage && !olderPage.shouldStop()) {
                return olderPage.promise;
            }
            const shouldStop = captureActiveHistoryReadGuard();
            if (shouldStop()) {
                return Promise.resolve('superseded');
            }
            if (!oldestStructuredAgentSessionCursor(snapshot.state) || !snapshot.state.hasOlder) {
                return Promise.resolve('exhausted');
            }
            setSnapshot({
                ...snapshot,
                loadingOlder: true
            });
            const page = {
                shouldStop,
                promise: readOlderPage(shouldStop)
            };
            olderPage = page;
            void page.promise.finally(()=>{
                if (olderPage !== page) {
                    return;
                }
                olderPage = null;
                if (!shouldStop()) {
                    clearLoadingOlder();
                }
            });
            return page.promise;
        },
        subscribe: (listener)=>{
            listeners.add(listener);
            return ()=>{
                listeners.delete(listener);
                deleteIfUnused();
            };
        }
    };
    return owner;
}
export function getStructuredAgentSessionReadOwner(sessionId, target) {
    const key = ownerKey(sessionId, target);
    let owner = owners.get(key);
    if (!owner) {
        owner = createReadOwner(key, sessionId, target);
        owners.set(key, owner);
    }
    return owner;
}
export function resetStructuredAgentSessionReadOwnersForTests() {
    for (const owner of owners.values()){
        owner.dispose();
    }
    owners.clear();
}
