"use strict";
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const mmss = (t) => `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
const min1 = (s) => (s / 60).toFixed(1);
const STATUS = { idle: "Available", to_casualty: "Going to casualty", to_hospital: "Taking patient to hospital" };

const socket = io();
const map = L.map("map").setView([12.965, 77.59], 13);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "&copy; OpenStreetMap contributors" }).addTo(map);

const layers = { hosp: {}, vol: {}, cas: {}, route: {}, road: {}, disasters: L.layerGroup().addTo(map) };
let fitted = false, blockMode = false, blockPts = [], blockMarker = null, last = null;

/* ---------- map ---------- */
function updateMap(s) {
  s.hospitals.forEach((h) => {
    const full = h.busy >= h.beds;
    const ic = L.divIcon({ className: "", iconSize: [22, 22], html: `<div class="mk h ${full ? "full" : ""}">H</div>` });
    if (!layers.hosp[h.id]) layers.hosp[h.id] = L.marker([h.lat, h.lng], { icon: ic, zIndexOffset: 400 }).addTo(map);
    layers.hosp[h.id].setIcon(ic).bindTooltip(`${esc(h.name)}: ${h.busy}/${h.beds} beds, ${h.queue} waiting, ${h.inbound} on the way`);
  });

  const vids = new Set();
  s.volunteers.forEach((v) => {
    vids.add(v.id);
    const ic = L.divIcon({ className: "", iconSize: [12, 12], html: `<div class="vm ${v.status}"></div>` });
    if (!layers.vol[v.id]) layers.vol[v.id] = L.marker([v.lat, v.lng], { icon: ic, zIndexOffset: 300 }).addTo(map);
    layers.vol[v.id].setLatLng([v.lat, v.lng]).setIcon(ic).bindTooltip(`${esc(v.name)} - ${STATUS[v.status]}${v.decision && v.status === "to_hospital" ? "<br>" + esc(v.decision) : ""}`);
  });

  const cids = new Set();
  s.casualties.forEach((c) => {
    if (c.status === "carried" || c.status === "treating") return;       // being carried: shown with the volunteer
    cids.add(c.id);
    const ic = L.divIcon({ className: "", iconSize: [10, 10], html: `<div class="cm ${c.status}"></div>` });
    if (!layers.cas[c.id]) layers.cas[c.id] = L.marker([c.lat, c.lng], { icon: ic, zIndexOffset: 200 }).addTo(map);
    layers.cas[c.id].setIcon(ic).bindTooltip(`${esc(c.id)}: ${c.status === "waiting" ? "waiting for a volunteer" : c.status === "assigned" ? "volunteer on the way" : "waiting for a bed"}`);
  });
  Object.keys(layers.cas).filter((k) => !cids.has(k)).forEach((k) => { map.removeLayer(layers.cas[k]); delete layers.cas[k]; });

  const rids = new Set(Object.keys(s.routes));
  Object.keys(layers.route).filter((k) => !rids.has(k)).forEach((k) => { map.removeLayer(layers.route[k]); delete layers.route[k]; });
  Object.entries(s.routes).forEach(([vid, r]) => {
    const style = { color: r.safe ? "#35618f" : "#b3261e", weight: 2.5, opacity: 0.7, dashArray: r.safe ? null : "6 6" };
    if (!layers.route[vid]) layers.route[vid] = L.polyline(r.coords, style).addTo(map);
    else layers.route[vid].setLatLngs(r.coords).setStyle(style);
  });

  const bids = new Set(s.blocked.map((b) => b.id));
  Object.keys(layers.road).filter((k) => !bids.has(k)).forEach((k) => { map.removeLayer(layers.road[k]); delete layers.road[k]; });
  s.blocked.forEach((b) => {
    if (!layers.road[b.id]) layers.road[b.id] = L.polyline(b.coords, { color: "#b3261e", weight: 5, opacity: 0.75, dashArray: "8 6" }).addTo(map);
    layers.road[b.id].bindTooltip(`Closed road ${esc(b.id)}`);
  });

  if (!fitted) {
    map.fitBounds(s.hospitals.map((h) => [h.lat, h.lng]).concat(s.volunteers.map((v) => [v.lat, v.lng])), { padding: [50, 50] });
    fitted = true;
  }
}

/* ---------- panels ---------- */
function renderHospitals(s) {
  $("hospitals").innerHTML = s.hospitals.map((h) => {
    const beds = Array.from({ length: h.beds }, (_, i) => `<i class="${i < h.busy ? (h.busy >= h.beds ? "full" : "busy") : ""}"></i>`).join("");
    return `<div class="hosp"><div class="top"><span class="name">${esc(h.name)}</span><span class="tag">${h.busy}/${h.beds} beds</span></div>
      <div class="beds">${beds}</div>
      <div class="stat">${h.queue ? `<span class="tag q">${h.queue} waiting</span> ` : ""}${h.inbound ? `<span class="tag in">${h.inbound} on the way</span> ` : ""}treated ${h.treated}</div></div>`;
  }).join("");
}

function renderVols(s) {
  const c = { idle: 0, to_casualty: 0, to_hospital: 0 };
  s.volunteers.forEach((v) => c[v.status]++);
  $("volSummary").textContent = `${c.idle} free, ${c.to_casualty + c.to_hospital} busy`;
  const order = { to_hospital: 0, to_casualty: 1, idle: 2 };
  $("vols").innerHTML = [...s.volunteers].sort((a, b) => order[a.status] - order[b.status] || a.name.localeCompare(b.name, undefined, { numeric: true }))
    .map((v) => { const r = s.routes[v.id];
      return `<div class="vol"><span class="n"><i class="dot ${v.status}"></i>${esc(v.name)}</span><span class="s">${STATUS[v.status]}${r ? ` &middot; ${Math.ceil(r.etaSec / 60)} min` : ""}</span></div>`; }).join("");
}

function renderMetrics(s) {
  const m = s.metrics;
  const rows = [["Casualties reported", m.casualties], ["Reached a bed", m.reachedBed], ["Fully treated", m.treated],
    ["Average time to a bed", m.reachedBed ? min1(m.avgToBed) + " min" : "-"], ["90th percentile", m.reachedBed ? min1(m.p90ToBed) + " min" : "-"],
    ["Worst case", m.reachedBed ? min1(m.maxToBed) + " min" : "-"], ["Arrived at a full hospital", m.queuedArrivals], ["Longest queue", m.peakQueue],
    ["Live diversions", m.diversions], ["Re-plans after a road closed", m.reroutes], ["Trips with no clear road", m.unsafeRoutes]];
  $("metrics").innerHTML = rows.map(([k, v]) => `<div class="metric"><span>${k}</span><b>${v}</b></div>`).join("") +
    `<div class="note">Simulation clock ${mmss(s.t)} &middot; ${s.strategy === "aware" ? "choosing hospitals by drive time + expected wait" : "choosing the nearest hospital"}</div>`;
}

function renderRoads(s) {
  $("roads").innerHTML = s.blocked.length ? s.blocked.map((b) => `<div class="rowline"><span>Road ${esc(b.id)}</span><button class="btn" data-open="${esc(b.id)}">Reopen</button></div>`).join("")
    : '<div class="empty">No closed roads. Use "Close a road" and click two points on the map.</div>';
}

function renderEvents(s) {
  $("events").innerHTML = s.events.length ? s.events.map((e) => `<div class="ev"><span class="t">${mmss(e.t)}</span>${esc(e.text)}</div>`).join("") : '<div class="empty">Nothing yet. Add a casualty wave to start.</div>';
}

function renderState(s) {
  last = s;
  updateMap(s);
  renderHospitals(s); renderVols(s); renderMetrics(s); renderRoads(s); renderEvents(s);
  document.querySelectorAll("#strategy button").forEach((b) => b.classList.toggle("on", b.dataset.s === s.strategy));
}

async function loadEval() {
  try {
    const e = await (await fetch("/api/eval")).json();
    if (!e) { $("evalbox").innerHTML = '<div class="empty">Run <code>node eval/run.js</code> to generate results.</div>'; return; }
    const pct = (r) => `${r.change > 0 ? "+" : ""}${Math.round(r.change * 100)}%`;
    $("evalbox").innerHTML = Object.values(e.scenarios).map((sc) => `<div class="eval-h">${esc(sc.label)}</div>
      <div class="eval-r"><span>Average wait for a bed</span><b>${pct(sc.rows[0])}</b></div>
      <div class="eval-r"><span>Longest queue</span><b>${pct(sc.rows[4])}</b></div>
      <div class="eval-r"><span>Better in</span><b>${sc.awareBetter} of ${e.seeds}</b></div>`).join("") +
      '<div class="note">Load-aware vs nearest hospital. Simulated casualties and beds; shows the relative difference, not real hospital performance.</div>';
  } catch { /* optional panel */ }
}

async function loadDisasters() {
  try {
    const data = await (await fetch("/disasters")).json();
    layers.disasters.clearLayers();
    (data || []).forEach((d) => L.circleMarker([d.lat, d.lng], { radius: 9, color: "#7a2e2a", weight: 1, fillColor: d.risk_level === "high" ? "#b3261e" : "#b26a00", fillOpacity: 0.55 })
      .bindTooltip(`Detected: ${esc(d.disaster_type)} (${esc(d.risk_level)} risk)`).addTo(layers.disasters));
  } catch { /* detection reports are optional */ }
}

/* ---------- interaction ---------- */
const post = (url, body) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
function setBlockMode(on) {
  blockMode = on; blockPts = [];
  if (blockMarker) { map.removeLayer(blockMarker); blockMarker = null; }
  $("block").classList.toggle("active", on);
  $("block").textContent = on ? "Cancel" : "Close a road";
  const h = $("hint");
  h.hidden = !on;
  h.textContent = "Click two points on the map to close the road between them";
  map.getContainer().style.cursor = on ? "crosshair" : "";
}
map.on("click", async (e) => {
  if (!blockMode) return;
  blockPts.push([e.latlng.lat, e.latlng.lng]);
  if (blockPts.length === 1) { blockMarker = L.circleMarker(e.latlng, { radius: 5, color: "#b3261e" }).addTo(map); $("hint").textContent = "Now click the second point"; }
  else { await post("/api/block", { coords: blockPts }); setBlockMode(false); }
});
$("block").onclick = () => setBlockMode(!blockMode);
$("wave").onclick = () => post("/api/casualties", { count: 12 });
$("fromReports").onclick = async () => {
  const r = await post("/api/casualties", { fromReports: true });
  if (!r.ok) { const h = $("hint"); h.hidden = false; h.textContent = "No readable detection reports found"; setTimeout(() => (h.hidden = true), 3000); }
  else loadDisasters();
};
$("reset").onclick = () => { fitted = false; post("/api/reset"); };
$("strategy").onclick = (e) => { const s = e.target.dataset && e.target.dataset.s; if (s) post("/api/strategy", { name: s }); };
document.addEventListener("click", (e) => { const id = e.target.dataset && e.target.dataset.open; if (id) fetch(`/api/block/${encodeURIComponent(id)}`, { method: "DELETE" }); });

socket.on("connect", () => { $("conn").classList.add("on"); $("conn").lastChild.textContent = "Live"; });
socket.on("disconnect", () => { $("conn").classList.remove("on"); $("conn").lastChild.textContent = "Reconnecting"; });
socket.on("state", renderState);
loadEval();
loadDisasters();
setInterval(loadDisasters, 30000);
