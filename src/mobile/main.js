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

    // 3. 執行第一次掃描
    scanImages();
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
async function startTranslation() {
    const selectedImages = Array.from(selectedIndices).map(i => foundImages[i]);
    updateStatus(`正在準備翻譯 ${selectedImages.length} 張圖片，即將開啟結果分頁...`);
    btnTranslate.disabled = true;

    chrome.runtime.sendMessage({
        action: 'START_MANGA_BATCH_PC_MODE',
        payload: {
            tabId: sourceTabId,
            images: selectedImages,
            navLinks: foundNavLinks,  // 傳入上/下話連結，讓結果頁顯示導航按鈕
            mobile: true
        }
    }, (response) => {
        if (chrome.runtime.lastError) {
            updateStatus('❌ 發送失敗: ' + chrome.runtime.lastError.message, true);
            btnTranslate.disabled = false;
            return;
        }
        updateStatus('✅ 翻譯指令已送出，正在開啟結果分頁...');
    });
}

// 啟動
init();
