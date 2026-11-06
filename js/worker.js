// Background worker: download -> decode -> grid -> isosurfaces, so the UI never freezes.
// Also runs the real-time feed (NEXRAD Level II chunks) and keeps low-level loop frames.
import { Level2Accumulator, parseLevel2, gunzipIfNeeded } from './level2.js';
import { buildGrid, isosurface, groundImage, lowestSweep, lowFrames, sweepImage } from './volume.js';

const CHUNKS = 'https://unidata-nexrad-level2-chunks.s3.amazonaws.com';
const MAX_FRAMES = 14;
const LOOP_WINDOW_MS = 45 * 60000;

let vol = null, grid = null, gridKey = '';
let live = null;                       // real-time session state
const frames = new Map();              // time -> low-level frame
let framesIcao = '';
const loopLoaded = new Set();          // archive URLs already decoded for loop frames

const post = (msg, transfer) => self.postMessage(msg, transfer || []);
const progress = (stage, frac) => post({ type: 'progress', stage, frac });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------- helpers ----------------
async function download(url, onProgress = true) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const total = +res.headers.get('content-length') || 0;
  if (!res.body || !total || !onProgress) return new Uint8Array(await res.arrayBuffer());
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

// S3 ListObjectsV2 (regex parsing: DOMParser is not available in workers)
async function s3list(bucket, prefix, delimiter = '') {
  const keys = [], prefixes = [];
  let token = '';
  for (let page = 0; page < 4; page++) {
    let url = `${bucket}/?list-type=2&prefix=${encodeURIComponent(prefix)}`;
    if (delimiter) url += `&delimiter=${encodeURIComponent(delimiter)}`;
    if (token) url += `&continuation-token=${encodeURIComponent(token)}`;
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`Listing failed (${res.status})`);
    const xml = await res.text();
    for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) keys.push(m[1]);
    for (const m of xml.matchAll(/<Prefix>([^<]+)<\/Prefix>/g)) if (m[1] !== prefix) prefixes.push(m[1]);
    const next = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml);
    if (!next) break;
    token = next[1].replace(/&amp;/g, '&');
  }
  return { keys, prefixes };
}

function metaOf(v, extra = {}) {
  const low = lowestSweep(v, 'REF');
  return {
    icao: v.icao, site: v.site, vcp: v.vcp, time: v.time,
    lowTime: low ? low.time : v.time,
    tilts: v.sweeps.map(s => ({ angle: +s.angle.toFixed(2), moments: Object.keys(s.moments) })),
    ...extra,
  };
}

function addFrames(v) {
  if (!v || !v.icao) return;
  if (v.icao !== framesIcao) { frames.clear(); loopLoaded.clear(); framesIcao = v.icao; }
  for (const f of lowFrames(v)) frames.set(f.time, f);
  const times = [...frames.keys()].sort((a, b) => a - b);
  while (times.length > MAX_FRAMES * 2) frames.delete(times.shift());
}

function setVolume(v, extra) {
  vol = v; grid = null; gridKey = '';
  addFrames(v);
  post({ type: 'loaded', meta: metaOf(v, extra) });
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

// ---------------- real-time chunks ----------------
// Bucket layout: SITE/<volume 1..999>/<YYYYMMDD-HHMMSS>-<seq>-<S|I|E>. Volume numbers wrap at 999.
const nextNum = n => (n % 999) + 1;
const prevNum = n => (n === 1 ? 999 : n - 1);

function parseChunkTime(dt) {
  return Date.UTC(+dt.slice(0, 4), +dt.slice(4, 6) - 1, +dt.slice(6, 8), +dt.slice(9, 11), +dt.slice(11, 13), +dt.slice(13, 15));
}

async function volumeChunks(site, n) {
  const { keys } = await s3list(CHUNKS, `${site}/${n}/`);
  const groups = new Map();
  for (const key of keys) {
    const m = /\/(\d{8}-\d{6})-(\d{3})-([SIE])$/.exec(key);
    if (!m) continue;
    if (!groups.has(m[1])) groups.set(m[1], []);
    groups.get(m[1]).push({ key, seq: +m[2], kind: m[3] });
  }
  if (!groups.size) return null;
  const dt = [...groups.keys()].sort().pop();       // newest volume in this slot
  const chunks = groups.get(dt).sort((a, b) => a.seq - b.seq);
  return { n, dt, time: parseChunkTime(dt), chunks, ended: chunks.some(c => c.kind === 'E') };
}

// Find the newest volume number: times increase with the number until the 999 -> 1 wrap,
// so binary-search for the last slot that is not older than the first slot.
async function findNewestVolume(site) {
  const { prefixes } = await s3list(CHUNKS, `${site}/`, '/');
  const nums = prefixes.map(p => +p.split('/')[1]).filter(n => n > 0).sort((a, b) => a - b);
  if (!nums.length) throw new Error(`No real-time data for ${site}`);
  const cache = new Map();
  const timeAt = async i => {
    if (!cache.has(i)) { const v = await volumeChunks(site, nums[i]); cache.set(i, v ? v.time : -Infinity); }
    return cache.get(i);
  };
  const t0 = await timeAt(0);
  let lo = 0, hi = nums.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (await timeAt(mid) >= t0) lo = mid; else hi = mid - 1;
  }
  return nums[lo];
}

async function fetchChunks(list, concurrency = 6) {
  const out = new Array(list.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, async () => {
    while (i < list.length) {
      const j = i++;
      const res = await fetch(`${CHUNKS}/${list[j].key}`);
      if (!res.ok) throw new Error(`Chunk download failed (${res.status})`);
      out[j] = new Uint8Array(await res.arrayBuffer());
    }
  }));
  return out;
}

async function wholeVolume(info) {
  const acc = new Level2Accumulator();
  const bytes = await fetchChunks(info.chunks);
  for (const b of bytes) acc.addChunk(b);
  return acc.snapshot();
}

// Rolling volume: newest complete sweep at every angle, from this volume or the previous one.
function merged(L) {
  const cur = L.acc.snapshot();
  const prev = L.prev;
  if (!cur.site || !cur.sweeps.some(s => s.complete)) return { vol: prev || cur, cur };
  if (!prev || prev.vcp !== cur.vcp) return { vol: (cur.complete || !prev) ? cur : prev, cur };
  return { vol: { ...cur, complete: true, sweeps: [...prev.sweeps, ...cur.sweeps] }, cur };
}

function liveStatus(L, cur) {
  const done = cur.sweeps.filter(s => s.complete).length;
  const active = cur.sweeps.find(s => !s.complete);
  return {
    type: 'live-status', volNum: L.n, volTime: L.time, nCuts: L.acc.nCuts || null,
    cutsDone: done, scanning: active ? +active.angle.toFixed(1) : null,
    sweepFrac: active ? Math.min(1, active.nRadials / (active.angle < 1.7 ? 720 : 360)) : null,
    ended: L.acc.endOfVolume, checked: Date.now(),
  };
}

// Rapid scan overlay: draw the lowest tilt while it is still being scanned, so the newest
// radials appear every few seconds on top of the previous complete scan.
let rapid = { on: true, rangeKm: 150, size: 1024 };
function postRapid(v, cur) {
  if (!rapid.on) return;
  const active = cur.sweeps.find(s => !s.complete);
  if (!active) return;
  const low = lowestSweep(v, 'REF');
  const lowAngle = low ? low.angle : active.angle;
  if (Math.abs(active.angle - lowAngle) > 0.25) return;
  // surveillance cut -> reflectivity; Doppler cut -> velocity
  const moments = active.moments.VEL ? ['VEL'] : ['REF'];
  for (const moment of moments) {
    const ms = active.moments[moment];
    if (!ms) continue;
    const img = sweepImage(ms, active.angle, moment, rapid.rangeKm, rapid.size);
    post({ type: 'rapid', moment, img, size: rapid.size, rangeKm: rapid.rangeKm, time: active.time,
      lastAz: ms.az[ms.n - 1], angle: active.angle }, [img.buffer]);
  }
}

function publish(L) {
  const { vol: v, cur } = merged(L);
  post(liveStatus(L, cur));
  postRapid(v, cur);
  const complete = cur.sweeps.filter(s => s.complete).length + (L.prev ? 1000 : 0);
  if (complete === L.lastComplete || !v.site) return;
  L.lastComplete = complete;
  setVolume(v, { mode: 'live', volNum: L.n });
}

async function runLive(L) {
  while (live === L) {
    try {
      progress('Finding the live scan', 0);
      const n = await findNewestVolume(L.site);
      const cur = await volumeChunks(L.site, n);
      if (!cur) throw new Error('Live volume not found');
      if (!cur.ended) {
        const pv = await volumeChunks(L.site, prevNum(n));
        if (pv && pv.ended && pv.time < cur.time) { progress('Loading previous scan', 0); L.prev = await wholeVolume(pv); }
        if (live !== L) return;
      }
      Object.assign(L, { n, dt: cur.dt, time: cur.time, acc: new Level2Accumulator(), next: 1, stalls: 0, lastComplete: -1 });
      if (L.prev) { addFrames(L.prev); }
      break;
    } catch (e) {
      post({ type: 'error', message: e.message });
      await sleep(15000);
    }
  }

  while (live === L) {
    let waitMs = 5000;
    try {
      const info = await volumeChunks(L.site, L.n);
      if (info && info.dt === L.dt) {
        // take the contiguous run of new chunks
        const fresh = [];
        for (const c of info.chunks) if (c.seq === L.next + fresh.length) fresh.push(c);
        if (!fresh.length && info.chunks.some(c => c.seq > L.next) && ++L.stalls > 3) {
          L.next = info.chunks.find(c => c.seq > L.next).seq; L.stalls = 0; // a chunk went missing: skip it
          waitMs = 0;
        }
        if (fresh.length) {
          L.stalls = 0;
          const bytes = await fetchChunks(fresh);
          if (live !== L) return;
          for (const b of bytes) L.acc.addChunk(b);
          L.next += fresh.length;
          publish(L);
          hideProgress();
          waitMs = fresh.length > 4 ? 0 : 4000;
        } else if (L.lastComplete < 0) {
          publish(L); hideProgress();
        }
      }
      if (L.acc.endOfVolume) {
        const nv = await volumeChunks(L.site, nextNum(L.n));
        if (nv && nv.time > L.time) {
          L.prev = L.acc.snapshot();
          Object.assign(L, { n: nv.n, dt: nv.dt, time: nv.time, acc: new Level2Accumulator(), next: 1, stalls: 0 });
          waitMs = 0;
        } else waitMs = 6000;
      }
    } catch (e) {
      post({ type: 'note', message: `Live feed hiccup: ${e.message} (retrying)` });
      waitMs = 10000;
    }
    if (waitMs) await sleep(waitMs);
  }
}
const hideProgress = () => post({ type: 'progress-done' });

// ---------------- loop frames ----------------
async function partialVolume(url) {
  // Only the first ~3.5 MB is needed for the lowest scans (records are stored in scan order).
  let u8;
  if (url.endsWith('.gz')) u8 = await gunzipIfNeeded(await download(url, false));
  else {
    const res = await fetch(url, { headers: { Range: 'bytes=0-3499999' } });
    if (!res.ok) throw new Error(`Download failed (${res.status})`);
    u8 = new Uint8Array(await res.arrayBuffer());
  }
  return parseLevel2(u8, ['REF', 'VEL'], null, { maxElevNum: 2 });
}

async function buildLoop(msg) {
  const urls = msg.urls.filter(u => !loopLoaded.has(u));
  let k = 0;
  for (const url of urls) {
    progress('Loading loop frames', k++ / urls.length);
    loopLoaded.add(url);
    try { const v = await partialVolume(url); if (v.icao === framesIcao) addFrames(v); } catch { /* skip frame */ }
  }
  const ref = vol ? metaOf(vol).lowTime : Date.now();
  const list = [...frames.values()]
    .filter(f => f.time <= ref + 60000 && f.time >= ref - LOOP_WINDOW_MS)
    .sort((a, b) => a.time - b.time)
    .slice(-MAX_FRAMES);
  const out = [], transfer = [];
  list.forEach((f, i) => {
    progress('Drawing loop frames', i / list.length);
    const isVel = msg.layer === 'VEL';
    const img = sweepImage(isVel ? f.vel : f.ref, isVel ? f.velAngle : f.angle, isVel ? 'VEL' : 'REF', msg.rangeKm, msg.size);
    out.push({ time: f.time, img });
    transfer.push(img.buffer);
  });
  post({ type: 'loop', id: msg.id, size: msg.size, layer: msg.layer, frames: out }, transfer);
}

// ---------------- messages ----------------
self.onmessage = async (ev) => {
  const msg = ev.data;
  try {
    if (msg.type === 'load') {
      live = null;
      progress('Downloading', 0);
      let u8 = await download(msg.url);
      u8 = await gunzipIfNeeded(u8);
      progress('Decoding', 0);
      const v = parseLevel2(u8, ['REF', 'VEL', 'RHO'], f => progress('Decoding', f));
      loopLoaded.add(msg.url);
      setVolume(v, { mode: 'archive' });
    } else if (msg.type === 'live-start') {
      live = { site: msg.site };
      runLive(live);
    } else if (msg.type === 'rapid-config') {
      rapid = { on: msg.on, rangeKm: msg.rangeKm, size: msg.size || 1024 };
    } else if (msg.type === 'live-stop') {
      live = null;
    } else if (msg.type === 'build') {
      if (!vol) throw new Error('No volume loaded');
      const o = msg.opts;
      const key = JSON.stringify([o.rangeKm, o.dxKm, o.dzKm, o.topKm, o.ccFilter, o.extendToGround, o.smooth]);
      if (key !== gridKey || !grid) {
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
        ground = { size: msg.groundSize, ref: ref.img, vel: vel.img, refAngle: ref.angle, velAngle: vel.angle, refTime: ref.time, velTime: vel.time };
        transfer.push(ref.img.buffer, vel.img.buffer);
      }
      post({ type: 'built', id: msg.id, meshes: list, ground, tilts: grid.tilts, focus: grid.focus }, transfer);
    } else if (msg.type === 'iso') {
      if (!grid) return;
      const { list, transfer } = meshes(msg.levels);
      post({ type: 'iso', id: msg.id, meshes: list }, transfer);
    } else if (msg.type === 'loop') {
      await buildLoop(msg);
    }
  } catch (e) {
    post({ type: 'error', message: e.message || String(e), id: msg.id });
  }
};
