#!/usr/bin/env node
// import-osm.mjs — national database builder.
//
// Queries the Overpass API for UK car parks tagged with a known private
// enforcement operator, maps them to the ParkMate schema, merges them with
// the hand-curated seed sites (curated always wins), and rewrites
// src/data/parkingSites.json.
//
// Usage:
//   node scripts/import-osm.mjs            # fetch from Overpass and write
//   node scripts/import-osm.mjs --dry-run  # fetch, print stats, write nothing
//   node scripts/import-osm.mjs --test     # run against a built-in fixture
//
// Data © OpenStreetMap contributors, ODbL — see README attribution note.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITES_PATH = join(ROOT, 'src', 'data', 'parkingSites.json');

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

// operator tag regex → ParkMate operatorId (ids must exist in operators.json)
const OPERATOR_MAP = [
  [/parking\s*eye/i, 'parkingeye'],
  [/euro\s*car\s*parks/i, 'euro-car-parks'],
  [/apcoa/i, 'apcoa'],
  [/smart\s*parking/i, 'smart-parking'],
  [/uk\s*parking\s*control|ukpc/i, 'ukpc'],
  [/horizon\s*parking/i, 'horizon'],
  [/group\s*nexus|cp\s*plus/i, 'groupnexus'],
  [/national\s*parking\s*enforcement/i, 'npe'],
  [/premier\s*park/i, 'premier-park'],
  [/civil\s*enforcement/i, 'civil-enforcement'],
];

// Overpass regexes are POSIX ERE — no \s, so spell the names out literally.
const OVERPASS_OPERATOR_RE = [
  'ParkingEye', 'Parking Eye', 'Euro Car Parks', 'APCOA', 'Smart Parking',
  'UK Parking Control', 'UKPC', 'Horizon Parking', 'GroupNexus', 'CP Plus',
  'National Parking Enforcement', 'Premier Park', 'Civil Enforcement',
].join('|');

const OVERPASS_QUERY = `
[out:json][timeout:180];
area["ISO3166-1"="GB"][admin_level=2]->.uk;
(
  nwr["amenity"="parking"]["operator"~"${OVERPASS_OPERATOR_RE}",i](area.uk);
);
out center tags;
`;

export function parseMaxstay(raw) {
  // OSM maxstay: "2 hours", "90 minutes", "1.5 hours", "2:30", "3 h", "no"
  if (!raw) return null;
  const s = String(raw).trim().toLowerCase();
  if (s === 'no' || s === 'unlimited' || s === 'none') return null;
  let m;
  if ((m = s.match(/^(\d+):(\d{2})$/))) return Number(m[1]) * 60 + Number(m[2]);
  if ((m = s.match(/^([\d.]+)\s*(hours?|hrs?|h)$/))) return Math.round(Number(m[1]) * 60);
  if ((m = s.match(/^([\d.]+)\s*(minutes?|mins?|m)$/))) return Math.round(Number(m[1]));
  if ((m = s.match(/^([\d.]+)$/))) return Math.round(Number(m[1]) * 60); // bare number = hours
  return null;
}

export function mapOperator(tag) {
  if (!tag) return null;
  for (const [re, id] of OPERATOR_MAP) if (re.test(tag)) return id;
  return null;
}

export function elementToSite(el) {
  const tags = el.tags || {};
  const operatorId = mapOperator(tags.operator);
  if (!operatorId) return null;
  const lat = el.lat ?? el.center?.lat;
  const lng = el.lon ?? el.center?.lon;
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;
  // UK bounding sanity check
  if (lat < 49 || lat > 61 || lng < -8.5 || lng > 2) return null;

  const maxStayMinutes = parseMaxstay(tags.maxstay);
  const fee = tags.fee === 'yes';
  const siteType = maxStayMinutes
    ? 'free-max-stay'
    : fee
      ? 'pay-and-display'
      : 'customer-only';

  return {
    id: `osm-${el.type}-${el.id}`,
    name: tags.name || `${tags.operator} car park`,
    town: tags['addr:city'] || tags['addr:town'] || '',
    operatorId,
    lat: Number(lat.toFixed(5)),
    lng: Number(lng.toFixed(5)),
    radiusM: 120,
    siteType,
    maxStayMinutes,
    confidence: 'medium',
    verified: false,
    source: 'osm',
    osmRef: `${el.type}/${el.id}`,
    notes: tags.maxstay ? `OSM maxstay: ${tags.maxstay}` : '',
  };
}

export function haversineM(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(a));
}

/** Merge OSM candidates into the existing database. Curated (non-osm) sites
 *  always win; an OSM site within 150 m of any curated site is dropped as a
 *  duplicate. Previously imported OSM sites are fully replaced by this run. */
export function merge(existing, osmSites) {
  const curated = existing.sites.filter((s) => s.source !== 'osm');
  const fresh = osmSites.filter(
    (o) => !curated.some((c) => haversineM(c.lat, c.lng, o.lat, o.lng) < 150)
  );
  fresh.sort((a, b) => a.id.localeCompare(b.id)); // stable diffs
  return {
    ...existing,
    region: 'United Kingdom (curated + OSM import)',
    effectiveDate: new Date().toISOString().slice(0, 10),
    attribution: 'Contains data © OpenStreetMap contributors (ODbL). Operator attributions and stay terms are unverified — on-site signage is authoritative.',
    sites: [...curated, ...fresh],
    stats: { curated: curated.length, osm: fresh.length, importedAt: new Date().toISOString() },
  };
}

async function fetchOverpass() {
  let lastErr;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'ParkMate-DB-Import/1.0 (+https://github.com/nickbh89/park-mate)',
        },
        body: 'data=' + encodeURIComponent(OVERPASS_QUERY),
      });
      if (!res.ok) throw new Error(`${endpoint} -> HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      console.error(`Overpass endpoint failed: ${e.message}`);
    }
  }
  throw lastErr;
}

const FIXTURE = {
  elements: [
    { type: 'node', id: 1, lat: 53.30, lon: -2.70, tags: { amenity: 'parking', operator: 'ParkingEye Ltd', name: 'Test Retail Park', maxstay: '2 hours', 'addr:city': 'Testville' } },
    { type: 'way', id: 2, center: { lat: 51.50, lon: -0.12 }, tags: { amenity: 'parking', operator: 'Euro Car Parks', fee: 'yes' } },
    { type: 'node', id: 3, lat: 53.2967, lon: -2.7230, tags: { amenity: 'parking', operator: 'ParkingEye' } }, // dup of curated aldi-frodsham
    { type: 'node', id: 4, lat: 48.85, lon: 2.35, tags: { amenity: 'parking', operator: 'APCOA' } }, // Paris — out of UK bounds
    { type: 'node', id: 5, lat: 55.95, lon: -3.19, tags: { amenity: 'parking', operator: 'Unknown Op Ltd' } }, // unmapped operator
    { type: 'node', id: 6, lat: 52.48, lon: -1.89, tags: { amenity: 'parking', operator: 'Smart Parking Ltd', maxstay: '90 minutes' } },
  ],
};

function runTest(existing) {
  const assert = (cond, msg) => { if (!cond) { console.error(`  ✗ ${msg}`); process.exitCode = 1; } else console.log(`  ✓ ${msg}`); };
  assert(parseMaxstay('2 hours') === 120, 'parseMaxstay "2 hours" -> 120');
  assert(parseMaxstay('90 minutes') === 90, 'parseMaxstay "90 minutes" -> 90');
  assert(parseMaxstay('1.5 hours') === 90, 'parseMaxstay "1.5 hours" -> 90');
  assert(parseMaxstay('2:30') === 150, 'parseMaxstay "2:30" -> 150');
  assert(parseMaxstay('no') === null, 'parseMaxstay "no" -> null');
  const sites = FIXTURE.elements.map(elementToSite).filter(Boolean);
  assert(sites.length === 4, `fixture maps 4 valid sites (got ${sites.length}) — Paris + unknown operator dropped`);
  assert(sites[0].siteType === 'free-max-stay' && sites[0].maxStayMinutes === 120, 'maxstay site typed free-max-stay 120');
  assert(sites[1].siteType === 'pay-and-display', 'fee=yes site typed pay-and-display');
  const merged = merge(existing, sites);
  assert(merged.sites.filter((s) => s.source === 'osm').length === 3, 'duplicate near curated Aldi Frodsham dropped in merge');
  assert(merged.sites.length === existing.sites.filter((s) => s.source !== 'osm').length + 3, 'merged count = curated + 3');
  console.log(process.exitCode ? 'TESTS FAILED' : 'All import tests passed');
}

async function main() {
  const existing = JSON.parse(readFileSync(SITES_PATH, 'utf8'));
  const mode = process.argv[2];

  if (mode === '--test') return runTest(existing);

  console.log('Querying Overpass for UK operator-tagged private car parks…');
  const data = await fetchOverpass();
  const osmSites = (data.elements || []).map(elementToSite).filter(Boolean);
  console.log(`Overpass returned ${data.elements?.length ?? 0} elements -> ${osmSites.length} mapped sites`);
  const merged = merge(existing, osmSites);
  console.log(`Merged database: ${merged.stats.curated} curated + ${merged.stats.osm} OSM = ${merged.sites.length} sites`);

  if (mode === '--dry-run') return console.log('Dry run — nothing written.');
  writeFileSync(SITES_PATH, JSON.stringify(merged, null, 2) + '\n');
  console.log(`Wrote ${SITES_PATH}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
