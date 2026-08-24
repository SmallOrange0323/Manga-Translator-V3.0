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
/**
 * 抓取網頁中的實體大圖 (包含 GigaViewer / Comic-y-ours 等日本電子漫畫閱讀器專屬解析)
 */
/**
 * 將網頁上由 CSS/DOM 切割拼圖 (Scrambled DOM Tiles) 組成的漫畫頁面，照相對座標自動重繪還原為整張無打亂圖片
 */
function tryReconstructScrambledDOM(containerEl) {
    if (!containerEl) return null;
    const pieces = Array.from(containerEl.querySelectorAll('div, span, canvas, img')).filter(p => {
        const r = p.getBoundingClientRect();
        return r.width > 20 && r.height > 20;
    });

    if (pieces.length >= 4) {
        const cRect = containerEl.getBoundingClientRect();
        if (cRect.width < 200 || cRect.height < 200) return null;

        const canvas = document.createElement('canvas');
        const scale = 2; // 高清 2x 採樣
        canvas.width = Math.round(cRect.width * scale);
        canvas.height = Math.round(cRect.height * scale);
        const ctx = canvas.getContext('2d');
        ctx.scale(scale, scale);

        let drewCount = 0;
        pieces.forEach(p => {
            const pRect = p.getBoundingClientRect();
            const relX = pRect.left - cRect.left;
            const relY = pRect.top - cRect.top;

            const tagName = p.tagName.toLowerCase();
            if ((tagName === 'img' || tagName === 'canvas') && p.width > 0) {
                try {
                    ctx.drawImage(p, relX, relY, pRect.width, pRect.height);
                    drewCount++;
                } catch(e) {}
            } else {
                const style = window.getComputedStyle(p);
                const bgUrl = style.backgroundImage;
                if (bgUrl && bgUrl.startsWith('url(')) {
                    const match = bgUrl.match(/url\(['"]?(.*?)['"]?\)/);
                    if (match && match[1]) {
                        const tmpImg = new Image();
                        tmpImg.src = match[1];
                        if (tmpImg.complete && tmpImg.naturalWidth > 0) {
                            try {
                                ctx.drawImage(tmpImg, relX, relY, pRect.width, pRect.height);
                                drewCount++;
                            } catch(e) {}
                        }
                    }
                }
            }
        });

        if (drewCount >= 2) {
            try {
                return canvas.toDataURL('image/jpeg', 0.95);
            } catch(e) {}
        }
    }
    return null;
}

/**
 * 智慧極速預滾動：瞬間分段模擬向下滾動觸發頁面所有 IntersectionObserver 與 Scroll-based 懶載入
 */
export async function triggerLazyScroll() {
    try {
        const totalHeight = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight, 3000);
        const winHeight = window.innerHeight || 800;
        
        // 快速分段觸發滾動事件
        for (let y = winHeight; y <= totalHeight; y += winHeight * 1.5) {
            window.scrollTo(0, y);
            window.dispatchEvent(new Event('scroll'));
        }
        // 滾動回原位
        window.scrollTo(0, 0);
        await new Promise(r => setTimeout(r, 120));
    } catch(e) {}
}

export function crawlImages() {
    let mangaImages = [];

    // ── -1. 專屬 DOM 切割拼圖 (Scrambled DOM Tiles) 自動重繪還原 ──
    const pageContainers = Array.from(document.querySelectorAll('.page-container, .reading-content, .chap-content, [class*="page"], [id*="page"]'));
    pageContainers.forEach(container => {
        const restoredUrl = tryReconstructScrambledDOM(container);
        if (restoredUrl) {
            const r = container.getBoundingClientRect();
            mangaImages.push({
                element: container,
                url: restoredUrl,
                isCanvas: true,
                width: r.width,
                height: r.height
            });
        }
    });

    // ── 0. Canvas 解密還原圖層優先擷取 (針對打亂切割圖檔 Scrambled Canvas DRM) ──
    const canvases = Array.from(document.querySelectorAll('canvas'));
    canvases.forEach(canvas => {
        let width = canvas.width || canvas.offsetWidth || 0;
        let height = canvas.height || canvas.offsetHeight || 0;
        if (width >= 300 && height >= 300) {
            try {
                const dataUrl = canvas.toDataURL('image/jpeg', 0.95);
                if (dataUrl && dataUrl.length > 1000) {
                    mangaImages.push({
                        element: canvas,
                        url: dataUrl,
                        isCanvas: true,
                        width, height
                    });
                }
            } catch(e) {
                console.warn('[Manga-Engine] Canvas toDataURL 受跨域限制:', e);
            }
        }
    });

    // ── 1. GigaViewer / Comic-y-ours / 生肉網站 JSON 媒體庫專屬自動解析 ──
    try {
        const jsonEl = document.getElementById('episode-json') || document.querySelector('[data-episode-json]');
        if (jsonEl) {
            const rawJson = jsonEl.dataset.episodeJson || jsonEl.dataset.value || jsonEl.textContent || '';
            const data = JSON.parse(rawJson);
            const pages = data?.readableProduct?.pageStructure?.pages || data?.pages || [];
            pages.forEach(p => {
                const src = p.src || p.url || p.image_url;
                if (src) {
                    try {
                        const fullUrl = new URL(src, window.location.href).href;
                        mangaImages.push({ url: fullUrl, width: 800, height: 1200 });
                    } catch(e) {}
                }
            });
        }
    } catch(e) {
        console.warn('[Manga-Engine] GigaViewer JSON 提取失敗，回退至廣用掃描', e);
    }

    // ── 2. <script> 標籤漫畫圖片陣列全域正則掃描器 (生肉網站 Script 變數適配) ──
    try {
        const scripts = Array.from(document.querySelectorAll('script'));
        scripts.forEach(script => {
            const code = script.textContent || '';
            if (!code || code.length > 500000) return;
            
            // 正則匹配包含漫畫副檔名的連續圖片 URL
            const matches = code.match(/https?:\/\/[^\s"'<>]+\.(?:jpg|jpeg|png|webp|gif)(?:\?[^\s"'<>]*)?/gi);
            if (matches && matches.length >= 3) {
                matches.forEach(imgUrl => {
                    const lower = imgUrl.toLowerCase();
                    const isScriptJunk = ['logo', 'avatar', 'icon', 'banner', 'upvote', 'downvote', 'funny', 'love', 'surprised', 'angry', 'vote', 'emoji', 'reaction', '512x512', '256x256', '128x128'].some(k => lower.includes(k));
                    if (!isScriptJunk) {
                        try {
                            const fullUrl = new URL(imgUrl, window.location.href).href;
                            mangaImages.push({ url: fullUrl, width: 800, height: 1200 });
                        } catch(e) {}
                    }
                });
            }
        });
    } catch(e) {
        console.warn('[Manga-Engine] Script 正則抓取失敗:', e);
    }

    // ── 3. 廣用 DOM 與 Canvas 閱讀器容器掃描 (全方位 Lazy 屬性大滿貫) ──
    const imgs = Array.from(document.querySelectorAll('img, canvas, svg image, div[style*="background"], div[class*="page"]'));
    
    // 生肉網站與日本電子漫畫閱讀器常見核心容器
    const MANGA_CONTAINERS = [
        '#list-imga', '#readerarea', '.reading-content', '.ts-main-image', 
        '.manga-image', '.page-break', '.blocks-gallery-item', '.js-page-image', 
        '.viewer-page', '.page-container', '[class*="page-image"]',
        '.chap-content', '.viewer-cnt', '#reader', '.readerarea'
    ];

    imgs.forEach(img => {
        let width = img.naturalWidth || img.width || img.offsetWidth || 0;
        let height = img.naturalHeight || img.height || img.offsetHeight || 0;
        let url = img.src || img.getAttribute('href') || '';
        
        // 全方位 Lazy-Load 屬性大滿貫 (涵蓋 JManga, Madara, WordPress 等生肉網站)
        const lazyAttrs = [
            'data-src', 'data-lazy-src', 'data-original', 'data-src-img', 'data-url', 
            'data-page-src', 'data-full-url', 'data-cdn', 'data-image', 'data-img', 
            'data-path', 'data-file', 'data-image-src', 'data-bg', 'data-actual-src', 'data-aload'
        ];
        
        let dataSrc = null;
        for (const attr of lazyAttrs) {
            dataSrc = img.getAttribute(attr);
            if (dataSrc) break;
        }

        // srcset 與 data-srcset 解析：提取最大寬度的超高清圖片
        const srcSet = img.getAttribute('srcset') || img.getAttribute('data-srcset');
        if (srcSet) {
            try {
                const candidates = srcSet.split(',').map(item => {
                    const parts = item.trim().split(/\s+/);
                    const itemUrl = parts[0];
                    const sizeStr = parts[1] || '0w';
                    const size = parseInt(sizeStr.replace(/[^\d]/g, '')) || 0;
                    return { url: itemUrl, size };
                }).sort((a, b) => b.size - a.size);
                if (candidates.length > 0 && candidates[0].url) {
                    dataSrc = candidates[0].url;
                }
            } catch(e) {}
        }

        // CSS background-image 提取
        if (!dataSrc && !url && img.style && img.style.backgroundImage) {
            const bgMatch = img.style.backgroundImage.match(/url\(['"]?(.*?)['"]?\)/);
            if (bgMatch && bgMatch[1]) {
                dataSrc = bgMatch[1];
            }
        }

        if (dataSrc) {
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
        if (img.tagName && img.tagName.toLowerCase() === 'canvas') {
            try { 
                url = img.toDataURL('image/jpeg'); 
                width = img.width || 800;
                height = img.height || 1200;
            } catch(e) {}
        }
        
        // 判斷是否在漫畫主閱讀容器內
        const isInMangaContainer = MANGA_CONTAINERS.some(selector => img.closest(selector)) || (img.classList && img.classList.contains('chapter-img'));

        // 徹底排除無效雜項容器 (驗證碼、模態框、登入框、麵包屑、導航列、頂部封面、側邊欄)
        const isInJunkBox = !!(img && img.closest && img.closest(
            '.modal, #login, #register, #forgot_password, #modal_baoloi, .modal-dialog, ' +
            '.form-signin, .captcha, .chance-captcha, .breadcrumb, ol.breadcrumb, ' +
            'nav, #header, #header_menu, .navbar, .headroom, .rd_sidebar, ' +
            '.headpost, .thumb, .series-thumb, .thumb-series, .post-thumb, .infox, .bdr, ' +
            '.entry-header, .cover, .series-cover, .sidebar, .widget, .manga-info, .series-info, ' +
            '.anime-info, .series-profile, .reactions, .wp-reactions, .post-ratings, .comment-reactions, ' +
            '.emotion-box, .votes, .social-share, .footer-widgets'
        ));

        // 排除被 CSS 隱藏或 class="hide" 的非閱讀區圖片
        const isHidden = (img.classList && (img.classList.contains('hide') || img.classList.contains('hidden'))) ||
                         (img.style && (img.style.display === 'none' || img.style.visibility === 'hidden'));

        // 獲取畫面上的實際渲染尺寸
        let renderedWidth = 0;
        let renderedHeight = 0;
        if (img && typeof img.getBoundingClientRect === 'function') {
            const rect = img.getBoundingClientRect();
            renderedWidth = rect.width || 0;
            renderedHeight = rect.height || 0;
        }

        // 嚴格尺寸門檻 (漫畫頁面高度普遍 >= 350px, 寬度 >= 250px)
        let isTooSmall = false;
        if (isInMangaContainer) {
            // 漫畫閱讀容器內：排除小於 250x350 的小圖示
            isTooSmall = (width > 0 && width < 250) || (height > 0 && height < 350);
        } else {
            // 容器外：嚴格限制
            const isNaturalSmall = (width > 0 && width < 500) || (height > 0 && height < 400);
            const isRenderedSmall = (renderedWidth > 0 && renderedWidth < 300) || (renderedHeight > 0 && renderedHeight < 350);
            isTooSmall = isNaturalSmall || isRenderedSmall || isInJunkBox || isHidden;
        }

        const isUnloadedJunk = (width === 0 || height === 0) && !isInMangaContainer && !dataSrc;
        
        // 垃圾關鍵字大滿貫 (徹底排除選單、加載轉輪、驗證碼、頭像、評分圖標、訪客計數器)
        const junkKeywords = [
            'chance-load', 'captcha', 'lzloader', 'lzloader1', 'loader', 'spin', 'spinner',
            'loading', 'placeholder', 'emoji', 'avatar', 'icon', 'logo', 'button', 'banner', 'reaction',
            'thumb', 'small', 'widget', 'social', 'badge', 'ad-', 'comment',
            'footer', 'header', 'nav', 'share', 'profile', 'upvote', 'downvote',
            'funny', 'love', 'surprised', 'angry', 'vote', 'rating', 'emoticon', 'stickers',
            'smilies', 'dislike', 'thumbs-up', 'thumbs-down', 'wp-reactions', 'post-ratings', 'emotion',
            'counter', 'whos.amung.us', 'hits', 'visitor', 'online', 'flagcounter', 'stat',
            'histats', 'tracker', 'clustrmaps', 'fc2.com', '99counter', 'cbox', 'user_online',
            'users_online', 'viewcount', 'traffic'
        ];
        const isJunkUrl = junkKeywords.some(key => url && url.toLowerCase().includes(key));
        
        // 排除小於 800px 的 GIF 動畫加載圖 (漫畫正頁絕非小 GIF)
        const isGifLoader = url && url.toLowerCase().includes('.gif') && (width < 800 || height < 800 || isJunkUrl);

        // 正方形表情/評分圖標特徵排除
        const isSquareReactionIcon = /(?:512x512|256x256|128x128|64x64|48x48|96x96|150x150|300x300)/i.test(url || '') || 
                                     (width > 0 && height > 0 && width <= 600 && height <= 600 && Math.abs(width - height) < 10 && isJunkUrl);

        if (!isTooSmall && !isUnloadedJunk && !isJunkUrl && !isGifLoader && !isSquareReactionIcon && !isInJunkBox && !isHidden && url) {
            if (!url.includes('data:image/svg+xml') && !url.includes('data:image/gif;base64,R0lGOD')) {
                mangaImages.push({
                    element: img,
                    url: url,
                    isInMangaContainer,
                    width, height
                });
            }
        }
    });

    // ── 智慧主閱讀區優先 (Container Domination) ──
    // 若檢測到主閱讀容器內已有 2 張以上漫畫頁，則直接捨棄所有容器外的雜項外部圖片
    const containerImages = mangaImages.filter(m => m.isInMangaContainer);
    let candidatePool = mangaImages;
    if (containerImages.length >= 2) {
        candidatePool = containerImages;
    }

    // 智慧型去重與 Canvas 還原圖優先：若存在 Canvas 解密還原圖，優先採用 Canvas 避免被打亂的原始圖檔取代
    const canvasImages = candidatePool.filter(m => m.isCanvas);
    let finalImages = candidatePool;
    if (canvasImages.length > 0) {
        finalImages = canvasImages;
    }

    const uniqueUrls = [...new Set(finalImages.map(m => m.url))];
    const navLinks = detectNavigationLinks();
    
    return {
        images: uniqueUrls.map(url => ({ src: url })),
        navLinks: navLinks
    };
}
