const test = require('node:test');
const assert = require('node:assert');
const geo = require('../lib/geo');
const { createOfflineRouter, createOsrmRouter } = require('../lib/router');
const { World } = require('../lib/world');
const { loadData } = require('../lib/data');
const { run } = require('../eval/run');

const data = loadData();
const mk = (over = {}) => new World({ ...data, blocked: [], router: createOfflineRouter(), ...over });
const H = (w, id) => w.hospitals.find((h) => h.id === id);

// ---------- geometry ----------
test('a route driving along the middle of a long closed road is caught (old vertex-only check missed it)', () => {
  const blocked = [[[12.95, 77.55], [12.99, 77.59]]];
  assert.ok(geo.pathBlocked([[12.96, 77.56], [12.98, 77.58]], blocked));      // runs along it, between the end points
  assert.ok(!geo.pathBlocked([[13.1, 77.55], [13.1, 77.59]], blocked));      // far away
});

test('merely crossing a closed road at a junction is not blocked', () => {
  const blocked = [[[12.95, 77.55], [12.99, 77.59]]];
  assert.ok(!geo.pathBlocked([[12.99, 77.55], [12.95, 77.59]], blocked));     // cuts straight across the diagonal
});

test('a volunteer standing on a closed road can still leave it', () => {
  const blocked = [[[12.97, 77.58], [12.97, 77.60]]];
  assert.ok(!geo.pathBlocked([[12.97, 77.58], [12.9, 77.58]], blocked));
});

test('offline router detours around a closed road it would otherwise drive along', async () => {
  const r = createOfflineRouter();
  const blocked = [{ id: 'b', coords: [[12.95, 77.5705], [13.02, 77.5705]] }];
  const route = await r.route([12.94, 77.5703], [13.03, 77.5703], blocked);     // would drive right along the closed road
  assert.ok(route.safe && !geo.pathBlocked(route.coords, blocked));
  assert.notStrictEqual(route.note, 'clear');
});

test('OSRM router picks a clear alternative, survives failure, and spaces requests', async () => {
  let calls = 0;
  const fetchImpl = async (url) => {
    calls++;
    if (url.includes('/route/')) {
      return { ok: true, json: async () => ({ routes: [
        { geometry: { coordinates: [[77.55, 12.97], [77.6, 12.97]] }, distance: 5000, duration: 600 },
        { geometry: { coordinates: [[77.55, 12.97], [77.575, 13.05], [77.6, 12.97]] }, distance: 9000, duration: 900 },
      ] }) };
    }
    return { ok: true, json: async () => ({ durations: [[0, 100, 200]] }) };
  };
  const osrm = createOsrmRouter({ fetchImpl, minGapMs: 0 });
  const blocked = [{ id: 'b', coords: [[12.9698, 77.55], [12.9698, 77.6]] }];       // the first route's road is closed
  const r = await osrm.route([12.97, 77.55], [12.97, 77.6], blocked);
  assert.ok(r.safe && r.note.includes('alternative'));
  assert.deepStrictEqual(await osrm.durations([12.97, 77.55], [[1, 1], [2, 2]]), [100, 200]);
  const broken = createOsrmRouter({ fetchImpl: async () => { throw new Error('offline'); }, minGapMs: 0 });
  const f = await broken.route([12.97, 77.55], [12.97, 77.6], []);
  assert.ok(f.safe && f.coords.length > 1);
  assert.strictEqual((await broken.durations([12.97, 77.55], [[12.97, 77.6]])).length, 1);
});

// ---------- hospital capacity model ----------
test('bedStart accounts for busy beds, queued patients and inbound volunteers', () => {
  const w = mk({ treatSec: 100 });
  const h = H(w, 'hosp4');
  h.beds = 1;
  assert.strictEqual(w.bedStart(h, 50), 50);                       // empty hospital: immediate
  h.busy.push({ until: 300, id: 'x' });
  assert.strictEqual(w.bedStart(h, 50), 300);                      // waits for the only bed
  h.queue.push({ id: 'q' });
  assert.strictEqual(w.bedStart(h, 50), 400);                      // behind one queued patient
  const v = w.volunteers[0];
  Object.assign(v, { status: 'to_hospital', hospitalId: 'hosp4', route: { total: 100, progress: 0, speed: 1 } });
  assert.strictEqual(w.bedStart(h, 200), 500);                     // an inbound volunteer arrives first
  assert.strictEqual(w.bedStart(h, 200, v), 400);                  // ...unless it's the one asking
});

// ---------- strategies ----------
function fillHospital(w, id, n) {
  const h = H(w, id);
  for (let i = 0; i < h.beds; i++) h.busy.push({ until: 5000, id: 'b' + i });
  for (let i = 0; i < n; i++) h.queue.push({ id: 'q' + i });
}

test('nearest sends the volunteer to the closest hospital even when it is full', async () => {
  const w = mk({ strategy: 'nearest' });
  const vol = w.volunteers.find((v) => v.id === 'vol4');
  const closest = [...w.hospitals].sort((a, b) => geo.haversine([vol.lat, vol.lng], [a.lat, a.lng]) - geo.haversine([vol.lat, vol.lng], [b.lat, b.lng]))[0];
  fillHospital(w, closest.id, 6);
  const c = await w.choose(vol);
  assert.strictEqual(c.hospital.id, closest.id);
});

test('aware avoids a full, queued hospital and explains why', async () => {
  const w = mk({ strategy: 'aware' });
  const vol = w.volunteers.find((v) => v.id === 'vol4');
  const closest = [...w.hospitals].sort((a, b) => geo.haversine([vol.lat, vol.lng], [a.lat, a.lng]) - geo.haversine([vol.lat, vol.lng], [b.lat, b.lng]))[0];
  fillHospital(w, closest.id, 6);
  const c = await w.choose(vol);
  assert.notStrictEqual(c.hospital.id, closest.id);
  assert.match(c.reason, /wait/);
  assert.match(c.reason, new RegExp(closest.name));
});

test('aware still picks the nearest hospital when nothing is crowded', async () => {
  const w = mk({ strategy: 'aware' });
  const vol = w.volunteers.find((v) => v.id === 'vol4');
  const closest = [...w.hospitals].sort((a, b) => geo.haversine([vol.lat, vol.lng], [a.lat, a.lng]) - geo.haversine([vol.lat, vol.lng], [b.lat, b.lng]))[0];
  assert.strictEqual((await w.choose(vol)).hospital.id, closest.id);
});

// ---------- full simulation ----------
test('every casualty is eventually treated and every volunteer freed', async () => {
  const w = mk({ blocked: data.blocked });
  for (let i = 0; i < 10; i++) w.addCasualty(12.96 + i * 0.002, 77.58 + i * 0.002);
  for (let k = 0; k < 2000 && !w.done(); k++) await w.step(10);
  assert.ok(w.done());
  assert.ok(w.volunteers.every((v) => v.status === 'idle'));
  assert.ok(w.hospitals.every((h) => h.busy.length === 0 && h.queue.length === 0));
});

test('beds are never over-booked', async () => {
  const w = mk();
  for (let i = 0; i < 30; i++) w.addCasualty(12.964 + (i % 5) * 0.001, 77.575 + (i % 3) * 0.001);
  for (let k = 0; k < 400; k++) {
    await w.step(10);
    for (const h of w.hospitals) assert.ok(h.busy.length <= h.beds);
  }
});

test('a road closing mid-journey makes the volunteer re-plan', async () => {
  const w = mk();
  const vol = w.volunteers[0];
  w.addCasualty(vol.lat, vol.lng + 0.02);
  await w.step(1);
  assert.strictEqual(vol.status === 'to_casualty' || w.volunteers.some((v) => v.status === 'to_casualty'), true);
  const mover = w.volunteers.find((v) => v.status === 'to_casualty');
  const cas = w.casualties[0];
  w.addBlocked('new', [[mover.lat, mover.lng], [cas.lat, cas.lng]]);          // the road ahead of them closes
  await w.step(1);
  assert.ok(w.counters.reroutes >= 1);
  assert.ok(!geo.pathBlocked(w.remainingRoute(mover), w.blocked) || mover.route.safe === false);
});

test('aware diverts a volunteer when its hospital fills up while driving', async () => {
  const w = mk({ strategy: 'aware', rebalanceSec: 1 });
  const vol = w.volunteers.find((v) => v.id === 'vol10');
  const cas = w.addCasualty(vol.lat, vol.lng);
  cas.status = 'carried';
  vol.status = 'to_casualty';
  vol.casualtyId = cas.id;
  await w.sendToHospital(vol, cas);
  const first = vol.hospitalId;
  vol.route.progress = vol.route.total * 0.1;
  fillHospital(w, first, 8);
  await w.replan();
  if (w.counters.diversions === 0) {
    // hospital may be too close to divert from (<90 s left); make the trip long enough and retry
    vol.route.progress = 0;
    vol.lastReview = -100;
    await w.replan();
  }
  assert.ok(w.counters.diversions >= 1 || vol.hospitalId !== first);
});

// ---------- evaluation ----------
test('evaluation is deterministic and load-aware helps when casualties cluster near one hospital', async () => {
  const a = await run('aware', 3, data);
  const b = await run('aware', 3, data);
  assert.deepStrictEqual(a, b);
  const nearest = await run('nearest', 3, data);
  assert.ok(a.avgToBed < nearest.avgToBed);
  assert.ok(a.peakQueue < nearest.peakQueue);
});
