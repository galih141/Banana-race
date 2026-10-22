/* racingline.js — pure helpers (no THREE): name detection + racing-line extraction from a road mask.
   Works in the browser (window.RL) and in Node (module.exports) so it can be unit-tested. */
(function (root) {
  'use strict';
  const RL = {};
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  RL.norm = norm;

  // ---- naming rules ----
  // wheels: front_left / front_right / back_left / back_right  (rear_* also accepted)
  RL.wheelKey = function (name) {
    const m = /(front|back|rear)(left|right)\d*$/.exec(norm(name));
    if (!m) return null;
    return (m[1] === 'front' ? 'f' : 'b') + (m[2] === 'left' ? 'l' : 'r');
  };
  // body: name ends with "cars_body" (cat_cars_body, dog_cars_body…); "car_body" is accepted too
  RL.isBodyName = name => /cars?body\d*$/.test(norm(name));
  // track: name starts with "track"
  RL.isTrackName = name => norm(name).startsWith('track');
  // lap gate: name starts with "lap"; "lap_reverse" / "lap_rev" flips the race direction
  RL.isLapName = name => norm(name).startsWith('lap');
  RL.lapReversed = name => /rev/.test(norm(name));
  // matte painting: a mesh named "matepainting" (or "mattepainting") — a flat-shaded background dome
  RL.isMatteName = name => /^matt?epaint/.test(norm(name));

  // ---- road mask ----
  // tris: flat array [x0,z0,x1,z1,x2,z2, ...] in world units (top-down projection of the road surface)
  RL.buildGrid = function (tris, cellHint) {
    let minX = 1e18, minZ = 1e18, maxX = -1e18, maxZ = -1e18;
    for (let i = 0; i < tris.length; i += 2) {
      const x = tris[i], z = tris[i + 1];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    const span = Math.max(maxX - minX, maxZ - minZ) || 1;
    const cell = cellHint || span / 700;
    minX -= cell * 3; minZ -= cell * 3;
    const w = Math.ceil((maxX - minX) / cell) + 4, h = Math.ceil((maxZ - minZ) / cell) + 4;
    const mask = new Uint8Array(w * h);
    const eps = 0.03;
    for (let t = 0; t < tris.length; t += 6) {
      const x0 = tris[t], z0 = tris[t + 1], x1 = tris[t + 2], z1 = tris[t + 3], x2 = tris[t + 4], z2 = tris[t + 5];
      const d = (z1 - z2) * (x0 - x2) + (x2 - x1) * (z0 - z2);
      if (Math.abs(d) < 1e-14) continue;
      const i0 = Math.max(0, Math.floor((Math.min(x0, x1, x2) - minX) / cell) - 1);
      const i1 = Math.min(w - 1, Math.ceil((Math.max(x0, x1, x2) - minX) / cell) + 1);
      const j0 = Math.max(0, Math.floor((Math.min(z0, z1, z2) - minZ) / cell) - 1);
      const j1 = Math.min(h - 1, Math.ceil((Math.max(z0, z1, z2) - minZ) / cell) + 1);
      for (let j = j0; j <= j1; j++) {
        const cz = minZ + (j + 0.5) * cell;
        for (let i = i0; i <= i1; i++) {
          const cx = minX + (i + 0.5) * cell;
          const l0 = ((z1 - z2) * (cx - x2) + (x2 - x1) * (cz - z2)) / d;
          const l1 = ((z2 - z0) * (cx - x2) + (x0 - x2) * (cz - z2)) / d;
          const l2 = 1 - l0 - l1;
          if (l0 >= -eps && l1 >= -eps && l2 >= -eps) mask[j * w + i] = 1;
        }
      }
    }
    // close 1px pinholes (dilate, then erode)
    const dil = new Uint8Array(w * h), ero = new Uint8Array(w * h);
    for (let j = 1; j < h - 1; j++) for (let i = 1; i < w - 1; i++) {
      const k = j * w + i;
      dil[k] = (mask[k] | mask[k - 1] | mask[k + 1] | mask[k - w] | mask[k + w]) ? 1 : 0;
    }
    for (let j = 1; j < h - 1; j++) for (let i = 1; i < w - 1; i++) {
      const k = j * w + i;
      ero[k] = (dil[k] & dil[k - 1] & dil[k + 1] & dil[k - w] & dil[k + w]) ? 1 : 0;
    }
    return { mask: ero, w, h, minX, minZ, cell };
  };
  const isRoad = (g, x, z) => {
    const i = Math.floor((x - g.minX) / g.cell), j = Math.floor((z - g.minZ) / g.cell);
    return i >= 0 && j >= 0 && i < g.w && j < g.h && g.mask[j * g.w + i] === 1;
  };
  RL.isRoad = isRoad;

  function scan(g, x, z, nx, nz, maxT) {
    if (!isRoad(g, x, z)) return null;
    const st = g.cell * 0.5; let a = 0, b = 0;
    while (a < maxT && isRoad(g, x + nx * (a + st), z + nz * (a + st))) a += st;
    while (b < maxT && isRoad(g, x - nx * (b + st), z - nz * (b + st))) b += st;
    return { a, b };
  }
  function snap(g, x, z, maxR) {
    if (isRoad(g, x, z)) return { x, z };
    for (let r = g.cell; r <= maxR; r += g.cell) {
      for (let k = 0; k < 24; k++) {
        const a = k / 24 * Math.PI * 2, px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r;
        if (isRoad(g, px, pz)) return { x: px, z: pz };
      }
    }
    return null;
  }
  // direction of travel at a road point = perpendicular to the shortest cross-section
  function travelDir(g, p, maxT) {
    let best = 1e9, bd = null;
    for (let k = 0; k < 18; k++) {
      const a = k / 18 * Math.PI, dx = Math.cos(a), dz = Math.sin(a);
      const s = scan(g, p.x, p.z, dx, dz, maxT); if (!s) continue;
      if (s.a + s.b < best) { best = s.a + s.b; bd = { x: dx, z: dz }; }
    }
    return bd ? { x: -bd.z, z: bd.x } : { x: 1, z: 0 };
  }

  // March along the middle of the road from `start`, return a closed loop resampled to n points
  // (index 0 = start). Returns null if no closed loop was found.
  RL.extractLine = function (g, start, dirHint, opts) {
    opts = opts || {};
    const sp = snap(g, start.x, start.z, g.cell * 400);
    if (!sp) return null;
    const bigT = Math.max(g.w, g.h) * g.cell;
    let d = dirHint ? norm2(dirHint) : travelDir(g, sp, bigT * 0.5);
    let n = { x: -d.z, z: d.x };
    let s = scan(g, sp.x, sp.z, n.x, n.z, bigT * 0.5);
    if (!s) return null;
    let p = { x: sp.x + n.x * (s.a - s.b) / 2, z: sp.z + n.z * (s.a - s.b) / 2 };
    const w0 = s.a + s.b, step = Math.max(g.cell * 2, w0 / 10), maxT = Math.max(w0 * 5, g.cell * 40);
    const p0 = { x: p.x, z: p.z }, d0 = { x: d.x, z: d.z };
    const pts = [{ x: p.x, z: p.z, hw: w0 / 2 }];
    let traveled = 0, closed = false;
    for (let it = 0; it < 20000; it++) {
      const qx = p.x + d.x * step, qz = p.z + d.z * step;
      n = { x: -d.z, z: d.x };
      let sc = scan(g, qx, qz, n.x, n.z, maxT), qx2 = qx, qz2 = qz;
      if (!sc) {
        for (const k of [1, -1, 2, -2, 3, -3, 4, -4]) {
          qx2 = qx + n.x * k * g.cell * 2; qz2 = qz + n.z * k * g.cell * 2;
          sc = scan(g, qx2, qz2, n.x, n.z, maxT); if (sc) break;
        }
        if (!sc) break;
      }
      let shift = (sc.a - sc.b) / 2; shift = Math.max(-step, Math.min(step, shift));
      const cx = qx2 + n.x * shift, cz = qz2 + n.z * shift;
      const mx = cx - p.x, mz = cz - p.z, ml = Math.hypot(mx, mz);
      if (ml < 1e-9) break;
      d = norm2({ x: 0.6 * d.x + 0.4 * mx / ml, z: 0.6 * d.z + 0.4 * mz / ml });
      p = { x: cx, z: cz }; traveled += ml;
      pts.push({ x: cx, z: cz, hw: (sc.a + sc.b) / 2 });
      if (traveled > step * 20 && Math.hypot(p.x - p0.x, p.z - p0.z) < step * 1.5 && d.x * d0.x + d.z * d0.z > 0) { closed = true; break; }
    }
    if (!closed || pts.length < 12) return null;
    pts.pop();
    // resample uniformly by arclength
    const M = pts.length, cum = [0];
    for (let i = 1; i <= M; i++) { const a = pts[i - 1], b = pts[i % M]; cum.push(cum[i - 1] + Math.hypot(b.x - a.x, b.z - a.z)); }
    const L = cum[M];
    const N = opts.n || Math.max(60, Math.round(L / (opts.spacing || 0.057)));
    const X = [], Z = [], H = [];
    let seg = 0;
    for (let k = 0; k < N; k++) {
      const sdist = L * k / N;
      while (seg < M - 1 && cum[seg + 1] < sdist) seg++;
      const a = pts[seg], b = pts[(seg + 1) % M], t = (sdist - cum[seg]) / Math.max(1e-9, cum[seg + 1] - cum[seg]);
      X.push(a.x + (b.x - a.x) * t); Z.push(a.z + (b.z - a.z) * t); H.push(a.hw + (b.hw - a.hw) * t);
    }
    const sm = arr => { for (let r = 0; r < 4; r++) { const c = arr.slice(); for (let i = 0; i < N; i++) arr[i] = (c[(i + N - 1) % N] + 2 * c[i] + c[(i + 1) % N]) / 4; } };
    // keep index 0 exactly on the start point; smooth the rest
    sm(X); sm(Z); sm(H);
    let area = 0;
    for (let i = 0; i < N; i++) { const j = (i + 1) % N; area += X[i] * Z[j] - X[j] * Z[i]; }
    return { x: X, z: Z, hw: H, L, area: area / 2 };
  };
  function norm2(v) { const l = Math.hypot(v.x, v.z) || 1; return { x: v.x / l, z: v.z / l }; }

  // reverse the loop direction but keep index 0 as the start point
  RL.reverseLine = function (ln) {
    const f = a => [a[0]].concat(a.slice(1).reverse());
    return { x: f(ln.x), z: f(ln.z), hw: f(ln.hw), L: ln.L, area: -ln.area };
  };
  RL.scaleLine = function (ln, k) {
    return { x: ln.x.map(v => v * k), z: ln.z.map(v => v * k), hw: ln.hw.map(v => v * k), L: ln.L * k, area: ln.area * k * k };
  };
  RL.median = a => { const s = a.slice().sort((p, q) => p - q); return s[Math.floor(s.length / 2)]; };

  if (typeof module !== 'undefined' && module.exports) module.exports = RL; else root.RL = RL;
})(typeof window !== 'undefined' ? window : globalThis);
