// src/utils/logger.js

/**
 * Logger Utility for Manga Translator V2.0
 * 支援 Service Worker 環境偵測與樣式化輸出
 */

// 偵測環境：MV3 Service Worker 沒有 window 與 document
const IS_SW = typeof window === 'undefined' || typeof document === 'undefined';

/**
 * HH:mm:ss.SSS 格式時間戳
 */
function getTimestamp() {
    const now = new Date();
    const h = String(now.getHours()).padStart(2, '0');
    const m = String(now.getMinutes()).padStart(2, '0');
    const s = String(now.getSeconds()).padStart(2, '0');
    const ms = String(now.getMilliseconds()).padStart(3, '0');
    return `${h}:${m}:${s}.${ms}`;
}

/**
 * 遮罩 API Key，僅保留前 8 位與後 4 位
 */
export function maskKey(key) {
    if (!key || typeof key !== 'string') return 'N/A';
    if (key.length <= 12) return '****';
    return `${key.slice(0, 8)}...${key.slice(-4)}`;
}

/**
 * 樣式定義 (僅於非 SW 環境生效)
 */
const STYLES = {
    info: 'color: #00b894; font-weight: bold;',
    warn: 'color: #fdcb6e; font-weight: bold;',
    error: 'color: #d63031; font-weight: bold;',
    api: 'color: #0984e3; font-weight: bold;',
    state: 'color: #6c5ce7; font-weight: bold;'
};

export const log = {
    info(module, msg, data = '') {
        const ts = getTimestamp();
        if (IS_SW) {
            console.log(`[${ts}] ℹ️ [${module}] ${msg}`, data);
        } else {
            console.log(`%c[${ts}] ℹ️ [${module}] %c${msg}`, STYLES.info, 'color: inherit;', data);
        }
    },

    warn(module, msg, data = '') {
        const ts = getTimestamp();
        if (IS_SW) {
            console.warn(`[${ts}] ⚠️ [${module}] ${msg}`, data);
        } else {
            console.warn(`%c[${ts}] ⚠️ [${module}] %c${msg}`, STYLES.warn, 'color: inherit;', data);
        }
    },

    error(module, msg, err = null) {
        const ts = getTimestamp();
        if (IS_SW) {
            console.error(`[${ts}] 🛑 [${module}] ${msg}`, err);
            if (err?.stack) console.error(err.stack);
        } else {
            console.error(`%c[${ts}] 🛑 [${module}] %c${msg}`, STYLES.error, 'color: inherit;', err);
            if (err?.stack) console.error(err.stack);
        }
    },

    api(module, msg, stats = {}) {
        const { model, latencyMs, keyAlias, status = 'OK' } = stats;
        const ts = getTimestamp();
        const icon = status === 'OK' ? '✅' : '❌';
        const formattedMsg = `${icon} API ${status} | model: ${model} | latency: ${latencyMs}ms | key: ${keyAlias}`;
        
        if (IS_SW) {
            console.log(`[${ts}] 🌐 [${module}] ${formattedMsg}`, msg);
        } else {
            console.log(`%c[${ts}] 🌐 [${module}] %c${formattedMsg}`, STYLES.api, 'color: inherit;', msg);
        }
    },

    state(key, action, newVal) {
        const ts = getTimestamp();
        const msg = `狀態更新: [${key}] ${action}`;
        if (IS_SW) {
            console.log(`[${ts}] 💾 [儲存] ${msg}`, newVal);
        } else {
            console.log(`%c[${ts}] 💾 [儲存] %c${msg}`, STYLES.state, 'color: inherit;', newVal);
        }
    }
};
