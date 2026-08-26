/**
 * pretranslation-checkpoint.js
 * 
 * 專職負責 MV3 預翻 (Pretranslation) 進行中狀態的 checkpoint 快照建立、
 * 驗證、正規化、Session Storage 讀寫與 Service Worker 重啟恢復。
 */

export const PRETRANS_SESSION_CHECKPOINT_KEY = 'mt_pretrans_session_checkpoints';

/**
 * 依據嚴格白名單建立預翻 Checkpoint 快照
 * 嚴禁保存 API Key、Base64 圖片、Blob、Prompt、Glossary 等敏感或大型二進位資料
 * @param {Object} jobData 
 * @returns {Object|null}
 */
export function createPretranslationSnapshot(jobData) {
    if (!jobData || typeof jobData !== 'object') return null;
    
    // 圖片白名單清理：保證只存原始 URL / 物件，絕不保存 Base64 (data:image...)
    const safeImages = Array.isArray(jobData.images) ? jobData.images.map(img => {
        if (typeof img === 'string') {
            return img.startsWith('data:image') ? '' : img;
        }
        if (img && typeof img === 'object') {
            const src = img.src || '';
            return {
                ...img,
                src: src.startsWith('data:image') ? '' : src
            };
        }
        return img;
    }) : [];

    // 計算已處理頁數
    const processedCount = Array.isArray(jobData.results) ? jobData.results.length : 0;

    return {
        version: 1,
        url: jobData.url || '',
        images: safeImages,
        results: Array.isArray(jobData.results) ? jobData.results : [],
        navLinks: jobData.navLinks || null,
        usedModelName: jobData.usedModelName || null,
        batchSize: Number(jobData.batchSize) || 5,
        status: jobData.status || (jobData.inProgress ? 'inProgress' : 'pending'),
        isDone: Boolean(jobData.isDone),
        inProgress: Boolean(jobData.inProgress),
        isCancelled: Boolean(jobData.isCancelled),
        sourceTabId: jobData.sourceTabId ?? null,
        associatedResultTabId: jobData.associatedResultTabId ?? null,
        startTime: Number(jobData.startTime) || Date.now(),
        updatedAt: Date.now(),
        processedCount
    };
}

/**
 * 驗證快照結構完整性
 * @param {Object} snapshot 
 * @returns {boolean}
 */
export function validatePretranslationSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return false;
    if (typeof snapshot.url !== 'string' || !snapshot.url) return false;
    if (!Array.isArray(snapshot.images) || snapshot.images.length === 0) return false;
    if (!Array.isArray(snapshot.results)) return false;
    return true;
}

/**
 * 計算預翻安全恢復的起始索引 (Resume Index)
 * @param {Object} snapshot 
 * @returns {number}
 */
export function getPretranslationResumeIndex(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return 0;
    const imagesCount = Array.isArray(snapshot.images) ? snapshot.images.length : 0;
    const resultsCount = Array.isArray(snapshot.results) ? snapshot.results.length : 0;

    let resumeIndex = Number(snapshot.processedCount);
    if (isNaN(resumeIndex) || resumeIndex < 0 || resumeIndex > imagesCount) {
        resumeIndex = resultsCount;
    }
    if (resumeIndex < 0 || resumeIndex > imagesCount) {
        resumeIndex = 0;
    }
    return resumeIndex;
}

/**
 * 將從 session storage 還原的快照正規化為安全的記憶體 job 狀態
 * @param {Object} snapshot 
 * @returns {Object|null}
 */
export function normalizeRestoredPretranslation(snapshot) {
    if (!validatePretranslationSnapshot(snapshot)) return null;

    const processedCount = getPretranslationResumeIndex(snapshot);
    const isCancelled = Boolean(snapshot.isCancelled);
    const isDone = Boolean(snapshot.isDone) || snapshot.status === 'completed';

    let status = snapshot.status;
    if (isCancelled) {
        status = 'cancelled';
    } else if (isDone) {
        status = 'completed';
    } else {
        // SW 重啟時，未完成的進行中任務一律正規化為 interrupted，且 inProgress 設為 false，避免永久卡死
        status = 'interrupted';
    }

    return {
        url: snapshot.url,
        images: snapshot.images,
        results: snapshot.results,
        navLinks: snapshot.navLinks,
        usedModelName: snapshot.usedModelName,
        batchSize: snapshot.batchSize || 5,
        status,
        isDone,
        inProgress: false,
        isCancelled,
        sourceTabId: snapshot.sourceTabId,
        associatedResultTabId: snapshot.associatedResultTabId,
        startTime: snapshot.startTime,
        updatedAt: snapshot.updatedAt,
        processedCount
    };
}

/**
 * 將目前進行中的預翻進度保存至 chrome.storage.session
 * 包含 Feature Detect：若環境不支援 session storage 則優雅忽略
 * @param {Object} jobData 
 */
export async function savePretranslationCheckpoint(jobData) {
    if (typeof chrome === 'undefined' || !chrome.storage?.session) return;
    if (!jobData || !jobData.url) return;
    const snapshot = createPretranslationSnapshot(jobData);
    if (!snapshot) return;

    try {
        const stored = await chrome.storage.session.get([PRETRANS_SESSION_CHECKPOINT_KEY]);
        const map = stored?.[PRETRANS_SESSION_CHECKPOINT_KEY] || {};
        map[jobData.url] = snapshot;
        await chrome.storage.session.set({ [PRETRANS_SESSION_CHECKPOINT_KEY]: map });
    } catch (_) {}
}

/**
 * 從 chrome.storage.session 讀取所有預翻快照
 * @returns {Promise<Object>}
 */
export async function getPretranslationCheckpoints() {
    if (typeof chrome === 'undefined' || !chrome.storage?.session) return {};
    try {
        const stored = await chrome.storage.session.get([PRETRANS_SESSION_CHECKPOINT_KEY]);
        return stored?.[PRETRANS_SESSION_CHECKPOINT_KEY] || {};
    } catch (_) {
        return {};
    }
}

/**
 * 刪除指定章節 URL 的 Session Checkpoint
 * @param {string} url 
 */
export async function removePretranslationCheckpoint(url) {
    if (typeof chrome === 'undefined' || !chrome.storage?.session) return;
    if (!url) return;
    try {
        const stored = await chrome.storage.session.get([PRETRANS_SESSION_CHECKPOINT_KEY]);
        const map = stored?.[PRETRANS_SESSION_CHECKPOINT_KEY] || {};
        if (map[url]) {
            delete map[url];
            await chrome.storage.session.set({ [PRETRANS_SESSION_CHECKPOINT_KEY]: map });
        }
    } catch (_) {}
}

/**
 * 當分頁關閉時，清除與指定 tabId 關聯的 Session Checkpoints
 * @param {number} tabId 
 */
export async function clearPretranslationCheckpointsForTabs(tabId) {
    if (typeof chrome === 'undefined' || !chrome.storage?.session) return;
    if (!tabId) return;
    try {
        const stored = await chrome.storage.session.get([PRETRANS_SESSION_CHECKPOINT_KEY]);
        const map = stored?.[PRETRANS_SESSION_CHECKPOINT_KEY] || {};
        let modified = false;
        for (const [url, snapshot] of Object.entries(map)) {
            if (snapshot.sourceTabId === tabId || snapshot.associatedResultTabId === tabId) {
                delete map[url];
                modified = true;
            }
        }
        if (modified) {
            await chrome.storage.session.set({ [PRETRANS_SESSION_CHECKPOINT_KEY]: map });
        }
    } catch (_) {}
}
