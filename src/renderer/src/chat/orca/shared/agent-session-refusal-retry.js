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
export function agentSessionRefusalOperationState(code) {
    switch(code){
        case 'agent_session_owner_restart_failed':
        case 'agent_session_operation_conflict':
        case 'agent_session_operation_expired':
        case 'agent_session_operation_invalid':
        case 'agent_session_item_revision_stale':
        case 'agent_session_already_resolved':
            return 'settled-rejected';
        case 'agent_session_operation_unknown':
            return 'unknown';
        case 'structured_agent_session_unsupported':
        case 'agent_session_checkpoint_stale':
        case 'agent_session_conflict':
        case 'agent_session_ownership_unknown':
        case 'agent_session_operation_capacity':
        case 'agent_session_identity_required':
        case 'agent_session_journal_unreadable':
        case 'execution_owner_reconciling':
            return 'pending-admission';
    }
}
