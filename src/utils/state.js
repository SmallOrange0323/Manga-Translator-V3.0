// src/utils/state.js
import { log } from './logger.js';

/**
 * StateManager: Manga Translator V3.0 狀態管理器
 * 
 * 核心設計：
 * 1. Storage-First: 所有狀態變更立即或延後寫入 chrome.storage.local
 * 2. Throttle: 進度更新等高頻寫入會進行節流處理，避免阻塞
 * 3. Reactive: 透過 chrome.storage.onChanged 讓 UI 對應更新
 */

class StateManager {
  constructor() {
    this.cache = {};
    this.throttleTimers = {};
    this.isInitialized = false;
    this.initPromise = null;
    this.apiKeys = [];
    this.currentKeyIndex = 0;
  }

  /**
   * 初始化：從 Storage 讀取所有資料到快取
   * 使用 Promise 鎖確保全球只執行一次
   */
  async init() {
    if (this.isInitialized) return Promise.resolve();
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
        const data = await chrome.storage.local.get(null);
        this.cache = data || {};
        
        // 初始化 API Key 池
        this.refreshApiKeyPool();

        this.isInitialized = true;
        this.initPromise = null;
        log.state('ALL', 'Initialized', this.cache);
    })();

    return this.initPromise;
  }

  /**
   * 讀取狀態
   * @param {string} key 
   * @param {any} defaultValue 
   */
  async get(key, defaultValue = null) {
    if (!this.isInitialized) await this.init();
    return this.cache[key] !== undefined ? this.cache[key] : defaultValue;
  }

  /**
   * 原子化更新：確保讀取、修改、寫入過程不被中途干擾
   * 非常適用於隊列 (Queue) 操作
   * @param {string} key 
   * @param {function} updater (currentVal) => newVal
   */
  async update(key, updater) {
    if (!this.isInitialized) await this.init();
    
    // 為了跨 context (Sidepanel/Background) 原子化，
    // 我們在更新前強制從 storage 讀取一次最新值
    const data = await chrome.storage.local.get(key);
    const currentVal = data[key];
    const newVal = await updater(currentVal);
    
    this.cache[key] = newVal;
    await chrome.storage.local.set({ [key]: newVal });
    log.state(key, 'Updated (Atomic)', newVal);
  }

  /**
   * 寫入狀態 (即時)
   * @param {string} key 
   * @param {any} value 
   */
  async set(key, value) {
    this.cache[key] = value;
    await chrome.storage.local.set({ [key]: value });
    log.state(key, 'Set', value);
  }

  /**
   * 具有節流機制的寫入 (適用於進度條)
   * @param {string} key 
   * @param {any} value 
   * @param {number} delay 毫秒數
   */
  async setThrottled(key, value, delay = 200) {
    this.cache[key] = value;
    
    if (this.throttleTimers[key]) return; // 已有排定的寫入，略過此波

    this.throttleTimers[key] = setTimeout(async () => {
      await chrome.storage.local.set({ [key]: this.cache[key] });
      delete this.throttleTimers[key];
    }, delay);
  }

  /**
   * 重新從 raw apiKey 字串解析金鑰池
   */
  refreshApiKeyPool() {
    const rawKeys = this.cache['apiKey'] || '';
    this.apiKeys = rawKeys.split('\n').map(k => k.trim()).filter(k => k);
    log.info('StateManager', `API Key Pool refreshed: ${this.apiKeys.length} keys`);
  }

  /**
   * 獲取下一個可用的 API Key (輪替機制)
   */
  getNextApiKey() {
    if (this.apiKeys.length === 0) return null;
    const key = this.apiKeys[this.currentKeyIndex];
    this.currentKeyIndex = (this.currentKeyIndex + 1) % this.apiKeys.length;
    return key;
  }

  /**
   * 獲取 API Key 的友善別名 (對應設定頁面的索引)
   * @param {string} key 
   * @returns {string} 例如 "API Key 1" 或遮罩後的字串
   */
  getApiKeyAlias(key) {
    if (!key) return 'N/A';
    const index = this.apiKeys.indexOf(key);
    if (index !== -1) {
      return `API Key ${index + 1}`;
    }
    // 找不到 Key 則使用遮罩格式回退
    return key.length > 12 ? `${key.slice(0, 8)}...${key.slice(-4)}` : '****';
  }

  /**
   * 監聽狀態變更的便捷封裝
   */
  onChanged(callback) {
    chrome.storage.onChanged.addListener((changes, namespace) => {
      if (namespace === 'local') {
        // 更新本地快取以保持同步
        for (let key in changes) {
          this.cache[key] = changes[key].newValue;
          
          // 如果是 apiKey 變更，同步更新金鑰池
          if (key === 'apiKey') {
            this.refreshApiKeyPool();
          } else {
            // apiKey 以外的變更記錄到 log (避免在 onChanged 裡印出 key)
            log.state(key, 'Changed (External)', changes[key].newValue);
          }
        }
        callback(changes);
      }
    });
  }
}

export const state = new StateManager();
