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
import { platformBindings } from "./definitions-support.js";
export const KEYBINDING_DEFINITION_CORE_4 = [
    {
        id: 'terminal.clearPaneTitle',
        get title() { return t("chat.orca.copy.clear_pane_title", "Clear Pane Title"); },
        group: t("chat.orca.copy.terminal_panes", "Terminal Panes"),
        scope: 'terminal',
        searchKeywords: [
            'shortcut',
            'terminal',
            'pane',
            'clear title',
            'remove title',
            'title'
        ],
        defaultBindings: platformBindings([])
    },
    {
        id: 'terminal.closePane',
        get title() { return t("chat.orca.copy.close_active_pane", "Close active pane"); },
        group: t("chat.orca.copy.terminal_panes", "Terminal Panes"),
        scope: 'terminal',
        searchKeywords: [
            'shortcut',
            'pane',
            'close'
        ],
        defaultBindings: platformBindings([
            'Mod+W'
        ])
    },
    {
        id: 'terminal.splitRight',
        get title() { return t("chat.orca.copy.split_terminal_right", "Split terminal right"); },
        group: t("chat.orca.copy.terminal_panes", "Terminal Panes"),
        scope: 'terminal',
        searchKeywords: [
            'shortcut',
            'pane',
            'split',
            'right'
        ],
        defaultBindings: {
            darwin: [
                'Mod+D'
            ],
            linux: [
                'Mod+Shift+D'
            ],
            win32: [
                'Mod+Shift+D'
            ]
        }
    },
    {
        id: 'terminal.splitDown',
        get title() { return t("chat.orca.copy.split_terminal_down", "Split terminal down"); },
        group: t("chat.orca.copy.terminal_panes", "Terminal Panes"),
        scope: 'terminal',
        searchKeywords: [
            'shortcut',
            'pane',
            'split',
            'down'
        ],
        defaultBindings: {
            darwin: [
                'Mod+Shift+D'
            ],
            linux: [
                'Alt+Shift+D'
            ],
            win32: [
                'Alt+Shift+D'
            ]
        }
    },
    {
        id: 'terminal.switchInputSource',
        get title() { return t("chat.orca.copy.switch_input_source_language_native", "Switch input source / language (native)"); },
        group: t("chat.orca.copy.terminal_panes", "Terminal Panes"),
        scope: 'terminal',
        searchKeywords: [
            'shortcut',
            'input',
            'source',
            'language',
            'korean',
            'english',
            'ime',
            'switch',
            'hangul',
            'layout'
        ],
        defaultBindings: {
            darwin: [],
            linux: [],
            win32: []
        },
        allowShiftOnlyKeybindings: true
    }
];
