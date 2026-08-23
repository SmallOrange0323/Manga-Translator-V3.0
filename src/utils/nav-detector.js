/**
 * 偵測網頁中的「下一話」、「上一話」導航連結，以及當前話數與完整章節選單
 */
export function detectNavigationLinks() {
    const nav = { prev: null, next: null, currentChapter: '', chapterList: [] };
    const links = document.querySelectorAll('a');

    // 取得當前頁面 URL 並標準化 (移除 hash 與末端斜線)
    const currentUrl = window.location.href.split('#')[0].replace(/\/$/, '');

    // 1. 嘗試從 <select> 下拉選單中獲取章節列表與當前選中項 (相容 Rawkuma, Jestful, MangaDex, Madara 等漫畫網站)
    const chapterSelects = document.querySelectorAll(
        'select#chapter, select#select-chapter, select.chapter-select, select[name*="chapter"], select[id*="chapter"], .select-chapter select, .chapter-select select, .chapter_select select, #klist-chss select, select.form-control'
    );

    chapterSelects.forEach(select => {
        if (select && select.options && select.options.length >= 2) {
            const list = [];
            let selectedIdx = -1;

            for (let i = 0; i < select.options.length; i++) {
                const opt = select.options[i];
                const optVal = (opt.value || '').trim();
                const optText = opt.text.trim();
                if (!optVal && !optText) continue;

                let optUrl = '';
                if (optVal && (optVal.startsWith('http') || optVal.startsWith('/') || optVal.includes('.html') || optVal.includes('chapter'))) {
                    optUrl = optVal.startsWith('http') ? optVal : new URL(optVal, window.location.href).href;
                }

                const isSelected = opt.selected || opt.hasAttribute('selected') || (optUrl && currentUrl.includes(optUrl));
                if (isSelected) {
                    selectedIdx = list.length;
                    if (!nav.currentChapter) nav.currentChapter = optText;
                }

                list.push({
                    title: optText,
                    url: optUrl,
                    current: isSelected
                });
            }

            if (list.length > 0 && nav.chapterList.length === 0) {
                nav.chapterList = list;
            }

            // 智慧推導上一話 / 下一話連結 (若當前為倒序或正序)
            if (selectedIdx !== -1 && list.length >= 2) {
                // 判斷章節排列順序 (抽取數字比對第 0 項與最後一項)
                const getChapNum = (t) => {
                    const m = (t || '').match(/[\d\.]+/);
                    return m ? parseFloat(m[0]) : 0;
                };
                const firstNum = getChapNum(list[0].title);
                const lastNum = getChapNum(list[list.length - 1].title);
                const isDescending = firstNum >= lastNum; // 倒序：最新話在最前

                if (isDescending) {
                    // 倒序：上方 (idx - 1) 是下一話(較新)，下方 (idx + 1) 是上一話(較舊)
                    if (selectedIdx > 0 && list[selectedIdx - 1].url) {
                        nav.next = list[selectedIdx - 1].url;
                    }
                    if (selectedIdx < list.length - 1 && list[selectedIdx + 1].url) {
                        nav.prev = list[selectedIdx + 1].url;
                    }
                } else {
                    // 正序：下方 (idx + 1) 是下一話(較新)，上方 (idx - 1) 是上一話(較舊)
                    if (selectedIdx < list.length - 1 && list[selectedIdx + 1].url) {
                        nav.next = list[selectedIdx + 1].url;
                    }
                    if (selectedIdx > 0 && list[selectedIdx - 1].url) {
                        nav.prev = list[selectedIdx - 1].url;
                    }
                }
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

        // 關鍵字匹配（text + title + aria-label + class）
        const text = (a.innerText || a.title || a.getAttribute('aria-label') || '').trim();
        const className = (a.className || '').toLowerCase();
        
        if (!nav.next && (nextRegex.test(text) || className.includes('next'))) {
            nav.next = href;
        }
        if (!nav.prev && (prevRegex.test(text) || className.includes('prev'))) {
            nav.prev = href;
        }
    });

    return nav;
}
