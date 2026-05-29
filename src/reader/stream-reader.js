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
    activeMangaKey = mangaData.titleKey || mangaData.id;
    totalPages = mangaData.pages ? mangaData.pages.length : 0;
    
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

    // 2. 啟動 Intersection Observer 僅用於更新頂部當前閱讀頁碼
    const observerOptions = {
        root: null,
        rootMargin: '100px 0px',
        threshold: 0.1
    };

    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                const index = parseInt(entry.target.dataset.index);
                currentPageEl.textContent = index + 1;
            }
        });
    }, observerOptions);

    document.querySelectorAll('.page-wrapper').forEach(el => {
        observer.observe(el);
        pageObservers.push({ element: el, observer });
    });

    // 3. 立刻啟動自動背景併發佇列下載圖片
    startBackgroundDownloadQueue();
}

// 自動背景下載佇列主邏輯 (將併發數提升至 5，此為 N網 官方預載的安全限流上限，兼顧極速與防封鎖)
async function startBackgroundDownloadQueue() {
    progressBar.style.display = 'block';
    progressFill.style.width = '0%';
    progressText.textContent = `正在預載圖片中... (0 / ${totalPages})`;

    const queue = Array.from({ length: totalPages }, (_, i) => i);
    const maxConcurrency = 5;
    let activeWorkers = 0;
    let completedCount = 0;

    const runWorker = async () => {
        while (queue.length > 0) {
            const index = queue.shift();
            activeWorkers++;
            
            try {
                // 更新該頁的 UI Loading 狀態為「正在下載...」
                const overlayText = document.getElementById(`overlay-text-${index}`);
                if (overlayText) overlayText.textContent = `正在下載中... (P. ${index + 1})`;

                await loadPageImage(index);
            } catch (err) {
                console.error(`P.${index + 1} 載入失敗:`, err);
            } finally {
                activeWorkers--;
                completedCount++;
                const percent = Math.round((completedCount / totalPages) * 100);
                progressFill.style.width = percent + '%';
                progressText.textContent = `正在預載圖片中: ${completedCount} / ${totalPages} (${percent}%)`;
            }
        }

        // 所有圖片下載緩存完畢
        if (completedCount === totalPages) {
            progressFill.style.width = '100%';
            progressText.textContent = `🎉 所有圖片預載快取完成！`;
            btnDownloadZip.innerHTML = '📦 瞬間打包下載 (已就緒)';
            setTimeout(() => {
                progressBar.style.display = 'none';
            }, 3000);
        }
    };

    // 啟動併發工作線程
    const workers = Array.from({ length: Math.min(maxConcurrency, totalPages) }, () => runWorker());
    await Promise.all(workers);
}

// 載入單一頁面的真實圖片連結 (Promise 化以配合併發佇列)
function loadPageImage(index) {
    return new Promise((resolve, reject) => {
        const wrapper = document.getElementById(`page-wrapper-${index}`);
        const overlay = document.getElementById(`overlay-${index}`);
        
        if (loadedImagesMap.has(index)) {
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

        chrome.runtime.sendMessage({ action: 'FETCH_HTML', url: pageObj.url }, (response) => {
            if (chrome.runtime.lastError || !response || !response.success || !response.html) {
                const errMsg = chrome.runtime.lastError ? chrome.runtime.lastError.message : '背景網頁抓取失敗';
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
                    overlay.classList.add('hidden');
                    wrapper.style.minHeight = ''; // 清除固定高度
                    loadedImagesMap.set(index, imgUrl);
                    resolve();
                };

                img.onerror = () => {
                    showErrorPage(index, '圖片檔案載入失敗');
                    reject(new Error('圖片檔案載入失敗'));
                };

                wrapper.insertBefore(img, wrapper.querySelector('.page-actions'));
            } else {
                showErrorPage(index, '無法解析圖片連結');
                reject(new Error('無法解析圖片連結'));
            }
        });
    });
}

// 從分頁 HTML 提取真實圖片路徑
function extractImgUrl(htmlText, pageUrl) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(htmlText, 'text/html');
    if (pageUrl.includes('nhentai.net')) {
        const img = doc.querySelector('#image-container img');
        return img ? img.src : null;
    } else if (pageUrl.includes('e-hentai.org') || pageUrl.includes('exhentai.org')) {
        const img = doc.getElementById('img');
        return img ? img.src : null;
    }
    return null;
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
    const overlay = document.getElementById(`overlay-${index}`);
    if (overlay) {
        overlay.innerHTML = `
            <div class="spinner"></div>
            <p>正在重試第 ${index + 1} 頁...</p>
        `;
    }
    try {
        await loadPageImage(index);
    } catch (e) {
        console.error('重試失敗:', e);
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

// 翻譯所有頁面
async function translateAllPages() {
    if (isTranslatingAll) return;
    isTranslatingAll = true;
    btnTransAll.disabled = true;
    progressBar.style.display = 'block';

    let successCount = 0;
    let totalToTranslate = totalPages;

    for (let i = 0; i < totalPages; i++) {
        // 更新進度
        const percent = Math.round((i / totalPages) * 100);
        progressFill.style.width = percent + '%';
        progressText.textContent = `全頁翻譯中: ${i + 1} / ${totalPages} (${percent}%)`;

        // 確保圖片已載入
        let imgUrl = loadedImagesMap.get(i);
        if (!imgUrl || imgUrl === 'loading') {
            // 嘗試載入或等待
            loadPageImage(i);
            await new Promise(resolve => setTimeout(resolve, 1500));
            imgUrl = loadedImagesMap.get(i);
        }

        if (imgUrl && imgUrl !== 'loading') {
            try {
                const response = await new Promise(resolve => {
                    chrome.runtime.sendMessage({
                        action: 'retranslateImage',
                        url: imgUrl,
                        mangaKey: activeMangaKey
                    }, resolve);
                });

                if (response && response.results) {
                    renderDialogueResults(i, response.results);
                    successCount++;
                }
            } catch (e) {
                console.error(`P.${i + 1} translate failed:`, e);
            }
        }
    }

    progressFill.style.width = '100%';
    progressText.textContent = `翻譯完成！成功 ${successCount} / ${totalPages} 頁`;
    setTimeout(() => {
        progressBar.style.display = 'none';
        isTranslatingAll = false;
        btnTransAll.disabled = false;
    }, 3000);
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
