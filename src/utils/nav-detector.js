/**
 * 偵測網頁中的「下一話」、「上一話」導航連結，以及當前話數與完整章節選單
 */
export function detectNavigationLinks() {
    const nav = { prev: null, next: null, currentChapter: '', chapterList: [] };
    const links = document.querySelectorAll('a');

    // 取得當前頁面 URL 並標準化 (移除 hash 與末端斜線)
    const currentUrl = window.location.href.split('#')[0].replace(/\/$/, '');

    // 1. 嘗試從 <select> 下拉選單中獲取章節列表與當前選中項 (常見於 Rawkuma, MangaDex, Madara 等漫畫網站)
    const chapterSelects = document.querySelectorAll('select#chapter, select#select-chapter, select.chapter-select, select[name="chapter"]');
    chapterSelects.forEach(select => {
        if (select && select.options && select.options.length > 0) {
            const list = [];
            for (let i = 0; i < select.options.length; i++) {
                const opt = select.options[i];
                const optUrl = opt.value && (opt.value.startsWith('http') || opt.value.startsWith('/')) ? opt.value : '';
                const isSelected = opt.selected || opt.hasAttribute('selected') || (optUrl && currentUrl.includes(optUrl));
                const title = opt.text.trim();
                if (isSelected && !nav.currentChapter) {
                    nav.currentChapter = title;
                }
                if (optUrl) {
                    list.push({
                        title: title,
                        url: optUrl.startsWith('http') ? optUrl : new URL(optUrl, window.location.href).href,
                        current: isSelected
                    });
                }
            }
            if (list.length > 0 && nav.chapterList.length === 0) {
                nav.chapterList = list;
            }
        }
    });

    // 2. 若尚未識別出當前話數，嘗試從 URL 或頁面標題（H1, Title）提取 (如 chapter-15.4、第15話)
    if (!nav.currentChapter) {
        const urlMatch = currentUrl.match(/chapter[_-]?([\d\.]+)/i) || currentUrl.match(/(\d+[\.\d]*)\/?$/);
        if (urlMatch && urlMatch[1]) {
            nav.currentChapter = `Chapter ${urlMatch[1]}`;
        } else {
            const titleText = document.title || '';
            const titleMatch = titleText.match(/Chapter\s*([\d\.]+)/i) || titleText.match(/第\s*([\d\.]+)\s*話/i);
            if (titleMatch && titleMatch[1]) {
                nav.currentChapter = `Chapter ${titleMatch[1]}`;
            }
        }
    }

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

        // 優先檢查 rel 屬性 (HTML 標準)
        const rel = (a.getAttribute('rel') || '').toLowerCase();
        if (!nav.next && (rel === 'next' || rel.includes('next'))) {
            nav.next = href;
        }
        if (!nav.prev && (rel === 'prev' || rel.includes('prev') || rel.includes('previous'))) {
            nav.prev = href;
        }

        // 關鍵字匹配（text + title + aria-label）
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
