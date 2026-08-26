/**
 * pretranslation-checkpoint.js
 * 
 * 專職負責 MV3 預翻 (Pretranslation) 進行中狀態的 checkpoint 快照建立、
 * 資料極小化過濾 (Data Minimization)、驗證、正規化、Session Storage 讀寫與 SW 重啟恢復。
 */

export const PRETRANS_SESSION_CHECKPOINT_KEY = 'mt_pretrans_session_checkpoints';

/**
 * 將圖片參照正規化為純字串 URL，嚴格剔除所有 Base64 與未知物件欄位
 * @param {string|Object} img 
 * @returns {string}
 */
export function sanitizeImageRef(img) {
    const src = typeof img === 'string'
        ? img
        : (typeof img?.src === 'string' ? img.src : '');

    if (!src) return '';
    if (src.startsWith('data:image')) return '';
    return src;
}

/**
 * 對單一翻譯結果進行嚴格白名單過濾，絕不複製未授權或敏感大型欄位
 * @param {Object} item 
 * @returns {Object}
 */
export function sanitizePretranslationResultItem(item) {
    if (!item || typeof item !== 'object') {
        return { image: '', results: [] };
    }

    const safeImage = sanitizeImageRef(item.image);
    const safeResults = Array.isArray(item.results) ? item.results.map(r => ({
        original: typeof r?.original === 'string' ? r.original : '',
        translation: typeof r?.translation === 'string' ? r.translation : ''
    })) : [];

    const sanitized = {
        image: safeImage,
        results: safeResults
    };

    if (typeof item.error === 'string' && item.error) {
        sanitized.error = item.error;
    }
    if (typeof item.usedModelName === 'string' && item.usedModelName) {
        sanitized.usedModelName = item.usedModelName;
    }

    return sanitized;
}

/**
 * 依據嚴格白名單建立預翻 Checkpoint 快照
 * 嚴禁保存 API Key、Base64 圖片、Blob、Prompt、Glossary 等敏感或大型二進位資料
 * @param {Object} jobData 
 * @returns {Object|null}
 */
export function createPretranslationSnapshot(jobData) {
    if (!jobData || typeof jobData !== 'object') return null;

    // 1. 圖片白名單：保證只存 string URL 陣列，絕無物件展開
    const safeImages = Array.isArray(jobData.images)
        ? jobData.images.map(sanitizeImageRef)
        : [];

    // 2. 結果白名單過濾
    const safeResults = Array.isArray(jobData.results)
        ? jobData.results.map(sanitizePretranslationResultItem)
        : [];

    // 3. 導航連結白名單
    let safeNavLinks = null;
    if (jobData.navLinks && typeof jobData.navLinks === 'object') {
        safeNavLinks = {
            prev: typeof jobData.navLinks.prev === 'string' ? jobData.navLinks.prev : null,
            next: typeof jobData.navLinks.next === 'string' ? jobData.navLinks.next : null
        };
    }

    const safeBatchSize = Number.isInteger(jobData.batchSize) && jobData.batchSize > 0
        ? jobData.batchSize
        : 5;

    // 計算保守一致的 processedCount (不得超過 results.length)
    const rawProcessedCount = Number.isInteger(jobData.processedCount) && jobData.processedCount >= 0
        ? jobData.processedCount
        : safeResults.length;
    const processedCount = Math.min(rawProcessedCount, safeResults.length, safeImages.length);

    return {
        version: 1,
        url: typeof jobData.url === 'string' ? jobData.url : '',
        images: safeImages,
        results: safeResults,
        navLinks: safeNavLinks,
        usedModelName: typeof jobData.usedModelName === 'string' ? jobData.usedModelName : null,
        batchSize: safeBatchSize,
        status: typeof jobData.status === 'string' ? jobData.status : (jobData.inProgress ? 'inProgress' : 'pending'),
        isDone: Boolean(jobData.isDone),
        inProgress: Boolean(jobData.inProgress),
        isCancelled: Boolean(jobData.isCancelled),
        sourceTabId: typeof jobData.sourceTabId === 'number' ? jobData.sourceTabId : null,
        associatedResultTabId: typeof jobData.associatedResultTabId === 'number' ? jobData.associatedResultTabId : null,
        startTime: typeof jobData.startTime === 'number' ? jobData.startTime : Date.now(),
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
 * 保守原則：永遠不能讓 resumeIndex 超過實際已有的 results.length 與 images.length
 * @param {Object} snapshot 
 * @returns {number}
 */
export function getPretranslationResumeIndex(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return 0;
    const imagesCount = Array.isArray(snapshot.images) ? snapshot.images.length : 0;
    const resultsCount = Array.isArray(snapshot.results) ? snapshot.results.length : 0;

    let parsedCount = snapshot.processedCount;
    // 嚴格整數校驗，防止浮點數 (如 12.5) 或非數字導致異常
    if (!Number.isInteger(parsedCount) || parsedCount < 0) {
        parsedCount = resultsCount;
    }

    // 保守約束：取 processedCount, results.length, images.length 三者之最小值
    return Math.min(parsedCount, resultsCount, imagesCount);
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
 * 從多個 Session Checkpoint 中篩選出最新 (updatedAt 最大) 的單一 interrupted snapshot，並識別過期需清理的清單
 * @param {Object} checkpointsMap 
 * @returns {{ latestInterrupted: Object|null, staleUrls: string[] }}
 */
export function selectLatestInterruptedCheckpoint(checkpointsMap) {
    const entries = Object.values(checkpointsMap || {});
    let latestInterrupted = null;
    const staleUrls = [];

    for (const rawSnapshot of entries) {
        const normalized = normalizeRestoredPretranslation(rawSnapshot);
        if (!normalized || normalized.isCancelled || normalized.isDone) {
            if (rawSnapshot?.url) staleUrls.push(rawSnapshot.url);
            continue;
        }

        if (normalized.status === 'interrupted') {
            if (!latestInterrupted || normalized.updatedAt > latestInterrupted.updatedAt) {
                if (latestInterrupted) {
                    staleUrls.push(latestInterrupted.url);
                }
                latestInterrupted = normalized;
            } else {
                staleUrls.push(normalized.url);
            }
        }
    }

    return { latestInterrupted, staleUrls };
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
