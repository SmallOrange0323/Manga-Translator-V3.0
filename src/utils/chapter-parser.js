// Pure helpers shared by the content script and the MV3 service worker.

const IMAGE_ATTRIBUTES = [
    'data-src', 'data-lazy-src', 'data-original', 'data-aload',
    'data-src-img', 'data-page-src', 'data-image-src', 'data-full-url',
    'data-url', 'data-srcset', 'src', 'srcset'
];
const READER_CONTAINERS = new Set([
    'readerarea', 'reading-content', 'list-imga', 'ts-main-image',
    'manga-image', 'viewer-cnt', 'chapter-content'
]);
const JUNK_FILENAME = /(?:^|[-_.])(?:logo|banner|icon|button|avatar|widget|social|badge|emoji|reaction|loading|placeholder|thumb|header|footer|advert|donate|rating|counter|captcha|tracker|visitor|viewcount)(?:[-_.]|$)/i;
const TRACKER_HOST = /(?:^|\.)(?:whos\.amung\.us|histats\.com|clustrmaps\.com|flagcounter\.com)$/i;
const PLACEHOLDER_FILENAME = /^(?:loading|placeholder|spacer|transparent|pixel)(?:[-_.][\w-]+)*\.(?:gif|png|jpe?g|webp|svg)$/i;

export function decodeHtmlEntities(value = '') {
    return String(value).replace(/&(#(?:x[0-9a-f]+|[0-9]+)|amp|quot|apos|lt|gt|nbsp|sol);/gi, (_, entity) => {
        const named = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ', sol: '/' };
        if (entity[0] !== '#') return named[entity.toLowerCase()] || _;
        const number = entity[1].toLowerCase() === 'x'
            ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
        return Number.isInteger(number) && number > 0 && number <= 0x10ffff
            ? String.fromCodePoint(number) : _;
    });
}

export function resolveHttpUrl(value, baseUrl) {
    if (!value || /^(?:javascript|data|blob):/i.test(String(value).trim())) return '';
    try {
        // DOM attributes and parsed HTML attributes are already entity-decoded.
        // Decoding twice changes signed query strings such as "&amp;quot;".
        const url = new URL(String(value).trim(), baseUrl);
        if (!/^https?:$/.test(url.protocol)) return '';
        return url.href;
    } catch (_) {
        return '';
    }
}

export function normalizeChapterUrl(value, baseUrl) {
    const resolved = resolveHttpUrl(value, baseUrl);
    if (!resolved) return '';
    const url = new URL(resolved);
    url.hash = '';
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url.href;
}

export function chapterNumber(value) {
    const text = String(value || '');
    if (/(?:^|\W)(?:extra|special|bonus)(?:\W|$)|番外|特別/i.test(text)) return null;
    const match = text.match(/(?:chapter|chap|ch\.?|episode|ep\.?|第)\s*[-_]?\s*0*(\d+(?:\.\d+)?)/i)
        || text.match(/(?:^|[^\d])0*(\d+(?:\.\d+)?)(?!\d)/);
    return match ? Number(match[1]) : null;
}

function chapterNumberFromUrl(value, baseUrl) {
    const url = normalizeChapterUrl(value, baseUrl);
    if (!url) return null;
    const lastSegment = new URL(url).pathname.split('/').filter(Boolean).pop() || '';
    if (!/(?:chapter|chap|ch[-_.]?|episode|ep[-_.]?|^\d)/i.test(lastSegment)) return null;
    return chapterNumber(lastSegment);
}

export function chapterNeighbors(entries, currentUrl, baseUrl = currentUrl) {
    const list = entries.map(item => ({
        ...item,
        url: resolveHttpUrl(item.url, baseUrl),
        number: chapterNumber(item.title) ?? chapterNumberFromUrl(item.url, baseUrl)
    }));
    const normalizedCurrent = normalizeChapterUrl(currentUrl, baseUrl);
    if (!normalizedCurrent) return { prev: null, next: null, currentIndex: -1 };
    let index = list.findIndex(item => item.url && normalizeChapterUrl(item.url, baseUrl) === normalizedCurrent);
    if (index < 0) index = list.findIndex(item => item.current && item.url
        && new URL(item.url).origin === new URL(normalizedCurrent).origin);
    if (index < 0) return { prev: null, next: null, currentIndex: -1 };

    const numeric = list.filter(item => item.number !== null);
    if (numeric.length < 2) return { prev: null, next: null, currentIndex: index };
    const first = numeric[0].number;
    const last = numeric[numeric.length - 1].number;
    if (first === last) return { prev: null, next: null, currentIndex: index };
    const descending = first > last;
    const current = list[index];
    const neighbor = (offset, newer) => {
        const item = list[index + offset];
        if (!item?.url || item.number === null || current.number === null) return null;
        if (newer ? item.number <= current.number : item.number >= current.number) return null;
        if (normalizeChapterUrl(item.url, baseUrl) === normalizedCurrent) return null;
        if (new URL(item.url).origin !== new URL(normalizedCurrent).origin) return null;
        return item.url;
    };
    return {
        prev: neighbor(descending ? 1 : -1, false),
        next: neighbor(descending ? -1 : 1, true),
        currentIndex: index
    };
}

function attributes(tag) {
    const result = {};
    const body = tag.replace(/^<\/?[\w:-]+\b/, '').replace(/\/?\s*>$/, '');
    const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
    let match;
    while ((match = pattern.exec(body))) {
        result[match[1].toLowerCase()] = decodeHtmlEntities(match[2] ?? match[3] ?? match[4] ?? '');
    }
    return result;
}

function imageUrl(attrs, baseUrl, trustedReader) {
    for (const key of IMAGE_ATTRIBUTES) {
        let candidate = attrs[key];
        if (!candidate) continue;
        if (key.endsWith('srcset')) candidate = candidate.split(',')[0].trim().split(/\s+/)[0];
        const url = resolveHttpUrl(candidate, baseUrl);
        if (!url) continue;
        const parsed = new URL(url);
        const filename = parsed.pathname.split('/').pop() || '';
        if (/\.svg$/i.test(filename) || PLACEHOLDER_FILENAME.test(filename)
            || (!trustedReader && JUNK_FILENAME.test(filename)) || TRACKER_HOST.test(parsed.hostname)) continue;
        return url;
    }
    return '';
}

function htmlTags(html) {
    // Quoted '>' characters must not terminate a tag.
    return html.match(/<\/?[a-z][\w:-]*\b(?:"[^"]*"|'[^']*'|[^'">])*>/gi) || [];
}

function parseEpisodeJsonImages(html, baseUrl) {
    for (const match of html.matchAll(/(<script\b(?:"[^"]*"|'[^']*'|[^'">])*>)([\s\S]*?)<\/script\s*>/gi)) {
        const attrs = attributes(match[1]);
        if (attrs.id !== 'episode-json' && !Object.hasOwn(attrs, 'data-episode-json')) continue;
        const raw = attrs['data-episode-json'] || attrs['data-value'] || match[2].trim();
        if (!raw || raw.length > 2_000_000) continue;
        try {
            const data = JSON.parse(raw);
            const pageStructure = data?.readableProduct?.pageStructure;
            if (pageStructure?.choJuGiga) return { images: [], protectedCanvas: true };
            const pages = pageStructure?.pages || data?.pages;
            if (!Array.isArray(pages)) continue;
            const images = pages.filter(page => page?.type === 'main' && typeof page.src === 'string')
                .map(page => imageUrl({ src: page.src }, baseUrl, true)).filter(Boolean);
            if (images.length) return { images: [...new Set(images)], protectedCanvas: false };
        } catch (_) {
            // Malformed episode data should not prevent the regular image scan.
        }
    }
    return { images: [], protectedCanvas: false };
}

function parseImages(html, baseUrl) {
    const tags = htmlTags(html.replace(/<(script|style)\b(?:"[^"]*"|'[^']*'|[^'">])*?>[\s\S]*?<\/\1\s*>/gi, ''));
    const records = [];
    const stack = [];
    for (const tag of tags) {
        const opening = tag.match(/^<([a-z][\w:-]*)/i);
        const closing = tag.match(/^<\/([a-z][\w:-]*)/i);
        if (closing) {
            const index = stack.map(item => item.name).lastIndexOf(closing[1].toLowerCase());
            if (index >= 0) stack.length = index;
            continue;
        }
        if (!opening) continue;
        const name = opening[1].toLowerCase();
        const attrs = attributes(tag);
        if (name === 'img') {
            const width = Number.parseInt(attrs.width, 10);
            const height = Number.parseInt(attrs.height, 10);
            if ((width > 0 && width < 200) || (height > 0 && height < 200)) continue;
            const inReader = stack.some(item => item.reader);
            const url = imageUrl(attrs, baseUrl, inReader);
            if (url) records.push({ url, inReader });
        } else if (!/\/>$/.test(tag) && !/^(?:area|base|br|embed|hr|input|link|meta|source|wbr)$/.test(name)) {
            const names = [attrs.id, ...(attrs.class || '').split(/\s+/)].filter(Boolean);
            stack.push({ name, reader: Object.hasOwn(attrs, 'data-image-data')
                || names.some(value => READER_CONTAINERS.has(value.toLowerCase())) });
        }
    }
    const candidates = records.some(item => item.inReader) ? records.filter(item => item.inReader) : records;
    return [...new Set(candidates.map(item => item.url))];
}

function parseSelectLists(html, baseUrl) {
    const lists = [];
    for (const select of html.matchAll(/<select\b(?:"[^"]*"|'[^']*'|[^'">])*>([\s\S]*?)<\/select\s*>/gi)) {
        const entries = [];
        for (const option of select[1].matchAll(/(<option\b(?:"[^"]*"|'[^']*'|[^'">])*>)([\s\S]*?)<\/option\s*>/gi)) {
            const attrs = attributes(option[1]);
            entries.push({
                title: decodeHtmlEntities(option[2].replace(/<[^>]*>/g, '').trim()),
                url: attrs.value || '',
                current: Object.hasOwn(attrs, 'selected')
            });
        }
        if (entries.length >= 2) lists.push(entries);
    }
    return lists;
}

function parseCustomLists(html) {
    const lists = [];
    for (const ul of html.matchAll(/(<ul\b(?:"[^"]*"|'[^']*'|[^'">])*>)([\s\S]*?)<\/ul\s*>/gi)) {
        const ulAttrs = attributes(ul[1]);
        if (!/(?:reading-list|chapters-list|chapter-list)/i.test(`${ulAttrs.class || ''} ${ulAttrs.id || ''}`)) continue;
        const entries = [];
        for (const li of ul[2].matchAll(/(<li\b(?:"[^"]*"|'[^']*'|[^'">])*>)([\s\S]*?)<\/li\s*>/gi)) {
            const anchor = li[2].match(/(<a\b(?:"[^"]*"|'[^']*'|[^'">])*>)([\s\S]*?)<\/a\s*>/i);
            if (!anchor) continue;
            const attrs = attributes(anchor[1]);
            const liAttrs = attributes(li[1]);
            entries.push({
                title: decodeHtmlEntities(anchor[2].replace(/<[^>]*>/g, '').trim()),
                url: attrs.href || '',
                current: /(?:^|\s)(?:highlight|active|current|selected)(?:\s|$)/i.test(liAttrs.class || '')
            });
        }
        if (entries.length >= 2) lists.push({
            entries,
            visible: !/display\s*:\s*none/i.test(ulAttrs.style || '') && ulAttrs['aria-hidden'] !== 'true'
        });
    }
    return lists;
}

function parseLegacyLinks(html, baseUrl, nav) {
    const current = normalizeChapterUrl(baseUrl, baseUrl);
    for (const anchor of html.matchAll(/(<a\b(?:"[^"]*"|'[^']*'|[^'">])*>)([\s\S]*?)<\/a\s*>/gi)) {
        const attrs = attributes(anchor[1]);
        const url = resolveHttpUrl(attrs.href, baseUrl);
        if (!url || normalizeChapterUrl(url, baseUrl) === current || new URL(url).origin !== new URL(current).origin
            || Object.hasOwn(attrs, 'disabled') || attrs['aria-disabled'] === 'true'
            || /(?:^|\s)(?:disabled|is-disabled)(?:\s|$)/i.test(attrs.class || '')) continue;
        const text = decodeHtmlEntities(anchor[2].replace(/<[^>]*>/g, ''));
        const label = `${text} ${attrs.title || ''} ${attrs['aria-label'] || ''} ${attrs.class || ''}`;
        const rel = attrs.rel || '';
        if (!nav.next && (/(?:^|\s)next(?:\s|$)/i.test(rel) || /下一[話话頁页章回節节]|next(?:\s*page|\s*chapter)?|次へ/i.test(label))) nav.next = url;
        if (!nav.prev && (/(?:^|\s)prev(?:ious)?(?:\s|$)/i.test(rel) || /上一[話话頁页章回節节]|prev(?:ious)?|前へ/i.test(label))) nav.prev = url;
    }
}

export function parseChapterHtml(html, chapterUrl) {
    // Scripts/comments can contain sample markup that is not part of the page.
    html = String(html || '').replace(/<!--[\s\S]*?-->/g, '');
    const episode = parseEpisodeJsonImages(html, chapterUrl);
    html = html
        .replace(/<(script|style)\b(?:"[^"]*"|'[^']*'|[^'">])*?>[\s\S]*?<\/\1\s*>/gi, '');
    const images = episode.protectedCanvas ? []
        : episode.images.length ? episode.images : parseImages(html, chapterUrl);
    const navLinks = { prev: null, next: null };
    const lists = [
        ...parseSelectLists(String(html || ''), chapterUrl).map(entries => ({ entries, visible: true })),
        ...parseCustomLists(String(html || ''))
    ];
    const current = normalizeChapterUrl(chapterUrl, chapterUrl);
    const candidates = lists.map(list => ({
        ...list,
        exact: list.entries.some(item => normalizeChapterUrl(item.url, chapterUrl) === current),
        inferred: chapterNeighbors(list.entries, chapterUrl)
    })).filter(item => item.inferred.currentIndex >= 0);
    candidates.sort((a, b) => Number(b.exact) - Number(a.exact) || Number(b.visible) - Number(a.visible));
    if (candidates[0]) {
        navLinks.prev = candidates[0].inferred.prev;
        navLinks.next = candidates[0].inferred.next;
    } else {
        parseLegacyLinks(String(html || ''), chapterUrl, navLinks);
    }
    return { images, navLinks };
}
