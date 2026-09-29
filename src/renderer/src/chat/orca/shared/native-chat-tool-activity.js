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
// English fallback catalog; the renderer translates at the call site.
import { createToolInputDisplay } from "./native-chat-tool-summary.js";
import { isToolCallBlock } from "./native-chat-types.js";
export const NATIVE_CHAT_TOOL_ACTIVITY_COPY = {
    runningPreview: 'Running {{preview}}', // i18n-ignore
    runningCommand: 'Running command', // i18n-ignore
    runningNamedPreview: 'Running {{toolName}} {{preview}}', // i18n-ignore
    runningNamed: 'Running {{toolName}}', // i18n-ignore
    countOne: '1 tool call',
    countN: '{{value0}} tool calls',
    moreCalls: '+{{value0}} more',
    failedCount: '{{value0}} failed',
    failedCallsLabel: 'Failed tool calls: {{value0}}' // i18n-ignore
};
export const COMMAND_TOOL_NAMES = new Set([
    'bash',
    'shell',
    'powershell',
    'terminal',
    'execute',
    'run_command',
    'run_shell_command',
    'shell_command',
    'exec_command',
    'run_terminal_cmd',
    'run_terminal_command'
]);
export function isCommandToolName(name) {
    return COMMAND_TOOL_NAMES.has(name.trim().toLowerCase());
}
export function describeActiveToolCall(call) {
    const preview = createToolInputDisplay(call.input).label;
    const isCommand = isCommandToolName(call.name);
    const key = isCommand ? preview ? 'runningPreview' : 'runningCommand' : preview ? 'runningNamedPreview' : 'runningNamed';
    return {
        key,
        toolName: call.name,
        preview,
        isCommand
    };
}
export function formatActiveToolLabel(descriptor) {
    return NATIVE_CHAT_TOOL_ACTIVITY_COPY[descriptor.key].replaceAll('{{preview}}', descriptor.preview).replaceAll('{{toolName}}', descriptor.toolName);
}
export function describeLatestToolCall(call) {
    const { toolName, preview, isCommand } = describeActiveToolCall(call);
    if (isCommand) {
        return preview || toolName;
    }
    return preview ? `${toolName} ${preview}` : toolName;
}
export function selectActiveToolCall(blocks, { activeTurnIsWorking }) {
    if (activeTurnIsWorking === false) {
        return null;
    }
    const calls = blocks.filter(isToolCallBlock);
    for(let index = calls.length - 1; index >= 0; index--){
        const call = calls[index];
        if (call && (call.state === 'running' || call.state == null && activeTurnIsWorking === true)) {
            return call;
        }
    }
    return null;
}
export function formatToolCallCount(callCount) {
    return callCount === 1 ? NATIVE_CHAT_TOOL_ACTIVITY_COPY.countOne : NATIVE_CHAT_TOOL_ACTIVITY_COPY.countN.replaceAll('{{value0}}', String(callCount));
}
