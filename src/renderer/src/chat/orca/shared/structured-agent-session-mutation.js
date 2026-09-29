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
import { sha256 } from "./sha256.js";
function canonicalize(value) {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value ?? null);
    }
    if (Array.isArray(value)) {
        return `[${value.map(canonicalize).join(',')}]`;
    }
    const entries = Object.entries(value).filter(([, entry])=>entry !== undefined).sort(([left], [right])=>left < right ? -1 : left > right ? 1 : 0);
    return `{${entries.map(([key, entry])=>`${JSON.stringify(key)}:${canonicalize(entry)}`).join(',')}}`;
}
export function structuredAgentSessionPayloadFingerprint(input) {
    const bytes = sha256(new TextEncoder().encode(canonicalize({
        method: input.method,
        sessionId: input.sessionId,
        fields: input.fields
    })));
    return Array.from(bytes, (byte)=>byte.toString(16).padStart(2, '0')).join('');
}
export function structuredAgentSessionDomainFingerprint(input) {
    return structuredAgentSessionPayloadFingerprint({
        method: input.domain,
        sessionId: input.sessionId,
        fields: input.fields
    });
}
export function structuredAgentSessionCreateFingerprint(input) {
    return structuredAgentSessionPayloadFingerprint({
        method: 'agentSession.create',
        sessionId: input.sessionId,
        fields: {
            worktree: input.worktree,
            agent: input.agent,
            resumeFrom: input.resumeFrom,
            tabId: input.tabId
        }
    });
}
export function showStructuredAgentSessionChoice(input) {
    return input.hostCapability && input.workspaceSupport && (input.agent === 'claude' || input.agent === 'codex');
}
export function createStructuredAgentSessionOperationId(randomUuid, now = Date.now()) {
    const timestamp = Math.trunc(now).toString();
    const entropy = randomUuid().replaceAll('-', '').toLowerCase();
    if (!/^\d{13}$/.test(timestamp) || !/^[0-9a-f]{32}$/.test(entropy)) {
        throw new Error('Unable to create a durable operation id');
    }
    return `${timestamp}-${entropy}`;
}
