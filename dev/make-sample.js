// Writes dev/sample-snapshot.js from your live processes, with a synthetic 10-minute
// history so the chart has shape. Then serve the repo and open dev/panel-harness.html.
const fs = require('fs');
const path = require('path');
const { buildSnapshot, History, scanner } = require('../src/snapshot');

scanner.scan().then((groups) => {
  const live = buildSnapshot(groups, null);
  const history = new History();
  const now = Date.now();
  for (let i = 120; i > 0; i--) {
    const wave = 0.4 + 0.6 * Math.abs(Math.sin(i / 14));
    history.samples.push({ t: now - i * 5000, byProject: Object.fromEntries(live.projects.map((p) => [p.key, p.cores * wave])) });
  }
  const snapshot = buildSnapshot(groups, history);
  snapshot.colorSlots = Object.fromEntries(snapshot.projects.slice(0, 8).map((p, i) => [p.key, i]));
  fs.writeFileSync(path.join(__dirname, 'sample-snapshot.js'), `window.__SNAPSHOT__=${JSON.stringify(snapshot)};`);
  console.log(`Wrote sample: ${snapshot.cores} cores across ${snapshot.projects.length} projects`);
});
