import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getHybridSchedule, getBatchModel, getEffectiveDelay, getFailoverModel } from '../src/background/hybrid-scheduler.js';

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
