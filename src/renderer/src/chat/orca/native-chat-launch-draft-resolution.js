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
import { LIFECYCLE_CLOCK_SKEW_SLACK_MS } from "./native-chat-live-status.js";
export function nativeChatLaunchDraftTurnBaseline(messages) {
    const userTurns = messages.filter((message)=>message.role === 'user');
    return {
        userTurnCount: userTurns.length,
        lastUserTurnId: userTurns.at(-1)?.id ?? null
    };
}
export function launchDraftResolvedByTranscript(entry, messages, baseline) {
    const provablyOlder = (message)=>message.timestamp !== null && message.timestamp + LIFECYCLE_CLOCK_SKEW_SLACK_MS < entry.createdAt;
    if (messages.some((message)=>message.role === 'user' && !provablyOlder(message))) {
        return true;
    }
    if (!baseline) {
        return false;
    }
    const userTurns = messages.filter((message)=>message.role === 'user');
    return userTurns.length > baseline.userTurnCount && (userTurns.at(-1)?.id ?? null) !== baseline.lastUserTurnId;
}
