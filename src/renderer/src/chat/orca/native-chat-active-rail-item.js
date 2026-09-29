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
import { NATIVE_CHAT_BOTTOM_THRESHOLD_PX } from "./native-chat-autoscroll.js";
export function findActiveNativeChatRailItem({ slots, virtualItems, scrollTop, clientHeight, scrollHeight, previousActiveId }) {
    if (virtualItems.length === 0) {
        return previousActiveId;
    }
    const atBottom = scrollHeight - clientHeight - scrollTop <= NATIVE_CHAT_BOTTOM_THRESHOLD_PX;
    if (atBottom) {
        const last = virtualItems.at(-1);
        return last === undefined ? previousActiveId : slots[last.index]?.turnKey ?? null;
    }
    let fold;
    for (const item of virtualItems){
        if (item.start <= scrollTop && (fold === undefined || item.start > fold.start)) {
            fold = item;
        }
    }
    if (fold === undefined) {
        return slots[virtualItems[0]?.index ?? -1]?.turnKey ?? null;
    }
    if (fold.end <= scrollTop) {
        return previousActiveId;
    }
    return slots[fold.index]?.turnKey ?? null;
}
