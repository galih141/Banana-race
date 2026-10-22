/* Banana Racer — game.js
   Cars  : assets/cars/*.glb    (wheels: front_left, front_right, back_left, back_right · body: name ends with "cars_body")
   Tracks: assets/tracks/*.glb  (road: node name starts with "track" · finish gate: box named "lap")
   The list of files comes from assets/manifest.json (built by tools/make-manifest.js / the GitHub Action). */
(function () {
'use strict';
const $ = id => document.getElementById(id);
if (typeof THREE === 'undefined' || !THREE.GLTFLoader) {
  $('loadMsg').textContent = 'Could not load three.js from the internet.';
  $('loadSub').textContent = 'Please check your connection and reload.';
  return;
}

// ---------- tuning (world units) ----------
const MAX_SPEED   = 2.3;
const BOOST_MULT  = 1.45;
const ACCEL       = 2.0;
const BRAKE       = 4.5;
const DRAG        = 0.9;
const TURN_RATE   = 2.3;
const BOT_MAX = 2.7, BOT_ACCEL = 2.6, BOT_TURN = 2.45;   // bots are a bit faster than the player's base speed
const GRAVITY     = 7.0;
const JUMP_V      = 1.4;
const TOTAL_LAPS  = 3;
const NUM_BOTS    = 2;
const BOT_SKILLS  = [0.97, 0.93];
const CAR_LEN_WORLD  = 0.19;    // every car is scaled to this length
const REF_ROAD_WIDTH = 0.866;   // every track is scaled so its road is this wide (keeps speed/size feel the same)
const LINE_SPACING   = 0.057;   // distance between racing-line points

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const fmt = t => { const m = Math.floor(t / 60), s = t - m * 60; return m + ':' + (s < 10 ? '0' : '') + s.toFixed(2); };
const wrapAng = a => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
const prettyName = f => f.replace(/\.glb$/i, '').replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ').trim();

// car-dependent values (set when a car is chosen)
let CAR_SCALE = 0.04, HALF_W = 0.04, HALF_L = 0.08, WHEEL_R = 0.5;
const qA = new THREE.Quaternion(), qB = new THREE.Quaternion();

// ---------- renderer / scene ----------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputEncoding = THREE.sRGBEncoding;
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9ec9e8);
scene.fog = new THREE.Fog(0x9ec9e8, 8, 40);
const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.004, 100);
scene.add(new THREE.HemisphereLight(0xffffff, 0x8a7a66, 0.95));
const sun = new THREE.DirectionalLight(0xffffff, 0.9);
sun.position.set(3, 6, 2);
scene.add(sun);
// matte-painting dome: an unlit, shadow-free sphere that follows the camera (so it always looks infinitely far away)
const BACKDROP_YAW = 0;                      // turn the panorama around if its "front" should face another way
const dome = new THREE.Mesh((() => { const g = new THREE.SphereGeometry(50, 64, 32); g.scale(-1, 1, 1); return g; })(),
  new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false, depthWrite: false, toneMapped: false }));
dome.visible = false; dome.renderOrder = -1000; dome.frustumCulled = false; dome.rotation.y = BACKDROP_YAW;
scene.add(dome);
addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
});

// ---------- input ----------
const keys = {};
const down = (...c) => c.some(k => keys[k]);
addEventListener('keydown', e => {
  keys[e.code] = true;
  if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
  startAudio();
  if (e.code === 'KeyM') toggleMute();
  if (race.state === 'select') {
    if (e.code === 'ArrowLeft' || e.code === 'KeyA') chooseCar(carIdx - 1);
    else if (e.code === 'ArrowRight' || e.code === 'KeyD') chooseCar(carIdx + 1);
    else if (e.code === 'ArrowUp' || e.code === 'KeyW') chooseTrack(trackIdx - 1);
    else if (e.code === 'ArrowDown' || e.code === 'KeyS') chooseTrack(trackIdx + 1);
    else if (/^Digit[1-9]$/.test(e.code) && +e.code.slice(5) <= CARS.length) chooseCar(+e.code.slice(5) - 1);
    else if (e.code === 'Enter' || e.code === 'Space') startFromSelect();
    return;
  }
  if (race.state === 'loading') return;
  if (e.code === 'KeyR') respawn();
  if (e.code === 'Enter') restartRace();
  if (e.code === 'KeyC') enterSelect();
});
addEventListener('keyup', e => { keys[e.code] = false; });
addEventListener('blur', () => { for (const k in keys) keys[k] = false; });
function bindBtn(id, code) {
  const el = $(id);
  const on = e => { e.preventDefault(); keys[code] = true; el.classList.add('on'); startAudio(); };
  const off = e => { e.preventDefault(); keys[code] = false; el.classList.remove('on'); };
  el.addEventListener('pointerdown', on);
  el.addEventListener('pointerup', off);
  el.addEventListener('pointercancel', off);
  el.addEventListener('pointerleave', off);
}
bindBtn('bL', 'ArrowLeft'); bindBtn('bR', 'ArrowRight'); bindBtn('bG', 'ArrowUp');
bindBtn('bBr', 'ArrowDown'); bindBtn('bJ', 'Space'); bindBtn('bB', 'ShiftLeft');

// ---------- audio (tiny engine hum) ----------
let actx = null, osc = null, gain = null, muted = false;
function startAudio() {
  if (actx) { if (actx.state === 'suspended') actx.resume(); return; }
  try {
    actx = new (window.AudioContext || window.webkitAudioContext)();
    osc = actx.createOscillator(); osc.type = 'sawtooth';
    const lp = actx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 700;
    gain = actx.createGain(); gain.gain.value = 0;
    osc.connect(lp); lp.connect(gain); gain.connect(actx.destination); osc.start();
  } catch (e) { actx = null; }
}
function toggleMute() { muted = !muted; if (gain) gain.gain.value = 0; }
function sfx(freq, dur, type, vol) {
  if (!actx || muted) return;
  const o = actx.createOscillator(), g = actx.createGain();
  o.type = type || 'square'; o.frequency.value = freq; g.gain.value = vol || 0.06;
  g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + dur);
  o.connect(g); g.connect(actx.destination); o.start(); o.stop(actx.currentTime + dur);
}

// ---------- game state ----------
const car = { x: 0, z: 0, y: 0, yaw: 0, moveYaw: 0, speed: 0, vy: 0, air: false, pitch: 0, roll: 0, steer: 0, boost: 1, wheelSpin: 0,
  drift: 0, driftT: 0, turbo: 0, prevOnly: 0, idx: 0, laps: -1, finished: false, finishT: 0 };
let lastSafe = { x: 0, z: 0, yaw: 0, idx: 0, laps: -1 };
let safeTimer = 0;
let race = { state: 'loading', t: 0, countdown: 3.4, lapStart: 0, best: null, total: 0 };
let playerRig = null, shadow = null;

// current track
let roadMeshes = [], trackObj = null, TRACK = null, TN = 0, TTX = [], TTZ = [];
let rayTop = 4, rayFar = 8, killY = -1.5;
const ray = new THREE.Raycaster();
const DOWN = new THREE.Vector3(0, -1, 0), ORG = new THREE.Vector3();
function groundAt(x, z) {                 // road height at x,z (null = no road there)
  ORG.set(x, rayTop, z);
  ray.set(ORG, DOWN); ray.far = rayFar;
  const hit = ray.intersectObjects(roadMeshes, false);
  return hit.length ? hit[0].point.y : null;
}

// ---------- racing line helpers ----------
const wrapI = i => ((i % TN) + TN) % TN;
function setRacingLine(line) {
  TRACK = line; TN = line.x.length; TTX = []; TTZ = [];
  for (let i = 0; i < TN; i++) {
    const a = (i + 1) % TN, b = (i - 1 + TN) % TN;
    const dx = line.x[a] - line.x[b], dz = line.z[a] - line.z[b], l = Math.hypot(dx, dz) || 1;
    TTX.push(dx / l); TTZ.push(dz / l);
  }
}
function nearestIdxNear(x, z, from, win) {
  let b = from, bd = 1e9;
  for (let k = -win; k <= win; k++) {
    const i = wrapI(from + k), d = (TRACK.x[i] - x) ** 2 + (TRACK.z[i] - z) ** 2;
    if (d < bd) { bd = d; b = i; }
  }
  return b;
}
// e = {idx,laps}: index 0 of the racing line is the finish line ("lap" box)
function trackAdvance(e, x, z) {
  const prev = e.idx, ni = nearestIdxNear(x, z, prev, 16);
  if (prev > TN * 0.75 && ni < TN * 0.25) e.laps++;
  else if (prev < TN * 0.25 && ni > TN * 0.75) e.laps--;
  e.idx = ni;
}
// starting grid: slots 0..2 behind the line (slot 2 = player, at the back)
const GRID = [{ back: 3, lane: 0.1 }, { back: 3, lane: -0.1 }, { back: 7, lane: 0 }];
function gridPose(slot) {
  const g = GRID[slot], i = wrapI(TN - g.back);
  const lx = TTZ[i], lz = -TTX[i];
  return { x: TRACK.x[i] + lx * g.lane, z: TRACK.z[i] + lz * g.lane, yaw: Math.atan2(TTX[i], TTZ[i]), idx: i, laps: -1 };
}

// ---------- assets: lists, loading, caches ----------
let CARS = [], TRACKS = [];                       // [{name,url}]
const carCache = {}, trackCache = {};
const gltfLoader = new THREE.GLTFLoader();
const loadGLB = url => new Promise((res, rej) => gltfLoader.load(url, res, undefined, err => rej(new Error('Could not load ' + url))));

async function fetchManifest() {
  // On GitHub Pages ask GitHub which files are in the folders (always up to date, no Action needed);
  // otherwise / if that fails, use assets/manifest.json.
  const api = await githubListing();
  if (api && (api.cars.length || api.tracks.length)) return api;
  let man = null;
  try {
    const r = await fetch('assets/manifest.json?v=' + Date.now(), { cache: 'no-store' });
    if (r.ok) man = await r.json();
  } catch (e) { /* ignore */ }
  return man || { cars: [], tracks: [] };
}
async function githubListing() {
  const h = location.hostname;
  if (!h.endsWith('.github.io')) return null;
  const owner = h.split('.')[0], repo = location.pathname.split('/')[1];
  if (!repo) return null;
  try {
    const out = { cars: [], tracks: [] };
    for (const k of ['cars', 'tracks']) {
      const r = await fetch('https://api.github.com/repos/' + owner + '/' + repo + '/contents/assets/' + k, { cache: 'no-store' });
      if (!r.ok) return null;                       // rate-limited or not found -> use the manifest instead
      out[k] = (await r.json()).filter(f => f.type === 'file' && /\.glb$/i.test(f.name)).map(f => f.name).sort((a, b) => a.localeCompare(b));
    }
    return out;
  } catch (e) { return null; }
}

// ---- cars ----
function findCarParts(root) {
  const wheels = {}, bodies = [];
  root.traverse(o => {
    if (o === root) return;
    const k = RL.wheelKey(o.name);
    if (k) { if (!wheels[k]) wheels[k] = o; }
    else if (RL.isBodyName(o.name)) bodies.push(o);
  });
  return { wheels, bodies };
}
function chainQuat(node, root) {                  // rotation of node's parent chain (up to, not including, root)
  const q = new THREE.Quaternion();
  for (let p = node.parent; p && p !== root; p = p.parent) q.premultiply(p.quaternion);
  return q;
}
function analyzeCar(gltf) {
  const root = gltf.scene;
  root.position.set(0, 0, 0); root.rotation.set(0, 0, 0); root.scale.set(1, 1, 1); root.updateMatrixWorld(true);
  const { wheels, bodies } = findCarParts(root);
  const warn = [];
  if (!bodies.length) warn.push('no body named "…cars_body"');
  const wk = Object.keys(wheels);
  if (wk.length < 4) warn.push('wheels found: ' + (wk.join(', ') || 'none'));
  const wb = {}, wc = {};
  let minY = 1e9, rSum = 0;
  wk.forEach(k => {
    const b = new THREE.Box3().setFromObject(wheels[k]);
    wb[k] = b; wc[k] = b.getCenter(new THREE.Vector3());
    minY = Math.min(minY, b.min.y); rSum += (b.max.y - b.min.y) / 2;
  });
  const avg = ks => { const v = new THREE.Vector3(); let n = 0; ks.forEach(k => { if (wc[k]) { v.add(wc[k]); n++; } }); return n ? v.divideScalar(n) : null; };
  const front = avg(['fl', 'fr']), back = avg(['bl', 'br']);
  let fx = 0, fz = 1;
  if (front && back) { fx = front.x - back.x; fz = front.z - back.z; const l = Math.hypot(fx, fz) || 1; fx /= l; fz /= l; }
  const yaw = -Math.atan2(fx, fz);                // rotate so the car faces +Z
  root.rotation.y = yaw; root.updateMatrixWorld(true);
  const bb = new THREE.Box3().setFromObject(root);
  const size = bb.getSize(new THREE.Vector3()), center = bb.getCenter(new THREE.Vector3());
  root.rotation.y = 0; root.updateMatrixWorld(true);
  if (!(size.z > 1e-6)) throw new Error('this car has no geometry');
  const ground = wk.length ? -minY : -bb.min.y;
  return {
    yaw, center: { x: center.x, z: center.z }, ground,
    wheelR: wk.length ? rSum / wk.length : size.y * 0.2,
    length: size.z, width: size.x,
    scale: CAR_LEN_WORLD / size.z,
    halfL: size.z * 0.42, halfW: size.x * 0.40,
    fwd: { x: fx, z: fz }, left: { x: fz, z: -fx },    // in the file's own axes
    warn: warn.length ? warn.join('; ') : ''
  };
}
function makeRig(info, gltf) {                    // a fresh, independent copy of a car
  const model = gltf.scene.clone(true);
  model.position.set(-info.center.x, info.ground, -info.center.z);
  model.rotation.set(0, info.yaw, 0); model.scale.set(1, 1, 1);
  const { wheels, bodies } = findCarParts(model);
  const axLeft = new THREE.Vector3(info.left.x, 0, info.left.z), axUp = new THREE.Vector3(0, 1, 0), axFwd = new THREE.Vector3(info.fwd.x, 0, info.fwd.z);
  const prep = (n, spinToo) => {
    const inv = chainQuat(n, model).invert();
    n.userData.q0 = n.quaternion.clone();
    n.userData.axUp = axUp.clone().applyQuaternion(inv);
    n.userData.axSpin = axLeft.clone().applyQuaternion(inv);
    n.userData.axFwd = axFwd.clone().applyQuaternion(inv);
  };
  Object.values(wheels).forEach(prep);
  bodies.forEach(prep);
  const group = new THREE.Group(), inner = new THREE.Group();
  inner.add(model); group.add(inner);
  group.userData.inner = inner;
  group.scale.setScalar(info.scale);
  group.visible = false;
  scene.add(group);
  let mixer = null;
  if (gltf.animations && gltf.animations.length) { mixer = new THREE.AnimationMixer(model); gltf.animations.forEach(c => mixer.clipAction(c).play()); }
  return { info, group, model, wheels, bodies, mixer };
}
function disposeRig(rig) { if (rig && rig.group.parent) rig.group.parent.remove(rig.group); }
function animateWheels(rig, spin, steerAng) {
  for (const k of ['fl', 'fr', 'bl', 'br']) {
    const n = rig.wheels[k]; if (!n) continue;
    qA.setFromAxisAngle(n.userData.axUp, k[0] === 'f' ? steerAng : 0);
    qB.setFromAxisAngle(n.userData.axSpin, spin);
    n.quaternion.copy(qA).multiply(qB).multiply(n.userData.q0);
  }
}
function leanBody(rig, ang) {
  for (const b of rig.bodies) { qA.setFromAxisAngle(b.userData.axFwd, ang); b.quaternion.copy(qA).multiply(b.userData.q0); }
}
async function getCar(entry) {
  let c = carCache[entry.url];
  if (!c) { c = carCache[entry.url] = { gltf: await loadGLB(entry.url) }; }
  if (!c.info) c.info = analyzeCar(c.gltf);
  return c;
}

// ---- tracks ----
const anc = (o, test) => { for (let p = o; p; p = p.parent) if (test(p)) return true; return false; };
function roadTriangles(meshes) {
  const tris = [], v = new THREE.Vector3();
  for (const m of meshes) {
    m.updateMatrixWorld(true);
    const pos = m.geometry.attributes.position, idx = m.geometry.index;
    const n = idx ? idx.count : pos.count;
    const P = k => { v.fromBufferAttribute(pos, idx ? idx.getX(k) : k).applyMatrix4(m.matrixWorld); return [v.x, v.z]; };
    for (let k = 0; k + 2 < n; k += 3) { const a = P(k), b = P(k + 1), c = P(k + 2); tris.push(a[0], a[1], b[0], b[1], c[0], c[1]); }
  }
  return tris;
}
function lapFromNode(node) {                      // gate position + the direction of its thin axis (= direction of travel)
  node.updateMatrixWorld(true);
  let mesh = null; node.traverse(o => { if (!mesh && o.isMesh) mesh = o; });
  let m4, c, size;
  if (mesh) {
    mesh.updateMatrixWorld(true);
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    const bb = mesh.geometry.boundingBox; c = bb.getCenter(new THREE.Vector3()); size = bb.getSize(new THREE.Vector3()); m4 = mesh.matrixWorld;
  } else { c = new THREE.Vector3(); size = new THREE.Vector3(2, 2, 2); m4 = node.matrixWorld; }   // empty cube
  const e = m4.elements, axes = [new THREE.Vector3(e[0], e[1], e[2]), new THREE.Vector3(e[4], e[5], e[6]), new THREE.Vector3(e[8], e[9], e[10])];
  let best = null;
  axes.forEach((a, i) => {
    const sc = a.length() || 1, ext = size.getComponent(i) * sc, dir = a.clone().divideScalar(sc);
    if (Math.abs(dir.y) < 0.7 && (!best || ext < best.ext)) best = { ext, dir };
  });
  const cw = c.clone().applyMatrix4(m4);
  return { x: cw.x, z: cw.z, dir: best ? { x: best.dir.x, z: best.dir.z } : null };
}
function processTrack(gltf) {
  const root = gltf.scene;
  root.updateMatrixWorld(true);
  const trackNodes = [], lapNodes = [];
  const matteNodes = [];
  root.traverse(o => {
    if (o === root) return;
    if (RL.isLapName(o.name)) lapNodes.push(o);
    else if (RL.isMatteName(o.name)) matteNodes.push(o);
    else if (RL.isTrackName(o.name)) trackNodes.push(o);
  });
  // matte painting mesh: drawn flat (no lighting, no fog, no shadows), never touched by physics
  matteNodes.forEach(n => n.traverse(o => {
    if (!o.isMesh) return;
    o.castShadow = false; o.receiveShadow = false; o.renderOrder = -10; o.frustumCulled = false; o.raycast = () => {};
    const ms = Array.isArray(o.material) ? o.material : [o.material];
    const nm = ms.map(m => new THREE.MeshBasicMaterial({
      map: (m && (m.map || m.emissiveMap)) || null, color: (m && !m.map && !m.emissiveMap && m.color) ? m.color.clone() : 0xffffff,
      side: THREE.DoubleSide, fog: false, toneMapped: false, depthWrite: false }));
    o.material = Array.isArray(o.material) ? nm : nm[0];
  }));
  lapNodes.forEach(n => { n.visible = false; });  // the gate is never drawn
  if (!trackNodes.length) throw new Error('no node whose name starts with "track" in this file');
  const seen = new Set(); let meshes = [];
  trackNodes.forEach(t => t.traverse(o => {
    if (o.isMesh && !o.isSkinnedMesh && !seen.has(o) && !anc(o, p => RL.isLapName(p.name) || RL.isMatteName(p.name))) { seen.add(o); meshes.push(o); }
  }));
  const matName = m => { const ms = Array.isArray(m.material) ? m.material : [m.material]; return ms.some(x => x && RL.isTrackName(x.name)); };
  if (meshes.some(matName)) meshes = meshes.filter(matName);          // only the drivable material, if one is named "track…"
  if (!meshes.length) throw new Error('the "track" node has no mesh');
  meshes.forEach(m => (Array.isArray(m.material) ? m.material : [m.material]).forEach(x => { if (x) x.side = THREE.DoubleSide; }));

  // road mask -> racing line
  const tris = roadTriangles(meshes);
  const grid = RL.buildGrid(tris);
  let start = null, dir = null, reversed = false;
  if (lapNodes.length) { const L = lapFromNode(lapNodes[0]); start = { x: L.x, z: L.z }; dir = L.dir; reversed = RL.lapReversed(lapNodes[0].name); }
  if (!start) {                                   // no gate: start on the lowest road point at the middle of the map
    const cx = grid.minX + grid.w * grid.cell / 2;
    start = { x: cx, z: grid.minZ + grid.h * grid.cell / 2 };
    for (let z = grid.minZ + (grid.h - 3) * grid.cell; z > grid.minZ; z -= grid.cell) if (RL.isRoad(grid, cx, z)) { start = { x: cx, z }; break; }
  }
  let line = RL.extractLine(grid, start, dir);
  if (!line) throw new Error('could not find a closed road loop on this track');
  // normalise the world size (so every track feels the same), then redo the line with the right point spacing
  const k = REF_ROAD_WIDTH / (2 * RL.median(line.hw));
  line = RL.extractLine(grid, start, dir, { spacing: LINE_SPACING / k });
  if (line.area > 0) line = RL.reverseLine(line);       // default: clockwise seen from above
  if (reversed) line = RL.reverseLine(line);            // box named lap_reverse
  if (Math.abs(k - 1) > 0.01) { root.scale.multiplyScalar(k); line = RL.scaleLine(line, k); }
  root.updateMatrixWorld(true);
  const bb = new THREE.Box3(); meshes.forEach(m => bb.expandByObject(m));
  let mixer = null;
  if (gltf.animations && gltf.animations.length) { mixer = new THREE.AnimationMixer(root); gltf.animations.forEach(c => mixer.clipAction(c).play()); }
  return { root, meshes, line, mixer, top: bb.max.y + 1, far: bb.max.y - bb.min.y + 3, minY: bb.min.y, hasGate: lapNodes.length > 0, hasMatte: matteNodes.length > 0 };
}
async function getTrack(entry) {
  let t = trackCache[entry.url];
  if (!t) { const gltf = await loadGLB(entry.url); t = trackCache[entry.url] = processTrack(gltf); }
  return t;
}
function applyTrack(t) {
  if (trackObj) scene.remove(trackObj.root);
  trackObj = t; scene.add(t.root);
  roadMeshes = t.meshes; rayTop = t.top; rayFar = t.far; killY = t.minY - 1.2;
  setRacingLine(t.line);
}

// ---- matte painting backdrop ----
let bdTok = 0, localBackdrop = null;
const loadTex = url => new Promise((res, rej) => new THREE.TextureLoader().load(url, res, undefined, () => rej(new Error('no image'))));
function showDome(tex) {
  tex.encoding = THREE.sRGBEncoding;
  tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  dome.material.map = tex; dome.material.needsUpdate = true; dome.visible = true;
}
// priority: a mesh named "matepainting" inside the track file  >  assets/backdrops/<track file name>.jpg|png|webp  >  assets/backdrops/matepainting.jpg|png|webp
async function updateBackdrop(entry, t) {
  const tok = ++bdTok;
  if (t.hasMatte) { dome.visible = false; return; }
  if (localBackdrop) { showDome(localBackdrop); return; }
  if (location.protocol === 'file:') { dome.visible = false; return; }
  const base = (entry.file || '').replace(/\.glb$/i, '');
  for (const b of [base, 'matepainting']) {
    if (!b) continue;
    for (const ext of ['jpg', 'jpeg', 'png', 'webp']) {
      if (tok !== bdTok) return;
      try { const tex = await loadTex('assets/backdrops/' + encodeURIComponent(b) + '.' + ext); if (tok !== bdTok) return; showDome(tex); return; } catch (e) { /* try next */ }
    }
  }
  if (tok === bdTok) dome.visible = false;
}

// ---------- bots ----------
let bots = [];
function makeShadow(op) {
  const m = new THREE.Mesh(new THREE.CircleGeometry(0.08, 20), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: op, depthWrite: false }));
  m.scale.set(0.55, 1.05, 1); m.rotation.x = -Math.PI / 2; scene.add(m); return m;
}
function clearBots() { bots.forEach(b => { disposeRig(b.rig); scene.remove(b.shadow); }); bots = []; }
function buildBots(rigsList) {
  clearBots();
  bots = rigsList.map((rig, k) => {
    rig.group.visible = true;
    return { rig, skill: BOT_SKILLS[k % BOT_SKILLS.length], x: 0, z: 0, y: 0, yaw: 0, speed: 0, idx: 0, laps: -1, steer: 0, spin: 0, pitch: 0, roll: 0,
      lane: 0, laneGoal: 0, laneTimer: 0, finished: false, finishT: 0, shadow: makeShadow(0.28) };
  });
}
function resetBots() {
  bots.forEach((b, k) => {
    const p = gridPose(k);
    b.x = p.x; b.z = p.z; b.yaw = p.yaw; b.idx = p.idx; b.laps = -1; b.speed = 0; b.steer = 0; b.pitch = 0; b.roll = 0;
    b.lane = GRID[k].lane; b.laneGoal = b.lane; b.laneTimer = 1 + k; b.finished = false; b.finishT = 0;
    const h = groundAt(b.x, b.z); b.y = h === null ? 0 : h;
    botVisual(b, 0);
  });
}
function botVisual(b, dt) {
  const g = b.rig.group, info = b.rig.info;
  g.position.set(b.x, b.y, b.z);
  g.rotation.set(0, b.yaw, 0, 'YXZ');
  g.userData.inner.rotation.set(-b.pitch, 0, b.roll, 'XYZ');
  b.spin += b.speed * dt / (info.wheelR * info.scale);
  if (b.rig.mixer) b.rig.mixer.update(dt);
  animateWheels(b.rig, b.spin, b.steer * 0.45);
  leanBody(b.rig, -b.steer * clamp(b.speed / BOT_MAX, 0, 1) * 0.05);
  const hs = groundAt(b.x, b.z);
  b.shadow.visible = hs !== null;
  if (hs !== null) { b.shadow.position.set(b.x, hs + 0.002, b.z); b.shadow.rotation.set(-Math.PI / 2, 0, b.yaw, 'YXZ'); }
}
function updateBots(dt) {
  const active = race.state === 'race' || race.state === 'finish';
  const playerProg = car.laps * TN + car.idx;
  for (const b of bots) {
    if (active) {
      const hw = TRACK.hw[b.idx];
      b.laneTimer -= dt;
      if (b.laneTimer <= 0) { b.laneGoal = (Math.random() * 2 - 1) * 0.7 * Math.max(0.05, hw - 0.17); b.laneTimer = 2 + Math.random() * 3; }
      b.lane += (b.laneGoal - b.lane) * Math.min(1, dt * 0.9);
      const lane = clamp(b.lane, -(hw - 0.15), hw - 0.15);
      const look = 6 + Math.round(b.speed * 3), ti = wrapI(b.idx + look);
      const tx = TRACK.x[ti] + TTZ[ti] * lane, tz = TRACK.z[ti] - TTX[ti] * lane;
      const diff = wrapAng(Math.atan2(tx - b.x, tz - b.z) - b.yaw);
      b.steer += (clamp(diff * 2.5, -1, 1) - b.steer) * Math.min(1, dt * 8);
      b.yaw += b.steer * BOT_TURN * clamp(b.speed / 0.5, 0, 1) * dt;
      const a1 = Math.atan2(TTX[wrapI(b.idx + 2)], TTZ[wrapI(b.idx + 2)]);
      const a2 = Math.atan2(TTX[wrapI(b.idx + 16)], TTZ[wrapI(b.idx + 16)]);
      const curve = Math.abs(wrapAng(a2 - a1));
      const rb = clamp(1 + ((playerProg - (b.laps * TN + b.idx)) / TN) * 0.5, 0.92, 1.07);
      const target = BOT_MAX * b.skill * rb * (1 - clamp(curve * 0.9, 0, 0.5)) * (1 - clamp(Math.abs(diff) * 0.25, 0, 0.3));
      if (b.speed < target) b.speed += BOT_ACCEL * dt * (1 - clamp(b.speed / (BOT_MAX * 1.1), 0, 1) * 0.6);
      else b.speed -= 3 * dt;
      b.x += Math.sin(b.yaw) * b.speed * dt;
      b.z += Math.cos(b.yaw) * b.speed * dt;
    }
    const h = groundAt(b.x, b.z);
    if (h === null) {                              // slipped off the road: pull back to the line
      const ci = nearestIdxNear(b.x, b.z, b.idx, 20);
      b.x += (TRACK.x[ci] - b.x) * 0.25; b.z += (TRACK.z[ci] - b.z) * 0.25; b.speed *= 0.85;
    } else b.y = h;
    trackAdvance(b, b.x, b.z);
    if (!b.finished && b.laps >= TOTAL_LAPS) { b.finished = true; b.finishT = race.t; }
    const s = Math.sin(b.yaw), c = Math.cos(b.yaw), hl = b.rig.info.halfL * b.rig.info.scale;
    const hf = groundAt(b.x + s * hl, b.z + c * hl), hb = groundAt(b.x - s * hl, b.z - c * hl);
    const tp = (hf !== null && hb !== null) ? Math.atan2(hf - hb, hl * 2) : 0;
    b.pitch += (tp - b.pitch) * Math.min(1, dt * 10);
    botVisual(b, dt);
  }
}
function collideCars() {
  if (race.state !== 'race' && race.state !== 'finish') return;
  const ents = [car, ...bots];
  const px = car.x, pz = car.z;
  for (let i = 0; i < ents.length; i++) for (let j = i + 1; j < ents.length; j++) {
    const a = ents[i], b = ents[j];
    const dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz), min = 0.12;
    if (d < min && d > 1e-5 && Math.abs(a.y - b.y) < 0.08) {
      const nx = dx / d, nz = dz / d, ov = (min - d) / 2;
      a.x -= nx * ov; a.z -= nz * ov; b.x += nx * ov; b.z += nz * ov;
      a.speed *= 0.985; b.speed *= 0.985;
    }
  }
  if (!car.air && (car.x !== px || car.z !== pz) && probes(car.x, car.z, car.yaw).valid < 3) { car.x = px; car.z = pz; }
}
const score = e => e.finished ? 1e6 - e.finishT : e.laps * TN + e.idx;
function playerRank() { const me = score(car); let r = 1; for (const b of bots) if (score(b) > me) r++; return r; }
const ORD = ['1st', '2nd', '3rd', '4th', '5th'];

// ---------- drift smoke ----------
const puffs = []; let puffI = 0, puffTimer = 0;
(function initPuffs() {
  const g = new THREE.SphereGeometry(0.018, 8, 6);
  for (let i = 0; i < 28; i++) {
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false }));
    m.visible = false; scene.add(m); puffs.push({ m, life: 0, max: 0.5 });
  }
})();
function spawnPuff(x, y, z, color) {
  const p = puffs[puffI++ % puffs.length];
  p.m.position.set(x + (Math.random() - 0.5) * 0.015, y + 0.01, z + (Math.random() - 0.5) * 0.015);
  p.m.material.color.setHex(color); p.life = p.max = 0.45 + Math.random() * 0.2; p.m.visible = true; p.m.scale.setScalar(1);
}
function updatePuffs(dt) {
  for (const p of puffs) {
    if (p.life <= 0) continue;
    p.life -= dt;
    if (p.life <= 0) { p.m.visible = false; continue; }
    const k = 1 - p.life / p.max;
    p.m.scale.setScalar(1 + k * 2.2); p.m.material.opacity = 0.55 * (1 - k); p.m.position.y += dt * 0.06;
  }
}
shadow = makeShadow(0.3);

// ---------- placement / race flow ----------
function placeAtStart() {
  const p = gridPose(2);                           // player starts at the back of the grid
  car.x = p.x; car.z = p.z; car.yaw = p.yaw; car.moveYaw = p.yaw; car.idx = p.idx; car.laps = -1;
  const h = groundAt(car.x, car.z); car.y = h === null ? 0 : h;
  car.speed = 0; car.vy = 0; car.air = false; car.pitch = 0; car.roll = 0; car.steer = 0;
  car.drift = 0; car.driftT = 0; car.turbo = 0; car.prevOnly = 0; car.finished = false; car.finishT = 0;
  lastSafe = { x: car.x, z: car.z, yaw: car.yaw, idx: car.idx, laps: car.laps };
  resetBots();
}
function restartRace() {
  if (!playerRig || !TRACK) return;
  placeAtStart();
  race = { state: 'count', t: 0, countdown: 3.4, lapStart: 0, best: race.best, total: 0 };
  car.boost = 1;
  $('sub').textContent = ''; $('msg').textContent = '';
}
function respawn() {
  if (!playerRig || race.state === 'loading' || race.state === 'select') return;
  car.x = lastSafe.x; car.z = lastSafe.z; car.yaw = lastSafe.yaw; car.moveYaw = lastSafe.yaw;
  car.idx = lastSafe.idx; car.laps = lastSafe.laps;
  const h = groundAt(car.x, car.z); car.y = h === null ? 0 : h;
  car.speed = 0; car.vy = 0; car.air = false; car.drift = 0; car.driftT = 0;
}

// ---------- select screen ----------
let carIdx = 0, trackIdx = 0, carTok = 0, trackTok = 0, busy = 0, started = false;
let toastT = 0;
function toast(msg, secs) { $('selMsg').textContent = msg || ''; toastT = (secs || 7); if (msg) console.warn(msg); }
function setBusy(d) {
  busy += d;
  const b = $('selGo'); b.disabled = busy > 0 || !playerRig || !TRACK;
  b.textContent = busy > 0 ? 'LOADING…' : 'START RACE';
}
async function chooseTrack(i) {
  if (!TRACKS.length) return;
  trackIdx = (i % TRACKS.length + TRACKS.length) % TRACKS.length;
  const tok = ++trackTok; setBusy(1);
  $('trkName').textContent = TRACKS[trackIdx].name + ' …';
  try {
    const t = await getTrack(TRACKS[trackIdx]);
    if (tok !== trackTok) return;
    applyTrack(t);
    updateBackdrop(TRACKS[trackIdx], t);
    $('trkName').textContent = TRACKS[trackIdx].name;
    if (!t.hasGate) toast('"' + TRACKS[trackIdx].name + '": no box named "lap" found — start line placed automatically.', 6);
    if (playerRig && race.state === 'select') placeAtStart();
  } catch (e) {
    if (tok === trackTok) { $('trkName').textContent = TRACKS[trackIdx].name + ' (error)'; toast('Track "' + TRACKS[trackIdx].name + '": ' + e.message, 10); }
  } finally { setBusy(-1); }
}
async function chooseCar(i) {
  if (!CARS.length) return;
  carIdx = (i % CARS.length + CARS.length) % CARS.length;
  const tok = ++carTok; setBusy(1);
  $('selName').textContent = CARS[carIdx].name + ' …';
  try {
    const mine = await getCar(CARS[carIdx]);
    const botEntries = []; for (let k = 0; k < NUM_BOTS; k++) botEntries.push(CARS[(carIdx + 1 + k) % CARS.length]);
    const botCars = [];
    for (const e of botEntries) { try { botCars.push(await getCar(e)); } catch (err) { botCars.push(mine); } }
    if (tok !== carTok) return;
    disposeRig(playerRig);
    playerRig = makeRig(mine.info, mine.gltf); playerRig.group.visible = true;
    CAR_SCALE = mine.info.scale; WHEEL_R = mine.info.wheelR; HALF_W = mine.info.halfW * CAR_SCALE; HALF_L = mine.info.halfL * CAR_SCALE;
    car.wheelSpin = 0;
    buildBots(botCars.map(c => makeRig(c.info, c.gltf)));
    $('selName').textContent = CARS[carIdx].name;
    if (mine.info.warn) toast('"' + CARS[carIdx].name + '": ' + mine.info.warn, 8);
    if (TRACK && race.state === 'select') placeAtStart();
  } catch (e) {
    if (tok === carTok) { $('selName').textContent = CARS[carIdx].name + ' (error)'; toast('Car "' + CARS[carIdx].name + '": ' + e.message, 10); }
  } finally { setBusy(-1); }
}
function enterSelect() {
  if (!playerRig || !TRACK) return;
  placeAtStart();
  race = { state: 'select', t: 0, countdown: 3.4, lapStart: 0, best: race.best, total: 0 };
  $('select').style.display = 'flex'; $('msg').textContent = ''; $('sub').textContent = '';
  $('selHint').textContent = (CARS.length > 1 ? '←/→ car · ' : '') + (TRACKS.length > 1 ? '↑/↓ track · ' : '') + 'Enter to start   (' + CARS.length + ' cars, ' + TRACKS.length + ' tracks found)';
}
function startFromSelect() {
  if (race.state !== 'select' || busy > 0 || !playerRig || !TRACK) return;
  $('select').style.display = 'none'; $('selMsg').textContent = '';
  restartRace();
}
$('selPrev').addEventListener('click', () => { startAudio(); chooseCar(carIdx - 1); });
$('selNext').addEventListener('click', () => { startAudio(); chooseCar(carIdx + 1); });
$('trkPrev').addEventListener('click', () => chooseTrack(trackIdx - 1));
$('trkNext').addEventListener('click', () => chooseTrack(trackIdx + 1));
$('selGo').addEventListener('click', () => { startAudio(); startFromSelect(); });

// ---- add .glb files by hand (drag & drop or button) — handy when testing before uploading ----
function classify(gltf) {
  let wheel = 0, body = 0, track = 0;
  gltf.scene.traverse(o => { if (RL.wheelKey(o.name)) wheel++; else if (RL.isBodyName(o.name)) body++; else if (RL.isTrackName(o.name) && !RL.isLapName(o.name)) track++; });
  if (body || wheel >= 2) return 'car';
  if (track) return 'track';
  return null;
}
async function addLocalFiles(files) {
  for (const f of files) {
    if (/\.(jpe?g|png|webp)$/i.test(f.name)) {
      try { localBackdrop = await loadTex(URL.createObjectURL(f)); showDome(localBackdrop); toast('Matte painting "' + f.name + '" applied (until you reload — put it in assets/backdrops to keep it)', 6); }
      catch (e) { toast('"' + f.name + '": could not read this image', 6); }
      continue;
    }
    if (!/\.glb$/i.test(f.name)) { toast('"' + f.name + '" is not a .glb or image file', 5); continue; }
    const url = URL.createObjectURL(f);
    try {
      const gltf = await loadGLB(url), kind = classify(gltf), entry = { name: prettyName(f.name), file: f.name, url };
      if (kind === 'car') { carCache[url] = { gltf }; CARS.push(entry); toast('Added car "' + entry.name + '" (until you reload — upload it to assets/cars to keep it)', 6); }
      else if (kind === 'track') { TRACKS.push(entry); trackCache[url] = processTrack(gltf); toast('Added track "' + entry.name + '" (until you reload — upload it to assets/tracks to keep it)', 6); }
      else toast('"' + f.name + '": could not tell if this is a car (wheels / "cars_body") or a track ("track…")', 9);
    } catch (e) { toast('"' + f.name + '": ' + e.message, 9); }
  }
  if (!started) tryBegin(); else if (race.state === 'select') { if (!playerRig) chooseCar(0); if (!TRACK) chooseTrack(0); }
}
$('fileIn').addEventListener('change', e => { addLocalFiles(Array.from(e.target.files)); e.target.value = ''; });
addEventListener('dragover', e => { e.preventDefault(); });
addEventListener('drop', e => { e.preventDefault(); if (e.dataTransfer && e.dataTransfer.files.length) addLocalFiles(Array.from(e.dataTransfer.files)); });

// ---------- physics ----------
function probes(x, z, yaw) {
  const s = Math.sin(yaw), c = Math.cos(yaw);
  const pts = [[HALF_L, HALF_W], [HALF_L, -HALF_W], [-HALF_L, HALF_W], [-HALF_L, -HALF_W]];
  let valid = 0; const hs = [];
  for (const [a, b] of pts) {
    const px = x + s * a + c * b, pz = z + c * a - s * b;
    const h = groundAt(px, pz);
    hs.push(h); if (h !== null) valid++;
  }
  return { valid, hs };
}

function update(dt) {
  const throttle = down('ArrowUp', 'KeyW') ? 1 : 0;
  const brake = down('ArrowDown', 'KeyS') ? 1 : 0;
  const left = down('ArrowLeft', 'KeyA') ? 1 : 0;
  const right = down('ArrowRight', 'KeyD') ? 1 : 0;
  const wantJump = down('Space');
  const wantBoost = down('ShiftLeft', 'ShiftRight');
  const racing = race.state === 'race';

  let boosting = false;
  if (racing && wantBoost && car.boost > 0.02 && throttle) { boosting = true; car.boost = Math.max(0, car.boost - 0.45 * dt); }
  else car.boost = Math.min(1, car.boost + 0.18 * dt);
  const turboOn = car.turbo > 0;
  if (turboOn) car.turbo -= dt;
  const vmax = MAX_SPEED * (boosting ? BOOST_MULT : (turboOn ? 1.3 : 1));

  // ---- steering & drift (hold a direction, then tap the opposite one) ----
  const onlyL = left && !right, onlyR = right && !left;
  const endDrift = () => {
    if (car.driftT > 0.8) { car.turbo = Math.min(1.3, 0.5 + car.driftT * 0.3); car.boost = Math.min(1, car.boost + 0.25); sfx(700, 0.2, 'triangle', 0.08); flash('TURBO!', 500); }
    car.drift = 0; car.driftT = 0;
  };
  if (!car.drift && racing && !car.air && car.speed > 0.9 && left && right && car.prevOnly !== 0) {
    car.drift = car.prevOnly; car.driftT = 0; sfx(300, 0.12, 'sawtooth', 0.05);   // +1 = drifting left, -1 = right
  }
  car.prevOnly = onlyL ? 1 : (onlyR ? -1 : ((left && right) ? car.prevOnly : 0));
  let steerTarget = left - right;
  if (car.drift) {
    const hd = car.drift > 0 ? left : right, ho = car.drift > 0 ? right : left;
    if ((!left && !right) || car.speed < 0.6 || car.air || !racing) endDrift();
    else { steerTarget = car.drift * ((hd && !ho) ? 1.0 : ((hd && ho) ? 0.75 : 0.42)); car.driftT += dt; }
  }
  car.steer += (steerTarget - car.steer) * Math.min(1, dt * 10);
  const sp = car.speed;
  const speedFactor = clamp(Math.abs(sp) / 0.5, 0, 1) * (1 - 0.35 * clamp(Math.abs(sp) / MAX_SPEED, 0, 1));
  const airFactor = car.air ? 0.45 : 1;
  if (racing || race.state === 'finish') {
    if (car.drift) car.yaw += car.steer * TURN_RATE * 0.85 * dt;
    else car.yaw += car.steer * TURN_RATE * speedFactor * Math.sign(sp || 1) * airFactor * dt;
  }

  // speed
  if (!car.air) {
    if (racing) {
      if (throttle) car.speed += ACCEL * ((boosting || turboOn) ? 2.2 : 1) * dt * (1 - clamp(Math.max(0, sp) / vmax, 0, 1) * 0.65);
      if (brake) car.speed += (sp > 0.05 ? -BRAKE : -ACCEL * 0.8) * dt;
    }
    if ((!throttle && !brake) || !racing) { const d = DRAG * dt; car.speed = Math.abs(car.speed) <= d ? 0 : car.speed - Math.sign(car.speed) * d; }
    car.speed = clamp(car.speed, -MAX_SPEED * 0.45, vmax);
    if (sp > vmax) car.speed = Math.max(vmax, sp - 2 * dt);
  }

  // jump
  if (racing && wantJump && !car.air) { car.vy = JUMP_V; car.air = true; sfx(520, 0.12, 'triangle', 0.08); }

  // horizontal movement (the car travels along moveYaw; in a drift it lags behind where the nose points)
  { const lag = car.drift ? 4.0 : (car.air ? 1.2 : 18);
    car.moveYaw += wrapAng(car.yaw - car.moveYaw) * Math.min(1, dt * lag);
    const sl = wrapAng(car.yaw - car.moveYaw);
    if (Math.abs(sl) > 0.75) car.moveYaw = car.yaw - Math.sign(sl) * 0.75; }
  const s = Math.sin(car.moveYaw), c = Math.cos(car.moveYaw);
  let nx = car.x + s * car.speed * dt, nz = car.z + c * car.speed * dt;
  if (!car.air) {                                  // road edges act as walls
    const cur = probes(car.x, car.z, car.yaw);
    const need = Math.min(4, cur.valid);
    let ok = probes(nx, nz, car.yaw).valid >= need;
    if (!ok) {
      if (probes(nx, car.z, car.yaw).valid >= need) { nz = car.z; ok = true; }
      else if (probes(car.x, nz, car.yaw).valid >= need) { nx = car.x; ok = true; }
    }
    if (ok) { car.x = nx; car.z = nz; }
    else { if (Math.abs(car.speed) > 0.5) sfx(110, 0.08, 'square', 0.07); car.speed *= -0.25; car.drift = 0; car.driftT = 0; }
  } else { car.x = nx; car.z = nz; }

  // vertical
  const hC = groundAt(car.x, car.z);
  if (car.air) {
    car.vy -= GRAVITY * dt;
    car.y += car.vy * dt;
    if (hC !== null && car.y <= hC && car.vy <= 0) {
      car.y = hC; car.air = false;
      if (car.vy < -1.2) sfx(140, 0.1, 'sine', 0.1);
      car.vy = 0;
    }
    if (car.y < killY) respawn();
  } else {
    if (hC === null) { car.air = true; car.vy = 0; }
    else {
      const prev = car.y; car.y = hC;
      const vyGround = (hC - prev) / Math.max(dt, 1e-4);
      if (vyGround > 2.2) { car.air = true; car.vy = Math.min(vyGround * 0.6, 2.5); car.y = prev; }
    }
  }

  // pitch/roll from the road
  let tp = 0, tr = 0;
  if (!car.air) {
    const p = probes(car.x, car.z, car.yaw);
    if (p.valid === 4) {
      const [fl, fr, bl, br] = p.hs;
      tp = Math.atan2(((fl + fr) / 2) - ((bl + br) / 2), HALF_L * 2);
      tr = Math.atan2(((fl + bl) / 2) - ((fr + br) / 2), HALF_W * 2);
    }
    tr += car.drift * 0.07;
  } else { tp = clamp(-car.vy * 0.06, -0.25, 0.25); }
  car.pitch += (tp - car.pitch) * Math.min(1, dt * 10);
  car.roll += (tr - car.roll) * Math.min(1, dt * 10);

  // last safe spot (for R / falling off)
  safeTimer += dt;
  if (!car.air && safeTimer > 0.4) {
    safeTimer = 0;
    if (probes(car.x, car.z, car.yaw).valid === 4) lastSafe = { x: car.x, z: car.z, yaw: car.yaw, idx: car.idx, laps: car.laps };
  }

  // wheels + body
  car.wheelSpin += car.speed * dt / (WHEEL_R * CAR_SCALE);
  if (playerRig.mixer) playerRig.mixer.update(dt);
  animateWheels(playerRig, car.wheelSpin, car.steer * 0.45);
  leanBody(playerRig, -car.steer * clamp(car.speed / MAX_SPEED, 0, 1) * 0.05);

  // drift smoke
  if (car.drift && !car.air) {
    puffTimer -= dt;
    if (puffTimer <= 0) {
      puffTimer = 0.03;
      const sy = Math.sin(car.yaw), cy = Math.cos(car.yaw);
      for (const side of [1, -1]) spawnPuff(car.x - sy * HALF_L * 0.8 + cy * HALF_W * side, car.y, car.z - cy * HALF_L * 0.8 - sy * HALF_W * side, car.driftT > 0.8 ? 0xffb020 : 0xffffff);
    }
  }

  // progress along the racing line + laps (index 0 = the "lap" gate)
  if (racing || race.state === 'finish') {
    const before = car.laps;
    trackAdvance(car, car.x, car.z);
    if (racing && car.laps > before) {
      if (car.laps === 0) { race.lapStart = race.t; flash('LAP 1', 700); sfx(660, 0.15, 'triangle', 0.08); }
      else {
        const lt = race.t - race.lapStart; race.lapStart = race.t;
        if (race.best === null || lt < race.best) race.best = lt;
        sfx(880, 0.2, 'triangle', 0.1);
        if (car.laps >= TOTAL_LAPS) {
          car.finished = true; car.finishT = race.t;
          race.state = 'finish'; race.total = race.t;
          const pl = playerRank();
          $('msg').textContent = pl === 1 ? 'YOU WIN!' : 'FINISH! ' + ORD[pl - 1];
          $('sub').textContent = 'Total ' + fmt(race.t) + '   ·   Best lap ' + fmt(race.best) + '\nEnter: race again  ·  C: car / track menu';
        } else flash('LAP ' + (car.laps + 1), 900);
      }
    }
  }
  if (race.state === 'finish') { car.speed *= Math.max(0, 1 - 1.2 * dt); }
}

let flashT = 0;
function flash(t, ms) { $('msg').textContent = t; flashT = ms / 1000; }

// ---------- camera & visuals ----------
const camPos = new THREE.Vector3(), camLook = new THREE.Vector3();
let camInit = false, orbitA = 0;
function updateVisuals(dt) {
  const g = playerRig.group;
  g.position.set(car.x, car.y, car.z);
  g.rotation.set(0, car.yaw, 0, 'YXZ');
  g.userData.inner.rotation.set(-car.pitch, 0, car.roll, 'XYZ');
  const hs = groundAt(car.x, car.z);
  shadow.visible = hs !== null;
  if (hs !== null) {
    shadow.position.set(car.x, hs + 0.002, car.z);
    shadow.rotation.set(-Math.PI / 2, 0, car.yaw, 'YXZ');
    shadow.material.opacity = 0.32 * (1 - clamp((car.y - hs) / 0.2, 0, 0.6));
  }
  if (race.state === 'select') {                   // orbit around the car on the start grid
    orbitA += dt * 0.7;
    camPos.set(car.x + Math.sin(orbitA) * 0.4, car.y + 0.18, car.z + Math.cos(orbitA) * 0.4);
    camLook.set(car.x, car.y + 0.05, car.z); camInit = true;
    camera.position.copy(camPos); camera.lookAt(camLook);
    return;
  }
  const s = Math.sin(car.yaw), c = Math.cos(car.yaw);
  const dist = 0.42 + clamp(car.speed / MAX_SPEED, 0, 1) * 0.10, height = 0.20 + (car.air ? 0.02 : 0);
  const target = new THREE.Vector3(car.x - s * dist, car.y + height, car.z - c * dist);
  const lookT = new THREE.Vector3(car.x + s * 0.14, car.y + 0.056, car.z + c * 0.14);
  if (!camInit) { camPos.copy(target); camLook.copy(lookT); camInit = true; }
  camPos.lerp(target, 1 - Math.exp(-dt * 7)); camLook.lerp(lookT, 1 - Math.exp(-dt * 12));
  camera.position.copy(camPos); camera.lookAt(camLook);
  const fov = 62 + clamp(car.speed / MAX_SPEED, 0, 1.4) * 10;
  if (Math.abs(camera.fov - fov) > 0.05) { camera.fov += (fov - camera.fov) * 0.1; camera.updateProjectionMatrix(); }
}

// ---------- HUD / audio ----------
const elDrift = $('driftTxt'), elTop = $('top'), elSpeed = $('speed'), elBoost = $('boost'), elMsg = $('msg');
function updateHUD() {
  const lapNo = clamp(car.laps + 1, 1, TOTAL_LAPS);
  const pos = (race.state === 'race' || race.state === 'finish') ? playerRank() : (bots.length + 1);
  elTop.innerHTML = 'LAP ' + lapNo + ' / ' + TOTAL_LAPS + ' &nbsp;·&nbsp; POS ' + pos + ' / ' + (bots.length + 1) + '<br><small>Time ' + fmt(race.t) + (race.best !== null ? '  ·  Best lap ' + fmt(race.best) : '') + '</small>';
  elDrift.textContent = car.drift ? (car.driftT > 0.8 ? 'DRIFT ⚡ release for turbo' : 'DRIFT') : '';
  elDrift.style.color = car.driftT > 0.8 ? '#ffd23f' : '#fff';
  elSpeed.firstChild.nodeValue = Math.round(Math.abs(car.speed) / MAX_SPEED * 65) + ' ';
  elBoost.style.width = (car.boost * 100) + '%';
}
function updateAudio() {
  if (!actx || !gain) return;
  const v = clamp(Math.abs(car.speed) / MAX_SPEED, 0, 1.4);
  osc.frequency.setTargetAtTime(55 + v * 130 + (car.air ? 30 : 0), actx.currentTime, 0.05);
  gain.gain.setTargetAtTime(muted ? 0 : 0.035 + v * 0.03, actx.currentTime, 0.05);
}

// ---------- main loop ----------
let last = performance.now();
function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  if (toastT > 0) { toastT -= dt; if (toastT <= 0) $('selMsg').textContent = ''; }
  if (!playerRig || !TRACK) { renderer.render(scene, camera); return; }
  if (race.state === 'count') {
    race.countdown -= dt;
    const n = Math.ceil(race.countdown);
    if (race.countdown > 0) elMsg.textContent = n > 3 ? '' : String(n);
    else { race.state = 'race'; flash('GO!', 800); sfx(660, 0.3, 'square', 0.08); }
  }
  if (race.state === 'race') race.t += dt;
  if (flashT > 0) { flashT -= dt; if (flashT <= 0 && race.state !== 'finish') elMsg.textContent = ''; }
  if (trackObj && trackObj.mixer) trackObj.mixer.update(dt);
  if (race.state !== 'select') update(dt);
  updateBots(dt);
  collideCars();
  updatePuffs(dt);
  updateVisuals(dt);
  dome.position.copy(camera.position);
  updateHUD();
  updateAudio();
  renderer.render(scene, camera);
}

// ---------- start-up ----------
async function begin() {
  if (started) return; started = true;
  $('loadMsg').textContent = 'Loading…'; $('loadSub').textContent = '';
  await chooseTrack(0);
  await chooseCar(0);
  if (!playerRig || !TRACK) {
    started = false;
    $('loadMsg').textContent = 'Could not start';
    $('loadSub').textContent = ($('selMsg').textContent || 'Check that your car and track files follow the naming rules (see README).');
    return;
  }
  enterSelect();
  $('loading').style.display = 'none';
}
function tryBegin() { if (CARS.length && TRACKS.length) begin(); else showEmpty(); }
function showEmpty() {
  $('loadMsg').textContent = !CARS.length && !TRACKS.length ? 'No cars or tracks found' : (!CARS.length ? 'No cars found' : 'No tracks found');
  $('loadSub').innerHTML = 'Put car files in <b>assets/cars</b> and track files in <b>assets/tracks</b> (then reload), or drop your <b>.glb</b> files on this page to try them right now.<br><br>' +
    '<label class="fileBtn">＋ Add .glb files<input type="file" id="fileIn2" accept=".glb" multiple hidden></label>';
  const f2 = $('fileIn2'); if (f2) f2.addEventListener('change', e => { addLocalFiles(Array.from(e.target.files)); e.target.value = ''; });
}
(async function startup() {
  requestAnimationFrame(loop);
  const man = location.protocol === 'file:' ? { cars: [], tracks: [] } : await fetchManifest();
  const mk = (list, dir) => (list || []).map(f => ({ name: prettyName(f), file: f, url: 'assets/' + dir + '/' + encodeURIComponent(f) }));
  CARS = mk(man.cars, 'cars'); TRACKS = mk(man.tracks, 'tracks');
  if (location.protocol === 'file:') {
    $('loadMsg').textContent = 'Opened as a local file';
    $('loadSub').innerHTML = 'Browsers block loading the assets folder from a local file. Run it from GitHub Pages (or a local web server), or drop your <b>.glb</b> car and track files on this page to play now.<br><br><label class="fileBtn">＋ Add .glb files<input type="file" id="fileIn2" accept=".glb" multiple hidden></label>';
    const f2 = $('fileIn2'); if (f2) f2.addEventListener('change', e => { addLocalFiles(Array.from(e.target.files)); e.target.value = ''; });
    return;
  }
  tryBegin();
})();
})();
