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
import { isBackgroundTaskBlock, isSubagentGroupBlock, isToolCallBlock } from "./shared/native-chat-types.js";
import { nativeChatTurnFold } from "./shared/native-chat-turn-fold.js";
import { deriveNativeChatRowContent, nativeChatRowRendersContent } from "./shared/native-chat-row-content.js";
import { estimateNativeChatRowHeight, nativeChatRowContentMetrics } from "./native-chat-row-height-estimate.js";
function isAlertNotice(message, block) {
    return message.role === 'system' && block.type === 'text' && (block.tone === 'error' || block.tone === 'warning');
}
// Tessel: what changed the session itself (a compaction, a model or effort
// change) is not a turn's work: it stays in view when the turn folds.
const SESSION_NOTICES = new Set(['compaction', 'session-option', 'interrupted']);
function isSessionNotice(message, block) {
    return message.role === 'system' && block.type === 'text' && SESSION_NOTICES.has(block.presentation);
}
export function buildNativeChatTranscriptSlots(input) {
    const { messages, turnKeys, latestUserIndex, currentTurnKey, receipts, turnStatuses, turnDiffs, showTurnStatus, expandedTurnKeys, isWorking, lifecycleWorking } = input;
    const foldRows = messages.map((message, index)=>{
        const content = deriveNativeChatRowContent(message.blocks);
        return {
            turnKey: turnKeys[index],
            role: message.role,
            rendersProse: content.markdown.length > 0 || content.hasImages,
            // Tessel: an error or a warning stays in view when its turn folds.
            outlivesTurn: message.blocks.some((block)=>isSubagentGroupBlock(block) || isBackgroundTaskBlock(block) || isAlertNotice(message, block) || isSessionNotice(message, block))
        };
    });
    const trailingRunIndex = foldRows.findLastIndex((row, index)=>row.role !== 'user' && row.role !== 'reasoning' && receipts.get(messages[index].id)?.kind !== 'approval' && (row.rendersProse || messages[index].blocks.some(isToolCallBlock)));
    const settledTurnKeys = new Set(showTurnStatus ? Object.entries(turnStatuses.completedByTurn).filter(([, status])=>status.workedSeconds != null).map(([turnKey])=>turnKey) : []);
    const { foldedRows, foldableTurnKeys } = nativeChatTurnFold({
        rows: foldRows,
        settledTurnKeys,
        expandedTurnKeys
    });
    const slots = [];
    for (const [index, message] of messages.entries()){
        const turnKey = turnKeys[index];
        const receipt = receipts.get(message.id);
        const candidateStatus = index === latestUserIndex ? turnStatuses.active : message.role === 'user' && turnKey ? turnStatuses.completedByTurn[turnKey] : undefined;
        const status = showTurnStatus && candidateStatus?.workedSeconds != null ? candidateStatus : undefined;
        const turnDiff = turnKey && turnKeys[index + 1] !== turnKey ? turnDiffs.get(turnKey) : undefined;
        const folded = foldedRows.has(index);
        const drawsRow = receipt !== undefined || !folded && nativeChatRowRendersContent(message.blocks);
        if (!drawsRow && status === undefined && turnDiff === undefined) {
            continue;
        }
        slots.push({
            message,
            turnKey,
            activeTurnIsWorking: (currentTurnKey ? turnKey === currentTurnKey : turnKey === undefined) && (isWorking || lifecycleWorking),
            trailingRun: index === trailingRunIndex,
            receipt,
            status: status ?? undefined,
            folded,
            turnFolds: turnKey !== undefined && foldableTurnKeys.has(turnKey),
            turnDiff,
            estimatedHeight: estimateNativeChatRowHeight(nativeChatRowContentMetrics(message), {
                hasReceipt: receipt !== undefined,
                hasStatus: status !== undefined,
                hasTurnDiff: turnDiff !== undefined,
                folded
            })
        });
    }
    return slots;
}
export function nativeChatSlotIndexOf(slots, messageId) {
    if (messageId === undefined) {
        return -1;
    }
    return slots.findIndex((slot)=>slot.message.id === messageId);
}
