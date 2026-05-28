// src/utils/sync.js
import { state } from './state.js';
import { GLOSSARY_STORAGE_KEY } from '../background/glossary-manager.js';
import { log } from './logger.js';

const SYNC_FILE_NAME = 'manga_translator_v3_sync.json';
const SETTINGS_LAST_MODIFIED_KEY = 'settingsLastModified';
const SYNC_ENABLED_KEY = 'enableCloudSync';
const SYNC_LAST_TIME_KEY = 'googleSyncLastTime';
const SYNC_STATUS_KEY = 'googleSyncStatus';

/**
 * 透過 Web 授權流獲取 Google Token (Edge / 跨瀏覽器相容方案)
 * @param {boolean} interactive 
 */
function runWebAuthFlow(interactive = true) {
  return new Promise(async (resolve, reject) => {
    try {
      // 優先載入使用者在設定頁面中貼入的自訂 Web 用戶端 ID
      const savedClientId = await state.get('googleClientId', '');
      const clientId = savedClientId || '892014744898-ea2t1djhd9sqs350hb244pifstrlre4q.apps.googleusercontent.com';
      const redirectUri = chrome.identity.getRedirectURL();
      const scope = encodeURIComponent('https://www.googleapis.com/auth/drive.appdata');
      const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&response_type=token&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${scope}`;

      log.info('GoogleSync', '發起跨瀏覽器 WebAuthFlow 授權...', redirectUri);

      chrome.identity.launchWebAuthFlow({
        url: authUrl,
        interactive: interactive
      }, (redirectUrl) => {
        const err = chrome.runtime.lastError;
        if (err) {
          log.error('GoogleSync', 'WebAuthFlow 失敗:', err.message);
          reject(new Error(err.message));
          return;
        }

        if (!redirectUrl) {
          log.error('GoogleSync', 'WebAuthFlow 未取得跳轉 URL');
          reject(new Error('授權流程中斷，未取得重新導向 URL'));
          return;
        }

        // 從 Hash 解析 Access Token
        const matches = redirectUrl.match(/access_token=([^&]+)/);
        if (matches && matches[1]) {
          const token = matches[1];
          log.info('GoogleSync', 'WebAuthFlow 成功取得 Token');
          resolve(token);
        } else {
          log.error('GoogleSync', '跳轉 URL 中未含有 token 參數');
          reject(new Error('重新導向 URL 中未包含 access_token'));
        }
      });
    } catch (e) {
      log.error('GoogleSync', 'WebAuthFlow 初始化失敗:', e);
      reject(e);
    }
  });
}

/**
 * 取得 Google 授權 Token
 * @param {boolean} interactive 是否顯示互動視窗進行授權
 */
export function getAuthToken(interactive = true) {
  return new Promise((resolve, reject) => {
    // 優先試用 Chrome 內建 getAuthToken
    chrome.identity.getAuthToken({ interactive }, (token) => {
      const err = chrome.runtime.lastError;
      if (err) {
        const errMsg = err.message || '';
        // 當發現是 Edge 或 API 不受支援時，自動無縫降級至 Web 授權流
        if (errMsg.includes('not supported') || errMsg.includes('Edge') || errMsg.includes('disabled')) {
          log.info('GoogleSync', '偵測到 getAuthToken 不受支援，正在為 Edge 瀏覽器降級使用 WebAuthFlow...');
          runWebAuthFlow(interactive).then(resolve).catch(reject);
        } else {
          log.error('GoogleSync', '取得 Token 失敗:', errMsg);
          reject(new Error(errMsg));
        }
      } else if (!token) {
        log.error('GoogleSync', '未取得授權 Token');
        reject(new Error('未取得授權 Token'));
      } else {
        log.info('GoogleSync', '成功取得授權 Token (getAuthToken)');
        resolve(token);
      }
    });
  });
}

/**
 * 移除已失效的 Token 快取，以便重新授權
 * @param {string} token 
 */
export function removeCachedAuthToken(token) {
  return new Promise((resolve) => {
    chrome.identity.removeCachedAuthToken({ token }, () => {
      log.info('GoogleSync', '已清除快取的 Token');
      resolve();
    });
  });
}

/**
 * 搜尋 AppData 中的同步檔案
 * @param {string} token 
 * @returns {Promise<string|null>} 檔案 ID，不存在則回傳 null
 */
async function findSyncFile(token) {
  const url = `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=name='${SYNC_FILE_NAME}'&fields=files(id,name)`;
  const res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${token}`
    }
  });

  if (!res.ok) {
    if (res.status === 401) {
      await removeCachedAuthToken(token);
    }
    throw new Error(`搜尋同步檔案失敗: ${res.statusText}`);
  }

  const data = await res.json();
  if (data.files && data.files.length > 0) {
    return data.files[0].id;
  }
  return null;
}

/**
 * 下載同步檔案內容
 * @param {string} token 
 * @param {string} fileId 
 */
async function downloadSyncFile(token, fileId) {
  const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
  const res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${token}`
    }
  });

  if (!res.ok) {
    throw new Error(`下載同步檔案失敗: ${res.statusText}`);
  }

  return await res.json();
}

/**
 * 上傳/新建同步檔案
 * @param {string} token 
 * @param {object} contentData 
 */
async function createSyncFile(token, contentData) {
  const metadata = {
    name: SYNC_FILE_NAME,
    parents: ['appDataFolder']
  };

  const boundary = '-------314159265358979323846';
  const delimiter = "\r\n--" + boundary + "\r\n";
  const closeDelim = "\r\n--" + boundary + "--";

  const body = delimiter +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    JSON.stringify(metadata) +
    delimiter +
    'Content-Type: application/json\r\n\r\n' +
    JSON.stringify(contentData) +
    closeDelim;

  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary=${boundary}`
    },
    body: body
  });

  if (!res.ok) {
    throw new Error(`新建雲端同步檔案失敗: ${res.statusText}`);
  }

  const result = await res.json();
  return result.id;
}

/**
 * 覆寫/更新現有的雲端檔案內容
 * @param {string} token 
 * @param {string} fileId 
 * @param {object} contentData 
 */
async function updateSyncFile(token, fileId, contentData) {
  const res = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(contentData)
  });

  if (!res.ok) {
    throw new Error(`更新雲端同步檔案失敗: ${res.statusText}`);
  }

  return await res.json();
}

/**
 * 合併術語清單
 * @param {Array} localTerms 
 * @param {Array} cloudTerms 
 */
function mergeGlossaryTerms(localTerms = [], cloudTerms = []) {
  const mergedMap = new Map();

  // 1. 先放雲端的
  cloudTerms.forEach(term => {
    mergedMap.set(term.ori, term);
  });

  // 2. 本地的覆蓋或加入，比對 createdAt 或 source
  localTerms.forEach(term => {
    const existing = mergedMap.get(term.ori);
    if (!existing) {
      mergedMap.set(term.ori, term);
    } else {
      const localTime = term.createdAt || 0;
      const cloudTime = existing.createdAt || 0;
      // 使用者手動設定的優先於 AI 學習；同等級則以時間新者優先
      if (term.source === 'user' && existing.source !== 'user') {
        mergedMap.set(term.ori, term);
      } else if (term.source === existing.source && localTime > cloudTime) {
        mergedMap.set(term.ori, term);
      }
    }
  });

  return Array.from(mergedMap.values());
}

/**
 * 執行雙向資料同步（拉取、合併、上傳）
 * @param {string} token Google 授權 Token
 */
export async function performBiDirectionalSync(token) {
  log.info('GoogleSync', '開始進行雙向資料同步...');
  
  // 1. 獲取本機所有相關資料
  const localStore = await chrome.storage.local.get(null);
  
  // 萃取設定檔
  const settingKeys = [
    'apiKey', 'translationMode', 'modelName', 'fallbackModelName', 
    'useFallbackModelOnBatchRetry', 'ocrBatchSize', 'requestDelay', 
    'imageMaxDimension', 'ocrModelName', 'customPrompt', 'customPromptOcr',
    'novelModelName', 'novelBatchSize', 'novelPrompt'
  ];
  
  const localSettings = {};
  settingKeys.forEach(k => {
    if (localStore[k] !== undefined) {
      localSettings[k] = localStore[k];
    }
  });
  
  const localSettingsTime = localStore[SETTINGS_LAST_MODIFIED_KEY] || 0;
  const localGlossaries = localStore[GLOSSARY_STORAGE_KEY] || {};

  // 2. 查詢雲端同步檔案
  let fileId = await findSyncFile(token);
  let cloudData = null;

  if (fileId) {
    log.info('GoogleSync', `找到雲端同步檔案，ID: ${fileId}，進行下載中...`);
    try {
      cloudData = await downloadSyncFile(token, fileId);
    } catch (err) {
      log.error('GoogleSync', '下載雲端檔案失敗，嘗試清除快取重新授權', err);
      await removeCachedAuthToken(token);
      throw err;
    }
  }

  let finalSettings = { ...localSettings };
  let finalGlossaries = { ...localGlossaries };
  let settingsUpdated = false;
  let glossariesUpdated = false;

  if (cloudData) {
    log.info('GoogleSync', '開始合併本機與雲端資料...');

    // 合併設定
    const cloudSettingsTime = cloudData.settingsLastModified || 0;
    if (cloudSettingsTime > localSettingsTime) {
      log.info('GoogleSync', '雲端設定較新，將覆蓋本機設定');
      finalSettings = { ...cloudData.settings };
      settingsUpdated = true;
    } else if (localSettingsTime > cloudSettingsTime) {
      log.info('GoogleSync', '本機設定較新，雲端設定將被更新');
      settingsUpdated = true; // 用於觸發雲端更新
    }

    // 合併詞彙庫 (Glossaries)
    const cloudGlossaries = cloudData.glossaries || {};
    
    // 合併所有漫畫項目
    const allMangaKeys = new Set([
      ...Object.keys(localGlossaries),
      ...Object.keys(cloudGlossaries)
    ]);

    allMangaKeys.forEach(mangaKey => {
      const localManga = localGlossaries[mangaKey];
      const cloudManga = cloudGlossaries[mangaKey];

      if (localManga && cloudManga) {
        // 兩邊都有，進行術語合併與 lastUsed 比對
        const mergedTerms = mergeGlossaryTerms(localManga.terms, cloudManga.terms);
        const newerLastUsed = Math.max(localManga.lastUsed || 0, cloudManga.lastUsed || 0);
        const displayName = (localManga.lastUsed || 0) >= (cloudManga.lastUsed || 0) 
          ? (localManga.displayName || cloudManga.displayName)
          : (cloudManga.displayName || localManga.displayName);

        finalGlossaries[mangaKey] = {
          displayName,
          lastUsed: newerLastUsed,
          terms: mergedTerms
        };
        glossariesUpdated = true;
      } else if (cloudManga) {
        // 只有雲端有，拉回本機
        finalGlossaries[mangaKey] = cloudManga;
        glossariesUpdated = true;
      } else if (localManga) {
        // 只有本機有，準備送上雲端
        finalGlossaries[mangaKey] = localManga;
        glossariesUpdated = true;
      }
    });

  } else {
    log.info('GoogleSync', '未找到雲端同步檔案，將直接上傳本機資料建立雲端備份。');
    settingsUpdated = true;
    glossariesUpdated = true;
  }

  // 3. 準備寫回本機與雲端
  const now = Date.now();
  const nextSettingsTime = Math.max(localSettingsTime, cloudData?.settingsLastModified || 0);

  // 寫入本機 Storage
  const updatePayload = {};
  if (settingsUpdated) {
    Object.assign(updatePayload, finalSettings);
  }
  updatePayload[GLOSSARY_STORAGE_KEY] = finalGlossaries;
  updatePayload[SYNC_LAST_TIME_KEY] = new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' });
  updatePayload[SYNC_STATUS_KEY] = '已與雲端同步';
  
  await chrome.storage.local.set(updatePayload);

  // 寫入雲端檔案
  const syncPayload = {
    settings: finalSettings,
    settingsLastModified: nextSettingsTime || now,
    glossaries: finalGlossaries,
    lastSyncTime: now
  };

  if (fileId) {
    await updateSyncFile(token, fileId, syncPayload);
    log.info('GoogleSync', '雲端同步檔案更新成功！');
  } else {
    fileId = await createSyncFile(token, syncPayload);
    log.info('GoogleSync', `新建雲端同步檔案成功！ID: ${fileId}`);
  }

  // 重新初始化 state 快取
  await state.init();
  
  // 廣播詞彙庫更新事件以重新整理設定畫面
  chrome.runtime.sendMessage({
    action: 'GLOSSARY_UPDATED',
    payload: { mangaKey: null }
  }).catch(() => {});

  return updatePayload[SYNC_LAST_TIME_KEY];
}
