import { LOADING_GIF_FILENAME, RUNNING_ANIMS } from '../utils/constants.js';

let translatedData = [];
const container = document.getElementById('results-container');
let currentTheme = 'umamusume';
let sourceTabId = null;
let activeMangaKey = null;

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

// Initial load: Pull navigation links from background
document.addEventListener('DOMContentLoaded', () => {
    // 加載主題
    chrome.storage.local.get(['mt_theme'], (result) => {
        applyTheme(result.mt_theme || 'umamusume');
        
        // 注入東方 Loading GIF 到右下角的翻譯中膠囊
        const mainAnim = document.getElementById('main-loading-anim');
        if (mainAnim) mainAnim.src = chrome.runtime.getURL(LOADING_GIF_FILENAME);
    });

    chrome.runtime.sendMessage({ action: "getResultMetadata" }, (response) => {
        if (response) {
            if (response.navLinks) updateNavUI(response.navLinks);
            if (response.mangaKey) activeMangaKey = response.mangaKey;
            
            if (response.displayName) {
                const titleEl = document.getElementById('manga-title-display');
                if (titleEl) titleEl.textContent = '- ' + response.displayName;
            }

            // [新增] 查詢並顯示語彙庫詳細狀態
            if (activeMangaKey) {
                chrome.runtime.sendMessage({ action: "getGlossaryDetail", mangaKey: activeMangaKey }, (glossaryResp) => {
                    if (glossaryResp && glossaryResp.entry) {
                        const badge = document.getElementById('glossary-info-badge');
                        if (badge) {
                            badge.textContent = `已套用語彙庫: ${glossaryResp.entry.displayName} (${glossaryResp.entry.terms?.length || 0} 詞)`;
                            badge.classList.add('show');
                        }
                    }
                });
            }
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
                    const card = buildCard(item, idx);
                    container.appendChild(card);
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

    // 通知背景結果分頁已載入完成
    chrome.runtime.sendMessage({ action: "resultPageReady" }).catch(() => {});

    // 初始化語彙庫 Modal
    setupGlossaryModal();
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

        // 先取得 displayName，用於新作品首次建立詞庫時命名正確
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
            if (response && response.success) {
                // 成功後，Badge 會透過監聽訊息自動更新
                closeModal();
            } else {
                alert('儲存失敗: ' + (response?.error || '未知錯誤'));
                saveBtn.disabled = false;
                saveBtn.textContent = '儲存條目';
            }
        });
    };
}

function showGlossaryModal(ori, trans) {
    const modal = document.getElementById('mt-glossary-modal');
    if (!modal) return;

    const oriInput = document.getElementById('mt-glossary-ori');
    const transInput = document.getElementById('mt-glossary-trans');

    oriInput.value = ori || '';
    transInput.value = trans || '';

    modal.classList.add('show');
    transInput.focus();
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

function updateNavUI(navLinks) {
    const { prev, next } = navLinks;
    const footer = document.getElementById('nav-footer');
    const prevBtn = document.getElementById('prev-btn');
    const nextBtn = document.getElementById('next-btn');
    const safePrev = isSafeUrl(prev) ? prev : null;
    const safeNext = isSafeUrl(next) ? next : null;

    if (safePrev || safeNext) {
        if (footer) footer.style.display = 'flex';

        if (safePrev && prevBtn) {
            prevBtn.style.display = 'inline-flex';
            prevBtn.onclick = () => {
                prevBtn.disabled = true;
                if(nextBtn) nextBtn.disabled = true;
                prevBtn.classList.add('is-navigating');
                prevBtn.innerHTML = `正在跳轉至上一話...`;
                chrome.runtime.sendMessage({ 
                    action: "navigateAndTranslate", 
                    url: safePrev,
                    tabId: sourceTabId,
                    mangaKey: activeMangaKey,
                    mobile: urlParams.get('mobile') === '1'
                });
            };
            prevBtn.title = safePrev;
        } else if (prevBtn) {
            prevBtn.style.display = 'none';
        }

        if (safeNext && nextBtn) {
            nextBtn.style.display = 'inline-flex';
            nextBtn.onclick = () => {
                nextBtn.disabled = true;
                if(prevBtn) prevBtn.disabled = true;
                nextBtn.classList.add('is-navigating');
                nextBtn.innerHTML = `正在跳轉至下一話...`;
                
                setTimeout(resetNavButtons, 10000);

                chrome.runtime.sendMessage({ 
                    action: "navigateAndTranslate", 
                    url: safeNext,
                    tabId: sourceTabId,
                    mangaKey: activeMangaKey,
                    mobile: urlParams.get('mobile') === '1'
                });
            };
            nextBtn.title = safeNext;
        } else if (nextBtn) {
            nextBtn.style.display = 'none';
        }
    } else {
        if (footer) footer.style.display = 'none';
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

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "appendResult") {
        const imgUrl = request.data?.image || '';
        // 【改動3】整批重試時：若卡片已存在（依 data-retry-url 定位），直接覆蓋
        const existingErrorCard = imgUrl
            ? container.querySelector(`.result-card.is-error[data-retry-url="${CSS.escape(imgUrl)}"]`)
            : null;

        let realCard;
        if (existingErrorCard) {
            // 覆蓋模式：原地替換失敗卡片
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
                container.appendChild(realCard);
            }
        }
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

        // 隱藏舊導航、清除翻譯完成 overlay
        const footer = document.getElementById('nav-footer');
        if (footer) footer.style.display = 'none';
        const overlay = document.getElementById('loading-overlay');
        if (overlay) overlay.classList.remove('hidden');
        document.getElementById('progress-text').innerText = '正在跳轉並準備翻譯...';

        // 更新語彙庫 key
        if (request.mangaKey) activeMangaKey = request.mangaKey;

        // 告訴 Background 確認收到（讓它繼續呼叫 processMangaBatchPCMode）
        sendResponse({ ready: true });
        return true; // 非同步
    }
    return false;
});

function createPlaceholders(total) {
    for (let i = 0; i < total; i++) {
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
        container.appendChild(card);
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
    imageWrapper.appendChild(img);
    card.appendChild(imageWrapper);

    const textWrapper = document.createElement('div');
    textWrapper.className = 'card-text-wrapper';

    // 翻譯失敗：顯示錯誤訊息 + 再次翻譯按鈕
    if (item.error) {
        card.classList.add('is-error');

        const errorGroup = document.createElement('div');
        errorGroup.className = 'text-group';

        const errorLabel = document.createElement('div');
        errorLabel.className = 'text-label text-label--error';
        errorLabel.textContent = '翻譯失敗';
        errorGroup.appendChild(errorLabel);

        const errorMsg = document.createElement('div');
        errorMsg.className = 'error-message';
        errorMsg.textContent = item.error;
        errorGroup.appendChild(errorMsg);

        const retryBtn = document.createElement('button');
        retryBtn.className = 'btn-retry';
        retryBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16"/></svg> 再次翻譯`;
        retryBtn.addEventListener('click', () => {
            retryBtn.disabled = true;
            retryBtn.textContent = '翻譯中...';
            card.classList.remove('is-error');
            errorMsg.textContent = '正在重新呼叫 API...';

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
    renderDialogueItems(dialoguesContainer, results, item);
    textWrapper.appendChild(dialoguesContainer);
    textWrapper.appendChild(createSuccessActionGroup(item, dialoguesContainer));
    card.appendChild(textWrapper);
    return card;
}

function renderDialogueItems(container, results, item) {
    container.innerHTML = '';
    results.forEach((res) => {
        const itemDiv = document.createElement('div');
        itemDiv.className = 'dialogue-item';
        itemDiv.draggable = true;
        const dragHandle = document.createElement('div');
        dragHandle.className = 'mt-drag-handle';
        dragHandle.innerHTML = `<svg width="12" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="19" r="1"/></svg>`;
        const contentDiv = document.createElement('div');
        contentDiv.className = 'dialogue-content';
        const transText = document.createElement('div');
        transText.className = 'translated-text';
        transText.textContent = res.translation || '無翻譯';
        const origText = document.createElement('div');
        origText.className = 'original-text';
        origText.setAttribute('contenteditable', 'true');
        origText.setAttribute('spellcheck', 'false');
        origText.textContent = res.original || '無內容';
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
        itemDiv.appendChild(dragHandle);
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
                    transText.textContent = response.results[0].translation; 
                }
                else { 
                    alert("重譯失敗: " + (response?.error || 'Unknown')); 
                    transText.textContent = originalOldText; 
                }
            });
        };
    });
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
                        el.textContent = newResults[i].translation;
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

/** 重置導航按鈕狀態，用於逾時保險或任務完成 */
function resetNavButtons() {
    const btns = [
        document.getElementById('prev-btn'),
        document.getElementById('prev-btn-top'),
        document.getElementById('next-btn'),
        document.getElementById('next-btn-top')
    ];
    btns.forEach(btn => {
        if (!btn) return;
        btn.disabled = false;
        btn.classList.remove('is-navigating');
        if (btn.id.includes('prev')) {
            btn.innerHTML = btn.id.includes('top') 
                ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg> 上一話`
                : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg> 上一話`;
        } else {
            btn.innerHTML = btn.id.includes('top')
                ? `下一話 <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>`
                : `下一話 <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>`;
        }
    });
}

/* ─── 行動端漫畫閱讀器互動邏輯 ─── */
let mobileReaderInitialized = false;

function initMobileReader() {
    // 優先使用 URL 參數 ?mobile=1 判斷（行動端跳轉時帶入）
    // 備援：偵測觸控裝置（Android 平板/iPad 不依賴螢幕寬度判斷）
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

    // ── 2. Scroll 偵測 ──
    const scrollObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (!entry.isIntersecting) return;
            const cards = Array.from(resultsContainer.querySelectorAll('.result-card:not(.skeleton-card)'));
            const idx = cards.indexOf(entry.target);
            if (idx >= 0) {
                updateActiveDot(idx);
                currentVisibleCard = entry.target;
                
                // 【新增】預設開啟翻譯面板
                const textWrapper = entry.target.querySelector('.card-text-wrapper');
                if (textWrapper && !textWrapper.classList.contains('is-open')) {
                    openPanel(textWrapper);
                }

                // 確保其他非當前卡片的面板收起
                cards.forEach((c, i) => {
                    if (i !== idx) c.querySelector('.card-text-wrapper')?.classList.remove('is-open');
                });
            }
        });
    }, { root: resultsContainer, threshold: 0.5 });

    // ── 3. 建立全域固定 FAB 按鈕（position: fixed，不受卡片/容器影響）──
    const fab = document.createElement('button');
    fab.id = 'mt-mobile-fab';
    fab.textContent = '📖 查看翻譯';
    document.body.appendChild(fab);

    let currentVisibleCard = null;

    const openPanel = (textWrapper) => {
        // 關閉所有已開啟的面板
        document.querySelectorAll('.card-text-wrapper.is-open').forEach(w => w.classList.remove('is-open'));
        textWrapper.scrollTop = 0;  // 每次打開都從頂部開始
        textWrapper.classList.add('is-open');
        fab.classList.add('hidden');
    };

    const closePanel = () => {
        document.querySelectorAll('.card-text-wrapper.is-open').forEach(w => w.classList.remove('is-open'));
        fab.classList.remove('hidden');
    };

    // FAB 點擊：開啟目前可見卡片的翻譯面板
    fab.addEventListener('click', () => {
        if (!currentVisibleCard) return;
        const textWrapper = currentVisibleCard.querySelector('.card-text-wrapper');
        if (textWrapper) openPanel(textWrapper);
    });

    // ── 4. 綁定單張卡片（加入面板 header + 捲動區域）──
    window._bindMobileCard = function(card) {
        if (card.dataset.mobileBound) return;
        card.dataset.mobileBound = '1';

        const textWrapper = card.querySelector('.card-text-wrapper');
        if (!textWrapper) return;

        // 把 textWrapper 原有的所有子元素移到獨立捲動容器
        const contentArea = document.createElement('div');
        contentArea.className = 'mobile-panel-content';
        while (textWrapper.firstChild) {
            contentArea.appendChild(textWrapper.firstChild);
        }

        // 建立 panel header（固定在最上方，不用 sticky）
        const panelHeader = document.createElement('div');
        panelHeader.className = 'mobile-panel-header';
        panelHeader.innerHTML = `
            <div class="mobile-panel-header-row">
                <span class="mobile-panel-title">📄 翻譯內容</span>
                <button class="mobile-close-btn">✕ 收起</button>
            </div>
        `;

        // 重組 textWrapper：header → content（分開捲動）
        textWrapper.appendChild(panelHeader);
        textWrapper.appendChild(contentArea);

        panelHeader.querySelector('.mobile-close-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            closePanel();
        });
        panelHeader.querySelector('.mobile-close-btn').addEventListener('touchend', (e) => {
            e.preventDefault();
            e.stopPropagation();
            closePanel();
        });

        scrollObserver.observe(card);
        rebuildDots();
    };

    // 對目前已存在的卡片初始化
    resultsContainer.querySelectorAll('.result-card:not(.skeleton-card)').forEach(window._bindMobileCard);
    rebuildDots();
}

// ── result.js 是 module，執行時 DOMContentLoaded 已觸發，直接呼叫 ──
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
