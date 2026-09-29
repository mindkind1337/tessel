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
import { t } from "../../../../i18n/index.js";
import { ALL_TUI_AGENTS, TUI_AGENT_DISPLAY_NAMES } from "../tui-agent-display-names.js";
import { KEYBINDING_DEFINITION_CORE_1 } from "./definitions-core-1.js";
import { KEYBINDING_DEFINITION_CORE_2 } from "./definitions-core-2.js";
import { KEYBINDING_DEFINITION_CORE_3 } from "./definitions-core-3.js";
import { KEYBINDING_DEFINITION_CORE_4 } from "./definitions-core-4.js";
export function agentTabActionId(agent) {
    return `tab.newAgent.${agent}`; // i18n-ignore
}
function buildAgentTabKeybindingDefinitions() {
    return ALL_TUI_AGENTS.map((agent)=>({
            id: agentTabActionId(agent),
            get title() { return t("chat.orca.copy.new_agent_tab", "New {{agent}} tab", { agent: TUI_AGENT_DISPLAY_NAMES[agent] }); },
            group: 'Agents',
            scope: 'tabs',
            searchKeywords: [
                'shortcut',
                'tab',
                'agent',
                'new',
                'launch',
                agent,
                TUI_AGENT_DISPLAY_NAMES[agent].toLowerCase()
            ],
            defaultBindings: {
                darwin: [],
                linux: [],
                win32: []
            }
        }));
}
export const KEYBINDING_DEFINITIONS = [
    ...KEYBINDING_DEFINITION_CORE_1,
    ...KEYBINDING_DEFINITION_CORE_2,
    ...KEYBINDING_DEFINITION_CORE_3,
    ...KEYBINDING_DEFINITION_CORE_4,
    ...buildAgentTabKeybindingDefinitions()
];
export const LEGACY_TAB_SWITCH_BINDINGS = {
    'tab.nextSameType': [
        'Mod+Shift+BracketRight'
    ],
    'tab.previousSameType': [
        'Mod+Shift+BracketLeft'
    ],
    'tab.nextAllTypes': [
        'Mod+Alt+BracketRight'
    ],
    'tab.previousAllTypes': [
        'Mod+Alt+BracketLeft'
    ]
};
export const DEFINITIONS_BY_ID = new Map(KEYBINDING_DEFINITIONS.map((definition)=>[
        definition.id,
        definition
    ]));
const DEFINITION_IDS = new Set(KEYBINDING_DEFINITIONS.map((definition)=>definition.id));
export const DIGIT_INDEX_ACTION_IDS = [
    'tab.selectByIndex',
    'workspace.selectByIndex'
];
export const DIGIT_INDEX_KEY_PATTERN = /^[1-9]$/;
export function isDigitIndexActionId(actionId) {
    return DIGIT_INDEX_ACTION_IDS.includes(actionId);
}
export function isKeybindingActionId(value) {
    return DEFINITION_IDS.has(value) || isPluginKeybindingActionId(value);
}
export function isPluginKeybindingActionId(value) {
    return value.length <= 400 && /^plugin:[a-z0-9]+(?:-[a-z0-9]+)*\.[a-z0-9]+(?:-[a-z0-9]+)*\/[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/.test(value);
}
export function getKeybindingDefinition(actionId) {
    return DEFINITIONS_BY_ID.get(actionId) ?? null;
}
export function getKeybindingPlatform(platform) {
    return platform === 'darwin' ? 'darwin' : platform === 'win32' ? 'win32' : 'linux';
}
