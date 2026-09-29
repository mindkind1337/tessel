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
import { describe, expect, it } from 'vitest';
import { shouldFocusNativeChatComposerFromEditingKey, shouldFocusNativeChatPaneFromPointerTarget, shouldRedirectNativeChatTyping } from "../native-chat-typing-redirect.js";
function keyEvent(overrides) {
    return {
        key: 'a',
        ctrlKey: false,
        metaKey: false,
        defaultPrevented: false,
        target: inertTarget(),
        ...overrides
    };
}
function inertTarget() {
    return {
        closest: ()=>null
    };
}
function interactiveTarget() {
    return {
        closest: ()=>({})
    };
}
describe('shouldRedirectNativeChatTyping', ()=>{
    it('redirects printable typing from the native chat pane', ()=>{
        expect(shouldRedirectNativeChatTyping(keyEvent({
            key: 'x'
        }))).toBe(true);
    });
    it('does not redirect shortcuts or non-printable keys', ()=>{
        expect(shouldRedirectNativeChatTyping(keyEvent({
            key: 'Enter'
        }))).toBe(false);
        expect(shouldRedirectNativeChatTyping(keyEvent({
            key: 'a',
            metaKey: true
        }))).toBe(false);
        expect(shouldRedirectNativeChatTyping(keyEvent({
            key: 'a',
            ctrlKey: true
        }))).toBe(false);
    });
    it('does not redirect IME composition or already-handled events', ()=>{
        expect(shouldRedirectNativeChatTyping(keyEvent({
            isComposing: true
        }))).toBe(false);
        expect(shouldRedirectNativeChatTyping(keyEvent({
            defaultPrevented: true
        }))).toBe(false);
    });
    it('leaves interactive targets alone', ()=>{
        expect(shouldRedirectNativeChatTyping(keyEvent({
            target: interactiveTarget()
        }))).toBe(false);
    });
});
describe('shouldFocusNativeChatComposerFromEditingKey', ()=>{
    it('focuses the composer on Backspace/Delete from the pane', ()=>{
        expect(shouldFocusNativeChatComposerFromEditingKey(keyEvent({
            key: 'Backspace'
        }))).toBe(true);
        expect(shouldFocusNativeChatComposerFromEditingKey(keyEvent({
            key: 'Delete'
        }))).toBe(true);
    });
    it('ignores other keys, shortcut/editing modifiers, IME composition, and handled events', ()=>{
        expect(shouldFocusNativeChatComposerFromEditingKey(keyEvent({
            key: 'a'
        }))).toBe(false);
        expect(shouldFocusNativeChatComposerFromEditingKey(keyEvent({
            key: 'Backspace',
            defaultPrevented: true
        }))).toBe(false);
        expect(shouldFocusNativeChatComposerFromEditingKey(keyEvent({
            key: 'Backspace',
            metaKey: true
        }))).toBe(false);
        expect(shouldFocusNativeChatComposerFromEditingKey(keyEvent({
            key: 'Backspace',
            ctrlKey: true
        }))).toBe(false);
        expect(shouldFocusNativeChatComposerFromEditingKey(keyEvent({
            key: 'Delete',
            shiftKey: true
        }))).toBe(false);
        expect(shouldFocusNativeChatComposerFromEditingKey(keyEvent({
            key: 'Backspace',
            altKey: true
        }))).toBe(false);
        expect(shouldFocusNativeChatComposerFromEditingKey(keyEvent({
            key: 'Backspace',
            isComposing: true
        }))).toBe(false);
    });
    it('leaves interactive targets (the textarea itself) alone', ()=>{
        expect(shouldFocusNativeChatComposerFromEditingKey(keyEvent({
            key: 'Backspace',
            target: interactiveTarget()
        }))).toBe(false);
    });
});
describe('shouldFocusNativeChatPaneFromPointerTarget', ()=>{
    it('focuses the pane for non-interactive clicks', ()=>{
        expect(shouldFocusNativeChatPaneFromPointerTarget(inertTarget())).toBe(true);
    });
    it('does not steal focus from controls', ()=>{
        expect(shouldFocusNativeChatPaneFromPointerTarget(interactiveTarget())).toBe(false);
    });
});
