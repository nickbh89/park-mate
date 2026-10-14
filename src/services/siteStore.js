// Pure helpers for storing the site database on the phone in pieces.
// Android's AsyncStorage cannot read back a single value much over 2 MB, and
// the national database is larger than that, so it is saved as a small header
// plus fixed-size chunks of sites.

export const CHUNK_SIZE = 1500;

/** Split a database into { meta, chunks } where every chunk is a JSON string. */
export function toChunks(db, chunkSize = CHUNK_SIZE) {
  const { sites = [], ...head } = db;
  const chunks = [];
  for (let i = 0; i < sites.length; i += chunkSize) {
    chunks.push(JSON.stringify(sites.slice(i, i + chunkSize)));
  }
  return { meta: { head, count: sites.length, chunks: chunks.length }, chunks };
}

/** Rebuild a database from a meta object and its chunk strings. Returns null
 *  if anything is missing or damaged, so the caller falls back cleanly. */
export function fromChunks(meta, chunkStrings) {
  if (!meta || !Array.isArray(chunkStrings) || chunkStrings.length !== meta.chunks) return null;
  const sites = [];
  for (const str of chunkStrings) {
    if (typeof str !== 'string') return null;
    let part;
    try { part = JSON.parse(str); } catch { return null; }
    if (!Array.isArray(part)) return null;
    for (const s of part) sites.push(s);
  }
  if (sites.length !== meta.count) return null;
  return { ...meta.head, sites };
}

export function isNewer(candidate, current) {
  return Boolean(
    candidate?.effectiveDate &&
    (!current?.effectiveDate || candidate.effectiveDate > current.effectiveDate)
  );
}

/** A downloaded database is only accepted if it looks like one. */
export function looksValid(db) {
  return Boolean(db && typeof db.effectiveDate === 'string' && Array.isArray(db.sites) && db.sites.length > 0
    && typeof db.sites[0].lat === 'number' && typeof db.sites[0].lng === 'number');
}
