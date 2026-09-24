import { log } from '../utils/logger.js';
import { GLOSSARY_STORAGE_KEY, GLOSSARY_TOMBSTONES_KEY, termKey, mergeGlossaryData, normalizeGlossaryKey, findMatchingGlossaryKey } from '../utils/glossary-data.js';

export { GLOSSARY_STORAGE_KEY, GLOSSARY_TOMBSTONES_KEY };
export const GLOSSARY_MAX_TERMS = 500;
export const GLOSSARY_REGISTER_PREFIX = 'mangaGlossaryRegister:';
const writerScope = typeof chrome !== 'undefined' && chrome.extension?.inIncognitoContext ? 'incognito' : 'regular';
const registerKey = key => `${GLOSSARY_REGISTER_PREFIX}${writerScope}:${encodeURIComponent(key)}`;

let pendingWrite = Promise.resolve();
function serialize(work) {
  const result = pendingWrite.then(work);
  pendingWrite = result.catch(() => {});
  return result;
}
const timestamp = value => Number(value) || 0;
const nextTime = (...values) => Math.max(Date.now(), ...values.map(timestamp)) + 1;
const notify = (key, entry) => chrome.runtime?.sendMessage?.({
  action: 'GLOSSARY_UPDATED', payload: { mangaKey: key, termCount: entry?.terms?.length || 0, deleted: !entry }
})?.catch?.(() => {});

export function normalizeMangaKey(str) {
  return normalizeGlossaryKey(str);
}

export function findExistingGlossaryKey(allGlossaries, mangaKey) {
  if (!mangaKey || !allGlossaries) return null;
  if (allGlossaries[mangaKey]) return mangaKey;
  const target = normalizeMangaKey(mangaKey);
  if (!target) return null;
  const keys = Object.keys(allGlossaries);
  for (const key of keys) if (normalizeMangaKey(key) === target) return key;
  for (const key of keys) {
    const norm = normalizeMangaKey(key);
    if (norm.length >= 8 && target.length >= 8 && (norm.startsWith(target) || target.startsWith(norm))) return key;
  }
  return null;
}

export function deduplicateGlossaries(allGlossaries) {
  if (!allGlossaries || typeof allGlossaries !== 'object') return {};
  const result = {};
  const norms = new Map();
  for (const [key, entry] of Object.entries(allGlossaries)) {
    if (!entry) continue;
    const norm = normalizeMangaKey(key);
    if (!norm) continue;
    const canonical = norms.get(norm);
    if (!canonical) {
      norms.set(norm, key);
      result[key] = { ...entry, terms: [...(entry.terms || [])] };
    } else {
      result[canonical] = mergeGlossaryData({ [canonical]: result[canonical] }, { [canonical]: entry }).glossaries[canonical];
    }
  }
  return result;
}

async function readData() {
  const data = await chrome.storage.local.get(null);
  let current = {
    glossaries: data[GLOSSARY_STORAGE_KEY] || {},
    tombstones: data[GLOSSARY_TOMBSTONES_KEY] || {}
  };
  // Split incognito backgrounds share chrome.storage.local but not memory.
  // Each process owns one durable register per work; repeated edits replace
  // that process's register instead of growing an unbounded operation log.
  for (const key of Object.keys(data).filter(key => key.startsWith(GLOSSARY_REGISTER_PREFIX)).sort()) {
    const operation = data[key];
    if (!operation || typeof operation !== 'object') continue;
    current = mergeGlossaryData(current.glossaries, operation.glossaries, current.tombstones, operation.tombstones);
  }
  return current;
}

function buildOperation(before, after) {
  const registers = {};
  const keys = new Set([
    ...Object.keys(before.glossaries), ...Object.keys(after.glossaries),
    ...Object.keys(before.tombstones), ...Object.keys(after.tombstones)
  ]);
  for (const key of keys) {
    if (JSON.stringify(before.glossaries[key]) === JSON.stringify(after.glossaries[key]) &&
        timestamp(before.tombstones[key]) === timestamp(after.tombstones[key])) continue;
    registers[registerKey(key)] = {
      glossaries: after.glossaries[key] ? { [key]: after.glossaries[key] } : {},
      tombstones: after.tombstones[key] ? { [key]: after.tombstones[key] } : {}
    };
  }
  return registers;
}

// All background glossary mutations, including cloud merges, enter this queue.
// The latest storage snapshot is read only after the previous writer commits.
export function updateGlossaryStore(mutator) {
  return serialize(async () => {
    const current = await readData();
    const before = structuredClone(current);
    const result = await mutator(current.glossaries, current.tombstones);
    if (result?.changed) {
      const registers = buildOperation(before, current);
      if (Object.keys(registers).length) await chrome.storage.local.set(registers);
      const latest = await readData();
      await chrome.storage.local.set({
        [GLOSSARY_STORAGE_KEY]: latest.glossaries,
        [GLOSSARY_TOMBSTONES_KEY]: latest.tombstones
      });
      if (result.key !== undefined) notify(result.key, latest.glossaries[result.key]);
    }
    return result;
  });
}

export async function mergeRemoteGlossaries(cloudGlossaries = {}, cloudTombstones = {}) {
  return updateGlossaryStore((glossaries, tombstones) => {
    const merged = mergeGlossaryData(glossaries, cloudGlossaries, tombstones, cloudTombstones);
    const changed = JSON.stringify(glossaries) !== JSON.stringify(merged.glossaries) || JSON.stringify(tombstones) !== JSON.stringify(merged.tombstones);
    for (const key of Object.keys(glossaries)) delete glossaries[key];
    Object.assign(glossaries, merged.glossaries);
    Object.assign(tombstones, merged.tombstones);
    return { changed, key: null, glossaries: merged.glossaries, tombstones: merged.tombstones };
  });
}

export async function getGlossarySnapshot() { return serialize(readData); }

export async function loadGlossary(mangaKey) {
  if (!mangaKey) return null;
  try {
    const { glossaries } = await readData();
    const key = findExistingGlossaryKey(glossaries, mangaKey);
    return key ? glossaries[key] : null;
  } catch (error) {
    log.warn('Glossary', `讀取失敗: ${error.message}`);
    return null;
  }
}

function trimTerms(terms) {
  if (terms.length <= GLOSSARY_MAX_TERMS) return terms;
  const user = terms.filter(term => term.source === 'user');
  const ai = terms.filter(term => term.source !== 'user');
  const remaining = Math.max(0, GLOSSARY_MAX_TERMS - user.length);
  return [...user, ...(remaining ? ai.slice(-remaining) : [])];
}
function trimAndMark(terms, tombstones, at) {
  const kept = trimTerms(terms);
  const keys = new Set(kept.map(termKey));
  for (const term of terms) {
    const key = termKey(term);
    if (key && !keys.has(key)) tombstones[key] = at;
  }
  return kept;
}

// Used by automatic extraction. It adds only previously unseen terms; stale AI
// snapshots cannot overwrite a manual edit or revive a deletion.
export async function saveGlossary(mangaKey, glossaryEntry) {
  if (!mangaKey || !glossaryEntry) throw new Error('缺少必要欄位');
  return updateGlossaryStore((all, deletions) => {
    const key = findExistingGlossaryKey(all, mangaKey) || findMatchingGlossaryKey(deletions, mangaKey) || mangaKey;
    const deletionKey = findMatchingGlossaryKey(deletions, key);
    const deletedAt = timestamp(deletionKey && deletions[deletionKey]);
    if (deletedAt && timestamp(all[key]?.recreatedAt) <= deletedAt) return { changed: false, suppressed: true };
    const old = all[key] || {};
    const termTombstones = { ...(old.termTombstones || {}) };
    const existing = new Map((old.terms || []).map(term => [termKey(term), term]));
    let terms = [...(old.terms || [])];
    let added = false;
    for (const input of glossaryEntry.terms || []) {
      const keyName = termKey(input);
      const trans = String(input?.trans || input?.translation || '').trim();
      if (!keyName || !trans || existing.has(keyName) || termTombstones[keyName]) continue;
      const at = nextTime(old.updatedAt);
      const term = { ...input, ori: String(input.ori || input.original).trim(), trans, source: input.source || 'ai', createdAt: timestamp(input.createdAt) || at, updatedAt: at };
      terms.push(term);
      existing.set(keyName, term);
      added = true;
    }
    if (!added && all[key] && old.displayName && old.romanKey && (old.rawJapanese || !glossaryEntry.rawJapanese)) {
      return { changed: false, key, success: true, termCount: terms.length };
    }
    const at = nextTime(old.updatedAt);
    all[key] = {
      ...old,
      displayName: old.displayName || glossaryEntry.displayName || key,
      rawJapanese: old.rawJapanese || glossaryEntry.rawJapanese || null,
      romanKey: old.romanKey || glossaryEntry.romanKey || key,
      terms: trimAndMark(terms, termTombstones, at), termTombstones,
      updatedAt: added || !all[key] ? at : (old.updatedAt || at),
      lastUsed: at
    };
    return { changed: true, key, success: true, termCount: all[key].terms.length };
  });
}

export function mergeGlossaryTerms(existingTerms, newTerms) {
  const existing = Array.isArray(existingTerms) ? existingTerms : [];
  const seen = new Set(existing.map(termKey));
  const terms = [...existing];
  let addedCount = 0;
  for (const input of newTerms || []) {
    const key = termKey(input);
    const trans = String(input?.trans || input?.translation || '').trim();
    if (!key || !trans || seen.has(key)) continue;
    terms.push({ ...input, ori: String(input.ori || input.original).trim(), trans, source: input.source || 'ai' });
    seen.add(key);
    addedCount++;
  }
  return { terms, addedCount };
}

export async function upsertGlossaryTerm(mangaKey, term, oldOri) {
  if (!mangaKey || !termKey(term) || !String(term?.trans || '').trim()) return { success: false, error: '缺少必要欄位' };
  return updateGlossaryStore((all, deletions) => {
    const key = findExistingGlossaryKey(all, mangaKey) || findMatchingGlossaryKey(deletions, mangaKey) || mangaKey;
    const old = all[key] || {};
    const deletionKey = findMatchingGlossaryKey(deletions, key);
    const at = nextTime(old.updatedAt, deletionKey && deletions[deletionKey]);
    const terms = [...(old.terms || [])];
    const tombstones = { ...(old.termTombstones || {}) };
    const newKey = termKey(term);
    const previousKey = oldOri ? termKey({ ori: oldOri }) : newKey;
    const index = terms.findIndex(item => termKey(item) === previousKey);
    const previous = index >= 0 ? terms[index] : null;
    if (previousKey !== newKey) {
      const other = terms.findIndex(item => termKey(item) === newKey);
      if (other >= 0 && other !== index) return { changed: false, success: false, error: '原文已存在' };
      if (index >= 0) terms.splice(index, 1);
      tombstones[previousKey] = at;
    } else if (index >= 0) terms.splice(index, 1);
    delete tombstones[newKey];
    terms.push({ ...previous, ...term, ori: term.ori.trim(), trans: term.trans.trim(), source: 'user', createdAt: timestamp(previous?.createdAt) || at, updatedAt: at });
    all[key] = { ...old, displayName: old.displayName || key, romanKey: old.romanKey || key, terms: trimAndMark(terms, tombstones, at), termTombstones: tombstones, updatedAt: at, recreatedAt: at, lastUsed: at };
    return { changed: true, key, success: true, termCount: all[key].terms.length };
  });
}

export async function deleteMultipleGlossaryTerms(mangaKey, oriTexts) {
  if (!mangaKey || !Array.isArray(oriTexts) || !oriTexts.length) return { success: false, error: '參數錯誤' };
  return updateGlossaryStore((all) => {
    const key = findExistingGlossaryKey(all, mangaKey);
    if (!key) return { changed: false, success: false, error: '找不到該作品的詞庫' };
    const entry = all[key];
    const keys = new Set(oriTexts.map(ori => termKey({ ori })));
    const terms = (entry.terms || []).filter(term => !keys.has(termKey(term)));
    const deletedCount = (entry.terms || []).length - terms.length;
    if (!deletedCount) return { changed: false, success: false, error: '未找到該詞條' };
    const at = nextTime(entry.updatedAt);
    const termTombstones = { ...(entry.termTombstones || {}) };
    for (const ori of keys) termTombstones[ori] = at;
    all[key] = { ...entry, terms, termTombstones, updatedAt: at, lastUsed: at };
    return { changed: true, key, success: true, deletedCount, termCount: terms.length };
  });
}

export async function deleteGlossaryTerm(mangaKey, oriText) {
  const result = await deleteMultipleGlossaryTerms(mangaKey, [oriText]);
  return result;
}

export async function deleteGlossary(mangaKey) {
  if (!mangaKey) return { success: false, error: '參數錯誤' };
  return updateGlossaryStore((all, deletions) => {
    const key = findExistingGlossaryKey(all, mangaKey);
    if (!key) return { changed: false, success: false, error: '找不到該作品的詞庫' };
    deletions[key] = nextTime(all[key].updatedAt, deletions[key]);
    delete all[key];
    return { changed: true, key, success: true };
  });
}

export async function updateGlossaryDisplayName(mangaKey, newDisplayName) {
  if (!mangaKey || !newDisplayName?.trim()) return { success: false, error: '參數錯誤' };
  return updateGlossaryStore((all) => {
    const key = findExistingGlossaryKey(all, mangaKey);
    if (!key) return { changed: false, success: false, error: '找不到該作品的詞庫' };
    const at = nextTime(all[key].updatedAt);
    all[key] = { ...all[key], displayName: newDisplayName.trim(), updatedAt: at, recreatedAt: at, lastUsed: at };
    return { changed: true, key, success: true };
  });
}

export async function importGlossaryTerms(mangaKey, incoming) {
  if (!mangaKey || !Array.isArray(incoming)) return { success: false, error: '參數錯誤' };
  return updateGlossaryStore((all, deletions) => {
    const key = findExistingGlossaryKey(all, mangaKey) || findMatchingGlossaryKey(deletions, mangaKey) || mangaKey;
    const old = all[key] || {};
    const deletionKey = findMatchingGlossaryKey(deletions, key);
    let at = nextTime(old.updatedAt, deletionKey && deletions[deletionKey]);
    const terms = [...(old.terms || [])];
    const tombstones = { ...(old.termTombstones || {}) };
    let addedCount = 0;
    for (const item of incoming) {
      const ori = String(item?.ori || '').trim();
      const trans = String(item?.trans || '').trim();
      if (!ori || !trans) continue;
      const keyName = termKey({ ori });
      const index = terms.findIndex(term => termKey(term) === keyName);
      const previous = index >= 0 ? terms[index] : null;
      if (previous?.source === 'user') continue;
      at = nextTime(at);
      if (index >= 0) terms.splice(index, 1);
      else addedCount++;
      terms.push({ ...previous, ori, trans, source: 'user', createdAt: timestamp(previous?.createdAt) || at, updatedAt: at });
      delete tombstones[keyName];
    }
    all[key] = { ...old, displayName: old.displayName || key, romanKey: old.romanKey || key, terms: trimAndMark(terms, tombstones, at), termTombstones: tombstones, updatedAt: at, recreatedAt: at, lastUsed: at };
    return { changed: true, key, success: true, addedCount, termCount: all[key].terms.length };
  });
}

export function buildGlossaryPromptSnippet(terms) {
  if (!terms?.length) return '';
  const list = terms.filter(term => term?.ori && term?.trans).map(term => `• 原文: "${term.ori}" ➔ 強制譯名: "${term.trans}"`).join('\n');
  return `\n【最高優先級 - 專屬名詞與人名強制定名表 (CRITICAL GLOSSARY OVERRIDE)】\n遇到以下日文詞彙/人名時，你【必須 100% 強制使用】指定的繁體中文譯名，嚴禁擅自意譯、音譯或替換為其他名稱：\n${list}\n`;
}
