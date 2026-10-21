// Simulation of volunteers carrying casualties to hospitals.
//
// A volunteer is paired with the nearest waiting casualty, picks them up, and a *strategy* decides which
// hospital to take them to:
//   nearest - the original rule: closest hospital by straight-line distance, first one with a clear route
//   aware   - lowest (drive time + expected wait for a bed), re-evaluated while driving
// Everything else (pairing, movement, hospital treatment) is identical, so any difference in outcome comes
// from the destination decision alone.
const { haversine, pathBlocked, pointAlong } = require('./geo');

const DEFAULT_BEDS = [3, 4, 3, 3, 4];
const mins = (s) => `${(s / 60).toFixed(1)} min`;

function makeRoute(r) {
  const seg = [];
  for (let i = 0; i < r.coords.length - 1; i++) seg.push(haversine(r.coords[i], r.coords[i + 1]));
  const total = seg.reduce((a, b) => a + b, 0);
  return { coords: r.coords, seg, total, progress: 0, duration: r.duration, distance: r.distance,
    speed: total / Math.max(r.duration, 1), safe: r.safe, note: r.note };
}

class World {
  constructor({ hospitals, volunteers, blocked = [], router, strategy = 'aware', treatSec = 300, rebalanceSec = 15 }) {
    this.router = router;
    this.treatSec = treatSec;
    this.rebalanceSec = rebalanceSec;
    this.strategyName = strategy;
    this.t = 0;
    this.hospitals = hospitals.map((h, i) => ({
      id: h.id, name: h.name, lat: h.lat, lng: h.lng, beds: h.beds || DEFAULT_BEDS[i % DEFAULT_BEDS.length],
      busy: [], queue: [], arrivals: 0, treated: 0, peakQueue: 0,
    }));
    this.volunteers = volunteers.map((v) => ({ id: v.id, name: v.name, lat: v.lat, lng: v.lng, status: 'idle',
      casualtyId: null, hospitalId: null, route: null, delivered: 0, lastReview: 0 }));
    this.blocked = blocked.map((b) => ({ id: b.id, coords: b.coords }));
    this.blockedVersion = 0;
    this.routeVersion = new Map();
    this.casualties = [];
    this.events = [];
    this.counters = { queuedArrivals: 0, diversions: 0, reroutes: 0, unsafeRoutes: 0 };
    this._cn = 0;
  }

  log(text) { this.events.unshift({ t: this.t, text }); this.events.length = Math.min(this.events.length, 60); }
  setStrategy(name) { this.strategyName = name === 'nearest' ? 'nearest' : 'aware'; }

  // ----- inputs -----
  addCasualty(lat, lng) {
    const c = { id: `C${++this._cn}`, lat, lng, t0: this.t, status: 'waiting', volunteerId: null, hospitalId: null,
      tPickup: null, tArrive: null, tBed: null, tDone: null };
    this.casualties.push(c);
    return c;
  }
  addBlocked(id, coords) { this.blocked.push({ id, coords }); this.blockedVersion++; this.log(`Road ${id} closed`); }
  removeBlocked(id) {
    this.blocked = this.blocked.filter((b) => b.id !== id);
    this.blockedVersion++;
    this.log(`Road ${id} reopened`);
  }

  // ----- hospital capacity model -----
  // When would a patient arriving at `arriveAt` get a bed? Accounts for patients already queued and for
  // other volunteers already driving there (except `exclude`).
  bedStart(h, arriveAt, exclude = null) {
    const free = h.busy.map((b) => b.until);
    while (free.length < h.beds) free.push(0);
    const take = (readyAt) => {
      let k = 0;
      for (let i = 1; i < free.length; i++) if (free[i] < free[k]) k = i;
      const start = Math.max(free[k], readyAt);
      free[k] = start + this.treatSec;
      return start;
    };
    for (let i = 0; i < h.queue.length; i++) take(this.t);
    const inbound = this.volunteers
      .filter((v) => v.status === 'to_hospital' && v.hospitalId === h.id && v !== exclude && v.route)
      .map((v) => this.t + (v.route.total - v.route.progress) / v.route.speed)
      .filter((eta) => eta <= arriveAt)
      .sort((a, b) => a - b);
    inbound.forEach(take);
    return take(arriveAt);
  }

  inboundCount(h) { return this.volunteers.filter((v) => v.status === 'to_hospital' && v.hospitalId === h.id).length; }
  remainingRoute(v) {
    const r = v.route;
    let d = r.progress, i = 0;
    while (i < r.seg.length - 1 && d > r.seg[i]) { d -= r.seg[i]; i++; }
    return [[v.lat, v.lng], ...r.coords.slice(i + 1)];
  }

  // ----- strategies: return {hospital, route, reason} -----
  async chooseNearest(vol) {
    const origin = [vol.lat, vol.lng];
    const sorted = [...this.hospitals].sort((a, b) => haversine(origin, [a.lat, a.lng]) - haversine(origin, [b.lat, b.lng]));
    let firstRoute = null;
    for (const h of sorted) {
      const route = await this.router.route(origin, [h.lat, h.lng], this.blocked);
      firstRoute = firstRoute || { h, route };
      if (route.safe) return { hospital: h, route, reason: `${h.name}: nearest hospital${h === sorted[0] ? '' : ' with a clear road'}` };
    }
    return { hospital: firstRoute.h, route: firstRoute.route, reason: `${firstRoute.h.name}: nearest (no clear road found)` };
  }

  async chooseAware(vol, exclude = vol) {
    const origin = [vol.lat, vol.lng];
    const dur = await this.router.durations(origin, this.hospitals.map((h) => [h.lat, h.lng]));
    const scored = this.hospitals.map((h, i) => {
      const arrive = this.t + dur[i];
      const wait = this.bedStart(h, arrive, exclude) - arrive;
      return { h, drive: dur[i], wait, score: dur[i] + wait };
    }).sort((a, b) => a.score - b.score);
    const nearest = [...this.hospitals].sort((a, b) => haversine(origin, [a.lat, a.lng]) - haversine(origin, [b.lat, b.lng]))[0];
    for (const c of scored) {
      const route = await this.router.route(origin, [c.h.lat, c.h.lng], this.blocked);
      if (!route.safe) continue;
      let why = `${c.h.name}: ${mins(route.duration)} drive + ${mins(c.wait)} wait`;
      if (c.h !== nearest) {
        const n = scored.find((s) => s.h === nearest);
        why += ` (nearest, ${nearest.name}, would be ${mins(n.drive)} + ${mins(n.wait)} wait)`;
      }
      return { hospital: c.h, route, reason: why, score: c.score };
    }
    const c = scored[0];
    const route = await this.router.route(origin, [c.h.lat, c.h.lng], this.blocked);
    return { hospital: c.h, route, reason: `${c.h.name}: no clear road to any hospital`, score: c.score };
  }

  choose(vol) { return this.strategyName === 'nearest' ? this.chooseNearest(vol) : this.chooseAware(vol); }

  // ----- actions -----
  setRoute(vol, route) {
    vol.route = makeRoute(route);
    this.routeVersion.set(vol.id, this.blockedVersion);
    if (!route.safe) this.counters.unsafeRoutes++;
  }

  async sendToHospital(vol, casualty) {
    const c = await this.choose(vol);
    casualty.hospitalId = c.hospital.id;
    vol.hospitalId = c.hospital.id;
    vol.status = 'to_hospital';
    this.setRoute(vol, c.route);
    vol.decision = c.reason;
    this.log(`${vol.name} -> ${c.reason}`);
  }

  async dispatchIdle() {
    const waiting = this.casualties.filter((c) => c.status === 'waiting');
    for (const c of waiting) {
      const idle = this.volunteers.filter((v) => v.status === 'idle');
      if (!idle.length) return;
      const vol = idle.reduce((a, b) => (haversine([a.lat, a.lng], [c.lat, c.lng]) <= haversine([b.lat, b.lng], [c.lat, c.lng]) ? a : b));
      const r = await this.router.route([vol.lat, vol.lng], [c.lat, c.lng], this.blocked);
      c.status = 'assigned';
      c.volunteerId = vol.id;
      vol.status = 'to_casualty';
      vol.casualtyId = c.id;
      vol.hospitalId = null;
      this.setRoute(vol, r);
    }
  }

  arriveHospital(vol) {
    const h = this.hospitals.find((x) => x.id === vol.hospitalId);
    const c = this.casualties.find((x) => x.id === vol.casualtyId);
    c.tArrive = this.t;
    h.arrivals++;
    if (h.busy.length < h.beds) {
      h.busy.push({ until: this.t + this.treatSec, id: c.id });
      c.status = 'treating';
      c.tBed = this.t;
    } else {
      h.queue.push(c);
      c.status = 'queued';
      this.counters.queuedArrivals++;
      h.peakQueue = Math.max(h.peakQueue, h.queue.length);
      this.log(`${h.name} full - ${c.id} waits (${h.queue.length} in queue)`);
    }
    vol.delivered++;
    vol.status = 'idle';
    vol.route = null;
    vol.casualtyId = null;
    vol.hospitalId = null;
    vol.lat = h.lat;
    vol.lng = h.lng;
  }

  tickHospitals() {
    for (const h of this.hospitals) {
      for (;;) {
        const done = h.busy.findIndex((b) => b.until <= this.t);
        if (done < 0) break;
        const b = h.busy.splice(done, 1)[0];
        const cas = this.casualties.find((x) => x.id === b.id);
        cas.status = 'treated';
        cas.tDone = b.until;
        h.treated++;
        if (h.queue.length) {
          const next = h.queue.shift();
          next.status = 'treating';
          next.tBed = b.until;
          h.busy.push({ until: b.until + this.treatSec, id: next.id });
        }
      }
    }
  }

  // Re-plan volunteers whose remaining route now crosses a closed road; let aware strategy divert when another
  // hospital has become clearly better.
  async replan() {
    for (const vol of this.volunteers) {
      if (!vol.route || (vol.status !== 'to_hospital' && vol.status !== 'to_casualty')) continue;
      const stale = this.routeVersion.get(vol.id) !== this.blockedVersion;
      if (stale) {
        this.routeVersion.set(vol.id, this.blockedVersion);
        if (pathBlocked(this.remainingRoute(vol), this.blocked)) {
          const was = vol.hospitalId;
          if (vol.status === 'to_hospital') {
            const c = await this.choose(vol);
            vol.hospitalId = c.hospital.id;
            this.casualties.find((x) => x.id === vol.casualtyId).hospitalId = c.hospital.id;
            this.setRoute(vol, c.route);
            vol.decision = c.reason;
            this.log(`${vol.name} re-planned: road closed ahead${was !== c.hospital.id ? ' - ' + c.reason : ''}`);
          } else {
            const cas = this.casualties.find((x) => x.id === vol.casualtyId);
            this.setRoute(vol, await this.router.route([vol.lat, vol.lng], [cas.lat, cas.lng], this.blocked));
            this.log(`${vol.name} re-planned route to ${cas.id}: road closed ahead`);
          }
          this.counters.reroutes++;
        }
      }
      if (this.strategyName === 'aware' && vol.status === 'to_hospital' && this.t - vol.lastReview >= this.rebalanceSec) {
        vol.lastReview = this.t;
        const remaining = (vol.route.total - vol.route.progress) / vol.route.speed;
        if (remaining < 90) continue;
        const cur = this.hospitals.find((h) => h.id === vol.hospitalId);
        const curScore = remaining + this.bedStart(cur, this.t + remaining, vol) - (this.t + remaining);
        const best = await this.chooseAware(vol, vol);
        if (best.hospital.id !== cur.id && best.score + Math.max(60, 0.15 * curScore) < curScore) {
          vol.hospitalId = best.hospital.id;
          this.casualties.find((x) => x.id === vol.casualtyId).hospitalId = best.hospital.id;
          this.setRoute(vol, best.route);
          vol.decision = best.reason;
          this.counters.diversions++;
          this.log(`${vol.name} diverted from ${cur.name}: ${best.reason}`);
        }
      }
    }
  }

  async step(dt) {
    this.t += dt;
    this.tickHospitals();
    const arrived = [];
    for (const v of this.volunteers) {
      if (!v.route) continue;
      v.route.progress = Math.min(v.route.total, v.route.progress + v.route.speed * dt);
      [v.lat, v.lng] = pointAlong(v.route.coords, v.route.seg, v.route.progress);
      if (v.route.progress >= v.route.total) arrived.push(v);
    }
    for (const v of arrived) {
      if (v.status === 'to_casualty') {
        const c = this.casualties.find((x) => x.id === v.casualtyId);
        c.status = 'carried';
        c.tPickup = this.t;
        await this.sendToHospital(v, c);
      } else if (v.status === 'to_hospital') {
        this.arriveHospital(v);
      }
    }
    await this.replan();
    await this.dispatchIdle();
    this.tickHospitals();
  }

  done() { return this.casualties.length > 0 && this.casualties.every((c) => c.status === 'treated'); }

  // ----- reporting -----
  metrics() {
    const treated = this.casualties.filter((c) => c.tBed != null);
    const waits = treated.map((c) => c.tBed - c.t0).sort((a, b) => a - b);
    const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
    const hospWait = treated.map((c) => c.tBed - c.tArrive);
    const arrivals = this.hospitals.map((h) => h.arrivals);
    const total = arrivals.reduce((a, b) => a + b, 0);
    return {
      casualties: this.casualties.length,
      reachedBed: treated.length,
      treated: this.casualties.filter((c) => c.status === 'treated').length,
      avgToBed: avg(waits),
      p90ToBed: waits.length ? waits[Math.min(waits.length - 1, Math.floor(0.9 * waits.length))] : 0,
      maxToBed: waits.length ? waits[waits.length - 1] : 0,
      avgWaitAtHospital: avg(hospWait),
      queuedArrivals: this.counters.queuedArrivals,
      peakQueue: Math.max(0, ...this.hospitals.map((h) => h.peakQueue)),
      busiestShare: total ? Math.max(...arrivals) / total : 0,
      diversions: this.counters.diversions,
      reroutes: this.counters.reroutes,
      unsafeRoutes: this.counters.unsafeRoutes,
    };
  }

  snapshot() {
    const routes = {};
    for (const v of this.volunteers) {
      if (v.route) routes[v.id] = { coords: this.remainingRoute(v).map((p) => [+p[0].toFixed(5), +p[1].toFixed(5)]),
        safe: v.route.safe, note: v.route.note, etaSec: Math.round((v.route.total - v.route.progress) / v.route.speed) };
    }
    return {
      t: this.t, strategy: this.strategyName, metrics: this.metrics(), routes, blocked: this.blocked,
      hospitals: this.hospitals.map((h) => ({ id: h.id, name: h.name, lat: h.lat, lng: h.lng, beds: h.beds,
        busy: h.busy.length, queue: h.queue.length, inbound: this.inboundCount(h), treated: h.treated, peakQueue: h.peakQueue })),
      volunteers: this.volunteers.map((v) => ({ id: v.id, name: v.name, lat: v.lat, lng: v.lng, status: v.status,
        hospitalId: v.hospitalId, casualtyId: v.casualtyId, decision: v.decision || null, delivered: v.delivered })),
      casualties: this.casualties.filter((c) => c.status !== 'treated').map((c) => ({ id: c.id, lat: c.lat, lng: c.lng, status: c.status })),
      events: this.events.slice(0, 30),
    };
  }
}

module.exports = { World, DEFAULT_BEDS };
