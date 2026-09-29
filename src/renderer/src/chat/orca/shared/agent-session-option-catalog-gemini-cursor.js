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
const hasModelFlag = (tokens)=>hasFlag(tokens, [
        '-m',
        '--model'
    ]);
export const GEMINI_SESSION_OPTION_CATALOG = {
    models: [
        {
            id: 'gemini-3-pro-preview',
            label: 'Gemini 3 Pro Preview', // i18n-ignore
            options: []
        },
        {
            id: 'gemini-3-flash-preview',
            label: 'Gemini 3 Flash Preview', // i18n-ignore
            options: []
        },
        {
            id: 'gemini-2.5-pro',
            label: 'Gemini 2.5 Pro', // i18n-ignore
            options: []
        },
        {
            id: 'gemini-2.5-flash',
            label: 'Gemini 2.5 Flash', // i18n-ignore
            options: []
        }
    ],
    modelApply: {
        launchArgs: (value)=>[
                '-m',
                String(value)
            ],
        agentArgsOverride: hasModelFlag,
        midSession: {
            kind: 'agent-picker',
            command: '/model'
        }
    }
};
const CURSOR_EFFORT = {
    id: 'effort',
    get label() { return t("chat.orca.copy.effort", "Effort"); },
    category: 'thought_level',
    kind: {
        type: 'select',
        choices: [
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
            }
        ],
        defaultValue: 'high'
    },
    apply: {
        composedIntoModel: true
    }
};
const CURSOR_FAST = {
    id: 'fastMode',
    get label() { return t("chat.orca.copy.fast_mode", "Fast mode"); },
    category: 'mode',
    kind: {
        type: 'boolean',
        defaultValue: false
    },
    apply: {
        composedIntoModel: true
    }
};
const CURSOR_THINKING = {
    id: 'thinking',
    get label() { return t("chat.orca.copy.thinking", "Thinking"); },
    category: 'model_config',
    kind: {
        type: 'boolean',
        defaultValue: true
    },
    apply: {
        composedIntoModel: true
    }
};
function parseCursorModels(stdout) {
    const seen = new Set();
    const models = [];
    for (const line of stdout.split(/\r?\n/)){
        const match = line.trim().match(/^(?:[-*]\s+)?([a-z0-9][a-z0-9._-]*)(?:\s+\(.*\))?$/i);
        const id = match?.[1];
        if (!id || id.toLowerCase() === 'models' || seen.has(id)) {
            continue;
        }
        seen.add(id);
        models.push({
            id,
            label: id === 'auto' ? 'Auto' : id,
            options: []
        });
    }
    return models;
}
export const CURSOR_SESSION_OPTION_CATALOG = {
    supportsWorkerLaunchPreferences: true,
    models: [
        {
            id: 'auto',
            get label() { return t("chat.orca.copy.auto", "Auto"); },
            isDefault: true,
            options: []
        },
        {
            id: 'gpt-5.3-codex',
            label: 'GPT-5.3 Codex',
            options: [
                CURSOR_EFFORT,
                CURSOR_FAST
            ]
        },
        {
            id: 'claude-opus-4-8',
            label: 'Claude Opus 4.8', // i18n-ignore
            options: [
                CURSOR_THINKING,
                CURSOR_EFFORT
            ]
        }
    ],
    modelApply: {
        launchArgs: (value)=>[
                '--model',
                String(value)
            ],
        agentArgsOverride: hasModelFlag,
        removeAgentArgs: (tokens)=>removeAgentArgOption(tokens, [
                '-m',
                '--model'
            ]),
        midSession: {
            kind: 'command',
            build: (value)=>`/model ${String(value)}` // i18n-ignore
        }
    },
    composeModelValue: (modelId, values)=>{
        if (modelId === 'auto') {
            return modelId;
        }
        if (modelId.startsWith('claude-')) {
            const thinking = values.thinking === true ? '-thinking' : '';
            const effort = typeof values.effort === 'string' ? `-${values.effort}` : '';
            return `${modelId}${thinking}${effort}`;
        }
        const effort = typeof values.effort === 'string' ? `-${values.effort}` : '';
        const fast = values.fastMode === true ? '-fast' : '';
        return `${modelId}${effort}${fast}`;
    },
    listModels: {
        command: 'cursor-agent models',
        parse: parseCursorModels
    }
};
