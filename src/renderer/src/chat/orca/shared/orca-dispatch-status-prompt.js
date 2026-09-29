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
// Agent prompt recognition must match the original transcript.
export const ORCA_DISPATCH_STATUS_PREAMBLE_PREFIX = 'You are working inside Orca, a multi-agent IDE.'; // i18n-ignore
export const ORCA_DISPATCH_STATUS_TASK_MARKER = '=== TASK ===';
export const ORCA_DISPATCH_PROMPT_LEAD_LINE = 'Please carry out this task from my Orca coordinator by following the brief I pasted below.'; // i18n-ignore
const ORCA_DISPATCH_STATUS_TASK_ID_MARKER = 'Your task ID is:'; // i18n-ignore
const ORCA_DISPATCH_STATUS_SOURCE_SCAN_LIMIT = 24_576;
const PASTED_CONTENT_OPEN_TAG = '<pasted_content';
const PASTED_CONTENT_OPEN_TAG_MAX_LENGTH = 64;
export function findOrcaDispatchPreambleStart(value) {
    const scanEnd = Math.min(value.length, ORCA_DISPATCH_STATUS_SOURCE_SCAN_LIMIT);
    let start = skipTrimWhitespace(value, 0, scanEnd);
    if (value.startsWith(ORCA_DISPATCH_PROMPT_LEAD_LINE, start)) {
        start = skipTrimWhitespace(value, start + ORCA_DISPATCH_PROMPT_LEAD_LINE.length, scanEnd);
    }
    if (value.startsWith(PASTED_CONTENT_OPEN_TAG, start)) {
        const tagLength = value.slice(start, start + PASTED_CONTENT_OPEN_TAG_MAX_LENGTH).indexOf('>');
        if (tagLength === -1) {
            return -1;
        }
        start = skipTrimWhitespace(value, start + tagLength + 1, scanEnd);
    }
    return start + ORCA_DISPATCH_STATUS_PREAMBLE_PREFIX.length <= scanEnd && value.startsWith(ORCA_DISPATCH_STATUS_PREAMBLE_PREFIX, start) ? start : -1;
}
function skipTrimWhitespace(value, from, scanEnd) {
    let index = from;
    while(index < scanEnd && isEcmaTrimWhitespace(value.charCodeAt(index))){
        index++;
    }
    return index;
}
export function compactDispatchPromptForStatus(value, maxLength, normalizeSingleLine) {
    const start = findOrcaDispatchPreambleStart(value);
    if (start === -1) {
        return null;
    }
    const scan = value.slice(start, Math.min(value.length, ORCA_DISPATCH_STATUS_SOURCE_SCAN_LIMIT));
    let taskId = '';
    const idMarkerIndex = scan.indexOf(ORCA_DISPATCH_STATUS_TASK_ID_MARKER);
    if (idMarkerIndex !== -1) {
        const afterId = scan.slice(idMarkerIndex + ORCA_DISPATCH_STATUS_TASK_ID_MARKER.length);
        let idStart = 0;
        while(idStart < afterId.length && isEcmaTrimWhitespace(afterId.charCodeAt(idStart))){
            idStart++;
        }
        const idRest = afterId.slice(idStart);
        const idEnd = idRest.search(/\s/);
        taskId = (idEnd === -1 ? idRest : idRest.slice(0, idEnd)).trim();
    }
    let taskBody = '';
    const taskMarkerIndex = findOrcaDispatchTaskMarkerIndex(scan);
    if (taskMarkerIndex !== -1) {
        const body = scan.slice(taskMarkerIndex + ORCA_DISPATCH_STATUS_TASK_MARKER.length);
        for (const line of body.split(/\r?\n/)){
            const preview = line.trim().replace(/\s+/g, ' ');
            if (preview.startsWith('</pasted_content')) {
                break;
            }
            if (preview) {
                taskBody = preview;
                break;
            }
        }
    }
    let compact = ORCA_DISPATCH_STATUS_PREAMBLE_PREFIX;
    if (taskId) {
        compact += ` ${ORCA_DISPATCH_STATUS_TASK_ID_MARKER} ${taskId}`;
    }
    if (taskBody) {
        compact += ` ${ORCA_DISPATCH_STATUS_TASK_MARKER} ${taskBody}`;
    }
    return normalizeSingleLine(compact, maxLength);
}
export function findOrcaDispatchTaskMarkerIndex(value) {
    let searchFrom = 0;
    while(searchFrom < value.length){
        const markerIndex = value.indexOf(ORCA_DISPATCH_STATUS_TASK_MARKER, searchFrom);
        if (markerIndex === -1) {
            break;
        }
        const markerEnd = markerIndex + ORCA_DISPATCH_STATUS_TASK_MARKER.length;
        const startsLine = markerIndex === 0 || isLineBreak(value.charCodeAt(markerIndex - 1));
        const endsLine = markerEnd === value.length || isLineBreak(value.charCodeAt(markerEnd));
        if (startsLine && endsLine) {
            return markerIndex;
        }
        searchFrom = markerEnd;
    }
    return value.includes('\n') || value.includes('\r') ? -1 : value.indexOf(ORCA_DISPATCH_STATUS_TASK_MARKER);
}
function isLineBreak(code) {
    return code === 10 || code === 13;
}
function isEcmaTrimWhitespace(code) {
    return code === 0x20 || code >= 0x09 && code <= 0x0d || code === 0xa0 || code === 0x1680 || code >= 0x2000 && code <= 0x200a || code === 0x2028 || code === 0x2029 || code === 0x202f || code === 0x205f || code === 0x3000 || code === 0xfeff;
}
