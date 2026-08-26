/**
 * novel-rehydrate-client.js
 * 
 * 專門負責 Content Script 端 (Desktop & Mobile 共用) 小說頁面 Reload Rehydrate 核心控制器。
 * 核心原則：
 * 1. Exact Source Validation: 嚴格逐段比對 idx 與原文，任何不符 Fail Closed。
 * 2. Double Snapshot Catch-up: 避免 Attach 期間 Background live batch 遺漏。
 * 3. 狀態不降級: 已 done 的 DOM 絕不被 pending 覆蓋。
 * 4. AUTO Defer & Manual Supersede: 處理與 AUTO_TRANSLATE_PAGE 及手動翻譯的競爭。
 * 5. Mismatch Abandon: 原文不符時安全放棄舊 Session。
 */

/**
 * 嚴格比對前台 DOM 原文與 Background 快照中的 expectedItems
 * @param {Array<{idx: number, text: string}>} currentItems 
 * @param {Array<{idx: number, text: string}>} expectedItems 
 * @returns {boolean}
 */
export function compareNovelSourceItems(currentItems, expectedItems) {
    if (!Array.isArray(currentItems) || !Array.isArray(expectedItems)) return false;
    if (currentItems.length !== expectedItems.length) return false;

    for (let i = 0; i < currentItems.length; i++) {
        const cur = currentItems[i];
        const exp = expectedItems[i];
        if (!cur || !exp) return false;
        if (cur.idx !== exp.idx) return false;
        if (cur.text !== exp.text) return false;
    }
    return true;
}

/**
 * 套用 Rehydrate Snapshot 中的 renderItems 到 DOM
 * @param {Array<object>} renderItems 
 * @param {object} options 
 * @param {function} [options.injectBatchResultFn] 
 */
export function applyNovelRehydrateSnapshot(renderItems, { injectBatchResultFn } = {}) {
    if (!Array.isArray(renderItems)) return;

    for (const item of renderItems) {
        if (!item || typeof item.idx !== 'number') continue;

        if (item.status === 'done' && typeof item.translation === 'string') {
            if (typeof injectBatchResultFn === 'function') {
                injectBatchResultFn(0, [item.translation], [item.idx], false);
            }
        } else if (item.status === 'failed') {
            if (typeof injectBatchResultFn === 'function') {
                injectBatchResultFn(0, ['（翻譯失敗）'], [item.idx], true);
            }
        } else if (item.status === 'retrying') {
            const placeholder = document.querySelector(`[data-novel-idx="${item.idx}"]`);
            if (placeholder && placeholder.dataset.status !== 'done' && placeholder.dataset.status !== 'failed') {
                placeholder.dataset.status = 'retrying';
                const statusEl = placeholder.querySelector('.mt-novel-placeholder-status');
                if (statusEl) statusEl.textContent = '⏳ 正在重譯段落...';
            }
        }
        // pending 狀態保持現有 placeholder，絕不覆蓋已完成之 DOM
    }
}

/**
 * 建立小說 Rehydrate 控制器
 */
export function createNovelRehydrateController() {
    let generation = 0;
    let phase = 'checking'; // 'checking' | 'rehydrated' | 'none' | 'mismatch' | 'superseded'
    let pendingAutoTranslate = false;

    return {
        getPhase: () => phase,
        isChecking: () => phase === 'checking',
        hasPendingAuto: () => pendingAutoTranslate,
        setPendingAuto: (val) => { pendingAutoTranslate = Boolean(val); },
        
        /**
         * 使用者發起手動翻譯時，立即使 Rehydrate 失效
         */
        supersede: () => {
            generation++;
            phase = 'superseded';
            pendingAutoTranslate = false;
        },

        /**
         * 執行 Rehydrate 主流程
         */
        attemptRehydrate: async ({
            getParagraphsFn,
            getParagraphTextFn,
            insertPlaceholdersFn,
            injectBatchResultFn,
            translateUIElementsFn,
            startNewTranslationFn,
            onSessionAttachedFn,
            onSessionDetachedFn
        } = {}) => {
            if (phase === 'superseded') return;

            const currentGen = ++generation;
            phase = 'checking';

            // 1. 等待 DOM Ready
            if (document.readyState === 'loading') {
                await new Promise(resolve => document.addEventListener('DOMContentLoaded', resolve, { once: true }));
            }

            if (currentGen !== generation || phase === 'superseded') return;

            // 2. 取得第一份 Background Snapshot
            let firstSnapshot = null;
            try {
                firstSnapshot = await new Promise(resolve => {
                    chrome.runtime.sendMessage({
                        action: 'GET_NOVEL_REHYDRATE_STATE',
                        pageUrl: window.location.href
                    }, resolve);
                });
            } catch (_) {}

            if (currentGen !== generation || phase === 'superseded') return;

            if (!firstSnapshot || !firstSnapshot.ok || firstSnapshot.status !== 'rehydratable') {
                phase = 'none';
                if (pendingAutoTranslate) {
                    pendingAutoTranslate = false;
                    if (typeof startNewTranslationFn === 'function') startNewTranslationFn();
                }
                return;
            }

            // 3. Exact Source Validation (最多嘗試 initial + 2 次 retry: 0ms, 300ms, 1000ms)
            const delays = [0, 300, 1000];
            let matched = false;
            let currentParagraphs = [];

            for (const delay of delays) {
                if (delay > 0) {
                    await new Promise(r => setTimeout(r, delay));
                }
                if (currentGen !== generation || phase === 'superseded') return;

                currentParagraphs = getParagraphsFn ? getParagraphsFn() : [];
                const currentItems = currentParagraphs.map((_, idx) => ({
                    idx,
                    text: getParagraphTextFn ? getParagraphTextFn(idx) : ''
                }));

                if (compareNovelSourceItems(currentItems, firstSnapshot.expectedItems)) {
                    matched = true;
                    break;
                }
            }

            if (!matched) {
                // 原文不一致 ➔ 發送 ABANDON 釋放舊 Session
                phase = 'mismatch';
                try {
                    await new Promise(resolve => {
                        chrome.runtime.sendMessage({
                            action: 'ABANDON_NOVEL_REHYDRATE',
                            sessionId: firstSnapshot.sessionId
                        }, resolve);
                    });
                } catch (_) {}

                if (pendingAutoTranslate) {
                    pendingAutoTranslate = false;
                    if (typeof startNewTranslationFn === 'function') startNewTranslationFn();
                }
                return;
            }

            // 4. 比對成功 ➔ Attach Session
            if (typeof onSessionAttachedFn === 'function') {
                onSessionAttachedFn(firstSnapshot.sessionId);
            }

            // 插入 Placeholders
            if (typeof insertPlaceholdersFn === 'function') {
                insertPlaceholdersFn(currentParagraphs);
            }

            // 套用第一份快照
            applyNovelRehydrateSnapshot(firstSnapshot.renderItems, { injectBatchResultFn });

            // 5. Double Snapshot Catch-up (抓取 Attach 期間 Background 新完成的 Batch)
            let secondSnapshot = null;
            try {
                secondSnapshot = await new Promise(resolve => {
                    chrome.runtime.sendMessage({
                        action: 'GET_NOVEL_REHYDRATE_STATE',
                        pageUrl: window.location.href,
                        expectedSessionId: firstSnapshot.sessionId
                    }, resolve);
                });
            } catch (_) {}

            if (currentGen !== generation || phase === 'superseded') return;

            if (secondSnapshot && secondSnapshot.ok && secondSnapshot.sessionId === firstSnapshot.sessionId) {
                applyNovelRehydrateSnapshot(secondSnapshot.renderItems, { injectBatchResultFn });
            } else if (secondSnapshot && secondSnapshot.status === 'stale-session') {
                // Background Session 在此期間已切換或過期
                if (typeof onSessionDetachedFn === 'function') {
                    onSessionDetachedFn();
                }
                phase = 'none';
                return;
            }

            // 6. 標記 Rehydrate 完成並翻譯 UI 元素
            phase = 'rehydrated';
            pendingAutoTranslate = false; // consume pending auto translate (不開新 Session)

            if (typeof translateUIElementsFn === 'function') {
                try {
                    translateUIElementsFn();
                } catch (_) {}
            }
        }
    };
}
