// src/utils/sync-engine.js
import { log } from './logger.js';
import { state } from './state.js';
import { getAuthToken, performBiDirectionalSync } from './sync.js';

/**
 * SyncEngine: 雲端同步背景排程器與調度核心
 * 
 * 核心功能：
 * 1. 內建防抖 (Debounce) 機制，防止因高頻寫入 storage（例如連續輸入 API Key）而重複發送大量 API 請求。
 * 2. 橋接背景監聽器與真實的 Google Drive REST API。
 * 3. 使用靜默授權（Non-interactive OAuth2），在不打擾使用者的前提下在背景自動雙向同步。
 */
class SyncEngine {
  constructor() {
    this.syncDebounceTimer = null;
    this.activeSync = null;
    this.dirty = false;
  }

  /**
   * 觸發同步：防抖（Debounce）處理
   * @param {Object} changes 本次變更的 storage 內容
   */
  triggerSync(changes = {}) {
    if (this.activeSync) {
      this.dirty = true;
      return;
    }
    if (this.syncDebounceTimer) {
      clearTimeout(this.syncDebounceTimer);
    }

    // 設定 3 秒防抖延遲
    this.syncDebounceTimer = setTimeout(() => {
      this.syncDebounceTimer = null;
      this.syncUp().catch(err => {
        log.error('SyncEngine', '背景自動同步任務失敗 (防抖觸發):', err);
      });
    }, 3000);
  }

  /**
   * 執行背景自動同步
   */
  async syncUp() {
    // 檢查是否啟用了雲端同步
    const enableCloudSync = await state.get('enableCloudSync', false);
    if (!enableCloudSync) {
      log.info('SyncEngine', '使用者未啟用雲端同步，跳過背景上傳');
      return;
    }

    try {
      // 1. 嘗試靜默獲取 Token (不彈出授權視窗)
      let token;
      try {
        token = await getAuthToken(false);
      } catch (tokenErr) {
        log.info('SyncEngine', '背景靜默獲取 Token 暫不可用 (需於設定頁手動點擊授權)，跳過本次背景自動同步');
        return; // 背景不強行彈出視窗打擾使用者
      }

      // 2. 執行真實的雙向拉取與上傳同步
      return await this.syncNow(token);

    } catch (err) {
      log.error('SyncEngine', '背景執行自動雲端同步時發生異常:', err.message);
      
      // 廣播錯誤狀態
      chrome.runtime.sendMessage({
        action: 'CLOUD_SYNC_STATUS',
        payload: { success: false, error: err.message }
      }).catch(() => {});
    }
  }

  // Manual and background sync share one in-flight operation. Storage changes
  // observed while the upload is pending request another full round trip.
  async syncNow(token) {
    if (this.activeSync) {
      this.dirty = true;
      return this.activeSync;
    }
    this.activeSync = (async () => {
      let lastSyncStr;
      do {
        this.dirty = false;
        lastSyncStr = await performBiDirectionalSync(token);
      } while (this.dirty);
      log.info('SyncEngine', `同步成功！同步時間: ${lastSyncStr}`);
      chrome.runtime.sendMessage({
        action: 'CLOUD_SYNC_STATUS',
        payload: { success: true, timestamp: Date.now(), lastSyncTime: lastSyncStr }
      }).catch(() => {});
      return lastSyncStr;
    })();
    try {
      return await this.activeSync;
    } finally {
      this.activeSync = null;
    }
  }
}

export const syncEngine = new SyncEngine();
