export function parseWnacgPageUrls(source, baseUrl) {
    const key = source.indexOf('"page_url"');
    if (key < 0) throw new Error('閱讀器資料沒有圖片清單');
    const start = source.indexOf('[', key + '"page_url"'.length);
    if (start < 0) throw new Error('閱讀器圖片清單格式不正確');

    let quoted = false;
    let escaped = false;
    let end = -1;
    for (let i = start + 1; i < source.length; i++) {
        const char = source[i];
        if (escaped) {
            escaped = false;
        } else if (char === '\\' && quoted) {
            escaped = true;
        } else if (char === '"') {
            quoted = !quoted;
        } else if (char === ']' && !quoted) {
            end = i;
            break;
        }
    }
    if (end < 0) throw new Error('閱讀器圖片清單未結束');

    // The site's JavaScript array currently has a trailing comma, so parse only
    // this data field rather than evaluating the script as code.
    const literal = source.slice(start, end + 1).replace(/,\s*]$/, ']');
    const rawUrls = JSON.parse(literal);
    if (!Array.isArray(rawUrls) || rawUrls.length === 0) {
        throw new Error('閱讀器圖片清單是空的');
    }
    const urls = rawUrls.map(raw => {
        if (typeof raw !== 'string') throw new Error('閱讀器圖片網址格式不正確');
        const url = new URL(raw, baseUrl);
        if (!['http:', 'https:'].includes(url.protocol)) {
            throw new Error('閱讀器圖片網址格式不正確');
        }
        if (new URL(baseUrl).protocol === 'https:' && url.protocol === 'http:') {
            url.protocol = 'https:';
        }
        return url.href;
    });
    if (new Set(urls).size !== urls.length) throw new Error('閱讀器圖片清單有重複頁面');
    return urls;
}
