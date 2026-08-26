/**
 * novel-cancellation.js
 * 
 * 專門負責小說模式的分頁級中斷生命週期管理 (Per-Tab Novel Cancellation Registry)。
 * 核心原則：
 * 1. 每個分頁的小說翻譯 Session 擁有獨立的中斷狀態，分頁 A 中斷絕不影響分頁 B。
 * 2. 收到中斷請求時，精確修剪 novelQueue 中屬於該分頁的所有未執行任務。
 * 3. 只有全新的整篇翻譯 Session (batchIndex === 0 且非重試) 才能安全解除該分頁的中斷狀態。
 * 4. Stale batch 或重試 batch 絕不能解除中斷狀態。
 * 5. 小說模式完全獨立於漫畫模式的全域 isStopping 狀態，彼此互不干擾。
 */

export function createNovelCancellationRegistry() {
    const cancelledTabs = new Set();

    return {
        /**
         * 標記特定分頁為中斷狀態
         * @param {number|string} tabId 
         */
        cancel(tabId) {
            if (tabId !== undefined && tabId !== null) {
                cancelledTabs.add(Number(tabId));
            }
        },

        /**
         * 開始新的小說翻譯 Session，清除該分頁的中斷標記
         * @param {number|string} tabId 
         */
        begin(tabId) {
            if (tabId !== undefined && tabId !== null) {
                cancelledTabs.delete(Number(tabId));
            }
        },

        /**
         * 檢查特定分頁是否已被中斷
         * @param {number|string} tabId 
         * @returns {boolean}
         */
        isCancelled(tabId) {
            if (tabId === undefined || tabId === null) return false;
            return cancelledTabs.has(Number(tabId));
        },

        /**
         * 清空所有分頁的中斷標記 (測試或重置用)
         */
        clearAll() {
            cancelledTabs.clear();
        },

        /**
         * 取得當前被中斷的分頁數量
         */
        size() {
            return cancelledTabs.size;
        }
    };
}

/**
 * 判斷傳入的小說批次訊息是否為全新的完整小說翻譯 Session
 * 只有新 session 的首批 (batchIndex === 0 且無 retryIndices) 才能解除中斷狀態
 * @param {object} message 
 * @returns {boolean}
 */
export function isNewFullSession(message) {
    if (!message || typeof message !== 'object') return false;
    const isFirstBatch = message.batchIndex === 0;
    const hasRetry = Array.isArray(message.retryIndices) && message.retryIndices.length > 0;
    return isFirstBatch && !hasRetry;
}

/**
 * 從佇列陣列中過濾掉特定分頁的所有任務
 * @param {Array} queue 
 * @param {number|string} tabId 
 * @returns {Array} 修剪後的佇列
 */
export function pruneQueueForTab(queue, tabId) {
    if (!Array.isArray(queue) || tabId === undefined || tabId === null) {
        return Array.isArray(queue) ? queue : [];
    }
    const targetId = Number(tabId);
    return queue.filter(task => Number(task?.tabId) !== targetId);
}

/**
 * 判定特定小說任務是否應當繼續執行
 * 完全僅依賴 registry 中的 per-tab 中斷狀態，絕不依賴全域 isStopping
 * @param {object} task 
 * @param {object} registry 
 * @returns {boolean}
 */
export function shouldProcessNovelTask(task, registry) {
    if (!task || typeof task !== 'object') return false;
    const tabId = task.tabId;
    if (tabId === undefined || tabId === null) return false;
    if (!registry || typeof registry.isCancelled !== 'function') return true;
    return !registry.isCancelled(tabId);
}

/**
 * 全域單例
 */
export const novelCancellationRegistry = createNovelCancellationRegistry();
