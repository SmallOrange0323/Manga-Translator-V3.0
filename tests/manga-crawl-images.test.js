import { describe, it, expect, beforeEach, vi } from 'vitest';

// 預先 mock document 環境以利 manga-engine 頂層注入 style 標籤
if (!globalThis.document) {
    globalThis.document = {
        createElement: () => ({ style: {}, appendChild: () => {}, innerHTML: '' }),
        head: { appendChild: () => {} },
        body: { appendChild: () => {} },
        querySelectorAll: () => [],
        getElementById: () => null
    };
}
if (!globalThis.window) {
    globalThis.window = {
        location: { href: 'https://rawkuma.net/manga/test/chapter-83.2/' },
        scrollTo: () => {},
        dispatchEvent: () => {}
    };
}

import { crawlImages } from '../src/content/manga-engine.js';

describe('manga-engine: crawlImages 容器與圖片抓取測試', () => {

    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('Rawkuma 新版型容器 [data-image-data] 內的漫畫圖片能被正確辨識並抓取', () => {
        // 模擬 DOM 節點結構
        const container = {
            tagName: 'SECTION',
            attributes: { 'data-image-data': '1' },
            matches(selector) {
                return selector === '[data-image-data]';
            },
            closest(selector) {
                if (selector === '[data-image-data]') return container;
                return null;
            }
        };

        const createMockImg = (src, width = 800, height = 1200, parent = container) => {
            const img = {
                tagName: 'IMG',
                src,
                naturalWidth: width,
                naturalHeight: height,
                width,
                height,
                offsetWidth: width,
                offsetHeight: height,
                classList: { contains: () => false },
                style: {},
                getAttribute: (attr) => attr === 'src' ? src : null,
                closest: (selector) => parent ? parent.closest(selector) : null,
                getBoundingClientRect: () => ({ width, height, left: 0, top: 0 })
            };
            return img;
        };

        // 模擬 10 張在 [data-image-data] 容器內的 Rawkuma 正文圖片
        const chapterImgs = Array.from({ length: 10 }, (_, i) => 
            createMockImg(`https://kuma.kyut.dev/wp-content/scr/t/raw/83.2/${i + 1}.jpg`)
        );

        // 模擬容器外的網站 Logo
        const logoImg = createMockImg('https://rawkuma.net/wp-content/uploads/2025/09/Rawkuma-Logo.png', 1156, 318, null);

        globalThis.document.querySelectorAll = vi.fn((selector) => {
            if (selector.includes('img')) {
                return [...chapterImgs, logoImg];
            }
            return [];
        });

        const result = crawlImages();

        // 應成功抓出 10 張漫畫正文圖片
        expect(result.images).toHaveLength(10);
        expect(result.images[0].src).toBe('https://kuma.kyut.dev/wp-content/scr/t/raw/83.2/1.jpg');
        expect(result.images[9].src).toBe('https://kuma.kyut.dev/wp-content/scr/t/raw/83.2/10.jpg');

        // Logo 應被 Container Domination 機制自動排除
        const hasLogo = result.images.some(img => img.src.includes('Rawkuma-Logo.png'));
        expect(hasLogo).toBe(false);
    });

    it('Rawkuma 圖片在剛載入 (width=0) 時，因在 [data-image-data] 容器內，不會被當作 isUnloadedJunk 排除', () => {
        const container = {
            tagName: 'SECTION',
            matches(selector) { return selector === '[data-image-data]'; },
            closest(selector) { return selector === '[data-image-data]' ? container : null; }
        };

        // width=0, height=0（尚未在瀏覽器中完成渲染或在可見視窗外）
        const unrenderedImg = {
            tagName: 'IMG',
            src: 'https://kuma.kyut.dev/wp-content/scr/t/raw/83.2/1.jpg',
            naturalWidth: 0,
            naturalHeight: 0,
            width: 0,
            height: 0,
            offsetWidth: 0,
            offsetHeight: 0,
            classList: { contains: () => false },
            style: {},
            getAttribute: (attr) => attr === 'src' ? 'https://kuma.kyut.dev/wp-content/scr/t/raw/83.2/1.jpg' : null,
            closest: (selector) => selector === '[data-image-data]' ? container : null,
            getBoundingClientRect: () => ({ width: 0, height: 0, left: 0, top: 0 })
        };

        const unrenderedImg2 = {
            ...unrenderedImg,
            src: 'https://kuma.kyut.dev/wp-content/scr/t/raw/83.2/2.jpg',
            getAttribute: (attr) => attr === 'src' ? 'https://kuma.kyut.dev/wp-content/scr/t/raw/83.2/2.jpg' : null,
        };

        globalThis.document.querySelectorAll = vi.fn((selector) => {
            if (selector.includes('img')) {
                return [unrenderedImg, unrenderedImg2];
            }
            return [];
        });

        const result = crawlImages();
        expect(result.images).toHaveLength(2);
        expect(result.images[0].src).toBe('https://kuma.kyut.dev/wp-content/scr/t/raw/83.2/1.jpg');
    });

    it('常規容器 (如 #readerarea) 下的圖片維持正常抓取', () => {
        const container = {
            tagName: 'DIV',
            id: 'readerarea',
            closest(selector) { return selector === '#readerarea' ? container : null; }
        };

        const img1 = {
            tagName: 'IMG',
            src: 'https://example.com/manga/p1.jpg',
            naturalWidth: 800,
            naturalHeight: 1200,
            width: 800,
            height: 1200,
            offsetWidth: 800,
            offsetHeight: 1200,
            classList: { contains: () => false },
            style: {},
            getAttribute: (attr) => attr === 'src' ? 'https://example.com/manga/p1.jpg' : null,
            closest: (selector) => selector === '#readerarea' ? container : null,
            getBoundingClientRect: () => ({ width: 800, height: 1200, left: 0, top: 0 })
        };

        const img2 = {
            ...img1,
            src: 'https://example.com/manga/p2.jpg',
            getAttribute: (attr) => attr === 'src' ? 'https://example.com/manga/p2.jpg' : null,
        };

        globalThis.document.querySelectorAll = vi.fn((selector) => {
            if (selector.includes('img')) {
                return [img1, img2];
            }
            return [];
        });

        const result = crawlImages();
        expect(result.images).toHaveLength(2);
    });
});
