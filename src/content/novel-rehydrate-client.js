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
    let autoDisposition = 'defer'; // 'defer' | 'allow' | 'consume'
    let pendingAutoTranslate = false;
    let candidateSessionId = null; // 追蹤從 Background 取得但尚未 Attach 的候選 Session

    return {
        getPhase: () => phase,
        isChecking: () => phase === 'checking',
        hasPendingAuto: () => pendingAutoTranslate,
        setPendingAuto: (val) => { pendingAutoTranslate = Boolean(val); },
        getAutoDisposition: () => autoDisposition,
        setAutoDisposition: (val) => { autoDisposition = val; },
        getCandidateSessionId: () => candidateSessionId,

        /**
         * 統一的 AUTO_TRANSLATE_PAGE 處理政策 (供 Desktop 與 Mobile 完全共用)
         * @param {Function} startTranslationFn
         * @returns {{started: boolean, deferred?: boolean, rehydrated?: boolean, consumed?: boolean, error?: string}}
         */
        handleAutoSignal: (startTranslationFn) => {
            if (autoDisposition === 'defer' || phase === 'checking') {
                pendingAutoTranslate = true;
                return { started: false, deferred: true };
            }
            if (autoDisposition === 'consume' || phase === 'rehydrated') {
                return { started: false, rehydrated: phase === 'rehydrated', consumed: true };
            }
            if (autoDisposition === 'allow') {
                // AUTO 決定啟動新翻譯，立即將 disposition 切換為 consume 防止重複觸發
                autoDisposition = 'consume';
                phase = 'superseded';
                candidateSessionId = null;
                try {
                    if (typeof startTranslationFn === 'function') startTranslationFn();
                    return { started: true };
                } catch (e) {
                    return { started: false, error: e.message };
                }
            }
            return { started: false, consumed: true };
        },

        /**
         * 手動發起翻譯時，立即使 Rehydrate 失效並鎖定後續 AUTO (避免 delayed AUTO 開第二 Session)
         */
        onManualStart: () => {
            generation++;
            phase = 'superseded';
            autoDisposition = 'consume';
            pendingAutoTranslate = false;
            candidateSessionId = null;
        },

        /**
         * 收到 Generic STOP 或模式停用時，終止並鎖定 AUTO
         */
        onGenericStop: () => {
            generation++;
            phase = 'superseded';
            autoDisposition = 'consume';
            pendingAutoTranslate = false;
            candidateSessionId = null;
        },

        /**
         * 收到針對特定舊 Session 的導航終止通知時，若當前 attached 或 candidate Session 相符則清除並重新允許 AUTO
         * @param {string} targetSessionId
         * @param {string|null} currentSessionId
         * @param {Function} detachFn
         * @returns {boolean} 是否成功處理
         */
        onTargetedNavigationAbort: (targetSessionId, currentSessionId, detachFn) => {
            if (!targetSessionId) return false;

            const isCurrentMatch = Boolean(currentSessionId && currentSessionId === targetSessionId);
            const isCandidateMatch = Boolean(candidateSessionId && candidateSessionId === targetSessionId);

            if (isCurrentMatch || isCandidateMatch) {
                generation++;
                phase = 'none';
                autoDisposition = 'allow'; // 允許後續新章節的 AUTO
                pendingAutoTranslate = false;
                candidateSessionId = null;

                if (isCurrentMatch && typeof detachFn === 'function') {
                    detachFn();
                }
                return true;
            }
            // 若當前 session 已非 targetSessionId (例如已成立 BBB 或 candidate BBB)，忽略不干擾
            return false;
        },

        /**
         * 使用者發起手動翻譯時，立即使 Rehydrate 失效
         */
        supersede: () => {
            generation++;
            phase = 'superseded';
            autoDisposition = 'consume';
            pendingAutoTranslate = false;
            candidateSessionId = null;
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
            autoDisposition = 'defer';
            candidateSessionId = null;

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
                candidateSessionId = null;
                if (firstSnapshot?.status === 'error') {
                    // 若為伺服器/通訊異常，保持 phase = 'none' 且 autoDisposition = 'consume' (Fail Closed)
                    phase = 'none';
                    autoDisposition = 'consume';
                    return;
                }
                phase = 'none';
                autoDisposition = 'allow';
                if (pendingAutoTranslate) {
                    pendingAutoTranslate = false;
                    autoDisposition = 'consume';
                    if (typeof startNewTranslationFn === 'function') startNewTranslationFn();
                }
                return;
            }

            // 取得候選 sessionId (在 Exact Source Validation 前設定)
            candidateSessionId = firstSnapshot.sessionId;

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
                let abandonRes = null;
                try {
                    abandonRes = await new Promise(resolve => {
                        chrome.runtime.sendMessage({
                            action: 'ABANDON_NOVEL_REHYDRATE',
                            sessionId: firstSnapshot.sessionId
                        }, resolve);
                    });
                } catch (_) {}

                // ABANDON await 期間可能已被使用者手動觸發 supersede 或 targeted abort，嚴格檢查 generation guard
                if (currentGen !== generation || phase === 'superseded') return;

                candidateSessionId = null;

                // 只有在 ABANDON 確認成功清理 (ok: true) 時，才允許 pending AUTO 開啟新 Session
                if (abandonRes && abandonRes.ok) {
                    autoDisposition = 'allow';
                    if (pendingAutoTranslate) {
                        pendingAutoTranslate = false;
                        autoDisposition = 'consume';
                        if (typeof startNewTranslationFn === 'function') startNewTranslationFn();
                    }
                } else {
                    // 若回傳 stale-session 或 superseded-session，表示背景已有更新 Session，鎖定 AUTO 且不開 CCC
                    autoDisposition = 'consume';
                    if (typeof onSessionDetachedFn === 'function') {
                        onSessionDetachedFn();
                    }
                    phase = 'none';
                }
                return;
            }

            // 4. 比對成功 ➔ Attach Session (ownership 轉移給 currentSessionId，清空 candidate)
            candidateSessionId = null;
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

            // 嚴格驗證第二份快照：只有 ok: true 且 sessionId 完全相符才視為成功 Catch-up
            if (secondSnapshot && secondSnapshot.ok && secondSnapshot.sessionId === firstSnapshot.sessionId) {
                applyNovelRehydrateSnapshot(secondSnapshot.renderItems, { injectBatchResultFn });
            } else {
                // 第二份快照失敗 (stale-session, error, url-mismatch, no-session 等) ➔ 絕不宣告成功 rehydrated
                if (typeof onSessionDetachedFn === 'function') {
                    onSessionDetachedFn();
                }
                phase = 'none';
                autoDisposition = 'consume';
                return;
            }

            // 6. 標記 Rehydrate 順利完成並翻譯 UI 元素
            phase = 'rehydrated';
            autoDisposition = 'consume';
            pendingAutoTranslate = false; // consume pending auto translate (不開新 Session)

            if (typeof translateUIElementsFn === 'function') {
                try {
                    translateUIElementsFn();
                } catch (_) {}
            }
        }
    };
}
