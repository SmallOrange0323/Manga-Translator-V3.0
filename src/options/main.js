// src/options/main.js
import { state } from '../utils/state.js';
import { loadGlossary, saveGlossary, GLOSSARY_STORAGE_KEY } from '../background/glossary-manager.js';
import * as Constants from '../utils/constants.js';
import { getAuthToken, performBiDirectionalSync } from '../utils/sync.js';

let currentSelectedMangaKey = null;
const MAX_KEYS = 10;

/**
 * 初始化選項頁面邏輯
 */
document.addEventListener('DOMContentLoaded', async () => {
    console.log('[漫譯 V3.0] 選項頁面初始化中...');
    
    try {
        // 1. 初始化 State
        await state.init();

        // 2. Tab 切換邏輯
        setupTabs();

        // 3. 載入並初始化各項設定
        await initGeneralSettings();
        await initApiKeyManager();
        await initNovelSettings();
        await initGoogleSyncSettings();
        
        // 4. 註冊儲存與恢復按鈕事件
        setupEventHandlers();

        // 5. 監聽背景訊息
        chrome.runtime.onMessage.addListener((request) => {
            if (request.action === 'GLOSSARY_UPDATED') {
                if (currentSelectedMangaKey === request.payload.mangaKey) {
                    selectManga(request.payload.mangaKey).catch(console.error);
                }
                refreshGlossaryList().catch(console.error);
            }
        });

        console.log('[漫譯 V3.0] 選項頁面載入成功');
    } catch (e) {
        console.error('[漫譯 V3.0] 初始化失敗:', e);
    }
});

/**
 * 分頁切換功能
 */
function setupTabs() {
    const tabBtns = document.querySelectorAll('.tab-btn');
    const tabContents = document.querySelectorAll('.tab-content');

    function switchTab(tabId) {
        tabBtns.forEach(btn => btn.classList.toggle('active', btn.dataset.tab === tabId));
        tabContents.forEach(content => content.classList.toggle('active', content.id === `${tabId}-tab`));
        if (tabId === 'glossary') {
            refreshGlossaryList().catch(console.error);
        }
    }

    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const tabId = btn.dataset.tab;
            switchTab(tabId);
        });
    });
}

/**
 * 載入一般翻譯設定
 */
async function initGeneralSettings() {
    const fields = [
        ['translationMode', 'one-step'],
        ['ocrBatchSize', 5],
        ['modelName', 'gemini-1.5-flash'],
        ['fallbackModelName', ''],
        ['useFallbackModelOnBatchRetry', false],
        ['requestDelay', 4000],
        ['imageMaxDimension', 1024],
        ['ocrModelName', 'gemma-4-26b-a4b-it']
    ];

    for (const [id, def] of fields) {
        const el = document.getElementById(id);
        if (!el) continue;
        const val = await state.get(id, def);
        
        if (el.type === 'checkbox') {
            el.checked = !!val;
        } else if (el.tagName === 'SELECT' && val) {
            // 自癒邏輯：若儲存值不在目前的選項清單中，則動態建立一項，避免顯示空白
            if (!Array.from(el.options).some(o => o.value === val)) {
                const opt = document.createElement('option');
                opt.value = opt.textContent = val;
                el.appendChild(opt);
            }
            el.value = val;
        } else {
            el.value = val;
        }
    }

    // 載入黃金提示詞
    const customPrompt = await state.get('customPrompt', Constants.DEFAULT_PROMPT_ONE_STEP);
    const promptEl = document.getElementById('customPrompt');
    if (promptEl) promptEl.value = customPrompt;

    const ocrPrompt = await state.get('customPromptOcr', Constants.DEFAULT_PROMPT_OCR);
    const ocrPromptEl = document.getElementById('customPromptOcr');
    if (ocrPromptEl) ocrPromptEl.value = ocrPrompt;
}

/**
 * API Key 動態管理邏輯
 */
async function initApiKeyManager() {
    const apiKeysContainer = document.getElementById('apiKeysContainer');
    const addKeyBtn = document.getElementById('add-key-btn');
    if (!apiKeysContainer || !addKeyBtn) return;

    function createKeyRow(value = '', index) {
        const row = document.createElement('div');
        row.className = 'api-key-row';
        
        const input = document.createElement('input');
        input.type = 'password';
        input.className = 'api-key-input';
        input.placeholder = index === 0 ? '主要金鑰 (Key 1)' : `備用金鑰 (Key ${index + 1})`;
        input.value = value;

        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'remove-key-btn';
        removeBtn.textContent = '✕ 刪除';
        removeBtn.onclick = () => {
            row.remove();
            reindexKeys();
        };

        row.appendChild(input);
        row.appendChild(removeBtn);
        return row;
    }

    function reindexKeys() {
        const inputs = apiKeysContainer.querySelectorAll('.api-key-input');
        inputs.forEach((input, i) => {
            input.placeholder = i === 0 ? '主要金鑰 (Key 1)' : `備用金鑰 (Key ${i + 1})`;
        });
    }

    addKeyBtn.onclick = () => {
        const count = apiKeysContainer.querySelectorAll('.api-key-row').length;
        if (count >= MAX_KEYS) return alert(`最多支援 ${MAX_KEYS} 組金鑰`);
        apiKeysContainer.appendChild(createKeyRow('', count));
    };

    // 關鍵修正：從 state 獲取值
    const savedKeys = await state.get('apiKey', '');
    console.log('[Options] Loading saved API keys:', savedKeys ? 'Found' : 'Empty');
    
    apiKeysContainer.innerHTML = '';
    const keyArray = savedKeys.split('\n').map(k => k.trim()).filter(k => k);
    
    if (keyArray.length === 0) {
        apiKeysContainer.appendChild(createKeyRow('', 0));
    } else {
        keyArray.forEach((k, i) => apiKeysContainer.appendChild(createKeyRow(k, i)));
    }
}

/**
 * 載入小說模式設定
 */
async function initNovelSettings() {
    const novelModelNameEl = document.getElementById('novelModelName');
    if (novelModelNameEl) {
        const val = await state.get('novelModelName', 'gemini-1.5-flash');
        if (val) {
            // 自癒邏輯
            if (!Array.from(novelModelNameEl.options).some(o => o.value === val)) {
                const opt = document.createElement('option');
                opt.value = opt.textContent = val;
                novelModelNameEl.appendChild(opt);
            }
            novelModelNameEl.value = val;
        }
    }

    if (document.getElementById('novelBatchSize')) 
        document.getElementById('novelBatchSize').value = await state.get('novelBatchSize', 50);
    if (document.getElementById('novelPrompt')) 
        document.getElementById('novelPrompt').value = await state.get('novelPrompt', Constants.DEFAULT_PROMPT_NOVEL);
}

/**
 * 註冊按鈕事件
 */
function setupEventHandlers() {
    // 儲存漫畫設定
    const saveBtn = document.getElementById('saveBtn');
    if (saveBtn) {
        saveBtn.onclick = async () => {
            const apiKeysContainer = document.getElementById('apiKeysContainer');
            const keyInputs = apiKeysContainer.querySelectorAll('.api-key-input');
            const keys = Array.from(keyInputs).map(i => i.value.trim()).filter(k => k).join('\n');
            
            await state.set('apiKey', keys);
            await state.set('translationMode', document.getElementById('translationMode').value);
            await state.set('modelName', document.getElementById('modelName').value);
            await state.set('fallbackModelName', document.getElementById('fallbackModelName').value);
            await state.set('customPrompt', document.getElementById('customPrompt').value);
            
            const numFields = ['ocrBatchSize', 'requestDelay', 'imageMaxDimension'];
            for (const id of numFields) {
                const el = document.getElementById(id);
                if (el) await state.set(id, parseInt(el.value));
            }
            
            const ocrModelEl = document.getElementById('ocrModelName');
            if(ocrModelEl) await state.set('ocrModelName', ocrModelEl.value);

            const fallbackRetry = document.getElementById('useFallbackModelOnBatchRetry');
            if(fallbackRetry) await state.set('useFallbackModelOnBatchRetry', fallbackRetry.checked);

            const googleClientIdEl = document.getElementById('googleClientId');
            if (googleClientIdEl) {
                await state.set('googleClientId', googleClientIdEl.value.trim());
            }

            await state.set('settingsLastModified', Date.now());

            showStatus('status');
        };
    }

    // 儲存小說設定
    const saveNovelBtn = document.getElementById('saveNovelBtn');
    if (saveNovelBtn) {
        saveNovelBtn.onclick = async () => {
            await state.set('novelModelName', document.getElementById('novelModelName').value);
            await state.set('novelBatchSize', parseInt(document.getElementById('novelBatchSize').value));
            await state.set('novelPrompt', document.getElementById('novelPrompt').value);
            await state.set('settingsLastModified', Date.now());
            showStatus('novel-status');
        };
    }

    // 恢復漫畫預設提示詞
    const resetPromptBtn = document.getElementById('resetPromptBtn');
    if (resetPromptBtn) {
        resetPromptBtn.onclick = () => {
            const mode = document.getElementById('translationMode').value;
            const model = document.getElementById('modelName').value.toLowerCase();
            let prompt = Constants.DEFAULT_PROMPT_ONE_STEP;
            
            if (mode === 'two-step') {
                prompt = Constants.DEFAULT_PROMPT_TWO_STEP;
            } else if (model.includes('gemma')) {
                prompt = Constants.DEFAULT_PROMPT_GEMMA_ONE_STEP;
            }
            
            document.getElementById('customPrompt').value = prompt;
            alert('黃金提示詞已恢復！');
        };
    }

    // 恢復小說預設提示詞
    const resetNovelPromptBtn = document.getElementById('resetNovelPromptBtn');
    if (resetNovelPromptBtn) {
        resetNovelPromptBtn.onclick = () => {
            document.getElementById('novelPrompt').value = Constants.DEFAULT_PROMPT_NOVEL;
            alert('黃金小說提示詞已恢復！');
        };
    }

    // 從 Google 取得模型清單
    const fetchModelsBtn = document.getElementById('fetchModelsBtn');
    if (fetchModelsBtn) {
        fetchModelsBtn.onclick = async () => {
            const apiContainer = document.getElementById('apiKeysContainer');
            const firstKey = apiContainer?.querySelector('.api-key-input')?.value.trim();
            if (!firstKey) return alert('請先填寫至少一組 API Key');
            
            try {
                const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${firstKey}`);
                if (!res.ok) throw new Error('API Key 無效或網路錯誤');
                const data = await res.json();
                const validModels = data.models.filter(m => m.supportedGenerationMethods.includes('generateContent'));
                
                ['modelName', 'fallbackModelName', 'novelModelName', 'ocrModelName'].forEach(id => {
                    const el = document.getElementById(id);
                    if (!el) return;
                    const oldVal = el.value;
                    el.innerHTML = '';
                    validModels.forEach(m => {
                        const mid = m.name.replace('models/', '');
                        const opt = document.createElement('option');
                        opt.value = opt.textContent = mid;
                        el.appendChild(opt);
                    });
                    if (Array.from(el.options).some(o => o.value === oldVal)) el.value = oldVal;
                });
                alert('模型清單更新成功！');
            } catch (e) {
                alert('無法獲取模型: ' + e.message);
            }
        };
    }
}

function showStatus(id) {
    const status = document.getElementById(id);
    if (!status) return;
    status.style.display = 'block';
    setTimeout(() => { status.style.display = 'none'; }, 2000);
}

/**
 * 初始化 Google 雲端同步設定與事件監聽
 */
async function initGoogleSyncSettings() {
    const syncEnabledEl = document.getElementById('enableCloudSync');
    const syncStatusEl = document.getElementById('googleSyncStatus');
    const syncLastTimeEl = document.getElementById('googleSyncLastTime');
    const syncNowBtn = document.getElementById('googleSyncNowBtn');
    const syncSpinner = document.getElementById('googleSyncSpinner');
    const syncBtnText = document.getElementById('googleSyncBtnText');
    const redirectUriEl = document.getElementById('googleRedirectUri');
    const clientIdEl = document.getElementById('googleClientId');

    if (!syncEnabledEl || !syncStatusEl || !syncLastTimeEl || !syncNowBtn) return;

    // 動態填入 Redirect URI 以方便使用者在 GCP 設定中複製
    if (redirectUriEl) {
        redirectUriEl.textContent = chrome.identity.getRedirectURL();
    }

    // 載入自訂 Google Client ID
    if (clientIdEl) {
        const savedClientId = await state.get('googleClientId', '');
        clientIdEl.value = savedClientId;
        clientIdEl.addEventListener('change', async () => {
            await state.set('googleClientId', clientIdEl.value.trim());
        });
    }

    // 1. 從 state 載入目前的同步狀態
    const isEnabled = await state.get('enableCloudSync', false);
    const lastTime = await state.get('googleSyncLastTime', '無紀錄');
    const lastStatus = await state.get('googleSyncStatus', isEnabled ? '已與雲端同步' : '未啟用');

    syncEnabledEl.checked = isEnabled;
    syncStatusEl.textContent = lastStatus;
    syncLastTimeEl.textContent = lastTime;
    syncNowBtn.disabled = !isEnabled;

    // 2. 監聽開關狀態切換
    syncEnabledEl.addEventListener('change', async () => {
        const checked = syncEnabledEl.checked;
        if (checked) {
            // 啟用同步：進行首次授權與同步
            syncStatusEl.textContent = '正在取得 Google 授權...';
            syncNowBtn.disabled = true;
            
            try {
                const token = await getAuthToken(true);
                syncStatusEl.textContent = '首次同步中...';
                
                // 顯示載入動畫
                if (syncSpinner) syncSpinner.style.display = 'inline-block';
                if (syncBtnText) syncBtnText.textContent = ' 同步中...';

                const lastSyncStr = await performBiDirectionalSync(token);
                
                await state.set('enableCloudSync', true);
                await state.set('googleSyncStatus', '已與雲端同步');
                await state.set('googleSyncLastTime', lastSyncStr);

                syncStatusEl.textContent = '已與雲端同步';
                syncLastTimeEl.textContent = lastSyncStr;
                syncNowBtn.disabled = false;
                
                alert('🎉 Google 雲端同步已成功啟用並完成首次資料合併！');
                
                // 重新載入設定與詞彙表以確保顯示最新合併後的資料
                await initGeneralSettings();
                await initApiKeyManager();
                await initNovelSettings();
            } catch (err) {
                console.error('[GoogleSync] 啟用同步失敗:', err);
                syncEnabledEl.checked = false;
                syncStatusEl.textContent = '同步失敗';
                await state.set('enableCloudSync', false);
                await state.set('googleSyncStatus', '同步失敗');
                alert('❌ 啟用同步失敗: ' + err.message);
            } finally {
                if (syncSpinner) syncSpinner.style.display = 'none';
                if (syncBtnText) syncBtnText.textContent = '🔄 立即手動同步';
            }
        } else {
            // 停用同步
            await state.set('enableCloudSync', false);
            await state.set('googleSyncStatus', '未啟用');
            syncStatusEl.textContent = '未啟用';
            syncNowBtn.disabled = true;
            alert('ℹ️ Google 雲端同步已關閉。');
        }
    });

    // 3. 監聽立即手動同步按鈕
    syncNowBtn.addEventListener('click', async () => {
        syncNowBtn.disabled = true;
        if (syncSpinner) syncSpinner.style.display = 'inline-block';
        if (syncBtnText) syncBtnText.textContent = ' 同步中...';
        syncStatusEl.textContent = '雙向同步中...';

        try {
            // 先嘗試非互動式獲取 token，若失效則彈出互動視窗
            let token;
            try {
                token = await getAuthToken(false);
            } catch (e) {
                token = await getAuthToken(true);
            }

            const lastSyncStr = await performBiDirectionalSync(token);
            
            await state.set('googleSyncStatus', '已與雲端同步');
            await state.set('googleSyncLastTime', lastSyncStr);

            syncStatusEl.textContent = '已與雲端同步';
            syncLastTimeEl.textContent = lastSyncStr;
            
            // 重新載入設定與詞彙表以顯示最新資料
            await initGeneralSettings();
            await initApiKeyManager();
            await initNovelSettings();
            
            // 短暫提示成功
            const originalColor = syncStatusEl.style.color;
            syncStatusEl.style.color = '#4CAF50';
            setTimeout(() => { syncStatusEl.style.color = originalColor; }, 2000);
        } catch (err) {
            console.error('[GoogleSync] 手動同步失敗:', err);
            syncStatusEl.textContent = '同步失敗';
            await state.set('googleSyncStatus', '同步失敗');
            alert('❌ 同步失敗: ' + err.message);
        } finally {
            if (syncSpinner) syncSpinner.style.display = 'none';
            if (syncBtnText) syncBtnText.textContent = '🔄 立即手動同步';
            syncNowBtn.disabled = false;
        }
    });
}

// =====================================================================
// 詞彙庫管理邏輯 (Glossary Manager)
// =====================================================================

async function refreshGlossaryList() {
    const mangaListEl = document.getElementById('mangaList');
    if (!mangaListEl) return;

    try {
        const data = await chrome.storage.local.get([GLOSSARY_STORAGE_KEY]);
        const glossaries = data[GLOSSARY_STORAGE_KEY] || {};
        const keys = Object.keys(glossaries).sort((a, b) => (glossaries[b].lastUsed || 0) - (glossaries[a].lastUsed || 0));

        if (keys.length === 0) {
            mangaListEl.innerHTML = '<div class="empty-state">尚未建立任何詞彙庫</div>';
            return;
        }

        mangaListEl.innerHTML = '';
        keys.forEach(key => {
            const item = glossaries[key];
            const div = document.createElement('div');
            div.className = 'manga-item';
            div.dataset.key = key;
            if (key === currentSelectedMangaKey) div.classList.add('active');

            const nameDiv = document.createElement('div');
            nameDiv.textContent = item.displayName || key;
            
            const metaDiv = document.createElement('div');
            metaDiv.className = 'manga-meta';
            const termCount = item.terms ? item.terms.length : 0;
            metaDiv.textContent = `${termCount} 詞 | 最後使用: ${new Date(item.lastUsed).toLocaleDateString()}`;
            
            div.appendChild(nameDiv);
            div.appendChild(metaDiv);
            div.onclick = () => selectManga(key).catch(console.error);
            mangaListEl.appendChild(div);
        });

    } catch (e) {
        mangaListEl.innerHTML = `<div class="empty-state">載入失敗: ${e.message}</div>`;
    }
}

async function selectManga(mangaKey) {
    currentSelectedMangaKey = mangaKey;
    document.querySelectorAll('.manga-item').forEach(el => {
        el.classList.toggle('active', el.dataset.key === mangaKey);
    });

    const detailEl = document.getElementById('mangaDetail');
    if (!detailEl) return;

    const entry = await loadGlossary(mangaKey);
    renderGlossaryDetail(mangaKey, entry);
}

function renderGlossaryDetail(mangaKey, entry) {
    const detailEl = document.getElementById('mangaDetail');
    const termCount = entry.terms ? entry.terms.length : 0;

    detailEl.innerHTML = `
        <div class="detail-header">
            <div class="manga-title-edit-container">
                <input type="text" id="mangaDisplayNameInput" class="manga-title-edit" value="${entry.displayName || mangaKey}" title="點擊更改作品顯示名稱">
            </div>
            <div class="meta-info">標識碼: <code>${mangaKey}</code> | 累積術語: ${termCount} / 500</div>
            <div id="ai-loader-text" class="ai-loader-text" style="display:none; color: #4CAF50; font-weight:bold; margin-top:8px;">
                <span class="ai-loader"></span>背景 AI 正在萃取新術語...
            </div>
            <div style="margin-top: 12px; display: flex; gap: 10px;">
                <input type="text" id="termSearchInput" placeholder="🔍 搜尋原文或譯文..." style="flex: 1; padding: 10px; border: 1px solid var(--border-color); border-radius: 4px; font-size: 14px;">
            </div>
        </div>
        <table class="term-table">
            <thead>
                <tr>
                    <th style="width: 5%"><input type="checkbox" id="selectAllTerms"></th>
                    <th style="width: 35%">日文原文 (Original)</th>
                    <th style="width: 40%">中文譯文 (Translation)</th>
                    <th style="width: 20%">來源與操作</th>
                </tr>
            </thead>
            <tbody id="termTableBody"></tbody>
        </table>
        <div class="glossary-footer" style="display: flex; gap: 10px; margin-top:20px;">
            <button id="addTermBtn" class="btn-small">+ 手動新增術語</button>
            <button id="importTermBtn" class="btn-small">📥 匯入術語</button>
            <input type="file" id="glossaryFileInput" accept=".json" style="display: none;">
            <button id="batchDeleteTermBtn" class="btn-small btn-danger" style="display: none;">🗑️ 批次刪除</button>
            <button id="deleteGlossaryBtn" class="btn-small btn-danger" style="margin-left: auto;">🗑️ 刪除詞庫</button>
        </div>
    `;

    // 名稱編輯功能
    const nameInput = document.getElementById('mangaDisplayNameInput');
    nameInput?.addEventListener('change', async () => {
        const newName = nameInput.value.trim();
        if (newName && newName !== entry.displayName) {
            const data = await chrome.storage.local.get([GLOSSARY_STORAGE_KEY]);
            const all = data[GLOSSARY_STORAGE_KEY] || {};
            if(all[mangaKey]) {
                all[mangaKey].displayName = newName;
                await chrome.storage.local.set({ [GLOSSARY_STORAGE_KEY]: all });
                refreshGlossaryList();
            }
        }
    });

    const tbody = document.getElementById('termTableBody');
    if (!entry.terms || entry.terms.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" class="empty-state">此作品尚無術語</td></tr>';
    } else {
        entry.terms.forEach((term) => {
            const tr = document.createElement('tr');
            const isUser = term.source === 'user';
            tr.innerHTML = `
                <td><input type="checkbox" class="term-checkbox" data-ori="${term.ori}"></td>
                <td><input type="text" class="term-input" data-field="ori" value="${term.ori}" data-old-ori="${term.ori}"></td>
                <td><input type="text" class="term-input" data-field="trans" value="${term.trans}"></td>
                <td>
                    <div class="action-btns">
                        <span class="badge ${isUser ? 'badge-user' : 'badge-ai'}" title="${isUser ? '使用者手動修改' : 'AI 自動學習'}">${isUser ? '🔒' : '🤖'}</span>
                        <span class="save-tick" style="display:none; color:green; font-weight:bold; font-size:12px;">✅ 儲存</span>
                        <button class="btn-small btn-danger delete-term-btn">✕</button>
                    </div>
                </td>
            `;

            const oriInput = tr.querySelector('[data-field="ori"]');
            const transInput = tr.querySelector('[data-field="trans"]');

            const onFieldChange = async () => {
                const newOri = oriInput.value.trim();
                const newTrans = transInput.value.trim();
                const oldOri = oriInput.dataset.oldOri;
                if (!newOri || !newTrans) return;

                if (newOri !== oldOri || newTrans !== term.trans) {
                    const data = await chrome.storage.local.get([GLOSSARY_STORAGE_KEY]);
                    const all = data[GLOSSARY_STORAGE_KEY] || {};
                    if(all[mangaKey]) {
                        const t = all[mangaKey].terms.find(x => x.ori === oldOri);
                        if(t) {
                            t.ori = newOri;
                            t.trans = newTrans;
                            t.source = 'user';
                            await chrome.storage.local.set({ [GLOSSARY_STORAGE_KEY]: all });
                            
                            oriInput.dataset.oldOri = newOri;
                            const badge = tr.querySelector('.badge');
                            badge.className = 'badge badge-user';
                            badge.textContent = '🔒';
                            
                            const tick = tr.querySelector('.save-tick');
                            tick.style.display = 'inline-block';
                            setTimeout(()=> tick.style.display = 'none', 1500);
                        }
                    }
                }
            };
            oriInput.addEventListener('change', onFieldChange);
            transInput.addEventListener('change', onFieldChange);

            tr.querySelector('.delete-term-btn').onclick = async () => {
                if(!confirm(`確定刪除術語 '${term.ori}' ?`)) return;
                const data = await chrome.storage.local.get([GLOSSARY_STORAGE_KEY]);
                const all = data[GLOSSARY_STORAGE_KEY] || {};
                if(all[mangaKey]) {
                    all[mangaKey].terms = all[mangaKey].terms.filter(x => x.ori !== term.ori);
                    await chrome.storage.local.set({ [GLOSSARY_STORAGE_KEY]: all });
                    selectManga(mangaKey);
                }
            };
            
            tbody.appendChild(tr);
        });
    }

    // 全選與批次刪除功能
    const selectAllCheckbox = document.getElementById('selectAllTerms');
    const batchDeleteBtn = document.getElementById('batchDeleteTermBtn');
    
    const updateBatchBtnVisibility = () => {
        const checkedCount = tbody.querySelectorAll('.term-checkbox:checked').length;
        if (batchDeleteBtn) batchDeleteBtn.style.display = checkedCount > 0 ? 'inline-block' : 'none';
    };

    selectAllCheckbox?.addEventListener('change', (e) => {
        const checkboxes = tbody.querySelectorAll('.term-checkbox');
        checkboxes.forEach(cb => cb.checked = e.target.checked);
        updateBatchBtnVisibility();
    });

    tbody.addEventListener('change', (e) => {
        if (e.target.classList.contains('term-checkbox')) {
            updateBatchBtnVisibility();
            // 如果有一個沒選，取消全選
            const allCheckboxes = tbody.querySelectorAll('.term-checkbox');
            const allChecked = Array.from(allCheckboxes).every(cb => cb.checked);
            if (selectAllCheckbox) selectAllCheckbox.checked = allChecked;
        }
    });

    if (batchDeleteBtn) {
        batchDeleteBtn.onclick = async () => {
            const checkedCheckboxes = tbody.querySelectorAll('.term-checkbox:checked');
            const orisToDelete = Array.from(checkedCheckboxes).map(cb => cb.dataset.ori);
            
            if (orisToDelete.length === 0) return;
            
            if (!confirm(`確定要刪除選取的 ${orisToDelete.length} 筆術語嗎？`)) return;
            
            chrome.runtime.sendMessage({
                action: 'deleteMultipleGlossaryTerms',
                mangaKey: mangaKey,
                oris: orisToDelete
            }, (response) => {
                if (response && response.success) {
                    alert(`成功刪除 ${response.deletedCount} 筆術語！`);
                    selectManga(mangaKey);
                } else {
                    alert('刪除失敗: ' + (response?.error || '未知錯誤'));
                }
            });
        };
    }

    // 搜尋功能
    const searchInput = document.getElementById('termSearchInput');
    searchInput?.addEventListener('input', (e) => {
        const query = e.target.value.toLowerCase().trim();
        const rows = tbody.querySelectorAll('tr:not(.empty-state)');
        rows.forEach(row => {
            const ori = row.querySelector('[data-field="ori"]')?.value.toLowerCase() || '';
            const trans = row.querySelector('[data-field="trans"]')?.value.toLowerCase() || '';
            row.style.display = (ori.includes(query) || trans.includes(query)) ? '' : 'none';
        });
    });

    // 新增
    document.getElementById('addTermBtn').onclick = async () => {
        const ori = prompt('請輸入「日文原文」:');
        if(!ori) return;
        const trans = prompt('請輸入「中文譯名」:');
        if(!trans) return;

        const data = await chrome.storage.local.get([GLOSSARY_STORAGE_KEY]);
        const all = data[GLOSSARY_STORAGE_KEY] || {};
        if(all[mangaKey]) {
            if(all[mangaKey].terms.some(t => t.ori === ori)) return alert('該原文已存在！');
            all[mangaKey].terms.push({ ori: ori.trim(), trans: trans.trim(), source: 'user', createdAt: Date.now() });
            await chrome.storage.local.set({ [GLOSSARY_STORAGE_KEY]: all });
            selectManga(mangaKey);
        }
    };

    // 匯入
    document.getElementById('importTermBtn').onclick = () => {
        document.getElementById('glossaryFileInput').click();
    };

    document.getElementById('glossaryFileInput').onchange = (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (ev) => {
            try {
                const terms = JSON.parse(ev.target.result);
                if (!Array.isArray(terms)) {
                    alert('格式錯誤：JSON 必須是陣列格式！\n範例: [{"ori": "日文", "trans": "中文"}]');
                    return;
                }
                
                chrome.runtime.sendMessage({
                    action: 'importGlossaryTerms',
                    mangaKey: mangaKey,
                    terms: terms
                }, (response) => {
                    if (response && response.success) {
                        alert(`成功匯入 ${response.addedCount} 筆新術語！`);
                        selectManga(mangaKey);
                    } else {
                        alert('匯入失敗: ' + (response?.error || '未知錯誤'));
                    }
                });
            } catch (err) {
                alert('解析 JSON 失敗: ' + err.message);
            }
            // 清空讓同一個檔案可以重複選取
            e.target.value = '';
        };
        reader.readAsText(file);
    };

    // 刪除整部
    document.getElementById('deleteGlossaryBtn').onclick = async () => {
        if(!confirm(`確定要刪除「${entry.displayName || mangaKey}」詞庫嗎？此操作無法還原！`)) return;
        const data = await chrome.storage.local.get([GLOSSARY_STORAGE_KEY]);
        const all = data[GLOSSARY_STORAGE_KEY] || {};
        delete all[mangaKey];
        await chrome.storage.local.set({ [GLOSSARY_STORAGE_KEY]: all });
        detailEl.innerHTML = '<div class="empty-state">請由左側選擇作品</div>';
        refreshGlossaryList();
    };
}
