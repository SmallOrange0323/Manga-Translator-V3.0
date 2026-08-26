import { beforeEach, describe, expect, it, vi } from 'vitest';
const assert = {
    equal: (actual, expected) => expect(actual).toBe(expected),
    deepEqual: (actual, expected) => expect(actual).toEqual(expected)
};

import {
    executeHybridRequest,
    HybridRequestAbortedError
} from '../src/background/hybrid-retry.js';
import {
    executeFallbackImages,
    shouldProceedToStage15,
    shouldProceedToStage2,
    shouldCompleteMangaTranslation
} from '../src/background/manga-lifecycle.js';

describe('Translation Lifecycle Integration Tests', () => {
    describe('情境 1: Hybrid 全部失敗後的 fallback 降級機制', () => {
        it('Primary/Secondary/所有 Key 失敗後，安全進入 fallback 逐張翻譯且結果正確寫入一次', async () => {
            const apiCalls = [];
            const fallbackCalls = [];

            // 模擬 Hybrid 批次：Key 1 (Model A, B) 失敗，Key 2 (Model A, B) 失敗
            let hybridSuccess = false;
            let hybridError = null;
            try {
                await executeHybridRequest({
                    candidateKeys: ['Key1', 'Key2'],
                    scheduledKey: 'Key1',
                    scheduledModel: 'gemini-3.1-flash-lite',
                    primaryModel: 'gemini-3.1-flash-lite',
                    secondaryModel: 'gemini-3.5-flash-lite',
                    isHybrid: true,
                    request: async ({ apiKey, modelName }) => {
                        apiCalls.push({ apiKey, modelName });
                        const err = new Error('429 Too Many Requests');
                        err.status = 429;
                        throw err;
                    }
                });
                hybridSuccess = true;
            } catch (err) {
                hybridError = err;
            }

            assert.equal(hybridSuccess, false);
            expect(hybridError).toBeDefined();
            // 驗證 Hybrid 重試了 Key1(3.1, 3.5) + Key2(3.1, 3.5) 共 4 次 API 呼叫，無無限 retry
            assert.equal(apiCalls.length, 4);

            // 進入 fallback 逐張處理 (3 張圖片)
            const validItems = [
                { b64: 'img1_base64', originalIdx: 0 },
                { b64: 'img2_base64', originalIdx: 1 },
                { b64: 'img3_base64', originalIdx: 2 }
            ];

            const fallbackResult = await executeFallbackImages({
                validItems,
                fallbackModelName: 'gemini-2.5-flash',
                getNextApiKey: async () => 'FallbackKey',
                translateSingle: async ({ imageBase64, model, apiKey }) => {
                    fallbackCalls.push({ imageBase64, model, apiKey });
                    return { results: [{ original: 'こんにちは', translation: '你好' }] };
                },
                shouldContinue: async () => true
            });

            assert.equal(fallbackResult.wasStopped, false);
            assert.equal(fallbackCalls.length, 3);
            assert.equal(fallbackResult.fallbackResults.length, 3);
            assert.equal(fallbackResult.fallbackResults[0].usedModelName, 'gemini-2.5-flash');
            assert.equal(fallbackResult.fallbackResults[0].results[0].translation, '你好');
            assert.equal(fallbackResult.fallbackResults[1].results[0].translation, '你好');
            assert.equal(fallbackResult.fallbackResults[2].results[0].translation, '你好');
        });
    });

    describe('情境 2: fallback 中途 STOP (核心防護)', () => {
        it('圖片 1 fallback 完成後使用者 STOP，圖片 2/3 嚴格不得發送任何 API 請求', async () => {
            const fallbackCalls = [];
            let isStopping = false;

            const validItems = [
                { b64: 'img1_base64', originalIdx: 0 },
                { b64: 'img2_base64', originalIdx: 1 },
                { b64: 'img3_base64', originalIdx: 2 }
            ];

            const fallbackResult = await executeFallbackImages({
                validItems,
                fallbackModelName: 'gemini-2.5-flash',
                getNextApiKey: async () => 'FallbackKey',
                translateSingle: async ({ imageBase64, model, apiKey }) => {
                    fallbackCalls.push({ imageBase64, model, apiKey });
                    // 圖片 1 完成後觸發 STOP
                    if (imageBase64 === 'img1_base64') {
                        isStopping = true;
                    }
                    return { results: [{ original: 'こんにちは', translation: '你好' }] };
                },
                shouldContinue: async () => !isStopping
            });

            // 驗證：僅發送了 1 次 API 請求，圖片 2 和 圖片 3 完全未發送請求
            assert.equal(fallbackCalls.length, 1);
            assert.equal(fallbackCalls[0].imageBase64, 'img1_base64');
            assert.equal(fallbackResult.wasStopped, true);

            // 未執行的圖片被標記為 '翻譯已停止'，絕不產生假成功結果
            assert.equal(fallbackResult.fallbackResults[0].results[0].translation, '你好');
            assert.equal(fallbackResult.fallbackResults[1].error, '翻譯已停止');
            assert.equal(fallbackResult.fallbackResults[2].error, '翻譯已停止');

            // 驗證 lifecycle 決策：不得標記為正常 completed
            const canComplete = shouldCompleteMangaTranslation({
                wasStopped: fallbackResult.wasStopped,
                wasAborted: false,
                isStopping: isStopping
            });
            assert.equal(canComplete, false);
        });
    });

    describe('情境 3: Two-step Pipeline STOP 兩階段守衛', () => {
        it('Stage 1 OCR 結束後若已 STOP，保證 Stage 1.5 (extractGlobalStoryAndGlossary) 與 Stage 2 請求數均為 0', async () => {
            let stage1Stopped = true;
            let stage15RequestCount = 0;
            let stage2RequestCount = 0;

            // 模擬 Stage 1 OCR 結束後進入 Stage 1.5 之前的守衛檢查
            const canProceedToStage15 = shouldProceedToStage15({
                wasStopped: stage1Stopped,
                isStopping: true
            });

            assert.equal(canProceedToStage15, false);

            // 當被守衛阻擋時，嚴格不得發起 Stage 1.5 (extractGlobalStoryAndGlossary) 與 Stage 2 請求
            if (canProceedToStage15) {
                stage15RequestCount++;
                const canProceedToStage2 = shouldProceedToStage2({
                    wasStopped: false,
                    isStopping: false,
                    scriptLinesCount: 5
                });
                if (canProceedToStage2) {
                    stage2RequestCount++;
                }
            }

            assert.equal(stage15RequestCount, 0);
            assert.equal(stage2RequestCount, 0);

            // 驗證 lifecycle 決策：不得標記為 completed
            const canComplete = shouldCompleteMangaTranslation({
                wasStopped: stage1Stopped,
                wasAborted: false,
                isStopping: true
            });
            assert.equal(canComplete, false);
        });

        it('Stage 1 OCR 正常完成但 Stage 1.5 期間 STOP，保證 Stage 2 請求數為 0', async () => {
            let stage15RequestCount = 0;
            let stage2RequestCount = 0;

            const canProceedToStage15 = shouldProceedToStage15({
                wasStopped: false,
                isStopping: false
            });
            assert.equal(canProceedToStage15, true);

            if (canProceedToStage15) {
                stage15RequestCount++;
                // 模擬在 Stage 1.5 執行期間或結束時使用者按 STOP
                const isStoppingAfterStage15 = true;
                const canProceedToStage2 = shouldProceedToStage2({
                    wasStopped: isStoppingAfterStage15,
                    isStopping: isStoppingAfterStage15,
                    scriptLinesCount: 5
                });
                if (canProceedToStage2) {
                    stage2RequestCount++;
                }
            }

            assert.equal(stage15RequestCount, 1);
            assert.equal(stage2RequestCount, 0);
        });

        it('Stage 1 與 Stage 1.5 均正常完成且未被停止時，順暢進入 Stage 2', () => {
            const canProceedToStage15 = shouldProceedToStage15({ wasStopped: false, isStopping: false });
            const canProceedToStage2 = shouldProceedToStage2({ wasStopped: false, isStopping: false, scriptLinesCount: 5 });

            assert.equal(canProceedToStage15, true);
            assert.equal(canProceedToStage2, true);
        });
    });

    describe('情境 4: 實際 usedModelName 一致性與 Failover 結果卡片邊界', () => {
        it('Model A 觸發 429 後切換至 Model B 成功，usedModelName 與結果卡片 metadata 保持一致為 Model B', async () => {
            const execution = await executeHybridRequest({
                candidateKeys: ['Key1'],
                scheduledKey: 'Key1',
                scheduledModel: 'gemini-3.1-flash-lite',
                primaryModel: 'gemini-3.1-flash-lite',
                secondaryModel: 'gemini-3.5-flash-lite',
                isHybrid: true,
                request: async ({ apiKey, modelName }) => {
                    if (modelName === 'gemini-3.1-flash-lite') {
                        const err = new Error('429 Rate Limit Exceeded');
                        err.status = 429;
                        throw err;
                    }
                    return [{ results: [{ translation: '譯文' }] }];
                }
            });

            // 驗證 usedModelName 是實際成功的 Model B (3.5-flash-lite)，而非 Model A (3.1)
            assert.equal(execution.usedModelName, 'gemini-3.5-flash-lite');
            assert.equal(execution.usedKey, 'Key1');

            // 驗證封裝至結果卡片時的 metadata 一致性
            const finalCardResult = {
                image: 'img1.jpg',
                results: execution.results[0].results,
                usedModelName: execution.usedModelName
            };

            assert.equal(finalCardResult.usedModelName, 'gemini-3.5-flash-lite');
            expect(finalCardResult.usedModelName).not.equal('gemini-3.1-flash-lite');
        });
    });
});
