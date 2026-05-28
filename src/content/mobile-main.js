import { log } from '../utils/logger.js';
import { state } from '../utils/state.js';
import { crawlImages } from './manga-engine.js';
import { getNovelParagraphs, insertPlaceholders, injectNovelBatchResult, translateUIElements, collectFailures, getParagraphText } from './novel-engine.js';

// 本地小說批次翻譯拉取佇列
let novelBatchQueue = [];

/**
 * 傳送下一個小說翻譯批次給背景服務，實現拉取式佇列控速
 */
function sendNextNovelBatch() {
    if (novelBatchQueue.length === 0) {
        log.info('Content-Mobile', '所有小說批次已翻譯完成');
        return;
    }
    const batch = novelBatchQueue.shift();
    log.info('Content-Mobile', `發送批次任務 ${batch.batchIndex + 1}/${batch.totalBatches}，段落數: ${batch.texts.length}`);
    chrome.runtime.sendMessage({
        action: 'translateNovelParagraphs',
        batchIndex: batch.batchIndex,
        totalBatches: batch.totalBatches,
        startIdx: batch.startIdx,
        texts: batch.texts,
        retryIndices: batch.retryIndices
    });
}

/**
 * 啟動行動端專用 UI 系統 (Overlay Drawer 模式)
 */
export function initMobileMode() {
  log.info('Content-Mobile', 'Initializing Mobile Overlay Drawer...');

  // 1. 建立 Shadow DOM 容器
  const container = document.createElement('div');
  container.id = 'mt-mobile-root';
  document.body.appendChild(container);
  const shadow = container.attachShadow({ mode: 'open' });

  // 2. 注入所有樣式 (按鈕 + 抽屜面板)
  const style = document.createElement('style');
  style.textContent = `
    :host {
      --edge-blue: #0078d4;
      --bg-acrylic: rgba(255, 255, 255, 0.85);
      --text-main: #242424;
      --radius: 12px;
    }
    @media (prefers-color-scheme: dark) {
      :host {
        --bg-acrylic: rgba(35, 35, 35, 0.9);
        --text-main: #ffffff;
      }
    }

    /* 懸浮按鈕 */
    .trigger-btn {
      position: fixed;
      bottom: 24px;
      right: 24px;
      width: 56px;
      height: 56px;
      border-radius: 28px;
      background: var(--edge-blue);
      box-shadow: 0 4px 16px rgba(0,0,0,0.3);
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      z-index: 2147483646;
      border: none;
      transition: transform 0.2s;
    }
    .trigger-btn:active { transform: scale(0.9); }
    .trigger-btn svg { width: 28px; height: 28px; fill: white; }

    /* 抽屜面板背景遮罩 */
    .drawer-overlay {
      position: fixed;
      top: 0; left: 0; width: 100%; height: 100%;
      background: rgba(0,0,0,0.4);
      z-index: 2147483647;
      opacity: 0;
      visibility: hidden;
      transition: opacity 0.3s;
    }
    .drawer-overlay.active {
      opacity: 1;
      visibility: visible;
    }

    /* 抽屜面板本體 */
    .drawer {
      position: fixed;
      bottom: 0; left: 0; width: 100%;
      height: 70vh;
      background: var(--bg-acrylic);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border-radius: 20px 20px 0 0;
      z-index: 2147483648;
      transform: translateY(100%);
      transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      display: flex;
      flex-direction: column;
      color: var(--text-main);
      box-shadow: 0 -8px 24px rgba(0,0,0,0.2);
    }
    .drawer.active { transform: translateY(0); }

    /* 面板頭部 */
    .drawer-header {
      padding: 16px;
      border-bottom: 1px solid rgba(128,128,128,0.2);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .drawer-header h2 { margin: 0; font-size: 18px; }
    .close-btn { background: none; border: none; color: var(--text-main); font-size: 24px; cursor: pointer; }

    /* 內容區 */
    .drawer-content {
      flex: 1;
      overflow-y: auto;
      padding: 16px;
    }
    .image-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(100px, 1fr));
      gap: 12px;
    }
    .img-item {
      aspect-ratio: 3/4;
      background: rgba(128,128,128,0.1);
      border-radius: 8px;
      overflow: hidden;
      border: 3px solid transparent;
      position: relative;
    }
    .img-item img { width: 100%; height: 100%; object-fit: cover; }
    .img-item.selected { border-color: var(--edge-blue); }
    .img-item.selected::after {
      content: "✓";
      position: absolute; top: 4px; right: 4px;
      background: var(--edge-blue); color: white;
      width: 20px; height: 20px; border-radius: 10px;
      display: flex; align-items: center; justify-content: center;
      font-size: 12px; font-weight: bold;
    }

    /* 底部操作 */
    .drawer-footer {
      padding: 16px;
      /* 修復大平板問題：safe-area-inset-bottom 確保不被系統導覽列遮住 */
      padding-bottom: max(16px, env(safe-area-inset-bottom, 16px));
      border-top: 1px solid rgba(128,128,128,0.2);
    }
    .primary-btn {
      width: 100%;
      background: var(--edge-blue);
      color: white;
      border: none;
      padding: 14px;
      border-radius: 8px;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
    }
    .primary-btn:disabled { opacity: 0.5; }

    /* 狀態日誌面板 */
    .log-panel {
      background: rgba(0,0,0,0.06);
      border-radius: 8px;
      padding: 10px;
      margin-top: 12px;
      font-size: 12px;
      font-family: monospace;
      max-height: 120px;
      overflow-y: auto;
      display: none;
    }
    .log-panel.visible { display: block; }
    .log-entry { padding: 2px 0; line-height: 1.4; }
    .log-entry.ok { color: #22c55e; }
    .log-entry.err { color: #ef4444; }
    .log-entry.info { opacity: 0.7; }
    .log-toggle {
      background: none; border: none;
      font-size: 11px; color: var(--edge-blue);
      cursor: pointer; padding: 4px 0;
      display: block; width: 100%; text-align: right;
    }
  `;
  shadow.appendChild(style);

  // 3. 建立 UI 結構
  const overlay = document.createElement('div');
  overlay.className = 'drawer-overlay';

  const drawer = document.createElement('div');
  drawer.className = 'drawer';
  drawer.innerHTML = `
    <div class="drawer-header">
      <h2>🎌 漫譯 V3 控制台</h2>
      <button class="close-btn">&times;</button>
    </div>
    <div class="drawer-content">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
        <div id="status-text" style="font-size:14px; opacity:0.7;">正在掃描圖片...</div>
        <div class="bulk-actions" style="display:flex; gap:8px;">
          <button id="select-all-btn" style="background:none; border:1px solid var(--edge-blue); color:var(--edge-blue); font-size:12px; padding:4px 8px; border-radius:4px; cursor:pointer;">全選</button>
          <button id="deselect-all-btn" style="background:none; border:1px solid rgba(128,128,128,0.5); color:var(--text-main); font-size:12px; padding:4px 8px; border-radius:4px; cursor:pointer;">取消</button>
        </div>
      </div>
      <div class="image-grid" id="drawer-grid"></div>
    </div>
    <div class="drawer-footer">
      <button class="primary-btn" id="drawer-submit" disabled>開始翻譯 (0)</button>
      <button class="log-toggle" id="log-toggle-btn">▸ 顯示 API 狀態日誌</button>
      <div class="log-panel" id="api-log-panel"></div>
    </div>
  `;

  const triggerBtn = document.createElement('button');
  triggerBtn.className = 'trigger-btn';
  triggerBtn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M12.87 15.07l-2.54-2.51.03-.03c1.74-1.94 2.98-4.17 3.71-6.53H17V4h-7V2H8v2H1v1.99h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12zm-2.62 7l1.62-4.33L19.12 17h-3.24z"/></svg>`;

  shadow.appendChild(overlay);
  shadow.appendChild(drawer);
  shadow.appendChild(triggerBtn);

  // 4. 邏輯控制
  let foundImages = [];
  let foundNavLinks = { prev: null, next: null };
  const selectedIndices = new Set();

  const toggleDrawer = (active) => {
    overlay.classList.toggle('active', active);
    drawer.classList.toggle('active', active);
    if (active) scanImages();
  };

  const scanImages = () => {
    const statusText = drawer.querySelector('#status-text');
    const grid = drawer.querySelector('#drawer-grid');
    statusText.textContent = '正在掃描圖片...';
    grid.innerHTML = '';
    
    const results = crawlImages();
    const images = results.images;
    const navLinks = results.navLinks;
    foundImages = images;
    foundNavLinks = navLinks;
    
    if (images.length === 0) {
      const paragraphs = getNovelParagraphs();
      if (paragraphs.length > 0) {
        statusText.textContent = `偵測到 ${paragraphs.length} 段小說內容`;
        grid.innerHTML = `
          <div style="grid-column: 1/-1; padding: 40px 20px; text-align: center;">
            <div style="font-size: 48px; margin-bottom: 16px;">📖</div>
            <div style="color: var(--text-main); margin-bottom: 24px;">這看起來是一篇小說，是否要開始翻譯？</div>
            <button id="start-novel-btn" style="background: var(--edge-blue); color: white; border: none; padding: 12px 24px; border-radius: 8px; font-size: 16px; font-weight: 600; cursor: pointer; width: 100%;">
              開始全頁翻譯
            </button>
          </div>
        `;
        grid.querySelector('#start-novel-btn').onclick = () => {
          toggleDrawer(false);
          startNovelTranslation();
        };
      } else {
        statusText.textContent = '未找到可翻譯內容';
      }
      updateFooter();
      return;
    }
    
    statusText.textContent = `找到 ${images.length} 張圖片`;
    
    // 預設全選
    selectedIndices.clear();
    images.forEach((_, i) => selectedIndices.add(i));

    images.forEach((img, i) => {
      const item = document.createElement('div');
      item.className = 'img-item selected'; // 預設加上 selected class
      item.innerHTML = `<img src="${img.src}" loading="lazy" referrerpolicy="no-referrer" style="width:100%; height:100%; object-fit:cover;">`;
      item.onclick = () => {
        if (selectedIndices.has(i)) {
          selectedIndices.delete(i);
          item.classList.remove('selected');
        } else {
          selectedIndices.add(i);
          item.classList.add('selected');
        }
        updateFooter();
      };
      grid.appendChild(item);
    });
    updateFooter();
  };

  const selectAll = () => {
    foundImages.forEach((_, i) => selectedIndices.add(i));
    drawer.querySelectorAll('.img-item').forEach(el => el.classList.add('selected'));
    updateFooter();
  };

  const deselectAll = () => {
    selectedIndices.clear();
    drawer.querySelectorAll('.img-item').forEach(el => el.classList.remove('selected'));
    updateFooter();
  };

  const updateFooter = () => {
    const btn = drawer.querySelector('#drawer-submit');
    btn.disabled = selectedIndices.size === 0;
    btn.textContent = `開始翻譯 (${selectedIndices.size})`;
  };

  // 狀態日誌輔助函式
  const logPanel = drawer.querySelector('#api-log-panel');
  const logToggleBtn = drawer.querySelector('#log-toggle-btn');
  logToggleBtn.onclick = () => {
    const visible = logPanel.classList.toggle('visible');
    logToggleBtn.textContent = visible ? '▾ 隱藏 API 狀態日誌' : '▸ 顯示 API 狀態日誌';
  };
  function appendLog(msg, type = 'info') {
    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;
    entry.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    logPanel.appendChild(entry);
    logPanel.scrollTop = logPanel.scrollHeight;
    // 有錯誤時自動展開
    if (type === 'err' && !logPanel.classList.contains('visible')) {
      logPanel.classList.add('visible');
      logToggleBtn.textContent = '▾ 隱藏 API 狀態日誌';
    }
  }

  // 事件綁定
  triggerBtn.onclick = () => toggleDrawer(true);
  overlay.onclick = () => toggleDrawer(false);
  drawer.querySelector('.close-btn').onclick = () => toggleDrawer(false);
  drawer.querySelector('#select-all-btn').onclick = selectAll;
  drawer.querySelector('#deselect-all-btn').onclick = deselectAll;
  
  drawer.querySelector('#drawer-submit').onclick = () => {
    const selected = Array.from(selectedIndices).map(i => foundImages[i]);
    if (selected.length === 0) return;
    
    appendLog(`準備送出 ${selected.length} 張圖片至 API...`, 'info');
    toggleDrawer(false);
    chrome.runtime.sendMessage({ 
      action: 'START_MANGA_BATCH_PC_MODE', 
      payload: { 
        images: selected,
        navLinks: foundNavLinks,
        mobile: true
      } 
    }, (resp) => {
      if (chrome.runtime.lastError) {
        appendLog('❌ 送出失敗: ' + chrome.runtime.lastError.message, 'err');
      } else {
        appendLog('✅ 已送出，等待翻譯回應...', 'ok');
      }
      // 重新打開抽屜以顯示狀態
      toggleDrawer(true);
    });
  };

  // 監聽背景訊息 (支援小說模式 + API 狀態回報)
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'translateNovelPage' || request.action === 'AUTO_TRANSLATE_PAGE') {
        startNovelTranslation();
        sendResponse({ started: true });
        return false;
    }

    if (request.action === 'injectNovelBatchResult') {
        log.info('Content-Mobile', `收到譯文批次結果，BatchIndex: ${request.batchIndex}，是否失敗: ${request.isFailed}`);
        injectNovelBatchResult(request.batchIndex, request.translations, request.retryIndices, request.isFailed);
        sendNextNovelBatch(); // 注入完畢，主動拉取下一批！
        sendResponse({ ok: true });
        return false;
    }

    if (request.action === 'retryAllFailed') {
        log.info('Content-Mobile', '收到重試所有失敗段落訊息');
        retryAllFailedNovels();
        sendResponse({ success: true });
        return false;
    }

    if (request.action === 'collectFailures') {
        const failedCount = collectFailures().length;
        sendResponse({ count: failedCount });
        return false;
    }

    if (request.action === 'crawlImages') {
        const results = crawlImages();
        sendResponse({ 
            images: results.images, 
            navLinks: results.navLinks 
        });
        return false;
    }

    // [新增] 接收背景廣播的 API 狀態訊息，顯示在行動端日誌面板
    if (request.action === 'TRANSLATION_STATUS') {
        const { type, msg } = request.payload || {};
        appendLog(msg || '（無說明）', type === 'error' ? 'err' : type === 'success' ? 'ok' : 'info');
        return false;
    }

    return false; // 明確標示同步回應
  });

  function startNovelTranslation() {
    const paragraphs = getNovelParagraphs();
    if (paragraphs.length === 0) return;
    
    // 清除舊狀態，準備新翻譯
    chrome.storage.local.set({ 
        novelResults: [],
        novelQueue: [],
        isProcessingNovel: false 
    }, () => {
        insertPlaceholders(paragraphs);
        
        // 讀取 batchSize (預設 50)
        const BATCH_SIZE = window.mt_currentNovelBatchSize || 50;
        
        // 劃分批次，排入 novelBatchQueue
        novelBatchQueue = [];
        const totalBatches = Math.ceil(paragraphs.length / BATCH_SIZE);
        
        for (let b = 0; b < totalBatches; b++) {
            const start = b * BATCH_SIZE;
            const end = Math.min(start + BATCH_SIZE, paragraphs.length);
            
            const batchTexts = paragraphs.slice(start, end).map((p, offset) => {
                const globalIdx = start + offset;
                return getParagraphText(globalIdx);
            });
            
            novelBatchQueue.push({
                batchIndex: b,
                totalBatches,
                startIdx: start,
                texts: batchTexts
            });
        }
        
        // 啟動首批拉取
        sendNextNovelBatch();
        // 啟動全網頁 UI 翻譯
        translateUIElements();
    });
  }

  /**
   * 重試所有翻譯失敗的段落，利用同一個佇列機制控速
   */
  function retryAllFailedNovels() {
      const failedIndices = collectFailures();
      if (failedIndices.length === 0) {
          log.info('Content-Mobile', '無任何失敗段落需要重試');
          return;
      }
      
      log.info('Content-Mobile', `開始重譯所有失敗段落，共 ${failedIndices.length} 段`);
      
      // 將所有失敗的段落標記為翻譯中 ⏳
      failedIndices.forEach(idx => {
          const container = document.querySelector(`.mt-novel-trans[data-novel-idx="${idx}"]`);
          if (container) {
              container.dataset.status = 'retrying';
              const textSpan = container.querySelector('span');
              if (textSpan) textSpan.textContent = '⏳ 正在重譯段落...';
              const actions = container.querySelector('.mt-novel-actions');
              if (actions) actions.style.display = 'none';
          }
      });
      
      const BATCH_SIZE = window.mt_currentNovelBatchSize || 50;
      novelBatchQueue = [];
      const totalBatches = Math.ceil(failedIndices.length / BATCH_SIZE);
      
      for (let b = 0; b < totalBatches; b++) {
          const start = b * BATCH_SIZE;
          const end = Math.min(start + BATCH_SIZE, failedIndices.length);
          const batchIndices = failedIndices.slice(start, end);
          
          const batchTexts = batchIndices.map(idx => getParagraphText(idx));
          
          novelBatchQueue.push({
              batchIndex: b,
              totalBatches,
              startIdx: start,
              texts: batchTexts,
              retryIndices: batchIndices
          });
      }
      
      // 啟動重試拉取
      sendNextNovelBatch();
  }

  log.info('Content-Mobile', 'Mobile Overlay Drawer ready.');
}
