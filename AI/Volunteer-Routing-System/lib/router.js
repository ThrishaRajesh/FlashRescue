// Routers share one interface so the simulation doesn't care where routes come from:
//   durations(origin, [dest...]) -> Promise<seconds[]>        (estimates, used to compare hospitals)
//   route(origin, dest, blocked)  -> Promise<{coords, distance, duration, safe, note}>
const { haversine, densify, routeLength, pathBlocked } = require('./geo');

const SPEED_MPS = 8.3;       // ~30 km/h urban average
const ROAD_FACTOR = 1.3;     // straight line -> typical road distance

function detours(origin, dest) {
  const mid = [(origin[0] + dest[0]) / 2, (origin[1] + dest[1]) / 2];
  const dy = dest[0] - origin[0];
  const dx = (dest[1] - origin[1]) * Math.cos((mid[0] * Math.PI) / 180);
  const n = Math.hypot(dx, dy) || 1;
  const px = -dy / n, py = dx / n;
  const out = [];
  for (const off of [1200, 2500, 4500]) {
    for (const s of [1, -1]) {
      out.push([
        mid[0] + (s * py * off) / 111320,
        mid[1] + (s * px * off) / (111320 * Math.cos((mid[0] * Math.PI) / 180)),
      ]);
    }
  }
  return out;
}

// Offline router: straight line, or a one-waypoint detour when the line crosses a blocked road.
// Used for tests, the evaluation, and as the fallback when OSRM can't be reached.
function createOfflineRouter({ speed = SPEED_MPS } = {}) {
  const make = (coords, safe, note) => {
    const distance = routeLength(coords) * ROAD_FACTOR;
    return { coords, distance, duration: distance / speed, safe, note };
  };
  return {
    name: 'offline',
    async durations(origin, dests) {
      return dests.map((d) => (haversine(origin, d) * ROAD_FACTOR) / speed);
    },
    async route(origin, dest, blocked = []) {
      const direct = densify([origin, dest]);
      if (!pathBlocked(direct, blocked)) return make(direct, true, 'clear');
      for (const wp of detours(origin, dest)) {
        const cand = densify([origin, wp, dest]);
        if (!pathBlocked(cand, blocked)) return make(cand, true, 'detour around blocked road');
      }
      return make(direct, false, 'no clear route');
    },
  };
}

// OSRM router (live demo). Caches results and spaces requests out so the free public server isn't hammered;
// any failure falls back to the offline router so the demo keeps running.
function createOsrmRouter({ base = 'https://router.project-osrm.org', fallback = createOfflineRouter(), minGapMs = 220, fetchImpl = fetch } = {}) {
  const cache = new Map();
  let last = 0;
  let chain = Promise.resolve();
  const key = (o, d) => [o, d].map((p) => p.map((x) => x.toFixed(3)).join(',')).join('>');
  const call = (url) => {
    const run = async () => {
      const wait = Math.max(0, last + minGapMs - Date.now());
      if (wait) await new Promise((r) => setTimeout(r, wait));
      last = Date.now();
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(6000) });
      if (!res.ok) throw new Error('OSRM ' + res.status);
      return res.json();
    };
    const p = chain.then(run, run);
    chain = p.catch(() => {});
    return p;
  };
  const self = {
    name: 'osrm',
    async durations(origin, dests) {
      try {
        const pts = [origin, ...dests].map((p) => `${p[1]},${p[0]}`).join(';');
        const j = await call(`${base}/table/v1/driving/${pts}?sources=0&annotations=duration`);
        const row = j.durations && j.durations[0];
        if (!row) throw new Error('no table');
        return dests.map((d, i) => (row[i + 1] == null ? Infinity : row[i + 1]));
      } catch {
        return fallback.durations(origin, dests);
      }
    },
    async route(origin, dest, blocked = []) {
      const k = key(origin, dest);
      let alts = cache.get(k);
      if (!alts) {
        try {
          const j = await call(`${base}/route/v1/driving/${origin[1]},${origin[0]};${dest[1]},${dest[0]}?overview=full&geometries=geojson&alternatives=true`);
          alts = (j.routes || []).map((r) => ({ coords: r.geometry.coordinates.map((c) => [c[1], c[0]]), distance: r.distance, duration: r.duration }));
          cache.set(k, alts);
        } catch {
          alts = [];
        }
      }
      for (let i = 0; i < alts.length; i++) {
        if (!pathBlocked(alts[i].coords, blocked)) {
          return { ...alts[i], safe: true, note: i === 0 ? 'clear' : 'alternative road avoids blockage' };
        }
      }
      const f = await fallback.route(origin, dest, blocked);
      return alts.length && f.safe ? { ...f, note: 'all roads blocked - off-road detour' } : f;
    },
  };
  return self;
}

module.exports = { createOfflineRouter, createOsrmRouter, SPEED_MPS };
