import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createMangaRecovery } from '../src/background/manga-recovery.js';
import { createPretranslationSnapshot } from '../src/background/pretranslation-checkpoint.js';
import { shouldCompleteMangaTranslation, shouldPublishMangaBatchResults, executeFallbackImages } from '../src/background/manga-lifecycle.js';
import { executeHybridRequest, HybridRequestAbortedError } from '../src/background/hybrid-retry.js';
import { getHybridSchedule, getEffectiveDelay } from '../src/background/hybrid-scheduler.js';

// Execute the actual production function bodies while replacing external Chrome/network dependencies.
// This avoids booting unrelated novel startup, alarms, cloud sync and context menus in a unit worker.
const source = readFileSync(new URL('../src/background/index.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function productionFunction(name, endMarker, dependencies) {
    const start = source.indexOf('async function ' + name + '(');
    const end = source.indexOf(endMarker, start);
    if (start < 0 || end < 0) throw new Error('Production function boundary missing: ' + name);
    return new Function(...Object.keys(dependencies), source.slice(start, end) + '\nreturn ' + name)(...Object.values(dependencies));
}
function deferred() {
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    return { promise, resolve };
}
function fixture() {
    const storage = {};
    const tabs = new Map([[1, { id: 1, url: 'https://manga.test/ch1' }], [2, { id: 2, url: 'chrome-extension://test/src/reader/result.html?tabId=1' }]]);
    const chrome = {
        extension: { inIncognitoContext: false },
        runtime: { getURL: path => 'chrome-extension://test/' + path, sendMessage: vi.fn(async () => {}) },
        storage: { local: {
            get: vi.fn(async key => structuredClone({ [key]: storage[key] })),
            set: vi.fn(async data => { Object.assign(storage, structuredClone(data)); })
        } },
        tabs: {
            query: vi.fn(async () => [...tabs.values()]),
            get: vi.fn(async id => { if (!tabs.has(id)) throw new Error('closed'); return tabs.get(id); }),
            update: vi.fn(async (id, value) => { Object.assign(tabs.get(id), value); return tabs.get(id); }),
            sendMessage: vi.fn(async () => {})
        }
    };
    return { chrome, storage, tabs };
}
const images = ['https://manga.test/p1.jpg', 'https://manga.test/p2.jpg'];
const log = { info() {}, warn() {}, error() {} };
function foreground(f, recovery, translate) {
    const controller = new AbortController();
    const settings = { ocrBatchSize: 1, requestDelay: 0, hybridModeEnabled: false, isStopping: false };
    const state = { apiKeys: ['fake-key'], isInitialized: true,
        get: async (key, fallback) => settings[key] ?? fallback,
        set: async (key, value) => { settings[key] = value; }, getApiKeyAlias: () => 'test', getNextApiKey: () => 'fake-key' };
    const fetchImages = vi.fn(async batch => batch.map(image => 'encoded:' + image));
    const startPretranslateNextChapter = vi.fn(async () => {});
    const dependencies = { chrome: f.chrome, state, log, activeTranslationJobs: new Map(),
        clearMangaRun: () => controller.abort(), getMangaAbortSignal: () => controller.signal,
        mangaRecovery: recovery, Constants: { DEFAULT_PROMPT_ONE_STEP: 'test prompt' },
        extractMangaTitle: () => null, isTabIncognito: async () => false,
        swKeepAlive: { start() {}, stop() {} }, fetchAndResizeBatch: fetchImages,
        translateTexts: translate, executeHybridRequest, HybridRequestAbortedError, getHybridSchedule, getEffectiveDelay,
        executeFallbackImages, shouldCompleteMangaTranslation, shouldPublishMangaBatchResults,
        startPretranslateNextChapter,
        incrementDailyUsage: vi.fn(async () => {}),
        setTimeout: callback => queueMicrotask(callback)
    };
    const run = productionFunction('processMangaBatchPCMode', '\n\n\n/**', dependencies);
    return { run: (resumed, navLinks = null) => run(1, 2, images, navLinks, false, null, '', null, resumed),
        controller, settings, fetchImages, startPretranslateNextChapter };
}

describe('actual foreground manga and consume flows', () => {
    it('starts the next chapter after committing all pages even if completion bookkeeping fails', async () => {
        const f = fixture();
        const recovery = createMangaRecovery(f.chrome);
        vi.spyOn(recovery, 'status').mockRejectedValueOnce(new Error('completion storage failure'));
        const translate = vi.fn(async () => ({ results: [{ original: 'text', translation: '譯文' }] }));
        const worker = foreground(f, recovery, translate);
        const next = 'https://manga.test/ch2';
        await expect(worker.run(null, { prev: null, next })).rejects.toThrow('completion storage failure');
        expect(worker.startPretranslateNextChapter).toHaveBeenCalledWith(next, 1, 2);
    });

    it('restarts after first saved batch, sends only remaining page after explicit resume and rejects old response', async () => {
        const f = fixture();
        const oldRecovery = createMangaRecovery(f.chrome);
        const secondRequested = deferred();
        const oldResponse = deferred();
        const translate = vi.fn(async (_texts, options) => {
            if (options.imageBase64.endsWith('p2.jpg')) { secondRequested.resolve(); return oldResponse.promise; }
            return { results: [{ original: 'page1', translation: 'saved' }] };
        });
        const old = foreground(f, oldRecovery, translate);
        const oldRun = old.run();
        await secondRequested.promise;
        expect((await oldRecovery.snapshot(2)).processedCount).toBe(1);
        const restarted = createMangaRecovery(f.chrome);
        const interrupted = await restarted.snapshot(2);
        expect(interrupted.status).toBe('interrupted');
        expect(translate).toHaveBeenCalledTimes(2);
        const newTranslate = vi.fn(async () => ({ results: [{ original: 'page2', translation: 'new result' }] }));
        const resumed = await restarted.resume(2, interrupted.id);
        const fresh = foreground(f, restarted, newTranslate);
        await fresh.run(resumed);
        expect(newTranslate).toHaveBeenCalledTimes(1);
        expect(newTranslate.mock.calls[0][1].imageBase64).toBe('encoded:' + images[1]);
        expect(fresh.fetchImages.mock.calls[0][0]).toEqual([images[1]]);
        oldResponse.resolve({ results: [{ original: 'page2', translation: 'stale result' }] });
        await oldRun;
        const finished = await restarted.snapshot(2);
        expect(finished.status).toBe('completed');
        expect(finished.results.map(row => row.results[0].translation)).toEqual(['saved', 'new result']);
    });

    it('STOP during actual in-flight translation never commits that response', async () => {
        const f = fixture();
        const recovery = createMangaRecovery(f.chrome);
        const requested = deferred();
        const response = deferred();
        const translate = vi.fn(async () => { requested.resolve(); return response.promise; });
        const worker = foreground(f, recovery, translate);
        const running = worker.run();
        await requested.promise;
        worker.controller.abort();
        worker.settings.isStopping = true;
        await recovery.stop();
        response.resolve({ results: [{ original: 'late', translation: 'late' }] });
        await running;
        const job = await recovery.snapshot(2);
        expect(job.status).toBe('stopped');
        expect(job.results).toEqual([]);
        expect(translate).toHaveBeenCalledTimes(1);
    });

    it('consuming an in-flight pretranslation waits for source navigation before attaching the stream', async () => {
        const f = fixture();
        const recovery = createMangaRecovery(f.chrome);
        const data = { images, results: [{ image: images[0], results: [{ original: 'a', translation: 'a' }] }],
            inProgress: true, isDone: false, batchSize: 1 };
        const navigation = deferred();
        f.chrome.tabs.update.mockImplementation(async (id, change) => { await navigation.promise; f.tabs.get(id).pendingUrl = change.url; return f.tabs.get(id); });
        const reply = deferred();
        const dependencies = { chrome: f.chrome, mangaRecovery: recovery, log,
            savePretranslationCheckpoint: vi.fn(async () => {}),
            isSuccessfulPretranslation: data => Boolean(data?.isDone && data.results?.length === data.images?.length && !data.results.some(result => result.error)),
            pretranslatedChaptersMap: new Map([['https://manga.test/ch2', data]]) };
        const start = source.indexOf("  if (message.action === 'CONSUME_PRETRANSLATED_CHAPTER')");
        const end = source.indexOf("  if (message.action === 'START_MANGA_BATCH_PC_MODE')", start);
        const handler = new Function(...Object.keys(dependencies), 'message', 'sender', 'sendResponse', source.slice(start, end));
        expect(handler(...Object.values(dependencies), { action: 'CONSUME_PRETRANSLATED_CHAPTER', payload: { nextUrl: 'https://manga.test/ch2', sourceTabId: 1 } }, { tab: { id: 2 } }, reply.resolve)).toBe(true);
        expect(data.consumedResultTabId).toBeUndefined();
        // A final batch finishes during navigation. Consume must include it and mark completion.
        data.results.push({ image: images[1], results: [{ original: 'b', translation: 'b' }] });
        data.isDone = true;
        navigation.resolve();
        const result = await reply.promise;
        expect(f.tabs.get(1).url).toBe('https://manga.test/ch1');
        expect(f.tabs.get(1).pendingUrl).toBe('https://manga.test/ch2');
        expect(result.success).toBe(true);
        expect(result.job.status).toBe('completed');
        expect(result.job.results).toHaveLength(2);
        expect(result.data).not.toHaveProperty('consumptionReady');
        expect(result.data).not.toHaveProperty('foregroundJob');
        expect(() => structuredClone(result)).not.toThrow();
        expect(data.consumedResultTabId).toBe(2);
    });

    it('attaches completed pretranslation while a discarded source tab still reports its old URL', async () => {
        const f = fixture();
        f.tabs.get(1).discarded = true;
        f.chrome.tabs.update.mockImplementation(async id => f.tabs.get(id));
        const recovery = createMangaRecovery(f.chrome);
        const nextUrl = 'https://manga.test/ch2';
        const data = { images, results: images.map(image => ({ image, results: [] })),
            isDone: true, inProgress: false, batchSize: 1 };
        const reply = deferred();
        const dependencies = { chrome: f.chrome, mangaRecovery: recovery, log,
            isSuccessfulPretranslation: value => Boolean(value?.isDone &&
                value.results?.length === value.images?.length && !value.results.some(result => result.error)),
            pretranslatedChaptersMap: new Map([[nextUrl, data]]) };
        const start = source.indexOf("  if (message.action === 'CONSUME_PRETRANSLATED_CHAPTER')");
        const end = source.indexOf("  if (message.action === 'START_MANGA_BATCH_PC_MODE')", start);
        const handler = new Function(...Object.keys(dependencies), 'message', 'sender', 'sendResponse', source.slice(start, end));
        handler(...Object.values(dependencies), { action: 'CONSUME_PRETRANSLATED_CHAPTER',
            payload: { nextUrl, sourceTabId: 1 } }, { tab: { id: 2 } }, reply.resolve);
        const result = await reply.promise;
        expect(result.success).toBe(true);
        expect(result.job).toMatchObject({ status: 'completed', sourceTabId: 1,
            isPretranslatedChapter: true, sourceUrl: nextUrl });
        expect(result.job.results).toHaveLength(2);
        expect(f.tabs.get(1).url).toBe('https://manga.test/ch1');
    });

    it('attaches two readers to one in-flight chapter without replacing the first consumer', async () => {
        const f = fixture();
        f.tabs.set(3, { id: 3, url: f.tabs.get(2).url });
        const recovery = createMangaRecovery(f.chrome);
        const nextUrl = 'https://manga.test/ch2';
        const data = { images, results: [{ image: images[0], results: [] }],
            isDone: false, inProgress: true, batchSize: 1 };
        const dependencies = { chrome: f.chrome, mangaRecovery: recovery, log,
            savePretranslationCheckpoint: vi.fn(async () => {}),
            isSuccessfulPretranslation: () => false, pretranslatedChaptersMap: new Map([[nextUrl, data]]) };
        const start = source.indexOf("  if (message.action === 'CONSUME_PRETRANSLATED_CHAPTER')");
        const end = source.indexOf("  if (message.action === 'START_MANGA_BATCH_PC_MODE')", start);
        const handler = new Function(...Object.keys(dependencies), 'message', 'sender', 'sendResponse', source.slice(start, end));
        const replies = [deferred(), deferred()];
        [2, 3].forEach((tabId, index) => handler(...Object.values(dependencies),
            { action: 'CONSUME_PRETRANSLATED_CHAPTER', payload: { nextUrl, sourceTabId: 1 } },
            { tab: { id: tabId } }, replies[index].resolve));
        const responses = await Promise.all(replies.map(reply => reply.promise));
        expect(responses.every(response => response.success)).toBe(true);
        expect(data.foregroundConsumers.size).toBe(2);
        expect(data.foregroundConsumers.get(2).job.resultTabId).toBe(2);
        expect(data.foregroundConsumers.get(3).job.resultTabId).toBe(3);
        responses.forEach(response => expect(() => structuredClone(response)).not.toThrow());
    });

    it('keeps the pretranslated chapter when updating the sleeping source tab fails', async () => {
        const f = fixture();
        f.chrome.tabs.update.mockRejectedValueOnce(new Error('tab discarded'));
        const recovery = createMangaRecovery(f.chrome);
        const nextUrl = 'https://manga.test/ch2';
        const data = { images, results: images.map(image => ({ image, results: [] })),
            isDone: true, inProgress: false, batchSize: 1 };
        const reply = deferred();
        const dependencies = { chrome: f.chrome, mangaRecovery: recovery, log,
            isSuccessfulPretranslation: value => Boolean(value?.isDone &&
                value.results?.length === value.images?.length && !value.results.some(result => result.error)),
            pretranslatedChaptersMap: new Map([[nextUrl, data]]) };
        const start = source.indexOf("  if (message.action === 'CONSUME_PRETRANSLATED_CHAPTER')");
        const end = source.indexOf("  if (message.action === 'START_MANGA_BATCH_PC_MODE')", start);
        const handler = new Function(...Object.keys(dependencies), 'message', 'sender', 'sendResponse', source.slice(start, end));
        handler(...Object.values(dependencies), { action: 'CONSUME_PRETRANSLATED_CHAPTER',
            payload: { nextUrl, sourceTabId: 1 } }, { tab: { id: 2 } }, reply.resolve);
        const result = await reply.promise;
        expect(result).toMatchObject({ success: true, job: {
            status: 'completed', sourceTabId: null, isPretranslatedChapter: true } });
        expect(result.job.results).toHaveLength(2);
    });

    it('actual completed-pretranslation writer stores only serializable snapshot and skips private sources', async () => {
        let privateSource = false;
        let cache = {};
        const update = vi.fn(async (_key, transform) => { cache = structuredClone(transform(cache)); });
        const save = productionFunction('savePretranslatedChapterToStorage', 'async function getPretranslatedChapterFromStorage', {
            state: { update }, pretranslationStorageKey: () => 'cache', createPretranslationSnapshot,
            isTabIncognito: async () => privateSource, log
        });
        const data = { url: 'https://manga.test/ch2', sourceTabId: 1, images,
            results: [], isDone: true, inProgress: true, consumptionReady: Promise.resolve(), foregroundJob: { id: 'private-owner' } };
        await save(data.url, data);
        expect(update).toHaveBeenCalledTimes(1);
        expect(cache[data.url].inProgress).toBe(false);
        expect(cache[data.url]).not.toHaveProperty('consumptionReady');
        expect(cache[data.url]).not.toHaveProperty('foregroundJob');
        privateSource = true;
        await save(data.url, data);
        expect(update).toHaveBeenCalledTimes(1);
    });
    it('reports a cache write failure so the caller can preserve its checkpoint', async () => {
        const save = productionFunction('savePretranslatedChapterToStorage', 'async function getPretranslatedChapterFromStorage', {
            state: { update: async () => { throw new Error('quota exceeded'); } },
            pretranslationStorageKey: () => 'cache', createPretranslationSnapshot,
            isTabIncognito: async () => false, log
        });
        await expect(save('https://manga.test/ch2', { url: 'https://manga.test/ch2', sourceTabId: 1,
            images, results: [], isDone: true })).rejects.toMatchObject({ cacheWriteFailed: true,
            message: 'quota exceeded' });
    });
    it('consume reports failure rather than marking an empty snapshot complete when navigation belongs to another chapter', async () => {
        const f = fixture();
        const recovery = createMangaRecovery(f.chrome);
        const nextUrl = 'https://manga.test/ch2';
        const data = { images, results: images.map(image => ({ image, results: [] })), isDone: true, batchSize: 1 };
        f.chrome.tabs.update.mockImplementation(async () => {
            f.tabs.get(1).pendingUrl = 'https://manga.test/unrelated';
            return f.tabs.get(1);
        });
        const reply = deferred();
        const dependencies = { chrome: f.chrome, mangaRecovery: recovery, log,
            isSuccessfulPretranslation: data => Boolean(data?.isDone && data.results?.length === data.images?.length && !data.results.some(result => result.error)),
            pretranslatedChaptersMap: new Map([[nextUrl, data]]) };
        const start = source.indexOf("  if (message.action === 'CONSUME_PRETRANSLATED_CHAPTER')");
        const end = source.indexOf("  if (message.action === 'START_MANGA_BATCH_PC_MODE')", start);
        const handler = new Function(...Object.keys(dependencies), 'message', 'sender', 'sendResponse', source.slice(start, end));
        handler(...Object.values(dependencies), { action: 'CONSUME_PRETRANSLATED_CHAPTER', payload: { nextUrl, sourceTabId: 1 } }, { tab: { id: 2 } }, reply.resolve);
        const result = await reply.promise;
        expect(result.success).toBe(false);
        expect(await recovery.snapshot(2)).toBeNull();
    });

});
