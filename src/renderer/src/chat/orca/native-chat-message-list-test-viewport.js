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
const TEST_VIEWPORT_HEIGHT_PX = 1_000_000;
const TEST_ROW_HEIGHT_PX = 48;
export function installNativeChatMessageListTestViewport() {
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
        configurable: true,
        get () {
            if (this.hasAttribute('data-native-chat-scroll')) {
                return TEST_VIEWPORT_HEIGHT_PX;
            }
            if (this.dataset.index !== undefined) {
                return TEST_ROW_HEIGHT_PX;
            }
            return original?.get?.call(this) ?? 0;
        }
    });
    return ()=>{
        if (original) {
            Object.defineProperty(HTMLElement.prototype, 'offsetHeight', original);
        } else {
            Reflect.deleteProperty(HTMLElement.prototype, 'offsetHeight');
        }
    };
}
