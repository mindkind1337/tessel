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
const COMPLETE = {
    kind: 'complete'
};
const STALE = {
    kind: 'stale'
};
const views = new WeakMap();
export function selectStructuredRailOutline(outline, window) {
    const { epoch, oldestLoadedSequence, hasOlder } = window;
    if (!hasOlder || epoch === null || oldestLoadedSequence === null) {
        return COMPLETE;
    }
    if (!outline || outline.cursor.epoch !== epoch || outline.cursor.sequence < oldestLoadedSequence - 1) {
        return STALE;
    }
    const cached = views.get(outline);
    if (cached?.edge === oldestLoadedSequence) {
        return cached.view;
    }
    let count = 0;
    for (const entry of outline.entries){
        if (entry.sequence < oldestLoadedSequence) {
            count += 1;
        }
    }
    const view = cached?.count === count ? cached.view : {
        kind: 'fresh',
        entries: outline.entries.filter((entry)=>entry.sequence < oldestLoadedSequence).map((entry)=>({
                id: entry.itemId,
                text: entry.preview,
                hasImages: entry.imageCount > 0
            }))
    };
    views.set(outline, {
        edge: oldestLoadedSequence,
        count,
        view
    });
    return view;
}
