/**
 * novel-result-mapping.js
 * 
 * 專門負責小說模式 Gemini API 回傳結果的驗證與位置精確對齊 (Positional Index Mapping)。
 * 核心原則：
 * 1. 輸出陣列長度永遠嚴格等於 expectedLength，絕不因缺失或多餘項產生索引壓縮與段落位移。
 * 2. 預設槽位為 '（翻譯失敗）'。
 * 3. 重複索引採 First Valid Result Wins 確定性規則。
 * 4. 嚴格過濾負數、浮點數、超界、字串型態索引與無效內容。
 */

export const NOVEL_TRANSLATION_FAILURE_TEXT = '（翻譯失敗）';

/**
 * 將 Gemini 回傳的結構化結果或 Legacy 陣列映射為長度固定且嚴格對齊的譯文字串陣列
 * @param {*} result Gemini 回傳結果
 * @param {number} expectedLength 預期的段落總數量
 * @returns {{ translations: string[], validCount: number }}
 */
export function mapNovelTranslationResults(result, expectedLength) {
    if (!Number.isInteger(expectedLength) || expectedLength <= 0) {
        return { translations: [], validCount: 0 };
    }

    const translations = new Array(expectedLength).fill(NOVEL_TRANSLATION_FAILURE_TEXT);
    let validCount = 0;
    const seenIndices = new Set();

    if (!result || typeof result !== 'object') {
        return { translations, validCount: 0 };
    }

    // 1. 標準結構化物件格式: { translations: [{ index, text }] }
    if (result.translations && Array.isArray(result.translations)) {
        for (const item of result.translations) {
            if (!item || typeof item !== 'object') continue;

            const idx = item.index;
            const text = item.text;

            // 嚴格索引校驗: 必須是整數且在 [0, expectedLength) 範圍內
            if (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0 || idx >= expectedLength) {
                continue;
            }

            // 重複索引防禦: First Valid Result Wins (第二筆重複忽略)
            if (seenIndices.has(idx)) {
                continue;
            }

            // 譯文文字校驗: 必須是非空字串
            if (typeof text !== 'string' || text.trim().length === 0) {
                continue;
            }

            seenIndices.add(idx);
            translations[idx] = text;
            validCount++;
        }
        return { translations, validCount };
    }

    // 2. Legacy Positional Array 格式: ["譯文1", "譯文2", ...]
    if (Array.isArray(result)) {
        const processCount = Math.min(result.length, expectedLength);
        for (let i = 0; i < processCount; i++) {
            const item = result[i];
            if (typeof item === 'string' && item.trim().length > 0) {
                translations[i] = item;
                validCount++;
            }
        }
        return { translations, validCount };
    }

    return { translations, validCount: 0 };
}
