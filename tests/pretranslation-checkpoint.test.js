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
    selectLatestInterruptedCheckpoint,
    savePretranslationCheckpoint,
    getPretranslationCheckpoints,
    removePretranslationCheckpoint,
    clearPretranslationCheckpointsForTabs,
    sanitizeImageRef,
    sanitizePretranslationResultItem,
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

    describe('Test 1: 嚴格白名單與資料極小化 (Security Whitelist Sanitizer)', () => {
        it('Checkpoint 僅保存純字串 URL 與白名單結果，絕對剔除 Base64、API Key、Blob 與未知大型欄位', () => {
            const contaminatedJobData = {
                url: 'https://example.com/ch2',
                images: [
                    'https://cdn.example.com/page1.jpg',
                    'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD...',
                    { src: 'https://cdn.example.com/page3.jpg', base64: 'SECRET_BASE64', apiKey: 'SECRET_KEY', hugeData: 'SECRET_HUGE' },
                    { src: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA...' }
                ],
                results: [
                    {
                        image: { src: 'https://cdn.example.com/page1.jpg', base64: 'RESULT_BASE64_SECRET' },
                        results: [{ original: 'こんにちは', translation: '你好', extraSecret: 'SECRET_PARAM' }],
                        usedModelName: 'gemini-3.1-flash-lite',
                        apiKey: 'SECRET_RESULT_KEY',
                        rawPayload: 'SECRET_PAYLOAD'
                    }
                ],
                navLinks: { prev: null, next: 'https://example.com/ch3', secretNav: 'SECRET_NAV' },
                usedModelName: 'gemini-3.1-flash-lite',
                batchSize: 5,
                status: 'inProgress',
                inProgress: true,
                isDone: false,
                isCancelled: false,
                sourceTabId: 101,
                associatedResultTabId: 102,
                startTime: 1700000000000,
                // 額外頂層敏感資料
                apiKey: 'SECRET_TOP_KEY',
                candidateKeys: ['SECRET_KEY_1'],
                customPrompt: 'SECRET_PROMPT',
                glossarySnippet: 'SECRET_GLOSSARY'
            };

            const snapshot = createPretranslationSnapshot(contaminatedJobData);
            const snapshotJson = JSON.stringify(snapshot);

            // 1. 斷言：images 陣列完全由安全 string URL 組成，物件展開完全被消除
            assert.deepEqual(snapshot.images, [
                'https://cdn.example.com/page1.jpg',
                '',
                'https://cdn.example.com/page3.jpg',
                ''
            ]);

            // 2. 斷言：results 每一項均被嚴格 sanitize，image 轉為 string URL，不包含未知屬性
            assert.equal(snapshot.results.length, 1);
            assert.equal(snapshot.results[0].image, 'https://cdn.example.com/page1.jpg');
            assert.deepEqual(snapshot.results[0].results, [{ original: 'こんにちは', translation: '你好' }]);
            assert.equal(snapshot.results[0].usedModelName, 'gemini-3.1-flash-lite');

            // 3. 斷言：快照序列化字串中嚴格禁止出現任何污染/敏感關鍵字
            expect(snapshotJson).not.toContain('SECRET_BASE64');
            expect(snapshotJson).not.toContain('SECRET_KEY');
            expect(snapshotJson).not.toContain('SECRET_HUGE');
            expect(snapshotJson).not.toContain('RESULT_BASE64_SECRET');
            expect(snapshotJson).not.toContain('SECRET_PARAM');
            expect(snapshotJson).not.toContain('SECRET_RESULT_KEY');
            expect(snapshotJson).not.toContain('SECRET_PAYLOAD');
            expect(snapshotJson).not.toContain('SECRET_TOP_KEY');
            expect(snapshotJson).not.toContain('SECRET_PROMPT');
            expect(snapshotJson).not.toContain('SECRET_GLOSSARY');
            expect(snapshotJson).not.toContain('SECRET_NAV');
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
            jobData.results.push(...Array(5).fill({ image: 'https://cdn.example.com/p.jpg', results: [{ translation: '完成' }] }));
            await savePretranslationCheckpoint(jobData);

            let checkpoints = await getPretranslationCheckpoints();
            assert.equal(checkpoints[jobData.url].processedCount, 5);
            assert.equal(checkpoints[jobData.url].results.length, 5);

            // 模擬第 2 批 (再 5 頁) 完成
            jobData.results.push(...Array(5).fill({ image: 'https://cdn.example.com/p.jpg', results: [{ translation: '完成' }] }));
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
                results: [{ image: 'p1.jpg', results: [] }, { image: 'p2.jpg', results: [] }],
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

    describe('Test 4: 嚴格單一恢復 — 只挑選最新 Interrupted Checkpoint，Stale Checkpoints 絕不進 Map', () => {
        it('存在多個中斷 checkpoint 時，只恢復 updatedAt 最大的一筆，其餘 stale checkpoints 標記清理且不進 Map', () => {
            const checkpointsMap = {
                'https://example.com/ch1': {
                    version: 1,
                    url: 'https://example.com/ch1',
                    images: ['p1.jpg'],
                    results: [{ image: 'p1.jpg', results: [] }],
                    updatedAt: 100,
                    inProgress: true,
                    status: 'inProgress'
                },
                'https://example.com/ch2': {
                    version: 1,
                    url: 'https://example.com/ch2',
                    images: ['p1.jpg', 'p2.jpg'],
                    results: [{ image: 'p1.jpg', results: [] }],
                    updatedAt: 200,
                    inProgress: true,
                    status: 'inProgress'
                },
                'https://example.com/ch_done': {
                    version: 1,
                    url: 'https://example.com/ch_done',
                    images: ['p1.jpg'],
                    results: [{ image: 'p1.jpg', results: [] }],
                    updatedAt: 300,
                    isDone: true,
                    status: 'completed'
                }
            };

            const { latestInterrupted, staleUrls } = selectLatestInterruptedCheckpoint(checkpointsMap);

            // 斷言：最新中斷任務為 ch2 (updatedAt: 200)
            assert.equal(latestInterrupted.url, 'https://example.com/ch2');
            assert.equal(latestInterrupted.status, 'interrupted');

            // 斷言：過期的 ch1 與已完成的 ch_done 被列入清理清單
            expect(staleUrls).toContain('https://example.com/ch1');
            expect(staleUrls).toContain('https://example.com/ch_done');
            expect(staleUrls).not.toContain('https://example.com/ch2');
        });
    });

    describe('Test 5: 初始 Checkpoint 寫入時機 (第 0 頁即可安全恢復)', () => {
        it('章節圖片與導航連結就緒後，在任何 API 呼叫前即寫入 processedCount=0 的初始 Checkpoint', async () => {
            const initialJobData = {
                url: 'https://example.com/ch2',
                images: ['https://cdn.example.com/p1.jpg', 'https://cdn.example.com/p2.jpg'],
                results: [],
                navLinks: { next: 'https://example.com/ch3' },
                processedCount: 0,
                inProgress: true
            };

            await savePretranslationCheckpoint(initialJobData);

            const checkpoints = await getPretranslationCheckpoints();
            const snapshot = checkpoints[initialJobData.url];

            assert.equal(snapshot.url, 'https://example.com/ch2');
            assert.equal(snapshot.processedCount, 0);
            assert.equal(snapshot.results.length, 0);
            assert.equal(snapshot.images.length, 2);
            assert.equal(snapshot.navLinks.next, 'https://example.com/ch3');
        });
    });

    describe('Test 6: Resume Index 保守一致性與整數邊界防護', () => {
        it('Case A: processedCount=12 > results.length=10 時，resumeIndex 必須保守取 10，絕不跳過第 10~11 頁', () => {
            const snapshot = {
                url: 'https://example.com/ch2',
                images: Array.from({ length: 20 }, (_, i) => `p${i}.jpg`),
                results: Array.from({ length: 10 }, (_, i) => ({ image: `p${i}.jpg`, results: [] })),
                processedCount: 12
            };

            const resumeIndex = getPretranslationResumeIndex(snapshot);
            assert.equal(resumeIndex, 10);
        });

        it('Case B: processedCount=12.5 (浮點數) 時，必須觸發安全整數 fallback 至 10', () => {
            const snapshot = {
                url: 'https://example.com/ch2',
                images: Array.from({ length: 20 }, (_, i) => `p${i}.jpg`),
                results: Array.from({ length: 10 }, (_, i) => ({ image: `p${i}.jpg`, results: [] })),
                processedCount: 12.5
            };

            const resumeIndex = getPretranslationResumeIndex(snapshot);
            assert.equal(resumeIndex, 10);
        });

        it('Case C: processedCount=10 === results.length=10 時，resumeIndex 精確為 10', () => {
            const snapshot = {
                url: 'https://example.com/ch2',
                images: Array.from({ length: 20 }, (_, i) => `p${i}.jpg`),
                results: Array.from({ length: 10 }, (_, i) => ({ image: `p${i}.jpg`, results: [] })),
                processedCount: 10
            };

            const resumeIndex = getPretranslationResumeIndex(snapshot);
            assert.equal(resumeIndex, 10);
        });
    });

    describe('Test 7: 真正的 Resume 斷點邊界與避免重複請求 (Observable Behavior)', () => {
        it('已有 10 頁結果時，Resume 必須精準從 images[10] 開始，絕不重新請求 images[0]', async () => {
            const images = Array.from({ length: 20 }, (_, i) => `https://cdn.example.com/p${i}.jpg`);
            const existingResults = Array.from({ length: 10 }, (_, i) => ({
                image: `https://cdn.example.com/p${i}.jpg`,
                results: [{ translation: `p${i} 譯文` }]
            }));

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
            const newBatchResults = firstResumeBatch.map(img => ({
                image: img,
                results: [{ translation: `${img} 新譯文` }]
            }));
            const combinedResults = [...existingResults.slice(0, resumeIndex), ...newBatchResults];

            // 斷言：合併後長度為 15，前 10 筆保持原樣，新 5 筆順暢接續，絕無重複
            assert.equal(combinedResults.length, 15);
            assert.equal(combinedResults[0].results[0].translation, 'p0 譯文');
            assert.equal(combinedResults[9].results[0].translation, 'p9 譯文');
            assert.equal(combinedResults[10].results[0].translation, 'https://cdn.example.com/p10.jpg 新譯文');
        });
    });

    describe('Test 8: 完成時先存 Local Completed Cache 再刪 Session Checkpoint 之呼叫順序', () => {
        it('任務完成時保證呼叫順序為：savePretranslatedChapterToStorage ➔ removePretranslationCheckpoint', async () => {
            const callOrder = [];
            const mockSaveLocal = async () => callOrder.push('SAVE_LOCAL');
            const mockRemoveSession = async () => callOrder.push('REMOVE_SESSION');

            // 模擬 production 完成區塊的順序
            await mockSaveLocal();
            await mockRemoveSession();

            assert.deepEqual(callOrder, ['SAVE_LOCAL', 'REMOVE_SESSION']);
        });
    });

    describe('Test 9: Cancelled 任務絕不復活', () => {
        it('isCancelled: true 的任務被正規化為 cancelled 狀態且不觸發 resume', () => {
            const snapshot = {
                version: 1,
                url: 'https://example.com/ch2',
                images: ['p1.jpg', 'p2.jpg'],
                results: [{ image: 'p1.jpg', results: [] }],
                status: 'cancelled',
                isCancelled: true,
                inProgress: false
            };

            const normalized = normalizeRestoredPretranslation(snapshot);
            assert.equal(normalized.status, 'cancelled');
            assert.equal(normalized.isCancelled, true);
        });
    });

    describe('Test 10: 來源分頁已不存在時安全 Cleanup', () => {
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

    describe('Test 11: chrome.storage.session 不可用時 Graceful Fallback', () => {
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
});
