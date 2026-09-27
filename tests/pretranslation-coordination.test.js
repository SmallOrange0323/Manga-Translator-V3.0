import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/background/index.js', import.meta.url), 'utf8');
const start = source.indexOf('function startPretranslateNextChapter(');
const end = source.indexOf('async function runPretranslateNextChapter(', start);
if (start < 0 || end < 0) throw new Error('Pretranslation coordinator boundary missing');

function coordinator(run) {
    const chrome = { tabs: { get: vi.fn(async id => ({ id })) } };
    const statuses = [];
    const startJob = new Function('chrome', 'runPretranslateNextChapter', 'setPretranslationStatus',
        'let pretranslationQueue = Promise.resolve(); const queuedPretranslationUrls = new Set();\n' +
        source.slice(start, end) + '\nreturn startPretranslateNextChapter;')(
        chrome, run, async (...args) => { statuses.push(args); });
    return { startJob, chrome, statuses };
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
