// Spawns two CPU-busy workers under one parent, for testing group detection and kill.
const { fork } = require('child_process');
if (process.argv[2] === 'worker') {
  setInterval(() => { const end = Date.now() + 80; while (Date.now() < end); }, 100);
  process.on('disconnect', () => process.exit(0)); // never outlive the parent
} else {
  fork(__filename, ['worker']);
  fork(__filename, ['worker']);
  setInterval(() => {}, 1000);
}
