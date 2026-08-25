/**
 * Hybrid 雙模型輪替調度模組
 */

/**
 * 計算指定批次的調度模型
 * @param {number} batchIdx 批次索引 (0, 1, 2...)
 * @param {boolean} isHybrid 是否啟用 Hybrid 雙模型輪替
 * @param {string} primaryModel 主要模型 (預設 gemini-3.1-flash-lite)
 * @param {string} secondaryModel 次要模型 (預設 gemini-3.5-flash-lite)
 * @returns {string} 該批次應指派的模型名稱
 */
export function getBatchModel(batchIdx, isHybrid, primaryModel, secondaryModel) {
    if (!isHybrid) return primaryModel;
    return (batchIdx % 2 === 1) ? (secondaryModel || primaryModel) : primaryModel;
}

/**
 * 計算 Hybrid 模式下的有效請求延遲 (ms)
 * @param {number} baseDelay 基礎延遲 (預設 4000ms)
 * @param {boolean} isHybrid 是否啟用 Hybrid 雙模型輪替
 * @returns {number} 實際等待延遲
 */
export function getEffectiveDelay(baseDelay, isHybrid) {
    if (!isHybrid) return baseDelay;
    return Math.max(1500, Math.floor(baseDelay / 2));
}

/**
 * 跨模型 429/503 容錯切換 (Failover)
 * @param {string} currentModel 當前失敗的模型
 * @param {string} primaryModel 主要模型
 * @param {string} secondaryModel 次要模型
 * @returns {string} 接棒重試的新模型
 */
export function getFailoverModel(currentModel, primaryModel, secondaryModel) {
    return (currentModel === primaryModel) ? (secondaryModel || primaryModel) : primaryModel;
}
