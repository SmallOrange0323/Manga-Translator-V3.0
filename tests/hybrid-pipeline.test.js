import { describe, expect, it } from 'vitest';
const assert = { deepEqual: (actual, expected) => expect(actual).toEqual(expected), equal: (actual, expected) => expect(actual).toBe(expected) };
import { getHybridSchedule, getBatchModel, getEffectiveDelay, getFailoverModel } from '../src/background/hybrid-scheduler.js';
import { executeHybridRequest, HybridRequestAbortedError } from '../src/background/hybrid-retry.js';

describe('2D Alternating Round-Robin Scheduler (Key × Model)', () => {
    const ModelA = 'gemini-3.1-flash-lite';
    const ModelB = 'gemini-3.5-flash-lite';

    describe('4 組 API Key 的二維交錯輪替驗證 (使用者指定需求)', () => {
        const keyCount = 4;

        it('第一輪 (Round 0): Key 1(A) → Key 2(B) → Key 3(A) → Key 4(B)', () => {
            assert.deepEqual(getHybridSchedule(0, keyCount, true, ModelA, ModelB), { keyIndex: 0, roundIndex: 0, modelName: ModelA });
            assert.deepEqual(getHybridSchedule(1, keyCount, true, ModelA, ModelB), { keyIndex: 1, roundIndex: 0, modelName: ModelB });
            assert.deepEqual(getHybridSchedule(2, keyCount, true, ModelA, ModelB), { keyIndex: 2, roundIndex: 0, modelName: ModelA });
            assert.deepEqual(getHybridSchedule(3, keyCount, true, ModelA, ModelB), { keyIndex: 3, roundIndex: 0, modelName: ModelB });
        });

        it('第二輪 (Round 1): 一輪結束後由 Key 1(B) 開始 → Key 2(A) → Key 3(B) → Key 4(A)', () => {
            assert.deepEqual(getHybridSchedule(4, keyCount, true, ModelA, ModelB), { keyIndex: 0, roundIndex: 1, modelName: ModelB });
            assert.deepEqual(getHybridSchedule(5, keyCount, true, ModelA, ModelB), { keyIndex: 1, roundIndex: 1, modelName: ModelA });
            assert.deepEqual(getHybridSchedule(6, keyCount, true, ModelA, ModelB), { keyIndex: 2, roundIndex: 1, modelName: ModelB });
            assert.deepEqual(getHybridSchedule(7, keyCount, true, ModelA, ModelB), { keyIndex: 3, roundIndex: 1, modelName: ModelA });
        });

        it('第三輪 (Round 2): 回歸 Key 1(A) 繼續循環', () => {
            assert.deepEqual(getHybridSchedule(8, keyCount, true, ModelA, ModelB), { keyIndex: 0, roundIndex: 2, modelName: ModelA });
            assert.deepEqual(getHybridSchedule(9, keyCount, true, ModelA, ModelB), { keyIndex: 1, roundIndex: 2, modelName: ModelB });
        });
    });

    describe('單組 API Key (keyCount = 1) 相容性', () => {
        const keyCount = 1;

        it('單 Key 下依然完美實現 A → B → A → B 輪替', () => {
            assert.deepEqual(getHybridSchedule(0, keyCount, true, ModelA, ModelB), { keyIndex: 0, roundIndex: 0, modelName: ModelA });
            assert.deepEqual(getHybridSchedule(1, keyCount, true, ModelA, ModelB), { keyIndex: 0, roundIndex: 1, modelName: ModelB });
            assert.deepEqual(getHybridSchedule(2, keyCount, true, ModelA, ModelB), { keyIndex: 0, roundIndex: 2, modelName: ModelA });
            assert.deepEqual(getHybridSchedule(3, keyCount, true, ModelA, ModelB), { keyIndex: 0, roundIndex: 3, modelName: ModelB });
        });
    });

    describe('未啟用 Hybrid (isHybrid = false) 降級保證', () => {
        it('所有批次固定使用 Model A，但仍依 Key 順序輪流 (Key 1 → Key 2 → Key 3 → Key 4)', () => {
            assert.deepEqual(getHybridSchedule(0, 4, false, ModelA, ModelB), { keyIndex: 0, roundIndex: 0, modelName: ModelA });
            assert.deepEqual(getHybridSchedule(1, 4, false, ModelA, ModelB), { keyIndex: 1, roundIndex: 0, modelName: ModelA });
            assert.deepEqual(getHybridSchedule(2, 4, false, ModelA, ModelB), { keyIndex: 2, roundIndex: 0, modelName: ModelA });
            assert.deepEqual(getHybridSchedule(3, 4, false, ModelA, ModelB), { keyIndex: 3, roundIndex: 0, modelName: ModelA });
        });
    });

    describe('getEffectiveDelay 智能延遲計算', () => {
        it('多 Key + Hybrid: 延遲極速降至 1000ms', () => {
            assert.equal(getEffectiveDelay(4000, true, 4), 1000);
            assert.equal(getEffectiveDelay(4000, true, 2), 1333);
        });

        it('單 Key + Hybrid: 延遲安全減半至 2000ms', () => {
            assert.equal(getEffectiveDelay(4000, true, 1), 2000);
        });
    });

    describe('getFailoverModel 容錯切換', () => {
        it('Model A 撞限時切換至 Model B，反之亦然', () => {
            assert.equal(getFailoverModel(ModelA, ModelA, ModelB), ModelB);
            assert.equal(getFailoverModel(ModelB, ModelA, ModelB), ModelA);
        });
    });
});

describe('Hybrid request failover', () => {
    const options = { scheduledKey: 'Key1', scheduledModel: 'A', primaryModel: 'A', secondaryModel: 'B', isHybrid: true };

    it('retries the same single key with the failover model after 429', async () => {
        const calls = [];
        const result = await executeHybridRequest({ ...options, candidateKeys: ['Key1'], request: async ({ apiKey, modelName }) => {
            calls.push([apiKey, modelName]);
            if (modelName === 'A') throw { statusCode: 429, message: 'rate limited' };
            return 'ok';
        }});
        assert.deepEqual(calls, [['Key1', 'A'], ['Key1', 'B']]);
        assert.equal(result.usedModelName, 'B');
    });

    it('tries failover on the final key after 503', async () => {
        const calls = [];
        const result = await executeHybridRequest({ ...options, candidateKeys: ['Key1', 'Key2'], scheduledKey: 'Key2', request: async ({ apiKey, modelName }) => {
            calls.push([apiKey, modelName]);
            if (apiKey === 'Key2' && modelName === 'A') throw { statusCode: 503, message: 'unavailable' };
            return 'ok';
        }});
        assert.deepEqual(calls, [['Key2', 'A'], ['Key2', 'B']]);
        assert.equal(result.usedModelName, 'B');
    });

    it('does not switch models for a non-failover error', async () => {
        const calls = [];
        await expect(executeHybridRequest({ ...options, candidateKeys: ['Key1'], request: async ({ modelName }) => {
            calls.push(modelName); throw { statusCode: 400, message: 'bad request' };
        }})).rejects.toMatchObject({ statusCode: 400 });
        assert.deepEqual(calls, ['A']);
    });

    it('does not issue a failover request after cancellation', async () => {
        const calls = [];
        let isRunning = true;
        await expect(executeHybridRequest({ ...options, candidateKeys: ['Key1'], shouldContinue: () => isRunning, request: async ({ modelName }) => {
            calls.push(modelName);
            isRunning = false;
            throw { statusCode: 429, message: 'rate limited' };
        }})).rejects.toMatchObject({ code: 'TRANSLATION_STOPPED' });
        assert.deepEqual(calls, ['A']);
    });

    it('passes the scheduled key and model to a single-image request', async () => {
        const result = await executeHybridRequest({
            ...options,
            candidateKeys: ['Key1', 'Key2'],
            scheduledKey: 'Key2',
            scheduledModel: 'B',
            request: async ({ apiKey, modelName }) => ({ apiKey, modelName })
        });
        assert.deepEqual(result.results, { apiKey: 'Key2', modelName: 'B' });
        assert.equal(result.usedModelName, 'B');
    });

    it('stops subsequent sub-batches inside request callback when cancelled', async () => {
        const calls = [];
        let isRunning = true;
        const subBatches = [['img1'], ['img2']];
        const allPageResults = [];

        await expect(executeHybridRequest({
            ...options,
            candidateKeys: ['Key1'],
            shouldContinue: () => isRunning,
            request: async ({ shouldContinue }) => {
                for (const subBatch of subBatches) {
                    if (!await shouldContinue()) {
                        throw new HybridRequestAbortedError();
                    }
                    calls.push(subBatch[0]);
                    isRunning = false;
                    if (!await shouldContinue()) {
                        throw new HybridRequestAbortedError();
                    }
                    allPageResults.push(...subBatch);
                }
                return true;
            }
        })).rejects.toMatchObject({ code: 'TRANSLATION_STOPPED' });

        assert.deepEqual(calls, ['img1']);
        assert.deepEqual(allPageResults, []);
    });
});
