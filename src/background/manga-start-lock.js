/**
 * Serializes only manga-job startup. Callers release the lock once a run has
 * been registered; the run itself remains managed by the background lifecycle.
 */
export function createMangaStartLock() {
    let queue = Promise.resolve();

    return function withMangaStartLock(task) {
        const previous = queue;
        let release;
        queue = new Promise(resolve => { release = resolve; });

        return previous.then(async () => {
            try {
                return await task();
            } finally {
                release();
            }
        });
    };
}
