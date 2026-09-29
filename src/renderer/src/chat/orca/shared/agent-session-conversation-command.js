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
export function isAgentSessionConversationCommandResult(value) {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const row = value;
    return (row.command === 'clear' || row.command === 'compact') && (row.state === 'completed' || row.state === 'unknown') && (row.replacementSessionId === undefined || typeof row.replacementSessionId === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(row.replacementSessionId)) && (row.error === undefined || typeof row.error === 'string' && row.error.length <= 4096);
}
export function isAgentSessionConversationCommandRecord(value) {
    if (!isAgentSessionConversationCommandResult(value)) {
        return false;
    }
    const row = value;
    return (row.phase === 'prepared' || row.phase === 'committed') && (row.runtimeFence === undefined || Number.isSafeInteger(row.runtimeFence) && row.runtimeFence > 0) && typeof row.operationId === 'string' && row.operationId.length > 0 && row.operationId.length <= 512 && typeof row.callerKey === 'string' && row.callerKey.length > 0 && row.callerKey.length <= 512;
}
