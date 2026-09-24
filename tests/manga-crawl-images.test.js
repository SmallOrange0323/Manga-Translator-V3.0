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

import { crawlImages, crawlImagesForRequest } from '../src/content/manga-engine.js';

describe('manga-engine: crawlImages 容器與圖片抓取測試', () => {

    beforeEach(() => {
        vi.restoreAllMocks();
        globalThis.document.getElementById = () => null;
        globalThis.window.location.href = 'https://rawkuma.net/manga/test/chapter-83.2/';
    });

    it('loads all Wnacg pages from its same-origin reader list without scrolling', async () => {
        const previousFetch = globalThis.fetch;
        const urls = Array.from({ length: 80 }, (_, index) =>
            `http://img.example/${String(index + 1).padStart(4, '0')}.webp?verify=token-${index}`);
        const script = `mReader.initData({"page_url":${JSON.stringify(urls).replace(/]$/, ',]')}});`;
        const fetchMock = vi.fn(async () => ({ ok: true, text: async () => script }));
        globalThis.fetch = fetchMock;
        globalThis.window.location.href = 'https://www.wnacg.com/photos-slide-aid-387480.html';
        globalThis.document.querySelector = selector => selector === '#slot-0 img'
            ? { src: 'https://img.example/0001.webp?verify=token-0' } : null;
        globalThis.document.querySelectorAll = selector => {
            if (selector === 'script[src]') return [{ src: 'https://www.wnacg.com/photos-item-aid-387480.html' }];
            if (selector === '.v-slot[data-index]') return Array.from({ length: 80 }, () => ({}));
            return [];
        };
        try {
            const result = await crawlImagesForRequest();
            expect(result.images).toHaveLength(80);
            expect(result.images[79].src).toBe('https://img.example/0080.webp?verify=token-79');
            expect(fetchMock).toHaveBeenCalledTimes(1);
        } finally {
            globalThis.fetch = previousFetch;
        }
    });

    it('blocks Wnacg when the reader list omits pages', async () => {
        const previousFetch = globalThis.fetch;
        globalThis.fetch = vi.fn(async () => ({ ok: true, text: async () =>
            'mReader.initData({"page_url":["https://img.example/1.webp",]});' }));
        globalThis.window.location.href = 'https://www.wnacg.com/photos-slide-aid-387480.html';
        globalThis.document.querySelector = () => null;
        globalThis.document.querySelectorAll = selector => {
            if (selector === 'script[src]') return [{ src: 'https://www.wnacg.com/photos-item-aid-387480.html' }];
            if (selector === '.v-slot[data-index]') return Array.from({ length: 80 }, () => ({}));
            return [];
        };
        try {
            const result = await crawlImagesForRequest();
            expect(result.images).toEqual([]);
            expect(result.error).toContain('1/80');
        } finally {
            globalThis.fetch = previousFetch;
        }
    });

    it('uses every GigaViewer main page instead of visible canvases and cover images', () => {
        const pages = [
            { type: 'other', src: 'https://reader.example/cover' },
            { type: 'link', src: 'https://reader.example/advert' },
            ...Array.from({ length: 6 }, (_, index) => ({
                type: 'main', src: `https://reader.example/page/${index + 1}`
            }))
        ];
        globalThis.document.getElementById = id => id === 'episode-json'
            ? { dataset: { value: JSON.stringify({ readableProduct: { pageStructure: { pages } } }) } }
            : null;
        globalThis.document.querySelectorAll = vi.fn(selector => {
            if (selector === 'canvas') return [{ width: 800, height: 1200, toDataURL: () => 'data:image/jpeg;base64,' + 'a'.repeat(1200) }];
            if (selector.includes('img')) return [{ src: 'https://reader.example/cover.jpg' }];
            return [];
        });
        expect(crawlImages().images.map(image => image.src)).toEqual(
            Array.from({ length: 6 }, (_, index) => `https://reader.example/page/${index + 1}`)
        );
    });

    it('uses rendered canvases when the GigaViewer manifest marks raw pages scrambled', () => {
        const rawUrl = 'https://reader.example/scrambled/page-1';
        const canvasUrl = 'data:image/jpeg;base64,' + 'a'.repeat(1200);
        globalThis.document.getElementById = id => id === 'episode-json'
            ? { dataset: { value: JSON.stringify({ readableProduct: { pageStructure: {
                choJuGiga: 'baku', pages: [{ type: 'main', src: rawUrl }]
            } } }) } } : null;
        globalThis.document.querySelectorAll = vi.fn(selector => selector === 'canvas'
            ? [{ width: 800, height: 1200, toDataURL: () => canvasUrl }] : []);
        expect(crawlImages().images).toEqual([{ src: canvasUrl }]);
    });

    it('blocks a protected episode when only some rendered pages are available', () => {
        const pages = Array.from({ length: 20 }, (_, index) => ({
            type: 'main', src: `https://reader.example/scrambled/${index + 1}`
        }));
        delete pages[19].src;
        globalThis.document.getElementById = id => id === 'episode-json'
            ? { dataset: { value: JSON.stringify({ readableProduct: { pageStructure: {
                choJuGiga: 'baku', pages
            } } }) } } : null;
        globalThis.document.querySelectorAll = vi.fn(selector => selector === 'canvas'
            ? Array.from({ length: 5 }, (_, index) => ({
                width: 800, height: 1200,
                toDataURL: () => `data:image/jpeg;base64,${String(index).repeat(1200)}`
            })) : []);
        const result = crawlImages();
        expect(result.images).toEqual([]);
        expect(result.error).toContain('5/20');
    });

    it('keeps the full reader DOM when generic episode data contains only a thumbnail', () => {
        globalThis.document.getElementById = id => id === 'episode-json'
            ? { dataset: { value: JSON.stringify({ pages: [{ src: 'https://reader.example/thumbnail.jpg' }] }) } }
            : null;
        const readerImage = n => ({
            tagName: 'IMG', src: `https://reader.example/pages/${n}.jpg`,
            naturalWidth: 800, naturalHeight: 1200, width: 800, height: 1200,
            offsetWidth: 800, offsetHeight: 1200, classList: { contains: () => false }, style: {},
            getAttribute: key => key === 'src' ? `https://reader.example/pages/${n}.jpg` : null,
            closest: selector => selector === '#readerarea' ? {} : null,
            getBoundingClientRect: () => ({ width: 800, height: 1200, left: 0, top: 0 })
        });
        globalThis.document.querySelectorAll = vi.fn(selector => selector.includes('img')
            ? [readerImage(1), readerImage(2)] : []);
        expect(crawlImages().images).toEqual([
            { src: 'https://reader.example/pages/1.jpg' },
            { src: 'https://reader.example/pages/2.jpg' }
        ]);
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

        // 模擬 10 張在 [data-image-data] 容器內的 Rawkuma 正文圖片 (網址含 lovery-girl 關鍵字)
        const chapterImgs = Array.from({ length: 10 }, (_, i) => 
            createMockImg(`https://kuma.kyut.dev/wp-content/scr/t/the-frontier-life-of-the-low-class-ossan-healer-and-the-lovery-girl-manga-raw/83.2/${i + 1}.jpg`)
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

        // 應成功抓出 10 張漫畫正文圖片，不受 URL 中包含 lovery 影響
        expect(result.images).toHaveLength(10);
        expect(result.images[0].src).toBe('https://kuma.kyut.dev/wp-content/scr/t/the-frontier-life-of-the-low-class-ossan-healer-and-the-lovery-girl-manga-raw/83.2/1.jpg');
        expect(result.images[9].src).toBe('https://kuma.kyut.dev/wp-content/scr/t/the-frontier-life-of-the-low-class-ossan-healer-and-the-lovery-girl-manga-raw/83.2/10.jpg');

        // Logo 應被 Container Domination 機制自動排除
        const hasLogo = result.images.some(img => img.src.includes('Rawkuma-Logo.png'));
        expect(hasLogo).toBe(false);
    });

    it('漫畫書名或路徑中包含 love, funny, angry, vote 等常見詞彙時，不被 junkKeywords 誤殺', () => {
        const container = {
            tagName: 'DIV',
            id: 'readerarea',
            closest(selector) { return selector === '#readerarea' ? container : null; }
        };

        const createMockImg = (src, width = 800, height = 1200) => ({
            tagName: 'IMG',
            src,
            naturalWidth: width,
            naturalHeight: height,
            width, height,
            offsetWidth: width,
            offsetHeight: height,
            classList: { contains: () => false },
            style: {},
            getAttribute: (attr) => attr === 'src' ? src : null,
            closest: (selector) => selector === '#readerarea' ? container : null,
            getBoundingClientRect: () => ({ width, height, left: 0, top: 0 })
        });

        const loveImgs = [
            createMockImg('https://example.com/manga/kaguya-love-is-war/c1/01.jpg'),
            createMockImg('https://example.com/manga/funny-story-vote/c1/02.jpg'),
            createMockImg('https://example.com/manga/angry-healer/c1/03.jpg')
        ];

        globalThis.document.querySelectorAll = vi.fn((selector) => {
            if (selector.includes('img')) return loveImgs;
            return [];
        });

        const result = crawlImages();
        expect(result.images).toHaveLength(3);
        expect(result.images[0].src).toContain('love-is-war');
        expect(result.images[1].src).toContain('funny-story-vote');
        expect(result.images[2].src).toContain('angry-healer');
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
