import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';

// Capture the actual reader listener and snapshot renderer without booting unrelated reader controls.
const source = readFileSync(new URL('../src/reader/result.js', import.meta.url), 'utf8');
const start = source.indexOf('function showRecoveryError(');
const end = source.indexOf('function createPlaceholders(', start);
if (start < 0 || end < 0) throw new Error('Reader message test boundary missing');

function reader() {
    const nodes = new Map();
    const cards = [];
    function element() {
        const classes = new Set();
        return { children: [], style: {}, textContent: '', innerText: '',
            classList: { add: name => classes.add(name), toggle: (name, value) => value ? classes.add(name) : classes.delete(name), contains: name => classes.has(name) },
            setAttribute() {}, addEventListener: vi.fn(), appendChild(node) { this.children.push(node); },
            remove() { nodes.delete(this.id); } };
    }
    nodes.set('loading-overlay', element());
    nodes.set('progress-text', element());
    const container = { before: node => nodes.set(node.id, node), set innerHTML(_value) { cards.length = 0; } };
    let listener;
    const dependencies = {
        chrome: { runtime: { onMessage: { addListener: callback => { listener = callback; } } } },
        document: { getElementById: id => nodes.get(id) || null, createElement: element },
        container, window: {},
        buildCard: (item, index) => ({ item, index }),
        getOrCreateBatchSection: () => ({ appendChild: card => cards.push(card) }),
        updateNavUI: vi.fn(), resetNavButtons: vi.fn(), updateRetryAllBtn: vi.fn()
    };
    const state = new Function(...Object.keys(dependencies),
        'let translatedData = []; let lastMangaRevision = -1; let activeMangaJob = null; let sourceTabId = null; let activeMangaKey = null; let placeholdersCreated = false;\n' +
        source.slice(start, end) + '\nreturn { apply: applyMangaSnapshot, read: () => translatedData };')(...Object.values(dependencies));
    return { ...state, nodes, cards, resetNavButtons: dependencies.resetNavButtons,
        deliver: message => listener(message, {}, vi.fn()) };
}
function job(revision, status = 'running', text = 'translated') {
    return { id: 'job1', revision, status, sourceTabId: 1, images: ['https://manga.test/page.jpg'], processedCount: 1,
        results: [{ image: 'https://manga.test/page.jpg', results: [{ original: 'text', translation: text }], pageIndex: 1, batchIndex: 0 }] };
}

describe('production reader recovery message listener', () => {
    it('renders live saved batches and reflects live completion without reload', () => {
        const page = reader();
        expect(page.deliver({ action: 'mangaSnapshot', job: job(1) })).toBe(false);
        expect(page.cards).toHaveLength(1);
        expect(page.read()[0].results[0].translation).toBe('translated');
        expect(page.nodes.get('loading-overlay').classList.contains('hidden')).toBe(false);
        page.deliver({ action: 'mangaSnapshot', job: job(2, 'completed') });
        expect(page.nodes.get('loading-overlay').classList.contains('hidden')).toBe(true);
        expect(page.cards).toHaveLength(1);
    });

    it('rejects stale initial response and duplicate live snapshots after a newer live batch', () => {
        const page = reader();
        page.deliver({ action: 'mangaSnapshot', job: job(4, 'completed', 'latest') });
        page.apply(job(2, 'running', 'stale initial response'));
        page.deliver({ action: 'mangaSnapshot', job: job(4, 'running', 'duplicate') });
        expect(page.read()[0].results[0].translation).toBe('latest');
        expect(page.cards).toHaveLength(1);
        expect(page.nodes.get('loading-overlay').classList.contains('hidden')).toBe(true);
    });

    it('shows live recovery errors and stops the loading indicator', () => {
        const page = reader();
        page.deliver({ action: 'mangaRecoveryError', error: 'Checkpoint unavailable' });
        expect(page.nodes.get('manga-recovery-notice').textContent).toBe('Checkpoint unavailable');
        expect(page.nodes.get('loading-overlay').classList.contains('hidden')).toBe(true);
        expect(page.resetNavButtons).toHaveBeenCalledOnce();
    });
});

describe('next chapter pretranslation badge', () => {
    it('keeps checking after an initial cache miss and shows the completed pretranslation', async () => {
        vi.useFakeTimers();
        try {
            const nodes = new Map();
            const document = { getElementById(id) {
                if (!nodes.has(id)) nodes.set(id, { style: {}, classList: { add() {} }, textContent: '', title: '' });
                return nodes.get(id);
            } };
            const replies = [
                { exists: false },
                { exists: true, inProgress: true, count: 1, total: 2 },
                { exists: true, isDone: true }
            ];
            const sendMessage = vi.fn((message, callback) => callback(message.action === 'CONSUME_PRETRANSLATED_CHAPTER'
                ? { success: true, data: { results: [] }, job: { id: 'next-chapter' } } : replies.shift()));
            const applyMangaSnapshot = vi.fn();
            const window = { scrollTo: vi.fn() };
            const container = { scrollTo: vi.fn() };
            const sectionStart = source.indexOf('let pretranslateBadgeGeneration = 0;');
            const sectionEnd = source.indexOf('\nlet placeholdersCreated = false;', sectionStart);
            const updateNavUI = new Function('document', 'chrome', 'isSafeUrl',
                'sourceTabId', 'activeMangaKey', 'urlParams', 'sendNavigateMessageWithRetry',
                'applyMangaSnapshot', 'renderPretranslatedChapter', 'window', 'container',
                source.slice(sectionStart, sectionEnd) + '\nreturn updateNavUI;')(
                    document, { runtime: { sendMessage } }, value => /^https?:\/\//.test(value),
                    1, null, new URLSearchParams(), vi.fn(), applyMangaSnapshot, vi.fn(), window, container
                );
            updateNavUI({ next: 'https://rawkuma.net/manga/example/chapter-4/' });
            expect(nodes.get('nav-pretranslate-badge').style.display).toBe('none');
            await vi.advanceTimersByTimeAsync(3000);
            expect(nodes.get('nav-pretranslate-badge').textContent).toContain('預翻中');
            await vi.advanceTimersByTimeAsync(3000);
            expect(nodes.get('nav-pretranslate-badge').textContent).toBe('⚡已預翻');
            expect(sendMessage).toHaveBeenCalledTimes(3);
            nodes.get('nav-next-chapter-btn').onclick();
            expect(applyMangaSnapshot).toHaveBeenCalledWith({ id: 'next-chapter' });
            expect(window.scrollTo).toHaveBeenCalledWith(0, 0);
            expect(container.scrollTo).toHaveBeenCalledWith(0, 0);
        } finally {
            vi.useRealTimers();
        }
    });
});
