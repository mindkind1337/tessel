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
import { AGENT_TUI_CLEAR_INPUT_LINE } from "./agent-tui-input-clear.js";
export const AGENT_TUI_COMMAND_KEY_INTERVAL_MS = 16;
function waitForNextKey(signal) {
    if (signal?.aborted) {
        return Promise.resolve(false);
    }
    return new Promise((resolve)=>{
        const timer = setTimeout(()=>finish(true), AGENT_TUI_COMMAND_KEY_INTERVAL_MS);
        const finish = (completed)=>{
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            resolve(completed);
        };
        const onAbort = ()=>finish(false);
        signal?.addEventListener('abort', onAbort, {
            once: true
        });
    });
}
export async function typeAgentTuiCommand(args) {
    const keys = [
        AGENT_TUI_CLEAR_INPUT_LINE,
        ...args.command,
        '\r'
    ];
    for(let index = 0; index < keys.length; index += 1){
        if (args.signal?.aborted) {
            return 'rejected';
        }
        const outcome = await args.write(keys[index]);
        if (outcome !== 'accepted') {
            return outcome;
        }
        if (index < keys.length - 1 && !await waitForNextKey(args.signal)) {
            return 'rejected';
        }
    }
    return 'accepted';
}
