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
import { isWindowsAbsolutePathLike } from "./cross-platform-path.js";
import { fileUriToFilesystemPath } from "./file-uri-path.js";
const WEB_SCHEME_PATTERN = /^(?:https?|mailto):/i;
const SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const BARE_FILE_LOCATION_PATTERN = /^[^\s:/\\?#]+\.[\p{L}\p{N}_+-]+:\d+(?::\d+)?$/u;
export const NATIVE_CHAT_FILE_HREF_PREFIX = '#orca-native-chat-file=';
const MAX_NATIVE_CHAT_FILE_HREF_DECODES = 4;
export function createNativeChatFileHref(pathText) {
    return `${NATIVE_CHAT_FILE_HREF_PREFIX}${encodeURIComponent(pathText)}`;
}
function decodeNativeChatFileHref(href) {
    if (!href.startsWith(NATIVE_CHAT_FILE_HREF_PREFIX)) {
        return null;
    }
    try {
        const decoded = decodeURIComponent(href.slice(NATIVE_CHAT_FILE_HREF_PREFIX.length));
        return decoded && !decoded.startsWith(NATIVE_CHAT_FILE_HREF_PREFIX) ? decoded : null;
    } catch  {
        return null;
    }
}
function parseLineFragment(hash) {
    if (!hash) {
        return null;
    }
    let decoded = hash;
    try {
        decoded = decodeURIComponent(hash);
    } catch  {}
    const match = /^(?:L|line-?)([1-9]\d*)\b/i.exec(decoded);
    return match ? Number.parseInt(match[1], 10) : null;
}
function stripQueryAndHash(value) {
    const hashIndex = value.indexOf('#');
    const queryIndex = value.indexOf('?');
    const suffixIndex = hashIndex === -1 ? queryIndex : queryIndex === -1 ? hashIndex : Math.min(hashIndex, queryIndex);
    const pathText = suffixIndex === -1 ? value : value.slice(0, suffixIndex);
    const hash = hashIndex === -1 ? '' : value.slice(hashIndex + 1, queryIndex > hashIndex ? queryIndex : undefined);
    return {
        pathText,
        line: parseLineFragment(hash)
    };
}
function maybeDecodeHrefPath(value) {
    try {
        return decodeURIComponent(value);
    } catch  {
        return value;
    }
}
export function routeNativeChatHref(href) {
    let trimmed = href?.trim();
    if (!trimmed) {
        return {
            kind: 'none'
        };
    }
    let isLiteralFileLocation = false;
    for(let depth = 0; depth < MAX_NATIVE_CHAT_FILE_HREF_DECODES; depth += 1){
        const encodedFileHref = decodeNativeChatFileHref(trimmed);
        if (!encodedFileHref) {
            break;
        }
        trimmed = encodedFileHref.trim();
        isLiteralFileLocation = true;
    }
    if (!trimmed || trimmed.startsWith(NATIVE_CHAT_FILE_HREF_PREFIX)) {
        return {
            kind: 'none'
        };
    }
    if (isLiteralFileLocation) {
        return {
            kind: 'file',
            pathText: trimmed,
            line: null
        };
    }
    if (trimmed.startsWith('#')) {
        return {
            kind: 'none'
        };
    }
    if (WEB_SCHEME_PATTERN.test(trimmed)) {
        return {
            kind: 'web',
            url: trimmed
        };
    }
    if (/^file:/i.test(trimmed)) {
        let url;
        try {
            url = new URL(trimmed);
        } catch  {
            return {
                kind: 'none'
            };
        }
        const pathText = fileUriToFilesystemPath(url);
        if (!pathText) {
            return {
                kind: 'none'
            };
        }
        return {
            kind: 'file',
            pathText,
            line: parseLineFragment(url.hash.slice(1))
        };
    }
    if (!isWindowsAbsolutePathLike(trimmed) && !BARE_FILE_LOCATION_PATTERN.test(trimmed) && SCHEME_PATTERN.test(trimmed)) {
        return {
            kind: 'none'
        };
    }
    const { pathText, line } = stripQueryAndHash(trimmed);
    const decodedPathText = maybeDecodeHrefPath(pathText);
    return decodedPathText ? {
        kind: 'file',
        pathText: decodedPathText,
        line
    } : {
        kind: 'none'
    };
}
