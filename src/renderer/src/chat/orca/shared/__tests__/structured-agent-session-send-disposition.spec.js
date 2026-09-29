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
import { describe, expect, it } from 'vitest';
import { dispatchWriteFailureReason, DISPATCH_REJECTED_CANCELLED, DISPATCH_REJECTED_QUEUE_FULL } from "../structured-agent-session-dispatch-rejection.js";
import { disposeStructuredAgentSessionSendResult } from "../structured-agent-session-send-disposition.js";
import { createStructuredAgentSessionOutboxEntry, reconcileStructuredAgentSessionOutbox } from "../structured-agent-session-outbox.js";
const entry = createStructuredAgentSessionOutboxEntry({
    clientMessageId: 'client-1',
    sessionId: 'session-1',
    text: 'hello',
    attachments: [],
    queuedAt: 1
});
function rejectedWith(reason) {
    const submission = {
        clientMessageId: 'client-1',
        fence: 1,
        payloadFingerprint: 'fingerprint',
        dispatchState: 'rejected',
        providerItemId: null,
        reason,
        submittedAt: 10,
        resolvedAt: 10
    };
    return {
        ok: true,
        replayed: false,
        fence: 1,
        cursor: {
            epoch: 'epoch-1',
            sequence: 10
        },
        value: {
            clientMessageId: 'client-1',
            submission
        }
    };
}
function notice(reason) {
    return disposeStructuredAgentSessionSendResult({
        entries: [
            entry
        ],
        entry,
        blockedClientMessageId: null,
        result: rejectedWith(reason),
        createOperationId: ()=>'unused'
    }).error;
}
describe('what a rejection shows the user', ()=>{
    it('removes a queued message the provider confirms Stop cancelled', ()=>{
        const result = rejectedWith(DISPATCH_REJECTED_CANCELLED);
        if (!result.ok) {
            throw new Error('expected rejected submission fixture');
        }
        expect(reconcileStructuredAgentSessionOutbox([
            entry
        ], [
            result.value.submission
        ])).toEqual([]);
    });
    it('never puts the transport marker on screen', ()=>{
        const shown = notice(dispatchWriteFailureReason(new Error('broken pipe')));
        expect(shown).not.toContain('provider_write_failed');
        expect(shown).not.toContain('broken pipe');
        expect(shown).toBe("Couldn't reach the agent. Your message was not sent — Retry to send it again.");
    });
    it('shows a content rejection in the provider own words', ()=>{
        expect(notice('Claude messages support at most 20 images')).toBe('Claude messages support at most 20 images');
    });
    it('names the cause of a start that died before it could take the message', ()=>{
        const reason = 'The provider stopped before it finished starting: claude stream-json exited (code 1): claude: not signed in.';
        expect(notice(reason)).toBe(reason);
    });
    it('claims no cause when the rejection names none', ()=>{
        expect(notice(null)).toBe('Message was not sent.');
    });
    it('never puts a local-capacity marker on screen either', ()=>{
        const shown = notice(DISPATCH_REJECTED_QUEUE_FULL);
        expect(shown).not.toContain('queue is full');
        expect(shown).toBe('Orca could not send your message — Retry to send it again.');
    });
});
describe('ambiguous operation refusals', ()=>{
    it.each([
        {
            ...entry,
            state: 'unconfirmed',
            lastAttemptAt: 10
        },
        {
            ...entry,
            state: 'queued',
            lastAttemptAt: 10,
            retryAfterUnknownSubmittedAt: 10
        }
    ])('never rotates $state operation after its host tombstone expires', (ambiguous)=>{
        const disposition = disposeStructuredAgentSessionSendResult({
            entries: [
                ambiguous
            ],
            entry: ambiguous,
            blockedClientMessageId: null,
            result: {
                ok: false,
                refusal: {
                    code: 'agent_session_operation_expired',
                    message: 'Operation expired.'
                }
            },
            createOperationId: ()=>'fresh-id'
        });
        expect(disposition.entries).toMatchObject([
            {
                clientMessageId: entry.clientMessageId,
                state: 'queued'
            }
        ]);
        expect(disposition.blockedClientMessageId).toBe(entry.clientMessageId);
    });
    it('parks a recovered missing submission without polling forever', ()=>{
        const result = rejectedWith(null);
        if (!result.ok) {
            throw new Error('expected a send result');
        }
        result.value.submission = {
            ...result.value.submission,
            dispatchState: 'unknown',
            reason: 'durable_send_submission_missing',
            recovered: true
        };
        const disposition = disposeStructuredAgentSessionSendResult({
            entries: [
                entry
            ],
            entry,
            blockedClientMessageId: null,
            result,
            createOperationId: ()=>'unused'
        });
        expect(disposition.entries).toMatchObject([
            {
                clientMessageId: entry.clientMessageId,
                state: 'unconfirmed',
                retryAfterUnknownSubmittedAt: -1
            }
        ]);
    });
});
