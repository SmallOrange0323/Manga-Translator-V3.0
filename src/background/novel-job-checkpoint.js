/**
 * novel-job-checkpoint.js
 * 
 * 專門負責 Novel Durable Job Checkpoint 在 chrome.storage.session 中的持久化、更新與 SW 重啟恢復。
 * 核心原則：
 * 1. 僅允許使用 chrome.storage.session，嚴禁 fallback 到 chrome.storage.local。
 * 2. 所有 whole-map 寫入均透過 module-level Promise mutation chain 序列化。
 * 3. 嚴格白名單過濾，絕不保存 API Key、OAuth token、Prompt、Glossary 或原始請求體。
 * 4. 嚴格驗證 version (=== 1)、kind ('full' | 'retry')、batch key (0..totalBatches-1) 與 translations 長度/型別。
 * 5. 提供 submitNovelJobCheckpointAtomic 實現同 Session 并發檢查與原子化提交。
 * 6. 提供 normalizeRestoredNovelJob 實現崩潰恢復後的狀態自修復。
 */

import { log } from '../utils/logger.js';

export const NOVEL_JOBS_KEY = 'mt_novel_jobs_v1';

/**
 * 模組層級的 Mutation Promise Chain，保證同一 SW 實例內所有 Job Checkpoint 讀改寫序列化
 */
let jobMutationChain = Promise.resolve();

export function enqueueJobMutation(operation) {
    const run = jobMutationChain.then(operation, operation);
    jobMutationChain = run.catch(() => {});
    return run;
}

/**
 * 安全存取 storage.session (嚴禁 fallback 到 storage.local)
 */
export function getStorageSession() {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.session) {
        return chrome.storage.session;
    }
    return null;
}

/**
 * 嚴格白名單淨化單一 Durable Job Checkpoint
 * @param {object} raw 
 * @returns {object|null}
 */
export function sanitizeNovelJobCheckpoint(raw) {
    if (!raw || typeof raw !== 'object') return null;

    // 嚴格限定 version 為 1
    if (raw.version !== 1) return null;
    const version = 1;

    const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId.trim() : '';
    if (!sessionId) return null;

    const tabId = Number(raw.tabId);
    if (!Number.isInteger(tabId) || tabId <= 0) return null;

    const pageUrl = typeof raw.pageUrl === 'string' ? raw.pageUrl : '';
    
    // 嚴格限定 kind 為 'full' 或 'retry'
    if (raw.kind !== 'full' && raw.kind !== 'retry') return null;
    const kind = raw.kind;
    
    const batchSize = Number(raw.batchSize);
    if (!Number.isInteger(batchSize) || batchSize <= 0) return null;

    if (!Array.isArray(raw.items) || raw.items.length === 0) return null;

    // 驗證 items 陣列與 idx 唯一性
    const cleanItems = [];
    const seenIndices = new Set();

    for (let i = 0; i < raw.items.length; i++) {
        const it = raw.items[i];
        if (!it || typeof it !== 'object') return null;

        const idx = Number(it.idx);
        if (!Number.isInteger(idx) || idx < 0) return null;

        if (typeof it.text !== 'string') return null;

        if (seenIndices.has(idx)) return null; // 禁止重複 idx
        seenIndices.add(idx);

        if (kind === 'full' && idx !== i) {
            return null; // Full Job idx 必須嚴格連續 0..N-1
        }

        cleanItems.push({
            idx,
            text: it.text // 不 trim，保持原文完整
        });
    }

    const totalBatches = Math.ceil(cleanItems.length / batchSize);

    const nextBatchIndex = Number.isInteger(raw.nextBatchIndex) && raw.nextBatchIndex >= 0 ? raw.nextBatchIndex : 0;
    const inFlightBatchIndex = (Number.isInteger(raw.inFlightBatchIndex) && raw.inFlightBatchIndex >= 0) 
        ? raw.inFlightBatchIndex 
        : null;

    // 嚴格淨化 batches 物件
    const cleanBatches = {};
    if (raw.batches && typeof raw.batches === 'object') {
        for (const [bKey, bVal] of Object.entries(raw.batches)) {
            if (!bVal || typeof bVal !== 'object') continue;

            // 驗證 batch key 必須是合法整數且在 0..totalBatches-1 範圍內
            const bIndex = Number(bKey);
            if (!Number.isInteger(bIndex) || bIndex < 0 || bIndex >= totalBatches || String(bIndex) !== bKey) {
                continue; // 丟棄非法 key
            }

            // 計算該批次預期的項目數量
            const start = bIndex * batchSize;
            const end = Math.min(start + batchSize, cleanItems.length);
            const expectedCount = end - start;

            // 驗證 translations 陣列長度與內部元素皆為 string
            if (!Array.isArray(bVal.translations) || bVal.translations.length !== expectedCount) {
                continue; // 長度不符，視為 malformed 丟棄
            }

            let allStrings = true;
            for (let tIdx = 0; tIdx < bVal.translations.length; tIdx++) {
                if (typeof bVal.translations[tIdx] !== 'string') {
                    allStrings = false;
                    break;
                }
            }

            if (!allStrings) {
                continue; // 包含非字串，丟棄
            }

            cleanBatches[bKey] = {
                translations: [...bVal.translations],
                isFailed: Boolean(bVal.isFailed),
                committed: Boolean(bVal.committed),
                injected: Boolean(bVal.injected),
                createdAt: typeof bVal.createdAt === 'number' ? bVal.createdAt : Date.now()
            };
        }
    }

    let status = 'pending';
    if (raw.status === 'processing' || raw.status === 'completed') {
        status = raw.status;
    }

    const createdAt = typeof raw.createdAt === 'number' ? raw.createdAt : Date.now();
    const updatedAt = typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now();

    return {
        version,
        sessionId,
        tabId,
        pageUrl,
        kind,
        batchSize,
        items: cleanItems,
        nextBatchIndex,
        inFlightBatchIndex,
        batches: cleanBatches,
        status,
        createdAt,
        updatedAt
    };
}

/**
 * 建立新的 Job Checkpoint 實體
 */
export function createNovelJobCheckpoint({ sessionId, tabId, pageUrl = '', kind = 'full', batchSize = 50, items = [] }) {
    const raw = {
        version: 1,
        sessionId,
        tabId,
        pageUrl,
        kind,
        batchSize,
        items,
        nextBatchIndex: 0,
        inFlightBatchIndex: null,
        batches: {},
        status: 'pending',
        createdAt: Date.now(),
        updatedAt: Date.now()
    };
    return sanitizeNovelJobCheckpoint(raw);
}

/**
 * 讀取所有持久化的 Novel Jobs Checkpoints (純讀取，不加鎖)
 * @returns {Promise<Object.<string, object>>}
 */
export async function getNovelJobCheckpoints() {
    const res = await readNovelJobCheckpointsStrict();
    return res.ok ? res.data : {};
}

/**
 * 嚴格讀取所有持久化的 Novel Jobs Checkpoints (區分 storage 失敗與真正 empty)
 * @returns {Promise<{ok: boolean, data?: Object.<string, object>, error?: string}>}
 */
export async function readNovelJobCheckpointsStrict() {
    const storage = getStorageSession();
    if (!storage) {
        return { ok: false, error: 'storage.session unavailable' };
    }

    try {
        const result = await new Promise((resolve, reject) => {
            storage.get(NOVEL_JOBS_KEY, (res) => {
                if (chrome.runtime?.lastError) {
                    reject(new Error(chrome.runtime.lastError.message || 'storage.get runtime.lastError'));
                } else {
                    resolve(res || {});
                }
            });
        });

        const rawMap = result[NOVEL_JOBS_KEY];
        if (!rawMap || typeof rawMap !== 'object') {
            return { ok: true, data: {} };
        }

        const cleanMap = {};
        for (const [key, value] of Object.entries(rawMap)) {
            const clean = sanitizeNovelJobCheckpoint(value);
            if (clean) {
                cleanMap[clean.sessionId] = clean;
            }
        }
        return { ok: true, data: cleanMap };
    } catch (e) {
        log.warn('NovelJobCheckpoint', '嚴格讀取 job checkpoints 失敗:', e);
        return { ok: false, error: e.message || 'Read exception' };
    }
}

/**
 * 保存或更新單一 Job Checkpoint (序列化寫入)
 * @param {object} job 
 * @returns {Promise<boolean>}
 */
export function saveNovelJobCheckpoint(job) {
    const clean = sanitizeNovelJobCheckpoint({ ...job, updatedAt: Date.now() });
    if (!clean) return Promise.resolve(false);

    return enqueueJobMutation(async () => {
        const storage = getStorageSession();
        if (!storage) return false;

        try {
            const rawMap = await new Promise((resolve) => {
                storage.get(NOVEL_JOBS_KEY, (res) => resolve(res?.[NOVEL_JOBS_KEY] || {}));
            });
            const currentMap = (rawMap && typeof rawMap === 'object') ? { ...rawMap } : {};
            currentMap[clean.sessionId] = clean;

            await new Promise((resolve, reject) => {
                storage.set({ [NOVEL_JOBS_KEY]: currentMap }, () => {
                    if (chrome.runtime?.lastError) reject(chrome.runtime.lastError);
                    else resolve();
                });
            });
            return true;
        } catch (e) {
            log.error('NovelJobCheckpoint', `保存 Job ${clean.sessionId} 失敗:`, e);
            return false;
        }
    });
}

/**
 * 原子化提交新的 Job Checkpoint (檢查同 Session active/completed 狀態並決定接受/拒絕/取代)
 * @param {object} newJob 
 * @returns {Promise<{ok: boolean, job?: object, status?: string, error?: string}>}
 */
export function submitNovelJobCheckpointAtomic(newJob) {
    const clean = sanitizeNovelJobCheckpoint({ ...newJob, updatedAt: Date.now() });
    if (!clean) return Promise.resolve({ ok: false, error: 'Failed to sanitize job items or parameters' });

    return enqueueJobMutation(async () => {
        const storage = getStorageSession();
        if (!storage) return { ok: false, error: 'storage.session unavailable' };

        try {
            const rawMap = await new Promise((resolve) => {
                storage.get(NOVEL_JOBS_KEY, (res) => resolve(res?.[NOVEL_JOBS_KEY] || {}));
            });
            const currentMap = (rawMap && typeof rawMap === 'object') ? { ...rawMap } : {};
            const existing = currentMap[clean.sessionId];

            if (existing) {
                // 若既有 Job 仍在執行中 (pending / processing)，拒絕任何新提交 (full 或 retry)
                if (existing.status !== 'completed') {
                    return { ok: false, status: 'job-in-progress', error: 'Previous job is still in progress' };
                }
                // 若既有 Job 已 completed，且新 Job 是 full ➔ 拒絕 (新完整翻譯應開啟新 Session)
                if (clean.kind === 'full') {
                    return { ok: false, status: 'job-already-completed', error: 'Full job already completed for this session' };
                }
                // 若既有 Job 已 completed，且新 Job 是 retry ➔ 允許取代舊的 completed checkpoint
            }

            currentMap[clean.sessionId] = clean;

            await new Promise((resolve, reject) => {
                storage.set({ [NOVEL_JOBS_KEY]: currentMap }, () => {
                    if (chrome.runtime?.lastError) reject(chrome.runtime.lastError);
                    else resolve();
                });
            });

            return { ok: true, job: clean };
        } catch (e) {
            log.error('NovelJobCheckpoint', `原子化提交 Job ${clean.sessionId} 失敗:`, e);
            return { ok: false, error: e.message };
        }
    });
}

/**
 * 原子化更新單一 Job Checkpoint (序列化 RMW)
 * @param {string} sessionId 
 * @param {function(object): object} updater 
 * @returns {Promise<object|null>} 更新後的 clean job 或 null
 */
export function updateNovelJobCheckpoint(sessionId, updater) {
    if (!sessionId || typeof updater !== 'function') return Promise.resolve(null);

    return enqueueJobMutation(async () => {
        const storage = getStorageSession();
        if (!storage) return null;

        try {
            const rawMap = await new Promise((resolve) => {
                storage.get(NOVEL_JOBS_KEY, (res) => resolve(res?.[NOVEL_JOBS_KEY] || {}));
            });
            const currentMap = (rawMap && typeof rawMap === 'object') ? { ...rawMap } : {};
            const existing = currentMap[sessionId];
            if (!existing) return null;

            const updatedRaw = updater(existing);
            if (!updatedRaw) return null;

            const clean = sanitizeNovelJobCheckpoint({ ...updatedRaw, updatedAt: Date.now() });
            if (!clean) return null;

            currentMap[sessionId] = clean;

            await new Promise((resolve, reject) => {
                storage.set({ [NOVEL_JOBS_KEY]: currentMap }, () => {
                    if (chrome.runtime?.lastError) reject(chrome.runtime.lastError);
                    else resolve();
                });
            });
            return clean;
        } catch (e) {
            log.error('NovelJobCheckpoint', `更新 Job ${sessionId} 失敗:`, e);
            return null;
        }
    });
}

/**
 * 移除單一 Job Checkpoint
 * @param {string} sessionId 
 * @returns {Promise<boolean>}
 */
export function removeNovelJobCheckpoint(sessionId) {
    if (!sessionId) return Promise.resolve(false);

    return enqueueJobMutation(async () => {
        const storage = getStorageSession();
        if (!storage) return false;

        try {
            const rawMap = await new Promise((resolve) => {
                storage.get(NOVEL_JOBS_KEY, (res) => resolve(res?.[NOVEL_JOBS_KEY] || {}));
            });
            if (rawMap && typeof rawMap === 'object' && rawMap[sessionId]) {
                const currentMap = { ...rawMap };
                delete currentMap[sessionId];
                await new Promise((resolve, reject) => {
                    storage.set({ [NOVEL_JOBS_KEY]: currentMap }, () => {
                        if (chrome.runtime?.lastError) reject(chrome.runtime.lastError);
                        else resolve();
                    });
                });
            }
            return true;
        } catch (e) {
            log.warn('NovelJobCheckpoint', `移除 Job ${sessionId} 失敗:`, e);
            return false;
        }
    });
}

/**
 * 移除特定分頁的所有 Job Checkpoints
 * @param {number|string} tabId 
 * @returns {Promise<number>} 移除的 job 數量
 */
export function removeNovelJobCheckpointsForTab(tabId) {
    const numericTabId = Number(tabId);
    if (!Number.isInteger(numericTabId) || numericTabId <= 0) return Promise.resolve(0);

    return enqueueJobMutation(async () => {
        const storage = getStorageSession();
        if (!storage) return 0;

        try {
            const rawMap = await new Promise((resolve) => {
                storage.get(NOVEL_JOBS_KEY, (res) => resolve(res?.[NOVEL_JOBS_KEY] || {}));
            });
            if (!rawMap || typeof rawMap !== 'object') return 0;

            let removedCount = 0;
            const currentMap = { ...rawMap };

            for (const [sessId, jobVal] of Object.entries(currentMap)) {
                if (jobVal && jobVal.tabId === numericTabId) {
                    delete currentMap[sessId];
                    removedCount++;
                }
            }

            if (removedCount > 0) {
                await new Promise((resolve, reject) => {
                    storage.set({ [NOVEL_JOBS_KEY]: currentMap }, () => {
                        if (chrome.runtime?.lastError) reject(chrome.runtime.lastError);
                        else resolve();
                    });
                });
            }
            return removedCount;
        } catch (e) {
            log.warn('NovelJobCheckpoint', `移除分頁 ${tabId} 的 Job Checkpoints 失敗:`, e);
            return 0;
        }
    });
}

/**
 * SW 重啟恢復時，對單一 Job Checkpoint 進行狀態正規化與修復
 * @param {object} rawJob 
 * @returns {object|null}
 */
export function normalizeRestoredNovelJob(rawJob) {
    const clean = sanitizeNovelJobCheckpoint(rawJob);
    if (!clean) return null;

    const totalBatches = Math.ceil(clean.items.length / clean.batchSize);

    // 1. SW 重啟後不再有真正 in-flight 的連線，重設為 null
    clean.inFlightBatchIndex = null;

    // 2. 根據已 committed 的批次，計算第一個未 committed 的批次索引
    let firstUncommitted = 0;
    while (firstUncommitted < totalBatches) {
        const b = clean.batches[String(firstUncommitted)];
        if (b && b.committed === true) {
            firstUncommitted++;
        } else {
            break;
        }
    }

    clean.nextBatchIndex = firstUncommitted;

    // 3. 校正 status
    if (firstUncommitted >= totalBatches) {
        clean.status = 'completed';
    } else {
        // 若有已開始但未全部完成的批次，標記為 processing，否則若從 0 開始且無 saved batches 則為 pending
        clean.status = (firstUncommitted > 0 || Object.keys(clean.batches).length > 0) ? 'processing' : 'pending';
    }

    return clean;
}

/**
 * 取得特定批次的 items 切片 (包含 global idx 與 text)
 * @param {object} job 
 * @param {number} batchIndex 
 * @returns {Array<{idx: number, text: string}>}
 */
export function getNovelJobBatchItems(job, batchIndex) {
    if (!job || !Array.isArray(job.items) || !job.batchSize) return [];
    const start = batchIndex * job.batchSize;
    if (start >= job.items.length) return [];
    const end = Math.min(start + job.batchSize, job.items.length);
    return job.items.slice(start, end);
}

/**
 * 從目前所有 Jobs 中選取下一個可運行的 Job (Multi-tab 公平調度)
 * 規則：
 * 1. status !== 'completed'
 * 2. tabId 在 activeTabIdSet 內 (若提供)
 * 3. registry.isCurrentSession(tabId, sessionId) 為 true
 * 4. 按 updatedAt 升序排序 (最久未更新的優先)
 * @param {Object.<string, object>} jobsMap 
 * @param {object} registry 
 * @param {Set<number>|null} [activeTabIdSet=null] 
 * @returns {object|null}
 */
export function selectNextRunnableNovelJob(jobsMap, registry, activeTabIdSet = null) {
    if (!jobsMap || typeof jobsMap !== 'object') return null;

    const candidates = [];

    for (const job of Object.values(jobsMap)) {
        if (!job || job.status === 'completed') continue;

        const tabId = job.tabId;
        const sessionId = job.sessionId;

        if (activeTabIdSet && !activeTabIdSet.has(tabId)) continue;
        if (registry && !registry.isCurrentSession(tabId, sessionId)) continue;

        candidates.push(job);
    }

    if (candidates.length === 0) return null;

    // 依 updatedAt 升序排序 (Fairness)
    candidates.sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));

    return candidates[0];
}
