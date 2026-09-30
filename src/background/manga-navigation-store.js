export const MANGA_NAVIGATION_KEY = 'mt_manga_navigation_v1';

// Each source tab has its own pending navigation. Claiming it is atomic so a
// load-complete event and the timeout fallback cannot both start translation.
export function createMangaNavigationStore(state, isPrivateProcess = false) {
    let privateRecords = {};
    let queue = Promise.resolve();
    function mutate(updater) {
        const operation = queue.then(async () => {
            if (isPrivateProcess) privateRecords = updater(privateRecords);
            else await state.update(MANGA_NAVIGATION_KEY, (records = {}) => updater(records));
        });
        queue = operation.catch(() => {});
        return operation;
    }
    return {
        async register(tabId, details) {
            const record = { ...details, tabId, token: crypto.randomUUID(), createdAt: Date.now() };
            await mutate(records => ({ ...records, [tabId]: record }));
            return record;
        },
        async claim(tabId, url, token = null) {
            let claimed = null;
            await mutate(records => {
                const record = records[tabId];
                if (!record || record.url !== url || (token && record.token !== token)) return records;
                const next = { ...records };
                delete next[tabId];
                // An old record must not unexpectedly translate a later visit.
                if (Date.now() - record.createdAt < 10 * 60 * 1000) claimed = record;
                return next;
            });
            return claimed;
        },
        async removeForTab(tabId, token = null) {
            await mutate(records => {
                const next = { ...records };
                for (const [id, record] of Object.entries(next)) {
                    if ((record.tabId === tabId || record.resultTabId === tabId) &&
                        (!token || record.token === token)) delete next[id];
                }
                return next;
            });
        }
    };
}
