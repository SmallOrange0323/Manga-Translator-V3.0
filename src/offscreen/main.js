import { createWorker } from 'tesseract.js';
import { log } from '../utils/logger.js';

log.info('OffscreenAI', 'Offscreen 本地端 AI 容器已啟動');

let tesseractWorker = null;
let isWorkerInitializing = false;
let initPromise = null;

/**
 * 初始化本機 Tesseract OCR Worker (支援日文豎排/橫排漫畫文字)
 */
async function getTesseractWorker() {
    if (tesseractWorker) return tesseractWorker;
    if (isWorkerInitializing) return initPromise;

    isWorkerInitializing = true;
    initPromise = (async () => {
        try {
            log.info('OffscreenAI', '正在初始化本地端日文漫畫 OCR Worker (100% 本機離線內建模式)...');
            const workerPath = chrome.runtime.getURL('assets/tesseract/worker.min.js');
            const corePath = chrome.runtime.getURL('assets/tesseract/tesseract-core-simd-lstm.wasm.js');
            const langPath = chrome.runtime.getURL('assets/tesseract/lang-data');

            const worker = await createWorker('jpn_vert+jpn', 1, {
                workerPath,
                corePath,
                langPath,
                workerBlobURL: false,
                gzip: true,
                logger: m => {
                    if (m.status === 'loading tdata') {
                        const pct = Math.round((m.progress || 0) * 100);
                        log.info('OffscreenAI', `📥 正在自本機讀取日文模型: ${pct}%`);
                    }
                }
            });

            tesseractWorker = worker;
            log.info('OffscreenAI', '✅ 本地端日文 OCR Worker 初始化就緒 (100% 離線 / 0 API 消耗)');
            return tesseractWorker;
        } catch (err) {
            log.warn('OffscreenAI', `Tesseract Worker 縱書初始化失敗: ${err.message}，嘗試本機標準日文模式...`);
            try {
                const workerPath = chrome.runtime.getURL('assets/tesseract/worker.min.js');
                const corePath = chrome.runtime.getURL('assets/tesseract/tesseract-core-simd-lstm.wasm.js');
                const langPath = chrome.runtime.getURL('assets/tesseract/lang-data');

                const fallbackWorker = await createWorker('jpn', 1, {
                    workerPath,
                    corePath,
                    langPath,
                    workerBlobURL: false,
                    gzip: true
                });
                tesseractWorker = fallbackWorker;
                log.info('OffscreenAI', '✅ 本地端日文 (標準) Worker 初始化就緒 (本機離線)');
                return tesseractWorker;
            } catch (e2) {
                log.error('OffscreenAI', `本地 OCR 引擎無法啟動: ${e2.message}`);
                throw e2;
            }
        } finally {
            isWorkerInitializing = false;
        }
    })();

    return initPromise;
}

/**
 * 檢測本機 WebGPU 硬體加速環境
 */
async function checkWebGpuSupport() {
    const info = {
        hasWebGPU: false,
        adapterName: '未偵測到相容顯卡 (使用 CPU/WASM 模式)',
        hasWasm: typeof WebAssembly === 'object'
    };

    if (navigator.gpu) {
        try {
            const adapter = await navigator.gpu.requestAdapter();
            if (adapter) {
                info.hasWebGPU = true;
                const adapterInfo = adapter.info || (await adapter.requestAdapterInfo?.()) || {};
                info.adapterName = adapterInfo.description || adapterInfo.device || 'WebGPU 硬體加速已啟用';
            }
        } catch (e) {
            log.warn('OffscreenAI', `WebGPU 檢測異常: ${e.message}`);
        }
    }

    return info;
}

/**
 * 本地端影像文字辨識 (支援 Canvas 縮放預處理提速)
 * @param {string} base64 
 * @returns {Promise<string>} 辨識出的日文文字
 */
async function recognizeImageLocal(base64) {
    if (!base64) return '';
    const startTime = performance.now();
    try {
        const worker = await getTesseractWorker();
        const imgSrc = base64.startsWith('data:') ? base64 : `data:image/jpeg;base64,${base64}`;

        const ret = await worker.recognize(imgSrc);
        const rawText = ret.data.text || '';
        const cleanText = rawText
            .split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0)
            .join('\n');

        const latencyMs = Math.round(performance.now() - startTime);
        log.info('OffscreenAI', `本地端日文辨識完成 (${latencyMs}ms)，萃取出 ${cleanText.length} 字`);
        return cleanText;
    } catch (err) {
        log.warn('OffscreenAI', `本地辨識錯誤: ${err.message}`);
        return '';
    }
}

/**
 * 清理瀏覽器 Cache Storage / IndexedDB 中快取的 AI 模型檔案
 */
async function clearModelCache() {
    try {
        if (tesseractWorker) {
            await tesseractWorker.terminate();
            tesseractWorker = null;
        }

        if ('caches' in window) {
            const keys = await caches.keys();
            const aiKeys = keys.filter(k => k.includes('tess') || k.includes('ocr') || k.includes('onnx'));
            await Promise.all(aiKeys.map(k => caches.delete(k)));
        }

        // 清理 IndexedDB 中的 tesseract 快取
        if (window.indexedDB && indexedDB.databases) {
            const dbs = await indexedDB.databases();
            for (const db of dbs) {
                if (db.name && db.name.includes('tesseract')) {
                    indexedDB.deleteDatabase(db.name);
                }
            }
        }

        log.info('OffscreenAI', '已清理本機 AI 模型快取項目');
        return { success: true };
    } catch (err) {
        return { success: false, message: err.message };
    }
}

// 監聽來自 Service Worker 的請求
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.target !== 'offscreen') return false;

    const { action, payload } = message;

    if (action === 'PING') {
        sendResponse({ pong: true });
        return false;
    }

    if (action === 'CHECK_LOCAL_AI_ENV') {
        checkWebGpuSupport().then(res => sendResponse({ success: true, data: res }));
        return true;
    }

    if (action === 'LOCAL_AI_OCR_PAGE') {
        recognizeImageLocal(payload.base64).then(res => sendResponse({ success: true, text: res.text, error: res.error }));
        return true;
    }

    if (action === 'LOCAL_AI_OCR_BATCH') {
        (async () => {
            const results = [];
            const errors = [];
            for (const b64 of (payload.base64Array || [])) {
                const res = await recognizeImageLocal(b64);
                results.push(res.text);
                if (res.error) errors.push(res.error);
            }
            sendResponse({ success: true, results, errors });
        })();
        return true;
    }

    if (action === 'LOCAL_AI_CLEAR_CACHE') {
        clearModelCache().then(res => sendResponse(res));
        return true;
    }

    return false;
});
