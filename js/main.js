import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { listDay, radarSites, warningsAt, basemap, warningText, pointInGeometry, geometryCenter } from './sources.js';
import { REF_COLORS } from './volume.js';
import { openPicker } from './picker.js';
import { renderBasemap, renderTiles, mosaicSource, BASEMAPS } from './tiles.js';

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
const WARN_COLORS = { TO: '#ff3030', SV: '#ffd21f', FF: '#2bff6a', EW: '#ff8c00', SQ: '#bde8ff', MA: '#ff9ad5', FL: '#00a651', FA: '#7fdc8f' };
const warnColor = w => (w.emergency ? '#ff00ff' : WARN_COLORS[w.phenomena] || '#c0c8d2');

const state = {
  site: 'KTLX', files: [], fileIdx: -1, meta: null, live: false,
  levels: new Set([20, 40, 50, 60]), exag: 3, opacity: 1,
  rangeKm: 150, detail: 'normal', ccFilter: true, extendToGround: true, smooth: true,
  groundLayer: 'REF', showWarnings: true, cutAxis: 'off', cutPos: 0,
  ground: null, warnings: [], sites: [], autoFocus: true, archiveFiles: [],
  selectedAlert: null, pendingFocus: null, alertFilter: 'severe',
  basemap: 'osm', show3d: true, rapidMode: 'low', rapid: {}, liveStatus: null,
  split: false, wide: true,
};

const $ = id => document.getElementById(id);

// ---------------- three.js scene ----------------
const canvas = $('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.localClippingEnabled = true;
const scene = new THREE.Scene();
scene.background = new THREE.Color('#0a0e13');
const camera = new THREE.PerspectiveCamera(45, 1, 0.5, 12000);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.495;
controls.minDistance = 5;
controls.maxDistance = 4500;

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
groundMesh.renderOrder = -1;
scene.add(groundMesh);
// split view: the right/bottom pane shows velocity from its own texture
const groundCanvas2 = document.createElement('canvas');
groundCanvas2.width = groundCanvas2.height = 2048;
const groundTex2 = new THREE.CanvasTexture(groundCanvas2);
groundTex2.colorSpace = THREE.SRGBColorSpace;
groundTex2.anisotropy = groundTex.anisotropy;

// "Whole map": a much larger plane under the radar square with a wide basemap and the
// national radar mosaic, so the map and radar continue past the selected radar's range.
// Mosaic and basemap are composited into one opaque texture (two textures for split view:
// with mosaic for reflectivity, basemap only for velocity) drawn first without depth writes,
// so the radar square always wins and nothing z-fights.
const WIDE_KM = 1500;
const mkCanvas = () => { const c = document.createElement('canvas'); c.width = c.height = 2048; return c; };
const mkTex = c => { const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = groundTex.anisotropy; return t; };
const wide = { base: mkCanvas(), mosaic: mkCanvas(), comp: mkCanvas(), baseKey: '', mosaicKey: '', baseReady: false, mosaicReady: false };
wide.texComp = mkTex(wide.comp);
wide.texBase = mkTex(wide.base);
wide.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2 * WIDE_KM, 2 * WIDE_KM), new THREE.MeshBasicMaterial({ map: wide.texComp, depthWrite: false }));
wide.mesh.rotation.x = -Math.PI / 2; wide.mesh.position.y = -0.05; wide.mesh.renderOrder = -3; wide.mesh.visible = false;
scene.add(wide.mesh);
function composeWide() {
  const ctx = wide.comp.getContext('2d'), S = wide.comp.width;
  ctx.fillStyle = '#121821'; ctx.fillRect(0, 0, S, S);
  if (wide.baseReady) ctx.drawImage(wide.base, 0, 0);
  if (wide.mosaicReady) { ctx.globalAlpha = 0.85; ctx.drawImage(wide.mosaic, 0, 0); ctx.globalAlpha = 1; }
  wide.texComp.needsUpdate = true; wide.texBase.needsUpdate = true;
}

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

function toLocal(lon, lat) {
  const s = state.meta.site;
  return { east: (lon - s.lon) * Math.cos(s.lat * Math.PI / 180) * 111.195, north: (lat - s.lat) * 111.195 };
}
function focusLonLat(lon, lat) {
  const { east, north } = toLocal(lon, lat);
  if (!state.show3d) {
    controls.target.set(east, 0, -north);
    camera.position.set(east, 160, -north + 0.01);
  } else {
    controls.target.set(east, 3 * state.exag, -north);
    camera.position.set(east + 45, 45 + 8 * state.exag, -north + 85);
  }
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
  }
  const vertical = state.split && h > w; // phones in portrait: stack the panes
  const aspect = !state.split ? w / h : vertical ? w / (h / 2) : (w / 2) / h;
  if (Math.abs(camera.aspect - aspect) > 1e-6) { camera.aspect = aspect; camera.updateProjectionMatrix(); }
  $('splitUI').classList.toggle('vertical', vertical);
}

// Split view panes in CSS pixels: [x, y-from-bottom, w, h]
function panes() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!state.split) return [[0, 0, w, h]];
  return h > w ? [[0, h / 2, w, h / 2], [0, 0, w, h / 2]] : [[0, 0, w / 2, h], [w / 2, 0, w / 2, h]];
}

function view(kind) {
  const R = state.rangeKm;
  controls.target.set(0, 0, 0);
  if (kind === 'top') camera.position.set(0, R * 2.6, 0.01);
  else if (kind === 'side') camera.position.set(0, R * 0.25, R * 1.9);
  else camera.position.set(R * 0.35, R * 1.25, R * 1.45);
  controls.update();
}

(function frame() {
  resize();
  controls.update();
  const ps = panes();
  if (ps.length === 1) {
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, canvas.clientWidth, canvas.clientHeight);
    groundMesh.material.map = groundTex;
    renderer.render(scene, camera);
  } else {
    renderer.setScissorTest(true);
    ps.forEach((p, i) => {
      renderer.setViewport(...p); renderer.setScissor(...p);
      groundMesh.material.map = i === 0 ? groundTex : groundTex2;
      wide.mesh.material.map = i === 0 ? wide.texComp : wide.texBase; // the mosaic is reflectivity only
      renderer.render(scene, camera);
    });
    wide.mesh.material.map = wide.texComp;
    renderer.setScissorTest(false);
  }
  requestAnimationFrame(frame);
})();

// double-click the map to orbit around that spot
const ray = new THREE.Raycaster();
function groundHit(e) {
  const r = canvas.getBoundingClientRect();
  const x = e.clientX - r.left, yUp = r.height - (e.clientY - r.top);
  const p = panes().find(([px, py, pw, ph]) => x >= px && x <= px + pw && yUp >= py && yUp <= py + ph) || [0, 0, r.width, r.height];
  ray.setFromCamera(new THREE.Vector2(((x - p[0]) / p[2]) * 2 - 1, ((yUp - p[1]) / p[3]) * 2 - 1), camera);
  return ray.intersectObjects([groundMesh, wide.mesh].filter(m => m.visible))[0] || null;
}
canvas.addEventListener('dblclick', e => {
  const hit = groundHit(e);
  if (!hit) return;
  const d = hit.point.clone().sub(controls.target);
  d.y = 0;
  controls.target.add(d); camera.position.add(d);
});
// single click (not a drag): open the warning under the pointer
let downAt = null;
canvas.addEventListener('pointerdown', e => { downAt = { x: e.clientX, y: e.clientY, t: performance.now() }; });
canvas.addEventListener('pointerup', e => {
  if (!downAt || !state.meta || !state.showWarnings) return;
  const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y), dt = performance.now() - downAt.t;
  downAt = null;
  if (moved > 6 || dt > 500) return;
  const hit = groundHit(e);
  if (!hit) return;
  const s = state.meta.site;
  const lat = s.lat + (-hit.point.z) / 111.195;
  const lon = s.lon + hit.point.x / (111.195 * Math.cos(s.lat * Math.PI / 180));
  const w = state.warnings.find(x => pointInGeometry(lon, lat, x.geometry)); // list is sorted most severe first
  if (w) openAlert(w, false); else if (!$('alertCard').hidden) closeAlert();
});

// ---------------- ground map ----------------
function project(lon, lat, R = state.rangeKm) {
  const s = state.meta.site, S = groundCanvas.width;
  const east = (lon - s.lon) * Math.cos(s.lat * Math.PI / 180) * 111.195;
  const north = (lat - s.lat) * 111.195;
  return [(east + R) / (2 * R) * S, (R - north) / (2 * R) * S];
}

function strokeLines(ctx, geom, R = state.rangeKm) {
  const lines = geom.type === 'MultiLineString' ? geom.coordinates : geom.type === 'LineString' ? [geom.coordinates] : [];
  const S = groundCanvas.width, m = S * 0.3;
  ctx.beginPath();
  for (const line of lines) {
    let pen = false;
    for (const [lon, lat] of line) {
      const [x, y] = project(lon, lat, R);
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
const overlay = document.createElement('canvas');
let overlayKey = '', groundVersion = 0;

// County/state lines + range rings, redrawn only when the site or range changes.
function buildOverlay() {
  const S = groundCanvas.width;
  const key = `${state.meta.icao}|${state.rangeKm}|${!!mapLines}|${state.basemap}`;
  if (key === overlayKey) return;
  overlayKey = key;
  overlay.width = overlay.height = S;
  const ctx = overlay.getContext('2d');
  ctx.clearRect(0, 0, S, S);
  ctx.strokeStyle = state.basemap === 'osm' ? 'rgba(20,30,45,0.35)' : 'rgba(255,255,255,0.12)'; ctx.lineWidth = 1.5;
  for (let r = 50; r <= state.rangeKm * 1.42; r += 50) {
    ctx.beginPath(); ctx.arc(S / 2, S / 2, r / (2 * state.rangeKm) * S, 0, Math.PI * 2); ctx.stroke();
  }
  if (mapLines && state.basemap === 'lines') {
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(150,165,185,0.30)'; ctx.lineWidth = 1.2; strokeLines(ctx, mapLines.counties);
    ctx.strokeStyle = 'rgba(215,225,240,0.75)'; ctx.lineWidth = 2.6; strokeLines(ctx, mapLines.states); strokeLines(ctx, mapLines.nation);
  }
}

// OpenStreetMap tiles under the radar, re-rendered when the site, range or style changes.
const tileCanvas = document.createElement('canvas');
let tileKey = '', tileReady = false;
function ensureTiles() {
  if (state.basemap === 'lines' || !state.meta || !state.meta.site) return;
  const key = `${state.basemap}|${state.meta.icao}|${state.rangeKm}`;
  if (key === tileKey) return;
  tileKey = key; tileReady = false;
  tileCanvas.width = tileCanvas.height = groundCanvas.width;
  renderBasemap(tileCanvas, state.basemap, state.meta.site, state.rangeKm)
    .then(r => {
      if (tileKey !== key) return;
      tileReady = true; drawGround();
      if (r.missing === r.total) setNote('Map tiles unavailable (offline?)');
    });
}

// Whole-map layers: re-rendered when the site, style or (for the mosaic) the scan time changes.
function ensureWide() {
  wide.mesh.visible = state.wide && !!state.meta;
  if (!state.wide || !state.meta || !state.meta.site) return;
  const site = state.meta.site;
  const baseKey = `${state.basemap}|${state.meta.icao}`;
  if (baseKey !== wide.baseKey) {
    wide.baseKey = baseKey; wide.baseReady = false;
    if (state.basemap === 'lines') {
      const ctx = wide.base.getContext('2d'), S = wide.base.width;
      ctx.fillStyle = '#121821'; ctx.fillRect(0, 0, S, S);
      if (mapLines) {
        ctx.strokeStyle = 'rgba(215,225,240,0.75)'; ctx.lineWidth = 1.5;
        strokeLines(ctx, mapLines.states, WIDE_KM); strokeLines(ctx, mapLines.nation, WIDE_KM);
        wide.baseReady = true;
      } else wide.baseKey = ''; // retry once outlines arrive
      composeWide();
    } else {
      renderTiles(wide.base, BASEMAPS[state.basemap], site, WIDE_KM).then(() => {
        if (wide.baseKey === baseKey) { wide.baseReady = true; composeWide(); }
      });
    }
  }
  const live = state.live && state.meta.mode === 'live';
  const src = mosaicSource(state.meta.lowTime || state.meta.time, live);
  const mosaicKey = `${state.meta.icao}|${src.url}`;
  if (mosaicKey !== wide.mosaicKey) {
    wide.mosaicKey = mosaicKey; wide.mosaicReady = false;
    renderTiles(wide.mosaic, src, site, WIDE_KM).then(() => {
      if (wide.mosaicKey === mosaicKey) { wide.mosaicReady = true; composeWide(); }
    });
  }
}

const rapidCanvas = { REF: document.createElement('canvas'), VEL: document.createElement('canvas') };
// follow mode: the previous sweep stays underneath while the next one is drawn
const rapidBase = { REF: document.createElement('canvas'), VEL: document.createElement('canvas') };

const radarImgs = { REF: document.createElement('canvas'), VEL: document.createElement('canvas') };
const radarKeys = { REF: '', VEL: '' };

function drawGround() {
  $('attrib').textContent = [state.basemap === 'lines' ? '' : BASEMAPS[state.basemap].attribution, state.wide ? 'Radar mosaic: IEM' : ''].filter(Boolean).join(' · ');
  ensureWide();
  if (state.split) {
    drawGroundInto(groundCanvas, groundTex, 'REF');
    drawGroundInto(groundCanvas2, groundTex2, 'VEL');
  } else drawGroundInto(groundCanvas, groundTex, state.groundLayer);
}

function drawGroundInto(cv, tex, layer) {
  const ctx = cv.getContext('2d');
  const S = cv.width;
  ctx.fillStyle = '#121821'; ctx.fillRect(0, 0, S, S);
  if (!state.meta) { tex.needsUpdate = true; return; }
  ensureTiles();
  if (state.basemap !== 'lines' && tileReady) ctx.drawImage(tileCanvas, 0, 0);
  let src = null;
  const r = state.rapid[layer];
  const rapidLive = state.live && !loop.playing && state.rapidMode !== 'off' && layer !== 'off';
  const showRapid = rapidLive && r && r.rangeKm === state.rangeKm;
  const follow = showRapid && state.rapidMode === 'follow';
  if (follow) {
    if (r.hasBase) { ctx.imageSmoothingEnabled = false; ctx.drawImage(rapidBase[layer], 0, 0, S, S); }
  } else if (layer !== 'off') {
    const frames = loop.frames[layer];
    if (loop.playing && frames && frames.length) src = frames[Math.min(loop.i, frames.length - 1)];
    else if (state.ground) {
      const g = state.ground, key = `${groundVersion}`, img = radarImgs[layer];
      if (key !== radarKeys[layer]) {
        radarKeys[layer] = key;
        img.width = img.height = g.size;
        img.getContext('2d').putImageData(new ImageData(layer === 'VEL' ? g.vel : g.ref, g.size, g.size), 0, 0);
      }
      src = img;
    }
  }
  if (src) { ctx.imageSmoothingEnabled = false; ctx.drawImage(src, 0, 0, S, S); }
  // rapid scan: newest radials of the sweep that is still being scanned
  if (showRapid) { ctx.imageSmoothingEnabled = false; ctx.drawImage(rapidCanvas[layer], 0, 0, S, S); }
  buildOverlay();
  ctx.drawImage(overlay, 0, 0);
  if (state.showWarnings) {
    // least severe first so tornado warnings end up on top
    for (let i = state.warnings.length - 1; i >= 0; i--) {
      const w = state.warnings[i], col = warnColor(w), adv = w.significance === 'Y';
      polygonPath(ctx, w.geometry);
      ctx.fillStyle = col + (adv ? '12' : '1a'); ctx.fill();
      ctx.setLineDash(adv ? [12, 8] : []);
      ctx.strokeStyle = '#000'; ctx.lineWidth = adv ? 5 : 7; ctx.stroke();
      ctx.strokeStyle = col; ctx.lineWidth = adv ? 2.5 : 4; ctx.stroke();
      ctx.setLineDash([]);
    }
    const sel = state.selectedAlert && state.warnings.find(w => w.id === state.selectedAlert);
    if (sel) {
      polygonPath(ctx, sel.geometry);
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 10; ctx.globalAlpha = 0.5; ctx.stroke(); ctx.globalAlpha = 1;
      ctx.strokeStyle = warnColor(sel); ctx.lineWidth = 5; ctx.stroke();
    }
  }
  // beam line: always shown in live mode; bright while it is drawing the layer you are looking at
  const ls = state.liveStatus;
  const beamAz = showRapid && !r.complete ? r.lastAz : (rapidLive && ls && ls.lastAz != null ? ls.lastAz : null);
  if (beamAz != null) {
    const a = beamAz * Math.PI / 180, len = S * 0.75, bright = showRapid && !r.complete;
    ctx.setLineDash(bright ? [] : [14, 10]);
    ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.lineWidth = bright ? 7 : 5;
    ctx.beginPath(); ctx.moveTo(S / 2, S / 2); ctx.lineTo(S / 2 + Math.sin(a) * len, S / 2 - Math.cos(a) * len); ctx.stroke();
    ctx.strokeStyle = bright ? '#ffffff' : 'rgba(255,255,255,0.6)'; ctx.lineWidth = bright ? 3 : 2; ctx.stroke();
    ctx.setLineDash([]);
  }
  // radar site marker
  ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(S / 2, S / 2, 7, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#0a0e13'; ctx.beginPath(); ctx.arc(S / 2, S / 2, 3, 0, Math.PI * 2); ctx.fill();
  tex.needsUpdate = true;
}

basemap().then(b => { mapLines = b; drawGround(); }).catch(() => setNote('Map outlines unavailable (offline?)'));

// ---------------- worker ----------------
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
let reqId = 0, latestBuild = 0, busy = false, pendingBuild = false;
let quietBuild = false; // live tilt updates rebuild in the background without the progress toast
const loop = { playing: false, frames: {}, times: [], i: 0, timer: null, reqId: 0 };

worker.onmessage = ev => {
  const m = ev.data;
  if (m.type === 'progress') { if (!quietBuild) showProgress(m.stage, m.frac); return; }
  if (m.type === 'progress-done') { if (!busy) hideProgress(); return; }
  if (m.type === 'note') return setNote(m.message);
  if (m.type === 'live-status') { state.liveStatus = m; updateLiveStatus(m); updateRapidInfo(); return drawGround(); }
  if (m.type === 'loop') return receiveLoop(m);
  if (m.type === 'rapid') {
    if (!state.live || state.rapidMode === 'off' || m.mode !== state.rapidMode) return;
    const c = rapidCanvas[m.moment], prev = state.rapid[m.moment];
    let hasBase = prev ? prev.hasBase : false;
    if (prev && prev.time !== m.time && m.mode === 'follow') {
      // a new sweep started: keep the previous one underneath
      const b = rapidBase[m.moment];
      b.width = b.height = c.width;
      b.getContext('2d').drawImage(c, 0, 0);
      hasBase = true;
    }
    c.width = c.height = m.size;
    c.getContext('2d').putImageData(new ImageData(m.img, m.size, m.size), 0, 0);
    state.rapid[m.moment] = { time: m.time, lastAz: m.lastAz, rangeKm: m.rangeKm, angle: m.angle, complete: m.complete, hasBase };
    $('scan').dataset.rapid = '1';
    updateStamp(); updateRapidInfo();
    return drawGround();
  }
  if (m.type === 'error') { busy = false; quietBuild = false; hideProgress(); return setNote(`Error: ${m.message}`, true); }
  if (m.type === 'loaded') {
    if (m.meta.mode === 'live' && !state.live) return; // stale message after leaving live mode
    state.meta = m.meta;
    updateStamp();
    renderAlertList();
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
      if (m.ground) {
        state.ground = m.ground; groundVersion++;
        // a finished low tilt replaces its rapid-scan preview
        if (state.rapidMode === 'low') {
          if (state.rapid.REF && m.ground.refTime >= state.rapid.REF.time) delete state.rapid.REF;
          if (state.rapid.VEL && m.ground.velTime >= state.rapid.VEL.time) delete state.rapid.VEL;
        }
        setGroundSize(); drawGround();
      }
      $('tilts').textContent = `${m.tilts.length} tilts: ${m.tilts.join('°, ')}°`;
    }
    for (const mesh of m.meshes) setMesh(mesh);
    if (m.type === 'built' && state.pendingFocus && state.meta && state.pendingFocus.icao === state.meta.icao) {
      focusLonLat(state.pendingFocus.lon, state.pendingFocus.lat);
      state.pendingFocus = null; state.autoFocus = false;
    } else if (m.type === 'built' && state.autoFocus && !state.pendingFocus) { state.autoFocus = false; focusOn(m.focus); }
    busy = false;
    quietBuild = false;
    hideProgress();
    if (pendingBuild) { pendingBuild = false; quietBuild = state.live; requestBuild(true); }
    const tris = [...meshes.values()].reduce((a, x) => a + (x.geometry.index ? x.geometry.index.count / 3 : 0), 0);
    setNote(!state.show3d ? '3D storms off: 2D radar view.' : tris ? `${(tris / 1000).toFixed(0)}k triangles` : 'No echoes at the selected levels in this volume.');
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
  worker.postMessage({ type: 'build', id: reqId, opts: gridOpts(), levels: state.show3d ? [...state.levels] : [], ground: withGround, groundSize: 1536 });
}

function requestLevel(level) {
  if (!state.meta || meshes.has(level) || !state.show3d) return;
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
  renderAlertList();
  // keep an open card in sync (it may have expired or been updated)
  if (state.selectedAlert && !state.warnings.some(w => w.id === state.selectedAlert)) $('acMeta').textContent += ' · no longer in effect';
  drawGround();
}
// live: refresh warnings every 2 minutes
setInterval(() => { if (state.live && state.meta) loadWarnings(); }, 120000);

// ---------------- alerts list + card ----------------
const fmtClock = t => new Date(t).toISOString().slice(11, 16) + ' UTC';
function relTime(t) {
  const ref = state.live ? Date.now() : (state.meta ? state.meta.lowTime : Date.now());
  const m = Math.round((t - ref) / 60000);
  return m >= 0 ? (m < 60 ? `in ${m} min` : `in ${Math.floor(m / 60)} h ${m % 60} min`) : `${-m} min ago`;
}
function tagList(w) {
  const t = w.tags, out = [];
  if (w.emergency) out.push(['TORNADO EMERGENCY', true]);
  if (w.pds) out.push(['Particularly dangerous situation', true]);
  if (t.tornado) out.push([`Tornado: ${t.tornado.toLowerCase()}`, /OBSERVED/i.test(t.tornado)]);
  if (t.damage) out.push([`Damage threat: ${t.damage.toLowerCase()}`, /CATASTROPHIC|DESTRUCTIVE|CONSIDERABLE/i.test(t.damage)]);
  if (t.hail) out.push([`Hail ${t.hail}"`, +t.hail >= 1.75]);
  if (t.wind) out.push([`Wind ${t.wind} mph`, +t.wind >= 70]);
  if (t.flood) out.push([`Flash flood: ${String(t.flood).toLowerCase()}`, /CATASTROPHIC|CONSIDERABLE/i.test(t.flood)]);
  if (t.squall) out.push([`Squall: ${String(t.squall).toLowerCase()}`, false]);
  return out;
}
function nearestSite(lon, lat) {
  let best = null, bd = Infinity;
  for (const s of state.sites) {
    const d = (s.lat - lat) ** 2 + ((s.lon - lon) * Math.cos(lat * Math.PI / 180)) ** 2;
    if (d < bd) { bd = d; best = s; }
  }
  return best;
}
function filteredAlerts() {
  const f = state.alertFilter;
  return state.warnings.filter(w => {
    if (f === 'severe') return ['TO', 'SV', 'EW', 'SQ'].includes(w.phenomena) && w.significance === 'W';
    if (f === 'warnings') return w.significance === 'W';
    if (f === 'near') {
      if (!state.meta || !state.meta.site) return false;
      const [lon, lat] = geometryCenter(w.geometry), { east, north } = toLocal(lon, lat);
      return Math.hypot(east, north) < 300;
    }
    return true;
  });
}
function renderAlertList() {
  const list = filteredAlerts();
  const nWarn = state.warnings.filter(w => ['TO', 'SV', 'EW'].includes(w.phenomena) && w.significance === 'W').length;
  const badge = $('alertCount');
  badge.hidden = !nWarn; badge.textContent = nWarn;
  badge.setAttribute('aria-label', `${nWarn} tornado and severe storm warnings`);
  $('alertSummary').textContent = !state.showWarnings ? 'Warnings are turned off in Settings.'
    : `${list.length} shown of ${state.warnings.length} in effect ${state.live ? 'now' : 'at ' + (state.meta ? fmtTime(state.meta.lowTime) : '')}.`;
  const ul = $('alertList');
  ul.innerHTML = '';
  for (const w of list.slice(0, 200)) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.style.setProperty('--c', warnColor(w));
    if (w.id === state.selectedAlert) b.classList.add('sel');
    const site = nearestSite(...geometryCenter(w.geometry));
    const tags = tagList(w).map(x => x[0]).slice(0, 2).join(' · ');
    b.innerHTML = `<span class="sw"></span><span class="t"></span><span class="m"></span>`;
    b.querySelector('.t').textContent = `${w.label} #${w.eventid}` + (w.emergency ? ' (EMERGENCY)' : '');
    b.querySelector('.m').textContent = `NWS ${w.wfo}${site ? ' · near ' + site.id : ''} · until ${fmtClock(w.expire)}${tags ? ' · ' + tags : ''}`;
    b.addEventListener('click', () => openAlert(w, true));
    li.appendChild(b); ul.appendChild(li);
  }
}

async function openAlert(w, fly) {
  state.selectedAlert = w.id;
  const card = $('alertCard');
  card.hidden = false;
  $('acSwatch').style.background = warnColor(w);
  $('acTitle').textContent = `${w.label} #${w.eventid}` + (w.emergency ? ' (TORNADO EMERGENCY)' : '');
  const expired = w.expire < (state.live ? Date.now() : state.meta.lowTime);
  $('acMeta').textContent = `NWS ${w.wfo} · issued ${fmtClock(w.issue)} · ${expired ? 'expired' : 'expires'} ${fmtClock(w.expire)} (${relTime(w.expire)})`;
  const tags = $('acTags'); tags.innerHTML = '';
  for (const [t, hot] of tagList(w)) { const sp = document.createElement('span'); sp.textContent = t; if (hot) sp.className = 'hot'; tags.appendChild(sp); }
  $('acLink').href = w.href || 'https://mesonet.agron.iastate.edu/vtec/';
  $('acGo').onclick = () => goToStorm(w);
  renderAlertList(); drawGround();
  if (fly) goToStorm(w);
  const pre = $('acText');
  pre.textContent = 'Loading text…';
  try {
    const txt = await warningText(w);
    if (state.selectedAlert === w.id) pre.textContent = txt || 'No text available.';
  } catch (e) { if (state.selectedAlert === w.id) pre.textContent = `Text unavailable: ${e.message}`; }
}
function closeAlert() {
  $('alertCard').hidden = true;
  state.selectedAlert = null;
  renderAlertList(); drawGround();
}

// Fly to a warning: switch to the nearest radar if needed (same time, or live), then focus the polygon.
function goToStorm(w) {
  const [lon, lat] = geometryCenter(w.geometry);
  const site = nearestSite(lon, lat);
  if (site && state.meta && site.id !== state.meta.icao) {
    state.pendingFocus = { lon, lat, icao: site.id };
    state.site = site.id; $('site').value = site.id;
    if (state.live) loadLatest(); else loadAt(state.meta.lowTime);
    setNote(`Switching to ${site.id} (${site.name}), the closest radar to this storm…`);
  } else if (state.meta) {
    focusLonLat(lon, lat);
  }
  document.body.classList.remove('panel-open');
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
  const layers = state.split ? ['REF', 'VEL'] : [state.groundLayer === 'VEL' ? 'VEL' : 'REF'];
  worker.postMessage({ type: 'loop', id: loop.reqId, urls: loopUrls(), layers, rangeKm: state.rangeKm, size: 1024 });
}
async function receiveLoop(m) {
  if (m.id !== loop.reqId || !loop.playing) return;
  if (!busy) hideProgress();
  const frames = {};
  for (const layer of m.layers) {
    frames[layer] = await Promise.all(m.frames.map(f => createImageBitmap(new ImageData(f.imgs[layer], m.size, m.size))));
  }
  const all = Object.values(frames).flat();
  if (m.id !== loop.reqId || !loop.playing) return all.forEach(b => b.close());
  Object.values(loop.frames).flat().forEach(b => b.close());
  loop.frames = frames;
  loop.times = m.frames.map(f => f.time);
  loop.i = Math.max(0, m.frames.length - 1);
  if (m.frames.length < 2) setNote('Only one low-level scan so far: the loop will grow as scans arrive.');
  loopTick();
}
function loopTick() {
  clearTimeout(loop.timer);
  if (!loop.playing) return;
  drawGround();
  const n = loop.times.length;
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
  Object.values(loop.frames).flat().forEach(b => b.close()); loop.frames = {}; loop.times = [];
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
  const rr = state.rapid[state.groundLayer];
  const rapidNow = isLive && state.rapidMode !== 'off' && rr && !rr.complete;
  $('age').textContent = rapidNow ? `LIVE · ${rr.angle}° scanning now`
    : isLive ? `LIVE · ${age < 90000 ? Math.round(age / 1000) + ' s' : Math.round(age / 60000) + ' min'} old`
    : age < 3 * 3600e3 ? `${Math.round(age / 60000)} min old` : 'archive';
  $('age').classList.toggle('live', isLive);
  if (!isLive) $('scan').textContent = '';
}
setInterval(updateStamp, 5000);

function updateLiveStatus(m) {
  if (!state.live) return;
  const cuts = `tilt ${m.cutsDone + (m.scanning != null ? 1 : 0)}`;
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

function sendRapidConfig() {
  worker.postMessage({ type: 'rapid-config', mode: state.rapidMode, rangeKm: state.rangeKm, size: 1024 });
}

// Plain-language status for the rapid scan setting.
function updateRapidInfo() {
  const el = $('rapidInfo');
  if (state.rapidMode === 'off') { el.textContent = ''; return; }
  if (!state.live) { el.innerHTML = 'Works in Live mode. <button id="rapidGoLive" class="linkish">Go live</button>'; $('rapidGoLive').onclick = () => { setLive(true); loadLatest(); }; return; }
  const ls = state.liveStatus, r = state.rapid[state.groundLayer];
  if (state.groundLayer === 'off') { el.textContent = 'Turn the ground layer on to see it.'; return; }
  if (!ls) { el.textContent = 'Connecting to the radar…'; return; }
  if (ls.ended) { el.textContent = 'Volume finished: waiting for the radar to start the next one.'; return; }
  if (state.rapidMode === 'follow') {
    el.textContent = r ? `Showing ${r.angle}° ${r.complete ? '(finished)' : 'as it is scanned'}.` : `Waiting for ${state.groundLayer === 'VEL' ? 'a tilt with velocity' : 'the next chunk'}…`;
    return;
  }
  if (ls.onLowTilt && r && !r.complete) el.textContent = `Updating now: ${r.angle}° low tilt, ${Math.round((ls.sweepFrac || 0) * 100)}% scanned.`;
  else if (ls.onLowTilt) el.textContent = `Low tilt in progress (${state.groundLayer === 'REF' ? 'velocity' : 'reflectivity'} cut): switch layer to see it, or wait.`;
  else el.textContent = `Radar is ${ls.scanning != null ? `on ${ls.scanning}°` : 'between tilts'} now (dashed line = beam). The low tilt updates at the next ${ls.nCuts > 14 ? 'SAILS cut or ' : ''}volume. Pick “Follow the radar” to watch every tilt.`;
}

function setLive(on) {
  state.rapid = {}; state.liveStatus = null;
  setTimeout(updateRapidInfo);
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
      sites: state.sites, current: state.site, basemap: state.basemap,
      live: state.live || !state.meta,
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
    syncGroundButtons(); updateRapidInfo(); updateStamp();
    if (loop.playing) { if (state.groundLayer === 'off') stopLoop(); else requestLoop(); }
    drawGround();
  });
  $('loop').addEventListener('click', () => (loop.playing ? stopLoop() : startLoop()));
  $('split').addEventListener('change', e => {
    state.split = e.target.checked;
    $('splitUI').hidden = !state.split;
    document.querySelectorAll('[data-ground]').forEach(b => { b.disabled = state.split; });
    if (state.split && state.groundLayer === 'off') state.groundLayer = 'REF';
    if (loop.playing) requestLoop();
    updateRapidInfo(); drawGround();
  });
  $('wide').addEventListener('change', e => { state.wide = e.target.checked; drawGround(); });
  $('alertFilter').addEventListener('change', e => { state.alertFilter = e.target.value; renderAlertList(); });
  $('acClose').addEventListener('click', closeAlert);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('alertCard').hidden && !$('picker').open) closeAlert(); });
  // tabs (arrow keys move between them, as the ARIA tabs pattern expects)
  const tabs = [...document.querySelectorAll('[role=tab]')];
  const selectTab = t => {
    for (const x of tabs) {
      const on = x === t;
      x.setAttribute('aria-selected', on); x.tabIndex = on ? 0 : -1;
      $(x.getAttribute('aria-controls')).hidden = !on;
    }
    try { localStorage.setItem('openradar-tab', t.id); } catch { /* storage unavailable */ }
  };
  tabs.forEach((t, i) => {
    t.addEventListener('click', () => selectTab(t));
    t.addEventListener('keydown', e => {
      const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (d) { const n = tabs[(i + d + tabs.length) % tabs.length]; selectTab(n); n.focus(); }
    });
  });
  try { const saved = $(localStorage.getItem('openradar-tab')); if (saved && tabs.includes(saved)) selectTab(saved); } catch { /* ignore */ }
  $('basemap').addEventListener('change', e => { state.basemap = e.target.value; tileKey = ''; drawGround(); });
  $('rapidMode').addEventListener('change', e => { state.rapidMode = e.target.value; state.rapid = {}; sendRapidConfig(); updateRapidInfo(); updateStamp(); drawGround(); });
  $('show3d').addEventListener('change', e => {
    state.show3d = e.target.checked;
    storm.visible = ruler.visible = state.show3d;
    document.getElementById('surfaces').disabled = !state.show3d;
    if (state.show3d) { requestBuild(false); view('3d'); }
    else { clearMeshes(); view('top'); setNote('3D storms off: 2D radar view.'); }
  });
  $('warn').addEventListener('change', e => { state.showWarnings = e.target.checked; loadWarnings(); });

  $('range').addEventListener('change', e => { state.rangeKm = +e.target.value; state.rapid = {}; sendRapidConfig(); requestBuild(true); view('3d'); if (loop.playing) requestLoop(); });
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
sendRapidConfig();
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
