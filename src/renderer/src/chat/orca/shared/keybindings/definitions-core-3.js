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
export const KEYBINDING_DEFINITION_CORE_3 = [
    {
        id: 'browser.reload',
        get title() { return t("chat.orca.copy.reload_browser_page", "Reload Browser Page"); },
        group: 'Browser',
        scope: 'browser',
        searchKeywords: [
            'shortcut',
            'browser',
            'reload',
            'refresh'
        ],
        defaultBindings: platformBindings([
            'Mod+R'
        ])
    },
    {
        id: 'browser.hardReload',
        get title() { return t("chat.orca.copy.hard_reload_browser_page", "Hard Reload Browser Page"); },
        group: 'Browser',
        scope: 'browser',
        searchKeywords: [
            'shortcut',
            'browser',
            'reload',
            'refresh',
            'cache'
        ],
        defaultBindings: platformBindings([
            'Mod+Shift+R'
        ])
    },
    {
        id: 'browser.focusAddressBar',
        get title() { return t("chat.orca.copy.focus_browser_address_bar", "Focus Browser Address Bar"); },
        group: 'Browser',
        scope: 'browser',
        searchKeywords: [
            'shortcut',
            'browser',
            'address',
            'url',
            'location'
        ],
        defaultBindings: platformBindings([
            'Mod+L'
        ])
    },
    {
        id: 'browser.grabElement',
        get title() { return t("chat.orca.copy.grab_page_element", "Grab Page Element"); },
        group: 'Browser',
        scope: 'browser',
        searchKeywords: [
            'shortcut',
            'browser',
            'grab',
            'copy',
            'element'
        ],
        defaultBindings: platformBindings([
            'Mod+C'
        ])
    },
    {
        id: 'editor.find',
        get title() { return t("chat.orca.copy.find_in_editor", "Find in editor"); },
        group: 'Editors',
        scope: 'editor',
        searchKeywords: [
            'shortcut',
            'editor',
            'find',
            'search'
        ],
        defaultBindings: platformBindings([
            'Mod+F'
        ])
    },
    {
        id: 'editor.replace',
        get title() { return t("chat.orca.copy.replace_in_editor", "Replace in editor"); },
        group: 'Editors',
        scope: 'editor',
        searchKeywords: [
            'shortcut',
            'editor',
            'replace',
            'find',
            'search'
        ],
        defaultBindings: {
            darwin: [
                'Mod+Alt+F'
            ],
            linux: [
                'Mod+H'
            ],
            win32: [
                'Mod+H'
            ]
        }
    },
    {
        id: 'editor.save',
        get title() { return t("chat.orca.copy.save_file", "Save File"); },
        group: 'Editors',
        scope: 'editor',
        searchKeywords: [
            'shortcut',
            'editor',
            'save'
        ],
        defaultBindings: platformBindings([
            'Mod+S'
        ])
    },
    {
        id: 'editor.markdownPreview',
        get title() { return t("chat.orca.copy.show_markdown_preview", "Show Markdown Preview"); },
        group: 'Editors',
        scope: 'editor',
        searchKeywords: [
            'shortcut',
            'editor',
            'markdown',
            'preview'
        ],
        defaultBindings: platformBindings([
            'Mod+Shift+V'
        ])
    },
    {
        id: 'editor.toggleWordWrap',
        get title() { return t("chat.orca.copy.toggle_word_wrap", "Toggle Word Wrap"); },
        group: 'Editors',
        scope: 'editor',
        searchKeywords: [
            'shortcut',
            'editor',
            'word wrap',
            'wrap',
            'long lines',
            'soft wrap'
        ],
        defaultBindings: platformBindings([
            'Alt+Z'
        ])
    },
    {
        id: 'editor.copyContext',
        get title() { return t("chat.orca.copy.copy_context", "Copy Context"); },
        group: 'Editors',
        scope: 'editor',
        searchKeywords: [
            'shortcut',
            'editor',
            'copy',
            'context'
        ],
        defaultBindings: platformBindings([
            'Mod+Alt+C'
        ])
    },
    {
        id: 'editor.previousChange',
        get title() { return t("chat.orca.copy.go_to_previous_change", "Go to Previous Change"); },
        group: 'Editors',
        scope: 'editor',
        searchKeywords: [
            'shortcut',
            'editor',
            'diff',
            'change',
            'hunk',
            'previous'
        ],
        defaultBindings: platformBindings([
            'Shift+F7'
        ]),
        allowBareKeybindings: true
    },
    {
        id: 'editor.nextChange',
        get title() { return t("chat.orca.copy.go_to_next_change", "Go to Next Change"); },
        group: 'Editors',
        scope: 'editor',
        searchKeywords: [
            'shortcut',
            'editor',
            'diff',
            'change',
            'hunk',
            'next'
        ],
        defaultBindings: platformBindings([
            'F7'
        ]),
        allowBareKeybindings: true
    },
    {
        id: 'editor.addReviewNote',
        get title() { return t("chat.orca.copy.add_review_note", "Add Review Note"); },
        group: 'Editors',
        scope: 'editor',
        searchKeywords: [
            'shortcut',
            'editor',
            'markdown',
            'note',
            'comment',
            'annotation',
            'review'
        ],
        defaultBindings: platformBindings([
            'Mod+Shift+A'
        ])
    },
    {
        id: 'sourceControl.sendReviewNotes',
        get title() { return t("chat.orca.copy.send_review_notes_to_agent", "Send Review Notes to Agent"); },
        group: 'Global',
        scope: 'global',
        conflictGroup: 'editor',
        searchKeywords: [
            'shortcut',
            'source control',
            'diff',
            'notes',
            'send',
            'agent',
            'review',
            'annotate'
        ],
        defaultBindings: platformBindings([])
    },
    {
        id: 'fileExplorer.undo',
        get title() { return t("chat.orca.copy.undo_file_operation", "Undo file operation"); },
        group: t("chat.orca.copy.file_explorer", "File Explorer"),
        scope: 'fileExplorer',
        searchKeywords: [
            'shortcut',
            'file explorer',
            'undo'
        ],
        defaultBindings: platformBindings([
            'Mod+Z'
        ])
    },
    {
        id: 'fileExplorer.redo',
        get title() { return t("chat.orca.copy.redo_file_operation", "Redo file operation"); },
        group: t("chat.orca.copy.file_explorer", "File Explorer"),
        scope: 'fileExplorer',
        searchKeywords: [
            'shortcut',
            'file explorer',
            'redo'
        ],
        defaultBindings: {
            darwin: [
                'Mod+Shift+Z'
            ],
            linux: [
                'Mod+Shift+Z',
                'Ctrl+Y'
            ],
            win32: [
                'Mod+Shift+Z',
                'Ctrl+Y'
            ]
        }
    },
    {
        id: 'fileExplorer.copyPath',
        get title() { return t("chat.orca.copy.copy_file_path", "Copy file path"); },
        group: t("chat.orca.copy.file_explorer", "File Explorer"),
        scope: 'fileExplorer',
        searchKeywords: [
            'shortcut',
            'file explorer',
            'copy',
            'path'
        ],
        defaultBindings: {
            darwin: [
                'Mod+Alt+C'
            ],
            linux: [
                'Alt+Shift+C'
            ],
            win32: [
                'Alt+Shift+C'
            ]
        }
    },
    {
        id: 'fileExplorer.copyRelativePath',
        get title() { return t("chat.orca.copy.copy_relative_file_path", "Copy relative file path"); },
        group: t("chat.orca.copy.file_explorer", "File Explorer"),
        scope: 'fileExplorer',
        searchKeywords: [
            'shortcut',
            'file explorer',
            'copy',
            'relative',
            'path'
        ],
        defaultBindings: platformBindings([
            'Mod+Alt+Shift+C'
        ])
    },
    {
        id: 'fileExplorer.delete',
        get title() { return t("chat.orca.copy.delete_file", "Delete file"); },
        group: t("chat.orca.copy.file_explorer", "File Explorer"),
        scope: 'fileExplorer',
        searchKeywords: [
            'shortcut',
            'file explorer',
            'delete',
            'remove',
            'trash'
        ],
        defaultBindings: {
            darwin: [
                'Mod+Backspace',
                'Delete'
            ],
            linux: [
                'Delete'
            ],
            win32: [
                'Delete'
            ]
        },
        allowBareKeybindings: true
    },
    {
        id: 'settings.search',
        get title() { return t("chat.orca.copy.search_settings", "Search Settings"); },
        group: 'Settings',
        scope: 'settings',
        searchKeywords: [
            'shortcut',
            'settings',
            'search',
            'find'
        ],
        defaultBindings: platformBindings([
            'Mod+F'
        ])
    },
    {
        id: 'terminal.copySelection',
        get title() { return t("chat.orca.copy.copy_terminal_selection", "Copy terminal selection"); },
        group: t("chat.orca.copy.terminal_panes", "Terminal Panes"),
        scope: 'terminal',
        searchKeywords: [
            'shortcut',
            'terminal',
            'copy',
            'selection'
        ],
        defaultBindings: {
            darwin: [
                'Mod+C'
            ],
            linux: [
                'Ctrl+Shift+C',
                'Ctrl+C'
            ],
            win32: [
                'Ctrl+Shift+C',
                'Ctrl+C'
            ]
        }
    },
    {
        id: 'terminal.selectAll',
        get title() { return t("chat.orca.copy.select_all_terminal_text", "Select all terminal text"); },
        group: t("chat.orca.copy.terminal_panes", "Terminal Panes"),
        scope: 'terminal',
        searchKeywords: [
            'shortcut',
            'terminal',
            'select',
            'all'
        ],
        defaultBindings: {
            darwin: [
                'Mod+A'
            ],
            linux: [
                'Ctrl+Shift+A'
            ],
            win32: [
                'Ctrl+Shift+A'
            ]
        }
    },
    {
        id: 'terminal.paste',
        get title() { return t("chat.orca.copy.paste_into_terminal", "Paste into terminal"); },
        group: t("chat.orca.copy.terminal_panes", "Terminal Panes"),
        scope: 'terminal',
        searchKeywords: [
            'shortcut',
            'terminal',
            'paste',
            'clipboard'
        ],
        defaultBindings: {
            darwin: [
                'Mod+V'
            ],
            linux: [
                'Ctrl+V',
                'Ctrl+Shift+V',
                'Shift+Insert'
            ],
            win32: [
                'Ctrl+V',
                'Ctrl+Shift+V',
                'Shift+Insert'
            ]
        }
    },
    {
        id: 'terminal.search',
        get title() { return t("chat.orca.copy.search_active_pane", "Search active pane"); },
        group: t("chat.orca.copy.terminal_panes", "Terminal Panes"),
        scope: 'terminal',
        searchKeywords: [
            'shortcut',
            'terminal',
            'search',
            'find'
        ],
        defaultBindings: platformBindings([
            'Mod+F'
        ])
    },
    {
        id: 'terminal.clear',
        get title() { return t("chat.orca.copy.clear_active_pane", "Clear active pane"); },
        group: t("chat.orca.copy.terminal_panes", "Terminal Panes"),
        scope: 'terminal',
        searchKeywords: [
            'shortcut',
            'pane',
            'clear'
        ],
        defaultBindings: platformBindings([
            'Mod+K'
        ])
    },
    {
        id: 'terminal.focusNextPane',
        get title() { return t("chat.orca.copy.focus_next_pane", "Focus next pane"); },
        group: t("chat.orca.copy.terminal_panes", "Terminal Panes"),
        scope: 'terminal',
        searchKeywords: [
            'shortcut',
            'pane',
            'focus',
            'next'
        ],
        defaultBindings: platformBindings([
            'Mod+BracketRight'
        ])
    },
    {
        id: 'terminal.focusPreviousPane',
        get title() { return t("chat.orca.copy.focus_previous_pane", "Focus previous pane"); },
        group: t("chat.orca.copy.terminal_panes", "Terminal Panes"),
        scope: 'terminal',
        searchKeywords: [
            'shortcut',
            'pane',
            'focus',
            'previous'
        ],
        defaultBindings: platformBindings([
            'Mod+BracketLeft'
        ])
    },
    {
        id: 'terminal.equalizePaneSizes',
        get title() { return t("chat.orca.copy.equalize_pane_sizes", "Equalize pane sizes"); },
        group: t("chat.orca.copy.terminal_panes", "Terminal Panes"),
        scope: 'terminal',
        searchKeywords: [
            'shortcut',
            'pane',
            'split',
            'equalize',
            'resize',
            'balance',
            'size'
        ],
        defaultBindings: platformBindings([])
    },
    {
        id: 'terminal.expandPane',
        get title() { return t("chat.orca.copy.expand_collapse_pane", "Expand / collapse pane"); },
        group: t("chat.orca.copy.terminal_panes", "Terminal Panes"),
        scope: 'terminal',
        searchKeywords: [
            'shortcut',
            'pane',
            'expand',
            'collapse'
        ],
        defaultBindings: platformBindings([
            'Mod+Shift+Enter'
        ])
    },
    {
        id: 'terminal.setTitle',
        get title() { return t("chat.orca.copy.set_title", "Set Title…"); },
        group: t("chat.orca.copy.terminal_panes", "Terminal Panes"),
        scope: 'terminal',
        searchKeywords: [
            'shortcut',
            'terminal',
            'pane',
            'set title',
            'title',
            'rename'
        ],
        defaultBindings: platformBindings([])
    }
];
