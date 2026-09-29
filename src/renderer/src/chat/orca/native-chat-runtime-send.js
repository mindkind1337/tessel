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
import { sendRuntimePtyInput, sendRuntimePtyInputVerified } from '@/runtime/runtime-terminal-inspection';
import { AGENT_TUI_CLEAR_INPUT_MAX } from "./shared/agent-tui-input-clear.js";
import { NATIVE_CHAT_ADVANCE_BUFFER_MS, NATIVE_CHAT_QUESTION_STEP_MS, NATIVE_CHAT_SUBMIT_DELAY_MS } from "./shared/native-chat-answer-stepping.js";
import { buildNativeChatPasteBytes, NATIVE_CHAT_SUBMIT } from "./native-chat-send.js";
import { AGENT_TUI_COMMAND_KEY_INTERVAL_MS, typeAgentTuiCommand } from "./shared/agent-tui-command-typing.js";
import { cancelNativeChatPtySends, enqueueNativeChatPtySend, resetNativeChatPtySendQueuesForTests, waitForNativeChatPtyIdle } from "./native-chat-pty-send-queue.js";
export { NATIVE_CHAT_ADVANCE_BUFFER_MS, NATIVE_CHAT_QUESTION_STEP_MS, NATIVE_CHAT_SUBMIT_DELAY_MS };
export { resetNativeChatPtySendQueuesForTests };
export const NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT = '\x15';
export const NATIVE_CHAT_CLEAR_CONFIRM_MS = 140;
export function clearUnsubmittedAgentInput(settings, ptyId, options) {
    sendRuntimePtyInput(settings, ptyId, options?.clearInput ?? NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT);
}
export function clearThenWrite(settings, ptyId, options, delay, writeBody) {
    clearUnsubmittedAgentInput(settings, ptyId, options);
    const confirmCleared = options?.confirmCleared;
    if (!confirmCleared) {
        writeBody();
        return;
    }
    delay(NATIVE_CHAT_CLEAR_CONFIRM_MS, ()=>{
        let cleared = false;
        try {
            cleared = confirmCleared();
        } catch  {}
        if (!cleared) {
            sendRuntimePtyInput(settings, ptyId, AGENT_TUI_CLEAR_INPUT_MAX);
        }
        writeBody();
    });
}
export function clearConfirmDurationMs(options) {
    return options?.confirmCleared ? NATIVE_CHAT_CLEAR_CONFIRM_MS : 0;
}
export function sendNativeChatMessage(settings, ptyId, text, options) {
    return enqueueNativeChatPtySend(ptyId, NATIVE_CHAT_SUBMIT_DELAY_MS + clearConfirmDurationMs(options), ({ isCancelled, delay, markSubmitted })=>{
        if (isCancelled()) {
            return;
        }
        clearThenWrite(settings, ptyId, options, delay, ()=>{
            if (isCancelled()) {
                return;
            }
            sendRuntimePtyInput(settings, ptyId, buildNativeChatPasteBytes(text));
            delay(NATIVE_CHAT_SUBMIT_DELAY_MS, ()=>{
                sendRuntimePtyInput(settings, ptyId, NATIVE_CHAT_SUBMIT);
                markSubmitted();
            });
        });
    }, {
        onCancelUnsubmitted: ()=>clearUnsubmittedAgentInput(settings, ptyId, options)
    });
}
function waitForNativeChatSubmit(signal) {
    if (signal?.aborted) {
        return Promise.resolve(false);
    }
    return new Promise((resolve)=>{
        let timer = null;
        const finish = (completed)=>{
            if (timer === null) {
                return;
            }
            clearTimeout(timer);
            timer = null;
            signal?.removeEventListener('abort', onAbort);
            resolve(completed);
        };
        const onAbort = ()=>finish(false);
        timer = setTimeout(()=>finish(true), NATIVE_CHAT_SUBMIT_DELAY_MS);
        signal?.addEventListener('abort', onAbort, {
            once: true
        });
    });
}
export async function sendNativeChatMessageVerified(settings, ptyId, text, signal) {
    cancelNativeChatPtySends(ptyId);
    await waitForNativeChatPtyIdle(ptyId);
    if (signal?.aborted) {
        return false;
    }
    const bodyAccepted = await sendRuntimePtyInputVerified(settings, ptyId, buildNativeChatPasteBytes(text));
    if (!bodyAccepted || signal?.aborted || !await waitForNativeChatSubmit(signal)) {
        return false;
    }
    return sendRuntimePtyInputVerified(settings, ptyId, NATIVE_CHAT_SUBMIT);
}
export async function typeNativeChatCommand(settings, ptyId, command, signal) {
    cancelNativeChatPtySends(ptyId);
    await waitForNativeChatPtyIdle(ptyId);
    const outcome = await typeAgentTuiCommand({
        command,
        signal,
        write: async (key)=>await sendRuntimePtyInputVerified(settings, ptyId, key) ? 'accepted' : 'rejected'
    });
    return outcome === 'accepted';
}
export function sendNativeChatTypedCommand(settings, ptyId, command) {
    const controller = new AbortController();
    return enqueueNativeChatPtySend(ptyId, (command.length + 1) * AGENT_TUI_COMMAND_KEY_INTERVAL_MS, ({ isCancelled, markSubmitted })=>{
        const finish = (outcome)=>{
            if (!isCancelled() && outcome !== 'accepted') {
                clearUnsubmittedAgentInput(settings, ptyId);
            }
            markSubmitted();
        };
        void typeAgentTuiCommand({
            command,
            signal: controller.signal,
            write: async (key)=>{
                if (isCancelled()) {
                    return 'rejected';
                }
                return await sendRuntimePtyInputVerified(settings, ptyId, key) ? 'accepted' : 'rejected';
            }
        }).then(finish, ()=>finish('rejected'));
    }, {
        onCancelUnsubmitted: ()=>{
            controller.abort();
            clearUnsubmittedAgentInput(settings, ptyId);
        }
    });
}
export function submitNativeChatPrompt(settings, ptyId) {
    sendRuntimePtyInput(settings, ptyId, NATIVE_CHAT_SUBMIT);
}
export function sendNativeChatAskAnswer(settings, ptyId, groups, onSettled) {
    if (groups.length === 0) {
        return {
            cancel: ()=>{},
            settleAfterMs: 0
        };
    }
    const timers = [];
    const verifiedWrites = [];
    let cancelled = false;
    groups.forEach((group, index)=>{
        timers.push(setTimeout(()=>{
            const bytes = 'raw' in group ? group.raw : buildNativeChatPasteBytes(group.text);
            if (onSettled) {
                verifiedWrites.push(sendRuntimePtyInputVerified(settings, ptyId, bytes).catch(()=>false));
            } else {
                sendRuntimePtyInput(settings, ptyId, bytes);
            }
        }, index * NATIVE_CHAT_QUESTION_STEP_MS));
    });
    const settleAfterMs = (groups.length - 1) * NATIVE_CHAT_QUESTION_STEP_MS + NATIVE_CHAT_SUBMIT_DELAY_MS;
    if (onSettled) {
        timers.push(setTimeout(()=>{
            void Promise.all(verifiedWrites).then((results)=>{
                if (!cancelled) {
                    onSettled(results.every(Boolean));
                }
            });
        }, settleAfterMs));
    }
    return {
        cancel: ()=>{
            cancelled = true;
            for (const timer of timers){
                clearTimeout(timer);
            }
        },
        settleAfterMs
    };
}
