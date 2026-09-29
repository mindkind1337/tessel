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
const INTERACTIVE_TARGET_SELECTOR = [
    'a[href]',
    'button',
    'input',
    'select',
    'textarea',
    '[contenteditable]:not([contenteditable="false"])',
    '[role="button"]',
    '[role="checkbox"]',
    '[role="combobox"]',
    '[role="menuitem"]',
    '[role="option"]',
    '[role="radio"]',
    '[role="slider"]',
    '[role="switch"]',
    '[role="textbox"]',
    '[data-native-chat-typing-redirect-ignore="true"]'
].join(',');
export function shouldRedirectNativeChatTyping(event) {
    if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.key.length !== 1) {
        return false;
    }
    return !isNativeChatInteractiveTarget(event.target);
}
export function shouldFocusNativeChatPaneFromPointerTarget(target) {
    return !isNativeChatInteractiveTarget(target);
}
export function shouldFocusNativeChatComposerFromEditingKey(event) {
    if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.key !== 'Backspace' && event.key !== 'Delete') {
        return false;
    }
    return !isNativeChatInteractiveTarget(event.target);
}
function isNativeChatInteractiveTarget(target) {
    const element = eventTargetElement(target);
    if (!element) {
        return false;
    }
    return element.closest(INTERACTIVE_TARGET_SELECTOR) !== null;
}
function eventTargetElement(target) {
    if (!target || typeof target !== 'object') {
        return null;
    }
    const candidate = target;
    if (typeof candidate.closest === 'function') {
        return candidate;
    }
    return candidate.parentElement ?? null;
}
