import { describe, expect, it, vi } from 'vitest';
import { crawlJestfulChapterInTab } from '../src/background/jestful-prefetch.js';

const chapter = 'https://jestful.net/series-raw-chapter-13.3.html';

function browser(responses, previewUrl = chapter) {
    const tabs = {
        get: vi.fn(async id => id === 1
            ? { id, windowId: 7, incognito: true }
            : { id, url: previewUrl, status: 'complete', incognito: true }),
        create: vi.fn(async () => ({ id: 2 })),
        remove: vi.fn(async () => {}),
        sendMessage: vi.fn(async () => responses.shift() || { images: [] })
    };
    return { tabs };
}

describe('Jestful next chapter prefetch', () => {
    it('waits for stable live reader pages in the source privacy window and closes preview', async () => {
        const pages = ['https://cdn.example/1.jpg', 'https://cdn.example/2.jpg'];
        const chrome = browser([
            { images: [], error: 'still loading' },
            ...Array.from({ length: 6 }, () => ({ images: pages.map(src => ({ src })), navLinks: { prev: null, next: null } }))
        ]);
        const result = await crawlJestfulChapterInTab(chrome, chapter, 1, async () => true, async () => {});
        expect(result.images).toEqual(pages);
        expect(chrome.tabs.create).toHaveBeenCalledWith({ url: chapter, active: false, windowId: 7 });
        expect(chrome.tabs.remove).toHaveBeenCalledWith(2);
    });

    it('rejects an advert redirect before reading its images and closes preview', async () => {
        const chrome = browser([{ images: [{ src: 'https://ads.example/creative.jpg' }] }],
            'https://ads.example/landing');
        await expect(crawlJestfulChapterInTab(chrome, chapter, 1, async () => true, async () => {}))
            .rejects.toThrow('轉向其他頁面');
        expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
        expect(chrome.tabs.remove).toHaveBeenCalledWith(2);
    });
});
