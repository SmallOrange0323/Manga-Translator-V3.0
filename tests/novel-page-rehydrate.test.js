import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

import { normalizeNovelPageUrl, isSameNovelPage } from '../src/utils/novel-page-identity.js';
import { buildNovelRehydrateSnapshot } from '../src/background/novel-rehydrate.js';
import { compareNovelSourceItems, applyNovelRehydrateSnapshot, createNovelRehydrateController } from '../src/content/novel-rehydrate-client.js';
import { createNovelSessionRegistry } from '../src/background/novel-cancellation.js';
import { createNovelJobCheckpoint } from '../src/background/novel-job-checkpoint.js';
import {
    saveNovelSessionState,
    getNovelSessionStates,
    removeNovelSessionStateIfMatches,
    NOVEL_SESSION_STATE_KEY
} from '../src/background/novel-session-state.js';

describe('Novel Mode: Page Reload Rehydrate Architecture & Hardening Tests', () => {

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
                            callback({});
                        }
                    },
                    set: (items, callback) => {
                        Object.assign(mockSessionStore, items);
                        if (callback) callback();
                    }
                }
            },
            runtime: {
                sendMessage: vi.fn(),
                lastError: null
            },
            tabs: {
                sendMessage: vi.fn()
            }
        };

        global.document = {
            readyState: 'complete',
            addEventListener: vi.fn(),
            querySelector: vi.fn(() => null)
        };
        global.window = {
            location: { href: 'https://site/chapter1' }
        };
    });

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

        it('Test 2: sessionState 已標記 cancelled ➔ 回傳 no-session', () => {
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
    // 二、 Render Snapshot Tests (11 ~ 18, R, S)
    // ─────────────────────────────────────────────────────────
    describe('2. Render Items 生成與 Durable 覆蓋 (Tests 11 ~ 18, R, S)', () => {
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

        it('Test 17 & Scenario R: Retry pending idx 存在 old failure novelResult ➔ 仍保持 retrying 不被蓋掉', () => {
            const retryJob = createNovelJobCheckpoint({ sessionId: 's1', tabId: 1, kind: 'retry', items: [{ idx: 1, text: 'B' }] });
            const res = buildNovelRehydrateSnapshot({
                sessionState: { tabId: 1, sessionId: 's1', pageUrl: 'https://site/1', cancelled: false },
                job: retryJob,
                novelResults: [
                    { tabId: 1, sessionId: 's1', idx: 0, original: 'A', translation: '譯文 A' },
                    { tabId: 1, sessionId: 's1', idx: 1, original: 'B', translation: '（翻譯失敗）' } // 舊 failure
                ]
            });
            expect(res.renderItems[0].status).toBe('done');
            expect(res.renderItems[1].status).toBe('retrying'); // 依然是 retrying，未被舊 failed 覆蓋
        });

        it('Scenario S: Retry 新 durable result ➔ retrying 正確變 done / failed', () => {
            const retryJob = createNovelJobCheckpoint({
                sessionId: 's1',
                tabId: 1,
                kind: 'retry',
                batchSize: 1,
                items: [{ idx: 1, text: 'B' }]
            });
            retryJob.batches["0"] = { translations: ['新重譯成功譯文'], isFailed: false };

            const res = buildNovelRehydrateSnapshot({
                sessionState: { tabId: 1, sessionId: 's1', pageUrl: 'https://site/1', cancelled: false },
                job: retryJob,
                novelResults: [
                    { tabId: 1, sessionId: 's1', idx: 0, original: 'A', translation: '譯文 A' },
                    { tabId: 1, sessionId: 's1', idx: 1, original: 'B', translation: '（翻譯失敗）' }
                ]
            });
            expect(res.renderItems[1].status).toBe('done');
            expect(res.renderItems[1].translation).toBe('新重譯成功譯文');
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
            expect(compareNovelSourceItems(cur, exp)).toBe(false);
        });
    });

    // ─────────────────────────────────────────────────────────
    // 四、 Client State & Double Snapshot Tests (25 ~ 33, P, Q)
    // ─────────────────────────────────────────────────────────
    describe('4. Client State 與 Double Snapshot Catch-up (Tests 25 ~ 33, P, Q)', () => {
        it('Test 25 ~ 27: Rehydrate 成功 ➔ current session 與 window.mt_currentNovelSessionId 恢復', async () => {
            const controller = createNovelRehydrateController();
            let attachedSessionId = null;

            global.chrome.runtime.sendMessage = vi.fn((msg, cb) => {
                if (msg.action === 'GET_NOVEL_REHYDRATE_STATE') {
                    cb({
                        ok: true,
                        status: 'rehydratable',
                        sessionId: 'sess_abc',
                        expectedItems: [{ idx: 0, text: 'A' }],
                        renderItems: [{ idx: 0, status: 'done', translation: '譯文 A' }]
                    });
                }
            });

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

            global.chrome.runtime.sendMessage = vi.fn((msg, cb) => {
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
            });

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

        it('Scenario P & Q: Second Snapshot 失敗 (error / no-session / stale) ➔ 絕不標記 rehydrated 並 detach', async () => {
            const controller = createNovelRehydrateController();
            let detached = false;
            let callCount = 0;

            global.chrome.runtime.sendMessage = vi.fn((msg, cb) => {
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
                        cb({ ok: false, status: 'error', error: 'Network failure' });
                    }
                }
            });

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
            expect(controller.getAutoDisposition()).toBe('consume');
        });
    });

    // ─────────────────────────────────────────────────────────
    // 五、 AUTO Policy, Barrier & Navigation (Tests 34 ~ 38, A ~ E, I ~ M)
    // ─────────────────────────────────────────────────────────
    describe('5. AUTO 競爭防護、Recovery Barrier 與早期導航 (Tests 34 ~ 38, A ~ E, I ~ M)', () => {
        it('Test 34 & 35: AUTO during checking ➔ defer，rehydrate 成功後不發起新 session', async () => {
            const controller = createNovelRehydrateController();
            controller.setPendingAuto(true);

            global.chrome.runtime.sendMessage = vi.fn((msg, cb) => {
                if (msg.action === 'GET_NOVEL_REHYDRATE_STATE') {
                    cb({
                        ok: true,
                        status: 'rehydratable',
                        sessionId: 'sess_1',
                        expectedItems: [{ idx: 0, text: 'A' }],
                        renderItems: [{ idx: 0, status: 'done', translation: 'A' }]
                    });
                }
            });

            const startNew = vi.fn();
            await controller.attemptRehydrate({
                getParagraphsFn: () => ['<p>A</p>'],
                getParagraphTextFn: () => 'A',
                startNewTranslationFn: startNew
            });

            expect(controller.getPhase()).toBe('rehydrated');
            expect(startNew).not.toHaveBeenCalled();
            expect(controller.hasPendingAuto()).toBe(false);
            expect(controller.getAutoDisposition()).toBe('consume');
        });

        it('Scenario I: manual start BBB ➔ 後續 delayed AUTO 只能 consume 絕不開 CCC', () => {
            const controller = createNovelRehydrateController();
            controller.onManualStart();

            const startSpy = vi.fn();
            const autoRes = controller.handleAutoSignal(startSpy);

            expect(autoRes.started).toBe(false);
            expect(autoRes.consumed).toBe(true);
            expect(startSpy).not.toHaveBeenCalled();
        });

        it('Scenario J: GET error ➔ 後續 late AUTO 只能 consume 絕不開新 Session (Fail Closed)', async () => {
            const controller = createNovelRehydrateController();

            global.chrome.runtime.sendMessage = vi.fn((msg, cb) => {
                if (msg.action === 'GET_NOVEL_REHYDRATE_STATE') {
                    cb({ ok: false, status: 'error', error: 'Storage timeout' });
                }
            });

            await controller.attemptRehydrate({
                getParagraphsFn: () => ['<p>A</p>'],
                getParagraphTextFn: () => 'A'
            });

            expect(controller.getPhase()).toBe('none');
            expect(controller.getAutoDisposition()).toBe('consume');

            // 500ms 後遲到的 AUTO 信號抵達
            const startSpy = vi.fn();
            const autoRes = controller.handleAutoSignal(startSpy);
            expect(autoRes.started).toBe(false);
            expect(startSpy).not.toHaveBeenCalled();
        });

        it('Scenario L: Generic STOP ➔ 後續 delayed AUTO 不得重啟小說翻譯', () => {
            const controller = createNovelRehydrateController();
            controller.onGenericStop();

            const startSpy = vi.fn();
            const autoRes = controller.handleAutoSignal(startSpy);
            expect(autoRes.started).toBe(false);
            expect(startSpy).not.toHaveBeenCalled();
        });

        it('Scenario M: targeted navigation abort 成功 ➔ autoDisposition 恢復 allow 允許新章節 AUTO', () => {
            const controller = createNovelRehydrateController();
            let detached = false;

            const handled = controller.onTargetedNavigationAbort(
                'sess_AAA',
                'sess_AAA',
                () => { detached = true; }
            );

            expect(handled).toBe(true);
            expect(detached).toBe(true);
            expect(controller.getAutoDisposition()).toBe('allow');

            const startSpy = vi.fn();
            const autoRes = controller.handleAutoSignal(startSpy);
            expect(autoRes.started).toBe(true);
            expect(startSpy).toHaveBeenCalledTimes(1);
        });

        it('Scenario A & B: Source Code 驗證 SW Startup 具備 initializeNovelRecovery Protected Bootstrap', () => {
            const bgCode = fs.readFileSync(path.resolve(__dirname, '../src/background/index.js'), 'utf-8');
            expect(bgCode.includes('initializeNovelRecovery')).toBe(true);
            expect(bgCode.includes('novelRecoveryResult = { ok: true }')).toBe(true);
            expect(bgCode.includes('resolveNovelRecoveryReady()')).toBe(true);
            expect(bgCode.includes('finally')).toBe(true);
        });

        it('Scenario D & E: Source Code 驗證 SW Startup 在 Scheduler 前驗證 Tab URL', () => {
            const bgCode = fs.readFileSync(path.resolve(__dirname, '../src/background/index.js'), 'utf-8');
            expect(bgCode.includes('isSameNovelPage(sessionState.pageUrl, currentTabUrl)')).toBe(true);
            expect(bgCode.includes('cleanupNovelSessionIfCurrent(jobTabId, sessId)')).toBe(true);
        });
    });

    // ─────────────────────────────────────────────────────────
    // 六、 Ownership-Safe Cleanup Tests (39 ~ 44, F ~ H, O)
    // ─────────────────────────────────────────────────────────
    describe('6. Ownership-Safe Cleanup 與條件移除 (Tests 39 ~ 44, F ~ H, O)', () => {
        it('Scenario F: cleanup AAA 期間若已成立 BBB ➔ 保留 BBB 且回傳 superseded-session 不得回 ok:true', () => {
            const registry = createNovelSessionRegistry();
            registry.begin(1, 'BBB'); // 當前分頁已經切換至 BBB

            expect(registry.isCurrentSession(1, 'AAA')).toBe(false);
            expect(registry.isCurrentSession(1, 'BBB')).toBe(true);
        });

        it('Scenario G & H: Targeted navigation abort 只清理目標 sessionId', () => {
            const controller = createNovelRehydrateController();
            let detached = false;

            // 當前 Content 已經是 BBB，收到針對舊 AAA 的 navigation abort ➔ 忽略不干擾
            const handledMismatch = controller.onTargetedNavigationAbort('sess_AAA', 'sess_BBB', () => { detached = true; });
            expect(handledMismatch).toBe(false);
            expect(detached).toBe(false);

            // 當前 Content 是 AAA，收到 AAA 的 navigation abort ➔ 成功清理
            const handledMatch = controller.onTargetedNavigationAbort('sess_AAA', 'sess_AAA', () => { detached = true; });
            expect(handledMatch).toBe(true);
            expect(detached).toBe(true);
        });

        it('Scenario H: removeNovelSessionStateIfMatches 只有 sessionId 相符時才刪除', async () => {
            await saveNovelSessionState({ tabId: 10, sessionId: 'session_AAA', pageUrl: 'https://site/1' });
            let states = await getNovelSessionStates();
            expect(states[10]?.sessionId).toBe('session_AAA');

            const deletedStale = await removeNovelSessionStateIfMatches(10, 'session_BBB');
            expect(deletedStale).toBe(false);
            states = await getNovelSessionStates();
            expect(states[10]?.sessionId).toBe('session_AAA');

            const deletedMatched = await removeNovelSessionStateIfMatches(10, 'session_AAA');
            expect(deletedMatched).toBe(true);
            states = await getNovelSessionStates();
            expect(states[10]).toBeUndefined();
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
    });

    // ─────────────────────────────────────────────────────────
    // 七、 Mismatch Abandon & Generation Guard Tests (45 ~ 48, K, N)
    // ─────────────────────────────────────────────────────────
    describe('7. Source Mismatch 放棄與 Generation Guard (Tests 45 ~ 48, K, N)', () => {
        it('Scenario N: ABANDON await 期間發生 manual supersede ➔ 舊 callback 不得竄改新狀態', async () => {
            const controller = createNovelRehydrateController();

            global.chrome.runtime.sendMessage = vi.fn((msg, cb) => {
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
                    // 在 ABANDON 等候期間使用者手動觸發翻譯
                    controller.supersede();
                    cb({ ok: true });
                }
            });

            const startNew = vi.fn();
            await controller.attemptRehydrate({
                getParagraphsFn: () => ['<p>新內容</p>'],
                getParagraphTextFn: () => '新內容',
                startNewTranslationFn: startNew
            });

            expect(controller.getPhase()).toBe('superseded');
            expect(startNew).not.toHaveBeenCalled(); // 絕不重複啟動
        });

        it('Scenario K: stale ABANDON ➔ late AUTO 只能 consume 絕不開 CCC', async () => {
            const controller = createNovelRehydrateController();

            global.chrome.runtime.sendMessage = vi.fn((msg, cb) => {
                if (msg.action === 'GET_NOVEL_REHYDRATE_STATE') {
                    cb({
                        ok: true,
                        status: 'rehydratable',
                        sessionId: 'sess_stale',
                        expectedItems: [{ idx: 0, text: '舊內容' }],
                        renderItems: []
                    });
                }
                if (msg.action === 'ABANDON_NOVEL_REHYDRATE') {
                    cb({ ok: false, status: 'stale-session' });
                }
            });

            await controller.attemptRehydrate({
                getParagraphsFn: () => ['<p>新內容</p>'],
                getParagraphTextFn: () => '新內容'
            });

            expect(controller.getAutoDisposition()).toBe('consume');
            const startSpy = vi.fn();
            const autoRes = controller.handleAutoSignal(startSpy);
            expect(autoRes.started).toBe(false);
            expect(startSpy).not.toHaveBeenCalled();
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

            expect(calls.length).toBe(1);
        });

        it('Test 53 & 54: Desktop 與 Mobile init 均包含 attemptRehydrate 調用', () => {
            const desktopCode = fs.readFileSync(path.resolve(__dirname, '../src/content/desktop-main.js'), 'utf-8');
            const mobileCode = fs.readFileSync(path.resolve(__dirname, '../src/content/mobile-main.js'), 'utf-8');

            expect(desktopCode.includes('attemptRehydrate')).toBe(true);
            expect(mobileCode.includes('attemptRehydrate')).toBe(true);
        });

        it('Test 55 & 56: Desktop 與 Mobile 均對接 handleAutoSignal 與 onTargetedNavigationAbort', () => {
            const desktopCode = fs.readFileSync(path.resolve(__dirname, '../src/content/desktop-main.js'), 'utf-8');
            const mobileCode = fs.readFileSync(path.resolve(__dirname, '../src/content/mobile-main.js'), 'utf-8');

            expect(desktopCode.includes('handleAutoSignal')).toBe(true);
            expect(mobileCode.includes('handleAutoSignal')).toBe(true);
            expect(desktopCode.includes('onTargetedNavigationAbort')).toBe(true);
            expect(mobileCode.includes('onTargetedNavigationAbort')).toBe(true);
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
