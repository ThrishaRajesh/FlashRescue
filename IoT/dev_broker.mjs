#!/usr/bin/env node
/**
 * Local development MQTT broker.
 *
 * Serves plain MQTT on 1883 for the Node services and MQTT-over-WebSocket on
 * 9001 for the browser dashboards, which cannot speak raw MQTT over TCP. This
 * removes the need to install and configure Mosquitto plus a separate bridge
 * just to run the project locally.
 *
 *   node IoT/dev_broker.mjs
 *
 * Live throughput, node health and link statistics are shown by the dashboards
 * (they arrive on sim/stats), so this process deliberately stays silent once up.
 *
 * Not for production: no authentication, no TLS, no persistence.
 */

import { createServer as createTcpServer } from "node:net";
import { Aedes } from "aedes";
import factory from "aedes-server-factory";

const MQTT_PORT = Number(process.env.MQTT_PORT || 1883);
const WS_PORT = Number(process.env.MQTT_WS_PORT || 9001);

const aedes = await Aedes.createBroker();

const tcpServer = createTcpServer(aedes.handle);
const wsServer = factory.createServer(aedes, { ws: true });

function fail(port, err) {
  if (err && err.code === "EADDRINUSE") {
    console.error(`Port ${port} is already in use — another broker may be running.`);
  } else {
    console.error(`Failed to listen on ${port}:`, err && err.message);
  }
  process.exit(1);
}
tcpServer.on("error", (e) => fail(MQTT_PORT, e));
wsServer.on("error", (e) => fail(WS_PORT, e));

await new Promise((resolve) => tcpServer.listen(MQTT_PORT, resolve));
await new Promise((resolve) => wsServer.listen(WS_PORT, resolve));

console.log(`MQTT broker   tcp://localhost:${MQTT_PORT}   (Node services)`);
console.log(`MQTT over WS  ws://localhost:${WS_PORT}      (browser dashboards)`);
console.log("\nNext:");
console.log("  node IoT/Publishers/sensor_sim.cjs --scenario assam_brahmaputra_flood");
console.log("  then open  IoT/Visualization Dashboard/sim_inspector.html");
console.log("\nCtrl+C to stop");

function shutdown() {
  console.log("\nshutting down broker…");
  tcpServer.close();
  wsServer.close();
  aedes.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
