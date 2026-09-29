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
import { compactDispatchPromptForStatus } from "./orca-dispatch-status-prompt.js";
export const AGENT_STATUS_MAX_FIELD_LENGTH = 200;
const SINGLE_LINE_FIELD_SCAN_OVERHEAD = 64;
const SINGLE_LINE_FIELD_SCAN_MULTIPLIER = 8;
function truncatePreservingSurrogates(value, maxLength) {
    if (value.length < maxLength) {
        return value;
    }
    let truncated = value.length === maxLength ? value : value.slice(0, maxLength);
    const lastCode = truncated.charCodeAt(truncated.length - 1);
    if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
        truncated = truncated.slice(0, -1);
    }
    return truncated;
}
function normalizeField(value, maxLength = AGENT_STATUS_MAX_FIELD_LENGTH) {
    if (typeof value !== 'string') {
        return '';
    }
    return normalizeSingleLinePreview(value, maxLength);
}
export function normalizePromptField(value) {
    if (typeof value !== 'string') {
        return '';
    }
    return compactDispatchPromptForStatus(value, AGENT_STATUS_MAX_FIELD_LENGTH, normalizeSingleLinePreview) ?? normalizeSingleLinePreview(value, AGENT_STATUS_MAX_FIELD_LENGTH);
}
function normalizeSingleLinePreview(value, maxLength) {
    const scanEnd = Math.min(value.length, maxLength * SINGLE_LINE_FIELD_SCAN_MULTIPLIER + SINGLE_LINE_FIELD_SCAN_OVERHEAD);
    let index = 0;
    while(index < scanEnd && isEcmaTrimWhitespace(value.charCodeAt(index))){
        index++;
    }
    let normalized = '';
    let lineSeparatorRun = false;
    while(index < scanEnd && normalized.length < maxLength){
        const code = value.charCodeAt(index);
        if (isSingleLineSeparator(code)) {
            if (code === 13 && value.charCodeAt(index + 1) === 10) {
                index++;
            }
            if (!lineSeparatorRun) {
                normalized += ' ';
            }
            lineSeparatorRun = true;
            index++;
            continue;
        }
        normalized += value[index];
        lineSeparatorRun = false;
        index++;
    }
    if (normalized.length < maxLength) {
        normalized = trimTrailingWhitespace(normalized);
    }
    return truncatePreservingSurrogates(normalized, maxLength);
}
function normalizeMultilineField(value, maxLength) {
    if (typeof value !== 'string') {
        return '';
    }
    const { start, end } = getTrimmedStringBounds(value);
    let normalized = '';
    let newlineRun = 0;
    for(let index = start; index < end && normalized.length < maxLength; index++){
        const code = value.charCodeAt(index);
        if (code === 13 || code === 10 || code === 0x2028 || code === 0x2029) {
            if (code === 13 && value.charCodeAt(index + 1) === 10) {
                index++;
            }
            if (newlineRun < 2) {
                normalized += '\n';
            }
            newlineRun++;
            continue;
        }
        normalized += value[index];
        newlineRun = 0;
    }
    return truncatePreservingSurrogates(normalized, maxLength);
}
function getTrimmedStringBounds(value) {
    let start = 0;
    let end = value.length;
    while(start < end && isEcmaTrimWhitespace(value.charCodeAt(start))){
        start++;
    }
    while(end > start && isEcmaTrimWhitespace(value.charCodeAt(end - 1))){
        end--;
    }
    return {
        start,
        end
    };
}
function trimTrailingWhitespace(value) {
    let end = value.length;
    while(end > 0 && isEcmaTrimWhitespace(value.charCodeAt(end - 1))){
        end--;
    }
    return end === value.length ? value : value.slice(0, end);
}
function isSingleLineSeparator(code) {
    return code === 13 || code === 10 || code === 0x2028 || code === 0x2029;
}
function isEcmaTrimWhitespace(code) {
    return code === 0x20 || code >= 0x09 && code <= 0x0d || code === 0xa0 || code === 0x1680 || code >= 0x2000 && code <= 0x200a || code === 0x2028 || code === 0x2029 || code === 0x202f || code === 0x205f || code === 0x3000 || code === 0xfeff;
}
export function normalizeInteractivePromptField(value, maxLength) {
    if (typeof value !== 'string' || value.length === 0) {
        return undefined;
    }
    const truncated = truncatePreservingSurrogates(value, maxLength);
    return truncated.length > 0 ? truncated : undefined;
}
export function normalizeOptionalField(value, maxLength) {
    if (typeof value !== 'string') {
        return undefined;
    }
    const normalized = normalizeField(value, maxLength);
    return normalized.length > 0 ? normalized : undefined;
}
export function normalizeOptionalMultilineField(value, maxLength) {
    if (typeof value !== 'string') {
        return undefined;
    }
    const normalized = normalizeMultilineField(value, maxLength);
    return normalized.length > 0 ? normalized : undefined;
}
export function normalizeTurnCompletedAtField(value, state) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return undefined;
    }
    return state === 'working' || state === 'done' ? value : undefined;
}
