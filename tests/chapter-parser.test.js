import { describe, expect, it, vi, afterEach } from 'vitest';
import { chapterNeighbors, normalizeChapterUrl, parseChapterHtml } from '../src/utils/chapter-parser.js';
import { detectNavigationLinks } from '../src/utils/nav-detector.js';

const base = 'https://reader.example/series/chapter-9/';

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('background chapter HTML parsing', () => {
    it('prefetches only GigaViewer main pages from episode-json ahead of page chrome', () => {
        const payload = { readableProduct: { pageStructure: { pages: [
            { type: 'other', hide: true },
            { type: 'link', linkPosition: 'left' },
            { type: 'main', src: 'https://cdn.example/public/page/1' },
            { type: 'main', src: '/public/page/2' }
        ] } } };
        const encoded = JSON.stringify(payload).replace(/"/g, '&quot;');
        const html = `<img src="/cover.jpg"><script id="episode-json" type="text/json" data-value="${encoded}"></script>`;
        expect(parseChapterHtml(html, base).images).toEqual([
            'https://cdn.example/public/page/1',
            'https://reader.example/public/page/2'
        ]);
    });

    it('falls back to reader images when episode-json is malformed', () => {
        const html = `<script id="episode-json" data-value="{broken}"></script>
            <div id="readerarea"><img src="/pages/1.jpg"></div>`;
        expect(parseChapterHtml(html, base).images).toEqual(['https://reader.example/pages/1.jpg']);
    });

    it('never prefetches scrambled GigaViewer sources or surrounding cover images', () => {
        const payload = { readableProduct: { pageStructure: {
            choJuGiga: 'baku', pages: [{ type: 'main', src: 'https://cdn.example/scrambled/page-1' }]
        } } };
        const encoded = JSON.stringify(payload).replace(/"/g, '&quot;');
        const html = `<img src="/cover.jpg"><script id="episode-json" data-value="${encoded}"></script>`;
        expect(parseChapterHtml(html, base).images).toEqual([]);
    });

    it('recognizes Rawkuma reader data and less common lazy attributes during chapter prefetch', () => {
        const html = `<img src="/site-logo.jpg">
            <div data-image-data="chapter">
                <img src="/placeholder.gif" data-page-src="/pages/01.jpg">
                <img src="/loading.png" data-image-src="/pages/02.jpg">
                <img data-full-url="/pages/03.jpg" src="/spacer.gif">
            </div><img src="/other/04.jpg">`;
        expect(parseChapterHtml(html, base).images).toEqual([
            'https://reader.example/pages/01.jpg',
            'https://reader.example/pages/02.jpg',
            'https://reader.example/pages/03.jpg'
        ]);
    });

    it('preserves signed CDN paths and decodes entities exactly once', () => {
        const html = `<div id="readerarea"><img data-src="https://cdn.example/page/?signature=a%2Fb&amp;literal=&amp;quot;" src="/placeholder.gif"></div>`;
        expect(parseChapterHtml(html, base).images).toEqual([
            'https://cdn.example/page/?signature=a%2Fb&literal=&quot;'
        ]);
    });

    it('keeps real reader pages named banner but never treats placeholders or sample markup as pages', () => {
        const html = `<!-- <img src="/ghost.jpg"> -->
            <script>const example = '<img src="/sample.jpg">';</script>
            <div id="readerarea"><img src="/pages/banner.jpg">
            <img src="/loading.gif"><img data-srcset="/pages/2.jpg 1x, /pages/2-hd.jpg 2x" src="/placeholder.png"></div>`;
        expect(parseChapterHtml(html, base).images).toEqual([
            'https://reader.example/pages/banner.jpg', 'https://reader.example/pages/2.jpg'
        ]);
    });

    it('does not infer external chapter links from a selected list', () => {
        expect(chapterNeighbors([
            { title: '8', url: '/series/chapter-8/' },
            { title: '9', url: base, current: true },
            { title: '10', url: 'https://outside.example/chapter-10/' }
        ], base).next).toBeNull();
    });

    it('uses a valid lazy image before a placeholder src, regardless of attribute order', () => {
        const html = `<div id="readerarea">
            <img src="/images/loading.svg" data-src="/pages/1.jpg?x=1&amp;y=2">
            <img data-lazy-src='/pages/2.jpg' src='/images/placeholder.gif'>
            <img src='/pages/3.jpg' data-original='/pages/3-full.jpg'>
        </div>`;
        expect(parseChapterHtml(html, base).images).toEqual([
            'https://reader.example/pages/1.jpg?x=1&y=2',
            'https://reader.example/pages/2.jpg',
            'https://reader.example/pages/3-full.jpg'
        ]);
    });

    it('keeps real chapter image URLs containing junk words while filtering actual junk images', () => {
        const html = `<img src="/series/logo-vote-love/chapter-9/01.jpg">
            <img src="/assets/site-logo.png"><img src="/assets/banner.jpg">
            <img src="/assets/tracker.gif" width="1" height="1">`;
        expect(parseChapterHtml(html, base).images).toEqual([
            'https://reader.example/series/logo-vote-love/chapter-9/01.jpg'
        ]);
    });

    it('handles numeric 8/9/10 order, quoted attributes, entities, and exact current URL', () => {
        const html = `<select id="chapter">
            <option value='/series/chapter-8/'>Chapter 8</option>
            <option value='/series/chapter-9/?a=1&amp;b=2' selected>Chapter 9</option>
            <option value='/series/chapter-10/'>Chapter 10</option>
        </select>`;
        const result = parseChapterHtml(html, 'https://reader.example/series/chapter-9/?a=1&b=2#page1');
        expect(result.navLinks).toEqual({
            prev: 'https://reader.example/series/chapter-8/',
            next: 'https://reader.example/series/chapter-10/'
        });
        expect(normalizeChapterUrl('/series/chapter-9/', base)).toBe('https://reader.example/series/chapter-9');
    });

    it('does not turn unrelated site pagination into a next chapter at the list boundary', () => {
        const html = `<select id="chapter">
            <option value="/series/chapter-9/">Chapter 9</option>
            <option value="/series/chapter-10/" selected>Chapter 10</option>
        </select><a rel="next" href="/catalog/page/2">Next</a>`;
        expect(parseChapterHtml(html, 'https://reader.example/series/chapter-10/').navLinks)
            .toEqual({ prev: 'https://reader.example/series/chapter-9/', next: null });
    });

    it('handles descending fractional chapters without inventing links through extras or missing current', () => {
        const list = [
            { title: 'Chapter 10', url: '/10' },
            { title: 'Chapter 9.5', url: '/9.5' },
            { title: 'Extra 5', url: '/extra-5' },
            { title: 'Chapter 9', url: '/9' },
            { title: 'Chapter 8', url: '/8' }
        ];
        expect(chapterNeighbors(list, 'https://reader.example/9.5').next).toBe('https://reader.example/10');
        expect(chapterNeighbors(list, 'https://reader.example/9.5').prev).toBeNull();
        expect(chapterNeighbors(list, 'https://reader.example/9').prev).toBe('https://reader.example/8');
        expect(chapterNeighbors(list, 'https://reader.example/9').next).toBeNull();
        expect(chapterNeighbors(list, 'https://reader.example/missing')).toEqual({ prev: null, next: null, currentIndex: -1 });
    });

    it('falls back to legacy next and previous anchors when no select resolves', () => {
        const html = `<a href="/series/chapter-10/?a=1&amp;b=2" rel="next">Next chapter</a>
            <a href='/series/chapter-8/' aria-label='上一話'>Back</a>
            <a href='/series/chapter-9/#top' rel='next'>Current</a>`;
        expect(parseChapterHtml(html, base).navLinks).toEqual({
            prev: 'https://reader.example/series/chapter-8/',
            next: 'https://reader.example/series/chapter-10/?a=1&b=2'
        });
    });

    it('parses uppercase tags and attributes, and rejects external legacy navigation', () => {
        const html = `<IMG DATA-SRC='/pages/4.jpg?one=1&amp;two=2' SRC='/loading.svg'>
            <A HREF='https://outside.example/series/chapter-10' REL='NEXT'>Next</A>
            <A HREF='/series/chapter-10/' REL='NEXT'>Next</A>`;
        const result = parseChapterHtml(html, base);
        expect(result.images).toEqual(['https://reader.example/pages/4.jpg?one=1&two=2']);
        expect(result.navLinks.next).toBe('https://reader.example/series/chapter-10/');
    });

    it('picks the exact current chapter from a visible multilingual custom list', () => {
        const html = `<ul class='reading-list' style='display:none'>
            <li class='highlight'><a href='/en/chapter-10/'>10</a></li>
            <li><a href='/en/chapter-9/'>9</a></li>
            <li><a href='/en/chapter-8/'>8</a></li>
        </ul>
        <ul class='reading-list'>
            <li><a href='/series/chapter-10/'>10</a></li>
            <li class='highlight'><a href='/series/chapter-9/'>9</a></li>
            <li><a href='/series/chapter-8/'>8</a></li>
        </ul>`;
        expect(parseChapterHtml(html, base).navLinks).toEqual({
            prev: 'https://reader.example/series/chapter-8/',
            next: 'https://reader.example/series/chapter-10/'
        });
    });
});

describe('content chapter navigation', () => {
    it('replaces wrong-language selected navigation when a custom list matches the exact current URL', () => {
        const options = [8, 9, 10].map(n => ({
            value: `/en/chapter-${n}/`, text: String(n), selected: n === 9,
            hasAttribute: () => false
        }));
        const custom = {
            style: {}, getAttribute: () => null,
            querySelectorAll: () => [8, 9, 10].map(n => ({
                className: n === 8 ? 'selected' : '',
                querySelector: () => ({ href: `https://reader.example/series/chapter-${n}/`, textContent: String(n) })
            }))
        };
        vi.stubGlobal('window', { location: { href: base } });
        vi.stubGlobal('document', {
            title: '', querySelectorAll: selector => selector === 'a' ? []
                : selector.startsWith('select') ? [{ options }] : [custom]
        });
        const nav = detectNavigationLinks();
        expect(nav.next).toBe('https://reader.example/series/chapter-10/');
        expect(nav.prev).toBe('https://reader.example/series/chapter-8/');
        expect(nav.chapterList.filter(item => item.current).map(item => item.title)).toEqual(['9']);
    });

    it('uses numeric order and exact URL matching in select lists', () => {
        const options = [8, 9, 10].map(n => ({
            value: `/series/chapter-${n}/`, text: `Chapter ${n}`, selected: false,
            hasAttribute: () => false
        }));
        vi.stubGlobal('window', { location: { href: base } });
        vi.stubGlobal('document', {
            title: '',
            querySelectorAll: selector => selector === 'a' ? [] : selector.startsWith('select')
                ? [{ options }] : []
        });
        const nav = detectNavigationLinks();
        expect(nav.next).toBe('https://reader.example/series/chapter-10/');
        expect(nav.prev).toBe('https://reader.example/series/chapter-8/');
        expect(nav.chapterList.filter(item => item.current)).toHaveLength(1);
    });

    it('uses the matching visible custom chapter list over a hidden other-language list', () => {
        const createList = (prefix, hidden) => ({
            style: { display: hidden ? 'none' : 'block' },
            getAttribute: () => null,
            querySelectorAll: () => [10, 9, 8].map(n => ({
                className: n === 9 ? 'highlight' : '',
                querySelector: () => ({
                    href: `https://reader.example/${prefix}/chapter-${n}/`,
                    textContent: String(n)
                })
            }))
        });
        vi.stubGlobal('window', { location: { href: base } });
        vi.stubGlobal('document', {
            title: '',
            querySelectorAll: selector => selector === 'a' ? [] : selector.startsWith('ul.')
                ? [createList('en', true), createList('series', false)] : []
        });
        const nav = detectNavigationLinks();
        expect(nav.next).toBe('https://reader.example/series/chapter-10/');
        expect(nav.prev).toBe('https://reader.example/series/chapter-8/');
        expect(nav.chapterList[nav.chapterList.findIndex(item => item.current)].title).toBe('9');
    });
});
