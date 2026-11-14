// 漫畫結果頁暫存圖片的 IndexedDB 持久化儲存層
// 用於解決 Manifest V3 Service Worker 休眠重啟後記憶體 Map 遺失本地上傳或 Canvas 暫存圖片的問題

export const MANGA_IMAGE_DB_NAME = 'mt_manga_temp_images_v1';
export const MANGA_IMAGE_STORE_NAME = 'page_images';
const MANGA_IMAGE_DB_VERSION = 1;

/**
 * 判斷是否為需要持久化的非 HTTP(S) 暫存圖片（例如 data:image/... 或 blob:...）
 * @param {unknown} value
 * @returns {boolean}
 */
export function isTransientImageUrl(value) {
    return typeof value === 'string' && value.length > 0 && !/^https?:\/\//i.test(value);
}

function makeRecordKey(tabId, jobId, pageIndex) {
    return `${tabId}:${jobId}:${pageIndex}`;
}

function parseTabIdFromKey(key) {
    const raw = String(key ?? '');
    const sep = raw.indexOf(':');
    return sep >= 0 ? raw.slice(0, sep) : '';
}

function waitForRequest(request) {
    return new Promise((resolve, reject) => {
        if (!request) {
            resolve(undefined);
            return;
        }
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
    });
}

function waitForTransaction(tx) {
    return new Promise((resolve, reject) => {
        if (!tx) {
            resolve();
            return;
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
        tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
    });
}

function normalizePageEntries(pageEntries) {
    if (!pageEntries) return [];
    const iterable = pageEntries instanceof Map ? pageEntries.entries() : pageEntries;
    const normalized = [];
    for (const entry of iterable) {
        let pageIndex;
        let image;
        if (Array.isArray(entry)) {
            [pageIndex, image] = entry;
        } else if (entry && typeof entry === 'object') {
            pageIndex = entry.pageIndex;
            image = entry.image;
        }
        const numPage = Number(pageIndex);
        if (Number.isInteger(numPage) && numPage > 0 && isTransientImageUrl(image)) {
            normalized.push([numPage, image]);
        }
    }
    return normalized;
}

/**
 * 建立漫畫暫存圖片 IndexedDB 儲存體
 * 若環境未提供 indexedDBApi（例如預設 Node 測試環境），所有方法皆安全降級為 no-op，絕不拋錯。
 * @param {IDBFactory | null | undefined} indexedDBApi
 */
export function createMangaImageIdbStore(indexedDBApi = globalThis.indexedDB) {
    const noopStore = {
        async putImages() {},
        async getJobImages() { return new Map(); },
        async getImage() { return ''; },
        async removeForTab() {},
        async pruneTabs() {}
    };

    if (!indexedDBApi || typeof indexedDBApi.open !== 'function') {
        return noopStore;
    }

    let dbPromise = null;

    async function openDb() {
        if (!dbPromise) {
            dbPromise = new Promise((resolve, reject) => {
                let request;
                try {
                    request = indexedDBApi.open(MANGA_IMAGE_DB_NAME, MANGA_IMAGE_DB_VERSION);
                } catch (err) {
                    reject(err);
                    return;
                }
                if (!request) {
                    reject(new Error('IndexedDB open returned empty request'));
                    return;
                }
                request.onupgradeneeded = event => {
                    const db = event?.target?.result || request.result;
                    if (!db) return;
                    if (!db.objectStoreNames?.contains(MANGA_IMAGE_STORE_NAME)) {
                        const store = db.createObjectStore(MANGA_IMAGE_STORE_NAME);
                        if (typeof store?.createIndex === 'function') {
                            store.createIndex('by_tab', 'tabId', { unique: false });
                            store.createIndex('by_tab_job', ['tabId', 'jobId'], { unique: false });
                        }
                    }
                };
                request.onsuccess = event => {
                    const db = event?.target?.result || request.result;
                    if (!db) {
                        resolve(null);
                        return;
                    }
                    if ('onversionchange' in db) {
                        db.onversionchange = () => {
                            try { db.close?.(); } catch {}
                            dbPromise = null;
                        };
                    }
                    resolve(db);
                };
                request.onerror = () => reject(request.error || new Error('IndexedDB open failed'));
                request.onblocked = () => reject(new Error('IndexedDB open blocked'));
            }).catch(() => {
                dbPromise = null;
                return null;
            });
        }
        return dbPromise;
    }

    async function putImages(tabId, jobId, pageEntries) {
        if (tabId == null || !jobId) return;
        const entries = normalizePageEntries(pageEntries);
        if (entries.length === 0) return;
        try {
            const db = await openDb();
            if (!db) return;
            const tx = db.transaction(MANGA_IMAGE_STORE_NAME, 'readwrite');
            const store = tx.objectStore(MANGA_IMAGE_STORE_NAME);
            const now = Date.now();
            const txDone = waitForTransaction(tx);
            for (const [pageIndex, image] of entries) {
                store.put(
                    { tabId, jobId, pageIndex, image, updatedAt: now },
                    makeRecordKey(tabId, jobId, pageIndex)
                );
            }
            await txDone;
        } catch {
            // 寫入 IndexedDB 失敗（例如容量上限）時降級保留記憶體運作，避免中斷主流程
        }
    }

    async function getJobImages(tabId, jobId) {
        const result = new Map();
        if (tabId == null || !jobId) return result;
        try {
            const db = await openDb();
            if (!db) return result;
            const tx = db.transaction(MANGA_IMAGE_STORE_NAME, 'readonly');
            const store = tx.objectStore(MANGA_IMAGE_STORE_NAME);

            const hasCompositeIndex = typeof store.index === 'function'
                && store.indexNames?.contains?.('by_tab_job')
                && typeof globalThis.IDBKeyRange?.only === 'function';

            const cursorReq = hasCompositeIndex
                ? store.index('by_tab_job').openCursor(globalThis.IDBKeyRange.only([tabId, jobId]))
                : store.openCursor();

            await new Promise((resolve, reject) => {
                cursorReq.onsuccess = event => {
                    const cursor = event?.target?.result || cursorReq.result;
                    if (!cursor) {
                        resolve();
                        return;
                    }
                    const record = cursor.value;
                    if (record && record.tabId === tabId && record.jobId === jobId && isTransientImageUrl(record.image)) {
                        const pageIndex = Number(record.pageIndex);
                        if (Number.isInteger(pageIndex) && pageIndex > 0) {
                            result.set(pageIndex, record.image);
                        }
                    }
                    cursor.continue();
                };
                cursorReq.onerror = () => reject(cursorReq.error || new Error('IndexedDB cursor failed'));
            });
        } catch {
            return new Map();
        }
        return result;
    }

    async function getImage(tabId, jobId, pageIndex) {
        const numPage = Number(pageIndex);
        if (tabId == null || !jobId || !Number.isInteger(numPage) || numPage <= 0) return '';
        try {
            const db = await openDb();
            if (!db) return '';
            const tx = db.transaction(MANGA_IMAGE_STORE_NAME, 'readonly');
            const store = tx.objectStore(MANGA_IMAGE_STORE_NAME);
            const record = await waitForRequest(store.get(makeRecordKey(tabId, jobId, numPage)));
            return isTransientImageUrl(record?.image) ? record.image : '';
        } catch {
            return '';
        }
    }

    async function removeForTab(tabId) {
        if (tabId == null) return;
        try {
            const db = await openDb();
            if (!db) return;
            const tx = db.transaction(MANGA_IMAGE_STORE_NAME, 'readwrite');
            const store = tx.objectStore(MANGA_IMAGE_STORE_NAME);
            const txDone = waitForTransaction(tx);

            const hasTabIndex = typeof store.index === 'function'
                && store.indexNames?.contains?.('by_tab')
                && typeof globalThis.IDBKeyRange?.only === 'function';

            const useKeyCursor = hasTabIndex || typeof store.openKeyCursor === 'function';
            const cursorReq = hasTabIndex
                ? store.index('by_tab').openKeyCursor(globalThis.IDBKeyRange.only(tabId))
                : (useKeyCursor ? store.openKeyCursor() : store.openCursor());

            const targetTabStr = String(tabId);
            await new Promise((resolve, reject) => {
                cursorReq.onsuccess = event => {
                    const cursor = event?.target?.result || cursorReq.result;
                    if (!cursor) {
                        resolve();
                        return;
                    }
                    if (useKeyCursor) {
                        const primaryKey = cursor.primaryKey ?? cursor.key;
                        if (hasTabIndex || parseTabIdFromKey(primaryKey) === targetTabStr) {
                            store.delete(primaryKey);
                        }
                    } else if (cursor.value?.tabId === tabId || String(cursor.value?.tabId) === targetTabStr) {
                        if (typeof cursor.delete === 'function') {
                            cursor.delete();
                        } else {
                            store.delete(cursor.key);
                        }
                    }
                    cursor.continue();
                };
                cursorReq.onerror = () => reject(cursorReq.error || new Error('IndexedDB remove cursor failed'));
            });
            await txDone;
        } catch {
            // 清理失敗時不中斷主流程
        }
    }

    async function pruneTabs(liveTabIds) {
        const liveStrSet = new Set(Array.from(liveTabIds || [], id => String(id)));
        try {
            const db = await openDb();
            if (!db) return;
            const tx = db.transaction(MANGA_IMAGE_STORE_NAME, 'readwrite');
            const store = tx.objectStore(MANGA_IMAGE_STORE_NAME);
            const txDone = waitForTransaction(tx);

            const useKeyCursor = typeof store.openKeyCursor === 'function';
            const cursorReq = useKeyCursor ? store.openKeyCursor() : store.openCursor();

            await new Promise((resolve, reject) => {
                cursorReq.onsuccess = event => {
                    const cursor = event?.target?.result || cursorReq.result;
                    if (!cursor) {
                        resolve();
                        return;
                    }
                    if (useKeyCursor) {
                        const primaryKey = cursor.primaryKey ?? cursor.key;
                        const tabStr = parseTabIdFromKey(primaryKey);
                        if (!tabStr || !liveStrSet.has(tabStr)) {
                            store.delete(primaryKey);
                        }
                    } else {
                        const tabStr = cursor.value?.tabId != null
                            ? String(cursor.value.tabId)
                            : parseTabIdFromKey(cursor.key);
                        if (!tabStr || !liveStrSet.has(tabStr)) {
                            if (typeof cursor.delete === 'function') {
                                cursor.delete();
                            } else {
                                store.delete(cursor.key);
                            }
                        }
                    }
                    cursor.continue();
                };
                cursorReq.onerror = () => reject(cursorReq.error || new Error('IndexedDB prune cursor failed'));
            });
            await txDone;
        } catch {
            // 清理過期分頁失敗時不中斷啟動流程
        }
    }

    return { putImages, getJobImages, getImage, removeForTab, pruneTabs };
}
