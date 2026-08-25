import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getBatchModel, getEffectiveDelay, getFailoverModel } from '../src/background/hybrid-scheduler.js';

describe('Hybrid Dual-Model Scheduler', () => {
    const primary = 'gemini-3.1-flash-lite';
    const secondary = 'gemini-3.5-flash-lite';

    describe('getBatchModel', () => {
        it('當未啟用 Hybrid 時，所有批次固定使用 Primary 模型', () => {
            assert.equal(getBatchModel(0, false, primary, secondary), primary);
            assert.equal(getBatchModel(1, false, primary, secondary), primary);
            assert.equal(getBatchModel(2, false, primary, secondary), primary);
        });

        it('當啟用 Hybrid 時，偶數批次為 Primary，奇數批次為 Secondary', () => {
            assert.equal(getBatchModel(0, true, primary, secondary), primary);
            assert.equal(getBatchModel(1, true, primary, secondary), secondary);
            assert.equal(getBatchModel(2, true, primary, secondary), primary);
            assert.equal(getBatchModel(3, true, primary, secondary), secondary);
        });
    });

    describe('getEffectiveDelay', () => {
        it('當未啟用 Hybrid 時，維持原本延遲', () => {
            assert.equal(getEffectiveDelay(4000, false), 4000);
            assert.equal(getEffectiveDelay(2000, false), 2000);
        });

        it('當啟用 Hybrid 時，延遲減半以加速，但維持最小 1500ms 安全間隔', () => {
            assert.equal(getEffectiveDelay(4000, true), 2000);
            assert.equal(getEffectiveDelay(5000, true), 2500);
            assert.equal(getEffectiveDelay(2000, true), 1500);
        });
    });

    describe('getFailoverModel', () => {
        it('當 Primary 失敗時，切換至 Secondary', () => {
            assert.equal(getFailoverModel(primary, primary, secondary), secondary);
        });

        it('當 Secondary 失敗時，切換至 Primary', () => {
            assert.equal(getFailoverModel(secondary, primary, secondary), primary);
        });
    });
});
