import { LOADING_GIF_FILENAME } from '../utils/constants.js';
import { createMangaImageReceiver } from '../utils/manga-image-messages.js';
import {
    sanitizeTranslationText,
    toLightweightRetryImageRef,
    applyTheme,
    initFontControls,
    initKeyboardCardNavigation,
    initModeToggleControls,
    initHeaderDropdowns,
    isSafeUrl,
    saveAsHTML,
    exportAsTXT,
    resetNavButtons,
    sendNavigateMessageWithRetry,
    renderDialogueItems,
    createSuccessActionGroup,
    updateRetryAllBtn,
    initRetryAllFailedButton
} from './reader-ui-helpers.js';
import {
    setupGlossaryModal,
    showGlossaryModal
} from './reader-glossary-modal.js';
import { initMobileReader } from './reader-mobile-drawer.js';

export { sanitizeTranslationText };

let translatedData = [];
let lastMangaRevision = -1;
let activeMangaJob = null;
const container = document.getElementById('results-container');
let sourceTabId = null;
let activeMangaKey = null;

// 解析 URL 取得來源分頁 ID
const urlParams = new URLSearchParams(window.location.search);
sourceTabId = parseInt(urlParams.get('tabId'));
if (isNaN(sourceTabId)) sourceTabId = null;

const getReaderContext = () => ({ sourceTabId, activeMangaKey });
const dialogueDeps = { showGlossaryModal, getContext: getReaderContext };

// 初始化：向背景請求元數據與導航資訊並綁定控制項
document.addEventListener('DOMContentLoaded', () => {
    initFontControls();

    // 加載主題
    chrome.storage.local.get(['mt_theme'], (result) => {
        applyTheme(result.mt_theme || 'umamusume');

        // 注入東方 Loading GIF 到右下角的翻譯中膠囊
        const mainAnim = document.getElementById('main-loading-anim');
        if (mainAnim) mainAnim.src = chrome.runtime.getURL(LOADING_GIF_FILENAME);
    });

    // 主動傳入 sourceTabId 查詢元數據與導航資訊
    chrome.runtime.sendMessage({ action: "getResultMetadata", tabId: sourceTabId }, (response) => {
        if (response) {
            if (response.mangaKey) activeMangaKey = response.mangaKey;

            if (response.displayName) {
                const titleEl = document.getElementById('manga-title-display');
                if (titleEl) {
                    titleEl.textContent = response.displayName;
                    titleEl.title = response.displayName;
                }
            }

            if (response.navLinks) {
                updateNavUI(response.navLinks);
            } else {
                updateNavUI({});
            }

            // 查詢並顯示語彙庫詳細狀態
            if (activeMangaKey) {
                chrome.runtime.sendMessage({ action: "getGlossaryDetail", mangaKey: activeMangaKey }, (glossaryResp) => {
                    if (glossaryResp && glossaryResp.entry) {
                        const badge = document.getElementById('glossary-info-badge');
                        if (badge) {
                            badge.textContent = `冊 語彙庫 ${glossaryResp.entry.terms?.length || 0} 詞`;
                            badge.style.display = 'inline-flex';
                            badge.classList.add('show');
                        }
                    }
                });
            }
        } else {
            updateNavUI({});
        }
    });

    sessionStorage.removeItem('mt_translated_data');
    sessionStorage.removeItem('mt_translation_complete');
    sessionStorage.removeItem('mt_progress_text');

    // 掛載匯出功能與模式切換
    document.getElementById('export-html-btn')?.addEventListener('click', saveAsHTML);
    document.getElementById('export-pdf-btn')?.addEventListener('click', () => window.print());
    document.getElementById('export-txt-btn')?.addEventListener('click', exportAsTXT);
    initModeToggleControls();
    initHeaderDropdowns(updateBatchDropdownMenu);

    // 綁定中止翻譯按鈕
    const stopBtn = document.getElementById('btn-stop-translation');
    if (stopBtn) {
        stopBtn.addEventListener('click', () => {
            if (confirm("確定要中止目前的批次翻譯嗎？")) {
                chrome.runtime.sendMessage({ action: 'STOP_TRANSLATION' }, () => {
                    const overlay = document.getElementById('loading-overlay');
                    if (overlay) overlay.classList.add('hidden');
                    // 清除可能殘留的暫停狀態
                    chrome.runtime.sendMessage({ action: 'SET_BATCH_PAUSE', paused: false }).catch(() => {});
                });
            }
        });
    }

    // 綁定「批次重翻」按鈕
    const retranslateAllBtn = document.getElementById('retranslate-all-btn');
    if (retranslateAllBtn) {
        retranslateAllBtn.addEventListener('click', () => {
            const validItems = translatedData.filter(item => item && (item.retryUrl || item.image));
            if (validItems.length === 0) {
                alert('目前沒有已載入的圖片可以重新翻譯！');
                return;
            }
            const images = validItems.map(item => toLightweightRetryImageRef(item));
            const retryPageIndices = validItems.map((item, idx) => item.pageIndex || (idx + 1));

            if (!confirm(`確定要重新翻譯整本漫畫（共 ${validItems.length} 頁）嗎？這將會清除當前所有翻譯結果並從第 1 頁重頭開始翻譯。`)) {
                return;
            }

            // 隱藏可能顯示的重試失敗按鈕，並開啟翻譯遮罩
            const retryContainer = document.getElementById('retry-all-container');
            if (retryContainer) retryContainer.style.display = 'none';
            const overlay = document.getElementById('loading-overlay');
            if (overlay) overlay.classList.remove('hidden');
            document.getElementById('progress-text').innerText = `正在準備重新翻譯 ${validItems.length} 張圖片...`;

            chrome.runtime.sendMessage({
                action: 'RETRANSLATE_ALL_BATCH',
                images,
                retryPageIndices,
                sourceTabId: sourceTabId ? parseInt(sourceTabId) : null,
                mangaKey: activeMangaKey
            }, (response) => {
                if (response?.status !== 'retrying') {
                    alert('重新翻譯請求失敗：' + (response?.error || '未知錯誤'));
                    if (overlay) overlay.classList.add('hidden');
                }
            });
        });
    }

    const retranslateBatchBtn = document.getElementById('retranslate-batch-btn');
    if (retranslateBatchBtn) {
        retranslateBatchBtn.addEventListener('click', () => {
            const validItems = translatedData.filter(item => item && (item.retryUrl || item.image) && Number.isInteger(item.pageIndex) && item.pageIndex > 0);
            if (validItems.length === 0) {
                alert('目前沒有已載入的批次圖片可以重翻！');
                return;
            }
            const images = validItems.map(item => toLightweightRetryImageRef(item));
            const retryPageIndices = validItems.map(item => item.pageIndex);

            if (!confirm(`確定要重新翻譯當前這批圖片（共 ${validItems.length} 張）嗎？`)) {
                return;
            }

            const overlay = document.getElementById('loading-overlay');
            if (overlay) overlay.classList.remove('hidden');
            document.getElementById('progress-text').innerText = `正在重翻當前批次 (${validItems.length} 張)...`;

            chrome.runtime.sendMessage({
                action: 'RETRY_FAILED_BATCH',
                images,
                retryPageIndices,
                sourceTabId: sourceTabId ? parseInt(sourceTabId) : null,
                mangaKey: activeMangaKey
            }, (response) => {
                if (response?.status !== 'retrying') {
                    alert('批次重翻請求失敗：' + (response?.error || '未知錯誤'));
                    if (overlay) overlay.classList.add('hidden');
                }
            });
        });
    }

    // 通知背景結果分頁已載入完成
    chrome.runtime.sendMessage({ action: "resultPageReady" }).then(response => {
        if (response?.job) applyMangaSnapshot(response.job);
        else if (response?.error) showRecoveryError(response.error);
    }).catch(err => showRecoveryError(err.message));

    // 初始化語彙庫 Modal 與鍵盤快捷鍵校對
    setupGlossaryModal(() => activeMangaKey);
    initKeyboardCardNavigation(container);
});

function renderPretranslatedChapter(chapterData) {
    console.log('[SPA] 命中跨話預翻快取，正在進行原地無縫換話...', chapterData);

    // 1. 清空舊卡片資料與批次容器
    container.innerHTML = '';
    translatedData.length = 0;
    const batchMenu = document.getElementById('batch-dropdown-menu');
    if (batchMenu) batchMenu.innerHTML = '';

    // 2. 逐一渲染已預翻好的卡片
    const results = chapterData.results || [];
    const batchSize = chapterData.batchSize || 10;
    results.forEach((item, idx) => {
        translatedData.push(item);
        const batchIdx = Math.floor(idx / batchSize);
        const targetGrid = getOrCreateBatchSection(batchIdx);
        const card = buildCard(item, idx);
        targetGrid.appendChild(card);
    });

    updateBatchDropdownMenu();

    // 3. 更新進度與導航 UI
    const progressEl = document.getElementById('progress-text');
    if (progressEl) progressEl.textContent = `✅ 全話 ${results.length} 頁已就緒 (預翻秒開)`;

    if (chapterData.navLinks) {
        updateNavUI(chapterData.navLinks);
    }

    // 4. 恢復按鈕狀態；捲動位置由換話成功的共同路徑重設。
    resetNavButtons();
}

let pretranslateBadgeGeneration = 0;
function updateNavUI(navLinks) {
    const badgeGeneration = ++pretranslateBadgeGeneration;
    const { prev, next, currentChapter, chapterList } = navLinks || {};
    const navBar = document.getElementById('chapter-nav-bar');
    const prevBtn = document.getElementById('nav-prev-chapter-btn');
    const nextBtn = document.getElementById('nav-next-chapter-btn');
    const currentText = document.getElementById('current-chapter-text');
    const chapterMenu = document.getElementById('chapter-dropdown-menu');
    const footer = document.getElementById('nav-footer');
    const footerPrevBtn = document.getElementById('prev-btn');
    const footerNextBtn = document.getElementById('next-btn');

    const safePrev = isSafeUrl(prev) ? prev : null;
    const safeNext = isSafeUrl(next) ? next : null;

    // 頂部導航欄與底部導航欄顯示控制
    if (navBar) navBar.style.display = 'inline-flex';
    if (footer) footer.style.display = 'flex';

    // 上一話動作處理函式
    const handlePrevNavigation = () => {
        if (!safePrev) return;
        sendNavigateMessageWithRetry({
            url: safePrev,
            tabId: sourceTabId,
            mangaKey: activeMangaKey,
            mobile: urlParams.get('mobile') === '1'
        }, [prevBtn, footerPrevBtn], '上一話');
    };

    // 下一話動作處理函式 (優先消費已預翻成果，實現 0ms SPA 原地秒開)
    const handleNextNavigation = () => {
        if (!safeNext) return;

        [nextBtn, footerNextBtn].filter(Boolean).forEach(b => {
            b.disabled = true;
            b.classList.add('is-navigating');
            b.innerHTML = `正在進入下一話...`;
        });

        // 嘗試向 Background 請求預翻好的成果
        chrome.runtime.sendMessage({
            action: 'CONSUME_PRETRANSLATED_CHAPTER',
            payload: {
                nextUrl: safeNext,
                sourceTabId,
                resultTabId: null
            }
        }, (response) => {
            if (response && response.success && response.data) {
                if (response.job) applyMangaSnapshot(response.job);
                else renderPretranslatedChapter(response.data);
                // Recovery snapshots may arrive before this response. Reset after
                // the chapter switch succeeds, regardless of which renderer ran.
                window.scrollTo(0, 0);
                container.scrollTo?.(0, 0);
            } else {
                // 快取未命中：退回生肉分頁跳轉
                sendNavigateMessageWithRetry({
                    url: safeNext,
                    tabId: sourceTabId,
                    mangaKey: activeMangaKey,
                    mobile: urlParams.get('mobile') === '1'
                }, [nextBtn, footerNextBtn], '下一話');
            }
        });
    };

    // 頂部中央：上一話
    if (prevBtn) {
        if (safePrev) {
            prevBtn.style.display = 'inline-flex';
            prevBtn.style.opacity = '1';
            prevBtn.disabled = false;
            prevBtn.onclick = handlePrevNavigation;
            prevBtn.title = safePrev;
        } else {
            prevBtn.style.opacity = '0.4';
            prevBtn.disabled = true;
        }
    }

    // 頂部中央：下一話
    if (nextBtn) {
        if (safeNext) {
            nextBtn.style.display = 'inline-flex';
            nextBtn.style.opacity = '1';
            nextBtn.disabled = false;
            nextBtn.onclick = handleNextNavigation;
            nextBtn.title = safeNext;
        } else {
            nextBtn.style.opacity = '0.4';
            nextBtn.disabled = true;
        }
    }

    // 底部導航：直接綁定相同動作，不走脆性的 DOM 代理點擊
    if (footerPrevBtn) {
        if (safePrev) {
            footerPrevBtn.style.display = 'inline-flex';
            footerPrevBtn.disabled = false;
            footerPrevBtn.onclick = handlePrevNavigation;
            footerPrevBtn.title = safePrev;
        } else {
            footerPrevBtn.style.display = 'none';
        }
    }

    if (footerNextBtn) {
        if (safeNext) {
            footerNextBtn.style.display = 'inline-flex';
            footerNextBtn.disabled = false;
            footerNextBtn.onclick = handleNextNavigation;
            footerNextBtn.title = safeNext;
        } else {
            footerNextBtn.style.display = 'none';
        }
    }

    // 檢查下一話預翻狀態並更新徽章
    const pretransBadge = document.getElementById('nav-pretranslate-badge');
    const retryPretransBtn = document.getElementById('nav-pretranslate-retry-btn');
    const footerRetryPretransBtn = document.getElementById('footer-pretranslate-retry-btn');
    const retryButtons = [retryPretransBtn, footerRetryPretransBtn].filter(Boolean);
    const showRetryButtons = visible => retryButtons.forEach(button => {
        button.style.display = visible ? 'inline-flex' : 'none';
    });
    let checkBadgeStatus = () => {};
    showRetryButtons(false);
    for (const button of retryButtons) {
        button.disabled = false;
        button.textContent = '重試預翻';
        button.onclick = () => {
            retryButtons.forEach(item => { item.disabled = true; item.textContent = '重試中…'; });
            chrome.runtime.sendMessage({ action: 'RETRY_PRETRANSLATED_CHAPTER',
                payload: { nextUrl: safeNext } }, (resp) => {
                if (badgeGeneration !== pretranslateBadgeGeneration) return;
                retryButtons.forEach(item => { item.textContent = '重試預翻'; });
                if (chrome.runtime.lastError || resp?.status !== 'retrying') {
                    retryButtons.forEach(item => { item.disabled = false; });
                    pretransBadge.title = resp?.error || chrome.runtime.lastError?.message || '重試預翻失敗';
                    return;
                }
                showRetryButtons(false);
                pretransBadge.textContent = '⏳預翻準備中';
                pretransBadge.style.background = '#ff9800';
                setTimeout(checkBadgeStatus, 1000);
            });
        };
    }
    if (safeNext && pretransBadge) {
        let checks = 0;
        checkBadgeStatus = () => {
            if (badgeGeneration !== pretranslateBadgeGeneration) return;
            chrome.runtime.sendMessage({
                action: 'CHECK_PRETRANSLATED_CHAPTER',
                payload: { nextUrl: safeNext }
            }, (resp) => {
                if (badgeGeneration !== pretranslateBadgeGeneration) return;
                const retry = () => {
                    if (++checks < 100) setTimeout(checkBadgeStatus, 3000);
                };
                if (chrome.runtime.lastError || resp?.error && !resp.exists) {
                    showRetryButtons(false);
                    pretransBadge.style.display = 'inline-block';
                    pretransBadge.textContent = '⚠狀態查詢失敗';
                    pretransBadge.style.background = '#d9534f';
                    pretransBadge.title = resp?.error || chrome.runtime.lastError?.message;
                    retry();
                    return;
                }
                if (resp && resp.exists) {
                    if (resp.isDone) {
                        showRetryButtons(false);
                        pretransBadge.style.display = 'inline-block';
                        pretransBadge.textContent = '⚡已預翻';
                        pretransBadge.style.background = '#4CAF50';
                        if (footerNextBtn) footerNextBtn.title = `${safeNext} (已預翻完成，點擊秒開)`;
                    } else if (resp.inProgress) {
                        showRetryButtons(false);
                        pretransBadge.style.display = 'inline-block';
                        pretransBadge.textContent = `⏳預翻中 (${resp.count}/${resp.total || '?'})`;
                        pretransBadge.style.background = '#ff9800';
                        retry();
                    } else if (resp.status === 'running') {
                        showRetryButtons(false);
                        pretransBadge.style.display = 'inline-block';
                        pretransBadge.textContent = '⏳預翻準備中';
                        pretransBadge.style.background = '#ff9800';
                        retry();
                    } else if (resp.error || resp.status === 'error') {
                        pretransBadge.style.display = 'inline-block';
                        pretransBadge.textContent = '⚠預翻失敗';
                        pretransBadge.style.background = '#d9534f';
                        pretransBadge.title = resp.error || '請查看擴充功能 Service Worker 訊息';
                        showRetryButtons(true);
                    } else {
                        retry();
                    }
                } else {
                    pretransBadge.style.display = 'none';
                    showRetryButtons(false);
                    retry();
                }
            });
        };
        checkBadgeStatus();
    } else if (pretransBadge) {
        pretransBadge.style.display = 'none';
    }
}

let placeholdersCreated = false;

// 監聽主題變更
chrome.storage.onChanged.addListener((changes) => {
    if (changes.mt_theme) {
        applyTheme(changes.mt_theme.newValue);
    }
});

function getBatchImagesByIndex(batchIndex, gridEl) {
    // 方案 1：直接從 DOM 元素提取 data-retry-url 或 img src
    const cards = gridEl ? gridEl.querySelectorAll('.result-card') : [];
    let images = Array.from(cards).map(card => {
        return card.dataset.retryUrl || card.querySelector('img')?.src || '';
    }).filter(url => url && !url.includes('data:image/svg'));

    // 方案 2：若 DOM 無資料，由 translatedData 快取陣列依批次切片 (預設每批 10 張)
    if (images.length === 0 && translatedData.length > 0) {
        const matched = translatedData.filter(item => item.batchIndex === batchIndex);
        if (matched.length > 0) {
            images = matched.map(item => item.retryUrl || item.image).filter(Boolean);
        } else {
            const sliceSize = 10;
            const start = batchIndex * sliceSize;
            const sliced = translatedData.slice(start, start + sliceSize);
            images = sliced.map(item => item.retryUrl || item.image).filter(Boolean);
        }
    }

    return images;
}

function getBatchRetryEntries(batchIndex) {
    return translatedData
        .filter(item => item.batchIndex === batchIndex && Number.isInteger(item.pageIndex) && item.pageIndex > 0)
        .sort((a, b) => a.pageIndex - b.pageIndex)
        .map(item => {
            const rawImage = item.retryUrl || item.image || '';
            return { rawImage, image: toLightweightRetryImageRef(rawImage), pageIndex: item.pageIndex };
        })
        .filter(item => item.rawImage && !item.rawImage.includes('data:image/svg'));
}

function updateBatchDropdownMenu() {
    const menu = document.getElementById('batch-dropdown-menu');
    if (!menu) return;

    const sections = [...container.querySelectorAll('.mt-batch-section')];
    if (sections.length === 0) {
        menu.innerHTML = `<div style="padding: 10px 16px; font-size: 13px; color: #666;">目前尚無可重翻的批次</div>`;
        return;
    }

    menu.innerHTML = '';
    sections.forEach((sec) => {
        const bIdx = parseInt(sec.dataset.batch);
        const grid = sec.querySelector('.mt-batch-grid');
        const images = getBatchImagesByIndex(bIdx, grid);
        const countDisplay = images.length > 0 ? `${images.length} 張圖` : `點擊進行批次重翻`;

        const item = document.createElement('div');
        item.style.cssText = `
            padding: 10px 16px;
            font-size: 13px;
            font-weight: 700;
            color: #212529;
            cursor: pointer;
            display: flex;
            justify-content: space-between;
            align-items: center;
            transition: background 0.15s;
        `;
        item.innerHTML = `
            <span>📦 第 ${bIdx + 1} 批次</span>
            <span style="font-size: 11px; color: #8d80f1; background: #f0edff; padding: 2px 8px; border-radius: 12px;">${countDisplay}</span>
        `;
        item.onmouseover = () => item.style.background = '#f4f2ff';
        item.onmouseout = () => item.style.background = 'transparent';
        item.onclick = () => {
            menu.style.display = 'none';
            sec.scrollIntoView({ behavior: 'smooth', block: 'center' });
            const btn = sec.querySelector('.btn-retranslate-single-batch');
            if (btn) btn.click();
        };
        menu.appendChild(item);
    });
}

function getOrCreateBatchSection(batchIndex, skipDropdownRefresh = false) {
    if (batchIndex === undefined || batchIndex === null || isNaN(batchIndex)) batchIndex = 0;
    let section = container.querySelector(`.mt-batch-section[data-batch="${batchIndex}"]`);
    if (!section) {
        section = document.createElement('div');
        section.className = 'mt-batch-section';
        section.dataset.batch = batchIndex;

        const header = document.createElement('div');
        header.className = 'mt-batch-header';

        header.innerHTML = `
            <div class="mt-batch-title">
                <span>📦 批次 #${batchIndex + 1}</span>
            </div>
            <button class="btn-export accent btn-retranslate-single-batch" data-batch="${batchIndex}">
                ⚡ 重翻第 ${batchIndex + 1} 批次
            </button>
        `;

        const grid = document.createElement('div');
        grid.className = 'mt-batch-grid';

        section.appendChild(header);
        section.appendChild(grid);

        // 綁定「⚡ 重翻第 N 批次」點擊事件
        header.querySelector('.btn-retranslate-single-batch').onclick = () => {
            const batchEntries = getBatchRetryEntries(batchIndex);
            const batchImages = batchEntries.map(item => item.image);

            if (batchImages.length === 0) {
                alert(`批次 #${batchIndex + 1} 無有效圖片可重翻（可能尚未開始載入或圖片連結失效）`);
                return;
            }

            if (!confirm(`確定要重新翻譯 批次 #${batchIndex + 1}（共 ${batchImages.length} 張圖片）嗎？`)) {
                return;
            }

            const overlay = document.getElementById('loading-overlay');
            if (overlay) overlay.classList.remove('hidden');
            document.getElementById('progress-text').innerText = `正在重翻第 ${batchIndex + 1} 批次 (${batchImages.length} 張)...`;

            chrome.runtime.sendMessage({
                action: 'RETRY_FAILED_BATCH',
                images: batchImages,
                retryPageIndices: batchEntries.map(item => item.pageIndex),
                targetBatchIndex: batchIndex,
                sourceTabId: sourceTabId,
                mangaKey: activeMangaKey
            }, (response) => {
                if (response?.status !== 'retrying') {
                    alert('批次重翻失敗: ' + (response?.error || '未知錯誤'));
                    if (overlay) overlay.classList.add('hidden');
                }
            });
        };

        // 按批次順序插入 container
        const sections = [...container.querySelectorAll('.mt-batch-section')];
        const nextSection = sections.find(sec => parseInt(sec.dataset.batch) > batchIndex);
        if (nextSection) {
            container.insertBefore(section, nextSection);
        } else {
            container.appendChild(section);
        }

        if (!skipDropdownRefresh) {
            updateBatchDropdownMenu();
        }
    }
    return section.querySelector('.mt-batch-grid');
}

function showRecoveryError(message) {
    document.getElementById('loading-overlay')?.classList.add('hidden');
    let notice = document.getElementById('manga-recovery-notice');
    if (!notice) {
        notice = document.createElement('div');
        notice.id = 'manga-recovery-notice';
        notice.setAttribute('role', 'status');
        notice.style.cssText = 'padding:16px;margin:16px;border:1px solid #d97706;border-radius:8px;';
        container.before(notice);
    }
    notice.textContent = message;
    return notice;
}

const retiredMangaJobIds = new Set();
function applyMangaSnapshot(job) {
    if (!job || retiredMangaJobIds.has(job.id)) return;
    const generation = job.createdAt || 0;
    const previousGeneration = activeMangaJob?.createdAt || 0;
    if (generation < previousGeneration ||
        (generation === previousGeneration && job.revision <= lastMangaRevision)) return;
    const previousJob = activeMangaJob;
    if (previousJob && previousJob.id !== job.id) retiredMangaJobIds.add(previousJob.id);
    const previousRows = translatedData;
    const sameChapterRetry = job.isRetry && previousJob &&
        previousJob.sourceTabId === job.sourceTabId &&
        previousJob.sourceUrl === job.sourceUrl;
    lastMangaRevision = job.revision;
    activeMangaJob = job;
    sourceTabId = job.sourceTabId || sourceTabId;
    activeMangaKey = job.mangaKey || activeMangaKey;
    const previousByPageIndex = new Map();
    for (const row of previousRows) {
        if (row && Number.isInteger(row.pageIndex)) {
            previousByPageIndex.set(row.pageIndex, row);
        }
    }
    const savedRows = job.results.map(item => {
        const existing = previousByPageIndex.get(item.pageIndex);
        // Keep temporary image pixels in this live page only.
        return !item.image && existing?.image && existing.pageIndex === item.pageIndex &&
            (job.id === existing._jobId || sameChapterRetry)
            ? { ...item, image: existing.image, _jobId: job.id } : { ...item, _jobId: job.id };
    });
    // A retry snapshot can contain only its selected batch (for example after a
    // worker restart). Keep the other visible pages of the same chapter.
    if (sameChapterRetry) {
        const savedPageIndices = new Set();
        const savedImages = new Set();
        for (const saved of savedRows) {
            if (saved.pageIndex > 0) savedPageIndices.add(saved.pageIndex);
            else if (saved.image) savedImages.add(saved.image);
        }
        translatedData = [
            ...savedRows,
            ...previousRows.filter(row => !(
                (row.pageIndex > 0 && savedPageIndices.has(row.pageIndex)) ||
                (!(row.pageIndex > 0) && row.image && savedImages.has(row.image))
            ))
        ].sort((a, b) => a.pageIndex - b.pageIndex);
    } else {
        translatedData = savedRows;
    }
    container.innerHTML = '';
    translatedData.forEach((item, index) => {
        const card = buildCard(item, index);
        getOrCreateBatchSection(item.batchIndex || 0, true).appendChild(card);
        if (window._bindMobileCard) window._bindMobileCard(card);
    });
    if (typeof updateBatchDropdownMenu === 'function') updateBatchDropdownMenu();
    placeholdersCreated = true;
    if (job.navLinks) updateNavUI(job.navLinks);
    document.getElementById('progress-text').innerText = job.processedCount + ' / ' + job.images.length;
    document.getElementById('loading-overlay').classList.toggle('hidden', job.status !== 'running');
    document.getElementById('manga-recovery-notice')?.remove();
    const missingImages = job.images.slice(job.processedCount).some(src => !src);
    if (job.status === 'interrupted' || job.status === 'stopped') {
        const notice = showRecoveryError(missingImages
            ? '此任務含暫存圖片，無法從中斷處繼續。請回原網頁重新擷取未完成的圖片。'
            : (job.status === 'stopped' ? '翻譯已停止。' : '背景服務曾中斷，已恢復保存的譯文。') + ' 按「繼續翻譯」才會發出新的翻譯請求。');
        if (!missingImages) {
            const button = document.createElement('button');
            button.textContent = '繼續翻譯';
            button.addEventListener('click', async () => {
                button.disabled = true;
                try {
                    const response = await chrome.runtime.sendMessage({ action: 'RESUME_MANGA_JOB', jobId: activeMangaJob.id });
                    if (!response?.success) throw new Error(response?.error || '無法繼續任務');
                } catch (err) { showRecoveryError(err.message); }
            });
            notice.appendChild(button);
        }
    } else if (job.status === 'source-changed') {
        showRecoveryError('來源章節已變更。已保存的譯文仍可閱讀；請從原網頁開始新的翻譯。');
    } else if (translatedData.some(item => !item.image)) {
        const notice = document.createElement('p');
        notice.id = 'manga-recovery-notice';
        notice.textContent = '部分暫存圖片已失效，已保存的譯文仍可閱讀；圖片需回原網頁重新擷取。';
        container.before(notice);
    }
    resetNavButtons();
    updateRetryAllBtn();
}

const receiveMangaImage = createMangaImageReceiver(() => activeMangaJob, (pageIndex, image) => {
    const row = translatedData.find(item => item.pageIndex === pageIndex);
    if (!row) return;
    row.image = image;
    const saved = activeMangaJob.results.find(item => item.pageIndex === pageIndex);
    if (saved) saved.image = image;
    const card = container.querySelector(`.result-card[data-page-index="${pageIndex}"]`);
    const img = card?.querySelector('.card-image-wrapper img');
    if (img) img.src = image;
    if (card) card.dataset.retryUrl = image;
    if (translatedData.every(item => item.image)) document.getElementById('manga-recovery-notice')?.remove();
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'mangaImageChunk') {
        receiveMangaImage(request);
        sendResponse({ status: 'success' });
        return false;
    }
    if (request.action === 'mangaSnapshot') {
        applyMangaSnapshot(request.job);
        sendResponse({ status: 'success' });
        return false;
    }
    if (request.action === 'mangaRecoveryError') {
        showRecoveryError(request.error);
        resetNavButtons();
        sendResponse({ status: 'success' });
        return false;
    }
    if (request.action === "appendResult") {
        const batchIdx = request.data?.batchIndex !== undefined ? request.data.batchIndex : 0;
        const targetGrid = getOrCreateBatchSection(batchIdx);

        // 同一圖片 URL 可能出現在多頁，重試結果以原始頁碼定位卡片。
        const existingErrorCard = Number.isInteger(request.data?.pageIndex)
            ? container.querySelector(`.result-card[data-page-index="${request.data.pageIndex}"]`)
            : null;

        let realCard;
        if (existingErrorCard) {
            // 覆蓋模式：原地替換舊卡片
            const existingIndex = existingErrorCard.dataset.index;
            translatedData[parseInt(existingIndex) || 0] = request.data;
            realCard = buildCard(request.data, parseInt(existingIndex) || 0);
            existingErrorCard.replaceWith(realCard);
        } else {
            translatedData.push(request.data);
            const idx = translatedData.length - 1;
            const placeholder = container.querySelector(`.skeleton-card[data-index="${idx}"]`);
            if (placeholder) {
                realCard = buildCard(request.data, idx);
                placeholder.replaceWith(realCard);
            } else {
                realCard = buildCard(request.data, idx);
                targetGrid.appendChild(realCard);
            }
        }
        // 關鍵保險：確保 realCard 必須屬於對應的 targetGrid 批次容器
        if (realCard && realCard.parentElement !== targetGrid) {
            targetGrid.appendChild(realCard);
        }
        updateBatchDropdownMenu();

        // 行動端：綁定點擊事件
        if (window._bindMobileCard) window._bindMobileCard(realCard);
        sendResponse({status: "success"});
    } else if (request.action === "updateProgress") {
        const isNumeric = typeof request.current === 'number';
        document.getElementById('progress-text').innerText = isNumeric
            ? `${request.current} / ${request.total}`
            : String(request.current);
        if (isNumeric && !placeholdersCreated && request.total > 0) {
            createPlaceholders(request.total);
            placeholdersCreated = true;
        }
    } else if (request.action === "batchComplete") {
        document.getElementById('loading-overlay').classList.add('hidden');
        container.querySelectorAll('.skeleton-card').forEach(el => el.remove());
        resetNavButtons();
        updateRetryAllBtn(); // 【改動3】統計失敗張數，更新重試按鈕
    } else if (request.action === "setNavigation") {
        updateNavUI(request.navLinks);
    } else if (request.action === "clearResults") {
        translatedData = [];
        container.innerHTML = '';
        document.getElementById('loading-overlay').classList.remove('hidden');
        document.getElementById('progress-text').innerText = '正在跳轉並準備翻譯...';
        placeholdersCreated = false;
        window.scrollTo(0, 0);
    } else if (request.action === "reloadAndTranslate") {
        // 【對齊 v1.8.7】就地清空結果頁，準備接收新章節的翻譯
        translatedData = [];
        container.innerHTML = '';
        placeholdersCreated = false;
        window.scrollTo(0, 0);

        // 更新 sourceTabId（新章節的 tabId）
        if (request.sourceTabId) sourceTabId = request.sourceTabId;

        // 立即重置導航按鈕狀態 (移除 "正在跳轉至 下一話..." 載入字樣)
        resetNavButtons();
        if (request.navLinks) {
            updateNavUI(request.navLinks);
        }

        // 隱藏舊導航、開啟翻譯進度 overlay
        const footer = document.getElementById('nav-footer');
        if (footer) footer.style.display = 'none';
        const overlay = document.getElementById('loading-overlay');
        if (overlay) overlay.classList.remove('hidden');
        document.getElementById('progress-text').innerText = '正在跳轉並準備翻譯...';

        // 更新語彙庫 key
        if (request.mangaKey) activeMangaKey = request.mangaKey;

        // 告訴 Background 確認收到
        sendResponse({ ready: true });
        return false;
    }
    return false;
});

function createPlaceholders(total) {
    const batchSize = 10;
    for (let i = 0; i < total; i++) {
        const batchIdx = Math.floor(i / batchSize);
        const targetGrid = getOrCreateBatchSection(batchIdx);

        const card = document.createElement('div');
        card.className = 'result-card skeleton-card';
        card.dataset.index = i;

        // 使用東方少女祈禱中 GIF 作為等待翻譯的 Skeleton 佔位動畫
        const animHtml = `
            <div class="skeleton-anim">
                <img src="${chrome.runtime.getURL(LOADING_GIF_FILENAME)}" style="width:70px; height:auto; opacity:0.6;" alt="少女祈禱中">
            </div>
        `;

        card.innerHTML = `
            <div class="card-image-wrapper skeleton-image">
                <span class="card-page-badge">P.${i + 1}</span>
                ${animHtml}
                <div class="skeleton-shimmer"></div>
            </div>
            <div class="card-text-wrapper">
                <div class="text-group">
                    <div class="skeleton-line skeleton-line--label"></div>
                    <div class="skeleton-line skeleton-line--long"></div>
                    <div class="skeleton-line skeleton-line--medium"></div>
                </div>
                <div class="text-group">
                    <div class="skeleton-line skeleton-line--label"></div>
                    <div class="skeleton-line skeleton-line--long"></div>
                </div>
            </div>
        `;
        targetGrid.appendChild(card);
    }
}

function buildCard(item, index) {
    const card = document.createElement('div');
    card.className = 'result-card';
    item.pageIndex ||= index + 1;
    card.dataset.pageIndex = item.pageIndex;
    // 記錄圖片 URL 以便整批重試時定位
    if (item.image) card.dataset.retryUrl = item.image;
    card.dataset.index = index;

    const imageWrapper = document.createElement('div');
    imageWrapper.className = 'card-image-wrapper';
    const badge = document.createElement('span');
    badge.className = 'card-page-badge';
    badge.textContent = `P.${index + 1}`;
    imageWrapper.appendChild(badge);

    if (item.usedModelName) {
        const modelBadge = document.createElement('span');
        modelBadge.className = 'card-model-badge';
        let displayName = item.usedModelName;
        if (item.usedModelName.includes('3.1-flash-lite')) displayName = '⚡ 3.1-Lite';
        else if (item.usedModelName.includes('3.5-flash-lite')) displayName = '⚡ 3.5-Lite';
        else if (item.usedModelName.includes('2.5-flash')) displayName = '⚡ 2.5-Flash';
        else if (item.usedModelName.toLowerCase().includes('gemini')) displayName = 'Gemini';
        else if (item.usedModelName.toLowerCase().includes('gemma')) displayName = 'Gemma';
        modelBadge.textContent = displayName;
        imageWrapper.appendChild(modelBadge);
    }

    const img = document.createElement('img');
    // 優先使用背景預翻快取的 Base64 實現 0ms 本機瞬間出圖，若無則降級為原圖 URL
    img.setAttribute('src', item.cachedBase64 || item.image);
    img.setAttribute('alt', `Page ${index + 1}`);
    img.loading = 'lazy';
    img.decoding = 'async'; // 將圖片解碼移出 UI 主線程，避免百頁長條漫滑動掉幀
    imageWrapper.appendChild(img);
    card.appendChild(imageWrapper);

    const textWrapper = document.createElement('div');
    textWrapper.className = 'card-text-wrapper';

    // 翻譯失敗 / 觸發模型審查拒絕：顯示專屬警示與重試按鈕
    if (item.error) {
        const isProhibited = item.isProhibited || (typeof item.error === 'string' && (item.error.includes('SAFETY') || item.error.includes('BLOCKLIST') || item.error.includes('Prohibited') || item.error.includes('過濾器') || item.error.includes('拒絕')));

        if (isProhibited) {
            card.classList.add('is-prohibited');
        } else {
            card.classList.add('is-error');
        }

        const errorGroup = document.createElement('div');
        errorGroup.className = 'text-group';

        let errorMsg = null;
        let bannerEl = null;

        if (isProhibited && item.isBatchFirstProhibited) {
            // 整批翻譯第一張圖片：渲染醒目的 Prohibited 專屬警示橫幅
            const prohibitedBanner = document.createElement('div');
            bannerEl = prohibitedBanner;
            prohibitedBanner.className = 'prohibited-banner';
            prohibitedBanner.innerHTML = `
                <div class="prohibited-header">
                    <span>🚫 AI 模型內容審查拒絕</span>
                    <span class="prohibited-badge">Prohibited</span>
                </div>
                <div class="prohibited-desc">
                    此批次漫畫畫面或台詞觸發了 Google AI 安全性過濾器 (SAFETY / BLOCKLIST)，模型直接拒絕翻譯本批內容。
                </div>
                <div class="prohibited-tip">
                    💡 <strong>處理建議：</strong>您可重新嘗試單張翻譯，或手動校對原文後使用文字翻譯。模型仍可能拒絕部分內容。
                </div>
            `;
            errorGroup.appendChild(prohibitedBanner);
        } else {
            const errorLabel = document.createElement('div');
            errorLabel.className = isProhibited ? 'text-label text-label--prohibited' : 'text-label text-label--error';
            errorLabel.textContent = isProhibited ? '🚫 內容審查受限 (Prohibited)' : '翻譯失敗';
            errorGroup.appendChild(errorLabel);

            errorMsg = document.createElement('div');
            errorMsg.className = 'error-message';
            errorMsg.textContent = item.error;
            errorGroup.appendChild(errorMsg);
        }

        const retryBtn = document.createElement('button');
        retryBtn.className = 'btn-retry';
        retryBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16"/></svg> 再次翻譯`;
        retryBtn.addEventListener('click', () => {
            retryBtn.disabled = true;
            retryBtn.textContent = '翻譯中...';
            card.classList.remove('is-error', 'is-prohibited');
            const targetErrorMsg = errorGroup.querySelector('.error-message');
            if (targetErrorMsg) targetErrorMsg.textContent = '正在重新呼叫 API...';

            chrome.runtime.sendMessage({
                action: "retranslateImage",
                url: item.retryUrl || item.image,
                pageIndex: item.pageIndex,
                tabId: sourceTabId,
                mangaKey: activeMangaKey
            }, (response) => {
                if (response && response.results) {
                    // 成功：移除錯誤區，補上結構化對話與完整的按鈕列
                    errorGroup.remove();
                    item.results = response.results;
                    item.usedModelName = response.usedModelName;

                    // 重新加載模型標籤 (如果有的話)
                    if (item.usedModelName) {
                        imageWrapper.querySelectorAll('.card-model-badge').forEach(el => el.remove());
                        const modelBadge = document.createElement('span');
                        modelBadge.className = 'card-model-badge';
                        let displayName = item.usedModelName;
                        if (item.usedModelName.toLowerCase().includes('gemini')) displayName = 'Gemini';
                        if (item.usedModelName.toLowerCase().includes('gemma')) displayName = 'Gemma';
                        modelBadge.textContent = displayName;
                        imageWrapper.appendChild(modelBadge);
                    }

                    // 重新渲染對話區域
                    const dialoguesContainer = document.createElement('div');
                    dialoguesContainer.className = 'dialogues-container';
                    renderDialogueItems(dialoguesContainer, item.results, item, dialogueDeps);
                    textWrapper.appendChild(dialoguesContainer);

                    textWrapper.appendChild(createSuccessActionGroup(item, dialoguesContainer, dialogueDeps));
                } else {
                    card.classList.add('is-error');
                    retryBtn.disabled = false;
                    retryBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16"/></svg> 再次翻譯`;
                    const failText = `❌ 重試失敗: ${response?.error || chrome.runtime.lastError?.message || '未知錯誤'}`;
                    if (errorMsg) {
                        errorMsg.textContent = failText;
                    } else if (bannerEl) {
                        const subText = bannerEl.querySelector('div:last-child');
                        if (subText) subText.textContent = failText;
                    }
                }
            });
        });
        errorGroup.appendChild(retryBtn);
        textWrapper.appendChild(errorGroup);
        card.appendChild(textWrapper);
        return card;
    }

    const dialoguesContainer = document.createElement('div');
    dialoguesContainer.className = 'dialogues-container';
    const results = item.results || [{ original: item.original, translation: item.translation }];

    // 在右側頂部加入精緻工具列 (🔄 重翻此頁) + 下方虛線分割
    const toolbarTop = document.createElement('div');
    toolbarTop.className = 'card-toolbar-top';
    toolbarTop.innerHTML = `
        <button class="btn-washi btn-retrans-top" style="padding: 2px 8px; font-size: 11px;" title="重新呼叫 API 翻譯本頁">🔄 重翻此頁</button>
    `;

    // 綁定「🔄 重翻此頁」事件
    toolbarTop.querySelector('.btn-retrans-top').onclick = () => {
        const btn = toolbarTop.querySelector('.btn-retrans-top');
        const origText = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<span class="mt-loader" style="width:10px; height:10px; border-width:1.5px;"></span> 翻譯中...';

        chrome.runtime.sendMessage({
            action: "retranslateImage",
            url: item.retryUrl || item.image,
            pageIndex: item.pageIndex,
            tabId: sourceTabId,
            mangaKey: activeMangaKey
        }, (response) => {
            btn.disabled = false;
            btn.innerHTML = origText;
            if (response && response.results) {
                item.results = response.results;
                item.usedModelName = response.usedModelName;
                renderDialogueItems(dialoguesContainer, item.results, item, dialogueDeps);
            } else {
                alert("重翻此頁失敗: " + (response?.error || '未知錯誤'));
            }
        });
    };

    textWrapper.appendChild(toolbarTop);
    renderDialogueItems(dialoguesContainer, results, item, dialogueDeps);
    textWrapper.appendChild(dialoguesContainer);
    card.appendChild(textWrapper);
    return card;
}

initMobileReader({ showGlossaryModal });
initRetryAllFailedButton(container, getReaderContext);
