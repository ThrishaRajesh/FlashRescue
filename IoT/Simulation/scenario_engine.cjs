const fs = require("fs");
const path = require("path");
const { WorldModel } = require("./world_model.cjs");
const { SensorNode } = require("./sensor_node.cjs");
const { Rng } = require("./util.cjs");

const SCENARIO_DIR = path.join(__dirname, "scenarios");
// Physics integration stays stable only with bounded steps, so fast-forwarding
// a multi-day event substeps rather than taking one giant leap.
const MAX_STEP_SEC = 30;

function listScenarios() {
  if (!fs.existsSync(SCENARIO_DIR)) return [];
  return fs
    .readdirSync(SCENARIO_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""));
}

function loadScenarioFile(name) {
  const file = path.join(SCENARIO_DIR, `${name}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(`Scenario "${name}" not found. Available: ${listScenarios().join(", ")}`);
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/**
 * Drives a WorldModel through a scripted timeline of forcing events, and owns
 * the sensor node network observing it. A scenario plus a seed fully determines
 * the run, so a demo or a paper figure is reproducible.
 */
class ScenarioEngine {
  constructor(scenario, opts = {}) {
    this.scenario = scenario;
    this.name = scenario.name;
    this.timeScale = opts.timeScale ?? scenario.timeScale ?? 60;
    this.rng = new Rng(opts.seed ?? scenario.seed ?? 20261021);

    this.world = new WorldModel({
      seed: opts.seed ?? scenario.seed,
      center: scenario.region?.center,
      latSpan: scenario.region?.latSpan,
      lonSpan: scenario.region?.lonSpan,
      climateZone: scenario.region?.climateZone,
      startTime: scenario.startTime,
      riverStations: scenario.riverStations || [],
      slopeUnits: scenario.slopeUnits || [],
      urbanCells: scenario.urbanCells || [],
    });

    this.nodes = this._buildNetwork(scenario.nodeGroups || []);
    this.world.seismicStations = this.nodes
      .filter((n) => n.kinds.includes("tremor"))
      .map((n) => ({ id: n.id, lat: n.lat, lon: n.lon }));
    this.pendingEvents = [...(scenario.events || [])]
      .map((e, i) => ({ ...e, _i: i }))
      .sort((a, b) => a.atHours - b.atHours);
    this.firedEvents = [];
    this.listeners = [];
  }

  onEvent(fn) {
    this.listeners.push(fn);
  }

  _scatter(count, groupId, group) {
    const { minLat, maxLat, minLon, maxLon } = this.world.bounds;
    const nodes = [];
    for (let i = 0; i < count; i++) {
      nodes.push(
        new SensorNode({
          id: `${groupId}-${i + 1}`,
          lat: this.rng.uniform(minLat, maxLat),
          lon: this.rng.uniform(minLon, maxLon),
          rng: this.rng,
          kinds: group.kinds,
          role: group.role,
          region: group.region,
          solarPowered: group.solarPowered ?? true,
          sampleIntervalOverrides: group.sampleIntervalOverrides,
        })
      );
    }
    return nodes;
  }

  _buildNetwork(groups) {
    const nodes = [];
    for (const group of groups) {
      if (group.perStation) {
        for (const station of this.world.stations.values()) {
          nodes.push(
            new SensorNode({
              id: `${group.id}-${station.id}`,
              lat: station.lat,
              lon: station.lon,
              rng: this.rng,
              kinds: group.kinds,
              role: group.role,
              stationRef: station.id,
              solarPowered: group.solarPowered ?? true,
              sampleIntervalOverrides: group.sampleIntervalOverrides,
            })
          );
        }
      } else if (group.perSlope) {
        for (const slope of this.world.slopes.values()) {
          nodes.push(
            new SensorNode({
              id: `${group.id}-${slope.id}`,
              lat: slope.lat,
              lon: slope.lon,
              rng: this.rng,
              kinds: group.kinds,
              role: group.role,
              slopeRef: slope.id,
              region: slope.region,
              solarPowered: group.solarPowered ?? true,
              sampleIntervalOverrides: group.sampleIntervalOverrides,
            })
          );
        }
      } else if (group.perUrban) {
        for (const cell of this.world.urbanCells.values()) {
          const node = new SensorNode({
            id: `${group.id}-${cell.id}`,
            lat: cell.lat,
            lon: cell.lon,
            rng: this.rng,
            kinds: group.kinds,
            role: group.role,
            solarPowered: group.solarPowered ?? true,
            sampleIntervalOverrides: group.sampleIntervalOverrides,
          });
          node.urbanRef = cell.id;
          nodes.push(node);
        }
      } else {
        nodes.push(...this._scatter(group.count ?? 0, group.id, group));
      }
    }
    return nodes;
  }

  _applyEvent(event) {
    const p = event.params || {};
    const w = this.world;

    switch (event.type) {
      case "storm":
        w.injectStorm(p.lat, p.lon, p);
        break;
      case "extreme_rain":
        w.setExtremeRain(p.on !== false);
        break;
      case "earthquake":
        w.triggerEarthquake(p);
        break;
      case "surge":
        w.injectSurge(p.stationId, p.cumecs ?? 2000);
        break;
      case "blockage":
        w.setBlockage(p.stationId, p.factor ?? 0.8, { impoundUpstream: p.impoundUpstream });
        break;
      case "cyclone":
        w.startCyclone(p);
        break;
      case "cyclone_landfall":
        if (w.cyclone) w.cyclone.landfall = true;
        break;
      case "fire":
        w.startFire(p);
        break;
      case "heat_wave":
        w.setHeatWave(p.deltaC ?? 5);
        break;
      case "sos":
        w.triggerSos(p.nodeId);
        break;
      case "dam_release":
        w.injectSurge(p.stationId, p.cumecs ?? 800);
        break;
      case "lake_drain":
        w.drainLake(p.stationId, p);
        break;
      case "basin_rain":
        w.setBasinRain(p.stationId, p.mmHr === undefined ? null : p.mmHr);
        break;
      default:
        return { ...event, applied: false, reason: "unknown_type" };
    }
    return { ...event, applied: true };
  }

  /** Drain early-warning detections accumulated since the last call. */
  takeSeismicDetections() {
    const out = this.pendingDetections || [];
    this.pendingDetections = [];
    return out;
  }

  /** Advance simulated time, substepping to keep the physics stable. */
  advance(dtSimSec) {
    let remaining = dtSimSec;
    this.pendingDetections = this.pendingDetections || [];
    while (remaining > 0) {
      const step = Math.min(MAX_STEP_SEC, remaining);
      this.world.tick(step);
      // Collected per substep, since the world clears its own buffer each tick.
      if (this.world.newSeismicDetections.length) {
        this.pendingDetections.push(...this.world.newSeismicDetections);
      }
      remaining -= step;

      const nowHours = this.world.simSec / 3600;
      while (this.pendingEvents.length && this.pendingEvents[0].atHours <= nowHours) {
        const event = this.pendingEvents.shift();
        const result = this._applyEvent(event);
        this.firedEvents.push({ ...result, firedAtSimSec: this.world.simSec });
        for (const fn of this.listeners) fn(result, this.world);
      }
    }
  }

  /**
   * Advance node power/drift by dtSec and collect any readings that came due.
   * Each sensor samples on its own realistic interval, not on the loop interval.
   */
  collectReadings(dtSec) {
    const simSec = this.world.simSec;
    const solar = this.world.solarIrradiance;
    const out = [];
    for (const node of this.nodes) {
      const readings = node.tick(dtSec, simSec, (kind, n) => this.world.truthFor(kind, n), solar);
      for (const r of readings) out.push({ node, reading: r });
    }
    return out;
  }

  summary() {
    const alive = this.nodes.filter((n) => n.alive).length;
    return {
      scenario: this.name,
      simTime: this.world.date.toISOString(),
      simHours: Number((this.world.simSec / 3600).toFixed(2)),
      nodes: this.nodes.length,
      nodesAlive: alive,
      nodesDutyCycled: this.nodes.filter((n) => n.dutyCycled).length,
      nodesOfflineAtSomePoint: this.nodes.filter((n) => n.offlineEpisodes > 0).length,
      nodesDutyCycledAtSomePoint: this.nodes.filter((n) => n.dutyCycledEver).length,
      lowestStateOfCharge: Number(Math.min(...this.nodes.map((n) => n.minStateOfCharge)).toFixed(3)),
      eventsFired: this.firedEvents.length,
      eventsPending: this.pendingEvents.length,
    };
  }
}

module.exports = { ScenarioEngine, loadScenarioFile, listScenarios, SCENARIO_DIR, MAX_STEP_SEC };
