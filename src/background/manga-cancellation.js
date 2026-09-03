/**
 * Manga Cancellation Registry (Runtime In-Memory Only)
 * 管理前景漫畫翻譯的生命週期與 AbortController
 * 注意：AbortController 僅存在於 Service Worker runtime memory，不可持久化
 */

let currentMangaController = null;
let isMangaActive = false;

/**
 * 啟動新的漫畫翻譯任務，綁定新的 AbortController
 * 若先前仍有未結束的任務控制器，立即進行 abort
 * @returns {AbortController}
 */
export function beginMangaRun() {
    if (currentMangaController) {
        try {
            currentMangaController.abort();
        } catch (_) {}
    }
    currentMangaController = new AbortController();
    isMangaActive = true;
    return currentMangaController;
}

/**
 * 中止目前進行中的漫畫翻譯任務 (Idempotent)
 */
export function cancelMangaRun() {
    if (currentMangaController) {
        try {
            currentMangaController.abort();
        } catch (_) {}
    }
    isMangaActive = false;
}

/**
 * 清理並重設漫畫翻譯任務控制器
 */
export function clearMangaRun() {
    cancelMangaRun();
    currentMangaController = null;
    isMangaActive = false;
}

/**
 * 取得目前活躍漫畫任務的 AbortSignal
 * 若任務已停止或不存在，返回已中斷 (aborted: true) 的 signal，以落實 fail-closed
 * @returns {AbortSignal}
 */
export function getMangaAbortSignal() {
    if (!currentMangaController || !isMangaActive) {
        return AbortSignal.abort();
    }
    return currentMangaController.signal;
}

/**
 * 檢查目前漫畫任務是否已被中止
 * @returns {boolean}
 */
export function isMangaRunAborted() {
    if (!currentMangaController || !isMangaActive) return true;
    return currentMangaController.signal.aborted;
}
