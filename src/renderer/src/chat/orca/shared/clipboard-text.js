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
import { yieldToEventLoop } from "./event-loop-yield.js";
import { getUtf8ByteLengthForCodePoint, measureUtf8ByteLength, readUtf8CodePointAt } from "./utf8-byte-limits.js";
export const CLIPBOARD_TEXT_READ_MAX_BYTES = 16 * 1024 * 1024;
export const CLIPBOARD_TEXT_WRITE_MAX_BYTES = 16 * 1024 * 1024;
export const CLIPBOARD_TEXT_TOO_LARGE_ERROR = "Clipboard text is too large for this paste target." /* i18n-ignore */; // i18n-ignore
export const CLIPBOARD_TEXT_WRITE_TOO_LARGE_ERROR = "Clipboard text is too large to copy safely." /* i18n-ignore */; // i18n-ignore
export const CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS = 256 * 1024;
export function measureClipboardTextByteLength(text, options = {}) {
    return measureUtf8ByteLength(text, options);
}
export function getClipboardTextByteLength(text) {
    return measureClipboardTextByteLength(text).byteLength;
}
export async function measureClipboardTextByteLengthWithYield(text, options = {}) {
    const stopAfterBytes = options.stopAfterBytes;
    const yieldAfterCodeUnits = Math.max(1, options.yieldAfterCodeUnits ?? CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS);
    const yieldBetweenBatches = options.yieldToEventLoop ?? yieldToEventLoop;
    let nextYieldAt = yieldAfterCodeUnits;
    let byteLength = 0;
    for(let index = 0; index < text.length; index += 1){
        const codePoint = readUtf8CodePointAt(text, index);
        byteLength += getUtf8ByteLengthForCodePoint(codePoint);
        if (Number.isFinite(stopAfterBytes) && byteLength > (stopAfterBytes ?? 0)) {
            return {
                byteLength,
                exceededLimit: true
            };
        }
        if (codePoint > 0xffff) {
            index += 1;
        }
        if (index >= nextYieldAt) {
            await yieldBetweenBatches();
            nextYieldAt = index + yieldAfterCodeUnits;
        }
    }
    return {
        byteLength,
        exceededLimit: false
    };
}
export function isClipboardTextByteLengthOverLimit(text, maxBytes) {
    return text.length > maxBytes || measureClipboardTextByteLength(text, {
        stopAfterBytes: maxBytes
    }).exceededLimit;
}
export async function isClipboardTextByteLengthOverLimitWithYield(text, maxBytes, options = {}) {
    if (text.length > maxBytes) {
        return true;
    }
    return (await measureClipboardTextByteLengthWithYield(text, {
        stopAfterBytes: maxBytes,
        yieldAfterCodeUnits: options.yieldAfterCodeUnits,
        yieldToEventLoop: options.yieldToEventLoop
    })).exceededLimit;
}
export function getClipboardTextReadMaxBytes(options, fallback = CLIPBOARD_TEXT_READ_MAX_BYTES) {
    return Number.isFinite(options?.maxBytes) && (options?.maxBytes ?? 0) > 0 ? Math.floor(options?.maxBytes ?? fallback) : fallback;
}
export function getClipboardTextWriteMaxBytes(options, fallback = CLIPBOARD_TEXT_WRITE_MAX_BYTES) {
    return Number.isFinite(options?.maxBytes) && (options?.maxBytes ?? 0) > 0 ? Math.floor(options?.maxBytes ?? fallback) : fallback;
}
export function assertClipboardTextWithinLimit(text, options) {
    const maxBytes = getClipboardTextReadMaxBytes(options);
    if (isClipboardTextByteLengthOverLimit(text, maxBytes)) {
        throw new Error(CLIPBOARD_TEXT_TOO_LARGE_ERROR);
    }
    return text;
}
export async function assertClipboardTextWithinLimitWithYield(text, options) {
    const maxBytes = getClipboardTextReadMaxBytes(options);
    if (await isClipboardTextByteLengthOverLimitWithYield(text, maxBytes)) {
        throw new Error(CLIPBOARD_TEXT_TOO_LARGE_ERROR);
    }
    return text;
}
export function assertClipboardTextWriteWithinLimit(text, options) {
    const maxBytes = getClipboardTextWriteMaxBytes(options);
    if (isClipboardTextByteLengthOverLimit(text, maxBytes)) {
        throw new Error(CLIPBOARD_TEXT_WRITE_TOO_LARGE_ERROR);
    }
    return text;
}
export async function assertClipboardTextWriteWithinLimitWithYield(text, options) {
    const maxBytes = getClipboardTextWriteMaxBytes(options);
    if (await isClipboardTextByteLengthOverLimitWithYield(text, maxBytes)) {
        throw new Error(CLIPBOARD_TEXT_WRITE_TOO_LARGE_ERROR);
    }
    return text;
}
export function isClipboardTextTooLargeError(error) {
    return error instanceof Error && error.message.includes(CLIPBOARD_TEXT_TOO_LARGE_ERROR);
}
export function isClipboardTextWriteTooLargeError(error) {
    return error instanceof Error && error.message.includes(CLIPBOARD_TEXT_WRITE_TOO_LARGE_ERROR);
}
