const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'public', 'Data');
const read = (f) => JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));

// blockedPaths.json stores [lng, lat] pairs (GeoJSON order); the rest of the code uses [lat, lng].
function loadData() {
  return {
    hospitals: read('hospitals.json'),
    shelters: read('shelters.json'),
    volunteers: read('volunteers.json'),
    citizens: read('citizens.json'),
    blocked: read('blockedPaths.json').map((b) => ({ id: b.id, coords: b.coordinates.map((c) => [c[1], c[0]]) })),
  };
}

module.exports = { loadData };
