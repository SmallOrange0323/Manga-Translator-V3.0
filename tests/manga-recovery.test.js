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

    it('keeps a consumed pretranslated chapter when its sleeping source tab changes or closes', async () => {
        const f = fixture();
        const recovery = createMangaRecovery(f.chrome);
        const job = await recovery.begin({ ...options, sourceUrl: 'https://manga.test/ch2', isPretranslatedChapter: true });
        await recovery.commit(job, 1, [item]);
        await recovery.status(job, 'interrupted');
        const restarted = createMangaRecovery(f.chrome);
        const restored = await restarted.snapshot(2);
        expect(restored).toMatchObject({ id: job.id, isPretranslatedChapter: true, status: 'interrupted' });
        const retry = await restarted.begin({ ...options, images: [options.images[0]], isRetry: true,
            retryPageIndices: [1] });
        expect((await restarted.snapshot(2))).toMatchObject({ id: retry.id, isPretranslatedChapter: true });
        f.tabs.delete(1);
        await restarted.remove(1);
        expect((await restarted.snapshot(2)).results).toHaveLength(1);
    });

    it('attaches cached pages if the source tab closes just before recovery begins', async () => {
        const f = fixture();
        const recovery = createMangaRecovery(f.chrome);
        await recovery.ready;
        f.tabs.delete(1);
        const job = await recovery.begin({ ...options, sourceUrl: 'https://manga.test/ch2',
            isPretranslatedChapter: true });
        expect(job.sourceTabId).toBeNull();
        expect((await recovery.commit(job, 1, [item])).results).toHaveLength(1);
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
        const retry = await recovery.begin({ ...options, images: [options.images[1]], isRetry: true, retryPageIndices: [2] });
        await recovery.commit(retry, 1, [{ ...item, pageIndex: 2, image: options.images[1], results: [{ original: 'B', translation: '乙' }] }]);
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

    it('uses original page numbers for duplicate URLs and temporary data images', async () => {
        const f = fixture();
        const recovery = createMangaRecovery(f.chrome);
        const duplicate = 'https://manga.test/same.jpg';
        const temporary = 'data:image/jpeg;base64,AAAA';
        const job = await recovery.begin({ ...options, images: [duplicate, duplicate, temporary], batchSize: 2 });
        await recovery.commit(job, 3, [
            { ...item, image: duplicate, pageIndex: 1, batchIndex: 0 },
            { ...item, image: duplicate, pageIndex: 2, batchIndex: 0 },
            { ...item, image: temporary, pageIndex: 3, batchIndex: 1 }
        ]);
        await recovery.status(job, 'completed');
        const retry = await recovery.begin({ ...options, images: [duplicate, temporary], isRetry: true,
            retryPageIndices: [2, 3] });
        await recovery.commit(retry, 2, [
            { ...item, image: duplicate, pageIndex: 2, results: [{ original: 'B', translation: '乙' }] },
            { ...item, image: temporary, pageIndex: 3, results: [{ original: 'C', translation: '丙' }] }
        ]);
        const rows = (await recovery.snapshot(2)).results;
        expect(rows.map(row => row.pageIndex)).toEqual([1, 2, 3]);
        expect(rows.map(row => row.results[0].translation)).toEqual(['甲', '乙', '丙']);
        await expect(recovery.commit(retry, 2, [{ ...item, pageIndex: 1 }]))
            .rejects.toThrow('頁碼不屬於');
    });

    it('single-page retry updates the selected page when URLs repeat or are temporary', async () => {
        const f = fixture();
        const recovery = createMangaRecovery(f.chrome);
        const duplicate = 'https://manga.test/same.jpg';
        const temporary = 'data:image/jpeg;base64,AAAA';
        const job = await recovery.begin({ ...options, images: [duplicate, duplicate, temporary] });
        await recovery.commit(job, 3, [
            { ...item, image: duplicate, pageIndex: 1 },
            { ...item, image: duplicate, pageIndex: 2 },
            { ...item, image: temporary, pageIndex: 3 }
        ]);
        await recovery.status(job, 'completed');
        await recovery.replaceResult(2, job.id, 2, { results: [{ original: 'B', translation: '乙' }] });
        await recovery.replaceResult(2, job.id, 3, { results: [{ original: 'C', translation: '丙' }] });
        const rows = (await recovery.snapshot(2)).results;
        expect(rows.map(row => row.results[0].translation)).toEqual(['甲', '乙', '丙']);
        expect(rows.map(row => row.pageIndex)).toEqual([1, 2, 3]);
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

function createFakeIndexedDB() {
    const databases = new Map();

    function ensureDb(name) {
        if (!databases.has(name)) {
            databases.set(name, { stores: new Map() });
        }
        return databases.get(name);
    }

    function makeStoreWrapper(storeData) {
        const wrapper = {
            createIndex() {},
            indexNames: { contains: () => false },
            put(value, key) {
                const req = {};
                queueMicrotask(() => {
                    storeData.set(key, structuredClone(value));
                    req.result = key;
                    req.onsuccess?.({ target: req });
                });
                return req;
            },
            get(key) {
                const req = {};
                queueMicrotask(() => {
                    req.result = storeData.has(key) ? structuredClone(storeData.get(key)) : undefined;
                    req.onsuccess?.({ target: req });
                });
                return req;
            },
            delete(key) {
                const req = {};
                queueMicrotask(() => {
                    storeData.delete(key);
                    req.onsuccess?.({ target: req });
                });
                return req;
            },
            openCursor() {
                const entries = Array.from(storeData.entries());
                let idx = 0;
                const req = {};
                function advance() {
                    queueMicrotask(() => {
                        if (idx >= entries.length) {
                            req.result = null;
                            req.onsuccess?.({ target: req });
                            return;
                        }
                        const [key, value] = entries[idx++];
                        req.result = {
                            key,
                            primaryKey: key,
                            value: structuredClone(value),
                            continue: advance,
                            delete() {
                                storeData.delete(key);
                            }
                        };
                        req.onsuccess?.({ target: req });
                    });
                }
                advance();
                return req;
            },
            openKeyCursor() {
                const keys = Array.from(storeData.keys());
                let idx = 0;
                const req = {};
                function advance() {
                    queueMicrotask(() => {
                        if (idx >= keys.length) {
                            req.result = null;
                            req.onsuccess?.({ target: req });
                            return;
                        }
                        const key = keys[idx++];
                        req.result = {
                            key,
                            primaryKey: key,
                            continue: advance
                        };
                        req.onsuccess?.({ target: req });
                    });
                }
                advance();
                return req;
            }
        };
        return wrapper;
    }

    return {
        open(name) {
            const req = {};
            queueMicrotask(() => {
                const state = ensureDb(name);
                const db = {
                    objectStoreNames: {
                        contains: storeName => state.stores.has(storeName)
                    },
                    createObjectStore(storeName) {
                        if (!state.stores.has(storeName)) {
                            state.stores.set(storeName, new Map());
                        }
                        return makeStoreWrapper(state.stores.get(storeName));
                    },
                    transaction(storeName) {
                        const tx = {
                            objectStore: () => makeStoreWrapper(state.stores.get(storeName) || new Map())
                        };
                        // 延後一輪 macrotask/microtask 確保所有 store req 都已執行完畢才觸發 tx.oncomplete
                        setTimeout(() => tx.oncomplete?.(), 0);
                        return tx;
                    },
                    close() {}
                };
                req.result = db;
                req.onupgradeneeded?.({ target: req });
                req.onsuccess?.({ target: req });
            });
            return req;
        },
        dump(dbName = 'mt_manga_temp_images_v1', storeName = 'page_images') {
            return new Map(databases.get(dbName)?.stores.get(storeName) || []);
        }
    };
}

describe('IndexedDB transient image persistence', () => {
    it('restores transient data URLs via snapshot and publish after Service Worker restart', async () => {
        const fakeIdb = createFakeIndexedDB();
        const f = fixture();
        const tempImg1 = 'data:image/jpeg;base64,TEMP_PAGE_1';
        const tempImg2 = 'data:image/jpeg;base64,TEMP_PAGE_2';
        const recovery = createMangaRecovery(f.chrome, { indexedDB: fakeIdb });
        const job = await recovery.begin({
            ...options,
            images: [tempImg1, tempImg2],
            batchSize: 1
        });
        await recovery.commit(job, 1, [{
            image: tempImg1,
            results: [{ original: 'A', translation: '甲' }],
            pageIndex: 1,
            batchIndex: 0
        }]);
        expect(JSON.stringify(f.data)).not.toContain('TEMP_PAGE_');
        expect(fakeIdb.dump().size).toBe(2);

        // 模擬 Service Worker 休眠重啟：建立全新實例（記憶體 Map 為空）
        const restarted = createMangaRecovery(f.chrome, { indexedDB: fakeIdb });
        expect(restarted.getMemoryImage(2, 1, job.id)).toBe('');

        const restored = await restarted.snapshot(2);
        expect(restored.results[0].image).toBe(tempImg1);
        expect(restarted.getMemoryImage(2, 1, job.id)).toBe(tempImg1);
        expect(restarted.getMemoryImage(2, 2, job.id)).toBe(tempImg2);
        expect(await restarted.getStoredImage(2, 2, job.id)).toBe(tempImg2);

        f.chrome.tabs.sendMessage.mockClear();
        await restarted.publish(restored);
        const chunkMsgs = f.chrome.tabs.sendMessage.mock.calls
            .map(([, msg]) => msg)
            .filter(msg => msg.action === 'mangaImageChunk');
        expect(chunkMsgs.some(msg => msg.pageIndex === 1 && msg.data === tempImg1)).toBe(true);
    });

    it('never writes or reads IndexedDB in incognito mode (isPrivate = true or incognito tab)', async () => {
        const fakeIdb = createFakeIndexedDB();
        const f = fixture(true);
        const tempImg = 'data:image/jpeg;base64,INCOGNITO_SECRET';
        const openSpy = vi.spyOn(fakeIdb, 'open');
        const recovery = createMangaRecovery(f.chrome, { indexedDB: fakeIdb });
        await recovery.ready;
        const job = await recovery.begin({ ...options, images: [tempImg] });
        await recovery.commit(job, 1, [{
            image: tempImg,
            results: [{ original: 'A', translation: '甲' }],
            pageIndex: 1,
            batchIndex: 0
        }]);
        expect(recovery.getMemoryImage(2, 1, job.id)).toBe(tempImg);
        expect(openSpy).not.toHaveBeenCalled();
        expect(fakeIdb.dump().size).toBe(0);

        // 即使非無痕 worker 遇到 incognito: true 的分頁，也嚴禁寫入 IndexedDB
        const mixedChrome = fixture(false).chrome;
        mixedChrome.tabs.get = vi.fn(async id => ({ id, url: 'chrome-extension://test/src/reader/result.html', incognito: true }));
        const mixedRecovery = createMangaRecovery(mixedChrome, { indexedDB: fakeIdb });
        const mixedJob = await mixedRecovery.begin({ ...options, images: [tempImg] });
        await mixedRecovery.commit(mixedJob, 1, [{
            image: tempImg,
            results: [{ original: 'A', translation: '甲' }],
            pageIndex: 1,
            batchIndex: 0
        }]);
        expect(fakeIdb.dump().size).toBe(0);
    });

    it('removes persisted images for a tab on remove(tabId) and prunes closed tabs on startup', async () => {
        const fakeIdb = createFakeIndexedDB();
        const f = fixture();
        const tempImg = 'data:image/jpeg;base64,CLEAR_ME';
        const recovery = createMangaRecovery(f.chrome, { indexedDB: fakeIdb });
        const job = await recovery.begin({ ...options, images: [tempImg] });
        await recovery.commit(job, 1, [{
            image: tempImg,
            results: [{ original: 'A', translation: '甲' }],
            pageIndex: 1,
            batchIndex: 0
        }]);
        expect(fakeIdb.dump().size).toBe(1);

        await recovery.remove(2);
        expect(fakeIdb.dump().size).toBe(0);

        // 驗證啟動時會自動清理已關閉分頁的遺留 IndexedDB 圖片
        const job2 = await recovery.begin({ ...options, images: [tempImg] });
        await recovery.commit(job2, 1, [{
            image: tempImg,
            results: [{ original: 'A', translation: '甲' }],
            pageIndex: 1,
            batchIndex: 0
        }]);
        expect(fakeIdb.dump().size).toBe(1);

        f.tabs.delete(2);
        const restarted = createMangaRecovery(f.chrome, { indexedDB: fakeIdb });
        await restarted.ready;
        expect(fakeIdb.dump().size).toBe(0);
    });
});
