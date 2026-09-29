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
import { decodeStructuredAgentSessionOptionValue, encodeStructuredAgentSessionOptionValue } from "../structured-agent-session-option-codec.js";
describe('structured agent session option codec', ()=>{
    it('encodes and decodes explicit Fast mode booleans', ()=>{
        expect(encodeStructuredAgentSessionOptionValue('fastMode', true)).toBe('true');
        expect(encodeStructuredAgentSessionOptionValue('fastMode', false)).toBe('false');
        expect(decodeStructuredAgentSessionOptionValue('fastMode', 'true')).toBe(true);
        expect(decodeStructuredAgentSessionOptionValue('fastMode', 'false')).toBe(false);
    });
    it('rejects string booleans on the UI side and non-canonical strings on the wire side', ()=>{
        expect(encodeStructuredAgentSessionOptionValue('fastMode', 'true')).toBeNull();
        expect(decodeStructuredAgentSessionOptionValue('fastMode', 'TRUE')).toBeNull();
        expect(decodeStructuredAgentSessionOptionValue('fastMode', '1')).toBeNull();
    });
    it('passes existing string options through unchanged', ()=>{
        expect(encodeStructuredAgentSessionOptionValue('model', 'gpt-example')).toBe('gpt-example');
        expect(decodeStructuredAgentSessionOptionValue('effort', 'high')).toBe('high');
    });
});
