import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createMangaNavigationStore } from '../src/background/manga-navigation-store.js';

function fixture() {
    const values = {};
    const state = { update: vi.fn(async (key, updater) => { values[key] = updater(values[key]); }) };
    return { state, store: createMangaNavigationStore(state) };
}

describe('manga navigation ownership', () => {
    it('keeps separate tabs and lets only one completion path claim each navigation', async () => {
        const { store } = fixture();
        await Promise.all([
            store.register(1, { url: 'https://manga.test/ch2', resultTabId: 2 }),
            store.register(3, { url: 'https://manga.test/ch4', resultTabId: 4 })
        ]);
        const claims = await Promise.all([
            store.claim(1, 'https://manga.test/ch2'), store.claim(1, 'https://manga.test/ch2')
        ]);
        expect(claims.filter(Boolean)).toHaveLength(1);
        expect(claims.find(Boolean).resultTabId).toBe(2);
        expect((await store.claim(3, 'https://manga.test/ch4')).resultTabId).toBe(4);
    });

    it('rejects old page completion and old timeouts without deleting a newer navigation', async () => {
        const { store } = fixture();
        const old = await store.register(1, { url: 'https://manga.test/ch2', resultTabId: 2 });
        const current = await store.register(1, { url: 'https://manga.test/ch3', resultTabId: 2 });
        expect(await store.claim(1, old.url)).toBeNull();
        expect(await store.claim(1, current.url, old.token)).toBeNull();
        await store.removeForTab(1, old.token);
        expect((await store.claim(1, current.url, current.token)).token).toBe(current.token);
    });

    it('restores normal navigation and keeps private navigation out of shared storage', async () => {
        const { state, store } = fixture();
        await store.register(1, { url: 'https://manga.test/ch2', resultTabId: 2 });
        const restored = createMangaNavigationStore(state);
        expect((await restored.claim(1, 'https://manga.test/ch2')).resultTabId).toBe(2);
        state.update.mockClear();
        const privateStore = createMangaNavigationStore(state, true);
        await privateStore.register(1, { url: 'https://private.test/ch2', resultTabId: 2 });
        await privateStore.removeForTab(2);
        expect(await privateStore.claim(1, 'https://private.test/ch2')).toBeNull();
        expect(state.update).not.toHaveBeenCalled();
    });

    it('load-complete and timeout racing through the production navigation handler start only once', async () => {
        vi.useFakeTimers();
        try {
            const source = readFileSync(new URL('../src/background/index.js', import.meta.url), 'utf8');
            const start = source.indexOf("  if (message.action === 'navigateAndTranslate')");
            const end = source.indexOf("  if (message.action === 'MOBILE_CRAWL_IMAGES')", start);
            const { store } = fixture();
            const tab = { id: 1, url: 'https://manga.test/ch1' };
            const chrome = { tabs: { get: async () => tab,
                update: vi.fn(async (_id, details) => Object.assign(tab, details)), sendMessage: vi.fn(async () => {}) } };
            const translate = vi.fn(async () => {});
            const handler = new Function('chrome', 'mangaNavigationStore', 'autoStartBatchWithRetry', 'log',
                'message', 'sender', 'sendResponse', source.slice(start, end));
            handler(chrome, store, translate, { info() {}, warn() {}, error() {} },
                { action: 'navigateAndTranslate', tabId: 1, url: 'https://manga.test/ch2' },
                { tab: { id: 2 } }, vi.fn());
            await vi.advanceTimersByTimeAsync(0);
            const complete = await store.claim(1, tab.url);
            await translate(1, complete.resultTabId, complete.mangaKey, complete.mobile);
            await vi.advanceTimersByTimeAsync(3500);
            expect(translate).toHaveBeenCalledOnce();
        } finally { vi.useRealTimers(); }
    });
});
