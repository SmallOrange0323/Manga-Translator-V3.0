import { describe, expect, it } from 'vitest';
import { shouldCompleteMangaTranslation } from '../src/background/manga-lifecycle.js';

describe('manga completed-path decision', () => {
    it.each([
        [{ wasStopped: false, wasAborted: false, isStopping: false }, true],
        [{ wasStopped: true, wasAborted: false, isStopping: true }, false],
        [{ wasStopped: false, wasAborted: true, isStopping: false }, false],
        [{ wasStopped: false, wasAborted: false, isStopping: true }, false]
    ])('returns %s for %o', (input, expected) => {
        expect(shouldCompleteMangaTranslation(input)).toBe(expected);
    });
});
