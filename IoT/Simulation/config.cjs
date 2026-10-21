/**
 * Real-world constants for the FlashRescue sensor simulation.
 * Values here are published/official figures, not tuning knobs — see citations.
 */

// IMD 24-hour rainfall classification (mm). Source: IMD rainfall terminology.
const IMD_RAINFALL_BANDS = [
  { name: "No rain", min: 0, max: 0.09 },
  { name: "Very light", min: 0.1, max: 2.4 },
  { name: "Light", min: 2.5, max: 15.5 },
  { name: "Moderate", min: 15.6, max: 64.4 },
  { name: "Heavy", min: 64.5, max: 115.5 },
  { name: "Very heavy", min: 115.6, max: 204.4 },
  { name: "Extremely heavy", min: 204.5, max: Infinity },
];

// IMD colour-coded warning levels.
const IMD_WARNING_COLORS = ["GREEN", "YELLOW", "ORANGE", "RED"];

// IMD heat wave criteria (deg C).
const HEAT_WAVE = {
  plainsThreshold: 40,
  coastalThreshold: 37,
  hillsThreshold: 30,
  departureHeatWave: 4.5,
  departureSevere: 6.5,
  absoluteHeatWave: 45,
  absoluteSevere: 47,
};

// Rainfall occurrence as a two-state Markov chain, per 2s tick scaled from daily stats.
const RAIN_MARKOV = {
  monsoon: { wetGivenWet: 0.75, wetGivenDry: 0.3 },
  nonMonsoon: { wetGivenWet: 0.45, wetGivenDry: 0.05 },
};

// Gamma intensity params for wet ticks (mm/h).
const RAIN_INTENSITY = {
  shape: 0.7,
  scaleMonsoon: 4.0,
  scaleNonMonsoon: 1.5,
  scaleExtreme: 9.0,
  ar1Rho: 0.85,
  lnSigma: 0.45,
  diurnalAmplitude: 0.35,
  diurnalPeakHour: 16,
  preDawnPeakHour: 4, // NE India secondary convective peak
  preDawnAmplitude: 0.2,
};

const STORM_CELL = {
  minRadiusKm: 3,
  maxRadiusKm: 8,
  minSpeedKmh: 6,
  maxSpeedKmh: 55,
  medianSpeedKmh: 22,
  speedLnSigma: 0.5,
  bearingMonsoonDeg: 45, // SW -> NE
  bearingJitterDeg: 25,
  minLifetimeSec: 1800,
  maxLifetimeSec: 21600,
  // Quasi-stationary systems: rare, slow, long-lived, and responsible for the
  // extreme-accumulation tail.
  stationaryProbability: 0.08,
  stationarySpeedMinKmh: 0.5,
  stationarySpeedMaxKmh: 3,
  stationaryMinLifetimeSec: 14400,
  stationaryMaxLifetimeSec: 36000,
  maxConcurrent: 2,
  // Calibrated so monsoon daily totals match Brahmaputra-valley climatology
  // (~11-13 mm/day mean, ~10% of days above the IMD "heavy" 64.5 mm threshold).
  spawnIntervalSecWet: 11000,
  spawnIntervalSecExtreme: 2400,
  peakIntensityScale: 4,
};

// Nash linear-reservoir cascade for rainfall -> runoff.
const HYDROLOGY = {
  cascadeReservoirs: 3,
  // K is PER RESERVOIR, so total time-to-peak is roughly cascadeReservoirs * K.
  // Small catchment: ~2.25h total. Main stem: ~48h total, matching the observed
  // 24-72h Brahmaputra lag.
  kMinutesSmallCatchment: 45,
  kMinutesMainStem: 960,
  risingLimbFactor: 0.6, // rising limb steeper than falling (hysteresis)
  ratingCurveA: 12.0,
  ratingCurveB: 1.9, // Q = a (h - h0)^b, b typically 1.5-2.5
  loopRatingC: 0.35,
  // Effective conveyance width above bank-full relative to the channel.
  floodplainWidthRatio: 8,
  tideLockPeriodHours: 12.4,
};

// CWC flood severity states. Warning = Danger - 0.6..1.0 m.
const CWC_STATES = ["NORMAL", "LOW", "MODERATE", "HIGH", "UNPRECEDENTED"];
const CWC_WARNING_OFFSET_M = 0.8;

// Published rainfall intensity-duration landslide thresholds: I = alpha * D^beta
// (I in mm/h, D in hours). Source: Indian regional I-D threshold studies.
const LANDSLIDE_ID_THRESHOLDS = {
  NW_HIMALAYA: { alpha: 2.9993, beta: -0.4152 },
  NE_HIMALAYA: { alpha: 5.8294, beta: -0.4141 },
  EASTERN_GHATS: { alpha: 26.88, beta: -0.6885 },
  WESTERN_GHATS: { alpha: 28.01, beta: -0.641 },
  SHIMLA: { alpha: 7.2, beta: -0.26 },
  GARHWAL: { alpha: 1.38, beta: -0.126 },
};

const LANDSLIDE = {
  apiDecayK: 0.89, // antecedent rainfall index daily decay
  poreePressureKHours: 4,
  tiltDriftDegPerHour: 0.01,
  tiltRunawayDeg: 0.5,
};

// Seismic: Gutenberg-Richter, Omori, wave speeds.
const SEISMIC = {
  gutenbergB: 1.0,
  gutenbergAZoneV: 3.2, // Assam/NE India is ISC Zone V
  minMagnitude: 2.5,
  maxMagnitude: 8.6,
  pVelocityKmS: 6.0,
  sVelocityKmS: 3.5,
  omoriP: 1.1,
  omoriCDays: 0.05,
  bathDelta: 1.2, // largest aftershock ~ mainshock - 1.2
  // Shaking is held in telemetry long enough to survive coarse simulation ticks;
  // see accelerationAt() in physics/seismic.cjs.
  telemetryHoldSec: 120,
  staWindowSec: 1.0,
  ltaWindowSec: 45.0,
  triggerRatio: 4.0,
  detriggerRatio: 1.5,
  gmpeC1: -1.72,
  gmpeC2: 0.43,
  gmpeC3: 1.08,
};

// Fire weather coupling.
const FIRE = {
  fuelMoistureTimeConstantHours: 0.7,
  windSpreadExponent: 1.5,
  baseSpreadMPerMin: 0.6,
  smokeAdvectionKmh: 12,
  coBaselinePpm: 1.5,
  pm25BaselineUgM3: 25,
};

// Holland cyclone wind profile + surge.
const CYCLONE = {
  hollandBMin: 1.2,
  hollandBMax: 1.5,
  rMaxKmMin: 30,
  rMaxKmMax: 60,
  ambientPressureHpa: 1010,
  airDensity: 1.15,
  surgeMPer10Hpa: 0.4,
  // Peak rain-band intensity (mm/h) per hPa of central pressure deficit.
  rainPerHpa: 0.45,
};

const URBAN_DRAINAGE = {
  designCapacityMmPerHour: 25, // Mumbai design capacity
  cloggingFactorDefault: 0.25,
  tideLockThreshold: 0.7,
};

/**
 * Sensor hardware profiles. Ranges, resolution and noise reflect real devices
 * so that saturation and quantization artefacts appear as they would in the field.
 */
const HARDWARE = {
  rain: {
    model: "Tipping-bucket ARG (Davis/IMD)",
    unit: "mm/h",
    min: 0,
    max: 200,
    resolution: 0.2, // mm per tip
    noiseSigma: 0,
    sampleIntervalSec: 60,
    warmupSec: 0,
    driftPerDay: 0.0005,
  },
  water: {
    model: "Ultrasonic Maxbotix / Keller pressure transducer",
    unit: "m",
    min: 0,
    max: 10,
    resolution: 0.001,
    noiseSigma: 0.005,
    sampleIntervalSec: 300,
    warmupSec: 0,
    driftPerDay: 0.001,
    biofoulingPerDay: 0.0008,
  },
  soil: {
    model: "Capacitive VWC (Decagon 10HS)",
    unit: "%VWC",
    min: 0,
    max: 55,
    resolution: 0.1,
    noiseSigma: 1.5,
    sampleIntervalSec: 900,
    warmupSec: 2,
    driftPerDay: 0.002,
  },
  tremor: {
    model: "MEMS MPU-6050 / Raspberry Shake 4D",
    unit: "g",
    min: 0,
    max: 2,
    resolution: 0.0001,
    noiseSigma: 0.005,
    sampleIntervalSec: 1,
    warmupSec: 1,
    driftPerDay: 0.0002,
  },
  tilt: {
    model: "MEMS inclinometer",
    unit: "deg",
    min: -30,
    max: 30,
    resolution: 0.01,
    noiseSigma: 0.005,
    sampleIntervalSec: 60,
    warmupSec: 1,
    driftPerDay: 0.01,
  },
  co: {
    model: "MQ-7 electrochemical",
    unit: "ppm",
    min: 20,
    max: 2000,
    resolution: 1,
    noiseSigma: 8,
    sampleIntervalSec: 30,
    warmupSec: 90, // MQ-series require warm-up before valid readings
    driftPerDay: 0.01,
  },
  pm25: {
    model: "PMS5003 laser scatter",
    unit: "ug/m3",
    min: 0,
    max: 1000,
    resolution: 1,
    noiseSigma: 6,
    sampleIntervalSec: 30,
    warmupSec: 30,
    driftPerDay: 0.005,
  },
  temp: {
    model: "BME280",
    unit: "degC",
    min: -40,
    max: 85,
    resolution: 0.01,
    noiseSigma: 0.3,
    sampleIntervalSec: 60,
    warmupSec: 2,
    driftPerDay: 0.001,
  },
  humidity: {
    model: "BME280",
    unit: "%RH",
    min: 0,
    max: 100,
    resolution: 0.1,
    noiseSigma: 1.5,
    sampleIntervalSec: 60,
    warmupSec: 2,
    driftPerDay: 0.002,
  },
  pressure: {
    model: "BME280 barometric",
    unit: "hPa",
    min: 300,
    max: 1100,
    resolution: 0.01,
    noiseSigma: 0.15,
    sampleIntervalSec: 60,
    warmupSec: 2,
    driftPerDay: 0.003,
  },
  wind: {
    model: "Cup anemometer",
    unit: "m/s",
    min: 0,
    max: 75,
    resolution: 0.1,
    noiseSigma: 0.4,
    sampleIntervalSec: 60,
    warmupSec: 0,
    driftPerDay: 0.001,
  },
  sos: {
    model: "Manual panic button",
    unit: "bool",
    min: 0,
    max: 1,
    resolution: 1,
    noiseSigma: 0,
    sampleIntervalSec: 1,
    warmupSec: 0,
    driftPerDay: 0,
  },
};

// Per-node fault injection probabilities (per sample unless noted).
const FAULTS = {
  stuckAtPerDay: 0.005,
  spikeProbability: 0.002,
  spikeMultiplierMin: 3,
  spikeMultiplierMax: 10,
  dropoutProbability: 0.02,
  nanProbability: 0.001,
  calibrationDriftPerDay: 0.001,
};

// Link behaviour. Rain fade makes loss worse exactly during storms.
const TRANSPORT = {
  basePacketLoss: 0.015,
  rainFadeLossPerMmHour: 0.0012,
  maxPacketLoss: 0.45,
  latencyMedianMs: 120,
  latencySigma: 0.9,
  latencyMaxMs: 4000,
  reorderProbability: 0.04,
  partitionProbabilityPerHour: 0.08,
  partitionMinSec: 30,
  partitionMaxSec: 300,
  storeAndForwardMax: 240,
};

// Solar + battery. Monsoon cloud cover drains nodes exactly when they matter.
const POWER = {
  // Sized so a well-charged node survives a long cloudy spell but a poorly
  // maintained one (starting at low charge) degrades and drops out during
  // sustained monsoon cloud — losing sensing exactly when it matters most.
  panelWatts: 1.5,
  batteryWh: 18,
  idleDrawW: 0.22,
  txDrawW: 0.5,
  chargeEfficiency: 0.75,
  dutyCycleSocThreshold: 0.3,
  dutyCycleMultiplier: 6,
  deadSocThreshold: 0.04,
  recoverSocThreshold: 0.12,
};

// LoRaWAN IN865 regional constraints (licence-free in India, 1% duty cycle).
const LORAWAN = {
  bandName: "IN865",
  freqMinMhz: 865,
  freqMaxMhz: 867,
  maxErpDbm: 30,
  dutyCyclePercent: 1.0,
  maxPayloadBytes: 237,
  bitrateMinBps: 300,
  bitrateMaxBps: 5470,
};

const MONSOON_MONTHS = [5, 6, 7, 8]; // JJAS, zero-indexed

module.exports = {
  IMD_RAINFALL_BANDS,
  IMD_WARNING_COLORS,
  HEAT_WAVE,
  RAIN_MARKOV,
  RAIN_INTENSITY,
  STORM_CELL,
  HYDROLOGY,
  CWC_STATES,
  CWC_WARNING_OFFSET_M,
  LANDSLIDE_ID_THRESHOLDS,
  LANDSLIDE,
  SEISMIC,
  FIRE,
  CYCLONE,
  URBAN_DRAINAGE,
  HARDWARE,
  FAULTS,
  TRANSPORT,
  POWER,
  LORAWAN,
  MONSOON_MONTHS,
};
