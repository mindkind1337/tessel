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
export { };
export const AGENT_SESSION_JOURNAL_SCHEMA_VERSION = 3;
export const AGENT_SESSION_JOURNAL_TURN_ITEM_SCHEMA_VERSION = 3;
const AGENT_SESSION_JOURNAL_PRE_TURN_SCHEMA_VERSION = 2;
export function journalRowSchemaVersion(bodies) {
    return bodies.some((body)=>body.kind === 'turn') ? AGENT_SESSION_JOURNAL_TURN_ITEM_SCHEMA_VERSION : AGENT_SESSION_JOURNAL_PRE_TURN_SCHEMA_VERSION;
}
export const AGENT_JOURNAL_MESSAGE_SEND_MODES = [
    'goal'
];
export const AGENT_JOURNAL_RESOLUTION_STATES = [
    'pending',
    'resolved',
    'cancelled'
];
export const AGENT_JOURNAL_TURN_LIFECYCLE_STATES = [
    'running',
    'completed',
    'interrupted',
    'unverifiable'
];
export { AGENT_JOURNAL_TURN_OUTCOMES } from "./agent-turn-outcome.js";
export const AGENT_JOURNAL_THREAD_GOAL_STATUSES = [
    'active',
    'paused',
    'blocked',
    'usageLimited',
    'budgetLimited',
    'complete'
];
export const AGENT_JOURNAL_DISPATCH_STATES = [
    'pending',
    'accepted',
    'rejected',
    'unknown'
];
export const AGENT_JOURNAL_RESET_REASONS = [
    'epoch_changed',
    'cursor_ahead',
    'cursor_compacted',
    'journal_gap',
    'schema_unreadable'
];
