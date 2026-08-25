import { describe, expect, it } from 'vitest';
import { getPretranslationCompletion, mapPretranslationBatchResults } from '../src/background/manga-lifecycle.js';

describe('pretranslation batch mapping', () => {
    it('maps compressed API results back to their original image indexes', () => {
        const results = mapPretranslationBatchResults(
            ['A', 'B', 'C'],
            [null, 'B-base64', 'C-base64'],
            [{ originalIdx: 1, b64: 'B-base64' }, { originalIdx: 2, b64: 'C-base64' }],
            [{ results: ['B translated'] }, { results: ['C translated'] }],
            'model'
        );

        expect(results).toEqual([
            { image: 'A', error: '圖片載入失敗', usedModelName: 'model' },
            { image: 'B', results: ['B translated'], usedModelName: 'model' },
            { image: 'C', results: ['C translated'], usedModelName: 'model' }
        ]);
    });
});

describe('pretranslation completion', () => {
    it.each([
        [{ isCancelled: true, resultCount: 3, imageCount: 3 }, { status: 'cancelled', isDone: false }],
        [{ isCancelled: false, resultCount: 3, imageCount: 3 }, { status: 'completed', isDone: true }],
        [{ isCancelled: false, resultCount: 2, imageCount: 3 }, { status: 'error', isDone: false, error: '預翻結果不完整' }]
    ])('returns the expected state for %o', (input, expected) => {
        expect(getPretranslationCompletion(input)).toEqual(expected);
    });
});
