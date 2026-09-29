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
export function readUtf8CodePointAt(text, index) {
    const leadUnit = text.charCodeAt(index);
    if (leadUnit < 0xd800 || leadUnit > 0xdbff || index + 1 >= text.length) {
        return leadUnit;
    }
    const trailUnit = text.charCodeAt(index + 1);
    if (trailUnit < 0xdc00 || trailUnit > 0xdfff) {
        return leadUnit;
    }
    return (leadUnit - 0xd800) * 0x400 + (trailUnit - 0xdc00) + 0x10000;
}
export function measureUtf8ByteLength(text, options = {}) {
    const stopAfterBytes = options.stopAfterBytes;
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
    }
    return {
        byteLength,
        exceededLimit: false
    };
}
export function getUtf8ByteLength(text) {
    return measureUtf8ByteLength(text).byteLength;
}
const MAX_UTF8_SCRATCH_BYTES = 1024 * 1024;
const utf8Encoder = new TextEncoder();
let utf8Scratch = new Uint8Array(0);
export function isUtf8ByteLengthWithinLimit(text, maxBytes) {
    if (text.length === 0) {
        return true;
    }
    if (text.length > maxBytes) {
        return false;
    }
    if (text.length * 3 <= maxBytes) {
        return true;
    }
    if (Number.isSafeInteger(maxBytes) && maxBytes <= MAX_UTF8_SCRATCH_BYTES) {
        if (utf8Scratch.length < maxBytes) {
            utf8Scratch = new Uint8Array(maxBytes);
        }
        return utf8Encoder.encodeInto(text, utf8Scratch.subarray(0, maxBytes)).read === text.length;
    }
    return !measureUtf8ByteLength(text, {
        stopAfterBytes: maxBytes
    }).exceededLimit;
}
export function clampUtf8TextTail(text, maxBytes) {
    if (!text || maxBytes <= 0) {
        return {
            text: '',
            bytes: 0
        };
    }
    let start = text.length;
    let bytes = 0;
    while(start > 0){
        const previous = getPreviousUtf8CodePoint(text, start);
        if (previous.bytes > maxBytes || bytes + previous.bytes > maxBytes) {
            break;
        }
        bytes += previous.bytes;
        start = previous.start;
        if (bytes >= maxBytes) {
            break;
        }
    }
    return {
        text: text.slice(start),
        bytes
    };
}
export function clampUtf8TextPrefix(text, maxBytes) {
    if (!text || maxBytes <= 0) {
        return '';
    }
    let bytes = 0;
    let end = 0;
    while(end < text.length){
        const codePoint = readUtf8CodePointAt(text, end);
        const codePointBytes = getUtf8ByteLengthForCodePoint(codePoint);
        if (bytes + codePointBytes > maxBytes) {
            break;
        }
        bytes += codePointBytes;
        end += codePoint > 0xffff ? 2 : 1;
    }
    return end === text.length ? text : text.slice(0, end);
}
export function getUtf8ChunkEndIndex(text, startIndex, maxBytes) {
    let bytes = 0;
    let endIndex = startIndex;
    while(endIndex < text.length){
        const codePoint = readUtf8CodePointAt(text, endIndex);
        const codePointBytes = getUtf8ByteLengthForCodePoint(codePoint);
        if (bytes > 0 && bytes + codePointBytes > maxBytes) {
            break;
        }
        bytes += codePointBytes;
        endIndex += codePoint > 0xffff ? 2 : 1;
    }
    return endIndex;
}
export function getUtf8ByteLengthForCodePoint(codePoint) {
    if (codePoint <= 0x7f) {
        return 1;
    }
    if (codePoint <= 0x7ff) {
        return 2;
    }
    if (codePoint <= 0xffff) {
        return 3;
    }
    return 4;
}
function getPreviousUtf8CodePoint(text, endIndex) {
    let start = endIndex - 1;
    const codeUnit = text.charCodeAt(start);
    const isLowSurrogate = codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
    if (isLowSurrogate && start > 0) {
        const previous = text.charCodeAt(start - 1);
        if (previous >= 0xd800 && previous <= 0xdbff) {
            start -= 1;
        }
    }
    return {
        start,
        bytes: getUtf8ByteLengthForCodePoint(readUtf8CodePointAt(text, start))
    };
}
