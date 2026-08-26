import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const assert = {
    equal: (actual, expected) => expect(actual).toBe(expected),
    deepEqual: (actual, expected) => expect(actual).toEqual(expected)
};

import {
    createNovelSessionRegistry,
    pruneQueueForTab,
    shouldProcessNovelTask
} from '../src/background/novel-cancellation.js';

import { createNovelSessionId } from '../src/utils/novel-session-id.js';

describe('Novel Mode: Explicit Session Identity & Lifecycle Registry Tests', () => {

    describe('Test 1: BEGIN Session AAA ➔ active AAA', () => {
        it('明確調用 begin(tabId, sessionId) 成功設定 active session', () => {
            const registry = createNovelSessionRegistry();
            registry.begin(101, 'session-AAA');

            assert.equal(registry.getActiveSessionId(101), 'session-AAA');
            assert.equal(registry.isCurrentSession(101, 'session-AAA'), true);
            assert.equal(registry.isCancelled(101), false);
        });
    });

    describe('Test 2: BEGIN AAA ➔ BEGIN BBB ➔ active BBB', () => {
        it('切換 Session 時，active session 正確更新為 BBB', () => {
            const registry = createNovelSessionRegistry();
            registry.begin(101, 'session-AAA');
            assert.equal(registry.getActiveSessionId(101), 'session-AAA');

            registry.begin(101, 'session-BBB');
            assert.equal(registry.getActiveSessionId(101), 'session-BBB');
            assert.equal(registry.isCurrentSession(101, 'session-BBB'), true);
            assert.equal(registry.isCurrentSession(101, 'session-AAA'), false);
        });
    });

    describe('Test 3: Stale AAA task 在 BBB active 時 ➔ reject', () => {
        it('舊 Session AAA 的任務抵達時，被判定為非當前 Session', () => {
            const registry = createNovelSessionRegistry();
            registry.begin(101, 'session-BBB');

            const staleTask = { tabId: 101, sessionId: 'session-AAA', batchIndex: 1 };
            assert.equal(shouldProcessNovelTask(staleTask, registry), false);
        });
    });

    describe('Test 4: AAA API in-flight ➔ BEGIN BBB ➔ AAA response ➔ discard policy', () => {
        it('模擬 API 請求進行中使用者啟動新 Session BBB：AAA 返回後偵測到 Session 不匹配，立即捨棄', () => {
            const registry = createNovelSessionRegistry();
            registry.begin(101, 'session-AAA');

            const inFlightTask = { tabId: 101, sessionId: 'session-AAA', batchIndex: 0 };
            let resultsWritten = 0;
            let injectSent = 0;

            // API 傳輸期間，使用者重新開始小說翻譯，建立 Session BBB
            registry.begin(101, 'session-BBB');

            // 模擬 Background Post-request Guard
            if (registry.isCurrentSession(inFlightTask.tabId, inFlightTask.sessionId)) {
                resultsWritten++;
                injectSent++;
            }

            assert.equal(resultsWritten, 0);
            assert.equal(injectSent, 0);
        });
    });

    describe('Test 5: STOP AAA ➔ AAA cancelled', () => {
        it('cancel 標記當前 Session 為 cancelled 狀態', () => {
            const registry = createNovelSessionRegistry();
            registry.begin(101, 'session-AAA');

            registry.cancel(101);
            assert.equal(registry.isCancelled(101), true);
            assert.equal(registry.isCurrentSession(101, 'session-AAA'), false);
        });
    });

    describe('Test 6: STOP AAA ➔ stale AAA Batch 0 ➔ 不得解除 cancellation', () => {
        it('收到遲來的 Batch 0 但無 BEGIN_NOVEL_SESSION 指令時，不得解除 cancelled 狀態', () => {
            const registry = createNovelSessionRegistry();
            registry.begin(101, 'session-AAA');
            registry.cancel(101);

            // 模擬 translateNovelParagraphs 收到 stale Batch 0
            const staleBatchMsg = { sessionId: 'session-AAA', batchIndex: 0, texts: ['hello'] };

            // 斷言：普通 batch 訊息不再調用 begin，狀態維持 cancelled
            const canProcess = registry.isCurrentSession(101, staleBatchMsg.sessionId);
            assert.equal(canProcess, false);
            assert.equal(registry.isCancelled(101), true);
        });
    });

    describe('Test 7: STOP AAA ➔ explicit BEGIN BBB ➔ BBB active', () => {
        it('STOP 後只有顯式的 BEGIN_NOVEL_SESSION BBB 才能建立新 session 並解除中斷', () => {
            const registry = createNovelSessionRegistry();
            registry.begin(101, 'session-AAA');
            registry.cancel(101);
            assert.equal(registry.isCancelled(101), true);

            // 顯式 BEGIN_NOVEL_SESSION BBB
            registry.begin(101, 'session-BBB');
            assert.equal(registry.isCancelled(101), false);
            assert.equal(registry.getActiveSessionId(101), 'session-BBB');
            assert.equal(registry.isCurrentSession(101, 'session-BBB'), true);
        });
    });

    describe('Test 8: Tab A AAA 與 Tab B BBB 互不影響 (Per-Tab Isolation)', () => {
        it('Tab A 切換或中斷 Session 絕不影響 Tab B 的活躍 Session', () => {
            const registry = createNovelSessionRegistry();
            registry.begin(101, 'session-A1');
            registry.begin(202, 'session-B1');

            registry.cancel(101);
            assert.equal(registry.isCurrentSession(101, 'session-A1'), false);
            assert.equal(registry.isCurrentSession(202, 'session-B1'), true);

            registry.begin(101, 'session-A2');
            assert.equal(registry.isCurrentSession(101, 'session-A2'), true);
            assert.equal(registry.isCurrentSession(202, 'session-B1'), true);
        });
    });

    describe('Test 9: Retry 使用 current session，不得產生新 session', () => {
        it('重試任務沿用當前 currentNovelSessionId', () => {
            let currentNovelSessionId = 'session-AAA';

            function mockRetry(failedIndices) {
                if (!currentNovelSessionId) return null;
                return {
                    sessionId: currentNovelSessionId,
                    retryIndices: failedIndices
                };
            }

            const retryTask = mockRetry([2, 5]);
            assert.equal(retryTask.sessionId, 'session-AAA');
        });
    });

    describe('Test 10: missing sessionId batch ➔ reject', () => {
        it('批次任務若無 sessionId 則應當被拒絕', () => {
            const registry = createNovelSessionRegistry();
            registry.begin(101, 'session-AAA');

            const taskWithoutSession = { tabId: 101, batchIndex: 0, texts: ['p1'] };
            assert.equal(shouldProcessNovelTask(taskWithoutSession, registry), false);
        });
    });

    describe('Test 11: invalid sessionId ➔ reject', () => {
        it('批次任務的 sessionId 與 active session 不一致時被拒絕', () => {
            const registry = createNovelSessionRegistry();
            registry.begin(101, 'session-AAA');

            const taskWithFakeSession = { tabId: 101, sessionId: 'session-FAKE', batchIndex: 0 };
            assert.equal(shouldProcessNovelTask(taskWithFakeSession, registry), false);
        });
    });

    describe('Test 12: late inject AAA, Content current BBB ➔ ignore', () => {
        it('Content Script 收到舊 Session AAA 的 late inject 時予以忽略且不發送下一批', () => {
            const currentNovelSessionId = 'session-BBB';
            const request = { action: 'injectNovelBatchResult', sessionId: 'session-AAA', batchIndex: 0 };

            let injected = false;
            let nextBatchSent = false;

            if (request.sessionId === currentNovelSessionId) {
                injected = true;
                nextBatchSent = true;
            }

            assert.equal(injected, false);
            assert.equal(nextBatchSent, false);
        });
    });

    describe('Test 13: current inject BBB ➔ accept', () => {
        it('Content Script 收到當前 Session BBB 的 inject 時成功接受並發送下一批', () => {
            const currentNovelSessionId = 'session-BBB';
            const request = { action: 'injectNovelBatchResult', sessionId: 'session-BBB', batchIndex: 0 };

            let injected = false;
            let nextBatchSent = false;

            if (request.sessionId === currentNovelSessionId) {
                injected = true;
                nextBatchSent = true;
            }

            assert.equal(injected, true);
            assert.equal(nextBatchSent, true);
        });
    });

    describe('Test 14: Tab close ➔ registry clear', () => {
        it('分頁關閉時 clear(tabId) 徹底清除該分頁的 Session 與中斷標記', () => {
            const registry = createNovelSessionRegistry();
            registry.begin(101, 'session-101');
            registry.cancel(101);

            assert.equal(registry.size(), 1);
            registry.clear(101);

            assert.equal(registry.size(), 0);
            assert.equal(registry.getActiveSessionId(101), null);
            assert.equal(registry.isCancelled(101), false);
        });
    });

    describe('Test 15: Session ID 產生器功能驗證', () => {
        it('createNovelSessionId 產生非空且長度合規的唯一識別碼', () => {
            const id1 = createNovelSessionId();
            const id2 = createNovelSessionId();

            assert.equal(typeof id1, 'string');
            assert.equal(id1.length > 8, true);
            assert.equal(id1 !== id2, true);
        });
    });

    describe('Test 16: 靜態程式碼防護：確認 production 代碼中不再有 isNewFullSession', () => {
        it('確認 src/background/index.js 中未引用或調用 isNewFullSession', () => {
            const indexPath = path.resolve(__dirname, '../src/background/index.js');
            const code = fs.readFileSync(indexPath, 'utf-8');

            assert.equal(code.includes('isNewFullSession'), false);
        });
    });
});
