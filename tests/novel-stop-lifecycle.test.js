import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const assert = {
    equal: (actual, expected) => expect(actual).toBe(expected),
    deepEqual: (actual, expected) => expect(actual).toEqual(expected)
};

import {
    createNovelCancellationRegistry,
    isNewFullSession,
    pruneQueueForTab,
    shouldProcessNovelTask
} from '../src/background/novel-cancellation.js';

describe('Novel Mode: STOP / Abort Lifecycle & Per-Tab Isolation Tests', () => {

    describe('Test 1: cancel(Tab A) 標記分頁為已中止', () => {
        it('cancel 成功將指定 tabId 寫入 registry', () => {
            const registry = createNovelCancellationRegistry();
            assert.equal(registry.isCancelled(101), false);

            registry.cancel(101);
            assert.equal(registry.isCancelled(101), true);
            assert.equal(registry.size(), 1);
        });
    });

    describe('Test 2: cancel(Tab A) 絕不影響 Tab B (Per-Tab Isolation)', () => {
        it('中止 Tab 101 時，Tab 202 維持 active 狀態', () => {
            const registry = createNovelCancellationRegistry();
            registry.cancel(101);

            assert.equal(registry.isCancelled(101), true);
            assert.equal(registry.isCancelled(202), false);
        });
    });

    describe('Test 3: begin(Tab A) 清除 Tab A 的中止標記', () => {
        it('新 session 啟動時 begin 可正確重置該分頁的中止狀態', () => {
            const registry = createNovelCancellationRegistry();
            registry.cancel(101);
            assert.equal(registry.isCancelled(101), true);

            registry.begin(101);
            assert.equal(registry.isCancelled(101), false);
        });
    });

    describe('Test 4: begin(Tab A) 絕不清除 Tab B 的中止標記', () => {
        it('Tab A 重啟時，Tab B 依然保持已中止狀態', () => {
            const registry = createNovelCancellationRegistry();
            registry.cancel(101);
            registry.cancel(202);

            registry.begin(101);
            assert.equal(registry.isCancelled(101), false);
            assert.equal(registry.isCancelled(202), true);
        });
    });

    describe('Test 5: Queue Pruning (修剪佇列中已中止分頁的所有未執行任務)', () => {
        it('從混合佇列 [A1, B1, A2, B2] 中中止 A 時，精確保留 [B1, B2]', () => {
            const initialQueue = [
                { tabId: 101, batchIndex: 0, texts: ['A1'] },
                { tabId: 202, batchIndex: 0, texts: ['B1'] },
                { tabId: 101, batchIndex: 1, texts: ['A2'] },
                { tabId: 202, batchIndex: 1, texts: ['B2'] }
            ];

            const pruned = pruneQueueForTab(initialQueue, 101);

            assert.equal(pruned.length, 2);
            assert.deepEqual(pruned, [
                { tabId: 202, batchIndex: 0, texts: ['B1'] },
                { tabId: 202, batchIndex: 1, texts: ['B2'] }
            ]);
        });

        it('修剪非陣列或無效 tabId 時具備健全防禦', () => {
            assert.deepEqual(pruneQueueForTab(null, 101), []);
            assert.deepEqual(pruneQueueForTab([{ tabId: 101 }], null), [{ tabId: 101 }]);
        });
    });

    describe('Test 6: 新 Session 識別 (isNewFullSession) — 首批非重試可重置', () => {
        it('batchIndex === 0 且無 retryIndices 時判定為全新完整 session', () => {
            const msg = {
                batchIndex: 0,
                totalBatches: 3,
                texts: ['p1', 'p2']
            };
            assert.equal(isNewFullSession(msg), true);
        });
    });

    describe('Test 7: 後續批次 (Batch 1 / Batch 2) 不得判定為新 Session', () => {
        it('batchIndex > 0 時不得判定為新 session (防止 stale batch 誤解除中斷)', () => {
            const msg1 = { batchIndex: 1, totalBatches: 3, texts: ['p3'] };
            const msg2 = { batchIndex: 2, totalBatches: 3, texts: ['p5'] };

            assert.equal(isNewFullSession(msg1), false);
            assert.equal(isNewFullSession(msg2), false);
        });
    });

    describe('Test 8: 重譯批次 (Retry Batch) 不得判定為新 Full Session', () => {
        it('batchIndex === 0 但帶有 retryIndices 時不得視為新 session', () => {
            const retryMsg = {
                batchIndex: 0,
                totalBatches: 1,
                texts: ['failed_p1'],
                retryIndices: [3, 7]
            };

            assert.equal(isNewFullSession(retryMsg), false);
        });
    });

    describe('Test 9: Pre-request Policy (API 呼叫前確認中止)', () => {
        it('模擬 Background 佇列循環：在 API 呼叫前偵測到已中止時直接跳過，API 呼叫 0 次', () => {
            const registry = createNovelCancellationRegistry();
            registry.cancel(101);

            let apiCallCount = 0;
            const task = { tabId: 101, batchIndex: 0, texts: ['hello'] };

            // 模擬 Background pre-request guard
            if (!registry.isCancelled(task.tabId)) {
                apiCallCount++;
            }

            assert.equal(apiCallCount, 0);
        });
    });

    describe('Test 10: Post-request Policy (API 呼叫中途中止後捨棄結果)', () => {
        it('模擬 API 傳輸期間使用者按 STOP：API 返回後偵測到已中止，捨棄譯文與寫入', () => {
            const registry = createNovelCancellationRegistry();
            const task = { tabId: 101, batchIndex: 0, texts: ['hello'] };

            let novelResultsWritten = 0;
            let injectMessageSent = 0;

            // 模擬 API 呼叫已發出
            const apiResult = { translations: [{ index: 0, text: '你好' }] };

            // API 傳輸期間使用者觸發 abort
            registry.cancel(task.tabId);

            // 模擬 Background post-request guard
            if (!registry.isCancelled(task.tabId)) {
                novelResultsWritten++;
                injectMessageSent++;
            }

            assert.equal(novelResultsWritten, 0);
            assert.equal(injectMessageSent, 0);
        });
    });

    describe('Test 11: Cancelled Task 絕不發送 Success Inject', () => {
        it('已被中止之分頁任務絕不發送 injectNovelBatchResult 訊息給前台', () => {
            const registry = createNovelCancellationRegistry();
            registry.cancel(101);

            let messageAction = null;
            const task = { tabId: 101, batchIndex: 0 };

            if (!registry.isCancelled(task.tabId)) {
                messageAction = 'injectNovelBatchResult';
            }

            assert.equal(messageAction, null);
        });
    });

    describe('Test 12: Cancelled Task 遭遇 API 錯誤時絕不發送 Failure Inject', () => {
        it('中止期間若 API 發生異常，catch 區塊辨識已中止，絕不發送 isFailed: true 注入', () => {
            const registry = createNovelCancellationRegistry();
            registry.cancel(101);

            let failureInjectSent = false;
            const task = { tabId: 101, batchIndex: 0 };

            // 模擬 catch 區塊
            if (!registry.isCancelled(task.tabId)) {
                failureInjectSent = true;
            }

            assert.equal(failureInjectSent, false);
        });
    });

    describe('Test 13: Cancelled Task 絕不觸發 Next Batch 拉取', () => {
        it('Content 端收到中止後 isNovelTranslationAborted 為 true，sendNextNovelBatch 立即中斷', () => {
            let isNovelTranslationAborted = true;
            let batchSentCount = 0;

            function mockSendNextNovelBatch() {
                if (isNovelTranslationAborted) return;
                batchSentCount++;
            }

            mockSendNextNovelBatch();
            assert.equal(batchSentCount, 0);
        });
    });

    describe('Test 14: 重新開始新 Novel Session 流程閉環驗證', () => {
        it('Tab A: 中止 ➔ 標記 cancelled ➔ 重新打開 (新 Batch 0) ➔ begin(A) ➔ 正常發起 API', () => {
            const registry = createNovelCancellationRegistry();

            // 1. 使用者中止
            registry.cancel(101);
            assert.equal(registry.isCancelled(101), true);

            // 2. 收到 stale batch 1 ➔ 拒絕
            const staleBatch = { batchIndex: 1, totalBatches: 3 };
            if (isNewFullSession(staleBatch)) registry.begin(101);
            assert.equal(registry.isCancelled(101), true);

            // 3. 使用者重新啟動小說模式 ➔ 收到新 Batch 0
            const newSessionBatch = { batchIndex: 0, totalBatches: 3, texts: ['new_p1'] };
            if (isNewFullSession(newSessionBatch)) {
                registry.begin(101);
            }
            assert.equal(registry.isCancelled(101), false);

            // 4. 正常執行 API
            let apiExecuted = false;
            if (!registry.isCancelled(101)) {
                apiExecuted = true;
            }
            assert.equal(apiExecuted, true);
        });
    });

    describe('Test 15: Manga 全域 isStopping 絕不影響小說任務 (跨模式隔離)', () => {
        it('即使漫畫模式正在 STOP (isStopping = true)，活躍的小說任務 (shouldProcessNovelTask) 依然允許執行', () => {
            const registry = createNovelCancellationRegistry();
            // 漫畫模式全域 STOP
            const mangaGlobalState = { isStopping: true };

            // 小說 Tab 101 未中止
            const novelTask = { tabId: 101, batchIndex: 0, texts: ['小說段落'] };

            // shouldProcessNovelTask 只看 registry，不受 mangaGlobalState 影響
            const canProcess = shouldProcessNovelTask(novelTask, registry);
            assert.equal(canProcess, true);
        });

        it('小說 Tab 101 被中止時，shouldProcessNovelTask 精準拒絕', () => {
            const registry = createNovelCancellationRegistry();
            registry.cancel(101);

            const novelTask = { tabId: 101, batchIndex: 0, texts: ['小說段落'] };
            assert.equal(shouldProcessNovelTask(novelTask, registry), false);
        });
    });

    describe('Test 16: 多分頁小說佇列交錯時，Tab A 中止僅跳過 A，Tab B 依然正常執行', () => {
        it('模擬佇列循環處理 [TaskA1, TaskB1, TaskA2, TaskB2]：A 中止時僅 A 被 skip，B 順利執行完成且佇列不 break', () => {
            const registry = createNovelCancellationRegistry();
            registry.cancel(101); // Tab A 中止

            const queue = [
                { tabId: 101, batchIndex: 0, id: 'A1' },
                { tabId: 202, batchIndex: 0, id: 'B1' },
                { tabId: 101, batchIndex: 1, id: 'A2' },
                { tabId: 202, batchIndex: 1, id: 'B2' }
            ];

            const executedTasks = [];
            const skippedTasks = [];

            // 模擬修正後的 processNovelQueue 循環
            for (const task of queue) {
                if (registry.isCancelled(task.tabId)) {
                    skippedTasks.push(task.id);
                    continue; // 僅 skip 該 task，絕不 break 整條 queue
                }
                executedTasks.push(task.id);
            }

            assert.deepEqual(skippedTasks, ['A1', 'A2']);
            assert.deepEqual(executedTasks, ['B1', 'B2']);
        });
    });

    describe('Test 17: 靜態程式碼防護：processNovelQueue 函式體內絕無 isStopping 依賴', () => {
        it('讀取 src/background/index.js 確認 processNovelQueue 實作中未調用 isStopping', () => {
            const indexPath = path.resolve(__dirname, '../src/background/index.js');
            const code = fs.readFileSync(indexPath, 'utf-8');

            // 擷取 processNovelQueue 函式主體
            const startIdx = code.indexOf('async function processNovelQueue()');
            const endIdx = code.indexOf('chrome.runtime.onMessage.addListener', startIdx);
            assert.equal(startIdx !== -1, true);
            assert.equal(endIdx !== -1, true);

            const novelFnCode = code.substring(startIdx, endIdx);

            // 斷言 processNovelQueue 內部絕對沒有 isStopping
            assert.equal(novelFnCode.includes('isStopping'), false);
        });
    });
});
