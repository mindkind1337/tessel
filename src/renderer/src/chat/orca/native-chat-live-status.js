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
export function mergeNativeChatLiveSession(input) {
    const { messages, sessionId, agent, hookState, stateStartedAt, transcriptLifecycle, statusTailMessage, hookHasWorkingSubagents, loading, error } = input;
    if (error) {
        return {
            messages,
            status: 'error',
            sessionId,
            agent,
            error
        };
    }
    const status = liveStatusOverride(hookState, statusTailMessage ?? messages.at(-1), stateStartedAt, transcriptLifecycle, hookHasWorkingSubagents ?? false);
    if (loading && status !== 'working') {
        return {
            messages,
            status: 'loading',
            sessionId,
            agent
        };
    }
    return {
        messages,
        status: status ?? (messages.length === 0 ? 'empty' : 'ready'),
        sessionId,
        agent
    };
}
export const LIFECYCLE_CLOCK_SKEW_SLACK_MS = 2_000;
function liveStatusOverride(hookState, statusTailMessage, stateStartedAt, transcriptLifecycle, hookHasWorkingSubagents) {
    if (hookState !== 'working') {
        return undefined;
    }
    const terminatesCurrentTurn = lifecycleTerminatesCurrentTurn(transcriptLifecycle, stateStartedAt);
    if (terminatesCurrentTurn && transcriptLifecycle?.state === 'interrupted') {
        return undefined;
    }
    if (hookHasWorkingSubagents) {
        return 'working';
    }
    if (terminatesCurrentTurn) {
        return undefined;
    }
    if (transcriptLifecycle?.state !== 'working' && trailingAssistantPostDates(statusTailMessage, stateStartedAt)) {
        return undefined;
    }
    return 'working';
}
function lifecycleTerminatesCurrentTurn(lifecycle, stateStartedAt) {
    if (lifecycle?.state !== 'completed' && lifecycle?.state !== 'interrupted') {
        return false;
    }
    if (stateStartedAt == null || lifecycle.timestamp == null) {
        return true;
    }
    if (lifecycle.timestamp >= stateStartedAt) {
        return true;
    }
    if (lifecycle.timestamp > 1e11 && stateStartedAt > 1e11) {
        return lifecycle.timestamp + LIFECYCLE_CLOCK_SKEW_SLACK_MS >= stateStartedAt;
    }
    return false;
}
function trailingAssistantPostDates(message, stateStartedAt) {
    if (stateStartedAt == null) {
        return false;
    }
    return message?.role === 'assistant' && message.timestamp != null && message.timestamp >= stateStartedAt;
}
