// Builds assets/manifest.json from the .glb files in assets/cars and assets/tracks.
// Run:  node tools/make-manifest.js      (the GitHub Action does this automatically on every push)
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..', 'assets');
const list = dir => fs.existsSync(path.join(root, dir))
  ? fs.readdirSync(path.join(root, dir)).filter(f => /\.glb$/i.test(f)).sort((a, b) => a.localeCompare(b)) : [];
const manifest = { cars: list('cars'), tracks: list('tracks') };
fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log('manifest.json:', manifest.cars.length, 'cars,', manifest.tracks.length, 'tracks');
