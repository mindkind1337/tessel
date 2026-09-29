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
import en from '@/i18n/locales/en.json';
import { NATIVE_CHAT_TOOL_ACTIVITY_COPY } from "../shared/native-chat-tool-activity.js";
import { NATIVE_CHAT_TURN_STATUS_COPY } from "../shared/native-chat-turn-status.js";
import { NATIVE_CHAT_TOOL_RUN_SENTENCE_COPY, NATIVE_CHAT_TOOL_RUN_SENTENCE_JOINERS } from "../shared/native-chat-tool-run-sentence.js";
const catalog = en;
describe('native-chat shared copy matches the English catalog', ()=>{
    it.each(Object.entries(NATIVE_CHAT_TURN_STATUS_COPY))('status.%s matches en.json', (key, value)=>{
        expect(catalog.components['native-chat'].status[key]).toBe(value);
    });
    it.each(Object.entries(NATIVE_CHAT_TOOL_ACTIVITY_COPY))('tool.%s matches en.json', (key, value)=>{
        expect(catalog.components['native-chat'].tool[key]).toBe(value);
    });
    it.each([
        [
            'runReadOne',
            NATIVE_CHAT_TOOL_RUN_SENTENCE_COPY.read.one
        ],
        [
            'runReadMany',
            NATIVE_CHAT_TOOL_RUN_SENTENCE_COPY.read.many
        ],
        [
            'runSearchOne',
            NATIVE_CHAT_TOOL_RUN_SENTENCE_COPY.search.one
        ],
        [
            'runSearchMany',
            NATIVE_CHAT_TOOL_RUN_SENTENCE_COPY.search.many
        ],
        [
            'runListFilesOne',
            NATIVE_CHAT_TOOL_RUN_SENTENCE_COPY.listFiles.one
        ],
        [
            'runListFilesMany',
            NATIVE_CHAT_TOOL_RUN_SENTENCE_COPY.listFiles.many
        ],
        [
            'runCommandOne',
            NATIVE_CHAT_TOOL_RUN_SENTENCE_COPY.unknown.one
        ],
        [
            'runCommandMany',
            NATIVE_CHAT_TOOL_RUN_SENTENCE_COPY.unknown.many
        ],
        [
            'runFileChangeOne',
            NATIVE_CHAT_TOOL_RUN_SENTENCE_COPY.fileChange.one
        ],
        [
            'runFileChangeMany',
            NATIVE_CHAT_TOOL_RUN_SENTENCE_COPY.fileChange.many
        ],
        [
            'runWebSearchOne',
            NATIVE_CHAT_TOOL_RUN_SENTENCE_COPY.webSearch.one
        ],
        [
            'runWebSearchMany',
            NATIVE_CHAT_TOOL_RUN_SENTENCE_COPY.webSearch.many
        ],
        [
            'runIntegrationOne',
            NATIVE_CHAT_TOOL_RUN_SENTENCE_COPY.mcpToolCall.one
        ],
        [
            'runIntegrationMany',
            NATIVE_CHAT_TOOL_RUN_SENTENCE_COPY.mcpToolCall.many
        ],
        [
            'runAgentOne',
            NATIVE_CHAT_TOOL_RUN_SENTENCE_COPY.subAgentActivity.one
        ],
        [
            'runAgentMany',
            NATIVE_CHAT_TOOL_RUN_SENTENCE_COPY.subAgentActivity.many
        ],
        [
            'runPlanOne',
            NATIVE_CHAT_TOOL_RUN_SENTENCE_COPY.todoList.one
        ],
        [
            'runPlanMany',
            NATIVE_CHAT_TOOL_RUN_SENTENCE_COPY.todoList.many
        ],
        [
            'runToolOne',
            NATIVE_CHAT_TOOL_RUN_SENTENCE_COPY.other.one
        ],
        [
            'runToolMany',
            NATIVE_CHAT_TOOL_RUN_SENTENCE_COPY.other.many
        ],
        [
            'runPair',
            NATIVE_CHAT_TOOL_RUN_SENTENCE_JOINERS.pair
        ],
        [
            'runList',
            NATIVE_CHAT_TOOL_RUN_SENTENCE_JOINERS.list
        ]
    ])('tool.%s matches the shared run sentence copy', (key, value)=>{
        expect(catalog.components['native-chat'].tool[key]).toBe(value);
    });
    it('keeps the interpolation placeholders the catalog expects', ()=>{
        expect(NATIVE_CHAT_TURN_STATUS_COPY.workedFor).toContain('{{value0}}');
        expect(NATIVE_CHAT_TURN_STATUS_COPY.workingFor).toContain('{{value0}}');
        expect(NATIVE_CHAT_TOOL_ACTIVITY_COPY.countN).toContain('{{value0}}');
        expect(NATIVE_CHAT_TOOL_ACTIVITY_COPY.runningPreview).toContain('{{preview}}');
        expect(NATIVE_CHAT_TOOL_ACTIVITY_COPY.runningNamedPreview).toContain('{{toolName}}');
        expect(NATIVE_CHAT_TOOL_ACTIVITY_COPY.runningNamedPreview).toContain('{{preview}}');
    });
});
