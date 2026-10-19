import { readFileSync } from 'node:fs';
import { describe, it, expect, vi } from 'vitest';
import { createLocalMangaUploads } from '../src/background/local-manga-uploads.js';
import { uploadLocalMangaImages, LOCAL_IMAGE_CHUNK_SIZE } from '../src/utils/local-manga-upload.js';
import { createMangaRecovery } from '../src/background/manga-recovery.js';
import { createMangaImageReceiver, mangaWireSnapshot } from '../src/utils/manga-image-messages.js';

const background = readFileSync(new URL('../src/background/index.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const sidepanel = readFileSync(new URL('../src/sidepanel/main.js', import.meta.url), 'utf8');
const temporary = value => 'data:image/jpeg;base64,' + value;
function bridge(store, overrides = {}) {
    let largest = 0;
    const start = vi.fn(async request => ({ status: 'ok', resultTabId: 2, received: store.take(request.payload.uploadId) }));
    const sendMessage = vi.fn(async request => {
        const size = Buffer.byteLength(JSON.stringify(request));
        largest = Math.max(largest, size);
        if (size > 64 * 1024 * 1024) throw new Error('Message length exceeded maximum allowed length.');
        if (request.action === 'BEGIN_LOCAL_MANGA_UPLOAD') return { status: 'ok', uploadId: store.begin(request.images) };
        if (request.action === 'APPEND_LOCAL_MANGA_UPLOAD') { store.append(request.uploadId, request.index, request.offset, request.data); return { status: 'ok' }; }
        if (request.action === 'CANCEL_LOCAL_MANGA_UPLOAD') { store.cancel(request.uploadId); return { status: 'ok' }; }
        return start(request);
    });
    return { chrome: { runtime: { sendMessage }, ...overrides }, start, largest: () => largest };
}
function buttonFixture(images, chrome) {
    const elements = new Map(['mt-batch-trans-btn', 'mt-stop-btn', 'mt-start-btn'].map(id => [id, { style: {} }]));
    const controls = { style: {} }, actions = { style: {} };
    const show = vi.fn(), alert = vi.fn();
    const start = sidepanel.indexOf('let isStartingBatch = false;');
    const end = sidepanel.indexOf('function clearPreviewList()', start);
    const dependencies = { chrome, document: { getElementById: id => elements.get(id),
        querySelector: selector => selector === '.mt-batch-controls' ? controls : actions },
        resultsContainer: { querySelectorAll: () => images.map((_, index) => ({ dataset: { index: String(index) } })) },
        uploadLocalMangaImages, showTranslatingCard: show, updateBatchCount: vi.fn(), alert };
    const read = new Function(...Object.keys(dependencies), 'images',
        'let candidateImages = images; let candidateNavLinks = {prev:null,next:null}; let currentMangaKey = null;\n' +
        sidepanel.slice(start, end) + '\nreturn () => candidateImages;')(...Object.values(dependencies), images);
    return { button: elements.get('mt-batch-trans-btn'), controls, actions, show, alert, read };
}
function functionFromSource(name, endMarker, dependencies) {
    const start = background.indexOf('async function ' + name + '(');
    const end = background.indexOf(endMarker, start);
    return new Function(...Object.keys(dependencies), background.slice(start, end) + '\nreturn ' + name)(...Object.values(dependencies));
}
function recoveryFixture() {
    const data = {}, tabs = new Map([[2, { id: 2, incognito: false, url: 'chrome-extension://test/src/reader/result.html' }]]);
    const chrome = { runtime: { getURL: path => `chrome-extension://test/${path}` },
        storage: { local: { get: async key => structuredClone({ [key]: data[key] }),
            set: async value => Object.assign(data, structuredClone(value)) } },
        tabs: { query: async () => [...tabs.values()], get: async id => {
            if (!tabs.has(id)) throw new Error('No tab with id ' + id);
            return tabs.get(id);
        }, sendMessage: vi.fn(async () => {}) } };
    return { chrome, data, tabs, recovery: createMangaRecovery(chrome) };
}

describe('local image upload and translation launch', () => {
    it('reproduces the 64 MiB failure and starts 170 images through the actual button with bounded messages', async () => {
        const images = Array.from({ length: 170 }, (_, i) => ({ id: `page-${i}`, src: temporary('A'.repeat(512 * 1024) + i) }));
        const f = bridge(createLocalMangaUploads(), { tabs: { query: async () => [] } });
        await expect(f.chrome.runtime.sendMessage({ action: 'START_MANGA_BATCH_PC_MODE', payload: { images } }))
            .rejects.toThrow('Message length exceeded');
        const page = buttonFixture(images, f.chrome);
        await page.button.onclick();
        expect(page.alert).not.toHaveBeenCalled();
        expect(page.show).toHaveBeenCalledWith(170);
        const launched = f.start.mock.calls[0][0];
        expect(launched.payload).toMatchObject({ tabId: null });
        expect(launched.payload).not.toHaveProperty('images');
        await expect(f.start.mock.results[0].value).resolves.toMatchObject({ received: images });
        const chunkSizes = f.chrome.runtime.sendMessage.mock.calls.slice(1).map(([request]) => Buffer.byteLength(JSON.stringify(request)));
        expect(Math.max(...chunkSizes)).toBeLessThan(3 * 1024 * 1024);
        expect(page.button.disabled).toBe(false);
    }, 20000);

    it('chunks a single oversized image and preserves order and exact bytes', async () => {
        const src = temporary('B'.repeat(LOCAL_IMAGE_CHUNK_SIZE * 3 + 1));
        const images = [{ id: 8, src }, { id: 4, src: temporary('SECOND') }];
        const f = bridge(createLocalMangaUploads());
        const progress = vi.fn();
        const result = await uploadLocalMangaImages(f.chrome, images, {}, progress);
        expect(result.received).toEqual(images);
        expect(f.largest()).toBeLessThan(3 * 1024 * 1024);
        expect(progress.mock.calls).toEqual([[1, 2], [2, 2]]);
    });

    it('keeps selected images, reports a rejected transfer and allows retry without double submission', async () => {
        let release;
        const chrome = { tabs: { query: async () => [] }, runtime: { sendMessage: vi.fn(() => new Promise(resolve => { release = resolve; })) } };
        const images = [{ src: temporary('KEEP') }];
        const page = buttonFixture(images, chrome);
        const running = page.button.onclick();
        await vi.waitFor(() => expect(release).toBeTypeOf('function'));
        await page.button.onclick();
        expect(chrome.runtime.sendMessage).toHaveBeenCalledOnce();
        release({ status: 'error', error: '傳送失敗' });
        await running;
        expect(page.show).not.toHaveBeenCalled();
        expect(page.read()).toBe(images);
        expect(page.alert).toHaveBeenCalledWith('無法開始翻譯：傳送失敗');
        expect(page.button.disabled).toBe(false);
        const retry = page.button.onclick();
        await vi.waitFor(() => expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(2));
        release({ status: 'error', error: '背景中斷' });
        await retry;
    });

    it('rejects missing selections with a visible error rather than a click exception', async () => {
        const page = buttonFixture([undefined], { tabs: { query: vi.fn() } });
        await page.button.onclick();
        expect(page.alert).toHaveBeenCalledWith('無法開始翻譯：選圖清單已變更，請重新選取圖片');
        expect(page.button.disabled).toBe(false);
    });

    it('cancels staged data when the worker expires the upload and never starts partial images', async () => {
        const store = createLocalMangaUploads();
        const f = bridge(store);
        f.chrome.runtime.sendMessage.mockImplementationOnce(async () => ({ status: 'ok', uploadId: 'expired' }));
        await expect(uploadLocalMangaImages(f.chrome, [{ src: temporary('A') }], {})).rejects.toThrow('傳送已中斷');
        expect(f.start).not.toHaveBeenCalled();
        expect(f.chrome.runtime.sendMessage).toHaveBeenLastCalledWith({ action: 'CANCEL_LOCAL_MANGA_UPLOAD', uploadId: 'expired' });
    });

    it('rejects skipped/duplicate chunks and incomplete transfers, and expires abandoned uploads', () => {
        let now = 0;
        const store = createLocalMangaUploads(() => now);
        const src = temporary('TEST');
        const id = store.begin([{ id: 1, length: src.length }]);
        expect(() => store.take(id)).toThrow('尚未傳送完成');
        expect(() => store.append(id, 0, 1, src)).toThrow('傳送順序');
        store.append(id, 0, 0, src);
        expect(() => store.append(id, 0, 0, src)).toThrow('傳送順序');
        now = 5 * 60 * 1000 + 1;
        expect(() => store.take(id)).toThrow('傳送已中斷');
    });

    it('waits for actual reader startup and sends its error instead of a premature success', async () => {
        const start = background.indexOf("  if (message.action === 'START_MANGA_BATCH_PC_MODE')");
        const end = background.indexOf('// 查詢特定分頁', start);
        const open = vi.fn(async () => { throw new Error('漫畫暫存已達容量上限'); });
        const route = new Function('message', 'sender', 'sendResponse', 'openNewResultPage', 'log', background.slice(start, end));
        const reply = vi.fn();
        expect(route({ action: 'START_MANGA_BATCH_PC_MODE', payload: { images: [temporary('LOCAL')], tabId: 1 } }, {}, reply, open, { error() {} })).toBe(true);
        expect(reply).not.toHaveBeenCalled();
        await vi.waitFor(() => expect(reply).toHaveBeenCalledWith({ status: 'error', error: '漫畫暫存已達容量上限' }));
        expect(open.mock.calls[0][0]).toBeNull();
    });

    it('removes only its newly created blank reader when startup fails', async () => {
        const chrome = { tabs: { create: vi.fn(async () => ({ id: 55 })), remove: vi.fn(async () => {}) } };
        const recovery = { begin: vi.fn(async () => { throw new Error('容量上限'); }), remove: vi.fn(async () => {}) };
        const pending = new Map();
        const open = functionFromSource('openNewResultPage', '\n/**', { chrome, mangaRecovery: recovery, pendingMangaJobs: pending,
            state: { get: async () => 1 } });
        await expect(open(null, [temporary('A')])).rejects.toThrow('容量上限');
        expect(chrome.tabs.remove).toHaveBeenCalledOnce();
        expect(chrome.tabs.remove).toHaveBeenCalledWith(55);
        expect(recovery.remove).toHaveBeenCalledOnce();
        expect(recovery.remove).toHaveBeenCalledWith(55);
        expect(pending.size).toBe(0);
    });

    it('retains the webpage translation launch for URL selections', async () => {
        const sendMessage = vi.fn(async () => ({ status: 'ok' }));
        const page = buttonFixture(['https://manga.test/page.jpg'], {
            tabs: { query: async () => [{ id: 9, windowId: 4 }] }, runtime: { sendMessage } });
        await page.button.onclick();
        expect(sendMessage).toHaveBeenCalledOnce();
        expect(sendMessage.mock.calls[0][0].payload).toMatchObject({ tabId: 9, windowId: 4, images: [{ src: 'https://manga.test/page.jpg' }] });
        expect(page.show).toHaveBeenCalledWith(1);
    });
});

describe('bounded local image result delivery', () => {
    it('delivers a 170 page snapshot in bounded messages without persisting pixels and can replay to a reloaded reader', async () => {
        const f = recoveryFixture();
        const image = temporary('A'.repeat(512 * 1024));
        const images = Array(170).fill(image);
        const job = await f.recovery.begin({ sourceTabId: null, resultTabId: 2, images, batchSize: 5 });
        let current, received = new Map(), largest = 0;
        const receive = createMangaImageReceiver(() => current, (index, src) => received.set(index, src));
        f.chrome.tabs.sendMessage.mockImplementation(async (_id, message) => {
            largest = Math.max(largest, Buffer.byteLength(JSON.stringify(message)));
            if (message.action === 'mangaSnapshot') current = message.job;
            else receive(message);
        });
        const rows = images.map((image, i) => ({ image, pageIndex: i + 1, results: [{ original: 'a', translation: `譯文${i}` }] }));
        await f.recovery.commit(job, 170, rows);
        expect(received.size).toBe(170);
        expect(received.get(170)).toBe(image);
        expect(largest).toBeLessThan(3 * 1024 * 1024);
        expect(JSON.stringify(f.data)).not.toContain('base64');
        const snapshot = await f.recovery.snapshot(2);
        expect(JSON.stringify(mangaWireSnapshot(snapshot)).length).toBeLessThan(100000);
        received = new Map();
        await f.recovery.publish(snapshot);
        expect(received.size).toBe(170);
        f.chrome.tabs.sendMessage.mockClear();
        await f.recovery.status(job, 'completed');
        expect(f.chrome.tabs.sendMessage).toHaveBeenCalledOnce();
        expect(f.chrome.tabs.sendMessage.mock.calls[0][1].job.status).toBe('completed');
    }, 20000);

    it('serializes publication so a later status cannot overtake an image transfer', async () => {
        const f = recoveryFixture();
        const image = temporary('A'.repeat(LOCAL_IMAGE_CHUNK_SIZE + 1));
        const job = await f.recovery.begin({ sourceTabId: null, resultTabId: 2, images: [image], batchSize: 1 });
        let release;
        const pause = new Promise(resolve => { release = resolve; });
        f.chrome.tabs.sendMessage.mockImplementation(async (_id, message) => { if (message.action === 'mangaImageChunk' && message.offset === 0) await pause; });
        const commit = f.recovery.commit(job, 1, [{ image, pageIndex: 1, results: [] }]);
        await vi.waitFor(() => expect(f.chrome.tabs.sendMessage.mock.calls.some(([, message]) => message.action === 'mangaImageChunk')).toBe(true));
        const status = f.recovery.status(job, 'completed');
        release();
        await Promise.all([commit, status]);
        const messages = f.chrome.tabs.sendMessage.mock.calls.map(([, message]) => message);
        const completed = messages.findIndex(message => message.job?.status === 'completed');
        expect(messages.filter(message => message.action === 'mangaImageChunk')).toHaveLength(2);
        expect(completed).toBeGreaterThan(messages.findLastIndex(message => message.action === 'mangaImageChunk'));
    });
});
