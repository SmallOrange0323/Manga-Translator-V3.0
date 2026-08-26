import { state } from '../utils/state.js';
import { getNovelParagraphs, insertPlaceholders, injectNovelBatchResult, translateUIElements, collectFailures, getParagraphText } from './novel-engine.js';
import { toggleSelectionMode, crawlImages, triggerLazyScroll } from './manga-engine.js';
import { log } from '../utils/logger.js';
import { createNovelSessionId } from '../utils/novel-session-id.js';
import { createNovelRehydrateController } from './novel-rehydrate-client.js';

// 本地小說中斷旗標與當前 Session ID
let isNovelTranslationAborted = false;
let currentNovelSessionId = null;
const rehydrateController = createNovelRehydrateController();

/**
 * 啟動電腦版專用 UI 系統
 */
export function initDesktopMode() {
  log.info('Content-Desktop', 'Initializing Desktop Mode...');

  // 監聽背景訊息 (電腦版專屬)
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'translateNovelPage') {
        log.info('Content-Desktop', '收到手動 translateNovelPage 訊息，使 Rehydrate 失效並啟動新翻譯');
        rehydrateController.onManualStart();
        try {
            startNovelTranslation();
            sendResponse({ started: true });
        } catch (e) {
            log.error('Content-Desktop', 'startNovelTranslation 發生錯誤:', e);
            sendResponse({ started: false, error: e.message });
        }
    }

    if (request.action === 'AUTO_TRANSLATE_PAGE') {
        log.info('Content-Desktop', '收到 AUTO_TRANSLATE_PAGE 自動翻譯訊息');
        const autoRes = rehydrateController.handleAutoSignal(() => {
            startNovelTranslation();
        });
        sendResponse(autoRes);
        return false;
    }

    if (request.action === 'abortNovelTranslation') {
        log.info('Content-Desktop', '收到 abortNovelTranslation 訊息:', request);
        if (request.reason === 'navigation' && request.sessionId) {
            // 導航專用 targeted abort：只有目標 sessionId 相符才清理
            const handled = rehydrateController.onTargetedNavigationAbort(
                request.sessionId,
                currentNovelSessionId,
                () => {
                    isNovelTranslationAborted = true;
                    currentNovelSessionId = null;
                    window.mt_currentNovelSessionId = null;
                }
            );
            sendResponse({ ok: true, targeted: true, handled });
            return false;
        }

        // Generic STOP / mode disable: 無條件終止並鎖定 AUTO
        rehydrateController.onGenericStop();
        isNovelTranslationAborted = true;
        currentNovelSessionId = null;
        window.mt_currentNovelSessionId = null;
        sendResponse({ ok: true, generic: true });
        return false;
    }

    if (request.action === 'injectNovelBatchResult') {
        if (isNovelTranslationAborted || !currentNovelSessionId || request.sessionId !== currentNovelSessionId) {
            log.info('Content-Desktop', `小說翻譯已終止或 Session 不匹配 (收到: ${request.sessionId}, 當前: ${currentNovelSessionId})，忽略遲來的 inject 請求`);
            sendResponse({ ignored: true });
            return false;
        }
        log.info('Content-Desktop', `收到譯文批次結果，BatchIndex: ${request.batchIndex}，是否失敗: ${request.isFailed}`);
        injectNovelBatchResult(request.batchIndex, request.translations, request.retryIndices, request.isFailed);
        sendResponse({ ok: true });
    }

    if (request.action === 'retryAllFailed') {
        log.info('Content-Desktop', '收到重試所有失敗段落訊息');
        retryAllFailedNovels();
        sendResponse({ success: true });
    }

    if (request.action === 'collectFailures') {
        const failedCount = collectFailures().length;
        sendResponse({ count: failedCount });
    }

    if (request.action === 'crawlImages') {
        triggerLazyScroll().then(() => {
            const results = crawlImages();
            sendResponse({ 
                images: results.images, 
                navLinks: results.navLinks 
            });
        });
        return true; // 非同步響應
    }

    if (request.action === 'fetchBase64') {
        handleBase64Fetch(request.url, request.maxDim || 0, sendResponse);
        return true; 
    }

    if (request.action === 'toggleSelectionMode') {
        chrome.runtime.sendMessage({ action: 'PRE_CAPTURE_FOR_SELECTION' }, (response) => {
            log.info('Content-Desktop', 'Pre-capture response received', response);
            toggleSelectionMode();
        });
        sendResponse({ started: true });
    }

    if (request.action === 'TITLE_DETECTED') {
        log.info('Content-Desktop', `當前作品已識別：${request.payload.displayName}`);
    }

    if (request.action === 'ping') {
        sendResponse({ pong: true });
    }
  });

  log.info('Content-Desktop', 'Desktop Mode initialized. 啟動小說頁面 Rehydrate 檢測...');

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
          log.info('Content-Desktop', `已成功重新連接至既有小說 Session: ${sessId}`);
      },
      onSessionDetachedFn: () => {
          currentNovelSessionId = null;
          window.mt_currentNovelSessionId = null;
      }
  });
}

function handleBase64Fetch(url, maxDim, sendResponse) {
    if (!/^(https?:|blob:|data:)/i.test(url)) {
        sendResponse({ error: "Blocked: unsupported URL protocol" });
        return;
    }
    fetch(url)
        .then(res => res.blob())
        .then(blob => {
            if (!maxDim || maxDim <= 0) {
                const reader = new FileReader();
                reader.onloadend = () => sendResponse({ base64: reader.result.split(',')[1] });
                reader.onerror = () => sendResponse({ error: "FileReader failed" });
                reader.readAsDataURL(blob);
                return;
            }
            
            // 縮圖邏輯
            createImageBitmap(blob).then(bitmap => {
                let width = bitmap.width;
                let height = bitmap.height;
                if (width > maxDim || height > maxDim) {
                    if (width > height) {
                        height = Math.round((height * maxDim) / width);
                        width = maxDim;
                    } else {
                        width = Math.round((width * maxDim) / height);
                        height = maxDim;
                    }
                }
                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(bitmap, 0, 0, width, height);
                
                const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
                sendResponse({ base64: dataUrl.split(',')[1] });
                bitmap.close();
            }).catch(err => {
                // 備援：原圖轉 base64
                const reader = new FileReader();
                reader.onloadend = () => sendResponse({ base64: reader.result.split(',')[1] });
                reader.readAsDataURL(blob);
            });
        })
        .catch(err => sendResponse({ error: err.message }));
}

function startNovelTranslation() {
    log.info('Content-Desktop', '執行 startNovelTranslation...');
    isNovelTranslationAborted = false;
    const paragraphs = getNovelParagraphs();
    log.info('Content-Desktop', `找到 ${paragraphs.length} 個段落`);
    if (paragraphs.length === 0) return;
    
    insertPlaceholders(paragraphs);
    log.info('Content-Desktop', '佔位符插入完成');
    
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
            log.warn('Content-Desktop', `忽略過期或不匹配的 BEGIN_NOVEL_SESSION ACK (當前: ${currentNovelSessionId}, 收到: ${response?.sessionId})`);
            return;
        }
        if (response && response.ok) {
            log.info('Content-Desktop', `Novel Session 已在背景註冊: ${newSessionId}，準備提交 Durable Job...`);
            
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
                    log.info('Content-Desktop', `Durable Novel Job 提交成功 (${items.length} 段落)，背景已接管執行`);
                    // 啟動全網頁 UI 翻譯
                    translateUIElements();
                } else {
                    log.error('Content-Desktop', 'Durable Novel Job 提交失敗:', submitRes);
                }
            });
        } else {
            log.error('Content-Desktop', 'Novel Session 註冊失敗:', response);
        }
    });
}

/**
 * 重試所有翻譯失敗的段落，透過 SUBMIT_NOVEL_JOB (kind: 'retry') 提交背景
 */
function retryAllFailedNovels() {
    if (!currentNovelSessionId) {
        log.warn('Content-Desktop', '無當前活躍 Session，無法重試');
        return;
    }
    const failedIndices = collectFailures();
    if (failedIndices.length === 0) {
        log.info('Content-Desktop', '無任何失敗段落需要重試');
        return;
    }
    
    log.info('Content-Desktop', `開始重譯所有失敗段落，共 ${failedIndices.length} 段 (Session: ${currentNovelSessionId})`);
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
            log.info('Content-Desktop', `Retry Job 提交成功 (${items.length} 段落)`);
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
            log.error('Content-Desktop', 'Retry Job 提交失敗:', submitRes);
        }
    });
}
