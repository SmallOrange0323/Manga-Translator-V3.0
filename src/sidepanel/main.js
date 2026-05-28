import { state } from '../utils/state.js';
import { extractMangaTitle } from '../utils/manga-utils.js';
import { LOADING_GIF_FILENAME, RUNNING_ANIMS, STANDING_ASSETS, PRICONNE_LOADING_SPRITES } from '../utils/constants.js';

console.log('[Manga Translator V3] Classic Sidepanel Initialized');

// ── 主題相關狀態 ──
let currentTheme = 'umamusume';

/**
 * setRandomBackground — 依當前主題隨機選取一張立繪作為側邊欄背景
 */
function setRandomBackground() {
    const bgImg = document.getElementById('mt-sidebar-bg');
    if (!bgImg) return;
    if (currentTheme === 'priconne') {
        const list = STANDING_ASSETS.priconne;
        const file = list[Math.floor(Math.random() * list.length)];
        bgImg.src = chrome.runtime.getURL(`assets/standing_priconne/${file}`);
    } else {
        const list = STANDING_ASSETS.umamusume;
        const file = list[Math.floor(Math.random() * list.length)];
        bgImg.src = chrome.runtime.getURL(`assets/standing/${file}`);
    }
}

/**
 * setThemeLoading — 依當前主題設定 Loading 動畫
 * 馬娘：隨機跑步 webp（<img> src）；公連：隨機 sprite 分格動畫（CSS background + <div>）
 */
function setThemeLoading() {
    const loadingImg = document.getElementById('mt-loading-gif');
    if (!loadingImg) return;

    if (currentTheme === 'priconne') {
        const sprite = PRICONNE_LOADING_SPRITES[Math.floor(Math.random() * PRICONNE_LOADING_SPRITES.length)];
        const url = chrome.runtime.getURL(`assets/loading_priconne/${sprite.file}`);
        const frameH = 128; // 每幀高度 (px)，sprite 為垂直分格

        // <img> 不支援 background-image sprite，改為 <div> 替換
        const spriteDiv = document.createElement('div');
        spriteDiv.id = 'mt-loading-gif';
        spriteDiv.style.cssText = `
            width: 96px; height: ${frameH}px;
            background: url('${url}') no-repeat 0 0;
            background-size: 100% auto;
            image-rendering: pixelated;
            --frames: ${sprite.frames};
            animation: priconne-sprite-anim ${(sprite.frames * 0.08).toFixed(2)}s steps(${sprite.frames}) infinite;
        `;
        loadingImg.replaceWith(spriteDiv);
    } else {
        // 確保元素是 <img>（防止公連切換回馬娘時仍是 <div>）
        if (loadingImg.tagName !== 'IMG') {
            const img = document.createElement('img');
            img.id = 'mt-loading-gif';
            img.alt = 'Loading...';
            loadingImg.replaceWith(img);
        }
        const imgEl = document.getElementById('mt-loading-gif');
        imgEl.style.cssText = 'width: 120px; height: auto; border-radius: 50%; box-shadow: 0 4px 15px rgba(0,0,0,0.1);';
        imgEl.src = chrome.runtime.getURL(`assets/running/${RUNNING_ANIMS[Math.floor(Math.random() * RUNNING_ANIMS.length)]}`);
    }
}

// 載入動畫元素初始化（等主題確認後再設定）
const loadingOverlay = document.getElementById('mt-loading-overlay');

// 詞庫狀態列相關元素
const glossaryBar = document.getElementById('mt-glossary-bar');
const glossaryNameEl = document.getElementById('mt-glossary-name');
const glossaryCountEl = document.getElementById('mt-glossary-count');
const manageBtn = document.getElementById('mt-manage-glossary-btn');

// 手動選取詞庫相關元素
const glossaryInfoGroup = document.getElementById('mt-glossary-info-group');
const glossaryManualGroup = document.getElementById('mt-glossary-manual');
const switchGlossaryBtn = document.getElementById('mt-switch-glossary-btn');
const glossarySelect = document.getElementById('mt-glossary-select');
const novelRetryAllBtn = document.getElementById('mt-novel-retry-all-btn');

let currentMangaKey = null;
let isManualGlossary = false; // 是否處於手動選擇狀態

/**
 * 刷新側邊欄的作品詞庫狀態
 */
async function refreshGlossaryStatus() {
    if (isManualGlossary) return; // 手動模式下不自動更新
    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        
        glossaryBar.style.display = 'flex'; // 永遠顯示狀態列，讓使用者能點擊手動選取
        
        if (!tab || !tab.title) {
            currentMangaKey = null;
            glossaryNameEl.textContent = '未偵測到作品';
            glossaryNameEl.title = '未偵測到作品';
            glossaryCountEl.textContent = '0 詞';
            return;
        }

        // 如果目前分頁是結果頁或是擴充功能的頁面，就維持原本的狀態，不要重新偵測
        if (tab.url && tab.url.startsWith('chrome-extension://')) {
            return;
        }

        const titleResult = extractMangaTitle(tab.title);
        if (titleResult) {
            currentMangaKey = titleResult.romanKey;
            glossaryNameEl.textContent = titleResult.displayName;
            glossaryNameEl.title = titleResult.displayName;

            // 向背景請求詳情
            chrome.runtime.sendMessage({ 
                action: 'GET_GLOSSARY_INFO', 
                payload: { mangaKey: currentMangaKey } 
            }, (response) => {
                if (response && response.success) {
                    glossaryCountEl.textContent = `${response.termCount} 詞`;
                }
            });
        } else {
            currentMangaKey = null;
            glossaryNameEl.textContent = '未偵測到作品';
            glossaryNameEl.title = '未偵測到作品';
            glossaryCountEl.textContent = '0 詞';
        }
    } catch (err) {
        console.warn('[Sidepanel] Failed to refresh glossary status:', err);
    }
}

// 監聽背景廣播的事件
chrome.runtime.onMessage.addListener((request) => {
    if (request.action === 'TITLE_DETECTED' && !isManualGlossary) {
        const title = request.payload;
        glossaryBar.style.display = 'flex';
        glossaryNameEl.textContent = title.displayName;
        currentMangaKey = title.romanKey;
        // 觸發重新抓取數量
        refreshGlossaryStatus();
    }

    if (request.action === 'GLOSSARY_UPDATED') {
        const { mangaKey, termCount } = request.payload;
        if (mangaKey === currentMangaKey && !isManualGlossary) {
            glossaryCountEl.textContent = `${termCount} 詞`;
        }
    }
});

// 監聽分頁切換
chrome.tabs.onActivated.addListener(() => {
    // 稍微延遲確保 tab 資訊已更新
    setTimeout(refreshGlossaryStatus, 300);
});

// 填充下拉選單
async function populateGlossaryDropdown() {
    try {
        const data = await chrome.storage.local.get(['mangaGlossaries']);
        const all = data.mangaGlossaries || {};
        const keys = Object.keys(all).sort((a, b) => {
            const timeA = all[a].lastUsed || 0;
            const timeB = all[b].lastUsed || 0;
            return timeB - timeA;
        });

        glossarySelect.innerHTML = '<option value="">-- 手動選擇詞庫 --</option>';
        keys.forEach(key => {
            const entry = all[key];
            const opt = document.createElement('option');
            opt.value = key;
            opt.textContent = entry.displayName || key;
            if (key === currentMangaKey) opt.selected = true;
            glossarySelect.appendChild(opt);
        });
    } catch (err) {
        console.warn('[Sidepanel] Failed to populate dropdown:', err);
    }
}

// 手動選取切換
if (switchGlossaryBtn) {
    switchGlossaryBtn.onclick = () => {
        isManualGlossary = !isManualGlossary;
        if (isManualGlossary) {
            glossaryInfoGroup.style.display = 'none';
            glossaryManualGroup.style.display = 'flex';
            switchGlossaryBtn.textContent = '取消手動';
            populateGlossaryDropdown();
        } else {
            glossaryInfoGroup.style.display = 'flex';
            glossaryManualGroup.style.display = 'none';
            switchGlossaryBtn.textContent = '手動選取';
            refreshGlossaryStatus(); // 恢復自動偵測狀態
        }
    };
}

// 手動選取變更
if (glossarySelect) {
    glossarySelect.onchange = () => {
        if (glossarySelect.value) {
            currentMangaKey = glossarySelect.value;
            console.log('[Sidepanel] 手動切換詞庫至:', currentMangaKey);
        }
    };
}

// 管理按鈕：打開選項頁並定位到詞庫區塊 (未來可強化定位)
manageBtn.onclick = () => {
    chrome.runtime.openOptionsPage();
};

const themeToggle = document.getElementById('mt-theme-toggle');
const body = document.body;

// 初始化主題
state.get('theme', 'theme-umamusume').then(theme => {
    currentTheme = theme.replace('theme-', '');
    body.className = theme;
    setRandomBackground();
    setThemeLoading();
});

// 主題切換邏輯
themeToggle.onclick = async () => {
    const currentBodyTheme = body.className;
    const nextBodyTheme = currentBodyTheme === 'theme-umamusume' ? 'theme-priconne' : 'theme-umamusume';
    body.className = nextBodyTheme;
    currentTheme = nextBodyTheme.replace('theme-', '');
    await state.set('theme', nextBodyTheme);
    setRandomBackground();   // 切換立繪
    setThemeLoading();       // 切換 Loading 動畫
    // 同步廣播給結果頁 (需去掉 'theme-' 前綴，否則 result.js 會套用 'theme-theme-xxx')
    chrome.storage.local.set({ mt_theme: currentTheme });
    console.log('[Sidepanel] Theme switched to:', nextBodyTheme);
};

// 訂閱狀態更新 (響應式 UI)
state.onChanged((changes) => {
    if (changes.usageCount || changes.usageTotal) {
        updateQuotaUI();
    }
    
    if (changes.novelProgress) {
        updateNovelStatus(changes.novelProgress.newValue);
    }

    if (changes.novelModeTabs) {
        updateNovelModeToggleForCurrentTab();
    }

        if (changes.isStopping) {
            const stopBtn = document.getElementById('mt-stop-btn');
            const startBtn = document.getElementById('mt-start-btn');
            const pauseBtn = document.getElementById('mt-pause-btn');
            if (changes.isStopping.newValue === true) {
                // isStopping = true 代表使用者主動按了停止
                if (stopBtn) stopBtn.style.display = 'none';
                if (startBtn) startBtn.style.display = 'flex';
                if (pauseBtn) pauseBtn.style.display = 'none';
            }
            // isStopping = false 代表任務完成或新任務開始，不在此處理
        }
});

// 監聽 batchComplete 訊息恢復 UI 狀態
chrome.runtime.onMessage.addListener((request) => {
    if (request.action === 'START_TRANSLATING_CARD') {
        const stopBtn = document.getElementById('mt-stop-btn');
        const startBtn = document.getElementById('mt-start-btn');
        if (stopBtn) stopBtn.style.display = 'flex';
        if (startBtn) startBtn.style.display = 'none';
        showTranslatingCard(request.imgCount || 0);
    }

    if (request.action === 'TRANSLATION_DONE') {
        const stopBtn = document.getElementById('mt-stop-btn');
        const startBtn = document.getElementById('mt-start-btn');
        const pauseBtn = document.getElementById('mt-pause-btn');
        if (stopBtn) stopBtn.style.display = 'none';
        if (startBtn) startBtn.style.display = 'flex';
        if (pauseBtn) { pauseBtn.style.display = 'none'; pauseBtn.textContent = '⏸️ 暫停'; pauseBtn.classList.remove('is-paused'); }
        hideTranslatingCard(); // 翻譯完成，移除跑步動畫卡片
    }
    // P1 移植：配額即時更新（對齊 v1.8.7 updateTokenDisplay）
    if (request.action === 'updateTokenDisplay') {
        updateQuotaUI();
    }
});

async function updateQuotaUI() {
    const count = await state.get('usageCount', 0);

    // 從 StateManager (chrome.storage.local) 讀取 apiKey，以精準統計多 API Key 的數量
    const apiKeyRaw = await state.get('apiKey', '');
    const keyCount = Math.max(
        (apiKeyRaw.split('\n').map(k => k.trim()).filter(k => k)).length,
        1
    );
    const total = keyCount * 500;
    const percent = Math.min(100, (count / total) * 100).toFixed(1);

    const countEl = document.getElementById('mt-quota-count');
    const fillEl = document.getElementById('mt-quota-bar-fill');
    if (countEl) countEl.textContent = `${count} / ${total} (${percent}%)`;
    if (fillEl) fillEl.style.width = `${percent}%`;
}

function updateNovelStatus(progress) {
    const statusEl = document.getElementById('mt-novel-status');
    const progressContainer = document.getElementById('mt-novel-progress-container');
    const progressText = document.getElementById('mt-novel-progress-text');
    const progressFill = document.getElementById('mt-novel-progress-fill');

    if (progress && progress.status) {
        statusEl.style.display = 'inline';
        statusEl.textContent = '(小說中)';
        
        if (progressContainer && progressText && progressFill) {
            progressContainer.style.display = 'block';
            progressText.textContent = progress.status;
            
            if (progress.current && progress.total) {
                const percent = Math.round((progress.current / progress.total) * 100);
                progressFill.style.width = `${percent}%`;
            }
        }
    } else {
        statusEl.style.display = 'none';
        if (progressContainer) {
            progressContainer.style.display = 'none';
            if (progressFill) progressFill.style.width = '0%';
        }
    }
}

// 選圖階段暫存變數
let candidateImages = [];
let candidateNavLinks = { prev: null, next: null }; // 同步儲存導航連結

// 綁定按鈕動作
document.getElementById('mt-start-btn').onclick = () => {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
        if (!tabs[0]) return;
        const tabId = tabs[0].id;

        // ── 漫畫模式（原有邏輯）──
        const novelModeTabs = await state.get('novelModeTabs', {});
        const isNovelMode = !!novelModeTabs[tabId];
        if (isNovelMode) {
            alert('目前為小說模式，此按鈕專供漫畫使用。請關閉小說模式後再試。');
            return;
        }

        // 顯示載入動畫
        if (loadingOverlay) loadingOverlay.style.display = 'flex';

        // 「對齊 v1.8.7」先呼叫 prepareTab 確保 Content Script 已注入
        chrome.runtime.sendMessage({ action: 'prepareTab', tabId }, (prep) => {
            if (!prep || !prep.ready) {
                if (loadingOverlay) loadingOverlay.style.display = 'none';
                alert("網頁環境啟動失敗。請確認網頁已載入完成，或嘗試手動重整一次網頁。");
                return;
            }

            let crawlTimeout = setTimeout(() => {
                if (loadingOverlay) loadingOverlay.style.display = 'none';
                alert("揃淨請求無回應。請確認網頁沒有變更位址，或嘗試手動重整。");
            }, 8000);

            chrome.tabs.sendMessage(tabId, { action: "crawlImages" }, (response) => {
                clearTimeout(crawlTimeout);
                if (loadingOverlay) loadingOverlay.style.display = 'none';

                if (chrome.runtime.lastError) {
                    console.error('[Manga][SP] crawlImages 失敗:', chrome.runtime.lastError.message);
                    alert('無法與頁面建立連線 (或網頁目前為行動模式)。詳細錯誤：' + chrome.runtime.lastError.message);
                    return;
                }
                if (response && Array.isArray(response.images)) {
                    candidateImages = response.images;
                    // 同步儲存導航連結，用於後續批次翻譯時帶入
                    candidateNavLinks = response.navLinks || { prev: null, next: null };
                    if (candidateImages.length === 0) {
                        alert("未在此網頁找到候選圖片！\n\n小提醒：部分網站需要往下捲動才會載入圖片，請先捲動網頁後再試一次。");
                        return;
                    }
                    renderPreviewList();
                }
            });
        });
    });
};

document.getElementById('mt-stop-btn').onclick = () => {
    chrome.runtime.sendMessage({ action: 'STOP_TRANSLATION' }, () => {
        // 【問題4修正】直接強制清除暫停狀態，而非使用 toggleBatchPause（切換操作）
        // 避免在非暫停狀態下按停止後，反而將 isBatchPaused 設為 true，
        // 導致下一次翻譯任務一開始就卡在暫停狀態，需使用者手動按「繼續」
        state.set('isBatchPaused', false);
        document.getElementById('mt-stop-btn').style.display = 'none';
        document.getElementById('mt-pause-btn')?.style.setProperty('display', 'none');
        document.getElementById('mt-start-btn').style.display = 'flex';
        // 同步重置暫停按鈕的視覺狀態
        const pauseBtn = document.getElementById('mt-pause-btn');
        if (pauseBtn) {
            pauseBtn.textContent = '⏸️ 暫停';
            pauseBtn.classList.remove('is-paused');
        }
        hideTranslatingCard(); // 停止時也移除跑步卡片
    });
};

// 暫停/繼續按鈕（對齊 v1.8.7 toggleBatchPause）
const pauseBtn = document.getElementById('mt-pause-btn');
if (pauseBtn) {
    pauseBtn.onclick = () => {
        chrome.runtime.sendMessage({ action: 'toggleBatchPause' }, (res) => {
            if (res?.status === 'paused') {
                pauseBtn.textContent = '▶️ 繼續';
                pauseBtn.classList.add('is-paused');
            } else {
                pauseBtn.textContent = '⏸️ 暫停';
                pauseBtn.classList.remove('is-paused');
            }
        });
    };
}

document.getElementById('mt-options-btn').onclick = () => {
    chrome.runtime.openOptionsPage();
};

document.getElementById('mt-selection-btn').onclick = () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        chrome.tabs.sendMessage(tabs[0].id, { action: 'toggleSelectionMode' });
    });
};

const resultsContainer = document.getElementById('mt-results-container');

// ── P0 移植：本地圖片上傳與拖放支援 ──
const uploadBtn = document.getElementById('mt-upload-btn');
const fileInput = document.getElementById('mt-file-input');

if (uploadBtn && fileInput) {
    uploadBtn.onclick = () => fileInput.click();
    
    fileInput.onchange = (e) => {
        handleFiles(e.target.files);
    };
}

function handleFiles(files) {
    if (!files || files.length === 0) return;
    
    if (loadingOverlay) loadingOverlay.style.display = 'flex';
    
    const fileArray = Array.from(files);
    const readPromises = fileArray.map(file => {
        return new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = (ev) => resolve({ src: ev.target.result, name: file.name });
            reader.readAsDataURL(file);
        });
    });
    
    Promise.all(readPromises).then(results => {
        if (loadingOverlay) loadingOverlay.style.display = 'none';
        
        // 將讀取的 base64 圖片加入候選清單
        candidateImages = results.map(r => r.src);
        candidateNavLinks = { prev: null, next: null }; // 本地上傳無導航
        
        renderPreviewList();
        // 清空 input 讓同一個檔案可以重複選取
        fileInput.value = '';
    });
}

// 拖放支援
if (resultsContainer) {
    resultsContainer.addEventListener('dragover', (e) => {
        e.preventDefault();
        resultsContainer.style.background = 'rgba(106, 90, 211, 0.05)';
        resultsContainer.style.border = '2px dashed var(--theme-accent)';
    });

    resultsContainer.addEventListener('dragleave', () => {
        resultsContainer.style.background = '';
        resultsContainer.style.border = '';
    });

    resultsContainer.addEventListener('drop', (e) => {
        e.preventDefault();
        resultsContainer.style.background = '';
        resultsContainer.style.border = '';
        handleFiles(e.dataTransfer.files);
    });
}

document.getElementById('mt-clear-btn').onclick = () => clearPreviewList();
document.getElementById('mt-back-btn').onclick = () => clearPreviewList();
document.getElementById('mt-select-all-btn').onclick = () => {
    const allCheckboxes = resultsContainer.querySelectorAll('.mt-preview-checkbox');
    const allChecked = Array.from(allCheckboxes).every(cb => cb.checked);
    allCheckboxes.forEach(cb => { cb.checked = !allChecked; });
    updateBatchCount();
};

document.getElementById('mt-batch-trans-btn').onclick = () => {
    const selectedCheckboxes = resultsContainer.querySelectorAll('.mt-preview-checkbox:checked');
    const selectedIds = Array.from(selectedCheckboxes).map(cb => cb.dataset.index);
    const selectedUrls = selectedIds.map(idx => ({
        id: candidateImages[idx].id || Date.now() + idx,
        src: candidateImages[idx].src || candidateImages[idx]
    }));

    if (selectedUrls.length === 0) {
        alert("請至少選取一張圖片！");
        return;
    }

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tabId = tabs[0]?.id || 'current';
        // 發送給背景以啟動新分頁
        chrome.runtime.sendMessage({
            action: 'START_MANGA_BATCH_PC_MODE',
            payload: {
                tabId: tabId,
                windowId: tabs[0]?.windowId,
                images: selectedUrls,
                navLinks: candidateNavLinks, // 傳入導航連結，供結果頁顯示上下一話按鈕
                mangaKey: currentMangaKey    // 傳入選擇的詞庫 key
            }
        });
        
        // 顯示停止按鈕
        document.getElementById('mt-stop-btn').style.display = 'flex';
        document.getElementById('mt-start-btn').style.display = 'none';
        
        // 隱藏選圖清單，改顯示跑步動畫卡片
        document.querySelector('.mt-batch-controls').style.display = 'none';
        document.querySelector('.mt-main-actions').style.display = 'flex';
        showTranslatingCard(selectedUrls.length);
    });
};

function clearPreviewList() {
    resultsContainer.innerHTML = '';
    document.querySelector('.mt-batch-controls').style.display = 'none';
    document.querySelector('.mt-main-actions').style.display = 'flex';
    candidateImages = [];
}

/**
 * showTranslatingCard — 在 mt-results-container 顯示帶跑步動畫的「翻譯進行中」卡片
 * 對齊 V1.8.6 showLoadingCard 的視覺效果
 */
function showTranslatingCard(imgCount = 0) {
    // 先清空容器（移除勾選清單）
    resultsContainer.innerHTML = '';
    candidateImages = [];

    const card = document.createElement('div');
    card.id = 'mt-translating-card';
    card.style.cssText = `
        display: flex; flex-direction: column; align-items: center; justify-content: center;
        padding: 28px 16px; gap: 12px;
        background: rgba(255,255,255,0.6);
        border-radius: 12px; margin: 12px;
        border: 1px solid rgba(0,0,0,0.06);
        animation: fadeIn 0.3s ease;
    `;

    // 使用 createElement 建立圖片元素，避免 innerHTML 設定 style background url 時被 CSP 阻擋
    let animEl;
    if (currentTheme === 'priconne') {
        const sprite = PRICONNE_LOADING_SPRITES[Math.floor(Math.random() * PRICONNE_LOADING_SPRITES.length)];
        const url = chrome.runtime.getURL(`assets/loading_priconne/${sprite.file}`);
        animEl = document.createElement('img');
        animEl.src = url;
        animEl.alt = "翻譯中...";
        animEl.style.cssText = `
            width: 96px; height: auto;
            image-rendering: pixelated;
            margin: 0 auto;
        `;
    } else {
        const animUrl = chrome.runtime.getURL(`assets/running/${RUNNING_ANIMS[Math.floor(Math.random() * RUNNING_ANIMS.length)]}`);
        animEl = document.createElement('img');
        animEl.src = animUrl;
        animEl.alt = "翻譯中...";
        animEl.style.cssText = "width:90px; height:auto; border-radius:50%; box-shadow: 0 4px 15px rgba(0,0,0,0.1);";
    }

    const textEl = document.createElement('div');
    textEl.style.cssText = "font-size:13px; font-weight:600; color:#666; text-align:center;";
    textEl.innerHTML = `
        正在翻譯 ${imgCount} 張圖片...<br>
        <span style="font-size:11px; color:#999;">結果將顯示於新分頁</span>
    `;

    card.appendChild(animEl);
    card.appendChild(textEl);
    resultsContainer.appendChild(card);
}

/** hideTranslatingCard — 移除進行中卡片 */
function hideTranslatingCard() {
    const old = document.getElementById('mt-translating-card');
    if (old) old.remove();
}

// ── 【缺口A移植】拖曳排序所需狀態變數 ──
let _draggedItem = null;
let _draggedIndex = -1;
let _lastDragTarget = null;

function renderPreviewList() {
    resultsContainer.innerHTML = '';
    document.querySelector('.mt-main-actions').style.display = 'none';
    document.querySelector('.mt-batch-controls').style.display = 'block';

    const listContainer = document.createElement('div');
    listContainer.className = 'mt-preview-list';

    candidateImages.forEach((imgObj, index) => {
        const src = imgObj.src || imgObj;
        const item = document.createElement('div');
        item.className = 'mt-preview-item';
        item.setAttribute('draggable', true);
        item.dataset.index = index;

        // 拖曳把手
        const handle = document.createElement('div');
        handle.className = 'mt-preview-drag-handle';
        handle.innerHTML = '☰';
        handle.style.cssText = 'cursor: grab; padding: 0 6px; color: #aaa; font-size: 14px; user-select: none; flex-shrink: 0;';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'mt-preview-checkbox';
        checkbox.checked = true;
        checkbox.dataset.index = index;

        const previewImg = document.createElement('img');
        previewImg.className = 'mt-preview-img';
        previewImg.src = src;
        previewImg.title = '點擊放大';
        previewImg.style.cursor = 'zoom-in';

        const info = document.createElement('div');
        info.className = 'mt-preview-info';
        info.style.cssText = 'font-size: 11px; padding-left: 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1;';
        // 【缺口I改善】顯示真實檔名（從 URL 解析）
        let filename = `圖片 ${index + 1}`;
        try {
            const urlObj = new URL(src);
            const pathName = urlObj.pathname.split('/').pop();
            if (pathName && pathName.length > 1) filename = decodeURIComponent(pathName);
        } catch (e) {}
        info.textContent = filename;
        info.title = filename;

        item.appendChild(handle);
        item.appendChild(checkbox);
        item.appendChild(previewImg);
        item.appendChild(info);

        item.onclick = (e) => {
            if (e.target !== checkbox && e.target !== previewImg && !e.target.classList.contains('mt-preview-drag-handle')) {
                checkbox.checked = !checkbox.checked;
                updateBatchCount();
            }
        };
        checkbox.onchange = updateBatchCount;

        // 【缺口H移植】縮圖點擊 → 燈箱
        previewImg.addEventListener('click', (e) => {
            e.stopPropagation();
            showLightbox(src);
        });

        // 【缺口A移植】拖曳事件
        item.addEventListener('dragstart', (e) => {
            _draggedItem = item;
            _draggedIndex = index;
            _lastDragTarget = null;
            e.dataTransfer.effectAllowed = 'move';
            setTimeout(() => item.classList.add('dragging'), 0);
        });
        item.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            const target = e.target.closest('.mt-preview-item');
            if (target === _lastDragTarget) return;
            if (_lastDragTarget) _lastDragTarget.classList.remove('drag-over-top', 'drag-over-bottom');
            _lastDragTarget = target;
            if (target && target !== _draggedItem) {
                const rect = target.getBoundingClientRect();
                target.classList.add(e.clientY < rect.top + rect.height / 2 ? 'drag-over-top' : 'drag-over-bottom');
            }
        });
        item.addEventListener('drop', (e) => {
            e.stopPropagation();
            const target = e.target.closest('.mt-preview-item');
            if (!target || target === _draggedItem) return;
            const targetIndex = parseInt(target.dataset.index);
            const rect = target.getBoundingClientRect();
            const insertBefore = e.clientY < rect.top + rect.height / 2;
            const movedItem = candidateImages.splice(_draggedIndex, 1)[0];
            let newIndex = targetIndex;
            if (_draggedIndex < targetIndex) newIndex = targetIndex - 1;
            if (!insertBefore) newIndex += 1;
            candidateImages.splice(newIndex, 0, movedItem);
            renderPreviewList();
        });
        item.addEventListener('dragend', () => {
            if (_lastDragTarget) _lastDragTarget.classList.remove('drag-over-top', 'drag-over-bottom');
            if (_draggedItem) _draggedItem.classList.remove('dragging');
            _draggedItem = null;
            _draggedIndex = -1;
            _lastDragTarget = null;
        });

        listContainer.appendChild(item);
    });

    resultsContainer.appendChild(listContainer);
    updateBatchCount();
}

// 【缺口H移植】燈箱大圖函式
function showLightbox(src) {
    const box = document.createElement('div');
    box.id = 'mt-lightbox';
    box.style.cssText = 'position: fixed; inset: 0; background: rgba(0,0,0,0.85); display: flex; align-items: center; justify-content: center; z-index: 9999; cursor: zoom-out;';
    const img = document.createElement('img');
    img.src = src;
    img.style.cssText = 'max-width: 95vw; max-height: 95vh; object-fit: contain; border-radius: 4px; box-shadow: 0 8px 32px rgba(0,0,0,0.5);';
    box.appendChild(img);
    document.body.appendChild(box);

    const handleEsc = (e) => { if (e.key === 'Escape') closeLightbox(); };
    const closeLightbox = () => {
        box.remove();
        document.removeEventListener('keydown', handleEsc);
    };
    box.addEventListener('click', closeLightbox);
    document.addEventListener('keydown', handleEsc);
}

function updateBatchCount() {
    const allCheckboxes = resultsContainer.querySelectorAll('.mt-preview-checkbox');
    const checked = Array.from(allCheckboxes).filter(cb => cb.checked).length;
    
    const transBtn = document.getElementById('mt-batch-trans-btn');
    if (transBtn) {
        transBtn.innerHTML = `翻譯所選 (${checked}張) · 開啟新分頁`;
    }

    const selectAllBtn = document.getElementById('mt-select-all-btn');
    if (selectAllBtn) {
        selectAllBtn.textContent = (checked === allCheckboxes.length && checked > 0) ? '取消全選' : '全選';
    }
}

// =====================================================
// 小說模式 & 詞彙庫 Toggle 初始化與事件綁定
// =====================================================
const novelModeToggle = document.getElementById('mt-novel-mode-toggle');
const globalGlossaryToggle = document.getElementById('mt-global-glossary-toggle');

// 💡 分頁個別綁定 (Tab-Bound) 輔助函式：根據當前活躍分頁同步 toggle UI
async function updateNovelModeToggleForCurrentTab() {
    if (!novelModeToggle) return;
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
        if (!tabs[0]) return;
        const tabId = tabs[0].id;
        const novelModeTabs = await state.get('novelModeTabs', {});
        const isEnabled = !!novelModeTabs[tabId];
        novelModeToggle.checked = isEnabled;
        if (novelRetryAllBtn) {
            novelRetryAllBtn.style.display = isEnabled ? 'inline-block' : 'none';
        }
    });
}

if (novelModeToggle) {
    // 1. 初始化載入時同步當前活躍分頁狀態
    updateNovelModeToggleForCurrentTab();

    // 2. 監聽當前分頁切換與更新事件，自動同步 toggle UI
    chrome.tabs.onActivated.addListener(updateNovelModeToggleForCurrentTab);
    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
        if (changeInfo.status === 'complete') {
            updateNovelModeToggleForCurrentTab();
        }
    });

    // 3. toggle UI 變更事件處理
    novelModeToggle.addEventListener('change', async () => {
        const isEnabled = novelModeToggle.checked;
        if (novelRetryAllBtn) {
            novelRetryAllBtn.style.display = isEnabled ? 'inline-block' : 'none';
        }
        
        chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
            if (!tabs[0]) return;
            const tabId = tabs[0].id;

            // 原子化寫入 novelModeTabs[tabId]
            await state.update('novelModeTabs', (current = {}) => {
                const next = { ...current };
                if (isEnabled) {
                    let origin = true;
                    try {
                        if (tabs[0].url) {
                            origin = new URL(tabs[0].url).origin;
                        }
                    } catch (e) {
                        console.error('[Sidepanel] 無法解析當前分頁 URL 網域:', e);
                    }
                    next[tabId] = origin;
                } else {
                    delete next[tabId]; // 設為 false 時可直接 delete，省空間
                }
                return next;
            });
            console.log(`[Sidepanel] 分頁 ${tabId} 小說模式:`, isEnabled ? '開啟' : '關閉');

            // 對齊 v1.8.7：切換開關即觸發或停止翻譯
            if (isEnabled) {
                chrome.runtime.sendMessage({ action: 'prepareTab', tabId }, (prep) => {
                    if (!prep || !prep.ready) {
                        alert('網頁環境啟動失敗，請重新整理網頁。');
                        novelModeToggle.checked = false;
                        state.update('novelModeTabs', (current = {}) => {
                            const next = { ...current };
                            delete next[tabId];
                            return next;
                        });
                        return;
                    }
                    chrome.tabs.sendMessage(tabId, { action: 'translateNovelPage' });
                });
            } else {
                chrome.runtime.sendMessage({ action: 'abortNovelTranslation', tabId });
                state.set('isStopping', true);
            }
        });
    });
}

if (globalGlossaryToggle) {
    state.get('globalGlossaryEnabled', true).then(val => {
        globalGlossaryToggle.checked = (val !== false);
    });
    globalGlossaryToggle.addEventListener('change', async () => {
        await state.set('globalGlossaryEnabled', globalGlossaryToggle.checked);
        console.log('[Sidepanel] 詞彙庫:', globalGlossaryToggle.checked ? '啟用' : '停用');
    });
}

if (novelRetryAllBtn) {
    novelRetryAllBtn.onclick = () => {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (!tabs[0]) return;
            const tabId = tabs[0].id;
            chrome.tabs.sendMessage(tabId, { action: 'retryAllFailed' });
            console.log('[Sidepanel] 已發送重試所有失敗小說段落訊息給 tab:', tabId);
        });
    };
}

// 初始化載入
updateQuotaUI();
refreshGlossaryStatus();
