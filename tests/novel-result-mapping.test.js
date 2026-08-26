import { describe, expect, it } from 'vitest';
const assert = {
    equal: (actual, expected) => expect(actual).toBe(expected),
    deepEqual: (actual, expected) => expect(actual).toEqual(expected)
};

import {
    mapNovelTranslationResults,
    NOVEL_TRANSLATION_FAILURE_TEXT
} from '../src/background/novel-result-mapping.js';

describe('Novel Mode: Gemini Translation Result Index Mapping Tests', () => {

    describe('Test 1: 正常完整 1:1 結構化結果對齊', () => {
        it('輸入 3 筆，回傳 3 筆正常索引時，精確映射至對應位置', () => {
            const rawResult = {
                translations: [
                    { index: 0, text: '第一句譯文' },
                    { index: 1, text: '第二句譯文' },
                    { index: 2, text: '第三句譯文' }
                ]
            };

            const { translations, validCount } = mapNovelTranslationResults(rawResult, 3);

            assert.equal(validCount, 3);
            assert.deepEqual(translations, ['第一句譯文', '第二句譯文', '第三句譯文']);
        });
    });

    describe('Test 2: 中間索引缺失 (Missing Middle Index) — 絕不發生位移', () => {
        it('Gemini 漏翻第 1 句 (僅回 0 與 2) 時，第 1 槽位補失敗標記，第 2 句絕不向前 shift 錯位', () => {
            const rawResult = {
                translations: [
                    { index: 0, text: 'A2' },
                    { index: 2, text: 'C2' }
                ]
            };

            const { translations, validCount } = mapNovelTranslationResults(rawResult, 3);

            assert.equal(validCount, 2);
            assert.equal(translations.length, 3);
            assert.equal(translations[0], 'A2');
            assert.equal(translations[1], NOVEL_TRANSLATION_FAILURE_TEXT);
            assert.equal(translations[2], 'C2');
        });
    });

    describe('Test 3: 開頭索引缺失 (Missing First Index)', () => {
        it('Gemini 漏翻第 0 句 (僅回 1 與 2) 時，第 0 槽位補失敗，其餘段落正確對齊', () => {
            const rawResult = {
                translations: [
                    { index: 1, text: 'B2' },
                    { index: 2, text: 'C2' }
                ]
            };

            const { translations, validCount } = mapNovelTranslationResults(rawResult, 3);

            assert.equal(validCount, 2);
            assert.equal(translations[0], NOVEL_TRANSLATION_FAILURE_TEXT);
            assert.equal(translations[1], 'B2');
            assert.equal(translations[2], 'C2');
        });
    });

    describe('Test 4: 結尾索引缺失 (Missing Last Index)', () => {
        it('Gemini 漏翻第 2 句 (僅回 0 與 1) 時，第 2 槽位補失敗', () => {
            const rawResult = {
                translations: [
                    { index: 0, text: 'A2' },
                    { index: 1, text: 'B2' }
                ]
            };

            const { translations, validCount } = mapNovelTranslationResults(rawResult, 3);

            assert.equal(validCount, 2);
            assert.equal(translations[0], 'A2');
            assert.equal(translations[1], 'B2');
            assert.equal(translations[2], NOVEL_TRANSLATION_FAILURE_TEXT);
        });
    });

    describe('Test 5: 重複索引 (Duplicate Index) — First Valid Wins 確定性規則', () => {
        it('同一 index 出現多次時，採先到先得原則，忽略後續重複項目', () => {
            const rawResult = {
                translations: [
                    { index: 0, text: 'A_FIRST' },
                    { index: 0, text: 'A_SECOND_DUPLICATE' },
                    { index: 1, text: 'B_FIRST' }
                ]
            };

            const { translations, validCount } = mapNovelTranslationResults(rawResult, 2);

            assert.equal(validCount, 2);
            assert.equal(translations[0], 'A_FIRST');
            assert.equal(translations[1], 'B_FIRST');
        });
    });

    describe('Test 6: 負數索引 (Negative Index) 忽略防禦', () => {
        it('index = -1 的項目直接忽略，不影響合法槽位', () => {
            const rawResult = {
                translations: [
                    { index: -1, text: 'INVALID_NEGATIVE' },
                    { index: 0, text: 'A2' }
                ]
            };

            const { translations, validCount } = mapNovelTranslationResults(rawResult, 2);

            assert.equal(validCount, 1);
            assert.equal(translations[0], 'A2');
            assert.equal(translations[1], NOVEL_TRANSLATION_FAILURE_TEXT);
        });
    });

    describe('Test 7: 超界索引 (Out-of-range Index) 忽略防禦', () => {
        it('index = 999 超出 expectedLength 時安全忽略', () => {
            const rawResult = {
                translations: [
                    { index: 0, text: 'A2' },
                    { index: 999, text: 'OUT_OF_BOUNDS' }
                ]
            };

            const { translations, validCount } = mapNovelTranslationResults(rawResult, 2);

            assert.equal(validCount, 1);
            assert.equal(translations[0], 'A2');
            assert.equal(translations[1], NOVEL_TRANSLATION_FAILURE_TEXT);
        });
    });

    describe('Test 8: 浮點數索引 (Fractional Index) 忽略防禦', () => {
        it('index = 1.5 非合法整數時安全忽略', () => {
            const rawResult = {
                translations: [
                    { index: 0, text: 'A2' },
                    { index: 1.5, text: 'FRACTIONAL' }
                ]
            };

            const { translations, validCount } = mapNovelTranslationResults(rawResult, 2);

            assert.equal(validCount, 1);
            assert.equal(translations[0], 'A2');
            assert.equal(translations[1], NOVEL_TRANSLATION_FAILURE_TEXT);
        });
    });

    describe('Test 9: 字串型態索引 (String Index) 忽略防禦', () => {
        it('index = "1" 嚴格拒絕非數值整數型態', () => {
            const rawResult = {
                translations: [
                    { index: 0, text: 'A2' },
                    { index: '1', text: 'STRING_INDEX' }
                ]
            };

            const { translations, validCount } = mapNovelTranslationResults(rawResult, 2);

            assert.equal(validCount, 1);
            assert.equal(translations[0], 'A2');
            assert.equal(translations[1], NOVEL_TRANSLATION_FAILURE_TEXT);
        });
    });

    describe('Test 10: 畸形項目 (Malformed Items) 安全防禦', () => {
        it('陣列內混入 null、{}、[] 等異常項目時不 crash 且正確過濾', () => {
            const rawResult = {
                translations: [
                    null,
                    undefined,
                    {},
                    [],
                    'not_an_object',
                    { index: 0, text: 'VALID_A' }
                ]
            };

            const { translations, validCount } = mapNovelTranslationResults(rawResult, 1);

            assert.equal(validCount, 1);
            assert.equal(translations[0], 'VALID_A');
        });
    });

    describe('Test 11: 缺少 text 屬性', () => {
        it('item 缺少 text 欄位時該 slot 保持失敗', () => {
            const rawResult = {
                translations: [
                    { index: 0 }
                ]
            };

            const { translations, validCount } = mapNovelTranslationResults(rawResult, 1);

            assert.equal(validCount, 0);
            assert.equal(translations[0], NOVEL_TRANSLATION_FAILURE_TEXT);
        });
    });

    describe('Test 12: 空字串 text', () => {
        it('text 為空字串 "" 時視為無效譯文，保持失敗狀態供前端重試', () => {
            const rawResult = {
                translations: [
                    { index: 0, text: '' }
                ]
            };

            const { translations, validCount } = mapNovelTranslationResults(rawResult, 1);

            assert.equal(validCount, 0);
            assert.equal(translations[0], NOVEL_TRANSLATION_FAILURE_TEXT);
        });
    });

    describe('Test 13: 純空白字串 text (Whitespace-only)', () => {
        it('text 僅含空白與換行時視為無效譯文', () => {
            const rawResult = {
                translations: [
                    { index: 0, text: '   \n\t  ' }
                ]
            };

            const { translations, validCount } = mapNovelTranslationResults(rawResult, 1);

            assert.equal(validCount, 0);
            assert.equal(translations[0], NOVEL_TRANSLATION_FAILURE_TEXT);
        });
    });

    describe('Test 14: translations 屬性不是陣列', () => {
        it('result.translations 為字串或物件等非陣列型態時安全回傳全失敗', () => {
            const rawResult = {
                translations: 'not_an_array'
            };

            const { translations, validCount } = mapNovelTranslationResults(rawResult, 2);

            assert.equal(validCount, 0);
            assert.equal(translations.length, 2);
            assert.deepEqual(translations, [NOVEL_TRANSLATION_FAILURE_TEXT, NOVEL_TRANSLATION_FAILURE_TEXT]);
        });
    });

    describe('Test 15: Legacy String Array — 長度不足補失敗', () => {
        it('回傳純字串陣列且長度不足時，後續位置安全補上失敗標記', () => {
            const rawResult = ['譯文1', '譯文2'];

            const { translations, validCount } = mapNovelTranslationResults(rawResult, 4);

            assert.equal(validCount, 2);
            assert.deepEqual(translations, ['譯文1', '譯文2', NOVEL_TRANSLATION_FAILURE_TEXT, NOVEL_TRANSLATION_FAILURE_TEXT]);
        });
    });

    describe('Test 16: Legacy String Array — 長度過長時截斷', () => {
        it('回傳純字串陣列超出 expectedLength 時截斷多餘項，長度保持精準一致', () => {
            const rawResult = ['譯文1', '譯文2', '多餘譯文3', '多餘譯文4'];

            const { translations, validCount } = mapNovelTranslationResults(rawResult, 2);

            assert.equal(validCount, 2);
            assert.deepEqual(translations, ['譯文1', '譯文2']);
        });
    });

    describe('Test 17: expectedLength 為 0 或無效數值時之安全防禦', () => {
        it('expectedLength <= 0 時安全返回空陣列', () => {
            const rawResult = {
                translations: [{ index: 0, text: 'A' }]
            };

            const res0 = mapNovelTranslationResults(rawResult, 0);
            assert.deepEqual(res0, { translations: [], validCount: 0 });

            const resNeg = mapNovelTranslationResults(rawResult, -5);
            assert.deepEqual(resNeg, { translations: [], validCount: 0 });

            const resNull = mapNovelTranslationResults(rawResult, null);
            assert.deepEqual(resNull, { translations: [], validCount: 0 });
        });
    });

    describe('Test 18: 混合 Valid 與 Invalid 結果之精確計數', () => {
        it('多筆混合輸入時，validCount 僅計算合法成功段落，translations 長度精準等於 expectedLength', () => {
            const rawResult = {
                translations: [
                    { index: 0, text: 'A' },               // valid (0)
                    { index: -1, text: 'IGNORED' },         // invalid
                    { index: 1, text: '' },                 // invalid empty
                    { index: 2, text: 'C' },               // valid (2)
                    { index: 2, text: 'C_DUPLICATE' },      // invalid duplicate
                    { index: 3, text: '   ' },             // invalid whitespace
                    { index: 999, text: 'OUT' }             // invalid out of bounds
                ]
            };

            const { translations, validCount } = mapNovelTranslationResults(rawResult, 5);

            assert.equal(validCount, 2);
            assert.equal(translations.length, 5);
            assert.deepEqual(translations, [
                'A',
                NOVEL_TRANSLATION_FAILURE_TEXT,
                'C',
                NOVEL_TRANSLATION_FAILURE_TEXT,
                NOVEL_TRANSLATION_FAILURE_TEXT
            ]);
        });
    });
});
