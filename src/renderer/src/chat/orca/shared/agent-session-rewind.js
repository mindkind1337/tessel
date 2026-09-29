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
import { z } from 'zod';
import { AgentJournalItemBodySchema } from "./agent-session-journal-schemas.js";
import { parseAgentJournalItemKey } from "./agent-session-journal-item-key.js";
export const AGENT_SESSION_REWIND_REASONS = [
    'unsupported',
    'history-not-paginated',
    'busy',
    'stale-epoch',
    'invalid-target',
    'history-limit',
    'provider-refused',
    'proof-mismatch',
    'outcome-unknown'
];
const Key = z.string().min(1).max(4096);
export const AgentSessionRewindRecordSchema = z.object({
    operationId: Key,
    callerKey: Key,
    itemId: Key,
    providerItemId: Key.optional(),
    expectedEpoch: Key,
    phase: z.enum([
        'prepared',
        'provider-succeeded',
        'completed',
        'refused'
    ]),
    epoch: Key.optional(),
    hydrationVerified: z.boolean().optional(),
    providerApplied: z.boolean().optional(),
    reason: z.string().min(1).max(512).optional(),
    retained: z.array(z.object({
        itemId: Key.refine((key)=>parseAgentJournalItemKey(key) !== null),
        body: AgentJournalItemBodySchema,
        observedAt: z.number().finite()
    })).max(10_000)
});
export const isAgentSessionRewindRecord = (value)=>AgentSessionRewindRecordSchema.safeParse(value).success;
export function isAgentSessionRewindResult(value) {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const result = value;
    return typeof result.itemId === 'string' && typeof result.epoch === 'string';
}
