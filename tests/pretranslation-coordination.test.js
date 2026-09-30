import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createPretranslationQueueStore, PRETRANSLATION_QUEUE_KEY } from '../src/background/pretranslation-queue-store.js';

const source = readFileSync(new URL('../src/background/index.js', import.meta.url), 'utf8');
const start = source.indexOf('function startPretranslateNextChapter(');
const end = source.indexOf('async function runPretranslateNextChapter(', start);
if (start < 0 || end < 0) throw new Error('Pretranslation coordinator boundary missing');

function coordinator(run) {
    const chrome = { tabs: { get: vi.fn(async id => ({ id })) } };
    const statuses = [];
    const pretranslationQueueStore = { add: vi.fn(async () => true), remove: vi.fn(async () => {}) };
    const startJob = new Function('chrome', 'runPretranslateNextChapter', 'setPretranslationStatus', 'pretranslationQueueStore',
        'let pretranslationQueue = Promise.resolve(); const queuedPretranslationUrls = new Set();\n' +
        source.slice(start, end) + '\nreturn startPretranslateNextChapter;')(
        chrome, run, async (...args) => { statuses.push(args); }, pretranslationQueueStore);
    return { startJob, chrome, statuses, pretranslationQueueStore };
}

describe('pretranslation coordinator', () => {
    it('runs different chapters one at a time and deduplicates the same chapter', async () => {
        let releaseFirst;
        const first = new Promise(resolve => { releaseFirst = resolve; });
        const run = vi.fn(async url => { if (url === 'chapter-2') await first; });
        const { startJob } = coordinator(run);
        const a = startJob('chapter-2', 1, 2);
        const duplicate = startJob('chapter-2', 1, 2);
        const b = startJob('chapter-3', 1, 2);
        await duplicate;
        await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
        expect(run.mock.calls[0][0]).toBe('chapter-2');
        releaseFirst();
        await Promise.all([a, b]);
        expect(run.mock.calls.map(call => call[0])).toEqual(['chapter-2', 'chapter-3']);
    });

    it('skips a queued chapter when its source tab has closed', async () => {
        let releaseFirst;
        const first = new Promise(resolve => { releaseFirst = resolve; });
        const run = vi.fn(async url => { if (url === 'chapter-2') await first; });
        const { startJob, chrome } = coordinator(run);
        const a = startJob('chapter-2', 1, 2);
        const b = startJob('chapter-3', 3, 4);
        await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
        chrome.tabs.get.mockImplementation(async id => { if (id === 3) throw new Error('closed'); return { id }; });
        releaseFirst();
        await Promise.all([a, b]);
        expect(run).toHaveBeenCalledTimes(1);
    });
});

describe('pretranslation status persistence', () => {
    it('retains a compact failure after the worker state is rebuilt', async () => {
        const first = source.indexOf('async function setPretranslationStatus(');
        const last = source.indexOf('function isJestfulChapterUrl(', first);
        if (first < 0 || last < 0) throw new Error('Pretranslation status boundary missing');
        const values = new Map();
        const state = { get: async (key, fallback) => values.get(key) || fallback,
            update: async (key, updater) => values.set(key, await updater(values.get(key))) };
        const { setStatus, getStatus } = new Function('state', 'chrome', 'isIncognitoProcess',
            `const PRETRANS_STATUS_KEY = 'status';\n${source.slice(first, last)}\n` +
            'return { setStatus: setPretranslationStatus, getStatus: getPretranslationStatus };')(
                state, { tabs: { get: async () => ({ incognito: false }) } }, false);
        await setStatus('https://manga.test/ch2', 'error', 1, '圖片抓取失敗');
        expect(await getStatus('https://manga.test/ch2')).toMatchObject({ status: 'error', error: '圖片抓取失敗' });
        await setStatus('https://manga.test/ch2', null, 1);
        expect(await getStatus('https://manga.test/ch2')).toBeNull();
        await setStatus('https://manga.test/ch2', 'running', 1);
        const saved = values.get('status');
        saved['https://manga.test/ch2'].updatedAt -= 6 * 60 * 1000;
        expect(await getStatus('https://manga.test/ch2')).toMatchObject({ status: 'error', error: '背景預翻已中斷，可手動重試' });
    });
});

describe('queued pretranslation persistence', () => {
    it('restores pending regular jobs in order and never writes private jobs', async () => {
        const values = new Map();
        const state = { get: async (key, fallback) => values.get(key) || fallback,
            update: async (key, updater) => values.set(key, await updater(values.get(key))) };
        const chrome = { tabs: { get: async id => ({ id, incognito: id === 9 }) } };
        const first = createPretranslationQueueStore(state, chrome);
        expect(await first.add('chapter-2', 1, 2, false)).toBe(true);
        expect(await first.add('private', 9, 10, false)).toBe(false);
        expect(await first.add('chapter-3', 1, 2, true)).toBe(true);
        const restarted = createPretranslationQueueStore(state, chrome);
        expect((await restarted.pending()).map(item => item.url)).toEqual(['chapter-2', 'chapter-3']);
        expect(values.get(PRETRANSLATION_QUEUE_KEY)).not.toHaveProperty('private');
        await restarted.remove('chapter-2');
        expect((await restarted.pending()).map(item => item.url)).toEqual(['chapter-3']);
    });

    it('replays unfinished queue records after a worker restart', async () => {
        const first = source.indexOf('async function restoreQueuedPretranslations()');
        const last = source.indexOf('async function restorePretranslationCheckpoints()', first);
        if (first < 0 || last < 0) throw new Error('Queue restore boundary missing');
        const remove = vi.fn(async () => {});
        const startJob = vi.fn(async () => {});
        const restore = new Function('pretranslationQueueStore', 'chrome', 'queuedPretranslationUrls',
            'getPretranslatedChapterFromStorage', 'isSuccessfulPretranslation', 'startPretranslateNextChapter', 'log',
            source.slice(first, last) + '\nreturn restoreQueuedPretranslations;')(
            { pending: async () => [
                { url: 'done', sourceTabId: 1 }, { url: 'pending', sourceTabId: 1 },
                { url: 'closed', sourceTabId: 3 }
            ], remove },
            { tabs: { get: async id => id === 3 ? Promise.reject(new Error('closed')) : { id, incognito: false } } },
            new Set(), async url => url === 'done' ? { isDone: true, images: ['a'], results: [{}] } : null,
            data => !!data?.isDone, startJob, { warn: vi.fn() });
        await restore();
        expect(startJob).toHaveBeenCalledOnce();
        expect(startJob.mock.calls[0][0]).toBe('pending');
        expect(remove.mock.calls.map(call => call[0])).toEqual(['done', 'closed']);
    });
});
