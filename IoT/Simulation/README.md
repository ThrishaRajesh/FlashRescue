# FlashRescue sensor simulation

A physics-based replacement for the original `Math.random()` sensor feed.

Every reading published to MQTT is a **degraded observation of a shared physical
world**: storm cells drift across the region, catchments convert rainfall to
discharge with real lag, slopes accumulate pore pressure, and each node corrupts
its measurement through genuine hardware limits, faults, battery state and a
lossy radio link.

The point is that nothing is independently random. Neighbouring gauges agree
because they sample the same storm. A river keeps rising after the rain stops
because catchment routing says it must. That is what makes the risk grid,
diffusion forecast and A* routing downstream meaningful rather than decorative.

---

## Running it

```bash
node Publishers/sensor_sim.cjs --list                  # show scenarios
node Publishers/sensor_sim.cjs --scenario normal_monsoon
node Publishers/sensor_sim.cjs --scenario sikkim_glof_2023 --speed 30

# Validate the physics with no broker running:
node Publishers/sensor_sim.cjs --scenario assam_brahmaputra_flood --headless
```

| Flag | Meaning |
|---|---|
| `--scenario <name>` | Scenario to replay (default `normal_monsoon`) |
| `--speed <n>` | Simulated seconds per real second; overrides the scenario default |
| `--duration <h>` | Stop after this many simulated hours |
| `--headless` | Run with no broker, as fast as possible, then print a summary |
| `--seed <n>` | Override the scenario seed |
| `--tick <ms>` | Real-time loop interval (default 1000) |
| `--no-impair` | Disable packet loss, jitter and outages |
| `--broker <url>` | MQTT broker (default `mqtt://localhost:1883`) |

Some scenarios cover a region other than the default Assam box. Those print the
`CENTER_LAT` / `LAT_SPAN` environment variables to use with `risk_predictor.cjs`
so the risk grid actually covers the sensors.

## Topics published

| Topic | Contents |
|---|---|
| `sensors/{nodeId}/{kind}` | Risk-bearing channels, with `valueNorm` feeding the risk grid |
| `telemetry/{nodeId}/{kind}` | Context channels (temperature, humidity) with no risk weight |
| `nodes/{nodeId}/health` | Battery, drift, stuck sensors, hardware models |
| `nodes/{nodeId}/status` | Retained online/offline, for dead-node detection |
| `events/seismic` | Triggered earthquake records with early-warning lead times |
| `sim/world` | Full ground-truth world state (for dashboards and validation) |
| `sim/events` | Scenario timeline narration as events fire |
| `sim/stats` | Node and transport statistics |

Risk and context channels are deliberately separated. Publishing temperature on
the risk topic would dilute the grid, because every benign reading drags a cell's
smoothed risk back toward zero.

---

## The model

### Rainfall
Occurrence is a two-state wet/dry Markov chain using IMD-derived **daily**
transition probabilities, rescaled to the simulation step through the chain's
second eigenvalue (applying daily probabilities at a 10-minute step would make
wet spells ~144x too short). Intensity comes from drifting Gaussian **storm
cells** with a diurnal cycle; around 8% are **quasi-stationary**, which is the
mechanism behind India's extreme daily totals.

### Hydrology
Rainfall feeds a **Nash linear-reservoir cascade** (K is per reservoir, so total
lag ≈ `n × K`: ~2h for a small catchment, ~48h for the Brahmaputra main stem),
then an inverted **rating curve** `Q = a(h − h₀)^b` converts discharge to stage.
Above bank-full a **compound channel** applies, because a river spreading across
its floodplain gains stage far more slowly — without it the model predicts stages
metres above the recorded highest flood level.

Levels are classified using CWC vocabulary: Warning, Danger, HFL, and
*Unprecedented* at or above the record.

GLOF, dam-break and storm-surge waves **bypass the cascade** as unit-hydrograph
pulses, since a sharp channel flood wave is not catchment runoff and would
otherwise be smeared into nothing.

### Landslides
Antecedent Rainfall Index plus a lagged pore-pressure reservoir, assessed against
**published Indian regional intensity–duration thresholds** (`I = αD^β`). The
threshold is evaluated over a continuous **rainfall event** (ended by a 6-hour dry
gap), not a fixed trailing window, because that is what the published curves
describe. Failure requires both a saturated slope and a threshold crossing, then
relaxes and enters a cooldown — a slope that has failed has shed its material.

### Seismic
Gutenberg–Richter magnitudes, Poisson timing, Omori aftershock sequences capped
by Båth's law, and a simple attenuation relation for PGA.

**Early warning is simulated honestly.** STA/LTA needs sub-second samples, but
the main loop ticks at 20–300 simulated seconds. So when an event occurs, a short
burst of the station's real 100 Hz accelerometer stream is simulated across the
P-to-S window and the detector runs on that — producing a genuine detection time
and therefore a genuine lead time. Reported lead times are given **by target
distance**, because detection happens near the epicentre while the alert protects
places the S wave has not yet reached.

### Atmosphere, fire, cyclone, urban
Diurnal and seasonal temperature with IMD heat-wave classification; fuel moisture
driven by an equilibrium-moisture relation with Rothermel-style spread and a
**downwind-advected smoke plume** (so plume direction locates a fire, not just its
presence); the **Holland** radial wind profile with pressure as the leading
cyclone indicator and shelf-amplified surge; and urban ponding where drainage
capacity degrades with clogging and goes to zero under **tide lock**.

### Hardware and link realism
Each reading passes through `truth → drift → fouling → noise → fault injection →
saturation → quantization`. Saturation and quantization are what make a feed look
like real instruments: a tipping bucket can only report multiples of 0.2 mm.
Faults include stuck-at, spikes, dropouts, NaN and calibration drift.

The link applies packet loss worsened by **rain fade**, lognormal latency jitter,
reordering, and whole-region outages with **store-and-forward replay** — so
downstream services must cope with late and out-of-order data. Solar nodes charge
against cloud cover and duty-cycle or die when depleted, which during a long
monsoon means losing sensing exactly when it matters most.

---

## Calibration

The rainfall model is tuned against Brahmaputra-valley climatology rather than by
eye. Measured over 180 simulated July days across 6 seeds:

| Metric | Simulated | Target |
|---|---|---|
| Mean daily rainfall | ~22 mm | 11–25 mm (valley range) |
| Median daily | ~12 mm | light-band median |
| Days above IMD "heavy" (64.5 mm) | ~8% | ~10% |
| Days above "very heavy" (115.6 mm) | ~2% | ~2% |
| Dry days (<2.5 mm) | ~36% | 35–45% |
| Maximum daily | ~225 mm | extremes present |
| Non-monsoon mean / dry days | ~2 mm / 86% | strongly dry |

Scenario results are checked against the real events: the Sikkim GLOF peaks at
**7,420 m³/s at Chungthang** against an observed ~7,355 m³/s, and the wave covers
67 km in ~2h20m (~29 km/h), matching the reconstruction.

Reproducibility: a scenario plus a seed fully determines a run. Physics and
instrument randomness draw from **separate streams**, so the world evolves
identically regardless of how many sensors are deployed to observe it.

---

## Files

```
Simulation/
├── config.cjs            Published thresholds and hardware specs (IMD, CWC, I-D curves)
├── util.cjs              Seeded RNG, distributions, geodesy
├── world_model.cjs       Shared world state and the scenario hooks
├── sensor_node.cjs       Sensor signal chain, faults, solar/battery
├── transport.cjs         Loss, jitter, reordering, outages, store-and-forward
├── normalize.cjs         Reading -> 0..1 risk, anchored on official thresholds
├── scenario_engine.cjs   Timeline replay and node network construction
├── physics/
│   ├── rainfall.cjs      Markov occurrence, storm cells, IMD bands
│   ├── hydrology.cjs     Nash cascade, rating curves, CWC states, ponding
│   ├── landslide.cjs     API, pore pressure, I-D thresholds
│   ├── seismic.cjs       GR/Omori, PGA, STA/LTA, early warning
│   ├── atmosphere.cjs    Temperature, humidity, pressure, wind, heat wave
│   ├── fire.cjs          Fuel moisture, spread, smoke plume
│   └── cyclone.cjs       Holland profile, surge
└── scenarios/            Replayable real Indian events
```

## Scenarios

| Scenario | What it demonstrates |
|---|---|
| `normal_monsoon` | Control run — nothing should escalate to a high-risk zone |
| `assam_brahmaputra_flood` | Basin-scale flood; river keeps rising after rain stops |
| `sikkim_glof_2023` | Seismic precedes water; lake gauge **falls**; wave propagates downstream in sequence |
| `chamoli_2021` | Debris flood with **zero rainfall** — rain-only models see nothing coming |
| `ne_quake_cascade` | Quake → landslide dam → downstream gauge **falls** while upstream rises → breach → outburst flood |
| `chennai_urban_2015` | Urban ponding and tide lock, with almost no river signal |
| `cyclone_amphan` | Pressure as the leading indicator, hours before the wind |
| `joshimath_subsidence` | Slow creep over weeks; a short-memory filter averages it away entirely |
| `uttarakhand_forest_fire` | Heat wave, fuel drying, and directional smoke detection |

Each scenario's `events` array carries `note` fields explaining what each forcing
represents, and those notes are published to `sim/events` as the run proceeds.
