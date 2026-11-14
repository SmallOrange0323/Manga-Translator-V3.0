/**
 * 背景圖片處理與跨話抓取核心模組
 * 負責圖片裁切、OffscreenCanvas 等比例縮放壓縮、批次抓圖管線、
 * 跨話靜默探針抓圖、區域截圖翻譯以及單頁重譯處理。
 */
import { state } from '../utils/state.js';
import * as Constants from '../utils/constants.js';
import { log } from '../utils/logger.js';
import { parseChapterHtml } from '../utils/chapter-parser.js';
import { crawlJestfulChapterInTab } from './jestful-prefetch.js';
import { translateTexts } from './translate-api.js';
import { loadGlossary, buildGlossaryPromptSnippet } from './glossary-manager.js';
import { createMangaResultUpdate } from './manga-result-update.js';

// 區域截圖翻譯暫存圖資 (Data URL)
let capturedScreenshotForSelection = null;

/**
 * 設定區域截圖暫存圖資
 * @param {string|null} dataUrl
 */
export function setCapturedScreenshot(dataUrl) {
    capturedScreenshotForSelection = dataUrl || null;
}

/**
 * 取得區域截圖暫存圖資
 * @returns {string|null}
 */
export function getCapturedScreenshot() {
    return capturedScreenshotForSelection;
}

/**
 * 預設判斷是否為 Jestful 章節網址
 * @param {string} value
 * @returns {boolean}
 */
function defaultIsJestfulChapterUrl(value) {
    try {
        const url = new URL(value);
        return /(^|\.)jestful\.net$/i.test(url.hostname) && /-chapter-[\d.]+\.html$/i.test(url.pathname);
    } catch (_) {
        return false;
    }
}

/**
 * 依指定座標與尺寸裁切 Base64/DataURL 圖片，輸出 JPEG Base64 (不含前綴)
 * @param {string} fullBase64
 * @param {{x: number, y: number, width: number, height: number}} rect
 * @returns {Promise<string>}
 */
export async function cropImageBase64(fullBase64, rect) {
    if (!fullBase64) throw new Error('No base64 image provided');
    const res = await fetch(fullBase64);
    const blob = await res.blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(rect.width, rect.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
    const croppedBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.95 });

    // ArrayBuffer 轉為 Base64 (Service Worker 安全實作)
    const arrayBuffer = await croppedBlob.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

/**
 * 將抓取到的 Blob 轉換為 ImageBitmap，並利用 OffscreenCanvas 等比例縮小到 maxDim 後輸出 JPEG Base64。
 * 如果 maxDim 為 0 或未設定，則不進行縮放，直接轉 Base64。
 * @param {Blob} blob
 * @param {number} maxDim
 * @returns {Promise<string>}
 */
export async function resizeImageBlobToBase64(blob, maxDim) {
    if (!maxDim || maxDim <= 0) {
        const arrayBuffer = await blob.arrayBuffer();
        const bytes = new Uint8Array(arrayBuffer);
        let binary = '';
        const chunkSize = 0x8000;
        for (let b = 0; b < bytes.byteLength; b += chunkSize) {
            binary += String.fromCharCode.apply(null, bytes.subarray(b, b + chunkSize));
        }
        return btoa(binary);
    }

    try {
        const bitmap = await createImageBitmap(blob);
        const { width, height } = Constants.computeMangaTargetDimensions(bitmap.width, bitmap.height, maxDim);

        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0, width, height);

        // 匯出為壓縮度與辨識度最佳平衡的 jpeg (品質 0.90，確保密集日文漢字與濁音點銳利清晰)
        const compressedBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.90 });
        const arrayBuffer = await compressedBlob.arrayBuffer();
        const bytes = new Uint8Array(arrayBuffer);
        let binary = '';
        const chunkSize = 0x8000;
        for (let b = 0; b < bytes.byteLength; b += chunkSize) {
            binary += String.fromCharCode.apply(null, bytes.subarray(b, b + chunkSize));
        }
        bitmap.close(); // 即時釋放顯存/記憶體
        return btoa(binary);
    } catch (err) {
        log.warn('Background', `圖片壓縮處理失敗，退回原圖: ${err.message}`);
        const arrayBuffer = await blob.arrayBuffer();
        const bytes = new Uint8Array(arrayBuffer);
        let binary = '';
        const chunkSize = 0x8000;
        for (let b = 0; b < bytes.byteLength; b += chunkSize) {
            binary += String.fromCharCode.apply(null, bytes.subarray(b, b + chunkSize));
        }
        return btoa(binary);
    }
}

/**
 * 在背景靜默抓取下一話 HTML，並提取漫畫圖片清單與下下一話導航連結
 * @param {string} chapterUrl
 * @param {number} sourceTabId
 * @param {Function} ensureContentScriptInjectedFn
 * @param {Function} [isJestfulChapterUrlFn]
 * @returns {Promise<{images: Array, navLinks: {prev: string|null, next: string|null}}>}
 */
export async function crawlChapterImagesAndNavCore(
    chapterUrl,
    sourceTabId,
    ensureContentScriptInjectedFn,
    isJestfulChapterUrlFn = defaultIsJestfulChapterUrl
) {
    try {
        if (isJestfulChapterUrlFn(chapterUrl)) {
            if (!sourceTabId) throw new Error('找不到來源分頁');
            return await crawlJestfulChapterInTab(chrome, chapterUrl, sourceTabId, ensureContentScriptInjectedFn);
        }
        log.info('Background', `[跨話靜默探針] 正在抓取下一話 HTML: ${chapterUrl}...`);
        const res = await fetch(chapterUrl, {
            headers: {
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'User-Agent': navigator.userAgent
            }
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const html = await res.text();

        return parseChapterHtml(html, chapterUrl);
    } catch (err) {
        log.warn('Background', `[跨話靜默探針] HTML 抓取解析失敗: ${err.message}`);
        return { images: [], navLinks: { prev: null, next: null } };
    }
}

/**
 * 組合跨批次對話上下文與場景錨點摘要，提供給下一批 API 呼叫保持語氣連貫
 * @param {Array} results
 * @param {number|string} maxLines
 * @param {string} sceneContext
 * @returns {string}
 */
export function buildPreviousContextSnippet(results = [], maxLines = 5, sceneContext = '') {
    if (typeof maxLines === 'string') {
        sceneContext = maxLines;
        maxLines = 5;
    }
    const list = Array.isArray(results) ? results : (results ? [results] : []);
    const pairs = [];
    for (const item of list) {
        const lines = Array.isArray(item?.results) ? item.results : (Array.isArray(item) ? item : []);
        for (const line of lines) {
            if (line?.original && line?.translation) {
                pairs.push(`${line.original} -> ${line.translation}`);
            }
        }
    }
    const limit = typeof maxLines === 'number' && maxLines > 0 ? maxLines : 5;
    const dialogueLines = pairs.slice(-limit);
    const trimmedScene = typeof sceneContext === 'string' ? sceneContext.trim() : '';

    if (trimmedScene && dialogueLines.length > 0) {
        return `[場景與角色關係]: ${trimmedScene}\n${dialogueLines.join('\n')}`;
    }
    if (trimmedScene) {
        return `[場景與角色關係]: ${trimmedScene}`;
    }
    return dialogueLines.join('\n');
}

/**
 * 專職負責將指定批次的圖片進行並行抓取、Blob 轉換與 OffscreenCanvas 等比例縮放
 * 支援雙緩衝管線 (Pipeline Prefetching) 在背景非同步提前預載
 * @param {Array} batch - 當前批次圖片陣列
 * @param {number} maxDim - 最大限制尺寸
 * @param {number|string} sourceTabId - 來源分頁 ID
 * @returns {Promise<Array<string|null>>} Base64 字串陣列
 */
export async function fetchAndResizeBatch(batch, maxDim, sourceTabId) {
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

/**
 * 處理區域截圖框選後的裁切與單圖翻譯
 * @param {{x: number, y: number, width: number, height: number}} rect
 * @param {number} tabId
 * @returns {Promise<{success: boolean, result?: Object, error?: string}>}
 */
export async function handleProcessScreenshot(rect, tabId) {
    try {
        if (!capturedScreenshotForSelection) {
            throw new Error('截圖資料遺失，請重新框選');
        }

        // 1. 裁切圖片取得 base64 (不含 data:image/jpeg;base64, 前綴)
        const croppedBase64 = await cropImageBase64(capturedScreenshotForSelection, rect);

        // 2. 獲取翻譯設定與詞庫
        const modelName = await state.get('modelName', 'gemini-3.1-flash-lite');
        const customPrompt = await state.get('customPrompt', Constants.DEFAULT_PROMPT_ONE_STEP);
        const navCtx = await state.get('navigationContext', {});
        const mangaKey = navCtx[tabId];
        let glossarySnippet = '';
        const isGlossaryEnabled = await state.get('globalGlossaryEnabled', true);
        if (isGlossaryEnabled && mangaKey) {
            const currentGlossary = await loadGlossary(mangaKey);
            if (currentGlossary && currentGlossary.terms) {
                glossarySnippet = buildGlossaryPromptSnippet(currentGlossary.terms);
            }
        }

        // 3. 呼叫翻譯 (一條龍 Vision 模式)
        const finalPrompt = Constants.resolveMangaOneStepPrompt(customPrompt, modelName);

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
        }
        throw new Error('API 請求成功但無回傳文字');
    } catch (err) {
        console.error('[ProcessScreenshot] 處理過程發生錯誤:', err);
        return { success: false, error: err.message };
    }
}

/**
 * 處理結果頁單張圖片重新翻譯請求 (使用備援模型並持久化寫回 mangaRecovery)
 * @param {Object} message
 * @param {Object} sender
 * @param {Object} mangaRecovery
 * @returns {Promise<{results: Array, usedModelName: string}>}
 */
export async function handleRetranslateImage(message, sender, mangaRecovery) {
    const { url, pageIndex, mangaKey } = message;
    const resultTabId = sender.tab?.id;
    const initialJob = resultTabId ? await mangaRecovery.snapshot(resultTabId) : null;
    const fallbackMemImg = (resultTabId && Number.isInteger(pageIndex))
        ? (mangaRecovery.getMemoryImage?.(resultTabId, pageIndex, initialJob?.id) || initialJob?.results?.find(r => r.pageIndex === pageIndex)?.image || '')
        : '';
    const effectiveUrl = url || fallbackMemImg;

    let base64 = null;
    if (effectiveUrl && effectiveUrl.startsWith('data:image')) {
        base64 = effectiveUrl.split(',')[1];
    } else if (effectiveUrl) {
        const maxDim = await state.get('imageMaxDimension', 1024);
        const res = await fetch(effectiveUrl);
        if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
        const blob = await res.blob();
        base64 = await resizeImageBlobToBase64(blob, maxDim);
    }
    if (!base64) throw new Error('無法取得圖片 Base64');

    const modelName = await state.get('modelName', 'gemini-3.1-flash-lite');
    const fallbackModelName = await state.get('fallbackModelName', 'gemini-3.5-flash-lite');
    const savedPrompt = await state.get('customPrompt', Constants.DEFAULT_PROMPT_ONE_STEP);

    // 救援行動強制使用備援模型
    const usedModel = fallbackModelName || modelName;
    const finalPrompt = Constants.resolveMangaOneStepPrompt(savedPrompt, usedModel);

    let glossarySnippet = '';
    const isGlossaryEnabled = await state.get('globalGlossaryEnabled', true);
    if (isGlossaryEnabled && mangaKey) {
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

    if (!result?.results) {
        throw new Error('API 回應格式異常');
    }

    // 優先採用 translateTexts 回傳的 usedModelName，並同步持久化寫回 mangaRecovery
    if (initialJob && Number.isInteger(pageIndex) && pageIndex > 0) {
        const expectedRow = initialJob.results?.find(r => r.pageIndex === pageIndex);
        const update = createMangaResultUpdate(expectedRow,
            { image: effectiveUrl, results: result.results, usedModelName: result.usedModelName || usedModel });
        const saved = await mangaRecovery.replaceResult(resultTabId, initialJob.id, pageIndex, update);
        if (!saved) throw new Error('頁面或任務已更新，請重新發起重譯');
    }

    return { results: result.results, usedModelName: result.usedModelName || usedModel };
}
