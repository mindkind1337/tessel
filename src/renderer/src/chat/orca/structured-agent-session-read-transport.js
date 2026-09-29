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
import { createStructuredAgentSessionEventCoalescer } from "./shared/structured-agent-session-coalescer.js";
import { AGENT_SESSION_UNATTACHED_READ_GRACE_MS, isUnattachedAgentSessionReadRefusal } from "./shared/structured-agent-session-read-refusal.js";
import { subscribeStructuredAgentSession } from '@/runtime/structured-agent-session-client';
function createReconnectScheduler(args) {
    let timer = null;
    return {
        schedule (delay = 750) {
            if (args.shouldStop() || timer) {
                return;
            }
            timer = setTimeout(()=>{
                timer = null;
                if (!args.shouldStop()) {
                    args.reconnect();
                }
            }, delay);
        },
        dispose () {
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
        }
    };
}
export function startStructuredAgentSessionReadTransport(args) {
    let stopped = false;
    let connected = false;
    let unattachedSince = null;
    let opening = false;
    let openGeneration = 0;
    let stateGeneration = 0;
    let unsubscribe = ()=>{};
    let shouldStopCoalescedEvent = ()=>true;
    const coalescer = createStructuredAgentSessionEventCoalescer((event)=>{
        if (!shouldStopCoalescedEvent()) {
            args.applyEvent(event);
        }
    });
    const reconnectScheduler = createReconnectScheduler({
        shouldStop: ()=>stopped || connected,
        reconnect: ()=>void open()
    });
    const isCurrentOpenGeneration = (candidate)=>!stopped && candidate === openGeneration;
    const clearUnattachedReadGrace = ()=>{
        unattachedSince = null;
    };
    const reportReadFailure = (error)=>{
        if (!isUnattachedAgentSessionReadRefusal(error)) {
            clearUnattachedReadGrace();
            args.applyError(String(error));
            return;
        }
        const now = Date.now();
        unattachedSince ??= now;
        if (now - unattachedSince >= AGENT_SESSION_UNATTACHED_READ_GRACE_MS) {
            args.applyError(String(error));
        }
    };
    const captureHistoryReadGuard = ()=>{
        const readOpenGeneration = openGeneration;
        const readStateGeneration = stateGeneration;
        return ()=>!isCurrentOpenGeneration(readOpenGeneration) || readStateGeneration !== stateGeneration;
    };
    const handleEvent = (event, eventOpenGeneration)=>{
        if (!isCurrentOpenGeneration(eventOpenGeneration)) {
            return;
        }
        clearUnattachedReadGrace();
        if (event.type === 'snapshot' || event.type === 'reset') {
            coalescer.flush();
            if (!isCurrentOpenGeneration(eventOpenGeneration)) {
                return;
            }
            stateGeneration += 1;
            args.onHistoryReadInvalidated();
            if (!isCurrentOpenGeneration(eventOpenGeneration)) {
                return;
            }
        } else if (event.type === 'end') {
            connected = false;
            reconnectScheduler.schedule();
        }
        shouldStopCoalescedEvent = captureHistoryReadGuard();
        coalescer.push(event);
    };
    async function open() {
        if (stopped || connected) {
            return;
        }
        if (opening) {
            reconnectScheduler.schedule();
            return;
        }
        opening = true;
        coalescer.flush();
        if (stopped) {
            opening = false;
            return;
        }
        const currentOpenGeneration = ++openGeneration;
        args.onHistoryReadInvalidated();
        unsubscribe();
        unsubscribe = ()=>{};
        try {
            if (!isCurrentOpenGeneration(currentOpenGeneration)) {
                return;
            }
            let closedDuringOpen = false;
            const cursor = args.getCursor();
            const handle = await subscribeStructuredAgentSession(args.target, {
                sessionId: args.sessionId,
                ...cursor ? {
                    cursor
                } : {}
            }, (event)=>handleEvent(event, currentOpenGeneration), (error)=>{
                if (!isCurrentOpenGeneration(currentOpenGeneration)) {
                    return;
                }
                closedDuringOpen = true;
                connected = false;
                reportReadFailure(error);
                reconnectScheduler.schedule();
            }, ()=>{
                if (!isCurrentOpenGeneration(currentOpenGeneration)) {
                    return;
                }
                closedDuringOpen = true;
                connected = false;
                reconnectScheduler.schedule();
            });
            if (!isCurrentOpenGeneration(currentOpenGeneration) || closedDuringOpen) {
                handle.unsubscribe();
                if (isCurrentOpenGeneration(currentOpenGeneration)) {
                    reconnectScheduler.schedule();
                }
            } else {
                connected = true;
                unsubscribe = handle.unsubscribe;
            }
        } catch (error) {
            if (!isCurrentOpenGeneration(currentOpenGeneration)) {
                return;
            }
            connected = false;
            reportReadFailure(error);
            reconnectScheduler.schedule();
        } finally{
            if (currentOpenGeneration === openGeneration) {
                opening = false;
            }
        }
    }
    if (args.hydrate) {
        const shouldStopInitialRead = captureHistoryReadGuard();
        void args.hydrate(shouldStopInitialRead).then(()=>{
            if (shouldStopInitialRead()) {
                return;
            }
            clearUnattachedReadGrace();
            return open();
        }).catch((error)=>{
            if (!shouldStopInitialRead()) {
                reportReadFailure(error);
                reconnectScheduler.schedule();
            }
        });
    } else {
        void open();
    }
    return {
        captureHistoryReadGuard,
        dispose: ()=>{
            stopped = true;
            openGeneration += 1;
            args.onHistoryReadInvalidated();
            reconnectScheduler.dispose();
            coalescer.dispose();
            unsubscribe();
        }
    };
}
