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
    terms.set(key, chooseTerm(terms.get(key), term));
  }
  const deleted = record(tombstones);
  return [...terms.entries()]
    .filter(([key, term]) => !stamp(deleted[key]) || (term.source === 'user' && termTime(term) > stamp(deleted[key])))
    .map(([, term]) => term);
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
