// src/utils/site-adapters.js
// 網站專屬適配器（Site Adapter）隔離架構：集中管理特定漫畫網站的容器與佔位圖規則，避免改動誤傷既有網站

/**
 * 網站專屬適配器規則陣列（保持純 JSON 可序列化結構，方便未來雲端熱更新）
 */
export const SITE_ADAPTER_RULES = [
    {
        id: 'jmanga',
        hostPattern: '(^|\\.)jmanga\\.[a-z]+$',
        hostFlags: 'i',
        extraContainers: [
            '#images-content',
            '#vertical-content',
            '.container-reader-chapter',
            '.iv-card'
        ],
        allowPlaceholderWithDataSrc: true
    }
];

const compiledPatternCache = new WeakMap();

/**
 * 從完整網址或主機名稱中萃取標準化小寫主機名稱
 * @param {string} urlOrHostname
 * @returns {string}
 */
function extractHostname(urlOrHostname) {
    if (!urlOrHostname || typeof urlOrHostname !== 'string') return '';
    const trimmed = urlOrHostname.trim();
    if (!trimmed) return '';
    try {
        if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
            return new URL(trimmed).hostname.toLowerCase();
        }
        return trimmed.split(/[/?#]/)[0].split(':')[0].toLowerCase();
    } catch (_) {
        return '';
    }
}

/**
 * 取得或編譯規則的主機名稱正則表達式
 * @param {object} rule
 * @returns {RegExp|null}
 */
function getHostRegex(rule) {
    if (!rule || typeof rule !== 'object') return null;
    if (compiledPatternCache.has(rule)) {
        return compiledPatternCache.get(rule);
    }
    let regex = null;
    try {
        if (rule.hostRegex instanceof RegExp) {
            regex = rule.hostRegex;
        } else if (typeof rule.hostPattern === 'string' && rule.hostPattern) {
            regex = new RegExp(rule.hostPattern, rule.hostFlags || 'i');
        }
    } catch (_) {
        regex = null;
    }
    compiledPatternCache.set(rule, regex);
    return regex;
}

/**
 * 依網址或主機名稱查詢對應的網站專屬適配器規則
 * @param {string} urlOrHostname
 * @param {Array<object>} [rules=SITE_ADAPTER_RULES]
 * @returns {object|null}
 */
export function getSiteAdapter(urlOrHostname, rules = SITE_ADAPTER_RULES) {
    const hostname = extractHostname(urlOrHostname);
    if (!hostname || !Array.isArray(rules)) return null;
    for (const rule of rules) {
        const regex = getHostRegex(rule);
        if (regex && regex.test(hostname)) {
            return rule;
        }
    }
    return null;
}

/**
 * 取得指定網站的額外漫畫主容器 CSS 選擇器列表（未匹配網站回傳空陣列）
 * @param {string} urlOrHostname
 * @param {Array<object>} [rules=SITE_ADAPTER_RULES]
 * @returns {string[]}
 */
export function getExtraMangaContainers(urlOrHostname, rules = SITE_ADAPTER_RULES) {
    const adapter = getSiteAdapter(urlOrHostname, rules);
    if (!adapter || !Array.isArray(adapter.extraContainers)) {
        return [];
    }
    return [...adapter.extraContainers];
}

/**
 * 判斷圖片是否符合該網站的「1x1 / 佔位圖 + 有效 dataSrc」豁免條件
 * 未匹配專屬規則或未開啟 allowPlaceholderWithDataSrc 的網站一律回傳 false，確保不影響既有網站
 * @param {Element|object|null} imgElement
 * @param {string|null|undefined} dataSrc
 * @param {string|null|undefined} url
 * @param {string} urlOrHostname
 * @returns {boolean}
 */
export function isSitePlaceholderExempt(imgElement, dataSrc, url, urlOrHostname) {
    const adapter = getSiteAdapter(urlOrHostname);
    if (!adapter || !adapter.allowPlaceholderWithDataSrc) {
        return false;
    }

    const normalizedDataSrc = typeof dataSrc === 'string' ? dataSrc.trim() : '';
    const normalizedUrl = typeof url === 'string' ? url.trim() : '';
    if (!normalizedDataSrc || !normalizedUrl) {
        return false;
    }

    // dataSrc 或解析後 url 本身不可為空白透明佔位 Data URI
    if (/^data:image\/(?:gif;base64,R0lGOD|svg\+xml)/i.test(normalizedDataSrc)
        || /^data:image\/(?:gif;base64,R0lGOD|svg\+xml)/i.test(normalizedUrl)) {
        return false;
    }

    // 優先讀取 HTML src 屬性，避免瀏覽器將 src="" 解析成當前頁面 URL
    const attrSrc = typeof imgElement?.getAttribute === 'function'
        ? imgElement.getAttribute('src')
        : undefined;
    const rawSrc = String(attrSrc ?? imgElement?.src ?? '').trim();

    return !rawSrc
        || /^data:image\//i.test(rawSrc)
        || /(?:placeholder|loading)/i.test(rawSrc);
}
