import { chapterNeighbors, normalizeChapterUrl, resolveHttpUrl } from './chapter-parser.js';

/**
 * 偵測網頁中的「下一話」、「上一話」導航連結，以及當前話數與完整章節選單
 */
export function detectNavigationLinks() {
    const nav = { prev: null, next: null, currentChapter: '', chapterList: [] };
    const links = document.querySelectorAll('a');

    // 取得當前頁面 URL 並標準化 (移除 hash 與末端斜線)
    const currentUrl = normalizeChapterUrl(window.location.href, window.location.href);

    // 1. 嘗試從 <select> 下拉選單中獲取章節列表與當前選中項 (相容 Rawkuma, Jestful, MangaDex, Madara 等漫畫網站)
    const chapterSelects = document.querySelectorAll(
        'select#chapter, select#select-chapter, select.chapter-select, select[name*="chapter"], select[id*="chapter"], .select-chapter select, .chapter-select select, .chapter_select select, #klist-chss select, select.form-control'
    );

    const selectCandidates = [];
    chapterSelects.forEach(select => {
        if (select && select.options && select.options.length >= 2) {
            const list = [];

            for (let i = 0; i < select.options.length; i++) {
                const opt = select.options[i];
                const optVal = (opt.value || '').trim();
                const optText = (opt.text || '').trim();
                if (!optVal && !optText) continue;

                let optUrl = '';
                if (optVal && (optVal.startsWith('http') || optVal.startsWith('/') || optVal.includes('.html') || optVal.includes('chapter'))) {
                    optUrl = resolveHttpUrl(optVal, window.location.href);
                }

                const isSelected = !!(opt.selected || opt.hasAttribute('selected') ||
                    (optUrl && currentUrl === normalizeChapterUrl(optUrl, window.location.href)));
                list.push({
                    title: optText,
                    url: optUrl,
                    current: isSelected
                });
            }

            const inferred = chapterNeighbors(list, currentUrl);
            if (inferred.currentIndex !== -1) selectCandidates.push({
                list, inferred, exact: list.some(item =>
                    normalizeChapterUrl(item.url, window.location.href) === currentUrl)
            });
        }
    });
    selectCandidates.sort((a, b) => Number(b.exact) - Number(a.exact));
    if (selectCandidates[0]) {
        const { list, inferred } = selectCandidates[0];
        nav.chapterList = list.map((item, index) => ({ ...item, current: index === inferred.currentIndex }));
        nav.currentChapter = list[inferred.currentIndex].title;
        nav.next = inferred.next;
        nav.prev = inferred.prev;
    }

    // Custom chapter lists (for example, JManga's reading-list) use anchors instead of select options.
    if (nav.chapterList.length === 0 || !selectCandidates[0]?.exact) {
        const chapterLists = document.querySelectorAll(
            'ul.reading-list, ul.chapters-list, .chapters-list-ul ul, ul.chapter-list, .chapter-list-read ul, .list-chapter ul'
        );
        const candidates = [];
        chapterLists.forEach(ul => {
            const entries = [];
            ul.querySelectorAll('li').forEach(li => {
                const a = li.querySelector('a[href]');
                if (!a) return;
                const url = resolveHttpUrl(a.href || a.getAttribute('href'), window.location.href);
                if (!url) return;
                entries.push({
                    title: (a.textContent || '').trim(), url,
                    current: /(?:^|\s)(?:highlight|active|current|selected)(?:\s|$)/i.test(li.className || '')
                });
            });
            if (entries.length < 2) return;
            const inferred = chapterNeighbors(entries, currentUrl);
            const visible = ul.style?.display !== 'none' && ul.getAttribute('aria-hidden') !== 'true';
            const exact = entries.some(item => normalizeChapterUrl(item.url, window.location.href) === currentUrl);
            candidates.push({ entries, inferred, visible, exact });
        });
        const chosen = candidates.filter(item => item.inferred.currentIndex >= 0)
            .sort((a, b) => Number(b.exact) - Number(a.exact) || Number(b.visible) - Number(a.visible))[0];
        if (chosen && (nav.chapterList.length === 0 || chosen.exact)) {
            nav.chapterList = chosen.entries.map((item, index) => ({ ...item, current: index === chosen.inferred.currentIndex }));
            nav.currentChapter = chosen.entries[chosen.inferred.currentIndex].title;
            nav.next = chosen.inferred.next;
            nav.prev = chosen.inferred.prev;
        }
    }

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
        const targetUrl = normalizeChapterUrl(href, window.location.href);
        if (!targetUrl || targetUrl === currentUrl || new URL(targetUrl).origin !== new URL(currentUrl).origin) return;

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
