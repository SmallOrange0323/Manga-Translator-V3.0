export const GLOSSARY_STORAGE_KEY = 'mangaGlossaries';
export const GLOSSARY_TOMBSTONES_KEY = 'mangaGlossaryTombstones';

const isRecord = value => value && typeof value === 'object' && !Array.isArray(value);
const record = value => isRecord(value) ? value : {};
export function normalizeGlossaryKey(value) {
  if (typeof value !== 'string') return '';
  return value.toLowerCase().replace(/[\-_:!?'"()（）\[\]【】／/\\.,~～]/g, ' ').replace(/\s+/g, ' ').trim();
}
export function findMatchingGlossaryKey(collection, requestedKey) {
  const keys = Object.keys(record(collection));
  if (keys.includes(requestedKey)) return requestedKey;
  const wanted = normalizeGlossaryKey(requestedKey);
  if (!wanted) return null;
  for (const key of keys) if (normalizeGlossaryKey(key) === wanted) return key;
  for (const key of keys) {
    const candidate = normalizeGlossaryKey(key);
    if (candidate.length >= 8 && wanted.length >= 8 && (candidate.startsWith(wanted) || wanted.startsWith(candidate))) return key;
  }
  return null;
}
export const termKey = term => String(term?.ori || term?.original || '').trim().toLowerCase();

export function normalizeTerm(term = {}, fallbackAt = 0) {
  const ori = String(term?.ori || term?.original || '').trim();
  const trans = String(term?.trans || term?.translation || '').trim();
  const note = String(term?.note || term?.role || '').trim();
  const fallback = Number(fallbackAt) || 0;
  const createdAt = Number(term?.createdAt) || fallback || 0;
  const updatedAt = Number(term?.updatedAt) || createdAt || fallback || 0;
  return {
    ori,
    trans,
    ...(note ? { note } : {}),
    source: term?.source === 'user' ? 'user' : 'ai',
    createdAt,
    updatedAt
  };
}

export function transKey(term) {
  return String(typeof term === 'string' ? term : term?.trans || term?.translation || '').trim().toLowerCase();
}

/**
 * 自動排毒：當多個不同日文原文 (ori) 卻指向同一個非空中文譯名 (trans) 時：
 * - 手動詞條 (source === 'user') 永遠保留，不受限制。
 * - 若該譯名已有手動詞條佔用，或有多筆 AI 詞條撞名，AI 詞條僅在「沒有手動詞條佔用」時保留最早建立 (createdAt 最小) 的第一筆本尊，其餘撞名的 AI 詞條一律剔除。
 * - 若傳入 termTombstones 物件，被剔除的撞名 AI 詞條會自動寫入 tombstone (Math.max(Number(termTombstones[key]) || 0, Number(term.updatedAt) || 0, at))，防止從雲端或舊快照死灰復燃。
 */
export function sanitizeCollidingAiTerms(terms = [], termTombstones = null, at = Date.now()) {
  const normalized = (Array.isArray(terms) ? terms : [])
    .map(t => normalizeTerm(t))
    .filter(t => t.ori && t.trans);

  // 按脫敏譯名分組
  const byTrans = new Map();
  for (const term of normalized) {
    const tk = transKey(term);
    if (!tk) continue;
    if (!byTrans.has(tk)) byTrans.set(tk, []);
    byTrans.get(tk).push(term);
  }

  const evictedOriKeys = new Set();
  for (const [, group] of byTrans.entries()) {
    if (group.length <= 1) continue;
    // 檢查是否包含不同 oriKey
    const uniqueOris = new Set(group.map(t => termKey(t)));
    if (uniqueOris.size <= 1) continue;

    const userTerms = group.filter(t => t.source === 'user');
    const aiTerms = group.filter(t => t.source !== 'user');
    if (aiTerms.length === 0) continue;

    if (userTerms.length > 0) {
      // 已有使用者手動指定該譯名 -> 所有撞名的 AI 詞條皆視為誤配剔除
      for (const bad of aiTerms) {
        const ok = termKey(bad);
        evictedOriKeys.add(ok);
        if (termTombstones && typeof termTombstones === 'object') {
          termTombstones[ok] = Math.max(Number(termTombstones[ok]) || 0, Number(bad.updatedAt) || 0, at);
        }
      }
    } else {
      // 全部都是 AI 詞條撞同一個譯名 -> 按 createdAt 升序（若相同則 updatedAt 升序），只留最早登場的第一筆本尊
      const sortedAi = [...aiTerms].sort((a, b) => (a.createdAt - b.createdAt) || (a.updatedAt - b.updatedAt));
      for (let i = 1; i < sortedAi.length; i++) {
        const bad = sortedAi[i];
        const ok = termKey(bad);
        evictedOriKeys.add(ok);
        if (termTombstones && typeof termTombstones === 'object') {
          termTombstones[ok] = Math.max(Number(termTombstones[ok]) || 0, Number(bad.updatedAt) || 0, at);
        }
      }
    }
  }

  if (evictedOriKeys.size === 0) return normalized;
  return normalized.filter(t => !evictedOriKeys.has(termKey(t)));
}

export function normalizeGlossaryEntry(entry = {}, fallbackKey = '') {
  const raw = isRecord(entry) ? entry : {};
  const key = String(fallbackKey || raw.romanKey || raw.displayName || '').trim();
  const termTombstones = { ...record(raw.termTombstones) };
  const rawTerms = Array.isArray(raw.terms) ? raw.terms : [];
  const filteredTerms = rawTerms
    .map(t => normalizeTerm(t))
    .filter(t => {
      const k = termKey(t);
      if (!k || !t.trans) return false;
      const deleted = stamp(termTombstones[k]);
      return !deleted || (t.source === 'user' && termTime(t) > deleted);
    });
  const sanitizedTerms = sanitizeCollidingAiTerms(filteredTerms, termTombstones);
  return {
    ...raw,
    displayName: raw.displayName || key,
    rawJapanese: raw.rawJapanese || null,
    romanKey: raw.romanKey || key,
    terms: sanitizedTerms,
    termTombstones,
    updatedAt: stamp(raw.updatedAt),
    lastUsed: stamp(raw.lastUsed)
  };
}
const stamp = value => Number(value) || 0;
const termTime = term => Math.max(stamp(term?.updatedAt), stamp(term?.createdAt));
const workTime = work => stamp(work?.updatedAt) || stamp(work?.lastUsed);

function chooseTerm(local, cloud) {
  if (!local) return cloud;
  if (!cloud) return local;
  if (local.source === 'user' && cloud.source !== 'user') return local;
  if (cloud.source === 'user' && local.source !== 'user') return cloud;
  const a = termTime(local);
  const b = termTime(cloud);
  if (a !== b) return a > b ? local : cloud;
  // A fixed tie break converges even when each device considers itself local.
  const content = term => [term?.ori, term?.trans, term?.source, term?.createdAt].map(value => String(value ?? '')).join('\u0000');
  return content(local) >= content(cloud) ? local : cloud;
}

export function mergeTermLists(localTerms = [], cloudTerms = [], tombstones = {}) {
  const terms = new Map();
  for (const term of [...(Array.isArray(localTerms) ? localTerms : []), ...(Array.isArray(cloudTerms) ? cloudTerms : [])]) {
    const key = termKey(term);
    if (!key) continue;
    terms.set(key, chooseTerm(terms.get(key), normalizeTerm(term)));
  }
  const deleted = record(tombstones);
  const remaining = [...terms.entries()]
    .filter(([key, term]) => !stamp(deleted[key]) || (term.source === 'user' && termTime(term) > stamp(deleted[key])))
    .map(([, term]) => term);
  return sanitizeCollidingAiTerms(remaining, tombstones);
}

export function mergeGlossaryData(localGlossaries = {}, cloudGlossaries = {}, localDeletes = {}, cloudDeletes = {}) {
  localGlossaries = record(localGlossaries);
  cloudGlossaries = record(cloudGlossaries);
  const tombstones = { ...record(cloudDeletes) };
  for (const [key, deletedAt] of Object.entries(record(localDeletes))) {
    tombstones[key] = Math.max(stamp(tombstones[key]), stamp(deletedAt));
  }
  const glossaries = {};
  for (const key of new Set([...Object.keys(localGlossaries), ...Object.keys(cloudGlossaries)])) {
    if (!isRecord(localGlossaries[key]) && !isRecord(cloudGlossaries[key])) continue;
    const local = record(localGlossaries[key]);
    const cloud = record(cloudGlossaries[key]);
    const deletionKey = findMatchingGlossaryKey(tombstones, key);
    const deletion = stamp(deletionKey && tombstones[deletionKey]);
    // Automatic extraction can update lastUsed after a deletion. Only an
    // explicit user mutation may recreate a deleted work.
    const validLocal = !deletion || stamp(local.recreatedAt) > deletion;
    const validCloud = !deletion || stamp(cloud.recreatedAt) > deletion;
    if (!validLocal && !validCloud) continue;
    const workSignature = work => [work.displayName, work.rawJapanese, work.romanKey, work.recreatedAt]
      .map(value => String(value ?? '')).join('\u0000');
    const localWins = workTime(local) > workTime(cloud) ||
      (workTime(local) === workTime(cloud) && workSignature(local) >= workSignature(cloud));
    const newer = !validCloud || (validLocal && localWins) ? local : cloud;
    const older = newer === local ? (validCloud ? cloud : {}) : (validLocal ? local : {});
    const termTombstones = { ...record(cloud.termTombstones) };
    for (const [term, deletedAt] of Object.entries(record(local.termTombstones))) {
      termTombstones[term] = Math.max(stamp(termTombstones[term]), stamp(deletedAt));
    }
    const localTerms = validLocal ? local.terms : [];
    const cloudTerms = validCloud ? cloud.terms : [];
    glossaries[key] = {
      ...(older || {}), ...(newer || {}),
      displayName: newer?.displayName || older?.displayName || key,
      rawJapanese: newer?.rawJapanese || older?.rawJapanese || null,
      romanKey: newer?.romanKey || older?.romanKey || key,
      terms: mergeTermLists(localTerms, cloudTerms, termTombstones).filter(term => !deletion || termTime(term) > deletion),
      termTombstones,
      updatedAt: Math.max(validLocal ? workTime(local) : 0, validCloud ? workTime(cloud) : 0),
      lastUsed: Math.max(validLocal ? stamp(local.lastUsed) : 0, validCloud ? stamp(cloud.lastUsed) : 0)
    };
  }
  return { glossaries, tombstones };
}
