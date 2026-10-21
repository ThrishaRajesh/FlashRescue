const { Rng, clamp } = require("./util.cjs");
const { RainfallField, classifyImd } = require("./physics/rainfall.cjs");
const { RiverStation, UrbanDrainageCell } = require("./physics/hydrology.cjs");
const { SlopeUnit } = require("./physics/landslide.cjs");
const { SeismicCatalogue, simulateEewDetection, leadTimesForTargets } = require("./physics/seismic.cjs");
const { Atmosphere } = require("./physics/atmosphere.cjs");
const { FireWeather, FireFront, smokeToSensorValues } = require("./physics/fire.cjs");
const { Cyclone } = require("./physics/cyclone.cjs");
const { HYDROLOGY } = require("./config.cjs");

/** Rolling-window accumulator for rainfall totals (IMD bands are 24-hour). */
class Accumulator {
  constructor(windowHours = 24, bucketMinutes = 15) {
    this.bucketMinutes = bucketMinutes;
    this.count = (windowHours * 60) / bucketMinutes;
    this.buckets = new Array(this.count).fill(0);
    this.index = 0;
    this.secondsInBucket = 0;
  }

  add(amount, dtSec) {
    this.buckets[this.index] += amount;
    this.secondsInBucket += dtSec;
    while (this.secondsInBucket >= this.bucketMinutes * 60) {
      this.secondsInBucket -= this.bucketMinutes * 60;
      this.index = (this.index + 1) % this.count;
      this.buckets[this.index] = 0;
    }
  }

  get total() {
    return this.buckets.reduce((a, b) => a + b, 0);
  }
}

/**
 * The shared physical world. Every sensor reading in the simulation is a sampled,
 * degraded observation of state held here — so neighbouring nodes agree, hazards
 * propagate, and effects lag their causes the way they do in the field.
 */
class WorldModel {
  constructor(opts = {}) {
    this.seed = opts.seed ?? 20261021;
    this.rng = new Rng(this.seed);
    // Instrument-level randomness (sensor noise bursts, early-warning waveform
    // simulation) draws from a separate stream so the physical world evolves
    // identically regardless of how many sensors are deployed to observe it.
    this.instrumentRng = new Rng(this.seed ^ 0x5eed);

    this.center = opts.center || { lat: 26.2006, lon: 92.9376 };
    const latSpan = opts.latSpan ?? 0.12;
    const lonSpan = opts.lonSpan ?? 0.12;
    this.bounds = {
      minLat: this.center.lat - latSpan / 2,
      maxLat: this.center.lat + latSpan / 2,
      minLon: this.center.lon - lonSpan / 2,
      maxLon: this.center.lon + lonSpan / 2,
    };

    this.startTime = opts.startTime ? new Date(opts.startTime) : new Date();
    this.simSec = 0;

    this.rainfall = new RainfallField(this.rng, this.bounds, { startDate: this.startTime });
    this.atmosphere = new Atmosphere(this.rng, {
      climateZone: opts.climateZone || "plains",
      lat: this.center.lat,
      lon: this.center.lon,
    });
    this.seismic = new SeismicCatalogue(this.rng, this.bounds);
    this.fireWeather = new FireWeather();
    this.fires = [];
    this.cyclone = null;

    // Registered by the scenario engine so early-warning lead times can be
    // computed at the locations that actually have accelerometers.
    this.seismicStations = [];
    this.newSeismicDetections = [];

    this.stations = new Map();
    this.slopes = new Map();
    this.urbanCells = new Map();
    this.sosPending = new Set();

    this.regionRain24h = new Accumulator(24);
    this.peakRain24hMm = 0;
    this.tideLevel = 0;

    for (const s of opts.riverStations || []) this.addRiverStation(s);
    for (const s of opts.slopeUnits || []) this.addSlopeUnit(s);
    for (const u of opts.urbanCells || []) this.addUrbanCell(u);
  }

  get date() {
    return new Date(this.startTime.getTime() + this.simSec * 1000);
  }

  addRiverStation(opts) {
    const station = new RiverStation(opts);
    station.rain24h = new Accumulator(24);
    this.stations.set(station.id, station);
    return station;
  }

  addSlopeUnit(opts) {
    const slope = new SlopeUnit(opts);
    this.slopes.set(slope.id, slope);
    return slope;
  }

  addUrbanCell(opts) {
    const cell = new UrbanDrainageCell(opts);
    cell.id = opts.id;
    cell.lat = opts.lat;
    cell.lon = opts.lon;
    this.urbanCells.set(cell.id, cell);
    return cell;
  }

  /** Solar irradiance 0..1 from the hour angle, attenuated by cloud. */
  get solarIrradiance() {
    const hour = (this.date.getUTCHours() + this.date.getUTCMinutes() / 60 + 5.5) % 24;
    const elevation = Math.sin((Math.PI * (hour - 6)) / 12);
    if (elevation <= 0) return 0;
    return elevation * (1 - 0.75 * this.atmosphere.cloudCover);
  }

  rainfallAt(lat, lon) {
    let r = this.rainfall.intensityAt(lat, lon, this.date);
    if (this.cyclone) r += this.cyclone.rainfallAt(lat, lon);
    return r;
  }

  tick(dtSec) {
    this.simSec += dtSec;
    const date = this.date;

    // Semi-diurnal tide, normalised 0..1 — drives tide lock and backwater.
    const tidePhase = (this.simSec / 3600 / HYDROLOGY.tideLockPeriodHours) * 2 * Math.PI;
    this.tideLevel = (Math.sin(tidePhase) + 1) / 2;

    this.rainfall.tick(dtSec, date);
    if (this.cyclone) this.cyclone.tick(dtSec);

    const centreRain = this.rainfallAt(this.center.lat, this.center.lon);
    this.atmosphere.setSamplePoint(this.center.lat, this.center.lon);
    // Active storm cells imply overcast even when the Markov wet/dry state says
    // dry — otherwise a scenario's scripted storms would rain under a clear sky.
    const overcast = this.rainfall.wet || this.rainfall.cells.length > 0 || Boolean(this.cyclone);
    this.atmosphere.tick(dtSec, date, centreRain, this.cyclone, overcast);
    this.regionRain24h.add((centreRain * dtSec) / 3600, dtSec);
    this.peakRain24hMm = Math.max(this.peakRain24hMm, this.regionRain24h.total);

    this.seismic.tick(dtSec);
    this.newSeismicDetections = [];
    const pendingQuakes = this.seismic.newEvents;
    this.seismic.newEvents = [];
    for (const event of pendingQuakes) {
      // Only events strong enough to matter get an early-warning evaluation.
      if (event.magnitude < 4.0) continue;
      const stations = this.seismicStations.map((s) => ({
        stationId: s.id,
        ...simulateEewDetection(event, s.lat, s.lon, this.instrumentRng),
      }));
      const detected = stations.filter((s) => s.detected);
      const earliest = detected.length
        ? detected.reduce((a, b) => (a.detectedAtSimSec <= b.detectedAtSimSec ? a : b))
        : null;
      this.newSeismicDetections.push({
        event: event.snapshot(),
        stations,
        earliestDetection: earliest,
        leadTimeByDistance: earliest ? leadTimesForTargets(event, earliest.detectedAtSimSec) : [],
      });
    }
    this.fireWeather.tick(dtSec, this.atmosphere, centreRain);
    for (const f of this.fires) f.tick(dtSec, this.atmosphere, this.fireWeather, this.rainfallAt(f.lat, f.lon));
    this.fires = this.fires.filter((f) => f.active);

    for (const station of this.stations.values()) {
      const rain = this.rainfallAt(station.lat, station.lon);
      station.rain24h.add((rain * dtSec) / 3600, dtSec);
      station.tick(dtSec, rain, this.tideLevel);
    }

    // Transfer flow withheld by any blockage into the impoundment upstream of it.
    if (this.blockagePairs) {
      for (const [blockedId, upstreamId] of this.blockagePairs) {
        const blocked = this.stations.get(blockedId);
        const upstream = upstreamId ? this.stations.get(upstreamId) : null;
        if (!blocked || !upstream) continue;
        const withheld = blocked.naturalDischarge * blocked.blockageFactor;
        upstream.addImpoundedVolume(withheld * dtSec);
      }
    }

    for (const slope of this.slopes.values()) {
      slope.tick(dtSec, this.rainfallAt(slope.lat, slope.lon));
    }

    for (const cell of this.urbanCells.values()) {
      cell.tick(dtSec, this.rainfallAt(cell.lat, cell.lon), this.tideLevel);
    }
  }

  /**
   * Ground truth for a sensor channel at a node. Sensors then degrade this value;
   * nothing downstream ever sees these numbers directly.
   */
  truthFor(kind, node) {
    switch (kind) {
      case "rain":
        return this.rainfallAt(node.lat, node.lon);

      case "water": {
        if (node.stationRef && this.stations.has(node.stationRef)) {
          // An ultrasonic or pressure gauge measures depth above its own gauge
          // zero (a 0-10 m instrument range), not absolute elevation above sea
          // level. Returning the datum stage would saturate every reading.
          const station = this.stations.get(node.stationRef);
          return station.stage - station.bedLevelM;
        }
        if (node.urbanRef && this.urbanCells.has(node.urbanRef)) {
          return this.urbanCells.get(node.urbanRef).pondingMm / 1000;
        }
        return null;
      }

      case "soil":
        return node.slopeRef && this.slopes.has(node.slopeRef)
          ? this.slopes.get(node.slopeRef).soilMoisturePercent
          : null;

      case "tilt":
        return node.slopeRef && this.slopes.has(node.slopeRef)
          ? this.slopes.get(node.slopeRef).tiltDeg
          : null;

      case "tremor":
        return this.seismic.accelerationAt(node.lat, node.lon);

      case "co":
      case "pm25": {
        let factor = 0;
        for (const f of this.fires) factor = Math.max(factor, f.smokeFactorAt(node.lat, node.lon, this.atmosphere));
        const values = smokeToSensorValues(factor);
        return kind === "co" ? values.coPpm : values.pm25;
      }

      case "temp":
        return this.atmosphere.temperatureC;
      case "humidity":
        return this.atmosphere.humidityPct;
      case "pressure":
        return this.cyclone
          ? this.cyclone.pressureAt(node.lat, node.lon)
          : this.atmosphere.pressureHpa;
      case "wind":
        return this.cyclone
          ? Math.max(this.atmosphere.windMs, this.cyclone.windAt(node.lat, node.lon))
          : this.atmosphere.windMs;

      case "sos": {
        if (this.sosPending.has(node.id)) {
          this.sosPending.delete(node.id);
          return 1;
        }
        return 0;
      }

      default:
        return null;
    }
  }

  // ---- Scenario hooks -------------------------------------------------------

  injectStorm(lat, lon, opts) {
    return this.rainfall.injectCell(lat ?? this.center.lat, lon ?? this.center.lon, opts);
  }

  setExtremeRain(on) {
    this.rainfall.setExtremeMode(on);
  }

  triggerEarthquake(opts) {
    return this.seismic.inject(opts);
  }

  /** GLOF / dam break: a short, very large discharge pulse into a station. */
  injectSurge(stationId, cumecs) {
    const station = this.stations.get(stationId);
    if (station) station.injectSurge(cumecs);
    return station;
  }

  /**
   * Landslide dam. The blocked station passes less flow downstream; the withheld
   * volume accumulates at `impoundUpstream` (the gauge above the dam), so that
   * gauge RISES while the downstream one FALLS — the counter-intuitive signature
   * that makes a landslide dam dangerous to misread.
   */
  setBlockage(stationId, factor, { impoundUpstream = null } = {}) {
    const station = this.stations.get(stationId);
    if (!station) return null;
    station.setBlockage(factor);

    this.blockagePairs = this.blockagePairs || new Map();
    if (factor > 0) {
      this.blockagePairs.set(stationId, impoundUpstream);
    } else {
      // Breach: the stored volume is released as a flood wave downstream.
      const upstreamId = this.blockagePairs.get(stationId);
      this.blockagePairs.delete(stationId);
      const upstream = upstreamId ? this.stations.get(upstreamId) : null;
      if (upstream) {
        const volume = upstream.releaseImpoundment();
        // Convert stored volume to a peak discharge over a ~30 min breach.
        const peak = volume / (30 * 60);
        if (peak > 1) station.injectSurge(peak, { riseMinutes: 12 });
      }
    }
    return station;
  }

  /** Basin-average rainfall forcing for catchments larger than the simulated box. */
  setBasinRain(stationId, mmHr) {
    const station = this.stations.get(stationId);
    if (station) station.setBasinRain(mmHr);
    return station;
  }

  /** Glacial lake emptying: the lake gauge falls abruptly before anything downstream moves. */
  drainLake(stationId, { stageDropM = 20, baseflowCumecs = 5 } = {}) {
    const station = this.stations.get(stationId);
    if (station) {
      station.setStageOffset(-Math.abs(stageDropM));
      station.setBaseflow(baseflowCumecs);
    }
    return station;
  }

  startCyclone(opts) {
    this.cyclone = new Cyclone(this.rng, opts);
    return this.cyclone;
  }

  startFire(opts) {
    const fire = new FireFront({ id: opts.id || `fire-${this.fires.length + 1}`, ...opts });
    this.fires.push(fire);
    return fire;
  }

  setHeatWave(deltaC) {
    this.atmosphere.setHeatWaveForcing(deltaC);
  }

  triggerSos(nodeId) {
    this.sosPending.add(nodeId);
  }

  snapshot() {
    return {
      simSec: Math.round(this.simSec),
      simTime: this.date.toISOString(),
      seed: this.seed,
      center: this.center,
      bounds: this.bounds,
      tideLevel: Number(this.tideLevel.toFixed(3)),
      solarIrradiance: Number(this.solarIrradiance.toFixed(3)),
      rain24hMm: Number(this.regionRain24h.total.toFixed(1)),
      peakRain24hMm: Number(this.peakRain24hMm.toFixed(1)),
      imdBand: classifyImd(this.regionRain24h.total),
      peakImdBand: classifyImd(this.peakRain24hMm),
      rainfall: this.rainfall.snapshot(),
      atmosphere: this.atmosphere.snapshot(),
      fireWeather: this.fireWeather.snapshot(),
      fires: this.fires.map((f) => f.snapshot()),
      cyclone: this.cyclone ? this.cyclone.snapshot() : null,
      seismicActive: this.seismic.activeEvents(this.center.lat, this.center.lon),
      stations: Array.from(this.stations.values()).map((s) => ({
        ...s.snapshot(),
        rain24hMm: Number(s.rain24h.total.toFixed(1)),
        imdBand: classifyImd(s.rain24h.total),
        normalizedRisk: Number(s.normalizedRisk.toFixed(3)),
      })),
      slopes: Array.from(this.slopes.values()).map((s) => s.snapshot()),
      urban: Array.from(this.urbanCells.values()).map((u) => ({
        id: u.id,
        lat: u.lat,
        lon: u.lon,
        pondingMm: Number(u.pondingMm.toFixed(1)),
        peakPondingMm: Number(u.peakPondingMm.toFixed(1)),
        tideLocked: u.tideLocked,
        normalizedRisk: Number(u.normalizedRisk.toFixed(3)),
      })),
    };
  }
}

module.exports = { WorldModel, Accumulator };
