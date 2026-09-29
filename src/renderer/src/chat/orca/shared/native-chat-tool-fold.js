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
import { isBackgroundTaskBlock, isSubagentGroupBlock, isToolCallBlock, isToolResultBlock } from "./native-chat-types.js";
import { isKnownHarnessInjectedUserTurnText } from "./harness-injected-user-turns.js";
import { isNoiseMessage } from "./native-chat-noise.js";
function isToolOnlyMessage(message) {
    return message.blocks.length > 0 && message.blocks.every((block)=>isToolCallBlock(block) || isToolResultBlock(block));
}
function isHarnessSidecarToolMessage(message) {
    if (message.role !== 'user' || isInterruptionBoundary(message) || !message.blocks.some(isToolResultBlock)) {
        return false;
    }
    const textBlocks = message.blocks.filter((block)=>block.type === 'text');
    return textBlocks.length > 0 && message.blocks.every((block)=>isToolResultBlock(block) || block.type === 'text' && isKnownHarnessInjectedUserTurnText(block.text));
}
function isSubagentRosterMessage(message) {
    return message.blocks.some(isSubagentGroupBlock);
}
function isBackgroundTaskMessage(message) {
    return message.blocks.some(isBackgroundTaskBlock);
}
function isInterruptionBoundary(message) {
    return message.blocks.some((block)=>block.type === 'text' && block.text.trim().toLowerCase().startsWith('[request interrupted'));
}
function dropUnattributableToolResults(message) {
    let blocks;
    let unansweredCalls = 0;
    for(let index = 0; index < message.blocks.length; index++){
        const block = message.blocks[index];
        if (isToolCallBlock(block)) {
            unansweredCalls += 1;
        } else if (isToolResultBlock(block)) {
            if (unansweredCalls === 0) {
                blocks ??= message.blocks.slice(0, index);
                continue;
            }
            unansweredCalls -= 1;
        }
        blocks?.push(block);
    }
    if (!blocks) {
        return message;
    }
    return blocks.length > 0 ? {
        ...message,
        blocks
    } : null;
}
export function foldToolMessages(messages) {
    const output = [];
    let mutableAssistantIndex = -1;
    let clonedAssistantIndex = -1;
    for (const message of messages){
        if (isHarnessSidecarToolMessage(message) && mutableAssistantIndex >= 0) {
            const index = mutableAssistantIndex;
            const assistant = output[index];
            if (assistant?.role === 'assistant') {
                if (clonedAssistantIndex !== index) {
                    output[index] = {
                        ...assistant,
                        blocks: [
                            ...assistant.blocks
                        ]
                    };
                    clonedAssistantIndex = index;
                }
                output[index].blocks.push(...message.blocks.filter(isToolResultBlock));
                output.push({
                    ...message,
                    blocks: message.blocks.filter((block)=>!isToolResultBlock(block))
                });
                continue;
            }
        }
        if (isToolOnlyMessage(message) && mutableAssistantIndex >= 0) {
            const index = mutableAssistantIndex;
            const assistant = output[index];
            if (assistant?.role !== 'assistant') {
                output.push(message);
                mutableAssistantIndex = -1;
                continue;
            }
            if (clonedAssistantIndex !== index) {
                output[index] = {
                    ...assistant,
                    blocks: [
                        ...assistant.blocks
                    ]
                };
                clonedAssistantIndex = index;
            }
            output[index].blocks.push(...message.blocks);
            continue;
        }
        output.push(message);
        if (message.role === 'assistant') {
            mutableAssistantIndex = output.length - 1;
            clonedAssistantIndex = -1;
        } else if (!isSubagentRosterMessage(message) && !isBackgroundTaskMessage(message) && (!isNoiseMessage(message) || isInterruptionBoundary(message))) {
            mutableAssistantIndex = -1;
            clonedAssistantIndex = -1;
        }
    }
    const attributedOutput = [];
    for (const message of output){
        const attributed = dropUnattributableToolResults(message);
        if (attributed) {
            attributedOutput.push(attributed);
        }
    }
    return attributedOutput;
}
export function pairToolBlocks(blocks, limit = Infinity) {
    const pairs = [];
    const callSlots = [];
    let resultOrdinal = 0;
    for (const block of blocks){
        if (pairs.length >= limit && resultOrdinal >= callSlots.length) {
            break;
        }
        if (block.type === 'tool-call') {
            if (pairs.length < limit) {
                callSlots.push(pairs.length);
                pairs.push({
                    call: block
                });
            }
            continue;
        }
        if (block.type !== 'tool-result') {
            continue;
        }
        const slot = callSlots[resultOrdinal];
        if (slot === undefined) {
            if (pairs.length < limit) {
                pairs.push({
                    result: block
                });
            }
        } else {
            resultOrdinal += 1;
            pairs[slot].result = block;
        }
    }
    return pairs;
}
export function splitNativeChatBlocks(blocks) {
    const prose = [];
    const tools = [];
    for (const block of blocks){
        if (isToolCallBlock(block) || isToolResultBlock(block)) {
            tools.push(block);
        } else {
            prose.push(block);
        }
    }
    return {
        prose,
        tools
    };
}
