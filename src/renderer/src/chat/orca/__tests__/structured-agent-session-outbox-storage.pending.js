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
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStructuredAgentSessionOutboxEntry } from "../shared/structured-agent-session-outbox.js";
import { hasUndeliveredStructuredAgentSessionOutbox, resetUndeliveredStructuredAgentSessionOutboxForTests, subscribeToUndeliveredStructuredAgentSessionOutbox, writeOutbox } from "../structured-agent-session-outbox-storage.js";
function entry(sessionId, clientMessageId) {
    return createStructuredAgentSessionOutboxEntry({
        clientMessageId,
        sessionId,
        text: clientMessageId,
        attachments: [],
        queuedAt: 1
    });
}
describe('undelivered structured agent session outbox projection', ()=>{
    beforeEach(()=>{
        localStorage.clear();
        resetUndeliveredStructuredAgentSessionOutboxForTests();
    });
    it('reports a session whose outbox was persisted before this renderer read it', ()=>{
        writeOutbox('session-a', [
            entry('session-a', 'client-1')
        ]);
        resetUndeliveredStructuredAgentSessionOutboxForTests();
        expect(hasUndeliveredStructuredAgentSessionOutbox('session-a')).toBe(true);
        expect(hasUndeliveredStructuredAgentSessionOutbox('session-b')).toBe(false);
    });
    it('notifies when the first entry lands and when the last one leaves', ()=>{
        const listener = vi.fn();
        const unsubscribe = subscribeToUndeliveredStructuredAgentSessionOutbox('session-a', listener);
        writeOutbox('session-a', [
            entry('session-a', 'client-1')
        ]);
        expect(listener).toHaveBeenCalledTimes(1);
        expect(hasUndeliveredStructuredAgentSessionOutbox('session-a')).toBe(true);
        writeOutbox('session-a', []);
        expect(listener).toHaveBeenCalledTimes(2);
        expect(hasUndeliveredStructuredAgentSessionOutbox('session-a')).toBe(false);
        unsubscribe();
        writeOutbox('session-a', [
            entry('session-a', 'client-2')
        ]);
        expect(listener).toHaveBeenCalledTimes(2);
    });
    it('stays quiet for a write that leaves the session undelivered either way', ()=>{
        const listener = vi.fn();
        const unsubscribe = subscribeToUndeliveredStructuredAgentSessionOutbox('session-a', listener);
        writeOutbox('session-a', [
            entry('session-a', 'client-1'),
            entry('session-a', 'client-2')
        ]);
        expect(listener).toHaveBeenCalledTimes(1);
        writeOutbox('session-a', [
            entry('session-a', 'client-2')
        ]);
        expect(listener).toHaveBeenCalledTimes(1);
        unsubscribe();
    });
    it('does not notify a session subscriber for another session', ()=>{
        const listener = vi.fn();
        const unsubscribe = subscribeToUndeliveredStructuredAgentSessionOutbox('session-a', listener);
        expect(hasUndeliveredStructuredAgentSessionOutbox('session-a')).toBe(false);
        writeOutbox('session-b', [
            entry('session-b', 'client-1')
        ]);
        expect(listener).not.toHaveBeenCalled();
        unsubscribe();
    });
    it('releases the cached snapshot when the last subscriber leaves', ()=>{
        writeOutbox('session-a', [
            entry('session-a', 'client-1')
        ]);
        const unsubscribe = subscribeToUndeliveredStructuredAgentSessionOutbox('session-a', vi.fn());
        const getItem = vi.spyOn(localStorage, 'getItem');
        for(let index = 0; index < 10; index += 1){
            expect(hasUndeliveredStructuredAgentSessionOutbox('session-a')).toBe(true);
        }
        expect(getItem).not.toHaveBeenCalled();
        unsubscribe();
        localStorage.clear();
        expect(hasUndeliveredStructuredAgentSessionOutbox('session-a')).toBe(false);
        getItem.mockRestore();
    });
    it('keeps a snapshot until both subscribers leave and reloads it on remount', ()=>{
        const first = vi.fn();
        const second = vi.fn();
        const releaseFirst = subscribeToUndeliveredStructuredAgentSessionOutbox('session-a', first);
        const releaseSecond = subscribeToUndeliveredStructuredAgentSessionOutbox('session-a', second);
        releaseFirst();
        writeOutbox('session-a', [
            entry('session-a', 'client-1')
        ]);
        expect(first).not.toHaveBeenCalled();
        expect(second).toHaveBeenCalledTimes(1);
        releaseSecond();
        localStorage.clear();
        const releaseRemount = subscribeToUndeliveredStructuredAgentSessionOutbox('session-a', first);
        expect(hasUndeliveredStructuredAgentSessionOutbox('session-a')).toBe(false);
        writeOutbox('session-a', [
            entry('session-a', 'client-2')
        ]);
        expect(first).toHaveBeenCalledTimes(1);
        expect(second).toHaveBeenCalledTimes(1);
        releaseRemount();
    });
});
