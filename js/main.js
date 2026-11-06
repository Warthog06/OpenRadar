import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { listDay, radarSites, warningsAt, basemap } from './sources.js';
import { REF_COLORS } from './volume.js';
import { openPicker } from './picker.js';

// ---------------- config ----------------
const LEVELS = {
  10: ['#4fb4ff', 0.1], 20: ['#3ddc5a', 0.16], 30: ['#1f9e3a', 0.3], 35: ['#f4e93a', 0.38],
  40: ['#e8b923', 0.36], 45: ['#ff9a1f', 0.62], 50: ['#ff3b30', 0.82], 55: ['#e0202a', 0.92],
  60: ['#c3122a', 1], 65: ['#f43cff', 1], 70: ['#b78cff', 1],
};
const DETAIL = { fast: { dxKm: 2, dzKm: 0.75 }, normal: { dxKm: 1, dzKm: 0.5 }, high: { dxKm: 0.5, dzKm: 0.3 } };
const TOP_KM = 20;
const PRESETS = [
  { label: 'Moore, OK EF5 tornado (2013-05-20)', site: 'KTLX', t: '2013-05-20T20:00:00Z' },
  { label: 'Mayfield, KY tornado (2021-12-11)', site: 'KPAH', t: '2021-12-11T03:30:00Z' },
  { label: 'Little Rock, AR tornado (2023-03-31)', site: 'KLZK', t: '2023-03-31T20:35:00Z' },
  { label: 'Elkhorn, NE tornado (2024-04-26)', site: 'KOAX', t: '2024-04-26T20:21:00Z' },
  { label: 'Barnsdall, OK tornado (2024-05-07)', site: 'KINX', t: '2024-05-07T03:10:00Z' },
];
const WARN_COLORS = { TO: '#ff3030', SV: '#ffd21f', FF: '#2bff6a', EW: '#ff8c00', SQ: '#bde8ff', MA: '#ff9ad5' };

const state = {
  site: 'KTLX', files: [], fileIdx: -1, meta: null, live: false,
  levels: new Set([20, 40, 50, 60]), exag: 3, opacity: 1,
  rangeKm: 150, detail: 'normal', ccFilter: true, extendToGround: true, smooth: true,
  groundLayer: 'REF', showWarnings: true, cutAxis: 'off', cutPos: 0,
  ground: null, warnings: [], sites: [], autoFocus: true, archiveFiles: [],
};

const $ = id => document.getElementById(id);

// ---------------- three.js scene ----------------
const canvas = $('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.localClippingEnabled = true;
const scene = new THREE.Scene();
scene.background = new THREE.Color('#0a0e13');
const camera = new THREE.PerspectiveCamera(45, 1, 0.5, 6000);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.495;
controls.minDistance = 5;
controls.maxDistance = 1500;

scene.add(new THREE.HemisphereLight(0xf2f6ff, 0x39424f, 1.9));
const sun = new THREE.DirectionalLight(0xffffff, 2.2); sun.position.set(180, 400, 220); scene.add(sun);
const fill = new THREE.DirectionalLight(0x9db4ff, 0.5); fill.position.set(-250, 120, -200); scene.add(fill);

const groundCanvas = document.createElement('canvas');
groundCanvas.width = groundCanvas.height = 2048;
const groundTex = new THREE.CanvasTexture(groundCanvas);
groundTex.colorSpace = THREE.SRGBColorSpace;
groundTex.anisotropy = renderer.capabilities.getMaxAnisotropy();
const groundMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: groundTex }));
groundMesh.rotation.x = -Math.PI / 2;
scene.add(groundMesh);

const storm = new THREE.Group();   // y-scaled by vertical exaggeration
scene.add(storm);
const meshes = new Map();           // level -> mesh
const clipPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 1e6);
const ruler = new THREE.Group();
scene.add(ruler);

function setGroundSize() {
  const R = state.rangeKm;
  groundMesh.scale.set(2 * R, 2 * R, 1);
  buildRuler();
}

function textSprite(text, color = '#cfd8e3') {
  const c = document.createElement('canvas'); c.width = 256; c.height = 64;
  const g = c.getContext('2d');
  g.font = '600 34px system-ui, sans-serif'; g.fillStyle = color; g.textBaseline = 'middle';
  g.fillText(text, 8, 32);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  s.renderOrder = 999;
  return s;
}

function buildRuler() {
  ruler.clear();
  const R = state.rangeKm, x = -R, z = R; // SW corner
  const pts = [new THREE.Vector3(x, 0, z), new THREE.Vector3(x, TOP_KM * state.exag, z)];
  for (let h = 0; h <= TOP_KM; h += 5) {
    const y = h * state.exag;
    pts.push(new THREE.Vector3(x, y, z), new THREE.Vector3(x + R * 0.03, y, z));
    if (h) {
      const s = textSprite(`${h} km`);
      const w = R * 0.11; s.scale.set(w, w / 4, 1);
      s.position.set(x + R * 0.03 + w * 0.5, y, z);
      ruler.add(s);
    }
  }
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  ruler.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x8a97a8 })));
  const n = textSprite('N', '#ffffff'); const w = R * 0.08; n.scale.set(w, w / 4, 1);
  n.position.set(w * 0.3, 1, -R - w * 0.15); ruler.add(n);
}

function applyExaggeration() {
  storm.scale.y = state.exag;
  buildRuler();
}

function applyCut() {
  const R = state.rangeKm;
  const v = state.cutPos * R;
  if (state.cutAxis === 'ns') { clipPlane.normal.set(0, 0, 1); clipPlane.constant = v; }      // keep north <= v
  else if (state.cutAxis === 'ew') { clipPlane.normal.set(-1, 0, 0); clipPlane.constant = v; } // keep east <= v
  else { clipPlane.normal.set(0, 0, 1); clipPlane.constant = 1e6; }
}

function materialFor(level) {
  const [color, op] = LEVELS[level];
  const o = Math.min(1, op * state.opacity);
  return new THREE.MeshStandardMaterial({
    color, roughness: 0.6, metalness: 0.0, emissive: color, emissiveIntensity: 0.12,
    transparent: o < 1, opacity: o, depthWrite: o >= 1,
    side: o < 1 ? THREE.FrontSide : THREE.DoubleSide,
    clippingPlanes: [clipPlane],
  });
}

function setMesh(m) {
  const old = meshes.get(m.level);
  if (old) { storm.remove(old); old.geometry.dispose(); old.material.dispose(); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(m.normals, 3));
  g.setIndex(new THREE.BufferAttribute(m.indices, 1));
  const mesh = new THREE.Mesh(g, materialFor(m.level));
  mesh.renderOrder = 100 - m.level; // inner (higher dBZ) shells first, then translucent outer shells
  mesh.visible = state.levels.has(m.level);
  storm.add(mesh);
  meshes.set(m.level, mesh);
}

// Point the camera at the most intense storm core.
function focusOn(f) {
  if (!f || !(f.dbz > 20)) return view('3d');
  controls.target.set(f.x, 3 * state.exag, f.z);
  camera.position.set(f.x + 45, 45 + 8 * state.exag, f.z + 85);
  controls.update();
}

function refreshMaterials() {
  for (const [level, mesh] of meshes) { mesh.material.dispose(); mesh.material = materialFor(level); }
}

function clearMeshes() {
  for (const mesh of meshes.values()) { storm.remove(mesh); mesh.geometry.dispose(); mesh.material.dispose(); }
  meshes.clear();
}

function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.floor(w * renderer.getPixelRatio()) || canvas.height !== Math.floor(h * renderer.getPixelRatio())) {
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
  }
}

function view(kind) {
  const R = state.rangeKm;
  controls.target.set(0, 0, 0);
  if (kind === 'top') camera.position.set(0, R * 2.6, 0.01);
  else if (kind === 'side') camera.position.set(0, R * 0.25, R * 1.9);
  else camera.position.set(R * 0.35, R * 1.25, R * 1.45);
  controls.update();
}

(function loop() {
  resize();
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(loop);
})();

// double-click the map to orbit around that spot
const ray = new THREE.Raycaster();
canvas.addEventListener('dblclick', e => {
  const r = canvas.getBoundingClientRect();
  ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
  const hit = ray.intersectObject(groundMesh)[0];
  if (!hit) return;
  const d = hit.point.clone().sub(controls.target);
  controls.target.add(d); camera.position.add(d);
});

// ---------------- ground map ----------------
function project(lon, lat) {
  const s = state.meta.site, R = state.rangeKm, S = groundCanvas.width;
  const east = (lon - s.lon) * Math.cos(s.lat * Math.PI / 180) * 111.195;
  const north = (lat - s.lat) * 111.195;
  return [(east + R) / (2 * R) * S, (R - north) / (2 * R) * S];
}

function strokeLines(ctx, geom) {
  const lines = geom.type === 'MultiLineString' ? geom.coordinates : geom.type === 'LineString' ? [geom.coordinates] : [];
  const S = groundCanvas.width, m = S * 0.3;
  ctx.beginPath();
  for (const line of lines) {
    let pen = false;
    for (const [lon, lat] of line) {
      const [x, y] = project(lon, lat);
      if (x < -m || y < -m || x > S + m || y > S + m) { pen = false; continue; }
      if (pen) ctx.lineTo(x, y); else { ctx.moveTo(x, y); pen = true; }
    }
  }
  ctx.stroke();
}

function polygonPath(ctx, geom) {
  const polys = geom.type === 'MultiPolygon' ? geom.coordinates : [geom.coordinates];
  ctx.beginPath();
  for (const poly of polys) for (const ring of poly) {
    ring.forEach(([lon, lat], i) => { const [x, y] = project(lon, lat); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.closePath();
  }
}

let mapLines = null;
const radarImg = document.createElement('canvas');
const overlay = document.createElement('canvas');
let overlayKey = '', radarKey = '', groundVersion = 0;

// County/state lines + range rings, redrawn only when the site or range changes.
function buildOverlay() {
  const S = groundCanvas.width;
  const key = `${state.meta.icao}|${state.rangeKm}|${!!mapLines}`;
  if (key === overlayKey) return;
  overlayKey = key;
  overlay.width = overlay.height = S;
  const ctx = overlay.getContext('2d');
  ctx.clearRect(0, 0, S, S);
  ctx.strokeStyle = 'rgba(255,255,255,0.10)'; ctx.lineWidth = 1.5;
  for (let r = 50; r <= state.rangeKm * 1.42; r += 50) {
    ctx.beginPath(); ctx.arc(S / 2, S / 2, r / (2 * state.rangeKm) * S, 0, Math.PI * 2); ctx.stroke();
  }
  if (mapLines) {
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(150,165,185,0.30)'; ctx.lineWidth = 1.2; strokeLines(ctx, mapLines.counties);
    ctx.strokeStyle = 'rgba(215,225,240,0.75)'; ctx.lineWidth = 2.6; strokeLines(ctx, mapLines.states); strokeLines(ctx, mapLines.nation);
  }
}

function drawGround() {
  const ctx = groundCanvas.getContext('2d');
  const S = groundCanvas.width;
  ctx.fillStyle = '#121821'; ctx.fillRect(0, 0, S, S);
  if (!state.meta) { groundTex.needsUpdate = true; return; }
  let src = null;
  if (state.groundLayer !== 'off') {
    if (loop.playing && loop.bitmaps.length) src = loop.bitmaps[loop.i];
    else if (state.ground) {
      const g = state.ground, key = `${groundVersion}|${state.groundLayer}`;
      if (key !== radarKey) {
        radarKey = key;
        radarImg.width = radarImg.height = g.size;
        radarImg.getContext('2d').putImageData(new ImageData(state.groundLayer === 'VEL' ? g.vel : g.ref, g.size, g.size), 0, 0);
      }
      src = radarImg;
    }
  }
  if (src) { ctx.imageSmoothingEnabled = false; ctx.drawImage(src, 0, 0, S, S); }
  buildOverlay();
  ctx.drawImage(overlay, 0, 0);
  if (state.showWarnings) {
    for (const w of state.warnings) {
      const col = w.emergency ? '#ff00ff' : WARN_COLORS[w.phenomena] || '#ffffff';
      polygonPath(ctx, w.geometry);
      ctx.fillStyle = col + '1a'; ctx.fill();
      ctx.strokeStyle = '#000'; ctx.lineWidth = 7; ctx.stroke();
      ctx.strokeStyle = col; ctx.lineWidth = 4; ctx.stroke();
    }
  }
  // radar site marker
  ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(S / 2, S / 2, 7, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#0a0e13'; ctx.beginPath(); ctx.arc(S / 2, S / 2, 3, 0, Math.PI * 2); ctx.fill();
  groundTex.needsUpdate = true;
}

basemap().then(b => { mapLines = b; drawGround(); }).catch(() => setNote('Map outlines unavailable (offline?)'));

// ---------------- worker ----------------
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
let reqId = 0, latestBuild = 0, busy = false, pendingBuild = false;
let quietBuild = false; // live tilt updates rebuild in the background without the progress toast
const loop = { playing: false, bitmaps: [], times: [], i: 0, timer: null, reqId: 0 };

worker.onmessage = ev => {
  const m = ev.data;
  if (m.type === 'progress') { if (!quietBuild) showProgress(m.stage, m.frac); return; }
  if (m.type === 'progress-done') { if (!busy) hideProgress(); return; }
  if (m.type === 'note') return setNote(m.message);
  if (m.type === 'live-status') return updateLiveStatus(m);
  if (m.type === 'loop') return receiveLoop(m);
  if (m.type === 'error') { busy = false; quietBuild = false; hideProgress(); return setNote(`Error: ${m.message}`, true); }
  if (m.type === 'loaded') {
    if (m.meta.mode === 'live' && !state.live) return; // stale message after leaving live mode
    state.meta = m.meta;
    updateStamp();
    const background = m.meta.mode === 'live' && meshes.size > 0;
    if (busy) pendingBuild = true; else { requestBuild(true); quietBuild = background; }
    maybeWarnings();
    if (loop.playing) requestLoop();
    return;
  }
  if (m.type === 'built' || m.type === 'iso') {
    if (m.id < latestBuild) return;
    if (m.type === 'built') {
      clearMeshes();
      if (m.ground) { state.ground = m.ground; groundVersion++; setGroundSize(); drawGround(); }
      $('tilts').textContent = `${m.tilts.length} tilts: ${m.tilts.join('°, ')}°`;
    }
    for (const mesh of m.meshes) setMesh(mesh);
    if (m.type === 'built' && state.autoFocus) { state.autoFocus = false; focusOn(m.focus); }
    busy = false;
    quietBuild = false;
    hideProgress();
    if (pendingBuild) { pendingBuild = false; quietBuild = state.live; requestBuild(true); }
    const tris = [...meshes.values()].reduce((a, x) => a + (x.geometry.index ? x.geometry.index.count / 3 : 0), 0);
    setNote(tris ? `${(tris / 1000).toFixed(0)}k triangles` : 'No echoes at the selected levels in this volume.');
  }
};

function gridOpts() {
  const d = DETAIL[state.detail];
  let dxKm = d.dxKm;
  const maxCells = 14e6;
  while (Math.pow(2 * state.rangeKm / dxKm, 2) * (TOP_KM / d.dzKm) > maxCells) dxKm *= 1.25;
  return { rangeKm: state.rangeKm, dxKm, dzKm: d.dzKm, topKm: TOP_KM, ccFilter: state.ccFilter, extendToGround: state.extendToGround, smooth: state.smooth };
}

function requestBuild(withGround) {
  if (!state.meta) return;
  latestBuild = ++reqId;
  busy = true;
  worker.postMessage({ type: 'build', id: reqId, opts: gridOpts(), levels: [...state.levels], ground: withGround, groundSize: 1536 });
}

function requestLevel(level) {
  if (!state.meta || meshes.has(level)) return;
  worker.postMessage({ type: 'iso', id: latestBuild, levels: [level] });
}

// ---------------- data flow ----------------
let warnFor = 0;
function maybeWarnings() {
  if (state.meta && Math.abs(state.meta.lowTime - warnFor) > 120000) loadWarnings();
}
async function loadWarnings() {
  state.warnings = [];
  if (!state.showWarnings || !state.meta) return drawGround();
  const t = state.meta.lowTime || state.meta.time;
  warnFor = t;
  try { state.warnings = await warningsAt(t); } catch { setNote('Warnings unavailable'); }
  drawGround();
}

function loadFile(idx) {
  const f = state.files[idx];
  if (!f) return;
  state.fileIdx = idx;
  $('fileTime').textContent = fmtTime(f.time);
  const iso = new Date(f.time).toISOString();
  $('date').value = iso.slice(0, 10); $('time').value = iso.slice(11, 16);
  updateHash(f);
  worker.postMessage({ type: 'load', url: f.url });
}

const DAY = 86400000;

// Live mode streams real-time chunks: each tilt appears as soon as the radar finishes it.
function loadLatest() {
  setNote('');
  state.autoFocus = true;
  state.files = []; state.fileIdx = -1; state.archiveFiles = [];
  stopLoop();
  showProgress('Finding the live scan', 0);
  $('fileTime').textContent = 'Live';
  $('scan').textContent = '';
  history.replaceState(null, '', `#site=${state.site}&live=1`);
  worker.postMessage({ type: 'live-start', site: state.site });
  // archive listing: used for stepping back in time and for loop frames
  const site = state.site;
  listDay(site, new Date())
    .then(f => f.length ? f : listDay(site, new Date(Date.now() - DAY)))
    .then(f => { if (state.live && state.site === site) state.archiveFiles = f; })
    .catch(() => {});
}

async function loadAt(timeMs) {
  setNote('');
  state.autoFocus = true;
  showProgress('Finding scan', 0);
  try {
    const d = new Date(timeMs);
    let files = await listDay(state.site, d);
    if (!files.length) throw new Error(`No data for ${state.site} on ${d.toISOString().slice(0, 10)}`);
    state.files = files;
    let best = 0;
    files.forEach((f, i) => { if (Math.abs(f.time - timeMs) < Math.abs(files[best].time - timeMs)) best = i; });
    loadFile(best);
  } catch (e) { hideProgress(); setNote(e.message, true); }
}

async function step(dir) {
  if (state.live || !state.files.length) {
    if (dir > 0) return setNote('Already showing the live scan.');
    setLive(false);
    try {
      let files = state.archiveFiles && state.archiveFiles.length ? state.archiveFiles : await listDay(state.site, new Date());
      if (!files.length) files = await listDay(state.site, new Date(Date.now() - DAY));
      if (!files.length) return;
      state.files = files;
      return loadFile(files.length - 1);
    } catch (e) { return setNote(e.message, true); }
  }
  let i = state.fileIdx + dir;
  try {
    if (i < 0) {
      const prev = await listDay(state.site, new Date(state.files[0].time - DAY));
      if (!prev.length) return;
      state.files = prev.concat(state.files); i = prev.length - 1;
    } else if (i >= state.files.length) {
      const next = await listDay(state.site, new Date(state.files[state.files.length - 1].time + DAY));
      if (!next.length) return setNote('This is the newest scan.');
      state.files = state.files.concat(next);
    }
    loadFile(i);
  } catch (e) { setNote(e.message, true); }
}

// ---------------- low-level loop ----------------
function loopUrls() {
  const files = state.live ? (state.archiveFiles || []) : state.files.slice(0, state.fileIdx + 1);
  const ref = state.meta ? state.meta.lowTime : Date.now();
  return files.filter(f => f.time < ref + 60000 && f.time > ref - 40 * 60000).slice(-4).map(f => f.url);
}
function requestLoop() {
  if (!state.meta) return;
  loop.reqId++;
  worker.postMessage({ type: 'loop', id: loop.reqId, urls: loopUrls(), layer: state.groundLayer === 'VEL' ? 'VEL' : 'REF', rangeKm: state.rangeKm, size: 1024 });
}
async function receiveLoop(m) {
  if (m.id !== loop.reqId || !loop.playing) return;
  if (!busy) hideProgress();
  const bitmaps = await Promise.all(m.frames.map(f => createImageBitmap(new ImageData(f.img, m.size, m.size))));
  if (m.id !== loop.reqId || !loop.playing) return bitmaps.forEach(b => b.close());
  loop.bitmaps.forEach(b => b.close());
  loop.bitmaps = bitmaps;
  loop.times = m.frames.map(f => f.time);
  loop.i = Math.max(0, bitmaps.length - 1);
  if (bitmaps.length < 2) setNote('Only one low-level scan so far: the loop will grow as scans arrive.');
  loopTick();
}
function loopTick() {
  clearTimeout(loop.timer);
  if (!loop.playing) return;
  drawGround();
  const n = loop.bitmaps.length;
  $('loopInfo').textContent = n ? `Frame ${loop.i + 1}/${n} · ${fmtTime(loop.times[loop.i]).slice(11)}` : 'Loading…';
  if (n < 2) return;
  const last = loop.i === n - 1;
  loop.timer = setTimeout(() => { loop.i = (loop.i + 1) % n; loopTick(); }, last ? 1600 : 550);
}
function startLoop() {
  if (state.groundLayer === 'off') { state.groundLayer = 'REF'; syncGroundButtons(); }
  loop.playing = true;
  $('loop').setAttribute('aria-pressed', 'true'); $('loop').textContent = 'Stop loop';
  $('loopInfo').textContent = 'Loading…';
  showProgress('Loading loop frames', 0);
  requestLoop();
}
function stopLoop() {
  loop.playing = false; loop.reqId++;
  clearTimeout(loop.timer);
  loop.bitmaps.forEach(b => b.close()); loop.bitmaps = []; loop.times = [];
  $('loop').setAttribute('aria-pressed', 'false'); $('loop').textContent = 'Play low-level loop';
  $('loopInfo').textContent = '';
  drawGround();
}

// ---------------- UI ----------------
function fmtTime(t) { return new Date(t).toISOString().replace('T', ' ').slice(0, 19) + ' UTC'; }

function updateStamp() {
  const m = state.meta;
  if (!m) return;
  const site = state.sites.find(s => s.id === m.icao);
  const t = m.lowTime || m.time;
  $('stamp').textContent = `${m.icao}${site ? ' · ' + site.name : ''} · ${fmtTime(t)} · VCP ${m.vcp ?? '?'}`;
  const age = Math.max(0, Date.now() - t);
  const isLive = m.mode === 'live' && state.live;
  $('age').textContent = isLive ? `LIVE · ${age < 90000 ? Math.round(age / 1000) + ' s' : Math.round(age / 60000) + ' min'} old`
    : age < 3 * 3600e3 ? `${Math.round(age / 60000)} min old` : 'archive';
  $('age').classList.toggle('live', isLive);
  if (!isLive) $('scan').textContent = '';
}
setInterval(updateStamp, 5000);

function updateLiveStatus(m) {
  if (!state.live) return;
  const cuts = m.nCuts ? `cut ${Math.min(m.cutsDone + (m.scanning != null ? 1 : 0), m.nCuts)}/${m.nCuts}` : `${m.cutsDone} cuts done`;
  $('scan').textContent = m.ended ? 'Volume complete · waiting for the next one'
    : m.scanning != null ? `Scanning ${m.scanning}° ${m.sweepFrac != null ? Math.round(m.sweepFrac * 100) + '%' : ''} · ${cuts}` : cuts;
}

function updateHash(f) {
  history.replaceState(null, '', `#site=${state.site}&t=${new Date(f.time).toISOString().slice(0, 16)}Z${state.live ? '&live=1' : ''}`);
}

function showProgress(stage, frac) {
  $('status').hidden = false;
  $('statusText').textContent = stage + (frac ? ` ${Math.round(frac * 100)}%` : '…');
  $('statusBar').style.width = `${Math.round((frac || 0) * 100)}%`;
}
function hideProgress() { $('status').hidden = true; }
function setNote(text, isError = false) { const n = $('note'); n.textContent = text; n.classList.toggle('error', isError); }

function buildLevelChips() {
  const box = $('levels');
  for (const lv of Object.keys(LEVELS).map(Number)) {
    const lab = document.createElement('label');
    lab.className = 'chip';
    lab.style.setProperty('--c', LEVELS[lv][0]);
    lab.innerHTML = `<input type="checkbox" ${state.levels.has(lv) ? 'checked' : ''}><span>${lv}</span>`;
    lab.querySelector('input').addEventListener('change', e => {
      if (e.target.checked) { state.levels.add(lv); if (meshes.has(lv)) meshes.get(lv).visible = true; else requestLevel(lv); }
      else { state.levels.delete(lv); if (meshes.has(lv)) meshes.get(lv).visible = false; }
    });
    box.appendChild(lab);
  }
}

function buildLegend() {
  const bar = $('legend');
  bar.innerHTML = REF_COLORS.map(([t, c]) => `<span style="background:rgb(${c})" title="${t} dBZ"></span>`).join('');
  $('legendTicks').innerHTML = REF_COLORS.filter((_, i) => i % 2 === 1).map(([t]) => `<span>${t}</span>`).join('');
}

function setLive(on) {
  if (!on && state.live) worker.postMessage({ type: 'live-stop' });
  state.live = on;
  $('live').classList.toggle('on', on);
  $('live').setAttribute('aria-pressed', on);
}

async function initSites() {
  state.sites = await radarSites();
  const sel = $('site');
  sel.innerHTML = state.sites.map(s => `<option value="${s.id}">${s.id} — ${s.name}</option>`).join('');
  if (!state.sites.find(s => s.id === state.site)) sel.insertAdjacentHTML('afterbegin', `<option value="${state.site}">${state.site}</option>`);
  sel.value = state.site;
  if (state.meta) updateStamp();
}

function syncGroundButtons() {
  document.querySelectorAll('[data-ground]').forEach(x => x.setAttribute('aria-pressed', x.dataset.ground === state.groundLayer));
}

function bind() {
  $('site').addEventListener('change', e => { state.site = e.target.value; state.live ? loadLatest() : setNote('Press “Live” or pick a time to load this radar.'); });
  $('live').addEventListener('click', () => { setLive(true); loadLatest(); });
  $('openPicker').addEventListener('click', () => {
    document.body.classList.remove('panel-open');
    openPicker({
      sites: state.sites, current: state.site,
      timeMs: state.live || !state.meta ? Date.now() : state.meta.lowTime,
      onPick: id => {
        state.site = id; $('site').value = id;
        // live stays live; when browsing history, jump to the same moment on the new radar
        if (state.live || !state.meta) { setLive(true); loadLatest(); }
        else loadAt(state.meta.lowTime);
      },
    });
  });
  $('pickerClose').addEventListener('click', () => $('picker').close());
  $('picker').addEventListener('click', e => { if (e.target === $('picker')) $('picker').close(); });
  $('go').addEventListener('click', () => {
    const d = $('date').value, t = $('time').value || '00:00';
    if (!d) return setNote('Pick a date first.', true);
    setLive(false); loadAt(Date.parse(`${d}T${t}:00Z`));
  });
  $('preset').addEventListener('change', e => {
    const p = PRESETS[+e.target.value];
    if (!p) return;
    setLive(false); state.site = p.site; $('site').value = p.site;
    $('date').value = p.t.slice(0, 10); $('time').value = p.t.slice(11, 16);
    loadAt(Date.parse(p.t));
  });
  $('prev').addEventListener('click', () => { setLive(false); step(-1); });
  $('next').addEventListener('click', () => step(1));
  $('nearest').addEventListener('click', () => {
    if (!navigator.geolocation) return setNote('Location not available', true);
    navigator.geolocation.getCurrentPosition(pos => {
      const { latitude: la, longitude: lo } = pos.coords;
      let best = null, bd = Infinity;
      for (const s of state.sites) { const d = (s.lat - la) ** 2 + ((s.lon - lo) * Math.cos(la * Math.PI / 180)) ** 2; if (d < bd) { bd = d; best = s; } }
      if (best) { state.site = best.id; $('site').value = best.id; setLive(true); loadLatest(); }
    }, () => setNote('Location permission denied', true));
  });

  $('exag').addEventListener('input', e => { state.exag = +e.target.value; $('exagVal').textContent = `${state.exag}×`; applyExaggeration(); });
  $('opacity').addEventListener('input', e => { state.opacity = +e.target.value; refreshMaterials(); });
  $('cutAxis').addEventListener('change', e => { state.cutAxis = e.target.value; $('cutPos').disabled = state.cutAxis === 'off'; applyCut(); });
  $('cutPos').addEventListener('input', e => { state.cutPos = +e.target.value; applyCut(); });

  for (const b of document.querySelectorAll('[data-ground]')) b.addEventListener('click', () => {
    state.groundLayer = b.dataset.ground;
    syncGroundButtons();
    if (loop.playing) { if (state.groundLayer === 'off') stopLoop(); else { loop.bitmaps = []; requestLoop(); } }
    drawGround();
  });
  $('loop').addEventListener('click', () => (loop.playing ? stopLoop() : startLoop()));
  $('warn').addEventListener('change', e => { state.showWarnings = e.target.checked; loadWarnings(); });

  $('range').addEventListener('change', e => { state.rangeKm = +e.target.value; requestBuild(true); view('3d'); if (loop.playing) requestLoop(); });
  $('detail').addEventListener('change', e => { state.detail = e.target.value; requestBuild(false); });
  $('cc').addEventListener('change', e => { state.ccFilter = e.target.checked; requestBuild(false); });
  $('extend').addEventListener('change', e => { state.extendToGround = e.target.checked; requestBuild(false); });
  $('smooth').addEventListener('change', e => { state.smooth = e.target.checked; requestBuild(false); });

  for (const b of document.querySelectorAll('[data-view]')) b.addEventListener('click', () => view(b.dataset.view));
  $('togglePanel').addEventListener('click', () => {
    const open = document.body.classList.toggle('panel-open');
    $('togglePanel').setAttribute('aria-expanded', open);
  });
}

// ---------------- start ----------------
buildLevelChips();
buildLegend();
$('preset').innerHTML = '<option value="">Historical cases…</option>' + PRESETS.map((p, i) => `<option value="${i}">${p.label}</option>`).join('');
bind();
setGroundSize();
view('3d');
drawGround();
initSites();

const hash = new URLSearchParams(location.hash.slice(1));
if (hash.get('site')) { state.site = hash.get('site').toUpperCase(); }
if (hash.get('live') || (hash.get('site') && !hash.get('t'))) { setLive(true); loadLatest(); }
else if (hash.get('t')) { loadAt(Date.parse(hash.get('t'))); }
else { const p = PRESETS[0]; state.site = p.site; $('date').value = p.t.slice(0, 10); $('time').value = p.t.slice(11, 16); loadAt(Date.parse(p.t)); }
$('site').value = state.site;
