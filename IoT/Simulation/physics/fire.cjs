const { FIRE } = require("../config.cjs");
const { haversineKm, clamp, toRad } = require("../util.cjs");

/**
 * Equilibrium moisture content of fine fuels for given temperature and humidity.
 * Simard-style approximation; drives how readily a fire ignites and spreads.
 */
function equilibriumMoisture(tempC, humidityPct) {
  const h = clamp(humidityPct, 1, 100);
  if (h < 10) return 0.03229 + 0.281073 * h - 0.000578 * h * tempC;
  if (h < 50) return 2.22749 + 0.160107 * h - 0.014784 * tempC;
  return 21.0606 + 0.005565 * h * h - 0.00035 * h * tempC - 0.483199 * h;
}

/**
 * Fire weather state for a region: fine fuel moisture relaxes toward the
 * equilibrium value, and rain wets fuels immediately.
 */
class FireWeather {
  constructor(opts = {}) {
    this.fuelMoisturePct = opts.initialFuelMoisturePct ?? 14;
    this.droughtIndex = opts.initialDroughtIndex ?? 15;
  }

  tick(dtSec, atmosphere, rainMmHr = 0) {
    const dtHours = dtSec / 3600;
    const emc = equilibriumMoisture(atmosphere.temperatureC, atmosphere.humidityPct);
    const tau = FIRE.fuelMoistureTimeConstantHours;
    this.fuelMoisturePct += ((emc - this.fuelMoisturePct) * dtHours) / tau;

    if (rainMmHr > 0.2) this.fuelMoisturePct += rainMmHr * dtHours * 2.5;
    this.fuelMoisturePct = clamp(this.fuelMoisturePct, 1, 60);

    // Longer-term drying: the drought code analogue.
    this.droughtIndex = clamp(
      this.droughtIndex + dtHours * (atmosphere.temperatureC > 25 ? 0.08 : -0.02) - rainMmHr * dtHours * 0.6,
      0,
      100
    );
  }

  /** Initial spread index analogue: dry fuel plus wind. */
  get spreadIndex() {
    const moistureFactor = Math.exp(-0.17 * this.fuelMoisturePct);
    return moistureFactor * 100;
  }

  /** Composite 0..1 fire danger. */
  dangerRating(atmosphere) {
    const windFactor = clamp(atmosphere.windMs / 15, 0, 1);
    const moistureFactor = clamp(1 - this.fuelMoisturePct / 30, 0, 1);
    const droughtFactor = clamp(this.droughtIndex / 100, 0, 1);
    const tempFactor = clamp((atmosphere.temperatureC - 20) / 25, 0, 1);
    return clamp(
      0.35 * moistureFactor + 0.25 * windFactor + 0.2 * droughtFactor + 0.2 * tempFactor,
      0,
      1
    );
  }

  snapshot() {
    return {
      fuelMoisturePct: Number(this.fuelMoisturePct.toFixed(2)),
      droughtIndex: Number(this.droughtIndex.toFixed(1)),
      spreadIndex: Number(this.spreadIndex.toFixed(2)),
    };
  }
}

/**
 * An active fire. Spread follows a Rothermel-style wind-and-slope multiplier,
 * and the smoke plume is advected downwind so sensors downwind detect it first.
 */
class FireFront {
  constructor(opts) {
    this.id = opts.id;
    this.lat = opts.lat;
    this.lon = opts.lon;
    this.radiusM = opts.initialRadiusM ?? 20;
    this.slopeDeg = opts.slopeDeg ?? 5;
    this.active = true;
    this.ageSec = 0;
    this.suppressed = false;
  }

  /** Rothermel-lite: R = R0 * (1 + phi_wind + phi_slope). */
  spreadRateMPerMin(atmosphere, fireWeather) {
    if (!this.active || this.suppressed) return 0;
    const phiWind = 0.4 * Math.pow(Math.max(0, atmosphere.windMs), FIRE.windSpreadExponent);
    const phiSlope = 5.275 * Math.pow(Math.tan(toRad(this.slopeDeg)), 2);
    const moistureDamping = clamp(1 - fireWeather.fuelMoisturePct / 30, 0, 1);
    return FIRE.baseSpreadMPerMin * (1 + phiWind + phiSlope) * moistureDamping;
  }

  tick(dtSec, atmosphere, fireWeather, rainMmHr = 0) {
    if (!this.active) return;
    this.ageSec += dtSec;

    if (rainMmHr > 8 || fireWeather.fuelMoisturePct > 28) {
      this.suppressed = true;
    } else {
      this.suppressed = false;
    }

    const rate = this.spreadRateMPerMin(atmosphere, fireWeather);
    this.radiusM += (rate * dtSec) / 60;

    if (this.suppressed) {
      this.radiusM = Math.max(0, this.radiusM - (dtSec / 60) * 1.5);
      if (this.radiusM <= 0.5) this.active = false;
    }
  }

  get intensity() {
    return clamp(this.radiusM / 800, 0, 1);
  }

  /**
   * Smoke concentration at a point: a Gaussian plume elongated downwind.
   * Upwind sensors see almost nothing, which is what makes plume detection
   * directional in reality.
   */
  smokeFactorAt(lat, lon, atmosphere) {
    const distKm = haversineKm(this.lat, this.lon, lat, lon);
    if (distKm > 25) return 0;

    const dLat = lat - this.lat;
    const dLon = lon - this.lon;
    const bearingToPoint = (Math.atan2(dLon, dLat) * 180) / Math.PI;
    const windDir = atmosphere.windDirDeg ?? 225;
    // Wind direction is where wind comes FROM; smoke travels to the opposite side.
    const plumeAxis = (windDir + 180) % 360;
    let delta = Math.abs(((bearingToPoint - plumeAxis + 540) % 360) - 180);

    const alongWind = Math.exp(-distKm / (2 + atmosphere.windMs * 1.5));
    const crossWind = Math.exp(-Math.pow(delta / 40, 2));
    return this.intensity * alongWind * crossWind;
  }

  snapshot() {
    return {
      id: this.id,
      lat: Number(this.lat.toFixed(5)),
      lon: Number(this.lon.toFixed(5)),
      radiusM: Number(this.radiusM.toFixed(1)),
      intensity: Number(this.intensity.toFixed(3)),
      active: this.active,
      suppressed: this.suppressed,
    };
  }
}

/** Convert a smoke factor into sensor-space CO (ppm) and PM2.5 (ug/m3). */
function smokeToSensorValues(factor) {
  return {
    coPpm: FIRE.coBaselinePpm + factor * 900,
    pm25: FIRE.pm25BaselineUgM3 + factor * 750,
  };
}

module.exports = {
  FireWeather,
  FireFront,
  equilibriumMoisture,
  smokeToSensorValues,
};
