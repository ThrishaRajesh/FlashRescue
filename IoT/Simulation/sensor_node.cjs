const { HARDWARE, FAULTS, POWER } = require("./config.cjs");
const { clamp, quantize } = require("./util.cjs");

/**
 * One physical sensor channel. The measurement chain mirrors real instruments:
 *   truth -> drift -> fouling -> noise -> fault injection -> saturation -> quantization
 * Saturation and quantization are what make a simulated feed look like real
 * hardware: a tipping bucket can only ever report multiples of 0.2 mm.
 */
class Sensor {
  constructor(kind, rng, opts = {}) {
    this.kind = kind;
    this.spec = HARDWARE[kind];
    if (!this.spec) throw new Error(`Unknown sensor kind: ${kind}`);
    this.rng = rng;
    this.drift = 0;
    this.fouling = 0;
    this.stuck = false;
    this.stuckValue = null;
    this.warmupRemainingSec = this.spec.warmupSec;
    this.lastSampleSimSec = -Infinity;
    this.sampleIntervalSec = opts.sampleIntervalSec ?? this.spec.sampleIntervalSec;
    this.calibrationError = rng.gaussian(0, this.spec.resolution * 2);
    this.lastReading = null;
  }

  get dueAt() {
    return this.lastSampleSimSec + this.sampleIntervalSec;
  }

  isDue(simSec) {
    return simSec >= this.dueAt;
  }

  /** Age drift, fouling and warm-up regardless of whether we sample this tick. */
  age(dtSec) {
    const dtDays = dtSec / 86400;
    this.drift += this.rng.gaussian(0, this.spec.driftPerDay * Math.sqrt(Math.max(dtDays, 1e-9)));
    if (this.spec.biofoulingPerDay) {
      this.fouling += this.spec.biofoulingPerDay * dtDays;
    }
    if (this.warmupRemainingSec > 0) this.warmupRemainingSec = Math.max(0, this.warmupRemainingSec - dtSec);

    if (!this.stuck && this.rng.next() < FAULTS.stuckAtPerDay * dtDays) {
      this.stuck = true;
      this.stuckValue = this.lastReading ? this.lastReading.value : this.spec.min;
    }
  }

  /** Returns null when the sample is dropped (comms/fault) — the pipeline must cope. */
  sample(trueValue, simSec) {
    this.lastSampleSimSec = simSec;

    if (this.warmupRemainingSec > 0) {
      return { kind: this.kind, value: null, unit: this.spec.unit, quality: "WARMUP", trueValue };
    }

    if (this.stuck) {
      const reading = {
        kind: this.kind,
        value: this.stuckValue,
        unit: this.spec.unit,
        quality: "STUCK",
        trueValue,
      };
      this.lastReading = reading;
      return reading;
    }

    if (this.rng.next() < FAULTS.nanProbability) {
      return { kind: this.kind, value: null, unit: this.spec.unit, quality: "NAN", trueValue };
    }

    let v = trueValue + this.drift + this.calibrationError - this.fouling;
    if (this.spec.noiseSigma > 0) v += this.rng.gaussian(0, this.spec.noiseSigma);

    let quality = "OK";
    if (this.rng.next() < FAULTS.spikeProbability) {
      const mult = this.rng.uniform(FAULTS.spikeMultiplierMin, FAULTS.spikeMultiplierMax);
      v = v * mult;
      quality = "SPIKE";
    }

    const saturated = v > this.spec.max || v < this.spec.min;
    v = clamp(v, this.spec.min, this.spec.max);
    v = quantize(v, this.spec.resolution);

    const reading = {
      kind: this.kind,
      value: v,
      unit: this.spec.unit,
      quality: saturated && quality === "OK" ? "SATURATED" : quality,
      trueValue,
    };
    this.lastReading = reading;
    return reading;
  }
}

/**
 * A field node: a set of sensors sharing a solar panel, a battery and a radio.
 * Under sustained cloud cover the battery declines and the node duty-cycles down
 * or dies — which in a monsoon means losing sensing exactly when it matters most.
 */
class SensorNode {
  constructor(opts) {
    this.id = opts.id;
    this.lat = opts.lat;
    this.lon = opts.lon;
    this.rng = opts.rng;
    this.kinds = opts.kinds;
    this.role = opts.role || "generic";
    this.stationRef = opts.stationRef || null;
    this.slopeRef = opts.slopeRef || null;
    this.region = opts.region || null;
    this.solarPowered = opts.solarPowered ?? true;

    this.sensors = {};
    for (const kind of this.kinds) {
      this.sensors[kind] = new Sensor(kind, this.rng, {
        sampleIntervalSec: opts.sampleIntervalOverrides?.[kind],
      });
    }

    // Field networks are not uniformly maintained: some nodes start well below
    // full charge and are the first to fail in a long overcast spell.
    this.batteryWh = POWER.batteryWh * this.rng.uniform(0.22, 1.0);
    this.alive = true;
    this.dutyCycled = false;
    this.dutyCycledEver = false;
    this.offlineEpisodes = 0;
    this.minStateOfCharge = 1;
    this.lastSeenSimSec = 0;
    this.txCount = 0;
  }

  get stateOfCharge() {
    return clamp(this.batteryWh / POWER.batteryWh, 0, 1);
  }

  /** Mains-powered nodes bypass the solar/battery model entirely. */
  _updatePower(dtSec, solarIrradiance) {
    if (!this.solarPowered) {
      this.alive = true;
      this.dutyCycled = false;
      return;
    }

    const dtHours = dtSec / 3600;
    const charge = POWER.panelWatts * solarIrradiance * POWER.chargeEfficiency * dtHours;
    const draw = (POWER.idleDrawW + (this.txCount > 0 ? POWER.txDrawW * 0.02 : 0)) * dtHours;
    this.txCount = 0;

    this.batteryWh = clamp(this.batteryWh + charge - draw, 0, POWER.batteryWh);

    const soc = this.stateOfCharge;
    if (this.alive && soc <= POWER.deadSocThreshold) {
      this.alive = false;
      this.offlineEpisodes += 1;
    } else if (!this.alive && soc >= POWER.recoverSocThreshold) {
      this.alive = true;
    }

    this.dutyCycled = soc < POWER.dutyCycleSocThreshold;
    // Tracked because nodes recharge after a storm clears, so an end-of-run
    // snapshot hides outages that happened during the event itself.
    if (soc < this.minStateOfCharge) this.minStateOfCharge = soc;
    if (this.dutyCycled) this.dutyCycledEver = true;
  }

  /**
   * Advance the node and return any readings produced this tick.
   * `truthFor(kind, node)` supplies the physical ground truth from the world model.
   */
  tick(dtSec, simSec, truthFor, solarIrradiance) {
    this._updatePower(dtSec, solarIrradiance);

    for (const kind of this.kinds) this.sensors[kind].age(dtSec);

    if (!this.alive) return [];

    const readings = [];
    for (const kind of this.kinds) {
      const sensor = this.sensors[kind];
      const interval = this.dutyCycled
        ? sensor.sampleIntervalSec * POWER.dutyCycleMultiplier
        : sensor.sampleIntervalSec;

      if (simSec < sensor.lastSampleSimSec + interval) continue;

      const truth = truthFor(kind, this);
      if (truth === null || truth === undefined) {
        sensor.lastSampleSimSec = simSec;
        continue;
      }
      const reading = sensor.sample(truth, simSec);
      if (reading.value !== null) {
        this.txCount += 1;
        this.lastSeenSimSec = simSec;
      }
      readings.push(reading);
    }
    return readings;
  }

  healthSnapshot() {
    return {
      nodeId: this.id,
      role: this.role,
      lat: Number(this.lat.toFixed(6)),
      lon: Number(this.lon.toFixed(6)),
      alive: this.alive,
      dutyCycled: this.dutyCycled,
      stateOfCharge: Number(this.stateOfCharge.toFixed(3)),
      batteryWh: Number(this.batteryWh.toFixed(2)),
      sensors: Object.fromEntries(
        Object.entries(this.sensors).map(([k, s]) => [
          k,
          { model: s.spec.model, stuck: s.stuck, driftedBy: Number(s.drift.toFixed(4)) },
        ])
      ),
    };
  }
}

module.exports = { Sensor, SensorNode };
