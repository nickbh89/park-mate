// siteSync — effective-dated site/operator data loading, modelled on
// Toll Mate's policySync.js. Bundled JSON is the baseline; a newer copy saved
// on the phone or published online supersedes it.
import AsyncStorage from '@react-native-async-storage/async-storage';
import bundledSites from '../data/parkingSites.json';
import bundledOperators from '../data/operators.json';
import { toChunks, fromChunks, isNewer, looksValid } from './siteStore';

const LEGACY_SITES_KEY = 'parkmate:sites'; // single-value cache used up to 0.1.x
const META_KEY = 'parkmate:sites:meta';
const chunkKey = (i) => `parkmate:sites:c${i}`;
const LIMITS_KEY = 'parkmate:userLimits';
const FETCH_TIMEOUT_MS = 25000;

// Point this at a raw GitHub URL (or your own endpoint) to ship data
// updates without an app release.
export const REMOTE_SITES_URL =
  'https://raw.githubusercontent.com/nickbh89/park-mate/main/src/data/parkingSites.json';

/** Fast, offline: the newest of the bundled database and the saved copy. */
export async function loadSites() {
  const cached = await readCache();
  return decorate(isNewer(cached, bundledSites) ? cached : bundledSites);
}

/** Slow, online: fetch the published database. Resolves to the decorated
 *  database if it is newer than `current`, otherwise null. Never throws. */
export async function refreshSites(current) {
  if (!REMOTE_SITES_URL) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(REMOTE_SITES_URL, { signal: ctrl.signal });
    if (!res.ok) return null;
    const remote = await res.json();
    if (!looksValid(remote) || !isNewer(remote, current)) return null;
    writeCache(remote).catch(() => {}); // saving is best-effort; the data is usable now
    return decorate(remote);
  } catch {
    return null; // offline is fine — bundled/saved data stands
  } finally {
    clearTimeout(timer);
  }
}

export function loadOperators() {
  return bundledOperators;
}

async function readCache() {
  try {
    const metaRaw = await AsyncStorage.getItem(META_KEY);
    if (!metaRaw) return null;
    const meta = JSON.parse(metaRaw);
    const pairs = await AsyncStorage.multiGet(Array.from({ length: meta.chunks }, (_, i) => chunkKey(i)));
    return fromChunks(meta, pairs.map(([, v]) => v));
  } catch {
    return null;
  }
}

async function writeCache(db) {
  const { meta, chunks } = toChunks(db);
  let previous = 0;
  try { previous = JSON.parse(await AsyncStorage.getItem(META_KEY))?.chunks || 0; } catch {}
  // Remove the header first so a half-written set is never read as complete.
  await AsyncStorage.multiRemove([META_KEY, LEGACY_SITES_KEY]);
  for (let i = 0; i < chunks.length; i++) await AsyncStorage.setItem(chunkKey(i), chunks[i]);
  if (previous > chunks.length) {
    await AsyncStorage.multiRemove(Array.from({ length: previous - chunks.length }, (_, i) => chunkKey(chunks.length + i)));
  }
  await AsyncStorage.setItem(META_KEY, JSON.stringify(meta));
}

function decorate(data) {
  const ops = new Map(bundledOperators.operators.map((o) => [o.id, o]));
  return {
    ...data,
    sites: data.sites.map((s) => ({
      ...s,
      operatorName: ops.get(s.operatorId)?.name || 'Private operator',
      gracePeriodMinutes: s.gracePeriodMinutes ?? data.defaults?.gracePeriodMinutes ?? 10,
    })),
  };
}

// ---- limits the driver has read off the sign, remembered per site ----------

export async function loadUserLimits() {
  try {
    return JSON.parse(await AsyncStorage.getItem(LIMITS_KEY)) || {};
  } catch {
    return {};
  }
}

export async function saveUserLimits(limits) {
  try { await AsyncStorage.setItem(LIMITS_KEY, JSON.stringify(limits)); } catch {}
}
