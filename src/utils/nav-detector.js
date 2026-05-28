/**
 * 偵測網頁中的「下一話」與「上一話」導航連結
 * 對齊 v1.8.7 的完整邏輯：包含 disabled 過濾、URL 標準化、aria-label 支援
 */
export function detectNavigationLinks() {
    const nav = { prev: null, next: null };
    const links = document.querySelectorAll('a');

    // 取得當前頁面 URL 並標準化 (移除 hash 與末端斜線)
    const currentUrl = window.location.href.split('#')[0].replace(/\/$/, '');

    const nextRegex = /(下一|次|next|forward|後|→|≫|»|>)/i;
    const prevRegex = /(上一|前|prev|back|return|先|←|≪|«|<)/i;

    links.forEach(a => {
        const href = a.href;
        // 排除無效連結或 JavaScript 動作
        if (!href || href.startsWith('javascript:') || href.split('#')[0] === '') return;

        // 排除指向當前頁面的連結 (標準化後比對)
        const targetUrl = href.split('#')[0].replace(/\/$/, '');
        if (targetUrl === currentUrl) return;

        // 排除被禁用的連結 (常見於漫畫網站的「無下一話」狀態)
        if (a.hasAttribute('disabled') ||
            a.getAttribute('aria-disabled') === 'true' ||
            a.classList.contains('disabled') ||
            a.classList.contains('is-disabled')) return;

        // 1. 優先檢查 rel 屬性 (HTML 標準)
        const rel = (a.getAttribute('rel') || '').toLowerCase();
        if (!nav.next && (rel === 'next' || rel.includes('next'))) {
            nav.next = href;
        }
        if (!nav.prev && (rel === 'prev' || rel.includes('prev') || rel.includes('previous'))) {
            nav.prev = href;
        }

        // 2. 關鍵字匹配（text + title + aria-label，長度限制 30 字避免誤抓長文）
        const text = (a.innerText || a.title || a.getAttribute('aria-label') || '').trim();
        if (!text || text.length > 30) return;

        if (!nav.next && nextRegex.test(text)) {
            nav.next = href;
        }
        if (!nav.prev && prevRegex.test(text)) {
            nav.prev = href;
        }
    });

    return nav;
}
