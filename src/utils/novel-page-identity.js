/**
 * novel-page-identity.js
 * 
 * 專門負責小說頁面 URL 的規範化與比對。
 * 核心原則：
 * 1. 使用標準 URL API 進行解析。
 * 2. 保留 origin, pathname, search/query（因為 ?chapter=1 與 ?chapter=2 代表不同章節）。
 * 3. 移除 hash fragment（例如 #p20 與無 hash 視為同一頁面）。
 * 4. 嚴禁模糊匹配或僅比對 hostname。
 */

/**
 * 規範化小說頁面 URL
 * @param {string} rawUrl 
 * @returns {string}
 */
export function normalizeNovelPageUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return '';
    try {
        const parsed = new URL(rawUrl);
        // 移除 hash fragment，保留 origin + pathname + search
        return `${parsed.origin}${parsed.pathname}${parsed.search}`;
    } catch (_) {
        // 若非合法完整 URL，去除 hash 後回傳 trim 結果
        const hashIdx = rawUrl.indexOf('#');
        const withoutHash = hashIdx >= 0 ? rawUrl.substring(0, hashIdx) : rawUrl;
        return withoutHash.trim();
    }
}

/**
 * 比對兩個小說頁面 URL 是否為同一頁面 (忽略 hash fragment)
 * @param {string} urlA 
 * @param {string} urlB 
 * @returns {boolean}
 */
export function isSameNovelPage(urlA, urlB) {
    const normA = normalizeNovelPageUrl(urlA);
    const normB = normalizeNovelPageUrl(urlB);
    if (!normA || !normB) return false;
    return normA === normB;
}
