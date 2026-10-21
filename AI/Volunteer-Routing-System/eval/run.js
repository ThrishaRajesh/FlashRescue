// Compares the two hospital-choice strategies over many random disaster scenarios.
//   node eval/run.js [--seeds 30]
// Same volunteers, same casualties, same closures, same hospital capacity - only the destination rule differs.
const fs = require('fs');
const path = require('path');
const { World } = require('../lib/world');
const { createOfflineRouter } = require('../lib/router');
const { loadData } = require('../lib/data');

function rng(seed) { // mulberry32
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (r) => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());

// Three waves of casualties around the city centre, plus one road closing mid-way.
const KINDS = {
  clustered: { sigma: 0.011, waves: [[0, 300, 24], [900, 1200, 20], [1800, 2100, 16]], label: 'Heavy, clustered near the centre (60 casualties)' },
  spread: { sigma: 0.035, waves: [[0, 300, 24], [900, 1200, 20], [1800, 2100, 16]], label: 'Heavy, spread across the whole city (60 casualties)' },
  light: { sigma: 0.011, waves: [[0, 300, 8], [900, 1200, 6], [1800, 2100, 4]], label: 'Light load, clustered (18 casualties, fewer than beds)' },
};

function scenario(seed, kind = 'clustered') {
  const r = rng(seed);
  const centre = [12.965, 77.59];
  const { sigma, waves } = KINDS[kind];
  const events = [];
  for (const [from, to, n] of waves) {
    for (let i = 0; i < n; i++) {
      events.push({ t: from + r() * (to - from), lat: centre[0] + gauss(r) * sigma, lng: centre[1] + gauss(r) * sigma });
    }
  }
  events.sort((a, b) => a.t - b.t);
  const close = { t: 600, id: 'x1', coords: [[12.95, 77.572], [12.98, 77.572]] };
  return { events, close };
}

async function run(strategy, seed, data, opts = {}, kind = 'clustered') {
  const w = new World({ ...data, strategy, router: createOfflineRouter(), treatSec: opts.treatSec || 300 });
  const sc = scenario(seed, kind);
  let i = 0, closed = false;
  const dt = 10;
  while (w.t < 7200) {
    while (i < sc.events.length && sc.events[i].t <= w.t) { w.addCasualty(sc.events[i].lat, sc.events[i].lng); i++; }
    if (!closed && w.t >= sc.close.t) { w.addBlocked(sc.close.id, sc.close.coords); closed = true; }
    await w.step(dt);
    if (i >= sc.events.length && w.done()) break;
  }
  return w.metrics();
}

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const std = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };

async function main() {
  const n = Number(process.argv[process.argv.indexOf('--seeds') + 1]) || 30;
  const data = loadData();
  const keys = [
    ['avgToBed', 'Average time to a bed (min)', 60],
    ['p90ToBed', '90th percentile (min)', 60],
    ['maxToBed', 'Worst case (min)', 60],
    ['queuedArrivals', 'Patients arriving at a full hospital', 1],
    ['peakQueue', 'Longest queue at one hospital', 1],
  ];
  const pad = (s, w) => String(s).padEnd(w);
  const out = { seeds: n, scenarios: {} };
  console.log(`
Nearest hospital vs load-aware dispatch, ${n} random scenarios each. 20 volunteers, 5 hospitals, 17 beds, one road closes mid-way.`);
  for (const kind of Object.keys(KINDS)) {
    const res = { nearest: [], aware: [] };
    for (let s = 1; s <= n; s++) for (const strat of ['nearest', 'aware']) res[strat].push(await run(strat, s, data, {}, kind));
    const rows = keys.map(([k, label, div]) => {
      const a = res.nearest.map((m) => m[k] / div), b = res.aware.map((m) => m[k] / div);
      return { label, nearest: mean(a), nearestSd: std(a), aware: mean(b), awareSd: std(b), change: mean(a) ? (mean(b) - mean(a)) / mean(a) : 0 };
    });
    const wins = res.nearest.filter((m, i) => res.aware[i].avgToBed < m.avgToBed - 1e-9).length;
    const ties = res.nearest.filter((m, i) => Math.abs(res.aware[i].avgToBed - m.avgToBed) <= 1e-9).length;
    out.scenarios[kind] = { label: KINDS[kind].label, rows, awareBetter: wins, ties, diversions: mean(res.aware.map((m) => m.diversions)) };
    console.log(`
${KINDS[kind].label}`);
    console.log(pad('  Metric', 40) + pad('Nearest', 16) + pad('Load-aware', 16) + 'Change');
    for (const r of rows) {
      console.log(pad('  ' + r.label, 40) + pad(`${r.nearest.toFixed(1)} +/-${r.nearestSd.toFixed(1)}`, 16) + pad(`${r.aware.toFixed(1)} +/-${r.awareSd.toFixed(1)}`, 16) + `${r.change >= 0 ? '+' : ''}${(r.change * 100).toFixed(0)}%`);
    }
    console.log(`  Load-aware had the lower average wait in ${wins} of ${n} scenarios (${ties} ties). Live diversions per run: ${out.scenarios[kind].diversions.toFixed(1)}.`);
  }
  console.log('\nSimulated casualties, bed counts and a simplified road model: shows the relative difference between the rules, not real hospital performance.');
  fs.writeFileSync(path.join(__dirname, 'results.json'), JSON.stringify(out, null, 2));
}

if (require.main === module) main();
module.exports = { run, scenario };
