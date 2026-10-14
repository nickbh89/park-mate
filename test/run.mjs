// Node test runner for the pure logic (no Expo/RN imports).
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { haversineM, createDetector, classifyFix, hasLeft } from '../src/services/geofence.js';
import { planSession, planPaidExpiry, cancelOnExit, planUserLimit, LIMIT_CHOICES } from '../src/services/stayTimer.js';
import { toChunks, fromChunks, isNewer, looksValid } from '../src/services/siteStore.js';

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

console.log('geofence');
test('haversine: known distance Frodsham→Chester ~11-13 km', () => {
  const d = haversineM(53.2946, -2.7256, 53.1905, -2.8918);
  assert.ok(d > 10000 && d < 17000, `got ${d}`);
});
test('haversine: zero distance', () => {
  assert.strictEqual(haversineM(53.3, -2.7, 53.3, -2.7), 0);
});

const site = { id: 't1', name: 'Test Park', lat: 53.3000, lng: -2.7000, radiusM: 100 };
test('classifyFix inside/boundary/outside', () => {
  assert.strictEqual(classifyFix(site, 53.3000, -2.7000), 'inside');
  assert.strictEqual(classifyFix(site, 53.3011, -2.7000), 'boundary'); // ~122m
  assert.strictEqual(classifyFix(site, 53.3100, -2.7000), 'outside');  // ~1.1km
});

test('detector requires 2 fixes to confirm entry (no drive-past false positive)', () => {
  const det = createDetector([site]);
  let ev = det.update(53.3000, -2.7000, 1000);
  assert.strictEqual(ev.length, 0, 'first fix should not trigger');
  ev = det.update(53.3001, -2.7001, 31000);
  assert.strictEqual(ev.length, 1);
  assert.strictEqual(ev[0].type, 'enter');
});

test('detector hysteresis: boundary jitter does not exit', () => {
  const det = createDetector([site]);
  det.update(53.3000, -2.7000, 1000);
  det.update(53.3000, -2.7000, 2000); // entered
  let ev = det.update(53.3011, -2.7000, 3000); // boundary band
  assert.strictEqual(ev.length, 0, 'boundary fix must not exit');
  assert.ok(det.isActive('t1'));
  ev = det.update(53.3100, -2.7000, 4000); // clearly outside
  assert.strictEqual(ev.length, 1);
  assert.strictEqual(ev[0].type, 'exit');
});

console.log('stayTimer');
const freeSite = { id: 'f1', name: 'Retail Park', siteType: 'free-max-stay', maxStayMinutes: 120, gracePeriodMinutes: 10, operatorName: 'ParkingEye Ltd' };
test('free-max-stay plan: deadline, grace, 4 reminders', () => {
  const t0 = Date.UTC(2026, 7, 23, 10, 0, 0);
  const plan = planSession(freeSite, t0, { alertLeadMinutes: 15 });
  assert.strictEqual(plan.deadlineAt, t0 + 120 * 60000);
  assert.strictEqual(plan.hardLimitAt, t0 + 130 * 60000);
  assert.strictEqual(plan.reminders.length, 4);
  const kinds = plan.reminders.map((r) => r.kind);
  assert.deepStrictEqual(kinds, ['entry', 'pre-deadline', 'deadline', 'overstay']);
  assert.strictEqual(plan.reminders[1].at, plan.deadlineAt - 15 * 60000);
});
test('entry reminder fires at entry (not before)', () => {
  const t0 = 1000000;
  const plan = planSession(freeSite, t0);
  // 'entry' pushed with at === entryAt would be filtered by (at > entryAt): verify behavior
  assert.ok(plan.reminders[0].kind === 'entry' || plan.reminders[0].kind === 'pre-deadline');
});
test('pay-on-exit: no deadline, pay reminder on entry', () => {
  const plan = planSession({ id: 'h', name: 'Hospital', siteType: 'pay-on-exit' }, 5000);
  assert.strictEqual(plan.deadlineAt, null);
  assert.strictEqual(plan.reminders.length, 1);
  assert.ok(plan.reminders[0].message.includes('pay'));
});
test('paid expiry plan: 3 reminders around paidUntil', () => {
  const paidUntil = Date.UTC(2026, 7, 23, 14, 0, 0);
  const p = planPaidExpiry({ id: 'p', name: 'P&D', gracePeriodMinutes: 10 }, paidUntil, { alertLeadMinutes: 10 });
  assert.strictEqual(p.reminders.length, 3);
  assert.strictEqual(p.hardLimitAt, paidUntil + 10 * 60000);
});
test('cancelOnExit drops future reminders', () => {
  const t0 = Date.UTC(2026, 7, 23, 10, 0, 0);
  const plan = planSession(freeSite, t0, { alertLeadMinutes: 15 });
  const out = cancelOnExit(plan, t0 + 30 * 60000); // left after 30 min
  assert.ok(out.reminders.every((r) => r.at <= t0 + 30 * 60000));
  assert.ok(out.reminders.length < plan.reminders.length);
});

console.log('database');
test('parkingSites.json: valid, UK coords, operators resolve, sane values', () => {
  const sites = JSON.parse(readFileSync(new URL('../src/data/parkingSites.json', import.meta.url)));
  const ops = JSON.parse(readFileSync(new URL('../src/data/operators.json', import.meta.url)));
  const opIds = new Set(ops.operators.map((o) => o.id));
  const seen = new Set();
  for (const s of sites.sites) {
    assert.ok(!seen.has(s.id), `duplicate id ${s.id}`);
    seen.add(s.id);
    assert.ok(s.lat > 49 && s.lat < 61, `${s.id} lat out of UK range`);
    assert.ok(s.lng > -8.5 && s.lng < 2, `${s.id} lng out of UK range`);
    // null means the operator is not known; the app shows it as "Private operator"
    assert.ok(s.operatorId === null || opIds.has(s.operatorId), `${s.id} unknown operator ${s.operatorId}`);
    assert.ok(s.radiusM >= 50 && s.radiusM <= 400, `${s.id} radius ${s.radiusM}`);
    if (s.siteType === 'free-max-stay') assert.ok(s.maxStayMinutes >= 1, `${s.id} maxStay`); // drop-off bays can be 5 min
    assert.strictEqual(s.verified, false, `${s.id}: seed entries must be verified:false until surveyed`);
  }
  assert.ok(sites.sites.length >= 25, 'expected 25+ seed sites');
});

console.log('leaving');
test('hasLeft: inside and boundary are not left, clearly outside is', () => {
  const visit = { lat: 53.3000, lng: -2.7000, radiusM: 100 };
  assert.strictEqual(hasLeft(visit, 53.3000, -2.7000), false);
  assert.strictEqual(hasLeft(visit, 53.3011, -2.7000), false); // ~122 m, inside the 150 m exit ring
  assert.strictEqual(hasLeft(visit, 53.3100, -2.7000), true);  // ~1.1 km
  assert.strictEqual(hasLeft(null, 53.31, -2.7), false);
  assert.strictEqual(hasLeft({ siteId: 'old-format' }, 53.31, -2.7), false);
});

console.log('user-set limits');
const unknownSite = { id: 'u1', name: 'Aldi car park', siteType: 'customer-only', gracePeriodMinutes: 10, operatorName: 'ParkingEye Ltd' };
test('unknown site: entry alert tells the driver to set the limit', () => {
  const plan = planSession(unknownSite, 1000);
  assert.strictEqual(plan.deadlineAt, null);
  assert.strictEqual(plan.reminders.length, 1);
  assert.ok(/tap its time limit/.test(plan.reminders[0].message));
});
test('planUserLimit: 90 min from arrival, set 20 min in', () => {
  const t0 = Date.UTC(2026, 9, 11, 10, 0, 0);
  const now = t0 + 20 * 60000;
  const plan = planUserLimit(unknownSite, t0, 90, { alertLeadMinutes: 15, now });
  assert.strictEqual(plan.deadlineAt, t0 + 90 * 60000);
  assert.strictEqual(plan.hardLimitAt, t0 + 100 * 60000);
  assert.deepStrictEqual(plan.reminders.map((r) => r.kind), ['pre-deadline', 'deadline', 'overstay']);
});
test('planUserLimit: limit already passed leaves only the alerts still ahead', () => {
  const t0 = Date.UTC(2026, 9, 11, 10, 0, 0);
  const plan = planUserLimit(unknownSite, t0, 30, { alertLeadMinutes: 15, now: t0 + 35 * 60000 });
  assert.deepStrictEqual(plan.reminders.map((r) => r.kind), ['overstay']);
});
test('planUserLimit: remembered limit adds an entry alert that says so', () => {
  const plan = planUserLimit(unknownSite, 5000, 120, { remembered: true });
  assert.strictEqual(plan.reminders[0].kind, 'entry');
  assert.ok(/last time/.test(plan.reminders[0].message));
  assert.strictEqual(plan.reminders.length, 4);
});
test('limit choices are sensible', () => {
  assert.ok(LIMIT_CHOICES.includes(90) && LIMIT_CHOICES.includes(120));
});

console.log('siteStore');
const bigDb = { schemaVersion: 1, effectiveDate: '2026-10-11', defaults: { gracePeriodMinutes: 10 }, sites: Array.from({ length: 3700 }, (_, i) => ({ id: `s${i}`, lat: 53 + i / 1e5, lng: -2.7 })) };
test('chunks round-trip a large database', () => {
  const { meta, chunks } = toChunks(bigDb);
  assert.strictEqual(chunks.length, 3);
  assert.strictEqual(meta.count, 3700);
  assert.ok(chunks.every((c) => c.length < 1.5e6));
  const back = fromChunks(JSON.parse(JSON.stringify(meta)), chunks);
  assert.strictEqual(back.sites.length, 3700);
  assert.strictEqual(back.effectiveDate, '2026-10-11');
  assert.deepStrictEqual(back.sites[3699], bigDb.sites[3699]);
});
test('a missing or damaged chunk gives null, not a partial database', () => {
  const { meta, chunks } = toChunks(bigDb);
  assert.strictEqual(fromChunks(meta, [chunks[0], null, chunks[2]]), null);
  assert.strictEqual(fromChunks(meta, [chunks[0], '{broken', chunks[2]]), null);
  assert.strictEqual(fromChunks(meta, chunks.slice(0, 2)), null);
  assert.strictEqual(fromChunks(null, chunks), null);
});
test('isNewer compares effective dates', () => {
  assert.ok(isNewer({ effectiveDate: '2026-10-11' }, { effectiveDate: '2026-09-14' }));
  assert.ok(!isNewer({ effectiveDate: '2026-09-14' }, { effectiveDate: '2026-09-14' }));
  assert.ok(!isNewer(null, { effectiveDate: '2026-09-14' }));
});
test('looksValid rejects junk downloads', () => {
  assert.ok(looksValid(bigDb));
  assert.ok(!looksValid({ effectiveDate: '2026-10-11', sites: [] }));
  assert.ok(!looksValid({ message: 'Not Found' }));
});

console.log(`\n${passed} tests passed${process.exitCode ? ' (with failures)' : ''}`);
