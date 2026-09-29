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
import { agentJournalSubmissionKey } from "./agent-session-journal-item-key.js";
import { reconcileStructuredAgentSessionOutbox } from "./structured-agent-session-outbox.js";
import { projectStructuredItemsToNativeChat } from "./structured-agent-session-projection.js";
export function projectStructuredAgentSessionMessages(items, outbox, submissions, projectItems = projectStructuredItemsToNativeChat) {
    const optimistic = reconcileStructuredAgentSessionOutbox(outbox, submissions);
    const rejected = new Set(submissions.filter((submission)=>submission.dispatchState === 'rejected').map((submission)=>agentJournalSubmissionKey(submission.clientMessageId)));
    const visibleItems = items.filter((item)=>!rejected.has(item.itemId));
    const journalled = new Set(visibleItems.map((item)=>item.itemId));
    return [
        ...projectItems(visibleItems),
        ...optimistic.filter((entry)=>!journalled.has(agentJournalSubmissionKey(entry.clientMessageId))).map((entry)=>({
                id: agentJournalSubmissionKey(entry.clientMessageId),
                role: 'user',
                source: 'transcript',
                timestamp: entry.queuedAt,
                blocks: entry.body.blocks
            }))
    ];
}
