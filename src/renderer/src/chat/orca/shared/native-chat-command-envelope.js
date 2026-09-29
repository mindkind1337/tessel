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
import { isTextBlock } from "./native-chat-types.js";
const COMMAND_NAME = /<command-name>([\s\S]*?)<\/command-name>/;
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/;
export function parseNativeChatCommandEnvelope(text) {
    const trimmed = text.trimStart();
    if (!trimmed.toLowerCase().startsWith('<command-')) {
        return null;
    }
    const name = COMMAND_NAME.exec(trimmed)?.[1]?.trim();
    if (!name) {
        return null;
    }
    return {
        name,
        args: COMMAND_ARGS.exec(trimmed)?.[1]?.trim() ?? ''
    };
}
export function surfaceSkillInvocationUserTurns(messages, catalogCommandNames) {
    let changed = false;
    const out = messages.map((message)=>{
        if (message.role !== 'user' || !message.blocks.every(isTextBlock)) {
            return message;
        }
        const envelope = parseNativeChatCommandEnvelope(message.blocks.map((block)=>block.text).join('\n'));
        if (!envelope || catalogCommandNames.has(envelope.name.replace(/^\//, ''))) {
            return message;
        }
        const shortName = envelope.name.replace(/^\//, '').split(':').at(-1) ?? '';
        const token = `/${shortName}`;
        changed = true;
        return {
            ...message,
            blocks: [
                {
                    type: 'text',
                    text: envelope.args ? `${token} ${envelope.args}` : token
                }
            ]
        };
    });
    return changed ? out : messages;
}
