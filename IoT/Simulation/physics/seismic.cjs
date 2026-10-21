const { SEISMIC } = require("../config.cjs");
const { haversineKm, clamp } = require("../util.cjs");

/**
 * A single earthquake. Ground motion at a station is time-dependent: the P wave
 * arrives first at 6.0 km/s, the S wave at 3.5 km/s, and the gap between them is
 * the early-warning window a real EEW system exploits.
 */
class SeismicEvent {
  constructor(opts) {
    this.id = opts.id;
    this.lat = opts.lat;
    this.lon = opts.lon;
    this.depthKm = opts.depthKm ?? 12;
    this.magnitude = opts.magnitude;
    this.originSimSec = opts.originSimSec;
    this.isAftershock = Boolean(opts.isAftershock);
    this.parentId = opts.parentId || null;
    // Shaking duration grows with magnitude.
    this.durationSec = clamp(2 + Math.pow(10, 0.4 * (this.magnitude - 3)), 2, 180);
  }

  hypocentralDistanceKm(lat, lon) {
    const epi = haversineKm(this.lat, this.lon, lat, lon);
    return Math.sqrt(epi * epi + this.depthKm * this.depthKm);
  }

  /** Peak ground acceleration (g) via a simple attenuation relation. */
  pgaAt(lat, lon) {
    const r = this.hypocentralDistanceKm(lat, lon);
    const logPga =
      SEISMIC.gmpeC1 + SEISMIC.gmpeC2 * this.magnitude - SEISMIC.gmpeC3 * Math.log10(r + 10);
    return Math.max(0, Math.pow(10, logPga));
  }

  arrivalTimes(lat, lon) {
    const r = this.hypocentralDistanceKm(lat, lon);
    return {
      distanceKm: r,
      pSec: this.originSimSec + r / SEISMIC.pVelocityKmS,
      sSec: this.originSimSec + r / SEISMIC.sVelocityKmS,
      warningWindowSec: r / SEISMIC.sVelocityKmS - r / SEISMIC.pVelocityKmS,
    };
  }

  /**
   * Acceleration envelope at a station: zero before the P arrival, ~30% of peak
   * between P and S, full amplitude after S, then decay.
   *
   * The decay is stretched over SEISMIC.telemetryHoldSec rather than the true
   * few-second shaking duration. Real shaking is far shorter than one simulation
   * tick at 30-300x speed, so a literal waveform would be sampled as zero almost
   * every time. Holding the envelope keeps the PEAK value faithful (which is what
   * a station actually reports) while remaining observable at coarse tick rates.
   * Wave ARRIVAL times are computed analytically in arrivalTimes(), so early-
   * warning lead times are unaffected by this.
   */
  accelerationAt(lat, lon, simSec) {
    const { pSec, sSec } = this.arrivalTimes(lat, lon);
    if (simSec < pSec) return 0;
    const peak = this.pgaAt(lat, lon);
    if (simSec < sSec) return peak * 0.3;
    const elapsed = simSec - sSec;
    const window = Math.max(this.durationSec, SEISMIC.telemetryHoldSec);
    if (elapsed > window) return 0;
    return peak * Math.exp(-3 * (elapsed / window));
  }

  /** True instantaneous ground motion, with no telemetry hold applied. */
  trueAccelerationAt(lat, lon, simSec) {
    const { pSec, sSec } = this.arrivalTimes(lat, lon);
    if (simSec < pSec) return 0;
    const peak = this.pgaAt(lat, lon);
    if (simSec < sSec) return peak * 0.3;
    const elapsed = simSec - sSec;
    if (elapsed > this.durationSec) return 0;
    return peak * Math.exp(-3 * (elapsed / this.durationSec));
  }

  snapshot() {
    return {
      id: this.id,
      lat: Number(this.lat.toFixed(4)),
      lon: Number(this.lon.toFixed(4)),
      depthKm: Number(this.depthKm.toFixed(1)),
      magnitude: Number(this.magnitude.toFixed(2)),
      isAftershock: this.isAftershock,
      parentId: this.parentId,
      durationSec: Number(this.durationSec.toFixed(1)),
    };
  }
}

/**
 * Background seismicity following Gutenberg-Richter, with Omori-law aftershock
 * sequences and Bath's law capping the largest aftershock.
 */
class SeismicCatalogue {
  constructor(rng, bounds, opts = {}) {
    this.rng = rng;
    this.bounds = bounds;
    this.events = [];
    this.pending = [];
    this.newEvents = [];
    this.nextId = 1;
    // Expected mainshocks per day above minMagnitude, from the GR a-value.
    this.ratePerDay =
      opts.ratePerDay ??
      Math.pow(10, SEISMIC.gutenbergAZoneV - SEISMIC.gutenbergB * SEISMIC.minMagnitude);
    this.simSec = 0;
  }

  _randomEpicentre() {
    const { minLat, maxLat, minLon, maxLon } = this.bounds;
    return {
      lat: this.rng.uniform(minLat - 0.3, maxLat + 0.3),
      lon: this.rng.uniform(minLon - 0.3, maxLon + 0.3),
    };
  }

  /** Schedule an Omori-distributed aftershock sequence for a mainshock. */
  _scheduleAftershocks(main) {
    const count = Math.max(0, Math.round(Math.pow(10, main.magnitude - 4.2)));
    const maxAftershockMag = main.magnitude - SEISMIC.bathDelta;
    if (maxAftershockMag < SEISMIC.minMagnitude) return;

    for (let k = 0; k < count; k++) {
      // Inverse-transform the Omori decay n(t) = K/(t+c)^p for p != 1.
      const u = this.rng.next();
      const c = SEISMIC.omoriCDays;
      const p = SEISMIC.omoriP;
      const tDays = Math.pow(Math.pow(c, 1 - p) * (1 - u), 1 / (1 - p)) - c;
      const delaySec = clamp(tDays * 86400, 10, 30 * 86400);
      const mag = this.rng.grMagnitude(SEISMIC.gutenbergB, SEISMIC.minMagnitude, maxAftershockMag);
      this.pending.push({
        atSimSec: main.originSimSec + delaySec,
        lat: main.lat + this.rng.gaussian(0, 0.08),
        lon: main.lon + this.rng.gaussian(0, 0.08),
        depthKm: clamp(main.depthKm + this.rng.gaussian(0, 3), 3, 60),
        magnitude: mag,
        isAftershock: true,
        parentId: main.id,
      });
    }
  }

  /** Scenario hook: trigger a specific earthquake now. */
  inject(opts = {}) {
    const epi = opts.lat !== undefined ? { lat: opts.lat, lon: opts.lon } : this._randomEpicentre();
    const event = new SeismicEvent({
      id: `eq-${this.nextId++}`,
      lat: epi.lat,
      lon: epi.lon,
      depthKm: opts.depthKm ?? this.rng.uniform(8, 35),
      magnitude: opts.magnitude ?? this.rng.grMagnitude(SEISMIC.gutenbergB, SEISMIC.minMagnitude, SEISMIC.maxMagnitude),
      originSimSec: this.simSec,
      isAftershock: Boolean(opts.isAftershock),
      parentId: opts.parentId || null,
    });
    this.events.push(event);
    if (!this.newEvents) this.newEvents = [];
    this.newEvents.push(event);
    if (!event.isAftershock && event.magnitude >= 4.5) this._scheduleAftershocks(event);
    return event;
  }

  tick(dtSec) {
    this.simSec += dtSec;
    // newEvents is NOT cleared here: scenario-injected quakes are applied after
    // the world tick, so clearing here would discard them before the early-
    // warning evaluation ever sees them. The consumer drains the queue instead.
    const lambda = (this.ratePerDay / 86400) * dtSec;
    if (this.rng.next() < lambda) this.inject();

    const due = this.pending.filter((p) => p.atSimSec <= this.simSec);
    if (due.length) {
      this.pending = this.pending.filter((p) => p.atSimSec > this.simSec);
      for (const d of due) {
        const event = new SeismicEvent({
          id: `eq-${this.nextId++}`,
          lat: d.lat,
          lon: d.lon,
          depthKm: d.depthKm,
          magnitude: d.magnitude,
          originSimSec: this.simSec,
          isAftershock: true,
          parentId: d.parentId,
        });
        this.events.push(event);
        this.newEvents.push(event);
      }
    }

    // Retire events whose shaking has passed everywhere in the region.
    this.events = this.events.filter((e) => this.simSec - e.originSimSec < e.durationSec + 600);
  }

  accelerationAt(lat, lon) {
    let total = 0;
    for (const e of this.events) total += e.accelerationAt(lat, lon, this.simSec);
    return total;
  }

  /** Events currently producing motion anywhere, for dashboards and EEW displays. */
  activeEvents(lat, lon) {
    return this.events
      .map((e) => {
        const arr = e.arrivalTimes(lat, lon);
        return {
          ...e.snapshot(),
          distanceKm: Number(arr.distanceKm.toFixed(1)),
          warningWindowSec: Number(arr.warningWindowSec.toFixed(2)),
          pArrived: this.simSec >= arr.pSec,
          sArrived: this.simSec >= arr.sSec,
          pgaG: Number(e.pgaAt(lat, lon).toFixed(5)),
        };
      })
      .filter((e) => e.pArrived);
  }
}

/**
 * STA/LTA trigger: the standard way a seismic station decides an event has begun,
 * by comparing short-term to long-term average amplitude.
 */
class StaLtaDetector {
  constructor(opts = {}) {
    this.sta = 0;
    this.lta = opts.initialLta ?? 0.004;
    this.staWindow = opts.staWindowSec ?? SEISMIC.staWindowSec;
    this.ltaWindow = opts.ltaWindowSec ?? SEISMIC.ltaWindowSec;
    this.triggered = false;
    this.ratio = 1;
  }

  update(amplitude, dtSec) {
    const absAmp = Math.abs(amplitude);
    const aSta = Math.min(1, dtSec / this.staWindow);
    const aLta = Math.min(1, dtSec / this.ltaWindow);
    this.sta += (absAmp - this.sta) * aSta;
    // Freezing the LTA while triggered stops the event from raising its own baseline.
    if (!this.triggered) this.lta += (absAmp - this.lta) * aLta;
    this.lta = Math.max(1e-6, this.lta);
    this.ratio = this.sta / this.lta;

    if (!this.triggered && this.ratio >= SEISMIC.triggerRatio) this.triggered = true;
    else if (this.triggered && this.ratio <= SEISMIC.detriggerRatio) this.triggered = false;

    return this.triggered;
  }
}

/**
 * Earthquake early warning, simulated honestly.
 *
 * STA/LTA needs sub-second samples, but the main loop ticks at 20-300 simulated
 * seconds. So when an event occurs we run a short burst simulation of the
 * station's real 100 Hz accelerometer stream across the P-to-S window and run the
 * detector on that. The result is a genuine detection time and therefore a
 * genuine warning lead time, rather than an assumed one.
 */
function simulateEewDetection(event, lat, lon, rng, opts = {}) {
  const sampleRateHz = opts.sampleRateHz ?? 100;
  const noiseG = opts.noiseG ?? 0.0015;
  const dominantHz = opts.dominantHz ?? 3;
  const dt = 1 / sampleRateHz;

  const { pSec, sSec, distanceKm, warningWindowSec } = event.arrivalTimes(lat, lon);
  const detector = new StaLtaDetector({ initialLta: noiseG });

  // Begin a few seconds before the P arrival so the LTA settles on real noise.
  const startSec = pSec - 5;
  const endSec = sSec + 3;
  let detectedAtSec = null;

  for (let t = startSec; t <= endSec; t += dt) {
    const envelope = event.trueAccelerationAt(lat, lon, t);
    const oscillation = Math.sin(2 * Math.PI * dominantHz * (t - startSec));
    const sample = envelope * oscillation + rng.gaussian(0, noiseG);
    if (detector.update(sample, dt) && detectedAtSec === null) {
      detectedAtSec = t;
      break;
    }
  }

  const leadTimeSec = detectedAtSec === null ? 0 : Math.max(0, sSec - detectedAtSec);
  return {
    eventId: event.id,
    magnitude: Number(event.magnitude.toFixed(2)),
    distanceKm: Number(distanceKm.toFixed(1)),
    pgaG: Number(event.pgaAt(lat, lon).toFixed(5)),
    detected: detectedAtSec !== null,
    detectedAtSimSec: detectedAtSec,
    detectionDelaySec: detectedAtSec === null ? null : Number((detectedAtSec - pSec).toFixed(3)),
    // Warning available at the detecting station itself. Stations close to the
    // epicentre are inside the EEW "blind zone" and get very little.
    leadTimeSec: Number(leadTimeSec.toFixed(2)),
    theoreticalMaxLeadSec: Number(warningWindowSec.toFixed(2)),
  };
}

/**
 * Warning time available to targets at a distance, given when the network
 * actually detected the event. This is the number that matters operationally:
 * detection happens near the epicentre, but the alert protects places further
 * away, which the S wave has not yet reached.
 */
function leadTimesForTargets(event, detectionAbsSec, distancesKm = [20, 50, 100, 200]) {
  if (detectionAbsSec === null || detectionAbsSec === undefined) return [];
  return distancesKm.map((d) => {
    const sArrival = event.originSimSec + d / SEISMIC.sVelocityKmS;
    return {
      distanceKm: d,
      leadTimeSec: Number(Math.max(0, sArrival - detectionAbsSec).toFixed(2)),
    };
  });
}

module.exports = {
  SeismicEvent,
  SeismicCatalogue,
  StaLtaDetector,
  simulateEewDetection,
  leadTimesForTargets,
};
