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
import { projectAgentSessionConversationOutline, truncateOutlinePreview } from "../shared/agent-session-conversation-outline.js";
import { agentJournalSubmissionKey } from "../shared/agent-session-journal-item-key.js";
import { buildNativeChatRailItems } from "../native-chat-message-rail-items.js";
import { createNativeChatMessageListProjection } from "../native-chat-message-list-projection.js";
import { projectNativeChatTaskListFrames } from "../native-chat-task-list-frames.js";
import { omitNativeChatThreadGoalRows } from "../native-chat-thread-goal-rows.js";
import { buildNativeChatTranscriptSlots } from "../native-chat-transcript-slots.js";
import { projectStructuredAgentSessionMessages } from "../structured-agent-session-message-projection.js";
function row(sequence, body, itemId = `item-${sequence}`) {
    return {
        itemId,
        revision: 1,
        sequence,
        observedAt: 1_000 + sequence,
        body
    };
}
function user(sequence, blocks, itemId) {
    return row(sequence, {
        kind: 'message',
        role: 'user',
        blocks
    }, itemId);
}
const REJECTED = {
    clientMessageId: 'client-refused',
    fence: 1,
    payloadFingerprint: 'fingerprint',
    dispatchState: 'rejected',
    providerItemId: null,
    reason: 'refused',
    submittedAt: 1,
    resolvedAt: 2
};
const JOURNAL = [
    user(1, [
        {
            type: 'text',
            text: '  Fix   the\nparser  '
        }
    ]),
    row(2, {
        kind: 'message',
        role: 'assistant',
        blocks: [
            {
                type: 'text',
                text: 'On it.'
            }
        ]
    }),
    row(3, {
        kind: 'tool-call',
        name: 'Read',
        state: 'completed',
        input: {
            file_path: 'a.ts'
        }
    }),
    user(4, [
        {
            type: 'tool-result',
            output: 'file body'
        },
        {
            type: 'text',
            text: '<system-reminder>Keep going.</system-reminder>'
        }
    ]),
    user(5, [
        {
            type: 'image-ref',
            path: '/tmp/one.png'
        }
    ]),
    user(6, [
        {
            type: 'text',
            text: 'refused send'
        }
    ], agentJournalSubmissionKey('client-refused')),
    user(7, [
        {
            type: 'text',
            text: '<command-name>/compact</command-name>'
        }
    ]),
    user(8, [
        {
            type: 'text',
            text: ''
        }
    ]),
    user(9, [
        {
            type: 'text',
            text: 'Compare these'
        },
        {
            type: 'image-ref',
            path: '/tmp/a.png'
        },
        {
            type: 'image-ref',
            path: '/tmp/b.png'
        }
    ]),
    row(10, {
        kind: 'message',
        role: 'assistant',
        blocks: [
            {
                type: 'text',
                text: 'Done.'
            }
        ]
    }),
    user(11, [
        {
            type: 'text',
            text: 'Thanks'
        }
    ]),
    {
        ...user(12, [
            {
                type: 'text',
                text: 'Observed earlier'
            }
        ]),
        observedAt: 1_009.5
    }
];
function loadedRailItems(items, submissions) {
    const projected = createNativeChatMessageListProjection()(projectStructuredAgentSessionMessages(items, [], submissions));
    const messages = omitNativeChatThreadGoalRows(projectNativeChatTaskListFrames(projected));
    let turn;
    const turnKeys = messages.map((message)=>{
        if (message.role === 'user') {
            turn = message.id;
        }
        return turn;
    });
    const slots = buildNativeChatTranscriptSlots({
        messages,
        turnKeys,
        latestUserIndex: messages.findLastIndex((message)=>message.role === 'user'),
        currentTurnKey: turn,
        receipts: new Map(),
        turnStatuses: {
            active: null,
            completedByTurn: {}
        },
        turnDiffs: new Map(),
        showTurnStatus: true,
        expandedTurnKeys: new Set(),
        isWorking: false,
        lifecycleWorking: false
    });
    return buildNativeChatRailItems(slots);
}
describe('conversation outline parity with the loaded rail', ()=>{
    it('lists exactly the user messages the transcript gives a rail tick, with the same ids and previews', ()=>{
        const outline = projectAgentSessionConversationOutline(JOURNAL, [
            REJECTED
        ]);
        const loaded = loadedRailItems(JOURNAL, [
            REJECTED
        ]);
        expect(outline.map((entry)=>entry.itemId)).toEqual(loaded.map((item)=>item.id));
        expect(outline.map((entry)=>({
                id: entry.itemId,
                text: entry.preview,
                hasImages: entry.imageCount > 0
            }))).toEqual(loaded.map(({ id, text, hasImages })=>({
                id,
                text,
                hasImages
            })));
        expect(outline.map((entry)=>entry.itemId)).toEqual([
            'item-1',
            'item-5',
            'item-9',
            'item-12',
            'item-11'
        ]);
    });
    it('carries each entry its creation sequence and image count', ()=>{
        const outline = projectAgentSessionConversationOutline(JOURNAL, [
            REJECTED
        ]);
        expect(outline).toEqual([
            {
                itemId: 'item-1',
                sequence: 1,
                preview: 'Fix the parser',
                imageCount: 0
            },
            {
                itemId: 'item-5',
                sequence: 5,
                preview: '',
                imageCount: 1
            },
            {
                itemId: 'item-9',
                sequence: 9,
                preview: 'Compare these',
                imageCount: 2
            },
            {
                itemId: 'item-12',
                sequence: 12,
                preview: 'Observed earlier',
                imageCount: 0
            },
            {
                itemId: 'item-11',
                sequence: 11,
                preview: 'Thanks',
                imageCount: 0
            }
        ]);
    });
});
describe('outline preview truncation', ()=>{
    it('cuts to the cap without splitting a surrogate pair', ()=>{
        expect(truncateOutlinePreview('short', 10)).toBe('short');
        expect(truncateOutlinePreview('abcdef', 3)).toBe('abc');
        const emoji = 'ab\u{1F600}cd';
        expect(truncateOutlinePreview(emoji, 3)).toBe('ab');
        expect(truncateOutlinePreview(emoji, 4)).toBe('ab\u{1F600}');
    });
});
