import { describe, it, expect, vi } from 'vitest';
import { createMangaRecovery } from '../src/background/manga-recovery.js';
import { MANGA_JOBS_KEY } from '../src/background/manga-job-store.js';
import { createPretranslationSnapshot } from '../src/background/pretranslation-checkpoint.js';

function fixture(isPrivate = false, seed = {}) {
    const data = structuredClone(seed);
    const tabs = new Map([[1, { id: 1, url: 'https://manga.test/ch1', incognito: isPrivate }],
        [2, { id: 2, url: 'chrome-extension://test/src/reader/result.html?tabId=1', incognito: isPrivate }]]);
    const chrome = {
        extension: { inIncognitoContext: isPrivate },
        runtime: { getURL: path => 'chrome-extension://test/' + path },
        storage: { local: {
            get: vi.fn(async key => structuredClone({ [key]: data[key] })),
            set: vi.fn(async value => { Object.assign(data, structuredClone(value)); })
        } },
        tabs: {
            query: vi.fn(async () => [...tabs.values()]),
            get: vi.fn(async id => { if (!tabs.has(id)) throw new Error('closed'); return tabs.get(id); }),
            sendMessage: vi.fn(async () => {})
        }
    };
    return { chrome, data, tabs };
}
const options = { sourceTabId: 1, resultTabId: 2, images: ['https://manga.test/1.jpg', 'https://manga.test/2.jpg'], batchSize: 1 };
const item = { image: options.images[0], results: [{ original: 'A', translation: '甲' }], pageIndex: 1, batchIndex: 0 };

describe('foreground manga recovery coordinator', () => {
    it('split incognito startup, STOP and close never access or mutate normal checkpoints', async () => {
        const normal = { [MANGA_JOBS_KEY]: { 99: { id: 'regular', status: 'running', results: [] } } };
        const f = fixture(true, normal);
        const recovery = createMangaRecovery(f.chrome);
        await recovery.ready;
        const job = await recovery.begin(options);
        await recovery.commit(job, 1, [item]);
        expect((await recovery.snapshot(2)).results).toHaveLength(1);
        await recovery.stop();
        await recovery.remove(2);
        expect(f.chrome.storage.local.get).not.toHaveBeenCalled();
        expect(f.chrome.storage.local.set).not.toHaveBeenCalled();
        expect(f.data).toEqual(normal);
    });

    it('persists before publishing and restores interruption without dispatching requests', async () => {
        const f = fixture();
        const recovery = createMangaRecovery(f.chrome);
        const job = await recovery.begin(options);
        f.chrome.tabs.sendMessage.mockImplementation(async (_id, message) => {
            expect(f.data[MANGA_JOBS_KEY][2].revision).toBe(message.job.revision);
        });
        await recovery.commit(job, 1, [item]);
        const restarted = createMangaRecovery(f.chrome);
        const snapshot = await restarted.snapshot(2);
        expect(snapshot.status).toBe('interrupted');
        expect(snapshot.processedCount).toBe(1);
        expect(snapshot.results[0].results).toEqual(item.results);
        const resumed = await restarted.resume(2, snapshot.id);
        expect(resumed.images.slice(resumed.processedCount)).toEqual([options.images[1]]);
        expect(resumed.id).not.toBe(job.id);
        expect(await recovery.commit(job, 2, [{ ...item, pageIndex: 2 }])).toBeNull();
    });

    it('STOP fences late batch results and completion', async () => {
        const f = fixture();
        const recovery = createMangaRecovery(f.chrome);
        const job = await recovery.begin(options);
        await recovery.commit(job, 1, [item]);
        await recovery.stop();
        expect(await recovery.commit(job, 2, [{ ...item, pageIndex: 2 }])).toBeNull();
        await recovery.status(job, 'completed');
        expect((await recovery.snapshot(2)).status).toBe('stopped');
        expect((await recovery.snapshot(2)).results).toHaveLength(1);
    });

    it('refuses changed source URLs and excludes transient image bytes and secrets', async () => {
        const f = fixture();
        const recovery = createMangaRecovery(f.chrome);
        const job = await recovery.begin({ ...options, images: [{ src: 'data:image/png;base64,SECRET', apiKey: 'KEY' }], prompt: 'PROMPT' });
        await recovery.status(job, 'interrupted');
        await expect(recovery.resume(2, job.id)).rejects.toThrow('暫存圖片');
        expect(JSON.stringify(f.data)).not.toMatch(/SECRET|KEY|PROMPT/);
        f.tabs.get(1).url = 'https://manga.test/ch2';
        await expect(recovery.resume(2, job.id)).rejects.toThrow('來源章節');
    });

    it('retry retains other pages and replaces matching page at its original position', async () => {
        const f = fixture();
        const recovery = createMangaRecovery(f.chrome);
        const job = await recovery.begin(options);
        await recovery.commit(job, 2, [item, { ...item, image: options.images[1], pageIndex: 2, batchIndex: 1 }]);
        await recovery.status(job, 'completed');
        const retry = await recovery.begin({ ...options, images: [options.images[1]], isRetry: true });
        await recovery.commit(retry, 1, [{ ...item, image: options.images[1], results: [{ original: 'B', translation: '乙' }] }]);
        const rows = (await recovery.snapshot(2)).results;
        expect(rows).toHaveLength(2);
        expect(rows[0].results).toEqual(item.results);
        expect(rows[1]).toMatchObject({ pageIndex: 2, batchIndex: 1, results: [{ original: 'B', translation: '乙' }] });
    });

    it('does not replace the reader job when retry has no saved chapter to preserve', async () => {
        const f = fixture();
        const recovery = createMangaRecovery(f.chrome);
        await expect(recovery.begin({ ...options, images: [options.images[1]], isRetry: true }))
            .rejects.toThrow('找不到原章節');
        expect(await recovery.snapshot(2)).toBeNull();
    });

    it('pretranslation cache serialization excludes foreground ownership and readiness promises', () => {
        const snapshot = createPretranslationSnapshot({ ...options, url: 'https://manga.test/ch2', results: [item],
            consumptionReady: Promise.resolve(), foregroundJob: { id: 'old-owner' }, consumedResultTabId: 2 });
        expect(snapshot).not.toHaveProperty('consumptionReady');
        expect(snapshot).not.toHaveProperty('foregroundJob');
        expect(snapshot).not.toHaveProperty('consumedResultTabId');
        expect(() => structuredClone(snapshot)).not.toThrow();
    });
    it('keeps a sanitized chapter dropdown through commit and worker recovery', async () => {
        const f = fixture();
        const recovery = createMangaRecovery(f.chrome);
        const navLinks = { currentChapter: 'Chapter 1', chapterList: [
            { title: 'Chapter 1', url: 'https://manga.test/ch1', current: true, payload: 'not saved' },
            { title: 'Chapter 2', url: 'https://manga.test/ch2', current: false },
            { title: 'Bad', url: 'javascript:alert(1)' }
        ] };
        const job = await recovery.begin({ ...options, navLinks });
        await recovery.commit(job, 1, [item]);
        const restarted = createMangaRecovery(f.chrome);
        const saved = await restarted.snapshot(2);
        expect(saved.navLinks.chapterList).toEqual([
            { title: 'Chapter 1', url: 'https://manga.test/ch1', current: true },
            { title: 'Chapter 2', url: 'https://manga.test/ch2', current: false }
        ]);
    });

    it('accepts owned pending navigation but rejects an unrelated pending chapter and incomplete completion', async () => {
        const f = fixture();
        const recovery = createMangaRecovery(f.chrome);
        f.tabs.get(1).pendingUrl = 'https://manga.test/ch2';
        const job = await recovery.begin({ ...options, sourceUrl: 'https://manga.test/ch2' });
        expect(await recovery.commit(job, 1, [item])).not.toBeNull();
        const restarted = createMangaRecovery(f.chrome);
        expect((await restarted.snapshot(2)).status).toBe('interrupted');
        const resumed = await restarted.resume(2, job.id);
        await expect(restarted.status(resumed, 'completed')).rejects.toThrow('before all pages');
        f.tabs.get(1).pendingUrl = 'https://manga.test/ch3';
        expect(await restarted.commit(resumed, 2, [{ ...item, pageIndex: 2 }])).toBeNull();
    });

});
