const { TRANSPORT, LORAWAN } = require("./config.cjs");
const { clamp } = require("./util.cjs");

/**
 * Lossy link between nodes and the broker. Models packet loss (worse during
 * heavy rain — real rain fade), latency jitter, reordering, network partitions,
 * and store-and-forward replay of buffered readings once connectivity returns.
 *
 * Downstream services therefore have to cope with late, out-of-order and missing
 * data, which is the realistic case.
 */
class SimulatedTransport {
  constructor(client, rng, opts = {}) {
    this.client = client;
    this.rng = rng;
    this.enabled = opts.enabled ?? true;
    // Instant mode keeps loss and partitions but delivers without wall-clock
    // delay, so a fast-forwarded headless run stays deterministic.
    this.instant = opts.instant ?? false;
    // Outage and duty-cycle windows are tracked on the SIMULATION clock, not the
    // wall clock: at 300x speed a wall-clock outage would swallow hours of the run.
    this.simSec = 0;
    this.partitionUntilSimSec = -1;
    this.queue = [];
    this.stats = {
      sent: 0,
      dropped: 0,
      queued: 0,
      replayed: 0,
      reordered: 0,
      partitions: 0,
    };
    this.loraBudget = {
      windowStartSimSec: 0,
      airtimeMs: 0,
      budgetMs: (LORAWAN.dutyCyclePercent / 100) * 3600 * 1000,
      throttled: 0,
    };
  }

  get partitioned() {
    return this.simSec < this.partitionUntilSimSec;
  }

  tick(dtSec) {
    if (!this.enabled) return;
    this.simSec += dtSec;

    if (!this.partitioned) {
      const perSec = TRANSPORT.partitionProbabilityPerHour / 3600;
      if (this.rng.next() < perSec * dtSec) {
        const duration = this.rng.uniform(TRANSPORT.partitionMinSec, TRANSPORT.partitionMaxSec);
        this.partitionUntilSimSec = this.simSec + duration;
        this.stats.partitions += 1;
      }
    }

    if (!this.partitioned && this.queue.length) this._flushQueue();
  }

  /** Replay buffered messages, preserving their original timestamps as late data. */
  _flushQueue() {
    const batch = this.queue.splice(0, this.queue.length);
    for (const item of batch) {
      this.stats.replayed += 1;
      this._deliver(item.topic, { ...item.payload, late: true }, item.options, 0);
    }
  }

  _lossProbability(rainMmHr) {
    const fade = rainMmHr * TRANSPORT.rainFadeLossPerMmHour;
    return clamp(TRANSPORT.basePacketLoss + fade, 0, TRANSPORT.maxPacketLoss);
  }

  _deliver(topic, payload, options, delayMs) {
    const send = () => {
      try {
        this.client.publish(topic, JSON.stringify(payload), { qos: options.qos ?? 0 });
        this.stats.sent += 1;
      } catch (e) {
        this.stats.dropped += 1;
      }
    };
    if (delayMs <= 0) send();
    else setTimeout(send, delayMs);
  }

  /**
   * LoRa transmissions are constrained by the IN865 1% duty cycle, so during a
   * storm the radio budget runs out and reporting must throttle.
   */
  loraAdmit(payloadBytes) {
    if (this.simSec - this.loraBudget.windowStartSimSec >= 3600) {
      this.loraBudget.windowStartSimSec = this.simSec;
      this.loraBudget.airtimeMs = 0;
    }
    if (payloadBytes > LORAWAN.maxPayloadBytes) return false;
    const airtimeMs = (payloadBytes * 8 * 1000) / LORAWAN.bitrateMinBps;
    if (this.loraBudget.airtimeMs + airtimeMs > this.loraBudget.budgetMs) {
      this.loraBudget.throttled += 1;
      return false;
    }
    this.loraBudget.airtimeMs += airtimeMs;
    return true;
  }

  publish(topic, payload, options = {}) {
    if (!this.enabled) {
      this._deliver(topic, payload, options, 0);
      return true;
    }

    if (this.partitioned) {
      if (this.queue.length < TRANSPORT.storeAndForwardMax) {
        this.queue.push({ topic, payload, options });
        this.stats.queued += 1;
      } else {
        this.stats.dropped += 1;
      }
      return false;
    }

    if (this.rng.next() < this._lossProbability(options.rainMmHr || 0)) {
      this.stats.dropped += 1;
      return false;
    }

    let delay = clamp(
      this.rng.lognormal(TRANSPORT.latencyMedianMs, TRANSPORT.latencySigma),
      5,
      TRANSPORT.latencyMaxMs
    );
    if (this.rng.next() < TRANSPORT.reorderProbability) {
      delay += this.rng.uniform(200, 1500);
      this.stats.reordered += 1;
    }

    this._deliver(topic, payload, options, this.instant ? 0 : delay);
    return true;
  }

  snapshot() {
    return {
      partitioned: this.partitioned,
      queueDepth: this.queue.length,
      loraThrottled: this.loraBudget.throttled,
      ...this.stats,
    };
  }
}

/** MQTT Last Will and Testament, so the broker announces a node going dark. */
function buildLwtOptions(clientId, topic, payload) {
  return {
    clientId,
    clean: true,
    will: {
      topic,
      payload: JSON.stringify({ ...payload, event: "node_offline", ts: Date.now() }),
      qos: 1,
      retain: true,
    },
  };
}

module.exports = { SimulatedTransport, buildLwtOptions };
