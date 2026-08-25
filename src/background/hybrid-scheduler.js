/**
 * 2D 二維交錯輪替調度模組 (2D Alternating Round-Robin Scheduler)
 * 實現 Key1(A) → Key2(B) → Key3(A) → Key4(B) 輪替，
 * 一輪結束後由 Key1(B) → Key2(A) → Key3(B) → Key4(A) 繼續輪替。
 */

/**
 * 計算指定批次的 Key 索引與指派模型
 * @param {number} batchIdx 批次索引 (0, 1, 2...)
 * @param {number} keyCount API Key 總數 (至少 1)
 * @param {boolean} isHybrid 是否啟用 Hybrid 雙模型輪替
 * @param {string} primaryModel 主要模型 (Model A, 預設 gemini-3.1-flash-lite)
 * @param {string} secondaryModel 次要模型 (Model B, 預設 gemini-3.5-flash-lite)
 * @returns {{ keyIndex: number, roundIndex: number, modelName: string }}
 */
export function getHybridSchedule(batchIdx, keyCount, isHybrid, primaryModel, secondaryModel) {
    const totalKeys = Math.max(1, keyCount || 1);
    const keyIndex = batchIdx % totalKeys;
    const roundIndex = Math.floor(batchIdx / totalKeys);

    if (!isHybrid) {
        return { keyIndex, roundIndex, modelName: primaryModel };
    }

    // 核心二維交錯演算法：(keyIndex + roundIndex) % 2
    // Round 0: Key 0(A), Key 1(B), Key 2(A), Key 3(B)...
    // Round 1: Key 0(B), Key 1(A), Key 2(B), Key 3(A)...
    const modelParity = (keyIndex + roundIndex) % 2;
    const modelName = (modelParity === 1) ? (secondaryModel || primaryModel) : primaryModel;

    return { keyIndex, roundIndex, modelName };
}

/**
 * 取得指定批次的模型名稱
 */
export function getBatchModel(batchIdx, keyCount, isHybrid, primaryModel, secondaryModel) {
    return getHybridSchedule(batchIdx, keyCount, isHybrid, primaryModel, secondaryModel).modelName;
}

/**
 * 計算 Hybrid 模式下的有效請求延遲 (ms)
 * @param {number} baseDelay 基礎延遲 (預設 4000ms)
 * @param {boolean} isHybrid 是否啟用 Hybrid 雙模型輪替
 * @param {number} keyCount API Key 數量
 * @returns {number} 實際等待延遲
 */
export function getEffectiveDelay(baseDelay, isHybrid, keyCount = 1) {
    if (!isHybrid) {
        if (keyCount > 1) return Math.max(2000, Math.floor(baseDelay / keyCount));
        return baseDelay;
    }
    // Hybrid + 多 Key 綜效：每個 (Key, Model) 實體冷卻時間超長，延遲可極速降至 1000~1500ms
    if (keyCount >= 2) return Math.max(1000, Math.floor(baseDelay / (keyCount * 1.5)));
    return Math.max(1500, Math.floor(baseDelay / 2));
}

/**
 * 跨模型 429/503 容錯切換 (Failover)
 */
export function getFailoverModel(currentModel, primaryModel, secondaryModel) {
    return (currentModel === primaryModel) ? (secondaryModel || primaryModel) : primaryModel;
}
