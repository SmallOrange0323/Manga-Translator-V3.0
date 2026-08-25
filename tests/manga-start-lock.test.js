import { describe, expect, it } from 'vitest';
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
        expect(events).toEqual(['A enter']);
        releaseA();
        await Promise.all([a, b]);
        expect(events).toEqual(['A enter', 'A release', 'B enter']);
    });

    it('releases the queue after a startup failure', async () => {
        const withLock = createMangaStartLock();
        await expect(withLock(async () => { throw new Error('startup failed'); })).rejects.toThrow('startup failed');
        await expect(withLock(async () => 'next startup')).resolves.toBe('next startup');
    });
});
