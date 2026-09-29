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
export const KEYBINDING_DEFINITION_CORE_2 = [
    {
        id: 'floatingWorkspace.minimize',
        get title() { return t("chat.orca.copy.minimize_floating_workspace_panel", "Minimize Floating Workspace Panel"); },
        group: 'Global',
        scope: 'global',
        searchKeywords: [
            'shortcut',
            'floating',
            'workspace',
            'panel',
            'floating workspace',
            'workspace panel',
            'minimize',
            'hide'
        ],
        defaultBindings: {
            darwin: [],
            linux: [],
            win32: []
        },
        allowInTerminal: true
    },
    {
        id: 'zoom.in',
        get title() { return t("chat.orca.copy.zoom_in", "Zoom In"); },
        group: 'Global',
        scope: 'global',
        searchKeywords: [
            'shortcut',
            'zoom',
            'in',
            'scale'
        ],
        defaultBindings: platformBindings([
            'Mod+Equal',
            'Mod+Shift+Plus',
            'Mod+NumpadAdd'
        ])
    },
    {
        id: 'zoom.out',
        get title() { return t("chat.orca.copy.zoom_out", "Zoom Out"); },
        group: 'Global',
        scope: 'global',
        searchKeywords: [
            'shortcut',
            'zoom',
            'out',
            'scale'
        ],
        defaultBindings: platformBindings([
            'Mod+Minus',
            'Mod+NumpadSubtract'
        ])
    },
    {
        id: 'zoom.reset',
        get title() { return t("chat.orca.copy.reset_size", "Reset Size"); },
        group: 'Global',
        scope: 'global',
        searchKeywords: [
            'shortcut',
            'zoom',
            'reset',
            'size',
            'actual'
        ],
        defaultBindings: platformBindings([
            'Mod+0'
        ])
    },
    {
        id: 'worktree.history.back',
        get title() { return t("chat.orca.copy.worktree_history_back", "Worktree History Back"); },
        group: 'Global',
        scope: 'global',
        searchKeywords: [
            'shortcut',
            'worktree',
            'history',
            'back'
        ],
        defaultBindings: platformBindings([
            'Mod+Alt+ArrowLeft'
        ]),
        allowInTerminal: true
    },
    {
        id: 'worktree.history.forward',
        get title() { return t("chat.orca.copy.worktree_history_forward", "Worktree History Forward"); },
        group: 'Global',
        scope: 'global',
        searchKeywords: [
            'shortcut',
            'worktree',
            'history',
            'forward'
        ],
        defaultBindings: platformBindings([
            'Mod+Alt+ArrowRight'
        ]),
        allowInTerminal: true
    },
    {
        id: 'tab.newTerminal',
        get title() { return t("chat.orca.copy.new_terminal_tab", "New terminal tab"); },
        group: 'Tabs',
        scope: 'tabs',
        searchKeywords: [
            'shortcut',
            'tab',
            'terminal',
            'new'
        ],
        defaultBindings: platformBindings([
            'Mod+T'
        ])
    },
    {
        id: 'tab.newAgent',
        get title() { return t("chat.orca.copy.new_agent_tab_default_agent", "New agent tab (default agent)"); },
        group: 'Tabs',
        scope: 'tabs',
        searchKeywords: [
            'shortcut',
            'tab',
            'agent',
            'new',
            'default',
            'launch'
        ],
        defaultBindings: {
            darwin: [
                'Mod+Alt+T'
            ],
            linux: [],
            win32: []
        }
    },
    {
        id: 'tab.newBrowser',
        get title() { return t("chat.orca.copy.new_browser_tab", "New browser tab"); },
        group: 'Tabs',
        scope: 'tabs',
        searchKeywords: [
            'shortcut',
            'tab',
            'browser',
            'new'
        ],
        defaultBindings: platformBindings([
            'Mod+Shift+B'
        ])
    },
    {
        id: 'tab.newSimulator',
        get title() { return t("chat.orca.copy.new_mobile_emulator_tab", "New mobile emulator tab"); },
        group: 'Tabs',
        scope: 'tabs',
        searchKeywords: [
            'shortcut',
            'tab',
            'simulator',
            'emulator',
            'mobile',
            'ios',
            'new'
        ],
        defaultBindings: {
            darwin: [
                'Mod+Alt+Shift+E'
            ],
            linux: [],
            win32: []
        }
    },
    {
        id: 'tab.newMarkdown',
        get title() { return t("chat.orca.copy.new_markdown_tab", "New markdown tab"); },
        group: 'Tabs',
        scope: 'tabs',
        searchKeywords: [
            'shortcut',
            'tab',
            'markdown',
            'file',
            'new'
        ],
        defaultBindings: platformBindings([
            'Mod+Shift+M'
        ])
    },
    {
        id: 'tab.openMarkdown',
        get title() { return t("chat.orca.copy.open_markdown_tab", "Open markdown tab"); },
        group: 'Tabs',
        scope: 'tabs',
        searchKeywords: [
            'shortcut',
            'tab',
            'markdown',
            'file',
            'open'
        ],
        defaultBindings: platformBindings([
            'Mod+Shift+O'
        ])
    },
    {
        id: 'tab.close',
        get title() { return t("chat.orca.copy.close_active_tab", "Close active tab"); },
        group: 'Tabs',
        scope: 'tabs',
        searchKeywords: [
            'shortcut',
            'close',
            'tab',
            'pane'
        ],
        defaultBindings: platformBindings([
            'Mod+W'
        ])
    },
    {
        id: 'tab.closeAll',
        get title() { return t("chat.orca.copy.close_all_editor_tabs", "Close all editor tabs"); },
        group: 'Tabs',
        scope: 'tabs',
        searchKeywords: [
            'shortcut',
            'close',
            'all',
            'tabs',
            'files',
            'editors'
        ],
        defaultBindings: platformBindings([
            'Mod+Alt+W'
        ])
    },
    {
        id: 'tab.rename',
        get title() { return t("chat.orca.copy.rename_active_tab", "Rename active tab"); },
        group: 'Tabs',
        scope: 'tabs',
        conflictGroup: 'workspace-shell',
        searchKeywords: [
            'shortcut',
            'tab',
            'rename',
            'title',
            'label'
        ],
        defaultBindings: {
            darwin: [
                'Mod+R'
            ],
            linux: [],
            win32: []
        }
    },
    {
        id: 'tab.reopenClosed',
        get title() { return t("chat.orca.copy.reopen_closed_tab", "Reopen closed tab"); },
        group: 'Tabs',
        scope: 'tabs',
        searchKeywords: [
            'shortcut',
            'tab',
            'reopen',
            'restore',
            'closed'
        ],
        defaultBindings: platformBindings([
            'Mod+Shift+T'
        ])
    },
    {
        id: 'tab.nextSameType',
        get title() { return t("chat.orca.copy.next_tab_same_type", "Next tab (same type)"); },
        group: t("chat.orca.copy.tab_navigation", "Tab Navigation"),
        scope: 'tabs',
        searchKeywords: [
            'shortcut',
            'tab',
            'next',
            'switch',
            'cycle'
        ],
        defaultBindings: platformBindings([
            'Mod+Alt+BracketRight'
        ])
    },
    {
        id: 'tab.previousSameType',
        get title() { return t("chat.orca.copy.previous_tab_same_type", "Previous tab (same type)"); },
        group: t("chat.orca.copy.tab_navigation", "Tab Navigation"),
        scope: 'tabs',
        searchKeywords: [
            'shortcut',
            'tab',
            'previous',
            'switch',
            'cycle'
        ],
        defaultBindings: platformBindings([
            'Mod+Alt+BracketLeft'
        ])
    },
    {
        id: 'tab.nextAllTypes',
        get title() { return t("chat.orca.copy.next_tab_all_types", "Next tab (all types)"); },
        group: t("chat.orca.copy.tab_navigation", "Tab Navigation"),
        scope: 'tabs',
        searchKeywords: [
            'shortcut',
            'tab',
            'next',
            'switch',
            'cycle',
            'all',
            'any'
        ],
        defaultBindings: platformBindings([
            'Mod+Shift+BracketRight'
        ])
    },
    {
        id: 'tab.previousAllTypes',
        get title() { return t("chat.orca.copy.previous_tab_all_types", "Previous tab (all types)"); },
        group: t("chat.orca.copy.tab_navigation", "Tab Navigation"),
        scope: 'tabs',
        searchKeywords: [
            'shortcut',
            'tab',
            'previous',
            'switch',
            'cycle',
            'all',
            'any'
        ],
        defaultBindings: platformBindings([
            'Mod+Shift+BracketLeft'
        ])
    },
    {
        id: 'tab.previousRecent',
        get title() { return t("chat.orca.copy.previous_recent_tab", "Previous recent tab"); },
        group: t("chat.orca.copy.tab_navigation", "Tab Navigation"),
        scope: 'tabs',
        searchKeywords: [
            'shortcut',
            'tab',
            'recent',
            'mru',
            'switch',
            'last used'
        ],
        defaultBindings: platformBindings([
            'Ctrl+Tab'
        ]),
        allowInTerminal: true
    },
    {
        id: 'tab.nextTerminal',
        get title() { return t("chat.orca.copy.next_terminal_tab", "Next terminal tab"); },
        group: t("chat.orca.copy.tab_navigation", "Tab Navigation"),
        scope: 'tabs',
        searchKeywords: [
            'shortcut',
            'tab',
            'terminal',
            'next',
            'switch'
        ],
        defaultBindings: platformBindings([
            'Ctrl+PageDown'
        ]),
        allowInTerminal: true
    },
    {
        id: 'tab.previousTerminal',
        get title() { return t("chat.orca.copy.previous_terminal_tab", "Previous terminal tab"); },
        group: t("chat.orca.copy.tab_navigation", "Tab Navigation"),
        scope: 'tabs',
        searchKeywords: [
            'shortcut',
            'tab',
            'terminal',
            'previous',
            'switch'
        ],
        defaultBindings: platformBindings([
            'Ctrl+PageUp'
        ]),
        allowInTerminal: true
    },
    {
        id: 'tab.selectByIndex',
        get title() { return t("chat.orca.copy.select_tab_1_9", "Select Tab 1–9"); },
        group: t("chat.orca.copy.tab_navigation", "Tab Navigation"),
        scope: 'tabs',
        searchKeywords: [
            'shortcut',
            'tab',
            'select',
            'switch',
            'number',
            'digit',
            '1-9',
            'index'
        ],
        defaultBindings: {
            darwin: [
                'Ctrl+1'
            ],
            linux: [
                'Alt+1'
            ],
            win32: [
                'Alt+1'
            ]
        }
    },
    {
        id: 'tab.openQuickCommandsMenu',
        get title() { return t("chat.orca.copy.toggle_quick_commands_menu", "Toggle Quick Commands menu"); },
        group: t("chat.orca.copy.quick_commands", "Quick Commands"),
        scope: 'tabs',
        conflictGroup: 'global',
        searchKeywords: [
            'shortcut',
            'quick',
            'command',
            'menu',
            'tab',
            'group',
            'toggle'
        ],
        defaultBindings: platformBindings([])
    },
    {
        id: 'browser.find',
        get title() { return t("chat.orca.copy.find_in_browser", "Find in Browser"); },
        group: 'Browser',
        scope: 'browser',
        searchKeywords: [
            'shortcut',
            'browser',
            'find',
            'search'
        ],
        defaultBindings: platformBindings([
            'Mod+F'
        ])
    },
    {
        id: 'browser.back',
        get title() { return t("chat.orca.copy.go_back_in_browser", "Go Back in Browser"); },
        group: 'Browser',
        scope: 'browser',
        searchKeywords: [
            'shortcut',
            'browser',
            'history',
            'back',
            'previous'
        ],
        defaultBindings: {
            darwin: [
                'Mod+BracketLeft'
            ],
            linux: [
                'Alt+ArrowLeft'
            ],
            win32: [
                'Alt+ArrowLeft'
            ]
        }
    },
    {
        id: 'browser.forward',
        get title() { return t("chat.orca.copy.go_forward_in_browser", "Go Forward in Browser"); },
        group: 'Browser',
        scope: 'browser',
        searchKeywords: [
            'shortcut',
            'browser',
            'history',
            'forward',
            'next'
        ],
        defaultBindings: {
            darwin: [
                'Mod+BracketRight'
            ],
            linux: [
                'Alt+ArrowRight'
            ],
            win32: [
                'Alt+ArrowRight'
            ]
        }
    }
];
