import { log } from '../utils/logger.js';

const OFFSCREEN_PATH = 'src/offscreen/index.html';

/**
 * 確保 Offscreen Document 存在
 */
export async function ensureOffscreenDocument() {
    if (!chrome.offscreen) {
        log.warn('OffscreenManager', '當前瀏覽器版本不支援 chrome.offscreen API');
        return false;
    }

    try {
        // 檢查是否已存在
        if (chrome.offscreen.hasDocument) {
            const hasDoc = await chrome.offscreen.hasDocument();
            if (hasDoc) return true;
        } else if (chrome.runtime.getContexts) {
            const contexts = await chrome.runtime.getContexts({
                contextTypes: ['OFFSCREEN_DOCUMENT']
            });
            if (contexts && contexts.length > 0) return true;
        }

        log.info('OffscreenManager', '建立 Offscreen Document 容器...');
        await chrome.offscreen.createDocument({
            url: OFFSCREEN_PATH,
            reasons: [chrome.offscreen.Reason.WORKERS || 'WORKERS'],
            justification: '用於執行本地 WebGPU / WASM 端側 AI 運算與影像預處理'
        });
        log.info('OffscreenManager', 'Offscreen Document 容器已就緒');
        return true;
    } catch (err) {
        if (err.message && err.message.includes('Only a single offscreen document may be created')) {
            return true;
        }
        log.warn('OffscreenManager', `建立 Offscreen 失敗: ${err.message}`);
        return false;
    }
}

/**
 * 向 Offscreen Document 發送訊息並取得回應
 */
export async function sendToOffscreen(action, payload = {}) {
    const ready = await ensureOffscreenDocument();
    if (!ready) {
        throw new Error('無法啟動本地 AI 容器 (Offscreen Document)');
    }

    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({
            target: 'offscreen',
            action,
            payload
        }, (response) => {
            const lastErr = chrome.runtime.lastError;
            if (lastErr) {
                return reject(new Error(lastErr.message));
            }
            if (response && response.success) {
                resolve(response.data !== undefined ? response.data : response);
            } else {
                reject(new Error(response?.message || 'Offscreen 處理失敗'));
            }
        });
    });
}

/**
 * 檢測本地 WebGPU 與顯卡硬體加速狀態
 */
export async function checkLocalGpuStatus() {
    try {
        return await sendToOffscreen('CHECK_LOCAL_AI_ENV');
    } catch (e) {
        return {
            hasWebGPU: false,
            adapterName: '本地端引擎準備中',
            hasWasm: typeof WebAssembly === 'object'
        };
    }
}

/**
 * 執行多圖本地端文字辨識
 */
export async function runLocalAiOcrBatch(base64Array) {
    try {
        const resp = await sendToOffscreen('LOCAL_AI_OCR_BATCH', { base64Array });
        return resp.results || Array(base64Array.length).fill('');
    } catch (e) {
        log.warn('OffscreenManager', `本地批次辨識失敗: ${e.message}`);
        return Array(base64Array.length).fill('');
    }
}

/**
 * 清理本地模型快取
 */
export async function clearLocalModelCache() {
    try {
        return await sendToOffscreen('LOCAL_AI_CLEAR_CACHE');
    } catch (e) {
        return { success: false, message: e.message };
    }
}
