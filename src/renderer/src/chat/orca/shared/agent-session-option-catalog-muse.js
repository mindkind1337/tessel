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
import { t } from "../../../i18n/index.js";
import { hasFlag } from "./agent-cli-flag-detection.js";
import { removeAgentArgOption } from "./agent-session-option-agent-args.js";
const MUSE_EFFORT = {
    id: 'effort',
    get label() { return t("chat.orca.copy.reasoning_effort", "Reasoning effort"); },
    category: 'thought_level',
    kind: {
        type: 'select',
        choices: [
            {
                value: 'minimal',
                get label() { return t("chat.orca.copy.minimal", "Minimal"); }
            },
            {
                value: 'low',
                get label() { return t("chat.orca.copy.low", "Low"); }
            },
            {
                value: 'medium',
                get label() { return t("chat.orca.copy.medium", "Medium"); }
            },
            {
                value: 'high',
                get label() { return t("chat.orca.copy.high", "High"); }
            },
            {
                value: 'xhigh',
                get label() { return t("chat.orca.copy.extra_high", "Extra high"); }
            },
            {
                value: 'max',
                get label() { return t("chat.orca.copy.max", "Max"); }
            },
            {
                value: 'ultra',
                get label() { return t("chat.orca.copy.ultra", "Ultra"); }
            }
        ],
        defaultValue: 'high'
    },
    apply: {
        launchArgs: (value)=>[
                '--reasoning-effort',
                String(value)
            ],
        agentArgsOverride: (tokens)=>hasFlag(tokens, [
                '--reasoning-effort'
            ]),
        removeAgentArgs: (tokens)=>removeAgentArgOption(tokens, [
                '--reasoning-effort'
            ])
    }
};
export const MUSE_SESSION_OPTION_CATALOG = {
    supportsWorkerLaunchPreferences: true,
    models: [],
    modelApply: {
        launchArgs: (value)=>[
                '--model',
                String(value)
            ],
        agentArgsOverride: (tokens)=>hasFlag(tokens, [
                '--model'
            ]),
        removeAgentArgs: (tokens)=>removeAgentArgOption(tokens, [
                '--model'
            ])
    },
    unknownModelOptions: [
        MUSE_EFFORT
    ]
};
