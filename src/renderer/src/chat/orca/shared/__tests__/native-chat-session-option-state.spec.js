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
import { CLAUDE_SESSION_OPTION_CATALOG, CODEX_SESSION_OPTION_CATALOG } from "../agent-session-option-catalog-claude-codex.js";
import { applyNativeChatReportedSessionOptions, createNativeChatSessionOptionRecord, matchNativeChatCatalogModelId } from "../native-chat-session-option-state.js";
function claudeRecord() {
    return createNativeChatSessionOptionRecord('claude');
}
describe('applyNativeChatReportedSessionOptions', ()=>{
    it('reports become authority and reset stale per-model values on a model change', ()=>{
        const record = claudeRecord();
        record.model = {
            value: 'sonnet',
            source: 'dispatched'
        };
        record.valuesByModel.opus = {
            effort: {
                value: 'high',
                source: 'dispatched'
            }
        };
        expect(applyNativeChatReportedSessionOptions(record, {
            model: 'opus'
        })).toBe(true);
        expect(record.model).toEqual({
            value: 'opus',
            source: 'reported'
        });
        expect(record.valuesByModel.opus).toEqual({});
    });
    it('promotes a dispatched guess the report confirms', ()=>{
        const record = claudeRecord();
        record.model = {
            value: 'sonnet',
            source: 'dispatched'
        };
        expect(applyNativeChatReportedSessionOptions(record, {
            model: 'sonnet'
        })).toBe(true);
        expect(record.model).toEqual({
            value: 'sonnet',
            source: 'reported'
        });
    });
    it('keeps locally tracked options when the reported model is unchanged', ()=>{
        const record = claudeRecord();
        record.model = {
            value: 'sonnet',
            source: 'reported'
        };
        record.valuesByModel.sonnet = {
            effort: {
                value: 'high',
                source: 'dispatched'
            }
        };
        expect(applyNativeChatReportedSessionOptions(record, {
            model: 'sonnet'
        })).toBe(false);
        expect(record.valuesByModel.sonnet?.effort).toEqual({
            value: 'high',
            source: 'dispatched'
        });
    });
    it('is a no-op when the report matches tracked state', ()=>{
        const record = claudeRecord();
        record.model = {
            value: 'sonnet',
            source: 'reported'
        };
        expect(applyNativeChatReportedSessionOptions(record, {
            model: 'sonnet'
        })).toBe(false);
    });
});
describe('matchNativeChatCatalogModelId', ()=>{
    it('prefers the longest contained id and keeps catalog order for ties', ()=>{
        const catalog = {
            ...CLAUDE_SESSION_OPTION_CATALOG,
            models: [
                'a',
                'abc',
                'xyz'
            ].map((id)=>({
                    id,
                    label: id,
                    options: []
                }))
        };
        expect(matchNativeChatCatalogModelId(catalog, 'provider-xyz-abc')).toBe('abc');
        expect(catalog.models.map((model)=>model.id)).toEqual([
            'a',
            'abc',
            'xyz'
        ]);
    });
    it('keeps the reported selector as-is for a catalog that seeds no models', ()=>{
        const unseeded = {
            ...CLAUDE_SESSION_OPTION_CATALOG,
            models: []
        };
        expect(matchNativeChatCatalogModelId(unseeded, ' deepseek/deepseek-v4-pro ')).toBe('deepseek/deepseek-v4-pro');
        expect(matchNativeChatCatalogModelId(unseeded, '   ')).toBeNull();
    });
    it('matches exact ids, labels, and provider-id containment', ()=>{
        expect(matchNativeChatCatalogModelId(CLAUDE_SESSION_OPTION_CATALOG, 'sonnet')).toBe('sonnet');
        expect(matchNativeChatCatalogModelId(CLAUDE_SESSION_OPTION_CATALOG, 'Sonnet 5')).toBe('sonnet');
        expect(matchNativeChatCatalogModelId(CLAUDE_SESSION_OPTION_CATALOG, 'claude-sonnet-5')).toBe('sonnet');
        expect(matchNativeChatCatalogModelId(CODEX_SESSION_OPTION_CATALOG, 'gpt-5.5')).toBe('gpt-5.5');
    });
    it('returns null for unrecognized reports', ()=>{
        expect(matchNativeChatCatalogModelId(CLAUDE_SESSION_OPTION_CATALOG, 'mystery-model')).toBeNull();
        expect(matchNativeChatCatalogModelId(CLAUDE_SESSION_OPTION_CATALOG, '')).toBeNull();
    });
});
