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
export const NATIVE_CHAT_BOTTOM_THRESHOLD_PX = 48;
export function distanceFromBottom(geometry) {
    return Math.max(0, geometry.scrollHeight - geometry.clientHeight - geometry.scrollTop);
}
export function isNearBottom(geometry, threshold = NATIVE_CHAT_BOTTOM_THRESHOLD_PX) {
    return distanceFromBottom(geometry) <= threshold;
}
export function shouldShowJumpToLatest(isStuckToBottom, geometry, threshold = NATIVE_CHAT_BOTTOM_THRESHOLD_PX) {
    if (isStuckToBottom) {
        return false;
    }
    return distanceFromBottom(geometry) > threshold;
}
export const NATIVE_CHAT_FOLLOW_REARM_PX = 4;
export function nextFollowingEnd(intent) {
    if (intent.programmatic) {
        return intent.following;
    }
    if (!intent.following && distanceFromBottom(intent.geometry) > intent.previousDistanceFromEnd) {
        return false;
    }
    return isNearBottom(intent.geometry, NATIVE_CHAT_FOLLOW_REARM_PX);
}
