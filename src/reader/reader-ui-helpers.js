// 漫譯閱讀器 UI 輔助、匯出、字型/主題控制與卡片對話渲染模組
import { LOADING_GIF_FILENAME } from '../utils/constants.js';

let currentTheme = 'umamusume';
let currentFontScale = 100; // 70% ~ 160%

// 4 大黃金字型對照表 (宋體 / 圓體 / 源石黑體 / 楷體)
const FONT_MAP = {
    serif: 'var(--font-serif)',
    maru: 'var(--font-maru)',
    gensen: 'var(--font-gensen)',
    kai: 'var(--font-kai)'
};

/**
 * 譯文文字淨化工具：徹底清理 \n 與多餘換行，若整句被外層對話引號包裹則成對剝離，保留句內引號
 * @param {string} text
 * @returns {string}
 */
export function sanitizeTranslationText(text) {
    if (!text) return '';
    let clean = text.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
    clean = clean.replace(/([，。！？；：])\s+/g, '$1');
    // 只有當整句話是成對被外層引號包裹時才剝離，句中專有名詞引號（如「戰鬥方式」）100% 完整保留
    if ((clean.startsWith('「') && clean.endsWith('」')) ||
        (clean.startsWith('『') && clean.endsWith('』')) ||
        (clean.startsWith('"') && clean.endsWith('"')) ||
        (clean.startsWith("'") && clean.endsWith("'"))) {
        clean = clean.slice(1, -1).trim();
    }
    return clean;
}

/**
 * 將本地大型 data:image/... 轉換為空字串，避免 sendMessage 超出 Chrome 64 MiB 限制
 * @param {string|Object} item
 * @returns {string}
 */
export function toLightweightRetryImageRef(item) {
    const src = typeof item === 'string' ? item : (item?.retryUrl || item?.image || '');
    return src.startsWith('data:image/') ? '' : src;
}

/**
 * 套用閱讀器主題樣式
 * @param {string} theme
 */
export function applyTheme(theme) {
    document.body.classList.remove('theme-umamusume', 'theme-priconne');
    document.body.classList.add(`theme-${theme}`);
    currentTheme = theme;
}

/**
 * 取得載入動畫資源設定
 * @returns {{ type: string, url: string }}
 */
export function getRandomAnimPath() {
    // 使用東方 Loading GIF
    return {
        type: 'image',
        url: chrome.runtime.getURL(LOADING_GIF_FILENAME)
    };
}

/**
 * 套用字體縮放比例 (70% ~ 160%)
 * @param {number} scale
 */
export function applyFontScale(scale) {
    currentFontScale = Math.max(70, Math.min(160, scale));
    const zhSize = (17.5 * (currentFontScale / 100)).toFixed(1);
    const jaSize = (13 * (currentFontScale / 100)).toFixed(1);
    document.documentElement.style.setProperty('--zh-font-size', `${zhSize}px`);
    document.documentElement.style.setProperty('--ja-font-size', `${jaSize}px`);
    const indicator = document.getElementById('font-size-indicator');
    if (indicator) indicator.textContent = `${currentFontScale}%`;
    chrome.storage.local.set({ mt_font_scale: currentFontScale });
}

/**
 * 套用譯文字型風格
 * @param {string} fontKey
 */
export function applyFontFamily(fontKey) {
    const targetFont = FONT_MAP[fontKey] || FONT_MAP.serif;
    document.documentElement.style.setProperty('--font-trans', targetFont);
    const selectEl = document.getElementById('font-family-select');
    if (selectEl && selectEl.value !== fontKey) {
        selectEl.value = fontKey;
    }
    chrome.storage.local.set({ mt_font_family: fontKey });
}

/**
 * 初始化字體大小與字型切換控制列
 */
export function initFontControls() {
    // 1. 初始化字體大小
    chrome.storage.local.get(['mt_font_scale', 'mt_font_family'], (res) => {
        if (res && res.mt_font_scale) {
            applyFontScale(res.mt_font_scale);
        } else {
            applyFontScale(100);
        }
        // 2. 初始化字型風格
        if (res && res.mt_font_family) {
            applyFontFamily(res.mt_font_family);
        } else {
            applyFontFamily('serif');
        }
    });

    const decBtn = document.getElementById('font-decrease-btn');
    const incBtn = document.getElementById('font-increase-btn');
    if (decBtn) decBtn.onclick = () => applyFontScale(currentFontScale - 10);
    if (incBtn) incBtn.onclick = () => applyFontScale(currentFontScale + 10);

    const fontSelect = document.getElementById('font-family-select');
    if (fontSelect) {
        fontSelect.onchange = (e) => applyFontFamily(e.target.value);
    }
}

/**
 * 聚焦並捲動至指定結果卡片
 * @param {HTMLElement} cardEl
 * @param {HTMLElement|null} [containerEl]
 */
export function focusCard(cardEl, containerEl = document.getElementById('results-container')) {
    if (!cardEl) return;
    if (containerEl) {
        containerEl.querySelectorAll('.result-card').forEach(el => el.classList.remove('is-focused'));
    }
    cardEl.classList.add('is-focused');
    cardEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/**
 * 初始化鍵盤左右鍵 / A / D 卡片快速切換與聚焦樣式
 * @param {HTMLElement} container
 */
export function initKeyboardCardNavigation(container) {
    const style = document.createElement('style');
    style.id = 'mt-result-focus-styles';
    style.textContent = `
        .result-card.is-focused {
            border: 2px solid #4a9eff !important;
            box-shadow: 0 0 15px rgba(74, 158, 255, 0.4) !important;
            transform: translateY(-2px) scale(1.005);
            transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1) !important;
        }
    `;
    document.head.appendChild(style);

    let currentFocusedCardIndex = -1;
    document.addEventListener('keydown', (e) => {
        // 如果使用者正在輸入文字或可編輯狀態中，不進行卡片切換
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) {
            return;
        }

        const cards = container.querySelectorAll('.result-card');
        if (cards.length === 0) return;

        if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') {
            e.preventDefault();
            currentFocusedCardIndex = Math.min(currentFocusedCardIndex + 1, cards.length - 1);
            focusCard(cards[currentFocusedCardIndex], container);
        } else if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') {
            e.preventDefault();
            currentFocusedCardIndex = Math.max(currentFocusedCardIndex - 1, 0);
            focusCard(cards[currentFocusedCardIndex], container);
        }
    });
}

/**
 * 初始化閱讀模式切換按鈕 (三態：自動 / 行動 / 電腦) 與行動端頂部切換電腦版按鈕
 */
export function initModeToggleControls() {
    const toggleModeBtn = document.getElementById('toggle-mode-btn');
    if (toggleModeBtn) {
        const urlParams = new URLSearchParams(location.search);
        const hasTouchAndMobileUA = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
            (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

        let currentMode = 'auto';
        if (urlParams.get('mobile') === '1') {
            currentMode = 'mobile';
        } else if (urlParams.get('desktop') === '1') {
            currentMode = 'desktop';
        }

        // 根據不同模式渲染按鈕文字
        if (currentMode === 'mobile') {
            toggleModeBtn.innerHTML = `📱 強制行動版`;
            toggleModeBtn.title = "目前強制使用行動端滑動佈局，點擊切換為電腦版模式";
        } else if (currentMode === 'desktop') {
            toggleModeBtn.innerHTML = `💻 強制電腦版`;
            toggleModeBtn.title = "目前強制使用電腦端並排佈局，點擊切換為自動偵測模式";
        } else {
            const detectedMobile = hasTouchAndMobileUA || (window.innerWidth <= 768);
            toggleModeBtn.innerHTML = `🤖 自動偵測 (${detectedMobile ? '行動' : '電腦'})`;
            toggleModeBtn.title = "目前由系統根據螢幕尺寸與裝置自動判定，點擊切換為行動版模式";
        }

        toggleModeBtn.addEventListener('click', () => {
            // 保存當前的翻譯資料和進度狀態到 sessionStorage
            const overlayHidden = document.getElementById('loading-overlay').classList.contains('hidden');
            sessionStorage.setItem('mt_translation_complete', overlayHidden ? '1' : '0');
            sessionStorage.setItem('mt_progress_text', document.getElementById('progress-text').innerText);

            const params = new URLSearchParams(window.location.search);
            if (currentMode === 'auto') {
                // 自動 -> 行動
                params.set('mobile', '1');
                params.delete('desktop');
            } else if (currentMode === 'mobile') {
                // 行動 -> 電腦
                params.set('desktop', '1');
                params.delete('mobile');
            } else {
                // 電腦 -> 自動
                params.delete('mobile');
                params.delete('desktop');
            }
            window.location.search = params.toString();
        });
    }

    // 行動端頂部專屬「💻 電腦版」按鈕直接切換
    const mobileToggleDesktopBtn = document.getElementById('mobile-toggle-desktop-btn');
    if (mobileToggleDesktopBtn) {
        mobileToggleDesktopBtn.addEventListener('click', () => {
            const overlayHidden = document.getElementById('loading-overlay').classList.contains('hidden');
            sessionStorage.setItem('mt_translation_complete', overlayHidden ? '1' : '0');
            sessionStorage.setItem('mt_progress_text', document.getElementById('progress-text').innerText);

            const params = new URLSearchParams(window.location.search);
            params.set('desktop', '1');
            params.delete('mobile');
            window.location.search = params.toString();
        });
    }
}

/**
 * 初始化頂部下拉選單開關 (批次選單、章節選單、更多選單)
 * @param {Function} onBatchMenuOpen - 開啟批次選單前的清單刷新回呼
 */
export function initHeaderDropdowns(onBatchMenuOpen) {
    const dropBtn = document.getElementById('retranslate-batch-dropdown-btn');
    const menu = document.getElementById('batch-dropdown-menu');
    if (dropBtn && menu) {
        dropBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const isVisible = menu.style.display === 'block';
            document.querySelectorAll('.dropdown-menu').forEach(m => m.style.display = 'none');
            if (!isVisible) {
                if (typeof onBatchMenuOpen === 'function') onBatchMenuOpen();
                menu.style.display = 'block';
            }
        });
    }

    const chapterBtn = document.getElementById('chapter-dropdown-btn');
    const chapterMenu = document.getElementById('chapter-dropdown-menu');
    if (chapterBtn && chapterMenu) {
        chapterBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const isVisible = chapterMenu.style.display === 'block';
            document.querySelectorAll('.dropdown-menu').forEach(m => m.style.display = 'none');
            if (!isVisible) chapterMenu.style.display = 'block';
        });
    }

    const moreBtn = document.getElementById('more-actions-btn');
    const moreMenu = document.getElementById('more-actions-menu');
    if (moreBtn && moreMenu) {
        moreBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const isVisible = moreMenu.style.display === 'block';
            document.querySelectorAll('.dropdown-menu').forEach(m => m.style.display = 'none');
            if (!isVisible) moreMenu.style.display = 'block';
        });
    }

    document.addEventListener('click', () => {
        document.querySelectorAll('.dropdown-menu').forEach(m => m.style.display = 'none');
    });
}

/**
 * 將 blob: URL 轉換為 Base64 Data URL
 * @param {string} blobUrl
 * @returns {Promise<string>}
 */
export function blobToDataURL(blobUrl) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.onload = function() {
            const reader = new FileReader();
            reader.onloadend = function() { resolve(reader.result); };
            reader.readAsDataURL(xhr.response);
        };
        xhr.onerror = reject;
        xhr.open('GET', blobUrl);
        xhr.responseType = 'blob';
        xhr.send();
    });
}

/**
 * 檢查是否為安全的 http/https 網址
 * @param {string} url
 * @returns {boolean}
 */
export function isSafeUrl(url) {
    return typeof url === 'string' && /^https?:\/\//i.test(url);
}

/**
 * 匯出淨化後的單檔可離線閱讀 HTML
 */
export async function saveAsHTML() {
    const btn = document.getElementById('export-html-btn');
    const originalText = btn.innerText;
    btn.innerText = '正在進行內容淨化...';
    btn.disabled = true;

    try {
        // 動態獲取當前頁面所有已加載的 CSS 樣式，不寫死外部檔名
        let inlinedCss = '';
        try {
            const cssTexts = [];
            // 1. 獲取所有 <link rel="stylesheet"> 的外部 CSS 內容
            const links = Array.from(document.querySelectorAll('link[rel="stylesheet"]'));
            for (const link of links) {
                const url = link.href;
                if (url) {
                    try {
                        const text = await fetch(url).then(r => r.text());
                        cssTexts.push(text);
                    } catch (err) {
                        console.warn(`[HTML Export] 無法下載樣式表: ${url}`, err);
                    }
                }
            }
            // 2. 獲取所有現有的 <style> 標籤內容
            const styles = Array.from(document.querySelectorAll('style'));
            for (const style of styles) {
                cssTexts.push(style.textContent);
            }
            inlinedCss = cssTexts.join('\n');
        } catch (cssErr) {
            console.warn('[HTML Export] 獲取 CSS 樣式失敗，導出的 HTML 可能缺少樣式:', cssErr);
        }

        const docClone = document.documentElement.cloneNode(true);

        // 移除失效的外部 CSS 連結，改用內嵌樣式
        docClone.querySelectorAll('link[rel="stylesheet"]').forEach(el => el.remove());
        if (inlinedCss) {
            const styleTag = document.createElement('style');
            styleTag.textContent = inlinedCss;
            docClone.querySelector('head').appendChild(styleTag);
        }

        // 移除動態背景與過濾層，保留主體背景與卡片設計
        docClone.querySelector('.page-grain')?.remove();

        // 徹底刪除非必要的互動元素（保留頁數標籤 .card-page-badge）
        const selectorsToRemove = [
            '.result-header',
            '.actions',
            '.nav-footer',
            '.loading-overlay',
            '.mt-drag-handle',
            '.dialogue-btn-group',
            '.action-btn-group',
            '.btn-retry',
            '.btn-retranslate-vision',
            '.btn-retranslate-text',
            'script',
            'button',
            'iframe'
        ];

        selectorsToRemove.forEach(s => {
            const elements = docClone.querySelectorAll(s);
            elements.forEach(el => el.remove());
        });

        // 淨化編輯屬性
        docClone.querySelectorAll('[contenteditable]').forEach(el => {
            el.removeAttribute('contenteditable');
        });

        // 安全性防護：過濾 javascript: href，防止匯出 HTML 含有 XSS 連結
        docClone.querySelectorAll('a[href]').forEach(el => {
            if (/^javascript:/i.test(el.getAttribute('href'))) {
                el.removeAttribute('href');
            }
        });

        // 將所有的 blob: 網址轉換為內嵌 Base64
        const images = Array.from(docClone.querySelectorAll('img'));
        for (const img of images) {
            if (img.src.startsWith('blob:')) {
                try {
                    const base64 = await blobToDataURL(img.src);
                    img.src = base64;
                } catch (e) { console.error('Image convert failed:', e); }
            }
        }

        const htmlContent = `<!DOCTYPE html>\n${docClone.outerHTML}`;
        const blob = new Blob([htmlContent], { type: 'text/html' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `Manga_Translator_Export_${new Date().getTime()}.html`;
        a.click();
        URL.revokeObjectURL(url);
    } catch (e) {
        console.error('Save HTML failed:', e);
        alert('儲存失敗，請重試');
    } finally {
        btn.innerText = originalText;
        btn.disabled = false;
    }
}

/**
 * 從即時 DOM 匯出純文字 TXT 翻譯結果
 */
export function exportAsTXT() {
    // 改從 DOM 即時讀取，確保使用者的手動編輯與重譯都能被匯出
    const cards = document.querySelectorAll('#results-container .result-card:not(.skeleton-card)');
    if (cards.length === 0) return;

    let content = "Manga Translator 批次翻譯結果\n==============================\n\n";

    chrome.runtime.sendMessage({ action: "getResultMetadata" }, (response) => {
        if (response && response.navLinks) {
            if (response.navLinks.prev) content += `[上一話連結]: ${response.navLinks.prev}\n`;
            if (response.navLinks.next) content += `[下一話連結]: ${response.navLinks.next}\n`;
            content += "------------------------------\n\n";
        }

        cards.forEach((card, index) => {
            content += `【第 ${index + 1} 頁】\n`;

            if (card.classList.contains('is-error')) {
                const errMsg = card.querySelector('.error-message')?.textContent?.trim() || '未知錯誤';
                content += `[翻譯失敗]: ${errMsg}\n`;
            } else {
                // 即時從 DOM 讀取，捕捉使用者重譯後的最新內容
                const transTexts = Array.from(card.querySelectorAll('.translated-text')).map(el => el.textContent.trim()).filter(Boolean);
                const origTexts = Array.from(card.querySelectorAll('.original-text')).map(el => el.textContent.trim()).filter(Boolean);
                content += `[譯文]\n${transTexts.join('\n') || '無'}\n`;
                content += `[原文]\n${origTexts.join('\n') || '無'}\n`;
            }
            content += "------------------------------\n\n";
        });

        const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `Manga_Translation_${new Date().getTime()}.txt`;
        link.click();
        URL.revokeObjectURL(url);
    });
}

/**
 * 重置導航按鈕狀態，用於跳轉完成、逾時保險或任務結束
 */
export function resetNavButtons() {
    const topPrev = document.getElementById('nav-prev-chapter-btn');
    const topNext = document.getElementById('nav-next-chapter-btn');
    const bottomPrev = document.getElementById('prev-btn');
    const bottomNext = document.getElementById('next-btn');

    if (topPrev) {
        topPrev.disabled = false;
        topPrev.classList.remove('is-navigating');
        topPrev.innerHTML = `<span>‹</span> 上一話`;
    }
    if (topNext) {
        topNext.disabled = false;
        topNext.classList.remove('is-navigating');
        topNext.innerHTML = `下一話 <span>›</span>`;
    }
    if (bottomPrev) {
        bottomPrev.disabled = false;
        bottomPrev.classList.remove('is-navigating');
        bottomPrev.innerHTML = `
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>
            </svg>
            上一話`;
    }
    if (bottomNext) {
        bottomNext.disabled = false;
        bottomNext.classList.remove('is-navigating');
        bottomNext.innerHTML = `
            下一話
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>
            </svg>`;
    }
}

/**
 * 帶冷啟動容錯重試的章節跳轉訊息發送
 * @param {Object} payload
 * @param {HTMLElement|HTMLElement[]} btns
 * @param {string} label
 */
export function sendNavigateMessageWithRetry(payload, btns, label) {
    let responded = false;
    const btnList = Array.isArray(btns) ? btns.filter(Boolean) : [btns].filter(Boolean);

    btnList.forEach(b => {
        b.disabled = true;
        b.classList.add('is-navigating');
        b.innerHTML = `正在跳轉至 ${label}...`;
    });

    const doSend = () => {
        chrome.runtime.sendMessage({
            action: "navigateAndTranslate",
            ...payload
        }, (response) => {
            if (!chrome.runtime.lastError && response?.status === 'navigating') {
                responded = true;
            }
        });
    };

    doSend();

    // 600ms 容錯重試：防止 Service Worker 休眠冷啟動導致第一次訊息漏單
    setTimeout(() => {
        if (!responded) {
            console.log('[Nav] 偵測到背景 SW 可能處於冷啟動，自動補發跳轉訊息...');
            doSend();
        }
    }, 600);

    setTimeout(resetNavButtons, 10000);
}

/**
 * 渲染卡片內的對話條目，並綁定複製、語彙庫、拖曳排序與單句重譯
 * @param {HTMLElement} containerEl
 * @param {Array<Object>} results
 * @param {Object} item
 * @param {Object} [deps]
 * @param {Function} [deps.showGlossaryModal]
 * @param {Function} [deps.getContext]
 */
export function renderDialogueItems(containerEl, results, item, deps = {}) {
    const { showGlossaryModal, getContext } = deps;
    containerEl.innerHTML = '';
    results.forEach((res, lineIndex) => {
        const itemDiv = document.createElement('div');
        itemDiv.className = 'dialogue-item';
        itemDiv.draggable = true;

        const contentDiv = document.createElement('div');
        contentDiv.className = 'dialogue-content';
        const transText = document.createElement('div');
        transText.className = 'translated-text';
        transText.textContent = sanitizeTranslationText(res.translation) || '無翻譯';
        const origText = document.createElement('div');
        origText.className = 'original-text';
        origText.setAttribute('contenteditable', 'true');
        origText.setAttribute('spellcheck', 'false');
        origText.textContent = res.original || '無內容';

        // 實作 Ctrl + Enter 自動跳轉並聚焦下一個對話文字框
        origText.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && e.ctrlKey) {
                e.preventDefault();
                const allOrigs = [...containerEl.querySelectorAll('.original-text')];
                const currentIdx = allOrigs.indexOf(origText);
                if (currentIdx !== -1 && currentIdx + 1 < allOrigs.length) {
                    const nextOrig = allOrigs[currentIdx + 1];
                    nextOrig.focus();

                    const range = document.createRange();
                    range.selectNodeContents(nextOrig);
                    const selection = window.getSelection();
                    selection.removeAllRanges();
                    selection.addRange(range);
                } else {
                    origText.blur();
                }
            }
        });

        contentDiv.appendChild(transText);
        contentDiv.appendChild(origText);
        const btnGroup = document.createElement('div');
        btnGroup.className = 'dialogue-btn-group';
        btnGroup.innerHTML = `
            <button class="dialogue-icon-btn copy-trans" title="複製譯文"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>
            <button class="dialogue-icon-btn save-glossary" title="新增至語彙庫"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/><path d="M8 7h6M8 11h8"/></svg></button>
            <button class="dialogue-icon-btn retranslate-item" title="重新翻譯 (文字重譯)"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
            <button class="dialogue-icon-btn copy-orig" title="複製原文"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>
        `;
        itemDiv.appendChild(contentDiv);
        itemDiv.appendChild(btnGroup);
        containerEl.appendChild(itemDiv);
        itemDiv.addEventListener('dragstart', (e) => { itemDiv.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
        itemDiv.addEventListener('dragend', () => { itemDiv.classList.remove('dragging'); });
        itemDiv.addEventListener('dragover', (e) => {
            e.preventDefault();
            const draggingItem = containerEl.querySelector('.dragging');
            if (!draggingItem) return;
            const items = [...containerEl.querySelectorAll('.dialogue-item:not(.dragging)')];
            const nextItem = items.find(sibling => {
                const rect = sibling.getBoundingClientRect();
                const offset = e.clientY - rect.top - rect.height / 2;
                return offset < 0;
            });
            if (nextItem) containerEl.insertBefore(draggingItem, nextItem);
            else containerEl.appendChild(draggingItem);
        });
        btnGroup.querySelector('.copy-trans').onclick = () => { navigator.clipboard.writeText(transText.innerText); };
        btnGroup.querySelector('.copy-orig').onclick = () => { navigator.clipboard.writeText(origText.innerText); };
        btnGroup.querySelector('.save-glossary').onclick = () => {
            if (typeof showGlossaryModal === 'function') {
                showGlossaryModal(origText.innerText.trim(), transText.innerText.trim());
            }
        };
        btnGroup.querySelector('.retranslate-item').onclick = () => {
            const newText = origText.innerText.trim();
            if (!newText) return;
            const { sourceTabId = null, activeMangaKey = null } = getContext ? getContext() : {};
            const originalOldText = transText.textContent;
            transText.innerHTML = '<span class="mt-loading-text" style="font-size:12px">正在翻譯...</span>';
            chrome.runtime.sendMessage({
                action: "retranslateText",
                text: newText,
                mangaKey: activeMangaKey,
                tabId: sourceTabId,
                pageIndex: item?.pageIndex,
                lineIndex
            }, (response) => {
                if (response && response.results && response.results.length > 0) {
                    const cleaned = sanitizeTranslationText(response.results[0].translation);
                    transText.textContent = cleaned;
                    res.original = newText;
                    res.translation = cleaned;
                } else {
                    alert("重譯失敗: " + (response?.error || 'Unknown'));
                    transText.textContent = originalOldText;
                }
            });
        };
    });

    // 若行動端抽屜處於開啟狀態且更新的正是當前卡片，即時動態同步抽屜內容
    try {
        const card = containerEl.closest('.result-card');
        const drawer = document.getElementById('mt-mobile-drawer');
        if (card && drawer && drawer.classList.contains('is-open') && typeof window._syncCardToDrawer === 'function') {
            window._syncCardToDrawer(card);
        }
    } catch (_) {}
}

/**
 * 建立錯誤卡片重試成功後的操作按鈕群 (重新翻譯自原圖 / 重譯文字)
 * @param {Object} item
 * @param {HTMLElement} dialoguesContainer
 * @param {Object} [deps]
 * @returns {HTMLDivElement}
 */
export function createSuccessActionGroup(item, dialoguesContainer, deps = {}) {
    const { getContext } = deps;
    const actionGroup = document.createElement('div');
    actionGroup.className = 'action-btn-group';
    const visionBtn = document.createElement('button');
    visionBtn.className = 'btn-retranslate-vision';
    visionBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16"/></svg> 重新翻譯自原圖`;
    visionBtn.addEventListener('click', () => {
        const { sourceTabId = null, activeMangaKey = null } = getContext ? getContext() : {};
        visionBtn.disabled = true;
        const oldHtml = visionBtn.innerHTML;
        visionBtn.textContent = '辨識中...';
        const loader = document.createElement('div');
        loader.className = 'error-message';
        loader.textContent = '正在重新進行視覺辨識與翻譯...';
        actionGroup.appendChild(loader);
        chrome.runtime.sendMessage({
            action: "retranslateImage",
            url: item.retryUrl || item.image,
            pageIndex: item.pageIndex,
            tabId: sourceTabId,
            mangaKey: activeMangaKey
        }, (response) => {
            loader.remove();
            visionBtn.disabled = false;
            visionBtn.innerHTML = oldHtml;
            if (response && response.results) {
                item.results = response.results;
                renderDialogueItems(dialoguesContainer, item.results, item, deps);
            } else {
                alert('重新翻譯失敗: ' + (response?.error || '未知錯誤'));
            }
        });
    });
    const textBtn = document.createElement('button');
    textBtn.className = 'btn-retranslate-text';
    textBtn.title = '修改原文後點此重譯文字';
    textBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg> 重譯文字`;
    textBtn.addEventListener('click', () => {
        const originalTexts = Array.from(dialoguesContainer.querySelectorAll('.original-text')).map(el => el.innerText.trim());
        const combinedText = originalTexts.join('\n\n');
        if (!combinedText) return;
        const { sourceTabId = null, activeMangaKey = null } = getContext ? getContext() : {};
        textBtn.disabled = true;
        const oldHtml = textBtn.innerHTML;
        textBtn.textContent = '翻譯中...';
        chrome.runtime.sendMessage({
            action: "retranslateText",
            text: combinedText,
            mangaKey: activeMangaKey,
            tabId: sourceTabId,
            pageIndex: item?.pageIndex
        }, (response) => {
            textBtn.disabled = false;
            textBtn.innerHTML = oldHtml;
            if (response && response.results) {
                const newResults = response.results;
                const transElements = dialoguesContainer.querySelectorAll('.translated-text');

                // 逐行填回，避免越界，並同步更新本地 item.results
                transElements.forEach((el, i) => {
                    if (newResults[i]) {
                        const cleaned = sanitizeTranslationText(newResults[i].translation);
                        el.textContent = cleaned;
                        if (Array.isArray(item?.results) && item.results[i]) {
                            item.results[i].original = originalTexts[i] || item.results[i].original;
                            item.results[i].translation = cleaned;
                        }
                    }
                });
            } else {
                alert('重譯失敗: ' + (response?.error || '未知錯誤'));
            }
        });
    });
    actionGroup.appendChild(visionBtn);
    actionGroup.appendChild(textBtn);
    return actionGroup;
}

/**
 * 統計頁面內失敗卡片數量，顯示或隱藏「重試所有失敗圖片」按鈕
 * @param {HTMLElement|null} [containerEl]
 */
export function updateRetryAllBtn(containerEl = document.getElementById('results-container')) {
    if (!containerEl) return;
    const failedCards = containerEl.querySelectorAll('.result-card.is-error');
    const count = failedCards.length;
    const retryContainer = document.getElementById('retry-all-container');
    const countEl = document.getElementById('retry-failed-count');
    if (!retryContainer || !countEl) return;

    if (count > 0) {
        countEl.textContent = count;
        retryContainer.style.display = 'flex';
    } else {
        retryContainer.style.display = 'none';
    }
}

/**
 * 綁定「重試所有失敗圖片」按鈕事件
 * @param {HTMLElement} containerEl
 * @param {Function} getContext - 回傳 { sourceTabId, activeMangaKey } 的函式
 */
export function initRetryAllFailedButton(containerEl, getContext) {
    const retryBtn = document.getElementById('btn-retry-all-failed');
    if (!retryBtn) return;

    retryBtn.addEventListener('mouseenter', () => {
        retryBtn.style.transform = 'scale(1.04)';
        retryBtn.style.boxShadow = '0 6px 20px rgba(249,115,22,0.55)';
    });
    retryBtn.addEventListener('mouseleave', () => {
        retryBtn.style.transform = 'scale(1)';
        retryBtn.style.boxShadow = '0 4px 14px rgba(249,115,22,0.4)';
    });

    retryBtn.addEventListener('click', () => {
        // 收集所有失敗卡片的 data-retry-url
        const failedCards = containerEl.querySelectorAll('.result-card.is-error[data-retry-url]');
        const entries = Array.from(failedCards)
            .map(card => {
                const rawUrl = card.dataset.retryUrl || '';
                const pageIndex = Number(card.dataset.pageIndex);
                return {
                    rawUrl,
                    image: toLightweightRetryImageRef(rawUrl),
                    pageIndex
                };
            })
            .filter(item => item.rawUrl && Number.isInteger(item.pageIndex) && item.pageIndex > 0);

        if (entries.length === 0) return;

        const images = entries.map(item => item.image);
        const retryPageIndices = entries.map(item => item.pageIndex);

        if (!confirm(`確定要重新批次翻譯 ${images.length} 張失敗圖片嗎？`)) return;

        // 隱藏按鈕，顯示翻譯中 overlay
        const retryContainer = document.getElementById('retry-all-container');
        if (retryContainer) retryContainer.style.display = 'none';
        const overlay = document.getElementById('loading-overlay');
        if (overlay) overlay.classList.remove('hidden');
        document.getElementById('progress-text').innerText = `正在重試 ${images.length} 張失敗圖片...`;

        const { sourceTabId = null, activeMangaKey = null } = getContext ? getContext() : {};
        chrome.runtime.sendMessage({
            action: 'RETRY_FAILED_BATCH',
            images: images,
            retryPageIndices: retryPageIndices,
            sourceTabId: sourceTabId ? parseInt(sourceTabId) : null,
            mangaKey: activeMangaKey,
            resultTabId: null // background 會用 sender.tab.id 自動填入
        }, (response) => {
            if (response?.status !== 'retrying') {
                alert('重試請求失敗：' + (response?.error || '未知錯誤'));
                if (overlay) overlay.classList.add('hidden');
                if (retryContainer) retryContainer.style.display = 'flex';
            }
        });
    });
}
