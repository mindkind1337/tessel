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
export const DISPATCH_REJECTED_WRITE_FAILED = 'provider_write_failed';
export const DISPATCH_REJECTED_QUEUE_FULL = 'claude structured dispatch queue is full';
export const DISPATCH_REJECTED_CODEX_QUEUE_FULL = 'codex structured dispatch queue is full';
export const DISPATCH_REJECTED_CANCELLED = 'provider_cancelled_before_start';
export function dispatchWriteFailureReason(error) {
    const detail = error instanceof Error ? error.message : String(error);
    return `${DISPATCH_REJECTED_WRITE_FAILED}: ${detail}`;
}
export function dispatchRejectionWasTransportWriteFailure(reason) {
    return reason === DISPATCH_REJECTED_WRITE_FAILED || reason?.startsWith(`${DISPATCH_REJECTED_WRITE_FAILED}: `) === true;
}
export function dispatchRejectionReasonIsInternal(reason) {
    return dispatchRejectionWasTransportWriteFailure(reason) || reason === DISPATCH_REJECTED_QUEUE_FULL || reason === DISPATCH_REJECTED_CODEX_QUEUE_FULL || reason === DISPATCH_REJECTED_CANCELLED;
}
