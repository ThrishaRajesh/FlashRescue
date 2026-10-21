// server.js - volunteer dispatch + hospital digital twin.
// The simulation runs here (one source of truth); browsers only display it, so any number of open tabs agree.
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const { World } = require('./lib/world');
const { createOsrmRouter, createOfflineRouter } = require('./lib/router');
const { loadData } = require('./lib/data');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.json());

// Serve static files from 'public'
app.use(express.static(path.join(__dirname, 'public')));

const SIM_SCALE = Number(process.env.SIM_SCALE || 20);          // simulated seconds per real second
const TICK_MS = 500;
const router = process.env.OFFLINE === '1' ? createOfflineRouter() : createOsrmRouter();
const data = loadData();
const REPORTS_FILE = process.env.REPORTS_FILE || path.join(__dirname, '..', 'Disaster_Detection', 'disaster_reports.json');
const CENTRE = [12.965, 77.59];

let world;
let strategy = 'aware';
let roadN = 0;
function newWorld() {
  world = new World({ ...data, router, strategy });
  roadN = 0;
}
newWorld();

// Disaster route (reports produced by the Disaster Detection feature)
app.get('/disasters', (req, res) => {
  fs.readFile(REPORTS_FILE, 'utf8', (err, raw) => {
    if (err) return res.status(500).json({ error: 'Could not read disaster reports', details: err.message });
    try {
      const reports = JSON.parse(raw);
      res.json(reports
        .filter((r) => r.location && r.location.latitude && r.location.longitude)
        .map((r) => ({ lat: r.location.latitude, lng: r.location.longitude, disaster_type: r.disaster_type,
          risk_level: r.risk_level, timestamp: r.timestamp })));
    } catch (e) {
      res.status(500).json({ error: 'Invalid JSON', details: e.message });
    }
  });
});

// ----- simulation API -----
const jitter = (m) => (Math.random() - 0.5) * 2 * (m / 111320);
const num = (x) => typeof x === 'number' && Number.isFinite(x);

app.get('/api/state', (req, res) => res.json(world.snapshot()));

app.post('/api/strategy', (req, res) => {
  strategy = req.body && req.body.name === 'nearest' ? 'nearest' : 'aware';
  world.setStrategy(strategy);
  world.log(`Dispatch rule: ${strategy === 'aware' ? 'load-aware' : 'nearest hospital'}`);
  res.json({ strategy });
});

// {lat,lng} adds one; {count} adds a wave near the centre; {fromReports:true} uses Disaster Detection output
app.post('/api/casualties', (req, res) => {
  const b = req.body || {};
  let added = 0;
  if (num(b.lat) && num(b.lng)) { world.addCasualty(b.lat, b.lng); added = 1; }
  else if (b.fromReports) {
    try {
      const reports = JSON.parse(fs.readFileSync(REPORTS_FILE, 'utf8'));
      for (const r of reports) {
        if (!r.location || !num(r.location.latitude) || !num(r.location.longitude)) continue;
        const n = r.risk_level === 'high' ? 3 : r.risk_level === 'medium' ? 2 : 1;
        for (let i = 0; i < n; i++) { world.addCasualty(r.location.latitude + jitter(150), r.location.longitude + jitter(150)); added++; }
      }
      world.log(`${added} casualties created from ${reports.length} detection reports`);
    } catch (e) { return res.status(500).json({ error: 'Could not read disaster reports', details: e.message }); }
  } else {
    const n = Math.max(1, Math.min(60, Number(b.count) || 12));
    for (let i = 0; i < n; i++) world.addCasualty(CENTRE[0] + jitter(1300), CENTRE[1] + jitter(1300));
    added = n;
    world.log(`${n} casualties reported`);
  }
  res.json({ added });
});

app.post('/api/block', (req, res) => {
  const c = req.body && req.body.coords;
  if (!Array.isArray(c) || c.length < 2 || !c.every((p) => Array.isArray(p) && num(p[0]) && num(p[1]))) {
    return res.status(400).json({ error: 'coords must be [[lat,lng],[lat,lng],...]' });
  }
  const id = `x${++roadN}`;
  world.addBlocked(id, c);
  res.json({ id });
});
app.delete('/api/block/:id', (req, res) => { world.removeBlocked(req.params.id); res.json({ ok: true }); });

app.post('/api/reset', (req, res) => { newWorld(); res.json({ ok: true }); });

app.get('/api/eval', (req, res) => {
  fs.readFile(path.join(__dirname, 'eval', 'results.json'), 'utf8', (err, raw) => (err ? res.json(null) : res.json(JSON.parse(raw))));
});

// ----- simulation loop & live updates -----
let stepping = false;
setInterval(async () => {
  if (stepping) return;                       // never overlap steps if routing is slow
  stepping = true;
  try {
    await world.step((TICK_MS / 1000) * SIM_SCALE);
    io.emit('state', world.snapshot());
  } catch (e) {
    console.error('step failed:', e.message);
  } finally {
    stepping = false;
  }
}, TICK_MS);

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  socket.emit('state', world.snapshot());
  socket.on('disconnect', () => console.log('Client disconnected:', socket.id));
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT} (${router.name} routing, ${strategy} dispatch, ${SIM_SCALE}x speed)`);
});
