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
import { agentSessionRefusalOperationState } from "./agent-session-refusal-retry.js";
import { structuredAgentSessionPayloadFingerprint } from "./structured-agent-session-mutation.js";
import { DISPATCH_REJECTED_CANCELLED } from "./structured-agent-session-dispatch-rejection.js";
export function structuredAgentSessionSendBody(text, attachments) {
    return {
        kind: 'message',
        role: 'user',
        blocks: [
            ...text.trim().length > 0 ? [
                {
                    type: 'text',
                    text: text.trimEnd()
                }
            ] : [],
            ...attachments.map((attachment)=>({
                    type: 'image-ref',
                    path: attachment.path
                }))
        ]
    };
}
export function createStructuredAgentSessionOutboxEntry(args) {
    return {
        clientMessageId: args.clientMessageId,
        sessionId: args.sessionId,
        body: structuredAgentSessionSendBody(args.text, args.attachments),
        previewUris: args.attachments.map((attachment)=>attachment.previewUri),
        state: 'queued',
        queuedAt: args.queuedAt,
        lastAttemptAt: null,
        retryAfterUnknownSubmittedAt: null
    };
}
export function updateStructuredAgentSessionOutboxEntry(entries, id, update) {
    return entries.flatMap((entry)=>{
        if (entry.clientMessageId !== id) {
            return [
                entry
            ];
        }
        const next = update(entry);
        return next ? [
            next
        ] : [];
    });
}
export function requeueStructuredAgentSessionSendRefusal(entry, code, createOperationId, retainOperationId = false) {
    const refusalState = agentSessionRefusalOperationState(code);
    if (refusalState !== 'settled-rejected' || retainOperationId || entry.state === 'unconfirmed' || entry.retryAfterUnknownSubmittedAt !== null) {
        return {
            ...entry,
            state: 'queued'
        };
    }
    return {
        ...entry,
        clientMessageId: createOperationId(),
        state: 'queued',
        lastAttemptAt: null,
        retryAfterUnknownSubmittedAt: null
    };
}
export function reconcileStructuredAgentSessionOutbox(entries, submissions) {
    const settled = new Map(submissions.map((entry)=>[
            entry.clientMessageId,
            entry
        ]));
    return entries.flatMap((entry)=>{
        const submission = settled.get(entry.clientMessageId);
        if (submission?.dispatchState === 'accepted') {
            return [];
        }
        if (submission?.dispatchState === 'rejected' && submission.reason === DISPATCH_REJECTED_CANCELLED) {
            return [];
        }
        if (submission?.dispatchState === 'pending') {
            return entry.state === 'dispatching' ? [
                entry
            ] : [
                {
                    ...entry,
                    state: 'dispatching'
                }
            ];
        }
        if (submission?.dispatchState === 'unknown' && entry.retryAfterUnknownSubmittedAt !== -1 && entry.retryAfterUnknownSubmittedAt !== submission.submittedAt) {
            return [
                {
                    ...entry,
                    state: 'unconfirmed'
                }
            ];
        }
        return [
            entry
        ];
    });
}
export function admitStructuredAgentSessionOutboxEntry(entries, blockedClientMessageId) {
    for (const entry of entries){
        if (entry.state === 'unconfirmed' || entry.clientMessageId === blockedClientMessageId) {
            return {
                state: 'blocked',
                entry
            };
        }
        if (entry.state === 'queued') {
            return {
                state: 'dispatch',
                entry
            };
        }
    }
    return {
        state: 'idle',
        entry: null
    };
}
export function parseStructuredAgentSessionOutboxEntry(value, sessionId) {
    if (typeof value !== 'object' || value === null) {
        return null;
    }
    const entry = value;
    const body = entry.body;
    if (entry.sessionId !== sessionId || typeof entry.clientMessageId !== 'string' || typeof entry.queuedAt !== 'number' || !body || body.kind !== 'message' || body.role !== 'user' || !Array.isArray(body.blocks) || !Array.isArray(entry.previewUris) || !entry.previewUris.every((uri)=>typeof uri === 'string') || ![
        'queued',
        'dispatching',
        'unconfirmed'
    ].includes(entry.state ?? '')) {
        return null;
    }
    return {
        clientMessageId: entry.clientMessageId,
        sessionId,
        body,
        previewUris: entry.previewUris,
        state: entry.state,
        queuedAt: entry.queuedAt,
        lastAttemptAt: typeof entry.lastAttemptAt === 'number' ? entry.lastAttemptAt : null,
        retryAfterUnknownSubmittedAt: typeof entry.retryAfterUnknownSubmittedAt === 'number' ? entry.retryAfterUnknownSubmittedAt : null,
        ...entry.source === 'launch' ? {
            source: 'launch'
        } : {}
    };
}
export function structuredAgentSessionSendMutation(entry, expectedRuntimeFence) {
    const fields = {
        body: entry.body
    };
    return {
        envelope: {
            sessionId: entry.sessionId,
            clientOperationId: entry.clientMessageId,
            expectedRuntimeFence,
            payloadFingerprint: structuredAgentSessionPayloadFingerprint({
                method: 'agentSession.send',
                sessionId: entry.sessionId,
                fields
            })
        },
        ...fields
    };
}
export function structuredAgentSessionSendRequest(entry, expectedRuntimeFence) {
    return structuredAgentSessionSendMutation(entry, expectedRuntimeFence);
}
export function classifyStructuredAgentSessionSendFailure(error, isDeliveryUnknown) {
    return isDeliveryUnknown(error) ? 'delivery-unknown' : 'failed';
}
