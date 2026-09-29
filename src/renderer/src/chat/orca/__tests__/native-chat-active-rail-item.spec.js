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
import { describe, expect, it } from 'vitest';
import { findActiveNativeChatRailItem } from "../native-chat-active-rail-item.js";
function rows(count, height = 100) {
    return Array.from({
        length: count
    }, (_unused, index)=>({
            index,
            start: index * height,
            end: index * height + height
        }));
}
const TURNS = [
    {
        turnKey: 'u1'
    },
    {
        turnKey: 'u1'
    },
    {
        turnKey: 'u1'
    },
    {
        turnKey: 'u1'
    },
    {
        turnKey: 'u2'
    },
    {
        turnKey: 'u2'
    },
    {
        turnKey: 'u2'
    },
    {
        turnKey: 'u2'
    },
    {
        turnKey: 'u2'
    },
    {
        turnKey: 'u2'
    }
];
const VIEWPORT = 300;
const MID_SCROLL = {
    clientHeight: VIEWPORT,
    scrollHeight: 1000,
    previousActiveId: null
};
describe('active rail item', ()=>{
    it('keeps the owning prompt lit while an agent reply fills the viewport', ()=>{
        expect(findActiveNativeChatRailItem({
            slots: TURNS,
            virtualItems: rows(10),
            scrollTop: 250,
            ...MID_SCROLL
        })).toBe('u1');
    });
    it('moves to the next prompt once its turn reaches the fold', ()=>{
        expect(findActiveNativeChatRailItem({
            slots: TURNS,
            virtualItems: rows(10),
            scrollTop: 450,
            ...MID_SCROLL
        })).toBe('u2');
    });
    it('selects the row the fold sits exactly on', ()=>{
        expect(findActiveNativeChatRailItem({
            slots: TURNS,
            virtualItems: rows(10),
            scrollTop: 400,
            ...MID_SCROLL
        })).toBe('u2');
    });
    it('lights the newest turn when pinned to the bottom', ()=>{
        expect(findActiveNativeChatRailItem({
            slots: TURNS,
            virtualItems: rows(10),
            scrollTop: 700,
            clientHeight: VIEWPORT,
            scrollHeight: 1000,
            previousActiveId: null
        })).toBe('u2');
    });
    it('lights nothing above the first prompt', ()=>{
        expect(findActiveNativeChatRailItem({
            slots: [
                {
                    turnKey: undefined
                },
                {
                    turnKey: undefined
                },
                ...TURNS
            ],
            virtualItems: rows(12),
            scrollTop: 50,
            clientHeight: VIEWPORT,
            scrollHeight: 1200,
            previousActiveId: null
        })).toBeNull();
    });
    it('holds the previous tick when the window is stale', ()=>{
        expect(findActiveNativeChatRailItem({
            slots: TURNS,
            virtualItems: [
                {
                    index: 0,
                    start: 0,
                    end: 100
                }
            ],
            scrollTop: 600,
            clientHeight: VIEWPORT,
            scrollHeight: 4000,
            previousActiveId: 'u1'
        })).toBe('u1');
    });
    it('holds the previous tick when nothing is windowed', ()=>{
        expect(findActiveNativeChatRailItem({
            slots: TURNS,
            virtualItems: [],
            scrollTop: 0,
            clientHeight: VIEWPORT,
            scrollHeight: 1000,
            previousActiveId: 'u2'
        })).toBe('u2');
    });
    it('keeps a row taller than the viewport active while it spans it', ()=>{
        expect(findActiveNativeChatRailItem({
            slots: [
                {
                    turnKey: 'u1'
                }
            ],
            virtualItems: [
                {
                    index: 0,
                    start: 0,
                    end: 2000
                }
            ],
            scrollTop: 800,
            clientHeight: VIEWPORT,
            scrollHeight: 4000,
            previousActiveId: null
        })).toBe('u1');
    });
    it('reads offsets in container space, margin included', ()=>{
        const margin = 500;
        expect(findActiveNativeChatRailItem({
            slots: TURNS,
            virtualItems: rows(10).map((row)=>({
                    ...row,
                    start: row.start + margin,
                    end: row.end + margin
                })),
            scrollTop: margin + 450,
            clientHeight: VIEWPORT,
            scrollHeight: 1500,
            previousActiveId: null
        })).toBe('u2');
    });
});
