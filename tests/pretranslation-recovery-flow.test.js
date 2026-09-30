import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createPretranslationSnapshot, selectLatestInterruptedCheckpoint, getPretranslationResumeIndex } from '../src/background/pretranslation-checkpoint.js';
import { getPretranslationCompletion, mapPretranslationBatchResults } from '../src/background/manga-lifecycle.js';

const source = readFileSync(new URL('../src/background/index.js', import.meta.url), 'utf8');
function production(name, endMarker, deps, prefix = '') {
    const start = source.indexOf(`async function ${name}(`);
    const end = source.indexOf(endMarker, start);
    if (start < 0 || end < 0) throw new Error('Production boundary missing');
    return new Function(...Object.keys(deps), prefix + source.slice(start, end) + `\nreturn ${name};`)(...Object.values(deps));
}

describe('pretranslation restart coordination', () => {
    it('closing one reader leaves the shared stream and checkpoint alive for the other', async () => {
        const url = 'https://manga.test/ch2';
        const data = { sourceTabId: 1, associatedResultTabId: 2, consumedResultTabId: 3,
            foregroundConsumers: new Map([[2, {}], [3, {}]]) };
        const cache = new Map([[url, data]]);
        const clear = vi.fn(async () => {});
        const start = source.indexOf('  // 清理與該分頁關聯的跨話預翻快取');
        const end = source.indexOf('  // 1. 清除小說模式狀態', start);
        const close = new Function('pretranslatedChaptersMap', 'clearPretranslationCheckpointsForTabs', 'log',
            'let activePretranslateJob = pretranslatedChaptersMap.values().next().value;\n' +
            'return async function(tabId) {\n' + source.slice(start, end) + '\n};')(cache, clear, { info() {} });
        await close(2);
        expect(data.isCancelled).not.toBe(true);
        expect(cache.has(url)).toBe(true);
        expect([...data.foregroundConsumers.keys()]).toEqual([3]);
        expect(clear).toHaveBeenLastCalledWith(2, new Set([url]));
        await close(3);
        expect(data.isCancelled).toBe(true);
        expect(cache.has(url)).toBe(false);
        expect(clear).toHaveBeenLastCalledWith(3, new Set());
    });
    it('does not reuse normal persistent chapter caches or statuses from a private worker', async () => {
        const state = { get: vi.fn(async () => ({ private: 'must not be read' })) };
        const getCache = production('getPretranslatedChapterFromStorage', 'async function crawlChapterImagesAndNav', {
            isIncognitoProcess: true, state
        });
        const getStatus = production('getPretranslationStatus', 'function isJestfulChapterUrl', {
            isIncognitoProcess: true, state
        });
        expect(await getCache('https://manga.test/ch2')).toBeNull();
        expect(await getStatus('https://manga.test/ch2')).toBeNull();
        expect(state.get).not.toHaveBeenCalled();
    });
    it('leaves a consumed chapter to explicit foreground recovery rather than replaying background requests', async () => {
        const snapshot = createPretranslationSnapshot({ url: 'https://manga.test/ch2', images: ['1', '2'],
            results: [{ image: '1', results: [] }], sourceTabId: 1,
            consumedResultTabId: 2, inProgress: true, processedCount: 1 }, { includeConsumer: true });
        const startJob = vi.fn(async () => {});
        const removeQueue = vi.fn(async () => {});
        const removeCheckpoint = vi.fn(async () => {});
        const restore = production('restorePretranslationCheckpoints', '// 同步本地鎖', {
            getPretranslationCheckpoints: async () => ({ [snapshot.url]: snapshot }),
            selectLatestInterruptedCheckpoint, removePretranslationCheckpoint: removeCheckpoint,
            pretranslationQueueStore: { remove: removeQueue },
            startPretranslateNextChapter: startJob, log: { warn: vi.fn(), info: vi.fn() }
        });
        await restore();
        expect(startJob).not.toHaveBeenCalled();
        expect(removeQueue).toHaveBeenCalledWith(snapshot.url);
        expect(removeCheckpoint).toHaveBeenCalledWith(snapshot.url);
    });

    it.each([false, true])('uses the saved batch size and streams to each reader (consumed=%s)', async consumed => {
        const images = Array.from({ length: 6 }, (_, i) => `https://manga.test/${i}.jpg`);
        const cached = { url: 'https://manga.test/ch2', images, batchSize: 2,
            results: images.slice(0, 2).map(image => ({ image, results: [] })),
            processedCount: 2, status: 'interrupted', sourceTabId: 1, inProgress: false };
        if (consumed) cached.foregroundConsumers = new Map([2, 3].map(resultTabId =>
            [resultTabId, { job: { resultTabId }, ready: Promise.resolve() }]));
        const commit = vi.fn(async () => ({ processedCount: 6 }));
        const status = vi.fn(async () => {});
        const api = vi.fn(async () => ({ results: [{ results: [] }, { results: [] }], usedModelName: 'test' }));
        const fetchImages = vi.fn(async batch => batch.map(() => 'base64'));
        const saveCheckpoint = vi.fn(async () => {});
        const settings = { ocrBatchSize: 3, requestDelay: 0, hybridModeEnabled: false };
        const run = production('runPretranslateNextChapter', 'async function fetchAndResizeBatch', {
            pretranslatedChaptersMap: new Map([[cached.url, cached]]),
            state: { get: async (key, fallback) => settings[key] ?? fallback, apiKeys: ['fake'], getApiKeyAlias: () => 'fake' },
            getPretranslationResumeIndex, setPretranslationStatus: async () => {},
            Constants: { DEFAULT_PROMPT_ONE_STEP: 'test' }, swKeepAlive: { start() {}, stop() {} },
            log: { info() {}, warn() {} }, savePretranslationCheckpoint: saveCheckpoint,
            getEffectiveDelay: () => 0, getHybridSchedule: () => ({ modelName: 'test', keyIndex: 0 }),
            fetchAndResizeBatch: fetchImages, executeHybridRequest: api,
            mapPretranslationBatchResults, getPretranslationCompletion,
            mangaRecovery: { commit, status },
            savePretranslatedChapterToStorage: async () => {}, removePretranslationCheckpoint: async () => {},
            setTimeout: callback => queueMicrotask(callback)
        }, 'let activePretranslateJob = null;\n');
        await run(cached.url, 1, 2);
        expect(fetchImages.mock.calls.map(call => call[0])).toEqual([images.slice(2, 4), images.slice(4, 6)]);
        expect(api).toHaveBeenCalledTimes(2);
        expect(cached).toMatchObject({ isDone: true, processedCount: 6, batchSize: 2 });
        if (consumed) {
            expect(commit.mock.calls.map(call => call[0].resultTabId)).toEqual([2, 3, 2, 3]);
            expect(commit.mock.calls.map(call => call[2].map(row => row.pageIndex))).toEqual([[3, 4], [3, 4], [5, 6], [5, 6]]);
            expect(status.mock.calls.map(call => [call[0].resultTabId, call[1]])).toEqual([[2, 'completed'], [3, 'completed']]);
        }
    });
});
