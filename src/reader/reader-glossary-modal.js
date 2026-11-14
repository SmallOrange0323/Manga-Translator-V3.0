// 漫譯閱讀器詞庫管理彈窗與狀態模組

let getActiveMangaKey = () => null;

/**
 * 綁定語彙庫彈窗事件與初始化詞庫鍵值取得函式
 * @param {Function} [getMangaKey] - 回傳當前 activeMangaKey 的函式
 */
export function setupGlossaryModal(getMangaKey) {
    if (typeof getMangaKey === 'function') {
        getActiveMangaKey = getMangaKey;
    }

    const modal = document.getElementById('mt-glossary-modal');
    if (!modal) return;

    const closeBtn = modal.querySelector('.mt-modal-close');
    const cancelBtn = document.getElementById('mt-glossary-cancel');
    const saveBtn = document.getElementById('mt-glossary-save');
    const oriInput = document.getElementById('mt-glossary-ori');
    const transInput = document.getElementById('mt-glossary-trans');
    const backdrop = modal.querySelector('.mt-modal-backdrop');
    const badge = document.getElementById('glossary-info-badge');

    // 綁定頂部語彙庫徽章點擊開啟彈窗
    if (badge) {
        badge.onclick = () => {
            showGlossaryModal('', '');
        };
    }

    const closeModal = () => {
        modal.classList.remove('show');
        setTimeout(() => {
            oriInput.value = '';
            transInput.value = '';
            saveBtn.disabled = false;
            saveBtn.textContent = '儲存條目';
        }, 300);
    };

    closeBtn.onclick = closeModal;
    cancelBtn.onclick = closeModal;
    backdrop.onclick = closeModal;

    saveBtn.onclick = async () => {
        const ori = oriInput.value.trim();
        const trans = transInput.value.trim();

        if (!ori || !trans) {
            alert('請填寫原文與譯文');
            return;
        }

        const activeMangaKey = getActiveMangaKey();
        if (!activeMangaKey) {
            alert('無法識別作品，無法儲存至語彙庫');
            return;
        }

        saveBtn.disabled = true;
        saveBtn.textContent = '儲存中...';

        let displayName = '';
        try {
            const detailResp = await new Promise(resolve =>
                chrome.runtime.sendMessage({ action: 'getGlossaryDetail', mangaKey: activeMangaKey }, resolve)
            );
            displayName = detailResp?.entry?.displayName || activeMangaKey;
        } catch (_) {
            displayName = activeMangaKey;
        }

        chrome.runtime.sendMessage({
            action: 'saveGlossaryTerm',
            mangaKey: activeMangaKey,
            displayName: displayName,
            ori: ori,
            trans: trans
        }, (response) => {
            saveBtn.disabled = false;
            saveBtn.textContent = '儲存條目';

            if (response && response.success) {
                // 清空輸入框並即時刷新彈窗清單與頂部 Badge
                oriInput.value = '';
                transInput.value = '';
                loadGlossaryTermsIntoModal(activeMangaKey);
                if (badge && response.count !== undefined) {
                    badge.textContent = `冊 語彙庫 ${response.count} 詞`;
                    badge.style.display = 'inline-flex';
                    badge.classList.add('show');
                }
            } else {
                alert('儲存失敗: ' + (response?.error || '未知錯誤'));
            }
        });
    };
}

/**
 * 載入當前作品的全部收錄詞彙至彈窗清單中
 * @param {string|null} [mangaKey] - 指定作品鍵值，預設使用目前作用中的鍵值
 */
export function loadGlossaryTermsIntoModal(mangaKey = getActiveMangaKey()) {
    const listEl = document.getElementById('mt-glossary-terms-list');
    const countEl = document.getElementById('mt-glossary-terms-count');
    const badge = document.getElementById('glossary-info-badge');
    const oriInput = document.getElementById('mt-glossary-ori');
    const transInput = document.getElementById('mt-glossary-trans');

    if (!listEl || !mangaKey) {
        if (listEl) listEl.innerHTML = '<div class="mt-glossary-empty-hint">尚未辨識到作品或無詞彙</div>';
        return;
    }

    chrome.runtime.sendMessage({ action: "getGlossaryDetail", mangaKey }, (res) => {
        const terms = res?.entry?.terms || [];
        if (countEl) countEl.textContent = `${terms.length} 詞`;
        if (badge) {
            badge.textContent = `冊 語彙庫 ${terms.length} 詞`;
            badge.style.display = 'inline-flex';
            badge.classList.add('show');
        }

        if (terms.length === 0) {
            listEl.innerHTML = '<div class="mt-glossary-empty-hint">尚未收錄專屬術語，可於上方手動新增</div>';
            return;
        }

        listEl.innerHTML = '';
        terms.forEach((item) => {
            const row = document.createElement('div');
            row.className = 'mt-glossary-term-item';

            const info = document.createElement('div');
            info.className = 'mt-term-info';

            const oriSpan = document.createElement('span');
            oriSpan.className = 'mt-term-ori';
            oriSpan.textContent = item.ori;
            oriSpan.title = item.ori;

            const arrowSpan = document.createElement('span');
            arrowSpan.className = 'mt-term-arrow';
            arrowSpan.textContent = '➔';

            const transSpan = document.createElement('span');
            transSpan.className = 'mt-term-trans';
            transSpan.textContent = item.trans;
            transSpan.title = item.trans;

            info.appendChild(oriSpan);
            info.appendChild(arrowSpan);
            info.appendChild(transSpan);

            const actions = document.createElement('div');
            actions.className = 'mt-term-actions';

            // 編輯按鈕：直接帶入上方表單，一鍵覆蓋
            const editBtn = document.createElement('button');
            editBtn.className = 'mt-term-btn mt-term-btn-edit';
            editBtn.textContent = '編輯';
            editBtn.onclick = () => {
                if (oriInput) oriInput.value = item.ori;
                if (transInput) {
                    transInput.value = item.trans;
                    transInput.focus();
                }
            };

            // 刪除按鈕
            const delBtn = document.createElement('button');
            delBtn.className = 'mt-term-btn mt-term-btn-del';
            delBtn.textContent = '刪除';
            delBtn.onclick = () => {
                if (!confirm(`確定要從語彙庫中刪除「${item.ori} ➔ ${item.trans}」嗎？`)) return;
                chrome.runtime.sendMessage({
                    action: 'deleteGlossaryTerm',
                    mangaKey,
                    ori: item.ori
                }, (delRes) => {
                    if (delRes && delRes.success) {
                        loadGlossaryTermsIntoModal(mangaKey);
                    } else {
                        alert('刪除失敗: ' + (delRes?.error || '未知錯誤'));
                    }
                });
            };

            actions.appendChild(editBtn);
            actions.appendChild(delBtn);

            row.appendChild(info);
            row.appendChild(actions);
            listEl.appendChild(row);
        });
    });
}

/**
 * 開啟語彙庫彈窗並預填原文與譯文
 * @param {string} ori - 原文
 * @param {string} trans - 譯文
 * @param {string|null} [mangaKey] - 指定作品鍵值
 */
export function showGlossaryModal(ori, trans, mangaKey = getActiveMangaKey()) {
    const modal = document.getElementById('mt-glossary-modal');
    if (!modal) return;

    const oriInput = document.getElementById('mt-glossary-ori');
    const transInput = document.getElementById('mt-glossary-trans');

    oriInput.value = ori || '';
    transInput.value = trans || '';

    // 即時加載當前作品詞彙清單
    loadGlossaryTermsIntoModal(mangaKey);

    modal.classList.add('show');
    if (trans) {
        transInput.focus();
    } else {
        oriInput.focus();
    }
}

/**
 * 重新查詢並更新頂部語彙庫狀態徽章
 * @param {string|null} [mangaKey] - 指定作品鍵值
 */
export function refreshGlossaryStatus(mangaKey = getActiveMangaKey()) {
    if (!mangaKey) return;
    chrome.runtime.sendMessage({ action: "getGlossaryDetail", mangaKey }, (glossaryResp) => {
        if (glossaryResp && glossaryResp.entry) {
            const badge = document.getElementById('glossary-info-badge');
            if (badge) {
                badge.textContent = `已套用語彙庫: ${glossaryResp.entry.displayName} (${glossaryResp.entry.terms?.length || 0} 詞)`;
                badge.classList.add('show');

                // 簡單的更新動畫
                badge.style.transform = 'scale(1.1)';
                setTimeout(() => { badge.style.transform = 'scale(1)'; }, 200);
            }
        }
    });
}
