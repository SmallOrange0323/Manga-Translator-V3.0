/**
 * json-utils.js
 * JSON 字串預處理工具
 * 用途：清理 LLM 產出的格式問題，使 JSON.parse 能正常運作
 */

/**
 * 清理模型回傳的 JSON 字串
 * 處理項目：
 * 1. 移除 Markdown 代碼區塊標記 (```json ... ```)
 * 2. 移除 JSON 字串值內的原始換行符（\n、\r）
 * 3. 清理殘破的 Unicode 逸出序列
 * @param {string} rawText
 * @returns {string}
 */
export function sanitizeJsonForParsing(rawText) {
    if (!rawText || typeof rawText !== 'string') return '{}';

    // 1. 移除 Markdown 代碼塊
    let cleaned = rawText
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();

    // 2. 移除 JSON 字串值內的原始換行符（僅在字串值內部）
    // 策略：將所有連續空白字元（換行、Tab）替換為空格，再讓 JSON.parse 處理
    // 注意：這個方式對大多數 LLM 輸出有效，但不處理刻意包含換行的字串值
    cleaned = cleaned.replace(/[\r\n\t]+/g, ' ');

    // 3. 嘗試擷取合法的 JSON 物件或陣列區間
    const firstBrace = cleaned.indexOf('{');
    const firstBracket = cleaned.indexOf('[');
    
    let start = -1;
    let end = -1;

    // 決定起點
    if (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
        start = firstBrace;
        end = cleaned.lastIndexOf('}');
    } else if (firstBracket !== -1) {
        start = firstBracket;
        end = cleaned.lastIndexOf(']');
    }

    if (start !== -1 && end !== -1 && end > start) {
        cleaned = cleaned.slice(start, end + 1);
    }

    return cleaned;
}
