// siteSync — effective-dated site/operator data loading, modelled on
// Toll Mate's policySync.js. Bundled JSON is the baseline; a remote
// manifest can supersede it when its effectiveDate is newer.
import AsyncStorage from '@react-native-async-storage/async-storage';
import bundledSites from '../data/parkingSites.json';
import bundledOperators from '../data/operators.json';

const SITES_KEY = 'parkmate:sites';
const OPS_KEY = 'parkmate:operators';

// Point this at a raw GitHub URL (or your own endpoint) to ship data
// updates without an app release.
export const REMOTE_SITES_URL = null; // e.g. 'https://raw.githubusercontent.com/nickbh89/park-mate/main/src/data/parkingSites.json'

export async function loadSites() {
  const cached = await readJson(SITES_KEY);
  let data = newest(bundledSites, cached);
  if (REMOTE_SITES_URL) {
    try {
      const res = await fetch(REMOTE_SITES_URL);
      if (res.ok) {
        const remote = await res.json();
        if (isNewer(remote, data)) {
          data = remote;
          await AsyncStorage.setItem(SITES_KEY, JSON.stringify(remote));
        }
      }
    } catch {
      // Offline is fine — bundled/cached data stands.
    }
  }
  return decorate(data);
}

export function loadOperators() {
  return bundledOperators;
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

function newest(a, b) {
  if (!b) return a;
  return isNewer(b, a) ? b : a;
}

function isNewer(candidate, current) {
  return (
    candidate?.effectiveDate &&
    (!current?.effectiveDate || candidate.effectiveDate > current.effectiveDate)
  );
}

async function readJson(key) {
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
