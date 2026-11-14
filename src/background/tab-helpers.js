/**
 * 分頁通訊輔助、詞庫與雲端同步管理、區域截圖擷取與配額統計模組
 * 提供重試機制通訊、Content Script 動態重注入、幽靈分頁垃圾回收、
 * 以及從 background/index.js 抽離的管理型訊息處理器。
 */
import { state } from '../utils/state.js';
import { log } from '../utils/logger.js';
import { syncEngine } from '../utils/sync-engine.js';
import {
    loadGlossary,
    upsertGlossaryTerm,
    buildGlossaryPromptSnippet,
    deleteGlossaryTerm,
    deleteGlossary,
    updateGlossaryDisplayName,
    importGlossaryTerms,
    deleteMultipleGlossaryTerms
} from './glossary-manager.js';
import { translateTexts } from './translate-api.js';
import { setCapturedScreenshot } from './image-processor.js';

// 註冊來自 index.js 的批次啟動處理器，避免循環依賴
let registeredBatchHandlers = {
    openNewResultPage: null,
    startNewMangaBatchProcessing: null
};

/**
 * 註冊由 index.js 提供的漫畫批次啟動函式
 * @param {{openNewResultPage?: Function, startNewMangaBatchProcessing?: Function}} handlers
 */
export function registerTabBatchHandlers(handlers = {}) {
    if (typeof handlers.openNewResultPage === 'function') {
        registeredBatchHandlers.openNewResultPage = handlers.openNewResultPage;
    }
    if (typeof handlers.startNewMangaBatchProcessing === 'function') {
        registeredBatchHandlers.startNewMangaBatchProcessing = handlers.startNewMangaBatchProcessing;
    }
}

/**
 * 主動垃圾回收：啟動時及定時清除已關閉分頁的歷史殘留 (幽靈分頁清理)
 */
export async function cleanupGhostTabs() {
    try {
        const openTabs = await chrome.tabs.query({});
        const activeTabIds = new Set(openTabs.map(t => String(t.id)));

        await state.update('navigationContext', (current = {}) => {
            const cleaned = {};
            for (const [tId, val] of Object.entries(current)) {
                if (activeTabIds.has(String(tId))) cleaned[tId] = val;
            }
            return cleaned;
        });

        await state.update('navLinksStore', (current = {}) => {
            const cleaned = {};
            for (const [tId, val] of Object.entries(current)) {
                if (activeTabIds.has(String(tId))) cleaned[tId] = val;
            }
            return cleaned;
        });
    } catch (_) {}
}

/**
 * 帶重試的訊息傳送工具 (移植自 V1.8.6 sendMessageWithRetry)
 * 解決頁面剛載入時 content script 尚未就緒的問題
 * @param {number} tabId
 * @param {Object} message
 * @param {number} [maxRetries=8]
 * @param {number} [interval=1500]
 * @returns {Promise<any>}
 */
export async function sendMessageWithRetry(tabId, message, maxRetries = 8, interval = 1500) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            log.info('Background', `[AutoBatch] 正在連線分頁 content script (${i + 1}/${maxRetries})... action: ${message.action}`);
            const response = await new Promise((resolve, reject) => {
                chrome.tabs.sendMessage(tabId, message, (resp) => {
                    if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
                    else resolve(resp);
                });
            });
            log.info('Background', `[AutoBatch] 連線成功 (${message.action})`);
            return response;
        } catch (e) {
            log.warn('Background', `[AutoBatch] 通訊重試失敗 (${i + 1}/${maxRetries}): ${e.message}`);
            if (i === maxRetries - 1) throw e;
            await new Promise(r => setTimeout(r, interval));
        }
    }
}

/**
 * 確保 Content Script 已在目標分頁中運行
 * 若擴充套件重新載入導致舊分頁變成孤兒腳本，自動動態重注入並驗證連線
 * @param {number} tabId
 * @returns {Promise<boolean>} 是否就緒
 */
export async function ensureContentScriptInjected(tabId) {
    try {
        // 1. 先嘗試 Ping — 若成功表示已就緒
        await chrome.tabs.sendMessage(tabId, { action: 'ping' });
        log.info('Background', `[PrepareTab] 分頁 ${tabId} 已具備環境`);
        return true;
    } catch {
        // 2. Ping 失敗，自動嘗試動態重注入
        try {
            log.info('Background', `[PrepareTab] 檢測到分頁 ${tabId} 斷線，正在自動動態注入 Content Script...`);
            const manifest = chrome.runtime.getManifest();
            const contentScripts = manifest.content_scripts?.[0]?.js || ['src/content/main.js'];
            await chrome.scripting.executeScript({
                target: { tabId },
                files: contentScripts
            });
            await new Promise(r => setTimeout(r, 400));
            // 再次驗證連線
            await chrome.tabs.sendMessage(tabId, { action: 'ping' });
            log.info('Background', `[PrepareTab] 分頁 ${tabId} 自動注入成功並已恢復通訊！`);
            return true;
        } catch (injectErr) {
            log.warn('Background', `[PrepareTab] 分頁 ${tabId} 自動注入失敗 (${injectErr.message})，提示使用者手動重新整理`);
            return false;
        }
    }
}

/**
 * 帶重試的接力翻譯啟動函式 (移植自 V1.8.6 autoStartBatch)
 * 跳轉後由 onUpdated 呼叫，確保 content script 就緒後再抓圖
 * @param {number} tabId
 * @param {number|null} resultTabId
 * @param {string|null} mangaKey
 * @param {boolean} mobile
 * @param {{openNewResultPage?: Function, startNewMangaBatchProcessing?: Function}} [handlers]
 */
export async function autoStartBatchWithRetry(tabId, resultTabId, mangaKey, mobile, handlers = null) {
    const openNewResultPageFn = handlers?.openNewResultPage || registeredBatchHandlers.openNewResultPage;
    const startNewMangaBatchProcessingFn = handlers?.startNewMangaBatchProcessing || registeredBatchHandlers.startNewMangaBatchProcessing;

    log.info('Background', `[AutoBatch] 嘗試開始接力翻譯 - TabID: ${tabId}, Mobile: ${!!mobile}`);
    try {
        // 先確保 content script 已注入（Edge Android 背景分頁跳轉後可能未自動注入）
        log.info('Background', `[AutoBatch] 確認 content script 注入狀態...`);
        await ensureContentScriptInjected(tabId);

        // 輪詢等待生肉網站非同步/AJAX 圖片加載完畢並達到穩定狀態 (防止只抓到剛載入的前幾張)
        let lastCount = 0;
        let stableCountMatches = 0;
        let crawlResult = null;

        for (let attempt = 1; attempt <= 12; attempt++) {
            const res = await sendMessageWithRetry(tabId, { action: 'crawlImages' });
            if (res?.error) {
                log.warn('Background', `[AutoBatch] ${res.error}`);
                chrome.tabs.sendMessage(tabId, {
                    action: 'TRANSLATION_STATUS',
                    payload: { msg: res.error, type: 'error', crawlBlocked: true }
                }).catch(() => {});
                if (resultTabId) chrome.tabs.sendMessage(resultTabId, {
                    action: 'mangaRecoveryError', error: res.error
                }).catch(() => {});
                return;
            }
            const currentImages = res?.images || [];
            const count = currentImages.length;

            if (count > 0) {
                if (count === lastCount) {
                    stableCountMatches++;
                    // 連續 2 次數量不變，確認所有圖片已完全注入
                    if (stableCountMatches >= 2 || (count >= 15 && stableCountMatches >= 1)) {
                        crawlResult = res;
                        log.info('Background', `[AutoBatch] 圖片數量已完全穩定：共獲取 ${count} 張圖片！(檢測嘗試 ${attempt} 次)`);
                        break;
                    }
                } else {
                    // 圖片數量持續增長中，重置穩定次數，繼續等待下一輪
                    stableCountMatches = 0;
                    lastCount = count;
                    log.info('Background', `[AutoBatch] 偵測到生肉圖片動態注入中 (當前 ${count} 張)，等待全部加載完畢...`);
                }
            } else {
                log.info('Background', `[AutoBatch] 第 ${attempt}/12 次抓圖尚未發現圖片，等待頁面渲染...`);
            }

            crawlResult = res;
            await new Promise(r => setTimeout(r, 600));
        }

        if (!crawlResult || !crawlResult.images || crawlResult.images.length === 0) {
            log.warn('Background', '[AutoBatch] 接力翻譯：多次輪詢後抓圖結果仍為空，中止');
            if (resultTabId) chrome.tabs.sendMessage(resultTabId, {
                action: 'mangaRecoveryError', error: '下一話尚未載入可辨識的漫畫圖片。請在原網頁確認圖片顯示後重新翻譯。'
            }).catch(() => {});
            return;
        }

        const images = crawlResult.images;
        const navLinks = crawlResult.navLinks || { prev: null, next: null };

        if (resultTabId) {
            try {
                const existingResultTab = await chrome.tabs.get(resultTabId);
                if (existingResultTab) {
                    chrome.tabs.update(resultTabId, { active: true });
                    chrome.tabs.sendMessage(resultTabId, {
                        action: 'reloadAndTranslate',
                        sourceTabId: tabId,
                        images,
                        navLinks,
                        mangaKey: mangaKey || null
                    }, () => {
                        if (chrome.runtime.lastError) {
                            log.warn('Background', '[AutoBatch] 結果頁無回應，改開新頁');
                            if (openNewResultPageFn) {
                                openNewResultPageFn(tabId, images, navLinks, mangaKey, mobile).catch(err => log.error('Background', err.message));
                            }
                        } else if (startNewMangaBatchProcessingFn) {
                            startNewMangaBatchProcessingFn(tabId, resultTabId, images, navLinks)
                                .catch(err => log.error('Background', `[AutoBatch] 接力翻譯啟動失敗: ${err.message}`));
                        }
                    });
                    return;
                }
            } catch (_) {
                log.warn('Background', '[AutoBatch] 原有結果頁已關閉，開新頁');
            }
        }
        if (openNewResultPageFn) {
            openNewResultPageFn(tabId, images, navLinks, mangaKey, mobile).catch(err => log.error('Background', err.message));
        }
    } catch (err) {
        log.error('Background', `[AutoBatch] 接力翻譯啟動失敗（8次重試均失敗）: ${err.message}`);
        // 廣播錯誤狀態給行動端（生肉網頁）的控制面板日誌區，方便實機除錯
        if (tabId) {
            chrome.tabs.sendMessage(tabId, {
                action: 'TRANSLATION_STATUS',
                payload: { msg: `🚨 接力翻譯啟動失敗: ${err.message}`, type: 'error' }
            }).catch(() => {});
        }
    }
}

/**
 * 更新每日翻譯次數統計（用於 getDailyTokenCount 配額顯示）
 * 支援單張或整批圖片完成後一次累加，減少 storage.local I/O 次數
 * @param {string} [modelName=''] - 當前使用的模型名稱
 * @param {number} [delta=1] - 本次累加張數（預設 1）
 */
export async function incrementDailyUsage(modelName = '', delta = 1) {
    try {
        const increment = Math.max(1, Number(delta) || 1);
        if (modelName && modelName.toLowerCase().includes('gemma')) {
            log.info('Background', `使用 Gemma 模型 (${modelName})，不記入每日額度`);
            return;
        }
        const today = new Date().toISOString().split('T')[0];
        const savedDate = await state.get('usageDate', '');
        let newCount = increment;
        if (savedDate !== today) {
            await state.set('usageDate', today);
            await state.set('usageCount', newCount);
        } else {
            const count = await state.get('usageCount', 0);
            newCount = count + increment;
            await state.set('usageCount', newCount);
        }
        // 廣播更新給 Sidepanel
        chrome.runtime.sendMessage({ action: 'updateTokenDisplay', count: newCount }).catch(() => {});
    } catch { /* 統計失敗不影響主要功能 */ }
}

/**
 * 處理區域截圖前的畫面擷取請求 (PRE_CAPTURE_FOR_SELECTION)
 * @param {Object} sender
 * @param {Function} sendResponse
 * @returns {boolean} 永遠回傳 true 表示非同步回應
 */
export function handlePreCaptureForSelection(sender, sendResponse) {
    const windowId = sender.tab ? sender.tab.windowId : null;
    chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 100 }, (result) => {
        if (chrome.runtime.lastError) {
            console.warn('[PreCapture] 截圖失敗:', chrome.runtime.lastError.message);
            setCapturedScreenshot(null);
            sendResponse({ success: false });
        } else {
            setCapturedScreenshot(result);
            sendResponse({ success: true });
        }
    });
    return true;
}

/**
 * 處理取得作品詞庫摘要資訊請求 (GET_GLOSSARY_INFO)
 * @param {Object} message
 * @param {Function} sendResponse
 * @returns {boolean} 永遠回傳 true 表示非同步回應
 */
export function handleGlossaryInfoRequest(message, sendResponse) {
    const { mangaKey } = message.payload;
    loadGlossary(mangaKey).then(entry => {
        sendResponse({
            success: true,
            displayName: entry?.displayName || mangaKey,
            termCount: entry?.terms?.length || 0
        });
    }).catch(err => {
        console.error('[Background] GET_GLOSSARY_INFO failed:', err);
        sendResponse({ success: false, error: err.message });
    });
    return true;
}

/**
 * 處理詞庫管理與雲端手動同步相關訊息 (位於 getGlossaryDetail 之後的長篇分支)
 * 若訊息屬於詞庫/同步操作，回傳 boolean（true 表示非同步、false 表示同步回應）；否則回傳 null。
 * @param {Object} message
 * @param {Function} sendResponse
 * @returns {boolean|null}
 */
export function handleGlossaryOrSyncMessage(message, sendResponse) {
    if (message.action === 'saveGlossaryTerm' || message.action === 'upsertGlossaryTerm') {
        upsertGlossaryTerm(message.mangaKey, message.term || { ori: message.ori, trans: message.trans }, message.oldOri)
            .then(sendResponse).catch(err => sendResponse({ success: false, error: err.message }));
        return true;
    }

    if (message.action === 'syncGlossariesNow') {
        syncEngine.syncNow(message.token).then(lastSyncTime => sendResponse({ success: true, lastSyncTime }))
            .catch(err => sendResponse({ success: false, error: err.message }));
        return true;
    }

    if (message.action === 'deleteGlossaryTerm') {
        const { mangaKey, ori } = message;
        if (!mangaKey || !ori) { sendResponse({ success: false, error: '缺少必要欄位' }); return false; }
        deleteGlossaryTerm(mangaKey, ori).then(res => sendResponse(res)).catch(err => sendResponse({ success: false, error: err.message }));
        return true;
    }

    if (message.action === 'deleteMultipleGlossaryTerms') {
        const { mangaKey, oris } = message;
        if (!mangaKey || !oris) { sendResponse({ success: false, error: '缺少必要欄位' }); return false; }
        deleteMultipleGlossaryTerms(mangaKey, oris).then(res => sendResponse(res)).catch(err => sendResponse({ success: false, error: err.message }));
        return true;
    }

    if (message.action === 'deleteGlossary') {
        const { mangaKey } = message;
        if (!mangaKey) { sendResponse({ success: false, error: '缺少必要欄位' }); return false; }
        deleteGlossary(mangaKey).then(res => sendResponse(res)).catch(err => sendResponse({ success: false, error: err.message }));
        return true;
    }

    if (message.action === 'updateGlossaryDisplayName') {
        const { mangaKey, newDisplayName } = message;
        if (!mangaKey || !newDisplayName) { sendResponse({ success: false, error: '缺少必要欄位' }); return false; }
        updateGlossaryDisplayName(mangaKey, newDisplayName).then(res => sendResponse(res)).catch(err => sendResponse({ success: false, error: err.message }));
        return true;
    }

    if (message.action === 'importGlossaryTerms') {
        const { mangaKey, terms } = message;
        if (!mangaKey || !terms) { sendResponse({ success: false, error: '缺少必要欄位' }); return false; }
        importGlossaryTerms(mangaKey, terms).then(res => sendResponse(res)).catch(err => sendResponse({ success: false, error: err.message }));
        return true;
    }

    return null;
}

/**
 * 處理網頁 UI 文字批次直譯請求 (translateUIBatch)
 * @param {Object} message
 * @param {Object} sender
 * @returns {Promise<{translations: Array<string>, error?: string}>}
 */
export async function handleTranslateUIBatch(message, sender) {
    const { texts } = message;
    try {
        const model = await state.get('novelModelName', 'gemini-3.5-flash-lite');
        const fallbackModel = await state.get('fallbackModelName', 'gemini-3.5-flash-lite');

        let glossarySnippet = '';
        const tabId = sender.tab?.id;
        const isGlossaryEnabled = await state.get('globalGlossaryEnabled', true);
        if (isGlossaryEnabled && tabId) {
            const navCtx = await state.get('navigationContext', {});
            const mangaKey = navCtx[tabId];
            if (mangaKey) {
                const gl = await loadGlossary(mangaKey);
                if (gl?.terms) glossarySnippet = buildGlossaryPromptSnippet(gl.terms);
            }
        }

        const prompt = '你是一位專業的翻譯師，將日文翻譯為繁體中文。請保持原文的語意、格式與標點符號，只進行簡潔直譯，不可有任何額外的解釋或包裝。請嚴格遵守 1:1 對位，輸出 JSON 必須包含 index (0-based) 與 text (譯文)。';

        // 加上 [idx] 前綴
        const indexedTexts = texts.map((t, idx) => `[${idx}] ${t}`);

        // 使用嚴格的 JSON 結構化輸出以確保安全對齊
        const schema = {
            type: 'OBJECT',
            properties: {
                translations: {
                    type: 'ARRAY',
                    items: {
                        type: 'OBJECT',
                        properties: {
                            index: { type: 'INTEGER' },
                            text: { type: 'STRING' }
                        },
                        required: ['index', 'text']
                    }
                }
            },
            required: ['translations']
        };

        const result = await translateTexts(indexedTexts, {
            model,
            fallbackModel,
            prompt,
            schema,
            glossarySnippet
        });

        // 建立預設以原文填充的 translations 陣列，長度 100% 相同
        const finalTranslations = [...texts];
        let hasValidResult = false;

        if (result && result.translations && Array.isArray(result.translations)) {
            result.translations.forEach(item => {
                const idx = item.index;
                if (typeof idx === 'number' && idx >= 0 && idx < texts.length) {
                    finalTranslations[idx] = item.text || texts[idx];
                }
            });
            hasValidResult = true;
        } else if (Array.isArray(result)) {
            // 回退機制：嘗試一般解析
            result.forEach((resText, idx) => {
                if (idx < texts.length) {
                    finalTranslations[idx] = resText || texts[idx];
                }
            });
            hasValidResult = true;
        }

        if (hasValidResult) {
            await incrementDailyUsage(model);
            return { translations: finalTranslations };
        }
        // 最終 fallback：返回全部空字串
        return { translations: texts.map(() => '') };
    } catch (err) {
        log.error('Background', 'translateUIBatch 發生錯誤:', err);
        return { translations: texts.map(() => ''), error: err.message };
    }
}

/**
 * 安裝雲端自動同步全域監聽器 (監聽 criticalKeys 變更並自動喚醒 syncEngine)
 */
export function installCloudSyncStorageListener() {
    chrome.storage.onChanged.addListener((changes, namespace) => {
        if (namespace !== 'local') return;

        // 關鍵設定的 Keys (包含翻譯語言、API Key、獨立時間戳、自訂詞彙、模型設定、自訂提示詞)
        const criticalKeys = [
            'apiKey',
            'apiKeyLastModified',
            'settingsLastModified',
            'targetLanguage',
            'mangaGlossaries',
            'mangaGlossaryTombstones',
            'modelName',
            'novelModelName',
            'customPrompt',
            'novelPrompt'
        ];

        const hasCriticalChange = Object.keys(changes).some(key => criticalKeys.includes(key));

        if (hasCriticalChange) {
            // 非同步讀取 enableCloudSync 狀態，避免阻塞
            chrome.storage.local.get(['enableCloudSync'], (result) => {
                const enableCloudSync = result.enableCloudSync || false;
                if (enableCloudSync) {
                    log.info('BackgroundSync', '檢測到關鍵設定變更且已啟用雲端同步，準備觸發同步引擎...');
                    try {
                        syncEngine.triggerSync(changes);
                    } catch (syncErr) {
                        log.error('BackgroundSync', '喚醒同步引擎時發生異常:', syncErr);
                    }
                }
            });
        }
    });
}
