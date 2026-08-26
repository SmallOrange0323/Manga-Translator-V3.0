/**
 * novel-session-state.js
 * 
 * 專門負責小說 Session Identity 在 chrome.storage.session 中的持久化與 SW 重啟恢復 (Hydration)。
 * 核心原則：
 * 1. 僅保存極小的 Session Identity 白名單欄位 (tabId, sessionId, pageUrl, cancelled, updatedAt)。
 * 2. 嚴格禁止持久化小說原文、譯文、結果陣列、API Key、OAuth token、Prompt 或詞庫等任何敏感/大型資料。
 * 3. 支援 SW 重啟時從 storage.session 恢復 registry，並主動清理不存在的 Ghost Tab。
 */

import { log } from '../utils/logger.js';

export const NOVEL_SESSION_STATE_KEY = 'mt_novel_session_state_v1';

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
 * 安全存取 storage.session
 */
function getStorageSession() {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.session) {
        return chrome.storage.session;
    }
    // Fallback 到 local 若環境不支援 session storage
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        return chrome.storage.local;
    }
    return null;
}

/**
 * 讀取所有持久化的 Novel Session States
 * @returns {Promise<Object.<number, object>>}
 */
export async function getNovelSessionStates() {
    const storage = getStorageSession();
    if (!storage) return {};

    try {
        const result = await new Promise((resolve) => {
            storage.get(NOVEL_SESSION_STATE_KEY, (res) => resolve(res || {}));
        });
        const rawMap = result[NOVEL_SESSION_STATE_KEY];
        if (!rawMap || typeof rawMap !== 'object') return {};

        const cleanMap = {};
        for (const [key, value] of Object.entries(rawMap)) {
            const clean = sanitizeNovelSessionState(value);
            if (clean) {
                cleanMap[clean.tabId] = clean;
            }
        }
        return cleanMap;
    } catch (e) {
        log.warn('NovelSessionState', '讀取 session states 失敗:', e);
        return {};
    }
}

/**
 * 保存或更新特定分頁的 Session Identity
 * @param {object} params 
 * @param {number|string} params.tabId
 * @param {string} params.sessionId
 * @param {string} [params.pageUrl]
 * @param {boolean} [params.cancelled]
 * @returns {Promise<boolean>}
 */
export async function saveNovelSessionState({ tabId, sessionId, pageUrl = '', cancelled = false }) {
    const clean = sanitizeNovelSessionState({ tabId, sessionId, pageUrl, cancelled, updatedAt: Date.now() });
    if (!clean) return false;

    const storage = getStorageSession();
    if (!storage) return false;

    try {
        const currentMap = await getNovelSessionStates();
        currentMap[clean.tabId] = clean;
        await new Promise((resolve, reject) => {
            storage.set({ [NOVEL_SESSION_STATE_KEY]: currentMap }, () => {
                if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
                else resolve();
            });
        });
        return true;
    } catch (e) {
        log.error('NovelSessionState', `保存分頁 ${tabId} 的 session state 失敗:`, e);
        return false;
    }
}

/**
 * 移除特定分頁的 Session Identity
 * @param {number|string} tabId 
 * @returns {Promise<boolean>}
 */
export async function removeNovelSessionState(tabId) {
    const numericTabId = Number(tabId);
    if (!Number.isInteger(numericTabId) || numericTabId <= 0) return false;

    const storage = getStorageSession();
    if (!storage) return false;

    try {
        const currentMap = await getNovelSessionStates();
        if (currentMap[numericTabId]) {
            delete currentMap[numericTabId];
            await new Promise((resolve, reject) => {
                storage.set({ [NOVEL_SESSION_STATE_KEY]: currentMap }, () => {
                    if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
                    else resolve();
                });
            });
        }
        return true;
    } catch (e) {
        log.warn('NovelSessionState', `移除分頁 ${tabId} 的 session state 失敗:`, e);
        return false;
    }
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
