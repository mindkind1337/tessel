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
import { t } from "../../../i18n/index.js";
import { dispatchRejectionReasonIsInternal, dispatchRejectionWasTransportWriteFailure } from "./structured-agent-session-dispatch-rejection.js";
import { classifyStructuredAgentSessionSendFailure, requeueStructuredAgentSessionSendRefusal } from "./structured-agent-session-outbox.js";
function replaceEntryState(input, state) {
    return input.entries.map((candidate)=>candidate.clientMessageId === input.entry.clientMessageId ? {
            ...candidate,
            state
        } : candidate);
}
function dropEntry(input) {
    return input.entries.filter((candidate)=>candidate.clientMessageId !== input.entry.clientMessageId);
}
function refusedRedelivery(entry, submission) {
    return entry.retryAfterUnknownSubmittedAt !== null && submission.dispatchState === 'unknown' && submission.submittedAt === entry.retryAfterUnknownSubmittedAt;
}
export function structuredAgentSessionRejectionNotice(reason) {
    if (reason === null) {
        return t("chat.orca.copy.message_was_not_sent", "Message was not sent.");
    }
    if (dispatchRejectionWasTransportWriteFailure(reason)) {
        return t("chat.orca.copy.couldn_t_reach_the_agent_your_message_was_not_sent_retry_to_send_it_again", "Couldn't reach the agent. Your message was not sent — Retry to send it again.");
    }
    return dispatchRejectionReasonIsInternal(reason) ? t("chat.orca.copy.orca_could_not_send_your_message_retry_to_send_it_again", "Orca could not send your message — Retry to send it again.") : reason;
}
export function disposeStructuredAgentSessionSendResult(input) {
    const result = input.result;
    if (!result.ok) {
        const refusedIndex = input.entries.findIndex((candidate)=>candidate.clientMessageId === input.entry.clientMessageId);
        const entries = input.entries.map((candidate)=>candidate.clientMessageId === input.entry.clientMessageId ? requeueStructuredAgentSessionSendRefusal(candidate, result.refusal.code, input.createOperationId, input.entry.lastAttemptAt !== null) : candidate);
        return {
            entries,
            error: result.refusal.message,
            blockedClientMessageId: entries[refusedIndex]?.clientMessageId ?? null,
            retryWithFreshClientMessageId: null
        };
    }
    const submission = result.value.submission;
    if (refusedRedelivery(input.entry, submission)) {
        return {
            entries: dropEntry(input),
            error: t("chat.orca.copy.message_delivery_is_unconfirmed_and_orca_will_not_send_it_again", "Message delivery is unconfirmed and Orca will not send it again"),
            blockedClientMessageId: input.blockedClientMessageId,
            retryWithFreshClientMessageId: null
        };
    }
    if (submission.dispatchState === 'accepted') {
        return {
            entries: dropEntry(input),
            error: null,
            blockedClientMessageId: input.blockedClientMessageId,
            retryWithFreshClientMessageId: null
        };
    }
    if (submission.dispatchState === 'rejected') {
        return {
            entries: replaceEntryState(input, 'queued'),
            error: structuredAgentSessionRejectionNotice(submission.reason),
            blockedClientMessageId: input.entry.clientMessageId,
            retryWithFreshClientMessageId: input.entry.clientMessageId
        };
    }
    if (submission.dispatchState === 'unknown' && submission.recovered) {
        return {
            entries: input.entries.map((candidate)=>candidate.clientMessageId === input.entry.clientMessageId ? {
                    ...candidate,
                    state: 'unconfirmed',
                    retryAfterUnknownSubmittedAt: -1
                } : candidate),
            error: null,
            blockedClientMessageId: input.blockedClientMessageId,
            retryWithFreshClientMessageId: null
        };
    }
    return {
        entries: replaceEntryState(input, submission.dispatchState === 'unknown' ? 'unconfirmed' : 'dispatching'),
        error: null,
        blockedClientMessageId: input.blockedClientMessageId,
        retryWithFreshClientMessageId: null
    };
}
export function disposeStructuredAgentSessionSendFailure(input) {
    const failure = classifyStructuredAgentSessionSendFailure(input.cause, input.isDeliveryUnknown);
    const deliveryUnknown = failure === 'delivery-unknown';
    return {
        entries: replaceEntryState(input, deliveryUnknown ? 'unconfirmed' : 'queued'),
        error: deliveryUnknown ? t("chat.orca.copy.message_delivery_is_unconfirmed", "Message delivery is unconfirmed") : String(input.cause),
        blockedClientMessageId: deliveryUnknown ? input.blockedClientMessageId : input.entry.clientMessageId,
        retryWithFreshClientMessageId: null
    };
}
