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
import { omitNativeChatThreadGoalRows } from "../native-chat-thread-goal-rows.js";
const PAYLOAD = {
    head: '{}',
    byteLength: 2,
    digest: 'd'.repeat(64),
    truncated: false
};
function frameRow(id, provider, kind) {
    return {
        id,
        role: 'system',
        timestamp: 0,
        source: 'transcript',
        blocks: [
            {
                type: 'text',
                text: id,
                providerFrame: {
                    provider,
                    kind,
                    payload: PAYLOAD
                }
            }
        ]
    };
}
describe('omitNativeChatThreadGoalRows', ()=>{
    it('drops goal transitions and keeps every other row', ()=>{
        const user = {
            id: 'user',
            role: 'user',
            timestamp: 0,
            source: 'transcript',
            blocks: [
                {
                    type: 'text',
                    text: 'Ship the parser'
                }
            ],
            sentAs: 'goal'
        };
        const warning = frameRow('warning', 'codex', 'notification:warning');
        const messages = [
            user,
            frameRow('set', 'codex', 'notification:thread/goal/updated'),
            warning,
            frameRow('cleared', 'codex', 'notification:thread/goal/cleared')
        ];
        expect(omitNativeChatThreadGoalRows(messages).map((message)=>message.id)).toEqual([
            'user',
            'warning'
        ]);
    });
    it('keeps a same-named frame from another provider', ()=>{
        const other = frameRow('other', 'claude', 'notification:thread/goal/updated');
        expect(omitNativeChatThreadGoalRows([
            other
        ])).toEqual([
            other
        ]);
    });
});
