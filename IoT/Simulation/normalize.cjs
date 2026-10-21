const { clamp } = require("./util.cjs");
const { CYCLONE, HEAT_WAVE, LANDSLIDE } = require("./config.cjs");

/**
 * Channels that carry hazard information feed the risk grid; the rest are
 * context telemetry. Publishing context on the risk topic would dilute the grid,
 * since every benign reading drags a cell's smoothed risk back toward zero.
 */
const HAZARD_KINDS = new Set(["rain", "water", "soil", "tilt", "tremor", "co", "pm25", "sos", "wind", "pressure"]);
const CONTEXT_KINDS = new Set(["temp", "humidity"]);

/**
 * Map a physical reading onto the 0..1 risk scale the fusion grid expects.
 *
 * Where an official threshold exists we anchor to it rather than inventing a
 * divisor: a river at its CWC danger level reads 0.65 by construction, not by
 * coincidence of scaling. This is what makes grid values defensible.
 */
function hazardNorm(kind, value, ctx = {}) {
  if (value === null || value === undefined || Number.isNaN(value)) return null;

  switch (kind) {
    case "rain":
      // mm/h; 100 mm/h is an extreme instantaneous rate.
      return clamp(value / 100, 0, 1);

    case "water": {
      // Anchored on Warning / Danger / HFL rather than raw stage, because an
      // absolute datum level (e.g. 75 m) carries no risk meaning on its own.
      if (ctx.station) return clamp(ctx.station.normalizedRisk, 0, 1);
      if (ctx.urban) return clamp(ctx.urban.normalizedRisk, 0, 1);
      return clamp(value / 3, 0, 1);
    }

    case "soil":
      if (ctx.slope) return clamp(ctx.slope.susceptibility, 0, 1);
      return clamp((value - 10) / 40, 0, 1);

    case "tilt":
      if (ctx.slope) return clamp(ctx.slope.susceptibility, 0, 1);
      return clamp(Math.abs(value) / LANDSLIDE.tiltRunawayDeg, 0, 1);

    case "tremor":
      // 0.3 g is severe shaking; scale PGA against that.
      return clamp(value / 0.3, 0, 1);

    case "co":
      return clamp((value - 5) / 400, 0, 1);

    case "pm25":
      return clamp((value - 60) / 500, 0, 1);

    case "wind":
      return clamp(value / 45, 0, 1);

    case "pressure": {
      // Risk comes from the pressure deficit, not the absolute value.
      const deficit = CYCLONE.ambientPressureHpa - value;
      return clamp(deficit / 70, 0, 1);
    }

    case "sos":
      return value >= 1 ? 1.0 : 0;

    case "temp": {
      const threshold =
        ctx.climateZone === "coastal"
          ? HEAT_WAVE.coastalThreshold
          : ctx.climateZone === "hills"
            ? HEAT_WAVE.hillsThreshold
            : HEAT_WAVE.plainsThreshold;
      if (value < threshold) return 0;
      return clamp((value - threshold) / (HEAT_WAVE.absoluteSevere - threshold), 0, 1);
    }

    default:
      return null;
  }
}

module.exports = { hazardNorm, HAZARD_KINDS, CONTEXT_KINDS };
