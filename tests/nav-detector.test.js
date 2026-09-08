import { describe, it, expect, beforeEach, vi } from 'vitest';

// 預先 mock document 與 window
if (!globalThis.document) {
    globalThis.document = {
        querySelectorAll: () => []
    };
}
if (!globalThis.window) {
    globalThis.window = {
        location: { href: 'https://jmanga.email/read/test/ja/chapter-1-raw/' }
    };
}

import { detectNavigationLinks } from '../src/utils/nav-detector.js';

describe('nav-detector: 章節導航與上一話/下一話推導測試', () => {

    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('JManga 自訂 ul.reading-list 倒序清單：第 1 話時 next 正確推導為第 2 話，prev 為 null', () => {
        globalThis.window.location.href = 'https://jmanga.email/read/%E8%B2%9E%E6%93%8D%E9%80%86%E8%BB%A2%E4%B8%96%E7%95%8C/ja/chapter-1-raw/';

        const mockChapters = [
            { num: '8.2', url: 'https://jmanga.email/read/貞操逆転世界/ja/chapter-8.2-raw/', isCur: false },
            { num: '8.1', url: 'https://jmanga.email/read/貞操逆転世界/ja/chapter-8.1-raw/', isCur: false },
            { num: '2', url: 'https://jmanga.email/read/貞操逆転世界/ja/chapter-2-raw/', isCur: false },
            { num: '1', url: 'https://jmanga.email/read/貞操逆転世界/ja/chapter-1-raw/', isCur: true }
        ];

        const mockLis = mockChapters.map(ch => ({
            tagName: 'LI',
            classList: { contains: (c) => c === 'highlight' && ch.isCur },
            getAttribute: (attr) => attr === 'data-number' ? ch.num : null,
            querySelector: (sel) => sel === 'a' ? {
                href: ch.url,
                getAttribute: (attr) => attr === 'href' ? ch.url : null,
                innerText: ch.num
            } : null
        }));

        const mockUl = {
            tagName: 'UL',
            className: 'ulclear reading-list lang-chapters',
            style: { display: 'block' },
            querySelectorAll: (sel) => sel === 'li' ? mockLis : []
        };

        globalThis.document.querySelectorAll = vi.fn((sel) => {
            if (sel.includes('select')) return [];
            if (sel.includes('reading-list')) return [mockUl];
            if (sel === 'a') return [];
            return [];
        });

        const nav = detectNavigationLinks();

        // 倒序清單：第 1 話的上一項是第 2 話 (較新)，因此 next 為第 2 話
        expect(nav.next).toBe('https://jmanga.email/read/貞操逆転世界/ja/chapter-2-raw/');
        expect(nav.prev).toBeNull();
        expect(nav.currentChapter).toBe('1');
        expect(nav.chapterList).toHaveLength(4);
    });

    it('JManga 自訂清單：中間話數 (第 5 話) 能同時正確推導下一話 (第 6 話) 與上一話 (第 4 話)', () => {
        globalThis.window.location.href = 'https://jmanga.email/read/貞操逆転世界/ja/chapter-5-raw/';

        const mockChapters = [
            { num: '7', url: 'https://jmanga.email/read/貞操逆転世界/ja/chapter-7-raw/', isCur: false },
            { num: '6', url: 'https://jmanga.email/read/貞操逆転世界/ja/chapter-6-raw/', isCur: false },
            { num: '5', url: 'https://jmanga.email/read/貞操逆転世界/ja/chapter-5-raw/', isCur: true },
            { num: '4', url: 'https://jmanga.email/read/貞操逆転世界/ja/chapter-4-raw/', isCur: false },
            { num: '3', url: 'https://jmanga.email/read/貞操逆転世界/ja/chapter-3-raw/', isCur: false }
        ];

        const mockLis = mockChapters.map(ch => ({
            tagName: 'LI',
            classList: { contains: (c) => c === 'active' && ch.isCur },
            getAttribute: (attr) => attr === 'data-number' ? ch.num : null,
            querySelector: (sel) => sel === 'a' ? {
                href: ch.url,
                getAttribute: (attr) => attr === 'href' ? ch.url : null,
                innerText: ch.num
            } : null
        }));

        const mockUl = {
            tagName: 'UL',
            querySelectorAll: (sel) => sel === 'li' ? mockLis : []
        };

        globalThis.document.querySelectorAll = vi.fn((sel) => {
            if (sel.includes('select')) return [];
            if (sel.includes('reading-list')) return [mockUl];
            if (sel === 'a') return [];
            return [];
        });

        const nav = detectNavigationLinks();

        expect(nav.next).toBe('https://jmanga.email/read/貞操逆転世界/ja/chapter-6-raw/');
        expect(nav.prev).toBe('https://jmanga.email/read/貞操逆転世界/ja/chapter-4-raw/');
        expect(nav.currentChapter).toBe('5');
    });

    it('JManga 自訂清單：最新話 (第 8.2 話) 時 next 為 null，prev 為第 8.1 話', () => {
        globalThis.window.location.href = 'https://jmanga.email/read/貞操逆転世界/ja/chapter-8.2-raw/';

        const mockChapters = [
            { num: '8.2', url: 'https://jmanga.email/read/貞操逆転世界/ja/chapter-8.2-raw/', isCur: true },
            { num: '8.1', url: 'https://jmanga.email/read/貞操逆転世界/ja/chapter-8.1-raw/', isCur: false },
            { num: '7', url: 'https://jmanga.email/read/貞操逆転世界/ja/chapter-7-raw/', isCur: false }
        ];

        const mockLis = mockChapters.map(ch => ({
            tagName: 'LI',
            classList: { contains: (c) => c === 'highlight' && ch.isCur },
            getAttribute: (attr) => attr === 'data-number' ? ch.num : null,
            querySelector: (sel) => sel === 'a' ? {
                href: ch.url,
                getAttribute: (attr) => attr === 'href' ? ch.url : null,
                innerText: ch.num
            } : null
        }));

        const mockUl = {
            tagName: 'UL',
            querySelectorAll: (sel) => sel === 'li' ? mockLis : []
        };

        globalThis.document.querySelectorAll = vi.fn((sel) => {
            if (sel.includes('select')) return [];
            if (sel.includes('reading-list')) return [mockUl];
            if (sel === 'a') return [];
            return [];
        });

        const nav = detectNavigationLinks();

        expect(nav.next).toBeNull();
        expect(nav.prev).toBe('https://jmanga.email/read/貞操逆転世界/ja/chapter-8.1-raw/');
    });

    it('傳統 select 下拉選單維持原有相容性', () => {
        globalThis.window.location.href = 'https://example.com/manga/ch2';

        const mockSelect = {
            options: [
                { value: 'https://example.com/manga/ch3', text: 'Chapter 3', selected: false, hasAttribute: () => false },
                { value: 'https://example.com/manga/ch2', text: 'Chapter 2', selected: true, hasAttribute: () => true },
                { value: 'https://example.com/manga/ch1', text: 'Chapter 1', selected: false, hasAttribute: () => false }
            ]
        };

        globalThis.document.querySelectorAll = vi.fn((sel) => {
            if (sel.includes('select')) return [mockSelect];
            if (sel === 'a') return [];
            return [];
        });

        const nav = detectNavigationLinks();
        expect(nav.next).toBe('https://example.com/manga/ch3');
        expect(nav.prev).toBe('https://example.com/manga/ch1');
        expect(nav.currentChapter).toBe('Chapter 2');
    });
});
