// Geometry helpers. Points are [lat, lng]. A route is an array of points; a blocked road is a polyline of points.
const R = 6371000;
const rad = (d) => (d * Math.PI) / 180;

function haversine(a, b) {
  const dLat = rad(b[0] - a[0]);
  const dLng = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// local flat projection to metres around a reference latitude
const project = (p, refLat) => [rad(p[1]) * R * Math.cos(rad(refLat)), rad(p[0]) * R];

function ptSeg(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

const orient = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

// Minimum distance in metres between segments ab and cd.
function segSegDist(a, b, c, d) {
  const ref = (a[0] + b[0] + c[0] + d[0]) / 4;
  const [A, B, C, D] = [a, b, c, d].map((p) => project(p, ref));
  if (orient(A, B, C) * orient(A, B, D) < 0 && orient(C, D, A) * orient(C, D, B) < 0) return 0;
  return Math.min(ptSeg(A, C, D), ptSeg(B, C, D), ptSeg(C, A, B), ptSeg(D, A, B));
}

function densify(route, stepM = 40) {
  const out = [route[0]];
  for (let i = 0; i < route.length - 1; i++) {
    const n = Math.max(1, Math.floor(haversine(route[i], route[i + 1]) / stepM));
    for (let k = 1; k <= n; k++) {
      const f = k / n;
      out.push([route[i][0] + (route[i + 1][0] - route[i][0]) * f, route[i][1] + (route[i + 1][1] - route[i][1]) * f]);
    }
  }
  return out;
}

function routeLength(route) {
  let s = 0;
  for (let i = 0; i < route.length - 1; i++) s += haversine(route[i], route[i + 1]);
  return s;
}

const BUFFER_M = 35;        // how close counts as "on" the road
const MIN_RUN_M = 120;      // how far the route must run along it to count as using it
const START_GRACE_M = 150;

function distToLine(p, line) {
  let best = Infinity;
  for (let k = 0; k < line.length - 1; k++) {
    const ref = (p[0] + line[k][0] + line[k + 1][0]) / 3;
    best = Math.min(best, ptSeg(project(p, ref), project(line[k], ref), project(line[k + 1], ref)));
  }
  return best;
}

// True if the route *uses* a closed road, i.e. runs along it for at least MIN_RUN_M (or 60% of a short closure).
// Merely crossing a closed road at a junction is fine, so it doesn't count. The first START_GRACE_M of the
// route are ignored so a volunteer already standing on a closed road can still leave it.
function pathBlocked(route, blocked, bufferM = BUFFER_M, graceM = START_GRACE_M, minRunM = MIN_RUN_M) {
  if (!blocked.length || route.length < 2) return false;
  const dense = densify(route, 20);
  let start = 0;
  while (start < dense.length && haversine(dense[0], dense[start]) <= graceM) start++;
  for (const road of blocked) {
    const line = road.coords || road;
    const need = Math.min(minRunM, 0.6 * routeLength(line));
    let run = 0;
    for (let j = Math.max(start, 1); j < dense.length; j++) {
      if (distToLine(dense[j], line) <= bufferM) {
        run += haversine(dense[j - 1], dense[j]);
        if (run >= need) return true;
      } else run = 0;
    }
  }
  return false;
}

// Point at `dist` metres along a route (uses precomputed segment lengths).
function pointAlong(coords, seg, dist) {
  for (let i = 0; i < seg.length; i++) {
    if (dist <= seg[i] || i === seg.length - 1) {
      const f = seg[i] === 0 ? 0 : Math.min(1, dist / seg[i]);
      return [coords[i][0] + (coords[i + 1][0] - coords[i][0]) * f, coords[i][1] + (coords[i + 1][1] - coords[i][1]) * f];
    }
    dist -= seg[i];
  }
  return coords[coords.length - 1];
}

module.exports = { haversine, segSegDist, densify, routeLength, pathBlocked, pointAlong, BUFFER_M };
