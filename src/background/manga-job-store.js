// A single background writer owns durable reader results and the current run cursor.
// Never persist image bytes, API keys, or prompts in these checkpoints.
export const MANGA_JOBS_KEY = 'mt_manga_jobs_v1';

function imageRef(value) {
    const src = typeof value === 'string' ? value : value?.src;
    return typeof src === 'string' && /^https?:\/\//i.test(src) ? src : '';
}

function resultItem(item) {
    return {
        image: imageRef(item.image),
        results: (Array.isArray(item.results) ? item.results : []).map(row => ({
            original: String(row?.original || ''), translation: String(row?.translation || '')
        })),
        ...(item.error ? { error: String(item.error) } : {}),
        usedModelName: String(item.usedModelName || ''),
        isProhibited: Boolean(item.isProhibited),
        isBatchFirstProhibited: Boolean(item.isBatchFirstProhibited),
        batchIndex: Number.isInteger(item.batchIndex) ? item.batchIndex : 0,
        pageIndex: Number.isInteger(item.pageIndex) ? item.pageIndex : 0
    };
}

export function createMangaJobStore(storage, key = MANGA_JOBS_KEY) {
    let queue = Promise.resolve();
    const readAll = async () => (await storage.get(key))[key] || {};
    function mutate(update) {
        const operation = queue.then(async () => {
            const jobs = await readAll();
            const result = update(jobs);
            if (new TextEncoder().encode(JSON.stringify(jobs)).length > 4_000_000) throw new Error('漫畫暫存已達容量上限，請關閉不再使用的結果頁');
            await storage.set({ [key]: jobs });
            return result;
        });
        queue = operation.catch(() => {});
        return operation;
    }
    const get = async (tabId) => { await queue; return (await readAll())[tabId] || null; };
    return {
        get,
        async begin({ sourceTabId, resultTabId, sourceUrl = '', images, navLinks, mangaKey, batchSize, isRetry = false, targetBatchIndex = null, retryPageIndices = null, isPretranslatedChapter = false }) {
            return mutate(jobs => {
                const previous = jobs[resultTabId];
                if (images.length > 800) throw new Error('每個漫畫任務最多支援 800 頁');
                if (!previous && Object.keys(jobs).length >= 8) throw new Error('最多保留 8 個漫畫結果頁，請先關閉舊結果頁');
                if (isRetry && (!previous || previous.results.length === 0)) {
                    throw new Error('找不到原章節的翻譯結果，請從原網頁重新翻譯');
                }
                if (isRetry) {
                    if (!Array.isArray(retryPageIndices) || retryPageIndices.length !== images.length ||
                        new Set(retryPageIndices).size !== retryPageIndices.length) {
                        throw new Error('重翻缺少原始頁碼，請重新載入結果頁');
                    }
                    retryPageIndices.forEach((pageIndex, index) => {
                        const original = previous.results.find(row => row.pageIndex === pageIndex);
                        const candidate = imageRef(images[index]);
                        if (!Number.isInteger(pageIndex) || pageIndex <= 0 || !original ||
                            (targetBatchIndex !== null && original.batchIndex !== targetBatchIndex) ||
                            (original.image && original.image !== candidate)) {
                            throw new Error('重翻圖片與原始頁碼不一致，請重新載入結果頁');
                        }
                    });
                }
                const job = {
                    id: crypto.randomUUID(), sourceTabId, resultTabId, sourceUrl: isRetry ? previous.sourceUrl : sourceUrl,
                    images: images.map(imageRef), navLinks: navLinks ? {
                        prev: imageRef(navLinks.prev), next: imageRef(navLinks.next), currentChapter: String(navLinks.currentChapter || ''),
                        chapterList: (Array.isArray(navLinks.chapterList) ? navLinks.chapterList : []).slice(0, 2000)
                            .map(item => ({ title: String(item?.title || ''), url: imageRef(item?.url), current: Boolean(item?.current) }))
                            .filter(item => item.url)
                    } : (isRetry ? previous.navLinks : null),
                    mangaKey: mangaKey || null, batchSize, isRetry, targetBatchIndex,
                    isPretranslatedChapter: isRetry ? Boolean(previous.isPretranslatedChapter) : Boolean(isPretranslatedChapter),
                    retryPageIndices: isRetry ? retryPageIndices : null,
                    results: isRetry ? previous?.results || [] : [],
                    processedCount: 0, status: 'running', revision: (previous?.revision || 0) + 1,
                    createdAt: Math.max(Date.now(), (previous?.createdAt || 0) + 1), updatedAt: Date.now()
                };
                jobs[resultTabId] = job;
                return job;
            });
        },
        async resume(tabId, id) {
            return mutate(jobs => {
                const job = jobs[tabId];
                if (!job || job.id !== id || !['interrupted', 'stopped'].includes(job.status)) throw new Error('任務已變更，請重新載入結果頁');
                if (job.images.slice(job.processedCount).some(src => !src)) throw new Error('此任務含暫存圖片，請從原網頁重新擷取未完成的圖片');
                job.id = crypto.randomUUID();
                job.status = 'running';
                job.revision++;
                job.updatedAt = Date.now();
                return job;
            });
        },
        async commit(tabId, id, processedCount, items, canCommit = () => true) {
            return mutate(jobs => {
                const job = jobs[tabId];
                if (!job || job.id !== id || job.status !== 'running' || !canCommit()) return null;
                for (const raw of items) {
                    const item = resultItem(raw);
                    const index = job.results.findIndex(row => row.pageIndex === item.pageIndex);
                    if (job.isRetry && (!job.retryPageIndices?.includes(item.pageIndex) || index < 0)) {
                        throw new Error('重翻結果頁碼不屬於目前任務');
                    }
                    if (index >= 0) {
                        job.results[index] = { ...item, pageIndex: job.results[index].pageIndex, batchIndex: job.results[index].batchIndex };
                    } else job.results.push(item);
                }
                job.processedCount = Math.min(job.images.length, Math.max(job.processedCount, processedCount));
                job.revision++;
                job.updatedAt = Date.now();
                return job;
            });
        },
        async replaceResult(tabId, id, pageIndex, result) {
            return mutate(jobs => {
                const job = jobs[tabId];
                if (!job || job.id !== id) return null;
                const index = job.results.findIndex(item => item.pageIndex === pageIndex);
                if (index < 0) return null;
                job.results[index] = resultItem({ ...job.results[index], ...result, error: '', isProhibited: false, isBatchFirstProhibited: false });
                job.revision++;
                return job;
            });
        },
        async status(tabId, id, status) {
            return mutate(jobs => {
                const job = jobs[tabId];
                if (!job || job.id !== id) return null;
                // An asynchronous completion must never override a persisted STOP.
                if (job.status !== 'running') return job;
                if (status === 'completed' && job.processedCount < job.images.length) throw new Error('Cannot complete a manga job before all pages are saved');
                job.status = status;
                job.revision++;
                job.updatedAt = Date.now();
                return job;
            });
        },
        async stopAll() {
            return mutate(jobs => {
                for (const job of Object.values(jobs)) {
                    if (job.status === 'running') {
                        job.status = 'stopped'; job.revision++; job.updatedAt = Date.now();
                    }
                }
            });
        },
        async removeForTab(tabId) {
            return mutate(jobs => {
                for (const [id, job] of Object.entries(jobs)) {
                    if (job.resultTabId === tabId || (job.sourceTabId === tabId && !job.isPretranslatedChapter)) delete jobs[id];
                }
            });
        },
        async recover(tabs, readerUrl) {
            return mutate(jobs => {
                const live = new Map(tabs.map(tab => [tab.id, tab]));
                for (const [id, job] of Object.entries(jobs)) {
                    const result = live.get(job.resultTabId);
                    const source = live.get(job.sourceTabId);
                    if (!result?.url?.startsWith(readerUrl) || (!job.isPretranslatedChapter && job.sourceTabId &&
                        (!source || (job.sourceUrl && (source.pendingUrl || source.url) !== job.sourceUrl)))) {
                        delete jobs[id];
                    } else if (job.status === 'running') {
                        job.status = 'interrupted'; job.revision++;
                    }
                }
            });
        }
    };
}
