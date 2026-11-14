import { extractMangaTitle } from '../utils/manga-utils.js';
import { getGlossarySnapshot } from '../background/glossary-manager.js';

/**
 * 初始化側邊欄詞庫狀態列與手動選取管理模組
 * @param {object} options
 * @param {(mangaKey: string|null) => void} [options.onMangaKeyChange] 當當前作品鍵值變動時的回呼
 */
export function initGlossaryModule({ onMangaKeyChange } = {}) {
    // 詞庫狀態列相關元素
    const glossaryBar = document.getElementById('mt-glossary-bar');
    const glossaryNameEl = document.getElementById('mt-glossary-name');
    const glossaryCountEl = document.getElementById('mt-glossary-count');
    const manageBtn = document.getElementById('mt-manage-glossary-btn');

    // 手動選取詞庫相關元素
    const glossaryInfoGroup = document.getElementById('mt-glossary-info-group');
    const glossaryManualGroup = document.getElementById('mt-glossary-manual');
    const switchGlossaryBtn = document.getElementById('mt-switch-glossary-btn');
    const glossarySelect = document.getElementById('mt-glossary-select');
    const glossaryManualCountEl = document.getElementById('mt-glossary-manual-count');

    let currentMangaKey = null;
    let isManualGlossary = false; // 是否處於手動選擇狀態

    const setMangaKey = (nextKey) => {
        currentMangaKey = nextKey;
        if (typeof onMangaKeyChange === 'function') {
            onMangaKeyChange(nextKey);
        }
    };

    /**
     * 刷新側邊欄的作品詞庫狀態
     */
    async function refreshGlossaryStatus() {
        if (isManualGlossary) return; // 手動模式下不自動更新
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

            if (glossaryBar) glossaryBar.style.display = 'flex'; // 永遠顯示狀態列，讓使用者能點擊手動選取

            if (!tab || !tab.title) {
                setMangaKey(null);
                if (glossaryNameEl) {
                    glossaryNameEl.textContent = '未偵測到作品';
                    glossaryNameEl.title = '未偵測到作品';
                }
                if (glossaryCountEl) glossaryCountEl.textContent = '0 詞';
                return;
            }

            // 如果目前分頁是結果頁或是擴充功能的頁面，就維持原本的狀態，不要重新偵測
            if (tab.url && tab.url.startsWith('chrome-extension://')) {
                return;
            }

            const titleResult = extractMangaTitle(tab.title);
            if (!titleResult || !titleResult.romanKey) {
                setMangaKey(null);
                if (glossaryNameEl) {
                    glossaryNameEl.textContent = '未偵測到作品';
                    glossaryNameEl.title = '未偵測到作品';
                }
                if (glossaryCountEl) glossaryCountEl.textContent = '0 詞';
                return;
            }

            setMangaKey(titleResult.romanKey);
            const displayName = titleResult.displayName || titleResult.romanKey;

            // 讀取詞庫狀態
            const { glossaries: all = {} } = await getGlossarySnapshot();
            const entry = all[currentMangaKey];

            if (glossaryNameEl) {
                glossaryNameEl.textContent = displayName;
                glossaryNameEl.title = displayName;
            }

            const count = entry && entry.terms ? entry.terms.length : 0;
            if (glossaryCountEl) glossaryCountEl.textContent = `${count} 詞`;
        } catch (err) {
            console.warn('[Sidepanel] Failed to refresh glossary:', err);
        }
    }

    /**
     * 填充手動選取詞庫下拉選單
     */
    async function populateGlossaryDropdown() {
        if (!glossarySelect) return;
        try {
            const { glossaries: all = {} } = await getGlossarySnapshot();

            const keys = Object.keys(all).sort((a, b) => {
                const timeA = all[a].lastUsed || 0;
                const timeB = all[b].lastUsed || 0;
                return timeB - timeA;
            });

            glossarySelect.innerHTML = '<option value="">-- 手動選擇詞庫 --</option>';
            let matchedEntry = null;

            keys.forEach(key => {
                const entry = all[key];
                const termCount = Array.isArray(entry.terms) ? entry.terms.length : 0;
                const opt = document.createElement('option');
                opt.value = key;
                opt.textContent = `${entry.displayName || key} (${termCount} 詞)`;
                if (key === currentMangaKey) {
                    opt.selected = true;
                    matchedEntry = entry;
                }
                glossarySelect.appendChild(opt);
            });

            // 更新手動詞彙數量標籤
            if (glossaryManualCountEl) {
                if (matchedEntry) {
                    const count = Array.isArray(matchedEntry.terms) ? matchedEntry.terms.length : 0;
                    glossaryManualCountEl.textContent = `${count} 詞`;
                    glossaryManualCountEl.style.display = 'inline-block';
                } else {
                    glossaryManualCountEl.style.display = 'none';
                }
            }
        } catch (err) {
            console.warn('[Sidepanel] Failed to populate dropdown:', err);
        }
    }

    // 監聽 Background 發送的詞庫更新通知
    chrome.runtime.onMessage.addListener((msg) => {
        if (msg.action === 'GLOSSARY_UPDATED') {
            if (!isManualGlossary && msg.payload.mangaKey === currentMangaKey && glossaryCountEl) {
                glossaryCountEl.textContent = `${msg.payload.termCount} 詞`;
            }
            // 若下拉選單開啟中，重新填充
            if (isManualGlossary) {
                populateGlossaryDropdown();
            }
        }
    });

    // 監聽 Tab 切換
    chrome.tabs.onActivated.addListener(() => {
        // 稍微延遲確保 tab 資訊已更新
        setTimeout(refreshGlossaryStatus, 300);
    });

    // 手動選取切換
    if (switchGlossaryBtn) {
        switchGlossaryBtn.onclick = () => {
            isManualGlossary = !isManualGlossary;
            if (isManualGlossary) {
                if (glossaryInfoGroup) glossaryInfoGroup.style.display = 'none';
                if (glossaryManualGroup) glossaryManualGroup.style.display = 'flex';
                switchGlossaryBtn.textContent = '取消手動';
                populateGlossaryDropdown();
            } else {
                if (glossaryInfoGroup) glossaryInfoGroup.style.display = 'flex';
                if (glossaryManualGroup) glossaryManualGroup.style.display = 'none';
                switchGlossaryBtn.textContent = '手動選取';
                refreshGlossaryStatus(); // 恢復自動偵測狀態
            }
        };
    }

    // 手動選取變更
    if (glossarySelect) {
        glossarySelect.onchange = async () => {
            if (glossarySelect.value) {
                setMangaKey(glossarySelect.value);
                console.log('[Sidepanel] 手動切換詞庫至:', currentMangaKey);

                const { glossaries: all = {} } = await getGlossarySnapshot();
                const entry = all[currentMangaKey];
                const count = entry && Array.isArray(entry.terms) ? entry.terms.length : 0;

                if (glossaryManualCountEl) {
                    glossaryManualCountEl.textContent = `${count} 詞`;
                    glossaryManualCountEl.style.display = 'inline-block';
                }
            } else if (glossaryManualCountEl) {
                glossaryManualCountEl.style.display = 'none';
            }
        };
    }

    // 管理按鈕：打開選項頁並定位到詞庫區塊 (未來可強化定位)
    if (manageBtn) {
        manageBtn.onclick = () => {
            chrome.runtime.openOptionsPage();
        };
    }

    return {
        refreshGlossaryStatus,
        populateGlossaryDropdown,
        getCurrentMangaKey: () => currentMangaKey
    };
}
