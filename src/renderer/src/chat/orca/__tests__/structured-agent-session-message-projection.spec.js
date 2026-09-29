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
import { agentJournalSubmissionKey } from "../shared/agent-session-journal-item-key.js";
import { createStructuredAgentSessionOutboxEntry } from "../shared/structured-agent-session-outbox.js";
import { projectStructuredAgentSessionMessages } from "../structured-agent-session-message-projection.js";
function submission(index) {
    return {
        clientMessageId: `client-${index}`,
        fence: 1,
        payloadFingerprint: `fingerprint-${index}`,
        dispatchState: 'accepted',
        providerItemId: `provider-${index}`,
        reason: null,
        submittedAt: index,
        resolvedAt: index
    };
}
function item(index) {
    return {
        itemId: `journal-${index}`,
        revision: 1,
        sequence: index,
        observedAt: index,
        body: {
            kind: 'message',
            role: 'user',
            blocks: [
                {
                    type: 'text',
                    text: `send ${index}`
                }
            ]
        }
    };
}
describe('structured agent session message projection', ()=>{
    it('does not render a rejected host submission as a sent user message', ()=>{
        const rejected = {
            ...submission(0),
            dispatchState: 'rejected',
            providerItemId: null
        };
        const refusedItem = {
            ...item(0),
            itemId: agentJournalSubmissionKey(rejected.clientMessageId)
        };
        const acceptedItem = item(1);
        expect(projectStructuredAgentSessionMessages([
            refusedItem,
            acceptedItem
        ], [], [
            rejected
        ])).toMatchObject([
            {
                id: acceptedItem.itemId,
                role: 'user'
            }
        ]);
    });
    it('keeps a refused local draft available through its outbox', ()=>{
        const rejected = {
            ...submission(0),
            dispatchState: 'rejected',
            providerItemId: null
        };
        const refusedItem = {
            ...item(0),
            itemId: agentJournalSubmissionKey(rejected.clientMessageId)
        };
        const draft = createStructuredAgentSessionOutboxEntry({
            clientMessageId: rejected.clientMessageId,
            sessionId: 'session-1',
            text: 'An unsent draft',
            attachments: [],
            queuedAt: 1
        });
        expect(projectStructuredAgentSessionMessages([
            refusedItem
        ], [
            draft
        ], [
            rejected
        ])).toMatchObject([
            {
                id: refusedItem.itemId,
                blocks: [
                    {
                        text: 'An unsent draft'
                    }
                ]
            }
        ]);
    });
    it.each([
        5,
        10
    ])('renders %i rapid accepted desktop sends exactly once', (sendCount)=>{
        const outbox = Array.from({
            length: sendCount
        }, (_, index)=>createStructuredAgentSessionOutboxEntry({
                clientMessageId: `client-${index}`,
                sessionId: 'session-1',
                text: `send ${index}`,
                attachments: [],
                queuedAt: index
            }));
        const messages = projectStructuredAgentSessionMessages(Array.from({
            length: sendCount
        }, (_, index)=>item(index)), outbox, Array.from({
            length: sendCount
        }, (_, index)=>submission(sendCount - index - 1)));
        expect(messages.filter((message)=>message.role === 'user')).toHaveLength(sendCount);
        expect(messages.map((message)=>message.id)).toEqual(Array.from({
            length: sendCount
        }, (_, index)=>`journal-${index}`));
    });
    it('renders one bubble while the submission is still dispatching', ()=>{
        const outbox = [
            createStructuredAgentSessionOutboxEntry({
                clientMessageId: 'client-pending',
                sessionId: 'session-1',
                text: 'Ok thanks',
                attachments: [],
                queuedAt: 1
            })
        ];
        const walItem = {
            itemId: agentJournalSubmissionKey('client-pending'),
            revision: 0,
            sequence: 1,
            observedAt: 1,
            body: {
                kind: 'message',
                role: 'user',
                blocks: [
                    {
                        type: 'text',
                        text: 'Ok thanks'
                    }
                ]
            }
        };
        const pending = {
            ...submission(0),
            clientMessageId: 'client-pending',
            dispatchState: 'pending',
            providerItemId: null,
            resolvedAt: null
        };
        const messages = projectStructuredAgentSessionMessages([
            walItem
        ], outbox, [
            pending
        ]);
        const optimistic = projectStructuredAgentSessionMessages([], outbox, []);
        expect(messages.filter((message)=>message.role === 'user')).toHaveLength(1);
        expect(messages.map((message)=>message.id)).toEqual([
            walItem.itemId
        ]);
        expect(optimistic[0]?.id).toBe(messages[0]?.id);
    });
    it('keeps an optimistic send until its acceptance arrives', ()=>{
        const outbox = [
            createStructuredAgentSessionOutboxEntry({
                clientMessageId: 'client-pending',
                sessionId: 'session-1',
                text: 'pending',
                attachments: [],
                queuedAt: 1
            })
        ];
        expect(projectStructuredAgentSessionMessages([], outbox, [])).toMatchObject([
            {
                id: agentJournalSubmissionKey('client-pending'),
                role: 'user'
            }
        ]);
    });
});
