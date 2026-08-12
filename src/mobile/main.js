import { log } from '../utils/logger.js';

// 全域狀態
let sourceTabId = null;
let foundImages = [];
let foundNavLinks = null;  // 儲存上/下話連結
let selectedIndices = new Set();

// UI 元素
const statusBar = document.getElementById('status-bar');
const imageGrid = document.getElementById('image-grid');
const imageCountBadge = document.getElementById('image-count-badge');
const btnSelectAll = document.getElementById('btn-select-all');
const btnRefresh = document.getElementById('btn-refresh');
const btnTranslate = document.getElementById('btn-start-translate');
const selectedCountText = document.getElementById('selected-count');
const btnOptions = document.getElementById('btn-open-options');

/**
 * 初始化
 */
async function init() {
    log.info('Mobile-Panel', 'Initializing mobile panel main...');
    
    // 1. 從 URL 獲取 sourceTabId
    const params = new URLSearchParams(window.location.search);
    sourceTabId = parseInt(params.get('sourceTabId'));

    if (!sourceTabId) {
        updateStatus('❌ 錯誤：未找到來源分頁 ID', true);
        return;
    }

    // 2. 綁定按鈕事件
    btnRefresh.addEventListener('click', () => scanImages());
    btnSelectAll.addEventListener('click', () => toggleSelectAll());
    btnTranslate.addEventListener('click', () => startTranslation());
    btnOptions.addEventListener('click', () => {
        chrome.tabs.create({ url: chrome.runtime.getURL('src/options/index.html') });
    });

    // 3. 綁定行動版「⚡ 啟動串聯流式閱讀」主動按鈕
    const btnStreamLarge = document.getElementById('btn-stream-reader-large');
    if (btnStreamLarge) {
        btnStreamLarge.addEventListener('click', async () => {
            if (!sourceTabId) return;
            btnStreamLarge.disabled = true;
            const originalText = btnStreamLarge.textContent;
            btnStreamLarge.textContent = '⏳ 正在讀取 N網/E網 媒體庫...';

            const unlockTimer = setTimeout(() => {
                btnStreamLarge.disabled = false;
                btnStreamLarge.textContent = originalText;
            }, 5000);

            chrome.tabs.sendMessage(sourceTabId, { action: 'extractNEMetadata' }, async (response) => {
                clearTimeout(unlockTimer);
                btnStreamLarge.disabled = false;
                btnStreamLarge.textContent = originalText;

                if (chrome.runtime.lastError || !response || !response.success || !response.data) {
                    alert('❌ 無法觸發串流閱讀：請確認您正處於 N網或 E網 的漫畫詳情首頁！');
                    return;
                }

                // 成功獲取媒體庫數據，寫入本地 storage 並開啟 stream-reader
                await chrome.storage.local.set({ mt_current_stream: response.data });
                chrome.tabs.create({ url: chrome.runtime.getURL('src/reader/stream-reader.html') });
            });
        });
    }

    // 4. 執行第一次掃描
    scanImages();
}

function injectMobileStreamBtn() {
    const btnSelectAll = document.getElementById('btn-select-all');
    if (!btnSelectAll || document.getElementById('btn-stream-read')) return;

    const btnStream = document.createElement('button');
    btnStream.id = 'btn-stream-read';
    btnStream.className = 'text-btn';
    btnStream.style.color = '#34c759'; // 美麗的綠色
    btnStream.style.fontWeight = 'bold';
    btnStream.textContent = '⚡ 串聯流式閱讀';
    
    btnStream.addEventListener('click', async () => {
        if (!sourceTabId) return;
        btnStream.disabled = true;
        btnStream.textContent = '⏳ 讀取中...';

        const unlockTimer = setTimeout(() => {
            btnStream.disabled = false;
            btnStream.textContent = '⚡ 串聯流式閱讀';
        }, 5000);

        chrome.tabs.sendMessage(sourceTabId, { action: 'extractNEMetadata' }, async (response) => {
            clearTimeout(unlockTimer);
            btnStream.disabled = false;
            btnStream.textContent = '⚡ 串聯流式閱讀';

            if (chrome.runtime.lastError || !response || !response.success || !response.metadata) {
                alert('無法自來源網頁提取漫畫資訊，請確保來源網頁是在 N/E 網的漫畫詳情首頁！');
                return;
            }
            
            await chrome.storage.local.set({ mt_current_stream: response.metadata });
            const readerUrl = chrome.runtime.getURL('src/reader/stream-reader.html');
            chrome.tabs.create({ url: readerUrl });
        });
    });

    btnSelectAll.parentNode.insertBefore(btnStream, btnSelectAll.nextSibling);
}

/**
 * 掃描來源頁面的圖片
 */
async function scanImages() {
    updateStatus('正在掃描來源分頁的圖片...');
    imageGrid.innerHTML = '<div class="empty-msg">掃描中...</div>';
    
    try {
        // 向漫畫頁面發送 crawlImages 請求
        const response = await chrome.tabs.sendMessage(sourceTabId, { action: 'crawlImages' });
        
        if (response && response.images) {
            foundImages = response.images;
            foundNavLinks = response.navLinks || null;  // 同步儲存上/下話連結
            renderImageGrid();
            updateStatus(`掃描完成，找到 ${foundImages.length} 張圖片`);
        } else {
            updateStatus('未找到圖片，請確認該頁面是否包含漫畫圖片', true);
            imageGrid.innerHTML = '<div class="empty-msg">未找到圖片</div>';
        }
    } catch (err) {
        log.error('Mobile-Panel', 'Scan failed', err);
        updateStatus('❌ 掃描失敗：請確認漫畫分頁是否已關閉或重新整理', true);
        imageGrid.innerHTML = '<div class="empty-msg">掃描失敗</div>';
    }
}

/**
 * 渲染圖片格線
 */
function renderImageGrid() {
    imageGrid.innerHTML = '';
    imageCountBadge.textContent = foundImages.length;
    selectedIndices.clear();

    if (foundImages.length === 0) {
        imageGrid.innerHTML = '<div class="empty-msg">未找到圖片</div>';
        updateUIState();
        return;
    }

    foundImages.forEach((img, index) => {
        const item = document.createElement('div');
        item.className = 'image-item';
        item.innerHTML = `<img src="${img.src}" loading="lazy">`;
        
        item.addEventListener('click', () => toggleImageSelection(index, item));
        imageGrid.appendChild(item);
    });

    updateUIState();
}

/**
 * 切換圖片選取狀態
 */
function toggleImageSelection(index, element) {
    if (selectedIndices.has(index)) {
        selectedIndices.delete(index);
        element.classList.remove('selected');
    } else {
        selectedIndices.add(index);
        element.classList.add('selected');
    }
    updateUIState();
}

/**
 * 全選/取消全選
 */
function toggleSelectAll() {
    const items = imageGrid.querySelectorAll('.image-item');
    if (selectedIndices.size === foundImages.length) {
        selectedIndices.clear();
        items.forEach(el => el.classList.remove('selected'));
    } else {
        foundImages.forEach((_, i) => selectedIndices.add(i));
        items.forEach(el => el.classList.add('selected'));
    }
    updateUIState();
}

/**
 * 更新 UI 狀態 (按鈕與計數)
 */
function updateUIState() {
    const count = selectedIndices.size;
    selectedCountText.textContent = `(${count})`;
    btnTranslate.disabled = count === 0;
    btnSelectAll.textContent = (count === foundImages.length && count > 0) ? '取消全選' : '全選';
}

/**
 * 更新狀態列
 */
function updateStatus(msg, isError = false) {
    statusBar.textContent = msg;
    statusBar.style.color = isError ? '#ff3b30' : 'inherit';
}

/**
 * 開始翻譯
 * 使用 PC_MODE 讓 background 自動開啟 result.html 顯示結果。
 * 舊的 MOBILE_MODE 會把結果送回 mobile 選圖頁，但該頁沒有接收器，結果永遠不顯示。
 */
/**
 * 開始翻譯
 * 使用 PC_MODE 讓 background 自動開啟 result.html 顯示結果。
 */
async function startTranslation() {
    const selectedImages = Array.from(selectedIndices).map(i => foundImages[i]);
    if (selectedImages.length === 0) return;

    updateStatus(`正在準備翻譯 ${selectedImages.length} 張圖片，即將開啟結果分頁...`);
    btnTranslate.disabled = true;

    // 5 秒超時強制解鎖定時器：防止 Android WebView 凍結導致按鈕永久鎖死
    const autoUnlockTimer = setTimeout(() => {
        btnTranslate.disabled = false;
        updateStatus('⚠️ 操作超時，按鈕已自動解鎖，請重試', true);
    }, 5000);

    chrome.runtime.sendMessage({
        action: 'START_MANGA_BATCH_PC_MODE',
        payload: {
            tabId: sourceTabId,
            images: selectedImages,
            navLinks: foundNavLinks,  // 傳入上/下話連結，讓結果頁顯示導航按鈕
            mobile: true
        }
    }, (response) => {
        clearTimeout(autoUnlockTimer);
        btnTranslate.disabled = false;

        if (chrome.runtime.lastError) {
            updateStatus('❌ 發送失敗: ' + chrome.runtime.lastError.message, true);
            return;
        }
        updateStatus('✅ 翻譯指令已送出，正在開啟結果分頁...');
    });
}

// 行動端頁面解凍與重獲焦點自癒
function setupMobileAutoRecovery() {
    const recoverUI = () => {
        btnTranslate.disabled = selectedIndices.size === 0;
        const btnStream = document.getElementById('btn-stream-read');
        if (btnStream && btnStream.textContent.includes('讀取中')) {
            btnStream.textContent = '⚡ 串聯流式閱讀';
        }
    };

    window.addEventListener('focus', recoverUI);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') recoverUI();
    });
}

setupMobileAutoRecovery();

// 啟動
init();
