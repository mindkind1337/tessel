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
import { agentArgOptionTokens, removeAgentArgOption } from "./agent-session-option-agent-args.js";
import { CLAUDE_MODEL_LIST_ARGS, CLAUDE_MODEL_LIST_STDIN, parseClaudeModelList } from "./claude-model-list-probe.js";
import { hasFlag } from "./agent-cli-flag-detection.js";
function hasCodexEffortOverride(tokens) {
    if (hasFlag(tokens, [
        '--reasoning-effort'
    ])) {
        return true;
    }
    const optionTokens = agentArgOptionTokens(tokens);
    return optionTokens.some((token, index)=>{
        const previous = optionTokens[index - 1];
        return token.startsWith('model_reasoning_effort=') && (previous === '-c' || previous === '--config') || token.startsWith('-cmodel_reasoning_effort=') || token.startsWith('-c=model_reasoning_effort=') || token.startsWith('--config=model_reasoning_effort=');
    });
}
function removeCodexEffortOverride(tokens) {
    const withoutFlag = removeAgentArgOption(tokens, [
        '--reasoning-effort'
    ]);
    const result = [];
    for(let index = 0; index < withoutFlag.length; index += 1){
        const token = withoutFlag[index];
        if (token === '--') {
            result.push(...withoutFlag.slice(index));
            break;
        }
        const next = withoutFlag[index + 1];
        if ((token === '-c' || token === '--config') && next?.startsWith('model_reasoning_effort=')) {
            index += 1;
            continue;
        }
        if (token.startsWith('-cmodel_reasoning_effort=') || token.startsWith('-c=model_reasoning_effort=') || token.startsWith('--config=model_reasoning_effort=')) {
            continue;
        }
        result.push(token);
    }
    return result;
}
const STANDARD_EFFORT_CHOICES = [
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
];
const EXTENDED_EFFORT_CHOICES = [
    ...STANDARD_EFFORT_CHOICES,
    {
        value: 'xhigh',
        get label() { return t("chat.orca.copy.extra_high", "Extra high"); }
    },
    {
        value: 'max',
        get label() { return t("chat.orca.copy.max", "Max"); }
    }
];
function claudeEffort(extended) {
    return claudeEffortWithChoices(extended ? EXTENDED_EFFORT_CHOICES : STANDARD_EFFORT_CHOICES);
}
function claudeEffortWithChoices(choices) {
    return {
        id: 'effort',
        get label() { return t("chat.orca.copy.effort", "Effort"); },
        category: 'thought_level',
        kind: {
            type: 'select',
            choices,
            defaultValue: choices.some((choice)=>choice.value === 'high') ? 'high' : choices[0]?.value ?? 'high'
        },
        apply: {
            launchArgs: (value)=>[
                    '--effort',
                    String(value)
                ],
            agentArgsOverride: (tokens)=>hasFlag(tokens, [
                    '--effort'
                ]),
            removeAgentArgs: (tokens)=>removeAgentArgOption(tokens, [
                    '--effort'
                ]),
            midSession: {
                kind: 'command',
                build: (value)=>`/effort ${String(value)}` // i18n-ignore
            }
        }
    };
}
export function createClaudeCatalogOptions(args) {
    const effortChoices = EXTENDED_EFFORT_CHOICES.filter((choice)=>args.effortLevelIds.includes(choice.value));
    return [
        ...effortChoices.length > 0 ? [
            claudeEffortWithChoices(effortChoices)
        ] : [],
        ...args.supportsFastMode ? [
            CLAUDE_FAST_MODE
        ] : []
    ];
}
function parseClaudeCatalogModels(stdout) {
    return parseClaudeModelList(stdout).map((model)=>{
        return {
            id: model.id,
            label: model.label,
            ...model.description ? {
                description: model.description
            } : {},
            options: createClaudeCatalogOptions({
                effortLevelIds: model.effortLevels,
                supportsFastMode: model.supportsFastMode
            })
        };
    });
}
const CLAUDE_FAST_MODE = {
    id: 'fastMode',
    get label() { return t("chat.orca.copy.fast_mode", "Fast mode"); },
    category: 'mode',
    kind: {
        type: 'boolean',
        defaultValue: false
    },
    apply: {
        midSession: {
            kind: 'toggle-command',
            command: '/fast'
        }
    }
};
export const CLAUDE_SESSION_OPTION_CATALOG = {
    supportsWorkerLaunchPreferences: true,
    models: [
        {
            id: 'fable',
            label: 'Fable',
            get description() { return t("chat.orca.copy.most_capable_for_the_hardest_longest_running_tasks", "Most capable for the hardest, longest-running tasks"); },
            options: [
                claudeEffort(true)
            ]
        },
        {
            id: 'opus',
            label: 'Opus',
            get description() { return t("chat.orca.copy.best_for_everyday_complex_tasks", "Best for everyday, complex tasks"); },
            options: [
                claudeEffort(true),
                CLAUDE_FAST_MODE
            ]
        },
        {
            id: 'sonnet',
            label: 'Sonnet',
            get description() { return t("chat.orca.copy.efficient_for_routine_tasks", "Efficient for routine tasks"); },
            isDefault: true,
            options: [
                claudeEffort(true)
            ]
        },
        {
            id: 'haiku',
            label: 'Haiku',
            get description() { return t("chat.orca.copy.fastest_for_quick_answers", "Fastest for quick answers"); },
            options: []
        }
    ],
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
            ]),
        midSession: {
            kind: 'command',
            build: (value)=>`/model ${String(value)}`, // i18n-ignore
            pickerCommand: '/model',
            detectAgentInteraction: 'claude-model-switch-confirmation'
        }
    },
    unknownModelOptions: [
        claudeEffort(true)
    ],
    listModels: {
        command: `echo '${CLAUDE_MODEL_LIST_STDIN.trim()}' | claude ${CLAUDE_MODEL_LIST_ARGS.join(' ')}`, // i18n-ignore
        parse: parseClaudeCatalogModels
    }
};
const CODEX_EFFORT_CHOICES = [
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
];
function codexEffort(ceiling) {
    const ceilingIndex = CODEX_EFFORT_CHOICES.findIndex((choice)=>choice.value === ceiling);
    return {
        id: 'effort',
        get label() { return t("chat.orca.copy.reasoning_effort", "Reasoning effort"); },
        category: 'thought_level',
        kind: {
            type: 'select',
            choices: CODEX_EFFORT_CHOICES.slice(0, ceilingIndex + 1),
            defaultValue: 'medium'
        },
        apply: {
            launchArgs: (value)=>[
                    '-c',
                    `model_reasoning_effort=${String(value)}` // i18n-ignore
                ],
            agentArgsOverride: hasCodexEffortOverride,
            removeAgentArgs: removeCodexEffortOverride,
            midSession: {
                kind: 'agent-picker',
                command: '/model',
                delivery: 'type'
            }
        }
    };
}
export const CODEX_SESSION_OPTION_CATALOG = {
    supportsWorkerLaunchPreferences: true,
    models: [
        {
            id: 'gpt-5.6-sol',
            label: 'GPT-5.6 Sol',
            options: [
                codexEffort('ultra')
            ]
        },
        {
            id: 'gpt-5.6-terra',
            label: 'GPT-5.6 Terra',
            options: [
                codexEffort('ultra')
            ]
        },
        {
            id: 'gpt-5.6-luna',
            label: 'GPT-5.6 Luna',
            options: [
                codexEffort('max')
            ]
        },
        {
            id: 'gpt-5.5',
            label: 'GPT-5.5',
            options: [
                codexEffort('xhigh')
            ]
        },
        {
            id: 'gpt-5.2-codex',
            label: 'GPT-5.2 Codex',
            options: [
                codexEffort('xhigh')
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
        removeAgentArgs: (tokens)=>removeAgentArgOption(tokens, [
                '-m',
                '--model'
            ]),
        midSession: {
            kind: 'agent-picker',
            command: '/model',
            delivery: 'type'
        }
    },
    unknownModelOptions: [
        codexEffort('xhigh')
    ]
};
