import { describe, expect, it } from 'vitest';
const assert = { deepEqual: (actual, expected) => expect(actual).toEqual(expected), equal: (actual, expected) => expect(actual).toBe(expected), rejects: async (task, pattern) => expect(task()).rejects.toThrow(pattern) };
import { createMangaStartLock } from '../src/background/manga-start-lock.js';

describe('manga start lock', () => {
    it('allows only one startup critical section at a time', async () => {
        const withLock = createMangaStartLock();
        const events = [];
        let releaseA;
        const a = withLock(async () => {
            events.push('A enter');
            await new Promise(resolve => { releaseA = resolve; });
            events.push('A release');
        });
        const b = withLock(async () => { events.push('B enter'); });

        await Promise.resolve();
        assert.deepEqual(events, ['A enter']);
        releaseA();
        await Promise.all([a, b]);
        assert.deepEqual(events, ['A enter', 'A release', 'B enter']);
    });

    it('releases the queue after a startup failure', async () => {
        const withLock = createMangaStartLock();
        await assert.rejects(async () => {
            await withLock(async () => { throw new Error('startup failed'); });
        }, /startup failed/);
        const res = await withLock(async () => 'next startup');
        assert.equal(res, 'next startup');
    });
});
