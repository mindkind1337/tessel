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
import { describe, it, expect } from 'vitest';
import { distanceFromBottom, isNearBottom, nextFollowingEnd, shouldShowJumpToLatest, NATIVE_CHAT_BOTTOM_THRESHOLD_PX, NATIVE_CHAT_FOLLOW_REARM_PX } from "../native-chat-autoscroll.js";
const atBottom = {
    scrollTop: 952,
    scrollHeight: 1000,
    clientHeight: 48
};
const scrolledUp = {
    scrollTop: 0,
    scrollHeight: 1000,
    clientHeight: 48
};
const noOverflow = {
    scrollTop: 0,
    scrollHeight: 48,
    clientHeight: 48
};
function parkedAbove(distance) {
    return {
        scrollTop: 952 - distance,
        scrollHeight: 1000,
        clientHeight: 48
    };
}
describe('distanceFromBottom', ()=>{
    it('is zero at the exact bottom and never negative', ()=>{
        expect(distanceFromBottom(atBottom)).toBe(0);
        expect(distanceFromBottom({
            scrollTop: 5000,
            scrollHeight: 1000,
            clientHeight: 48
        })).toBe(0);
    });
});
describe('isNearBottom', ()=>{
    it('sticks within the threshold and detaches beyond it', ()=>{
        expect(isNearBottom(atBottom)).toBe(true);
        expect(isNearBottom({
            scrollTop: 952 - NATIVE_CHAT_BOTTOM_THRESHOLD_PX,
            scrollHeight: 1000,
            clientHeight: 48
        })).toBe(true);
        expect(isNearBottom(scrolledUp)).toBe(false);
    });
});
describe('shouldShowJumpToLatest', ()=>{
    it('shows only when detached with content below', ()=>{
        expect(shouldShowJumpToLatest(false, scrolledUp)).toBe(true);
    });
    it('hides while stuck to bottom', ()=>{
        expect(shouldShowJumpToLatest(true, scrolledUp)).toBe(false);
    });
    it('hides when there is nothing to scroll', ()=>{
        expect(shouldShowJumpToLatest(false, noOverflow)).toBe(false);
    });
});
describe('nextFollowingEnd', ()=>{
    const wellAway = parkedAbove(400);
    const following = {
        following: true,
        programmatic: false,
        geometry: parkedAbove(0),
        previousDistanceFromEnd: 400
    };
    it('follows when the reader reaches the end', ()=>{
        expect(nextFollowingEnd(following)).toBe(true);
    });
    it('keeps following when a delayed application scroll arrives after growth', ()=>{
        expect(nextFollowingEnd({
            ...following,
            programmatic: true,
            geometry: wellAway
        })).toBe(true);
    });
    it('treats an unmarked offset away from the end as the reader leaving', ()=>{
        expect(nextFollowingEnd({
            ...following,
            geometry: wellAway
        })).toBe(false);
    });
    it.each([
        0,
        NATIVE_CHAT_FOLLOW_REARM_PX,
        400
    ])('does not reattach a detached reader from an application write %i px from the end', (distance)=>{
        expect(nextFollowingEnd({
            following: false,
            programmatic: true,
            geometry: parkedAbove(distance),
            previousDistanceFromEnd: 400
        })).toBe(false);
    });
    it('lets the reader park just inside the near-bottom band', ()=>{
        expect(NATIVE_CHAT_FOLLOW_REARM_PX).toBeLessThan(NATIVE_CHAT_BOTTOM_THRESHOLD_PX);
        const parked = parkedAbove(NATIVE_CHAT_BOTTOM_THRESHOLD_PX - 1);
        expect(nextFollowingEnd({
            ...following,
            geometry: parked
        })).toBe(false);
        expect(isNearBottom(parked)).toBe(true);
        expect(shouldShowJumpToLatest(false, parked)).toBe(false);
    });
    it('re-arms at the band and not one pixel past it', ()=>{
        const detached = {
            following: false,
            programmatic: false,
            previousDistanceFromEnd: 400
        };
        expect(nextFollowingEnd({
            ...detached,
            geometry: parkedAbove(NATIVE_CHAT_FOLLOW_REARM_PX)
        })).toBe(true);
        expect(nextFollowingEnd({
            ...detached,
            geometry: parkedAbove(NATIVE_CHAT_FOLLOW_REARM_PX + 1)
        })).toBe(false);
    });
    it('does not reattach a detached reader who is moving away from the end', ()=>{
        const leaving = {
            following: false,
            programmatic: false,
            previousDistanceFromEnd: 0
        };
        expect(nextFollowingEnd({
            ...leaving,
            geometry: parkedAbove(0.3)
        })).toBe(false);
        expect(nextFollowingEnd({
            ...leaving,
            geometry: parkedAbove(2)
        })).toBe(false);
        expect(nextFollowingEnd({
            ...leaving,
            previousDistanceFromEnd: 52,
            geometry: parkedAbove(2)
        })).toBe(true);
        expect(nextFollowingEnd({
            ...leaving,
            geometry: parkedAbove(0)
        })).toBe(true);
    });
    it('keeps a following reader through a small move up inside the band', ()=>{
        expect(nextFollowingEnd({
            ...following,
            previousDistanceFromEnd: 0,
            geometry: parkedAbove(2)
        })).toBe(true);
    });
    it('holds follow through rounding noise at the end', ()=>{
        expect(nextFollowingEnd({
            ...following,
            geometry: parkedAbove(1.5)
        })).toBe(true);
    });
});
