#!/usr/bin/env node
// import-osm.mjs — national database builder.
//
// Queries the Overpass API for car parks across the UK (incl. Northern
// Ireland), the Isle of Man and the Channel Islands, in three classes:
//   1. operator-tagged: managed by a known private enforcement operator
//      (also catches council-owned car parks run by NCP/APCOA/Saba/etc.)
//   2. brand-tagged: supermarket / fast-food sites (Aldi, Lidl, McDonald's…)
//      which are routinely ANPR-enforced under national contracts
//   3. maxstay-tagged with no operator: free-max-stay sites, enforcement
//      unverified (low confidence)
// Maps them to the ParkMate schema, merges with the hand-curated seed sites
// (curated always wins), and rewrites src/data/parkingSites.json.
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
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

// Querying one giant UK-wide area from CI runners gets 504/502 (shared IPs,
// heavy query). Tile the coverage into bboxes instead — each tile is a cheap
// query that reliably gets a slot. Tiles cover GB, NI, IoM, Jersey & Guernsey.
// (south, west, north, east)
const TILES = [
  [49.0, -3.0, 50.5, 2.0],   // Channel Islands + south coast
  [50.5, -6.5, 52.0, 2.0],   // SW + southern England
  [52.0, -5.5, 53.5, 2.0],   // Wales + Midlands + East Anglia
  [53.5, -5.2, 55.0, 0.5],   // northern England + Isle of Man
  [54.0, -8.3, 55.5, -5.2],  // Northern Ireland
  [55.0, -6.5, 57.5, -1.0],  // southern/central Scotland
  [57.5, -8.0, 61.0, 0.0],   // northern Scotland + isles
];

// operator tag regex → ParkMate operatorId (ids should exist in operators.json;
// unknown ids fall back to "Private operator" in the app).
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
  // majors that also run council-owned car parks under contract
  [/\bncp\b|national\s*car\s*parks/i, 'ncp'],
  [/q[-\s]?park/i, 'q-park'],
  [/saba\s*park|^saba$/i, 'saba'],
  [/\bindigo\b/i, 'indigo'],
  [/\bnsl\b/i, 'nsl'],
  // other accredited private (PCN-issuing) operators
  [/britannia\s*parking/i, 'britannia'],
  [/excel\s*parking/i, 'excel-parking'],
  [/met\s*parking/i, 'met-parking'],
  [/minster\s*baywatch/i, 'minster-baywatch'],
  [/local\s*parking\s*security/i, 'local-parking-security'],
  [/one\s*parking\s*solution/i, 'one-parking-solution'],
  [/initial\s*parking/i, 'initial-parking'],
  [/carflow/i, 'carflow'],
  [/creative\s*car\s*park/i, 'creative-car-park'],
  [/athena/i, 'athena'],
  [/vehicle\s*control\s*services|\bvcs\b/i, 'vcs'],
  [/parking\s*control\s*management|\bpcm\b/i, 'pcm'],
  [/\bg24\b/i, 'g24'],
  [/district\s*enforcement/i, 'district-enforcement'],
  [/es\s*parking/i, 'es-parking'],
  [/p4\s*parking/i, 'p4-parking'],
  [/park\s*watch|parkwatch/i, 'park-watch'],
  [/highview/i, 'highview'],
  [/gemini\s*parking/i, 'gemini'],
  [/total\s*(car\s*)?parking|total\s*car\s*parks/i, 'total-parking'],
  [/secure\s*parking/i, 'secure-parking'],
  [/flash\s*park/i, 'flashpark'],
  [/spring\s*parking/i, 'spring-parking'],
  [/rcp\s*parking/i, 'rcp-parking'],
  [/select\s*parking/i, 'select-parking'],
  [/new\s*generation\s*parking/i, 'new-generation-parking'],
  [/ukcps|uk\s*car\s*park\s*solutions/i, 'ukcps'],
];

// Brand-tagged car parks (operator = the store, not the enforcement company).
// These sites are routinely ANPR-enforced under national contracts, so they
// are imported as candidates. Where the national contract is well documented
// the operatorId is mapped; otherwise it stays null → "Private operator".
const BRAND_MAP = [
  [/^aldi\b/i, 'parkingeye', 'Aldi store car park — Aldi sites are nationally managed by ParkingEye ANPR'],
  [/^lidl\b/i, 'athena', 'Lidl store car park — Lidl sites are widely managed by Athena ANPR'],
  [/^mcdonald/i, 'met-parking', "McDonald's car park — commonly managed by MET Parking Services ANPR"],
  [/^asda\b/i, null, 'Asda store car park — commonly ANPR-enforced under contract'],
  [/^tesco\b/i, null, 'Tesco store car park — commonly ANPR-enforced under contract'],
  [/^morrisons?\b/i, null, 'Morrisons store car park — commonly ANPR-enforced under contract'],
  [/^sainsbury/i, null, "Sainsbury's store car park — commonly ANPR-enforced under contract"],
  [/^kfc\b/i, null, 'KFC car park — commonly ANPR-enforced under contract'],
  [/^b\s*&\s*m\b|^b&m\b/i, null, 'B&M store car park — commonly ANPR-enforced under contract'],
  [/^home\s*bargains/i, null, 'Home Bargains car park — commonly ANPR-enforced under contract'],
  [/^iceland\b/i, null, 'Iceland store car park — commonly ANPR-enforced under contract'],
  [/^matalan\b/i, null, 'Matalan store car park — commonly ANPR-enforced under contract'],
];

// Overpass regexes are POSIX ERE — no \s or \b, so spell names literally.
const OVERPASS_OPERATOR_RE = [
  'ParkingEye', 'Parking Eye', 'Euro Car Parks', 'APCOA', 'Smart Parking',
  'UK Parking Control', 'UKPC', 'Horizon Parking', 'GroupNexus', 'CP Plus',
  'National Parking Enforcement', 'Premier Park', 'Civil Enforcement',
  'NCP', 'National Car Parks', 'Q-Park', 'Q Park', 'Saba', 'Indigo', 'NSL',
  'Britannia Parking', 'Excel Parking', 'MET Parking', 'Minster Baywatch',
  'Local Parking Security', 'One Parking Solution', 'Initial Parking',
  'Carflow', 'Creative Car Park', 'Athena', 'Vehicle Control Services',
  'Parking Control Management', 'G24', 'District Enforcement', 'ES Parking',
  'P4 Parking', 'Park Watch', 'Parkwatch', 'Highview', 'Gemini Parking',
  'Total Parking', 'Total Car Parks', 'Secure Parking', 'FlashPark',
  'Flash Park', 'Spring Parking', 'RCP Parking', 'Select Parking',
  'New Generation Parking', 'UKCPS', 'UK Car Park Solutions',
  'Aldi', 'Lidl', "McDonald's", 'McDonalds', 'Asda', 'Tesco', 'Morrisons',
  "Sainsbury's", 'Sainsburys', 'KFC', 'B&M', 'Home Bargains', 'Iceland',
  'Matalan',
].join('|');

const tileQueryOperators = ([s, w, n, e]) => `
[out:json][timeout:120];
nwr["amenity"="parking"]["operator"~"${OVERPASS_OPERATOR_RE}",i](${s},${w},${n},${e});
out center tags;
`;

const tileQueryMaxstay = ([s, w, n, e]) => `
[out:json][timeout:120];
nwr["amenity"="parking"]["maxstay"][!"operator"](${s},${w},${n},${e});
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

export function mapBrand(tag) {
  if (!tag) return null;
  for (const [re, id, note] of BRAND_MAP) if (re.test(tag)) return { operatorId: id, note };
  return null;
}

// bounds covering GB, NI, IoM and the Channel Islands
function inBounds(lat, lng) {
  return lat >= 49 && lat <= 61 && lng >= -8.5 && lng <= 2;
}

export function elementToSite(el, klass = 'operator') {
  const tags = el.tags || {};
  const lat = el.lat ?? el.center?.lat;
  const lng = el.lon ?? el.center?.lon;
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;
  if (!inBounds(lat, lng)) return null;

  const maxStayMinutes = parseMaxstay(tags.maxstay);
  const fee = tags.fee === 'yes';

  let operatorId = null;
  let confidence = 'medium';
  let notes = tags.maxstay ? `OSM maxstay: ${tags.maxstay}` : '';

  if (klass === 'maxstay') {
    // free-max-stay site with no operator tag — enforcement unverified
    if (!maxStayMinutes) return null;
    confidence = 'low';
    notes = `OSM maxstay: ${tags.maxstay} — operator untagged, enforcement unverified`;
  } else {
    operatorId = mapOperator(tags.operator);
    if (!operatorId) {
      const brand = mapBrand(tags.operator);
      if (!brand) return null;
      operatorId = brand.operatorId; // may be null → "Private operator"
      confidence = brand.operatorId ? 'medium' : 'low';
      notes = [brand.note, tags.maxstay ? `OSM maxstay: ${tags.maxstay}` : ''].filter(Boolean).join(' · ');
    }
  }

  const siteType = maxStayMinutes ? 'free-max-stay' : fee ? 'pay-and-display' : 'customer-only';

  return {
    id: `osm-${el.type}-${el.id}`,
    name: tags.name || `${tags.operator || 'Private'} car park`,
    town: tags['addr:city'] || tags['addr:town'] || '',
    operatorId,
    lat: Number(lat.toFixed(5)),
    lng: Number(lng.toFixed(5)),
    radiusM: 120,
    siteType,
    maxStayMinutes,
    confidence,
    verified: false,
    source: 'osm',
    osmRef: `${el.type}/${el.id}`,
    notes,
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
  const seen = new Set();
  const fresh = osmSites.filter((o) => {
    if (seen.has(o.id)) return false; // element matched by both queries
    seen.add(o.id);
    return !curated.some((c) => haversineM(c.lat, c.lng, o.lat, o.lng) < 150);
  });
  fresh.sort((a, b) => a.id.localeCompare(b.id)); // stable diffs
  return {
    ...existing,
    region: 'United Kingdom, Isle of Man & Channel Islands (curated + OSM import)',
    effectiveDate: new Date().toISOString().slice(0, 10),
    attribution: 'Contains data © OpenStreetMap contributors (ODbL). Operator attributions and stay terms are unverified — on-site signage is authoritative.',
    sites: [...curated, ...fresh],
    stats: { curated: curated.length, osm: fresh.length, importedAt: new Date().toISOString() },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchOverpass(query, { attempts = 6 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    const endpoint = OVERPASS_ENDPOINTS[i % OVERPASS_ENDPOINTS.length];
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'ParkMate-DB-Import/1.2 (+https://github.com/nickbh89/park-mate)',
        },
        body: 'data=' + encodeURIComponent(query),
      });
      if (!res.ok) throw new Error(`${endpoint} -> HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      const wait = Math.min(15000 * (i + 1), 60000);
      console.error(`  Overpass attempt ${i + 1}/${attempts} failed: ${e.message} — waiting ${wait / 1000}s`);
      if (i < attempts - 1) await sleep(wait);
    }
  }
  throw lastErr;
}

/** Fetch every tile for a query builder, politely (pause between tiles). */
async function fetchTiles(buildQuery, label) {
  const elements = [];
  for (const [idx, tile] of TILES.entries()) {
    console.log(`  ${label}: tile ${idx + 1}/${TILES.length} [${tile.join(', ')}]`);
    const data = await fetchOverpass(buildQuery(tile));
    elements.push(...(data.elements || []));
    if (idx < TILES.length - 1) await sleep(8000);
  }
  return elements;
}

const FIXTURE = {
  elements: [
    { type: 'node', id: 1, lat: 53.30, lon: -2.70, tags: { amenity: 'parking', operator: 'ParkingEye Ltd', name: 'Test Retail Park', maxstay: '2 hours', 'addr:city': 'Testville' } },
    { type: 'way', id: 2, center: { lat: 51.50, lon: -0.12 }, tags: { amenity: 'parking', operator: 'Euro Car Parks', fee: 'yes' } },
    { type: 'node', id: 3, lat: 53.2967, lon: -2.7230, tags: { amenity: 'parking', operator: 'ParkingEye' } }, // dup of curated aldi-frodsham
    { type: 'node', id: 4, lat: 48.85, lon: 2.35, tags: { amenity: 'parking', operator: 'APCOA' } }, // Paris — out of bounds
    { type: 'node', id: 5, lat: 55.95, lon: -3.19, tags: { amenity: 'parking', operator: 'Unknown Op Ltd' } }, // unmapped operator
    { type: 'node', id: 6, lat: 52.48, lon: -1.89, tags: { amenity: 'parking', operator: 'Smart Parking Ltd', maxstay: '90 minutes' } },
    { type: 'node', id: 7, lat: 53.40, lon: -2.99, tags: { amenity: 'parking', operator: 'NCP', fee: 'yes', name: 'NCP Liverpool' } }, // newly mapped major
    { type: 'node', id: 8, lat: 53.41, lon: -2.98, tags: { amenity: 'parking', operator: 'Aldi', name: 'Aldi Anfield' } }, // brand → parkingeye
    { type: 'node', id: 9, lat: 54.15, lon: -4.48, tags: { amenity: 'parking', operator: 'Tesco', name: 'Tesco Douglas' } }, // brand, IoM, no national contract → null operator
  ],
  maxstayElements: [
    { type: 'way', id: 10, center: { lat: 53.294, lon: -2.724 }, tags: { amenity: 'parking', maxstay: '2 hours', name: 'Precinct Car Park' } },
    { type: 'way', id: 11, center: { lat: 51.45, lon: -2.59 }, tags: { amenity: 'parking', maxstay: 'no' } }, // maxstay=no dropped
  ],
};

function runTest(existing) {
  const assert = (cond, msg) => { if (!cond) { console.error(`  ✗ ${msg}`); process.exitCode = 1; } else console.log(`  ✓ ${msg}`); };
  assert(parseMaxstay('2 hours') === 120, 'parseMaxstay "2 hours" -> 120');
  assert(parseMaxstay('90 minutes') === 90, 'parseMaxstay "90 minutes" -> 90');
  assert(parseMaxstay('1.5 hours') === 90, 'parseMaxstay "1.5 hours" -> 90');
  assert(parseMaxstay('2:30') === 150, 'parseMaxstay "2:30" -> 150');
  assert(parseMaxstay('no') === null, 'parseMaxstay "no" -> null');
  const sites = FIXTURE.elements.map((e) => elementToSite(e, 'operator')).filter(Boolean);
  assert(sites.length === 7, `fixture maps 7 valid operator/brand sites (got ${sites.length})`);
  assert(sites.find((s) => s.id === 'osm-node-7')?.operatorId === 'ncp', 'NCP mapped');
  assert(sites.find((s) => s.id === 'osm-node-8')?.operatorId === 'parkingeye', 'Aldi brand → parkingeye');
  const tesco = sites.find((s) => s.id === 'osm-node-9');
  assert(tesco && tesco.operatorId === null && tesco.confidence === 'low', 'Tesco brand → null operator, low confidence');
  const ms = FIXTURE.maxstayElements.map((e) => elementToSite(e, 'maxstay')).filter(Boolean);
  assert(ms.length === 1 && ms[0].confidence === 'low' && ms[0].siteType === 'free-max-stay', 'maxstay class: 1 site, low confidence, free-max-stay');
  const merged = merge(existing, [...sites, ...ms]);
  assert(merged.sites.filter((s) => s.source === 'osm').length >= 6, 'merge keeps new osm sites, drops curated-adjacent dup');
  console.log(process.exitCode ? 'TESTS FAILED' : 'All import tests passed');
}

async function main() {
  const existing = JSON.parse(readFileSync(SITES_PATH, 'utf8'));
  const mode = process.argv[2];

  if (mode === '--test') return runTest(existing);

  console.log('Querying Overpass: operator/brand-tagged car parks (tiled, GB+NI+IoM+CI)…');
  const opElements = await fetchTiles(tileQueryOperators, 'operators');
  const opSites = opElements.map((e) => elementToSite(e, 'operator')).filter(Boolean);
  console.log(`  ${opElements.length} elements -> ${opSites.length} mapped sites`);

  console.log('Querying Overpass: maxstay-tagged car parks with no operator (tiled)…');
  let msSites = [];
  try {
    const msElements = await fetchTiles(tileQueryMaxstay, 'maxstay');
    msSites = msElements.map((e) => elementToSite(e, 'maxstay')).filter(Boolean);
    console.log(`  ${msElements.length} elements -> ${msSites.length} mapped sites`);
  } catch (e) {
    console.error(`  maxstay query failed (${e.message}) — continuing with operator sites only`);
  }

  const merged = merge(existing, [...opSites, ...msSites]);
  console.log(`Merged database: ${merged.stats.curated} curated + ${merged.stats.osm} OSM = ${merged.sites.length} sites`);

  if (mode === '--dry-run') return console.log('Dry run — nothing written.');
  writeFileSync(SITES_PATH, JSON.stringify(merged, null, 2) + '\n');
  console.log(`Wrote ${SITES_PATH}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
