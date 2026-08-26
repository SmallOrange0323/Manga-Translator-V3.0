import { state } from '../utils/state.js';
import * as Constants from '../utils/constants.js';
import { extractMangaTitle } from '../utils/manga-utils.js';
import './download-helper.js';
import { loadGlossary, saveGlossary, mergeGlossaryTerms, buildGlossaryPromptSnippet, deleteGlossaryTerm, deleteGlossary, updateGlossaryDisplayName, importGlossaryTerms, deleteMultipleGlossaryTerms } from './glossary-manager.js';
import { translateTexts, extractTermsFromTranslation, callGeminiAPIBatch, extractGlobalStoryAndGlossary, extractTextFromImage, callGeminiAPIBatchOcr } from './translate-api.js';
import { log } from '../utils/logger.js';
import { Semaphore, KeyRateLimiter } from '../utils/concurrency.js';
import { syncEngine } from '../utils/sync-engine.js';
import { createMangaStartLock } from './manga-start-lock.js';
import { getPretranslationCompletion, mapPretranslationBatchResults, shouldCompleteMangaTranslation, executeFallbackImages, executeOcrFallbackImages, shouldProceedToStage15, shouldProceedToStage2 } from './manga-lifecycle.js';
import { getHybridSchedule, getEffectiveDelay } from './hybrid-scheduler.js';
import { executeHybridRequest, HybridRequestAbortedError } from './hybrid-retry.js';
import { savePretranslationCheckpoint, getPretranslationCheckpoints, removePretranslationCheckpoint, clearPretranslationCheckpointsForTabs, normalizeRestoredPretranslation, getPretranslationResumeIndex } from './pretranslation-checkpoint.js';

let capturedScreenshotForSelection = null;
// 記錄每個分頁最後的小說網址，防止 onUpdated 重複觸發自動翻譯
// 注意：此為記憶體變數，SW 重啟後清空屬正常行為
const lastNovelUrlByTab = {};

// 【雙階段模式】單話任務短期記憶體暫存區 (Session Context)，任務結束後自動釋放，絕不污染長期詞庫
const sessionStoryContext = {};

// 追蹤當前正在進行漫畫翻譯任務的分頁 (分頁 ID ➔ 任務詳情)
const activeTranslationJobs = new Map();
// V3.1.5 的 stop/pause 仍是全域狀態；啟動 mutex 與 run tracking 共同保證全域單一漫畫 lifecycle。
// 未來若要支援多 Tab 並行，需將 stop/pause、cancellation 與 job state 改為 per-job。
const activeMangaTranslationRuns = new Set();
const withMangaStartLock = createMangaStartLock();



log.info('Background', '漫譯 V3 背景服務程式已啟動');

// 檢查是否處於無痕模式背景實例中 (用於 split 模式分流)
const isIncognitoProcess = chrome.extension ? chrome.extension.inIncognitoContext : false;

/**
 * 判斷指定分頁是否為無痕視窗
 * @param {number} tabId 
 * @returns {Promise<boolean>}
 */
async function isTabIncognito(tabId) {
    if (isIncognitoProcess) return true;
    if (!tabId) return false;
    try {
        const tab = await chrome.tabs.get(tabId);
        return !!tab?.incognito;
    } catch (_) {
        return false;
    }
}

// ─── Service Worker 任務保活心跳管理器 (結合 JS 內部定時器 + Chrome 官方 Alarms 雙重保活) ───
const ALARM_KEEPALIVE_NAME = 'mt_sw_heartbeat_alarm';

class ServiceWorkerKeepAlive {
    constructor() {
        this.timer = null;
        this.activeJobs = 0;
    }

    start() {
        this.activeJobs++;
        if (this.timer) return;

        // 1. 內部定時器 (每 15 秒輕量呼叫一次 API 續命)
        this.timer = setInterval(async () => {
            try {
                await chrome.runtime.getPlatformInfo();
            } catch (_) {}
        }, 15000);

        // 2. 外部 Chrome 官方鬧鐘 (向瀏覽器核心註冊每 0.5 分鐘 / 30 秒觸發一次的 Morning Call)
        try {
            chrome.alarms.create(ALARM_KEEPALIVE_NAME, {
                periodInMinutes: 0.5
            });
        } catch (_) {}

        log.info('Background', '🛡️ [KeepAlive] Service Worker 雙重保活機制已啟動 (內部心跳 + 官方 Alarms)');
    }

    stop() {
        this.activeJobs = Math.max(0, this.activeJobs - 1);
        if (this.activeJobs === 0) {
            if (this.timer) {
                clearInterval(this.timer);
                this.timer = null;
            }
            try {
                chrome.alarms.clear(ALARM_KEEPALIVE_NAME);
            } catch (_) {}
            log.info('Background', '🛡️ [KeepAlive] Service Worker 雙重保活機制已停止並釋放鬧鐘');
        }
    }
}

const swKeepAlive = new ServiceWorkerKeepAlive();

// 監聽 Chrome 官方鬧鐘喚醒事件
if (chrome.alarms && chrome.alarms.onAlarm) {
    chrome.alarms.onAlarm.addListener(async (alarm) => {
        if (alarm.name === ALARM_KEEPALIVE_NAME) {
            try {
                await chrome.runtime.getPlatformInfo();
            } catch (_) {}
        }
    });
}

// 當 Service Worker 啟動或重啟時，初次化狀態
state.init().then(async () => {
    log.info('Background', `狀態載入完成 (無痕模式: ${isIncognitoProcess})，檢查待處理任務...`);
    await state.set('isStopping', false); // 重置停止狀態

    // 檢查是否有遺留的小說翻譯任務
    const queue = await state.get('novelQueue', []);
    if (queue.length > 0 && !isIncognitoProcess) {
        log.warn('Background', `偵測到 ${queue.length} 個小說待處理任務，準備恢復...`);
        processNovelQueue().catch(err => log.error('Background', '恢復小說佇列失敗:', err));
    }

    // 檢查是否有未完成的漫畫預翻 session checkpoint，安全恢復
    if (!isIncognitoProcess) {
        restorePretranslationCheckpoints().catch(err => log.warn('Background', `[跨話連續追漫] 恢復預翻 checkpoint 失敗: ${err.message}`));
    }
});

/**
 * Service Worker 啟動時從 chrome.storage.session 恢復中斷的預翻任務
 */
async function restorePretranslationCheckpoints() {
    try {
        const checkpoints = await getPretranslationCheckpoints();
        const entries = Object.values(checkpoints || {});
        if (entries.length === 0) return;

        log.info('Background', `[跨話連續追漫] 正在檢查 ${entries.length} 筆 session 預翻 checkpoint...`);

        let latestInterrupted = null;

        for (const rawSnapshot of entries) {
            const normalized = normalizeRestoredPretranslation(rawSnapshot);
            if (!normalized) {
                if (rawSnapshot?.url) await removePretranslationCheckpoint(rawSnapshot.url);
                continue;
            }

            if (normalized.isCancelled || normalized.isDone) {
                await removePretranslationCheckpoint(normalized.url);
                continue;
            }

            pretranslatedChaptersMap.set(normalized.url, normalized);

            if (normalized.status === 'interrupted') {
                if (!latestInterrupted || normalized.updatedAt > latestInterrupted.updatedAt) {
                    if (latestInterrupted) {
                        await removePretranslationCheckpoint(latestInterrupted.url);
                    }
                    latestInterrupted = normalized;
                } else {
                    await removePretranslationCheckpoint(normalized.url);
                }
            }
        }

        if (latestInterrupted) {
            let isValidTab = false;
            if (latestInterrupted.sourceTabId && typeof latestInterrupted.sourceTabId === 'number') {
                try {
                    await chrome.tabs.get(latestInterrupted.sourceTabId);
                    isValidTab = true;
                } catch (_) {
                    isValidTab = false;
                }
            }

            if (isValidTab) {
                log.info('Background', `[跨話連續追漫] 正在從 Service Worker 重啟中恢復預翻: ${latestInterrupted.url} (已完成 ${latestInterrupted.processedCount}/${latestInterrupted.images.length} 頁)`);
                startPretranslateNextChapter(latestInterrupted.url, latestInterrupted.sourceTabId, latestInterrupted.associatedResultTabId)
                    .catch(err => log.warn('Background', `恢復預翻失敗: ${err.message}`));
            } else {
                log.info('Background', `[跨話連續追漫] 來源分頁 ${latestInterrupted.sourceTabId} 已不存在，清理 checkpoint: ${latestInterrupted.url}`);
                pretranslatedChaptersMap.delete(latestInterrupted.url);
                await removePretranslationCheckpoint(latestInterrupted.url);
            }
        }
    } catch (err) {
        log.warn('Background', `恢復預翻 checkpoint 異常: ${err.message}`);
    }
}

// 同步本地鎖，解決 chrome.storage 非同步造成的 race condition
let _localNovelProcessingLock = false;

// 真正的翻譯處理循環
async function processNovelQueue() {
    if (isIncognitoProcess) {
        log.info('Background', '[NovelQueue] 無痕模式背景不處理全域小說佇列，避免競爭');
        return;
    }
    if (_localNovelProcessingLock) return;
    _localNovelProcessingLock = true;

    // 仍需更新 storage 以便讓 UI 知道狀態
    await state.set('isProcessingNovel', true);
    
    try {
        while (true) {
            const rawQueue = await state.get('novelQueue', []);
            const queue = Array.isArray(rawQueue) ? rawQueue : Object.values(rawQueue || {});
            
            if (queue.length === 0) break;
            
            // 檢查是否中斷
            if (await state.get('isStopping')) {
                log.warn('Background', '小說翻譯任務已被強制停止');
                break;
            }

            const task = queue.shift();
            await state.set('novelQueue', queue);

            // 標題與作品 Key 識別
            const navCtx = await state.get('navigationContext', {});
            let mangaKey = navCtx[task.tabId];
            if (!mangaKey && task.tabId) {
                try {
                    const tabInfo = await chrome.tabs.get(task.tabId);
                    const titleResult = extractMangaTitle(tabInfo.title || '');
                    if (titleResult) {
                        mangaKey = titleResult.romanKey;
                        navCtx[task.tabId] = mangaKey;
                        await state.set('navigationContext', navCtx);
                    }
                } catch (e) {}
            }

            let glossarySnippet = '';
            let currentDisplayName = mangaKey;
            const isIncognitoTask = await isTabIncognito(task.tabId);
            const incognitoPrivacy = await state.get('incognitoPrivacyMode', true);

            if (mangaKey) {
                const entry = await loadGlossary(mangaKey);
                if (!entry) {
                    if (isIncognitoTask && incognitoPrivacy) {
                        log.info('Glossary', `🔒 [隱私保護] 偵測到無痕視窗，已跳過為新小說作品 "${mangaKey}" 建立初始詞庫與雲端同步`);
                    } else {
                        // 比照漫畫模式：建立初始存檔
                        await saveGlossary(mangaKey, { displayName: mangaKey, terms: [] });
                        log.info('Glossary', `為新小說作品 "${mangaKey}" 建立初始詞庫`);
                    }
                } else {
                    currentDisplayName = entry.displayName || mangaKey;
                    if (entry.terms && entry.terms.length > 0) {
                        glossarySnippet = buildGlossaryPromptSnippet(entry.terms);
                        log.info('Glossary', `套用小說詞庫 "${currentDisplayName}"，共 ${entry.terms.length} 筆術語`);
                    }
                }
            }

            // 讀取小說專用設定
            const modelName = await state.get('novelModelName', 'gemini-3.5-flash-lite');
            const fallbackModelName = await state.get('fallbackModelName', 'gemini-3.5-flash-lite');
            const novelPrompt = await state.get('novelPrompt', '');
            const requestDelay = await state.get('requestDelay', 3000);

            const allTranslatedResults = []; // 用於結尾萃取
            const isRetry = Array.isArray(task.retryIndices) && task.retryIndices.length > 0;

            try {
                const typeStr = isRetry ? '重譯批次' : '新譯批次';
                log.info('Background', `[小說批次] ${typeStr} 處理中，BatchIndex: ${(task.batchIndex || 0) + 1}/${task.totalBatches || 1}，段落數: ${task.texts.length}`);

                // 提早更新進度
                await state.setThrottled('novelProgress', {
                    status: `[處理中] 正在翻譯第 ${(task.batchIndex || 0) + 1}/${task.totalBatches || 1} 批小說，請稍候...`
                }, 0); 

                // 【V1.8.6 移植】為傳送文本加上索引前綴 [N]，強化模型對位
                const indexedTexts = task.texts.map((t, idx) => `[${idx}] ${t}`);

                // 強制要求 JSON 結構化輸出 (Response Schema)
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

                const finalPrompt = (novelPrompt || '你是一位專業的翻譯師，將日文翻譯為繁體中文。') + 
                    '\n請嚴格遵守 1:1 對位，輸出 JSON 必須包含 index (0-based) 與 text (譯文)。';

                const result = await translateTexts(indexedTexts, { 
                    model: modelName,
                    fallbackModel: fallbackModelName,
                    prompt: finalPrompt,
                    schema: schema, 
                    glossarySnippet
                }); 

                // 解析結果
                let translations = [];
                if (result && result.translations) {
                    const sorted = result.translations.sort((a, b) => a.index - b.index);
                    translations = sorted.map(item => item.text);
                } else if (Array.isArray(result)) {
                    translations = result;
                }
                
                if (translations.length === 0) throw new Error('翻譯結果為空或格式錯誤'); 

                // 補全配額更新，傳入 modelName 支援 Gemma 識別
                await incrementDailyUsage(modelName);

                // 逐條寫入結果以更新 status / stats 累加
                for (let k = 0; k < task.texts.length; k++) {
                    const translation = translations[k] || '（翻譯失敗）';
                    const globalIdx = isRetry ? task.retryIndices[k] : (task.startIdx + k);
                    const resultItem = {
                        tabId: task.tabId,
                        idx: globalIdx,
                        original: task.texts[k],
                        translation: translation
                    };
                    allTranslatedResults.push({ original: task.texts[k], translation: translation });
                    await state.update('novelResults', (current = []) => [...current, resultItem]);
                }

                // 批次完成後通知前端注入
                log.info('Background', `[小說批次] 完成翻譯，即將發送訊息給前台分頁: ${task.tabId}`);
                await chrome.tabs.sendMessage(task.tabId, {
                    action: 'injectNovelBatchResult',
                    batchIndex: task.batchIndex,
                    translations: translations,
                    retryIndices: task.retryIndices,
                    isFailed: false
                });

                // 更新進度
                await state.setThrottled('novelProgress', {
                    status: `已完成第 ${(task.batchIndex || 0) + 1} / ${task.totalBatches || 1} 批`
                }, 0);

            } catch (batchErr) {
                log.error('Background', `批次翻譯失敗 (第 ${(task.batchIndex || 0) + 1} 批):`, batchErr);
                
                // 翻譯失敗也主動發送 injectNovelBatchResult 給前台，讓前台更新 UI 呈現失敗並顯示「重試」按鈕
                try {
                    await chrome.tabs.sendMessage(task.tabId, {
                        action: 'injectNovelBatchResult',
                        batchIndex: task.batchIndex,
                        translations: task.texts.map(() => '（翻譯失敗）'),
                        retryIndices: task.retryIndices,
                        isFailed: true
                    });
                } catch (msgErr) {
                    log.error('Background', '無法將失敗訊息傳給前台分頁:', msgErr);
                }
            }

            // ── 異步術語萃取 (與漫畫模式對齊) ──
            if (isIncognitoTask && incognitoPrivacy) {
                log.info('Background', '🔒 [隱私保護] 偵測到無痕視窗，已自動跳過小說術語萃取與詞庫儲存');
            } else if (mangaKey && allTranslatedResults.length > 0) {
                log.info('Background', `[小說萃取] 開始分析小說譯文，提取關鍵術語...`);
                setTimeout(async () => {
                    try {
                        const newTerms = await extractTermsFromTranslation(allTranslatedResults, { model: modelName });
                        if (newTerms && newTerms.length > 0) {
                            const currentEntry = await loadGlossary(mangaKey) || { terms: [] };
                            const { terms: mergedTerms, addedCount } = mergeGlossaryTerms(currentEntry.terms || [], newTerms);
                            if (addedCount > 0) {
                                await saveGlossary(mangaKey, {
                                    displayName: currentDisplayName || mangaKey,
                                    terms: mergedTerms
                                });
                                log.info('Background', `[小說萃取] 作品 "${mangaKey}" 自動新增 ${addedCount} 筆術語。`);
                            }
                        }
                    } catch (err) {
                        log.warn('Background', `[小說萃取] 發生錯誤: ${err.message}`);
                    }
                }, 1000);
            }

            // 批次間延遲控速
            if (queue.length > 0) {
                await new Promise(r => setTimeout(r, requestDelay));
            }
        }
    } catch (globalErr) {
        log.error('Background', '小說隊列處理異常:', globalErr);
        await state.set('novelProgress', { status: `[系統錯誤] ${globalErr.message}` });
        await new Promise(r => setTimeout(r, 5000));
    } finally {
        _localNovelProcessingLock = false;
        await state.set('isProcessingNovel', false);
        await state.set('novelProgress', null);
    }
}

// 監聽訊息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  log.info('Messenger', `收到訊息: ${message.action}`, { tabId: sender.tab?.id });

  if (message.action === 'PING') {
    sendResponse({ status: 'PONG', version: chrome.runtime.getManifest().version });
    return false;
  }

  if (message.action === 'GET_LOCAL_AI_STATUS') {
    wasmOcrEngine.getGpuStatus().then(status => {
      sendResponse({ success: true, data: status });
    }).catch(err => {
      sendResponse({ success: false, message: err.message });
    });
    return true;
  }

  if (message.action === 'CLEAR_LOCAL_AI_CACHE') {
    wasmOcrEngine.clearCache().then(res => {
      sendResponse(res);
    }).catch(err => {
      sendResponse({ success: false, message: err.message });
    });
    return true;
  }

  if (message.action === 'translateNovelParagraphs') {
      const { batchIndex, totalBatches, startIdx, texts, retryIndices } = message;
      const tabId = sender.tab?.id;
      if (!tabId) {
          sendResponse({ error: '找不到分頁 ID' });
          return false;
      }

      state.set('isStopping', false);
      state.set('isBatchPaused', false);

      const task = {
          tabId,
          batchIndex,
          totalBatches,
          startIdx,
          texts,
          retryIndices
      };

      handleAddToQueue(task).then(() => {
          processNovelQueue();
      }).catch(err => log.error('Background', '小說任務加入佇列失敗:', err));

      sendResponse({ status: 'queued' });
      return false;
  }

  if (message.action === 'translateUIBatch') {
      const { texts } = message;
      (async () => {
          try {
              const model = await state.get('novelModelName', 'gemini-3.5-flash-lite');
              const fallbackModel = await state.get('fallbackModelName', 'gemini-3.5-flash-lite');
              
              let glossarySnippet = '';
              const tabId = sender.tab?.id;
              if (tabId) {
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
              } else {
                  // 回退機制：嘗試一般解析
                  if (Array.isArray(result)) {
                      result.forEach((resText, idx) => {
                          if (idx < texts.length) {
                              finalTranslations[idx] = resText || texts[idx];
                          }
                      });
                      hasValidResult = true;
                  }
              }

              if (hasValidResult) {
                  await incrementDailyUsage(model);
                  sendResponse({ translations: finalTranslations });
              } else {
                  // 最終 fallback：返回全部空譯文或日文原文
                  sendResponse({ translations: texts.map(() => '') });
              }
          } catch (err) {
              log.error('Background', 'translateUIBatch 發生錯誤:', err);
              sendResponse({ translations: texts.map(() => ''), error: err.message });
          }
      })();
      return true; // 保持非同步通道
  }
  
  if (message.action === 'ADD_TO_QUEUE') {
    const payload = message.payload;
    if (!payload.tabId && sender.tab) payload.tabId = sender.tab.id;
    if (payload.navLinks) {
        state.get('navLinksStore', {}).then(store => {
            store[payload.tabId] = payload.navLinks;
            state.set('navLinksStore', store);
        });
    }
    
    // Bug #1 修復：重置停止旗標，防止前次按停止後小說無法再次翻譯
    state.set('isStopping', false);
    state.set('isBatchPaused', false);
    
    // 將任務加入全域佇列 (使用原子化 handleAddToQueue)
    handleAddToQueue(payload).then(() => {
        processNovelQueue(); // 啟動處理器
    }).catch(err => log.error('Background', 'Queue update failed:', err));
    
    sendResponse({ status: 'queued' });
    return false; // 同步回應
  }

  if (message.action === 'CHECK_PRETRANSLATED_CHAPTER') {
      const { nextUrl } = message.payload || {};
      (async () => {
          let data = pretranslatedChaptersMap.get(nextUrl);
          if (!data) {
              data = await getPretranslatedChapterFromStorage(nextUrl);
              if (data) pretranslatedChaptersMap.set(nextUrl, data);
          }
          if (data) {
              sendResponse({
                  exists: true,
                  isDone: data.isDone,
                  inProgress: data.inProgress,
                  status: data.status || null,
                  error: data.error || null,
                  count: data.results?.length || 0,
                  total: data.images?.length || 0,
                  data: data.isDone && !data.isCancelled ? data : null
              });
          } else {
              sendResponse({ exists: false });
          }
      })();
      return true; // 保持異步通道
  }

  if (message.action === 'CONSUME_PRETRANSLATED_CHAPTER') {
      const { nextUrl, sourceTabId } = message.payload || {};
      const resultTabId = message.payload?.resultTabId || sender.tab?.id;
      (async () => {
          let data = pretranslatedChaptersMap.get(nextUrl);
          if (!data) {
              data = await getPretranslatedChapterFromStorage(nextUrl);
              if (data) pretranslatedChaptersMap.set(nextUrl, data);
          }
          if (data && (data.isDone || (data.inProgress && data.results?.length > 0)) && !data.isCancelled) {
              log.info('Background', `[跨話連續追漫] 讀者進入下一話 (${nextUrl})，消費預翻成果 (已完成 ${data.results.length}/${data.images?.length || '?'} 頁)！`);
              
              // 若預翻仍在進行中，將接收結果頁綁定為當前 resultTabId
              data.associatedResultTabId = resultTabId;

              // 靜默更新生肉分頁網址（保持進度同步）
              if (sourceTabId && typeof sourceTabId === 'number') {
                  chrome.tabs.update(sourceTabId, { url: nextUrl }).catch(() => {});
              }

              // 讀者已進入本話，為即將到來的下下一話啟動單話預翻 (深度始終保持為 1)
              if (data.navLinks?.next && typeof data.navLinks.next === 'string') {
                  startPretranslateNextChapter(data.navLinks.next, sourceTabId, null).catch(err => {
                      log.warn('Background', `[跨話連續追漫] 預翻下下一話失敗: ${err.message}`);
                  });
              }

              sendResponse({ success: true, data });
          } else {
              sendResponse({ success: false, data: null });
          }
      })();
      return true;
  }

  if (message.action === 'START_MANGA_BATCH_PC_MODE') {
      let { tabId, images, mobile, navLinks, mangaKey, windowId } = message.payload;
      if (!tabId && sender.tab) tabId = sender.tab.id;
      if (!windowId && sender.tab) windowId = sender.tab.windowId;
      
      // 紀錄手動選擇的詞庫 key
      if (mangaKey) {
          state.get('navigationContext', {}).then(ctx => {
              ctx[tabId] = mangaKey;
              state.set('navigationContext', ctx);
          });
      }
      
      // 紀錄導航連結
      if (navLinks) {
          state.get('navLinksStore', {}).then(store => {
              store[tabId] = navLinks;
              state.set('navLinksStore', store);
          });
      }
      // 行動端來源時加上 mobile=1 參數，讓結果頁知道要啟用行動閱讀器模式
      const mobileParam = mobile ? '&mobile=1' : '';
      // 儲存 payload，等 result.html 的 resultPageReady 訊號再開始翻譯
      chrome.storage.local.set({ mt_batch_payload: { tabId, images } }, () => {
          const createTab = (targetWindowId) => {
              chrome.tabs.create({ url: chrome.runtime.getURL('src/reader/result.html') + '?tabId=' + tabId + mobileParam, windowId: targetWindowId }, (tab) => {
                  if (chrome.runtime.lastError) {
                      // Fallback if windowId is invalid
                      chrome.tabs.create({ url: chrome.runtime.getURL('src/reader/result.html') + '?tabId=' + tabId + mobileParam }, (tab2) => {
                          setupResultTab(tab2);
                      });
                  } else {
                      setupResultTab(tab);
                  }
              });
          };

          const setupResultTab = (tab) => {
              if (!tab) return;
              state.get('pendingBatchJobs', {}).then(jobs => {
                  jobs[tab.id] = { sourceTabId: tabId, images, navLinks: navLinks || null };
                  state.set('pendingBatchJobs', jobs);
                  setTimeout(() => {
                      state.get('pendingBatchJobs', {}).then(jobs2 => {
                          delete jobs2[tab.id];
                          state.set('pendingBatchJobs', jobs2);
                      });
                  }, 60000);
              });
          };

          if (windowId) {
              createTab(windowId);
          } else {
              chrome.tabs.get(tabId, (sourceTab) => {
                  createTab(sourceTab ? sourceTab.windowId : undefined);
              });
          }
      });
      sendResponse({ status: 'ok' });
      return false;
  }

  // 查詢特定分頁是否正在進行漫畫翻譯長任務
  if (message.action === 'CHECK_TAB_TRANSLATION_STATUS') {
      const tabId = message.payload?.tabId;
      const isTranslating = tabId ? activeTranslationJobs.has(tabId) : false;
      const jobInfo = tabId ? activeTranslationJobs.get(tabId) : null;
      sendResponse({ isTranslating, jobInfo });
      return false;
  }

  // 側邊欄或前台主動停止漫畫翻譯任務
  if (message.action === 'STOP_TRANSLATION') {
      const tabId = message.payload?.tabId || sender.tab?.id;
      state.set('isStopping', true);
      log.warn('Background', '收到停止指令，正在中斷相關翻譯任務...');
      if (tabId) {
          const job = activeTranslationJobs.get(tabId);
          if (job) {
              activeTranslationJobs.delete(job.sourceTabId);
              activeTranslationJobs.delete(job.resultTabId);
          }
          activeTranslationJobs.delete(tabId);
      } else {
          activeTranslationJobs.clear();
      }
      chrome.runtime.sendMessage({ action: 'TRANSLATION_DONE' }).catch(() => {});
      sendResponse({ success: true, status: 'stopping' });
      return false;
  }

  // 行動端專用：開啟行動版翻譯分頁
  if (message.action === 'OPEN_MOBILE_PANEL') {
      const sourceTabId = sender.tab.id;
      const windowId = sender.tab.windowId;
      const mobileUrl = chrome.runtime.getURL('src/mobile/index.html') + '?sourceTabId=' + sourceTabId;
      chrome.tabs.create({ url: mobileUrl, windowId: windowId });
      sendResponse({ status: 'ok' });
      return false;
  }

  if (message.action === 'resultPageReady') {
      const resultTabId = sender.tab?.id;
      if (resultTabId) {
          state.get('pendingBatchJobs', {}).then(jobs => {
              if (jobs[resultTabId]) {
                  const { sourceTabId, images, navLinks } = jobs[resultTabId];
                  delete jobs[resultTabId];
                  state.set('pendingBatchJobs', jobs);
                  // 新任務必須等待先前被停止的任務真正退出後，才清除停止旗標並派發。
                  startNewMangaBatchProcessing(sourceTabId, resultTabId, images, navLinks)
                      .catch(err => log.error('Background', `啟動漫畫翻譯任務失敗: ${err.message}`));
              }
          });
      }
      sendResponse({ status: 'ok' });
      return false;
  }

    if (message.action === 'GET_GLOSSARY_INFO') {
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

    if (message.action === 'PRE_CAPTURE_FOR_SELECTION') {
    const windowId = sender.tab ? sender.tab.windowId : null;
    chrome.tabs.captureVisibleTab(windowId, { format: "jpeg", quality: 100 }, (result) => {
        if (chrome.runtime.lastError) {
          console.warn("[PreCapture] 截圖失敗:", chrome.runtime.lastError.message);
          capturedScreenshotForSelection = null;
          sendResponse({ success: false });
        } else {
          capturedScreenshotForSelection = result;
          sendResponse({ success: true });
        }
    });
    return true; // 保持通道以進行異步回應
  }

  if (message.action === 'PROCESS_SCREENSHOT') {
    handleProcessScreenshot(message.rect, sender.tab.id)
        .then(res => sendResponse(res))
        .catch(err => {
            console.error('[Background] PROCESS_SCREENSHOT failed:', err);
            sendResponse({ success: false, error: err.message });
        });
    return true; // 非同步處理中
  }
  

  if (message.action === 'getResultMetadata') {
      const sourceTabId = message.tabId || parseInt(new URL(sender.tab?.url || 'about:blank').searchParams.get('tabId'));
      (async () => {
          const navCtx = await state.get('navigationContext', {});
          const navStore = await state.get('navLinksStore', {});
          const mangaKey = (!isNaN(sourceTabId) && navCtx[sourceTabId]) ? navCtx[sourceTabId] : null;
          let navLinks = (!isNaN(sourceTabId) && navStore[sourceTabId]) ? { ...navStore[sourceTabId] } : { prev: null, next: null, currentChapter: '', chapterList: [] };
          
          // 若 currentChapter 尚未填寫，主動從宿主分頁的 URL 與 Title 精準提取
          if (!isNaN(sourceTabId)) {
              try {
                  const srcTab = await chrome.tabs.get(sourceTabId);
                  const srcUrl = srcTab?.url || '';
                  const srcTitle = srcTab?.title || '';
                  if (!navLinks.currentChapter) {
                      const urlMatch = srcUrl.match(/chapter[_-]?([\d\.]+)/i) || srcUrl.match(/(\d+[\.\d]*)\/?$/);
                      if (urlMatch && urlMatch[1]) {
                          navLinks.currentChapter = `Chapter ${urlMatch[1]}`;
                      } else {
                          const titleMatch = srcTitle.match(/Chapter\s*([\d\.]+)/i) || srcTitle.match(/第\s*([\d\.]+)\s*話/i);
                          if (titleMatch && titleMatch[1]) {
                              navLinks.currentChapter = `Chapter ${titleMatch[1]}`;
                          }
                      }
                  }
              } catch(e) {}
          }

          let displayName = null;
          if (mangaKey) {
              try {
                  const glossary = await loadGlossary(mangaKey);
                  displayName = glossary?.displayName || mangaKey;
              } catch(e) {}
          }
          sendResponse({ navLinks, mangaKey, displayName });
      })();
      return true;
  }

  if (message.action === 'getTabMangaKey') {
      const tabId = message.tabId || sender.tab?.id;
      (async () => {
          const navCtx = await state.get('navigationContext', {});
          sendResponse({ mangaKey: navCtx[tabId] || null });
      })();
      return true;
  }

  if (message.action === 'getGlossaryDetail') {
      const { mangaKey } = message;
      if (!mangaKey) { sendResponse({ entry: null }); return false; }
      loadGlossary(mangaKey).then(entry => {
          sendResponse({ entry: entry || null });
      }).catch(() => sendResponse({ entry: null }));
      return true;
  }

  if (message.action === 'saveGlossaryTerm') {
      const { mangaKey, displayName, ori, trans } = message;
      if (!mangaKey || !ori || !trans) {
          sendResponse({ success: false, error: '缺少必要欄位' });
          return false;
      }
      (async () => {
          try {
              const existing = await loadGlossary(mangaKey) || { displayName: displayName || mangaKey, terms: [] };
              const cleanOri = ori.trim();
              const cleanTrans = trans.trim();
              
              const existingIndex = existing.terms.findIndex(t => t.ori === cleanOri);
              if (existingIndex >= 0) {
                  // 原文已存在，使用者手動覆蓋更新譯名
                  existing.terms[existingIndex].trans = cleanTrans;
                  existing.terms[existingIndex].source = 'user';
                  existing.terms[existingIndex].updatedAt = Date.now();
                  log.info('Glossary', `[詞彙更新] 作品 "${mangaKey}" 覆蓋詞彙: ${cleanOri} ➔ ${cleanTrans}`);
              } else {
                  // 新增詞彙
                  existing.terms.push({ ori: cleanOri, trans: cleanTrans, source: 'user', createdAt: Date.now() });
                  log.info('Glossary', `[詞彙新增] 作品 "${mangaKey}" 新增詞彙: ${cleanOri} ➔ ${cleanTrans}`);
              }
              await saveGlossary(mangaKey, existing);
              sendResponse({ success: true, count: existing.terms.length });
          } catch(e) {
              sendResponse({ success: false, error: e.message });
          }
      })();
      return true;
  }

  if (message.action === 'deleteGlossaryTerm') {
      const { mangaKey, ori } = message;
      if (!mangaKey || !ori) { sendResponse({ success: false, error: '缺少必要欄位' }); return false; }
      deleteGlossaryTerm(mangaKey, ori).then(res => sendResponse(res));
      return true;
  }

  if (message.action === 'deleteMultipleGlossaryTerms') {
      const { mangaKey, oris } = message;
      if (!mangaKey || !oris) { sendResponse({ success: false, error: '缺少必要欄位' }); return false; }
      deleteMultipleGlossaryTerms(mangaKey, oris).then(res => sendResponse(res));
      return true;
  }

  if (message.action === 'deleteGlossary') {
      const { mangaKey } = message;
      if (!mangaKey) { sendResponse({ success: false, error: '缺少必要欄位' }); return false; }
      deleteGlossary(mangaKey).then(res => sendResponse(res));
      return true;
  }

  if (message.action === 'updateGlossaryDisplayName') {
      const { mangaKey, newDisplayName } = message;
      if (!mangaKey || !newDisplayName) { sendResponse({ success: false, error: '缺少必要欄位' }); return false; }
      updateGlossaryDisplayName(mangaKey, newDisplayName).then(res => sendResponse(res));
      return true;
  }

  if (message.action === 'importGlossaryTerms') {
      const { mangaKey, terms } = message;
      if (!mangaKey || !terms) { sendResponse({ success: false, error: '缺少必要欄位' }); return false; }
      importGlossaryTerms(mangaKey, terms).then(res => sendResponse(res));
      return true;
  }
  if (message.action === 'retranslateImage') {
      const { url, tabId, mangaKey } = message;
      (async () => {
          try {
              let base64 = null;
              if (url && url.startsWith('data:image')) {
                  base64 = url.split(',')[1];
              } else if (url) {
                  const maxDim = await state.get('imageMaxDimension', 1024);
                  const res = await fetch(url);
                  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
                  const blob = await res.blob();
                  base64 = await resizeImageBlobToBase64(blob, maxDim);
              }
              if (!base64) throw new Error('無法取得圖片 Base64');
              const modelName = await state.get('modelName', 'gemini-3.1-flash-lite');
              const fallbackModelName = await state.get('fallbackModelName', 'gemini-3.5-flash-lite');
              let finalPrompt = await state.get('customPrompt', Constants.DEFAULT_PROMPT_ONE_STEP);
              
              // 救援行動強制使用備援模型
              const usedModel = fallbackModelName || modelName;
              if (usedModel.toLowerCase().includes('gemma')) {
                  finalPrompt = Constants.DEFAULT_PROMPT_GEMMA_ONE_STEP;
              }
              
              let glossarySnippet = '';
              if (mangaKey) {
                  const gl = await loadGlossary(mangaKey);
                  if (gl?.terms) glossarySnippet = buildGlossaryPromptSnippet(gl.terms);
              }
              const result = await translateTexts([], {
                  model: usedModel,
                  prompt: finalPrompt,
                  glossarySnippet,
                  imageBase64: base64,
                  schema: {
                      type: 'OBJECT',
                      properties: {
                          results: {
                              type: 'ARRAY',
                              items: {
                                  type: 'OBJECT',
                                  properties: {
                                      original: { type: 'STRING' },
                                      translation: { type: 'STRING' }
                                  },
                                  required: ['original', 'translation']
                              }
                          }
                      },
                      required: ['results']
                  }
              });
              if (result?.results) {
                  // 修復 Bug #3：優先採用 translateTexts 回傳的 usedModelName（已由 translate-api.js 注入），
                  // 若為舊版未含該欄位則 fallback 至本次實際使用的 usedModel
                  sendResponse({ results: result.results, usedModelName: result.usedModelName || usedModel });
              } else {
                  throw new Error('API 回應格式異常');
              }
          } catch(e) {
              console.error('[Background] retranslateImage failed:', e);
              sendResponse({ success: false, error: e.message });
          }
      })();
      return true;
  }

  if (message.action === 'retranslateText') {
      const { text, mangaKey } = message;
      (async () => {
          try {
              const modelName = await state.get('modelName', 'gemini-3.1-flash-lite');
              const fallbackModelName = await state.get('fallbackModelName', 'gemini-3.5-flash-lite');
              let prompt = await state.get('customPrompt', Constants.DEFAULT_PROMPT_TWO_STEP);
              
              // 救援行動強制使用備援模型
              const usedModel = fallbackModelName || modelName;
              if (usedModel.toLowerCase().includes('gemma')) {
                  prompt = Constants.DEFAULT_PROMPT_GEMMA_ONE_STEP;
              }
              
              let glossarySnippet = '';
              if (mangaKey) {
                  const gl = await loadGlossary(mangaKey);
                  if (gl?.terms) glossarySnippet = buildGlossaryPromptSnippet(gl.terms);
              }
              const texts = text.split('\n\n').filter(t => t.trim());
              const result = await translateTexts(texts, {
                  model: usedModel,
                  prompt,
                  glossarySnippet,
                  schema: {
                      type: 'OBJECT',
                      properties: {
                          results: {
                              type: 'ARRAY',
                              items: {
                                  type: 'OBJECT',
                                  properties: {
                                      original: { type: 'STRING' },
                                      translation: { type: 'STRING' }
                                  },
                                  required: ['original', 'translation']
                              }
                          }
                      },
                      required: ['results']
                  }
              });
              if (result?.results) {
                  sendResponse({ results: result.results });
              } else {
                  throw new Error('API 回應格式異常');
              }
          } catch(e) {
              console.error('[Background] retranslateText failed:', e);
              sendResponse({ success: false, error: e.message });
          }
      })();
      return true;
  }

  if (message.action === 'retranslateNovelParagraph') {
      const { text, mangaKey } = message;
      (async () => {
          try {
              const model = await state.get('novelModelName', 'gemini-3.5-flash-lite');
              const prompt = await state.get('novelPrompt', Constants.DEFAULT_PROMPT_NOVEL);
              
              let glossarySnippet = '';
              if (mangaKey) {
                  const gl = await loadGlossary(mangaKey);
                  if (gl?.terms) glossarySnippet = buildGlossaryPromptSnippet(gl.terms);
              }
              
              const result = await translateTexts([text], {
                  model: model,
                  prompt: prompt,
                  glossarySnippet: glossarySnippet,
                  schema: {
                      type: 'OBJECT',
                      properties: {
                          results: {
                              type: 'ARRAY',
                              items: { type: 'STRING' }
                          }
                      },
                      required: ['results']
                  }
              });
              
              if (result?.results && result.results[0]) {
                  await incrementDailyUsage(model);
                  sendResponse({ success: true, translation: result.results[0] });
              } else {
                  throw new Error('API 回應格式異常');
              }
          } catch(e) {
              console.error('[Background] retranslateNovelParagraph failed:', e);
              sendResponse({ success: false, error: e.message });
          }
      })();
      return true;
  }

  if (message.action === 'navigateAndTranslate') {
      const { url, tabId, mangaKey, mobile } = message;
      if (!url) { sendResponse({ status: 'error' }); return false; }
      
      const resultTabId = sender.tab?.id || null;
      log.info('Navigation', `[跳轉] 收到跳轉請求: ${url} (來源分頁: ${tabId})`);

      const setupNavigation = async () => {
          let targetTabId = tabId;
          
          // 驗證分頁是否存在
          let tabExists = false;
          if (targetTabId) {
              try {
                  const existing = await chrome.tabs.get(targetTabId);
                  if (existing) tabExists = true;
              } catch (_) {}
          }

          if (tabExists) {
              await state.set('pendingAutoTranslate', { tabId: targetTabId, resultTabId, mangaKey: mangaKey || null, mobile: !!mobile });
              chrome.tabs.update(targetTabId, { url }, () => {
                  if (chrome.runtime.lastError) {
                      log.warn('Navigation', `navigateAndTranslate update 失敗: ${chrome.runtime.lastError.message}`);
                  }
              });
          } else {
              // 若原分頁已不存在，自動建立後台新分頁加載新章節
              log.info('Navigation', `原宿主分頁已不存在，自動開啟新分頁載入新話數...`);
              const newTab = await chrome.tabs.create({ url, active: false });
              targetTabId = newTab.id;
              await state.set('pendingAutoTranslate', { tabId: targetTabId, resultTabId, mangaKey: mangaKey || null, mobile: !!mobile });
          }

          // ── 3.5秒超時保險機制 ──
          // 防止某些漫畫網站第三方廣告卡住 status==='complete' 導致無法觸發 onUpdated
          setTimeout(async () => {
              const pending = await state.get('pendingAutoTranslate', null);
              if (pending && pending.tabId === targetTabId) {
                  log.info('Navigation', `[超時保險] 目標分頁 onUpdated 逾時未觸發 complete，主動啟動抓圖接力翻譯...`);
                  await state.set('pendingAutoTranslate', null);
                  autoStartBatchWithRetry(targetTabId, pending.resultTabId, pending.mangaKey, pending.mobile);
              }
          }, 3500);
      };

      setupNavigation().catch(err => {
          log.error('Navigation', `跳轉處理發生異常: ${err.message}`);
      });

      sendResponse({ status: 'navigating' });
      return false;
  }

  if (message.action === 'MOBILE_CRAWL_IMAGES') {
      const { sourceTabId } = message.payload;
      chrome.tabs.sendMessage(sourceTabId, { action: 'crawlImages' }, (response) => {
          if (chrome.runtime.lastError) {
              log.error('Background', `Mobile crawl failed: ${chrome.runtime.lastError.message}`);
              sendResponse({ images: [] });
          } else {
              sendResponse({ images: response?.images || [] });
          }
      });
      return true; // 非同步
  }

  if (message.action === 'START_MANGA_BATCH_MOBILE_MODE') {
      const { sourceTabId, images, navLinks } = message.payload;
      const mobileTabId = sender.tab?.id;
      if (mobileTabId) {
          startNewMangaBatchProcessing(sourceTabId, mobileTabId, images, navLinks || null)
              .catch(err => log.error('Background', `行動版漫畫翻譯啟動失敗: ${err.message}`));
      }
      sendResponse({ status: 'ok' });
      return false;
  }

  // ── P0 移植：prepareTab — 確保 Content Script 已注入（對齊 v1.8.7） ──
  if (message.action === 'prepareTab') {
      const targetTabId = message.tabId || sender.tab?.id;
      ensureContentScriptInjected(targetTabId).then(ready => {
          sendResponse({ ready });
      }).catch(() => sendResponse({ ready: false }));
      return true; // 非同步
  }

  // ── P0 移植：toggleBatchPause — 批次翻譯暫停/繼續（對齊 v1.8.7） ──
  if (message.action === 'toggleBatchPause') {
      state.get('isBatchPaused', false).then(currentPaused => {
          const newPaused = !currentPaused;
          state.set('isBatchPaused', newPaused).then(() => {
              log.info('Background', `批次翻譯狀態: ${newPaused ? '暫停' : '繼續'}`);
              sendResponse({ status: newPaused ? 'paused' : 'running' });
          });
      });
      return true; // 非同步
  }

  if (message.action === 'SET_BATCH_PAUSE') {
      state.set('isBatchPaused', !!message.paused).then(() => {
          sendResponse({ status: message.paused ? 'paused' : 'running' });
      }).catch(err => sendResponse({ success: false, error: err.message }));
      return true;
  }


  // ── P0 移植：abortNovelTranslation / setNovelMode / getNovelModeState — 小説翻譯控制（對齊 v1.8.7） ──
  if (message.action === 'abortNovelTranslation') {
      const targetTabId = message.tabId || sender.tab?.id;
      log.info('Background', `[Novel] 中止分頁 ${targetTabId} 的小説翻譯任務`);
      // 对此分頁的 content script 發送中止指令
      chrome.tabs.sendMessage(targetTabId, { action: 'abortNovelTranslation' }).catch(() => {});
      sendResponse({ ok: true });
      return false;
  }

  // ── P1 移植：getDailyTokenCount — API 配額顯示（對齊 v1.8.7） ──
  if (message.action === 'getDailyTokenCount') {
      state.get('usageDate', '').then(async savedDate => {
          const today = new Date().toISOString().split('T')[0];
          if (savedDate !== today) {
              await state.set('usageDate', today);
              await state.set('usageCount', 0);
              sendResponse({ count: 0 });
          } else {
              const count = await state.get('usageCount', 0);
              sendResponse({ count });
          }
      }).catch(() => sendResponse({ count: 0 }));
      return true; // 非同步
  }

  // ── 整批重試 / 指定批次重翻 — 一鍵重試圖片（不開新分頁） ──
  if (message.action === 'RETRY_FAILED_BATCH') {
      const { images, sourceTabId: retrySourceTabId, targetBatchIndex, mangaKey } = message;
      const retryResultTabId = message.resultTabId || sender.tab?.id;
      if (!images || images.length === 0 || !retryResultTabId) {
          sendResponse({ status: 'error', error: '缺少圖片清單或結果分頁 ID' });
          return false;
      }
      startNewMangaBatchProcessing(retrySourceTabId || null, retryResultTabId, images, null, true, targetBatchIndex, mangaKey || null)
          .catch(err => log.error('Background', `重試批次啟動失敗: ${err.message}`));
      log.info('Background', `[重試批次] 收到 ${images.length} 張圖片，重翻指定批次 #${targetBatchIndex !== undefined ? targetBatchIndex + 1 : '全'} (作品: ${mangaKey || '自動辨識'})... (resultTabId: ${retryResultTabId})`);
      sendResponse({ status: 'retrying' });
      return false;
  }

  // ── 批次重翻整個作品/整批 ──
  if (message.action === 'RETRANSLATE_ALL_BATCH') {
      const { images, sourceTabId: retrySourceTabId, mangaKey } = message;
      const retryResultTabId = message.resultTabId || sender.tab?.id;
      if (!images || images.length === 0 || !retryResultTabId) {
          sendResponse({ status: 'error', error: '缺少圖片清單或結果分頁 ID' });
          return false;
      }

      state.set('isStopping', true);

      setTimeout(async () => {
          log.info('Background', `[重翻批次] 收到 ${images.length} 張圖片，開始重新翻譯 (作品: ${mangaKey || '自動辨識'})... (resultTabId: ${retryResultTabId})`);
          startNewMangaBatchProcessing(retrySourceTabId || null, retryResultTabId, images, null, false, null, mangaKey || null)
              .catch(err => log.error('Background', `重翻批次啟動失敗: ${err.message}`));
      }, 300);

      sendResponse({ status: 'retrying' });
      return false;
  }

  return false;
});


async function cropImageBase64(fullBase64, rect) {
    if (!fullBase64) throw new Error("No base64 image provided");
    const res = await fetch(fullBase64);
    const blob = await res.blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(rect.width, rect.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
    const croppedBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.95 });
    
    // ArrayBuffer to Base64 (Safe for Service Workers)
    const arrayBuffer = await croppedBlob.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

/**
 * resizeImageBlobToBase64 — 將抓取到的 Blob 轉換為 ImageBitmap，並利用 OffscreenCanvas 等比例縮小到 maxDim (e.g. 1024px) 後，以 JPEG 壓縮格式輸出為 Base64。
 * 如果 maxDim 為 0 或未設定，則不進行縮放，直接轉 Base64。
 */
async function resizeImageBlobToBase64(blob, maxDim) {
    if (!maxDim || maxDim <= 0) {
        const arrayBuffer = await blob.arrayBuffer();
        const bytes = new Uint8Array(arrayBuffer);
        let binary = '';
        const chunk_size = 0x8000;
        for (let b = 0; b < bytes.byteLength; b += chunk_size) {
            binary += String.fromCharCode.apply(null, bytes.subarray(b, b + chunk_size));
        }
        return btoa(binary);
    }

    try {
        const bitmap = await createImageBitmap(blob);
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

        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0, width, height);
        
        // 匯出為壓縮度與辨識度最佳平衡的 jpeg (品質設為 0.82，Payload 體積減少 ~35%，日文對白字體依然銳利)
        const compressedBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.82 });
        const arrayBuffer = await compressedBlob.arrayBuffer();
        const bytes = new Uint8Array(arrayBuffer);
        let binary = '';
        const chunk_size = 0x8000;
        for (let b = 0; b < bytes.byteLength; b += chunk_size) {
            binary += String.fromCharCode.apply(null, bytes.subarray(b, b + chunk_size));
        }
        bitmap.close(); // 即時釋放顯存/記憶體
        return btoa(binary);
    } catch (err) {
        log.warn('Background', `圖片壓縮處理失敗，退回原圖: ${err.message}`);
        const arrayBuffer = await blob.arrayBuffer();
        const bytes = new Uint8Array(arrayBuffer);
        let binary = '';
        const chunk_size = 0x8000;
        for (let b = 0; b < bytes.byteLength; b += chunk_size) {
            binary += String.fromCharCode.apply(null, bytes.subarray(b, b + chunk_size));
        }
        return btoa(binary);
    }
}

// ── 跨話無縫連續追漫：預翻快取池與任務控制器 ──
const pretranslatedChaptersMap = new Map(); // key: chapterUrl, value: { url, images, results, navLinks, usedModelName, isDone, inProgress, error, associatedResultTabId, sourceTabId }
let activePretranslateJob = null;
const PRETRANS_STORAGE_KEY = 'mt_pretranslated_chapters_cache';

async function savePretranslatedChapterToStorage(url, data) {
    try {
        const stored = await state.get(PRETRANS_STORAGE_KEY, {});
        // 只保留最新 2 話快取，防止佔滿 storage 配額
        const keys = Object.keys(stored);
        if (keys.length >= 3) {
            delete stored[keys[0]];
        }
        stored[url] = data;
        await state.set(PRETRANS_STORAGE_KEY, stored);
    } catch (e) {
        log.warn('Background', `預翻資料持久化寫入失敗: ${e.message}`);
    }
}

async function getPretranslatedChapterFromStorage(url) {
    try {
        const stored = await state.get(PRETRANS_STORAGE_KEY, {});
        return stored[url] || null;
    } catch (_) {
        return null;
    }
}

/**
 * crawlChapterImagesAndNav — 在背景靜默抓取下一話 HTML，並提取漫畫圖片清單與下下一話導航連結
 */
async function crawlChapterImagesAndNav(chapterUrl) {
    try {
        log.info('Background', `[跨話靜默探針] 正在抓取下一話 HTML: ${chapterUrl}...`);
        const res = await fetch(chapterUrl, {
            headers: {
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'User-Agent': navigator.userAgent
            }
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const html = await res.text();

        // 1. 優先從漫畫正文容器抽取 (避免抓到 Header Logo, 按鈕圖示, 訪客計數器與 Footer 雜圖)
        const images = [];
        const seenUrls = new Set();
        const junkKeywords = [
            'logo', 'banner', 'icon', 'button', 'turn-off', 'light', 'dark', 'avatar',
            'widget', 'social', 'badge', 'emoji', 'reaction', 'loading', 'placeholder',
            'thumb', 'small', 'header', 'footer', 'advert', 'donate', 'rating', 'vote',
            '512x512', '256x256', '128x128', 'chance-load', 'lzloader', 'captcha',
            'counter', 'whos.amung.us', 'hits', 'visitor', 'online', 'flagcounter', 'stat',
            'histats', 'tracker', 'clustrmaps', 'fc2.com', '99counter', 'cbox', 'user_online',
            'users_online', 'viewcount', 'traffic'
        ];

        // 嘗試截取主流漫畫容器 HTML
        let targetHtml = html;
        const containerMatch = html.match(/<(?:div|article|section)[^>]+(?:id|class)=["'](?:readerarea|reading-content|list-imga|ts-main-image|manga-image|viewer-cnt|chapter-content)["'][^>]*>([\s\S]*?)<\/(?:div|article|section)>/i);
        if (containerMatch && containerMatch[1]) {
            targetHtml = containerMatch[1];
        }

        const imgRegex = /<img[^>]+(?:data-src|data-lazy-src|data-original|data-aload|src)=["']([^"']+)["'][^>]*>/gi;
        let match;
        while ((match = imgRegex.exec(targetHtml)) !== null) {
            const fullTag = match[0];
            let imgUrl = match[1].trim();
            if (!imgUrl || imgUrl.startsWith('data:') || imgUrl.endsWith('.svg')) continue;
            
            const lower = (imgUrl + ' ' + fullTag).toLowerCase();
            const isJunk = junkKeywords.some(k => lower.includes(k));
            if (isJunk) continue;

            // 檢查標籤中是否有小尺寸屬性 (如 width="80" 或 height="30")
            const dimMatch = fullTag.match(/(?:width|height)=["']?(\d+)["']?/i);
            if (dimMatch && parseInt(dimMatch[1]) > 0 && parseInt(dimMatch[1]) < 200) {
                continue; // 排除小於 200px 的計數器與按鈕
            }

            try {
                imgUrl = new URL(imgUrl, chapterUrl).href;
            } catch (_) {}

            if (!seenUrls.has(imgUrl)) {
                seenUrls.add(imgUrl);
                images.push(imgUrl);
            }
        }

        // 2. 提取下下一話與上一話導航連結 (支援下拉選單與連結標籤)
        let nextNav = null;
        let prevNav = null;

        // 下拉選單解析
        const selectMatch = html.match(/<select[^>]*>([\s\S]*?)<\/select>/i);
        if (selectMatch && selectMatch[1]) {
            const optRegex = /<option[^>]+value=["']([^"']+)["'][^>]*>([\s\S]*?)<\/option>/gi;
            const optList = [];
            let currentOptIdx = -1;
            let optMatch;
            while ((optMatch = optRegex.exec(selectMatch[1])) !== null) {
                const optVal = optMatch[1].trim();
                const isCur = optMatch[0].includes('selected') || (optVal && chapterUrl.includes(optVal));
                if (isCur) currentOptIdx = optList.length;
                optList.push(optVal);
            }
            if (currentOptIdx !== -1 && optList.length >= 2) {
                const isDesc = optList[0] > optList[optList.length - 1];
                if (isDesc) {
                    if (currentOptIdx > 0) nextNav = new URL(optList[currentOptIdx - 1], chapterUrl).href;
                    if (currentOptIdx < optList.length - 1) prevNav = new URL(optList[currentOptIdx + 1], chapterUrl).href;
                } else {
                    if (currentOptIdx < optList.length - 1) nextNav = new URL(optList[currentOptIdx + 1], chapterUrl).href;
                    if (currentOptIdx > 0) prevNav = new URL(optList[currentOptIdx - 1], chapterUrl).href;
                }
            }
        }

        // 連結標籤解析 (若未從 select 取得)
        if (!nextNav || !prevNav) {
            const linkRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
            while ((match = linkRegex.exec(html)) !== null) {
                const href = match[1].trim();
                const text = match[2].replace(/<[^>]+>/g, '').trim();
                if (!href || href === '#' || href.startsWith('javascript:')) continue;

                let absHref;
                try {
                    absHref = new URL(href, chapterUrl).href;
                } catch (_) {
                    continue;
                }

                if (/下一[話话頁页章回節节]|next(?:\s*page|\s*chapter)?|次へ/i.test(text) || /(?:next|next-chapter|next_page)/i.test(href)) {
                    if (!nextNav && absHref !== chapterUrl) nextNav = absHref;
                }
                if (/上一[話话頁页章回節节]|prev(?:ious)?|前へ/i.test(text) || /(?:prev|prev-chapter|prev_page)/i.test(href)) {
                    if (!prevNav && absHref !== chapterUrl) prevNav = absHref;
                }
            }
        }

        return {
            images,
            navLinks: { prev: prevNav, next: nextNav }
        };
    } catch (err) {
        log.warn('Background', `[跨話靜默探針] HTML 抓取解析失敗: ${err.message}`);
        return { images: [], navLinks: { prev: null, next: null } };
    }
}

/**
 * startPretranslateNextChapter — 啟動下一話的背景靜默預翻 (嚴格單話佇列 + SW保活 + Session Checkpoint 斷點續翻)
 */
async function startPretranslateNextChapter(nextUrl, sourceTabId, resultTabId) {
    if (!nextUrl || typeof nextUrl !== 'string') return;
    const isEnabled = await state.get('autoPretranslateNextChapter', true);
    if (!isEnabled) return;

    let resumeIndex = 0;
    let initialResults = [];
    let jobData = null;

    if (pretranslatedChaptersMap.has(nextUrl)) {
        const existing = pretranslatedChaptersMap.get(nextUrl);
        if (existing.isDone || existing.inProgress) {
            log.info('Background', `[跨話連續追漫] 下一話 ${nextUrl} 已經在預翻或已完成，不重複觸發`);
            return;
        }
        if (existing.status === 'interrupted') {
            resumeIndex = getPretranslationResumeIndex(existing);
            initialResults = Array.isArray(existing.results) ? [...existing.results] : [];
            jobData = existing;
            jobData.inProgress = true;
            jobData.isCancelled = false;
            jobData.sourceTabId = sourceTabId || existing.sourceTabId;
            jobData.associatedResultTabId = resultTabId || existing.associatedResultTabId;
        }
    }

    const batchSizeSetting = await state.get('ocrBatchSize', 10);
    const batchSize = Math.max(1, parseInt(batchSizeSetting) || 10);

    if (!jobData) {
        jobData = {
            url: nextUrl,
            images: [],
            results: [],
            navLinks: null,
            usedModelName: null,
            batchSize: batchSize,
            isDone: false,
            inProgress: true,
            isCancelled: false,
            sourceTabId,
            associatedResultTabId: resultTabId,
            startTime: Date.now(),
            processedCount: 0
        };
        pretranslatedChaptersMap.set(nextUrl, jobData);
    }
    activePretranslateJob = jobData;
    swKeepAlive.start();

    log.info('Background', `[跨話連續追漫] 🚀 開始在背景靜默預翻下一話: ${nextUrl} (起始索引: ${resumeIndex})`);
    try {
        let chapterImages = jobData.images;
        let navLinks = jobData.navLinks;

        if (!chapterImages || chapterImages.length === 0) {
            const crawlData = await crawlChapterImagesAndNav(nextUrl);
            if (!crawlData.images || crawlData.images.length === 0) throw new Error('無法獲取圖片');
            chapterImages = crawlData.images;
            navLinks = crawlData.navLinks;
            jobData.images = chapterImages;
            jobData.navLinks = navLinks;
            log.info('Background', `[跨話連續追漫] 成功抓取下一話 ${chapterImages.length} 張圖片，下下一話連結: ${navLinks?.next || '無'}`);
        }

        // 確保 results 只包含 resumeIndex 之前的已完成項目，防止重複
        jobData.results = initialResults.slice(0, resumeIndex);
        jobData.processedCount = jobData.results.length;

        const modelName = await state.get('modelName', 'gemini-3.1-flash-lite');
        const customPrompt = await state.get('customPrompt', Constants.DEFAULT_PROMPT_ONE_STEP);
        const finalPrompt = modelName.toLowerCase().includes('gemma')
            ? Constants.DEFAULT_PROMPT_GEMMA_ONE_STEP : customPrompt;
        const navCtx = await state.get('navigationContext', {});
        const mangaKey = navCtx[sourceTabId] || navCtx[resultTabId];
        let glossarySnippet = '';
        if (mangaKey) {
            const glossary = await loadGlossary(mangaKey);
            if (glossary?.terms?.length) glossarySnippet = buildGlossaryPromptSnippet(glossary.terms);
        }
        const maxDim = parseInt(await state.get('imageMaxDimension', 1024)) || 1024;
        const requestDelay = await state.get('requestDelay', 4000);

        const candidateKeys = (state.apiKeys && state.apiKeys.length > 0) ? [...state.apiKeys] : [null];
        const isHybrid = (await state.get('hybridModeEnabled', true)) && !modelName.toLowerCase().includes('gemma');
        const secondaryModelName = await state.get('secondaryModelName', 'gemini-3.5-flash-lite');
        const effectiveDelay = getEffectiveDelay(requestDelay, isHybrid, candidateKeys.length);

        for (let i = resumeIndex; i < chapterImages.length; i += batchSize) {
            if (jobData.isCancelled) {
                log.info('Background', `[跨話連續追漫] 任務已被取消，停止預翻`);
                break;
            }
            const currentBatch = chapterImages.slice(i, i + batchSize);
            const batchIdx = Math.floor(i / batchSize);
            const schedule = getHybridSchedule(batchIdx, candidateKeys.length, isHybrid, modelName, secondaryModelName);
            const batchModel = schedule.modelName;
            const scheduledKey = candidateKeys[schedule.keyIndex];
            const base64List = await fetchAndResizeBatch(currentBatch, maxDim, sourceTabId);
            const validItems = base64List
                .map((b64, idx) => ({ b64, originalIdx: idx }))
                .filter(item => typeof item.b64 === 'string' && item.b64);
            let batchResults;
            if (validItems.length > 0) {
                try {
                    const execution = await executeHybridRequest({
                        candidateKeys, scheduledKey, scheduledModel: batchModel, primaryModel: modelName,
                        secondaryModel: secondaryModelName, isHybrid,
                        shouldContinue: () => !jobData.isCancelled,
                        request: ({ apiKey, modelName: requestModel }) => callGeminiAPIBatch(
                            validItems.map(v => v.b64), finalPrompt, glossarySnippet, apiKey, requestModel
                        )
                    });
                    batchResults = mapPretranslationBatchResults(currentBatch, base64List, validItems, execution.results, execution.usedModelName);
                    jobData.usedModelName = execution.usedModelName;
                } catch (apiErr) {
                    log.warn('Background', `[跨話連續追漫] 批次翻譯錯誤 (${state.getApiKeyAlias(scheduledKey)} | ${batchModel}): ${apiErr.message}`);
                    batchResults = mapPretranslationBatchResults(currentBatch, base64List, validItems, null, batchModel, apiErr);
                }
            } else {
                batchResults = mapPretranslationBatchResults(currentBatch, base64List, validItems, null, batchModel);
            }

            jobData.results.push(...batchResults);
            jobData.processedCount = jobData.results.length;

            // 每完成一批，立即保存 Session Checkpoint
            await savePretranslationCheckpoint(jobData);

            // 若讀者已切換至本話，即時串流推送本批翻譯結果至結果頁
            if (jobData.associatedResultTabId) {
                chrome.tabs.sendMessage(jobData.associatedResultTabId, {
                    action: 'batchComplete',
                    batchIndex: Math.floor(i / batchSize),
                    totalBatches: Math.ceil(chapterImages.length / batchSize),
                    batchResults: batchResults,
                    isLastBatch: (i + batchSize >= chapterImages.length)
                }).catch(() => {});
            }

            if (i + batchSize < chapterImages.length && !jobData.isCancelled) {
                await new Promise(r => setTimeout(r, effectiveDelay));
            }
        }

        jobData.usedModelName ||= modelName;
        const completion = getPretranslationCompletion({
            isCancelled: jobData.isCancelled,
            resultCount: jobData.results.length,
            imageCount: jobData.images.length
        });
        jobData.status = completion.status;
        jobData.isDone = completion.isDone;
        if (completion.status === 'cancelled') {
            await removePretranslationCheckpoint(nextUrl);
            log.info('Background', `[跨話連續追漫] 下一話預翻已取消`);
        } else if (completion.status === 'completed') {
            // 先保存完成的 local 快取，再清理 session checkpoint
            await savePretranslatedChapterToStorage(nextUrl, jobData);
            await removePretranslationCheckpoint(nextUrl);
            log.info('Background', `[跨話連續追漫] 🎉 下一話 (${nextUrl}) 全部預翻完成！共 ${jobData.results.length} 頁已在記憶體待命！`);
        } else {
            jobData.error = completion.error;
            await removePretranslationCheckpoint(nextUrl);
            log.warn('Background', `[跨話連續追漫] 預翻結果不完整 (${jobData.results.length}/${jobData.images.length})`);
        }
    } catch (err) {
        jobData.error = err.message;
        jobData.status = 'error';
        await removePretranslationCheckpoint(nextUrl);
        log.warn('Background', `[跨話連續追漫] 預翻失敗: ${err.message}`);
    } finally {
        jobData.inProgress = false;
        jobData.isDone = jobData.status === 'completed';
        if (activePretranslateJob === jobData) activePretranslateJob = null;
        swKeepAlive.stop();
    }
}

/**
 * fetchAndResizeBatch — 專職負責將指定批次的圖片進行並行抓取、Blob 轉換與 OffscreenCanvas 等比例縮放
 * 支援雙緩衝管線 (Pipeline Prefetching) 在背景非同步提前預載
 * @param {Array} batch - 當前批次圖片陣列
 * @param {number} maxDim - 最大限制尺寸
 * @param {number|string} sourceTabId - 來源分頁 ID
 * @returns {Promise<Array<string|null>>} Base64 字串陣列
 */
async function fetchAndResizeBatch(batch, maxDim, sourceTabId) {
    return Promise.all(batch.map(async (imgData) => {
        const imgSrc = imgData.src || imgData;
        if (!imgSrc) return null;
        if (typeof imgSrc === 'string' && imgSrc.startsWith('data:image')) {
            return imgSrc.split(',')[1];
        }
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 10000);
            const res = await fetch(imgSrc, { signal: controller.signal });
            clearTimeout(timeoutId);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const blob = await res.blob();
            return await resizeImageBlobToBase64(blob, maxDim);
        } catch (fetchErr) {
            // 退回 Content Script 備援
            if (sourceTabId && sourceTabId !== 'current') {
                const resp = await Promise.race([
                    new Promise(resolve => chrome.tabs.sendMessage(sourceTabId, { action: 'fetchBase64', url: imgSrc, maxDim }, resolve)),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Content Script fetch Timeout')), 15000))
                ]).catch(e => ({ error: e.message }));
                return resp?.base64 || null;
            }
            return null;
        }
    }));
}

async function handleProcessScreenshot(rect, tabId) {
    try {
        if (!capturedScreenshotForSelection) {
            throw new Error("截圖資料遺失，請重新框選");
        }
        
        // 1. 裁切圖片取得 base64 (不含 data:image/jpeg;base64, 前綴)
        const croppedBase64 = await cropImageBase64(capturedScreenshotForSelection, rect);
        
        // 2. 獲取翻譯設定與詞庫
        const modelName = await state.get('modelName', 'gemini-3.1-flash-lite');
        const customPrompt = await state.get('customPrompt', 'Translate to Traditional Chinese.');
        const navCtx = await state.get('navigationContext', {});
        const mangaKey = navCtx[tabId];
        let glossarySnippet = '';
        if (mangaKey) {
            const currentGlossary = await loadGlossary(mangaKey);
            if (currentGlossary && currentGlossary.terms) {
                glossarySnippet = buildGlossaryPromptSnippet(currentGlossary.terms);
            }
        }

        // 3. 呼叫翻譯 (一條龍 Vison 模式)
        // 關鍵修正：對齊黃金 Prompt 格式要求
        let finalPrompt = customPrompt;
        if (modelName.toLowerCase().includes('gemma')) {
            finalPrompt = Constants.DEFAULT_PROMPT_GEMMA_ONE_STEP;
        }

        const result = await translateTexts([], {
            model: modelName,
            prompt: finalPrompt,
            glossarySnippet: glossarySnippet,
            imageBase64: croppedBase64,
            schema: {
                type: 'OBJECT',
                properties: {
                    results: {
                        type: 'ARRAY',
                        items: {
                            type: 'OBJECT',
                            properties: {
                                original: { type: 'STRING' },
                                translation: { type: 'STRING' }
                            },
                            required: ['original', 'translation']
                        }
                    }
                },
                required: ['results']
            }
        });

        if (result && result.results) {
            return { success: true, result: result };
        } else {
            throw new Error("API 請求成功但無回傳文字");
        }
    } catch (err) {
        console.error("[ProcessScreenshot] 處理過程發生錯誤:", err);
        return { success: false, error: err.message };
    }
}

/**
 * openNewResultPage — 開一個新的結果頁並儲存 pendingBatchJobs
 * 供 navigateAndTranslate 的 fallback（結果頁已關閉時）使用
 */
function openNewResultPage(sourceTabId, images, navLinks, mangaKey, mobile) {
    const mobileParam = mobile ? '&mobile=1' : '&mobile=0';
    chrome.tabs.get(sourceTabId, (sourceTab) => {
        const targetWindowId = sourceTab ? sourceTab.windowId : undefined;
        chrome.tabs.create({
            url: chrome.runtime.getURL('src/reader/result.html') + `?tabId=${sourceTabId}${mobileParam}`,
            windowId: targetWindowId
        }, (resultTab) => {
            if (chrome.runtime.lastError) {
                // Fallback
                chrome.tabs.create({
                    url: chrome.runtime.getURL('src/reader/result.html') + `?tabId=${sourceTabId}${mobileParam}`
                }, (tab2) => setupNewResultPageJob(tab2, sourceTabId, images, navLinks, mangaKey));
            } else {
                setupNewResultPageJob(resultTab, sourceTabId, images, navLinks, mangaKey);
            }
        });
    });
}

function setupNewResultPageJob(resultTab, sourceTabId, images, navLinks, mangaKey) {
    if (!resultTab) {
        log.warn('Background', 'openNewResultPage: 無法建立結果頁');
        return;
    }
    state.get('pendingBatchJobs', {}).then(jobs => {
        jobs[resultTab.id] = { sourceTabId, images, navLinks: navLinks || null, mangaKey: mangaKey || null };
        state.set('pendingBatchJobs', jobs);
        setTimeout(() => {
            state.get('pendingBatchJobs', {}).then(jobs2 => {
                delete jobs2[resultTab.id];
                state.set('pendingBatchJobs', jobs2);
            });
        }, 60000);
    });
}

/**
 * 漫畫批次翻譯統一派發器：依據使用者設定之 translationMode 分流
 * - one-step: 一條龍模式 (每批圖片直接送 Vision 直譯，極速、零等待)
 * - two-step: 雙階段模式 (先快速 OCR 提煉全書劇本 ➔ 1次通讀暫存劇情大綱與角色關係 ➔ 帶全域記憶 Vision 精翻)
 */
async function startNewMangaBatchProcessing(sourceTabId, resultTabId, images, navLinks = null, isRetry = false, targetBatchIndex = null, customMangaKey = null) {
    let createdRun;
    await withMangaStartLock(async () => {
        // STOP 後等待所有舊任務離開其 finally，才可清除全域停止/暫停旗標。
        await Promise.allSettled([...activeMangaTranslationRuns]);
        await state.set('isStopping', false);
        await state.set('isBatchPaused', false);

        // dispatch 建立並追蹤 run 後立即釋放啟動鎖；翻譯本身不佔用 mutex。
        createdRun = (await dispatchMangaBatchProcessing(
            sourceTabId, resultTabId, images, navLinks, isRetry, targetBatchIndex, customMangaKey
        )).run;
    });
    return createdRun;
}

async function dispatchMangaBatchProcessing(sourceTabId, resultTabId, images, navLinks = null, isRetry = false, targetBatchIndex = null, customMangaKey = null) {
    const mode = await state.get('translationMode', 'one-step');
    log.info('Background', `[任務派發] 當前模式: ${mode}，圖片數: ${images.length}，是否重試: ${isRetry}，指定作品Key: ${customMangaKey || '無'}`);
    const run = (mode === 'two-step' && !isRetry)
        ? processMangaBatchTwoStepMode(sourceTabId, resultTabId, images, navLinks, isRetry, targetBatchIndex, customMangaKey)
        : processMangaBatchPCMode(sourceTabId, resultTabId, images, navLinks, isRetry, targetBatchIndex, '', customMangaKey);
    activeMangaTranslationRuns.add(run);
    run.finally(() => {
        activeMangaTranslationRuns.delete(run);
    }).catch(err => log.error('Background', `漫畫翻譯任務結束時發生錯誤: ${err.message}`));
    return { run };
}

/**
 * 【雙階段模式 (Two-Step Story Pipeline)】專屬處理器：
 * 階段 1：使用 ocrModelName (如 Gemma 4 26B / Flash-Lite) 快速提取全書純日文對白，拼裝成 fullScriptText
 * 階段 1.5：1 次純文字 API 通讀全本台詞，萃取【單話劇情大綱 + 角色關係 + 專有名詞】
 *           - 單話劇情大綱與角色關係 ➔ 寫入 sessionStoryContext 短期暫存
 *           - 專屬術語 ➔ 合併存入長期詞庫 (saveGlossary)
 * 階段 2：組合 sessionContextSnippet，呼叫 Vision 精翻輸出
 */
async function processMangaBatchTwoStepMode(sourceTabId, resultTabId, images, navLinks = null, isRetry = false, targetBatchIndex = null, customMangaKey = null) {
    if (sourceTabId) activeTranslationJobs.set(sourceTabId, { sourceTabId, resultTabId, imgCount: images.length, mode: 'two-step' });
    if (resultTabId) activeTranslationJobs.set(resultTabId, { sourceTabId, resultTabId, imgCount: images.length, mode: 'two-step' });

    const broadcastStatus = (msg, type = 'info') => {
        if (!sourceTabId) return;
        chrome.tabs.sendMessage(sourceTabId, {
            action: 'TRANSLATION_STATUS',
            payload: { msg, type }
        }).catch(() => {});
    };

    swKeepAlive.start();
    try {
        log.info('TwoStepPipeline', `啟動雙階段劇本預讀工作流：共 ${images.length} 張圖片`);
        broadcastStatus(`📖 [階段 1] 啟動 OCR 提取全書台詞劇本 (共 ${images.length} 頁)...`, 'info');
        chrome.tabs.sendMessage(resultTabId, {
            action: 'updateProgress',
            current: `正在提取全書劇本 (0/${images.length})`,
            total: images.length
        });

    const maxDim = parseInt(await state.get('imageMaxDimension', 1280)) || 1280;
    const ocrModelName = await state.get('ocrModelName', 'gemini-3.1-flash-lite');
    const isWasmOcr = (ocrModelName === 'local-wasm-ocr');
    const ocrBatchSize = parseInt(await state.get('ocrBatchSize', 10)) || 10;

    log.info('TwoStepPipeline', `[階段 1] 模式: ${isWasmOcr ? '💻 本地 WASM OCR' : `☁️ 雲端批次 OCR (${ocrModelName})`}，每批打包: ${ocrBatchSize} 頁，傳送尺寸: ${maxDim}px`);

    // ── 階段 1：OCR 提取全書台詞 (雙緩衝管線預載) ──
    const scriptLines = [];
    let nextOcrBatchPromise = (images.length > 0)
        ? fetchAndResizeBatch(images.slice(0, ocrBatchSize), maxDim, sourceTabId)
        : Promise.resolve([]);

    for (let i = 0; i < images.length; i += ocrBatchSize) {
        if (await state.get('isStopping')) break;
        const currentBatch = images.slice(i, i + ocrBatchSize);
        const startPage = i + 1;
        const endPage = Math.min(i + ocrBatchSize, images.length);

        chrome.tabs.sendMessage(resultTabId, {
            action: 'updateProgress',
            current: `正在提取第 ${startPage}~${endPage} 頁劇本...`,
            total: images.length
        }).catch(() => {});
        broadcastStatus(`📖 [階段 1] 正在提取第 ${startPage}~${endPage} 頁劇本...`, 'info');

        // 1. 取得本批預先壓縮好的 Base64
        const base64List = await nextOcrBatchPromise;

        // 預載結束後、發起任何 OCR API 之前，立即再次檢查 isStopping
        if (await state.get('isStopping')) break;

        // 2. 雙緩衝管線：若有下一批，立即在發送 API 前啟動背景預載預壓
        const nextOcrStart = i + ocrBatchSize;
        if (nextOcrStart < images.length) {
            nextOcrBatchPromise = fetchAndResizeBatch(images.slice(nextOcrStart, nextOcrStart + ocrBatchSize), maxDim, sourceTabId);
        } else {
            nextOcrBatchPromise = Promise.resolve([]);
        }

        let batchScripts = [];
        if (isWasmOcr) {
            batchScripts = await wasmOcrEngine.recognizeBatch(base64List);
        } else {
            try {
                batchScripts = await callGeminiAPIBatchOcr(base64List, {
                    model: ocrModelName,
                    pageOffset: i
                });
            } catch (batchOcrErr) {
                log.warn('TwoStepPipeline', `第 ${startPage}~${endPage} 頁批次 OCR 失敗，嘗試逐張重試: ${batchOcrErr.message}`);
                batchScripts = await executeOcrFallbackImages({
                    base64List,
                    extractSingle: (b64) => extractTextFromImage(b64, { model: ocrModelName }),
                    shouldContinue: async () => !(await state.get('isStopping'))
                });
            }
        }

        batchScripts.forEach((text, idx) => {
            const pageNum = i + idx + 1;
            if (text && text.trim()) {
                scriptLines.push(`[P.${pageNum}]\n${text.trim()}`);
            }
        });
    }

    // ── 【第一道 STOP 守衛：Stage 1 OCR 結束 ➔ 進入 Stage 1.5 之前】 ──
    const isStoppingAfterOcr = await state.get('isStopping');
    if (!shouldProceedToStage15({ wasStopped: isStoppingAfterOcr, isStopping: isStoppingAfterOcr })) {
        log.warn('TwoStepPipeline', '階段 1 OCR 過程中已被停止，中止進入階段 1.5 與階段 2');
        if (sourceTabId) activeTranslationJobs.delete(sourceTabId);
        if (resultTabId) {
            activeTranslationJobs.delete(resultTabId);
            delete sessionStoryContext[resultTabId];
        }
        return;
    }

    const fullScriptText = scriptLines.join('\n\n');
    log.info('TwoStepPipeline', `全書劇本提取完成，有效台詞段落: ${scriptLines.length} 頁，總字數: ${fullScriptText.length} 字`);

    // ── 階段 1.5：全域劇本通讀與分層存儲 ──
    let sessionContextSnippet = '';
    const navCtx = await state.get('navigationContext', {});
    chrome.tabs.sendMessage(resultTabId, { action: 'clearResults', expectedCount: images.length }).catch(() => {});
    const currentMangaKey = customMangaKey || navCtx[sourceTabId];

    if (fullScriptText.trim().length > 20) {
        broadcastStatus(`✨ [階段 1.5] 通讀全篇劇本，分析當話劇情大綱與人物關係...`, 'info');
        chrome.tabs.sendMessage(resultTabId, {
            action: 'updateProgress',
            current: `正在分析全局劇情大綱與人物關係...`,
            total: images.length
        }).catch(() => {});

        try {
            const sessionAnalysis = await extractGlobalStoryAndGlossary(fullScriptText, {
                mangaKey: currentMangaKey,
                displayName: currentMangaKey
            });

            // 1. 當話劇情大綱與角色互動 ➔ 短期任務記憶體暫存
            sessionStoryContext[resultTabId] = {
                storySummary: sessionAnalysis.storySummary || '',
                characterRelationships: sessionAnalysis.characterRelationships || []
            };

            // 2. 專屬術語 ➔ 合併存入長期詞庫
            if (sessionAnalysis.glossaryTerms && sessionAnalysis.glossaryTerms.length > 0 && currentMangaKey) {
                await mergeGlossaryTerms(currentMangaKey, sessionAnalysis.glossaryTerms, 'ai');
                log.info('TwoStepPipeline', `已將 ${sessionAnalysis.glossaryTerms.length} 筆全書專有名詞存入長期詞庫 (${currentMangaKey})`);
            }

            // 3. 封裝注入片段
            const relText = (sessionAnalysis.characterRelationships || [])
                .map(r => `• ${r.charA} 與 ${r.charB}: ${r.relation} (稱呼: ${r.callCharB || '無'})`)
                .join('\n');

            const allTerms = await loadGlossary(currentMangaKey);
            const termsSnippet = buildGlossaryPromptSnippet(allTerms?.terms || []);

            sessionContextSnippet = `
<story_context>
  <current_chapter_summary>
${sessionAnalysis.storySummary || '無'}
  </current_chapter_summary>
  <character_relationships>
${relText || '無'}
  </character_relationships>
  <required_terms>
${termsSnippet}
  </required_terms>
</story_context>`;

            broadcastStatus(`🎯 已掌握全局設定（大綱+角色），開始進入批次精翻！`, 'ok');
        } catch (storyErr) {
            log.warn('TwoStepPipeline', `全域劇本分析失敗，退回無劇情背景精翻: ${storyErr.message}`);
        }
    }
    } catch (err) {
        if (sourceTabId) activeTranslationJobs.delete(sourceTabId);
        if (resultTabId) {
            activeTranslationJobs.delete(resultTabId);
            delete sessionStoryContext[resultTabId];
        }
        throw err;
    } finally {
        swKeepAlive.stop();
    }

    const isStopping = await state.get('isStopping');
    if (!shouldProceedToStage2({ wasStopped: isStopping, isStopping, scriptLinesCount: scriptLines.length })) {
        log.warn('TwoStepPipeline', '階段 1 OCR 過程中已被停止，中止進入階段 2 翻譯');
        if (sourceTabId) activeTranslationJobs.delete(sourceTabId);
        if (resultTabId) {
            activeTranslationJobs.delete(resultTabId);
            delete sessionStoryContext[resultTabId];
        }
        return;
    }

    return await processMangaBatchPCMode(sourceTabId, resultTabId, images, navLinks, isRetry, targetBatchIndex, sessionContextSnippet, customMangaKey);
}

// PC 模式的專屬翻譯處理器 (雙緩衝管線版本 - 0 延遲無縫流式批次)
async function processMangaBatchPCMode(sourceTabId, resultTabId, images, navLinks = null, isRetry = false, targetBatchIndex = null, injectedGlossarySnippet = '', customMangaKey = null) {
    if (sourceTabId) activeTranslationJobs.set(sourceTabId, { sourceTabId, resultTabId, imgCount: images.length, mode: 'one-step' });
    if (resultTabId) activeTranslationJobs.set(resultTabId, { sourceTabId, resultTabId, imgCount: images.length, mode: 'one-step' });
    const cleanupTranslationJob = () => {
        if (sourceTabId) activeTranslationJobs.delete(sourceTabId);
        if (resultTabId) {
            activeTranslationJobs.delete(resultTabId);
            delete sessionStoryContext[resultTabId];
        }
    };

    const broadcastStatus = (msg, type = 'info') => {
        if (!sourceTabId) return;
        chrome.tabs.sendMessage(sourceTabId, {
            action: 'TRANSLATION_STATUS',
            payload: { msg, type }
        }).catch(() => {});
    };

    if (!isRetry) {
        chrome.tabs.sendMessage(resultTabId, { action: 'clearResults', expectedCount: images.length });
    }
    broadcastStatus(`🚀 開始翻譯 ${images.length} 張圖片...`, 'info');

    chrome.runtime.sendMessage({
        action: 'START_TRANSLATING_CARD',
        imgCount: images.length
    }).catch(() => {});

    chrome.tabs.sendMessage(resultTabId, {
        action: 'updateProgress',
        current: 0,
        total: images.length
    });

    let modelName;
    let fallbackModelName;
    let finalPrompt;
    let glossarySnippet = injectedGlossarySnippet || '';
    let navCtx;
    let currentMangaKey;
    let currentDisplayName;
    try {
        modelName = await state.get('modelName', 'gemini-3.1-flash-lite');
        fallbackModelName = await state.get('fallbackModelName', null);
        const customPrompt = await state.get('customPrompt', Constants.DEFAULT_PROMPT_ONE_STEP);
        finalPrompt = modelName.toLowerCase().includes('gemma')
            ? Constants.DEFAULT_PROMPT_GEMMA_ONE_STEP : customPrompt;
        navCtx = await state.get('navigationContext', {});
        currentMangaKey = customMangaKey || navCtx[sourceTabId] || navCtx[resultTabId];
        currentDisplayName = currentMangaKey;
    } catch (err) {
        cleanupTranslationJob();
        throw err;
    }

    try {
        if (!currentMangaKey && sourceTabId && sourceTabId !== 'current') {
            const tabInfo = await chrome.tabs.get(sourceTabId);
            const titleResult = extractMangaTitle(tabInfo.title || '');
            if (titleResult) {
                currentMangaKey = titleResult.romanKey;
                currentDisplayName = titleResult.displayName;
                navCtx[sourceTabId] = currentMangaKey;
                await state.set('navigationContext', navCtx);
                log.info('Glossary', `PC 模式啟動時自動辨識作品: ${currentDisplayName}`);
            }
        }

        const isIncognitoBatch = await isTabIncognito(sourceTabId);
        const incognitoPrivacySetting = await state.get('incognitoPrivacyMode', true);

        if (currentMangaKey) {
            const entry = await loadGlossary(currentMangaKey);
            if (!entry) {
                if (isIncognitoBatch && incognitoPrivacySetting) {
                    log.info('Glossary', `🔒 [隱私保護] 偵測到無痕視窗，已跳過為新作品 "${currentMangaKey}" 建立本機詞庫與雲端同步`);
                } else {
                    await saveGlossary(currentMangaKey, {
                        displayName: currentDisplayName || currentMangaKey,
                        terms: []
                    });
                    log.info('Glossary', `為新作品 "${currentMangaKey}" 建立初始詞庫`);
                }
            } else {
                currentDisplayName = entry.displayName || currentMangaKey;
                if (entry.terms && entry.terms.length > 0) {
                    glossarySnippet = buildGlossaryPromptSnippet(entry.terms);
                    log.info('Glossary', `✅ [詞庫生效] 已成功為批次翻譯載入 "${currentDisplayName}" 詞庫，共 ${entry.terms.length} 筆強制定名：\n` + entry.terms.map(t => `  • 原文: "${t.ori}" ➔ 強制譯名: "${t.trans}"`).join('\n'));
                } else {
                    log.info('Glossary', `ℹ️ [詞庫狀態] 作品 "${currentDisplayName}" 目前詞庫為空 (0 詞)`);
                }
            }
            
            chrome.runtime.sendMessage({
                action: 'TITLE_DETECTED',
                payload: { romanKey: currentMangaKey, displayName: currentDisplayName }
            }).catch(() => {});
        } else {
            log.warn('Glossary', `⚠️ [詞庫警告] 未找到當前作品 Key，本次翻譯未套用任何專屬詞庫`);
        }
    } catch (glossaryErr) {
        log.warn('Glossary', `初始化階段發生錯誤，將以無詞庫狀態繼續: ${glossaryErr.message}`);
    }

    // ── 傳送導航連結給結果頁 ──
    let resolvedNavLinks = navLinks;
    if (!resolvedNavLinks) {
        try {
            const navStore = await state.get('navLinksStore', {});
            resolvedNavLinks = navStore[sourceTabId] || null;
        } catch(_) {}
    }
    if (resolvedNavLinks && (resolvedNavLinks.prev || resolvedNavLinks.next)) {
        setTimeout(() => {
            chrome.tabs.sendMessage(resultTabId, {
                action: 'setNavigation',
                navLinks: resolvedNavLinks
            });
        }, 500);
    }

    swKeepAlive.start();
    try {
        // 4. 讀取批次大小與圖片大小設定
        const isGemmaMode = modelName.toLowerCase().includes('gemma');
        const ocrBatchSizeSetting = await state.get('ocrBatchSize', 5);
        const batchSize = isGemmaMode ? 1 : (parseInt(ocrBatchSizeSetting) || 1);
        const requestDelay = await state.get('requestDelay', 4000);
        const maxDim = await state.get('imageMaxDimension', 1024);
        const candidateKeys = (state.apiKeys && state.apiKeys.length > 0) ? [...state.apiKeys] : [null];
        const isHybrid = (await state.get('hybridModeEnabled', true)) && !isGemmaMode;
        const secondaryModelName = await state.get('secondaryModelName', 'gemini-3.5-flash-lite');
        const effectiveDelay = getEffectiveDelay(requestDelay, isHybrid, candidateKeys.length);
        
        if (!state.isInitialized) await state.init();

        await state.set('isBatchPaused', false);

        log.info('Background', `開始管線批次翻譯：共 ${images.length} 張，每批=${batchSize} 張，傳送尺寸=${maxDim}px (2D交錯加速: ${isHybrid ? `已啟用 [Key池=${candidateKeys.length}組 / 主: ${modelName} / 次: ${secondaryModelName}], 延遲: ${effectiveDelay}ms` : `關閉, 延遲: ${requestDelay}ms`})`);

        let completedCount = 0;
        let allBatchResults = [];
        let wasStopped = false;
        let wasAborted = false;

        // ── 5. 雙緩衝管線 (Double-Buffered Pipeline) 啟動：提前非同步預載第 1 批 ──
        let nextBatchPromise = (images.length > 0)
            ? fetchAndResizeBatch(images.slice(0, batchSize), maxDim, sourceTabId)
            : Promise.resolve([]);

        // 主迴圈：依 batchSize 切塊，流水線無縫處理
        for (let i = 0; i < images.length; i += batchSize) {
            // Kill-Switch 檢查
            if (resultTabId && typeof resultTabId === 'number') {
                try {
                    const tab = await chrome.tabs.get(resultTabId);
                    if (!tab) {
                        log.info('Background', `結果分頁 ${resultTabId} 不存在，中止任務。`);
                        wasAborted = true;
                        break;
                    }
                } catch (tabErr) {
                    log.info('Background', `結果分頁 ${resultTabId} 無法存取，中止任務。`);
                    wasAborted = true;
                    break;
                }
            }

            const currentBatch = images.slice(i, i + batchSize);
            const totalBatches = Math.ceil(images.length / batchSize);
            const currentBatchIndex = Math.floor(i / batchSize) + 1;
            const batchIdx = Math.floor(i / batchSize);

            // 2D 二維交錯輪替排程 (Key1-A → Key2-B → Key3-A → Key4-B → Round 2: Key1-B → ...)
            const schedule = getHybridSchedule(batchIdx, candidateKeys.length, isHybrid, modelName, secondaryModelName);
            let batchModel = schedule.modelName;
            const scheduledKey = candidateKeys[schedule.keyIndex];

            if (await state.get('isStopping')) {
                log.warn('Background', '漫畫翻譯任務已被強制停止');
                wasStopped = true;
                break;
            }

            // 暫停檢查
            while (await state.get('isBatchPaused', false)) {
                await new Promise(r => setTimeout(r, 500));
                if (await state.get('isStopping')) break;
            }
            if (await state.get('isStopping')) {
                log.warn('Background', '漫畫翻譯任務已在暫停狀態下停止');
                wasStopped = true;
                break;
            }

            const keyTag = state.getApiKeyAlias(scheduledKey);
            const progressText = batchSize > 1
                ? `第 ${currentBatchIndex} / ${totalBatches} 批 [${keyTag} | ${batchModel.replace('gemini-', '')}] (圖片 ${i + 1}~${Math.min(i + batchSize, images.length)})`
                : `${i + 1} / ${images.length} [${keyTag} | ${batchModel.replace('gemini-', '')}]`;
            
            chrome.tabs.sendMessage(resultTabId, { action: 'updateProgress', current: progressText, total: images.length }).catch(() => {});
            broadcastStatus(`⏳ 正在處理 ${progressText}...`, 'info');

            // 1. 等待本批次圖片下載與壓縮完成
            const base64Results = await nextBatchPromise;

            // 2. 雙緩衝管線核心：若有下一批圖片，立即在發送本批 API 之前非同步啟動下一批預載預壓！
            const nextStart = i + batchSize;
            if (nextStart < images.length) {
                const nextBatchImages = images.slice(nextStart, nextStart + batchSize);
                nextBatchPromise = fetchAndResizeBatch(nextBatchImages, maxDim, sourceTabId);
            } else {
                nextBatchPromise = Promise.resolve([]);
            }

            // 分離有效/無效圖片
            const validItems = base64Results
                .map((b64, idx) => ({ b64, originalIdx: idx }))
                .filter(item => typeof item.b64 === 'string' && item.b64);

            const allPageResults = Array(currentBatch.length).fill(null);
            base64Results.forEach((r, idx) => {
                if (!r || typeof r !== 'string') allPageResults[idx] = { error: '圖片載入失敗' };
            });

            if (validItems.length > 0) {
                const PAYLOAD_LIMIT = 15_000_000;
                const totalPayload = validItems.reduce((sum, v) => sum + v.b64.length, 0);
                const subBatches = (batchSize > 1)
                    ? (totalPayload > PAYLOAD_LIMIT
                        ? [validItems.slice(0, Math.ceil(validItems.length / 2)), validItems.slice(Math.ceil(validItems.length / 2))]
                        : [validItems])
                    : null;

                let batchSuccess = false;
                let batchWasStopped = false;

                if (batchSize > 1) {
                    if (i > 0 && effectiveDelay > 0) {
                        await new Promise(r => setTimeout(r, effectiveDelay));
                    }

                    if (subBatches.length > 1) {
                        log.warn('Background', `[批次] 請求體過大，拆分為 ${subBatches.length} 個子批次。`);
                    }

                    try {
                        const execution = await executeHybridRequest({
                            candidateKeys, scheduledKey, scheduledModel: batchModel, primaryModel: modelName,
                            secondaryModel: secondaryModelName, isHybrid,
                            shouldContinue: async () => !(await state.get('isStopping')),
                            request: async ({ apiKey, modelName: requestModel, shouldContinue: shouldContinueRequest }) => {
                                const checkContinue = shouldContinueRequest || (async () => !(await state.get('isStopping')));
                                for (const subBatch of subBatches) {
                                    if (!await checkContinue()) {
                                        throw new HybridRequestAbortedError();
                                    }
                                    const subResults = await callGeminiAPIBatch(subBatch.map(v => v.b64), finalPrompt, glossarySnippet, apiKey, requestModel);
                                    if (!await checkContinue()) {
                                        throw new HybridRequestAbortedError();
                                    }
                                    subBatch.forEach((item, k) => { allPageResults[item.originalIdx] = subResults[k] || { error: '批次結果不足' }; });
                                }
                                return true;
                            }
                        });
                        batchModel = execution.usedModelName;
                        batchSuccess = true;
                    } catch (batchKeyErr) {
                        batchWasStopped = batchKeyErr.code === 'TRANSLATION_STOPPED';
                        log.warn('Background', `[批次] 所有 Key/模型批次嘗試失敗: ${batchKeyErr.message}`);
                    }
                } else {
                    // 逐張路徑 (batchSize=1)
                    const item = validItems[0];
                    if (item) {
                        try {
                            const execution = await executeHybridRequest({
                                candidateKeys, scheduledKey, scheduledModel: batchModel, primaryModel: modelName,
                                secondaryModel: secondaryModelName, isHybrid,
                                shouldContinue: async () => !(await state.get('isStopping')),
                                request: ({ apiKey, modelName: requestModel }) => translateTexts([], {
                                model: requestModel,
                                apiKey,
                                prompt: finalPrompt,
                                glossarySnippet,
                                imageBase64: item.b64,
                                schema: {
                                    type: 'OBJECT',
                                    properties: { results: { type: 'ARRAY', items: { type: 'OBJECT', properties: { original: { type: 'STRING' }, translation: { type: 'STRING' } }, required: ['original', 'translation'] } } },
                                    required: ['results']
                                }
                            }) });
                            allPageResults[item.originalIdx] = execution.results;
                            batchModel = execution.usedModelName;
                            batchSuccess = true;
                        } catch (singleErr) {
                            batchWasStopped = singleErr.code === 'TRANSLATION_STOPPED';
                            log.warn('Background', `[逐張] 翻譯失敗: ${singleErr.message}`);
                        }
                    }
                }

                if (batchWasStopped) {
                    wasStopped = true;
                    break;
                }

                // ── 若所有 Key 的批次請求均宣告失敗，才啟動最後防線：逐張降級重試 ──
                if (!batchSuccess) {
                    log.warn('Background', `[批次] 所有 API Key 批次翻譯均失敗，啟動備援逐張重試...`);
                    broadcastStatus(`⚠️ 所有 Key 批次失敗，正在啟動逐張重試...`, 'warn');

                    const fallbackResult = await executeFallbackImages({
                        validItems,
                        fallbackModelName,
                        getNextApiKey: () => state.getNextApiKey(),
                        translateSingle: ({ imageBase64, model, apiKey }) => translateTexts([], {
                            model,
                            apiKey,
                            prompt: finalPrompt,
                            glossarySnippet,
                            imageBase64,
                            schema: {
                                type: 'OBJECT',
                                properties: { results: { type: 'ARRAY', items: { type: 'OBJECT', properties: { original: { type: 'STRING' }, translation: { type: 'STRING' } }, required: ['original', 'translation'] } } },
                                required: ['results']
                            }
                        }),
                        shouldContinue: async () => !(await state.get('isStopping')),
                        broadcastStatus: (msg, type) => broadcastStatus(msg, type)
                    });

                    if (fallbackResult.wasStopped) {
                        wasStopped = true;
                    }

                    validItems.forEach((item, k) => {
                        allPageResults[item.originalIdx] = fallbackResult.fallbackResults[k] || { error: '備援翻譯結果缺失' };
                    });
                }
            }

            // 回傳本批結果給 UI
            for (let j = 0; j < currentBatch.length; j++) {
                const imgData = currentBatch[j];
                const imgSrc = imgData.src || imgData;
                const res = allPageResults[j];
                completedCount++;

                const currentBatchIdx = (targetBatchIndex !== null && targetBatchIndex !== undefined) 
                    ? targetBatchIndex 
                    : Math.floor(i / batchSize);
                // 檢測本批次是否觸發了模型內容安全審查
                const hasProhibitedInBatch = allPageResults.some(r => r?.isProhibited || (r?.error && (r.error.includes('SAFETY') || r.error.includes('BLOCKLIST') || r.error.includes('Prohibited') || r.error.includes('過濾器'))));

                const isErr = !res || res.error || (res.results && res.results.length === 0 && hasProhibitedInBatch);
                if (isErr) {
                    const isFirstInBatch = (j === 0);
                    const isItemProhibited = res?.isProhibited || (res?.error && (res.error.includes('SAFETY') || res.error.includes('BLOCKLIST') || res.error.includes('Prohibited') || res.error.includes('過濾器'))) || hasProhibitedInBatch;
                    const errorMsg = res?.error || (isItemProhibited ? '觸發 Google AI 安全性過濾器 (Prohibited Content)，模型拒絕翻譯' : '翻譯失敗或無回應');

                    broadcastStatus(`❌ 第 ${completedCount} 張翻譯失敗: ${errorMsg}`, 'error');
                    chrome.tabs.sendMessage(resultTabId, {
                        action: 'appendResult',
                        data: { 
                            image: imgSrc, 
                            error: errorMsg,
                            isProhibited: isItemProhibited,
                            isBatchFirstProhibited: isFirstInBatch && isItemProhibited,
                            batchIndex: currentBatchIdx,
                            pageIndex: completedCount
                        }
                    }).catch(() => {});
                } else {
                    const actualModel = res.usedModelName || batchModel;
                    await incrementDailyUsage(actualModel);
                    allBatchResults.push(...(res.results || []));
                    chrome.tabs.sendMessage(resultTabId, {
                        action: 'appendResult',
                        data: { 
                            image: imgSrc, 
                            results: res.results, 
                            usedModelName: actualModel,
                            batchIndex: currentBatchIdx,
                            pageIndex: completedCount
                        }
                    }).catch(() => {});
                }
            }

            // 批次間延遲 (Hybrid 模式下可安全減半加速)
            const finalDelay = isHybrid ? Math.max(1000, Math.floor(requestDelay / 2)) : (batchSize > 1 ? requestDelay * 1.5 : requestDelay);
            if (i + batchSize < images.length) {
                await new Promise(r => setTimeout(r, finalDelay));
            }
        }

        const isStopping = wasStopped || await state.get('isStopping');
        if (isStopping) wasStopped = true;
        if (!wasAborted && resultTabId && typeof resultTabId === 'number') {
            try {
                await chrome.tabs.get(resultTabId);
            } catch (_) {
                wasAborted = true;
            }
        }

        if (!shouldCompleteMangaTranslation({ wasStopped, wasAborted, isStopping })) {
            const statusMessage = wasStopped ? '翻譯已停止' : '翻譯已中止（結果分頁已關閉）';
            broadcastStatus(`⏹️ ${statusMessage}`, 'warn');
            chrome.runtime.sendMessage({ action: 'TRANSLATION_DONE' }).catch(() => {});
            return;
        }

        // ── 異步術語萃取 (遵循 V1.8.6 / 無痕模式隱私保護) ──
        const isIncognitoBatch = await isTabIncognito(sourceTabId);
        const incognitoPrivacySetting = await state.get('incognitoPrivacyMode', true);

        if (isIncognitoBatch && incognitoPrivacySetting) {
            log.info('Background', '🔒 [隱私保護] 偵測到無痕視窗翻譯，已自動跳過漫畫術語萃取與詞庫儲存');
        } else if (currentMangaKey && allBatchResults.length > 0) {
            log.info('Background', `[術語萃取] 開始分析漫畫譯文，共 ${allBatchResults.length} 組對話...`);
            setTimeout(async () => {
                try {
                    const newTerms = await extractTermsFromTranslation(allBatchResults, { model: modelName });
                    if (newTerms && newTerms.length > 0) {
                        const currentEntry = await loadGlossary(currentMangaKey) || { terms: [] };
                        const { terms: mergedTerms, addedCount } = mergeGlossaryTerms(currentEntry.terms || [], newTerms);
                        if (addedCount > 0) {
                            await saveGlossary(currentMangaKey, {
                                displayName: currentDisplayName || currentMangaKey,
                                terms: mergedTerms
                            });
                            log.info('Background', `[術語萃取] 作品 "${currentMangaKey}" 新增 ${addedCount} 筆術語。`);
                        } else {
                            log.info('Background', `[術語萃取] 分析完成，無新增術語。`);
                        }
                    }
                } catch (err) {
                    log.warn('Background', `[術語萃取] 發生錯誤: ${err.message}`);
                }
            }, 1500);
        } else {
            // [DEBUG] 明確說明為何跳過萃取
            if (!currentMangaKey) log.warn('Background', `[術語萃取-DEBUG] ⛔ 跳過萃取：currentMangaKey 為空，作品標題可能無法被辨識。`);
            if (allBatchResults.length === 0) log.warn('Background', `[術語萃取-DEBUG] ⛔ 跳過萃取：allBatchResults 為空，翻譯結果可能格式錯誤。`);
        }

        chrome.tabs.sendMessage(resultTabId, { action: 'batchComplete' }).catch(() => {});
        broadcastStatus(`✅ 全部 ${images.length} 張翻譯完成！請查看結果頁。`, 'success');
        // 廣播任務完成，讓 Sidepanel 恢復開始按鈕
        chrome.runtime.sendMessage({ action: 'TRANSLATION_DONE' }).catch(() => {});
        // 修復 Bug #矛盾2：任務完成後重置為 false，而非設為 true
        // UI 端收到 batchComplete 後自行隱藏停止按鈕，不依賴 isStopping 旗標
        await state.set('isStopping', false);

        // ── 跨話連續追漫：當前話翻完，自動於背景啟動下一話預翻 ──
        if (resolvedNavLinks?.next && typeof resolvedNavLinks.next === 'string') {
            startPretranslateNextChapter(resolvedNavLinks.next, sourceTabId, resultTabId).catch(err => {
                log.warn('Background', `[跨話連續追漫] 背景預翻下一話失敗: ${err.message}`);
            });
        }
    } finally {
        cleanupTranslationJob();
        swKeepAlive.stop();
    }
}


// 監聽分頁更新：標題解析與小說續傳
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;

  // [P1] 檢查是否為跳轉後自動翻譯
  const pendingAuto = await state.get('pendingAutoTranslate', null);
  if (pendingAuto && pendingAuto.tabId === tabId) {
      log.info('Background', `偵測到跳轉完成，啟動自動翻譯: ${tabId}`);
      await state.set('pendingAutoTranslate', null);
      const { resultTabId, mangaKey, mobile } = pendingAuto;
      // 【缺口F移植】改用帶重試的接力翻譯啟動函式（8次 × 1.5秒間隔）
      // 確保 content script 尚未就緒時仍能成功抓取圖片並啟動翻譯
      autoStartBatchWithRetry(tabId, resultTabId, mangaKey, mobile);
  }

  // 1. 智慧標題辨識 (靜默綁定當前分頁作品詞庫)
  const pageTitle = tab.title || '';
  const titleResult = extractMangaTitle(pageTitle);
  if (titleResult) {
    const navCtx = await state.get('navigationContext', {});
    navCtx[tabId] = titleResult.romanKey;
    await state.set('navigationContext', navCtx);
    
    // 通知 UI 標題已識別 (供 UI 顯示當前作品)
    chrome.runtime.sendMessage({
      action: 'TITLE_DETECTED',
      payload: titleResult
    }).catch(() => {});
  }

  // 2. 小說自動續傳 (Tab-Bound)
  const novelModeTabs = await state.get('novelModeTabs', {});
  const allowedOrigin = novelModeTabs[tabId];
  if (!allowedOrigin) return;

  const currentUrl = tab.url || '';
  let currentOrigin = '';
  try {
      if (currentUrl) {
          currentOrigin = new URL(currentUrl).origin;
      }
  } catch (e) {
      log.error('Background', `無法解析當前跳轉網址的 origin: ${currentUrl}`, e);
  }

  // 跨網域安全保護：只要允許的網域與當前網域不一致（包含舊有殘留的 true 值），自動停用並清除狀態
  if (allowedOrigin !== currentOrigin) {
      log.warn('Background', `偵測到網域不相符或舊狀態殘留（允許: ${allowedOrigin}, 當前: ${currentOrigin}），自動停用分頁 ${tabId} 的小說模式`);
      
      // 清除狀態
      await state.update('novelModeTabs', (current = {}) => {
          const next = { ...current };
          delete next[tabId];
          return next;
      });
      
      // 清除跳轉網址紀錄
      delete lastNovelUrlByTab[tabId];

      // 通知前台終止小說翻譯
      chrome.tabs.sendMessage(tabId, { action: 'abortNovelTranslation' }).catch(() => {});
      return;
  }

  if (lastNovelUrlByTab[tabId] === currentUrl) return; // 防止重複觸發
  
  lastNovelUrlByTab[tabId] = currentUrl;
  log.info('Background', `偵測到小說頁面跳轉（分頁 ${tabId}），觸發自動翻譯...`);
  
  // 延遲一點點確保 DOM 穩定
  setTimeout(() => {
    chrome.tabs.sendMessage(tabId, { action: 'AUTO_TRANSLATE_PAGE' })
      .catch(err => log.warn('Background', `Auto-translate signal failed: ${err.message}`));
  }, 1200);
});

// 3. 垃圾回收：當分頁關閉時，清除該分頁的小說模式狀態、進行中任務與相關 context
chrome.tabs.onRemoved.addListener(async (tabId) => {
  // 清理記憶體中的翻譯中任務與保活計數
  if (activeTranslationJobs.has(tabId)) {
    const job = activeTranslationJobs.get(tabId);
    if (job) {
      activeTranslationJobs.delete(job.sourceTabId);
      activeTranslationJobs.delete(job.resultTabId);
    }
    activeTranslationJobs.delete(tabId);
  }
  delete sessionStoryContext[tabId];
  delete lastNovelUrlByTab[tabId];

  // 清理與該分頁關聯的跨話預翻快取 (記憶體 + Session Checkpoint)
  for (const [chUrl, data] of pretranslatedChaptersMap.entries()) {
    if (data.associatedResultTabId === tabId || data.sourceTabId === tabId) {
      pretranslatedChaptersMap.delete(chUrl);
      log.info('Background', `[跨話連續追漫] 分頁 ${tabId} 已關閉，釋放預翻快取: ${chUrl}`);
    }
  }
  if (activePretranslateJob && (activePretranslateJob.associatedResultTabId === tabId || activePretranslateJob.sourceTabId === tabId)) {
    activePretranslateJob.isCancelled = true;
    activePretranslateJob = null;
  }
  await clearPretranslationCheckpointsForTabs(tabId);

  // 1. 清除小說模式狀態
  await state.update('novelModeTabs', (current = {}) => {
    const next = { ...current };
    delete next[tabId];
    return next;
  });

  // 2. 清除 navigationContext 狀態
  await state.update('navigationContext', (current = {}) => {
    const next = { ...current };
    delete next[tabId];
    return next;
  });

  // 3. 清除 navLinksStore 狀態
  await state.update('navLinksStore', (current = {}) => {
    const next = { ...current };
    delete next[tabId];
    return next;
  });
});

// 主動垃圾回收：啟動時及定時清除已關閉分頁的歷史殘留 (幽靈分頁清理)
async function cleanupGhostTabs() {
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
    } catch(e) {}
}

cleanupGhostTabs();
setInterval(cleanupGhostTabs, 60000); // 每分鐘定期清理一次

/**
 * 【缺口F移植】帶重試的訊息傳送工具 (移植自 V1.8.6 sendMessageWithRetry)
 * 解決頁面剛載入時 content script 尚未就緒的問題
 */
async function sendMessageWithRetry(tabId, message, maxRetries = 8, interval = 1500) {
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
 * 【缺口F移植】帶重試的接力翻譯啟動函式 (移植自 V1.8.6 autoStartBatch)
 * 跳轉後由 onTabsUpdated 呼叫，確保 content script 就緒後再抓圖
 */
async function autoStartBatchWithRetry(tabId, resultTabId, mangaKey, mobile) {
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
            const currentImages = res?.images || [];
            const count = currentImages.length;

            if (count > 0) {
                if (count === lastCount) {
                    stableCountMatches++;
                    // 連續 2 次數量不變，確認所有圖片已完全注入！
                    if (stableCountMatches >= 2 || (count >= 15 && stableCountMatches >= 1)) {
                        crawlResult = res;
                        log.info('Background', `[AutoBatch] 圖片數量已完全穩定：共獲取 ${count} 張圖片！(檢測嘗試 ${attempt} 次)`);
                        break;
                    }
                } else {
                    // 圖片數量持續增長中 (例如 3 ➔ 8 ➔ 12)，重置穩定次數，繼續等待下一輪
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
                    }, (res) => {
                        if (chrome.runtime.lastError) {
                            log.warn('Background', '[AutoBatch] 結果頁無回應，改開新頁');
                            openNewResultPage(tabId, images, navLinks, mangaKey, mobile);
                        } else {
                            startNewMangaBatchProcessing(tabId, resultTabId, images, navLinks)
                                .catch(err => log.error('Background', `[AutoBatch] 接力翻譯啟動失敗: ${err.message}`));
                        }
                    });
                    return;
                }
            } catch (_) {
                log.warn('Background', '[AutoBatch] 原有結果頁已關閉，開新頁');
            }
        }
        openNewResultPage(tabId, images, navLinks, mangaKey, mobile);
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

async function handleAddToQueue(task) {

    // 使用原子化更新，確保不會覆蓋並發的任務
    await state.update('novelQueue', (currentQueue) => {
        // chrome.storage 有時會把陣列反序列化成 {0: item, 1: item} 的物件
        // 必須強制轉回陣列才能正確 spread
        const safeQueue = Array.isArray(currentQueue) 
            ? currentQueue 
            : Object.values(currentQueue || {});
        return [...safeQueue, task];
    });
    log.info('Background', '任務已原子化新增至儲存佇列');
}

// 依據裝置設定 Action 行為 (點擊擴充功能圖示)
const isMobileEnv = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
if (isMobileEnv) {
    // 行動端：使用 popup 作為控制面板 (因為行動端不支援 SidePanel)
    chrome.action.setPopup({ popup: 'src/popup/index.html' });
} else {
    // 電腦端：點擊直接開啟側邊欄
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
        .catch(err => log.error('Background', `設定側邊欄行為失敗: ${err.message}`));
}

// 右鍵選單：提供額外的「設定」快速入口
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'open-options',
    title: '⚙️ 設定 (Options)',
    contexts: ['action']
  });
});

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === 'open-options') {
    chrome.runtime.openOptionsPage();
  }
});


/**
 * ensureContentScriptInjected — 確保 Content Script 已在目標分頁中快行
 * 對齊 v1.8.7 的相同函式，用於 prepareTab 與 setNovelMode handler
 * @param {number} tabId 
 * @returns {Promise<boolean>} 是否就緒
 */
async function ensureContentScriptInjected(tabId) {
    try {
        // 1. 先嘗試 Ping — 若成功表示已就緒
        await chrome.tabs.sendMessage(tabId, { action: 'ping' });
        log.info('Background', `[PrepareTab] 分頁 ${tabId} 已具備環境`);
        return true;
    } catch {
        // 2. Ping 失敗 (通常因擴充套件重新載入導致舊分頁變成孤兒腳本)，自動嘗試動態重注入
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
 * 更新每日翻譯次數統計（用於 getDailyTokenCount 配額顯示）
 * 在每張圖片翻譯完成後呼叫此函式
 * @param {string} modelName - 當前使用的模型名稱
 */
async function incrementDailyUsage(modelName = '') {
    try {
        if (modelName && modelName.toLowerCase().includes('gemma')) {
            log.info('Background', `使用 Gemma 模型 (${modelName})，不記入每日額度`);
            return;
        }
        const today = new Date().toISOString().split('T')[0];
        const savedDate = await state.get('usageDate', '');
        if (savedDate !== today) {
            await state.set('usageDate', today);
            await state.set('usageCount', 1);
        } else {
            const count = await state.get('usageCount', 0);
            await state.set('usageCount', count + 1);
        }
        // 廣播更新給 Sidepanel
        const newCount = await state.get('usageCount', 0);
        chrome.runtime.sendMessage({ action: 'updateTokenDisplay', count: newCount }).catch(() => {});
    } catch { /* 統計失敗不影響主要功能 */ }
}

// 雲端自動同步全域監聽器
chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace !== 'local') return;

    // 關鍵設定的 Keys (包含翻譯語言、API Key、自訂詞彙、模型設定、自訂提示詞)
    const criticalKeys = [
        'apiKey',
        'targetLanguage',
        'mangaGlossaries',
        'modelName',
        'novelModelName',
        'customPrompt',
        'novelPrompt'
    ];

    // 檢查是否有任何關鍵設定被修改
    const hasCriticalChange = Object.keys(changes).some(key => criticalKeys.includes(key));

    if (hasCriticalChange) {
        // 非同步讀取 enableCloudSync 狀態，避免阻塞
        chrome.storage.local.get(['enableCloudSync'], (result) => {
            const enableCloudSync = result.enableCloudSync || false;
            if (enableCloudSync) {
                log.info('BackgroundSync', '檢測到關鍵設定變更且已啟用雲端同步，準備觸發同步引擎...');
                try {
                    // 自動在背景非同步喚醒同步引擎
                    syncEngine.triggerSync(changes);
                } catch (syncErr) {
                    // 健全的錯誤處理，防止斷線或 token 失效等例外阻塞 SW
                    log.error('BackgroundSync', '喚醒同步引擎時發生異常:', syncErr);
                }
            }
        });
    }
});

