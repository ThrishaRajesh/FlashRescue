#!/usr/bin/env node
/**
 * FlashRescue physics-based sensor network simulator.
 *
 * Replaces uniform random sampling with a shared physical world: storm cells
 * drift across the region, rivers respond with catchment lag, slopes accumulate
 * pore pressure, and each node degrades its observation through real hardware
 * limits, faults, battery state and a lossy link.
 *
 *   node sensor_sim.cjs --list
 *   node sensor_sim.cjs --scenario assam_brahmaputra_flood --speed 300
 *   node sensor_sim.cjs --scenario sikkim_glof_2023 --headless --duration 4
 *
 * Risk-bearing channels publish to  sensors/{nodeId}/{kind}   (feeds the risk grid)
 * Context channels publish to       telemetry/{nodeId}/{kind}
 * Node health publishes to          nodes/{nodeId}/health
 * World ground truth publishes to   sim/world
 */

const path = require("path");
const { ScenarioEngine, loadScenarioFile, listScenarios } = require("../Simulation/scenario_engine.cjs");
const { SimulatedTransport, buildLwtOptions } = require("../Simulation/transport.cjs");
const { hazardNorm, HAZARD_KINDS } = require("../Simulation/normalize.cjs");
const { classifyImd } = require("../Simulation/physics/rainfall.cjs");

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) args[key] = true;
      else {
        args[key] = next;
        i += 1;
      }
    } else args._.push(a);
  }
  return args;
}

const args = parseArgs(process.argv);

if (args.list) {
  const names = listScenarios();
  console.log("Available scenarios:\n");
  for (const n of names) {
    const s = loadScenarioFile(n);
    console.log(`  ${n}`);
    console.log(`      ${s.title}`);
    console.log(`      timeScale ${s.timeScale}x  duration ${s.durationHours}h  nodes in ${(s.nodeGroups || []).length} groups`);
  }
  process.exit(0);
}

const SCENARIO_NAME = args.scenario || process.env.SCENARIO || "normal_monsoon";
const BROKER = args.broker || process.env.MQTT_BROKER || "mqtt://localhost:1883";
const HEADLESS = Boolean(args.headless);
const TICK_MS = Number(args.tick || process.env.TICK_MS || 1000);
const IMPAIR = !args["no-impair"];

const scenario = loadScenarioFile(SCENARIO_NAME);
const engine = new ScenarioEngine(scenario, {
  timeScale: args.speed ? Number(args.speed) : undefined,
  seed: args.seed ? Number(args.seed) : undefined,
});

const MAX_SIM_HOURS = Number(args.duration || scenario.durationHours || 72);

/** Stand-in client so the physics can be validated with no broker running. */
function createHeadlessClient() {
  const topicCounts = new Map();
  return {
    headless: true,
    topicCounts,
    publish(topic, _payload) {
      const key = topic.split("/").slice(0, 2).join("/");
      topicCounts.set(key, (topicCounts.get(key) || 0) + 1);
    },
    subscribe() {},
    on() {},
    end(_force, cb) {
      if (cb) cb();
    },
  };
}

let client;
if (HEADLESS) {
  client = createHeadlessClient();
} else {
  const mqtt = require("mqtt");
  const lwt = buildLwtOptions(
    `flashrescue-sim-${Math.random().toString(16).slice(2, 8)}`,
    "sim/status",
    { scenario: SCENARIO_NAME }
  );
  client = mqtt.connect(BROKER, lwt);
  client.on("connect", () => {
    console.log(`Sensor simulator connected -> ${BROKER}`);
    console.log(`Scenario: ${scenario.title}`);
    console.log(`Time scale: ${engine.timeScale}x real time | ${engine.nodes.length} nodes`);
    if (scenario.gridHint) {
      console.log("\nNOTE: this scenario is outside the default Assam grid. Run risk_predictor.cjs with:");
      for (const [k, v] of Object.entries(scenario.gridHint)) {
        if (k !== "note") console.log(`  ${k}=${v}`);
      }
      console.log("");
    }
    client.publish(
      "sim/status",
      JSON.stringify({ event: "node_online", scenario: SCENARIO_NAME, ts: Date.now() }),
      { qos: 1, retain: true }
    );
    publishNodeRoster();
  });
  client.on("error", (e) => {
    console.error("MQTT connection error:", e.message);
    process.exit(1);
  });
}

const transport = new SimulatedTransport(client, engine.rng, {
  enabled: IMPAIR,
  instant: HEADLESS,
});

/**
 * Retained roster of the deployed network, so a dashboard opened at any time can
 * draw every node immediately instead of waiting for the slow health cycle.
 */
function publishNodeRoster() {
  client.publish(
    "sim/nodes",
    JSON.stringify({
      ts: Date.now(),
      scenario: SCENARIO_NAME,
      title: scenario.title,
      region: engine.world.bounds,
      center: engine.world.center,
      timeScale: engine.timeScale,
      nodes: engine.nodes.map((n) => ({
        nodeId: n.id,
        role: n.role,
        lat: Number(n.lat.toFixed(6)),
        lon: Number(n.lon.toFixed(6)),
        kinds: n.kinds,
        stationRef: n.stationRef,
        slopeRef: n.slopeRef,
        urbanRef: n.urbanRef || null,
        solarPowered: n.solarPowered,
      })),
    }),
    { qos: 1, retain: true }
  );
}

const nodeOnlineState = new Map();

engine.onEvent((event, world) => {
  const payload = {
    ts: Date.now(),
    simTime: world.date.toISOString(),
    simHours: Number((world.simSec / 3600).toFixed(3)),
    type: event.type,
    params: event.params || {},
    note: event.note || null,
    applied: event.applied,
  };
  // Scenario events bypass the lossy link: they are narration, not sensor data.
  client.publish("sim/events", JSON.stringify(payload), { qos: 1 });
  if (!HEADLESS) {
    console.log(`[${payload.simHours.toFixed(2)}h] EVENT ${event.type} — ${event.note || ""}`);
  }
});

/** Context objects a normalizer needs to anchor a reading to official thresholds. */
function contextFor(node) {
  const w = engine.world;
  return {
    station: node.stationRef ? w.stations.get(node.stationRef) : null,
    slope: node.slopeRef ? w.slopes.get(node.slopeRef) : null,
    urban: node.urbanRef ? w.urbanCells.get(node.urbanRef) : null,
    climateZone: w.atmosphere.climateZone,
  };
}

function publishReading(node, reading, rainMmHr) {
  const ctx = contextFor(node);
  const isHazard = HAZARD_KINDS.has(reading.kind);
  const norm = isHazard ? hazardNorm(reading.kind, reading.value, ctx) : null;

  const payload = {
    nodeId: node.id,
    ts: Date.now(),
    simTime: engine.world.date.toISOString(),
    lat: Number(node.lat.toFixed(6)),
    lon: Number(node.lon.toFixed(6)),
    type: reading.kind,
    value: reading.value,
    unit: reading.unit,
    quality: reading.quality,
    role: node.role,
    sensorModel: node.sensors[reading.kind].spec.model,
  };

  if (norm !== null) payload.valueNorm = Number(norm.toFixed(4));

  if (ctx.station && reading.kind === "water") {
    // `value` is the gauge reading above gauge zero; the absolute datum stage and
    // the official levels it must be compared against live here.
    payload.gaugeZeroM = ctx.station.bedLevelM;
    payload.station = {
      id: ctx.station.id,
      name: ctx.station.name,
      stageM: Number(ctx.station.stage.toFixed(3)),
      state: ctx.station.state,
      warningLevelM: ctx.station.warningLevelM,
      dangerLevelM: ctx.station.dangerLevelM,
      hflM: ctx.station.hflM,
      aboveDangerM: Number((ctx.station.stage - ctx.station.dangerLevelM).toFixed(3)),
      risingRateMPerHour: Number((ctx.station.dStageDt * 3600).toFixed(4)),
      rain24hMm: Number(ctx.station.rain24h.total.toFixed(1)),
      imdBand: classifyImd(ctx.station.rain24h.total),
    };
  }

  if (ctx.slope && (reading.kind === "soil" || reading.kind === "tilt")) {
    payload.slope = ctx.slope.snapshot();
  }

  if (reading.kind === "tremor") {
    const active = engine.world.seismic.activeEvents(node.lat, node.lon);
    if (active.length) payload.seismic = active[0];
  }

  const topic = isHazard
    ? `sensors/${node.id}/${reading.kind}`
    : `telemetry/${node.id}/${reading.kind}`;

  transport.publish(topic, payload, { qos: 0, rainMmHr });
}

function publishNodeStatusChanges() {
  for (const node of engine.nodes) {
    const prev = nodeOnlineState.get(node.id);
    const now = node.alive;
    if (prev === undefined || prev !== now) {
      nodeOnlineState.set(node.id, now);
      // Retained so a late-joining dashboard immediately knows which nodes are dark.
      client.publish(
        `nodes/${node.id}/status`,
        JSON.stringify({
          nodeId: node.id,
          event: now ? "node_online" : "node_offline",
          reason: now ? "battery_recovered" : "battery_depleted",
          stateOfCharge: Number(node.stateOfCharge.toFixed(3)),
          ts: Date.now(),
        }),
        { qos: 1, retain: true }
      );
    }
  }
}

let lastHealthPublish = 0;
let lastWorldPublish = 0;
let tickCount = 0;
const eewLog = [];

function loop() {
  const dtSimSec = (TICK_MS / 1000) * engine.timeScale;
  engine.advance(dtSimSec);

  const readings = engine.collectReadings(dtSimSec);
  for (const { node, reading } of readings) {
    if (reading.value === null) continue;
    const rainMmHr = engine.world.rainfallAt(node.lat, node.lon);
    publishReading(node, reading, rainMmHr);
  }

  transport.tick(dtSimSec);
  publishNodeStatusChanges();

  // Earthquake early warning. Published as a triggered-event record rather than
  // a sensor reading, because that is how a real EEW network disseminates: the
  // alert must outrun the S wave, so it cannot wait on routine telemetry.
  for (const detection of engine.takeSeismicDetections()) {
    const best = detection.earliestDetection;
    const payload = {
      ts: Date.now(),
      simTime: engine.world.date.toISOString(),
      event: detection.event,
      stations: detection.stations,
      firstDetection: best || null,
      leadTimeByDistance: detection.leadTimeByDistance,
    };
    client.publish("events/seismic", JSON.stringify(payload), { qos: 1 });
    if (!HEADLESS) {
      const spread = detection.leadTimeByDistance
        .map((l) => `${l.distanceKm}km:${l.leadTimeSec}s`)
        .join("  ");
      console.log(
        `[EEW] M${detection.event.magnitude} depth ${detection.event.depthKm}km — ` +
          (best ? `detected at ${best.stationId} | warning lead ${spread}` : "below detection threshold")
      );
    }
    eewLog.push(payload);
  }

  const nowMs = Date.now();
  if (nowMs - lastWorldPublish > 2000) {
    lastWorldPublish = nowMs;
    client.publish("sim/world", JSON.stringify(engine.world.snapshot()), { qos: 0 });
    client.publish(
      "sim/stats",
      JSON.stringify({ ts: nowMs, ...engine.summary(), transport: transport.snapshot() }),
      { qos: 0 }
    );
  }
  if (nowMs - lastHealthPublish > 10000) {
    lastHealthPublish = nowMs;
    for (const node of engine.nodes) {
      client.publish(`nodes/${node.id}/health`, JSON.stringify(node.healthSnapshot()), { qos: 0 });
    }
  }

  tickCount += 1;
  if (!HEADLESS && tickCount % 10 === 0) {
    const s = engine.summary();
    const w = engine.world.snapshot();
    const worstStation = w.stations.slice().sort((a, b) => b.normalizedRisk - a.normalizedRisk)[0];
    console.log(
      `[${s.simHours.toFixed(2)}h] readings=${readings.length} ` +
        `rain24h=${w.rain24hMm}mm (${w.imdBand}) ` +
        `storms=${w.rainfall.cells.length} ` +
        (worstStation ? `${worstStation.id}=${worstStation.stageM}m/${worstStation.state} ` : "") +
        `nodes=${s.nodesAlive}/${s.nodes} ` +
        `tx=${transport.stats.sent} drop=${transport.stats.dropped}` +
        (transport.partitioned ? " [PARTITIONED]" : "")
    );
  }

  if (engine.world.simSec / 3600 >= MAX_SIM_HOURS) {
    finish();
    return;
  }

  if (HEADLESS) setImmediate(loop);
}

function finish() {
  const s = engine.summary();
  const w = engine.world.snapshot();
  console.log("\n=== Scenario complete ===");
  console.log(`${scenario.title}`);
  console.log(`Simulated ${s.simHours}h | events fired ${s.eventsFired}/${s.eventsFired + s.eventsPending}`);
  console.log(
    `Nodes alive ${s.nodesAlive}/${s.nodes} now | ` +
      `${s.nodesOfflineAtSomePoint} went offline and ${s.nodesDutyCycledAtSomePoint} duty-cycled at some point | ` +
      `lowest battery ${(s.lowestStateOfCharge * 100).toFixed(0)}%`
  );
  console.log(`Rain 24h final ${w.rain24hMm} mm (${w.imdBand}) | PEAK ${w.peakRain24hMm} mm (${w.peakImdBand})`);
  console.log("\nRiver stations (peak of run):");
  for (const st of w.stations) {
    const above = (st.peakStageM - st.dangerLevelM).toFixed(2);
    console.log(
      `  ${st.id.padEnd(14)} peak ${String(st.peakStageM).padStart(9)} m  ` +
        `Q ${String(st.peakDischargeCumecs).padStart(8)} m3/s  ${String(st.peakState).padEnd(14)} ` +
        `vs DL ${st.dangerLevelM}m (${above > 0 ? "+" : ""}${above}m)  final ${st.state}`
    );
  }
  if (w.slopes.length) {
    console.log("\nSlope units:");
    for (const sl of w.slopes) {
      console.log(
        `  ${sl.id.padEnd(16)} API ${String(sl.apiMm).padStart(7)}mm  pore ${sl.poreePressure}  ` +
          `I/D ${sl.exceedanceRatio} (event ${sl.eventRainMm}mm/${sl.eventDurationH}h)  ` +
          `tilt ${sl.tiltDeg} deg  susceptibility ${sl.susceptibility}  ` +
          `failures ${sl.failureCount}${sl.failureActive ? " [ACTIVE]" : ""}` +
          (sl.lastFailureMode ? ` (${sl.lastFailureMode})` : "")
      );
    }
  }
  if (w.urban.length) {
    console.log("\nUrban waterlogging:");
    for (const u of w.urban) {
      console.log(
        `  ${u.id.padEnd(18)} peak ponding ${String(u.peakPondingMm).padStart(7)} mm  ` +
          `final ${String(u.pondingMm).padStart(7)} mm${u.tideLocked ? "  [TIDE-LOCKED]" : ""}`
      );
    }
  }
  if (w.fires.length) {
    console.log("\nFires:");
    for (const f of w.fires) console.log(`  ${f.id} radius ${f.radiusM}m intensity ${f.intensity}`);
  }
  if (w.cyclone) {
    console.log(
      `\nCyclone ${w.cyclone.name}: peak ${w.cyclone.minPressureHpa} hPa (${w.cyclone.peakCategory}), ` +
        `now ${w.cyclone.centralPressureHpa} hPa (${w.cyclone.category})` +
        (w.cyclone.landfall ? " — post-landfall, filling" : "")
    );
  }
  if (eewLog.length) {
    console.log("\nEarthquake early warning:");
    for (const e of eewLog) {
      const b = e.firstDetection;
      console.log(
        `  M${e.event.magnitude} depth ${e.event.depthKm}km${e.event.isAftershock ? " (aftershock)" : ""} -> ` +
          (b
            ? `detected ${b.detectionDelaySec}s after P arrival at ${b.stationId} ` +
              `(${b.distanceKm}km away, PGA ${b.pgaG}g)`
            : "not detected")
      );
      if (b) {
        console.log(
          "      warning lead for targets: " +
            e.leadTimeByDistance.map((l) => `${l.distanceKm}km = ${l.leadTimeSec}s`).join(", ")
        );
      }
    }
  }
  console.log("\nTransport:", JSON.stringify(transport.snapshot()));
  if (client.headless) {
    console.log("\nPublished message counts by topic prefix:");
    const sorted = Array.from(client.topicCounts.entries()).sort((a, b) => b[1] - a[1]);
    for (const [topic, count] of sorted.slice(0, 15)) {
      console.log(`  ${topic.padEnd(28)} ${count}`);
    }
  }
  try {
    client.end(false, () => process.exit(0));
  } catch (e) {
    process.exit(0);
  }
}

if (HEADLESS) {
  console.log(`Headless run: ${scenario.title}`);
  console.log(`Simulating ${MAX_SIM_HOURS}h at ${engine.timeScale}x with ${engine.nodes.length} nodes\n`);
  loop();
} else {
  console.log(`Starting scenario "${SCENARIO_NAME}" — ${engine.nodes.length} nodes, ${engine.timeScale}x speed`);
  setInterval(loop, TICK_MS);
}

process.on("SIGINT", () => {
  console.log("\nSimulator shutting down...");
  finish();
});
