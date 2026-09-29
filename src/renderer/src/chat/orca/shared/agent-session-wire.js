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
export * from "./agent-session-wire-refusals.js";
import { agentSessionScopeKey } from "./agent-session-record.js";
export { agentSessionBackgroundTasksEqual } from "./agent-session-background-task-wire.js";
export const AGENT_SESSION_ID_MAX_LENGTH = 512;
export const AGENT_SESSION_HISTORY_DEFAULT_LIMIT = 40;
export const AGENT_SESSION_HISTORY_MAX_LIMIT = 200;
export const AGENT_SESSION_HISTORY_DIRECTIONS = [
    'tail',
    'before',
    'after'
];
export function agentSessionTurnCompletionKey(completion) {
    return [
        agentSessionScopeKey(completion.scope),
        completion.sessionId,
        completion.turnId
    ].join('\u0000');
}
export const AGENT_SESSION_THREAD_GOAL_OBJECTIVE_MAX_LENGTH = 4000;
