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
import { hasFlag } from "../agent-cli-flag-detection.js";
const MODEL_FLAGS = [
    '-m',
    '--model'
];
describe('hasFlag', ()=>{
    it('matches an exact token', ()=>{
        expect(hasFlag([
            '-m',
            'grok-build'
        ], MODEL_FLAGS)).toBe(true);
        expect(hasFlag([
            '--model',
            'grok-build'
        ], MODEL_FLAGS)).toBe(true);
    });
    it('matches the flag=value form', ()=>{
        expect(hasFlag([
            '--model=grok-build'
        ], MODEL_FLAGS)).toBe(true);
        expect(hasFlag([
            '-m=grok-build'
        ], MODEL_FLAGS)).toBe(true);
    });
    it('matches a clustered single-dash flag', ()=>{
        expect(hasFlag([
            '-mgrok-build'
        ], MODEL_FLAGS)).toBe(true);
    });
    it('does not clusters-match a long flag that merely shares the prefix', ()=>{
        expect(hasFlag([
            '--model-context',
            '8000'
        ], MODEL_FLAGS)).toBe(false);
        expect(hasFlag([
            '--models'
        ], MODEL_FLAGS)).toBe(false);
    });
    it('ignores positional args that merely contain a flag substring', ()=>{
        expect(hasFlag([
            'summarize-my-diff'
        ], MODEL_FLAGS)).toBe(false);
        expect(hasFlag([
            'fix -m please'
        ], MODEL_FLAGS)).toBe(false);
        expect(hasFlag([
            '/tmp/-m'
        ], MODEL_FLAGS)).toBe(false);
    });
    it('is false for empty token lists and unrelated flags', ()=>{
        expect(hasFlag([], MODEL_FLAGS)).toBe(false);
        expect(hasFlag([
            '--reasoning-effort',
            'low'
        ], MODEL_FLAGS)).toBe(false);
    });
    it('scans every token, not just the first', ()=>{
        expect(hasFlag([
            '--debug',
            '--yolo',
            '--model',
            'grok-build'
        ], MODEL_FLAGS)).toBe(true);
    });
    it('stops scanning at the option terminator', ()=>{
        expect(hasFlag([
            '--',
            '--model'
        ], MODEL_FLAGS)).toBe(false);
        expect(hasFlag([
            '--',
            '-mgrok-build'
        ], MODEL_FLAGS)).toBe(false);
        expect(hasFlag([
            '--model',
            'grok-build',
            '--',
            '--model'
        ], MODEL_FLAGS)).toBe(true);
    });
    it('detects either spelling of grok effort flags', ()=>{
        const effortFlags = [
            '--effort',
            '--reasoning-effort'
        ];
        expect(hasFlag([
            '--effort',
            'low'
        ], effortFlags)).toBe(true);
        expect(hasFlag([
            '--reasoning-effort=low'
        ], effortFlags)).toBe(true);
        expect(hasFlag([
            '--effortless'
        ], effortFlags)).toBe(false);
    });
});
