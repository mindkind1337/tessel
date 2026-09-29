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
import { nativeChatUserMessagePreview } from "./shared/agent-session-conversation-outline.js";
export const NATIVE_CHAT_RAIL_MAX_TICKS = 20;
export const NATIVE_CHAT_RAIL_MIN_ITEMS = 3;
export function buildNativeChatRailItems(slots, previous = []) {
    const items = [];
    for (const [slotIndex, slot] of slots.entries()){
        if (slot.message.role !== 'user') {
            continue;
        }
        const preview = nativeChatUserMessagePreview(slot.message.blocks);
        const hasImages = preview.imageCount > 0;
        const prior = previous[items.length];
        items.push(prior?.id === slot.message.id && prior.slotIndex === slotIndex && prior.text === preview.text && prior.hasImages === hasImages ? prior : {
            id: slot.message.id,
            slotIndex,
            text: preview.text,
            hasImages
        });
    }
    return items.length === previous.length && items.every((item, index)=>item === previous[index]) ? previous : items;
}
export function mergeNativeChatRailOutline(outline, loaded) {
    if (!outline || outline.length === 0) {
        return loaded;
    }
    const loadedIds = new Set(loaded.map((item)=>item.id));
    const unloaded = [];
    for (const entry of outline){
        if (!loadedIds.has(entry.id)) {
            unloaded.push({
                ...entry,
                slotIndex: null
            });
        }
    }
    return unloaded.length === 0 ? loaded : [
        ...unloaded,
        ...loaded
    ];
}
export function selectNativeChatRailTicks({ items, activeId }) {
    if (items.length <= NATIVE_CHAT_RAIL_MAX_TICKS) {
        return items;
    }
    const maxIndex = items.length - 1;
    const sampled = new Set();
    for(let slot = 0; slot < NATIVE_CHAT_RAIL_MAX_TICKS; slot += 1){
        sampled.add(Math.round(slot * maxIndex / (NATIVE_CHAT_RAIL_MAX_TICKS - 1)));
    }
    const activeIndex = activeId === null ? -1 : items.findIndex((item)=>item.id === activeId);
    if (activeIndex >= 0 && !sampled.has(activeIndex)) {
        sampled.add(activeIndex);
        let evict = null;
        let evictDistance = Number.POSITIVE_INFINITY;
        for (const index of sampled){
            if (index === activeIndex || index === 0 || index === maxIndex) {
                continue;
            }
            const distance = Math.abs(index - activeIndex);
            if (distance < evictDistance) {
                evict = index;
                evictDistance = distance;
            }
        }
        if (evict !== null) {
            sampled.delete(evict);
        }
    }
    const ordered = [];
    for (const index of Array.from(sampled).sort((left, right)=>left - right)){
        const item = items[index];
        if (item) {
            ordered.push(item);
        }
    }
    return ordered;
}
