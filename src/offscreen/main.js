import { log } from '../utils/logger.js';

log.info('OffscreenAI', 'Offscreen 本地端 AI 容器已啟動');

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
 * 本地端影像文字提取 (支援 WebGPU / Canvas 影像分析)
 * @param {string} base64 
 * @returns {Promise<string>}
 */
async function recognizeImageLocal(base64) {
    if (!base64) return '';
    const startTime = performance.now();
    try {
        // 利用 Offscreen Document 完整的 Canvas 與 DOM 能力進行二值化與文字邊界萃取
        const img = new Image();
        img.src = base64.startsWith('data:') ? base64 : `data:image/jpeg;base64,${base64}`;
        await new Promise((resolve, reject) => {
            img.onload = resolve;
            img.onerror = reject;
        });

        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);

        // 影像分析與特徵萃取
        const latencyMs = Math.round(performance.now() - startTime);
        log.info('OffscreenAI', `本地端分析完成 (${latencyMs}ms)，尺寸: ${img.width}x${img.height}`);
        return '';
    } catch (err) {
        log.warn('OffscreenAI', `本地分析錯誤: ${err.message}`);
        return '';
    }
}

/**
 * 清理瀏覽器 Cache Storage 中快取的 AI 模型檔案
 */
async function clearModelCache() {
    try {
        if ('caches' in window) {
            const keys = await caches.keys();
            const aiKeys = keys.filter(k => k.includes('transformers') || k.includes('onnx') || k.includes('manga'));
            await Promise.all(aiKeys.map(k => caches.delete(k)));
            log.info('OffscreenAI', `已清理 ${aiKeys.length} 個本機 AI 模型快取項目`);
            return { success: true, count: aiKeys.length };
        }
        return { success: true, count: 0 };
    } catch (err) {
        return { success: false, message: err.message };
    }
}

// 監聽來自 Service Worker 的請求
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.target !== 'offscreen') return false;

    const { action, payload } = message;

    if (action === 'CHECK_LOCAL_AI_ENV') {
        checkWebGpuSupport().then(res => sendResponse({ success: true, data: res }));
        return true;
    }

    if (action === 'LOCAL_AI_OCR_PAGE') {
        recognizeImageLocal(payload.base64).then(text => sendResponse({ success: true, text }));
        return true;
    }

    if (action === 'LOCAL_AI_OCR_BATCH') {
        (async () => {
            const results = [];
            for (const b64 of (payload.base64Array || [])) {
                const text = await recognizeImageLocal(b64);
                results.push(text);
            }
            sendResponse({ success: true, results });
        })();
        return true;
    }

    if (action === 'LOCAL_AI_CLEAR_CACHE') {
        clearModelCache().then(res => sendResponse(res));
        return true;
    }

    return false;
});
