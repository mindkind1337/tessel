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
const pendingRendererYields = new Map();
let nextRendererYieldId = 0;
let rendererYieldChannel = null;
function isVitestEnvironment() {
    return typeof process !== 'undefined' && process.env?.VITEST === 'true';
}
function getRendererYieldChannel() {
    if (!rendererYieldChannel) {
        rendererYieldChannel = new globalThis.MessageChannel();
        rendererYieldChannel.port1.onmessage = (event)=>{
            const yieldId = event.data;
            const resolve = typeof yieldId === 'number' ? pendingRendererYields.get(yieldId) : undefined;
            if (!resolve) {
                return;
            }
            pendingRendererYields.delete(yieldId);
            resolve();
        };
    }
    return rendererYieldChannel;
}
export function getPendingRendererYieldCountForTesting() {
    return pendingRendererYields.size;
}
export function yieldToEventLoop() {
    return new Promise((resolve)=>{
        if (isVitestEnvironment()) {
            globalThis.setTimeout(resolve, 0);
            return;
        }
        const setImmediate = globalThis.setImmediate;
        if (typeof window === 'undefined' && setImmediate) {
            setImmediate(resolve);
            return;
        }
        if (typeof globalThis.MessageChannel === 'function') {
            const yieldId = nextRendererYieldId;
            nextRendererYieldId += 1;
            pendingRendererYields.set(yieldId, resolve);
            getRendererYieldChannel().port2.postMessage(yieldId);
            return;
        }
        globalThis.setTimeout(resolve, 0);
    });
}
