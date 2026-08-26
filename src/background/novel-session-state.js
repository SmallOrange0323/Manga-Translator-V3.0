/**
 * novel-session-state.js
 * 
 * 專門負責小說 Session Identity 在 chrome.storage.session 中的持久化與 SW 重啟恢復 (Hydration)。
 * 核心原則：
 * 1. 僅保存極小的 Session Identity 白名單欄位 (tabId, sessionId, pageUrl, cancelled, updatedAt)。
 * 2. 嚴格禁止持久化小說原文、譯文、結果陣列、API Key、OAuth token、Prompt 或詞庫等任何敏感/大型資料。
 * 3. 嚴格限定使用 session storage，絕不 fallback 到持久化 local 儲存。
 * 4. 所有 read-modify-write 均透過 module-level mutation chain 序列化，防止並發覆蓋 (Lost Update)。
 * 5. 支援 SW 重啟時從 storage.session 恢復 registry，並主動清理不存在的 Ghost Tab。
 */

import { log } from '../utils/logger.js';

export const NOVEL_SESSION_STATE_KEY = 'mt_novel_session_state_v1';

/**
 * 模組層級的 Mutation Promise Chain，保證同一 SW 實例內所有 Session State 讀改寫序列化
 */
let sessionStateMutationChain = Promise.resolve();

export function enqueueSessionStateMutation(operation) {
    const run = sessionStateMutationChain.then(operation, operation);
    sessionStateMutationChain = run.catch(() => {});
    return run;
}

/**
 * 嚴格白名單淨化單一 Session State 記錄
 * @param {object} raw 
 * @returns {object|null}
 */
export function sanitizeNovelSessionState(raw) {
    if (!raw || typeof raw !== 'object') return null;

    const tabId = Number(raw.tabId);
    if (!Number.isInteger(tabId) || tabId <= 0) return null;

    const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId.trim() : '';
    if (!sessionId) return null;

    const pageUrl = typeof raw.pageUrl === 'string' ? raw.pageUrl : '';
    const cancelled = Boolean(raw.cancelled);
    const updatedAt = typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) 
        ? raw.updatedAt 
        : Date.now();

    return {
        tabId,
        sessionId,
        pageUrl,
        cancelled,
        updatedAt
    };
}

/**
 * 安全存取 storage.session (嚴格限定 session storage)
 */
export function getStorageSession() {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.session) {
        return chrome.storage.session;
    }
    return null;
}

/**
 * 讀取所有持久化的 Novel Session States (純讀取，不加鎖)
 * @returns {Promise<Object.<number, object>>}
 */
export async function getNovelSessionStates() {
    const res = await readNovelSessionStatesStrict();
    return res.ok ? res.data : {};
}

/**
 * 嚴格讀取所有持久化的 Novel Session States (區分 storage 失敗與真正 empty)
 * @returns {Promise<{ok: boolean, data?: Object.<number, object>, error?: string}>}
 */
export async function readNovelSessionStatesStrict() {
    const storage = getStorageSession();
    if (!storage) {
        return { ok: false, error: 'storage.session unavailable' };
    }

    try {
        const result = await new Promise((resolve, reject) => {
            storage.get(NOVEL_SESSION_STATE_KEY, (res) => {
                if (chrome.runtime?.lastError) {
                    reject(new Error(chrome.runtime.lastError.message || 'storage.get runtime.lastError'));
                } else {
                    resolve(res || {});
                }
            });
        });

        const rawMap = result[NOVEL_SESSION_STATE_KEY];
        if (!rawMap || typeof rawMap !== 'object') {
            return { ok: true, data: {} };
        }

        const cleanMap = {};
        for (const [key, value] of Object.entries(rawMap)) {
            const clean = sanitizeNovelSessionState(value);
            if (clean) {
                cleanMap[clean.tabId] = clean;
            }
        }
        return { ok: true, data: cleanMap };
    } catch (e) {
        log.warn('NovelSessionState', '嚴格讀取 session states 失敗:', e);
        return { ok: false, error: e.message || 'Read exception' };
    }
}

/**
 * 保存或更新特定分頁的 Session Identity (透過 mutation queue 序列化)
 * @param {object} params 
 * @param {number|string} params.tabId
 * @param {string} params.sessionId
 * @param {string} [params.pageUrl]
 * @param {boolean} [params.cancelled]
 * @returns {Promise<boolean>}
 */
export function saveNovelSessionState({ tabId, sessionId, pageUrl = '', cancelled = false }) {
    const clean = sanitizeNovelSessionState({ tabId, sessionId, pageUrl, cancelled, updatedAt: Date.now() });
    if (!clean) return Promise.resolve(false);

    return enqueueSessionStateMutation(async () => {
        const storage = getStorageSession();
        if (!storage) return false;

        try {
            const rawMap = await new Promise((resolve) => {
                storage.get(NOVEL_SESSION_STATE_KEY, (res) => resolve(res?.[NOVEL_SESSION_STATE_KEY] || {}));
            });
            const currentMap = (rawMap && typeof rawMap === 'object') ? { ...rawMap } : {};

            currentMap[clean.tabId] = clean;
            await new Promise((resolve, reject) => {
                storage.set({ [NOVEL_SESSION_STATE_KEY]: currentMap }, () => {
                    if (chrome.runtime?.lastError) reject(chrome.runtime.lastError);
                    else resolve();
                });
            });
            return true;
        } catch (e) {
            log.error('NovelSessionState', `保存分頁 ${tabId} 的 session state 失敗:`, e);
            return false;
        }
    });
}

/**
 * 移除特定分頁的 Session Identity (透過 mutation queue 序列化)
 * @param {number|string} tabId 
 * @returns {Promise<boolean>}
 */
export function removeNovelSessionState(tabId) {
    const numericTabId = Number(tabId);
    if (!Number.isInteger(numericTabId) || numericTabId <= 0) return Promise.resolve(false);

    return enqueueSessionStateMutation(async () => {
        const storage = getStorageSession();
        if (!storage) return false;

        try {
            const rawMap = await new Promise((resolve) => {
                storage.get(NOVEL_SESSION_STATE_KEY, (res) => resolve(res?.[NOVEL_SESSION_STATE_KEY] || {}));
            });
            if (rawMap && typeof rawMap === 'object' && rawMap[numericTabId]) {
                const currentMap = { ...rawMap };
                delete currentMap[numericTabId];
                await new Promise((resolve, reject) => {
                    storage.set({ [NOVEL_SESSION_STATE_KEY]: currentMap }, () => {
                        if (chrome.runtime?.lastError) reject(chrome.runtime.lastError);
                        else resolve();
                    });
                });
            }
            return true;
        } catch (e) {
            log.warn('NovelSessionState', `移除分頁 ${tabId} 的 session state 失敗:`, e);
            return false;
        }
    });
}

/**
 * 條件式移除特定分頁的 Session Identity (只有當前 storage 中的 sessionId 相符時才刪除)
 * @param {number|string} tabId 
 * @param {string} expectedSessionId 
 * @returns {Promise<boolean>}
 */
export function removeNovelSessionStateIfMatches(tabId, expectedSessionId) {
    const numericTabId = Number(tabId);
    if (!Number.isInteger(numericTabId) || numericTabId <= 0 || !expectedSessionId) return Promise.resolve(false);

    return enqueueSessionStateMutation(async () => {
        const storage = getStorageSession();
        if (!storage) return false;

        try {
            const rawMap = await new Promise((resolve) => {
                storage.get(NOVEL_SESSION_STATE_KEY, (res) => resolve(res?.[NOVEL_SESSION_STATE_KEY] || {}));
            });
            if (rawMap && typeof rawMap === 'object' && rawMap[numericTabId]) {
                if (rawMap[numericTabId].sessionId === expectedSessionId) {
                    const currentMap = { ...rawMap };
                    delete currentMap[numericTabId];
                    await new Promise((resolve, reject) => {
                        storage.set({ [NOVEL_SESSION_STATE_KEY]: currentMap }, () => {
                            if (chrome.runtime?.lastError) reject(chrome.runtime.lastError);
                            else resolve();
                        });
                    });
                    return true;
                } else {
                    // sessionId 不匹配，表示已被更新的 Session 覆寫，無操作
                    return false;
                }
            }
            return true;
        } catch (e) {
            log.warn('NovelSessionState', `條件式移除分頁 ${tabId} (session: ${expectedSessionId}) 失敗:`, e);
            return false;
        }
    });
}

/**
 * SW 重啟時從 storedStates 恢復 registry，並剔除不存在的 Ghost Tab
 * @param {object} registry 
 * @param {Object.<number, object>} storedStates 
 * @param {Set<number>|null} [activeTabIdSet=null] 當前活躍的 Tab ID 集合，若提供則自動清除不在其中的 ghost tabs
 * @returns {Promise<number>} 成功恢復的 session 數量
 */
export async function restoreNovelSessionRegistry(registry, storedStates, activeTabIdSet = null) {
    if (!registry || !storedStates || typeof storedStates !== 'object') return 0;

    let restoredCount = 0;
    const ghostTabIds = [];

    for (const [tabKey, stateObj] of Object.entries(storedStates)) {
        const clean = sanitizeNovelSessionState(stateObj);
        if (!clean) continue;

        const tabId = clean.tabId;

        // 若有提供 activeTabIdSet 且此 tabId 不在其中，標記為 ghost tab
        if (activeTabIdSet && !activeTabIdSet.has(tabId)) {
            ghostTabIds.push(tabId);
            continue;
        }

        // Hydrate registry
        registry.begin(tabId, clean.sessionId);
        if (clean.cancelled) {
            registry.cancel(tabId);
        }
        restoredCount++;
    }

    // 清理 ghost tabs 的持久化記錄
    if (ghostTabIds.length > 0) {
        for (const ghostId of ghostTabIds) {
            await removeNovelSessionState(ghostId);
        }
        log.info('NovelSessionState', `清理了 ${ghostTabIds.length} 個不存在分頁的 Ghost Session Identity`);
    }

    return restoredCount;
}
