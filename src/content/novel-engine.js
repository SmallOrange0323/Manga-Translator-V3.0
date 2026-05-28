// src/content/novel-engine.js
/**
 * NovelEngine: 經典小說 DOM 偵測、譯文注入與全網頁 UI 翻譯核心
 * 完美移植自 V1.8.6 經典版實戰邏輯，適配 V2.0 模組化架構
 */

import { log } from '../utils/logger.js';

// 經典款小說與標題選擇器列表，涵蓋小說家新舊版及通用網生小說平台結構
const NOVEL_SELECTORS = [
    '.novel_title',          // 作品標題
    '.chapter_title',        // 章節標題
    '.novel_subtitle',       // 小說子標題
    '.novel_writername',     // 作者姓名
    '#novel_honbun p',       // 舊版 syosetu 正文
    '.p-novel__body p',      // 新版 syosetu 正文
    '.p-novel__title',       // 新版標題
    '.p-novel__author',      // 新版作者
    '#novel_p',              // 小說前言 (Preface)
    '#novel_a',              // 小說後記 (Afterword)
    '.novel_ex',             // 作品簡介
    '.subtitle',             // 一般子標題
    '.index_box .index_t',   // 目錄中的卷標題
    '.index_box .subtitle a',// 目錄中的章節連結
    '#novel_view p',         
    '.novel_view p',         
    'p.novel_view',          
    '[class*="honbun"] p',   
    '[id*="honbun"] p',      
    '.c-announce a',         // 舊版小說家作品名與作者連結
    '.c-announce span',      // 舊版小說家序章/說明資訊
];

// 本地模組級變數：快取最近一次翻譯的段落引用與作品 Key，避免重複掃描 DOM 與確保術語新增正常
let novelParagraphsRef = [];
let currentMangaKey = null;

/** 
 * 1. 抓取章節內容段落，相容各式小說佈局
 */
export function getNovelParagraphs() {
    // 假名安全鎖 (Kana Safety Check)：全網頁平假名與片假名掃描，過濾完全不含日文的網頁
    const pageText = document.body ? document.body.textContent : '';
    if (!/[\u3040-\u309F\u30A0-\u30FF]/.test(pageText)) {
        log.info('NovelEngine', '偵測到網頁完全不含日文假名，判定為非日文小說頁面');
        return [];
    }

    let result = [];
    let seen = new Set();

    // 聯集選擇器查詢，100% 確保符合 DOM 的自然順序，保證標題在最前列
    const unionSelector = NOVEL_SELECTORS.join(', ');
    document.querySelectorAll(unionSelector).forEach(el => {
        if (!seen.has(el) && el.textContent.trim().length > 0) {
            seen.add(el);
            result.push(el);
        }
    });

    if (result.length > 0) {
        log.info('NovelEngine', `使用聯集選擇器以 DOM 自然順序找到 ${result.length} 個小說段落`);
        novelParagraphsRef = result; // 快取引用
        return result;
    }

    // 通用 fallback：抓取頁面上所有含日文字元的 <p> 段落
    const allJpParas = Array.from(document.querySelectorAll('p')).filter(p => {
        const text = p.textContent.trim();
        return text.length > 0 && /[\u3040-\u9FFF]/.test(text);
    });

    if (allJpParas.length > 0) {
        log.info('NovelEngine', `通用模式：找到 ${allJpParas.length} 個含日文內容的 <p> 段落`);
        novelParagraphsRef = allJpParas; // 快取引用
        return allJpParas;
    }

    log.warn('NovelEngine', '所有選擇器均未找到小說段落');
    return [];
}

/**
 * 取得特定段落去除中文譯文後的乾淨日文原文，供主入口重譯佇列使用
 */
export function getParagraphText(idx) {
    const p = novelParagraphsRef[idx];
    if (!p) return '';
    const clone = p.cloneNode(true);
    const trans = clone.querySelectorAll('.mt-novel-trans');
    trans.forEach(el => el.remove());
    return clone.textContent.trim();
}

/** 
 * 2. 在每個 <p> 段落後方插入「翻譯中...」兄弟佔位符 (after)
 * 完美避免 p.appendChild 破壞原網頁結構
 */
export function insertPlaceholders(paragraphs) {
    injectStyles(); // 確保樣式已注入
    
    paragraphs.forEach((p, i) => {
        // 標記為正文區塊，防止 UI 翻譯重複處理
        p.dataset.mtNovelBody = "true";
        
        // 避免重複插入
        if (p.nextElementSibling && p.nextElementSibling.classList.contains('mt-novel-trans')) return;
        
        // 依元素類型決定佔位符標籤（避免在 <a>/<span> 後插入 block div 破壞目錄版面）
        const isInline = ['a', 'span', 'em', 'strong'].includes(p.tagName.toLowerCase());
        const placeholder = document.createElement(isInline ? 'span' : 'div');
        placeholder.className = 'mt-novel-trans mt-novel-placeholder';
        placeholder.dataset.novelIdx = i;
        placeholder.textContent = '⏳';
        
        p.after(placeholder);
    });
}

/**
 * 3. 收到批次翻譯結果，精確替換佔位符
 * 支援 1:1 精確對位、淡入動畫、雙語動作按鈕及重試邏輯，徹底解決 2.0 段落漏失 Bug
 */
export function injectNovelBatchResult(batchIndex, translations, retryIndices, isFailed = false) {
    // 從 sessionStorage 或全域動態讀取 batchSize
    const BATCH_SIZE = window.mt_currentNovelBatchSize || 50;
    const isRetry = Array.isArray(retryIndices) && retryIndices.length > 0;
    
    translations.forEach((text, i) => {
        const globalIdx = isRetry ? retryIndices[i] : (batchIndex * BATCH_SIZE + i);
        if (globalIdx === undefined) return;
        
        const placeholder = document.querySelector(`.mt-novel-trans[data-novel-idx="${globalIdx}"]`);
        if (!placeholder) return;

        // 使用快取的段落引用，避免反覆掃描 DOM 提升效率
        const sourceEl = novelParagraphsRef[globalIdx];
        const isInline = sourceEl && ['a', 'span', 'em', 'strong'].includes(sourceEl.tagName.toLowerCase());
        const transBlock = document.createElement(isInline ? 'span' : 'div');
        transBlock.className = 'mt-novel-trans';
        transBlock.dataset.novelIdx = globalIdx;

        // 譯文內容
        const textSpan = document.createElement('span');
        transBlock.appendChild(textSpan);

        if (isFailed || text === '（翻譯失敗）') {
            // 失敗狀態處理：顯示失敗標記與重試按鈕
            transBlock.dataset.status = 'failed';
            textSpan.textContent = '❌ 翻譯失敗';
            textSpan.style.color = '#ff4d4f';
            
            const actions = document.createElement('span');
            actions.className = 'mt-novel-actions';
            
            const retryBtn = document.createElement('button');
            retryBtn.className = 'mt-novel-btn mt-novel-retry-btn';
            retryBtn.textContent = '🔄 重試';
            
            const originalText = sourceEl?.textContent.trim();
            retryBtn.onclick = () => {
                retrySingleNovelParagraph(globalIdx, originalText, transBlock);
            };
            
            actions.appendChild(retryBtn);
            transBlock.appendChild(actions);
        } else {
            // 成功狀態處理：顯示譯文與 📚+ / 🔄 按鈕
            transBlock.dataset.status = 'done';
            textSpan.textContent = text;
            
            const actions = document.createElement('span');
            actions.className = 'mt-novel-actions';
            
            // 📚+ 按鈕：新增至語彙庫
            const addBtn = document.createElement('button');
            addBtn.className = 'mt-novel-btn';
            addBtn.textContent = '📚+';
            addBtn.title = '新增至語彙庫';
            
            const originalText = sourceEl?.textContent.trim();
            addBtn.onclick = () => {
                showGlossaryModal(originalText, text);
            };

            // 🔄 按鈕：單段重譯
            const retryBtn = document.createElement('button');
            retryBtn.className = 'mt-novel-btn mt-novel-retry-btn';
            retryBtn.textContent = '🔄';
            retryBtn.title = '重新翻譯此段落';
            retryBtn.onclick = () => {
                retrySingleNovelParagraph(globalIdx, originalText, transBlock);
            };
            
            actions.appendChild(addBtn);
            actions.appendChild(retryBtn);
            transBlock.appendChild(actions);
        }

        // 優雅的淡入 (Fade-in) 動畫效果
        transBlock.style.opacity = '0';
        placeholder.replaceWith(transBlock);
        void transBlock.offsetHeight; // 強制重繪
        transBlock.style.transition = 'opacity 0.4s ease';
        transBlock.style.opacity = '1';
    });
}

/**
 * 4. 復活全網頁 UI 元素與目錄翻譯 (Replace Mode)
 * 完美移植 V1.8.6 的 translateUIElements 核心
 */
export function translateUIElements() {
    const textNodes = [];
    const attrNodes = []; // { el, attr, original }

    // 使用 TreeWalker 收集網頁非本文區塊的日文文字節點
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) => {
            const parent = node.parentElement;
            if (!parent) return NodeFilter.FILTER_REJECT;
            const tag = parent.tagName.toLowerCase();
            if (['script', 'style', 'textarea', 'code'].includes(tag)) return NodeFilter.FILTER_REJECT;
            
            // 排除小說正文本體與已經翻譯的譯文區塊
            if (parent.closest('[data-mt-novel-body="true"]') || parent.closest('.mt-novel-trans') || parent.classList.contains('mt-novel-trans')) {
                return NodeFilter.FILTER_REJECT;
            }
            // 必須包含日文字元
            if (/[\u3040-\u9FFF]/.test(node.nodeValue)) return NodeFilter.FILTER_ACCEPT;
            return NodeFilter.FILTER_REJECT;
        }
    });

    let node;
    while (node = walk.nextNode()) textNodes.push(node);

    // 收集屬性文字 (如 Placeholder 或 Button value)
    document.querySelectorAll('input, textarea, button').forEach(el => {
        if (el.closest('[data-mt-novel-body="true"]') || el.closest('.mt-novel-trans')) return;

        // Placeholder 屬性
        const ph = el.getAttribute('placeholder');
        if (ph && /[\u3040-\u9FFF]/.test(ph)) {
            attrNodes.push({ el, attr: 'placeholder', original: ph });
        }

        // 按鈕的 Value 屬性
        if (el.tagName.toLowerCase() === 'input' && ['button', 'submit'].includes(el.type)) {
            const val = el.value;
            if (val && /[\u3040-\u9FFF]/.test(val)) {
                attrNodes.push({ el, attr: 'value', original: val });
            }
        }
    });

    const allToTranslate = [
        ...textNodes.map(n => n.nodeValue.trim()),
        ...attrNodes.map(a => a.original.trim())
    ];

    if (allToTranslate.length === 0) return;

    log.info('NovelEngine', `啟動全網頁 UI 與目錄翻譯，共 ${allToTranslate.length} 項`);

    const UI_BATCH_SIZE = 50;
    for (let i = 0; i < allToTranslate.length; i += UI_BATCH_SIZE) {
        const batchTexts = allToTranslate.slice(i, i + UI_BATCH_SIZE);
        const startIndex = i;

        chrome.runtime.sendMessage({
            action: 'translateUIBatch',
            texts: batchTexts
        }, (response) => {
            if (response?.translations) {
                response.translations.forEach((trans, idx) => {
                    if (!trans) return;
                    const globalIdx = startIndex + idx;
                    
                    if (globalIdx < textNodes.length) {
                        // 替換文字節點內容
                        textNodes[globalIdx].nodeValue = trans;
                    } else {
                        // 替換屬性文字
                        const attrIdx = globalIdx - textNodes.length;
                        const target = attrNodes[attrIdx];
                        if (target) target.el.setAttribute(target.attr, trans);
                    }
                });
            }
        });
    }
}

/**
 * 5. 針對單一小說段落進行重譯
 */
export async function retrySingleNovelParagraph(idx, originalText, container) {
    if (!originalText || !container) return;

    const textSpan = container.querySelector('span');
    const actions = container.querySelector('.mt-novel-actions');
    const originalContent = textSpan.textContent;

    // 進入 loading 載入狀態
    container.dataset.status = 'retrying';
    textSpan.textContent = '⏳ 正在重刷譯文...';
    if (actions) actions.style.display = 'none';

    // 確保 MangaKey 存在
    if (!currentMangaKey) {
        const { mangaKey } = await new Promise(r => chrome.runtime.sendMessage({ action: 'getTabMangaKey' }, r));
        if (mangaKey) {
            currentMangaKey = mangaKey;
            window.mt_currentMangaKey = mangaKey;
        }
    }

    chrome.runtime.sendMessage({
        action: 'retranslateNovelParagraph',
        text: originalText,
        mangaKey: currentMangaKey
    }, (response) => {
        if (actions) actions.style.display = 'inline-flex';
        
        if (response?.translation) {
            textSpan.textContent = response.translation;
            container.dataset.status = 'done';
            // 同步更新 📚+ 按鈕的點擊事件，確保存入新譯文
            const addBtn = container.querySelector('.mt-novel-btn');
            if (addBtn) {
                addBtn.onclick = () => showGlossaryModal(originalText, response.translation);
            }
        } else {
            textSpan.textContent = originalContent; // 還原
            container.dataset.status = 'failed';
            alert('重譯失敗: ' + (response?.error || '未知錯誤'));
        }
    });
}

/**
 * 6. 收集頁面上所有顯示為「失敗」的段落索引，供前台重新排程發送
 */
export function collectFailures() {
    const failedNodes = document.querySelectorAll('.mt-novel-trans[data-status="failed"]');
    const indices = [];
    failedNodes.forEach(node => {
        const idx = parseInt(node.dataset.novelIdx);
        if (!isNaN(idx)) indices.push(idx);
    });
    return indices;
}

/**
 * 7. 顯示/隱藏與注入語彙庫 Modal (移植自 V1.8.6 精美樣式與互動)
 */
export function showGlossaryModal(ori, trans) {
    injectGlossaryModalIfNeeded();
    const modal = document.getElementById('mt-glossary-modal');
    document.getElementById('mt-glossary-ori').value = ori || '';
    document.getElementById('mt-glossary-trans').value = trans || '';
    modal.classList.add('show');
    document.getElementById('mt-glossary-trans').focus();
}

async function injectGlossaryModalIfNeeded() {
    if (document.getElementById('mt-glossary-modal')) return;

    const modalHtml = `
    <div id="mt-glossary-modal" class="mt-modal">
        <div class="mt-modal-backdrop"></div>
        <div class="mt-modal-content">
            <div class="mt-modal-header">
                <h3>📖 新增至語彙庫</h3>
                <button class="mt-modal-close">&times;</button>
            </div>
            <div class="mt-modal-body">
                <div class="mt-input-group">
                    <label>原文 (日文)</label>
                    <input type="text" id="mt-glossary-ori" placeholder="例如：ラインフェルト">
                </div>
                <div class="mt-input-group">
                    <label>譯文 (中文)</label>
                    <input type="text" id="mt-glossary-trans" placeholder="例如：萊茵費爾特">
                </div>
                <p class="mt-modal-hint">儲存後，下一次進行翻譯時將會自動套用此譯名。</p>
            </div>
            <div class="mt-modal-footer">
                <button id="mt-glossary-cancel" class="mt-btn-secondary">取消</button>
                <button id="mt-glossary-save" class="mt-btn-accent">儲存條目</button>
            </div>
        </div>
    </div>`;

    const div = document.createElement('div');
    div.innerHTML = modalHtml;
    document.body.appendChild(div.firstElementChild);

    // 綁定事件
    const modal = document.getElementById('mt-glossary-modal');
    const closeBtn = modal.querySelector('.mt-modal-close');
    const cancelBtn = document.getElementById('mt-glossary-cancel');
    const saveBtn = document.getElementById('mt-glossary-save');
    const backdrop = modal.querySelector('.mt-modal-backdrop');

    const hide = () => modal.classList.remove('show');
    closeBtn.onclick = hide;
    cancelBtn.onclick = hide;
    backdrop.onclick = hide;

    saveBtn.onclick = async () => {
        const ori = document.getElementById('mt-glossary-ori').value.trim();
        const trans = document.getElementById('mt-glossary-trans').value.trim();

        if (!ori || !trans) return;
        
        // 若快取 MangaKey 為空，嘗試動態獲取
        if (!currentMangaKey) {
            const status = await new Promise(resolve => {
                chrome.runtime.sendMessage({ action: 'getTabMangaKey' }, resolve);
            });
            if (status?.mangaKey) {
                currentMangaKey = status.mangaKey;
                window.mt_currentMangaKey = status.mangaKey;
            }
        }

        if (!currentMangaKey) {
            alert('無法識別作品 ID (MangaKey)，無法儲存條目。\n請確保側邊欄已正確識別作品。');
            return;
        }

        saveBtn.disabled = true;
        saveBtn.textContent = '儲存中...';

        chrome.runtime.sendMessage({
            action: 'saveGlossaryTerm',
            mangaKey: currentMangaKey,
            ori: ori,
            trans: trans
        }, (res) => {
            saveBtn.disabled = false;
            saveBtn.textContent = '儲存條目';
            if (res && res.success) {
                hide();
            } else {
                alert('儲存失敗: ' + (res?.error || '未知錯誤'));
            }
        });
    };
}

/**
 * 8. 注入全域樣式（融合 V1.8.6 的 content.css 質感設計，適配各平台與深色模式）
 */
function injectStyles() {
    if (document.getElementById('mt-novel-styles')) return;
    const style = document.createElement('style');
    style.id = 'mt-novel-styles';
    style.textContent = `
        /* ===== 小說模式譯文區塊 ===== */
        .mt-novel-trans {
            display: block !important;
            color: #2979d4 !important;
            font-size: 0.95em !important;
            line-height: 1.9 !important;
            border-left: 3px solid #4a9eff !important;
            padding: 4px 0 4px 12px !important;
            margin: 4px 0 14px 0 !important;
            background: rgba(74, 158, 255, 0.04) !important;
            border-radius: 0 4px 4px 0 !important;
            text-align: left !important;
            font-family: inherit !important;
        }

        /* 行內譯文（適用於目錄連結或 inline 標籤旁）*/
        span.mt-novel-trans {
            display: inline-flex !important;
            align-items: center !important;
            border-left: none !important;
            padding: 2px 6px !important;
            margin: 0 0 0 8px !important;
            background: rgba(74, 158, 255, 0.08) !important;
            border-radius: 4px !important;
            font-size: 0.85em !important;
            line-height: 1.2 !important;
            vertical-align: middle !important;
        }

        /* 翻譯中佔位符（柔和脈動動畫） */
        .mt-novel-placeholder {
            color: #999 !important;
            font-style: italic !important;
            border-left-color: #ccc !important;
            background: transparent !important;
            animation: mt-novel-pulse 1.2s ease-in-out infinite !important;
        }

        @keyframes mt-novel-pulse {
            0%, 100% { opacity: 0.5; }
            50% { opacity: 1; }
        }

        /* 深色/暗黑模式適應 */
        @media (prefers-color-scheme: dark) {
            .mt-novel-trans {
                color: #7ab8ff !important;
                border-left-color: #4a9eff !important;
                background: rgba(74, 158, 255, 0.06) !important;
            }
            .mt-novel-placeholder {
                color: #666 !important;
                border-left-color: #444 !important;
            }
        }

        /* ===== 小說模式互動按鈕 ===== */
        .mt-novel-actions {
            display: inline-flex !important;
            gap: 8px !important;
            margin-left: 12px !important;
            vertical-align: middle !important;
        }

        .mt-novel-btn {
            padding: 2px 6px !important;
            font-size: 11px !important;
            background: #f0f4f8 !important;
            color: #4a9eff !important;
            border: 1px solid #d0e2f5 !important;
            border-radius: 4px !important;
            cursor: pointer !important;
            transition: all 0.2s !important;
            user-select: none !important;
            line-height: 1.2 !important;
            text-decoration: none !important;
            font-style: normal !important;
            font-weight: 700 !important;
            display: inline-block !important;
        }

        .mt-novel-btn:hover {
            background: #4a9eff !important;
            color: white !important;
            border-color: #4a9eff !important;
            transform: scale(1.1) !important;
        }

        .mt-novel-retry-btn {
            color: #4CAF50 !important;
            border-color: #c8e6c9 !important;
            background: #f1f8f1 !important;
        }

        .mt-novel-retry-btn:hover {
            background: #4CAF50 !important;
            border-color: #4CAF50 !important;
        }

        /* ===== 移植自 V1.8.6 的精美 Modal ===== */
        .mt-modal {
            position: fixed !important;
            inset: 0 !important;
            z-index: 2147483647 !important;
            display: flex !important;
            align-items: center !important;
            justify-content: center !important;
            padding: 20px !important;
            visibility: hidden !important;
            opacity: 0 !important;
            pointer-events: none !important;
            transition: opacity 0.3s ease, visibility 0.3s ease !important;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
            text-align: left !important;
        }

        .mt-modal.show {
            visibility: visible !important;
            opacity: 1 !important;
            pointer-events: auto !important;
        }

        .mt-modal-backdrop {
            position: absolute !important;
            inset: 0 !important;
            background: rgba(0, 0, 0, 0.4) !important;
            backdrop-filter: blur(4px) !important;
            -webkit-backdrop-filter: blur(4px) !important;
        }

        .mt-modal-content {
            position: relative !important;
            width: 100% !important;
            max-width: 400px !important;
            background: #ffffff !important;
            border-radius: 20px !important;
            box-shadow: 0 20px 50px rgba(0, 0, 0, 0.2) !important;
            overflow: hidden !important;
            transform: translateY(20px) !important;
            transition: transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1) !important;
            color: #333 !important;
            padding: 0 !important;
            border: none !important;
        }

        @media (prefers-color-scheme: dark) {
            .mt-modal-content {
                background: #1e1e1e !important;
                color: #e0e0e0 !important;
            }
            .mt-modal-header {
                background: #2d2d2d !important;
                border-bottom-color: #3d3d3d !important;
            }
            .mt-input-group input {
                background: #2d2d2d !important;
                border-color: #3d3d3d !important;
                color: #e0e0e0 !important;
            }
            .mt-modal-footer {
                background: #252525 !important;
                border-top-color: #3d3d3d !important;
            }
            .mt-btn-secondary {
                background: #2d2d2d !important;
                border-color: #444 !important;
                color: #aaa !important;
            }
        }

        .mt-modal.show .mt-modal-content {
            transform: translateY(0) !important;
        }

        .mt-modal-header {
            padding: 16px 20px !important;
            background: #f8f9fa !important;
            display: flex !important;
            justify-content: space-between !important;
            align-items: center !important;
            border-bottom: 1px solid #eee !important;
        }

        .mt-modal-header h3 {
            margin: 0 !important;
            padding: 0 !important;
            font-size: 17px !important;
            font-weight: 800 !important;
            color: #6a5ad3 !important;
            border: none !important;
        }

        .mt-modal-close {
            background: transparent !important;
            border: none !important;
            font-size: 22px !important;
            line-height: 1 !important;
            color: #999 !important;
            cursor: pointer !important;
        }

        .mt-modal-body {
            padding: 20px !important;
            display: flex !important;
            flex-direction: column !important;
            gap: 16px !important;
        }

        .mt-input-group {
            display: flex !important;
            flex-direction: column !important;
            gap: 6px !important;
        }

        .mt-input-group label {
            font-size: 12px !important;
            font-weight: 700 !important;
            color: #888 !important;
            text-transform: uppercase !important;
            margin: 0 !important;
            display: block !important;
        }

        .mt-input-group input {
            padding: 10px 14px !important;
            background: #f8f9fa !important;
            border: 1px solid #ddd !important;
            border-radius: 10px !important;
            font-size: 14px !important;
            width: 100% !important;
            box-sizing: border-box !important;
            color: #333 !important;
        }

        .mt-modal-hint {
            font-size: 11px !important;
            color: #666 !important;
            background: #fff9db !important;
            padding: 8px 12px !important;
            border-radius: 8px !important;
            margin: 0 !important;
            border-left: 3px solid #fcc419 !important;
            line-height: 1.4 !important;
        }

        .mt-modal-footer {
            padding: 12px 20px !important;
            background: #fbfbff !important;
            display: flex !important;
            justify-content: flex-end !important;
            gap: 10px !important;
            border-top: 1px solid #eee !important;
        }

        .mt-btn-secondary, .mt-btn-accent {
            padding: 8px 18px !important;
            border-radius: 10px !important;
            font-size: 13px !important;
            font-weight: 700 !important;
            cursor: pointer !important;
            transition: all 0.2s !important;
            font-family: inherit !important;
        }

        .mt-btn-secondary {
            background: white !important;
            border: 1px solid #ddd !important;
            color: #666 !important;
        }

        .mt-btn-accent {
            background: linear-gradient(135deg, #8d80f1 0%, #6a5ad3 100%) !important;
            border: none !important;
            color: white !important;
            box-shadow: 0 4px 10px rgba(106, 90, 211, 0.2) !important;
        }

        .mt-btn-accent:hover {
            filter: brightness(1.1) !important;
            transform: translateY(-1px) !important;
        }
    `;
    document.head.appendChild(style);
}
