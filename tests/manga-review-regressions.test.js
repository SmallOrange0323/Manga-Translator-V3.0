import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createMangaRecovery } from '../src/background/manga-recovery.js';
import { createMangaResultUpdate } from '../src/background/manga-result-update.js';
import { convertCnToTwLocal } from '../src/utils/zh-tw-localizer.js';

function fixture() {
    const data = {};
    const chrome = {
        extension: { inIncognitoContext: false },
        runtime: { getURL: path => `chrome-extension://test/${path}` },
        storage: { local: {
            get: vi.fn(async key => structuredClone({ [key]: data[key] })),
            set: vi.fn(async value => Object.assign(data, structuredClone(value)))
        } },
        tabs: {
            query: vi.fn(async () => []),
            get: vi.fn(async id => ({ id, incognito: false, url: 'https://manga.test/ch1' })),
            sendMessage: vi.fn(async () => {})
        }
    };
    const recovery = createMangaRecovery(chrome);
    const begin = images => recovery.begin({ sourceTabId: 1, resultTabId: 2, images, batchSize: 1 });
    return { chrome, data, recovery, begin };
}
const temporary = name => `data:image/jpeg;base64,${name}`;
const row = (image, pageIndex = 1) => ({ image, pageIndex, batchIndex: 0,
    results: [{ original: 'a', translation: 'OLD_A' }, { original: 'b', translation: 'OLD_B' }] });

describe('temporary image ownership', () => {
    it('rejects old commits and retranslation responses without changing a new job image', async () => {
        const f = fixture();
        const old = await f.begin([temporary('OLD')]);
        const current = await f.begin([temporary('NEW')]);
        await f.recovery.commit(current, 1, [row(temporary('NEW'))]);
        expect(await f.recovery.commit(old, 1, [row(temporary('OLD'))])).toBeNull();
        expect(await f.recovery.replaceResult(2, old.id, 1, row(temporary('LATE')))).toBeNull();
        await f.recovery.publish(old, [row(temporary('STALE_PUBLISH'))]);
        const snapshot = await f.recovery.snapshot(2);
        expect(snapshot.id).toBe(current.id);
        expect(snapshot.results[0].image).toBe(temporary('NEW'));
        expect(f.recovery.getMemoryImage(2, 1, old.id)).toBe('');
        expect(f.recovery.getMemoryImage(2, 1, current.id)).toBe(temporary('NEW'));
        expect(JSON.stringify(f.data)).not.toContain('base64');
    });

    it('does not cache pixels from a rejected STOP commit or failed storage write', async () => {
        const f = fixture();
        const job = await f.begin([temporary('ORIGINAL')]);
        await f.recovery.commit(job, 1, [row(temporary('ORIGINAL'))]);
        expect(await f.recovery.commit(job, 1, [row(temporary('STOPPED'))], () => false)).toBeNull();
        f.chrome.storage.local.set.mockRejectedValueOnce(new Error('storage failed'));
        await expect(f.recovery.commit(job, 1, [row(temporary('FAILED'))])).rejects.toThrow('storage failed');
        expect((await f.recovery.snapshot(2)).results[0].image).toBe(temporary('ORIGINAL'));
    });

    it('retains other temporary pages on a partial chapter retry', async () => {
        const f = fixture();
        const images = [temporary('ONE'), temporary('TWO')];
        const job = await f.begin(images);
        await f.recovery.commit(job, 2, images.map((image, index) => row(image, index + 1)));
        await f.recovery.status(job, 'completed');
        const retry = await f.recovery.begin({ sourceTabId: 1, resultTabId: 2,
            images: [images[1]], batchSize: 1, isRetry: true, retryPageIndices: [2] });
        await f.recovery.commit(retry, 1, [row(images[1], 2)]);
        expect((await f.recovery.snapshot(2)).results.map(item => item.image)).toEqual(images);
        expect(await f.recovery.replaceResult(2, job.id, 1, row(temporary('LATE')))).toBeNull();
        expect((await f.recovery.snapshot(2)).results.map(item => item.image)).toEqual(images);
    });

    it('transfers completed temporary images to an owned resumed job', async () => {
        const f = fixture();
        const job = await f.begin([temporary('ONE'), 'https://manga.test/two.jpg']);
        await f.recovery.commit(job, 1, [row(temporary('ONE'))]);
        await f.recovery.stop();
        const resumed = await f.recovery.resume(2, job.id);
        expect(resumed.id).not.toBe(job.id);
        expect(resumed.results[0].image).toBe(temporary('ONE'));
        expect(await f.recovery.commit(job, 1, [row(temporary('LATE'))])).toBeNull();
        expect((await f.recovery.snapshot(2)).results[0].image).toBe(temporary('ONE'));
    });

    it('records an accepted functional image update but rejects a later conflicting replacement', async () => {
        const f = fixture();
        const job = await f.begin([temporary('ORIGINAL')]);
        await f.recovery.commit(job, 1, [row(temporary('ORIGINAL'))]);
        const expected = (await f.recovery.snapshot(2)).results[0];
        const change = createMangaResultUpdate(expected, { image: temporary('UPDATED'),
            results: [{ original: 'a', translation: 'NEW_A' }] });
        expect(await f.recovery.replaceResult(2, job.id, 1, change)).not.toBeNull();
        const late = createMangaResultUpdate(expected, { image: temporary('LATE'),
            results: [{ original: 'a', translation: 'STALE' }] });
        expect(await f.recovery.replaceResult(2, job.id, 1, late)).toBeNull();
        expect((await f.recovery.snapshot(2)).results[0].image).toBe(temporary('UPDATED'));
    });
});

const background = readFileSync(new URL('../src/background/index.js', import.meta.url), 'utf8');
const textHandler = background.slice(background.indexOf("if (message.action === 'retranslateText')"),
    background.indexOf("if (message.action === 'retranslateNovelParagraph')"));

async function retranslationHarness() {
    const f = fixture();
    const job = await f.begin(['https://manga.test/one.jpg']);
    await f.recovery.commit(job, 1, [row('https://manga.test/one.jpg')]);
    const requests = [], responses = [];
    const dependencies = {
        mangaRecovery: f.recovery, createMangaResultUpdate,
        state: { get: async (key, def) => key === 'globalGlossaryEnabled' ? false : def },
        Constants: { DEFAULT_PROMPT_TWO_STEP: 'text', DEFAULT_PROMPT_GEMMA_ONE_STEP: 'text' },
        loadGlossary: vi.fn(), buildGlossaryPromptSnippet: vi.fn(),
        translateTexts: texts => new Promise(resolve => requests.push({ texts, resolve })),
        console: { error: vi.fn() }
    };
    const handler = new Function(...Object.keys(dependencies), 'message', 'sender', 'sendResponse', textHandler);
    const start = (text, lineIndex) => {
        const slot = responses.length;
        responses.push(null);
        expect(handler(...Object.values(dependencies), { action: 'retranslateText', text, pageIndex: 1,
            ...(lineIndex === undefined ? {} : { lineIndex }) }, { tab: { id: 2 } }, reply => { responses[slot] = reply; })).toBe(true);
    };
    const finish = async (index, translations) => {
        await vi.waitFor(() => expect(requests[index]).toBeDefined());
        requests[index].resolve({ results: translations.map((translation, i) => ({
            original: requests[index].texts[i], translation
        })), usedModelName: 'test-model' });
        await vi.waitFor(() => expect(responses[index]).not.toBeNull());
    };
    return { ...f, job, requests, responses, start, finish };
}

describe('production text retranslation persistence', () => {
    it.each([[0, 1], [1, 0]])('merges different lines when replies finish in order %s then %s', async (first, second) => {
        const f = await retranslationHarness();
        f.start('a', 0);
        f.start('b', 1);
        await vi.waitFor(() => expect(f.requests).toHaveLength(2));
        await f.finish(first, [first === 0 ? 'NEW_A' : 'NEW_B']);
        await f.finish(second, [second === 0 ? 'NEW_A' : 'NEW_B']);
        expect(f.responses.every(response => response.results?.length)).toBe(true);
        expect((await f.recovery.snapshot(2)).results[0].results.map(line => line.translation)).toEqual(['NEW_A', 'NEW_B']);
    });

    it('rejects a late response to a line that has already been edited', async () => {
        const f = await retranslationHarness();
        f.start('a-first', 0);
        f.start('a-later', 0);
        await vi.waitFor(() => expect(f.requests).toHaveLength(2));
        await f.finish(1, ['LATEST_A']);
        await f.finish(0, ['STALE_A']);
        expect(f.responses[0]).toMatchObject({ success: false });
        expect((await f.recovery.snapshot(2)).results[0].results[0].translation).toBe('LATEST_A');
    });

    it('does not let a pending whole-page retranslation undo a completed line edit', async () => {
        const f = await retranslationHarness();
        f.start('a\n\nb');
        f.start('b', 1);
        await vi.waitFor(() => expect(f.requests).toHaveLength(2));
        await f.finish(1, ['NEW_B']);
        await f.finish(0, ['PAGE_A', 'PAGE_B']);
        expect(f.responses[0]).toMatchObject({ success: false });
        expect((await f.recovery.snapshot(2)).results[0].results.map(line => line.translation)).toEqual(['OLD_A', 'NEW_B']);
    });

    it('reports failure when the job was replaced while the API was pending', async () => {
        const f = await retranslationHarness();
        f.start('a', 0);
        await vi.waitFor(() => expect(f.requests).toHaveLength(1));
        const current = await f.begin([temporary('NEW_JOB')]);
        await f.recovery.commit(current, 1, [row(temporary('NEW_JOB'))]);
        await f.finish(0, ['STALE_A']);
        expect(f.responses[0]).toMatchObject({ success: false });
        expect((await f.recovery.snapshot(2)).results[0].image).toBe(temporary('NEW_JOB'));
    });

    it('rejects incomplete whole-page output without truncating saved lines', async () => {
        const f = await retranslationHarness();
        f.start('a\n\nb');
        await f.finish(0, ['ONLY_A']);
        expect(f.responses[0]).toMatchObject({ success: false });
        expect((await f.recovery.snapshot(2)).results[0].results.map(line => line.translation)).toEqual(['OLD_A', 'OLD_B']);
    });
});

const stream = readFileSync(new URL('../src/reader/stream-reader.js', import.meta.url), 'utf8');
const streamFunctions = stream.slice(stream.indexOf('async function resolvePageDirectImageUrl('),
    stream.indexOf('// 導航到其他章節', stream.indexOf('async function resolvePageDirectImageUrl(')));
function streamHarness(failures = []) {
    const messages = [], alerts = [];
    const btnTransAll = { disabled: false, innerHTML: '全本翻譯' };
    const failed = new Set(failures);
    const dependencies = {
        loadedImagesMap: new Map(), totalPages: 3, btnTransAll, activeMangaKey: 'test',
        mangaData: { title: 'test', pages: [1, 2, 3].map(index => ({ url: `https://manga.test/${index}` })) },
        extractImgUrl: (_html, url) => `${url}.jpg`, alert: text => alerts.push(text),
        chrome: { runtime: { sendMessage: (message, reply) => {
            if (message.action === 'FETCH_HTML') reply(failed.has(Number(message.url.split('/').at(-1)))
                ? { success: false, error: 'HTTP 503' } : { success: true, html: 'image' });
            else { messages.push(message); reply({ success: true }); }
        } } }, console: { log: vi.fn(), warn: vi.fn() }
    };
    const translate = new Function(...Object.keys(dependencies), streamFunctions + '\nreturn translateAllPages;')(...Object.values(dependencies));
    return { translate, messages, alerts, failed, btnTransAll };
}

describe('stream whole-book completeness', () => {
    it.each([{ failures: [2] }, { failures: [1] }, { failures: [1, 2, 3] }])('stops instead of dropping missing pages $failures', async ({ failures }) => {
        const f = streamHarness(failures);
        await f.translate();
        expect(f.messages).toHaveLength(0);
        expect(f.alerts).toHaveLength(1);
        for (const index of failures) expect(f.alerts[0]).toContain(String(index));
        expect(f.btnTransAll).toEqual({ disabled: false, innerHTML: '全本翻譯' });
    });

    it('allows retry after the missing image resolves and preserves original page order', async () => {
        const f = streamHarness([2]);
        await f.translate();
        f.failed.clear();
        await f.translate();
        expect(f.messages).toHaveLength(1);
        expect(f.messages[0].payload.images).toEqual([1, 2, 3].map(index => `https://manga.test/${index}.jpg`));
        expect(f.btnTransAll.disabled).toBe(false);
    });
});

describe('Taiwanese usage regression', () => {
    it.each([
        '視頻與網絡，默認用戶可以複制',
        '视频与网络，默认用户可以复制',
        '视頻与網络，默認用戶可以复製'
    ])('handles simplified, Traditional and mixed input: %s', input => {
        expect(convertCnToTwLocal(input)).toBe('影片與網路，預設使用者可以複製');
    });

    it('retains the old audio, disk, menu, activation and recharge terms', () => {
        expect(convertCnToTwLocal('音頻、硬盤、光盤、鼠標、菜單、二進制、激活、充值')).toBe(
            '音訊、硬碟、光碟、滑鼠、選單、二進位、啟用、儲值');
        expect(convertCnToTwLocal('音频、硬盘、光盘、鼠标、菜单、二进制、激活、充值')).toBe(
            '音訊、硬碟、光碟、滑鼠、選單、二進位、啟用、儲值');
    });

    it('preserves correct Taiwanese text and ambiguous characters, including on repeated conversion', () => {
        const input = '臺灣的使用者用滑鼠複製影片，皇后在五公里外的故里整理頭髮。';
        expect(convertCnToTwLocal(input)).toBe(input);
        expect(convertCnToTwLocal(convertCnToTwLocal('太后与皇后坐在后面，头发擦干净'))).toBe(
            '太后與皇后坐在後面，頭髮擦乾淨');
    });
});
