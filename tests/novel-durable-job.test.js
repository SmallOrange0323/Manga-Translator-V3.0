import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

import {
    NOVEL_JOBS_KEY,
    sanitizeNovelJobCheckpoint,
    createNovelJobCheckpoint,
    getNovelJobCheckpoints,
    saveNovelJobCheckpoint,
    updateNovelJobCheckpoint,
    removeNovelJobCheckpoint,
    removeNovelJobCheckpointsForTab,
    normalizeRestoredNovelJob,
    getNovelJobBatchItems,
    selectNextRunnableNovelJob
} from '../src/background/novel-job-checkpoint.js';

import { upsertNovelResultItems } from '../src/background/novel-result-store.js';
import { createNovelSessionRegistry } from '../src/background/novel-cancellation.js';

describe('Novel Mode: Background-owned Durable Job & Checkpoint Architecture', () => {

    let mockSessionStore = {};

    beforeEach(() => {
        mockSessionStore = {};

        global.chrome = {
            storage: {
                session: {
                    get: (keys, callback) => {
                        if (typeof keys === 'string') {
                            callback({ [keys]: mockSessionStore[keys] });
                        } else if (Array.isArray(keys)) {
                            const res = {};
                            keys.forEach(k => { res[k] = mockSessionStore[k]; });
                            callback(res);
                        } else if (keys && typeof keys === 'object') {
                            const res = {};
                            for (const k of Object.keys(keys)) {
                                res[k] = mockSessionStore[k] !== undefined ? mockSessionStore[k] : keys[k];
                            }
                            callback(res);
                        } else {
                            callback({ ...mockSessionStore });
                        }
                    },
                    set: (items, callback) => {
                        Object.assign(mockSessionStore, items);
                        if (callback) callback();
                    },
                    remove: (keys, callback) => {
                        const keyArr = Array.isArray(keys) ? keys : [keys];
                        keyArr.forEach(k => delete mockSessionStore[k]);
                        if (callback) callback();
                    }
                }
            },
            runtime: {
                lastError: null
            }
        };
    });

    // ─────────────────────────────────────────────────────────
    // 一、 Checkpoint 結構與白名單驗證 (1 ~ 9)
    // ─────────────────────────────────────────────────────────
    describe('1. Checkpoint 結構與資料淨化', () => {
        it('Test 1: Full job sanitizer 保留合法 whitelist 欄位', () => {
            const raw = {
                version: 1,
                sessionId: 'sess_123',
                tabId: 10,
                pageUrl: 'https://novel.com/chapter1',
                kind: 'full',
                batchSize: 50,
                items: [
                    { idx: 0, text: '第一段' },
                    { idx: 1, text: '第二段' }
                ],
                nextBatchIndex: 0,
                inFlightBatchIndex: null,
                batches: {},
                status: 'pending'
            };
            const clean = sanitizeNovelJobCheckpoint(raw);
            expect(clean).not.toBeNull();
            expect(clean.sessionId).toBe('sess_123');
            expect(clean.tabId).toBe(10);
            expect(clean.kind).toBe('full');
            expect(clean.items.length).toBe(2);
            expect(clean.status).toBe('pending');
        });

        it('Test 2: 未知與敏感欄位 (API Key, OAuth token, prompt, glossary) 被嚴格剔除', () => {
            const raw = {
                version: 1,
                sessionId: 'sess_123',
                tabId: 10,
                batchSize: 50,
                apiKey: 'AIzaSySecretApiKey',
                oauthToken: 'bearer_token_xxx',
                prompt: 'system prompt',
                glossary: { key: 'val' },
                items: [{ idx: 0, text: '一段' }],
                batches: {
                    "0": {
                        translations: ['譯文'],
                        rawApiResponse: { candidates: [] },
                        secretToken: 'secret'
                    }
                }
            };
            const clean = sanitizeNovelJobCheckpoint(raw);
            expect(clean).not.toBeNull();
            expect(clean.apiKey).toBeUndefined();
            expect(clean.oauthToken).toBeUndefined();
            expect(clean.prompt).toBeUndefined();
            expect(clean.glossary).toBeUndefined();
            expect(clean.batches["0"].rawApiResponse).toBeUndefined();
            expect(clean.batches["0"].secretToken).toBeUndefined();
            expect(clean.batches["0"].translations).toEqual(['譯文']);
        });

        it('Test 3: 僅允許 storage.session，沒有 local fallback 支援', async () => {
            delete global.chrome.storage.session;
            const res = createNovelJobCheckpoint({
                sessionId: 'sess_1',
                tabId: 1,
                items: [{ idx: 0, text: 'text' }]
            });
            expect(res).not.toBeNull();
            await expect(saveNovelJobCheckpoint(res)).resolves.toBe(false);
        });

        it('Test 4: Full items 嚴格驗證 idx 連續 (0..N-1) 且有效', () => {
            const clean = sanitizeNovelJobCheckpoint({
                sessionId: 'sess_1',
                tabId: 1,
                kind: 'full',
                batchSize: 50,
                items: [
                    { idx: 0, text: 'A' },
                    { idx: 1, text: 'B' },
                    { idx: 2, text: 'C' }
                ]
            });
            expect(clean).not.toBeNull();
            expect(clean.items.map(i => i.idx)).toEqual([0, 1, 2]);
        });

        it('Test 5: Full items 若缺少中間 index (如 0, 2) 則 reject', () => {
            const clean = sanitizeNovelJobCheckpoint({
                sessionId: 'sess_1',
                tabId: 1,
                kind: 'full',
                batchSize: 50,
                items: [
                    { idx: 0, text: 'A' },
                    { idx: 2, text: 'C' }
                ]
            });
            expect(clean).toBeNull();
        });

        it('Test 6: Full items 若出現重複 idx 則 reject', () => {
            const clean = sanitizeNovelJobCheckpoint({
                sessionId: 'sess_1',
                tabId: 1,
                kind: 'full',
                batchSize: 50,
                items: [
                    { idx: 0, text: 'A' },
                    { idx: 0, text: 'B' }
                ]
            });
            expect(clean).toBeNull();
        });

        it('Test 7: Retry items 支援非連續 idx (例如 7, 12)', () => {
            const clean = sanitizeNovelJobCheckpoint({
                sessionId: 'sess_1',
                tabId: 1,
                kind: 'retry',
                batchSize: 50,
                items: [
                    { idx: 7, text: '段落 7' },
                    { idx: 12, text: '段落 12' }
                ]
            });
            expect(clean).not.toBeNull();
            expect(clean.items[0].idx).toBe(7);
            expect(clean.items[1].idx).toBe(12);
        });

        it('Test 8: Retry items 若有重複 idx 則 reject', () => {
            const clean = sanitizeNovelJobCheckpoint({
                sessionId: 'sess_1',
                tabId: 1,
                kind: 'retry',
                batchSize: 50,
                items: [
                    { idx: 7, text: '段落 7' },
                    { idx: 7, text: '段落 7 重複' }
                ]
            });
            expect(clean).toBeNull();
        });

        it('Test 9: 無效的 batchSize (<= 0 或 non-integer) 則 reject', () => {
            expect(sanitizeNovelJobCheckpoint({ sessionId: 's', tabId: 1, batchSize: 0, items: [{ idx: 0, text: 't' }] })).toBeNull();
            expect(sanitizeNovelJobCheckpoint({ sessionId: 's', tabId: 1, batchSize: -5, items: [{ idx: 0, text: 't' }] })).toBeNull();
            expect(sanitizeNovelJobCheckpoint({ sessionId: 's', tabId: 1, batchSize: 'abc', items: [{ idx: 0, text: 't' }] })).toBeNull();
        });
    });

    // ─────────────────────────────────────────────────────────
    // 二、 Batch 狀態機與生命週期 (10 ~ 17)
    // ─────────────────────────────────────────────────────────
    describe('2. Batch 狀態機與 Durable 推進', () => {
        it('Test 10: pending Batch N 在 API 前標記 inFlightBatchIndex = N', () => {
            const job = createNovelJobCheckpoint({
                sessionId: 'sess_1',
                tabId: 1,
                batchSize: 2,
                items: [{ idx: 0, text: '0' }, { idx: 1, text: '1' }, { idx: 2, text: '2' }]
            });
            job.inFlightBatchIndex = 0;
            job.status = 'processing';
            const clean = sanitizeNovelJobCheckpoint(job);
            expect(clean.inFlightBatchIndex).toBe(0);
            expect(clean.status).toBe('processing');
        });

        it('Test 11: API response 取得後寫入 batches[N]，committed 為 false', () => {
            const job = createNovelJobCheckpoint({
                sessionId: 'sess_1',
                tabId: 1,
                batchSize: 2,
                items: [{ idx: 0, text: '0' }, { idx: 1, text: '1' }]
            });
            job.batches["0"] = {
                translations: ['譯文 0', '譯文 1'],
                isFailed: false,
                committed: false,
                injected: false
            };
            const clean = sanitizeNovelJobCheckpoint(job);
            expect(clean.batches["0"].committed).toBe(false);
            expect(clean.batches["0"].translations.length).toBe(2);
        });

        it('Test 12: committed=false restore 狀態下，normalize 仍指向該 batch 且不重打 API', () => {
            const job = createNovelJobCheckpoint({
                sessionId: 'sess_1',
                tabId: 1,
                batchSize: 2,
                items: [{ idx: 0, text: '0' }, { idx: 1, text: '1' }, { idx: 2, text: '2' }]
            });
            job.batches["0"] = {
                translations: ['譯文 0', '譯文 1'],
                isFailed: false,
                committed: false,
                injected: false
            };
            const restored = normalizeRestoredNovelJob(job);
            expect(restored.nextBatchIndex).toBe(0);
            expect(restored.inFlightBatchIndex).toBeNull();
            expect(restored.batches["0"].committed).toBe(false);
        });

        it('Test 13: inFlightBatchIndex = N 但無 saved result，restore 後重設 inFlight 並重新執行 N', () => {
            const job = createNovelJobCheckpoint({
                sessionId: 'sess_1',
                tabId: 1,
                batchSize: 2,
                items: [{ idx: 0, text: '0' }, { idx: 1, text: '1' }]
            });
            job.inFlightBatchIndex = 0;
            job.status = 'processing';
            const restored = normalizeRestoredNovelJob(job);
            expect(restored.inFlightBatchIndex).toBeNull();
            expect(restored.nextBatchIndex).toBe(0);
        });

        it('Test 14: committed Batch N 後，nextBatchIndex 推進到 N+1', () => {
            const job = createNovelJobCheckpoint({
                sessionId: 'sess_1',
                tabId: 1,
                batchSize: 2,
                items: [{ idx: 0, text: '0' }, { idx: 1, text: '1' }, { idx: 2, text: '2' }]
            });
            job.batches["0"] = {
                translations: ['譯文 0', '譯文 1'],
                isFailed: false,
                committed: true,
                injected: true
            };
            const restored = normalizeRestoredNovelJob(job);
            expect(restored.nextBatchIndex).toBe(1);
        });

        it('Test 15: 全部批次 committed 後，status 自動標記為 completed', () => {
            const job = createNovelJobCheckpoint({
                sessionId: 'sess_1',
                tabId: 1,
                batchSize: 2,
                items: [{ idx: 0, text: '0' }, { idx: 1, text: '1' }]
            });
            job.batches["0"] = {
                translations: ['譯文 0', '譯文 1'],
                isFailed: false,
                committed: true,
                injected: true
            };
            const restored = normalizeRestoredNovelJob(job);
            expect(restored.nextBatchIndex).toBe(1);
            expect(restored.status).toBe('completed');
        });

        it('Test 16: partial mapped failure 仍屬於 isFailed = false 的正常結構化批次', () => {
            const job = createNovelJobCheckpoint({
                sessionId: 'sess_1',
                tabId: 1,
                batchSize: 2,
                items: [{ idx: 0, text: '0' }, { idx: 1, text: '1' }]
            });
            job.batches["0"] = {
                translations: ['成功譯文', '（翻譯失敗）'],
                isFailed: false,
                committed: false
            };
            const clean = sanitizeNovelJobCheckpoint(job);
            expect(clean.batches["0"].isFailed).toBe(false);
            expect(clean.batches["0"].translations[1]).toBe('（翻譯失敗）');
        });

        it('Test 17: total API error 標記 isFailed = true 且包含全部失敗占位譯文', () => {
            const job = createNovelJobCheckpoint({
                sessionId: 'sess_1',
                tabId: 1,
                batchSize: 2,
                items: [{ idx: 0, text: '0' }, { idx: 1, text: '1' }]
            });
            job.batches["0"] = {
                translations: ['（翻譯失敗）', '（翻譯失敗）'],
                isFailed: true,
                committed: false
            };
            const clean = sanitizeNovelJobCheckpoint(job);
            expect(clean.batches["0"].isFailed).toBe(true);
        });
    });

    // ─────────────────────────────────────────────────────────
    // 三、 novelResults 等冪寫入 (Idempotency) (18 ~ 21)
    // ─────────────────────────────────────────────────────────
    describe('3. novelResults 等冪寫入 (Idempotency)', () => {
        it('Test 18: 同一 sessionId + idx 重複寫入時 replace 舊值，不產生 duplicate', () => {
            const current = [
                { sessionId: 's1', tabId: 1, idx: 0, original: 'A', translation: '舊譯文' },
                { sessionId: 's1', tabId: 1, idx: 1, original: 'B', translation: '譯文 B' }
            ];
            const incoming = [
                { sessionId: 's1', tabId: 1, idx: 0, original: 'A', translation: '新譯文' }
            ];
            const updated = upsertNovelResultItems(current, incoming);
            expect(updated.length).toBe(2);
            const idx0 = updated.find(i => i.sessionId === 's1' && i.idx === 0);
            expect(idx0.translation).toBe('新譯文');
        });

        it('Test 19: 不同 Session 同樣的 idx，兩者均完整保留', () => {
            const current = [
                { sessionId: 's1', tabId: 1, idx: 0, original: 'A', translation: 'Session 1 譯文' }
            ];
            const incoming = [
                { sessionId: 's2', tabId: 2, idx: 0, original: 'A', translation: 'Session 2 譯文' }
            ];
            const updated = upsertNovelResultItems(current, incoming);
            expect(updated.length).toBe(2);
        });

        it('Test 20: Retry 時同一 session + idx，舊的失敗結果被新譯文覆蓋', () => {
            const current = [
                { sessionId: 's1', tabId: 1, idx: 7, original: 'A', translation: '（翻譯失敗）' }
            ];
            const incoming = [
                { sessionId: 's1', tabId: 1, idx: 7, original: 'A', translation: '重試成功譯文' }
            ];
            const updated = upsertNovelResultItems(current, incoming);
            expect(updated.length).toBe(1);
            expect(updated[0].translation).toBe('重試成功譯文');
        });

        it('Test 21: 重複 replay 相同 batch 兩次，novelResults 數量與內容完全不變', () => {
            const current = [
                { sessionId: 's1', tabId: 1, idx: 0, original: 'A', translation: '譯文 A' }
            ];
            const incoming = [
                { sessionId: 's1', tabId: 1, idx: 0, original: 'A', translation: '譯文 A' }
            ];
            const firstPass = upsertNovelResultItems(current, incoming);
            const secondPass = upsertNovelResultItems(firstPass, incoming);
            expect(secondPass.length).toBe(1);
            expect(secondPass[0].translation).toBe('譯文 A');
        });
    });

    // ─────────────────────────────────────────────────────────
    // 四、 Service Worker 重啟恢復與 Replay (22 ~ 26)
    // ─────────────────────────────────────────────────────────
    describe('4. Service Worker 崩潰與重啟恢復策略', () => {
        it('Test 22: API 執行前崩潰 ➔ 重啟後 request 可安全從該 batch 重新發起', () => {
            const job = createNovelJobCheckpoint({
                sessionId: 's1',
                tabId: 1,
                batchSize: 2,
                items: [{ idx: 0, text: 'A' }, { idx: 1, text: 'B' }]
            });
            job.nextBatchIndex = 0;
            const restored = normalizeRestoredNovelJob(job);
            expect(restored.nextBatchIndex).toBe(0);
            expect(restored.inFlightBatchIndex).toBeNull();
        });

        it('Test 23: API 執行期間崩潰 ➔ inFlight 重設為 null，batch 重新執行', () => {
            const job = createNovelJobCheckpoint({
                sessionId: 's1',
                tabId: 1,
                batchSize: 2,
                items: [{ idx: 0, text: 'A' }, { idx: 1, text: 'B' }]
            });
            job.inFlightBatchIndex = 0;
            const restored = normalizeRestoredNovelJob(job);
            expect(restored.inFlightBatchIndex).toBeNull();
            expect(restored.nextBatchIndex).toBe(0);
        });

        it('Test 24: Response 已 Checkpoint 但 novelResults 未 commit 崩潰 ➔ 重啟後不二次發起 Gemini API', () => {
            const job = createNovelJobCheckpoint({
                sessionId: 's1',
                tabId: 1,
                batchSize: 2,
                items: [{ idx: 0, text: 'A' }, { idx: 1, text: 'B' }]
            });
            job.batches["0"] = {
                translations: ['已存譯文 A', '已存譯文 B'],
                committed: false,
                isFailed: false
            };
            const restored = normalizeRestoredNovelJob(job);
            expect(restored.nextBatchIndex).toBe(0);
            expect(restored.batches["0"].translations).toEqual(['已存譯文 A', '已存譯文 B']);
            expect(restored.batches["0"].committed).toBe(false);
        });

        it('Test 25: novelResults upsert 後在 committed flag 寫入前崩潰 ➔ replay upsert 無 duplicate', () => {
            const initialResults = [
                { sessionId: 's1', tabId: 1, idx: 0, original: 'A', translation: '譯文 A' }
            ];
            const incoming = [
                { sessionId: 's1', tabId: 1, idx: 0, original: 'A', translation: '譯文 A' }
            ];
            const replayed = upsertNovelResultItems(initialResults, incoming);
            expect(replayed.length).toBe(1);
        });

        it('Test 26: Completed Job 重啟後不再執行 API', () => {
            const job = createNovelJobCheckpoint({
                sessionId: 's1',
                tabId: 1,
                batchSize: 2,
                items: [{ idx: 0, text: 'A' }, { idx: 1, text: 'B' }]
            });
            job.batches["0"] = {
                translations: ['譯文 A', '譯文 B'],
                committed: true,
                isFailed: false
            };
            const restored = normalizeRestoredNovelJob(job);
            expect(restored.status).toBe('completed');
            expect(restored.nextBatchIndex).toBe(1);
        });
    });

    // ─────────────────────────────────────────────────────────
    // 五、 Session Lifecycle、STOP 與 Tab 關閉 (27 ~ 32)
    // ─────────────────────────────────────────────────────────
    describe('5. Session Lifecycle、STOP 與 Tab 關閉', () => {
        it('Test 27: Stale Session Job ➔ selectNextRunnableNovelJob 自動略過', () => {
            const registry = createNovelSessionRegistry();
            registry.begin(1, 'active_session');

            const jobsMap = {
                'stale_session': createNovelJobCheckpoint({
                    sessionId: 'stale_session',
                    tabId: 1,
                    items: [{ idx: 0, text: 'A' }]
                })
            };

            const next = selectNextRunnableNovelJob(jobsMap, registry);
            expect(next).toBeNull();
        });

        it('Test 28: STOP (removeNovelJobCheckpointsForTab) ➔ 該分頁 Checkpoint 完全被清除', async () => {
            const job1 = createNovelJobCheckpoint({ sessionId: 's1', tabId: 10, items: [{ idx: 0, text: 'A' }] });
            const job2 = createNovelJobCheckpoint({ sessionId: 's2', tabId: 20, items: [{ idx: 0, text: 'B' }] });

            await saveNovelJobCheckpoint(job1);
            await saveNovelJobCheckpoint(job2);

            const count = await removeNovelJobCheckpointsForTab(10);
            expect(count).toBe(1);

            const remaining = await getNovelJobCheckpoints();
            expect(remaining['s1']).toBeUndefined();
            expect(remaining['s2']).toBeDefined();
        });

        it('Test 29: STOP during API ➔ late result 不得通過 isCurrentSession', () => {
            const registry = createNovelSessionRegistry();
            registry.begin(1, 's1');
            registry.cancel(1); // 使用者點擊 STOP

            expect(registry.isCurrentSession(1, 's1')).toBe(false);
        });

        it('Test 30: BEGIN 新 Session BBB ➔ 同分頁舊 Session AAA Job 被清除', async () => {
            const jobAAA = createNovelJobCheckpoint({ sessionId: 'AAA', tabId: 1, items: [{ idx: 0, text: 'A' }] });
            await saveNovelJobCheckpoint(jobAAA);

            await removeNovelJobCheckpointsForTab(1);

            const jobBBB = createNovelJobCheckpoint({ sessionId: 'BBB', tabId: 1, items: [{ idx: 0, text: 'B' }] });
            await saveNovelJobCheckpoint(jobBBB);

            const all = await getNovelJobCheckpoints();
            expect(all['AAA']).toBeUndefined();
            expect(all['BBB']).toBeDefined();
        });

        it('Test 31: Tab 關閉 (onRemoved) ➔ 該分頁 Job Checkpoint 被移除', async () => {
            const job = createNovelJobCheckpoint({ sessionId: 's1', tabId: 99, items: [{ idx: 0, text: 'A' }] });
            await saveNovelJobCheckpoint(job);

            await removeNovelJobCheckpointsForTab(99);

            const all = await getNovelJobCheckpoints();
            expect(all['s1']).toBeUndefined();
        });

        it('Test 32: Tab 關閉後 ➔ selectNextRunnableNovelJob 依 activeTabIdSet 拒絕選取該分頁 Job', () => {
            const registry = createNovelSessionRegistry();
            registry.begin(99, 's1');

            const jobsMap = {
                's1': createNovelJobCheckpoint({ sessionId: 's1', tabId: 99, items: [{ idx: 0, text: 'A' }] })
            };

            const activeTabs = new Set([1, 2, 3]); // 99 不在 activeTabs 內
            const next = selectNextRunnableNovelJob(jobsMap, registry, activeTabs);
            expect(next).toBeNull();
        });
    });

    // ─────────────────────────────────────────────────────────
    // 六、 多分頁公平調度與 Mutation 序列化 (33 ~ 37)
    // ─────────────────────────────────────────────────────────
    describe('6. 多分頁公平調度與並發防禦', () => {
        it('Test 33: Tab A 與 Tab B 的 Job Checkpoint 在 storage.session 中共存', async () => {
            const jobA = createNovelJobCheckpoint({ sessionId: 'sA', tabId: 1, items: [{ idx: 0, text: 'A' }] });
            const jobB = createNovelJobCheckpoint({ sessionId: 'sB', tabId: 2, items: [{ idx: 0, text: 'B' }] });

            await saveNovelJobCheckpoint(jobA);
            await saveNovelJobCheckpoint(jobB);

            const all = await getNovelJobCheckpoints();
            expect(all['sA']).toBeDefined();
            expect(all['sB']).toBeDefined();
        });

        it('Test 34: 並發更新 Tab A 與 Tab B ➔ 透過 Promise Chain 序列化，無 Lost Update', async () => {
            const jobA = createNovelJobCheckpoint({ sessionId: 'sA', tabId: 1, items: [{ idx: 0, text: 'A' }] });
            const jobB = createNovelJobCheckpoint({ sessionId: 'sB', tabId: 2, items: [{ idx: 0, text: 'B' }] });

            await Promise.all([
                saveNovelJobCheckpoint(jobA),
                saveNovelJobCheckpoint(jobB)
            ]);

            const all = await getNovelJobCheckpoints();
            expect(Object.keys(all).length).toBe(2);
        });

        it('Test 35: remove Tab A 的 Job ➔ 絕不影響 Tab B 的 Job', async () => {
            const jobA = createNovelJobCheckpoint({ sessionId: 'sA', tabId: 1, items: [{ idx: 0, text: 'A' }] });
            const jobB = createNovelJobCheckpoint({ sessionId: 'sB', tabId: 2, items: [{ idx: 0, text: 'B' }] });

            await saveNovelJobCheckpoint(jobA);
            await saveNovelJobCheckpoint(jobB);

            await removeNovelJobCheckpoint('sA');

            const all = await getNovelJobCheckpoints();
            expect(all['sA']).toBeUndefined();
            expect(all['sB']).toBeDefined();
        });

        it('Test 36: getNovelJobBatchItems 正確切分單一批次 items', () => {
            const job = createNovelJobCheckpoint({
                sessionId: 's1',
                tabId: 1,
                batchSize: 2,
                items: [
                    { idx: 0, text: 'A' },
                    { idx: 1, text: 'B' },
                    { idx: 2, text: 'C' }
                ]
            });
            const b0 = getNovelJobBatchItems(job, 0);
            expect(b0.length).toBe(2);
            expect(b0[0].idx).toBe(0);
            expect(b0[1].idx).toBe(1);

            const b1 = getNovelJobBatchItems(job, 1);
            expect(b1.length).toBe(1);
            expect(b1[0].idx).toBe(2);
        });

        it('Test 37: 調度公平性：Job A Batch 完成更新 updatedAt 後，下一次優先選取較舊的 Job B', () => {
            const registry = createNovelSessionRegistry();
            registry.begin(1, 'sA');
            registry.begin(2, 'sB');

            const jobA = createNovelJobCheckpoint({ sessionId: 'sA', tabId: 1, items: [{ idx: 0, text: 'A' }] });
            const jobB = createNovelJobCheckpoint({ sessionId: 'sB', tabId: 2, items: [{ idx: 0, text: 'B' }] });

            jobA.updatedAt = 2000;
            jobB.updatedAt = 1000;

            const jobsMap = { 'sA': jobA, 'sB': jobB };
            const next = selectNextRunnableNovelJob(jobsMap, registry);
            expect(next.sessionId).toBe('sB'); // 優先選取較久未執行的 Job B
        });
    });

    // ─────────────────────────────────────────────────────────
    // 七、 前台 Content Script 架構靜態檢查 (38 ~ 44)
    // ─────────────────────────────────────────────────────────
    describe('7. 前台 Content Script 架構靜態檢查', () => {
        it('Test 38: Desktop production source 不再有 novelBatchQueue 變數', () => {
            const code = fs.readFileSync(path.resolve(__dirname, '../src/content/desktop-main.js'), 'utf-8');
            expect(code.includes('let novelBatchQueue')).toBe(false);
            expect(code.includes('novelBatchQueue =')).toBe(false);
        });

        it('Test 39: Mobile production source 不再有 novelBatchQueue 變數', () => {
            const code = fs.readFileSync(path.resolve(__dirname, '../src/content/mobile-main.js'), 'utf-8');
            expect(code.includes('let novelBatchQueue')).toBe(false);
            expect(code.includes('novelBatchQueue =')).toBe(false);
        });

        it('Test 40: Desktop 不再有 sendNextNovelBatch 作為調度器', () => {
            const code = fs.readFileSync(path.resolve(__dirname, '../src/content/desktop-main.js'), 'utf-8');
            expect(code.includes('function sendNextNovelBatch')).toBe(false);
            expect(code.includes('sendNextNovelBatch()')).toBe(false);
        });

        it('Test 41: Mobile 不再有 sendNextNovelBatch 作為調度器', () => {
            const code = fs.readFileSync(path.resolve(__dirname, '../src/content/mobile-main.js'), 'utf-8');
            expect(code.includes('function sendNextNovelBatch')).toBe(false);
            expect(code.includes('sendNextNovelBatch()')).toBe(false);
        });

        it('Test 42: injectNovelBatchResult handler 不再觸發下一批拉取訊息', () => {
            const desktopCode = fs.readFileSync(path.resolve(__dirname, '../src/content/desktop-main.js'), 'utf-8');
            const mobileCode = fs.readFileSync(path.resolve(__dirname, '../src/content/mobile-main.js'), 'utf-8');
            expect(desktopCode.includes('sendNextNovelBatch')).toBe(false);
            expect(mobileCode.includes('sendNextNovelBatch')).toBe(false);
        });

        it('Test 43: Desktop startNovelTranslation 一次發送 SUBMIT_NOVEL_JOB 完整 items', () => {
            const code = fs.readFileSync(path.resolve(__dirname, '../src/content/desktop-main.js'), 'utf-8');
            expect(code.includes("action: 'SUBMIT_NOVEL_JOB'")).toBe(true);
            expect(code.includes("kind: 'full'")).toBe(true);
        });

        it('Test 44: Desktop retryAllFailedNovels 一次發送 SUBMIT_NOVEL_JOB retry items', () => {
            const code = fs.readFileSync(path.resolve(__dirname, '../src/content/desktop-main.js'), 'utf-8');
            expect(code.includes("kind: 'retry'")).toBe(true);
        });
    });
});
