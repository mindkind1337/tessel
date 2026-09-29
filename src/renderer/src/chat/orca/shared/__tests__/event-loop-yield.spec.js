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
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getPendingRendererYieldCountForTesting, yieldToEventLoop } from "../event-loop-yield.js";
afterEach(()=>{
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
});
describe('yieldToEventLoop', ()=>{
    it('uses setImmediate in Node runtimes', async ()=>{
        const scheduleImmediate = vi.fn((callback)=>queueMicrotask(callback));
        vi.stubEnv('VITEST', 'false');
        vi.stubGlobal('window', undefined);
        vi.stubGlobal('setImmediate', scheduleImmediate);
        await yieldToEventLoop();
        expect(scheduleImmediate).toHaveBeenCalledOnce();
    });
    it('releases callbacks during sustained concurrent renderer yields', async ()=>{
        const postMessage = vi.fn();
        let peakPendingAfterResolution = 0;
        vi.stubEnv('VITEST', 'false');
        vi.stubGlobal('window', {});
        vi.stubGlobal('MessageChannel', class {
            port1 = {
                onmessage: null
            };
            port2 = {
                postMessage: (data)=>{
                    postMessage(data);
                    setTimeout(()=>this.port1.onmessage?.({
                            data
                        }), 0);
                }
            };
        });
        const runProducer = async ()=>{
            for(let index = 0; index < 20; index += 1){
                await yieldToEventLoop();
                peakPendingAfterResolution = Math.max(peakPendingAfterResolution, getPendingRendererYieldCountForTesting());
            }
        };
        await Promise.all([
            runProducer(),
            runProducer()
        ]);
        expect(postMessage).toHaveBeenCalledTimes(40);
        expect(peakPendingAfterResolution).toBeLessThanOrEqual(1);
        expect(getPendingRendererYieldCountForTesting()).toBe(0);
    });
});
