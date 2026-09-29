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
// Protocol/recognition text stays English; translate only at the display boundary.
export const NATIVE_CHAT_SOURCES = [
    'transcript',
    'hook',
    'scrape'
];
export const NATIVE_CHAT_SOURCE_PRIORITY = {
    transcript: 3,
    hook: 2,
    scrape: 1
};
export const NATIVE_CHAT_ROLES = [
    'user',
    'assistant',
    'tool',
    'reasoning',
    'system'
];
export const NATIVE_CHAT_SUBAGENT_STATES = [
    'working',
    'idle',
    'completed',
    'failed',
    'stopped',
    'unverifiable'
];
export const NATIVE_CHAT_TURN_LIFECYCLE_STATES = [
    'working',
    'completed',
    'interrupted'
];
export const NATIVE_CHAT_INTERRUPTED_STATUS_TEXT = "Conversation interrupted" /* i18n-ignore */; // i18n-ignore
export const NATIVE_CHAT_SESSION_STATUSES = [
    'loading',
    'ready',
    'working',
    'empty',
    'error'
];
export function isTextBlock(block) {
    return block.type === 'text';
}
export function isToolCallBlock(block) {
    return block.type === 'tool-call';
}
export function isToolResultBlock(block) {
    return block.type === 'tool-result';
}
export function isInterruptedStatusMessage(message) {
    return message.role === 'system' && message.blocks.some((block)=>block.type === 'text' && block.text === NATIVE_CHAT_INTERRUPTED_STATUS_TEXT);
}
export function isImageRefBlock(block) {
    return block.type === 'image-ref';
}
export function isSubagentGroupBlock(block) {
    return block.type === 'subagent-group';
}
export function isBackgroundTaskBlock(block) {
    return block.type === 'background-task';
}
