/**
 * sync-policy.js
 * 
 * 專職負責 Google Drive 雲端同步的純策略函式 (Pure Functions)：
 * 1. 一般設定白名單過濾 (General Settings Whitelist)
 * 2. API Key Pool 正規化 (Normalization)
 * 3. 雙軌時間戳衝突消解 (Dual-Track Conflict Resolution)
 * 4. API Key 差異變更偵測與時間戳更新 (saveApiKeyPoolIfChanged)
 */

export const SYNCABLE_SETTING_KEYS = [
    'translationMode',
    'modelName',
    'fallbackModelName',
    'useFallbackModelOnBatchRetry',
    'enableTaiwanLocalization',
    'googleAccountEmail',
    'ocrBatchSize',
    'requestDelay',
    'imageMaxDimension',
    'ocrModelName',
    'customPrompt',
    'customPromptOcr',
    'novelModelName',
    'novelBatchSize',
    'novelPrompt',
    'hybridModeEnabled',
    'secondaryModelName',
    'autoPretranslateNextChapter'
];

/**
 * 將多行 API Key 字串正規化（去除每行頭尾空白、過濾空行、以 \n 重組）
 * 空字串 "" 為合法有效值（代表使用者刻意清空所有金鑰）
 * 若傳入非字串型態，回傳 null（代表 malformed）
 * @param {*} value 
 * @returns {string|null}
 */
export function normalizeApiKeyPool(value) {
    if (typeof value !== 'string') return null;
    return value
        .split('\n')
        .map(k => k.trim())
        .filter(k => k.length > 0)
        .join('\n');
}

/**
 * 依據一般設定白名單過濾物件，絕不複製未授權欄位（如 apiKey 或 runtime state）
 * @param {Object} rawSettings 
 * @returns {Object}
 */
export function sanitizeSyncableSettings(rawSettings) {
    if (!rawSettings || typeof rawSettings !== 'object') return {};
    const sanitized = {};
    for (const key of SYNCABLE_SETTING_KEYS) {
        if (rawSettings[key] !== undefined) {
            sanitized[key] = rawSettings[key];
        }
    }
    return sanitized;
}

/**
 * API Key 雙軌同步衝突消解 (Pure Function)
 * @param {Object} params
 * @param {string|null} params.localApiKey 本機 API Key
 * @param {number|null} params.localApiKeyLastModified 本機 API Key 專屬時間戳
 * @param {number|null} params.localSettingsLastModified 本機一般設定時間戳 (Legacy fallback)
 * @param {*} params.cloudApiKey 雲端頂層 API Key
 * @param {number|null} params.cloudApiKeyLastModified 雲端頂層 API Key 專屬時間戳
 * @param {number|null} params.cloudSettingsLastModified 雲端一般設定時間戳 (Legacy fallback)
 * @param {*} params.legacyCloudSettingsApiKey 舊版雲端 settings.apiKey 欄位 (Legacy candidate)
 * @returns {Object} { resolvedApiKey, resolvedTimestamp, source: 'cloud'|'local', shouldWriteLocal, shouldUploadCloud }
 */
export function resolveApiKeySync({
    localApiKey = '',
    localApiKeyLastModified = 0,
    localSettingsLastModified = 0,
    cloudApiKey,
    cloudApiKeyLastModified = 0,
    cloudSettingsLastModified = 0,
    legacyCloudSettingsApiKey
}) {
    // 1. 本機有效性與正規化
    const normLocalKey = typeof localApiKey === 'string' ? normalizeApiKeyPool(localApiKey) : '';
    const normLocalTime = Number.isFinite(localApiKeyLastModified) && localApiKeyLastModified > 0
        ? localApiKeyLastModified
        : (Number.isFinite(localSettingsLastModified) && localSettingsLastModified > 0 ? localSettingsLastModified : 0);

    // 2. 雲端候選 Key 提取與正規化 (優先使用頂層 cloudApiKey，其次 fallback 至舊版 settings.apiKey)
    let candidateCloudKey = cloudApiKey;
    let candidateCloudTime = cloudApiKeyLastModified;

    if (candidateCloudKey === undefined && legacyCloudSettingsApiKey !== undefined) {
        candidateCloudKey = legacyCloudSettingsApiKey;
        candidateCloudTime = cloudApiKeyLastModified || cloudSettingsLastModified || 0;
    }

    const normCloudKey = typeof candidateCloudKey === 'string' ? normalizeApiKeyPool(candidateCloudKey) : null;
    const normCloudTime = Number.isFinite(candidateCloudTime) && candidateCloudTime > 0 ? candidateCloudTime : 0;

    // 3. 雲端為 Malformed（非字串型態）時之防禦：保留本機
    if (normCloudKey === null) {
        return {
            resolvedApiKey: normLocalKey,
            resolvedTimestamp: normLocalTime || Date.now(),
            source: 'local',
            shouldWriteLocal: false,
            shouldUploadCloud: true
        };
    }

    // 4. 時間戳比對與衝突消解
    if (normCloudTime > normLocalTime) {
        // 雲端較新 ➔ 雲端獲勝 (寫入本機)
        return {
            resolvedApiKey: normCloudKey,
            resolvedTimestamp: normCloudTime,
            source: 'cloud',
            shouldWriteLocal: normCloudKey !== normLocalKey,
            shouldUploadCloud: false
        };
    } else if (normLocalTime > normCloudTime) {
        // 本機較新 ➔ 本機獲勝 (上傳雲端)
        return {
            resolvedApiKey: normLocalKey,
            resolvedTimestamp: normLocalTime,
            source: 'local',
            shouldWriteLocal: false,
            shouldUploadCloud: true
        };
    } else {
        // 時間戳相等 (Tie-break)
        if (normLocalKey === normCloudKey) {
            return {
                resolvedApiKey: normLocalKey,
                resolvedTimestamp: normLocalTime || Date.now(),
                source: 'local',
                shouldWriteLocal: false,
                shouldUploadCloud: false
            };
        } else {
            // 時間戳完全相等但內容不同 ➔ 確定性以雲端為準 (Cloud canonical state)
            return {
                resolvedApiKey: normCloudKey,
                resolvedTimestamp: normCloudTime || Date.now(),
                source: 'cloud',
                shouldWriteLocal: true,
                shouldUploadCloud: false
            };
        }
    }
}

/**
 * 輔助函式：只有在 API Key Pool 內容（正規化後）真正改變時，才更新 apiKey 與 apiKeyLastModified
 * @param {string} nextKeys 
 * @param {Object} stateManager state 物件實例
 * @returns {Promise<boolean>} 是否實際發生了更新
 */
export async function saveApiKeyPoolIfChanged(nextKeys, stateManager) {
    if (!stateManager || typeof stateManager.get !== 'function') return false;
    const currentKeys = await stateManager.get('apiKey', '');
    const normCurrent = normalizeApiKeyPool(currentKeys) || '';
    const normNext = normalizeApiKeyPool(typeof nextKeys === 'string' ? nextKeys : '') || '';

    if (normCurrent === normNext) {
        return false;
    }

    await stateManager.set('apiKey', normNext);
    await stateManager.set('apiKeyLastModified', Date.now());
    return true;
}
