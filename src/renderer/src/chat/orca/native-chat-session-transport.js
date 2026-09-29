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
import { t } from "../../i18n/index.js";
import { isWebClientLocation } from '@/lib/web-client-location';
import { callRuntimeRpc, RuntimeRpcCallError } from '@/runtime/runtime-rpc-client';
import { isRuntimeCompatBlockError } from '@/runtime/runtime-protocol-compat';
import { parseRuntimeNativeChatReadSessionResult, parseRuntimeNativeChatTurnLifecycle, RUNTIME_NATIVE_CHAT_READ_ERROR } from "./native-chat-runtime-contract.js";
const RUNTIME_TOO_OLD = t("chat.orca.copy.this_remote_runtime_is_too_old_to_show_agent_chat_history_update_the_remote_runtime_to_view_it", "This remote runtime is too old to show agent chat history. Update the remote runtime to view it.");
export const RUNTIME_NATIVE_CHAT_RECONNECT_MS = 2_000;
export function toRuntimeNativeChatErrorMessage(err) {
    if (err instanceof RuntimeRpcCallError && err.code === 'method_not_found') {
        return RUNTIME_TOO_OLD;
    }
    if (isRuntimeCompatBlockError(err)) {
        return RUNTIME_TOO_OLD;
    }
    return RUNTIME_NATIVE_CHAT_READ_ERROR;
}
const localNativeChatTransport = {
    readSession: (agent, sessionId, limit, transcriptPath)=>window.api.nativeChat.readSession(agent, sessionId, limit, transcriptPath),
    subscribe: (args, onFrame)=>window.api.nativeChat.subscribe(args, onFrame)
};
function createRuntimeNativeChatTransport(environmentId) {
    const target = {
        kind: 'environment',
        environmentId
    };
    return {
        readSession: async (agent, sessionId, limit, transcriptPath)=>{
            try {
                const result = await callRuntimeRpc(target, 'nativeChat.readSession', {
                    agent,
                    sessionId,
                    limit,
                    transcriptPath
                }, {
                    timeoutMs: 15_000
                });
                return parseRuntimeNativeChatReadSessionResult(result);
            } catch (err) {
                return {
                    error: toRuntimeNativeChatErrorMessage(err)
                };
            }
        },
        subscribe: (args, onFrame)=>{
            const { subscriptionId, agent, sessionId, transcriptPath, limit } = args;
            let cancelled = false;
            let receivedInitial = false;
            let handleUnsubscribe = null;
            let reconnectTimer = null;
            let activeAttempt = 0;
            let reconnectPendingAttempt = null;
            const scheduleReconnect = (attempt)=>{
                if (attempt !== activeAttempt) {
                    return;
                }
                handleUnsubscribe = null;
                reconnectPendingAttempt = attempt;
                if (cancelled || reconnectTimer) {
                    return;
                }
                reconnectTimer = setTimeout(()=>{
                    reconnectTimer = null;
                    reconnectPendingAttempt = null;
                    if (!cancelled) {
                        openStream();
                    }
                }, RUNTIME_NATIVE_CHAT_RECONNECT_MS);
            };
            const openStream = ()=>{
                const attempt = ++activeAttempt;
                void window.api.runtimeEnvironments.subscribe({
                    selector: environmentId,
                    method: 'nativeChat.subscribe',
                    params: {
                        subscriptionId,
                        agent,
                        sessionId,
                        transcriptPath,
                        limit,
                        capabilities: {
                            transcriptPending: 1
                        }
                    },
                    timeoutMs: 15_000
                }, {
                    onResponse: (response)=>{
                        if (cancelled || attempt !== activeAttempt) {
                            return;
                        }
                        if (response.ok === false) {
                            if (!receivedInitial) {
                                receivedInitial = true;
                                onFrame({
                                    type: 'snapshot',
                                    messages: [],
                                    hasMore: false,
                                    error: toRuntimeNativeChatErrorMessage(new RuntimeRpcCallError(response))
                                });
                            } else {
                                handleUnsubscribe?.();
                                scheduleReconnect(attempt);
                            }
                            return;
                        }
                        const frame = response.result;
                        const lifecycle = parseRuntimeNativeChatTurnLifecycle(frame?.lifecycle);
                        const pending = frame?.pending === true;
                        if ((frame?.type === 'appended' || frame?.type === 'snapshot' || frame?.type === 'replacement') && Array.isArray(frame.messages)) {
                            if (!receivedInitial) {
                                if (!pending) {
                                    receivedInitial = true;
                                }
                                onFrame({
                                    type: 'snapshot',
                                    messages: frame.messages,
                                    hasMore: frame.hasMore ?? frame.messages.length >= (limit ?? 300),
                                    ...frame.error ? {
                                        error: frame.error
                                    } : {},
                                    ...lifecycle ? {
                                        lifecycle
                                    } : {},
                                    ...pending ? {
                                        pending: true
                                    } : {}
                                });
                            } else if (frame.type === 'snapshot') {
                                onFrame({
                                    type: 'snapshot',
                                    messages: frame.messages,
                                    hasMore: frame.hasMore ?? false,
                                    ...frame.error ? {
                                        error: frame.error
                                    } : {},
                                    ...lifecycle ? {
                                        lifecycle
                                    } : {},
                                    ...pending ? {
                                        pending: true
                                    } : {}
                                });
                            } else {
                                onFrame(frame.type === 'replacement' ? {
                                    type: 'replacement',
                                    messages: frame.messages,
                                    hasMore: frame.hasMore ?? false,
                                    ...lifecycle ? {
                                        lifecycle
                                    } : {}
                                } : {
                                    type: 'appended',
                                    messages: frame.messages,
                                    ...lifecycle ? {
                                        lifecycle
                                    } : {}
                                });
                            }
                        } else if (!receivedInitial) {
                            receivedInitial = true;
                            onFrame({
                                type: 'snapshot',
                                messages: [],
                                hasMore: false,
                                ...frame?.error ? {
                                    error: frame.error
                                } : {}
                            });
                        }
                    },
                    onError: ()=>scheduleReconnect(attempt),
                    onClose: ()=>scheduleReconnect(attempt)
                }).then((handle)=>{
                    if (cancelled || attempt !== activeAttempt || reconnectPendingAttempt === attempt) {
                        handle.unsubscribe();
                        return;
                    }
                    handleUnsubscribe = handle.unsubscribe;
                }).catch((err)=>{
                    if (cancelled || attempt !== activeAttempt) {
                        return;
                    }
                    if (!receivedInitial) {
                        receivedInitial = true;
                        onFrame({
                            type: 'snapshot',
                            messages: [],
                            hasMore: false,
                            error: toRuntimeNativeChatErrorMessage(err)
                        });
                        return;
                    }
                    scheduleReconnect(attempt);
                });
            };
            openStream();
            return ()=>{
                cancelled = true;
                if (reconnectTimer) {
                    clearTimeout(reconnectTimer);
                    reconnectTimer = null;
                }
                reconnectPendingAttempt = null;
                handleUnsubscribe?.();
                handleUnsubscribe = null;
            };
        }
    };
}
export function getNativeChatSessionTransport(runtimeEnvironmentId) {
    if (runtimeEnvironmentId && !isWebClientLocation()) {
        return createRuntimeNativeChatTransport(runtimeEnvironmentId);
    }
    return localNativeChatTransport;
}
