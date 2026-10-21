const { HEAT_WAVE, CYCLONE } = require("../config.cjs");
const { clamp } = require("../util.cjs");

// Monthly mean daily max temperature (deg C), Brahmaputra valley climatology.
const MONTHLY_TMAX = [24, 27, 31, 32, 32, 32, 32, 33, 32, 31, 28, 25];
const MONTHLY_TMIN = [10, 12, 16, 19, 22, 25, 26, 26, 25, 21, 15, 11];

/**
 * Regional atmosphere: diurnal and seasonal temperature, humidity coupled to
 * rainfall, synoptic pressure, and wind. Pressure is the leading indicator for
 * cyclones — it falls hours before the wind arrives.
 */
class Atmosphere {
  constructor(rng, opts = {}) {
    this.rng = rng;
    this.climateZone = opts.climateZone || "plains";
    this.normalTmaxOffset = opts.normalTmaxOffset ?? 0;
    this.temperatureC = 24;
    this.humidityPct = 70;
    this.pressureHpa = CYCLONE.ambientPressureHpa;
    this.windMs = 2;
    this.windDirDeg = 225; // monsoon prevailing south-westerly
    this.gustState = 0;
    this.synopticAnomaly = 0;
    this.heatWaveForcing = 0;
    this.cloudCover = 0.3;
    this._month = 0;
    this.sampleLat = opts.lat ?? 26.2006;
    this.sampleLon = opts.lon ?? 92.9376;
  }

  get normalTmax() {
    return MONTHLY_TMAX[this._month] + this.normalTmaxOffset;
  }

  _localHour(date) {
    return (date.getUTCHours() + date.getUTCMinutes() / 60 + 5.5) % 24;
  }

  tick(dtSec, date, rainMmHr = 0, cyclone = null, wetSpell = false) {
    this._month = date.getUTCMonth();
    const hour = this._localHour(date);
    const tmax = MONTHLY_TMAX[this._month] + this.normalTmaxOffset + this.heatWaveForcing;
    const tmin = MONTHLY_TMIN[this._month] + this.normalTmaxOffset + this.heatWaveForcing * 0.5;
    const mean = (tmax + tmin) / 2;
    const amplitude = (tmax - tmin) / 2;

    // Peak heating lags solar noon; minimum just before dawn.
    const diurnal = mean + amplitude * Math.cos((2 * Math.PI * (hour - 15)) / 24);

    // Monsoon skies stay overcast through a wet spell, not only while it is
    // actually raining. Tying cloud to instantaneous rain made monsoon days
    // mostly sunny, which in turn kept every solar node fully charged.
    const cloudTarget = clamp(
      (wetSpell ? 0.85 : 0.2) + clamp(rainMmHr / 25, 0, 0.15),
      0.05,
      1
    );
    const cloudTau = 3600;
    this.cloudCover = clamp(
      this.cloudCover + (cloudTarget - this.cloudCover) * Math.min(1, dtSec / cloudTau),
      0.05,
      1
    );

    // Rain and cloud suppress daytime maxima.
    const rainCooling = clamp(rainMmHr * 0.25, 0, 6) + this.cloudCover * 2;
    const target = diurnal - rainCooling;
    const tau = 900;
    this.temperatureC += ((target - this.temperatureC) * dtSec) / tau;

    const humidityTarget = clamp(
      95 - (this.temperatureC - 20) * 2.2 + clamp(rainMmHr * 3, 0, 25),
      18,
      99
    );
    this.humidityPct += ((humidityTarget - this.humidityPct) * dtSec) / 600;
    this.humidityPct = clamp(this.humidityPct, 5, 100);

    // Slow synoptic wander via a mean-reverting random walk.
    this.synopticAnomaly += (-this.synopticAnomaly * dtSec) / 86400 + this.rng.gaussian(0, 0.02);
    let pressure = CYCLONE.ambientPressureHpa + this.synopticAnomaly * 3;

    let windTarget = 1.5 + clamp(rainMmHr / 6, 0, 8) + this.cloudCover * 1.5;

    const prevailing = this._month >= 5 && this._month <= 8 ? 225 : 45;
    let dirTarget = prevailing;

    if (cyclone) {
      pressure = Math.min(pressure, cyclone.pressureAt(this.sampleLat, this.sampleLon));
      windTarget = Math.max(windTarget, cyclone.windAt(this.sampleLat, this.sampleLon));
      // Cyclonic flow is tangential (anticlockwise in the northern hemisphere).
      const bearingToEye =
        (Math.atan2(cyclone.lon - this.sampleLon, cyclone.lat - this.sampleLat) * 180) / Math.PI;
      dirTarget = (bearingToEye + 90 + 360) % 360;
    }

    let dirDelta = ((dirTarget - this.windDirDeg + 540) % 360) - 180;
    this.windDirDeg = (this.windDirDeg + dirDelta * Math.min(1, dtSec / 1800) + this.rng.gaussian(0, 0.8) + 360) % 360;

    this.pressureHpa += ((pressure - this.pressureHpa) * dtSec) / 300;

    this.gustState += (-this.gustState * dtSec) / 60 + this.rng.gaussian(0, 0.25);
    this.windMs = Math.max(0, windTarget + this.gustState);
  }

  /** Station coordinates used when a cyclone is present. */
  setSamplePoint(lat, lon) {
    this.sampleLat = lat;
    this.sampleLon = lon;
  }

  setHeatWaveForcing(deltaC) {
    this.heatWaveForcing = deltaC;
  }

  /** IMD heat wave classification for the current temperature. */
  heatWaveStatus() {
    const threshold =
      this.climateZone === "coastal"
        ? HEAT_WAVE.coastalThreshold
        : this.climateZone === "hills"
          ? HEAT_WAVE.hillsThreshold
          : HEAT_WAVE.plainsThreshold;

    if (this.temperatureC < threshold) return { status: "NONE", departureC: 0 };

    const departure = this.temperatureC - this.normalTmax;
    if (this.temperatureC >= HEAT_WAVE.absoluteSevere || departure >= HEAT_WAVE.departureSevere) {
      return { status: "SEVERE_HEAT_WAVE", departureC: Number(departure.toFixed(1)) };
    }
    if (this.temperatureC >= HEAT_WAVE.absoluteHeatWave || departure >= HEAT_WAVE.departureHeatWave) {
      return { status: "HEAT_WAVE", departureC: Number(departure.toFixed(1)) };
    }
    return { status: "HOT", departureC: Number(departure.toFixed(1)) };
  }

  /** Heat index (apparent temperature) matters more than dry-bulb on humid coasts. */
  heatIndexC() {
    const t = this.temperatureC;
    const r = this.humidityPct;
    if (t < 27) return t;
    const tf = (t * 9) / 5 + 32;
    const hi =
      -42.379 +
      2.04901523 * tf +
      10.14333127 * r -
      0.22475541 * tf * r -
      0.00683783 * tf * tf -
      0.05481717 * r * r +
      0.00122874 * tf * tf * r +
      0.00085282 * tf * r * r -
      0.00000199 * tf * tf * r * r;
    return ((hi - 32) * 5) / 9;
  }

  snapshot() {
    const hw = this.heatWaveStatus();
    return {
      temperatureC: Number(this.temperatureC.toFixed(2)),
      humidityPct: Number(this.humidityPct.toFixed(1)),
      pressureHpa: Number(this.pressureHpa.toFixed(2)),
      windMs: Number(this.windMs.toFixed(2)),
      windDirDeg: Number(this.windDirDeg.toFixed(1)),
      cloudCover: Number(this.cloudCover.toFixed(2)),
      heatIndexC: Number(this.heatIndexC().toFixed(1)),
      heatWave: hw.status,
      departureC: hw.departureC,
    };
  }
}

module.exports = { Atmosphere, MONTHLY_TMAX, MONTHLY_TMIN };
