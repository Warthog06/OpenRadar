// Turns decoded radar sweeps into a 3D Cartesian grid and extracts isosurfaces.
import { sampleSweep } from './level2.js';

const RE = 6371 * 4 / 3;          // effective earth radius (km), standard 4/3 refraction model
const DEG = 180 / Math.PI;
export const EMPTY = -30;          // "no echo" fill value in dBZ

// Newest complete sweep in a group that has `moment`; for REF prefer the long-range
// surveillance cut of split cuts (most gates), so Doppler-cut REF never wins.
function newestOf(group, moment) {
  const withM = group.filter(s => s.moments[moment]);
  if (!withM.length) return null;
  const maxG = Math.max(...withM.map(s => s.moments[moment].ngates));
  const good = moment === 'REF' ? withM.filter(s => s.moments[moment].ngates >= 0.95 * maxG) : withM;
  return good.reduce((a, b) => (b.time > a.time ? b : a));
}

// Complete sweeps clustered by elevation angle, lowest first. Clustering (not rounding) because
// the lowest tilt drifts a little between volumes (e.g. 0.44 vs 0.48 deg) with AVSET/SAILS.
function completeGroups(vol) {
  const sw = vol.sweeps.filter(s => s.complete).sort((a, b) => a.angle - b.angle);
  const groups = [];
  let g = null;
  for (const s of sw) {
    if (!g || s.angle - g.base > 0.25) { g = { base: s.angle, list: [] }; groups.push(g); }
    g.list.push(s);
  }
  return groups.map(x => x.list);
}

// One sweep per distinct elevation angle: the newest complete one (SAILS / rolling live updates).
export function selectTilts(vol, moment = 'REF') {
  const tilts = [];
  for (const group of completeGroups(vol)) {
    const sw = newestOf(group, moment);
    if (!sw) continue;
    const rhoSweep = sw.moments.RHO ? sw : newestOf(group, 'RHO');
    tilts.push({ angle: sw.angle, m: sw.moments[moment], sweep: sw, rho: rhoSweep ? rhoSweep.moments.RHO : null });
  }
  return tilts.sort((a, b) => a.angle - b.angle);
}

// Most recent complete sweep at the lowest angle that has `moment`.
export function lowestSweep(vol, moment) {
  for (const group of completeGroups(vol)) {
    const sw = newestOf(group, moment);
    if (sw) return sw;
  }
  return null;
}

// Every complete lowest-angle scan in a volume as a loop frame (SAILS gives up to 4 per volume).
export function lowFrames(vol) {
  const lowest = completeGroups(vol).find(g => g.some(s => s.moments.REF));
  if (!lowest) return [];
  const group = lowest.sort((a, b) => a.time - b.time);
  const maxG = Math.max(...group.filter(s => s.moments.REF).map(s => s.moments.REF.ngates));
  const frames = [];
  for (const s of group) {
    if (!s.moments.REF || s.moments.REF.ngates < 0.95 * maxG) continue;
    // pair with the Doppler cut that follows (or the sweep itself if it carries velocity)
    const velSweep = s.moments.VEL ? s : group.find(v => v.moments.VEL && v.time >= s.time && v.time - s.time < 180000);
    frames.push({ time: s.time, angle: s.angle, icao: vol.icao, ref: s.moments.REF, vel: velSweep ? velSweep.moments.VEL : null, velAngle: velSweep ? velSweep.angle : s.angle });
  }
  return frames;
}

/**
 * Build a padded 3D grid of reflectivity.
 * opts: rangeKm, dxKm, dzKm, topKm, ccFilter, extendToGround, smooth
 * Layout: idx = (k*ny + j)*nx + i ; i = east, j = north, k = up. One empty cell of padding all round.
 */
export function buildGrid(vol, opts) {
  const tilts = selectTilts(vol, 'REF');
  if (!tilts.length) throw new Error('No reflectivity in this volume');
  const { rangeKm, dxKm, dzKm, topKm, ccFilter, extendToGround, smooth } = opts;
  const n = Math.round(2 * rangeKm / dxKm);
  const nzIn = Math.round(topKm / dzKm) + 1;
  const nx = n + 2, ny = n + 2, nz = nzIn + 2;
  const field = new Float32Array(nx * ny * nz).fill(EMPTY);
  const angles = tilts.map(t => t.angle);
  const nt = tilts.length;
  const HALF_BEAM = 0.5;

  const val = (t, az, r) => {
    const tl = tilts[t];
    let v = sampleSweep(tl.m, az, r);
    if (!(v > EMPTY)) return NaN;              // NaN or range folded
    if (ccFilter && tl.rho && v < 45) {
      const cc = sampleSweep(tl.rho, az, r);
      if (cc > 0 && cc < 0.8) return NaN;      // likely birds/insects/clutter/chaff
    }
    return v;
  };

  for (let j = 1; j < ny - 1; j++) {
    const y = -rangeKm + (j - 0.5) * dxKm;
    for (let i = 1; i < nx - 1; i++) {
      const x = -rangeKm + (i - 0.5) * dxKm;
      const s = Math.hypot(x, y);
      const az = (Math.atan2(x, y) * DEG + 360) % 360;
      const th = s / RE, sinT = Math.sin(th), cosT = Math.cos(th);
      let lo = 0;
      for (let k = 1; k < nz - 1; k++) {
        const h = (k - 1) * dzKm;
        const R = RE + h;
        const px = R * sinT, py = R * cosT - RE;
        const r = Math.hypot(px, py);
        const e = Math.atan2(py, px) * DEG;
        let v = NaN;
        if (e < angles[0]) {
          if (extendToGround || angles[0] - e <= HALF_BEAM) v = val(0, az, r);
        } else if (e >= angles[nt - 1]) {
          if (e - angles[nt - 1] <= HALF_BEAM) v = val(nt - 1, az, r);
          else break; // above the top beam: everything higher is empty too
        } else {
          while (lo < nt - 2 && angles[lo + 1] <= e) lo++;
          const v0 = val(lo, az, r), v1 = val(lo + 1, az, r);
          if (v0 === v0 || v1 === v1) {
            const w = (e - angles[lo]) / (angles[lo + 1] - angles[lo]);
            v = (v0 === v0 ? v0 : EMPTY) * (1 - w) + (v1 === v1 ? v1 : EMPTY) * w;
          }
        }
        if (v === v) field[(k * ny + j) * nx + i] = v;
      }
    }
  }
  if (smooth) smooth121(field, nx, ny, nz);
  // strongest core aloft (>= 2 km): good default camera target
  let best = -Infinity, bi = nx >> 1, bj = ny >> 1;
  const k0 = Math.max(1, Math.round(2 / dzKm) + 1);
  for (let k = k0; k < nz - 1; k++) for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
    const v = field[(k * ny + j) * nx + i];
    if (v > best) { best = v; bi = i; bj = j; }
  }
  return {
    focus: { x: -rangeKm + (bi - 0.5) * dxKm, z: -(-rangeKm + (bj - 0.5) * dxKm), dbz: best },
    field, nx, ny, nz, dxKm, dzKm,
    // world coordinates (km) of sample index 0 on each axis
    x0: -rangeKm - 0.5 * dxKm, y0: -rangeKm - 0.5 * dxKm, z0: -dzKm,
    tilts: tilts.map(t => +t.angle.toFixed(2)),
  };
}

function smooth121(f, nx, ny, nz) {
  const tmp = new Float32Array(f.length);
  const pass = (src, dst, stride, len, count) => {
    dst.set(src);
    for (let idx = 0; idx < src.length; idx++) {
      const c = Math.floor(idx / stride) % len;
      if (c === 0 || c === len - 1) continue;
      dst[idx] = (src[idx - stride] + 4 * src[idx] + src[idx + stride]) / 6;
    }
  };
  pass(f, tmp, 1, nx);
  pass(tmp, f, nx, ny);
  pass(f, tmp, nx * ny, nz);
  f.set(tmp);
  // keep padding empty so every surface closes
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++)
    if (i === 0 || j === 0 || k === 0 || i === nx - 1 || j === ny - 1 || k === nz - 1) f[(k * ny + j) * nx + i] = EMPTY;
}

/**
 * Naive surface nets isosurface. Returns world-space (km) geometry in three.js axes:
 * X = east, Y = up, Z = -north. Normals are from the field gradient.
 */
export function isosurface(grid, iso) {
  const { field, nx, ny, nz, dxKm, dzKm, x0, y0, z0 } = grid;
  const sxy = nx * ny;
  const cellIdx = new Int32Array(nx * ny * nz).fill(-1);
  let pos = new Float32Array(1 << 16), nor = new Float32Array(1 << 16);
  let nv = 0;
  const corner = new Float32Array(8);
  const EDGES = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  const CO = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];

  for (let k = 0; k < nz - 1; k++) for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const base = (k * ny + j) * nx + i;
    let mask = 0;
    for (let c = 0; c < 8; c++) {
      const v = field[base + CO[c][0] + CO[c][1] * nx + CO[c][2] * sxy];
      corner[c] = v;
      if (v > iso) mask |= 1 << c;
    }
    if (mask === 0 || mask === 255) continue;
    let ax = 0, ay = 0, az = 0, cnt = 0;
    for (const [a, b] of EDGES) {
      const ia = (mask >> a) & 1, ib = (mask >> b) & 1;
      if (ia === ib) continue;
      const t = (iso - corner[a]) / (corner[b] - corner[a]);
      ax += CO[a][0] + (CO[b][0] - CO[a][0]) * t;
      ay += CO[a][1] + (CO[b][1] - CO[a][1]) * t;
      az += CO[a][2] + (CO[b][2] - CO[a][2]) * t;
      cnt++;
    }
    ax /= cnt; ay /= cnt; az /= cnt;
    // gradient (per km) from cell corners
    const gx = ((corner[1] - corner[0]) + (corner[3] - corner[2]) + (corner[5] - corner[4]) + (corner[7] - corner[6])) / (4 * dxKm);
    const gy = ((corner[2] - corner[0]) + (corner[3] - corner[1]) + (corner[6] - corner[4]) + (corner[7] - corner[5])) / (4 * dxKm);
    const gz = ((corner[4] - corner[0]) + (corner[5] - corner[1]) + (corner[6] - corner[2]) + (corner[7] - corner[3])) / (4 * dzKm);
    if (nv * 3 + 3 > pos.length) { pos = grow(pos); nor = grow(nor); }
    const o = nv * 3;
    pos[o] = x0 + (i + ax) * dxKm;
    pos[o + 1] = z0 + (k + az) * dzKm;
    pos[o + 2] = -(y0 + (j + ay) * dxKm);
    // outward normal = -gradient, mapped to (east, up, -north)
    let nX = -gx, nY = -gz, nZ = gy;
    const l = Math.hypot(nX, nY, nZ) || 1;
    nor[o] = nX / l; nor[o + 1] = nY / l; nor[o + 2] = nZ / l;
    cellIdx[base] = nv++;
  }

  let idx = new Uint32Array(1 << 16), ni = 0;
  const quad = (a, b, c, d, flip) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (ni + 6 > idx.length) idx = grow(idx);
    if (!flip) { idx[ni++] = a; idx[ni++] = b; idx[ni++] = c; idx[ni++] = a; idx[ni++] = c; idx[ni++] = d; }
    else { idx[ni++] = a; idx[ni++] = c; idx[ni++] = b; idx[ni++] = a; idx[ni++] = d; idx[ni++] = c; }
  };
  const C = (i, j, k) => cellIdx[(k * ny + j) * nx + i];
  for (let k = 1; k < nz - 1; k++) for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
    const p = (k * ny + j) * nx + i;
    const inside = field[p] > iso;
    if (inside !== (field[p + 1] > iso))   // x edge
      quad(C(i, j - 1, k - 1), C(i, j, k - 1), C(i, j, k), C(i, j - 1, k), !inside);
    if (inside !== (field[p + nx] > iso))  // y edge
      quad(C(i - 1, j, k - 1), C(i - 1, j, k), C(i, j, k), C(i, j, k - 1), !inside);
    if (inside !== (field[p + sxy] > iso)) // z edge
      quad(C(i - 1, j - 1, k), C(i, j - 1, k), C(i, j, k), C(i - 1, j, k), !inside);
  }
  return { positions: pos.slice(0, nv * 3), normals: nor.slice(0, nv * 3), indices: idx.slice(0, ni) };
}

function grow(a) { const b = new a.constructor(a.length * 2); b.set(a); return b; }

// ---------- 2D ground layer (lowest tilt, projected to the ground) ----------

const REF_STOPS = [
  [5, [4, 233, 231]], [10, [1, 159, 244]], [15, [3, 0, 244]], [20, [2, 253, 2]], [25, [1, 197, 1]],
  [30, [0, 142, 0]], [35, [253, 248, 2]], [40, [229, 188, 0]], [45, [253, 149, 0]], [50, [253, 0, 0]],
  [55, [212, 0, 0]], [60, [188, 0, 0]], [65, [248, 0, 253]], [70, [152, 84, 198]], [75, [253, 253, 253]],
];
export function refColor(dbz) {
  if (!(dbz >= 5)) return null;
  let c = REF_STOPS[0][1];
  for (const [t, col] of REF_STOPS) if (dbz >= t) c = col;
  return c;
}
export const REF_COLORS = REF_STOPS;

function velColor(v) { // m/s, negative = toward radar
  if (v === -Infinity) return [119, 0, 125]; // range folded
  if (!(v === v)) return null;
  const a = Math.min(Math.abs(v) / 40, 1);
  if (Math.abs(v) < 1) return [120, 120, 120];
  if (v < 0) return [Math.round(10 + 40 * (1 - a)), Math.round(90 + 165 * a), Math.round(20 + 60 * (1 - a))];
  return [Math.round(110 + 145 * a), Math.round(20 * (1 - a)), Math.round(30 * (1 - a))];
}

export function sweepImage(ms, angle, moment, rangeKm, size) {
  const img = new Uint8ClampedArray(size * size * 4);
  if (!ms) return img;
  const cosE = Math.cos(angle / DEG);
  const kmPerPx = 2 * rangeKm / size;
  for (let py = 0; py < size; py++) {
    const north = rangeKm - (py + 0.5) * kmPerPx;
    for (let px = 0; px < size; px++) {
      const east = -rangeKm + (px + 0.5) * kmPerPx;
      const s = Math.hypot(east, north);
      const az = (Math.atan2(east, north) * DEG + 360) % 360;
      const v = sampleSweep(ms, az, s / cosE);
      const c = moment === 'REF' ? refColor(v) : velColor(v);
      if (!c) continue;
      const o = (py * size + px) * 4;
      img[o] = c[0]; img[o + 1] = c[1]; img[o + 2] = c[2]; img[o + 3] = 235;
    }
  }
  return img;
}

export function groundImage(vol, moment, rangeKm, size) {
  const sw = lowestSweep(vol, moment);
  if (!sw) return { img: new Uint8ClampedArray(size * size * 4), angle: null, time: null };
  return { img: sweepImage(sw.moments[moment], sw.angle, moment, rangeKm, size), angle: sw.angle, time: sw.time };
}
