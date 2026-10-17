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
//   4. adjacent: untagged car parks sitting next to a place that is routinely
//      enforced (chain stores, retail parks, hospitals, stations, services).
//      Likely enforced, never confirmed — low confidence, no time limit.
// Maps them to the ParkMate schema, merges with the hand-curated seed sites
// (curated always wins), and rewrites src/data/parkingSites.json.
//
// Each run works through the stalest areas first and stops when its time budget
// (IMPORT_BUDGET_MINUTES, default 150) is spent; areas it did not reach keep
// the sites they already had and go to the front of the queue next run.
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

// The tiles are rectangles, so they also cover northern France and part of the
// Republic of Ireland. Every query keeps only car parks inside these areas.
const UK_AREA = 'area["ISO3166-1"~"^(GB|IM|JE|GG)$"]["admin_level"="2"]->.uk;';

const tileQueryOperators = ([s, w, n, e]) => `
[out:json][timeout:120];
${UK_AREA}
nwr["amenity"="parking"]["operator"~"${OVERPASS_OPERATOR_RE}",i](${s},${w},${n},${e})(area.uk);
out center tags;
`;

const tileQueryMaxstay = ([s, w, n, e]) => `
[out:json][timeout:120];
${UK_AREA}
nwr["amenity"="parking"]["maxstay"][!"operator"](${s},${w},${n},${e})(area.uk);
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

// Bounds covering GB, NI, IoM and the Channel Islands, minus the parts of that
// rectangle that are France: Normandy (east of the Channel Islands and south of
// the English coast) and the Calais/Boulogne coast (east of Dover). The queries
// filter by country too; this is a second check that needs no network.
export function inBounds(lat, lng) {
  if (!(lat >= 49 && lat <= 61 && lng >= -8.5 && lng <= 2)) return false;
  if (lat < 49.9 && lng > -1.98) return false;
  if (lat < 50.5 && lng > -1.9) return false;
  if (lat < 51.2 && lng > 1.45) return false;
  return true;
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
// Chains whose car parks are routinely run by a private enforcement operator.
// POSIX ERE, matched against the brand tag.
const ANCHOR_BRAND_RE = [
  'Aldi', 'Lidl', 'Tesco', 'Asda', 'Morrisons', 'Sainsbury', 'Waitrose', 'Co-op', 'Iceland',
  'Farmfoods', 'Booths', 'Marks & Spencer', 'M&S', 'Home Bargains', 'B&M', 'The Range',
  'Matalan', 'Dunelm', 'B&Q', 'Wickes', 'Homebase', 'Halfords', 'Currys', 'Pets at Home',
  'Costco', 'IKEA', 'Next', 'TK Maxx', 'Smyths', 'Poundland', 'Wilko', 'Argos', 'Decathlon',
  'Hobbycraft', 'Sports Direct', 'JD Sports', 'Boots', 'Carpetright', 'DFS', 'Dreams',
  "McDonald's", 'KFC', 'Burger King', 'Costa', 'Starbucks', 'Greggs', 'Subway', "Nando's",
  'Pizza Hut', 'Taco Bell', "Wendy's", 'Popeyes', 'Tim Hortons', 'Five Guys',
  'PureGym', 'The Gym', 'JD Gyms', 'Nuffield Health', 'David Lloyd', 'Bannatyne', 'Anytime Fitness',
  'Odeon', 'Cineworld', 'Vue', 'Showcase', 'Premier Inn', 'Travelodge',
].join('|');

// Step 1 collects the anchors, step 2 the car parks within 60 m of any anchor.
// Both sets come back so each car park can be named after its nearest anchor.
const tileQueryAdjacent = ([s, w, n, e]) => `
[out:json][timeout:170];
${UK_AREA}
(
  nwr["brand"~"${ANCHOR_BRAND_RE}",i]["shop"](${s},${w},${n},${e});
  nwr["brand"~"${ANCHOR_BRAND_RE}",i]["amenity"~"^(fast_food|restaurant|cafe|cinema)$"](${s},${w},${n},${e});
  nwr["brand"~"${ANCHOR_BRAND_RE}",i]["leisure"="fitness_centre"](${s},${w},${n},${e});
  nwr["brand"~"${ANCHOR_BRAND_RE}",i]["tourism"="hotel"](${s},${w},${n},${e});
  nwr["landuse"="retail"]["name"](${s},${w},${n},${e});
  nwr["shop"="mall"](${s},${w},${n},${e});
  nwr["amenity"="hospital"](${s},${w},${n},${e});
  nwr["railway"="station"]["station"!~"subway|light_rail"](${s},${w},${n},${e});
  nwr["highway"="services"](${s},${w},${n},${e});
)->.anchors;
.anchors out center tags;
nwr["amenity"="parking"](around.anchors:60)(${s},${w},${n},${e})(area.uk);
out center tags;
`;

/** What kind of place an anchor is, for the site note. */
export function anchorKind(tags = {}) {
  if (tags.amenity === 'hospital') return 'hospital';
  if (tags.railway === 'station') return 'railway station';
  if (tags.highway === 'services') return 'motorway services';
  if (tags.landuse === 'retail' || tags.shop === 'mall') return 'retail park';
  if (tags.leisure === 'fitness_centre') return 'gym';
  if (tags.tourism === 'hotel') return 'hotel';
  if (tags.amenity === 'cinema') return 'cinema';
  if (tags.amenity) return 'restaurant';
  return 'store';
}

const NOT_PUBLIC_ACCESS = /^(private|no|permit|residents|staff|employees|delivery)$/;
const NOT_A_CAR_PARK = /^(street_side|lane|on_street|on_kerb|half_on_kerb|shoulder)$/;
const COUNCIL_OPERATOR = /council|borough|city of|county|district|transport for|network rail|nhs/i;
const ADJACENT_NOTE = 'likely enforced, check signage';
// Small-format and high-street outlets: the nearest car park is as likely to be
// a council one, so these only count when the car park is tagged for customers.
const SMALL_FORMAT = /subway|greggs|costa|starbucks|boots|poundland|argos|jd sports|sports direct|nando|pizza hut|five guys|hobbycraft|next|carpetright|dreams|express|local|metro|little waitrose|simply food|one stop|daily/i;
const isStrongAnchor = (t) => t.amenity === 'hospital' || t.railway === 'station' || t.highway === 'services' || t.landuse === 'retail' || t.shop === 'mall';

/** Turn the mixed anchor + car park result of tileQueryAdjacent into sites.
 *  Each car park is attributed to its nearest anchor (centre to centre, up to
 *  400 m because retail parks and hospitals are large). */
export function adjacentSites(elements) {
  const centre = (el) => ({ lat: el.lat ?? el.center?.lat, lng: el.lon ?? el.center?.lon });
  const anchors = [];
  const parks = [];
  for (const el of elements) {
    const { lat, lng } = centre(el);
    if (typeof lat !== 'number' || typeof lng !== 'number') continue;
    if (el.tags?.amenity === 'parking') parks.push({ el, lat, lng });
    else if (el.tags && (el.tags.name || el.tags.brand)) anchors.push({ tags: el.tags, lat, lng });
  }
  const out = [];
  for (const { el, lat, lng } of parks) {
    const tags = el.tags;
    if (!inBounds(lat, lng)) continue;
    if (tags.access && NOT_PUBLIC_ACCESS.test(tags.access)) continue;
    if (tags.parking && NOT_A_CAR_PARK.test(tags.parking)) continue;
    if (tags.operator && COUNCIL_OPERATOR.test(tags.operator) && !mapOperator(tags.operator)) continue;
    let best = null;
    let bestD = 400;
    const forCustomers = tags.access === 'customers';
    for (const a of anchors) {
      if (!forCustomers && !isStrongAnchor(a.tags) && SMALL_FORMAT.test(`${a.tags.brand || ''} ${a.tags.name || ''}`)) continue;
      if (Math.abs(a.lat - lat) > 0.004 || Math.abs(a.lng - lng) > 0.007) continue; // cheap reject
      const d = haversineM(lat, lng, a.lat, a.lng);
      if (d < bestD) { best = a; bestD = d; }
    }
    if (!best) continue;
    const label = best.tags.name || best.tags.brand;
    const brand = mapBrand(best.tags.brand || best.tags.name);
    const maxStayMinutes = parseMaxstay(tags.maxstay);
    out.push({
      id: `osm-${el.type}-${el.id}`,
      name: tags.name || `${label} car park`,
      town: tags['addr:city'] || tags['addr:town'] || best.tags['addr:city'] || best.tags['addr:town'] || '',
      operatorId: mapOperator(tags.operator) || brand?.operatorId || null,
      lat: Number(lat.toFixed(5)),
      lng: Number(lng.toFixed(5)),
      radiusM: 100,
      siteType: maxStayMinutes ? 'free-max-stay' : tags.fee === 'yes' ? 'pay-and-display' : 'customer-only',
      maxStayMinutes,
      confidence: 'low',
      verified: false,
      source: 'osm',
      osmRef: `${el.type}/${el.id}`,
      notes: `Next to ${label} (${anchorKind(best.tags)}) — ${ADJACENT_NOTE}`,
    });
  }
  return out;
}

/** Drop adjacent candidates that sit within minGapM of a site already kept
 *  (a confirmed site, or an earlier candidate). Big stores are often mapped as
 *  several parking polygons; without this each would fire its own alert. */
export function thinAdjacent(candidates, kept, minGapM = 150) {
  const cell = 0.003; // ~330 m of latitude; neighbours cover the gap
  const grid = new Map();
  const key = (lat, lng) => `${Math.floor(lat / cell)}:${Math.floor(lng / cell)}`;
  const add = (s) => { const k = key(s.lat, s.lng); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(s); };
  kept.forEach(add);
  const out = [];
  for (const c of [...candidates].sort((a, b) => a.id.localeCompare(b.id))) {
    const gy = Math.floor(c.lat / cell);
    const gx = Math.floor(c.lng / cell);
    let clash = false;
    for (let dy = -1; dy <= 1 && !clash; dy++) {
      for (let dx = -2; dx <= 2 && !clash; dx++) {
        for (const s of grid.get(`${gy + dy}:${gx + dx}`) || []) {
          if (s.id !== c.id && haversineM(c.lat, c.lng, s.lat, s.lng) < minGapM) { clash = true; break; }
        }
      }
    }
    if (clash) continue;
    add(c);
    out.push(c);
  }
  return out;
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
    if (!inBounds(o.lat, o.lng)) return false; // sites imported before the country filter existed
    return !curated.some((c) => haversineM(c.lat, c.lng, o.lat, o.lng) < 150);
  });
  fresh.sort((a, b) => a.id.localeCompare(b.id)); // stable diffs
  return {
    ...existing,
    region: 'United Kingdom, Isle of Man & Channel Islands (curated + OSM import)',
    // Full timestamp, so a second update on the same day still counts as newer.
    effectiveDate: new Date().toISOString().slice(0, 16),
    attribution: 'Contains data © OpenStreetMap contributors (ODbL). Operator attributions and stay terms are unverified — on-site signage is authoritative.',
    sites: [...curated, ...fresh],
    stats: { curated: curated.length, osm: fresh.length, importedAt: new Date().toISOString() },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FETCH_TIMEOUT_MS = 180000;

async function fetchOverpass(query, { attempts = 6, fetchImpl = fetch, sleepImpl = sleep } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    const endpoint = OVERPASS_ENDPOINTS[i % OVERPASS_ENDPOINTS.length];
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'ParkMate-DB-Import/1.3 (+https://github.com/nickbh89/park-mate)',
        },
        body: 'data=' + encodeURIComponent(query),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`${endpoint} -> HTTP ${res.status}`);
      const data = await res.json();
      // Overpass answers HTTP 200 with a `remark` and partial data when a query
      // times out or runs out of memory. Treat that as a failure, not a result.
      if (data.remark && /error|timed out|out of memory/i.test(data.remark)) {
        throw new Error(`${endpoint} -> incomplete result (${String(data.remark).slice(0, 80)})`);
      }
      return data;
    } catch (e) {
      lastErr = e;
      const wait = Math.min(15000 * (i + 1), 60000);
      console.error(`  Overpass attempt ${i + 1}/${attempts} failed: ${e.message} — waiting ${wait / 1000}s`);
      if (i < attempts - 1) await sleepImpl(wait);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

/** Split a (south, west, north, east) box into four quadrants. */
export function splitTile([s, w, n, e]) {
  const mLat = (s + n) / 2;
  const mLng = (w + e) / 2;
  return [
    [s, w, mLat, mLng], [s, mLng, mLat, e],
    [mLat, w, n, mLng], [mLat, mLng, n, e],
  ];
}

/** Fetch one tile. A 504 usually means the query was too heavy for a busy
 *  server, so when every attempt fails the tile is split into quadrants and
 *  each quadrant is tried on its own. Boxes
 *  that still fail are returned in `failed` instead of aborting the run. */
const MAX_SPLIT_DEPTH = 3; // dense boxes (London, Edinburgh, Manchester) need 64ths of a quarter
// Overall time budget for network work. Once it is spent, remaining boxes are
// skipped (and their existing sites kept) so a bad day cannot run for hours.
const RUN_BUDGET_MS = (Number(process.env.IMPORT_BUDGET_MINUTES) || 150) * 60 * 1000;
const runStarted = Date.now();
const budgetSpent = () => Date.now() - runStarted > RUN_BUDGET_MS;
export async function fetchTile(buildQuery, tile, opts = {}, depth = 0) {
  const sleepImpl = opts.sleepImpl || sleep;
  if (budgetSpent()) {
    console.error(`  time budget spent — skipping box [${tile.join(', ')}]`);
    return { elements: [], failed: [tile] };
  }
  try {
    const data = await fetchOverpass(buildQuery(tile), { ...opts, attempts: depth === 0 ? 4 : 2 });
    return { elements: data.elements || [], failed: [] };
  } catch (e) {
    if (depth >= MAX_SPLIT_DEPTH) {
      console.error(`  giving up on box [${tile.join(', ')}]: ${e.message}`);
      return { elements: [], failed: [tile] };
    }
    console.error(`  box [${tile.join(', ')}] failed — splitting into quadrants`);
    const out = { elements: [], failed: [] };
    for (const quad of splitTile(tile)) {
      const r = await fetchTile(buildQuery, quad, opts, depth + 1);
      out.elements.push(...r.elements);
      out.failed.push(...r.failed);
      await sleepImpl(5000);
    }
    return out;
  }
}

/** Fetch every tile for a query builder, politely (pause between tiles).
 *  Returns the elements plus the list of boxes that could not be fetched. */
async function fetchTiles(buildQuery, label, tiles = TILES) {
  const elements = [];
  const failed = [];
  for (const [idx, tile] of tiles.entries()) {
    console.log(`  ${label}: tile ${idx + 1}/${tiles.length} [${tile.join(', ')}]`);
    const r = await fetchTile(buildQuery, tile);
    elements.push(...r.elements);
    failed.push(...r.failed);
    if (idx < tiles.length - 1) await sleep(8000);
  }
  return { elements, failed };
}

const inBox = (site, [s, w, n, e]) => site.lat >= s && site.lat <= n && site.lng >= w && site.lng <= e;
const isMaxstayClass = (site) => site.operatorId === null && /operator untagged/.test(site.notes || '');
const isAdjacentClass = (site) => (site.notes || '').includes(ADJACENT_NOTE);

/** Sites from the previous database to keep because the box they sit in could
 *  not be refreshed this run. Without this a failed box would silently delete
 *  every car park inside it. */
export function carryOver(existing, failedOperatorBoxes, failedMaxstayBoxes, failedAdjacentBoxes = []) {
  return existing.sites.filter((site) => {
    if (site.source !== 'osm') return false;
    const boxes = isAdjacentClass(site) ? failedAdjacentBoxes
      : isMaxstayClass(site) ? failedMaxstayBoxes : failedOperatorBoxes;
    return boxes.some((box) => inBox(site, box));
  });
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

async function runTest(existing) {
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
  // carry-over: sites in a failed box are kept, by class
  const prev = { sites: [
    { id: 'cur-1', lat: 50, lng: 0 },
    { id: 'osm-a', source: 'osm', lat: 50, lng: 0, operatorId: 'ncp', notes: '' },
    { id: 'osm-b', source: 'osm', lat: 50, lng: 0, operatorId: null, notes: 'OSM maxstay: 2 hours — operator untagged, enforcement unverified' },
    { id: 'osm-c', source: 'osm', lat: 56, lng: -3, operatorId: 'ncp', notes: '' },
  ] };
  const box = [49, -3, 50.5, 2];
  assert(carryOver(prev, [box], []).map((x) => x.id).join() === 'osm-a', 'carryOver keeps operator-class sites in a failed operator box');
  assert(carryOver(prev, [], [box]).map((x) => x.id).join() === 'osm-b', 'carryOver keeps maxstay-class sites in a failed maxstay box');
  assert(carryOver(prev, [], []).length === 0, 'carryOver keeps nothing when no box failed');
  const quads = splitTile([49, -3, 50.5, 2]);
  assert(quads.length === 4 && quads[0][2] === 49.75 && quads[3][1] === -0.5, 'splitTile makes four quadrants');
  // adjacent pass
  const adjEls = [
    { type: 'way', id: 100, center: { lat: 53.2000, lon: -2.5000 }, tags: { shop: 'supermarket', brand: 'Aldi', name: 'Aldi' } },
    { type: 'way', id: 101, center: { lat: 53.2003, lon: -2.5003 }, tags: { amenity: 'parking' } },                       // next to Aldi
    { type: 'way', id: 102, center: { lat: 53.2005, lon: -2.5006 }, tags: { amenity: 'parking' } },                       // second polygon, same store
    { type: 'way', id: 103, center: { lat: 53.2002, lon: -2.4998 }, tags: { amenity: 'parking', access: 'private' } },    // staff only
    { type: 'way', id: 104, center: { lat: 53.2001, lon: -2.5001 }, tags: { amenity: 'parking', parking: 'street_side' } },
    { type: 'way', id: 105, center: { lat: 53.2004, lon: -2.5002 }, tags: { amenity: 'parking', operator: 'Cheshire West and Chester Council' } },
    { type: 'node', id: 110, lat: 53.4000, lon: -2.2000, tags: { amenity: 'hospital', name: 'Test General Hospital' } },
    { type: 'way', id: 111, center: { lat: 53.4010, lon: -2.2010 }, tags: { amenity: 'parking', fee: 'yes' } },
    { type: 'way', id: 120, center: { lat: 54.9000, lon: -1.6000 }, tags: { amenity: 'parking' } },                       // no anchor nearby
    { type: 'node', id: 130, lat: 52.0000, lon: -1.0000, tags: { shop: 'convenience', brand: 'Tesco', name: 'Tesco Express' } },
    { type: 'way', id: 131, center: { lat: 52.0003, lon: -1.0003 }, tags: { amenity: 'parking' } },                       // high-street store, untagged car park
  ];
  const adj = adjacentSites(adjEls);
  assert(adj.map((x) => x.id).join() === 'osm-way-101,osm-way-102,osm-way-111', `adjacentSites keeps public car parks beside anchors (got ${adj.map((x) => x.id).join()})`);
  const a101 = adj.find((x) => x.id === 'osm-way-101');
  assert(a101.name === 'Aldi car park' && a101.operatorId === 'parkingeye' && a101.confidence === 'low' && a101.siteType === 'customer-only', 'adjacent Aldi site: named, ParkingEye, low confidence, customer-only');
  assert(adj.find((x) => x.id === 'osm-way-111').siteType === 'pay-and-display' && /hospital/.test(adj.find((x) => x.id === 'osm-way-111').notes), 'adjacent hospital site: pay-and-display, note names the hospital');
  const thinned = thinAdjacent(adj, []);
  assert(thinned.map((x) => x.id).join() === 'osm-way-101,osm-way-111', 'thinAdjacent keeps one site per store');
  assert(thinAdjacent(adj, [{ id: 'cur', lat: 53.2003, lng: -2.5003 }]).map((x) => x.id).join() === 'osm-way-111', 'thinAdjacent drops candidates beside an existing site');
  assert(carryOver({ sites: [{ id: 'x', source: 'osm', lat: 50, lng: 0, operatorId: null, notes: adj[0].notes }] }, [], [], [box]).length === 1, 'carryOver keeps adjacent-class sites in a failed adjacent box');
  const round = JSON.parse(serialise({ schemaVersion: 1, sites: adj, stats: { osm: 3 } }));
  assert(round.sites.length === 3 && round.stats.osm === 3 && round.schemaVersion === 1, 'serialise writes valid JSON that round-trips');
  // country filter
  assert(inBounds(53.2955, -2.7236) && inBounds(49.19, -2.11) && inBounds(54.15, -4.48) && inBounds(51.13, 1.31) && inBounds(50.6, -1.2) && inBounds(49.92, -6.3), 'inBounds keeps Frodsham, Jersey, Isle of Man, Dover, Isle of Wight, Scilly');
  assert(!inBounds(49.18, -0.36) && !inBounds(49.44, 1.09) && !inBounds(50.95, 1.85) && !inBounds(49.65, -1.62) && !inBounds(49.92, 1.08), 'inBounds drops Caen, Rouen, Calais, Cherbourg, Dieppe');
  const withFrance = merge({ sites: [] }, [
    { id: 'osm-way-1', lat: 53.3, lng: -2.7 }, { id: 'osm-way-2', lat: 49.18, lng: -0.36 },
  ]);
  assert(withFrance.sites.length === 1 && withFrance.sites[0].id === 'osm-way-1', 'merge drops sites outside the UK');
  // job queue
  const firstPlan = planTasks({});
  assert(firstPlan.length === 42 && firstPlan.slice(0, 28).every((t) => t.klass === 'adjacent'), 'planTasks: 42 jobs, adjacent first when nothing has ever been refreshed');
  const stamped = Object.fromEntries(firstPlan.slice(0, 40).map((t) => [t.key, '2026-10-11T12:00']));
  stamped[firstPlan[3].key] = '2026-10-04T12:00';
  const nextPlan = planTasks(stamped);
  assert(nextPlan[0].key === firstPlan[40].key && nextPlan[1].key === firstPlan[41].key && nextPlan[2].key === firstPlan[3].key, 'planTasks: never-refreshed jobs first, then the oldest');
  const tried = { ...stamped, [firstPlan[40].key]: '2026-10-12T12:00' }; // tried but never completed
  assert(planTasks(stamped, tried)[0].key === firstPlan[41].key && planTasks(stamped, tried).at(-1).key === firstPlan[40].key, 'planTasks: a box tried today goes to the back even if it never completed');
  assert(/area\.uk/.test(tileQueryAdjacent([49, -3, 50, 2])) && /area\.uk/.test(tileQueryOperators([49, -3, 50, 2])) && /area\.uk/.test(tileQueryMaxstay([49, -3, 50, 2])), 'all three queries filter to UK areas');
  await testFetchTile(assert);
  console.log(process.exitCode ? 'TESTS FAILED' : 'All import tests passed');
}

async function testFetchTile(assert) {
  const noSleep = async () => {};
  const quiet = console.error; console.error = () => {};
  try {
    // whole tile always 504s, quadrants succeed -> elements from 4 quadrants, nothing failed
    let calls = 0;
    const bigFails = async (_url, init) => {
      calls++;
      const q = decodeURIComponent(init.body);
      const whole = q.includes('(49,-3,50.5,2)');
      return whole ? { ok: false, status: 504 } : { ok: true, json: async () => ({ elements: [{ id: calls }] }) };
    };
    const r1 = await fetchTile(tileQueryOperators, [49, -3, 50.5, 2], { fetchImpl: bigFails, sleepImpl: noSleep });
    console.error = quiet;
    assert(r1.elements.length === 4 && r1.failed.length === 0, 'fetchTile splits a failing tile and recovers via quadrants');
    console.error = () => {};
    // everything 504s -> no throw, the 16 smallest boxes are reported failed
    const allFail = async () => ({ ok: false, status: 504 });
    const r2 = await fetchTile(tileQueryOperators, [49, -3, 50.5, 2], { fetchImpl: allFail, sleepImpl: noSleep });
    console.error = quiet;
    assert(r2.elements.length === 0 && r2.failed.length === 64, 'fetchTile reports failed boxes instead of throwing');
    console.error = () => {};
    // HTTP 200 with a timeout remark is a failure, not an empty result
    const partial = async () => ({ ok: true, json: async () => ({ elements: [{ id: 1 }], remark: 'runtime error: Query timed out in "query" at line 3 after 121 seconds.' }) });
    const r3 = await fetchTile(tileQueryOperators, [49, -3, 50.5, 2], { fetchImpl: partial, sleepImpl: noSleep });
    console.error = quiet;
    assert(r3.elements.length === 0 && r3.failed.length === 64, 'fetchOverpass rejects partial results that carry a timeout remark');
  } finally {
    console.error = quiet;
  }
}

/** Every (pass, tile) job, stalest first by when it was last ATTEMPTED: jobs
 *  never tried come before any tried job, and among those the adjacent pass
 *  goes first. Ordering by attempt (not success) means a box that keeps coming
 *  back partial still goes to the back of the queue, so areas further down the
 *  list get their turn instead of being starved by it. */
export function planTasks(refreshed = {}, attempted = refreshed) {
  const tasks = [
    ...TILES.flatMap(splitTile).map((tile) => ({ klass: 'adjacent', tile, build: tileQueryAdjacent })),
    ...TILES.map((tile) => ({ klass: 'operator', tile, build: tileQueryOperators })),
    ...TILES.map((tile) => ({ klass: 'maxstay', tile, build: tileQueryMaxstay })),
  ].map((t) => ({ ...t, key: `${t.klass}:${t.tile.join(',')}` }));
  // Array.prototype.sort is stable, so ties keep the order above.
  return tasks.sort((a, b) => (attempted[a.key] || '').localeCompare(attempted[b.key] || ''));
}

/** One site per line: valid JSON, a fifth of the size of full pretty-printing,
 *  and still gives readable line-by-line diffs. */
export function serialise(db) {
  const { sites, ...head } = db;
  const top = JSON.stringify(head, null, 2).replace(/\n}$/, '');
  return `${top},\n  "sites": [\n${sites.map((x) => '    ' + JSON.stringify(x)).join(',\n')}\n  ]\n}\n`;
}

async function main() {
  const existing = JSON.parse(readFileSync(SITES_PATH, 'utf8'));
  const mode = process.argv[2];

  if (mode === '--test') return runTest(existing);

  const refreshed = { ...(existing.stats?.refreshed || {}) };
  const attempted = { ...refreshed, ...(existing.stats?.attempted || {}) };
  const tasks = planTasks(refreshed, attempted);
  const got = { operator: [], maxstay: [], adjacent: [] };
  const failed = { operator: [], maxstay: [], adjacent: [] };
  let done = 0;
  let skipped = 0;
  console.log(`Querying Overpass: ${tasks.length} jobs, stalest first (UK, Isle of Man, Channel Islands)…`);
  for (const [idx, task] of tasks.entries()) {
    if (budgetSpent()) { failed[task.klass].push(task.tile); skipped += 1; continue; }
    console.log(`  ${idx + 1}/${tasks.length} ${task.klass} [${task.tile.join(', ')}] last refreshed ${refreshed[task.key] || 'never'}, last tried ${attempted[task.key] || 'never'}`);
    attempted[task.key] = new Date().toISOString().slice(0, 16);
    const r = await fetchTile(task.build, task.tile);
    got[task.klass].push(...r.elements);
    failed[task.klass].push(...r.failed);
    if (r.failed.length === 0) { refreshed[task.key] = new Date().toISOString().slice(0, 16); done += 1; }
    await sleep(8000);
  }
  console.log(`  ${done} jobs completed, ${skipped} skipped for time, ${tasks.length - done - skipped} failed or partial`);
  if (done === 0) {
    throw new Error('Overpass completed no job at all — database left unchanged.');
  }

  const opSites = got.operator.map((e) => elementToSite(e, 'operator')).filter(Boolean);
  const msSites = got.maxstay.map((e) => elementToSite(e, 'maxstay')).filter(Boolean);
  const adjRaw = adjacentSites(got.adjacent);
  console.log(`  operator ${got.operator.length} elements -> ${opSites.length} sites; maxstay ${got.maxstay.length} -> ${msSites.length}; adjacent ${got.adjacent.length} -> ${adjRaw.length} candidates`);

  // Anything not refreshed this run keeps the sites it already had.
  const kept = carryOver(existing, failed.operator, failed.maxstay, failed.adjacent);
  if (kept.length) {
    const n = failed.operator.length + failed.maxstay.length + failed.adjacent.length;
    console.log(`::warning::${n} box(es) were not refreshed this run; kept ${kept.length} existing sites inside them.`);
  }

  // Confirmed sites first; adjacent candidates only fill the gaps between them.
  const confirmed = [...opSites, ...msSites, ...kept.filter((x) => !isAdjacentClass(x))];
  const confirmedIds = new Set(confirmed.map((x) => x.id));
  const curatedSites = existing.sites.filter((x) => x.source !== 'osm');
  const adjSites = thinAdjacent(
    [...adjRaw, ...kept.filter(isAdjacentClass)].filter((x) => !confirmedIds.has(x.id)),
    [...curatedSites, ...confirmed],
  );
  console.log(`  ${adjSites.length} adjacent sites kept after removing overlaps`);

  const merged = merge(existing, [...confirmed, ...adjSites]);
  merged.stats.refreshed = Object.fromEntries(Object.entries(refreshed).sort());
  merged.stats.attempted = Object.fromEntries(Object.entries(attempted).sort());
  console.log(`Merged database: ${merged.stats.curated} curated + ${merged.stats.osm} OSM = ${merged.sites.length} sites`);

  // Safety net: never publish a database that has lost a large share of its
  // sites in one run — that means a bad import, not a real-world change.
  const before = existing.sites.filter((x) => x.source === 'osm' && inBounds(x.lat, x.lng)).length;
  if (before > 0 && merged.stats.osm < before * 0.95) {
    throw new Error(`Import would shrink OSM sites from ${before} to ${merged.stats.osm} — refusing to write.`);
  }

  if (mode === '--dry-run') return console.log('Dry run — nothing written.');
  writeFileSync(SITES_PATH, serialise(merged));
  console.log(`Wrote ${SITES_PATH}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
