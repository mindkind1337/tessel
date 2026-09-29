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
const ptyQueues = new Map();
function getOrCreateState(ptyId) {
    let state = ptyQueues.get(ptyId);
    if (!state) {
        state = {
            tail: Promise.resolve(),
            freeAt: Date.now(),
            depth: 0,
            handles: new Set()
        };
        ptyQueues.set(ptyId, state);
    }
    return state;
}
export function resetNativeChatPtySendQueuesForTests() {
    for (const state of ptyQueues.values()){
        for (const handle of state.handles){
            handle.cancel();
        }
    }
    ptyQueues.clear();
}
export function cancelNativeChatPtySends(ptyId) {
    const state = ptyQueues.get(ptyId);
    if (!state) {
        return;
    }
    for (const handle of state.handles){
        handle.cancel();
    }
}
export async function waitForNativeChatPtyIdle(ptyId) {
    const state = ptyQueues.get(ptyId);
    if (!state) {
        return;
    }
    await state.tail;
}
export function enqueueNativeChatPtySend(ptyId, durationMs, start, options) {
    const now = Date.now();
    const state = getOrCreateState(ptyId);
    const waitMs = Math.max(0, state.freeAt - now);
    const settleAfterMs = waitMs + Math.max(0, durationMs);
    state.freeAt = Math.max(now, state.freeAt) + Math.max(0, durationMs);
    state.depth += 1;
    let cancelled = false;
    let bodyStarted = false;
    let finished = false;
    let submitted = false;
    const timers = [];
    let release = null;
    const finishEntry = ()=>{
        if (finished) {
            return;
        }
        finished = true;
        const resolve = release;
        release = null;
        resolve?.();
    };
    const delay = (ms, fn)=>{
        const timer = setTimeout(()=>{
            if (!cancelled) {
                fn();
            }
        }, ms);
        timers.push(timer);
    };
    const markSubmitted = ()=>{
        submitted = true;
        finishEntry();
    };
    const execute = ()=>new Promise((resolve)=>{
            release = resolve;
            if (cancelled) {
                release = null;
                finished = true;
                resolve();
                return;
            }
            bodyStarted = true;
            start({
                isCancelled: ()=>cancelled,
                delay,
                markSubmitted
            });
            if (durationMs <= 0) {
                markSubmitted();
            }
        });
    const runPromise = state.depth === 1 && waitMs === 0 ? execute() : state.tail.then(()=>execute());
    const dropHandle = ()=>{
        state.handles.delete(handle);
    };
    const settleQueueEntry = ()=>{
        state.depth = Math.max(0, state.depth - 1);
        finished = true;
        dropHandle();
        if (state.depth === 0 && state.handles.size === 0 && ptyQueues.get(ptyId) === state) {
            ptyQueues.delete(ptyId);
        }
    };
    const settled = runPromise.then(settleQueueEntry, settleQueueEntry);
    state.tail = settled;
    const handle = {
        cancel: ()=>{
            if (cancelled) {
                return;
            }
            cancelled = true;
            for (const timer of timers){
                clearTimeout(timer);
            }
            const shouldClear = bodyStarted && !submitted;
            state.freeAt = Math.max(Date.now(), state.freeAt - Math.max(0, durationMs));
            finishEntry();
            dropHandle();
            if (shouldClear) {
                options?.onCancelUnsubmitted?.();
            }
        },
        settleAfterMs,
        settled,
        bodyStarted: ()=>bodyStarted,
        finished: ()=>finished
    };
    state.handles.add(handle);
    return handle;
}
