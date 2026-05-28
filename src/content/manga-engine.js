// src/content/manga-engine.js
import { detectNavigationLinks } from '../utils/nav-detector.js';

let overlay = null;
let selectionBox = null;
let startX = 0, startY = 0;
let isSelecting = false;
let mangaImages = [];

/**
 * 初始化並切換選取遮罩
 */
export function toggleSelectionMode() {
    if (overlay) {
        removeOverlay();
    } else {
        createOverlay();
    }
}

function createOverlay() {
    overlay = document.createElement('div');
    overlay.id = 'mt-manga-overlay';
    // 樣式利用注入或寫死
    overlay.style.position = 'fixed';
    overlay.style.top = '0';
    overlay.style.left = '0';
    overlay.style.width = '100vw';
    overlay.style.height = '100vh';
    overlay.style.backgroundColor = 'rgba(0, 0, 0, 0.4)';
    overlay.style.cursor = 'crosshair';
    overlay.style.zIndex = '2147483647'; // 極大值
    
    // 選取方塊
    selectionBox = document.createElement('div');
    selectionBox.id = 'mt-manga-selectionBox';
    selectionBox.style.position = 'fixed';
    selectionBox.style.border = '2px dashed #008CBA';
    selectionBox.style.backgroundColor = 'rgba(0, 140, 186, 0.2)';
    selectionBox.style.display = 'none';
    selectionBox.style.zIndex = '2147483647';
    overlay.appendChild(selectionBox);

    overlay.addEventListener('mousedown', onMouseDown);
    overlay.addEventListener('mousemove', onMouseMove);
    overlay.addEventListener('mouseup', onMouseUp);
    
    // 攔截右鍵取消
    overlay.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        removeOverlay();
    });

    document.body.appendChild(overlay);
}

function removeOverlay() {
    if (overlay) {
        overlay.remove();
        overlay = null;
        selectionBox = null;
    }
}

function onMouseDown(e) {
    if (e.button !== 0) return; // 僅回應左鍵
    isSelecting = true;
    startX = e.clientX;
    startY = e.clientY;
    selectionBox.style.left = `${startX}px`;
    selectionBox.style.top = `${startY}px`;
    selectionBox.style.width = '0px';
    selectionBox.style.height = '0px';
    selectionBox.style.display = 'block';
    
    // 預先觸發 Edge 截圖黑屏 Workaround
    chrome.runtime.sendMessage({ action: "PRE_CAPTURE_FOR_SELECTION" });
}

function onMouseMove(e) {
    if (!isSelecting) return;
    const currentX = e.clientX;
    const currentY = e.clientY;
    
    const width = Math.abs(currentX - startX);
    const height = Math.abs(currentY - startY);
    const left = Math.min(currentX, startX);
    const top = Math.min(currentY, startY);
    
    selectionBox.style.width = `${width}px`;
    selectionBox.style.height = `${height}px`;
    selectionBox.style.left = `${left}px`;
    selectionBox.style.top = `${top}px`;
}

function onMouseUp(e) {
    if (!isSelecting) return;
    isSelecting = false;
    
    const width = Math.abs(e.clientX - startX);
    const height = Math.abs(e.clientY - startY);
    const left = Math.min(e.clientX, startX);
    const top = Math.min(e.clientY, startY);
    
    if (width > 10 && height > 10) {
        const dpr = window.devicePixelRatio || 1;
        const rect = {
            x: Math.round(left * dpr),
            y: Math.round(top * dpr),
            width: Math.round(width * dpr),
            height: Math.round(height * dpr)
        };
        
        // 發送給背景處理 (依賴 Background 去呼叫 Vision)
        processScreenSelection(rect, selectionBox);
    } else {
        removeOverlay(); // 解除選取
    }
}

async function processScreenSelection(rect, domBox) {
    // 轉成 Loading 狀態
    domBox.style.border = '2px solid #4CAF50';
    domBox.style.backgroundColor = 'rgba(76, 175, 80, 0.4)';
    domBox.style.display = 'flex';
    domBox.style.alignItems = 'center';
    domBox.style.justifyContent = 'center';
    domBox.style.color = '#fff';
    domBox.style.fontWeight = 'bold';
    domBox.style.fontSize = '14px';
    domBox.style.textShadow = '1px 1px 2px #000';
    domBox.innerHTML = '<span class="mt-loader" style="margin-right:8px; display:inline-block; width:16px; height:16px; border:2px solid #fff; border-top-color:transparent; border-radius:50%; animation:mt-spin 1s linear infinite;"></span>處理中...';

    // 取得當前捲動偏移量 (為了絕對定位)
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    
    // 這裡我們需要一個對應關係與絕對座標
    const absoluteRect = {
        left: parseFloat(domBox.style.left) + scrollX,
        top: parseFloat(domBox.style.top) + scrollY,
        width: parseFloat(domBox.style.width),
        height: parseFloat(domBox.style.height)
    };

    chrome.runtime.sendMessage({ 
        action: "PROCESS_SCREENSHOT", 
        rect: rect 
    }, (response) => {
        removeOverlay();
        
        if (response && response.success) {
            // 關鍵修正：解析由黃金 Prompt 產生的陣列結構
            const results = response.result?.results;
            if (results && results.length > 0) {
                const combinedTranslation = results.map(r => r.translation).join('\n\n');
                renderTranslationAt(absoluteRect, combinedTranslation);
            } else {
                console.warn('[Manga Engine] No results found in AI response');
            }
        } else {
            console.warn('[Manga Engine] Screenshot translation failed:', response?.error);
        }
    });
}

function renderTranslationAt(rect, translatedText) {
    const box = document.createElement('div');
    box.className = 'mt-floating-translation';
    box.style.position = 'absolute';
    box.style.left = `${rect.left}px`;
    box.style.top = `${rect.top}px`;
    box.style.width = `${rect.width}px`;
    box.style.height = `${rect.height}px`;
    box.style.backgroundColor = 'rgba(255, 255, 255, 0.9)';
    box.style.color = '#000';
    box.style.padding = '5px';
    box.style.boxSizing = 'border-box';
    box.style.borderRadius = '5px';
    box.style.border = '2px solid #4CAF50';
    box.style.zIndex = '2147483646'; // 小於 Overlay
    box.style.overflow = 'hidden';
    box.style.display = 'flex';
    box.style.alignItems = 'center';
    box.style.justifyContent = 'center';
    box.style.fontFamily = 'sans-serif';
    box.style.fontWeight = 'bold';
    box.style.boxShadow = '0 4px 6px rgba(0,0,0,0.3)';
    
    // 預設字體大小計算 (根據框框大小)
    let fontSize = Math.max(12, Math.min(24, Math.floor(rect.height / 5)));
    box.style.fontSize = `${fontSize}px`;
    box.innerText = translatedText;

    // 允許點擊關閉
    box.style.cursor = 'pointer';
    box.onclick = () => box.remove();

    document.body.appendChild(box);
}

// 動態注入 Spinner CSS
const style = document.createElement('style');
style.innerHTML = `
@keyframes mt-spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
`;
document.head.appendChild(style);

/**
 * 抓取網頁中的實體大圖 (過濾小圖示)
 */
export function crawlImages() {
    const imgs = Array.from(document.querySelectorAll('img, canvas'));
    let mangaImages = [];
    
    // 定義常見漫畫網站的閱讀器容器
    const MANGA_CONTAINERS = ['.ts-main-image', '.reading-content', '#readerarea', '.manga-image', '.page-break', '.blocks-gallery-item'];

    imgs.forEach(img => {
        let width = img.naturalWidth || img.width || img.offsetWidth;
        let height = img.naturalHeight || img.height || img.offsetHeight;
        let url = img.src; // 取得預設解析的絕對路徑
        
        // Lazy Load 處理：真實圖片通常在特殊屬性中
        const lazyAttrs = ['data-src', 'data-lazy-src', 'data-original', 'data-src-img', 'data-url'];
        let dataSrc = null;
        for (const attr of lazyAttrs) {
            dataSrc = img.getAttribute(attr);
            if (dataSrc) break;
        }

        if (dataSrc) {
            // 由於 data-src 可能是相對路徑，必須轉為絕對路徑
            try {
                if (dataSrc.startsWith('//')) {
                    url = window.location.protocol + dataSrc;
                } else if (!dataSrc.startsWith('http') && !dataSrc.startsWith('data:')) {
                    url = new URL(dataSrc, window.location.href).href;
                } else {
                    url = dataSrc;
                }
            } catch(e) {
                url = dataSrc;
            }
        }

        // Canvas 處理
        if (img.tagName.toLowerCase() === 'canvas') {
            try { url = img.toDataURL('image/jpeg'); } catch(e) {}
        }
        
        // 判斷是否在漫畫容器內
        const isInMangaContainer = MANGA_CONTAINERS.some(selector => img.closest(selector));

        // 過濾條件優化：
        // 1. 智慧型尺寸過濾門檻：分流處理在容器內與不在容器內的情況
        let isTooSmall = false;
        if (isInMangaContainer) {
            // 常見容器內：放寬限制。寬度小於 300px，或高度小於 100px 判定為尺寸不足
            isTooSmall = (width > 0 && width < 300) || (height > 0 && height < 100);
        } else {
            // 容器外（依照使用者反饋提高門檻）：嚴格限制。寬度小於 600px，或高度小於 300px 判定為尺寸不足
            isTooSmall = (width > 0 && width < 600) || (height > 0 && height < 300);
        }

        // 2. 若寬高為 0 (未加載) 但不在常見漫畫閱讀容器中，也判定為非目標雜訊
        const isUnloadedJunk = (width === 0 || height === 0) && !isInMangaContainer;

        // 3. 過濾明顯非漫畫的垃圾關鍵字網址
        const junkKeywords = ['emoji', 'avatar', 'icon', 'logo', 'button', 'banner', 'reaction'];
        const isJunk = junkKeywords.some(key => url && url.toLowerCase().includes(key));

        // 4. 不是太小的圖片、不是未載入的非容器雜訊、且不包含垃圾關鍵字
        if (!isTooSmall && !isUnloadedJunk && !isJunk) {
            // 過濾掉明顯是 Logo 或小 Icon 的 base64 碎圖
            if (url && !url.includes('data:image/svg+xml') && !url.includes('data:image/gif;base64,R0lGOD')) {
                mangaImages.push({
                    element: img,
                    url: url,
                    width, height
                });
            }
        }
    });

    // 移除重複 URL 並轉換為側邊欄需要的結構
    const uniqueUrls = [...new Set(mangaImages.map(m => m.url))];
    const navLinks = detectNavigationLinks();
    
    return {
        images: uniqueUrls.map(url => ({ src: url })),
        navLinks: navLinks
    };
}
