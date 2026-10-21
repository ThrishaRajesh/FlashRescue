const { HYDROLOGY, CWC_STATES, CWC_WARNING_OFFSET_M, URBAN_DRAINAGE } = require("../config.cjs");
const { clamp } = require("../util.cjs");

// 1 mm/h falling on 1 km^2 = 1000/3600 m^3/s.
const MM_HR_KM2_TO_CUMECS = 1000 / 3600;
const IMPOUNDMENT_MAX_RISE_M = 15;

/**
 * Nash linear-reservoir cascade: rainfall enters reservoir 0, each reservoir
 * drains into the next at rate S/K. This is what produces the real lag between
 * rain falling and a river rising, instead of an instantaneous response.
 */
class NashCascade {
  constructor(reservoirCount = HYDROLOGY.cascadeReservoirs, kSeconds = 2700) {
    this.storage = new Array(reservoirCount).fill(0);
    this.kSeconds = kSeconds;
    this.lastOutflow = 0;
  }

  /** inflowCumecs: m^3/s entering the top of the cascade. */
  tick(dtSec, inflowCumecs, risingLimb = true) {
    // A steeper rising limb than falling limb reproduces observed flood-wave hysteresis.
    const k = risingLimb ? this.kSeconds * HYDROLOGY.risingLimbFactor : this.kSeconds;
    let carry = inflowCumecs;
    for (let i = 0; i < this.storage.length; i++) {
      this.storage[i] += carry * dtSec;
      const out = this.storage[i] / k;
      this.storage[i] = Math.max(0, this.storage[i] - out * dtSec);
      carry = out;
    }
    this.lastOutflow = carry;
    return carry;
  }

  get totalStorage() {
    return this.storage.reduce((a, b) => a + b, 0);
  }
}

/**
 * A river gauging station. Emits stage (m) derived from discharge through an
 * inverted rating curve, and classifies against CWC Warning / Danger / HFL levels.
 */
class RiverStation {
  constructor(opts) {
    this.id = opts.id;
    this.name = opts.name || opts.id;
    this.lat = opts.lat;
    this.lon = opts.lon;
    this.catchmentAreaKm2 = opts.catchmentAreaKm2 ?? 400;
    this.runoffCoefficient = opts.runoffCoefficient ?? 0.45;
    this.bedLevelM = opts.bedLevelM ?? 0;
    this.dangerLevelM = opts.dangerLevelM ?? 6.0;
    this.hflM = opts.hflM ?? this.dangerLevelM + 1.2;
    this.warningLevelM = opts.warningLevelM ?? this.dangerLevelM - CWC_WARNING_OFFSET_M;
    this.isMainStem = Boolean(opts.isMainStem);
    this.tidal = Boolean(opts.tidal);
    // Rating curve coefficients are station-specific: a main stem and a small
    // tributary produce wildly different stages for the same discharge.
    this.ratingA = opts.ratingA ?? HYDROLOGY.ratingCurveA;
    this.ratingB = opts.ratingB ?? HYDROLOGY.ratingCurveB;
    // Compound (two-stage) channel: once the river tops its banks it spreads
    // across the floodplain, so a given extra discharge raises the stage far
    // less than it would in-channel. Without this the model happily predicts
    // stages metres above the recorded highest flood level.
    this.bankFullLevelM = opts.bankFullLevelM ?? this.dangerLevelM;
    this.floodplainWidthRatio = opts.floodplainWidthRatio ?? HYDROLOGY.floodplainWidthRatio;

    const kMinutes = opts.kMinutes ?? (this.isMainStem ? HYDROLOGY.kMinutesMainStem : HYDROLOGY.kMinutesSmallCatchment);
    this.cascade = new NashCascade(HYDROLOGY.cascadeReservoirs, kMinutes * 60);

    this.baseflowCumecs = opts.baseflowCumecs ?? 40;
    this.discharge = this.baseflowCumecs;
    this.prevDischarge = this.baseflowCumecs;
    this.stage = this._stageFromDischarge(this.discharge);
    this.prevStage = this.stage;
    this.dStageDt = 0;
    this.blockageFactor = 0; // landslide dam: 0 = free flowing, 1 = fully blocked
    this.surgePeakCumecs = 0;
    this.surgeRiseSec = 1200;
    this.surgeAgeSec = 0;
    this.surgeActive = false;
    this.impoundedVolumeM3 = 0;
    this.impoundmentAreaM2 = opts.impoundmentAreaM2 ?? 1.5e6;
    this.naturalDischarge = this.baseflowCumecs ?? 0;
    this.stageOffsetM = 0; // abrupt datum shift, e.g. a glacial lake emptying
    /**
     * Catchment-average rainfall, when the contributing basin is larger than the
     * simulated region. A 20,000 km^2 basin is ~140 km across, so driving it from
     * rainfall measured inside a 13 km sensor box would wrongly assume the whole
     * basin receives what one gauge sees. Scenarios set this explicitly; local
     * gauges continue to observe local rainfall.
     */
    this.basinRainMmHr = null;
  }

  setBasinRain(mmHr) {
    this.basinRainMmHr = mmHr === null ? null : Math.max(0, mmHr);
  }

  setBaseflow(cumecs) {
    this.baseflowCumecs = Math.max(0, cumecs);
  }

  /** Abrupt level change independent of discharge (lake drain, moraine breach). */
  setStageOffset(offsetM) {
    this.stageOffsetM = offsetM;
  }

  /** Inverse rating curve: Q = a (h - h0)^b  ->  h = h0 + (Q/a)^(1/b). */
  _stageFromDischarge(q) {
    const flow = Math.max(0, q);
    const bankFullDepth = Math.max(0.1, this.bankFullLevelM - this.bedLevelM);
    const bankFullQ = this.ratingA * Math.pow(bankFullDepth, this.ratingB);

    if (flow <= bankFullQ) {
      return this.bedLevelM + Math.pow(flow / this.ratingA, 1 / this.ratingB);
    }
    const overbank = flow - bankFullQ;
    const floodplainA = this.ratingA * this.floodplainWidthRatio;
    return this.bankFullLevelM + Math.pow(overbank / floodplainA, 1 / this.ratingB);
  }

  get state() {
    if (this.stage >= this.hflM) return "UNPRECEDENTED";
    if (this.stage >= this.hflM - 0.5) return "HIGH";
    if (this.stage >= this.dangerLevelM) return "MODERATE";
    if (this.stage >= this.warningLevelM) return "LOW";
    return "NORMAL";
  }

  /** 0..1 risk for the fusion grid, anchored on official levels rather than arbitrary scaling. */
  get normalizedRisk() {
    if (this.stage <= this.warningLevelM) {
      const span = Math.max(0.1, this.warningLevelM - this.bedLevelM);
      return clamp(((this.stage - this.bedLevelM) / span) * 0.45, 0, 0.45);
    }
    if (this.stage <= this.dangerLevelM) {
      const t = (this.stage - this.warningLevelM) / Math.max(0.1, this.dangerLevelM - this.warningLevelM);
      return 0.45 + t * 0.2;
    }
    const t = (this.stage - this.dangerLevelM) / Math.max(0.1, this.hflM - this.dangerLevelM);
    return clamp(0.65 + t * 0.35, 0.65, 1);
  }

  /** Blocked channel: discharge drops downstream while water impounds upstream. */
  setBlockage(factor) {
    this.blockageFactor = clamp(factor, 0, 1);
  }

  /** Water withheld by a downstream blockage, accumulating behind it. */
  addImpoundedVolume(m3) {
    this.impoundedVolumeM3 = Math.max(0, (this.impoundedVolumeM3 || 0) + m3);
  }

  get impoundmentStageRiseM() {
    if (!this.impoundedVolumeM3) return 0;
    return Math.min(IMPOUNDMENT_MAX_RISE_M, this.impoundedVolumeM3 / this.impoundmentAreaM2);
  }

  /** Dam breach: the stored volume leaves as a flood wave. */
  releaseImpoundment() {
    const volume = this.impoundedVolumeM3 || 0;
    this.impoundedVolumeM3 = 0;
    return volume;
  }

  /**
   * A GLOF, dam-break or storm-surge wave travels down the channel; it is NOT
   * catchment runoff, so it must bypass the rainfall-runoff cascade (which would
   * smear a sharp wave into nothing). Shaped as a unit-hydrograph pulse that
   * peaks at `riseMinutes` and then recedes.
   */
  injectSurge(peakCumecs, { riseMinutes = 20 } = {}) {
    this.surgePeakCumecs = Math.max(this.surgePeakCumecs || 0, Math.max(0, peakCumecs));
    this.surgeRiseSec = riseMinutes * 60;
    this.surgeAgeSec = 0;
    this.surgeActive = true;
  }

  _surgeDischarge(dtSec) {
    if (!this.surgeActive) return 0;
    this.surgeAgeSec += dtSec;
    const tp = this.surgeRiseSec;
    const t = this.surgeAgeSec;
    if (t > tp * 10) {
      this.surgeActive = false;
      this.surgePeakCumecs = 0;
      return 0;
    }
    return this.surgePeakCumecs * (t / tp) * Math.exp(1 - t / tp);
  }

  tick(dtSec, rainMmHr, tideLevel = 0) {
    const catchmentRain = this.basinRainMmHr !== null ? this.basinRainMmHr : rainMmHr;
    const effectiveRain = catchmentRain * this.runoffCoefficient;
    const inflow = effectiveRain * this.catchmentAreaKm2 * MM_HR_KM2_TO_CUMECS;

    const rising = inflow > this.cascade.lastOutflow;
    const routed = this.cascade.tick(dtSec, inflow, rising);
    const surge = this._surgeDischarge(dtSec);

    this.prevDischarge = this.discharge;
    let q = this.baseflowCumecs + routed + surge;

    // Retained before the blockage is applied, so the world model knows how much
    // flow is being withheld and can accumulate it upstream.
    this.naturalDischarge = q;
    if (this.blockageFactor > 0) q *= 1 - this.blockageFactor;

    // Tide lock / backwater: a high downstream level throttles drainage, so the
    // gauge can rise with no additional local rainfall.
    if (this.tidal && tideLevel > URBAN_DRAINAGE.tideLockThreshold) {
      q *= 1 - 0.35 * (tideLevel - URBAN_DRAINAGE.tideLockThreshold);
    }

    this.discharge = Math.max(0, q);

    this.prevStage = this.stage;
    let stage = this._stageFromDischarge(this.discharge);

    // Loop rating: on a steep rise the stage for a given discharge runs slightly
    // higher than on the falling limb. Scaled on the FRACTIONAL rate of change
    // per hour and capped, since the real effect is centimetres to decimetres.
    const fractionalRatePerHour =
      ((this.discharge - this.prevDischarge) / Math.max(1, this.discharge)) * (3600 / Math.max(1, dtSec));
    stage += clamp(HYDROLOGY.loopRatingC * fractionalRatePerHour, -0.3, 0.3);

    // Progressive impoundment: the gauge behind a blockage keeps climbing as
    // volume accumulates, rather than stepping up once.
    stage += this.impoundmentStageRiseM;

    this.stage = Math.max(this.bedLevelM, stage + this.stageOffsetM);
    this.dStageDt = (this.stage - this.prevStage) / Math.max(1, dtSec);

    if (this.peakStage === undefined || this.stage > this.peakStage) {
      this.peakStage = this.stage;
      this.peakState = this.state;
      this.peakDischarge = this.discharge;
    }
    return this.stage;
  }

  snapshot() {
    return {
      id: this.id,
      name: this.name,
      lat: this.lat,
      lon: this.lon,
      bedLevelM: this.bedLevelM,
      stageM: Number(this.stage.toFixed(3)),
      dischargeCumecs: Number(this.discharge.toFixed(1)),
      state: this.state,
      warningLevelM: this.warningLevelM,
      dangerLevelM: this.dangerLevelM,
      hflM: this.hflM,
      risingRateMPerHour: Number((this.dStageDt * 3600).toFixed(4)),
      blockageFactor: Number(this.blockageFactor.toFixed(2)),
      peakStageM: this.peakStage === undefined ? null : Number(this.peakStage.toFixed(3)),
      peakState: this.peakState || null,
      peakDischargeCumecs: this.peakDischarge === undefined ? null : Number(this.peakDischarge.toFixed(1)),
    };
  }
}

/**
 * Urban waterlogging: ponding accumulates whenever rainfall intensity exceeds
 * effective drainage capacity, which itself degrades with clogging and tide lock.
 */
class UrbanDrainageCell {
  constructor(opts = {}) {
    this.capacityMmHr = opts.capacityMmHr ?? URBAN_DRAINAGE.designCapacityMmPerHour;
    this.cloggingFactor = opts.cloggingFactor ?? URBAN_DRAINAGE.cloggingFactorDefault;
    this.pondingMm = 0;
    this.peakPondingMm = 0;
    this.tidal = Boolean(opts.tidal);
    this.tideLocked = false;
  }

  effectiveCapacity(tideLevel) {
    let cap = this.capacityMmHr * (1 - this.cloggingFactor);
    if (this.tidal && tideLevel > URBAN_DRAINAGE.tideLockThreshold) {
      const lock = (tideLevel - URBAN_DRAINAGE.tideLockThreshold) / (1 - URBAN_DRAINAGE.tideLockThreshold);
      cap *= Math.max(0, 1 - lock);
    }
    return cap;
  }

  tick(dtSec, rainMmHr, tideLevel = 0) {
    const cap = this.effectiveCapacity(tideLevel);
    const netMmHr = rainMmHr - cap;
    this.pondingMm = Math.max(0, this.pondingMm + (netMmHr * dtSec) / 3600);
    if (this.pondingMm > this.peakPondingMm) {
      this.peakPondingMm = this.pondingMm;
      this.peakTideLevel = tideLevel;
    }
    this.tideLocked = this.tidal && tideLevel > URBAN_DRAINAGE.tideLockThreshold;
    return this.pondingMm;
  }

  get normalizedRisk() {
    return clamp(this.pondingMm / 600, 0, 1);
  }
}

module.exports = {
  NashCascade,
  RiverStation,
  UrbanDrainageCell,
  CWC_STATES,
  MM_HR_KM2_TO_CUMECS,
};
