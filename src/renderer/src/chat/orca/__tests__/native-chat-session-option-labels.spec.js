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
import { describe, expect, it, vi } from 'vitest';
import { t } from "../../../i18n/index.js";
import { nativeChatModelPillLabel, nativeChatSessionChoiceLabel } from "../native-chat-session-option-labels.js";
vi.mock('../../../i18n/index.js', ()=>({
        t: vi.fn((_key, fallback)=>fallback)
    }));
function modelDescriptor(valueSource, currentValue) {
    return {
        id: 'model',
        label: 'Model',
        valueSource,
        transport: 'catalog',
        settable: true,
        kind: {
            type: 'select',
            ...currentValue ? {
                currentValue
            } : {},
            choices: [
                {
                    value: 'grok-4.5',
                    label: 'Grok 4.5'
                }
            ]
        }
    };
}
describe('nativeChatModelPillLabel', ()=>{
    it('names a model the CLI defaulted to, not the bare category', ()=>{
        expect(nativeChatModelPillLabel(modelDescriptor('default', 'grok-4.5'))).toBe('Grok 4.5');
    });
    it('names a model the user picked', ()=>{
        expect(nativeChatModelPillLabel(modelDescriptor('applied', 'grok-4.5'))).toBe('Grok 4.5');
    });
    it('withholds a value it has no evidence for', ()=>{
        expect(nativeChatModelPillLabel(modelDescriptor('unknown', 'grok-4.5'))).toBe('Model');
        expect(nativeChatModelPillLabel(modelDescriptor('default'))).toBe('Model');
    });
    it('falls back to the raw id when the list no longer offers it', ()=>{
        expect(nativeChatModelPillLabel(modelDescriptor('reported', 'grok-build'))).toBe('grok-build');
    });
});
describe('nativeChatSessionChoiceLabel', ()=>{
    it('routes ultra through the localized effort label', ()=>{
        nativeChatSessionChoiceLabel({
            value: 'ultra',
            label: 'Ultra'
        });
        expect(t).toHaveBeenCalledWith('chat.orca.composer.optionValue.ultra', 'Ultra');
    });
});
