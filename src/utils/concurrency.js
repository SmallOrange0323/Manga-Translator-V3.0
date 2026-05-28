/**
 * concurrency.js
 * 並發控制工具 - Semaphore（號誌）
 * 用途：限制同時執行的非同步任務數量，防止 API 過載
 */

export class Semaphore {
    /**
     * @param {number} maxConcurrency - 最大並行數（通常等於 API Key 數量）
     */
    constructor(maxConcurrency) {
        this._max = maxConcurrency;
        this._current = 0;
        this._queue = [];
    }

    /**
     * 取得一個執行許可。若已滿載，則等待直到有空位。
     * @returns {Promise<void>}
     */
    acquire() {
        return new Promise((resolve) => {
            if (this._current < this._max) {
                this._current++;
                resolve();
            } else {
                this._queue.push(resolve);
            }
        });
    }

    /**
     * 釋放一個執行許可，並喚醒下一個等待中的任務。
     */
    release() {
        this._current--;
        if (this._queue.length > 0) {
            const next = this._queue.shift();
            this._current++;
            next();
        }
    }

    /**
     * 以有序方式並行執行一組非同步工廠函數，並保留原始索引順序。
     * @param {Array<() => Promise<any>>} taskFactories - 任務工廠函數陣列
     * @returns {Promise<Array<{index: number, result?: any, error?: Error}>>}
     */
    async runAll(taskFactories) {
        const results = new Array(taskFactories.length);
        const promises = taskFactories.map((factory, index) =>
            (async () => {
                await this.acquire();
                try {
                    results[index] = { index, result: await factory() };
                } catch (err) {
                    results[index] = { index, error: err };
                } finally {
                    this.release();
                }
            })()
        );
        await Promise.all(promises);
        return results;
    }
}

/**
 * KeyRateLimiter: 支援「每個 Key 獨立冷卻時間」的排程器
 */
export class KeyRateLimiter {
    /**
     * @param {string[]} apiKeys - 所有的 API Keys
     * @param {number} delayMs - 每個 Key 使用後的強制冷卻時間 (ms)
     */
    constructor(apiKeys, delayMs) {
        this.keys = apiKeys.map(key => ({
            key,
            lastUsed: 0
        }));
        this.delayMs = delayMs;
        this.lastPickIndex = -1; // 追蹤上一次使用的索引
        this.waitingQueue = [];
    }

    /**
     * 獲取一個目前「已冷卻完畢」的可用 Key (採用 Round Robin 輪詢)
     */
    async acquireKey() {
        return new Promise((resolve) => {
            const tryPick = () => {
                const now = Date.now();
                const n = this.keys.length;
                
                // 從上一次使用的下一個位置開始搜尋
                for (let i = 1; i <= n; i++) {
                    const idx = (this.lastPickIndex + i) % n;
                    const k = this.keys[idx];
                    
                    if ((now - k.lastUsed) >= this.delayMs) {
                        k.lastUsed = now;
                        this.lastPickIndex = idx;
                        resolve(k.key);
                        return;
                    }
                }

                // 若都還在冷卻中，計算最快一個冷卻完的時間
                const nextReadyTime = Math.min(...this.keys.map(k => k.lastUsed + this.delayMs));
                const waitTime = Math.max(100, nextReadyTime - now);
                setTimeout(tryPick, waitTime);
            };
            tryPick();
        });
    }
}
