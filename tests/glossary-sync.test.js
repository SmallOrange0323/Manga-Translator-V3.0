import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mergeGlossaryData } from '../src/utils/glossary-data.js';
import {
  saveGlossary, upsertGlossaryTerm, deleteGlossaryTerm, deleteGlossary,
  mergeRemoteGlossaries, getGlossarySnapshot, GLOSSARY_MAX_TERMS
} from '../src/background/glossary-manager.js';
import { performBiDirectionalSync } from '../src/utils/sync.js';
import { syncEngine } from '../src/utils/sync-engine.js';

let store;
let failWrite;
beforeEach(() => {
  store = {};
  failWrite = false;
  globalThis.chrome = {
    storage: {
      local: {
        get: vi.fn(async keys => {
          if (keys === null) return structuredClone(store);
          const selected = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(selected.map(key => [key, structuredClone(store[key])]).filter(([, value]) => value !== undefined));
        }),
        set: vi.fn(async values => {
          if (failWrite) throw new Error('storage failed');
          Object.assign(store, structuredClone(values));
        })
      },
      onChanged: { addListener: vi.fn() }
    },
    runtime: { sendMessage: vi.fn(async () => {}) }
  };
});

describe('glossary conflict handling', () => {
  it('keeps the newer manual edit and metadata through a cloud round trip', () => {
    const local = { book: { displayName: 'Local title', rawJapanese: '原題', romanKey: 'book', updatedAt: 300, terms: [{ ori: 'Name', trans: 'New', source: 'user', createdAt: 100, updatedAt: 300 }] } };
    const cloud = { book: { displayName: 'Old title', updatedAt: 200, terms: [{ ori: 'Name', trans: 'Old', source: 'user', createdAt: 100, updatedAt: 200 }] } };
    const first = mergeGlossaryData(local, cloud);
    const second = mergeGlossaryData(first.glossaries, cloud);
    expect(second.glossaries.book.terms[0].trans).toBe('New');
    expect(second.glossaries.book.rawJapanese).toBe('原題');
    expect(second.glossaries.book.displayName).toBe('Local title');
  });

  it('migrates a legacy entry during merge and keeps its manual term over newer AI text', () => {
    const legacy = { book: { displayName: 'Legacy', rawJapanese: '原題', terms: [{ ori: 'Name', trans: 'Manual', source: 'user' }] } };
    const cloud = { book: { updatedAt: 200, terms: [{ ori: 'Name', trans: 'AI', source: 'ai', createdAt: 200, updatedAt: 200 }] } };
    const merged = mergeGlossaryData(legacy, cloud).glossaries.book;
    expect(merged.terms[0].trans).toBe('Manual');
    expect(merged.rawJapanese).toBe('原題');
    expect(merged.termTombstones).toEqual({});
  });

  it('does not revive a deleted term or work from an older cloud copy', async () => {
    await upsertGlossaryTerm('book', { ori: 'Name', trans: 'Name' });
    const oldCloud = (await getGlossarySnapshot()).glossaries;
    await deleteGlossaryTerm('book', 'Name');
    await mergeRemoteGlossaries(oldCloud);
    expect((await getGlossarySnapshot()).glossaries.book.terms).toEqual([]);
    await deleteGlossary('book');
    await mergeRemoteGlossaries(oldCloud);
    const snapshot = await getGlossarySnapshot();
    expect(snapshot.glossaries.book).toBeUndefined();
    expect(snapshot.tombstones.book).toBeGreaterThan(0);
  });

  it('keeps the work deletion boundary after one explicit new term', async () => {
    await upsertGlossaryTerm('book', { ori: 'Old 1', trans: '舊一' });
    await upsertGlossaryTerm('book', { ori: 'Old 2', trans: '舊二' });
    const oldCloud = (await getGlossarySnapshot()).glossaries;
    await deleteGlossary('book');
    await upsertGlossaryTerm('book', { ori: 'New', trans: '新' });
    await mergeRemoteGlossaries(oldCloud);
    const snapshot = await getGlossarySnapshot();
    expect(snapshot.glossaries.book.terms.map(term => term.ori)).toEqual(['New']);
    expect(snapshot.tombstones.book).toBeGreaterThan(0);
  });

  it('applies a work tombstone to case and punctuation aliases from the cloud', async () => {
    await upsertGlossaryTerm('Kamigami no Kago', { ori: 'Old', trans: '舊' });
    const oldCloud = (await getGlossarySnapshot()).glossaries['Kamigami no Kago'];
    await deleteGlossary('Kamigami no Kago');
    const result = await saveGlossary('KAMIGAMI-NO-KAGO', { terms: [{ ori: 'AI', trans: 'AI' }] });
    expect(result.suppressed).toBe(true);
    await mergeRemoteGlossaries({ 'KAMIGAMI-NO-KAGO': oldCloud });
    expect((await getGlossarySnapshot()).glossaries).toEqual({});
  });

  it('does not retain AI terms when 500 manual terms fill every slot', async () => {
    store.mangaGlossaries = { book: { terms: Array.from({ length: GLOSSARY_MAX_TERMS }, (_, index) => ({ ori: `User ${index}`, trans: `${index}`, source: 'user' })) } };
    await saveGlossary('book', { terms: [{ ori: 'AI', trans: 'AI', source: 'ai' }] });
    const terms = (await getGlossarySnapshot()).glossaries.book.terms;
    expect(terms).toHaveLength(GLOSSARY_MAX_TERMS);
    expect(terms.some(term => term.ori === 'AI')).toBe(false);
  });

  it('does not restore an AI term trimmed by the limit from a stale snapshot', async () => {
    const previous = Array.from({ length: GLOSSARY_MAX_TERMS }, (_, index) => ({ ori: `AI ${index}`, trans: `${index}`, source: 'ai', createdAt: 10, updatedAt: 10 }));
    store.mangaGlossaries = { book: { displayName: 'book', romanKey: 'book', terms: previous } };
    await saveGlossary('book', { terms: [{ ori: 'AI new', trans: 'new', source: 'ai' }] });
    store.mangaGlossaries.book.terms.unshift(previous[0]);
    const snapshot = await getGlossarySnapshot();
    expect(snapshot.glossaries.book.terms).toHaveLength(GLOSSARY_MAX_TERMS);
    expect(snapshot.glossaries.book.terms.some(term => term.ori === 'AI 0')).toBe(false);
  });

  it('uses a stable tie break and tolerates malformed cloud entries', () => {
    const a = { book: { terms: [{ ori: 'Name', trans: 'Alpha', source: 'user', updatedAt: 100 }] } };
    const b = { book: { terms: [{ ori: 'Name', trans: 'Beta', source: 'user', updatedAt: 100 }] } };
    const forward = mergeGlossaryData(a, b).glossaries.book.terms[0].trans;
    const reverse = mergeGlossaryData(b, a).glossaries.book.terms[0].trans;
    expect(forward).toBe(reverse);
    const firstTitle = mergeGlossaryData({ book: { displayName: 'Alpha', updatedAt: 100 } }, { book: { displayName: 'Beta', updatedAt: 100 } }).glossaries.book.displayName;
    const reverseTitle = mergeGlossaryData({ book: { displayName: 'Beta', updatedAt: 100 } }, { book: { displayName: 'Alpha', updatedAt: 100 } }).glossaries.book.displayName;
    expect(firstTitle).toBe(reverseTitle);
    expect(() => mergeGlossaryData(a, { book: { terms: 'corrupt', termTombstones: [] } })).not.toThrow();
    expect(mergeGlossaryData(a, ['corrupt']).glossaries.book.terms[0].trans).toBe('Alpha');
  });

  it('serializes concurrent saves of separate works', async () => {
    await Promise.all([
      saveGlossary('alpha', { terms: [{ ori: 'A', trans: '一' }] }),
      saveGlossary('beta', { terms: [{ ori: 'B', trans: '二' }] })
    ]);
    expect(Object.keys((await getGlossarySnapshot()).glossaries).sort()).toEqual(['alpha', 'beta']);
  });

  it('replays independent operations from two split background instances', async () => {
    chrome.extension = { inIncognitoContext: true };
    const otherBackground = await import('../src/background/glossary-manager.js?split-context');
    chrome.extension.inIncognitoContext = false;
    await Promise.all([
      upsertGlossaryTerm('book', { ori: 'A', trans: '一' }),
      otherBackground.upsertGlossaryTerm('book', { ori: 'B', trans: '二' })
    ]);
    const operationKeys = Object.keys(store).filter(key => key.startsWith('mangaGlossaryRegister:'));
    expect(operationKeys).toHaveLength(2);
    expect((await getGlossarySnapshot()).glossaries.book.terms.map(term => term.ori).sort()).toEqual(['A', 'B']);
    // Even if the other process later overwrites the materialized snapshot,
    // the two durable operation keys remain the source of truth.
    store.mangaGlossaries = { book: { terms: [{ ori: 'A', trans: '一', source: 'user' }] } };
    expect((await otherBackground.getGlossarySnapshot()).glossaries.book.terms.map(term => term.ori).sort()).toEqual(['A', 'B']);
    await upsertGlossaryTerm('book', { ori: 'A', trans: '更新' });
    expect(Object.keys(store).filter(key => key.startsWith('mangaGlossaryRegister:'))).toHaveLength(2);
  });

  it('propagates storage failure and recovers the queue', async () => {
    failWrite = true;
    await expect(saveGlossary('book', { terms: [] })).rejects.toThrow('storage failed');
    failWrite = false;
    await saveGlossary('book', { terms: [] });
    expect((await getGlossarySnapshot()).glossaries.book).toBeDefined();
  });

  it('merges against an edit made during cloud download', async () => {
    await upsertGlossaryTerm('book', { ori: 'Name', trans: 'Initial' });
    const staleCloud = (await getGlossarySnapshot()).glossaries;
    let releaseDownload;
    const downloadGate = new Promise(resolve => { releaseDownload = resolve; });
    let reachedDownload;
    const downloadStarted = new Promise(resolve => { reachedDownload = resolve; });
    globalThis.fetch = vi.fn(async (url, options = {}) => {
      if (url.includes('spaces=appDataFolder')) return { ok: true, json: async () => ({ files: [{ id: 'file1' }] }) };
      if (url.includes('alt=media')) {
        reachedDownload();
        await downloadGate;
        return { ok: true, json: async () => ({ glossaries: staleCloud }) };
      }
      if (options.method === 'PATCH') return { ok: true, json: async () => ({}) };
      throw new Error(`unexpected request ${url}`);
    });
    const syncing = performBiDirectionalSync('test-token');
    await downloadStarted;
    await upsertGlossaryTerm('book', { ori: 'Name', trans: 'Edited during download' });
    releaseDownload();
    await syncing;
    expect((await getGlossarySnapshot()).glossaries.book.terms[0].trans).toBe('Edited during download');
    const upload = globalThis.fetch.mock.calls.find(([, options]) => options?.method === 'PATCH');
    expect(JSON.parse(upload[1].body).glossaries.book.terms[0].trans).toBe('Edited during download');
  });

  it('runs another sync when the glossary changes during upload', async () => {
    let releaseUpload;
    const uploadGate = new Promise(resolve => { releaseUpload = resolve; });
    let reachedUpload;
    const uploadStarted = new Promise(resolve => { reachedUpload = resolve; });
    let uploads = 0;
    globalThis.fetch = vi.fn(async (url, options = {}) => {
      if (url.includes('spaces=appDataFolder')) return { ok: true, json: async () => ({ files: [{ id: 'file1' }] }) };
      if (url.includes('alt=media')) return { ok: true, json: async () => ({ glossaries: {} }) };
      if (options.method === 'PATCH') {
        uploads++;
        if (uploads === 1) { reachedUpload(); await uploadGate; }
        return { ok: true, json: async () => ({}) };
      }
      throw new Error(`unexpected request ${url}`);
    });
    const syncing = syncEngine.syncNow('test-token');
    await uploadStarted;
    await upsertGlossaryTerm('book', { ori: 'New', trans: '新' });
    syncEngine.triggerSync({ mangaGlossaries: true });
    releaseUpload();
    await syncing;
    expect(uploads).toBe(2);
    const lastUpload = globalThis.fetch.mock.calls.filter(([, options]) => options?.method === 'PATCH').at(-1);
    expect(JSON.parse(lastUpload[1].body).glossaries.book.terms[0].trans).toBe('新');
  });

  it('uses settings and API key edits made during cloud download', async () => {
    Object.assign(store, { requestDelay: 1, settingsLastModified: 100, apiKey: 'OLD', apiKeyLastModified: 100 });
    let releaseDownload;
    const downloadGate = new Promise(resolve => { releaseDownload = resolve; });
    let reachedDownload;
    const downloadStarted = new Promise(resolve => { reachedDownload = resolve; });
    globalThis.fetch = vi.fn(async (url, options = {}) => {
      if (url.includes('spaces=appDataFolder')) return { ok: true, json: async () => ({ files: [{ id: 'file1' }] }) };
      if (url.includes('alt=media')) {
        reachedDownload();
        await downloadGate;
        return { ok: true, json: async () => ({ settings: { requestDelay: 9 }, settingsLastModified: 200, apiKey: 'CLOUD', apiKeyLastModified: 200 }) };
      }
      if (options.method === 'PATCH') return { ok: true, json: async () => ({}) };
      throw new Error(`unexpected request ${url}`);
    });
    const syncing = performBiDirectionalSync('test-token');
    await downloadStarted;
    Object.assign(store, { requestDelay: 2, settingsLastModified: 300, apiKey: 'NEW', apiKeyLastModified: 300 });
    releaseDownload();
    await syncing;
    const upload = globalThis.fetch.mock.calls.find(([, options]) => options?.method === 'PATCH');
    const payload = JSON.parse(upload[1].body);
    expect(store.requestDelay).toBe(2);
    expect(store.apiKey).toBe('NEW');
    expect(payload.settings.requestDelay).toBe(2);
    expect(payload.settingsLastModified).toBe(300);
    expect(payload.apiKey).toBe('NEW');
    expect(payload.apiKeyLastModified).toBe(300);
  });

  it('persists the winning cloud settings timestamp locally', async () => {
    Object.assign(store, { requestDelay: 1, settingsLastModified: 100 });
    globalThis.fetch = vi.fn(async (url, options = {}) => {
      if (url.includes('spaces=appDataFolder')) return { ok: true, json: async () => ({ files: [{ id: 'file1' }] }) };
      if (url.includes('alt=media')) return { ok: true, json: async () => ({ settings: { requestDelay: 9 }, settingsLastModified: 200 }) };
      if (options.method === 'PATCH') return { ok: true, json: async () => ({}) };
      throw new Error(`unexpected request ${url}`);
    });
    await performBiDirectionalSync('test-token');
    expect(store.requestDelay).toBe(9);
    expect(store.settingsLastModified).toBe(200);
  });
});
