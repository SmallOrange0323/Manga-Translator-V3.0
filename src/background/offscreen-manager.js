import { log } from '../utils/logger.js';

const OFFSCREEN_PATH = 'src/offscreen/index.html';

/**
 * 確保 Offscreen Document 存在並完成握手
 */
export async function ensureOffscreenDocument() {
    if (!chrome.offscreen) {
        log.warn('OffscreenManager', '當前瀏覽器版本不支援 chrome.offscreen API');
        return false;
    }

    try {
        let exists = false;
        if (chrome.offscreen.hasDocument) {
            exists = await chrome.offscreen.hasDocument();
        } else if (chrome.runtime.getContexts) {
            const contexts = await chrome.runtime.getContexts({
                contextTypes: ['OFFSCREEN_DOCUMENT']
            });
            exists = (contexts && contexts.length > 0);
        }

        if (!exists) {
            log.info('OffscreenManager', '正在建立 Offscreen Document 容器...');
            await chrome.offscreen.createDocument({
                url: OFFSCREEN_PATH,
                reasons: [chrome.offscreen.Reason.WORKERS || 'WORKERS'],
                justification: '用於執行本地 WebGPU / WASM 端側 AI 運算與影像預處理'
            });
            log.info('OffscreenManager', 'Offscreen Document 容器已建立，等待腳本就緒...');
        }

        // 握手等待 Offscreen 腳本掛載完成 (最多等 2 秒)
        for (let attempt = 0; attempt < 10; attempt++) {
            const isAlive = await new Promise(resolve => {
                chrome.runtime.sendMessage({ target: 'offscreen', action: 'PING' }, resp => {
                    if (chrome.runtime.lastError || !resp || !resp.pong) {
                        resolve(false);
                    } else {
                        resolve(true);
                    }
                });
            });
            if (isAlive) {
                log.info('OffscreenManager', 'Offscreen 容器握手成功 (已就緒)');
                return true;
            }
            await new Promise(r => setTimeout(r, 150));
        }

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
 * 向 Offscreen Document 發送訊息並取得回應 (支援自動重試)
 */
export async function sendToOffscreen(action, payload = {}) {
    const ready = await ensureOffscreenDocument();
    if (!ready) {
        throw new Error('無法啟動本地 AI 容器 (Offscreen Document)');
    }

    const maxRetries = 2;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await new Promise((resolve, reject) => {
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
        } catch (err) {
            if (attempt === maxRetries) throw err;
            await new Promise(r => setTimeout(r, 200));
        }
    }
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
        log.info('OffscreenManager', `發送 ${base64Array.length} 頁至 Offscreen 容器進行本地辨識...`);
        const resp = await sendToOffscreen('LOCAL_AI_OCR_BATCH', { base64Array });
        if (resp.errors && resp.errors.length > 0) {
            log.warn('OffscreenManager', `本地 OCR 遭遇錯誤: ${resp.errors.join(' | ')}`);
        }
        return resp.results || Array(base64Array.length).fill('');
    } catch (e) {
        log.warn('OffscreenManager', `本地批次辨識調度異常: ${e.message}`);
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
