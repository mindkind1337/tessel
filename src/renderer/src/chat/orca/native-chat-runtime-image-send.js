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
import { agentImagePasteWrites, formatAgentImagePath } from "./shared/agent-image-paste.js";
import { sendRuntimePtyInput } from '@/runtime/runtime-terminal-inspection';
import { NATIVE_CHAT_SUBMIT_DELAY_MS } from "./shared/native-chat-answer-stepping.js";
import { buildNativeChatImagePasteBytes, buildNativeChatPasteBytes, NATIVE_CHAT_SUBMIT } from "./native-chat-send.js";
import { enqueueNativeChatPtySend } from "./native-chat-pty-send-queue.js";
import { clearConfirmDurationMs, clearThenWrite, clearUnsubmittedAgentInput, sendNativeChatMessage } from "./native-chat-runtime-send.js";
export const NATIVE_CHAT_IMAGE_ATTACHMENT_SETTLE_MS = 300;
export function sendNativeChatMessageWithImageAttachments(agent, settings, ptyId, text, imagePaths, options) {
    if (imagePaths.length === 0) {
        return sendNativeChatMessage(settings, ptyId, text, options);
    }
    const trimmedText = text.trim();
    const durationMs = (trimmedText.length > 0 ? NATIVE_CHAT_IMAGE_ATTACHMENT_SETTLE_MS + NATIVE_CHAT_SUBMIT_DELAY_MS : NATIVE_CHAT_SUBMIT_DELAY_MS) + clearConfirmDurationMs(options);
    return enqueueNativeChatPtySend(ptyId, durationMs, ({ isCancelled, delay, markSubmitted })=>{
        if (isCancelled()) {
            return;
        }
        clearThenWrite(settings, ptyId, options, delay, ()=>{
            if (isCancelled()) {
                return;
            }
            for (const payload of agentImagePasteWrites(agent, imagePaths.map((path)=>buildNativeChatImagePasteBytes(formatAgentImagePath(agent, path))), trimmedText.length > 0)){
                sendRuntimePtyInput(settings, ptyId, payload);
            }
            if (trimmedText.length > 0) {
                delay(NATIVE_CHAT_IMAGE_ATTACHMENT_SETTLE_MS, ()=>{
                    sendRuntimePtyInput(settings, ptyId, buildNativeChatPasteBytes(text));
                    delay(NATIVE_CHAT_SUBMIT_DELAY_MS, ()=>{
                        sendRuntimePtyInput(settings, ptyId, NATIVE_CHAT_SUBMIT);
                        markSubmitted();
                    });
                });
                return;
            }
            delay(NATIVE_CHAT_SUBMIT_DELAY_MS, ()=>{
                sendRuntimePtyInput(settings, ptyId, NATIVE_CHAT_SUBMIT);
                markSubmitted();
            });
        });
    }, {
        onCancelUnsubmitted: ()=>clearUnsubmittedAgentInput(settings, ptyId, options)
    });
}
