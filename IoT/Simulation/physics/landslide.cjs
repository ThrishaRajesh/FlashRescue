const { LANDSLIDE, LANDSLIDE_ID_THRESHOLDS } = require("../config.cjs");
const { clamp } = require("../util.cjs");

const DURATIONS_HOURS = [1, 3, 6, 12, 24, 48];
// Below this the rain is drizzle, not a triggering event; counting it would
// stretch "events" across entire wet spells and distort the I-D ratio.
const RAIN_EVENT_THRESHOLD_MM_HR = 1.0;
const EVENT_BREAK_HOURS = 6; // dry gap that ends a rainfall event
const MIN_EVENT_HOURS = 0.5;
const FAILURE_EXCEEDANCE = 1.3;
const FAILURE_PORE_PRESSURE = 0.65;
const FAILURE_RELAX_HOURS = 8;
// A slope that has just failed has shed its unstable material, so it cannot
// immediately fail again even while the rain continues.
const FAILURE_COOLDOWN_HOURS = 24;

/** Published regional threshold I = alpha * D^beta (I mm/h, D hours). */
function thresholdIntensity(region, durationHours) {
  const t = LANDSLIDE_ID_THRESHOLDS[region] || LANDSLIDE_ID_THRESHOLDS.NE_HIMALAYA;
  return t.alpha * Math.pow(durationHours, t.beta);
}

/**
 * A slope unit tracking antecedent wetness and rainfall intensity-duration
 * exceedance. Failure needs both: a saturated slope and a rain burst that
 * crosses the published regional I-D curve.
 */
class SlopeUnit {
  constructor(opts) {
    this.id = opts.id;
    this.lat = opts.lat;
    this.lon = opts.lon;
    this.region = opts.region || "NE_HIMALAYA";
    this.slopeDeg = opts.slopeDeg ?? 28;
    this.soilDepthM = opts.soilDepthM ?? 2.5;

    this.apiMm = opts.initialApiMm ?? 20;
    this.poreePressure = 0;
    this.tiltDeg = 0;
    this.creepDegPerHour = opts.creepDegPerHour ?? 0;

    // Published I-D curves describe a single continuous rainfall EVENT, so we
    // track one rather than averaging over fixed windows (which would count dry
    // spells as part of the storm and over-trigger).
    this.eventRainMm = 0;
    this.eventDurationH = 0;
    this.dryGapH = 0;
    this.lastExceedance = 0;
    this.criticalDurationH = null;

    this.failureActive = false;
    this.failureCount = 0;
    this.failureAgeH = 0;
    this.cooldownRemainingH = 0;
  }

  _updateEvent(rainMmHr, dtHours) {
    if (rainMmHr >= RAIN_EVENT_THRESHOLD_MM_HR) {
      this.eventRainMm += rainMmHr * dtHours;
      this.eventDurationH += dtHours;
      this.dryGapH = 0;
    } else {
      this.dryGapH += dtHours;
      if (this.dryGapH >= EVENT_BREAK_HOURS) {
        this.eventRainMm = 0;
        this.eventDurationH = 0;
      }
    }
  }

  /** Observed event intensity against the published regional threshold. */
  exceedanceRatio() {
    if (this.eventDurationH < MIN_EVENT_HOURS) {
      this.lastExceedance = 0;
      this.criticalDurationH = null;
      return 0;
    }
    const observed = this.eventRainMm / this.eventDurationH;
    const threshold = thresholdIntensity(this.region, this.eventDurationH);
    this.lastExceedance = threshold > 0 ? observed / threshold : 0;
    this.criticalDurationH = Number(this.eventDurationH.toFixed(2));
    return this.lastExceedance;
  }

  tick(dtSec, rainMmHr) {
    const dtHours = dtSec / 3600;
    const rainMm = rainMmHr * dtHours;

    this._updateEvent(rainMmHr, dtHours);

    // Antecedent Rainfall Index: exponential decay of past rainfall.
    const decayPerHour = Math.pow(LANDSLIDE.apiDecayK, dtHours / 24);
    this.apiMm = this.apiMm * decayPerHour + rainMm;

    // Pore pressure lags rainfall through a linear reservoir (hours, not minutes).
    const k = LANDSLIDE.poreePressureKHours;
    const target = clamp(this.apiMm / 250, 0, 1);
    this.poreePressure += ((target - this.poreePressure) * dtHours) / k;
    this.poreePressure = clamp(this.poreePressure, 0, 1);

    const exceedance = this.exceedanceRatio();

    // Slow creep (the Joshimath-style signature: tilt grows with no rain trigger).
    this.tiltDeg += this.creepDegPerHour * dtHours;
    if (this.poreePressure > 0.6) {
      this.tiltDeg += LANDSLIDE.tiltDriftDegPerHour * dtHours * (this.poreePressure - 0.6) * 10;
    }

    if (this.failureActive) {
      // After failure the slope drains and debris settles, so susceptibility
      // relaxes instead of latching high forever.
      this.failureAgeH += dtHours;
      if (this.failureAgeH >= FAILURE_RELAX_HOURS) {
        this.failureActive = false;
        this.failureAgeH = 0;
        this.cooldownRemainingH = FAILURE_COOLDOWN_HOURS;
        this.poreePressure = Math.max(0, this.poreePressure - 0.3);
        this.tiltDeg = 0;
      }
    } else if (this.cooldownRemainingH > 0) {
      this.cooldownRemainingH = Math.max(0, this.cooldownRemainingH - dtHours);
    } else {
      const rainTriggered = exceedance >= FAILURE_EXCEEDANCE && this.poreePressure >= FAILURE_PORE_PRESSURE;
      const creepTriggered = this.tiltDeg >= LANDSLIDE.tiltRunawayDeg;
      if (rainTriggered || creepTriggered) {
        this.failureActive = true;
        this.failureAgeH = 0;
        this.failureCount += 1;
        this.lastFailureMode = creepTriggered ? "creep" : "rainfall_id_threshold";
      }
    }

    return this.susceptibility;
  }

  get soilMoisturePercent() {
    // Map pore pressure onto a capacitive probe's VWC range.
    return 8 + this.poreePressure * 42;
  }

  get susceptibility() {
    const slopeFactor = clamp((this.slopeDeg - 12) / 33, 0, 1);
    const wetness = this.poreePressure;
    const trigger = clamp(this.lastExceedance, 0, 1.5) / 1.5;
    const tiltFactor = clamp(this.tiltDeg / LANDSLIDE.tiltRunawayDeg, 0, 1);
    // Intensity alone cannot fail a dry slope, so the I-D trigger term is gated
    // by antecedent wetness rather than added independently.
    const base = 0.5 * trigger * wetness + 0.25 * wetness + 0.25 * tiltFactor;
    return clamp(base * (0.5 + 0.5 * slopeFactor) + (this.failureActive ? 0.35 : 0), 0, 1);
  }

  snapshot() {
    return {
      id: this.id,
      region: this.region,
      lat: this.lat,
      lon: this.lon,
      slopeDeg: this.slopeDeg,
      apiMm: Number(this.apiMm.toFixed(1)),
      poreePressure: Number(this.poreePressure.toFixed(3)),
      exceedanceRatio: Number(this.lastExceedance.toFixed(3)),
      eventRainMm: Number(this.eventRainMm.toFixed(1)),
      eventDurationH: Number(this.eventDurationH.toFixed(2)),
      criticalDurationH: this.criticalDurationH,
      tiltDeg: Number(this.tiltDeg.toFixed(4)),
      susceptibility: Number(this.susceptibility.toFixed(3)),
      failureActive: this.failureActive,
      failureCount: this.failureCount,
      lastFailureMode: this.lastFailureMode || null,
    };
  }
}

module.exports = { SlopeUnit, thresholdIntensity, DURATIONS_HOURS };
