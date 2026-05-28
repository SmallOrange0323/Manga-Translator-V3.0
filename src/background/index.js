import { state } from '../utils/state.js';
import * as Constants from '../utils/constants.js';
import { extractMangaTitle } from '../utils/manga-utils.js';
import { loadGlossary, saveGlossary, mergeGlossaryTerms, buildGlossaryPromptSnippet, deleteGlossaryTerm, deleteGlossary, updateGlossaryDisplayName, importGlossaryTerms, deleteMultipleGlossaryTerms } from './glossary-manager.js';
import { translateTexts, extractTermsFromTranslation, callGeminiAPIBatch } from './translate-api.js';
import { log } from '../utils/logger.js';
import { Semaphore, KeyRateLimiter } from '../utils/concurrency.js';
import { syncEngine } from '../utils/sync-engine.js';

let capturedScreenshotForSelection = null;
// 記錄每個分頁最後的小說網址，防止 onUpdated 重複觸發自動翻譯
// 注意：此為記憶體變數，SW 重啟後清空屬正常行為
const lastNovelUrlByTab = {};


log.info('Background', '漫譯 V3 背景服務程式已啟動');

// 檢查是否處於無痕模式背景實例中 (用於 split 模式分流)
const isIncognitoProcess = chrome.extension ? chrome.extension.inIncognitoContext : false;

// 當 Service Worker 啟動或重啟時，初次化狀態
state.init().then(async () => {
    log.info('Background', `狀態載入完成 (無痕模式: ${isIncognitoProcess})，檢查待處理任務...`);
    await state.set('isStopping', false); // 重置停止狀態

    // 範例：檢查是否有遺留的小說翻譯任務
    const queue = await state.get('novelQueue', []);
    if (queue.length > 0 && !isIncognitoProcess) {
        log.warn('Background', `偵測到 ${queue.length} 個小說待處理任務，準備恢復...`);
        // 這裡未來會啟動 processNovelQueue()
    }
});

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
            if (mangaKey) {
                const entry = await loadGlossary(mangaKey);
                if (!entry) {
                    // 比照漫畫模式：建立初始存檔
                    await saveGlossary(mangaKey, { displayName: mangaKey, terms: [] });
                    log.info('Glossary', `為新小說作品 "${mangaKey}" 建立初始詞庫`);
                } else {
                    currentDisplayName = entry.displayName || mangaKey;
                    if (entry.terms && entry.terms.length > 0) {
                        glossarySnippet = buildGlossaryPromptSnippet(entry.terms);
                        log.info('Glossary', `套用小說詞庫 "${currentDisplayName}"，共 ${entry.terms.length} 筆術語`);
                    }
                }
            }

            // 讀取小說專用設定
            const modelName = await state.get('novelModelName', 'gemini-1.5-flash');
            const fallbackModelName = await state.get('fallbackModelName', 'gemini-1.5-flash');
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
            if (mangaKey && allTranslatedResults.length > 0) {
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
    sendResponse({ status: 'PONG', version: '3.0.0' });
  }

  if (message.action === 'STOP_TRANSLATION') {

      state.set('isStopping', true);
      log.warn('Background', '收到停止指令，正在中斷所有任務...');
      sendResponse({ status: 'stopping' });
      return false;
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
              const model = await state.get('novelModelName', 'gemini-1.5-flash');
              const fallbackModel = await state.get('fallbackModelName', 'gemini-1.5-flash');
              
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

  if (message.action === 'START_MANGA_BATCH_PC_MODE') {
      let { tabId, images, mobile, navLinks, mangaKey, windowId } = message.payload;
      if (!tabId && sender.tab) tabId = sender.tab.id;
      if (!windowId && sender.tab) windowId = sender.tab.windowId;
      
      state.set('isStopping', false);
      
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
                  // 將 navLinks 一起傳給翻譯處理器
                  processMangaBatchPCMode(sourceTabId, resultTabId, images, navLinks);
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
      const sourceTabId = parseInt(new URL(sender.tab?.url || 'about:blank').searchParams.get('tabId'));
      (async () => {
          const navCtx = await state.get('navigationContext', {});
          const navStore = await state.get('navLinksStore', {});
          const mangaKey = navCtx[sourceTabId] || null;
          const navLinks = navStore[sourceTabId] || { prev: null, next: null };
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
              if (existing.terms.some(t => t.ori === ori)) {
                  sendResponse({ success: false, error: '該原文已存在' });
                  return;
              }
              existing.terms.push({ ori: ori.trim(), trans: trans.trim(), source: 'user', createdAt: Date.now() });
              await saveGlossary(mangaKey, existing);
              sendResponse({ success: true });
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
              const modelName = await state.get('modelName', 'gemini-1.5-flash');
              const fallbackModelName = await state.get('fallbackModelName', 'gemini-1.5-flash');
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
              const modelName = await state.get('modelName', 'gemini-1.5-flash');
              const fallbackModelName = await state.get('fallbackModelName', 'gemini-1.5-flash');
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
              const model = await state.get('novelModelName', 'gemini-1.5-flash');
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
      if (!url || !tabId) { sendResponse({ status: 'error' }); return false; }
      // 儲存 resultTabId（發送訊息的分頁），讓 onUpdated 知道要通知哪個結果頁
      const resultTabId = sender.tab?.id || null;
      state.set('pendingAutoTranslate', { tabId, resultTabId, mangaKey: mangaKey || null, mobile: !!mobile }).then(() => {
          chrome.tabs.update(tabId, { url }, () => {
              if (chrome.runtime.lastError) {
                  console.warn('[Background] navigateAndTranslate failed:', chrome.runtime.lastError.message);
              }
          });
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
          processMangaBatchPCMode(sourceTabId, mobileTabId, images, navLinks || null);
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

  // ── 改動3：整批重試 — 一鍵重試所有失敗圖片（不開新分頁） ──
  if (message.action === 'RETRY_FAILED_BATCH') {
      const { images, sourceTabId: retrySourceTabId } = message;
      // resultTabId 優先使用 message 帶來的值，若為 null 則以 sender（result 頁自身）作為回傳目標
      const retryResultTabId = message.resultTabId || sender.tab?.id;
      if (!images || images.length === 0 || !retryResultTabId) {
          sendResponse({ status: 'error', error: '缺少圖片清單或結果分頁 ID' });
          return false;
      }
      // 重置停止旗標
      state.set('isStopping', false);
      // 直接以現有 resultTabId 啟動批次翻譯（不建立新分頁），並標記為重試 (isRetry = true)
      processMangaBatchPCMode(retrySourceTabId || null, retryResultTabId, images, null, true);
      log.info('Background', `[重試批次] 收到 ${images.length} 張失敗圖片，開始重試翻譯... (resultTabId: ${retryResultTabId})`);
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
    log.info('Background', `[DebugLog] 進入 resizeImageBlobToBase64，maxDim = ${maxDim}`);
    if (!maxDim || maxDim <= 0) {
        log.info('Background', `[DebugLog] maxDim 為 0 或負數，跳過壓縮，直接轉 base64`);
        // 不壓縮，直接轉 base64
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
        log.info('Background', `[DebugLog] resizeImageBlobToBase64: 準備呼叫 createImageBitmap...`);
        const bitmap = await createImageBitmap(blob);
        log.info('Background', `[DebugLog] resizeImageBlobToBase64: createImageBitmap 成功，原始尺寸 = ${bitmap.width}x${bitmap.height}`);
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

        log.info('Background', `[DebugLog] resizeImageBlobToBase64: 創建 OffscreenCanvas 尺寸 = ${width}x${height}`);
        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0, width, height);
        
        log.info('Background', `[DebugLog] resizeImageBlobToBase64: 準備呼叫 canvas.convertToBlob...`);
        // 匯出為壓縮度較佳的 jpeg (品質設為 0.85 兼顧字體清晰與體積)
        const compressedBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
        log.info('Background', `[DebugLog] resizeImageBlobToBase64: canvas.convertToBlob 成功，壓縮後大小 = ${compressedBlob.size} bytes`);
        const arrayBuffer = await compressedBlob.arrayBuffer();
        const bytes = new Uint8Array(arrayBuffer);
        let binary = '';
        const chunk_size = 0x8000;
        for (let b = 0; b < bytes.byteLength; b += chunk_size) {
            binary += String.fromCharCode.apply(null, bytes.subarray(b, b + chunk_size));
        }
        bitmap.close(); // 釋放記憶體
        log.info('Background', `[DebugLog] resizeImageBlobToBase64: 圖片處理完成`);
        return btoa(binary);
    } catch (err) {
        log.warn('Background', `[DebugLog] 圖片壓縮處理失敗，使用原圖傳送: ${err.message}`);
        // 備援：不壓縮轉 base64
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

async function handleProcessScreenshot(rect, tabId) {
    try {
        if (!capturedScreenshotForSelection) {
            throw new Error("截圖資料遺失，請重新框選");
        }
        
        // 1. 裁切圖片取得 base64 (不含 data:image/jpeg;base64, 前綴)
        const croppedBase64 = await cropImageBase64(capturedScreenshotForSelection, rect);
        
        // 2. 獲取翻譯設定與詞庫
        const modelName = await state.get('modelName', 'gemini-1.5-flash');
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

// PC 模式的專屬翻譯處理器 (並行版本 - 使用 Semaphore 控制並發數)
async function processMangaBatchPCMode(sourceTabId, resultTabId, images, navLinks = null, isRetry = false) {
    // 輔助函式：廣播狀態給行動端來源分頁的日誌面板
    const broadcastStatus = (msg, type = 'info') => {
        if (!sourceTabId) return;
        chrome.tabs.sendMessage(sourceTabId, {
            action: 'TRANSLATION_STATUS',
            payload: { msg, type }
        }).catch(() => {});
    };

    // 1. 通知閱讀器清空舊結果並準備開始 (僅在非重試模式下)
    if (!isRetry) {
        chrome.tabs.sendMessage(resultTabId, { action: 'clearResults', expectedCount: images.length });
    }
    broadcastStatus(`🚀 開始翻譯 ${images.length} 張圖片...`, 'info');

    // 通知側邊欄顯示「正在翻譯」動畫卡片（針對跳轉下一話等背景啟動的情況）
    chrome.runtime.sendMessage({
        action: 'START_TRANSLATING_CARD',
        imgCount: images.length
    }).catch(() => {});

    // 2. 初始化進度條
    chrome.tabs.sendMessage(resultTabId, {
        action: 'updateProgress',
        current: 0,
        total: images.length
    });

    // 3. 讀取翻譯設定（在並行前統一讀取，避免重複 I/O）
    const modelName = await state.get('modelName', 'gemini-1.5-flash');
    const fallbackModelName = await state.get('fallbackModelName', null);
    const customPrompt = await state.get('customPrompt', Constants.DEFAULT_PROMPT_ONE_STEP);
    let finalPrompt = customPrompt;
    if (modelName.toLowerCase().includes('gemma')) {
        finalPrompt = Constants.DEFAULT_PROMPT_GEMMA_ONE_STEP;
    }
    log.info('Background', `翻譯設定讀取完成 — 主要模型: ${modelName}，備援模型: ${fallbackModelName}`);

    // ── 語彙庫初始化與注入 (遵循 V1.8.6 邏輯) ──
    let glossarySnippet = '';
    const navCtx = await state.get('navigationContext', {});
    let currentMangaKey = navCtx[sourceTabId];
    let currentDisplayName = currentMangaKey;

    try {
        // 如果執行當下沒有 Key，嘗試從 Tab 標題重新解析 (自癒邏輯)
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

        if (currentMangaKey) {
            const entry = await loadGlossary(currentMangaKey);
            // 比照 V1.8.6：若是新作品，先建立基礎詞庫存檔
            if (!entry) {
                await saveGlossary(currentMangaKey, {
                    displayName: currentDisplayName || currentMangaKey,
                    terms: []
                });
                log.info('Glossary', `為新作品 "${currentMangaKey}" 建立初始詞庫`);
            } else {
                currentDisplayName = entry.displayName || currentMangaKey;
                if (entry.terms && entry.terms.length > 0) {
                    glossarySnippet = buildGlossaryPromptSnippet(entry.terms);
                    log.info('Glossary', `套用詞庫 "${currentMangaKey}"，共 ${entry.terms.length} 筆術語`);
                }
            }
            
            // 通知側邊欄識別成功 (確保 UI 狀態同步)
            chrome.runtime.sendMessage({
                action: 'TITLE_DETECTED',
                payload: { romanKey: currentMangaKey, displayName: currentDisplayName }
            }).catch(() => {});
        }
    } catch (glossaryErr) {
        log.warn('Glossary', `初始化階段發生錯誤，將以無詞庫狀態繼續: ${glossaryErr.message}`);
    }

    // ── 傳送導航連結給結果頁（對齊 v1.8.7 的 setNavigation 邏輯）──
    // 若呼叫方未提供 navLinks，嘗試從 navLinksStore 中補救
    let resolvedNavLinks = navLinks;
    if (!resolvedNavLinks) {
        try {
            const navStore = await state.get('navLinksStore', {});
            resolvedNavLinks = navStore[sourceTabId] || null;
        } catch(_) {}
    }
    // [Debug] 顯示導航連結實際內容，方便診斷
    log.info('Background', `[NavDebug] sourceTabId=${sourceTabId}, navLinks 傳入=${JSON.stringify(navLinks)}, navStore 補救=${JSON.stringify(resolvedNavLinks)}`);
    if (resolvedNavLinks && (resolvedNavLinks.prev || resolvedNavLinks.next)) {
        // 稍等 500ms 確保結果頁 DOM 已準備好
        setTimeout(() => {
            chrome.tabs.sendMessage(resultTabId, {
                action: 'setNavigation',
                navLinks: resolvedNavLinks
            });
        }, 500);
        log.info('Background', `導航連結已送出: prev=${resolvedNavLinks.prev ? '✓' : '✗'}, next=${resolvedNavLinks.next ? '✓' : '✗'}`);
    } else {
        log.warn('Background', '無導航連結可用，上/下一話按鈕將不顯示');
    }

    // 4. 讀取批次大小與圖片大小設定
    const isGemmaMode = modelName.toLowerCase().includes('gemma');
    const ocrBatchSizeSetting = await state.get('ocrBatchSize', 5);
    const batchSize = isGemmaMode ? 1 : (parseInt(ocrBatchSizeSetting) || 1);
    const requestDelay = await state.get('requestDelay', 4000);
    const maxDim = await state.get('imageMaxDimension', 1024);
    
    // Bug #4 修復：確保 state 已完成初始化後再讀取 apiKeys 池長度，
    // 避免 SW 冷啟動時 apiKeys 為空陣列導致並行度恒等於 1
    if (!state.isInitialized) await state.init();
    const concurrency = Math.max(1, state.apiKeys.length);

    // 強制重設暫停旗標，確保每次全新的翻譯任務都不會被殘留狀態鎖定
    await state.set('isBatchPaused', false);

    log.info('Background', `開始批次翻譯：共 ${images.length} 張，批次大小=${batchSize}，傳送尺寸限制=${maxDim}px，備援並行度=${concurrency}`);

    let completedCount = 0;
    let allBatchResults = [];

    // 5. 主迴圈：依 batchSize 切塊，逐批處理
    for (let i = 0; i < images.length; i += batchSize) {
        if (typeof console.groupCollapsed === 'function') {
            console.groupCollapsed(`[DebugLog Group] 📥 第 ${Math.floor(i / batchSize) + 1} 批圖片下載與壓縮處理詳細日誌 (i = ${i})`);
        }
        log.info('Background', `[DebugLog] 進入批次主迴圈，第 ${Math.floor(i / batchSize) + 1} 批，i = ${i}`);
        // Kill-Switch：若結果頁已關閉，終止
        try {
            await chrome.tabs.get(resultTabId);
        } catch (e) {
            log.info('Background', '結果頁面已關閉，中止批次任務。');
            break;
        }

        const currentBatch = images.slice(i, i + batchSize);
        const totalBatches = Math.ceil(images.length / batchSize);
        const currentBatchIndex = Math.floor(i / batchSize) + 1;

        // 檢查是否停止
        if (await state.get('isStopping')) {
            log.warn('Background', '漫畫翻譯任務已被強制停止');
            break;
        }

        // 暫停輪詢（對齊 v1.8.7 toggleBatchPause 功能）
        log.info('Background', `[DebugLog] 檢查暫停狀態...`);
        while (await state.get('isBatchPaused', false)) {
            log.info('Background', `[DebugLog] 漫畫翻譯處於暫停狀態，等待繼續...`);
            // 暫停中，每 500ms 檢查一次是否已繼續
            await new Promise(r => setTimeout(r, 500));
            // 暫停期間如果也收到 isStopping，一並結束
            if (await state.get('isStopping')) break;
        }

        // 進度顯示
        const progressText = batchSize > 1
            ? `第 ${currentBatchIndex} / ${totalBatches} 批 (圖片 ${i + 1}~${Math.min(i + batchSize, images.length)})`
            : `${i + 1} / ${images.length}`;
        
        log.info('Background', `[DebugLog] 發送進度更新 sendMessage: ${progressText}`);
        chrome.tabs.sendMessage(resultTabId, { action: 'updateProgress', current: progressText, total: images.length });
        broadcastStatus(`⏳ 正在處理 ${progressText}...`, 'info');

        log.info('Background', `[DebugLog] 開始載入本批 ${currentBatch.length} 張圖片`);
        // 並行抓取本批圖片 Base64，並依 maxDim 進行等比例縮放
        const base64Results = await Promise.all(currentBatch.map(async (imgData, idx) => {
            const imgSrc = imgData.src || imgData;
            log.info('Background', `[DebugLog] 處理圖片 [${idx}]: imgSrc 長度 = ${imgSrc ? imgSrc.substring(0, 100) : 'null'}`);
            // 如果 imgSrc 已經是 base64 (或者是 selection 截圖)，不需要 resize，直接使用
            if (imgSrc.startsWith('data:image')) {
                log.info('Background', `[DebugLog] 圖片 [${idx}] 是 base64 格式，跳過 fetch`);
                return imgSrc.split(',')[1];
            }
            try {
                log.info('Background', `[DebugLog] 圖片 [${idx}]: 準備呼叫 fetch`);
                // 加入 10 秒逾時機制，防止 fetch 無限期掛起
                const controller = new AbortController();
                const timeoutId = setTimeout(() => {
                    log.warn('Background', `[DebugLog] 圖片 [${idx}]: fetch 逾時，觸發 abort`);
                    controller.abort();
                }, 10000);
                
                const res = await fetch(imgSrc, { signal: controller.signal });
                clearTimeout(timeoutId);
                log.info('Background', `[DebugLog] 圖片 [${idx}]: fetch 完成，status = ${res.status}`);
                
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const blob = await res.blob();
                log.info('Background', `[DebugLog] 圖片 [${idx}]: blob 讀取完成，大小 = ${blob.size} bytes`);
                
                // 調用 OffscreenCanvas 進行等比例縮放與壓縮
                log.info('Background', `[DebugLog] 圖片 [${idx}]: 準備呼叫 resizeImageBlobToBase64`);
                const resB64 = await resizeImageBlobToBase64(blob, maxDim);
                log.info('Background', `[DebugLog] 圖片 [${idx}]: resizeImageBlobToBase64 完成，產出長度 = ${resB64 ? resB64.length : 0}`);
                return resB64;
            } catch (fetchErr) {
                // 退回 Content Script 備援
                log.warn('Background', `[DebugLog] 圖片 [${idx}] 直接抓取失敗，退回 Content Script: ${fetchErr.message}`);
                broadcastStatus(`⚠️ 圖片抓取逾時或失敗，嘗試透過網頁端抓取...`, 'warn');
                if (sourceTabId && sourceTabId !== 'current') {
                    log.info('Background', `[DebugLog] 圖片 [${idx}]: 向 Content Script 發送 fetchBase64，tabId = ${sourceTabId}`);
                    const resp = await Promise.race([
                        new Promise(resolve => chrome.tabs.sendMessage(sourceTabId, { action: 'fetchBase64', url: imgSrc, maxDim: maxDim }, resolve)),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('Content Script fetch Timeout')), 15000))
                    ]).catch(e => {
                        log.warn('Background', `[DebugLog] 圖片 [${idx}] Content Script 抓取逾時或出錯: ${e.message}`);
                        return { error: e.message };
                    });
                    log.info('Background', `[DebugLog] 圖片 [${idx}] Content Script 抓取回應: ${resp?.base64 ? '成功' : '失敗'}`);
                    return resp?.base64 || null;
                }
                return null;
            }
        }));
        log.info('Background', `[DebugLog] 本批圖片載入與縮放完成，有效圖片數 = ${base64Results.filter(Boolean).length}`);
        if (typeof console.groupEnd === 'function') {
            console.groupEnd();
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
            // 提前計算子批次，讓 catch 區塊中的多 Key 輪流重試也能使用
            const PAYLOAD_LIMIT = 15_000_000;
            const totalPayload = validItems.reduce((sum, v) => sum + v.b64.length, 0);
            const subBatches = (batchSize > 1)
                ? (totalPayload > PAYLOAD_LIMIT
                    ? [validItems.slice(0, Math.ceil(validItems.length / 2)), validItems.slice(Math.ceil(validItems.length / 2))]
                    : [validItems])
                : null; // batchSize=1 時不使用 subBatches

            try {
                if (batchSize > 1) {
                    // ── 批次路徑：多圖打包成一個 API 請求 ──
                    // 使用者的等待時間在此套用
                    if (i > 0 && requestDelay > 0) {
                        await new Promise(r => setTimeout(r, requestDelay));
                    }

                    if (subBatches.length > 1) {
                        log.warn('Background', `[批次] 請求體過大 (${Math.round(totalPayload / 1_000_000)}MB)，自動拆分為 ${subBatches.length} 個子批次。`);
                    }

                    for (const subBatch of subBatches) {
                        log.info('Background', `[批次] 打包 ${subBatch.length} 張圖送出 API...`);
                        const subResults = await callGeminiAPIBatch(
                            subBatch.map(v => v.b64),
                            finalPrompt,
                            glossarySnippet
                        );
                        subBatch.forEach((item, k) => {
                            allPageResults[item.originalIdx] = subResults[k] || { error: '批次結果不足' };
                        });
                    }
                } else {
                    // ── 逐張路徑 (batchSize=1) ──
                    const item = validItems[0];
                    if (item) {
                        const result = await translateTexts([], {
                            model: modelName,
                            fallbackModel: fallbackModelName,
                            prompt: finalPrompt,
                            glossarySnippet,
                            imageBase64: item.b64,
                            schema: {
                                type: 'OBJECT',
                                properties: { results: { type: 'ARRAY', items: { type: 'OBJECT', properties: { original: { type: 'STRING' }, translation: { type: 'STRING' } }, required: ['original', 'translation'] } } },
                                required: ['results']
                            }
                        });
                        allPageResults[item.originalIdx] = result;
                    }
                }
            } catch (batchErr) {
                // 【改動2】多 Key 輪流嘗試主模型批次翻譯，全部失敗才切備援模型
                log.warn('Background', `[批次] 主模型批次翻譯失敗 (Key1)，開始輪流嘗試其他 Key: ${batchErr.message}`);
                broadcastStatus(`⚠️ 批次翻譯失敗，嘗試其他 API Key...`, 'warn');

                let batchSucceeded = false;

                // 輪流嘗試剩餘的 API Key（跳過第一個已失敗的 Key，從第二個開始）
                const allKeys = [...state.apiKeys];
                for (let ki = 1; ki < allKeys.length; ki++) {
                    const retryKey = allKeys[ki];
                    try {
                        log.info('Background', `[批次] Key${ki + 1} (${state.getApiKeyAlias(retryKey)}) 嘗試批次翻譯...`);
                        broadcastStatus(`⏳ 嘗試 Key${ki + 1} 批次翻譯...`, 'info');

                        for (const subBatch of subBatches) {
                            const subResults = await callGeminiAPIBatch(
                                subBatch.map(v => v.b64),
                                finalPrompt,
                                glossarySnippet,
                                retryKey  // 指定使用此 Key
                            );
                            subBatch.forEach((item, k) => {
                                allPageResults[item.originalIdx] = subResults[k] || { error: '批次結果不足' };
                            });
                        }
                        log.info('Background', `[批次] Key${ki + 1} 批次翻譯成功！`);
                        broadcastStatus(`✅ Key${ki + 1} 批次翻譯成功`, 'ok');
                        batchSucceeded = true;
                        break;
                    } catch (retryErr) {
                        log.warn('Background', `[批次] Key${ki + 1} 批次翻譯失敗: ${retryErr.message}`);
                    }
                }

                // 所有 Key 批次均失敗，才啟動備援模型 (Gemma) 逐張翻譯
                if (!batchSucceeded) {
                    log.warn('Background', `[批次] 所有 Key (${allKeys.length} 個) 批次翻譯均失敗，啟動備援模型逐張翻譯 (${fallbackModelName})`);
                    broadcastStatus(`❌ 所有 Key 批次失敗，啟動備援模型逐張翻譯...`, 'err');

                    const limiter = new KeyRateLimiter(state.apiKeys, requestDelay);
                    const fallbackResults = new Array(validItems.length).fill(null);

                    await Promise.all(validItems.map(async (item, k) => {
                        const apiKey = await limiter.acquireKey();
                        try {
                            if (await state.get('isStopping')) return;

                            const result = await translateTexts([], {
                                model: fallbackModelName,
                                apiKey: apiKey,
                                prompt: finalPrompt,
                                glossarySnippet,
                                imageBase64: item.b64,
                                schema: {
                                    type: 'OBJECT',
                                    properties: { results: { type: 'ARRAY', items: { type: 'OBJECT', properties: { original: { type: 'STRING' }, translation: { type: 'STRING' } }, required: ['original', 'translation'] } } },
                                    required: ['results']
                                }
                            });
                            fallbackResults[k] = result;
                            broadcastStatus(`第 ${item.originalIdx + 1} 張備援翻譯成功`, 'ok');
                        } catch (singleErr) {
                            log.warn('Background', `[備援] 第 ${item.originalIdx + 1} 張翻譯失敗 (Key: ${state.getApiKeyAlias(apiKey)}): ${singleErr.message}`);
                            broadcastStatus(`❌ 第 ${item.originalIdx + 1} 張備援失敗: ${singleErr.message.slice(0, 30)}`, 'err');
                            fallbackResults[k] = { error: singleErr.message };
                        }
                    }));

                    validItems.forEach((item, k) => {
                        allPageResults[item.originalIdx] = fallbackResults[k] || { error: '備援翻譯結果缺失' };
                    });
                }
            }
        }

        // 回傳本批結果給 UI
        for (let j = 0; j < currentBatch.length; j++) {
            const imgData = currentBatch[j];
            const imgSrc = imgData.src || imgData;
            const res = allPageResults[j];
            completedCount++;

            if (!res || res.error) {
                broadcastStatus(`❌ 第 ${completedCount} 張翻譯失敗: ${res?.error || '無回應'}`, 'error');
                chrome.tabs.sendMessage(resultTabId, {
                    action: 'appendResult',
                    data: { image: imgSrc, error: res?.error || '翻譯失敗或無回應' }
                });
            } else {
                await incrementDailyUsage(modelName);
                allBatchResults.push(...(res.results || []));
                chrome.tabs.sendMessage(resultTabId, {
                    action: 'appendResult',
                    data: { 
                        image: imgSrc, 
                        results: res.results, 
                        usedModelName: res.usedModelName || modelName 
                    }
                });
            }
        }

        // 批次間延遲
        const finalDelay = batchSize > 1 ? requestDelay * 1.5 : requestDelay;
        if (i + batchSize < images.length) {
            await new Promise(r => setTimeout(r, finalDelay));
        }
    }

    // ── 異步術語萃取 (遵循 V1.8.6) ──
    // [DEBUG] 診斷用 log：確認萃取觸發條件
    log.info('Background', `[術語萃取-DEBUG] currentMangaKey = "${currentMangaKey}" | allBatchResults.length = ${allBatchResults.length}`);
    if (allBatchResults.length > 0) {
        log.info('Background', `[術語萃取-DEBUG] allBatchResults 第一筆格式樣本: ${JSON.stringify(allBatchResults[0])}`);
    }

    if (currentMangaKey && allBatchResults.length > 0) {
        log.info('Background', `[術語萃取] 開始分析漫畫譯文，共 ${allBatchResults.length} 組對話...`);
        setTimeout(async () => {
            try {
                const newTerms = await extractTermsFromTranslation(allBatchResults, { model: modelName });
                // [DEBUG] 確認 AI 回傳了什麼
                log.info('Background', `[術語萃取-DEBUG] AI 回傳術語數量: ${newTerms?.length ?? 0} | 內容: ${JSON.stringify(newTerms?.slice(0, 3))}`);
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

    chrome.tabs.sendMessage(resultTabId, { action: 'batchComplete' });
    broadcastStatus(`✅ 全部 ${images.length} 張翻譯完成！請查看結果頁。`, 'success');
    // 廣播任務完成，讓 Sidepanel 恢復開始按鈕
    chrome.runtime.sendMessage({ action: 'TRANSLATION_DONE' }).catch(() => {});
    // 修復 Bug #矛盾2：任務完成後重置為 false，而非設為 true
    // UI 端收到 batchComplete 後自行隱藏停止按鈕，不依賴 isStopping 旗標
    await state.set('isStopping', false);
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

  // 1. 智慧標題辨識
  const pageTitle = tab.title || '';
  const titleResult = extractMangaTitle(pageTitle);
  if (titleResult) {
    const navCtx = await state.get('navigationContext', {});
    navCtx[tabId] = titleResult.romanKey;
    await state.set('navigationContext', navCtx);
    log.info('Background', `偵測到作品標題: ${titleResult.displayName} (Key: ${titleResult.romanKey})`);
    
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

  log.info('Background', `小說續傳判定 - 分頁: ${tabId}, 允許網域: ${allowedOrigin}, 當前網域: ${currentOrigin}`);

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

// 3. 垃圾回收：當分頁關閉時，清除該分頁的小說模式狀態與相關 context
chrome.tabs.onRemoved.addListener(async (tabId) => {
  log.info('Background', `偵測到分頁關閉 (tabId=${tabId})，執行垃圾回收...`);
  
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
});

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

        const crawlResult = await sendMessageWithRetry(tabId, { action: 'crawlImages' });
        if (!crawlResult || !crawlResult.images || crawlResult.images.length === 0) {
            log.warn('Background', '[AutoBatch] 接力翻譯：抓圖結果為空，中止');
            return;
        }

        await state.set('isStopping', false);
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
                            processMangaBatchPCMode(tabId, resultTabId, images, navLinks);
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
        // 2. Ping 失敗，誠實地返回 false（這將觸發 UI 的 F5 重整提示，對使用者最為透明且安全）
        log.warn('Background', `[PrepareTab] 分頁 ${tabId} 連線已失效或為孤兒腳本，提示使用者重新整理網頁`);
        return false;
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

