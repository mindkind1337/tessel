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
export function isPersistedAgentSessionRuntimeKind(value) {
    return value === 'native' || value === 'tui';
}
export function isPersistedAgentSessionHandoffStage(value) {
    return value === 'preparing' || value === 'old-owner-stopped' || value === 'new-owner-proving' || value === 'recovering' || value === 'manual-recovery';
}
function isLegacyHandoffStage(stage) {
    return stage === 'preparing' || stage === 'old-owner-stopped' || stage === 'manual-recovery';
}
export function leaseCarriesLegacyHandoffValues(lease) {
    return lease.runtimeKind === 'tui' || isLegacyHandoffStage(lease.handoffStage);
}
export function normalizeLegacyHandoffLease(lease) {
    const { runtimeKind, handoffStage } = lease;
    const stage = isLegacyHandoffStage(handoffStage) ? 'recovering' : handoffStage;
    if (runtimeKind === 'native') {
        return {
            ...lease,
            runtimeKind,
            handoffStage: stage
        };
    }
    return {
        ...lease,
        runtimeKind: 'native',
        handoffStage: stage,
        claimStatus: lease.ownerProcess === null ? lease.claimStatus : 'conflicted'
    };
}
export function terminalOwnerRefusalMessage(lease) {
    const owner = lease.ownerProcess;
    const process = owner?.processStartTimeMs != null ? t("chat.orca.copy.process_pid", " (process {{pid}})", { pid: owner.pid }) : '';
    return t("chat.orca.copy.this_chat_is_still_open_in_a_terminal_agentprocess_quit_that_agent_to_continue_the_chat_here", "This chat is still open in a terminal agent{{process}}. Quit that agent to continue the chat here.", { process: process });
}
export function normalizeLegacyHandoffRecord(record) {
    return {
        record: {
            ...record,
            lease: normalizeLegacyHandoffLease(record.lease)
        },
        normalized: leaseCarriesLegacyHandoffValues(record.lease)
    };
}
