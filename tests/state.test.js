import { beforeEach, describe, expect, it, vi } from 'vitest';
const assert = {
    equal: (actual, expected) => expect(actual).toBe(expected),
    deepEqual: (actual, expected) => expect(actual).toEqual(expected)
};

function createStorageMock(initialData = {}) {
    const data = { ...initialData };
    const listeners = new Set();
    const addListenerSpy = vi.fn(fn => listeners.add(fn));
    const removeListenerSpy = vi.fn(fn => listeners.delete(fn));

    return {
        data,
        listeners,
        local: {
            async get(key) {
                if (key === null) return { ...data };
                if (typeof key === 'string') return { [key]: data[key] };
                return Object.fromEntries(key.map(name => [name, data[name]]));
            },
            async set(values) {
                const changes = {};
                for (const [k, v] of Object.entries(values)) {
                    changes[k] = { oldValue: data[k], newValue: v };
                    data[k] = v;
                }
                Object.assign(data, values);
            }
        },
        onChanged: {
            addListener: addListenerSpy,
            removeListener: removeListenerSpy
        },
        triggerChanged(changes, namespace = 'local') {
            for (const fn of listeners) {
                fn(changes, namespace);
            }
        }
    };
}

describe('StateManager live sync & API Key pool consistency', () => {
    let storageMock;

    beforeEach(() => {
        vi.resetModules();
        storageMock = createStorageMock();
        globalThis.chrome = { storage: storageMock };
    });

    it('Test 1: init() 自動註冊 storage listener 且多次 init 僅註冊一次', async () => {
        const { state } = await import('../src/utils/state.js');
        await state.init();
        await state.init();

        assert.equal(storageMock.onChanged.addListener.mock.calls.length, 1);
        assert.equal(storageMock.listeners.size, 1);
    });

    it('Test 2: 外部一般設定變更同步 cache', async () => {
        storageMock.data.modelName = 'ModelA';
        const { state } = await import('../src/utils/state.js');
        await state.init();

        assert.equal(await state.get('modelName'), 'ModelA');

        // 模擬外部 context (例如 Options 頁面) 變更 modelName
        storageMock.triggerChanged({
            modelName: { oldValue: 'ModelA', newValue: 'ModelB' }
        }, 'local');

        assert.equal(await state.get('modelName'), 'ModelB');
    });

    it('Test 3: 外部 apiKey 變更刷新 pool', async () => {
        storageMock.data.apiKey = 'Key1';
        const { state } = await import('../src/utils/state.js');
        await state.init();

        assert.equal(state.getNextApiKey(), 'Key1');

        // 模擬外部 Options 頁面儲存了新 API Keys
        storageMock.triggerChanged({
            apiKey: { oldValue: 'Key1', newValue: 'Key2\nKey3' }
        }, 'local');

        assert.equal(state.getNextApiKey(), 'Key2');
        assert.equal(state.getNextApiKey(), 'Key3');
        assert.equal(state.getNextApiKey(), 'Key2');
    });

    it('Test 4: Key pool 縮小時修正 currentKeyIndex 不出界', async () => {
        storageMock.data.apiKey = 'Key1\nKey2\nKey3\nKey4';
        const { state } = await import('../src/utils/state.js');
        await state.init();

        // 輪替到最後一個 Key (index 3)
        assert.equal(state.getNextApiKey(), 'Key1');
        assert.equal(state.getNextApiKey(), 'Key2');
        assert.equal(state.getNextApiKey(), 'Key3');
        assert.equal(state.getNextApiKey(), 'Key4');
        // 此時 currentKeyIndex 為 0 (4 % 4)

        // 讓 currentKeyIndex 走到 3
        state.currentKeyIndex = 3;

        // 外部改為只有 1 組 Key
        storageMock.triggerChanged({
            apiKey: { oldValue: 'Key1\nKey2\nKey3\nKey4', newValue: 'OnlyKey' }
        }, 'local');

        // currentKeyIndex 應被安全修正為 3 % 1 = 0，回傳 'OnlyKey' 而非 undefined
        const nextKey = state.getNextApiKey();
        assert.equal(nextKey, 'OnlyKey');
        expect(nextKey).not.toBeUndefined();
    });

    it('Test 5: 刪除 apiKey (newValue === undefined) 安全重設', async () => {
        storageMock.data.apiKey = 'Key1\nKey2';
        const { state } = await import('../src/utils/state.js');
        await state.init();

        assert.equal(state.apiKeys.length, 2);

        // 外部刪除 apiKey 設定
        storageMock.triggerChanged({
            apiKey: { oldValue: 'Key1\nKey2', newValue: undefined }
        }, 'local');

        assert.equal(state.apiKeys.length, 0);
        assert.equal(state.currentKeyIndex, 0);
        assert.equal(state.getNextApiKey(), null);
        assert.equal(await state.get('apiKey'), null);
    });

    it('Test 6: state.set(\'apiKey\') 同 instance 立即生效刷新 pool', async () => {
        const { state } = await import('../src/utils/state.js');
        await state.init();

        await state.set('apiKey', 'NewKey1\nNewKey2');

        assert.equal(state.getNextApiKey(), 'NewKey1');
        assert.equal(state.getNextApiKey(), 'NewKey2');
    });

    it('Test 7: 既有 update serialization 不 regression', async () => {
        const { state } = await import('../src/utils/state.js');
        await state.init();
        await Promise.all([
            state.update('counter', value => (value || 0) + 1),
            state.update('counter', value => (value || 0) + 1)
        ]);

        assert.equal(globalThis.chrome.storage.data.counter, 2);
    });

    it('Test 8: onChanged(callback) 支援訂閱與取消訂閱，且不產生重複 storage listener', async () => {
        const { state } = await import('../src/utils/state.js');
        await state.init();

        const callbackSpy = vi.fn();
        const unsubscribe = state.onChanged(callbackSpy);

        // 多次呼叫 onChanged 不增加 chrome.storage listener
        state.onChanged(() => {});
        assert.equal(storageMock.listeners.size, 1);

        storageMock.triggerChanged({ theme: { newValue: 'dark' } }, 'local');
        assert.equal(callbackSpy.mock.calls.length, 1);

        // 取消訂閱
        unsubscribe();
        storageMock.triggerChanged({ theme: { newValue: 'light' } }, 'local');
        assert.equal(callbackSpy.mock.calls.length, 1);
    });
});
