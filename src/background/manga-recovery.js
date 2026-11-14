import { createMangaJobStore } from './manga-job-store.js';
import { createMangaImageIdbStore, isTransientImageUrl } from './manga-image-idb.js';
import { mangaWireSnapshot, mangaImageMessages } from '../utils/manga-image-messages.js';

// The coordinator is also used by the foreground loop and reader message routes.
export function createMangaRecovery(chromeApi, options = {}) {
    let privateData = {};
    const privateStorage = {
        async get(key) { return structuredClone({ [key]: privateData[key] }); },
        async set(data) { Object.assign(privateData, structuredClone(data)); }
    };
    const privateStore = createMangaJobStore(privateStorage);
    const isPrivateWorker = Boolean(chromeApi.extension?.inIncognitoContext);
    // Split incognito workers must never read, recover, stop or delete regular jobs.
    const local = isPrivateWorker ? privateStore : createMangaJobStore(chromeApi.storage.local);
    // 無痕 Worker 嚴禁建立或讀寫任何持久化 IndexedDB 儲存體
    const indexedDBApi = isPrivateWorker ? null : (options.indexedDB || chromeApi.indexedDB || globalThis.indexedDB);
    const idbStore = createMangaImageIdbStore(indexedDBApi);
    const readerUrl = chromeApi.runtime.getURL('src/reader/result.html');
    const ready = isPrivateWorker
        ? Promise.resolve()
        : chromeApi.tabs.query({}).then(async tabs => {
            await local.recover(tabs, readerUrl);
            const liveTabIds = new Set(
                tabs
                    .filter(tab => !tab?.incognito && (tab?.url?.startsWith(readerUrl) || tab?.pendingUrl?.startsWith(readerUrl)))
                    .map(tab => tab.id)
            );
            await idbStore.pruneTabs(liveTabIds);
        });
    ready.catch(() => {});
    const memoryImagesByTab = new Map();
    const publishQueues = new Map();
    const idbQueues = new Map();

    async function isIncognitoTab(tabId) {
        if (isPrivateWorker) return true;
        if (tabId == null) return false;
        const tab = await chromeApi.tabs.get(tabId).catch(() => null);
        return Boolean(tab?.incognito);
    }

    function enqueueIdb(tabId, fn) {
        if (isPrivateWorker || tabId == null) return Promise.resolve();
        const prev = idbQueues.get(tabId) || Promise.resolve();
        const next = prev.then(fn, fn).catch(() => {});
        idbQueues.set(tabId, next);
        next.finally(() => {
            if (idbQueues.get(tabId) === next) idbQueues.delete(tabId);
        });
        return next;
    }

    function flushIdb(tabId) {
        return idbQueues.get(tabId) || Promise.resolve();
    }

    function persistEntriesToIdb(tabId, jobId, entries, { replaceTab = false } = {}) {
        if (isPrivateWorker || tabId == null || !jobId) return Promise.resolve();
        if (!replaceTab && (!entries || entries.length === 0)) return Promise.resolve();
        return enqueueIdb(tabId, async () => {
            if (await isIncognitoTab(tabId)) return;
            if (replaceTab) {
                await idbStore.removeForTab(tabId);
            }
            if (entries && entries.length > 0) {
                await idbStore.putImages(tabId, jobId, entries);
            }
        });
    }

    function activateMemoryImages(job, images = [], retryPageIndices = null, resumedFromId = null) {
        const previous = memoryImagesByTab.get(job.resultTabId);
        if (previous && previous.createdAt > job.createdAt) return;
        const sameChapter = previous?.sourceTabId === job.sourceTabId && previous?.sourceUrl === job.sourceUrl;
        const preserve = sameChapter && (job.isRetry || previous?.id === resumedFromId);
        memoryImagesByTab.set(job.resultTabId, {
            id: job.id, createdAt: job.createdAt, sourceTabId: job.sourceTabId, sourceUrl: job.sourceUrl,
            images: preserve ? new Map(previous.images) : new Map(),
            idbHydrated: true
        });
        recordMemoryImages(job, images, null, retryPageIndices, {
            replaceTab: !job.isRetry && !resumedFromId,
            includeOwnerImages: preserve
        });
    }

    function recordMemoryImages(job, images = [], items = [], retryPageIndices = null, idbOptions = {}) {
        const owner = memoryImagesByTab.get(job.resultTabId);
        if (owner?.id !== job.id) return;
        const pageMap = owner.images;
        const transientEntries = [];
        if (Array.isArray(images)) {
            images.forEach((img, idx) => {
                const rawImg = typeof img === 'string' ? img : (typeof img?.src === 'string' ? img.src : '');
                const pageIndex = Array.isArray(retryPageIndices) && Number.isInteger(retryPageIndices[idx])
                    ? retryPageIndices[idx]
                    : idx + 1;
                if (rawImg && pageIndex > 0) {
                    pageMap.set(pageIndex, rawImg);
                    if (isTransientImageUrl(rawImg)) {
                        transientEntries.push([pageIndex, rawImg]);
                    }
                }
            });
        }
        if (Array.isArray(items)) {
            for (const item of items) {
                if (item && Number.isInteger(item.pageIndex) && typeof item.image === 'string' && item.image) {
                    pageMap.set(item.pageIndex, item.image);
                    if (isTransientImageUrl(item.image)) {
                        transientEntries.push([item.pageIndex, item.image]);
                    }
                }
            }
        }
        const entriesToPersist = idbOptions.includeOwnerImages
            ? Array.from(pageMap.entries()).filter(([, rawImg]) => isTransientImageUrl(rawImg))
            : transientEntries;
        persistEntriesToIdb(job.resultTabId, job.id, entriesToPersist, { replaceTab: Boolean(idbOptions.replaceTab) });
        return pageMap;
    }

    function hydrateJobImages(job, liveItems = []) {
        if (!job) return job;
        const owner = memoryImagesByTab.get(job.resultTabId);
        const pageMap = owner?.id === job.id ? owner.images : null;
        const liveMap = new Map();
        if (Array.isArray(liveItems)) {
            for (const item of liveItems) {
                if (item && item.pageIndex != null) {
                    liveMap.set(item.pageIndex, item);
                }
            }
        }
        const results = Array.isArray(job.results) ? job.results.map(row => {
            if (row.image) return row;
            const liveImg = liveMap.get(row.pageIndex)?.image || pageMap?.get(row.pageIndex) || '';
            return liveImg ? { ...row, image: liveImg } : row;
        }) : [];
        return { ...job, results };
    }

    /**
     * 若非無痕模式且記憶體尚未載入該 job 的圖片（例如 SW 剛重啟），先從 IndexedDB 補回記憶體後再進行圖片回填。
     */
    async function ensureMemoryHydrated(job, liveItems = []) {
        if (!job) return job;
        const owner = memoryImagesByTab.get(job.resultTabId);
        if (owner?.id === job.id && (owner.idbHydrated || owner.images.size > 0)) {
            return hydrateJobImages(job, liveItems);
        }
        if (await isIncognitoTab(job.resultTabId)) {
            return hydrateJobImages(job, liveItems);
        }
        await flushIdb(job.resultTabId);
        const afterFlushOwner = memoryImagesByTab.get(job.resultTabId);
        if (afterFlushOwner?.id === job.id && (afterFlushOwner.idbHydrated || afterFlushOwner.images.size > 0)) {
            return hydrateJobImages(job, liveItems);
        }
        const idbImages = await idbStore.getJobImages(job.resultTabId, job.id);
        const currentOwner = memoryImagesByTab.get(job.resultTabId);
        if (!currentOwner || currentOwner.createdAt <= job.createdAt) {
            if (currentOwner?.id === job.id) {
                for (const [pageIndex, img] of idbImages.entries()) {
                    if (!currentOwner.images.has(pageIndex)) {
                        currentOwner.images.set(pageIndex, img);
                    }
                }
                currentOwner.idbHydrated = true;
            } else {
                memoryImagesByTab.set(job.resultTabId, {
                    id: job.id,
                    createdAt: job.createdAt,
                    sourceTabId: job.sourceTabId,
                    sourceUrl: job.sourceUrl,
                    images: new Map(idbImages),
                    idbHydrated: true
                });
            }
        }
        return hydrateJobImages(job, liveItems);
    }

    async function storeFor(tabId) {
        const tab = await chromeApi.tabs.get(tabId);
        return tab.incognito || chromeApi.extension?.inIncognitoContext ? privateStore : local;
    }
    async function snapshot(tabId) {
        await ready;
        const store = await storeFor(tabId);
        const rawJob = await store.get(tabId);
        if (!rawJob) return rawJob;
        const job = await ensureMemoryHydrated(rawJob);
        if (job?.sourceTabId && job.sourceUrl && !job.isPretranslatedChapter) {
            const source = await chromeApi.tabs.get(job.sourceTabId).catch(() => null);
            if (!source || (source.pendingUrl || source.url) !== job.sourceUrl) {
                return { ...job, status: 'source-changed' };
            }
        }
        return job;
    }
    async function publish(job, liveItems = null) {
        if (!job) return;
        // Temporary image bytes are delivered only to the live page, never storage.
        const hydrated = await ensureMemoryHydrated(job, liveItems);
        const send = async () => {
            await chromeApi.tabs.sendMessage(job.resultTabId, { action: 'mangaSnapshot', job: mangaWireSnapshot(hydrated) });
            // Only changed pages are sent after a commit; reload explicitly requests all live images.
            for (const message of mangaImageMessages(hydrated, liveItems ?? hydrated.results)) {
                await chromeApi.tabs.sendMessage(job.resultTabId, message);
            }
        };
        // Keep a later snapshot from overtaking an image transfer for this reader.
        const queued = (publishQueues.get(job.resultTabId) || Promise.resolve()).then(send).catch(() => {});
        publishQueues.set(job.resultTabId, queued);
        await queued;
        if (publishQueues.get(job.resultTabId) === queued) publishQueues.delete(job.resultTabId);
    }
    async function begin(options) {
        await ready;
        const store = await storeFor(options.resultTabId);
        // 若是重試且 SW 重啟過導致記憶體為空，先從 IndexedDB 補回原任務的暫存圖片以供繼承
        if (options.isRetry && !(await isIncognitoTab(options.resultTabId))) {
            const previousOwner = memoryImagesByTab.get(options.resultTabId);
            if (!previousOwner || previousOwner.images.size === 0) {
                const previousJob = await store.get(options.resultTabId);
                if (previousJob?.id) {
                    await ensureMemoryHydrated(previousJob);
                }
            }
        }
        const source = options.sourceTabId ? await chromeApi.tabs.get(options.sourceTabId).catch(err => {
            if (!options.isPretranslatedChapter) throw err;
            return null;
        }) : null;
        const job = await store.begin({ ...options, sourceTabId: source ? options.sourceTabId : null,
            sourceUrl: options.sourceUrl || source?.pendingUrl || source?.url || '' });
        activateMemoryImages(job, options.images, options.retryPageIndices);
        await flushIdb(job.resultTabId);
        await publish(job);
        return hydrateJobImages(job);
    }
    async function commit(job, count, items, canCommit = () => true) {
        const store = await storeFor(job.resultTabId);
        const current = await snapshot(job.resultTabId);
        if (!current || current.id !== job.id || current.status === 'source-changed') return null;
        const saved = await store.commit(job.resultTabId, job.id, count, items, canCommit);
        if (saved) {
            recordMemoryImages(saved, null, items);
            await flushIdb(saved.resultTabId);
            await publish(saved, items);
        }
        return hydrateJobImages(saved, items);
    }
    async function status(job, status) {
        const store = await storeFor(job.resultTabId);
        const saved = await store.status(job.resultTabId, job.id, status);
        await publish(saved, []);
        return hydrateJobImages(saved);
    }
    async function resume(tabId, id) {
        const current = await snapshot(tabId);
        if (!current || current.status === 'source-changed') throw new Error('來源章節已變更，請從原網頁重新開始');
        const store = await storeFor(tabId);
        const resumed = await store.resume(tabId, id);
        activateMemoryImages(resumed, [], null, id);
        await flushIdb(resumed.resultTabId);
        return hydrateJobImages(resumed);
    }
    async function replaceResult(tabId, id, pageIndex, result) {
        const store = await storeFor(tabId);
        const current = await snapshot(tabId);
        if (!current || current.id !== id || current.status === 'source-changed') return null;
        let appliedResult = result;
        const update = typeof result === 'function' ? row => {
            appliedResult = result(row);
            return appliedResult;
        } : result;
        const saved = await store.replaceResult(tabId, id, pageIndex, update);
        const liveItems = typeof appliedResult?.image === 'string' && appliedResult.image
            ? [{ pageIndex, image: appliedResult.image }] : [];
        if (saved) {
            recordMemoryImages(saved, null, liveItems);
            await flushIdb(saved.resultTabId);
            await publish(saved, liveItems);
        }
        return hydrateJobImages(saved, liveItems);
    }
    async function stop() {
        await ready;
        await Promise.all([local.stopAll(), privateStore.stopAll()]);
        const tabs = await chromeApi.tabs.query({});
        await Promise.all(tabs.filter(tab => tab.url?.startsWith(readerUrl)).map(async tab => publish(await snapshot(tab.id), [])));
    }
    async function remove(tabId) {
        await ready;
        memoryImagesByTab.delete(tabId);
        await Promise.all([
            local.removeForTab(tabId),
            privateStore.removeForTab(tabId),
            isPrivateWorker ? Promise.resolve() : enqueueIdb(tabId, () => idbStore.removeForTab(tabId))
        ]);
    }
    function getMemoryImage(tabId, pageIndex, jobId = null) {
        const owner = memoryImagesByTab.get(tabId);
        if (jobId && owner?.id !== jobId) return '';
        return owner?.images.get(Number(pageIndex)) || '';
    }
    async function getStoredImage(tabId, pageIndex, jobId = null) {
        const memImg = getMemoryImage(tabId, pageIndex, jobId);
        if (memImg) return memImg;
        if (await isIncognitoTab(tabId)) return '';
        await flushIdb(tabId);
        const memAfterFlush = getMemoryImage(tabId, pageIndex, jobId);
        if (memAfterFlush) return memAfterFlush;
        let targetJobId = jobId;
        if (!targetJobId) {
            const store = await storeFor(tabId).catch(() => null);
            const job = store ? await store.get(tabId).catch(() => null) : null;
            targetJobId = job?.id || null;
        }
        if (!targetJobId) return '';
        const img = await idbStore.getImage(tabId, targetJobId, pageIndex);
        if (img) {
            const owner = memoryImagesByTab.get(tabId);
            if (owner?.id === targetJobId) {
                owner.images.set(Number(pageIndex), img);
            }
        }
        return img || '';
    }
    return { ready, snapshot, begin, commit, status, resume, stop, remove, publish, replaceResult, getMemoryImage, getStoredImage };
}
