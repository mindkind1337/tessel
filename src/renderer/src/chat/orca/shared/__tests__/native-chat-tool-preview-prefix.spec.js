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
import { unwrapLoginShellCommand } from "../native-chat-tool-preview-prefix.js";
describe('unwrapLoginShellCommand', ()=>{
    it('drops the login-shell wrapper the agent reaches a terminal through', ()=>{
        expect(unwrapLoginShellCommand(`/bin/zsh -lc 'git status --short'`)).toBe('git status --short');
        expect(unwrapLoginShellCommand(`/bin/bash -lc "pnpm test"`)).toBe('pnpm test');
        expect(unwrapLoginShellCommand(`sh -c 'ls'`)).toBe('ls');
        expect(unwrapLoginShellCommand(`C:\\Program Files\\Git\\bin\\bash.exe -lc "ls"`)).toBe('ls');
    });
    it('keeps a command that only happens to mention a shell', ()=>{
        expect(unwrapLoginShellCommand('git status')).toBe('git status');
        expect(unwrapLoginShellCommand('echo /bin/zsh -lc')).toBe('echo /bin/zsh -lc');
    });
    it('leaves the wrapper alone when the remainder is not one quoted string', ()=>{
        expect(unwrapLoginShellCommand(`/bin/zsh -lc 'ls' | head`)).toBe(`/bin/zsh -lc 'ls' | head`);
        expect(unwrapLoginShellCommand(`/bin/zsh -lc "unterminated`)).toBe(`/bin/zsh -lc "unterminated`);
        expect(unwrapLoginShellCommand(`/bin/zsh -lc ls`)).toBe(`/bin/zsh -lc ls`);
    });
    it('keeps quotes that belong to the command itself', ()=>{
        expect(unwrapLoginShellCommand(`/bin/zsh -lc "rg -n 'needle' src"`)).toBe(`rg -n 'needle' src`);
    });
    it('unwraps a multi-line command without collapsing it', ()=>{
        expect(unwrapLoginShellCommand(`/bin/zsh -lc 'set -e\ngit push'`)).toBe('set -e\ngit push');
    });
});
