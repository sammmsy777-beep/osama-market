const fs = require('node:fs');
for (const file of ['package.json','electron/main.js','electron/preload.js','src/db.js','src/services.js','renderer/index.html','renderer/app.js']) {
  if (!fs.existsSync(file)) throw new Error(`Missing ${file}`);
}
console.log('Osama Market structure smoke test passed');
