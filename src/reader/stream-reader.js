// Stream Reader for Manga Translator V3
console.log('[Manga Translator V3] Stream Reader Initialized');

// 核心狀態
let mangaData = null;
let activeMangaKey = null;
let totalPages = 0;
let loadedImagesMap = new Map(); // index -> imageURL
let pageObservers = [];
let isTranslatingAll = false;
let translatedResultsMap = new Map(); // index -> dialogueResults

// DOM 元素
const mangaTitleEl = document.getElementById('manga-title');
const currentPageEl = document.getElementById('current-page');
const totalPagesEl = document.getElementById('total-pages');
const widthSlider = document.getElementById('width-slider');
const widthVal = document.getElementById('width-val');
const readerContainer = document.getElementById('reader-container');
const btnToggleTheme = document.getElementById('btn-toggle-theme');
const btnScrollTop = document.getElementById('btn-scroll-top');
const btnPrevChapter = document.getElementById('btn-prev-chapter');
const btnNextChapter = document.getElementById('btn-next-chapter');
const btnDownloadZip = document.getElementById('btn-download-zip');
const btnTransAll = document.getElementById('btn-trans-all');
const progressBar = document.getElementById('global-progress-bar');
const progressFill = document.getElementById('progress-fill');
const progressText = document.getElementById('progress-text');

// 載入資料
async function loadMangaData() {
    const data = await chrome.storage.local.get(['mt_current_stream', 'mt_theme']);
    if (data.mt_theme) {
        document.body.className = `theme-${data.mt_theme}`;
    }
    
    if (!data.mt_current_stream) {
        readerContainer.innerHTML = `
            <div class="error-container">
                <p>❌ 未找到漫畫串流資料，請確認您已在 N/E 網的漫畫詳情首頁點擊「流式閱讀」！</p>
            </div>
        `;
        return;
    }

    mangaData = data.mt_current_stream;
    activeMangaKey = mangaData.titleKey || mangaData.id || mangaData.mangaId || 'unknown';

    // 強效資料自動備援：自動將 pageUrls 轉換為標準 pages 結構
    if (!mangaData.pages && Array.isArray(mangaData.pageUrls)) {
        mangaData.pages = mangaData.pageUrls.map(u => ({ url: typeof u === 'string' ? u : u.url }));
    } else if (!mangaData.pages && mangaData.totalPages && mangaData.mangaId) {
        mangaData.pages = Array.from({ length: mangaData.totalPages }, (_, i) => ({
            url: `https://nhentai.net/g/${mangaData.mangaId}/${i + 1}/`
        }));
    }

    if (!mangaData.pages) mangaData.pages = [];
    totalPages = mangaData.pages.length;
    
    // 更新 UI 標題與頁數
    mangaTitleEl.textContent = mangaData.title || '未知漫畫';
    totalPagesEl.textContent = totalPages;

    // 處理章節導航
    if (mangaData.navLinks) {
        if (mangaData.navLinks.prev) {
            btnPrevChapter.disabled = false;
            btnPrevChapter.onclick = () => navigateToChapter(mangaData.navLinks.prev);
        }
        if (mangaData.navLinks.next) {
            btnNextChapter.disabled = false;
            btnNextChapter.onclick = () => navigateToChapter(mangaData.navLinks.next);
        }
    }

    // 初始化頁面容器
    initPageContainers();
}

// 建立佔位容器並啟動 Intersection Observer 與背景下載佇列
function initPageContainers() {
    readerContainer.innerHTML = '';
    const currentWidth = widthSlider.value + 'px';

    // 1. 先建立所有頁面的 HTML 骨架與佔位容器
    mangaData.pages.forEach((page, idx) => {
        const wrapper = document.createElement('div');
        wrapper.className = 'page-wrapper';
        wrapper.id = `page-wrapper-${idx}`;
        wrapper.dataset.index = idx;
        wrapper.style.width = currentWidth;
        wrapper.style.minHeight = '600px'; // 預設高度以防抖

        const overlay = document.createElement('div');
        overlay.className = 'page-overlay';
        overlay.id = `overlay-${idx}`;
        overlay.innerHTML = `
            <div class="spinner"></div>
            <p id="overlay-text-${idx}">等待下載佇列... (P. ${idx + 1})</p>
        `;

        const actions = document.createElement('div');
        actions.className = 'page-actions';
        actions.innerHTML = `
            <button class="btn-trans-page" data-index="${idx}">⚡ 翻譯此頁</button>
        `;

        wrapper.appendChild(overlay);
        wrapper.appendChild(actions);

        actions.querySelector('.btn-trans-page').onclick = (e) => {
            e.stopPropagation();
            translateSinglePage(idx);
        };

        readerContainer.appendChild(wrapper);
    });

    // 2. 啟動 Intersection Observer：更新頁碼並讓可見區域圖片享 VIP 優先插隊預載
    const observerOptions = {
        root: null,
        rootMargin: '300px 0px', // 擴大預載視野
        threshold: 0.05
    };

    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                const index = parseInt(entry.target.dataset.index);
                currentPageEl.textContent = index + 1;
                
                // 如果目前滑到的頁面尚未下載，且不在佇列前端，立即插隊至最優先下載
                if (!loadedImagesMap.has(index)) {
                    prioritizePageInQueue(index);
                }
            }
        });
    }, observerOptions);

    document.querySelectorAll('.page-wrapper').forEach(el => {
        observer.observe(el);
        pageObservers.push({ element: el, observer });
    });

    // 3. 立刻啟動自動背景順序佇列預載 (不需要手動滑動即可全自動下載全本)
    startBackgroundDownloadQueue();
}

// 全局預載佇列與心跳控制
let backgroundDownloadQueue = [];
let isQueueRunning = false;
let heartbeatIntervalId = null;

function prioritizePageInQueue(index) {
    if (loadedImagesMap.has(index) && loadedImagesMap.get(index) !== 'loading') return;
    
    const qIdx = backgroundDownloadQueue.indexOf(index);
    if (qIdx > 0) {
        backgroundDownloadQueue.splice(qIdx, 1);
        backgroundDownloadQueue.unshift(index); // 插隊到隊列最前面
    } else if (qIdx === -1) {
        backgroundDownloadQueue.unshift(index);
    }
}

// 自動背景下載佇列主邏輯 (自癒式不死佇列 - 全自動按 1,2,3 順序預載全本)
async function startBackgroundDownloadQueue() {
    if (isQueueRunning) return;
    isQueueRunning = true;
    
    progressBar.style.display = 'block';
    
    // 初始化尚未下載完成的頁面佇列
    if (backgroundDownloadQueue.length === 0) {
        for (let i = 0; i < totalPages; i++) {
            if (!loadedImagesMap.has(i) || loadedImagesMap.get(i) === 'loading') {
                backgroundDownloadQueue.push(i);
            }
        }
    }

    let activeWorkers = 0;
    const maxConcurrency = 3;

    const updateProgressUI = () => {
        let successCount = 0;
        loadedImagesMap.forEach(val => {
            if (val && val !== 'loading') successCount++;
        });

        const percent = Math.round((successCount / totalPages) * 100);
        progressFill.style.width = percent + '%';
        progressText.textContent = `正在全自動預載圖片中: ${successCount} / ${totalPages} (${percent}%)`;

        if (successCount === totalPages) {
            progressFill.style.width = '100%';
            progressText.textContent = `🎉 所有圖片預載快取完成！`;
            btnDownloadZip.innerHTML = '📦 瞬間打包下載 (已就緒)';
            if (heartbeatIntervalId) clearInterval(heartbeatIntervalId);
            setTimeout(() => {
                progressBar.style.display = 'none';
            }, 3000);
        }
    };

    const runWorker = async () => {
        while (backgroundDownloadQueue.length > 0) {
            const index = backgroundDownloadQueue.shift();
            
            // 跳過已經成功載入好的
            if (loadedImagesMap.has(index) && loadedImagesMap.get(index) !== 'loading') {
                updateProgressUI();
                continue;
            }

            activeWorkers++;
            
            try {
                const overlayText = document.getElementById(`overlay-text-${index}`);
                if (overlayText) overlayText.textContent = `正在預載中... (P. ${index + 1})`;

                await loadPageImage(index);
                // 順暢下載：平滑間隔 120ms
                await new Promise(r => setTimeout(r, 120));
            } catch (err) {
                console.warn(`P.${index + 1} 預載暫時受阻，放回佇列末尾重試...`);
                // 關鍵自癒邏輯：失敗圖片不拋棄，重新放入佇列末尾！
                if (!loadedImagesMap.has(index) || loadedImagesMap.get(index) === 'loading') {
                    backgroundDownloadQueue.push(index);
                }
                // 遇到繁忙時動態拉長休眠間隔 (1000ms)，給伺服器喘息
                await new Promise(r => setTimeout(r, 1000));
            } finally {
                activeWorkers--;
                updateProgressUI();
            }
        }
        
        isQueueRunning = false;
    };

    // 啟動 3 個 Worker
    const safeConcurrency = Math.min(maxConcurrency, Math.max(1, backgroundDownloadQueue.length));
    for (let i = 0; i < safeConcurrency; i++) {
        runWorker();
    }

    // 心跳檢查與自動甦醒機制 (每 4 秒檢查一次是否有漏掉或中斷的頁面)
    if (!heartbeatIntervalId) {
        heartbeatIntervalId = setInterval(() => {
            let successCount = 0;
            const pendingIndices = [];
            for (let i = 0; i < totalPages; i++) {
                if (loadedImagesMap.has(i) && loadedImagesMap.get(i) !== 'loading') {
                    successCount++;
                } else {
                    pendingIndices.push(i);
                }
            }

            if (successCount < totalPages) {
                if (!isQueueRunning || backgroundDownloadQueue.length === 0) {
                    console.log(`[QueueHeartbeat] 偵測到有 ${pendingIndices.length} 頁尚未完成，自動喚醒佇列繼續下載...`);
                    backgroundDownloadQueue = pendingIndices;
                    isQueueRunning = false;
                    startBackgroundDownloadQueue();
                }
            } else {
                clearInterval(heartbeatIntervalId);
                heartbeatIntervalId = null;
            }
        }, 4000);
    }
}

// 載入單一頁面的真實圖片連結 (包含自動重試與平滑延遲機制)
function loadPageImage(index, retryCount = 0) {
    return new Promise((resolve, reject) => {
        const wrapper = document.getElementById(`page-wrapper-${index}`);
        const overlay = document.getElementById(`overlay-${index}`);
        
        if (loadedImagesMap.has(index) && loadedImagesMap.get(index) !== 'loading') {
            resolve();
            return;
        }
        
        loadedImagesMap.set(index, 'loading');
        const pageObj = mangaData.pages[index];
        if (!pageObj || !pageObj.url) {
            showErrorPage(index, '無效的分頁網址');
            reject(new Error('無效的分頁網址'));
            return;
        }

        const fetchWithRetry = () => {
            chrome.runtime.sendMessage({ action: 'FETCH_HTML', url: pageObj.url }, (response) => {
                const err = chrome.runtime.lastError;
                if (err || !response || !response.success || !response.html) {
                    // 自動指數重試（最多 3 次）
                    if (retryCount < 3) {
                        const nextRetryDelay = (retryCount + 1) * 1200;
                        if (overlay) {
                            overlay.innerHTML = `
                                <div class="spinner"></div>
                                <p style="font-size:12px; opacity:0.8;">第 ${index + 1} 頁請求繁忙，${nextRetryDelay/1000}s 後自動重試 (${retryCount + 1}/3)...</p>
                            `;
                        }
                        setTimeout(() => {
                            loadPageImage(index, retryCount + 1).then(resolve).catch(reject);
                        }, nextRetryDelay);
                        return;
                    }

                    const errMsg = err ? err.message : '連線逾時或網站限制';
                    showErrorPage(index, errMsg);
                    reject(new Error(errMsg));
                    return;
                }

                const imgUrl = extractImgUrl(response.html, pageObj.url);
                if (imgUrl) {
                    const img = document.createElement('img');
                    img.src = imgUrl;
                    img.loading = 'lazy';
                    
                    img.onload = () => {
                        if (overlay) overlay.classList.add('hidden');
                        if (wrapper) wrapper.style.minHeight = '';
                        loadedImagesMap.set(index, imgUrl);
                        resolve();
                    };

                    img.onerror = () => {
                        if (retryCount < 2) {
                            setTimeout(() => {
                                loadPageImage(index, retryCount + 1).then(resolve).catch(reject);
                            }, 1500);
                        } else {
                            showErrorPage(index, '圖片檔案載入失敗');
                            reject(new Error('圖片檔案載入失敗'));
                        }
                    };

                    // 確保不重複插入
                    if (wrapper) {
                        const existingImg = wrapper.querySelector('img');
                        if (existingImg) existingImg.remove();
                        wrapper.insertBefore(img, wrapper.querySelector('.page-actions'));
                    }
                } else {
                    showErrorPage(index, '無法解析圖片連結');
                    reject(new Error('無法解析圖片連結'));
                }
            });
        };

        fetchWithRetry();
    });
}

// 從分頁 HTML 提取真實圖片路徑
function extractImgUrl(htmlText, pageUrl) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(htmlText, 'text/html');
    let rawSrc = null;

    if (pageUrl.includes('nhentai.net')) {
        const img = doc.querySelector('#image-container img') || doc.querySelector('.image-container img');
        if (img) {
            rawSrc = img.getAttribute('src') || img.dataset.src || img.getAttribute('data-src');
        }
        // 正則備援：直接從 HTML 文字匹配 nhentai 圖片 CDN URL
        if (!rawSrc) {
            const m = htmlText.match(/(?:https:)?\/\/(?:i\d*|t\d*)\.nhentai\.net\/galleries\/[^\s"'>]+/i);
            if (m) rawSrc = m[0];
        }
    } else if (pageUrl.includes('e-hentai.org') || pageUrl.includes('exhentai.org')) {
        const img = doc.getElementById('img') || doc.querySelector('img#img') || doc.querySelector('#i3 img');
        if (img) {
            rawSrc = img.getAttribute('src') || img.dataset.src || img.getAttribute('data-src');
        }
        // 正則備援：直接從 HTML 匹配 img#img 的 src
        if (!rawSrc) {
            const m = htmlText.match(/id="img"[^>]*src="([^"]+)"/i) || htmlText.match(/src="(https?:\/\/[^"]+\.(?:jpg|png|gif|webp)[^"]*)"/i);
            if (m) rawSrc = m[1];
        }
    }

    if (!rawSrc) return null;

    // 自動補全網址協定與相對路徑
    if (rawSrc.startsWith('//')) {
        return 'https:' + rawSrc;
    } else if (rawSrc.startsWith('/')) {
        const origin = new URL(pageUrl).origin;
        return origin + rawSrc;
    }
    return rawSrc;
}

// 顯示載入錯誤介面
function showErrorPage(index, errorMsg) {
    loadedImagesMap.delete(index);
    const overlay = document.getElementById(`overlay-${index}`);
    if (overlay) {
        overlay.innerHTML = `
            <div class="error-container">
                <p>❌ 第 ${index + 1} 頁載入失敗</p>
                <small style="color: #ff8b8b; opacity: 0.9;">${errorMsg}</small>
                <button class="retry-btn" onclick="retryLoadPage(${index})">重試</button>
            </div>
        `;
    }
}

// 重試載入
window.retryLoadPage = async (index) => {
    loadedImagesMap.delete(index);
    const overlay = document.getElementById(`overlay-${index}`);
    if (overlay) {
        overlay.classList.remove('hidden');
        overlay.innerHTML = `
            <div class="spinner"></div>
            <p>正在重試載入第 ${index + 1} 頁...</p>
        `;
    }
    try {
        await loadPageImage(index, 0);
    } catch (e) {
        console.error('手動重試失敗:', e);
    }
};

// 翻譯單頁
async function translateSinglePage(index) {
    const wrapper = document.getElementById(`page-wrapper-${index}`);
    const imgUrl = loadedImagesMap.get(index);
    
    if (!imgUrl || imgUrl === 'loading') {
        alert('請等待圖片下載完成後再進行翻譯！');
        return;
    }

    const overlay = document.getElementById(`overlay-${index}`);
    overlay.classList.remove('hidden');
    overlay.innerHTML = `
        <div class="spinner"></div>
        <p>正在翻譯此頁...</p>
    `;

    chrome.runtime.sendMessage({
        action: 'retranslateImage',
        url: imgUrl,
        mangaKey: activeMangaKey
    }, (response) => {
        overlay.classList.add('hidden');
        if (chrome.runtime.lastError || !response || !response.results) {
            alert('翻譯此頁失敗：' + (chrome.runtime.lastError?.message || response?.error || '未知錯誤'));
            return;
        }

        renderDialogueResults(index, response.results);
    });
}

// 渲染翻譯對話框結果 (加在圖片下方以折疊/展開展示)
function renderDialogueResults(index, results) {
    const wrapper = document.getElementById(`page-wrapper-${index}`);
    let resultsDiv = wrapper.querySelector('.page-translation-results');
    
    if (resultsDiv) resultsDiv.remove();

    resultsDiv = document.createElement('div');
    resultsDiv.className = 'page-translation-results';
    resultsDiv.style.cssText = `
        width: 100%;
        background-color: var(--card-bg);
        border: 1px solid var(--border-color);
        border-radius: 8px;
        padding: 15px;
        margin-top: 10px;
        font-size: 13px;
        box-shadow: 0 4px 15px rgba(0,0,0,0.15);
    `;

    const title = document.createElement('div');
    title.style.cssText = 'font-weight: bold; margin-bottom: 10px; color: var(--accent-color); display: flex; justify-content: space-between; align-items: center;';
    title.innerHTML = `
        <span>💬 譯文對照結果 (P. ${index + 1})</span>
        <button style="background: none; border: none; color: #ff3b30; cursor: pointer;" onclick="this.parentNode.parentNode.remove()">關閉</button>
    `;
    resultsDiv.appendChild(title);

    results.forEach(res => {
        const row = document.createElement('div');
        row.style.cssText = 'padding: 8px 0; border-bottom: 1px solid var(--border-color);';
        row.innerHTML = `
            <div style="font-weight: 500; color: var(--accent-color); margin-bottom: 3px;">${res.translation}</div>
            <div style="opacity: 0.6; font-size: 11px;">🇯🇵 ${res.original}</div>
        `;
        resultsDiv.appendChild(row);
    });

    wrapper.appendChild(resultsDiv);
}

// 翻譯所有頁面：開啟獨立的 result.html 圖文對照翻譯分頁
async function translateAllPages() {
    btnTransAll.disabled = true;
    const oldText = btnTransAll.innerHTML;
    btnTransAll.innerHTML = '⏳ 準備翻譯資料中...';

    // 收集所有頁面的圖片 URL 清單
    const imagesToTranslate = [];
    for (let i = 0; i < totalPages; i++) {
        let imgUrl = loadedImagesMap.get(i);
        if (!imgUrl || imgUrl === 'loading') {
            const pageObj = mangaData.pages[i];
            if (pageObj && pageObj.url) imgUrl = pageObj.url;
        }
        if (imgUrl && imgUrl !== 'loading') {
            imagesToTranslate.push(imgUrl);
        }
    }

    if (imagesToTranslate.length === 0) {
        alert('目前未找到有效的圖片可發送翻譯！請確認圖片加載進度。');
        btnTransAll.disabled = false;
        btnTransAll.innerHTML = oldText;
        return;
    }

    // 發送給 Background 開啟全新的 result.html 進行經典圖文對照與批次翻譯！
    chrome.runtime.sendMessage({
        action: 'START_MANGA_BATCH_PC_MODE',
        payload: {
            images: imagesToTranslate,
            navLinks: mangaData.navLinks || null,
            mangaKey: activeMangaKey,
            displayName: mangaData.title || activeMangaKey
        }
    }, (response) => {
        btnTransAll.disabled = false;
        btnTransAll.innerHTML = oldText;
        if (chrome.runtime.lastError) {
            alert('開啟翻譯分頁失敗: ' + chrome.runtime.lastError.message);
        } else {
            console.log('[StreamReader] 成功發送全本翻譯，已開啟 result.html！');
        }
    });
}

// 導航到其他章節
function navigateToChapter(url) {
    if (confirm('即將跳轉到其他章節，是否確認？')) {
        window.location.href = url;
    }
}

// 打包下載 ZIP
function downloadZip() {
    const urls = [];
    for (let i = 0; i < totalPages; i++) {
        const u = loadedImagesMap.get(i);
        if (u && u !== 'loading') {
            urls.push(u);
        }
    }

    if (urls.length < totalPages) {
        if (!confirm(`目前僅成功載入 ${urls.length} / ${totalPages} 頁圖片。繼續下載將只打包已載入的圖片，是否繼續？`)) {
            return;
        }
    }

    btnDownloadZip.innerText = '📦 打包中...';
    btnDownloadZip.disabled = true;

    chrome.runtime.sendMessage({
        action: 'DOWNLOAD_IMAGES_ZIP',
        urls: urls,
        filename: `${mangaData.title || 'Manga'}_${mangaData.id || Date.now()}.zip`
    }, (response) => {
        btnDownloadZip.innerText = '📦 打包下載';
        btnDownloadZip.disabled = false;
        if (chrome.runtime.lastError || !response || !response.success) {
            alert('打包下載失敗：' + (chrome.runtime.lastError?.message || response?.error || '未知錯誤'));
        }
    });
}

// 寬度滑桿監聽
widthSlider.oninput = () => {
    const w = widthSlider.value;
    widthVal.textContent = w + 'px';
    document.querySelectorAll('.page-wrapper').forEach(el => {
        el.style.width = w + 'px';
    });
};

// 🌓 切換主題
btnToggleTheme.onclick = () => {
    const isDark = document.body.classList.toggle('theme-dark');
    chrome.storage.local.set({ mt_theme: isDark ? 'dark' : 'light' });
};

// 返回頂端按鈕
window.onscroll = () => {
    if (document.body.scrollTop > 400 || document.documentElement.scrollTop > 400) {
        btnScrollTop.classList.add('visible');
    } else {
        btnScrollTop.classList.remove('visible');
    }
};

btnScrollTop.onclick = () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
};

// 全頁翻譯按鈕
btnTransAll.onclick = translateAllPages;

// 打包下載按鈕
btnDownloadZip.onclick = downloadZip;

// 初始化
loadMangaData();
