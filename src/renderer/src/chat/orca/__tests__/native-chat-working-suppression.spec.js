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
import { shouldClearNativeChatWorkingSuppression, shouldShowNativeChatWorking } from "../native-chat-working-suppression.js";
describe('native chat working suppression', ()=>{
    it('hides stale working state after a user interrupt', ()=>{
        expect(shouldShowNativeChatWorking({
            isConversation: true,
            working: true,
            interrupted: true
        })).toBe(false);
    });
    it('shows working before an interrupt', ()=>{
        expect(shouldShowNativeChatWorking({
            isConversation: true,
            working: true,
            interrupted: false
        })).toBe(true);
    });
    it('clears suppression after reconciled working clears', ()=>{
        expect(shouldClearNativeChatWorkingSuppression({
            working: true
        })).toBe(false);
        expect(shouldClearNativeChatWorkingSuppression({
            working: false
        })).toBe(true);
    });
    it('clears suppression when a newer working epoch starts while interrupted', ()=>{
        expect(shouldClearNativeChatWorkingSuppression({
            working: true,
            interrupted: true,
            workingEpoch: 20,
            previousWorkingEpoch: 10
        })).toBe(true);
        expect(shouldClearNativeChatWorkingSuppression({
            working: true,
            interrupted: true,
            workingEpoch: 10,
            previousWorkingEpoch: 10
        })).toBe(false);
    });
});
