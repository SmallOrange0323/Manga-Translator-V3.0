/**
 * novel-rehydrate.js
 * 
 * 專門負責小說 Page Reload Rehydrate Snapshot 的組裝與驗證 (Pure Helper)。
 * 核心原則：
 * 1. 唯讀操作，絕不修改 Session, Job, novelResults 或發起 Gemini API。
 * 2. 嚴格驗證 URL 一致性 (忽略 hash fragment)。
 * 3. 完整重建 expectedItems (Full 直接取 items，Retry 需由 retry items + novelResults 重組連續原文)。
 * 4. 合併 novelResults 與 Durable Job Checkpoints 生成最新的 renderItems。
 * 5. 白名單淨化，絕不外洩敏感資訊 (API Key, prompt, glossary 等)。
 */

import { isSameNovelPage, normalizeNovelPageUrl } from '../utils/novel-page-identity.js';
import { getNovelJobBatchItems } from './novel-job-checkpoint.js';

/**
 * 建立小說 Rehydrate Snapshot
 * @param {object} params
 * @param {object|null} params.sessionState
 * @param {object|null} params.job
 * @param {Array<object>} params.novelResults
 * @param {string} [params.currentTabUrl]
 * @returns {object}
 */
export function buildNovelRehydrateSnapshot({ sessionState, job, novelResults = [], currentTabUrl = '' }) {
    if (!sessionState || sessionState.cancelled === true || !job) {
        return { ok: false, status: 'no-session' };
    }

    const sessionId = sessionState.sessionId;
    const tabId = sessionState.tabId;

    // 1. URL 驗證
    if (currentTabUrl && !isSameNovelPage(sessionState.pageUrl, currentTabUrl)) {
        return { ok: false, status: 'url-mismatch' };
    }

    // 2. 建立與驗證 expectedItems (原始日文字串)
    let expectedItems = [];

    if (job.kind === 'full') {
        if (!Array.isArray(job.items) || job.items.length === 0) {
            return { ok: false, status: 'source-incomplete' };
        }
        for (let i = 0; i < job.items.length; i++) {
            const it = job.items[i];
            if (!it || it.idx !== i || typeof it.text !== 'string') {
                return { ok: false, status: 'source-incomplete' };
            }
            expectedItems.push({ idx: it.idx, text: it.text });
        }
    } else if (job.kind === 'retry') {
        // Retry Job: 需從 novelResults 與 job.items 合併完整的 0..N-1 段落原文
        const sourceMap = new Map();

        const safeResults = Array.isArray(novelResults) ? novelResults : [];
        for (const item of safeResults) {
            if (item && item.tabId === tabId && item.sessionId === sessionId && Number.isInteger(item.idx) && typeof item.original === 'string') {
                sourceMap.set(item.idx, item.original);
            }
        }

        if (Array.isArray(job.items)) {
            for (const it of job.items) {
                if (it && Number.isInteger(it.idx) && typeof it.text === 'string') {
                    sourceMap.set(it.idx, it.text);
                }
            }
        }

        if (sourceMap.size === 0) {
            return { ok: false, status: 'source-incomplete' };
        }

        // 驗證是否從 0 到 total-1 嚴格連續完整
        const totalItems = sourceMap.size;
        for (let i = 0; i < totalItems; i++) {
            if (!sourceMap.has(i)) {
                return { ok: false, status: 'source-incomplete' }; // 存在缺口，Fail Closed
            }
            expectedItems.push({ idx: i, text: sourceMap.get(i) });
        }
    } else {
        return { ok: false, status: 'source-incomplete' };
    }

    // 3. 建立 renderItems
    const retryIdxSet = new Set(job.kind === 'retry' && Array.isArray(job.items) ? job.items.map(it => it.idx) : []);
    const renderMap = new Map();

    for (const it of expectedItems) {
        renderMap.set(it.idx, {
            idx: it.idx,
            status: retryIdxSet.has(it.idx) ? 'retrying' : 'pending',
            translation: null
        });
    }

    // 第一層：從 novelResults 讀取已完成的段落
    const safeResults = Array.isArray(novelResults) ? novelResults : [];
    for (const item of safeResults) {
        if (!item || item.tabId !== tabId || item.sessionId !== sessionId) continue;
        if (!renderMap.has(item.idx)) continue;

        if (item.translation === '（翻譯失敗）') {
            renderMap.set(item.idx, {
                idx: item.idx,
                status: 'failed',
                translation: null
            });
        } else if (typeof item.translation === 'string') {
            renderMap.set(item.idx, {
                idx: item.idx,
                status: 'done',
                translation: item.translation
            });
        }
    }

    // 第二層：從 job.batches 讀取最新的 Durable Checkpoint 譯文 (優先覆蓋)
    if (job.batches && typeof job.batches === 'object') {
        const totalBatches = Math.ceil(job.items.length / job.batchSize);
        for (let bIdx = 0; bIdx < totalBatches; bIdx++) {
            const bVal = job.batches[String(bIdx)];
            if (!bVal || typeof bVal !== 'object') continue;

            const batchItems = getNovelJobBatchItems(job, bIdx);
            if (!Array.isArray(bVal.translations)) continue;

            if (bVal.isFailed) {
                for (let offset = 0; offset < batchItems.length; offset++) {
                    const it = batchItems[offset];
                    if (it && renderMap.has(it.idx)) {
                        renderMap.set(it.idx, {
                            idx: it.idx,
                            status: 'failed',
                            translation: null
                        });
                    }
                }
            } else {
                for (let offset = 0; offset < batchItems.length; offset++) {
                    const it = batchItems[offset];
                    const trans = bVal.translations[offset];
                    if (!it || !renderMap.has(it.idx)) continue;

                    if (trans === '（翻譯失敗）') {
                        renderMap.set(it.idx, {
                            idx: it.idx,
                            status: 'failed',
                            translation: null
                        });
                    } else if (typeof trans === 'string') {
                        renderMap.set(it.idx, {
                            idx: it.idx,
                            status: 'done',
                            translation: trans
                        });
                    }
                }
            }
        }
    }

    const renderItems = expectedItems.map(it => renderMap.get(it.idx));

    return {
        ok: true,
        status: 'rehydratable',
        sessionId,
        pageUrl: sessionState.pageUrl || '',
        jobKind: job.kind,
        jobStatus: job.status,
        batchSize: job.batchSize,
        expectedItems,
        renderItems
    };
}
