import { state } from '../utils/state.js';
import { getNovelParagraphs, insertPlaceholders, injectNovelBatchResult, translateUIElements, collectFailures, getParagraphText } from './novel-engine.js';
import { toggleSelectionMode, crawlImages, triggerLazyScroll } from './manga-engine.js';
import { log } from '../utils/logger.js';
import { createNovelSessionId } from '../utils/novel-session-id.js';

// 本地小說批次翻譯拉取佇列、中斷旗標與當前 Session ID
let novelBatchQueue = [];
let isNovelTranslationAborted = false;
let currentNovelSessionId = null;

/**
 * 傳送下一個小說翻譯批次給背景服務，實現拉取式佇列控速
 */
function sendNextNovelBatch() {
    if (isNovelTranslationAborted || !currentNovelSessionId) {
        log.info('Content-Desktop', '小說翻譯已中止或 Session 無效，停止發送後續批次');
        return;
    }
    if (novelBatchQueue.length === 0) {
        log.info('Content-Desktop', '所有小說批次已翻譯完成');
        return;
    }
    const batch = novelBatchQueue.shift();
    log.info('Content-Desktop', `發送批次任務 ${batch.batchIndex + 1}/${batch.totalBatches}，段落數: ${batch.texts.length} (Session: ${batch.sessionId || currentNovelSessionId})`);
    chrome.runtime.sendMessage({
        action: 'translateNovelParagraphs',
        sessionId: batch.sessionId || currentNovelSessionId,
        batchIndex: batch.batchIndex,
        totalBatches: batch.totalBatches,
        startIdx: batch.startIdx,
        texts: batch.texts,
        retryIndices: batch.retryIndices
    });
}

/**
 * 啟動電腦版專用 UI 系統
 */
export function initDesktopMode() {
  log.info('Content-Desktop', 'Initializing Desktop Mode...');

  // 監聽背景訊息 (電腦版專屬)
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'translateNovelPage' || request.action === 'AUTO_TRANSLATE_PAGE') {
        log.info('Content-Desktop', `收到 ${request.action} 訊息，準備啟動翻譯`);
        try {
            startNovelTranslation();
            sendResponse({ started: true });
        } catch (e) {
            log.error('Content-Desktop', 'startNovelTranslation 發生錯誤:', e);
            sendResponse({ started: false, error: e.message });
        }
    }

    if (request.action === 'abortNovelTranslation') {
        log.info('Content-Desktop', '收到 abortNovelTranslation 訊息，清空本地佇列並終止');
        isNovelTranslationAborted = true;
        novelBatchQueue = [];
        currentNovelSessionId = null;
        window.mt_currentNovelSessionId = null;
        sendResponse({ ok: true });
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
        sendNextNovelBatch(); // 注入完畢，主動拉取下一批！
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

  log.info('Content-Desktop', 'Desktop Mode initialized.');
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
    
    // 清理舊有的翻譯狀態
    chrome.storage.local.remove('novelResults');
    
    // 讀取 batchSize (預設 50)
    const BATCH_SIZE = window.mt_currentNovelBatchSize || 50;
    
    // 建立全新 Session ID
    const newSessionId = createNovelSessionId();
    currentNovelSessionId = newSessionId;
    window.mt_currentNovelSessionId = newSessionId;

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
            sessionId: newSessionId,
            batchIndex: b,
            totalBatches,
            startIdx: start,
            texts: batchTexts
        });
    }
    
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
            log.info('Content-Desktop', `Novel Session 已在背景註冊: ${newSessionId}`);
            // 啟動首批拉取
            sendNextNovelBatch();
            // 啟動全網頁 UI 翻譯
            translateUIElements();
        } else {
            log.error('Content-Desktop', 'Novel Session 註冊失敗:', response);
        }
    });
}

/**
 * 重試所有翻譯失敗的段落，利用同一個佇列機制控速
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
            sessionId: currentNovelSessionId,
            batchIndex: b,
            totalBatches,
            startIdx: start,
            texts: batchTexts,
            retryIndices: batchIndices
        });
    }
    
    // 啟動重試拉取 (沿用原 Session，不發送 BEGIN_NOVEL_SESSION)
    sendNextNovelBatch();
}
