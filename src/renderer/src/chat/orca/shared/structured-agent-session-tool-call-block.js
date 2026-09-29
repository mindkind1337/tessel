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
export function isStructuredAgentSessionToolAction(body) {
    return body?.kind === 'tool-call' || body?.kind === 'diff';
}
export function isRunningStructuredAgentSessionToolAction(action) {
    return action.kind === 'tool-call' && action.state === 'running';
}
export function structuredAgentSessionToolCallBlock(action) {
    if (action.kind === 'diff') {
        return {
            type: 'tool-call',
            name: 'Diff',
            input: {
                path: action.path
            }
        };
    }
    return {
        type: 'tool-call',
        name: action.name,
        input: action.input,
        state: action.state,
        ...action.callId !== undefined ? {
            callId: action.callId
        } : {},
        ...action.mcpIdentity !== undefined ? {
            mcpIdentity: action.mcpIdentity
        } : {},
        ...action.exitCode !== undefined ? {
            exitCode: action.exitCode
        } : {},
        ...action.durationMs !== undefined ? {
            durationMs: action.durationMs
        } : {},
        ...action.webSearchResults !== undefined ? {
            webSearchResults: action.webSearchResults
        } : {}
    };
}
