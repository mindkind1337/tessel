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
import { parseGrokModelList } from "./grok-model-list-probe.js";
const GROK_EFFORT_CHOICES = [
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
    }
];
function grokEffort(ceiling) {
    const ceilingIndex = GROK_EFFORT_CHOICES.findIndex((choice)=>choice.value === ceiling);
    return {
        id: 'effort',
        get label() { return t("chat.orca.copy.reasoning_effort", "Reasoning effort"); },
        category: 'thought_level',
        kind: {
            type: 'select',
            choices: GROK_EFFORT_CHOICES.slice(0, ceilingIndex + 1),
            defaultValue: 'high'
        },
        apply: {
            launchArgs: (value)=>[
                    '--reasoning-effort',
                    String(value)
                ],
            agentArgsOverride: (tokens)=>hasFlag(tokens, [
                    '--effort',
                    '--reasoning-effort'
                ]),
            midSession: {
                kind: 'command',
                build: (value)=>`/effort ${String(value)}` // i18n-ignore
            }
        }
    };
}
function parseGrokCatalogModels(stdout) {
    return parseGrokModelList(stdout).map((model)=>({
            ...model,
            options: []
        }));
}
export const GROK_SESSION_OPTION_CATALOG = {
    models: [
        {
            id: 'grok-4.6',
            label: 'Grok 4.6',
            get description() { return t("chat.orca.copy.xai_s_latest_frontier_model", "xAI's latest frontier model"); },
            isDefault: true,
            options: [
                grokEffort('xhigh')
            ]
        },
        {
            id: 'grok-4.5',
            label: 'Grok 4.5',
            get description() { return t("chat.orca.copy.xai_s_previous_frontier_model", "xAI's previous frontier model"); },
            options: [
                grokEffort('high')
            ]
        }
    ],
    modelApply: {
        launchArgs: (value)=>[
                '-m',
                String(value)
            ],
        agentArgsOverride: (tokens)=>hasFlag(tokens, [
                '-m',
                '--model'
            ]),
        midSession: {
            kind: 'command',
            build: (value)=>`/model ${String(value)}` // i18n-ignore
        }
    },
    unknownModelOptions: [
        grokEffort('xhigh')
    ],
    discoveredModelsAreAuthoritative: true,
    defaultModelIsCliDefault: true,
    listModels: {
        command: 'grok models',
        parse: parseGrokCatalogModels
    }
};
