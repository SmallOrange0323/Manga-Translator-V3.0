import { describe, expect, it } from 'vitest';
import * as TranslateApi from '../src/background/translate-api.js';
import * as Constants from '../src/utils/constants.js';

describe('V3.2.2 一階段架構收斂與退役 OCR 符號清理驗證', () => {
    it('已退役的兩階段 OCR API 與 Prompt 常數不再匯出', () => {
        expect(TranslateApi.callGeminiAPIBatchOcr).toBeUndefined();
        expect(TranslateApi.extractTextFromImage).toBeUndefined();
        expect(Constants.DEFAULT_PROMPT_OCR).toBeUndefined();
    });

    it('現役一階段翻譯 API 與 Prompt 常數維持正常匯出', () => {
        expect(typeof TranslateApi.callGeminiAPIBatch).toBe('function');
        expect(typeof TranslateApi.translateTexts).toBe('function');
        expect(typeof TranslateApi.extractTermsFromTranslation).toBe('function');

        expect(typeof Constants.DEFAULT_PROMPT_ONE_STEP).toBe('string');
        expect(Constants.DEFAULT_PROMPT_ONE_STEP.length).toBeGreaterThan(0);

        // 純文字重譯 (retranslateText) 仍使用 DEFAULT_PROMPT_TWO_STEP
        expect(typeof Constants.DEFAULT_PROMPT_TWO_STEP).toBe('string');
        expect(Constants.DEFAULT_PROMPT_TWO_STEP.length).toBeGreaterThan(0);
    });
});
