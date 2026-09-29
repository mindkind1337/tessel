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
import { createClaudeModelSwitchConfirmationObserver, hasClaudeModelSwitchConfirmation } from "../claude-model-switch-confirmation.js";
describe('Claude model switch confirmation detection', ()=>{
    it('recognizes the rendered cache warning across ANSI and wrapped whitespace', ()=>{
        expect(hasClaudeModelSwitchConfirmation('\u001b[1mSwitch model?\u001b[0m\r\nThis\u001b[9Gconversation\u001b[22Gis\u001b[25Gcached\r\nfor the current model.')).toBe(true);
        expect(hasClaudeModelSwitchConfirmation('Set model to Haiku 4.5')).toBe(false);
    });
    it('reports matching success output split across PTY chunks', async ()=>{
        const dataObserver = {
            current: (_data)=>{}
        };
        const unsubscribe = vi.fn(()=>{});
        const observer = createClaudeModelSwitchConfirmationObserver({
            ptyId: 'pty-1',
            settings: {},
            expectedModelLabel: 'Fable 5',
            subscribeToData: (watcher)=>{
                dataObserver.current = watcher;
                return unsubscribe;
            },
            timeoutMs: 100
        });
        await observer.ready;
        dataObserver.current('historical Set model to Fable 5');
        observer.arm();
        dataObserver.current('\u001b[2mSet\u001b[10Gmo');
        dataObserver.current('del\u001b[16Gto\u001b[19GFable 5 and saved as your default\u001b[0m');
        await expect(observer.result).resolves.toBe('applied');
        expect(unsubscribe).toHaveBeenCalledOnce();
    });
    it('matches the resolved-model echo when the picker label carries no version', async ()=>{
        const dataObserver = {
            current: (_data)=>{}
        };
        const observer = createClaudeModelSwitchConfirmationObserver({
            ptyId: 'pty-1',
            settings: {},
            expectedModelLabel: 'Opus (1M context)',
            subscribeToData: (watcher)=>{
                dataObserver.current = watcher;
                return vi.fn(()=>{});
            },
            timeoutMs: 100
        });
        await observer.ready;
        observer.arm();
        dataObserver.current('Set model to Opus 5 (1M context) and saved as your default');
        await expect(observer.result).resolves.toBe('applied');
    });
    it('does not confirm a different context variant from the same model family', async ()=>{
        vi.useFakeTimers();
        try {
            const dataObserver = {
                current: (_data)=>{}
            };
            const observer = createClaudeModelSwitchConfirmationObserver({
                ptyId: 'pty-1',
                settings: {},
                expectedModelLabel: 'Opus (1M context)',
                subscribeToData: (watcher)=>{
                    dataObserver.current = watcher;
                    return vi.fn(()=>{});
                },
                timeoutMs: 100
            });
            await observer.ready;
            observer.arm();
            observer.startDetection();
            dataObserver.current('Set model to Opus 5 and saved as your default');
            await vi.advanceTimersByTimeAsync(100);
            await expect(observer.result).resolves.toBe('unknown');
        } finally{
            vi.useRealTimers();
        }
    });
    it('accepts the exact cached-history confirmation once and keeps observing', async ()=>{
        const dataObserver = {
            current: (_data)=>{}
        };
        const submitConfirmation = vi.fn();
        const observer = createClaudeModelSwitchConfirmationObserver({
            ptyId: 'pty-1',
            settings: {},
            expectedModelLabel: 'Fable 5',
            subscribeToData: (watcher)=>{
                dataObserver.current = watcher;
                return vi.fn(()=>{});
            },
            submitConfirmation,
            timeoutMs: 100
        });
        await observer.ready;
        observer.arm();
        dataObserver.current('Switch model? This\u001b[9Gconversation\u001b[22Gis\u001b[25Gcached ');
        dataObserver.current('for\u001b[36Gthe\u001b[40Gcurrent\u001b[48Gmodel.');
        dataObserver.current(' redraw of the same Switch model? prompt');
        expect(submitConfirmation).toHaveBeenCalledOnce();
        dataObserver.current('Set model to Fable 5 and saved as your default for new sessions');
        await expect(observer.result).resolves.toBe('applied');
    });
    it('reports a canceled model switch without opening an interaction', async ()=>{
        const dataObserver = {
            current: (_data)=>{}
        };
        const observer = createClaudeModelSwitchConfirmationObserver({
            ptyId: 'pty-1',
            settings: {},
            expectedModelLabel: 'Haiku',
            subscribeToData: (watcher)=>{
                dataObserver.current = watcher;
                return vi.fn(()=>{});
            },
            timeoutMs: 100
        });
        await observer.ready;
        observer.arm();
        dataObserver.current('\u001b[2mKept\u001b[9Gmodel\u001b[16Gas ');
        dataObserver.current('Fable 5\u001b[0m');
        await expect(observer.result).resolves.toBe('rejected');
    });
    it('reports unknown when the PTY observer cannot be established', async ()=>{
        const observer = createClaudeModelSwitchConfirmationObserver({
            ptyId: 'pty-1',
            settings: {},
            expectedModelLabel: 'Fable 5',
            subscribeToData: ()=>Promise.reject(new Error('unavailable')),
            timeoutMs: 100
        });
        await observer.ready;
        observer.arm();
        await expect(observer.result).resolves.toBe('unknown');
    });
    it('reports unknown on timeout instead of requesting the terminal', async ()=>{
        vi.useFakeTimers();
        try {
            const observer = createClaudeModelSwitchConfirmationObserver({
                ptyId: 'pty-1',
                settings: {},
                expectedModelLabel: 'Fable 5',
                subscribeToData: ()=>vi.fn(()=>{}),
                timeoutMs: 100
            });
            await observer.ready;
            observer.arm();
            observer.startDetection();
            await vi.advanceTimersByTimeAsync(100);
            await expect(observer.result).resolves.toBe('unknown');
        } finally{
            vi.useRealTimers();
        }
    });
    it('does not start the detection timeout until startDetection() is called', async ()=>{
        vi.useFakeTimers();
        try {
            let settled = false;
            const observer = createClaudeModelSwitchConfirmationObserver({
                ptyId: 'pty-1',
                settings: {},
                expectedModelLabel: 'Fable 5',
                subscribeToData: ()=>vi.fn(()=>{}),
                timeoutMs: 100
            });
            void observer.result.then(()=>{
                settled = true;
            });
            await observer.ready;
            observer.arm();
            await vi.advanceTimersByTimeAsync(500);
            expect(settled).toBe(false);
            observer.startDetection();
            await vi.advanceTimersByTimeAsync(100);
            await expect(observer.result).resolves.toBe('unknown');
        } finally{
            vi.useRealTimers();
        }
    });
});
