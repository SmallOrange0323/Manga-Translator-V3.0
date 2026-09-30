export const PRETRANSLATION_QUEUE_KEY = 'mt_pretranslation_queue_v1';

export function createPretranslationQueueStore(state, chromeApi, isPrivateProcess = false) {
    return {
        async add(url, sourceTabId, resultTabId, force) {
            if (isPrivateProcess || !sourceTabId) return false;
            const source = await chromeApi.tabs.get(sourceTabId).catch(() => null);
            if (!source || source.incognito) return false;
            await state.update(PRETRANSLATION_QUEUE_KEY, (current = {}) => ({
                ...current,
                [url]: { url, sourceTabId, resultTabId: resultTabId || null, force: !!force, queuedAt: Date.now() }
            }));
            return true;
        },
        async remove(url) {
            await state.update(PRETRANSLATION_QUEUE_KEY, (current = {}) => {
                const next = { ...current };
                delete next[url];
                return next;
            });
        },
        async pending() {
            if (isPrivateProcess) return [];
            const records = await state.get(PRETRANSLATION_QUEUE_KEY, {});
            return Object.values(records).filter(item => item && typeof item.url === 'string' &&
                Number.isInteger(item.sourceTabId)).sort((a, b) => a.queuedAt - b.queuedAt);
        }
    };
}
