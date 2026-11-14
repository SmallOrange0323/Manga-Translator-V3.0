import { state } from '../utils/state.js';
import { RUNNING_ANIMS, STANDING_ASSETS, PRICONNE_LOADING_SPRITES } from '../utils/constants.js';

/**
 * 依當前主題隨機選取一張立繪作為側邊欄背景
 * @param {string} currentTheme 當前主題名稱（'umamusume' 或 'priconne'）
 */
export function setRandomBackground(currentTheme) {
    const bgImg = document.getElementById('mt-sidebar-bg');
    if (!bgImg) return;
    if (currentTheme === 'priconne') {
        const list = STANDING_ASSETS.priconne;
        const file = list[Math.floor(Math.random() * list.length)];
        bgImg.src = chrome.runtime.getURL(`assets/standing_priconne/${file}`);
    } else {
        const list = STANDING_ASSETS.umamusume;
        const file = list[Math.floor(Math.random() * list.length)];
        bgImg.src = chrome.runtime.getURL(`assets/standing/${file}`);
    }
}

/**
 * 依當前主題設定 Loading 動畫
 * 馬娘：隨機跑步 webp（<img> src）；公連：隨機 sprite 分格動畫（CSS background + <div>）
 * @param {string} currentTheme 當前主題名稱（'umamusume' 或 'priconne'）
 */
export function setThemeLoading(currentTheme) {
    const loadingImg = document.getElementById('mt-loading-gif');
    if (!loadingImg) return;

    if (currentTheme === 'priconne') {
        const sprite = PRICONNE_LOADING_SPRITES[Math.floor(Math.random() * PRICONNE_LOADING_SPRITES.length)];
        const url = chrome.runtime.getURL(`assets/loading_priconne/${sprite.file}`);
        const frameH = 128; // 每幀高度 (px)，sprite 為垂直分格

        // <img> 不支援 background-image sprite，改為 <div> 替換
        const spriteDiv = document.createElement('div');
        spriteDiv.id = 'mt-loading-gif';
        spriteDiv.style.cssText = `
            width: 96px; height: ${frameH}px;
            background: url('${url}') no-repeat 0 0;
            background-size: 100% auto;
            image-rendering: pixelated;
            --frames: ${sprite.frames};
            animation: priconne-sprite-anim ${(sprite.frames * 0.08).toFixed(2)}s steps(${sprite.frames}) infinite;
        `;
        loadingImg.replaceWith(spriteDiv);
    } else {
        // 確保元素是 <img>（防止公連切換回馬娘時仍是 <div>）
        if (loadingImg.tagName !== 'IMG') {
            const img = document.createElement('img');
            img.id = 'mt-loading-gif';
            img.alt = 'Loading...';
            loadingImg.replaceWith(img);
        }
        const imgEl = document.getElementById('mt-loading-gif');
        imgEl.style.cssText = 'width: 120px; height: auto; border-radius: 50%; box-shadow: 0 4px 15px rgba(0,0,0,0.1);';
        imgEl.src = chrome.runtime.getURL(`assets/running/${RUNNING_ANIMS[Math.floor(Math.random() * RUNNING_ANIMS.length)]}`);
    }
}

/**
 * 初始化主題狀態與切換按鈕事件
 * @returns {{ getCurrentTheme: () => string }}
 */
export function initThemeController() {
    let currentTheme = 'umamusume';
    const themeToggle = document.getElementById('mt-theme-toggle');
    const body = document.body;

    // 初始化主題
    state.get('theme', 'theme-umamusume').then(theme => {
        currentTheme = theme.replace('theme-', '');
        body.className = theme;
        setRandomBackground(currentTheme);
        setThemeLoading(currentTheme);
    });

    // 主題切換邏輯
    if (themeToggle) {
        themeToggle.onclick = async () => {
            const currentBodyTheme = body.className;
            const nextBodyTheme = currentBodyTheme === 'theme-umamusume' ? 'theme-priconne' : 'theme-umamusume';
            body.className = nextBodyTheme;
            currentTheme = nextBodyTheme.replace('theme-', '');
            await state.set('theme', nextBodyTheme);
            setRandomBackground(currentTheme);   // 切換立繪
            setThemeLoading(currentTheme);       // 切換 Loading 動畫
            // 同步廣播給結果頁 (需去掉 'theme-' 前綴，否則 result.js 會套用 'theme-theme-xxx')
            chrome.storage.local.set({ mt_theme: currentTheme });
            console.log('[Sidepanel] Theme switched to:', nextBodyTheme);
        };
    }

    return {
        getCurrentTheme: () => currentTheme
    };
}

/**
 * 更新 API 配額顯示條與百分比文字
 */
export async function updateQuotaUI() {
    const count = await state.get('usageCount', 0);

    // 從 StateManager (chrome.storage.local) 讀取 apiKey，以精準統計多 API Key 的數量
    const apiKeyRaw = await state.get('apiKey', '');
    const keyCount = Math.max(
        (apiKeyRaw.split('\n').map(k => k.trim()).filter(k => k)).length,
        1
    );
    const total = keyCount * 500;
    const percent = Math.min(100, (count / total) * 100).toFixed(1);

    const countEl = document.getElementById('mt-quota-count');
    const fillEl = document.getElementById('mt-quota-bar-fill');
    if (countEl) countEl.textContent = `${count} / ${total} (${percent}%)`;
    if (fillEl) fillEl.style.width = `${percent}%`;
}

/**
 * 更新小說翻譯進度條與狀態標籤
 * @param {object|null} progress 進度物件（含 status, current, total）
 */
export function updateNovelStatus(progress) {
    const statusEl = document.getElementById('mt-novel-status');
    const progressContainer = document.getElementById('mt-novel-progress-container');
    const progressText = document.getElementById('mt-novel-progress-text');
    const progressFill = document.getElementById('mt-novel-progress-fill');

    if (progress && progress.status) {
        if (statusEl) {
            statusEl.style.display = 'inline';
            statusEl.textContent = '(小說中)';
        }

        if (progressContainer && progressText && progressFill) {
            progressContainer.style.display = 'block';
            progressText.textContent = progress.status;

            if (progress.current && progress.total) {
                const percent = Math.round((progress.current / progress.total) * 100);
                progressFill.style.width = `${percent}%`;
            }
        }
    } else {
        if (statusEl) statusEl.style.display = 'none';
        if (progressContainer) {
            progressContainer.style.display = 'none';
            if (progressFill) progressFill.style.width = '0%';
        }
    }
}

/**
 * 在結果容器顯示帶跑步動畫的「翻譯進行中」卡片
 * @param {HTMLElement} resultsContainer
 * @param {string} currentTheme
 * @param {number} imgCount
 */
export function renderTranslatingCard(resultsContainer, currentTheme, imgCount = 0) {
    if (!resultsContainer) return;
    resultsContainer.innerHTML = '';

    const card = document.createElement('div');
    card.id = 'mt-translating-card';
    card.style.cssText = `
        display: flex; flex-direction: column; align-items: center; justify-content: center;
        padding: 28px 16px; gap: 12px;
        background: rgba(255,255,255,0.6);
        border-radius: 12px; margin: 12px;
        border: 1px solid rgba(0,0,0,0.06);
        animation: fadeIn 0.3s ease;
    `;

    // 使用 createElement 建立圖片元素，避免 innerHTML 設定 style background url 時被 CSP 阻擋
    let animEl;
    if (currentTheme === 'priconne') {
        const sprite = PRICONNE_LOADING_SPRITES[Math.floor(Math.random() * PRICONNE_LOADING_SPRITES.length)];
        const url = chrome.runtime.getURL(`assets/loading_priconne/${sprite.file}`);
        animEl = document.createElement('img');
        animEl.src = url;
        animEl.alt = '翻譯中...';
        animEl.style.cssText = `
            width: 96px; height: auto;
            image-rendering: pixelated;
            margin: 0 auto;
        `;
    } else {
        const animUrl = chrome.runtime.getURL(`assets/running/${RUNNING_ANIMS[Math.floor(Math.random() * RUNNING_ANIMS.length)]}`);
        animEl = document.createElement('img');
        animEl.src = animUrl;
        animEl.alt = '翻譯中...';
        animEl.style.cssText = 'width:90px; height:auto; border-radius:50%; box-shadow: 0 4px 15px rgba(0,0,0,0.1);';
    }

    const textEl = document.createElement('div');
    textEl.style.cssText = 'font-size:13px; font-weight:600; color:#666; text-align:center;';
    textEl.innerHTML = `
        正在翻譯 ${imgCount} 張圖片...<br>
        <span style="font-size:11px; color:#999;">結果將顯示於新分頁</span>
    `;

    card.appendChild(animEl);
    card.appendChild(textEl);
    resultsContainer.appendChild(card);
}

/**
 * 移除「翻譯進行中」卡片
 */
export function removeTranslatingCard() {
    const old = document.getElementById('mt-translating-card');
    if (old) old.remove();
}

/**
 * 燈箱大圖檢視函式
 * @param {string} src 圖片來源 URL 或 Data URL
 */
export function showLightbox(src) {
    const box = document.createElement('div');
    box.id = 'mt-lightbox';
    box.style.cssText = 'position: fixed; inset: 0; background: rgba(0,0,0,0.85); display: flex; align-items: center; justify-content: center; z-index: 9999; cursor: zoom-out;';
    const img = document.createElement('img');
    img.src = src;
    img.style.cssText = 'max-width: 95vw; max-height: 95vh; object-fit: contain; border-radius: 4px; box-shadow: 0 8px 32px rgba(0,0,0,0.5);';
    box.appendChild(img);
    document.body.appendChild(box);

    const handleEsc = (e) => { if (e.key === 'Escape') closeLightbox(); };
    const closeLightbox = () => {
        box.remove();
        document.removeEventListener('keydown', handleEsc);
    };
    box.addEventListener('click', closeLightbox);
    document.addEventListener('keydown', handleEsc);
}

/**
 * 更新批次翻譯按鈕所選數量與全選/取消全選文字
 * @param {HTMLElement} resultsContainer
 */
export function updateBatchCountUI(resultsContainer) {
    if (!resultsContainer) return;
    const allCheckboxes = resultsContainer.querySelectorAll('.mt-preview-checkbox');
    const checked = Array.from(allCheckboxes).filter(cb => cb.checked).length;

    const transBtn = document.getElementById('mt-batch-trans-btn');
    if (transBtn) {
        transBtn.innerHTML = `翻譯所選 (${checked}張) · 開啟新分頁`;
    }

    const selectAllBtn = document.getElementById('mt-select-all-btn');
    if (selectAllBtn) {
        selectAllBtn.textContent = (checked === allCheckboxes.length && checked > 0) ? '取消全選' : '全選';
    }
}

/**
 * 初始化本地圖片上傳、拖放及預覽拖曳排序渲染
 * @param {object} options
 * @param {HTMLElement} options.resultsContainer
 * @param {HTMLElement|null} options.loadingOverlay
 * @param {() => Array} options.getCandidateImages
 * @param {(patch: { images?: Array, isLocal?: boolean, navLinks?: object }) => void} options.setCandidateState
 * @returns {{ renderPreviewList: () => void, handleFiles: (files: FileList) => void }}
 */
export function initPreviewAndUpload({ resultsContainer, loadingOverlay, getCandidateImages, setCandidateState }) {
    const uploadBtn = document.getElementById('mt-upload-btn');
    const fileInput = document.getElementById('mt-file-input');

    // 拖曳排序所需狀態變數
    let draggedItem = null;
    let draggedIndex = -1;
    let lastDragTarget = null;

    function renderPreviewList() {
        const candidateImages = getCandidateImages();
        resultsContainer.innerHTML = '';
        document.querySelector('.mt-main-actions').style.display = 'none';
        document.querySelector('.mt-batch-controls').style.display = 'block';

        const streamBtn = document.getElementById('mt-stream-read-btn');
        if (streamBtn) {
            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                const tab = tabs[0];
                const url = tab?.url || '';
                const isNE = url.includes('nhentai.net') || url.includes('e-hentai.org') || url.includes('exhentai.org');
                streamBtn.style.display = isNE ? 'flex' : 'none';
            });
        }

        const listContainer = document.createElement('div');
        listContainer.className = 'mt-preview-list';

        candidateImages.forEach((imgObj, index) => {
            const src = imgObj.src || imgObj;
            const item = document.createElement('div');
            item.className = 'mt-preview-item';
            item.setAttribute('draggable', true);
            item.dataset.index = index;

            // 拖曳把手
            const handle = document.createElement('div');
            handle.className = 'mt-preview-drag-handle';
            handle.innerHTML = '☰';
            handle.style.cssText = 'cursor: grab; padding: 0 6px; color: #aaa; font-size: 14px; user-select: none; flex-shrink: 0;';

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.className = 'mt-preview-checkbox';
            checkbox.checked = true;
            checkbox.dataset.index = index;

            const previewImg = document.createElement('img');
            previewImg.className = 'mt-preview-img';
            previewImg.src = src;
            previewImg.title = '點擊放大';
            previewImg.style.cursor = 'zoom-in';

            const info = document.createElement('div');
            info.className = 'mt-preview-info';
            info.style.cssText = 'font-size: 11px; padding-left: 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1;';
            // 顯示真實檔名（從 URL 解析）
            let filename = imgObj.name || `圖片 ${index + 1}`;
            if (!imgObj.name && !src.startsWith('data:')) try {
                const urlObj = new URL(src);
                const pathName = urlObj.pathname.split('/').pop();
                if (pathName && pathName.length > 1) filename = decodeURIComponent(pathName);
            } catch (e) {}
            info.textContent = filename;
            info.title = filename;

            item.appendChild(handle);
            item.appendChild(checkbox);
            item.appendChild(previewImg);
            item.appendChild(info);

            item.onclick = (e) => {
                if (e.target !== checkbox && e.target !== previewImg && !e.target.classList.contains('mt-preview-drag-handle')) {
                    checkbox.checked = !checkbox.checked;
                    updateBatchCountUI(resultsContainer);
                }
            };
            checkbox.onchange = () => updateBatchCountUI(resultsContainer);

            // 縮圖點擊 → 燈箱
            previewImg.addEventListener('click', (e) => {
                e.stopPropagation();
                showLightbox(src);
            });

            // 拖曳事件
            item.addEventListener('dragstart', (e) => {
                draggedItem = item;
                draggedIndex = index;
                lastDragTarget = null;
                e.dataTransfer.effectAllowed = 'move';
                setTimeout(() => item.classList.add('dragging'), 0);
            });
            item.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                const target = e.target.closest('.mt-preview-item');
                if (target === lastDragTarget) return;
                if (lastDragTarget) lastDragTarget.classList.remove('drag-over-top', 'drag-over-bottom');
                lastDragTarget = target;
                if (target && target !== draggedItem) {
                    const rect = target.getBoundingClientRect();
                    target.classList.add(e.clientY < rect.top + rect.height / 2 ? 'drag-over-top' : 'drag-over-bottom');
                }
            });
            item.addEventListener('drop', (e) => {
                e.stopPropagation();
                const target = e.target.closest('.mt-preview-item');
                if (!target || target === draggedItem) return;
                const targetIndex = parseInt(target.dataset.index);
                const rect = target.getBoundingClientRect();
                const insertBefore = e.clientY < rect.top + rect.height / 2;
                const movedItem = candidateImages.splice(draggedIndex, 1)[0];
                let newIndex = targetIndex;
                if (draggedIndex < targetIndex) newIndex = targetIndex - 1;
                if (!insertBefore) newIndex += 1;
                candidateImages.splice(newIndex, 0, movedItem);
                renderPreviewList();
            });
            item.addEventListener('dragend', () => {
                if (lastDragTarget) lastDragTarget.classList.remove('drag-over-top', 'drag-over-bottom');
                if (draggedItem) draggedItem.classList.remove('dragging');
                draggedItem = null;
                draggedIndex = -1;
                lastDragTarget = null;
            });

            listContainer.appendChild(item);
        });

        resultsContainer.appendChild(listContainer);
        updateBatchCountUI(resultsContainer);
    }

    function handleFiles(files) {
        if (!files || files.length === 0) return;

        if (loadingOverlay) loadingOverlay.style.display = 'flex';

        const fileArray = Array.from(files);
        const readPromises = fileArray.map(file => {
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = (ev) => resolve({ src: ev.target.result, name: file.name });
                reader.onerror = () => reject(new Error(`無法讀取圖片：${file.name}`));
                reader.onabort = () => reject(new Error(`圖片讀取已取消：${file.name}`));
                reader.readAsDataURL(file);
            });
        });

        Promise.all(readPromises).then(results => {
            if (loadingOverlay) loadingOverlay.style.display = 'none';

            // 將讀取的 base64 圖片加入候選清單
            setCandidateState({
                images: results.map(r => ({ ...r, id: crypto.randomUUID() })),
                isLocal: true,
                navLinks: { prev: null, next: null } // 本地上傳無導航
            });

            renderPreviewList();
            // 清空 input 讓同一個檔案可以重複選取
            if (fileInput) fileInput.value = '';
        }).catch(error => alert(error.message)).finally(() => {
            if (loadingOverlay) loadingOverlay.style.display = 'none';
            if (fileInput) fileInput.value = '';
        });
    }

    // 本地圖片上傳按鈕
    if (uploadBtn && fileInput) {
        uploadBtn.onclick = () => fileInput.click();
        fileInput.onchange = (e) => {
            handleFiles(e.target.files);
        };
    }

    // 拖放支援
    if (resultsContainer) {
        resultsContainer.addEventListener('dragover', (e) => {
            e.preventDefault();
            resultsContainer.style.background = 'rgba(106, 90, 211, 0.05)';
            resultsContainer.style.border = '2px dashed var(--theme-accent)';
        });

        resultsContainer.addEventListener('dragleave', () => {
            resultsContainer.style.background = '';
            resultsContainer.style.border = '';
        });

        resultsContainer.addEventListener('drop', (e) => {
            e.preventDefault();
            resultsContainer.style.background = '';
            resultsContainer.style.border = '';
            handleFiles(e.dataTransfer.files);
        });
    }

    return {
        renderPreviewList,
        handleFiles
    };
}

/**
 * 初始化小說模式、全域詞彙庫、連續追漫預翻及視覺情境錨點開關
 * @returns {{ updateNovelModeToggleForCurrentTab: () => Promise<void>, syncAutoPretranslateUI: () => Promise<void>, syncSceneContextUI: () => Promise<void> }}
 */
export function initSidepanelToggles() {
    const novelModeToggle = document.getElementById('mt-novel-mode-toggle');
    const globalGlossaryToggle = document.getElementById('mt-global-glossary-toggle');
    const novelRetryAllBtn = document.getElementById('mt-novel-retry-all-btn');
    const autoPretranslateToggle = document.getElementById('mt-auto-pretranslate-toggle');
    const autoPretranslateBatchChk = document.getElementById('mt-auto-pretranslate-batch-chk');
    const sceneContextToggle = document.getElementById('mt-scene-context-toggle');

    // 分頁個別綁定 (Tab-Bound) 輔助函式：根據當前活躍分頁同步 toggle UI
    async function updateNovelModeToggleForCurrentTab() {
        if (!novelModeToggle) return;
        chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
            if (!tabs[0]) return;
            const tabId = tabs[0].id;
            const novelModeTabs = await state.get('novelModeTabs', {});
            const isEnabled = !!novelModeTabs[tabId];
            novelModeToggle.checked = isEnabled;
            if (novelRetryAllBtn) {
                novelRetryAllBtn.style.display = isEnabled ? 'inline-block' : 'none';
            }
        });
    }

    if (novelModeToggle) {
        // 1. 初始化載入時同步當前活躍分頁狀態
        updateNovelModeToggleForCurrentTab();

        // 2. 監聽當前分頁切換與更新事件，自動同步 toggle UI
        chrome.tabs.onActivated.addListener(updateNovelModeToggleForCurrentTab);
        chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
            if (changeInfo.status === 'complete') {
                updateNovelModeToggleForCurrentTab();
            }
        });

        // 3. toggle UI 變更事件處理
        novelModeToggle.addEventListener('change', async () => {
            const isEnabled = novelModeToggle.checked;
            if (novelRetryAllBtn) {
                novelRetryAllBtn.style.display = isEnabled ? 'inline-block' : 'none';
            }

            chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
                if (!tabs[0]) return;
                const tabId = tabs[0].id;

                // 原子化寫入 novelModeTabs[tabId]
                await state.update('novelModeTabs', (current = {}) => {
                    const next = { ...current };
                    if (isEnabled) {
                        let origin = true;
                        try {
                            if (tabs[0].url) {
                                origin = new URL(tabs[0].url).origin;
                            }
                        } catch (e) {
                            console.error('[Sidepanel] 無法解析當前分頁 URL 網域:', e);
                        }
                        next[tabId] = origin;
                    } else {
                        delete next[tabId]; // 設為 false 時可直接 delete，省空間
                    }
                    return next;
                });
                console.log(`[Sidepanel] 分頁 ${tabId} 小說模式:`, isEnabled ? '開啟' : '關閉');

                // 對齊 v1.8.7：切換開關即觸發或停止翻譯
                if (isEnabled) {
                    chrome.runtime.sendMessage({ action: 'prepareTab', tabId }, (prep) => {
                        if (!prep || !prep.ready) {
                            alert('網頁環境啟動失敗，請重新整理網頁。');
                            novelModeToggle.checked = false;
                            state.update('novelModeTabs', (current = {}) => {
                                const next = { ...current };
                                delete next[tabId];
                                return next;
                            });
                            return;
                        }
                        chrome.tabs.sendMessage(tabId, { action: 'translateNovelPage' });
                    });
                } else {
                    chrome.runtime.sendMessage({ action: 'abortNovelTranslation', tabId });
                }
            });
        });
    }

    if (globalGlossaryToggle) {
        state.get('globalGlossaryEnabled', true).then(val => {
            globalGlossaryToggle.checked = (val !== false);
        });
        globalGlossaryToggle.addEventListener('change', async () => {
            await state.set('globalGlossaryEnabled', globalGlossaryToggle.checked);
            console.log('[Sidepanel] 詞彙庫:', globalGlossaryToggle.checked ? '啟用' : '停用');
        });
    }

    // ── 連續追漫 (自動預翻下一話) 開關綁定 ──
    async function syncAutoPretranslateUI() {
        const isEnabled = await state.get('autoPretranslateNextChapter', true);
        if (autoPretranslateToggle) autoPretranslateToggle.checked = (isEnabled !== false);
        if (autoPretranslateBatchChk) autoPretranslateBatchChk.checked = (isEnabled !== false);
    }

    if (autoPretranslateToggle) {
        syncAutoPretranslateUI();
        autoPretranslateToggle.addEventListener('change', async () => {
            const val = autoPretranslateToggle.checked;
            await state.set('autoPretranslateNextChapter', val);
            if (autoPretranslateBatchChk) autoPretranslateBatchChk.checked = val;
            console.log('[Sidepanel] 連續追漫 (自動預翻下一話):', val ? '啟用' : '停用');
        });
    }

    if (autoPretranslateBatchChk) {
        autoPretranslateBatchChk.addEventListener('change', async () => {
            const val = autoPretranslateBatchChk.checked;
            await state.set('autoPretranslateNextChapter', val);
            if (autoPretranslateToggle) autoPretranslateToggle.checked = val;
            console.log('[Sidepanel] 批次控制區連續追漫:', val ? '啟用' : '停用');
        });
    }

    // ── 視覺情境錨點 (sceneContext) 開關綁定 ──
    async function syncSceneContextUI() {
        const isEnabled = await state.get('enableSceneContext', true);
        if (sceneContextToggle) sceneContextToggle.checked = (isEnabled !== false);
    }

    if (sceneContextToggle) {
        syncSceneContextUI();
        sceneContextToggle.addEventListener('change', async () => {
            const val = sceneContextToggle.checked;
            await state.set('enableSceneContext', val);
            console.log('[Sidepanel] 視覺情境錨點 (sceneContext):', val ? '啟用' : '停用');
        });
    }

    if (novelRetryAllBtn) {
        novelRetryAllBtn.onclick = () => {
            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                if (!tabs[0]) return;
                const tabId = tabs[0].id;
                chrome.tabs.sendMessage(tabId, { action: 'retryAllFailed' });
                console.log('[Sidepanel] 已發送重試所有失敗小說段落訊息給 tab:', tabId);
            });
        };
    }

    return {
        updateNovelModeToggleForCurrentTab,
        syncAutoPretranslateUI,
        syncSceneContextUI
    };
}
