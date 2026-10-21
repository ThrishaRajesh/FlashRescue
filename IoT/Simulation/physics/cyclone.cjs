const { CYCLONE } = require("../config.cjs");
const { haversineKm, destinationPoint, clamp } = require("../util.cjs");

/**
 * Tropical cyclone using the Holland (1980) radial wind profile. Pressure is the
 * useful early signal: a barometric sensor sees the deficit hours before the
 * destructive wind field arrives.
 */
class Cyclone {
  constructor(rng, opts = {}) {
    this.rng = rng;
    this.id = opts.id || "tc-1";
    this.name = opts.name || "Simulated TC";
    this.lat = opts.lat;
    this.lon = opts.lon;
    this.centralPressureHpa = opts.centralPressureHpa ?? 975;
    this.targetPressureHpa = opts.targetPressureHpa ?? this.centralPressureHpa;
    this.rMaxKm = opts.rMaxKm ?? rng.uniform(CYCLONE.rMaxKmMin, CYCLONE.rMaxKmMax);
    this.hollandB = opts.hollandB ?? rng.uniform(CYCLONE.hollandBMin, CYCLONE.hollandBMax);
    this.bearingDeg = opts.bearingDeg ?? 20;
    this.speedKmh = opts.speedKmh ?? 18;
    this.shelfDepthM = opts.shelfDepthM ?? 20; // shallow Bengal shelf amplifies surge
    this.fetchKm = opts.fetchKm ?? 180;
    this.landfall = false;
    this.ageSec = 0;
  }

  get pressureDeficitHpa() {
    return Math.max(0, CYCLONE.ambientPressureHpa - this.centralPressureHpa);
  }

  /** Holland profile: V(r) = sqrt(B * dP * (Rmax/r)^B * exp(-(Rmax/r)^B) / rho). */
  windAt(lat, lon) {
    const r = Math.max(1, haversineKm(this.lat, this.lon, lat, lon));
    const dp = this.pressureDeficitHpa * 100; // Pa
    const ratio = Math.pow(this.rMaxKm / r, this.hollandB);
    const v = Math.sqrt((this.hollandB * dp * ratio * Math.exp(-ratio)) / CYCLONE.airDensity);
    return Number.isFinite(v) ? v : 0;
  }

  /** Radial pressure profile toward the ambient value. */
  pressureAt(lat, lon) {
    const r = Math.max(1, haversineKm(this.lat, this.lon, lat, lon));
    const ratio = Math.pow(this.rMaxKm / r, this.hollandB);
    return CYCLONE.ambientPressureHpa - this.pressureDeficitHpa * Math.exp(-ratio);
  }

  /** Storm surge from pressure drop plus wind setup over a shallow shelf. */
  surgeHeightM(lat, lon) {
    const pressureComponent = (this.pressureDeficitHpa / 10) * CYCLONE.surgeMPer10Hpa;
    const wind = this.windAt(lat, lon);
    const windSetup = (0.0000045 * wind * wind * this.fetchKm) / Math.max(5, this.shelfDepthM);
    const distance = haversineKm(this.lat, this.lon, lat, lon);
    const decay = Math.exp(-distance / (this.rMaxKm * 3));
    return Math.max(0, (pressureComponent + windSetup) * decay);
  }

  /** Saffir-Simpson-like category from peak wind, in IMD-recognisable terms. */
  get category() {
    const v = this.windAt(
      destinationPoint(this.lat, this.lon, 0, this.rMaxKm).lat,
      this.lon
    );
    const kmh = Math.max(v, this.windAt(this.lat, this.lon)) * 3.6;
    if (kmh >= 222) return "SUPER_CYCLONIC_STORM";
    if (kmh >= 168) return "EXTREMELY_SEVERE";
    if (kmh >= 118) return "VERY_SEVERE";
    if (kmh >= 88) return "SEVERE";
    if (kmh >= 62) return "CYCLONIC_STORM";
    return "DEPRESSION";
  }

  tick(dtSec) {
    this.ageSec += dtSec;
    if (this.minPressureHpa === undefined || this.centralPressureHpa < this.minPressureHpa) {
      this.minPressureHpa = this.centralPressureHpa;
      this.peakCategory = this.category;
    }
    // Intensification/decay toward the scripted target pressure.
    const tau = 3 * 3600;
    this.centralPressureHpa += ((this.targetPressureHpa - this.centralPressureHpa) * dtSec) / tau;

    const distanceKm = (this.speedKmh * dtSec) / 3600;
    const moved = destinationPoint(this.lat, this.lon, this.bearingDeg, distanceKm);
    this.lat = moved.lat;
    this.lon = moved.lon;

    // Over land a cyclone fills rapidly.
    if (this.landfall) {
      this.targetPressureHpa = Math.min(CYCLONE.ambientPressureHpa, this.targetPressureHpa + (dtSec / 3600) * 6);
    }
  }

  /** Rain bands scale with intensity and peak near the radius of maximum wind. */
  rainfallAt(lat, lon) {
    const r = Math.max(1, haversineKm(this.lat, this.lon, lat, lon));
    const peak = clamp(this.pressureDeficitHpa * CYCLONE.rainPerHpa, 0, 90);
    const band = Math.exp(-Math.pow((r - this.rMaxKm) / (this.rMaxKm * 1.2), 2));
    return peak * band;
  }

  snapshot() {
    return {
      id: this.id,
      name: this.name,
      lat: Number(this.lat.toFixed(4)),
      lon: Number(this.lon.toFixed(4)),
      centralPressureHpa: Number(this.centralPressureHpa.toFixed(1)),
      minPressureHpa: this.minPressureHpa === undefined ? null : Number(this.minPressureHpa.toFixed(1)),
      rMaxKm: Number(this.rMaxKm.toFixed(1)),
      category: this.category,
      peakCategory: this.peakCategory || this.category,
      landfall: this.landfall,
    };
  }
}

module.exports = { Cyclone };
