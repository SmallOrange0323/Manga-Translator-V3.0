import { log } from '../utils/logger.js';
import { state } from '../utils/state.js';
import { crawlImages, triggerLazyScroll } from './manga-engine.js';
import { getNovelParagraphs, insertPlaceholders, injectNovelBatchResult, translateUIElements, collectFailures, getParagraphText } from './novel-engine.js';
import { extractMangaMetadata } from './n-e-extractor.js';
import { createNovelSessionId } from '../utils/novel-session-id.js';
import { createNovelRehydrateController } from './novel-rehydrate-client.js';

// 本地小說中斷旗標與當前 Session ID
let isNovelTranslationAborted = false;
let currentNovelSessionId = null;
const rehydrateController = createNovelRehydrateController();

/**
 * 啟動行動端專用 UI 系統 (Overlay Drawer 模式)
 */
export function initMobileMode() {
  log.info('Content-Mobile', 'Initializing Mobile Overlay Drawer...');

  // 0. 清除可能殘留的舊版本 Shadow DOM 根節點 (防止重載擴充套件時雙重按鈕並存)
  document.querySelectorAll('#mt-mobile-root').forEach(el => el.remove());

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

    /* 懸浮按鈕 (純圖示本體作為按鈕，無任何外層白底容器) */
    .trigger-btn {
      position: fixed;
      top: 70%;
      right: 0px;
      width: 44px;
      height: 44px;
      background: transparent;
      box-shadow: none;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      z-index: 2147483646;
      border: none;
      padding: 0;
      overflow: visible;
      user-select: none;
      touch-action: none;
      transition: transform 0.25s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.25s ease;
      opacity: 0.95;
    }
    .trigger-btn:active {
      transform: scale(0.92);
    }
    .trigger-btn img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      border-radius: 10px;
      box-shadow: 0 4px 14px rgba(0,0,0,0.35);
      border: 1px solid rgba(0, 0, 0, 0.1);
      pointer-events: none;
      display: block;
    }
    /* 自動靠邊微縮樣式 (Docked Mini Tab) */
    .trigger-btn.is-docked[data-side="right"],
    .trigger-btn.is-docked:not([data-side="left"]) {
      transform: translateX(26px);
      opacity: 0.5;
    }
    .trigger-btn.is-docked[data-side="left"] {
      transform: translateX(-26px);
      opacity: 0.5;
    }
    .trigger-btn:hover {
      opacity: 1;
      transform: translateX(0) scale(1.05);
    }

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
      <button class="primary-btn" id="drawer-stream-btn" style="display:none; background: linear-gradient(135deg, #34c759, #30b04a); margin-bottom: 8px; box-shadow: 0 2px 8px rgba(52,199,89,0.3);">
        ⚡ 啟動串聯流式閱讀 (N網/E網專屬)
      </button>
      <label style="display:flex; align-items:center; gap:6px; font-size:12px; color:var(--text-main); margin-bottom:8px; cursor:pointer; user-select:none;">
        <input type="checkbox" id="drawer-pretranslate-chk" checked style="cursor:pointer;">
        <span>⚡ 連續追漫 (背景自動預翻下一話)</span>
      </label>
      <button class="primary-btn" id="drawer-submit" disabled>開始翻譯 (0)</button>
      <button class="log-toggle" id="log-toggle-btn">▸ 顯示 API 狀態日誌</button>
      <div class="log-panel" id="api-log-panel"></div>
    </div>
  `;

  const triggerBtn = document.createElement('button');
  triggerBtn.className = 'trigger-btn';
  triggerBtn.title = '開啟漫譯控制台';
  
  // 注入高質感和風「漫」字 App 圖示 (滿版作為按鈕本體)
  const iconImg = document.createElement('img');
  iconImg.src = chrome.runtime.getURL('icon128.png');
  iconImg.alt = '漫譯';
  triggerBtn.appendChild(iconImg);

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
        statusText.textContent = `偵測到小說文本 (${paragraphs.length} 段)`;
        drawer.querySelector('#drawer-submit').textContent = `開始小說翻譯 (${paragraphs.length} 段)`;
        drawer.querySelector('#drawer-submit').disabled = false;
        drawer.querySelector('#drawer-submit').onclick = () => {
          toggleDrawer(false);
          startNovelTranslation(paragraphs);
        };
        return;
      }
      statusText.textContent = '未找到可翻譯的漫畫圖片或小說文本';
      drawer.querySelector('#drawer-submit').disabled = true;
      return;
    }
    
    statusText.textContent = `找到 ${images.length} 張圖片 (已過濾雜圖)`;
    images.forEach((img, idx) => {
      const item = document.createElement('div');
      item.className = 'img-item selected';
      selectedIndices.add(idx);
      
      const imgEl = document.createElement('img');
      const imgUrl = img.src || img.url || '';
      imgEl.src = imgUrl;
      imgEl.loading = 'lazy';
      imgEl.referrerPolicy = 'no-referrer';
      imgEl.style.cssText = 'width:100%; height:100%; object-fit:cover; display:block;';
      item.appendChild(imgEl);
      
      item.onclick = () => {
        if (selectedIndices.has(idx)) {
          selectedIndices.delete(idx);
          item.classList.remove('selected');
        } else {
          selectedIndices.add(idx);
          item.classList.add('selected');
        }
        updateFooter();
      };
      grid.appendChild(item);
    });

    // 偵測是否為 N網/E網 詳情頁，若是則顯示「⚡ 啟動串聯流式閱讀」綠色按鈕
    const streamBtn = drawer.querySelector('#drawer-stream-btn');
    if (streamBtn) {
      const curUrl = window.location.href;
      const isNE = curUrl.includes('nhentai.net') || curUrl.includes('e-hentai.org') || curUrl.includes('exhentai.org');
      if (isNE) {
        streamBtn.style.display = 'block';
        streamBtn.onclick = async () => {
          streamBtn.disabled = true;
          const origText = streamBtn.textContent;
          streamBtn.textContent = '⏳ 正在讀取 N/E 媒體庫...';

          const unlockTimer = setTimeout(() => {
            streamBtn.disabled = false;
            streamBtn.textContent = origText;
          }, 5000);

          try {
            const isNH = curUrl.includes('nhentai.net');
            const isEH = curUrl.includes('e-hentai.org') || curUrl.includes('exhentai.org');
            const meta = await extractMangaMetadata(isNH, isEH);
            clearTimeout(unlockTimer);
            streamBtn.disabled = false;
            streamBtn.textContent = origText;

            if (!meta) {
              alert('❌ 無法觸發串流閱讀：請確認您正處於 N網或 E網 的漫畫詳情首頁！');
              return;
            }

            await chrome.storage.local.set({ mt_current_stream: meta });
            const readerUrl = chrome.runtime.getURL('src/reader/stream-reader.html');
            window.open(readerUrl, '_blank');
            toggleDrawer(false);
          } catch (err) {
            clearTimeout(unlockTimer);
            streamBtn.disabled = false;
            streamBtn.textContent = origText;
            alert('❌ 串流閱讀啟動失敗: ' + err.message);
          }
        };
      } else {
        streamBtn.style.display = 'none';
      }
    }

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

  // ── 懸浮按鈕拖曳、自動靠邊與記憶互動 (三重事件保障 Tap 100% 響應) ──
  let isDragMoved = false;
  let startX = 0, startY = 0, initialX = 0, initialY = 0;
  let dockTimer = null;

  // 讀取上次記憶的位置
  try {
    chrome.storage.local.get(['mt_fab_position'], (res) => {
      const pos = res?.mt_fab_position;
      if (pos && typeof pos.topPercent === 'number') {
        const viewportHeight = window.visualViewport?.height || window.innerHeight;
        const targetTop = Math.max(50, Math.min(viewportHeight - 100, (viewportHeight * pos.topPercent) / 100));
        triggerBtn.style.top = `${targetTop}px`;
        triggerBtn.style.bottom = 'auto';

        if (pos.side === 'left') {
          triggerBtn.style.left = '0px';
          triggerBtn.style.right = 'auto';
          triggerBtn.dataset.side = 'left';
        } else {
          triggerBtn.style.right = '0px';
          triggerBtn.style.left = 'auto';
          triggerBtn.dataset.side = 'right';
        }
      }
    });
  } catch (_) {}

  const resetDockTimer = () => {
    triggerBtn.classList.remove('is-docked');
    clearTimeout(dockTimer);
    dockTimer = setTimeout(() => {
      triggerBtn.classList.add('is-docked');
    }, 2000);
  };

  resetDockTimer();

  triggerBtn.onpointerdown = (e) => {
    isDragMoved = false;
    startX = e.clientX;
    startY = e.clientY;

    const rect = triggerBtn.getBoundingClientRect();
    initialX = rect.left;
    initialY = rect.top;

    triggerBtn.classList.remove('is-docked');
    clearTimeout(dockTimer);
  };

  triggerBtn.onpointermove = (e) => {
    if (e.buttons !== 1 && e.pointerType === 'mouse') return;
    if (startX === 0 && startY === 0) return;

    const dx = e.clientX - startX;
    const dy = e.clientY - startY;

    if (Math.hypot(dx, dy) > 15) {
      isDragMoved = true;
      const viewportWidth = window.visualViewport?.width || window.innerWidth;
      const viewportHeight = window.visualViewport?.height || window.innerHeight;

      const newX = Math.max(0, Math.min(viewportWidth - 50, initialX + dx));
      const newY = Math.max(20, Math.min(viewportHeight - 70, initialY + dy));

      triggerBtn.style.left = `${newX}px`;
      triggerBtn.style.top = `${newY}px`;
      triggerBtn.style.right = 'auto';
      triggerBtn.style.bottom = 'auto';
    }
  };

  triggerBtn.onpointerup = (e) => {
    if (isDragMoved) {
      // 拖曳結束：吸附至左側或右側邊緣並持久化
      const viewportWidth = window.visualViewport?.width || window.innerWidth;
      const viewportHeight = window.visualViewport?.height || window.innerHeight;
      const rect = triggerBtn.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;

      const isLeft = centerX < viewportWidth / 2;
      triggerBtn.dataset.side = isLeft ? 'left' : 'right';

      triggerBtn.style.left = isLeft ? '0px' : 'auto';
      triggerBtn.style.right = isLeft ? 'auto' : '0px';

      const topPercent = Math.round((rect.top / viewportHeight) * 100);
      try {
        chrome.storage.local.set({
          mt_fab_position: { side: isLeft ? 'left' : 'right', topPercent }
        });
      } catch (_) {}

      setTimeout(() => { isDragMoved = false; }, 100);
    }
    startX = 0;
    startY = 0;
    resetDockTimer();
  };

  // 處理手勢異常中斷 (如收到電話或滑出視窗)
  triggerBtn.onpointercancel = triggerBtn.onpointerup;

  // 點擊觸發 (原生 click 與 touchend 雙重保證)
  triggerBtn.onclick = (e) => {
    if (isDragMoved) return;
    log.info('Content-Mobile', '點擊懸浮球，開啟控制台抽屜...');
    toggleDrawer(true);
  };

  // 事件綁定
  overlay.onclick = () => toggleDrawer(false);
  drawer.querySelector('.close-btn').onclick = () => toggleDrawer(false);
  drawer.querySelector('#select-all-btn').onclick = selectAll;
  drawer.querySelector('#deselect-all-btn').onclick = deselectAll;

  // 連續追漫 (自動預翻下一話) 狀態同步
  const pretransChk = drawer.querySelector('#drawer-pretranslate-chk');
  if (pretransChk) {
    state.get('autoPretranslateNextChapter', true).then(val => {
      pretransChk.checked = (val !== false);
    });
    pretransChk.onchange = async () => {
      await state.set('autoPretranslateNextChapter', pretransChk.checked);
      log.info('Content-Mobile', `[行動端] 連續追漫開關: ${pretransChk.checked ? '開啟' : '關閉'}`);
    };
  }
  
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
    if (request.action === 'translateNovelPage') {
        log.info('Content-Mobile', '收到手動 translateNovelPage 訊息，使 Rehydrate 失效並啟動新翻譯');
        rehydrateController.supersede();
        try {
            startNovelTranslation();
            sendResponse({ started: true });
        } catch (e) {
            log.error('Content-Mobile', 'startNovelTranslation 發生錯誤:', e);
            sendResponse({ started: false, error: e.message });
        }
        return false;
    }

    if (request.action === 'AUTO_TRANSLATE_PAGE') {
        log.info('Content-Mobile', '收到 AUTO_TRANSLATE_PAGE 自動翻譯訊息');
        if (rehydrateController.isChecking()) {
            log.info('Content-Mobile', '當前正在執行 Page Rehydrate，延遲 AUTO_TRANSLATE_PAGE 處理');
            rehydrateController.setPendingAuto(true);
            sendResponse({ started: false, deferred: true });
            return false;
        }
        try {
            startNovelTranslation();
            sendResponse({ started: true });
        } catch (e) {
            log.error('Content-Mobile', 'startNovelTranslation 發生錯誤:', e);
            sendResponse({ started: false, error: e.message });
        }
        return false;
    }

    if (request.action === 'abortNovelTranslation') {
        log.info('Content-Mobile', '收到 abortNovelTranslation 訊息，終止本地翻譯狀態');
        rehydrateController.supersede();
        isNovelTranslationAborted = true;
        currentNovelSessionId = null;
        window.mt_currentNovelSessionId = null;
        sendResponse({ ok: true });
        return false;
    }

    if (request.action === 'injectNovelBatchResult') {
        if (isNovelTranslationAborted || !currentNovelSessionId || request.sessionId !== currentNovelSessionId) {
            log.info('Content-Mobile', `小說翻譯已終止或 Session 不匹配 (收到: ${request.sessionId}, 當前: ${currentNovelSessionId})，忽略遲來的 inject 請求`);
            sendResponse({ ignored: true });
            return false;
        }
        log.info('Content-Mobile', `收到譯文批次結果，BatchIndex: ${request.batchIndex}，是否失敗: ${request.isFailed}`);
        injectNovelBatchResult(request.batchIndex, request.translations, request.retryIndices, request.isFailed);
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
        triggerLazyScroll().then(() => {
            const results = crawlImages();
            sendResponse({ 
                images: results.images, 
                navLinks: results.navLinks 
            });
        });
        return true; // 非同步
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
    isNovelTranslationAborted = false;
    const paragraphs = getNovelParagraphs();
    if (paragraphs.length === 0) return;
    
    insertPlaceholders(paragraphs);
    
    // 讀取 batchSize (預設 50)
    const BATCH_SIZE = window.mt_currentNovelBatchSize || 50;
    
    // 建立全新 Session ID
    const newSessionId = createNovelSessionId();
    currentNovelSessionId = newSessionId;
    window.mt_currentNovelSessionId = newSessionId;

    // 構造完整 items 陣列 (一次提交完整 Job)
    const items = paragraphs.map((p, idx) => ({
        idx,
        text: getParagraphText(idx)
    }));
    
    // 明確發送 BEGIN_NOVEL_SESSION 註冊新 Session
    chrome.runtime.sendMessage({
        action: 'BEGIN_NOVEL_SESSION',
        sessionId: newSessionId,
        pageUrl: location.href
    }, (response) => {
        if (isNovelTranslationAborted) return;
        if (currentNovelSessionId !== newSessionId || response?.sessionId !== newSessionId) {
            log.warn('Content-Mobile', `忽略過期或不匹配的 BEGIN_NOVEL_SESSION ACK (當前: ${currentNovelSessionId}, 收到: ${response?.sessionId})`);
            return;
        }
        if (response && response.ok) {
            log.info('Content-Mobile', `Novel Session 已在背景註冊: ${newSessionId}，準備提交 Durable Job...`);
            
            // 一次提交完整 Job 給背景 Durable Scheduler
            chrome.runtime.sendMessage({
                action: 'SUBMIT_NOVEL_JOB',
                sessionId: newSessionId,
                pageUrl: location.href,
                kind: 'full',
                batchSize: BATCH_SIZE,
                items
            }, (submitRes) => {
                if (isNovelTranslationAborted || currentNovelSessionId !== newSessionId) return;
                if (submitRes && submitRes.ok) {
                    log.info('Content-Mobile', `Durable Novel Job 提交成功 (${items.length} 段落)，背景已接管執行`);
                    // 啟動全網頁 UI 翻譯
                    translateUIElements();
                } else {
                    log.error('Content-Mobile', 'Durable Novel Job 提交失敗:', submitRes);
                }
            });
        } else {
            log.error('Content-Mobile', 'Novel Session 註冊失敗:', response);
        }
    });
  }

  /**
   * 重試所有翻譯失敗的段落，透過 SUBMIT_NOVEL_JOB (kind: 'retry') 提交背景
   */
  function retryAllFailedNovels() {
      if (!currentNovelSessionId) {
          log.warn('Content-Mobile', '無當前活躍 Session，無法重試');
          return;
      }
      const failedIndices = collectFailures();
      if (failedIndices.length === 0) {
          log.info('Content-Mobile', '無任何失敗段落需要重試');
          return;
      }
      
      log.info('Content-Mobile', `開始重譯所有失敗段落，共 ${failedIndices.length} 段 (Session: ${currentNovelSessionId})`);
      isNovelTranslationAborted = false;
      
      const BATCH_SIZE = window.mt_currentNovelBatchSize || 50;
      const items = failedIndices.map(idx => ({
          idx,
          text: getParagraphText(idx)
      }));

      // 提交 Retry Job 給背景 Durable Scheduler
      chrome.runtime.sendMessage({
          action: 'SUBMIT_NOVEL_JOB',
          sessionId: currentNovelSessionId,
          pageUrl: location.href,
          kind: 'retry',
          batchSize: BATCH_SIZE,
          items
      }, (submitRes) => {
          if (isNovelTranslationAborted || !currentNovelSessionId) return;
          if (submitRes && submitRes.ok) {
              log.info('Content-Mobile', `Retry Job 提交成功 (${items.length} 段落)`);
              // 提交成功後，將所有失敗段落 UI 標記為翻譯中 ⏳
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
          } else {
              log.error('Content-Mobile', 'Retry Job 提交失敗:', submitRes);
          }
      });
  }

  log.info('Content-Mobile', 'Mobile Overlay Drawer ready. 啟動小說頁面 Rehydrate 檢測...');

  // 初始化完成後，自動嘗試從背景恢復既有小說 Session (Reload Rehydrate)
  rehydrateController.attemptRehydrate({
      getParagraphsFn: getNovelParagraphs,
      getParagraphTextFn: getParagraphText,
      insertPlaceholdersFn: insertPlaceholders,
      injectBatchResultFn: injectNovelBatchResult,
      translateUIElementsFn: translateUIElements,
      startNewTranslationFn: startNovelTranslation,
      onSessionAttachedFn: (sessId) => {
          isNovelTranslationAborted = false;
          currentNovelSessionId = sessId;
          window.mt_currentNovelSessionId = sessId;
          log.info('Content-Mobile', `已成功重新連接至既有小說 Session: ${sessId}`);
      },
      onSessionDetachedFn: () => {
          currentNovelSessionId = null;
          window.mt_currentNovelSessionId = null;
      }
  });
}
