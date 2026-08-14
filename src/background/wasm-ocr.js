import { log } from '../utils/logger.js';
import { runLocalAiOcrBatch, checkLocalGpuStatus, clearLocalModelCache } from './offscreen-manager.js';

/**
 * MangaWasmOCR: 瀏覽器本地 WebAssembly / WebGPU 端側 AI 引擎
 * 特點：
 * 1. 0 API 消耗，完全由本地 GPU/WASM 執行
 * 2. 符合 MV3 Offscreen Document 標準規範
 */
class MangaWasmOCR {
    constructor() {
        this.gpuInfo = null;
    }

    /**
     * 獲取本地硬體加速與 WebGPU 狀態
     */
    async getGpuStatus() {
        if (!this.gpuInfo) {
            this.gpuInfo = await checkLocalGpuStatus();
        }
        return this.gpuInfo;
    }

    /**
     * 多圖批次本地 OCR 辨識
     * @param {string[]} base64Array - 圖片 Base64 陣列
     * @returns {Promise<string[]>} 各頁日文文字陣列
     */
    async recognizeBatch(base64Array) {
        log.info('WasmOCR', `啟動本地端 AI 批次辨識: 共 ${base64Array.length} 頁圖片 (0 API 消耗模式)`);
        const startTime = performance.now();
        const results = await runLocalAiOcrBatch(base64Array);
        const latencyMs = Math.round(performance.now() - startTime);
        log.info('WasmOCR', `本地端 AI 批次辨識完成 (${latencyMs}ms)`);
        return results;
    }

    /**
     * 清理快取
     */
    async clearCache() {
        return await clearLocalModelCache();
    }
}

export const wasmOcrEngine = new MangaWasmOCR();
