import { beforeEach, describe, expect, it, vi } from 'vitest';
const assert = { equal: (actual, expected) => expect(actual).toBe(expected) };

function createStorageMock() {
    const data = {};
    return {
        data,
        local: {
            async get(key) {
                if (key === null) return { ...data };
                if (typeof key === 'string') return { [key]: data[key] };
                return Object.fromEntries(key.map(name => [name, data[name]]));
            },
            async set(values) {
                Object.assign(data, values);
            }
        }
    };
}

describe('StateManager.update', () => {
    beforeEach(() => {
        vi.resetModules();
        globalThis.chrome = { storage: createStorageMock() };
    });

    it('serializes concurrent updates for the same key', async () => {
        const { state } = await import('../src/utils/state.js');
        await state.init();
        await Promise.all([
            state.update('counter', value => (value || 0) + 1),
            state.update('counter', value => (value || 0) + 1)
        ]);

        assert.equal(globalThis.chrome.storage.data.counter, 2);
    });
});
