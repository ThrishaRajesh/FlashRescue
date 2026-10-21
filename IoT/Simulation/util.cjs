/**
 * Seeded random + distribution sampling + geo helpers.
 * Everything stochastic in the simulation draws from a seeded RNG so a scenario
 * replays identically — essential for demos and for reproducing a paper figure.
 */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Rng {
  constructor(seed = 1337) {
    this.seed = seed;
    this._next = mulberry32(seed);
    this._spare = null;
  }

  next() {
    return this._next();
  }

  uniform(min, max) {
    return min + (max - min) * this.next();
  }

  int(min, max) {
    return Math.floor(this.uniform(min, max + 1));
  }

  bool(p = 0.5) {
    return this.next() < p;
  }

  pick(arr) {
    return arr[Math.floor(this.next() * arr.length)];
  }

  /** Box-Muller, caching the second variate. */
  gaussian(mean = 0, sigma = 1) {
    if (this._spare !== null) {
      const v = this._spare;
      this._spare = null;
      return mean + sigma * v;
    }
    let u = 0;
    let v = 0;
    let s = 0;
    do {
      u = this.next() * 2 - 1;
      v = this.next() * 2 - 1;
      s = u * u + v * v;
    } while (s >= 1 || s === 0);
    const mul = Math.sqrt((-2 * Math.log(s)) / s);
    this._spare = v * mul;
    return mean + sigma * u * mul;
  }

  lognormal(medianValue, sigma) {
    return medianValue * Math.exp(this.gaussian(0, sigma));
  }

  exponential(rate) {
    return -Math.log(1 - this.next()) / rate;
  }

  poisson(lambda) {
    if (lambda <= 0) return 0;
    if (lambda < 30) {
      const limit = Math.exp(-lambda);
      let k = 0;
      let p = 1;
      do {
        k += 1;
        p *= this.next();
      } while (p > limit);
      return k - 1;
    }
    return Math.max(0, Math.round(this.gaussian(lambda, Math.sqrt(lambda))));
  }

  /** Marsaglia-Tsang. Shape < 1 uses the boost transform. */
  gamma(shape, scale = 1) {
    if (shape < 1) {
      const u = this.next();
      return this.gamma(shape + 1, scale) * Math.pow(u, 1 / shape);
    }
    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    for (;;) {
      const x = this.gaussian();
      const v = Math.pow(1 + c * x, 3);
      if (v <= 0) continue;
      const u = this.next();
      if (u < 1 - 0.0331 * Math.pow(x, 4)) return d * v * scale;
      if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v * scale;
    }
  }

  /** Gutenberg-Richter magnitude by inverse transform, truncated to [mMin, mMax]. */
  grMagnitude(b, mMin, mMax) {
    const u = this.next();
    const denom = 1 - Math.pow(10, -b * (mMax - mMin));
    return mMin - Math.log10(1 - u * denom) / b;
  }
}

const EARTH_RADIUS_M = 6371e3;
const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

function haversineM(aLat, aLon, bLat, bLon) {
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function haversineKm(aLat, aLon, bLat, bLon) {
  return haversineM(aLat, aLon, bLat, bLon) / 1000;
}

/** Move from a point along a bearing — used to advect storm cells and cyclone tracks. */
function destinationPoint(lat, lon, bearingDeg, distanceKm) {
  const d = distanceKm / (EARTH_RADIUS_M / 1000);
  const brg = toRad(bearingDeg);
  const lat1 = toRad(lat);
  const lon1 = toRad(lon);
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brg)
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(brg) * Math.sin(d) * Math.cos(lat1),
      Math.cos(d) - Math.sin(lat1) * Math.sin(lat2)
    );
  return { lat: toDeg(lat2), lon: ((toDeg(lon2) + 540) % 360) - 180 };
}

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const lerp = (a, b, t) => a + (b - a) * t;

/** Quantize to a hardware resolution step (what an ADC actually reports). */
function quantize(value, step) {
  if (!step) return value;
  return Math.round(value / step) * step;
}

function round(value, places = 3) {
  const f = Math.pow(10, places);
  return Math.round(value * f) / f;
}

module.exports = {
  Rng,
  mulberry32,
  haversineM,
  haversineKm,
  destinationPoint,
  clamp,
  lerp,
  quantize,
  round,
  toRad,
  toDeg,
};
