/**
 * novel-session-id.js
 * 
 * 產生小說模式獨立 Session ID (UUID v4 規格)。
 */
export function createNovelSessionId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    // 安全 Fallback unique ID
    return 'nov-' + Date.now().toString(36) + '-' + Math.random().toString(36).substring(2, 11);
}
