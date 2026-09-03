/**
 * novel-refusal.js
 * 專門負責小說模式模型拒絕 (Model Refusal) 的結構化判斷與遞迴二分隔離 (Batch Isolation)
 */

import { log } from '../utils/logger.js';

/**
 * 判斷錯誤是否為 Gemini API 明確內容拒絕 (Model Refusal)
 * 例如 SAFETY, BLOCKLIST, PROHIBITED_CONTENT
 * @param {Error|any} error 
 * @returns {boolean}
 */
export function isModelRefusalError(error) {
    if (!error) return false;
    if (error.isProhibited === true) return true;
    const reason = error.finishReason;
    if (reason === 'SAFETY' || reason === 'BLOCKLIST' || reason === 'PROHIBITED_CONTENT') {
        return true;
    }
    return false;
}

/**
 * 針對小說 Batch 進行模型拒絕隔離 (Model Refusal Isolation)
 * 當 translateFn 因 isModelRefusalError 失敗時，自動遞迴二分拆解，
 * 逐步隔離出真正觸發拒絕的段落，其餘正常段落正常翻譯並維持原始順序與索引。
 * 普通錯誤 (429, 5xx, timeout, network, parse error 等) 則直接原樣 throw，不進行 split。
 * 
 * @param {Array<{idx: number, text: string}>} items 批次項目
 * @param {Function} translateFn 執行批次翻譯的非同步函式：(subItems) => Promise<Array<string>>
 * @param {Object} [options]
 * @param {Function} [options.shouldContinue] 是否繼續執行的檢查函式 (若已中止則中斷)
 * @param {number} [options.depth] 當前遞迴深度
 * @param {number} [options.maxDepth] 最大遞迴深度防護
 * @returns {Promise<Array<{idx: number, text: string, translation: string, failed?: boolean, failureReason?: string}>>}
 */
export async function translateNovelBatchWithRefusalIsolation(items, translateFn, options = {}) {
    if (!items || items.length === 0) return [];

    const { shouldContinue, depth = 0 } = options;
    const maxDepth = options.maxDepth ?? (Math.ceil(Math.log2(items.length)) + 2);

    // 檢查 Session Ownership / STOP 旗標
    if (shouldContinue && !(await shouldContinue())) {
        const abortErr = new Error('Session aborted');
        abortErr.isAborted = true;
        throw abortErr;
    }

    try {
        // 嘗試整批一次性翻譯
        const translations = await translateFn(items);
        return items.map((item, i) => ({
            idx: item.idx,
            text: item.text,
            translation: translations[i] ?? '（翻譯失敗）'
        }));
    } catch (err) {
        // 若為 abort / cancellation 錯誤，直接拋出
        if (err?.isAborted) {
            throw err;
        }

        // 非 Model Refusal (例如 429, 500, network, timeout, parse error)，絕對不 split，原樣拋出
        if (!isModelRefusalError(err)) {
            throw err;
        }

        // --- Model Refusal 處理分支 ---
        log.warn('NovelRefusal', `[Refusal Isolation] 偵測到 Model Refusal (Batch 筆數: ${items.length}, depth: ${depth})`);

        // Base Case: 只有單一段落時仍被拒絕，停止遞迴拆分，標記該單段失敗
        if (items.length <= 1) {
            return items.map(item => ({
                idx: item.idx,
                text: item.text,
                translation: '（翻譯失敗）',
                failed: true,
                failureReason: 'model-refusal'
            }));
        }

        // 防止遞迴過深防護 (Recursion Explosion Guard)
        if (depth >= maxDepth) {
            log.warn('NovelRefusal', `[Refusal Isolation] 已達最大遞迴深度限制 (${maxDepth})，停止拆分`);
            return items.map(item => ({
                idx: item.idx,
                text: item.text,
                translation: '（翻譯失敗）',
                failed: true,
                failureReason: 'model-refusal'
            }));
        }

        // 遞迴二分拆解 (Binary Split)
        const mid = Math.ceil(items.length / 2);
        const leftItems = items.slice(0, mid);
        const rightItems = items.slice(mid);

        // 執行左半部
        const leftResults = await translateNovelBatchWithRefusalIsolation(leftItems, translateFn, {
            ...options,
            depth: depth + 1,
            maxDepth
        });

        // 執行右半部前再次檢查 STOP / Ownership
        if (shouldContinue && !(await shouldContinue())) {
            const abortErr = new Error('Session aborted');
            abortErr.isAborted = true;
            throw abortErr;
        }

        // 執行右半部
        const rightResults = await translateNovelBatchWithRefusalIsolation(rightItems, translateFn, {
            ...options,
            depth: depth + 1,
            maxDepth
        });

        // 依原始順序合併返回
        return [...leftResults, ...rightResults];
    }
}

/**
 * 組裝小說單段重譯 (Single Paragraph Retry) 所需的 translateTexts options
 * @param {Object} params
 * @param {string} params.model
 * @param {string} [params.fallbackModel]
 * @param {string} [params.prompt]
 * @param {string} [params.glossarySnippet]
 * @param {Object} [params.schema]
 * @returns {Object}
 */
export function buildNovelSingleRetryOptions({ model, fallbackModel, prompt, glossarySnippet, schema } = {}) {
    return {
        model,
        fallbackModel,
        prompt,
        glossarySnippet: glossarySnippet || '',
        schema: schema || {
            type: 'OBJECT',
            properties: {
                results: {
                    type: 'ARRAY',
                    items: { type: 'STRING' }
                }
            },
            required: ['results']
        }
    };
}

/**
 * 從小說批次原始項目與翻譯結果中萃取成功的對話配對 (過濾失敗標記)
 * @param {Array<{text: string}>} batchItems 
 * @param {Array<string>} translations 
 * @returns {Array<{original: string, translation: string}>}
 */
export function buildSuccessfulNovelTranslationPairs(batchItems = [], translations = []) {
    if (!batchItems || !translations) return [];
    return batchItems.map((it, offset) => ({
        original: it.text,
        translation: translations[offset]
    })).filter(p => p.translation && p.translation !== '（翻譯失敗）');
}

/**
 * 將 Refusal Isolation 的結果物件陣列整合成 Durable Job 所需的 mappedResult
 * 保持 isFailed: false (避免 Mixed Batch 造成整批全部失敗)
 * @param {Array<{translation?: string, failed?: boolean}>} isolationResults 
 * @returns {{translations: Array<string>, isFailed: boolean}}
 */
export function buildNovelIsolationMappedResult(isolationResults = []) {
    const translations = (isolationResults || []).map(r => r.translation || '（翻譯失敗）');
    return {
        translations,
        isFailed: false
    };
}

