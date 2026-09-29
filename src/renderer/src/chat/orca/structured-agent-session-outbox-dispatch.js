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
import { t } from "../../i18n/index.js";
import { disposeStructuredAgentSessionSendFailure, disposeStructuredAgentSessionSendResult } from "./shared/structured-agent-session-send-disposition.js";
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client';
import { structuredAgentSessionSendRequest, updateStructuredAgentSessionOutboxEntry } from "./shared/structured-agent-session-outbox.js";
import { writeOutbox } from "./structured-agent-session-outbox-storage.js";
import { getStructuredAgentLaunchPromptDispatch, shareStructuredAgentLaunchPromptDispatch } from '@/lib/structured-agent-session-launch-prompt';
function isDesktopDeliveryUnknown(error) {
    const text = error instanceof Error ? `${error.name}:${error.message}` : String(error);
    return /timeout|disconnect|connection|closed|unavailable|cutover/i.test(text);
}
export function hasInFlightLaunchDispatch(entry, fence) {
    return Boolean(entry.source === 'launch' && getStructuredAgentLaunchPromptDispatch(entry.sessionId, entry.clientMessageId, fence ?? undefined));
}
export function readMountedStructuredAgentSessionOutbox(sessionId, fence, read) {
    return read(sessionId, {
        recoverDispatching: false
    }).map((entry)=>entry.state === 'dispatching' && !hasInFlightLaunchDispatch(entry, fence) ? {
            ...entry,
            state: 'unconfirmed'
        } : entry);
}
export function dispatchStructuredAgentSessionOutboxEntry(args) {
    const start = async ()=>{
        args.inFlightIdRef.current = args.next.clientMessageId;
        const staged = updateStructuredAgentSessionOutboxEntry(args.persisted, args.next.clientMessageId, (entry)=>({
                ...entry,
                state: 'dispatching',
                lastAttemptAt: Date.now()
            }));
        if (!writeOutbox(args.sessionId, staged)) {
            args.inFlightIdRef.current = null;
            args.blockedIdRef.current = args.next.clientMessageId;
            args.setError(t("chat.orca.copy.message_could_not_be_saved_to_the_outbox", "Message could not be saved to the outbox"));
            return false;
        }
        args.outboxRef.current = staged;
        args.setOutbox(staged);
        try {
            const result = await callStructuredAgentSession(args.target, 'agentSession.send', structuredAgentSessionSendRequest(args.next, args.fence));
            if (args.dispatchGenerationRef.current !== args.dispatchGeneration) {
                return false;
            }
            args.applyDisposition(disposeStructuredAgentSessionSendResult({
                entries: args.outboxRef.current,
                entry: args.next,
                blockedClientMessageId: args.blockedIdRef.current,
                result,
                createOperationId: args.createOperationId
            }));
            return result.ok ? result.value.submission.dispatchState === 'accepted' || result.value.submission.dispatchState === 'pending' : false;
        } catch (caught) {
            if (args.dispatchGenerationRef.current !== args.dispatchGeneration) {
                return false;
            }
            args.applyDisposition(disposeStructuredAgentSessionSendFailure({
                entries: args.outboxRef.current,
                entry: args.next,
                blockedClientMessageId: args.blockedIdRef.current,
                cause: caught,
                isDeliveryUnknown: isDesktopDeliveryUnknown
            }));
            return false;
        }
    };
    return args.next.source === 'launch' ? shareStructuredAgentLaunchPromptDispatch(args.next.sessionId, args.next.clientMessageId, args.fence, start) : {
        promise: start(),
        started: true
    };
}
