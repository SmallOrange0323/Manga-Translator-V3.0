// 漫譯行動端漫畫閱讀器互動邏輯 (進度點列、FAB 與全域 Bottom Sheet 抽屜)
import { showGlossaryModal as defaultShowGlossaryModal } from './reader-glossary-modal.js';

let mobileReaderInitialized = false;

/**
 * 初始化行動端閱讀器與 Bottom Sheet 抽屜介面
 * @param {Object} [options]
 * @param {Function} [options.showGlossaryModal] - 開啟詞庫彈窗的回呼函式
 */
export function initMobileReader(options = {}) {
    const onShowGlossary = options.showGlossaryModal || defaultShowGlossaryModal;

    const hasTouchAndMobileUA = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const urlParams = new URLSearchParams(location.search);

    let isMobileMode = false;
    if (urlParams.get('mobile') === '1') {
        isMobileMode = true;
    } else if (urlParams.get('desktop') === '1') {
        isMobileMode = false;
    } else {
        isMobileMode = hasTouchAndMobileUA || (window.innerWidth <= 768);
    }

    if (!isMobileMode) {
        document.body.classList.remove('mt-mobile-mode');
        return;
    }
    document.body.classList.add('mt-mobile-mode');
    if (mobileReaderInitialized) return;
    mobileReaderInitialized = true;

    const resultsContainer = document.getElementById('results-container');
    const drawer = document.getElementById('mt-mobile-drawer');
    const drawerTitle = document.getElementById('mt-drawer-title');
    const drawerBody = document.getElementById('mt-drawer-body');
    const drawerClose = document.getElementById('mt-drawer-close');
    const drawerBackdrop = drawer ? drawer.querySelector('.mt-drawer-backdrop') : null;

    if (!resultsContainer) return;

    // ── 1. 建立進度點列 ──
    const progressBar = document.createElement('div');
    progressBar.className = 'mobile-progress-bar';
    document.body.appendChild(progressBar);

    let dots = [];
    let currentPage = 0;

    function rebuildDots() {
        const cards = resultsContainer.querySelectorAll('.result-card:not(.skeleton-card)');
        progressBar.innerHTML = '';
        dots = [];
        if (cards.length > 20) {
            progressBar.style.display = 'none';
            return;
        }
        progressBar.style.display = 'flex';
        cards.forEach((_, i) => {
            const dot = document.createElement('div');
            dot.className = 'mobile-progress-dot' + (i === currentPage ? ' active' : '');
            progressBar.appendChild(dot);
            dots.push(dot);
        });
    }

    function updateActiveDot(index) {
        currentPage = index;
        dots.forEach((d, i) => d.classList.toggle('active', i === index));
    }

    // ── 2. 全域固定 FAB 按鈕 ──
    const fab = document.createElement('button');
    fab.id = 'mt-mobile-fab';
    fab.textContent = '📖 查看 P.1 翻譯';
    document.body.appendChild(fab);

    let currentVisibleCard = null;

    // 將指定卡片的翻譯對白同步渲染進全域底部抽屜
    window._syncCardToDrawer = function(card) {
        if (!card || !drawerBody) return;
        const pageNumStr = card.querySelector('.card-page-badge')?.textContent || `P.${currentPage + 1}`;
        if (drawerTitle) drawerTitle.textContent = `📄 ${pageNumStr} 翻譯內容`;
        if (fab) fab.textContent = `📖 查看 ${pageNumStr} 翻譯`;

        // 提取卡片內部的對白容器 .dialogues-container
        const dialoguesContainer = card.querySelector('.dialogues-container');
        drawerBody.innerHTML = '';

        if (dialoguesContainer && dialoguesContainer.children.length > 0) {
            Array.from(dialoguesContainer.querySelectorAll('.dialogue-item')).forEach(item => {
                const clone = item.cloneNode(true);
                // 重新綁定語彙庫按鈕事件
                const termBtn = clone.querySelector('.save-glossary');
                if (termBtn) {
                    const ori = clone.querySelector('.original-text')?.textContent || '';
                    const trans = clone.querySelector('.translated-text')?.textContent || '';
                    termBtn.onclick = (e) => {
                        e.stopPropagation();
                        onShowGlossary(ori, trans);
                    };
                }
                drawerBody.appendChild(clone);
            });
        } else {
            const emptyHint = document.createElement('div');
            emptyHint.style.cssText = 'padding: 24px; text-align: center; color: #888; font-size: 13px;';
            emptyHint.textContent = card.classList.contains('is-error') ? '⚠️ 本頁翻譯失敗' : '✨ 本頁無文字或正在翻譯中...';
            drawerBody.appendChild(emptyHint);
        }
    };

    function openDrawer() {
        const targetCard = currentVisibleCard || resultsContainer.querySelector('.result-card:not(.skeleton-card)');
        if (targetCard) {
            window._syncCardToDrawer(targetCard);
        }
        if (drawer) drawer.classList.add('is-open');
        if (fab) fab.classList.add('hidden');
    }

    function closeDrawer() {
        if (drawer) drawer.classList.remove('is-open');
        if (fab) fab.classList.remove('hidden');
    }

    // 綁定 FAB 按鈕點擊與觸碰事件 (雙重相容)
    fab.addEventListener('click', openDrawer);
    fab.addEventListener('touchend', (e) => {
        e.preventDefault();
        openDrawer();
    });

    if (drawerClose) {
        drawerClose.addEventListener('click', closeDrawer);
        drawerClose.addEventListener('touchend', (e) => {
            e.preventDefault();
            closeDrawer();
        });
    }
    if (drawerBackdrop) {
        drawerBackdrop.addEventListener('click', closeDrawer);
    }

    // ── 3. Scroll 偵測：自動動態同步當前頁碼與抽屜內容 ──
    const scrollObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (!entry.isIntersecting) return;
            const cards = Array.from(resultsContainer.querySelectorAll('.result-card:not(.skeleton-card)'));
            const idx = cards.indexOf(entry.target);
            if (idx >= 0) {
                updateActiveDot(idx);
                currentVisibleCard = entry.target;

                const pageNumStr = entry.target.querySelector('.card-page-badge')?.textContent || `P.${idx + 1}`;
                if (fab) fab.textContent = `📖 查看 ${pageNumStr} 翻譯`;

                // 若抽屜處於開啟中，自動無縫刷新為當前可見卡片的翻譯
                if (drawer && drawer.classList.contains('is-open')) {
                    window._syncCardToDrawer(entry.target);
                }
            }
        });
    }, { root: resultsContainer, threshold: 0.5 });

    // ── 4. 綁定卡片 Observer ──
    window._bindMobileCard = function(card) {
        if (card.dataset.mobileBound) return;
        card.dataset.mobileBound = '1';
        scrollObserver.observe(card);
        rebuildDots();
        if (!currentVisibleCard) {
            currentVisibleCard = card;
        }
    };

    resultsContainer.querySelectorAll('.result-card:not(.skeleton-card)').forEach(window._bindMobileCard);
    rebuildDots();
}
