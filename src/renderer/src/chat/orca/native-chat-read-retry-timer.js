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
const RETRY_DELAYS_MS = [
    1_000,
    2_000,
    4_000,
    8_000
];
const FIXED_RETRY_DELAY_MS = 10_000;
function retryDelayMs(attempt) {
    return RETRY_DELAYS_MS[attempt] ?? FIXED_RETRY_DELAY_MS;
}
export function createNativeChatReadRetryTimer() {
    let timer = null;
    const cancel = ()=>{
        if (timer !== null) {
            clearTimeout(timer);
            timer = null;
        }
    };
    return {
        schedule (attempt, retry) {
            cancel();
            timer = setTimeout(()=>{
                timer = null;
                retry();
            }, retryDelayMs(attempt));
        },
        cancel
    };
}
