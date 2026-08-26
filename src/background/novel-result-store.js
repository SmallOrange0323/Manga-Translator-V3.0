/**
 * novel-result-store.js
 * 
 * 專門負責 novelResults 的等冪寫入 (Idempotent Upsert)。
 * 核心原則：
 * 1. 唯一識別 key 為 `sessionId` + `idx`。
 * 2. 同一 Session 同一 index 的新譯文 (包含重試成果) 替換舊項目，絕不產生重複資料。
 * 3. 其他分頁或其他 Session 的結果完整保留。
 */

/**
 * 等冪更新小說翻譯結果陣列
 * @param {Array<object>} currentResults 既有結果陣列
 * @param {Array<object>} incomingResults 欲寫入/更新的批次結果陣列
 * @returns {Array<object>} 更新後的完整結果陣列
 */
export function upsertNovelResultItems(currentResults = [], incomingResults = []) {
    const safeCurrent = Array.isArray(currentResults) ? currentResults : [];
    const safeIncoming = Array.isArray(incomingResults) ? incomingResults : [];

    if (safeIncoming.length === 0) return [...safeCurrent];

    // 建立 key 到 index 的映射
    const itemMap = new Map();

    for (const item of safeCurrent) {
        if (!item || typeof item !== 'object') continue;
        const key = `${item.sessionId || ''}_${item.idx}`;
        itemMap.set(key, item);
    }

    for (const item of safeIncoming) {
        if (!item || typeof item !== 'object') continue;
        const key = `${item.sessionId || ''}_${item.idx}`;
        itemMap.set(key, item);
    }

    return Array.from(itemMap.values());
}

/**
 * 具備 Ownership/Session 驗證的 novelResults updater 輔助函式 (Pure Helper)
 * @param {Array<object>} currentResults 既有結果陣列
 * @param {Array<object>} incomingResults 欲寫入/更新的批次結果陣列
 * @param {object} options
 * @param {number} options.tabId
 * @param {string} options.sessionId
 * @param {object} [options.registry] 可選的 Session Registry
 * @returns {{ applied: boolean, nextResults: Array<object> }}
 */
export function applyNovelResultUpsertIfCurrent(currentResults, incomingResults, { tabId, sessionId, registry }) {
    const isCurrent = registry ? registry.isCurrentSession(tabId, sessionId) : true;
    if (!isCurrent) {
        return {
            applied: false,
            nextResults: Array.isArray(currentResults) ? currentResults : []
        };
    }
    return {
        applied: true,
        nextResults: upsertNovelResultItems(currentResults, incomingResults)
    };
}
