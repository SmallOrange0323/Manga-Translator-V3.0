import { createMangaJobStore } from './manga-job-store.js';

// The coordinator is also used by the foreground loop and reader message routes.
export function createMangaRecovery(chromeApi) {
    let privateData = {};
    const privateStorage = {
        async get(key) { return structuredClone({ [key]: privateData[key] }); },
        async set(data) { Object.assign(privateData, structuredClone(data)); }
    };
    const privateStore = createMangaJobStore(privateStorage);
    const isPrivateWorker = Boolean(chromeApi.extension?.inIncognitoContext);
    // Split incognito workers must never read, recover, stop or delete regular jobs.
    const local = isPrivateWorker ? privateStore : createMangaJobStore(chromeApi.storage.local);
    const readerUrl = chromeApi.runtime.getURL('src/reader/result.html');
    const ready = isPrivateWorker ? Promise.resolve() : chromeApi.tabs.query({}).then(tabs => local.recover(tabs, readerUrl));
    ready.catch(() => {});
    async function storeFor(tabId) {
        const tab = await chromeApi.tabs.get(tabId);
        return tab.incognito || chromeApi.extension?.inIncognitoContext ? privateStore : local;
    }
    async function snapshot(tabId) {
        await ready;
        const store = await storeFor(tabId);
        const job = await store.get(tabId);
        if (job?.sourceTabId && job.sourceUrl && !job.isPretranslatedChapter) {
            const source = await chromeApi.tabs.get(job.sourceTabId).catch(() => null);
            if (!source || (source.pendingUrl || source.url) !== job.sourceUrl) {
                return { ...job, status: 'source-changed' };
            }
        }
        return job;
    }
    async function publish(job, liveItems = []) {
        if (!job) return;
        // Temporary image bytes are delivered only to the live page, never storage.
        const results = job.results.map(row => {
            const live = liveItems.find(item => item.pageIndex === row.pageIndex);
            return !row.image && live ? { ...row, image: live.image } : row;
        });
        await chromeApi.tabs.sendMessage(job.resultTabId, { action: 'mangaSnapshot', job: { ...job, results } }).catch(() => {});
    }
    async function begin(options) {
        await ready;
        const store = await storeFor(options.resultTabId);
        const source = options.sourceTabId ? await chromeApi.tabs.get(options.sourceTabId).catch(err => {
            if (!options.isPretranslatedChapter) throw err;
            return null;
        }) : null;
        const job = await store.begin({ ...options, sourceTabId: source ? options.sourceTabId : null,
            sourceUrl: options.sourceUrl || source?.pendingUrl || source?.url || '' });
        await publish(job);
        return job;
    }
    async function commit(job, count, items, canCommit = () => true) {
        const store = await storeFor(job.resultTabId);
        const current = await snapshot(job.resultTabId);
        if (current?.status === 'source-changed') return null;
        const saved = await store.commit(job.resultTabId, job.id, count, items, canCommit);
        if (saved) await publish(saved, items);
        return saved;
    }
    async function status(job, status) {
        const store = await storeFor(job.resultTabId);
        const saved = await store.status(job.resultTabId, job.id, status);
        await publish(saved);
        return saved;
    }
    async function resume(tabId, id) {
        const current = await snapshot(tabId);
        if (!current || current.status === 'source-changed') throw new Error('來源章節已變更，請從原網頁重新開始');
        const store = await storeFor(tabId);
        return store.resume(tabId, id);
    }
    async function replaceResult(tabId, id, pageIndex, result) {
        const store = await storeFor(tabId);
        const current = await snapshot(tabId);
        if (current?.status === 'source-changed') return null;
        const saved = await store.replaceResult(tabId, id, pageIndex, result);
        await publish(saved);
        return saved;
    }
    async function stop() {
        await ready;
        await Promise.all([local.stopAll(), privateStore.stopAll()]);
        const tabs = await chromeApi.tabs.query({});
        await Promise.all(tabs.filter(tab => tab.url?.startsWith(readerUrl)).map(async tab => publish(await snapshot(tab.id))));
    }
    async function remove(tabId) {
        await ready;
        await Promise.all([local.removeForTab(tabId), privateStore.removeForTab(tabId)]);
    }
    return { ready, snapshot, begin, commit, status, resume, stop, remove, publish, replaceResult };
}
