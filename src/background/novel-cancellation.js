/**
 * novel-cancellation.js
 * 
 * 專門負責小說模式的分頁級 Session 與中斷生命週期管理 (Per-Tab Novel Session & Cancellation Registry)。
 * 核心原則：
 * 1. 每個分頁擁有獨立的 activeSessionId 與 cancelled 狀態，分頁 A 與 B 100% 隔離。
 * 2. 只有顯式的 BEGIN_NOVEL_SESSION 訊息才能建立/切換活躍 Session (begin(tabId, sessionId))。
 * 3. 任何普通批次訊息 (translateNovelParagraphs) 絕不可自行解除中斷或建立 Session。
 * 4. 所有批次任務與注入皆需攜帶 sessionId，並通過 isCurrentSession(tabId, sessionId) 驗證。
 * 5. Tab 關閉時執行 clear(tabId) 釋放記錄。
 * 6. 小說模式完全獨立於漫畫模式的全域 isStopping 狀態，彼此互不干擾。
 */

export function createNovelSessionRegistry() {
    const activeSessions = new Map(); // tabId -> sessionId
    const cancelledTabs = new Set();  // tabId

    return {
        /**
         * 明確開始新的小說翻譯 Session
         * @param {number|string} tabId 
         * @param {string} sessionId 
         */
        begin(tabId, sessionId) {
            if (tabId === undefined || tabId === null || !sessionId) return;
            const numericTabId = Number(tabId);
            activeSessions.set(numericTabId, String(sessionId));
            cancelledTabs.delete(numericTabId);
        },

        /**
         * 取得特定分頁當前的 active sessionId
         * @param {number|string} tabId 
         * @returns {string|null}
         */
        getActiveSessionId(tabId) {
            if (tabId === undefined || tabId === null) return null;
            return activeSessions.get(Number(tabId)) || null;
        },

        /**
         * 驗證 sessionId 是否為該分頁目前活躍且未被取消的合法 Session
         * @param {number|string} tabId 
         * @param {string} sessionId 
         * @returns {boolean}
         */
        isCurrentSession(tabId, sessionId) {
            if (tabId === undefined || tabId === null || !sessionId) return false;
            const numericTabId = Number(tabId);
            if (cancelledTabs.has(numericTabId)) return false;
            const current = activeSessions.get(numericTabId);
            return current === String(sessionId);
        },

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
         * 檢查特定分頁或 Session 是否已被中斷
         * @param {number|string} tabId 
         * @param {string} [sessionId]
         * @returns {boolean}
         */
        isCancelled(tabId, sessionId) {
            if (tabId === undefined || tabId === null) return false;
            const numericTabId = Number(tabId);
            if (cancelledTabs.has(numericTabId)) return true;
            if (sessionId) {
                const current = activeSessions.get(numericTabId);
                if (current !== String(sessionId)) return true;
            }
            return false;
        },

        /**
         * 分頁關閉時清理該分頁的所有 Session 與中斷記錄
         * @param {number|string} tabId 
         */
        clear(tabId) {
            if (tabId !== undefined && tabId !== null) {
                const numericTabId = Number(tabId);
                activeSessions.delete(numericTabId);
                cancelledTabs.delete(numericTabId);
            }
        },

        /**
         * 清空所有記錄 (測試用)
         */
        clearAll() {
            activeSessions.clear();
            cancelledTabs.clear();
        },

        /**
         * 取得目前活躍 Session 數量
         */
        size() {
            return activeSessions.size;
        }
    };
}

/**
 * 判定特定小說任務是否應當繼續執行
 * 同時驗證 Tab 中斷狀態與 Session 一致性
 * @param {object} task 
 * @param {object} registry 
 * @returns {boolean}
 */
export function shouldProcessNovelTask(task, registry) {
    if (!task || typeof task !== 'object') return false;
    const { tabId, sessionId } = task;
    if (tabId === undefined || tabId === null || !sessionId) return false;
    if (!registry || typeof registry.isCurrentSession !== 'function') return true;
    return registry.isCurrentSession(tabId, sessionId);
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
 * 保持向後相容別名與全域單例
 */
export const createNovelCancellationRegistry = createNovelSessionRegistry;
export const novelCancellationRegistry = createNovelSessionRegistry();
