const { RAIN_MARKOV, RAIN_INTENSITY, STORM_CELL, IMD_RAINFALL_BANDS, MONSOON_MONTHS } = require("../config.cjs");
const { haversineKm, destinationPoint, clamp } = require("../util.cjs");

/**
 * A convective storm cell: a Gaussian intensity blob that drifts across the map.
 * Spatial coherence between neighbouring sensors is an emergent property of
 * sampling this field, rather than something imposed per node.
 */
class StormCell {
  constructor(rng, lat, lon, opts = {}) {
    this.rng = rng;
    this.lat = lat;
    this.lon = lon;
    this.radiusKm = opts.radiusKm ?? rng.uniform(STORM_CELL.minRadiusKm, STORM_CELL.maxRadiusKm);
    this.peakIntensity = opts.peakIntensity ?? rng.uniform(5, 45);
    this.bearingDeg =
      opts.bearingDeg ??
      STORM_CELL.bearingMonsoonDeg +
        rng.uniform(-STORM_CELL.bearingJitterDeg, STORM_CELL.bearingJitterDeg);

    // A minority of systems are quasi-stationary. These are the mechanism behind
    // India's extreme daily totals (Mumbai 2005, Chennai 2015): a cell that sits
    // over one catchment for hours accumulates far more than a fast-moving one,
    // regardless of peak intensity.
    this.stationary = opts.stationary ?? rng.bool(STORM_CELL.stationaryProbability);

    if (opts.speedKmh !== undefined) {
      this.speedKmh = opts.speedKmh;
    } else if (this.stationary) {
      this.speedKmh = rng.uniform(STORM_CELL.stationarySpeedMinKmh, STORM_CELL.stationarySpeedMaxKmh);
    } else {
      this.speedKmh = clamp(
        rng.lognormal(STORM_CELL.medianSpeedKmh, STORM_CELL.speedLnSigma),
        STORM_CELL.minSpeedKmh,
        STORM_CELL.maxSpeedKmh
      );
    }

    if (opts.lifetimeSec !== undefined) {
      this.lifetimeSec = opts.lifetimeSec;
    } else if (this.stationary) {
      this.lifetimeSec = rng.uniform(STORM_CELL.stationaryMinLifetimeSec, STORM_CELL.stationaryMaxLifetimeSec);
    } else {
      // Slower systems persist longer, so transit time and lifetime stay consistent.
      this.lifetimeSec = clamp(
        3600 * (50 / this.speedKmh) * rng.uniform(0.5, 1.2),
        STORM_CELL.minLifetimeSec,
        STORM_CELL.maxLifetimeSec
      );
    }
    this.ageSec = 0;
    this.scripted = Boolean(opts.scripted);
    this.id = opts.id || `cell-${Math.floor(rng.next() * 1e6).toString(36)}`;
  }

  get alive() {
    return this.ageSec < this.lifetimeSec;
  }

  /** Intensity ramps up and decays over the cell lifetime. */
  get envelope() {
    const t = clamp(this.ageSec / this.lifetimeSec, 0, 1);
    return Math.sin(Math.PI * t) ** 0.7;
  }

  tick(dtSec) {
    this.ageSec += dtSec;
    const distanceKm = (this.speedKmh * dtSec) / 3600;
    const moved = destinationPoint(this.lat, this.lon, this.bearingDeg, distanceKm);
    this.lat = moved.lat;
    this.lon = moved.lon;
  }

  intensityAt(lat, lon) {
    const d = haversineKm(this.lat, this.lon, lat, lon);
    const r = this.radiusKm;
    return this.peakIntensity * this.envelope * Math.exp(-(d * d) / (2 * r * r));
  }

  snapshot() {
    return {
      id: this.id,
      lat: Number(this.lat.toFixed(5)),
      lon: Number(this.lon.toFixed(5)),
      radiusKm: Number(this.radiusKm.toFixed(2)),
      intensity: Number((this.peakIntensity * this.envelope).toFixed(2)),
      bearingDeg: Number(this.bearingDeg.toFixed(1)),
      speedKmh: Number(this.speedKmh.toFixed(1)),
      stationary: this.stationary,
      ageSec: Math.round(this.ageSec),
      lifetimeSec: Math.round(this.lifetimeSec),
    };
  }
}

/**
 * The rainfall field over the whole simulated region: a wet/dry Markov state
 * controlling cell spawning, plus an AR-1 background intensity.
 */
class RainfallField {
  constructor(rng, bounds, opts = {}) {
    this.rng = rng;
    this.bounds = bounds;
    this.cells = [];
    this.wet = false;
    this.lnBackground = Math.log(0.05);
    this.extremeMode = false;
    this.spawnMultiplier = opts.spawnMultiplier ?? 1;
    this.secondsSinceMarkovStep = 0;
    this.markovStepSec = 600;
    // Published transition probabilities are DAILY. Applying them directly at a
    // 10-minute step would make wet spells ~144x too short-lived, so they are
    // rescaled to the step length through the chain's second eigenvalue below.
    // Start from the chain's stationary distribution rather than always dry,
    // otherwise a short monsoon scenario can spend its whole run spinning up.
    const startMonsoon = opts.startDate ? this.isMonsoon(new Date(opts.startDate)) : true;
    this.wet = this.rng.bool(this._stationaryWetProbability(startMonsoon));
  }

  _chainParams(monsoon) {
    const p = monsoon ? RAIN_MARKOV.monsoon : RAIN_MARKOV.nonMonsoon;
    const pWetGivenDry = p.wetGivenDry;
    const pDryGivenWet = 1 - p.wetGivenWet;
    return { pWetGivenDry, pDryGivenWet, lambda: p.wetGivenWet - p.wetGivenDry };
  }

  _stationaryWetProbability(monsoon) {
    const { pWetGivenDry, pDryGivenWet } = this._chainParams(monsoon);
    return pWetGivenDry / (pWetGivenDry + pDryGivenWet);
  }

  /** Daily transition probabilities raised to a fractional-day step. */
  _scaledTransition(monsoon, stepDays) {
    const { lambda } = this._chainParams(monsoon);
    const piWet = this._stationaryWetProbability(monsoon);
    const decay = Math.pow(Math.max(lambda, 1e-6), stepDays);
    return {
      wetGivenWet: piWet + (1 - piWet) * decay,
      wetGivenDry: piWet * (1 - decay),
    };
  }

  isMonsoon(date) {
    return MONSOON_MONTHS.includes(date.getUTCMonth());
  }

  diurnalFactor(date) {
    const h = date.getUTCHours() + date.getUTCMinutes() / 60 + 5.5; // IST
    const main =
      1 +
      RAIN_INTENSITY.diurnalAmplitude *
        Math.cos((2 * Math.PI * (h - RAIN_INTENSITY.diurnalPeakHour)) / 24);
    const preDawn =
      RAIN_INTENSITY.preDawnAmplitude *
      Math.exp(-(((h - RAIN_INTENSITY.preDawnPeakHour) / 2) ** 2));
    return clamp(main + preDawn, 0.2, 2.0);
  }

  _markovStep(date) {
    const p = this._scaledTransition(this.isMonsoon(date), this.markovStepSec / 86400);
    this.wet = this.rng.bool(this.wet ? p.wetGivenWet : p.wetGivenDry);
  }

  _spawnCell(date) {
    const { minLat, maxLat, minLon, maxLon } = this.bounds;
    // Cells enter from the upwind (SW) edge so they traverse the region.
    const lat = this.rng.uniform(minLat - 0.05, maxLat - (maxLat - minLat) * 0.3);
    const lon = this.rng.uniform(minLon - 0.05, maxLon - (maxLon - minLon) * 0.3);
    const monsoon = this.isMonsoon(date);
    const scale = this.extremeMode
      ? RAIN_INTENSITY.scaleExtreme
      : monsoon
        ? RAIN_INTENSITY.scaleMonsoon
        : RAIN_INTENSITY.scaleNonMonsoon;
    const peak = clamp(
      this.rng.gamma(RAIN_INTENSITY.shape, scale) * STORM_CELL.peakIntensityScale,
      1,
      180
    );
    this.cells.push(new StormCell(this.rng, lat, lon, { peakIntensity: peak }));
  }

  /** Scenario hook: inject a deterministic storm (used by replay scenarios). */
  injectCell(lat, lon, opts = {}) {
    const cell = new StormCell(this.rng, lat, lon, { ...opts, scripted: true });
    this.cells.push(cell);
    return cell;
  }

  setExtremeMode(on) {
    this.extremeMode = Boolean(on);
  }

  tick(dtSec, date) {
    this.secondsSinceMarkovStep += dtSec;
    while (this.secondsSinceMarkovStep >= this.markovStepSec) {
      this.secondsSinceMarkovStep -= this.markovStepSec;
      this._markovStep(date);
    }

    const rho = RAIN_INTENSITY.ar1Rho;
    // Background drizzle only; storm cells supply the accumulation that matters.
    const target = Math.log(this.wet ? 0.35 : 0.015);
    this.lnBackground =
      rho * this.lnBackground + (1 - rho) * target + this.rng.gaussian(0, RAIN_INTENSITY.lnSigma * (1 - rho));

    for (const c of this.cells) c.tick(dtSec);
    this.cells = this.cells.filter((c) => c.alive);

    const capacity = Math.ceil(
      STORM_CELL.maxConcurrent * this.spawnMultiplier * (this.extremeMode ? 1.5 : 1)
    );
    if (this.wet && this.cells.length < capacity) {
      const interval = this.extremeMode
        ? STORM_CELL.spawnIntervalSecExtreme
        : STORM_CELL.spawnIntervalSecWet;
      const spawnRatePerSec = (1 / interval) * this.spawnMultiplier;
      if (this.rng.next() < spawnRatePerSec * dtSec) this._spawnCell(date);
    }
  }

  /** Instantaneous rainfall intensity (mm/h) at a point. */
  intensityAt(lat, lon, date) {
    let sum = 0;
    for (const c of this.cells) sum += c.intensityAt(lat, lon);
    const background = Math.exp(this.lnBackground);
    return Math.max(0, (sum + background) * this.diurnalFactor(date));
  }

  snapshot() {
    return {
      wet: this.wet,
      extremeMode: this.extremeMode,
      backgroundMmHr: Number(Math.exp(this.lnBackground).toFixed(3)),
      cells: this.cells.map((c) => c.snapshot()),
    };
  }
}

/**
 * IMD 24-hour accumulation band. Matched on upper bounds in ascending order so
 * the lookup is gapless — testing both bounds leaves values in the rounding gaps
 * between published bands unclassified.
 */
function classifyImd(mm24h) {
  for (const band of IMD_RAINFALL_BANDS) {
    if (mm24h <= band.max) return band.name;
  }
  return IMD_RAINFALL_BANDS[IMD_RAINFALL_BANDS.length - 1].name;
}

module.exports = { StormCell, RainfallField, classifyImd };
