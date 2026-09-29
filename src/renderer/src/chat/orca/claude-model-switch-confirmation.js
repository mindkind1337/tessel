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
import { subscribeToPtyData } from '../terminal-pane/pty-data-sidecar-subscriptions';
import { isRemoteRuntimePtyId, sendRuntimePtyInput } from '@/runtime/runtime-terminal-inspection';
import { subscribeToRuntimeTerminalData } from '@/runtime/runtime-terminal-stream';
import { NATIVE_CHAT_SUBMIT } from "./native-chat-send.js";
import { stripScrollbackAnsi } from "./native-chat-scrape-fallback.js";
const DETECTION_TIMEOUT_MS = 5_000;
const MAX_OBSERVED_BYTES = 64 * 1024;
export function hasClaudeModelSwitchConfirmation(buffer) {
    const text = compactTerminalText(buffer);
    return text.includes('switchmodel?') && text.includes('thisconversationiscachedforthecurrentmodel');
}
function compactTerminalText(buffer) {
    return stripScrollbackAnsi(buffer).replace(/\s+/g, '').toLowerCase();
}
function hasClaudeModelSwitchSuccess(buffer, modelLabel) {
    const text = compactTerminalText(buffer);
    const marker = `setmodelto${modelLabel.replace(/\s+/g, '').toLowerCase()}`; // i18n-ignore
    if (text.includes(marker)) {
        return true;
    }
    const labelTokens = modelLabel.toLowerCase().match(/[a-z]+|\d+[a-z]*/g) ?? [];
    const successStart = text.lastIndexOf('setmodelto');
    if (successStart === -1 || labelTokens.length === 0) {
        return false;
    }
    const successText = text.slice(successStart);
    let tokenEnd = 0;
    for (const token of labelTokens){
        const tokenStart = successText.indexOf(token, tokenEnd);
        if (tokenStart === -1) {
            return false;
        }
        tokenEnd = tokenStart + token.length;
    }
    return true;
}
function hasClaudeModelSwitchRejection(buffer) {
    return compactTerminalText(buffer).includes('keptmodelas');
}
function subscribeToClaudeModelSwitchData(args) {
    if (args.subscribeToData) {
        return args.subscribeToData(args.watcher);
    }
    if (isRemoteRuntimePtyId(args.ptyId)) {
        return subscribeToRuntimeTerminalData(args.settings, args.ptyId, `desktop:native-chat-model-switch:${args.ptyId}`, args.watcher, { // i18n-ignore
            startAtLiveTail: true
        });
    }
    return subscribeToPtyData(args.ptyId, args.watcher);
}
export function createClaudeModelSwitchConfirmationObserver(args) {
    let armed = false;
    let settled = false;
    let confirmationSubmitted = false;
    let observed = '';
    let timeout = null;
    let unsubscribe = null;
    let resolveResult;
    let resolveReady;
    const result = new Promise((resolve)=>{
        resolveResult = resolve;
    });
    const ready = new Promise((resolve)=>{
        resolveReady = resolve;
    });
    const finish = (outcome)=>{
        if (settled) {
            return;
        }
        settled = true;
        if (timeout !== null) {
            clearTimeout(timeout);
            timeout = null;
        }
        unsubscribe?.();
        unsubscribe = null;
        resolveResult(outcome);
    };
    const scheduleTimeout = ()=>{
        if (timeout !== null) {
            clearTimeout(timeout);
        }
        timeout = setTimeout(()=>finish('unknown'), args.timeoutMs ?? DETECTION_TIMEOUT_MS);
    };
    const observeData = (data)=>{
        if (!armed || settled) {
            return;
        }
        observed = `${observed}${data}`.slice(-MAX_OBSERVED_BYTES);
        if (args.expectedModelLabel && hasClaudeModelSwitchSuccess(observed, args.expectedModelLabel)) {
            finish('applied');
            return;
        }
        if (hasClaudeModelSwitchRejection(observed)) {
            finish('rejected');
            return;
        }
        if (!confirmationSubmitted && hasClaudeModelSwitchConfirmation(observed)) {
            confirmationSubmitted = true;
            try {
                const accepted = args.submitConfirmation ? args.submitConfirmation() !== false : sendRuntimePtyInput(args.settings, args.ptyId, NATIVE_CHAT_SUBMIT);
                if (!accepted) {
                    finish('unknown');
                    return;
                }
                scheduleTimeout();
            } catch  {
                finish('unknown');
            }
        }
    };
    try {
        const subscription = subscribeToClaudeModelSwitchData({
            ptyId: args.ptyId,
            settings: args.settings,
            subscribeToData: args.subscribeToData,
            watcher: observeData
        });
        void Promise.resolve(subscription).then((dispose)=>{
            if (settled) {
                dispose();
            } else {
                unsubscribe = dispose;
            }
        }).catch(()=>finish('unknown')).finally(resolveReady);
    } catch  {
        finish('unknown');
        resolveReady();
    }
    return {
        ready,
        result,
        arm: ()=>{
            if (settled || armed) {
                return;
            }
            armed = true;
        },
        startDetection: ()=>{
            if (settled) {
                return;
            }
            scheduleTimeout();
        },
        dispose: ()=>finish('unknown')
    };
}
