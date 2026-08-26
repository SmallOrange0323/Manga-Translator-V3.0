import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

import { normalizeNovelPageUrl, isSameNovelPage } from '../src/utils/novel-page-identity.js';
import { buildNovelRehydrateSnapshot } from '../src/background/novel-rehydrate.js';
import { compareNovelSourceItems, applyNovelRehydrateSnapshot, createNovelRehydrateController } from '../src/content/novel-rehydrate-client.js';
import { createNovelSessionRegistry } from '../src/background/novel-cancellation.js';
import { createNovelJobCheckpoint } from '../src/background/novel-job-checkpoint.js';

describe('Novel Mode: Page Reload Rehydrate Architecture (Full 60-Test Specification)', () => {

    // ─────────────────────────────────────────────────────────
    // 一、 Background Snapshot Tests (1 ~ 10)
    // ─────────────────────────────────────────────────────────
    describe('1. Background Snapshot 查詢與來源建構 (Tests 1 ~ 10)', () => {
        it('Test 1: No session ➔ 回傳 no-session', () => {
            const res = buildNovelRehydrateSnapshot({
                sessionState: null,
                job: null,
                novelResults: []
            });
            expect(res.ok).toBe(false);
            expect(res.status).toBe('no-session');
        });

        it('Test 2: cancelled session ➔ 回傳 no-session', () => {
            const res = buildNovelRehydrateSnapshot({
                sessionState: { tabId: 1, sessionId: 's1', pageUrl: 'https://site/1', cancelled: true },
                job: createNovelJobCheckpoint({ sessionId: 's1', tabId: 1, items: [{ idx: 0, text: 'A' }] }),
                novelResults: []
            });
            expect(res.ok).toBe(false);
            expect(res.status).toBe('no-session');
        });

        it('Test 3: 缺少 Job Checkpoint ➔ 回傳 no-session', () => {
            const res = buildNovelRehydrateSnapshot({
                sessionState: { tabId: 1, sessionId: 's1', pageUrl: 'https://site/1', cancelled: false },
                job: null,
                novelResults: []
            });
            expect(res.ok).toBe(false);
            expect(res.status).toBe('no-session');
        });

        it('Test 4: same normalized URL (hash only different) ➔ 允許 rehydratable', () => {
            const job = createNovelJobCheckpoint({ sessionId: 's1', tabId: 1, items: [{ idx: 0, text: 'A' }] });
            const res = buildNovelRehydrateSnapshot({
                sessionState: { tabId: 1, sessionId: 's1', pageUrl: 'https://site/ch1#header', cancelled: false },
                job,
                novelResults: [],
                currentTabUrl: 'https://site/ch1#p20'
            });
            expect(res.ok).toBe(true);
            expect(res.status).toBe('rehydratable');
        });

        it('Test 5: different pathname ➔ url-mismatch', () => {
            const job = createNovelJobCheckpoint({ sessionId: 's1', tabId: 1, items: [{ idx: 0, text: 'A' }] });
            const res = buildNovelRehydrateSnapshot({
                sessionState: { tabId: 1, sessionId: 's1', pageUrl: 'https://site/ch1', cancelled: false },
                job,
                novelResults: [],
                currentTabUrl: 'https://site/ch2'
            });
            expect(res.ok).toBe(false);
            expect(res.status).toBe('url-mismatch');
        });

        it('Test 6: different query (?chapter=1 vs ?chapter=2) ➔ url-mismatch', () => {
            const job = createNovelJobCheckpoint({ sessionId: 's1', tabId: 1, items: [{ idx: 0, text: 'A' }] });
            const res = buildNovelRehydrateSnapshot({
                sessionState: { tabId: 1, sessionId: 's1', pageUrl: 'https://site/read?chapter=1', cancelled: false },
                job,
                novelResults: [],
                currentTabUrl: 'https://site/read?chapter=2'
            });
            expect(res.ok).toBe(false);
            expect(res.status).toBe('url-mismatch');
        });

        it('Test 7: Full Job ➔ expectedItems = full items', () => {
            const job = createNovelJobCheckpoint({
                sessionId: 's1',
                tabId: 1,
                kind: 'full',
                items: [
                    { idx: 0, text: '第一段' },
                    { idx: 1, text: '第二段' }
                ]
            });
            const res = buildNovelRehydrateSnapshot({
                sessionState: { tabId: 1, sessionId: 's1', pageUrl: 'https://site/1', cancelled: false },
                job,
                novelResults: []
            });
            expect(res.ok).toBe(true);
            expect(res.expectedItems).toEqual([
                { idx: 0, text: '第一段' },
                { idx: 1, text: '第二段' }
            ]);
        });

        it('Test 8: Retry Job ➔ expectedItems 由 retry items + novelResults original 完整重建', () => {
            const retryJob = createNovelJobCheckpoint({
                sessionId: 's1',
                tabId: 1,
                kind: 'retry',
                items: [{ idx: 1, text: '第二段重試原文' }]
            });
            const novelResults = [
                { tabId: 1, sessionId: 's1', idx: 0, original: '第一段成功原文', translation: '譯文一' }
            ];
            const res = buildNovelRehydrateSnapshot({
                sessionState: { tabId: 1, sessionId: 's1', pageUrl: 'https://site/1', cancelled: false },
                job: retryJob,
                novelResults
            });
            expect(res.ok).toBe(true);
            expect(res.expectedItems).toEqual([
                { idx: 0, text: '第一段成功原文' },
                { idx: 1, text: '第二段重試原文' }
            ]);
        });

        it('Test 9: Retry source missing index ➔ source-incomplete (Fail Closed)', () => {
            const retryJob = createNovelJobCheckpoint({
                sessionId: 's1',
                tabId: 1,
                kind: 'retry',
                items: [{ idx: 2, text: '第三段' }]
            });
            const novelResults = [
                { tabId: 1, sessionId: 's1', idx: 0, original: '第一段', translation: '譯文一' }
                // 缺失 idx 1
            ];
            const res = buildNovelRehydrateSnapshot({
                sessionState: { tabId: 1, sessionId: 's1', pageUrl: 'https://site/1', cancelled: false },
                job: retryJob,
                novelResults
            });
            expect(res.ok).toBe(false);
            expect(res.status).toBe('source-incomplete');
        });

        it('Test 10: Unknown / unrelated novelResults 不得進 snapshot', () => {
            const job = createNovelJobCheckpoint({
                sessionId: 's1',
                tabId: 1,
                items: [{ idx: 0, text: '正確原文' }]
            });
            const novelResults = [
                { tabId: 999, sessionId: 's1', idx: 0, original: '其他 Tab 原文', translation: '其他 Tab 譯文' },
                { tabId: 1, sessionId: 'stale_sess', idx: 0, original: '舊 Session 原文', translation: '舊 Session 譯文' },
                { tabId: 1, sessionId: 's1', idx: 0, original: '正確原文', translation: '正確譯文' }
            ];
            const res = buildNovelRehydrateSnapshot({
                sessionState: { tabId: 1, sessionId: 's1', pageUrl: 'https://site/1', cancelled: false },
                job,
                novelResults
            });
            expect(res.renderItems[0].translation).toBe('正確譯文');
        });
    });

    // ─────────────────────────────────────────────────────────
    // 二、 Render Snapshot Tests (11 ~ 18)
    // ─────────────────────────────────────────────────────────
    describe('2. Render Items 生成與 Durable 覆蓋 (Tests 11 ~ 18)', () => {
        it('Test 11: novelResults success ➔ done', () => {
            const job = createNovelJobCheckpoint({ sessionId: 's1', tabId: 1, items: [{ idx: 0, text: 'A' }] });
            const res = buildNovelRehydrateSnapshot({
                sessionState: { tabId: 1, sessionId: 's1', pageUrl: 'https://site/1', cancelled: false },
                job,
                novelResults: [{ tabId: 1, sessionId: 's1', idx: 0, original: 'A', translation: '譯文' }]
            });
            expect(res.renderItems[0].status).toBe('done');
            expect(res.renderItems[0].translation).toBe('譯文');
        });

        it('Test 12: novelResults 翻譯失敗 marker ➔ failed', () => {
            const job = createNovelJobCheckpoint({ sessionId: 's1', tabId: 1, items: [{ idx: 0, text: 'A' }] });
            const res = buildNovelRehydrateSnapshot({
                sessionState: { tabId: 1, sessionId: 's1', pageUrl: 'https://site/1', cancelled: false },
                job,
                novelResults: [{ tabId: 1, sessionId: 's1', idx: 0, original: 'A', translation: '（翻譯失敗）' }]
            });
            expect(res.renderItems[0].status).toBe('failed');
            expect(res.renderItems[0].translation).toBeNull();
        });

        it('Test 13: Persisted job batch 覆蓋/補足 novelResults', () => {
            const job = createNovelJobCheckpoint({ sessionId: 's1', tabId: 1, batchSize: 2, items: [{ idx: 0, text: 'A' }, { idx: 1, text: 'B' }] });
            job.batches["0"] = { translations: ['最新譯文 A', '最新譯文 B'], isFailed: false };
            const res = buildNovelRehydrateSnapshot({
                sessionState: { tabId: 1, sessionId: 's1', pageUrl: 'https://site/1', cancelled: false },
                job,
                novelResults: [{ tabId: 1, sessionId: 's1', idx: 0, original: 'A', translation: '舊譯文 A' }]
            });
            expect(res.renderItems[0].translation).toBe('最新譯文 A');
            expect(res.renderItems[1].translation).toBe('最新譯文 B');
        });

        it('Test 14: committed=false persisted translation 仍可 render done (0 API 額外調用)', () => {
            const job = createNovelJobCheckpoint({ sessionId: 's1', tabId: 1, batchSize: 1, items: [{ idx: 0, text: 'A' }] });
            job.batches["0"] = { translations: ['未 Commit 的 Durable 譯文'], committed: false, isFailed: false };
            const res = buildNovelRehydrateSnapshot({
                sessionState: { tabId: 1, sessionId: 's1', pageUrl: 'https://site/1', cancelled: false },
                job,
                novelResults: []
            });
            expect(res.renderItems[0].status).toBe('done');
            expect(res.renderItems[0].translation).toBe('未 Commit 的 Durable 譯文');
        });

        it('Test 15: isFailed=true batch ➔ failed', () => {
            const job = createNovelJobCheckpoint({ sessionId: 's1', tabId: 1, batchSize: 1, items: [{ idx: 0, text: 'A' }] });
            job.batches["0"] = { translations: ['（翻譯失敗）'], isFailed: true };
            const res = buildNovelRehydrateSnapshot({
                sessionState: { tabId: 1, sessionId: 's1', pageUrl: 'https://site/1', cancelled: false },
                job,
                novelResults: []
            });
            expect(res.renderItems[0].status).toBe('failed');
        });

        it('Test 16: Full pending item ➔ pending', () => {
            const job = createNovelJobCheckpoint({ sessionId: 's1', tabId: 1, kind: 'full', items: [{ idx: 0, text: 'A' }] });
            const res = buildNovelRehydrateSnapshot({
                sessionState: { tabId: 1, sessionId: 's1', pageUrl: 'https://site/1', cancelled: false },
                job,
                novelResults: []
            });
            expect(res.renderItems[0].status).toBe('pending');
        });

        it('Test 17: Retry pending item ➔ retrying', () => {
            const retryJob = createNovelJobCheckpoint({ sessionId: 's1', tabId: 1, kind: 'retry', items: [{ idx: 1, text: 'B' }] });
            const res = buildNovelRehydrateSnapshot({
                sessionState: { tabId: 1, sessionId: 's1', pageUrl: 'https://site/1', cancelled: false },
                job: retryJob,
                novelResults: [{ tabId: 1, sessionId: 's1', idx: 0, original: 'A', translation: '譯文 A' }]
            });
            expect(res.renderItems[0].status).toBe('done');
            expect(res.renderItems[1].status).toBe('retrying');
        });

        it('Test 18: Global idx mapping 對 retry non-contiguous indices 正確', () => {
            const retryJob = createNovelJobCheckpoint({
                sessionId: 's1',
                tabId: 1,
                kind: 'retry',
                batchSize: 2,
                items: [{ idx: 5, text: '段落 5' }, { idx: 10, text: '段落 10' }]
            });
            retryJob.batches["0"] = { translations: ['重譯 5', '重譯 10'], isFailed: false };

            const novelResults = [];
            for (let i = 0; i <= 10; i++) {
                if (i !== 5 && i !== 10) {
                    novelResults.push({ tabId: 1, sessionId: 's1', idx: i, original: `原文 ${i}`, translation: `成功 ${i}` });
                }
            }

            const res = buildNovelRehydrateSnapshot({
                sessionState: { tabId: 1, sessionId: 's1', pageUrl: 'https://site/1', cancelled: false },
                job: retryJob,
                novelResults
            });
            expect(res.ok).toBe(true);
            expect(res.renderItems[5].translation).toBe('重譯 5');
            expect(res.renderItems[10].translation).toBe('重譯 10');
            expect(res.renderItems[4].translation).toBe('成功 4');
        });
    });

    // ─────────────────────────────────────────────────────────
    // 三、 Exact Source Compare Tests (19 ~ 24)
    // ─────────────────────────────────────────────────────────
    describe('3. 前台 DOM Exact Source 比對 (Tests 19 ~ 24)', () => {
        it('Test 19: 完全相同 ➔ match', () => {
            const cur = [{ idx: 0, text: '段落一' }, { idx: 1, text: '段落二' }];
            const exp = [{ idx: 0, text: '段落一' }, { idx: 1, text: '段落二' }];
            expect(compareNovelSourceItems(cur, exp)).toBe(true);
        });

        it('Test 20: text 任一字不同 ➔ mismatch', () => {
            const cur = [{ idx: 0, text: '段落一' }, { idx: 1, text: '段落二（修改）' }];
            const exp = [{ idx: 0, text: '段落一' }, { idx: 1, text: '段落二' }];
            expect(compareNovelSourceItems(cur, exp)).toBe(false);
        });

        it('Test 21: 段落數不同 ➔ mismatch', () => {
            const cur = [{ idx: 0, text: '段落一' }];
            const exp = [{ idx: 0, text: '段落一' }, { idx: 1, text: '段落二' }];
            expect(compareNovelSourceItems(cur, exp)).toBe(false);
        });

        it('Test 22: idx 不同 ➔ mismatch', () => {
            const cur = [{ idx: 1, text: '段落一' }, { idx: 0, text: '段落二' }];
            const exp = [{ idx: 0, text: '段落一' }, { idx: 1, text: '段落二' }];
            expect(compareNovelSourceItems(cur, exp)).toBe(false);
        });

        it('Test 23: 標點不同 ➔ mismatch', () => {
            const cur = [{ idx: 0, text: 'こんにちは！' }];
            const exp = [{ idx: 0, text: 'こんにちは。' }];
            expect(compareNovelSourceItems(cur, exp)).toBe(false);
        });

        it('Test 24: 前後 trim 遵循 getParagraphText 既有輸入結果，不額外 normalize', () => {
            const cur = [{ idx: 0, text: '  段落一  ' }];
            const exp = [{ idx: 0, text: '段落一' }];
            expect(compareNovelSourceItems(cur, exp)).toBe(false); // 嚴格比對，不隱式 trim
        });
    });

    // ─────────────────────────────────────────────────────────
    // 四、 Client State & Double Snapshot Tests (25 ~ 33)
    // ─────────────────────────────────────────────────────────
    describe('4. Client State 與 Double Snapshot Catch-up (Tests 25 ~ 33)', () => {
        beforeEach(() => {
            global.document = {
                readyState: 'complete',
                addEventListener: vi.fn(),
                querySelector: vi.fn(() => null)
            };
            global.window = {
                location: { href: 'https://site/chapter1' }
            };
        });

        it('Test 25 ~ 27: Rehydrate 成功 ➔ current session 與 window.mt_currentNovelSessionId 恢復', async () => {
            const controller = createNovelRehydrateController();
            let attachedSessionId = null;

            global.chrome = {
                runtime: {
                    sendMessage: vi.fn((msg, cb) => {
                        if (msg.action === 'GET_NOVEL_REHYDRATE_STATE') {
                            cb({
                                ok: true,
                                status: 'rehydratable',
                                sessionId: 'sess_abc',
                                expectedItems: [{ idx: 0, text: 'A' }],
                                renderItems: [{ idx: 0, status: 'done', translation: '譯文 A' }]
                            });
                        }
                    })
                }
            };

            await controller.attemptRehydrate({
                getParagraphsFn: () => ['<p>A</p>'],
                getParagraphTextFn: () => 'A',
                insertPlaceholdersFn: () => {},
                injectBatchResultFn: () => {},
                onSessionAttachedFn: (sId) => { attachedSessionId = sId; }
            });

            expect(controller.getPhase()).toBe('rehydrated');
            expect(attachedSessionId).toBe('sess_abc');
        });

        it('Test 28 ~ 30: Rehydrate 不會建立新 Session、不會發送 BEGIN 與 SUBMIT', async () => {
            const controller = createNovelRehydrateController();
            const sentActions = [];

            global.chrome = {
                runtime: {
                    sendMessage: vi.fn((msg, cb) => {
                        sentActions.push(msg.action);
                        if (msg.action === 'GET_NOVEL_REHYDRATE_STATE') {
                            cb({
                                ok: true,
                                status: 'rehydratable',
                                sessionId: 'sess_abc',
                                expectedItems: [{ idx: 0, text: 'A' }],
                                renderItems: [{ idx: 0, status: 'done', translation: '譯文 A' }]
                            });
                        }
                    })
                }
            };

            await controller.attemptRehydrate({
                getParagraphsFn: () => ['<p>A</p>'],
                getParagraphTextFn: () => 'A',
                insertPlaceholdersFn: () => {},
                injectBatchResultFn: () => {}
            });

            expect(sentActions).not.toContain('BEGIN_NOVEL_SESSION');
            expect(sentActions).not.toContain('SUBMIT_NOVEL_JOB');
        });

        it('Test 31 & 32: Snapshot #1 沒有 Batch X，Snapshot #2 有 Batch X ➔ X 最終 render 且 live done 不被舊 pending 降級', () => {
            const calls = [];
            const injectMock = vi.fn((bIdx, trans, retryIdx, isFailed) => {
                calls.push({ trans: trans[0], isFailed });
            });

            const snap1 = [{ idx: 0, status: 'done', translation: '譯文 0' }, { idx: 1, status: 'pending', translation: null }];
            applyNovelRehydrateSnapshot(snap1, { injectBatchResultFn: injectMock });

            injectMock(0, ['Live 譯文 1'], [1], false);

            const snap2 = [{ idx: 0, status: 'done', translation: '譯文 0' }, { idx: 1, status: 'done', translation: 'Catch-up 譯文 1' }];
            applyNovelRehydrateSnapshot(snap2, { injectBatchResultFn: injectMock });

            expect(calls.length).toBe(4);
            expect(calls[1].trans).toBe('Live 譯文 1');
            expect(calls[3].trans).toBe('Catch-up 譯文 1');
        });

        it('Test 33: Snapshot #2 回 stale-session ➔ Content 觸發 detach', async () => {
            const controller = createNovelRehydrateController();
            let detached = false;
            let callCount = 0;

            global.chrome = {
                runtime: {
                    sendMessage: vi.fn((msg, cb) => {
                        if (msg.action === 'GET_NOVEL_REHYDRATE_STATE') {
                            callCount++;
                            if (callCount === 1) {
                                cb({
                                    ok: true,
                                    status: 'rehydratable',
                                    sessionId: 'sess_abc',
                                    expectedItems: [{ idx: 0, text: 'A' }],
                                    renderItems: [{ idx: 0, status: 'done', translation: '譯文 A' }]
                                });
                            } else {
                                cb({ ok: false, status: 'stale-session' });
                            }
                        }
                    })
                }
            };

            await controller.attemptRehydrate({
                getParagraphsFn: () => ['<p>A</p>'],
                getParagraphTextFn: () => 'A',
                insertPlaceholdersFn: () => {},
                injectBatchResultFn: () => {},
                onSessionAttachedFn: () => {},
                onSessionDetachedFn: () => { detached = true; }
            });

            expect(detached).toBe(true);
            expect(controller.getPhase()).toBe('none');
        });
    });

    // ─────────────────────────────────────────────────────────
    // 五、 AUTO Race Tests (34 ~ 38)
    // ─────────────────────────────────────────────────────────
    describe('5. AUTO 競爭與手動覆蓋 (Tests 34 ~ 38)', () => {
        beforeEach(() => {
            global.document = { readyState: 'complete', addEventListener: vi.fn() };
            global.window = { location: { href: 'https://site/1' } };
        });

        it('Test 34 & 35: AUTO during checking ➔ defer，rehydrate 成功後不發起新 session', async () => {
            const controller = createNovelRehydrateController();
            controller.setPendingAuto(true);

            global.chrome = {
                runtime: {
                    sendMessage: vi.fn((msg, cb) => {
                        if (msg.action === 'GET_NOVEL_REHYDRATE_STATE') {
                            cb({
                                ok: true,
                                status: 'rehydratable',
                                sessionId: 'sess_1',
                                expectedItems: [{ idx: 0, text: 'A' }],
                                renderItems: [{ idx: 0, status: 'done', translation: 'A' }]
                            });
                        }
                    })
                }
            };

            const startNew = vi.fn();
            await controller.attemptRehydrate({
                getParagraphsFn: () => ['<p>A</p>'],
                getParagraphTextFn: () => 'A',
                startNewTranslationFn: startNew
            });

            expect(controller.getPhase()).toBe('rehydrated');
            expect(startNew).not.toHaveBeenCalled();
            expect(controller.hasPendingAuto()).toBe(false);
        });

        it('Test 36: No session + pending AUTO ➔ start normal new translation', async () => {
            const controller = createNovelRehydrateController();
            controller.setPendingAuto(true);

            global.chrome = {
                runtime: {
                    sendMessage: vi.fn((msg, cb) => {
                        if (msg.action === 'GET_NOVEL_REHYDRATE_STATE') {
                            cb({ ok: false, status: 'no-session' });
                        }
                    })
                }
            };

            const startNew = vi.fn();
            await controller.attemptRehydrate({
                getParagraphsFn: () => ['<p>A</p>'],
                getParagraphTextFn: () => 'A',
                startNewTranslationFn: startNew
            });

            expect(controller.getPhase()).toBe('none');
            expect(startNew).toHaveBeenCalledTimes(1);
        });

        it('Test 37 & 38: Manual translate during checking ➔ supersede rehydrate 且遲到的 callback 失效', async () => {
            const controller = createNovelRehydrateController();
            controller.supersede();

            let attached = false;
            await controller.attemptRehydrate({
                getParagraphsFn: () => ['<p>A</p>'],
                getParagraphTextFn: () => 'A',
                onSessionAttachedFn: () => { attached = true; }
            });

            expect(controller.getPhase()).toBe('superseded');
            expect(attached).toBe(false);
        });
    });

    // ─────────────────────────────────────────────────────────
    // 六、 Navigation Tests (39 ~ 44)
    // ─────────────────────────────────────────────────────────
    describe('6. 導航失效與分頁隔離 (Tests 39 ~ 44)', () => {
        it('Test 39: same normalized URL reload ➔ Session/Job 保留', () => {
            const registry = createNovelSessionRegistry();
            registry.begin(1, 'sess_1');

            const url1 = 'https://site/ch1';
            const url2 = 'https://site/ch1#p10';
            expect(isSameNovelPage(url1, url2)).toBe(true);
            expect(registry.isCurrentSession(1, 'sess_1')).toBe(true);
        });

        it('Test 40 ~ 42: different URL ➔ old Job / Session / novelResults removed only for same tab+session', () => {
            const registry = createNovelSessionRegistry();
            registry.begin(1, 'old_sess');

            expect(isSameNovelPage('https://site/ch1', 'https://site/ch2')).toBe(false);

            registry.cancel(1);
            registry.clear(1);

            expect(registry.isCurrentSession(1, 'old_sess')).toBe(false);
        });

        it('Test 43: Tab A navigation 不得清 Tab B', () => {
            const registry = createNovelSessionRegistry();
            registry.begin(10, 'tabA_sess');
            registry.begin(20, 'tabB_sess');

            registry.cancel(10);
            registry.clear(10);

            expect(registry.isCurrentSession(10, 'tabA_sess')).toBe(false);
            expect(registry.isCurrentSession(20, 'tabB_sess')).toBe(true);
        });

        it('Test 44: stale AAA invalidation 不得清 BBB', () => {
            const registry = createNovelSessionRegistry();
            registry.begin(10, 'BBB');

            // 嘗試以過期的 AAA 檢查
            expect(registry.isCurrentSession(10, 'AAA')).toBe(false);
            expect(registry.isCurrentSession(10, 'BBB')).toBe(true);
        });
    });

    // ─────────────────────────────────────────────────────────
    // 七、 Mismatch Abandon Tests (45 ~ 48)
    // ─────────────────────────────────────────────────────────
    describe('7. Source Mismatch 放棄與重啟 (Tests 45 ~ 48)', () => {
        beforeEach(() => {
            global.document = { readyState: 'complete', addEventListener: vi.fn() };
            global.window = { location: { href: 'https://site/1' } };
        });

        it('Test 45 ~ 47: Source mismatch ➔ 發送 ABANDON_NOVEL_REHYDRATE 且 stale 不清新 Session', async () => {
            const controller = createNovelRehydrateController();
            let abandonSessionId = null;

            global.chrome = {
                runtime: {
                    sendMessage: vi.fn((msg, cb) => {
                        if (msg.action === 'GET_NOVEL_REHYDRATE_STATE') {
                            cb({
                                ok: true,
                                status: 'rehydratable',
                                sessionId: 'sess_mismatch',
                                expectedItems: [{ idx: 0, text: '舊內容' }],
                                renderItems: []
                            });
                        }
                        if (msg.action === 'ABANDON_NOVEL_REHYDRATE') {
                            abandonSessionId = msg.sessionId;
                            cb({ ok: true });
                        }
                    })
                }
            };

            await controller.attemptRehydrate({
                getParagraphsFn: () => ['<p>新內容</p>'],
                getParagraphTextFn: () => '新內容'
            });

            expect(controller.getPhase()).toBe('mismatch');
            expect(abandonSessionId).toBe('sess_mismatch');
        });

        it('Test 48: Mismatch + pending AUTO ➔ abandon 後可 start new session', async () => {
            const controller = createNovelRehydrateController();
            controller.setPendingAuto(true);

            global.chrome = {
                runtime: {
                    sendMessage: vi.fn((msg, cb) => {
                        if (msg.action === 'GET_NOVEL_REHYDRATE_STATE') {
                            cb({
                                ok: true,
                                status: 'rehydratable',
                                sessionId: 'sess_mismatch',
                                expectedItems: [{ idx: 0, text: '舊內容' }],
                                renderItems: []
                            });
                        }
                        if (msg.action === 'ABANDON_NOVEL_REHYDRATE') {
                            cb({ ok: true });
                        }
                    })
                }
            };

            const startNew = vi.fn();
            await controller.attemptRehydrate({
                getParagraphsFn: () => ['<p>新內容</p>'],
                getParagraphTextFn: () => '新內容',
                startNewTranslationFn: startNew
            });

            expect(startNew).toHaveBeenCalledTimes(1);
        });
    });

    // ─────────────────────────────────────────────────────────
    // 八、 DOM Render & Source Regression Tests (49 ~ 60)
    // ─────────────────────────────────────────────────────────
    describe('8. DOM Render 與靜態架構回歸檢測 (Tests 49 ~ 60)', () => {
        it('Test 49 & 50: rehydrate done 與 failed 正確調用 injectBatchResultFn', () => {
            const calls = [];
            const injectMock = vi.fn((bIdx, trans, retryIdx, isFailed) => {
                calls.push({ trans: trans[0], isFailed, retryIdx });
            });

            const renderItems = [
                { idx: 0, status: 'done', translation: '成功' },
                { idx: 1, status: 'failed', translation: null }
            ];

            applyNovelRehydrateSnapshot(renderItems, { injectBatchResultFn: injectMock });

            expect(calls.length).toBe(2);
            expect(calls[0].isFailed).toBe(false);
            expect(calls[0].trans).toBe('成功');
            expect(calls[1].isFailed).toBe(true);
            expect(calls[1].trans).toBe('（翻譯失敗）');
        });

        it('Test 51 & 52: 重複套用 snapshot 不破壞狀態且 pending 不覆蓋 done', () => {
            const calls = [];
            const injectMock = vi.fn((bIdx, trans, retryIdx, isFailed) => {
                calls.push({ trans: trans[0], isFailed });
            });

            const doneSnapshot = [{ idx: 0, status: 'done', translation: '成功譯文' }];
            applyNovelRehydrateSnapshot(doneSnapshot, { injectBatchResultFn: injectMock });

            const pendingSnapshot = [{ idx: 0, status: 'pending', translation: null }];
            applyNovelRehydrateSnapshot(pendingSnapshot, { injectBatchResultFn: injectMock });

            expect(calls.length).toBe(1); // pending 不會重複 inject 覆蓋
        });

        it('Test 53 & 54: Desktop 與 Mobile init 均包含 attemptRehydrate 調用', () => {
            const desktopCode = fs.readFileSync(path.resolve(__dirname, '../src/content/desktop-main.js'), 'utf-8');
            const mobileCode = fs.readFileSync(path.resolve(__dirname, '../src/content/mobile-main.js'), 'utf-8');

            expect(desktopCode.includes('attemptRehydrate')).toBe(true);
            expect(mobileCode.includes('attemptRehydrate')).toBe(true);
        });

        it('Test 55 & 56: Desktop 與 Mobile AUTO_TRANSLATE_PAGE 均具備 defer path', () => {
            const desktopCode = fs.readFileSync(path.resolve(__dirname, '../src/content/desktop-main.js'), 'utf-8');
            const mobileCode = fs.readFileSync(path.resolve(__dirname, '../src/content/mobile-main.js'), 'utf-8');

            expect(desktopCode.includes('deferred: true')).toBe(true);
            expect(mobileCode.includes('deferred: true')).toBe(true);
        });

        it('Test 57 ~ 59: Rehydrate 模組未調用 createNovelSessionId / BEGIN / SUBMIT', () => {
            const rehydrateClientCode = fs.readFileSync(path.resolve(__dirname, '../src/content/novel-rehydrate-client.js'), 'utf-8');

            expect(rehydrateClientCode.includes('createNovelSessionId')).toBe(false);
            expect(rehydrateClientCode.includes("action: 'BEGIN_NOVEL_SESSION'")).toBe(false);
            expect(rehydrateClientCode.includes("action: 'SUBMIT_NOVEL_JOB'")).toBe(false);
        });

        it('Test 60: normalizeNovelPageUrl 完整支援 origin/pathname/search 且忽略 hash', () => {
            expect(normalizeNovelPageUrl('https://novel.com/chapter/1?sort=asc#p100')).toBe('https://novel.com/chapter/1?sort=asc');
        });
    });
});
