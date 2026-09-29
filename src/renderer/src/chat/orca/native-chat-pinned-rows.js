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
export function nativeChatPinnedRowIndexes({ count, revealIndex }) {
    const pinned = new Set();
    if (count <= 0) {
        return pinned;
    }
    pinned.add(count - 1);
    if (revealIndex != null && revealIndex >= 0 && revealIndex < count) {
        pinned.add(revealIndex);
    }
    return pinned;
}
export function nativeChatTranscriptRange(range, pinned) {
    const first = Math.max(range.startIndex - range.overscan, 0);
    const last = Math.min(range.endIndex + range.overscan, range.count - 1);
    const indexes = new Set();
    for(let index = first; index <= last; index += 1){
        indexes.add(index);
    }
    for (const index of pinned){
        if (index >= 0 && index < range.count) {
            indexes.add(index);
        }
    }
    return Array.from(indexes).sort((left, right)=>left - right);
}
