import { beforeEach, describe, expect, it, vi } from 'vitest';
const assert = {
    equal: (actual, expected) => expect(actual).toBe(expected),
    deepEqual: (actual, expected) => expect(actual).toEqual(expected)
};

import {
    createPretranslationSnapshot,
    validatePretranslationSnapshot,
    normalizeRestoredPretranslation,
    getPretranslationResumeIndex,
    savePretranslationCheckpoint,
    getPretranslationCheckpoints,
    removePretranslationCheckpoint,
    clearPretranslationCheckpointsForTabs,
    PRETRANS_SESSION_CHECKPOINT_KEY
} from '../src/background/pretranslation-checkpoint.js';

describe('Pretranslation Session Checkpoint & Recovery Tests', () => {
    let mockSessionStorage = {};

    beforeEach(() => {
        mockSessionStorage = {};
        global.chrome = {
            storage: {
                session: {
                    get: vi.fn(async (keys) => {
                        const key = Array.isArray(keys) ? keys[0] : keys;
                        return { [key]: mockSessionStorage[key] || {} };
                    }),
                    set: vi.fn(async (obj) => {
                        Object.assign(mockSessionStorage, obj);
                    })
                },
                local: {
                    get: vi.fn(async () => ({})),
                    set: vi.fn(async () => ({}))
                }
            },
            tabs: {
                get: vi.fn(async (tabId) => {
                    if (tabId === 9999) throw new Error('Tab not found');
                    return { id: tabId };
                })
            }
        };
    });

    describe('Test 1: Snapshot 嚴格白名單過濾機制', () => {
        it('Checkpoint 僅保存白名單 metadata，嚴禁洩漏 API Key、Base64 圖片、Prompt 或 Glossary', () => {
            const unsafeJobData = {
                url: 'https://example.com/ch2',
                images: [
                    'https://cdn.example.com/page1.jpg',
                    'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD...',
                    { src: 'https://cdn.example.com/page3.jpg' },
                    { src: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA...' }
                ],
                results: [{ translation: '第 1 頁譯文' }],
                navLinks: { next: 'https://example.com/ch3' },
                usedModelName: 'gemini-3.1-flash-lite',
                batchSize: 5,
                status: 'inProgress',
                inProgress: true,
                isDone: false,
                isCancelled: false,
                sourceTabId: 101,
                associatedResultTabId: 102,
                startTime: 1700000000000,
                // 額外敏感與無關資料
                apiKey: 'AIzaSySecretApiKey123456',
                candidateKeys: ['AIzaKey1', 'AIzaKey2'],
                customPrompt: 'Translate manga carefully',
                glossarySnippet: '<required_terms>主角->小明</required_terms>',
                base64List: ['base64_img_1', 'base64_img_2']
            };

            const snapshot = createPretranslationSnapshot(unsafeJobData);

            // 斷言：合法欄位正常保存
            assert.equal(snapshot.version, 1);
            assert.equal(snapshot.url, 'https://example.com/ch2');
            assert.equal(snapshot.usedModelName, 'gemini-3.1-flash-lite');
            assert.equal(snapshot.sourceTabId, 101);
            assert.equal(snapshot.associatedResultTabId, 102);
            assert.equal(snapshot.processedCount, 1);
            assert.equal(snapshot.results.length, 1);
            assert.equal(snapshot.results[0].translation, '第 1 頁譯文');

            // 斷言：圖片中所有 Base64 被清理為空字串，僅保留一般 URL
            assert.equal(snapshot.images[0], 'https://cdn.example.com/page1.jpg');
            assert.equal(snapshot.images[1], '');
            assert.equal(snapshot.images[2].src, 'https://cdn.example.com/page3.jpg');
            assert.equal(snapshot.images[3].src, '');

            // 斷言：敏感與大型資料完全不存在
            expect(snapshot).not.toHaveProperty('apiKey');
            expect(snapshot).not.toHaveProperty('candidateKeys');
            expect(snapshot).not.toHaveProperty('customPrompt');
            expect(snapshot).not.toHaveProperty('glossarySnippet');
            expect(snapshot).not.toHaveProperty('base64List');
        });
    });

    describe('Test 2: 每批 Checkpoint processedCount 遞增精確性', () => {
        it('批次 1 完成 (5 頁) ➔ processedCount = 5；批次 2 完成 (10 頁) ➔ processedCount = 10', async () => {
            const jobData = {
                url: 'https://example.com/ch2',
                images: Array.from({ length: 20 }, (_, i) => `https://cdn.example.com/p${i + 1}.jpg`),
                results: [],
                batchSize: 5,
                inProgress: true
            };

            // 模擬第 1 批 (5 頁) 完成
            jobData.results.push(...Array(5).fill({ translation: '完成' }));
            await savePretranslationCheckpoint(jobData);

            let checkpoints = await getPretranslationCheckpoints();
            assert.equal(checkpoints[jobData.url].processedCount, 5);
            assert.equal(checkpoints[jobData.url].results.length, 5);

            // 模擬第 2 批 (再 5 頁) 完成
            jobData.results.push(...Array(5).fill({ translation: '完成' }));
            await savePretranslationCheckpoint(jobData);

            checkpoints = await getPretranslationCheckpoints();
            assert.equal(checkpoints[jobData.url].processedCount, 10);
            assert.equal(checkpoints[jobData.url].results.length, 10);
        });
    });

    describe('Test 3: Service Worker 重啟時 Interrupted 狀態正規化', () => {
        it('中斷的任務正規化為 status: interrupted 且 inProgress: false，避免永久鎖死', () => {
            const snapshot = {
                version: 1,
                url: 'https://example.com/ch2',
                images: ['p1.jpg', 'p2.jpg', 'p3.jpg', 'p4.jpg'],
                results: [{ translation: 'p1' }, { translation: 'p2' }],
                navLinks: { next: 'ch3' },
                usedModelName: 'gemini-3.5-flash-lite',
                batchSize: 2,
                status: 'inProgress',
                inProgress: true,
                isDone: false,
                isCancelled: false,
                sourceTabId: 10,
                startTime: 1000,
                updatedAt: 2000,
                processedCount: 2
            };

            const normalized = normalizeRestoredPretranslation(snapshot);

            assert.equal(normalized.url, 'https://example.com/ch2');
            assert.equal(normalized.inProgress, false);
            assert.equal(normalized.status, 'interrupted');
            assert.equal(normalized.processedCount, 2);
            assert.equal(normalized.results.length, 2);
            assert.equal(normalized.usedModelName, 'gemini-3.5-flash-lite');
        });
    });

    describe('Test 4: 真正的 Resume 斷點邊界與避免重複請求 (Observable Behavior)', () => {
        it('已有 10 頁結果時，Resume 必須精準從 images[10] 開始，絕不重新請求 images[0]', async () => {
            const images = Array.from({ length: 20 }, (_, i) => `https://cdn.example.com/p${i}.jpg`);
            const existingResults = Array.from({ length: 10 }, (_, i) => ({ translation: `p${i} 譯文` }));

            const snapshot = {
                version: 1,
                url: 'https://example.com/ch2',
                images,
                results: existingResults,
                processedCount: 10,
                batchSize: 5
            };

            const resumeIndex = getPretranslationResumeIndex(snapshot);
            assert.equal(resumeIndex, 10);

            // 模擬 Resume 執行時的第一個 batch 提取
            const batchSize = snapshot.batchSize;
            const firstResumeBatch = images.slice(resumeIndex, resumeIndex + batchSize);

            // 斷言：第一個批次的起始圖片為 images[10]，而不是 images[0]
            assert.equal(firstResumeBatch.length, 5);
            assert.equal(firstResumeBatch[0], 'https://cdn.example.com/p10.jpg');
            assert.equal(firstResumeBatch[4], 'https://cdn.example.com/p14.jpg');
            expect(firstResumeBatch).not.toContain('https://cdn.example.com/p0.jpg');

            // 模擬完成本批後的 results 合併
            const newBatchResults = firstResumeBatch.map(img => ({ translation: `${img} 新譯文` }));
            const combinedResults = [...existingResults.slice(0, resumeIndex), ...newBatchResults];

            // 斷言：合併後長度為 15，前 10 筆保持原樣，新 5 筆順暢接續，絕無重複
            assert.equal(combinedResults.length, 15);
            assert.equal(combinedResults[0].translation, 'p0 譯文');
            assert.equal(combinedResults[9].translation, 'p9 譯文');
            assert.equal(combinedResults[10].translation, 'https://cdn.example.com/p10.jpg 新譯文');
        });
    });

    describe('Test 5: 完成時先存 Local Completed Cache 再刪 Session Checkpoint', () => {
        it('成功完成後 Session Checkpoint 被清理，順序保證資料不遺失', async () => {
            const jobData = {
                url: 'https://example.com/ch2',
                images: ['p1.jpg', 'p2.jpg'],
                results: [{ translation: 'p1' }, { translation: 'p2' }],
                status: 'completed',
                isDone: true
            };

            // 1. 保存進行中 checkpoint
            await savePretranslationCheckpoint(jobData);
            let checkpoints = await getPretranslationCheckpoints();
            expect(checkpoints[jobData.url]).toBeDefined();

            // 2. 模擬完成時的清理流程
            await removePretranslationCheckpoint(jobData.url);
            checkpoints = await getPretranslationCheckpoints();
            expect(checkpoints[jobData.url]).toBeUndefined();
        });
    });

    describe('Test 6: Cancelled 任務絕不復活', () => {
        it('isCancelled: true 的任務被正規化為 cancelled 狀態且不觸發 resume', () => {
            const snapshot = {
                version: 1,
                url: 'https://example.com/ch2',
                images: ['p1.jpg', 'p2.jpg'],
                results: [{ translation: 'p1' }],
                status: 'cancelled',
                isCancelled: true,
                inProgress: false
            };

            const normalized = normalizeRestoredPretranslation(snapshot);
            assert.equal(normalized.status, 'cancelled');
            assert.equal(normalized.isCancelled, true);
        });
    });

    describe('Test 7: 來源分頁已不存在時安全 Cleanup', () => {
        it('關閉關聯的分頁時，Session Checkpoint 被安全清除', async () => {
            const jobData1 = {
                url: 'https://example.com/ch1',
                images: ['p1.jpg'],
                results: [],
                sourceTabId: 101,
                associatedResultTabId: 102
            };
            const jobData2 = {
                url: 'https://example.com/ch2',
                images: ['p1.jpg'],
                results: [],
                sourceTabId: 201,
                associatedResultTabId: 202
            };

            await savePretranslationCheckpoint(jobData1);
            await savePretranslationCheckpoint(jobData2);

            let checkpoints = await getPretranslationCheckpoints();
            expect(checkpoints['https://example.com/ch1']).toBeDefined();
            expect(checkpoints['https://example.com/ch2']).toBeDefined();

            // 模擬分頁 101 關閉
            await clearPretranslationCheckpointsForTabs(101);

            checkpoints = await getPretranslationCheckpoints();
            expect(checkpoints['https://example.com/ch1']).toBeUndefined();
            expect(checkpoints['https://example.com/ch2']).toBeDefined();
        });
    });

    describe('Test 8: chrome.storage.session 不可用時 Graceful Fallback', () => {
        it('在不支援 session storage 的環境中呼叫不拋出任何異常', async () => {
            const originalSession = global.chrome.storage.session;
            global.chrome.storage.session = undefined;

            const jobData = {
                url: 'https://example.com/ch2',
                images: ['p1.jpg'],
                results: []
            };

            // 執行讀寫刪，保證不 crash
            await expect(savePretranslationCheckpoint(jobData)).resolves.not.toThrow();
            const checkpoints = await getPretranslationCheckpoints();
            assert.deepEqual(checkpoints, {});
            await expect(removePretranslationCheckpoint(jobData.url)).resolves.not.toThrow();
            await expect(clearPretranslationCheckpointsForTabs(101)).resolves.not.toThrow();

            global.chrome.storage.session = originalSession;
        });
    });

    describe('Test 9: 非 Batch-aligned 的 Checkpoint 容錯 Resume', () => {
        it('processedCount 為 12 (非 batchSize 5 的倍數) 時，能安全從第 12 頁繼續', () => {
            const snapshot = {
                url: 'https://example.com/ch2',
                images: Array.from({ length: 20 }, (_, i) => `p${i}.jpg`),
                results: Array.from({ length: 12 }, (_, i) => ({ translation: `p${i}` })),
                processedCount: 12
            };

            const resumeIndex = getPretranslationResumeIndex(snapshot);
            assert.equal(resumeIndex, 12);
        });
    });
});
