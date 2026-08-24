import { LOADING_GIF_FILENAME, RUNNING_ANIMS } from '../utils/constants.js';

let translatedData = [];
const container = document.getElementById('results-container');
let currentTheme = 'umamusume';
let sourceTabId = null;
let activeMangaKey = null;

// 譯文文字淨化工具：徹底清理 \n 與多餘換行，若整句被外層對話引號包裹則成對剝離，保留句內引號
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

// 解析 URL 取得來源分頁 ID
const urlParams = new URLSearchParams(window.location.search);
sourceTabId = parseInt(urlParams.get('tabId'));
if (isNaN(sourceTabId)) sourceTabId = null;

function applyTheme(theme) {
    document.body.classList.remove('theme-umamusume', 'theme-priconne');
    document.body.classList.add(`theme-${theme}`);
    currentTheme = theme;
}

// runningAnims 已移至 constants.js，此處直接使用全域 RUNNING_ANIMS

function getRandomAnimPath() {
    // 使用東方 Loading GIF
    return {
        type: 'image',
        url: chrome.runtime.getURL(LOADING_GIF_FILENAME)
    };
}

// ─── 字體大小縮放即時控制系統 ───
let currentFontScale = 100; // 70% ~ 160%

function applyFontScale(scale) {
    currentFontScale = Math.max(70, Math.min(160, scale));
    const zhSize = (17.5 * (currentFontScale / 100)).toFixed(1);
    const jaSize = (13 * (currentFontScale / 100)).toFixed(1);
    document.documentElement.style.setProperty('--zh-font-size', `${zhSize}px`);
    document.documentElement.style.setProperty('--ja-font-size', `${jaSize}px`);
    const indicator = document.getElementById('font-size-indicator');
    if (indicator) indicator.textContent = `${currentFontScale}%`;
    chrome.storage.local.set({ mt_font_scale: currentFontScale });
}

// ─── 4 大黃金字型即時切換系統 (宋體 / 圓體 / 源石黑體 / 楷體) ───
const FONT_MAP = {
    serif: 'var(--font-serif)',
    maru: 'var(--font-maru)',
    gensen: 'var(--font-gensen)',
    kai: 'var(--font-kai)'
};

function applyFontFamily(fontKey) {
    const targetFont = FONT_MAP[fontKey] || FONT_MAP.serif;
    document.documentElement.style.setProperty('--font-trans', targetFont);
    const selectEl = document.getElementById('font-family-select');
    if (selectEl && selectEl.value !== fontKey) {
        selectEl.value = fontKey;
    }
    chrome.storage.local.set({ mt_font_family: fontKey });
}

function initFontControls() {
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

// Initial load: Pull navigation links from background
document.addEventListener('DOMContentLoaded', () => {
    initFontControls();

    // 加載主題
    chrome.storage.local.get(['mt_theme'], (result) => {
        applyTheme(result.mt_theme || 'umamusume');
        
        // 注入東方 Loading GIF 到右下角的翻譯中膠囊
        const mainAnim = document.getElementById('main-loading-anim');
        if (mainAnim) mainAnim.src = chrome.runtime.getURL(LOADING_GIF_FILENAME);
    });

    // 主動傳入 sourceTabId 查詢元數據與導航資訊
    chrome.runtime.sendMessage({ action: "getResultMetadata", tabId: sourceTabId }, (response) => {
        if (response) {
            if (response.mangaKey) activeMangaKey = response.mangaKey;
            
            if (response.displayName) {
                const titleEl = document.getElementById('manga-title-display');
                if (titleEl) {
                    titleEl.textContent = response.displayName;
                    titleEl.title = response.displayName;
                }
            }

            if (response.navLinks) {
                updateNavUI(response.navLinks);
            } else {
                updateNavUI({});
            }

            // 查詢並顯示語彙庫詳細狀態
            if (activeMangaKey) {
                chrome.runtime.sendMessage({ action: "getGlossaryDetail", mangaKey: activeMangaKey }, (glossaryResp) => {
                    if (glossaryResp && glossaryResp.entry) {
                        const badge = document.getElementById('glossary-info-badge');
                        if (badge) {
                            badge.textContent = `冊 語彙庫 ${glossaryResp.entry.terms?.length || 0} 詞`;
                            badge.style.display = 'inline-flex';
                            badge.classList.add('show');
                        }
                    }
                });
            }
        } else {
            updateNavUI({});
        }
    });

    // 恢復重載前保存的翻譯資料 (用於行動版/電腦版切換)
    const savedDataStr = sessionStorage.getItem('mt_translated_data');
    if (savedDataStr) {
        try {
            const savedData = JSON.parse(savedDataStr);
            if (savedData && savedData.length > 0) {
                translatedData = savedData;
                
                if (sessionStorage.getItem('mt_translation_complete') === '1') {
                    document.getElementById('loading-overlay').classList.add('hidden');
                } else {
                    const progText = sessionStorage.getItem('mt_progress_text');
                    if (progText) document.getElementById('progress-text').innerText = progText;
                }
                
                savedData.forEach((item, idx) => {
                    const batchIdx = item.batchIndex !== undefined ? item.batchIndex : Math.floor(idx / 10);
                    const targetGrid = getOrCreateBatchSection(batchIdx);
                    const card = buildCard(item, idx);
                    targetGrid.appendChild(card);
                    if (window._bindMobileCard) window._bindMobileCard(card);
                });
                
                if (sessionStorage.getItem('mt_translation_complete') === '1') {
                    updateRetryAllBtn();
                }
            }
        } catch (e) {
            console.warn("Failed to restore translated data:", e);
        }
        sessionStorage.removeItem('mt_translated_data');
        sessionStorage.removeItem('mt_translation_complete');
        sessionStorage.removeItem('mt_progress_text');
    }

    // 掛載匯出功能
    document.getElementById('export-html-btn')?.addEventListener('click', saveAsHTML);
    document.getElementById('export-pdf-btn')?.addEventListener('click', () => window.print());

    // 【新增】切換模式功能 (三態：自動、行動、電腦)
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
            sessionStorage.setItem('mt_translated_data', JSON.stringify(translatedData));
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

    // 【新增】行動端頂部專屬「💻 電腦版」按鈕直接切換
    const mobileToggleDesktopBtn = document.getElementById('mobile-toggle-desktop-btn');
    if (mobileToggleDesktopBtn) {
        mobileToggleDesktopBtn.addEventListener('click', () => {
            sessionStorage.setItem('mt_translated_data', JSON.stringify(translatedData));
            const overlayHidden = document.getElementById('loading-overlay').classList.contains('hidden');
            sessionStorage.setItem('mt_translation_complete', overlayHidden ? '1' : '0');
            sessionStorage.setItem('mt_progress_text', document.getElementById('progress-text').innerText);

            const params = new URLSearchParams(window.location.search);
            params.set('desktop', '1');
            params.delete('mobile');
            window.location.search = params.toString();
        });
    }

    // [新增] 綁定中止翻譯按鈕
    const stopBtn = document.getElementById('btn-stop-translation');
    if (stopBtn) {
        stopBtn.addEventListener('click', () => {
            if (confirm("確定要中止目前的批次翻譯嗎？")) {
                chrome.runtime.sendMessage({ action: 'STOP_TRANSLATION' }, () => {
                    const overlay = document.getElementById('loading-overlay');
                    if (overlay) overlay.classList.add('hidden');
                    // 清除可能殘留的暫停狀態
                    chrome.runtime.sendMessage({ action: 'toggleBatchPause' }).catch(() => {});
                });
            }
        });
    }

    // 綁定「批次重翻」按鈕
    const retranslateAllBtn = document.getElementById('retranslate-all-btn');
    if (retranslateAllBtn) {
        retranslateAllBtn.addEventListener('click', () => {
            const images = translatedData
                .map(item => item.retryUrl || item.image)
                .filter(url => url);

            if (images.length === 0) {
                alert('目前沒有已載入的圖片可以重新翻譯！');
                return;
            }

            if (!confirm(`確定要重新翻譯整本漫畫（共 ${images.length} 頁）嗎？這將會清除當前所有翻譯結果並從第 1 頁重頭開始翻譯。`)) {
                return;
            }

            // 隱藏可能顯示的重試失敗按鈕，並開啟翻譯遮罩
            const retryContainer = document.getElementById('retry-all-container');
            if (retryContainer) retryContainer.style.display = 'none';
            const overlay = document.getElementById('loading-overlay');
            if (overlay) overlay.classList.remove('hidden');
            document.getElementById('progress-text').innerText = `正在準備重新翻譯 ${images.length} 張圖片...`;

            chrome.runtime.sendMessage({
                action: 'RETRANSLATE_ALL_BATCH',
                images: images,
                sourceTabId: sourceTabId,
                mangaKey: activeMangaKey
            }, (response) => {
                if (response?.status !== 'retrying') {
                    alert('重新翻譯請求失敗：' + (response?.error || '未知錯誤'));
                    if (overlay) overlay.classList.add('hidden');
                }
            });
        });
    }

    // 綁定「重翻當前批次」按鈕
    const retranslateBatchBtn = document.getElementById('retranslate-batch-btn');
    if (retranslateBatchBtn) {
        retranslateBatchBtn.addEventListener('click', () => {
            const images = translatedData
                .map(item => item.retryUrl || item.image)
                .filter(url => url);

            if (images.length === 0) {
                alert('目前沒有已載入的批次圖片可以重翻！');
                return;
            }

            if (!confirm(`確定要重新翻譯當前這批圖片（共 ${images.length} 張）嗎？`)) {
                return;
            }

            const overlay = document.getElementById('loading-overlay');
            if (overlay) overlay.classList.remove('hidden');
            document.getElementById('progress-text').innerText = `正在重翻當前批次 (${images.length} 張)...`;

            chrome.runtime.sendMessage({
                action: 'RETRY_FAILED_BATCH',
                images: images,
                sourceTabId: sourceTabId,
                mangaKey: activeMangaKey
            }, (response) => {
                if (response?.status !== 'retrying') {
                    alert('批次重翻請求失敗：' + (response?.error || '未知錯誤'));
                    if (overlay) overlay.classList.add('hidden');
                }
            });
        });
    }

    // 通知背景結果分頁已載入完成
    chrome.runtime.sendMessage({ action: "resultPageReady" }).catch(() => {});

    // 初始化語彙庫 Modal
    setupGlossaryModal();

    // ── 實作鍵盤快捷鍵校對與卡片切換功能 ──
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
            focusCard(cards[currentFocusedCardIndex]);
        } else if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') {
            e.preventDefault();
            currentFocusedCardIndex = Math.max(currentFocusedCardIndex - 1, 0);
            focusCard(cards[currentFocusedCardIndex]);
        }
    });

    function focusCard(cardEl) {
        if (!cardEl) return;
        container.querySelectorAll('.result-card').forEach(el => el.classList.remove('is-focused'));
        cardEl.classList.add('is-focused');
        cardEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
});

function setupGlossaryModal() {
    const modal = document.getElementById('mt-glossary-modal');
    if (!modal) return;

    const closeBtn = modal.querySelector('.mt-modal-close');
    const cancelBtn = document.getElementById('mt-glossary-cancel');
    const saveBtn = document.getElementById('mt-glossary-save');
    const oriInput = document.getElementById('mt-glossary-ori');
    const transInput = document.getElementById('mt-glossary-trans');
    const backdrop = modal.querySelector('.mt-modal-backdrop');
    const badge = document.getElementById('glossary-info-badge');

    // 綁定頂部語彙庫徽章點擊開啟彈窗
    if (badge) {
        badge.onclick = () => {
            showGlossaryModal('', '');
        };
    }

    const closeModal = () => {
        modal.classList.remove('show');
        setTimeout(() => {
            oriInput.value = '';
            transInput.value = '';
            saveBtn.disabled = false;
            saveBtn.textContent = '儲存條目';
        }, 300);
    };

    closeBtn.onclick = closeModal;
    cancelBtn.onclick = closeModal;
    backdrop.onclick = closeModal;

    saveBtn.onclick = async () => {
        const ori = oriInput.value.trim();
        const trans = transInput.value.trim();

        if (!ori || !trans) {
            alert('請填寫原文與譯文');
            return;
        }

        if (!activeMangaKey) {
            alert('無法識別作品，無法儲存至語彙庫');
            return;
        }

        saveBtn.disabled = true;
        saveBtn.textContent = '儲存中...';

        let displayName = '';
        try {
            const detailResp = await new Promise(resolve =>
                chrome.runtime.sendMessage({ action: 'getGlossaryDetail', mangaKey: activeMangaKey }, resolve)
            );
            displayName = detailResp?.entry?.displayName || activeMangaKey;
        } catch (_) { displayName = activeMangaKey; }

        chrome.runtime.sendMessage({
            action: 'saveGlossaryTerm',
            mangaKey: activeMangaKey,
            displayName: displayName,
            ori: ori,
            trans: trans
        }, (response) => {
            saveBtn.disabled = false;
            saveBtn.textContent = '儲存條目';

            if (response && response.success) {
                // 清空輸入框並即時刷新彈窗清單與頂部 Badge
                oriInput.value = '';
                transInput.value = '';
                loadGlossaryTermsIntoModal();
                if (badge && response.count !== undefined) {
                    badge.textContent = `冊 語彙庫 ${response.count} 詞`;
                    badge.style.display = 'inline-flex';
                    badge.classList.add('show');
                }
            } else {
                alert('儲存失敗: ' + (response?.error || '未知錯誤'));
            }
        });
    };
}

// 載入當前作品的全部收錄詞彙至彈窗清單中
function loadGlossaryTermsIntoModal() {
    const listEl = document.getElementById('mt-glossary-terms-list');
    const countEl = document.getElementById('mt-glossary-terms-count');
    const badge = document.getElementById('glossary-info-badge');
    const oriInput = document.getElementById('mt-glossary-ori');
    const transInput = document.getElementById('mt-glossary-trans');

    if (!listEl || !activeMangaKey) {
        if (listEl) listEl.innerHTML = '<div class="mt-glossary-empty-hint">尚未辨識到作品或無詞彙</div>';
        return;
    }

    chrome.runtime.sendMessage({ action: "getGlossaryDetail", mangaKey: activeMangaKey }, (res) => {
        const terms = res?.entry?.terms || [];
        if (countEl) countEl.textContent = `${terms.length} 詞`;
        if (badge) {
            badge.textContent = `冊 語彙庫 ${terms.length} 詞`;
            badge.style.display = 'inline-flex';
            badge.classList.add('show');
        }

        if (terms.length === 0) {
            listEl.innerHTML = '<div class="mt-glossary-empty-hint">尚未收錄專屬術語，可於上方手動新增</div>';
            return;
        }

        listEl.innerHTML = '';
        terms.forEach((item) => {
            const row = document.createElement('div');
            row.className = 'mt-glossary-term-item';

            const info = document.createElement('div');
            info.className = 'mt-term-info';

            const oriSpan = document.createElement('span');
            oriSpan.className = 'mt-term-ori';
            oriSpan.textContent = item.ori;
            oriSpan.title = item.ori;

            const arrowSpan = document.createElement('span');
            arrowSpan.className = 'mt-term-arrow';
            arrowSpan.textContent = '➔';

            const transSpan = document.createElement('span');
            transSpan.className = 'mt-term-trans';
            transSpan.textContent = item.trans;
            transSpan.title = item.trans;

            info.appendChild(oriSpan);
            info.appendChild(arrowSpan);
            info.appendChild(transSpan);

            const actions = document.createElement('div');
            actions.className = 'mt-term-actions';

            // 編輯按鈕：直接帶入上方表單，一鍵覆蓋
            const editBtn = document.createElement('button');
            editBtn.className = 'mt-term-btn mt-term-btn-edit';
            editBtn.textContent = '編輯';
            editBtn.onclick = () => {
                if (oriInput) oriInput.value = item.ori;
                if (transInput) {
                    transInput.value = item.trans;
                    transInput.focus();
                }
            };

            // 刪除按鈕
            const delBtn = document.createElement('button');
            delBtn.className = 'mt-term-btn mt-term-btn-del';
            delBtn.textContent = '刪除';
            delBtn.onclick = () => {
                if (!confirm(`確定要從語彙庫中刪除「${item.ori} ➔ ${item.trans}」嗎？`)) return;
                chrome.runtime.sendMessage({
                    action: 'deleteGlossaryTerm',
                    mangaKey: activeMangaKey,
                    ori: item.ori
                }, (delRes) => {
                    if (delRes && delRes.success) {
                        loadGlossaryTermsIntoModal();
                    } else {
                        alert('刪除失敗: ' + (delRes?.error || '未知錯誤'));
                    }
                });
            };

            actions.appendChild(editBtn);
            actions.appendChild(delBtn);

            row.appendChild(info);
            row.appendChild(actions);
            listEl.appendChild(row);
        });
    });
}

function showGlossaryModal(ori, trans) {
    const modal = document.getElementById('mt-glossary-modal');
    if (!modal) return;

    const oriInput = document.getElementById('mt-glossary-ori');
    const transInput = document.getElementById('mt-glossary-trans');

    oriInput.value = ori || '';
    transInput.value = trans || '';

    // 即時加載當前作品詞彙清單
    loadGlossaryTermsIntoModal();

    modal.classList.add('show');
    if (trans) {
        transInput.focus();
    } else {
        oriInput.focus();
    }
}

async function saveAsHTML() {
    const btn = document.getElementById('export-html-btn');
    const originalText = btn.innerText;
    btn.innerText = '正在進行內容淨化...';
    btn.disabled = true;

    try {
        // 修正：動態獲取當前頁面所有已加載的 CSS 樣式，不再寫死 result.css 檔名
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
        const bodyClone = docClone.querySelector('body');
        
        // 移除失效的外部 CSS 連結，改用內嵌樣式
        docClone.querySelectorAll('link[rel="stylesheet"]').forEach(el => el.remove());
        if (inlinedCss) {
            const styleTag = document.createElement('style');
            styleTag.textContent = inlinedCss;
            docClone.querySelector('head').appendChild(styleTag);
        }

        // 1. 不再強制加入 .is-reader-mode，以保留原有的主題精美卡片樣式與排版
        // 移除動態背景與過濾層，保留主體背景與卡片設計
        docClone.querySelector('.page-grain')?.remove();

        // 2. 徹底刪除非必要的互動元素（但保留頁數標籤 .card-page-badge 以維持設計質感）
        const selectorsToRemove = [
            '.result-header', 
            '.actions', 
            '.nav-footer', 
            '.loading-overlay',
            '.mt-drag-handle',
            '.dialogue-btn-group',
            '.action-btn-group',
            // '.card-page-badge', // 保留頁碼標籤 (例如 P.1) 以獲得更好的視覺效果
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

        // 3. 淨化編輯屬性
        docClone.querySelectorAll('[contenteditable]').forEach(el => {
            el.removeAttribute('contenteditable');
        });

        // 3b. 安全性防護：過濾 javascript: href，防止匯出 HTML 含有 XSS 連結
        docClone.querySelectorAll('a[href]').forEach(el => {
            if (/^javascript:/i.test(el.getAttribute('href'))) {
                el.removeAttribute('href');
            }
        });

        // 4. 將所有的 blob: 網址轉換為內嵌 Base64
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

function blobToDataURL(blobUrl) {
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

function isSafeUrl(url) {
    return typeof url === 'string' && /^https?:\/\//i.test(url);
}

function sendNavigateMessageWithRetry(payload, btns, label) {
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

function renderPretranslatedChapter(chapterData) {
    console.log('[SPA] 命中跨話預翻快取，正在進行原地無縫換話...', chapterData);
    
    // 1. 清空舊卡片資料與批次容器
    container.innerHTML = '';
    translatedData.length = 0;
    batchSections.clear();
    const batchMenu = document.getElementById('batch-dropdown-menu');
    if (batchMenu) batchMenu.innerHTML = '';

    // 2. 逐一渲染已預翻好的卡片
    const results = chapterData.results || [];
    results.forEach((item, idx) => {
        translatedData.push(item);
        const batchIdx = Math.floor(idx / 5);
        const targetGrid = getOrCreateBatchSection(batchIdx);
        const card = buildCard(item, idx);
        targetGrid.appendChild(card);
    });

    updateBatchDropdownMenu();

    // 3. 更新進度與導航 UI
    const progressEl = document.getElementById('progress-text');
    if (progressEl) progressEl.textContent = `✅ 全話 ${results.length} 頁已就緒 (預翻秒開)`;
    
    if (chapterData.navLinks) {
        updateNavUI(chapterData.navLinks);
    }

    // 4. 滾動條平滑移回最頂部
    window.scrollTo({ top: 0, behavior: 'smooth' });

    // 5. 恢復按鈕狀態
    resetNavButtons();
}

function updateNavUI(navLinks) {
    const { prev, next, currentChapter, chapterList } = navLinks || {};
    const navBar = document.getElementById('chapter-nav-bar');
    const prevBtn = document.getElementById('nav-prev-chapter-btn');
    const nextBtn = document.getElementById('nav-next-chapter-btn');
    const currentText = document.getElementById('current-chapter-text');
    const chapterMenu = document.getElementById('chapter-dropdown-menu');
    const footer = document.getElementById('nav-footer');
    const footerPrevBtn = document.getElementById('prev-btn');
    const footerNextBtn = document.getElementById('next-btn');

    const safePrev = isSafeUrl(prev) ? prev : null;
    const safeNext = isSafeUrl(next) ? next : null;

    // 頂部導航欄與底部導航欄顯示控制
    if (navBar) navBar.style.display = 'inline-flex';
    if (footer) footer.style.display = 'flex';

    // 上一話動作處理函式
    const handlePrevNavigation = () => {
        if (!safePrev) return;
        sendNavigateMessageWithRetry({
            url: safePrev,
            tabId: sourceTabId,
            mangaKey: activeMangaKey,
            mobile: urlParams.get('mobile') === '1'
        }, [prevBtn, footerPrevBtn], '上一話');
    };

    // 下一話動作處理函式 (優先消費已預翻成果，實現 0ms SPA 原地秒開)
    const handleNextNavigation = () => {
        if (!safeNext) return;

        [nextBtn, footerNextBtn].filter(Boolean).forEach(b => {
            b.disabled = true;
            b.classList.add('is-navigating');
            b.innerHTML = `正在進入下一話...`;
        });

        // 嘗試向 Background 請求預翻好的成果
        chrome.runtime.sendMessage({
            action: 'CONSUME_PRETRANSLATED_CHAPTER',
            payload: {
                nextUrl: safeNext,
                sourceTabId,
                resultTabId: null
            }
        }, (response) => {
            if (response && response.success && response.data) {
                renderPretranslatedChapter(response.data);
            } else {
                // 快取未命中：退回生肉分頁跳轉
                sendNavigateMessageWithRetry({
                    url: safeNext,
                    tabId: sourceTabId,
                    mangaKey: activeMangaKey,
                    mobile: urlParams.get('mobile') === '1'
                }, [nextBtn, footerNextBtn], '下一話');
            }
        });
    };

    // 頂部中央：上一話
    if (prevBtn) {
        if (safePrev) {
            prevBtn.style.display = 'inline-flex';
            prevBtn.style.opacity = '1';
            prevBtn.disabled = false;
            prevBtn.onclick = handlePrevNavigation;
            prevBtn.title = safePrev;
        } else {
            prevBtn.style.opacity = '0.4';
            prevBtn.disabled = true;
        }
    }

    // 頂部中央：下一話
    if (nextBtn) {
        if (safeNext) {
            nextBtn.style.display = 'inline-flex';
            nextBtn.style.opacity = '1';
            nextBtn.disabled = false;
            nextBtn.onclick = handleNextNavigation;
            nextBtn.title = safeNext;
        } else {
            nextBtn.style.opacity = '0.4';
            nextBtn.disabled = true;
        }
    }

    // 底部導航：直接綁定相同動作，不走脆性的 DOM 代理點擊
    if (footerPrevBtn) {
        if (safePrev) {
            footerPrevBtn.style.display = 'inline-flex';
            footerPrevBtn.disabled = false;
            footerPrevBtn.onclick = handlePrevNavigation;
            footerPrevBtn.title = safePrev;
        } else {
            footerPrevBtn.style.display = 'none';
        }
    }

    if (footerNextBtn) {
        if (safeNext) {
            footerNextBtn.style.display = 'inline-flex';
            footerNextBtn.disabled = false;
            footerNextBtn.onclick = handleNextNavigation;
            footerNextBtn.title = safeNext;
        } else {
            footerNextBtn.style.display = 'none';
        }
    }

    // 檢查下一話預翻狀態並更新徽章
    const pretransBadge = document.getElementById('nav-pretranslate-badge');
    if (safeNext && pretransBadge) {
        const checkBadgeStatus = () => {
            chrome.runtime.sendMessage({
                action: 'CHECK_PRETRANSLATED_CHAPTER',
                payload: { nextUrl: safeNext }
            }, (resp) => {
                if (resp && resp.exists) {
                    if (resp.isDone) {
                        pretransBadge.style.display = 'inline-block';
                        pretransBadge.textContent = '⚡已預翻';
                        pretransBadge.style.background = '#4CAF50';
                        if (footerNextBtn) footerNextBtn.title = `${safeNext} (已預翻完成，點擊秒開)`;
                    } else if (resp.inProgress) {
                        pretransBadge.style.display = 'inline-block';
                        pretransBadge.textContent = `⏳預翻中 (${resp.count}/${resp.total || '?'})`;
                        pretransBadge.style.background = '#ff9800';
                        setTimeout(checkBadgeStatus, 3000);
                    }
                } else {
                    pretransBadge.style.display = 'none';
                }
            });
        };
        checkBadgeStatus();
    } else if (pretransBadge) {
        pretransBadge.style.display = 'none';
    }
}

let placeholdersCreated = false;

// 監聽主題變更
chrome.storage.onChanged.addListener((changes) => {
    if (changes.mt_theme) {
        applyTheme(changes.mt_theme.newValue);
    }
});

function refreshGlossaryStatus() {
    if (!activeMangaKey) return;
    chrome.runtime.sendMessage({ action: "getGlossaryDetail", mangaKey: activeMangaKey }, (glossaryResp) => {
        if (glossaryResp && glossaryResp.entry) {
            const badge = document.getElementById('glossary-info-badge');
            if (badge) {
                badge.textContent = `已套用語彙庫: ${glossaryResp.entry.displayName} (${glossaryResp.entry.terms?.length || 0} 詞)`;
                badge.classList.add('show');
                
                // 簡單的更新動畫
                badge.style.transform = 'scale(1.1)';
                setTimeout(() => { badge.style.transform = 'scale(1)'; }, 200);
            }
        }
    });
}

function getBatchImagesByIndex(batchIndex, gridEl) {
    // 方案 1：直接從 DOM 元素提取 data-retry-url 或 img src
    const cards = gridEl ? gridEl.querySelectorAll('.result-card') : [];
    let images = Array.from(cards).map(card => {
        return card.dataset.retryUrl || card.querySelector('img')?.src || '';
    }).filter(url => url && !url.includes('data:image/svg'));

    // 方案 2：若 DOM 無資料，由 translatedData 快取陣列依批次切片 (預設每批 10 張)
    if (images.length === 0 && translatedData.length > 0) {
        // 先嘗試用指定 batchIndex 過濾
        const matched = translatedData.filter(item => item.batchIndex === batchIndex);
        if (matched.length > 0) {
            images = matched.map(item => item.retryUrl || item.image).filter(Boolean);
        } else {
            // 切片備援 (每批 10 張)
            const sliceSize = 10;
            const start = batchIndex * sliceSize;
            const sliced = translatedData.slice(start, start + sliceSize);
            images = sliced.map(item => item.retryUrl || item.image).filter(Boolean);
        }
    }

    return images;
}

function updateBatchDropdownMenu() {
    const menu = document.getElementById('batch-dropdown-menu');
    if (!menu) return;

    const sections = [...container.querySelectorAll('.mt-batch-section')];
    if (sections.length === 0) {
        menu.innerHTML = `<div style="padding: 10px 16px; font-size: 13px; color: #666;">目前尚無可重翻的批次</div>`;
        return;
    }

    menu.innerHTML = '';
    sections.forEach((sec) => {
        const bIdx = parseInt(sec.dataset.batch);
        const grid = sec.querySelector('.mt-batch-grid');
        const images = getBatchImagesByIndex(bIdx, grid);
        const countDisplay = images.length > 0 ? `${images.length} 張圖` : `點擊進行批次重翻`;

        const item = document.createElement('div');
        item.style.cssText = `
            padding: 10px 16px;
            font-size: 13px;
            font-weight: 700;
            color: #212529;
            cursor: pointer;
            display: flex;
            justify-content: space-between;
            align-items: center;
            transition: background 0.15s;
        `;
        item.innerHTML = `
            <span>📦 第 ${bIdx + 1} 批次</span>
            <span style="font-size: 11px; color: #8d80f1; background: #f0edff; padding: 2px 8px; border-radius: 12px;">${countDisplay}</span>
        `;
        item.onmouseover = () => item.style.background = '#f4f2ff';
        item.onmouseout = () => item.style.background = 'transparent';
        item.onclick = () => {
            menu.style.display = 'none';
            sec.scrollIntoView({ behavior: 'smooth', block: 'center' });
            const btn = sec.querySelector('.btn-retranslate-single-batch');
            if (btn) btn.click();
        };
        menu.appendChild(item);
    });
}

// 頂部下拉選單按鈕開關 (批次選單、章節選單、更多選單)
document.addEventListener('DOMContentLoaded', () => {
    const dropBtn = document.getElementById('retranslate-batch-dropdown-btn');
    const menu = document.getElementById('batch-dropdown-menu');
    if (dropBtn && menu) {
        dropBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const isVisible = menu.style.display === 'block';
            document.querySelectorAll('.dropdown-menu').forEach(m => m.style.display = 'none');
            if (!isVisible) {
                updateBatchDropdownMenu();
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
});

function getOrCreateBatchSection(batchIndex) {
    if (batchIndex === undefined || batchIndex === null || isNaN(batchIndex)) batchIndex = 0;
    let section = container.querySelector(`.mt-batch-section[data-batch="${batchIndex}"]`);
    if (!section) {
        section = document.createElement('div');
        section.className = 'mt-batch-section';
        section.dataset.batch = batchIndex;
        
        const header = document.createElement('div');
        header.className = 'mt-batch-header';
        
        header.innerHTML = `
            <div class="mt-batch-title">
                <span>📦 批次 #${batchIndex + 1}</span>
            </div>
            <button class="btn-export accent btn-retranslate-single-batch" data-batch="${batchIndex}">
                ⚡ 重翻第 ${batchIndex + 1} 批次
            </button>
        `;
        
        const grid = document.createElement('div');
        grid.className = 'mt-batch-grid';
        
        section.appendChild(header);
        section.appendChild(grid);
        
        // 綁定「⚡ 重翻第 N 批次」點擊事件
        header.querySelector('.btn-retranslate-single-batch').onclick = () => {
            const batchImages = getBatchImagesByIndex(batchIndex, grid);
            
            if (batchImages.length === 0) {
                alert(`批次 #${batchIndex + 1} 無有效圖片可重翻（可能尚未開始載入或圖片連結失效）`);
                return;
            }
            
            if (!confirm(`確定要重新翻譯 批次 #${batchIndex + 1}（共 ${batchImages.length} 張圖片）嗎？`)) {
                return;
            }

            const overlay = document.getElementById('loading-overlay');
            if (overlay) overlay.classList.remove('hidden');
            document.getElementById('progress-text').innerText = `正在重翻第 ${batchIndex + 1} 批次 (${batchImages.length} 張)...`;

            chrome.runtime.sendMessage({
                action: 'RETRY_FAILED_BATCH',
                images: batchImages,
                targetBatchIndex: batchIndex,
                sourceTabId: sourceTabId,
                mangaKey: activeMangaKey
            }, (response) => {
                if (response?.status !== 'retrying') {
                    alert('批次重翻失敗: ' + (response?.error || '未知錯誤'));
                    if (overlay) overlay.classList.add('hidden');
                }
            });
        };

        // 按批次順序插入 container
        const sections = [...container.querySelectorAll('.mt-batch-section')];
        const nextSection = sections.find(sec => parseInt(sec.dataset.batch) > batchIndex);
        if (nextSection) {
            container.insertBefore(section, nextSection);
        } else {
            container.appendChild(section);
        }

        updateBatchDropdownMenu();
    }
    return section.querySelector('.mt-batch-grid');
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "appendResult") {
        const imgUrl = request.data?.image || '';
        const batchIdx = request.data?.batchIndex !== undefined ? request.data.batchIndex : 0;
        const targetGrid = getOrCreateBatchSection(batchIdx);

        // 【改動3】整批重試時：若卡片已存在（依 data-retry-url 定位），直接覆蓋
        const existingErrorCard = imgUrl
            ? container.querySelector(`.result-card[data-retry-url="${CSS.escape(imgUrl)}"]`)
            : null;

        let realCard;
        if (existingErrorCard) {
            // 覆蓋模式：原地替換舊卡片
            const existingIndex = existingErrorCard.dataset.index;
            realCard = buildCard(request.data, parseInt(existingIndex) || 0);
            existingErrorCard.replaceWith(realCard);
        } else {
            translatedData.push(request.data);
            const idx = translatedData.length - 1;
            const placeholder = container.querySelector(`.skeleton-card[data-index="${idx}"]`);
            if (placeholder) {
                realCard = buildCard(request.data, idx);
                placeholder.replaceWith(realCard);
            } else {
                realCard = buildCard(request.data, idx);
                targetGrid.appendChild(realCard);
            }
        }
        // 關鍵保險：確保 realCard 必須屬於對應的 targetGrid 批次容器
        if (realCard && realCard.parentElement !== targetGrid) {
            targetGrid.appendChild(realCard);
        }
        updateBatchDropdownMenu();

        // 行動端：綁定點擊事件
        if (window._bindMobileCard) window._bindMobileCard(realCard);
        sendResponse({status: "success"});
    } else if (request.action === "updateProgress") {
        const isNumeric = typeof request.current === 'number';
        document.getElementById('progress-text').innerText = isNumeric
            ? `${request.current} / ${request.total}`
            : String(request.current);
        if (isNumeric && !placeholdersCreated && request.total > 0) {
            createPlaceholders(request.total);
            placeholdersCreated = true;
        }
    } else if (request.action === "batchComplete") {
        document.getElementById('loading-overlay').classList.add('hidden');
        container.querySelectorAll('.skeleton-card').forEach(el => el.remove());
        resetNavButtons();
        updateRetryAllBtn(); // 【改動3】統計失敗張數，更新重試按鈕
    } else if (request.action === "setNavigation") {
        updateNavUI(request.navLinks);
    } else if (request.action === "clearResults") {
        translatedData = [];
        container.innerHTML = '';
        document.getElementById('loading-overlay').classList.remove('hidden');
        document.getElementById('progress-text').innerText = '正在跳轉並準備翻譯...';
        placeholdersCreated = false;
        window.scrollTo(0, 0);
    } else if (request.action === "reloadAndTranslate") {
        // 【對齊 v1.8.7】就地清空結果頁，準備接收新章節的翻譯
        translatedData = [];
        container.innerHTML = '';
        placeholdersCreated = false;
        window.scrollTo(0, 0);

        // 更新 sourceTabId（新章節的 tabId）
        if (request.sourceTabId) sourceTabId = request.sourceTabId;

        // 立即重置導航按鈕狀態 (移除 "正在跳轉至 下一話..." 載入字樣)
        resetNavButtons();
        if (request.navLinks) {
            updateNavUI(request.navLinks);
        }

        // 隱藏舊導航、開啟翻譯進度 overlay
        const footer = document.getElementById('nav-footer');
        if (footer) footer.style.display = 'none';
        const overlay = document.getElementById('loading-overlay');
        if (overlay) overlay.classList.remove('hidden');
        document.getElementById('progress-text').innerText = '正在跳轉並準備翻譯...';

        // 更新語彙庫 key
        if (request.mangaKey) activeMangaKey = request.mangaKey;

        // 告訴 Background 確認收到
        sendResponse({ ready: true });
        return false;
    }
    return false;
});

function createPlaceholders(total) {
    const batchSize = 10;
    for (let i = 0; i < total; i++) {
        const batchIdx = Math.floor(i / batchSize);
        const targetGrid = getOrCreateBatchSection(batchIdx);

        const card = document.createElement('div');
        card.className = 'result-card skeleton-card';
        card.dataset.index = i;
        
        // 使用東方少女祈禱中 GIF 作為等待翻譯的 Skeleton 佔位動畫
        const animHtml = `
            <div class="skeleton-anim">
                <img src="${chrome.runtime.getURL(LOADING_GIF_FILENAME)}" style="width:70px; height:auto; opacity:0.6;" alt="少女祈禱中">
            </div>
        `;

        card.innerHTML = `
            <div class="card-image-wrapper skeleton-image">
                <span class="card-page-badge">P.${i + 1}</span>
                ${animHtml}
                <div class="skeleton-shimmer"></div>
            </div>
            <div class="card-text-wrapper">
                <div class="text-group">
                    <div class="skeleton-line skeleton-line--label"></div>
                    <div class="skeleton-line skeleton-line--long"></div>
                    <div class="skeleton-line skeleton-line--medium"></div>
                </div>
                <div class="text-group">
                    <div class="skeleton-line skeleton-line--label"></div>
                    <div class="skeleton-line skeleton-line--long"></div>
                </div>
            </div>
        `;
        targetGrid.appendChild(card);
    }
}

function buildCard(item, index) {
    const card = document.createElement('div');
    card.className = 'result-card';
    // 【改動3】記錄圖片 URL 以便整批重試時定位
    if (item.image) card.dataset.retryUrl = item.image;
    card.dataset.index = index;

    const imageWrapper = document.createElement('div');
    imageWrapper.className = 'card-image-wrapper';
    const badge = document.createElement('span');
    badge.className = 'card-page-badge';
    badge.textContent = `P.${index + 1}`;
    imageWrapper.appendChild(badge);

    if (item.usedModelName) {
        const modelBadge = document.createElement('span');
        modelBadge.className = 'card-model-badge';
        let displayName = item.usedModelName;
        if (item.usedModelName.toLowerCase().includes('gemini')) displayName = 'Gemini';
        if (item.usedModelName.toLowerCase().includes('gemma')) displayName = 'Gemma';
        modelBadge.textContent = displayName;
        imageWrapper.appendChild(modelBadge);
    }

    const img = document.createElement('img');
    img.setAttribute('src', item.image);
    img.setAttribute('alt', `Page ${index + 1}`);
    img.loading = 'lazy';
    img.decoding = 'async'; // 將圖片解碼移出 UI 主線程，避免百頁長條漫滑動掉幀
    imageWrapper.appendChild(img);
    card.appendChild(imageWrapper);

    const textWrapper = document.createElement('div');
    textWrapper.className = 'card-text-wrapper';

    // 翻譯失敗 / 觸發模型審查拒絕：顯示專屬警示與重試按鈕
    if (item.error) {
        const isProhibited = item.isProhibited || (typeof item.error === 'string' && (item.error.includes('SAFETY') || item.error.includes('BLOCKLIST') || item.error.includes('Prohibited') || item.error.includes('過濾器') || item.error.includes('拒絕')));
        
        if (isProhibited) {
            card.classList.add('is-prohibited');
        } else {
            card.classList.add('is-error');
        }

        const errorGroup = document.createElement('div');
        errorGroup.className = 'text-group';

        if (isProhibited && item.isBatchFirstProhibited) {
            // 整批翻譯第一張圖片：渲染醒目的 Prohibited 專屬警示橫幅
            const prohibitedBanner = document.createElement('div');
            prohibitedBanner.className = 'prohibited-banner';
            prohibitedBanner.innerHTML = `
                <div class="prohibited-header">
                    <span>🚫 AI 模型內容審查拒絕</span>
                    <span class="prohibited-badge">Prohibited</span>
                </div>
                <div class="prohibited-desc">
                    此批次漫畫畫面或台詞觸發了 Google AI 安全性過濾器 (SAFETY / BLOCKLIST)，模型直接拒絕翻譯本批內容。
                </div>
                <div class="prohibited-tip">
                    💡 <strong>解鎖建議：</strong>您可點擊下方按鈕重新嘗試單張翻譯，或在選項頁開啟「📖 雙階段劇本預讀模式」（先抽文字再翻譯）即可 100% 避開圖片視覺審查！
                </div>
            `;
            errorGroup.appendChild(prohibitedBanner);
        } else {
            const errorLabel = document.createElement('div');
            errorLabel.className = isProhibited ? 'text-label text-label--prohibited' : 'text-label text-label--error';
            errorLabel.textContent = isProhibited ? '🚫 內容審查受限 (Prohibited)' : '翻譯失敗';
            errorGroup.appendChild(errorLabel);

            const errorMsg = document.createElement('div');
            errorMsg.className = 'error-message';
            errorMsg.textContent = item.error;
            errorGroup.appendChild(errorMsg);
        }

        const retryBtn = document.createElement('button');
        retryBtn.className = 'btn-retry';
        retryBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16"/></svg> 再次翻譯`;
        retryBtn.addEventListener('click', () => {
            retryBtn.disabled = true;
            retryBtn.textContent = '翻譯中...';
            card.classList.remove('is-error', 'is-prohibited');
            const targetErrorMsg = errorGroup.querySelector('.error-message');
            if (targetErrorMsg) targetErrorMsg.textContent = '正在重新呼叫 API...';

            chrome.runtime.sendMessage({ 
                action: "retranslateImage", 
                url: item.retryUrl || item.image,
                tabId: sourceTabId,
                mangaKey: activeMangaKey 
            }, (response) => {
                if (response && response.results) {
                    // 成功：移除錯誤區，補上結構化對話與完整的按鈕列
                    errorGroup.remove();
                    item.results = response.results;
                    item.usedModelName = response.usedModelName;

                    // 重新加載模型標籤 (如果有的話)
                    if (item.usedModelName) {
                        // 移除舊標籤
                        imageWrapper.querySelectorAll('.card-model-badge').forEach(el => el.remove());
                        const modelBadge = document.createElement('span');
                        modelBadge.className = 'card-model-badge';
                        let displayName = item.usedModelName;
                        if (item.usedModelName.toLowerCase().includes('gemini')) displayName = 'Gemini';
                        if (item.usedModelName.toLowerCase().includes('gemma')) displayName = 'Gemma';
                        modelBadge.textContent = displayName;
                        imageWrapper.appendChild(modelBadge);
                    }

                    // 重新渲染對話區域
                    const dialoguesContainer = document.createElement('div');
                    dialoguesContainer.className = 'dialogues-container';
                    renderDialogueItems(dialoguesContainer, item.results);
                    textWrapper.appendChild(dialoguesContainer);

                    textWrapper.appendChild(createSuccessActionGroup(item, dialoguesContainer));
                } else {
                    card.classList.add('is-error');
                    retryBtn.disabled = false;
                    retryBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16"/></svg> 再次翻譯`;
                    errorMsg.textContent = '仍然失敗: ' + (response?.error || '未知錯誤');
                }
            });
        });
        errorGroup.appendChild(retryBtn);
        textWrapper.appendChild(errorGroup);
        card.appendChild(textWrapper);
        return card;
    }

    const dialoguesContainer = document.createElement('div');
    dialoguesContainer.className = 'dialogues-container';
    const results = item.results || [{ original: item.original, translation: item.translation }];

    // 比照 Preview：在右側頂部加入精緻工具列 (🔄 重翻此頁) + 下方虛線分割
    const toolbarTop = document.createElement('div');
    toolbarTop.className = 'card-toolbar-top';
    toolbarTop.innerHTML = `
        <button class="btn-washi btn-retrans-top" style="padding: 2px 8px; font-size: 11px;" title="重新呼叫 API 翻譯本頁">🔄 重翻此頁</button>
    `;

    // 綁定「🔄 重翻此頁」事件
    toolbarTop.querySelector('.btn-retrans-top').onclick = () => {
        const btn = toolbarTop.querySelector('.btn-retrans-top');
        const origText = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<span class="mt-loader" style="width:10px; height:10px; border-width:1.5px;"></span> 翻譯中...';
        
        chrome.runtime.sendMessage({ 
            action: "retranslateImage", 
            url: item.retryUrl || item.image,
            tabId: sourceTabId,
            mangaKey: activeMangaKey 
        }, (response) => {
            btn.disabled = false;
            btn.innerHTML = origText;
            if (response && response.results) {
                item.results = response.results;
                item.usedModelName = response.usedModelName;
                renderDialogueItems(dialoguesContainer, item.results, item);
            } else {
                alert("重翻此頁失敗: " + (response?.error || '未知錯誤'));
            }
        });
    };

    textWrapper.appendChild(toolbarTop);
    renderDialogueItems(dialoguesContainer, results, item);
    textWrapper.appendChild(dialoguesContainer);
    card.appendChild(textWrapper);
    return card;
}

function renderDialogueItems(container, results, item) {
    container.innerHTML = '';
    results.forEach((res) => {
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
                const allOrigs = [...container.querySelectorAll('.original-text')];
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
        container.appendChild(itemDiv);
        itemDiv.addEventListener('dragstart', (e) => { itemDiv.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
        itemDiv.addEventListener('dragend', () => { itemDiv.classList.remove('dragging'); });
        itemDiv.addEventListener('dragover', (e) => {
            e.preventDefault();
            const draggingItem = container.querySelector('.dragging');
            if (!draggingItem) return;
            const items = [...container.querySelectorAll('.dialogue-item:not(.dragging)')];
            const nextItem = items.find(sibling => {
                const rect = sibling.getBoundingClientRect();
                const offset = e.clientY - rect.top - rect.height / 2;
                return offset < 0;
            });
            if (nextItem) container.insertBefore(draggingItem, nextItem);
            else container.appendChild(draggingItem);
        });
        btnGroup.querySelector('.copy-trans').onclick = () => { navigator.clipboard.writeText(transText.innerText); };
        btnGroup.querySelector('.copy-orig').onclick = () => { navigator.clipboard.writeText(origText.innerText); };
        btnGroup.querySelector('.save-glossary').onclick = () => {
            showGlossaryModal(origText.innerText.trim(), transText.innerText.trim());
        };
        btnGroup.querySelector('.retranslate-item').onclick = () => {
            const newText = origText.innerText.trim();
            if (!newText) return;
            const originalOldText = transText.textContent;
            transText.innerHTML = '<span class="mt-loading-text" style="font-size:12px">正在翻譯...</span>';
            chrome.runtime.sendMessage({ 
                action: "retranslateText", 
                text: newText,
                mangaKey: activeMangaKey
            }, (response) => {
                if (response && response.results && response.results.length > 0) { 
                    transText.textContent = sanitizeTranslationText(response.results[0].translation); 
                }
                else { 
                    alert("重譯失敗: " + (response?.error || 'Unknown')); 
                    transText.textContent = originalOldText; 
                }
            });
        };
    });

    // 若行動端抽屜處於開啟狀態且更新的正是當前卡片，即時動態同步抽屜內容
    try {
        const card = container.closest('.result-card');
        const drawer = document.getElementById('mt-mobile-drawer');
        if (card && drawer && drawer.classList.contains('is-open') && typeof window._syncCardToDrawer === 'function') {
            window._syncCardToDrawer(card);
        }
    } catch (_) {}
}

function createSuccessActionGroup(item, dialoguesContainer) {
    const actionGroup = document.createElement('div');
    actionGroup.className = 'action-btn-group';
    const visionBtn = document.createElement('button');
    visionBtn.className = 'btn-retranslate-vision';
    visionBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16"/></svg> 重新翻譯自原圖`;
    visionBtn.addEventListener('click', () => {
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
            tabId: sourceTabId,
            mangaKey: activeMangaKey
        }, (response) => {
            loader.remove();
            visionBtn.disabled = false;
            visionBtn.innerHTML = oldHtml;
            if (response && response.results) {
                item.results = response.results;
                renderDialogueItems(dialoguesContainer, item.results, item);
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
        textBtn.disabled = true;
        const oldHtml = textBtn.innerHTML;
        textBtn.textContent = '翻譯中...';
        chrome.runtime.sendMessage({ 
            action: "retranslateText", 
            text: combinedText,
            mangaKey: activeMangaKey
        }, (response) => {
            textBtn.disabled = false;
            textBtn.innerHTML = oldHtml;
            if (response && response.results) {
                const newResults = response.results;
                const transElements = dialoguesContainer.querySelectorAll('.translated-text');
                
                // 逐行填回，避免越界
                transElements.forEach((el, i) => {
                    if (newResults[i]) {
                        el.textContent = sanitizeTranslationText(newResults[i].translation);
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

document.getElementById('export-txt-btn').addEventListener('click', () => {
    // 修復：改從 DOM 即時讀取，確保使用者的手動編輯與重譯都能被匹出
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
});

/** 重置導航按鈕狀態，用於跳轉完成、逾時保險或任務結束 */
function resetNavButtons() {
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

/* ─── 行動端漫畫閱讀器互動邏輯 (全域 Bottom Sheet 抽屜) ─── */
let mobileReaderInitialized = false;

function initMobileReader() {
    const hasTouchAndMobileUA = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const urlParams = new URLSearchParams(location.search);
    
    let isMobileMode = false;
    if (urlParams.get('mobile') === '1') {
        isMobileMode = true;
    } else if (urlParams.get('desktop') === '1') {
        isMobileMode = false;
    } else {
        isMobileMode = hasTouchAndMobileUA || (window.innerWidth <= 768);
    }

    if (!isMobileMode) {
        document.body.classList.remove('mt-mobile-mode');
        return;
    }
    document.body.classList.add('mt-mobile-mode');
    if (mobileReaderInitialized) return;
    mobileReaderInitialized = true;

    const resultsContainer = document.getElementById('results-container');
    const drawer = document.getElementById('mt-mobile-drawer');
    const drawerTitle = document.getElementById('mt-drawer-title');
    const drawerBody = document.getElementById('mt-drawer-body');
    const drawerClose = document.getElementById('mt-drawer-close');
    const drawerBackdrop = drawer ? drawer.querySelector('.mt-drawer-backdrop') : null;

    if (!resultsContainer) return;

    // ── 1. 建立進度點列 ──
    const progressBar = document.createElement('div');
    progressBar.className = 'mobile-progress-bar';
    document.body.appendChild(progressBar);

    let dots = [];
    let currentPage = 0;

    function rebuildDots() {
        const cards = resultsContainer.querySelectorAll('.result-card:not(.skeleton-card)');
        progressBar.innerHTML = '';
        dots = [];
        if (cards.length > 20) { progressBar.style.display = 'none'; return; }
        progressBar.style.display = 'flex';
        cards.forEach((_, i) => {
            const dot = document.createElement('div');
            dot.className = 'mobile-progress-dot' + (i === currentPage ? ' active' : '');
            progressBar.appendChild(dot);
            dots.push(dot);
        });
    }

    function updateActiveDot(index) {
        currentPage = index;
        dots.forEach((d, i) => d.classList.toggle('active', i === index));
    }

    // ── 2. 全域固定 FAB 按鈕 ──
    const fab = document.createElement('button');
    fab.id = 'mt-mobile-fab';
    fab.textContent = '📖 查看 P.1 翻譯';
    document.body.appendChild(fab);

    let currentVisibleCard = null;

    // 將指定卡片的翻譯對白同步渲染進全域底部抽屜
    window._syncCardToDrawer = function(card) {
        if (!card || !drawerBody) return;
        const pageNumStr = card.querySelector('.card-page-badge')?.textContent || `P.${currentPage + 1}`;
        if (drawerTitle) drawerTitle.textContent = `📄 ${pageNumStr} 翻譯內容`;
        if (fab) fab.textContent = `📖 查看 ${pageNumStr} 翻譯`;

        // 提取卡片內部的對白容器 .dialogues-container
        const dialoguesContainer = card.querySelector('.dialogues-container');
        drawerBody.innerHTML = '';

        if (dialoguesContainer && dialoguesContainer.children.length > 0) {
            Array.from(dialoguesContainer.querySelectorAll('.dialogue-item')).forEach(item => {
                const clone = item.cloneNode(true);
                // 重新綁定語彙庫按鈕事件
                const termBtn = clone.querySelector('.save-glossary');
                if (termBtn) {
                    const ori = clone.querySelector('.original-text')?.textContent || '';
                    const trans = clone.querySelector('.translated-text')?.textContent || '';
                    termBtn.onclick = (e) => {
                        e.stopPropagation();
                        showGlossaryModal(ori, trans);
                    };
                }
                drawerBody.appendChild(clone);
            });
        } else {
            const emptyHint = document.createElement('div');
            emptyHint.style.cssText = 'padding: 24px; text-align: center; color: #888; font-size: 13px;';
            emptyHint.textContent = card.classList.contains('is-error') ? '⚠️ 本頁翻譯失敗' : '✨ 本頁無文字或正在翻譯中...';
            drawerBody.appendChild(emptyHint);
        }
    };

    function openDrawer() {
        const targetCard = currentVisibleCard || resultsContainer.querySelector('.result-card:not(.skeleton-card)');
        if (targetCard) {
            window._syncCardToDrawer(targetCard);
        }
        if (drawer) drawer.classList.add('is-open');
        if (fab) fab.classList.add('hidden');
    }

    function closeDrawer() {
        if (drawer) drawer.classList.remove('is-open');
        if (fab) fab.classList.remove('hidden');
    }

    // 綁定 FAB 按鈕點擊與觸碰事件 (雙重相容)
    fab.addEventListener('click', openDrawer);
    fab.addEventListener('touchend', (e) => {
        e.preventDefault();
        openDrawer();
    });

    if (drawerClose) {
        drawerClose.addEventListener('click', closeDrawer);
        drawerClose.addEventListener('touchend', (e) => {
            e.preventDefault();
            closeDrawer();
        });
    }
    if (drawerBackdrop) {
        drawerBackdrop.addEventListener('click', closeDrawer);
    }

    // ── 3. Scroll 偵測：自動動態同步當前頁碼與抽屜內容 ──
    const scrollObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (!entry.isIntersecting) return;
            const cards = Array.from(resultsContainer.querySelectorAll('.result-card:not(.skeleton-card)'));
            const idx = cards.indexOf(entry.target);
            if (idx >= 0) {
                updateActiveDot(idx);
                currentVisibleCard = entry.target;
                
                const pageNumStr = entry.target.querySelector('.card-page-badge')?.textContent || `P.${idx + 1}`;
                if (fab) fab.textContent = `📖 查看 ${pageNumStr} 翻譯`;

                // 若抽屜處於開啟中，自動無縫刷新為當前可見卡片的翻譯
                if (drawer && drawer.classList.contains('is-open')) {
                    window._syncCardToDrawer(entry.target);
                }
            }
        });
    }, { root: resultsContainer, threshold: 0.5 });

    // ── 4. 綁定卡片 Observer ──
    window._bindMobileCard = function(card) {
        if (card.dataset.mobileBound) return;
        card.dataset.mobileBound = '1';
        scrollObserver.observe(card);
        rebuildDots();
        if (!currentVisibleCard) {
            currentVisibleCard = card;
        }
    };

    resultsContainer.querySelectorAll('.result-card:not(.skeleton-card)').forEach(window._bindMobileCard);
    rebuildDots();
}

initMobileReader();

// ── 【改動3】整批重試功能 ──

/**
 * updateRetryAllBtn — 統計頁面內失敗卡片數量，顯示或隱藏「重試所有失敗圖片」按鈕
 */
function updateRetryAllBtn() {
    const failedCards = container.querySelectorAll('.result-card.is-error');
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

// 綁定重試按鈕事件
const retryBtn = document.getElementById('btn-retry-all-failed');
if (retryBtn) {

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
        const failedCards = container.querySelectorAll('.result-card.is-error[data-retry-url]');
        const images = Array.from(failedCards)
            .map(card => card.dataset.retryUrl)
            .filter(url => url);

        if (images.length === 0) return;

        if (!confirm(`確定要重新批次翻譯 ${images.length} 張失敗圖片嗎？`)) return;

        // 隱藏按鈕，顯示翻譯中 overlay
        const retryContainer = document.getElementById('retry-all-container');
        if (retryContainer) retryContainer.style.display = 'none';
        const overlay = document.getElementById('loading-overlay');
        if (overlay) overlay.classList.remove('hidden');
        document.getElementById('progress-text').innerText = `正在重試 ${images.length} 張失敗圖片...`;

        chrome.runtime.sendMessage({
            action: 'RETRY_FAILED_BATCH',
            images: images,
            sourceTabId: sourceTabId,
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
