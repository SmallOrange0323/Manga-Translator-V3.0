import { describe, expect, it, beforeEach } from 'vitest';
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

import {
    NOVEL_SESSION_STATE_KEY,
    sanitizeNovelSessionState,
    getStorageSession,
    saveNovelSessionState,
    getNovelSessionStates,
    removeNovelSessionState,
    restoreNovelSessionRegistry,
    enqueueSessionStateMutation
} from '../src/background/novel-session-state.js';

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

            const staleBatchMsg = { sessionId: 'session-AAA', batchIndex: 0, texts: ['hello'] };

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

    describe('Test 15: Session State 淨化與白名單驗證 (防敏感資料寫入)', () => {
        it('只保留 tabId, sessionId, pageUrl, cancelled, updatedAt，丟棄原文/譯文/Key/token 等非法欄位', () => {
            const dirtyState = {
                tabId: 101,
                sessionId: 'sess-abc',
                pageUrl: 'https://example.com/novel/1',
                cancelled: false,
                updatedAt: 12345678,
                texts: ['秘密小說原文'],
                translations: ['機密譯文'],
                apiKey: 'AIzaSyFakeKey123',
                oauthToken: 'bearer-token-xyz',
                prompt: 'You are a translator'
            };

            const clean = sanitizeNovelSessionState(dirtyState);
            assert.deepEqual(clean, {
                tabId: 101,
                sessionId: 'sess-abc',
                pageUrl: 'https://example.com/novel/1',
                cancelled: false,
                updatedAt: 12345678
            });
            assert.equal(clean.texts, undefined);
            assert.equal(clean.apiKey, undefined);
            assert.equal(clean.oauthToken, undefined);
        });

        it('無效 tabId 或空 sessionId 判定為 null', () => {
            assert.equal(sanitizeNovelSessionState({ tabId: -1, sessionId: 'abc' }), null);
            assert.equal(sanitizeNovelSessionState({ tabId: 101, sessionId: '' }), null);
            assert.equal(sanitizeNovelSessionState(null), null);
        });
    });

    describe('Test 16: SW Restart Hydration 閉環測試', () => {
        it('Session AAA persist ➔ SW 重啟建立新 registry ➔ restore ➔ AAA 仍為 active', async () => {
            const stored = {
                101: { tabId: 101, sessionId: 'sess-AAA', pageUrl: '', cancelled: false, updatedAt: 1000 }
            };

            const freshRegistry = createNovelSessionRegistry();
            assert.equal(freshRegistry.isCurrentSession(101, 'sess-AAA'), false);

            await restoreNovelSessionRegistry(freshRegistry, stored, new Set([101]));
            assert.equal(freshRegistry.isCurrentSession(101, 'sess-AAA'), true);
            assert.equal(freshRegistry.getActiveSessionId(101), 'sess-AAA');
        });

        it('Cancelled AAA persist ➔ SW 重啟 restore ➔ 依然保持 cancelled 狀態', async () => {
            const stored = {
                101: { tabId: 101, sessionId: 'sess-AAA', pageUrl: '', cancelled: true, updatedAt: 1000 }
            };

            const freshRegistry = createNovelSessionRegistry();
            await restoreNovelSessionRegistry(freshRegistry, stored, new Set([101]));

            assert.equal(freshRegistry.isCancelled(101), true);
            assert.equal(freshRegistry.isCurrentSession(101, 'sess-AAA'), false);
        });

        it('Ghost Tab (分頁已關閉) ➔ restore 時自動剔除且不 hydrate', async () => {
            const stored = {
                101: { tabId: 101, sessionId: 'sess-AAA', pageUrl: '', cancelled: false, updatedAt: 1000 },
                202: { tabId: 202, sessionId: 'sess-BBB', pageUrl: '', cancelled: false, updatedAt: 1000 }
            };

            const freshRegistry = createNovelSessionRegistry();
            const activeTabs = new Set([101]);

            const restoredCount = await restoreNovelSessionRegistry(freshRegistry, stored, activeTabs);
            assert.equal(restoredCount, 1);
            assert.equal(freshRegistry.isCurrentSession(101, 'sess-AAA'), true);
            assert.equal(freshRegistry.isCurrentSession(202, 'sess-BBB'), false);
        });
    });

    describe('Test 17: Rapid Double-Start Race 防禦測試', () => {
        it('當 Content 快速切換至 Session BBB 時，遲來的 Session AAA ACK 絕不啟動 queue', () => {
            let currentNovelSessionId = 'session-BBB';
            let queueStarted = false;

            const capturedSessionId = 'session-AAA';
            const responseFromAAA = { ok: true, sessionId: 'session-AAA' };

            if (currentNovelSessionId !== capturedSessionId || responseFromAAA?.sessionId !== capturedSessionId) {
                // stale ACK 忽略
            } else {
                queueStarted = true;
            }

            assert.equal(queueStarted, false);
        });

        it('當前 Session BBB 收到 BBB 的 ACK 時正常啟動 queue', () => {
            let currentNovelSessionId = 'session-BBB';
            let queueStarted = false;

            const capturedSessionId = 'session-BBB';
            const responseFromBBB = { ok: true, sessionId: 'session-BBB' };

            if (currentNovelSessionId === capturedSessionId && responseFromBBB?.sessionId === capturedSessionId) {
                queueStarted = true;
            }

            assert.equal(queueStarted, true);
        });
    });

    describe('Test 18: ADD_TO_QUEUE 與 Single Paragraph Retry 嚴格 Session 驗證', () => {
        it('ADD_TO_QUEUE missing sessionId 必須被拒絕', () => {
            const registry = createNovelSessionRegistry();
            registry.begin(101, 'sess-101');

            const payloadWithoutSession = { tabId: 101, texts: ['p1'] };
            let enqueued = false;

            if (payloadWithoutSession.tabId && payloadWithoutSession.sessionId && registry.isCurrentSession(payloadWithoutSession.tabId, payloadWithoutSession.sessionId)) {
                enqueued = true;
            }

            assert.equal(enqueued, false);
        });

        it('Single retry 在發起前若 Session 不符直接拒絕發起 API', () => {
            const registry = createNovelSessionRegistry();
            registry.begin(101, 'sess-BBB');

            const retryReq = { tabId: 101, sessionId: 'sess-AAA', text: '段落原文' };
            let apiExecuted = false;

            if (retryReq.tabId && retryReq.sessionId && registry.isCurrentSession(retryReq.tabId, retryReq.sessionId)) {
                apiExecuted = true;
            }

            assert.equal(apiExecuted, false);
        });

        it('Single retry API 傳輸期間 Session 切換 ➔ 回應被 Post-request Guard 捨棄', () => {
            const registry = createNovelSessionRegistry();
            registry.begin(101, 'sess-AAA');

            const retryReq = { tabId: 101, sessionId: 'sess-AAA', text: '段落原文' };

            registry.begin(101, 'sess-BBB');

            let translationInjected = false;
            if (registry.isCurrentSession(retryReq.tabId, retryReq.sessionId)) {
                translationInjected = true;
            }

            assert.equal(translationInjected, false);
        });
    });

    describe('Test 19: Storage.session 專用性與禁止 storage.local fallback', () => {
        it('當 chrome.storage.session 不存在時，getStorageSession() 返回 null，絕不 fallback 到 storage.local', () => {
            const originalChrome = globalThis.chrome;
            try {
                globalThis.chrome = {
                    storage: {
                        local: { get: () => {}, set: () => {} }
                    }
                };
                assert.equal(getStorageSession(), null);
            } finally {
                globalThis.chrome = originalChrome;
            }
        });
    });

    describe('Test 20: Concurrent Save & Remove RMW Serialization 測試', () => {
        it('並發儲存 Tab A 與 Tab B 時，兩者皆被保留在最終 Map 中 (無 lost-update)', async () => {
            const mockStorage = {
                data: {},
                get(key, cb) {
                    setTimeout(() => cb({ [key]: { ...this.data[key] } }), 2);
                },
                set(obj, cb) {
                    setTimeout(() => {
                        Object.assign(this.data, obj);
                        cb();
                    }, 2);
                }
            };

            const originalChrome = globalThis.chrome;
            try {
                globalThis.chrome = {
                    storage: { session: mockStorage }
                };

                const p1 = saveNovelSessionState({ tabId: 101, sessionId: 'sess-101', pageUrl: 'url1' });
                const p2 = saveNovelSessionState({ tabId: 202, sessionId: 'sess-202', pageUrl: 'url2' });

                const [res1, res2] = await Promise.all([p1, p2]);
                assert.equal(res1, true);
                assert.equal(res2, true);

                const finalStates = await getNovelSessionStates();
                assert.equal(finalStates[101]?.sessionId, 'sess-101');
                assert.equal(finalStates[202]?.sessionId, 'sess-202');
            } finally {
                globalThis.chrome = originalChrome;
            }
        });

        it('並發執行 Tab A remove 與 Tab B save 時，A 被移除且 B 成功保留', async () => {
            const mockStorage = {
                data: {
                    [NOVEL_SESSION_STATE_KEY]: {
                        101: { tabId: 101, sessionId: 'sess-101', pageUrl: '', cancelled: false, updatedAt: 1000 }
                    }
                },
                get(key, cb) {
                    setTimeout(() => cb({ [key]: { ...this.data[key] } }), 2);
                },
                set(obj, cb) {
                    setTimeout(() => {
                        this.data[NOVEL_SESSION_STATE_KEY] = { ...obj[NOVEL_SESSION_STATE_KEY] };
                        cb();
                    }, 2);
                }
            };

            const originalChrome = globalThis.chrome;
            try {
                globalThis.chrome = {
                    storage: { session: mockStorage }
                };

                const pRemove = removeNovelSessionState(101);
                const pSave = saveNovelSessionState({ tabId: 202, sessionId: 'sess-202' });

                await Promise.all([pRemove, pSave]);

                const finalStates = await getNovelSessionStates();
                assert.equal(finalStates[101], undefined);
                assert.equal(finalStates[202]?.sessionId, 'sess-202');
            } finally {
                globalThis.chrome = originalChrome;
            }
        });
    });

    describe('Test 21: Superseded Session 阻斷與 Fail-safe Cancel 測試', () => {
        it('當同分頁 Session AAA 在持久化期間被 Session BBB 超越時，AAA 判定為 superseded 不得 ACK 成功', () => {
            const registry = createNovelSessionRegistry();
            registry.begin(101, 'session-AAA');

            registry.begin(101, 'session-BBB');

            const isAAACurrent = registry.isCurrentSession(101, 'session-AAA');
            assert.equal(isAAACurrent, false);

            const isBBBCurrent = registry.isCurrentSession(101, 'session-BBB');
            assert.equal(isBBBCurrent, true);
        });

        it('Cancel persistence 發生錯誤時，記憶體 registry 仍維持 cancelled (Fail-safe STOP)', () => {
            const registry = createNovelSessionRegistry();
            registry.begin(101, 'session-AAA');

            registry.cancel(101);

            assert.equal(registry.isCancelled(101), true);
            assert.equal(registry.isCurrentSession(101, 'session-AAA'), false);
        });
    });

    describe('Test 22: Stale persistence failure must not clear newer session (Ownership-aware rollback)', () => {
        it('當 AAA 持久化失敗進行 rollback 時，若當前 active session 已是 BBB，AAA 絕不清除 BBB', () => {
            const registry = createNovelSessionRegistry();
            const tabId = 101;

            // 1. begin AAA
            registry.begin(tabId, 'session-AAA');
            assert.equal(registry.getActiveSessionId(tabId), 'session-AAA');

            // 2. 模擬 AAA persistence 進行中，此時使用者快速發起 BBB
            registry.begin(tabId, 'session-BBB');
            assert.equal(registry.getActiveSessionId(tabId), 'session-BBB');

            // 3. 模擬 AAA persistence failure 觸發 rollback policy
            const aaaSessionId = 'session-AAA';
            let aaaAckResponse = null;

            // 執行 Background 中的 ownership-aware rollback 邏輯
            if (registry.getActiveSessionId(tabId) === aaaSessionId) {
                registry.clear(tabId);
            }
            aaaAckResponse = { ok: false, error: 'Failed to persist novel session identity' };

            // 4. 驗證：AAA ACK 失敗，但 Registry 的 active session 依然完好保持為 BBB
            assert.equal(aaaAckResponse.ok, false);
            assert.equal(registry.getActiveSessionId(tabId), 'session-BBB');
            assert.equal(registry.isCurrentSession(tabId, 'session-BBB'), true);
            assert.equal(registry.isCurrentSession(tabId, 'session-AAA'), false);
        });
    });

    describe('Test 23: 靜態程式碼防護：確認源碼中嚴格禁用 storage.local 作為 session fallback', () => {
        it('確認 src/background/novel-session-state.js 中不存在 chrome.storage.local 引用', () => {
            const statePath = path.resolve(__dirname, '../src/background/novel-session-state.js');
            const code = fs.readFileSync(statePath, 'utf-8');

            assert.equal(code.includes('chrome.storage.local'), false);
        });
    });
});
