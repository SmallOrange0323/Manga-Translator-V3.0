import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shouldCompleteMangaTranslation } from '../src/background/manga-lifecycle.js';

describe('manga completed-path decision', () => {
    const cases = [
        [{ wasStopped: false, wasAborted: false, isStopping: false }, true],
        [{ wasStopped: true, wasAborted: false, isStopping: true }, false],
        [{ wasStopped: false, wasAborted: true, isStopping: false }, false],
        [{ wasStopped: false, wasAborted: false, isStopping: true }, false]
    ];
    for (const [input, expected] of cases) {
        it(`returns ${expected} for ${JSON.stringify(input)}`, () => {
            assert.equal(shouldCompleteMangaTranslation(input), expected);
        });
    }
});
