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
export const STRUCTURED_AGENT_SESSION_CLIENT_COALESCE_MS = 48;
function bypassCoalescing(event) {
    return event.type !== 'batch' || event.batch.items.some((item)=>item.body.kind !== 'message' || item.body.role !== 'assistant');
}
function mergeBatch(left, right) {
    const items = new Map(left.batch.items.map((item)=>[
            item.itemId,
            item
        ]));
    for (const item of right.batch.items){
        items.set(item.itemId, item);
    }
    const submissions = new Map(left.batch.submissions.map((submission)=>[
            submission.clientMessageId,
            submission
        ]));
    for (const submission of right.batch.submissions){
        submissions.set(submission.clientMessageId, submission);
    }
    return {
        type: 'batch',
        ...right.commands !== undefined || left.commands !== undefined ? {
            commands: right.commands !== undefined ? right.commands : left.commands
        } : {},
        sessionId: right.sessionId,
        batch: {
            cursor: right.batch.cursor,
            items: [
                ...items.values()
            ],
            removedItemIds: [
                ...new Set([
                    ...left.batch.removedItemIds,
                    ...right.batch.removedItemIds
                ])
            ],
            submissions: [
                ...submissions.values()
            ]
        },
        ...right.fence !== undefined || left.fence !== undefined ? {
            fence: right.fence ?? left.fence
        } : {},
        ...right.backgroundTasks !== undefined || left.backgroundTasks !== undefined ? {
            backgroundTasks: right.backgroundTasks !== undefined ? right.backgroundTasks : left.backgroundTasks ?? null
        } : {},
        ...right.activity !== undefined || left.activity !== undefined ? {
            activity: right.activity !== undefined ? right.activity : left.activity ?? null
        } : {}
    };
}
export function createStructuredAgentSessionEventCoalescer(emit, delayMs = STRUCTURED_AGENT_SESSION_CLIENT_COALESCE_MS) {
    let pending = null;
    let timer = null;
    const flush = ()=>{
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
        if (pending) {
            const event = pending;
            pending = null;
            emit(event);
        }
    };
    return {
        push (event) {
            if (bypassCoalescing(event)) {
                flush();
                emit(event);
                return;
            }
            if (event.type !== 'batch') {
                return;
            }
            pending = pending ? mergeBatch(pending, event) : event;
            timer ??= setTimeout(flush, delayMs);
        },
        flush,
        dispose () {
            if (timer) {
                clearTimeout(timer);
            }
            timer = null;
            pending = null;
        }
    };
}
