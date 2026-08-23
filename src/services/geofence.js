// Geofence detection — pure logic, unit-testable in Node.
// Mirrors Toll Mate's haversine + hysteresis approach.

const EARTH_RADIUS_M = 6371000;

export function haversineM(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

// Hysteresis: exit only counts when the fix is beyond radius * EXIT_FACTOR,
// so GPS jitter at the boundary doesn't produce phantom exits/re-entries.
export const EXIT_FACTOR = 1.5;

// Consecutive-fix confirmation: require N fixes inside before declaring entry
// (avoids drive-past false positives on roads skirting a car park).
export const ENTRY_CONFIRM_FIXES = 2;

export function classifyFix(site, lat, lng) {
  const d = haversineM(site.lat, site.lng, lat, lng);
  if (d <= (site.radiusM || 120)) return 'inside';
  if (d <= (site.radiusM || 120) * EXIT_FACTOR) return 'boundary';
  return 'outside';
}

/**
 * Stateful detector. Feed GPS fixes; emits events:
 *   { type: 'enter', site, at }   — confirmed entry
 *   { type: 'exit',  site, at }   — confirmed exit
 */
export function createDetector(sites) {
  const state = new Map(); // siteId -> { insideCount, active }
  return {
    update(lat, lng, at = Date.now()) {
      const events = [];
      for (const site of sites) {
        if (site.enabled === false) continue;
        const s = state.get(site.id) || { insideCount: 0, active: false };
        const zone = classifyFix(site, lat, lng);
        if (zone === 'inside') {
          s.insideCount += 1;
          if (!s.active && s.insideCount >= ENTRY_CONFIRM_FIXES) {
            s.active = true;
            events.push({ type: 'enter', site, at });
          }
        } else if (zone === 'outside') {
          if (s.active) events.push({ type: 'exit', site, at });
          s.active = false;
          s.insideCount = 0;
        }
        // 'boundary': hold current state — hysteresis band.
        state.set(site.id, s);
      }
      return events;
    },
    isActive(siteId) {
      return state.get(siteId)?.active === true;
    },
  };
}
