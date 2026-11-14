import { state } from '../utils/state.js';
import { uploadLocalMangaImages } from '../utils/local-manga-upload.js';
import { initGlossaryModule } from './sidepanel-glossary.js';
import {
    initThemeController,
    updateQuotaUI,
    updateNovelStatus,
    renderTranslatingCard,
    removeTranslatingCard,
    updateBatchCountUI,
    initPreviewAndUpload,
    initSidepanelToggles
} from './sidepanel-ui-helpers.js';

document.getElementById('mt-extension-title').textContent = `漫譯 V${chrome.runtime.getManifest().version}`;

console.log('[Manga Translator V3] Classic Sidepanel Initialized');

// 載入動畫與結果容器元素
const loadingOverlay = document.getElementById('mt-loading-overlay');
const resultsContainer = document.getElementById('mt-results-container');

// 選圖階段暫存變數與作品鍵值
let currentMangaKey = null;
let candidateImages = [];
let isCandidateFromLocalFiles = false;
let candidateNavLinks = { prev: null, next: null }; // 同步儲存導航連結

// 初始化主題控制器、詞庫管理、預覽列表與模式開關
const { getCurrentTheme } = initThemeController();
const { refreshGlossaryStatus } = initGlossaryModule({
    onMangaKeyChange: (key) => {
        currentMangaKey = key;
    }
});
const { renderPreviewList } = initPreviewAndUpload({
    resultsContainer,
    loadingOverlay,
    getCandidateImages: () => candidateImages,
    setCandidateState: ({ images, isLocal, navLinks }) => {
        if (images !== undefined) candidateImages = images;
        if (isLocal !== undefined) isCandidateFromLocalFiles = isLocal;
        if (navLinks !== undefined) candidateNavLinks = navLinks;
    }
});
const {
    updateNovelModeToggleForCurrentTab,
    syncSceneContextUI
} = initSidepanelToggles();

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

    if (changes.enableSceneContext) {
        const sceneContextToggle = document.getElementById('mt-scene-context-toggle');
        if (sceneContextToggle) {
            sceneContextToggle.checked = changes.enableSceneContext.newValue !== false;
        }
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

// 監聽 batchComplete 與配額更新訊息恢復 UI 狀態
chrome.runtime.onMessage.addListener((request) => {
    if (request.action === 'START_TRANSLATING_CARD' || request.action === 'TRANSLATION_DONE') {
        syncCurrentTabState();
    }
    // 配額即時更新
    if (request.action === 'updateTokenDisplay') {
        updateQuotaUI();
    }
});

// 綁定主要按鈕動作
document.getElementById('mt-start-btn').onclick = () => {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
        if (!tabs[0]) return;
        const tabId = tabs[0].id;

        // ── 漫畫模式 ──
        const novelModeTabs = await state.get('novelModeTabs', {});
        const isNovelMode = !!novelModeTabs[tabId];
        if (isNovelMode) {
            alert('目前為小說模式，此按鈕專供漫畫使用。請關閉小說模式後再試。');
            return;
        }

        // 顯示載入動畫
        if (loadingOverlay) loadingOverlay.style.display = 'flex';

        // 先呼叫 prepareTab 確保 Content Script 已注入
        chrome.runtime.sendMessage({ action: 'prepareTab', tabId }, (prep) => {
            if (!prep || !prep.ready) {
                if (loadingOverlay) loadingOverlay.style.display = 'none';
                alert('網頁環境啟動失敗。請確認網頁已載入完成，或嘗試手動重整一次網頁。');
                return;
            }

            let crawlTimeout = setTimeout(() => {
                if (loadingOverlay) loadingOverlay.style.display = 'none';
                alert('網頁請求無回應。請確認網頁沒有變更位址，或嘗試手動重整。');
            }, 8000);

            chrome.tabs.sendMessage(tabId, { action: 'crawlImages' }, (response) => {
                clearTimeout(crawlTimeout);
                if (loadingOverlay) loadingOverlay.style.display = 'none';

                if (chrome.runtime.lastError) {
                    console.error('[Manga][SP] crawlImages 失敗:', chrome.runtime.lastError.message);
                    alert('無法與頁面建立連線 (或網頁目前為行動模式)。詳細錯誤：' + chrome.runtime.lastError.message);
                    return;
                }
                if (response && Array.isArray(response.images)) {
                    candidateImages = response.images;
                    isCandidateFromLocalFiles = false;
                    // 同步儲存導航連結，用於後續批次翻譯時帶入
                    candidateNavLinks = response.navLinks || { prev: null, next: null };
                    if (candidateImages.length === 0) {
                        if (response.error) {
                            alert(response.error);
                            return;
                        }
                        alert('未在此網頁找到候選圖片！\n\n小提醒：部分網站需要往下捲動才會載入圖片，請先捲動網頁後再試一次。');
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
        // 直接強制清除暫停狀態，避免下一次任務一開始就卡在暫停狀態
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

// 暫停/繼續按鈕
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

document.getElementById('mt-clear-btn').onclick = () => clearPreviewList();
document.getElementById('mt-back-btn').onclick = () => clearPreviewList();
document.getElementById('mt-select-all-btn').onclick = () => {
    const allCheckboxes = resultsContainer.querySelectorAll('.mt-preview-checkbox');
    const allChecked = Array.from(allCheckboxes).every(cb => cb.checked);
    allCheckboxes.forEach(cb => { cb.checked = !allChecked; });
    updateBatchCount();
};

/**
 * 在結果容器顯示帶跑步動畫的「翻譯進行中」卡片並清空選圖暫存
 */
function showTranslatingCard(imgCount = 0) {
    candidateImages = [];
    isCandidateFromLocalFiles = false;
    renderTranslatingCard(resultsContainer, getCurrentTheme(), imgCount);
}

/**
 * 移除「翻譯進行中」卡片
 */
function hideTranslatingCard() {
    removeTranslatingCard();
}

/**
 * 更新批次翻譯按鈕所選數量與全選狀態
 */
function updateBatchCount() {
    updateBatchCountUI(resultsContainer);
}

let isStartingBatch = false;
document.getElementById('mt-batch-trans-btn').onclick = async () => {
    if (isStartingBatch) return;
    const button = document.getElementById('mt-batch-trans-btn');
    isStartingBatch = true;
    button.disabled = true;
    try {
        const selectedCheckboxes = resultsContainer.querySelectorAll('.mt-preview-checkbox:checked');
        const selectedIds = Array.from(selectedCheckboxes).map(cb => cb.dataset.index);
        const selectedUrls = selectedIds.map(idx => {
            const image = candidateImages[idx];
            const src = typeof image === 'string' ? image : image?.src;
            if (!src) throw new Error('選圖清單已變更，請重新選取圖片');
            return { id: image.id || crypto.randomUUID(), src };
        });

        if (selectedUrls.length === 0) {
            alert("請至少選取一張圖片！");
            return;
        }

        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const hasDataUrl = selectedUrls.some(image => image.src.startsWith('data:image/'));
        const isLocal = (typeof isCandidateFromLocalFiles !== 'undefined' && isCandidateFromLocalFiles) || (!tab?.id && selectedUrls.every(image => image.src.startsWith('data:image/')));
        if (!isLocal && !tab?.id) throw new Error('找不到來源分頁，請重新開啟漫畫網頁');
        const options = { tabId: isLocal ? null : tab.id, openerTabId: tab?.id, windowId: tab?.windowId,
            navLinks: candidateNavLinks, mangaKey: currentMangaKey, isLocal };
        button.textContent = '正在準備圖片…';
        const response = hasDataUrl
            ? await uploadLocalMangaImages(chrome, selectedUrls, options, (current, total) => {
                button.textContent = `正在傳送圖片 (${current}/${total})…`;
            })
            : await chrome.runtime.sendMessage({
                action: 'START_MANGA_BATCH_PC_MODE',
                payload: { ...options, images: selectedUrls }
            });
        if (response?.status !== 'ok') throw new Error(response?.error || '無法啟動翻譯，請重新載入擴充套件');
        
        // 顯示停止按鈕
        document.getElementById('mt-stop-btn').style.display = 'flex';
        document.getElementById('mt-start-btn').style.display = 'none';
        
        // 隱藏選圖清單，改顯示跑步動畫卡片
        document.querySelector('.mt-batch-controls').style.display = 'none';
        document.querySelector('.mt-main-actions').style.display = 'flex';
        showTranslatingCard(selectedUrls.length);
    } catch (error) {
        alert(`無法開始翻譯：${error.message}`);
    } finally {
        isStartingBatch = false;
        button.disabled = false;
        updateBatchCount();
    }
};

function clearPreviewList() {
    resultsContainer.innerHTML = '';
    document.querySelector('.mt-batch-controls').style.display = 'none';
    document.querySelector('.mt-main-actions').style.display = 'flex';
    candidateImages = [];
    isCandidateFromLocalFiles = false;
}

// =====================================================
// 💡 分頁切換與即時狀態感知器 (Tab Switch Aware Sync)
// 徹底解決：切換到其他漫畫分頁時，按鈕卡在「正在翻譯/停止」的 Bug
// =====================================================
let tabStateRequestId = 0;
async function syncCurrentTabState() {
    // Opening the result tab must not discard selected local images during upload/startup.
    if (isStartingBatch) return;
    const requestId = ++tabStateRequestId;
    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab || !tab.id) return;

        // 1. 刷新該漫畫作品詞庫與情境設定
        refreshGlossaryStatus();
        if (typeof syncSceneContextUI === 'function') syncSceneContextUI();

        // 2. 查詢當前分頁是否正在進行翻譯長任務
        chrome.runtime.sendMessage({
            action: 'CHECK_TAB_TRANSLATION_STATUS',
            payload: { tabId: tab.id }
        }, (response) => {
            if (chrome.runtime.lastError || requestId !== tabStateRequestId || isStartingBatch) return;
            chrome.tabs.query({ active: true, currentWindow: true }, ([current]) => {
                if (requestId !== tabStateRequestId || current?.id !== tab.id || isStartingBatch) return;
                const isTranslating = response?.isTranslating || false;
                const stopBtn = document.getElementById('mt-stop-btn');
                const startBtn = document.getElementById('mt-start-btn');
                const pauseBtn = document.getElementById('mt-pause-btn');

                if (isTranslating) {
                    // 當前分頁正在翻譯中：顯示停止按鈕與跑步卡片
                    if (stopBtn) stopBtn.style.display = 'flex';
                    if (startBtn) startBtn.style.display = 'none';
                    if (pauseBtn) pauseBtn.style.display = 'flex';
                    showTranslatingCard(response.jobInfo?.imgCount || 0);
                } else {
                    // 當前分頁沒有正在進行的翻譯任務：恢復「開始翻譯」按鈕
                    if (stopBtn) stopBtn.style.display = 'none';
                    if (startBtn) startBtn.style.display = 'flex';
                    if (pauseBtn) {
                        pauseBtn.style.display = 'none';
                        pauseBtn.textContent = '⏸️ 暫停';
                        pauseBtn.classList.remove('is-paused');
                    }
                    hideTranslatingCard();
                }
            });
        });
    } catch (e) {
        console.warn('[Sidepanel] syncCurrentTabState error:', e);
    }
}

// 監聽瀏覽器分頁切換
chrome.tabs.onActivated.addListener(() => {
    syncCurrentTabState();
});

// 監聽分頁 URL 變更完成 (例如同一分頁內點擊跳轉到另一本漫畫)
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete' && tab.active) {
        syncCurrentTabState();
    }
});

// 初始化載入
updateQuotaUI();
syncCurrentTabState();

// 綁定串聯流式閱讀按鈕點擊事件
const streamBtn = document.getElementById('mt-stream-read-btn');
if (streamBtn) {
    streamBtn.onclick = () => {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            const tab = tabs[0];
            if (!tab) return;
            streamBtn.innerText = '⏳ 正在讀取詳情...';
            chrome.tabs.sendMessage(tab.id, { action: 'extractNEMetadata' }, async (response) => {
                if (chrome.runtime.lastError || !response || !response.success || !response.metadata) {
                    console.error('[Sidepanel] 讀取 N/E 詳情失敗:', chrome.runtime.lastError?.message || '無回應');
                    alert('無法自當前頁面提取漫畫資訊，請確保您是在 N/E 網的漫畫詳情首頁！');
                    streamBtn.innerText = '📖 串聯流式閱讀';
                    return;
                }

                await chrome.storage.local.set({ mt_current_stream: response.metadata });
                const readerUrl = chrome.runtime.getURL('src/reader/stream-reader.html');
                window.open(readerUrl, '_blank');
                streamBtn.innerText = '📖 串聯流式閱讀';
            });
        });
    };
}
