// Background worker: download -> decode -> grid -> isosurfaces, so the UI never freezes.
import { parseLevel2, gunzipIfNeeded } from './level2.js';
import { buildGrid, isosurface, groundImage } from './volume.js';

let vol = null, grid = null, gridKey = '';

const post = (msg, transfer) => self.postMessage(msg, transfer || []);
const progress = (stage, frac) => post({ type: 'progress', stage, frac });

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const total = +res.headers.get('content-length') || 0;
  if (!res.body || !total) return new Uint8Array(await res.arrayBuffer());
  const out = new Uint8Array(total);
  const reader = res.body.getReader();
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.set(value, got); got += value.length;
    progress('Downloading', got / total);
  }
  return out.subarray(0, got);
}

function meshes(levels) {
  const list = [], transfer = [];
  for (const level of levels) {
    const s = isosurface(grid, level);
    list.push({ level, ...s });
    transfer.push(s.positions.buffer, s.normals.buffer, s.indices.buffer);
  }
  return { list, transfer };
}

self.onmessage = async (ev) => {
  const msg = ev.data;
  try {
    if (msg.type === 'load') {
      progress('Downloading', 0);
      let u8 = await download(msg.url);
      u8 = await gunzipIfNeeded(u8);
      progress('Decoding', 0);
      vol = parseLevel2(u8, ['REF', 'VEL', 'RHO'], f => progress('Decoding', f));
      grid = null; gridKey = '';
      post({
        type: 'loaded',
        meta: {
          icao: vol.icao, site: vol.site, vcp: vol.vcp, time: vol.time,
          tilts: vol.sweeps.map(s => ({ angle: +s.angle.toFixed(2), moments: Object.keys(s.moments) })),
        },
      });
    } else if (msg.type === 'build') {
      if (!vol) throw new Error('No volume loaded');
      const o = msg.opts;
      const key = JSON.stringify([o.rangeKm, o.dxKm, o.dzKm, o.topKm, o.ccFilter, o.extendToGround, o.smooth]);
      if (key !== gridKey) {
        progress('Building 3D grid', 0);
        grid = buildGrid(vol, o);
        gridKey = key;
      }
      progress('Extracting surfaces', 0);
      const { list, transfer } = meshes(msg.levels);
      let ground = null;
      if (msg.ground) {
        progress('Drawing ground layer', 0);
        const ref = groundImage(vol, 'REF', o.rangeKm, msg.groundSize);
        const vel = groundImage(vol, 'VEL', o.rangeKm, msg.groundSize);
        ground = { size: msg.groundSize, ref: ref.img, vel: vel.img, refAngle: ref.angle, velAngle: vel.angle };
        transfer.push(ref.img.buffer, vel.img.buffer);
      }
      post({ type: 'built', id: msg.id, meshes: list, ground, tilts: grid.tilts, focus: grid.focus }, transfer);
    } else if (msg.type === 'iso') {
      if (!grid) return;
      const { list, transfer } = meshes(msg.levels);
      post({ type: 'iso', id: msg.id, meshes: list }, transfer);
    }
  } catch (e) {
    post({ type: 'error', message: e.message || String(e), id: msg.id });
  }
};
