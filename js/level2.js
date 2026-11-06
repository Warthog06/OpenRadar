// NEXRAD Level II (Archive II) decoder: message 31 radials -> sweeps.
import { bunzip2 } from './bzip2.js';

const MOMENTS = ['REF', 'VEL', 'SW ', 'ZDR', 'PHI', 'RHO', 'CFP'];

function ascii(u8, off, len) {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(u8[off + i]);
  return s;
}

export async function gunzipIfNeeded(u8) {
  if (u8[0] !== 0x1f || u8[1] !== 0x8b) return u8;
  const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Parse a whole Archive II file. `wanted` = moment names to keep (3 chars, e.g. 'REF').
export function parseLevel2(u8, wanted = ['REF', 'VEL', 'RHO'], onProgress = null) {
  if (ascii(u8, 0, 4) !== 'AR2V') throw new Error('Not a NEXRAD Level II file');
  const want = new Set(wanted.map(m => m.padEnd(3, ' ')));
  const vol = { icao: ascii(u8, 20, 4).trim(), site: null, vcp: null, time: null, sweeps: new Map() };
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);

  let off = 24;
  const compressed = off + 6 <= u8.length && u8[off + 4] === 0x42 && u8[off + 5] === 0x5a; // 'BZ'
  if (!compressed) {
    parseMessages(u8.subarray(off), vol, want);
  } else {
    while (off + 4 <= u8.length) {
      const size = Math.abs(dv.getInt32(off)); off += 4;
      if (!size || off + size > u8.length) break;
      const rec = u8.subarray(off, off + size); off += size;
      const data = (rec[0] === 0x42 && rec[1] === 0x5a) ? bunzip2(rec) : rec;
      parseMessages(data, vol, want);
      if (onProgress) onProgress(off / u8.length);
    }
  }
  return finishVolume(vol);
}

function parseMessages(data, vol, want) {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let p = 0;
  while (p + 28 <= data.length) {
    const size = dv.getUint16(p + 12);      // halfwords, excludes 12-byte CTM header
    const type = data[p + 15];
    if (type === 31) {
      const len = 12 + size * 2;
      if (size > 0 && p + len <= data.length) parse31(data, dv, p + 28, vol, want);
      p += Math.max(len, 28);
    } else {
      p += 2432;
    }
  }
}

function parse31(u8, dv, b, vol, want) {
  const ms = dv.getUint32(b + 4);
  const jd = dv.getUint16(b + 8);
  const az = dv.getFloat32(b + 12);
  const azRes = u8[b + 20];
  const elevNum = u8[b + 22];
  const elev = dv.getFloat32(b + 24);
  const nBlocks = dv.getUint16(b + 30);
  if (vol.time === null) vol.time = (jd - 1) * 86400000 + ms;

  const radial = { az, azRes, elev, moments: {} };
  for (let i = 0; i < Math.min(nBlocks, 10); i++) {
    const ptr = dv.getUint32(b + 32 + 4 * i);
    if (!ptr) continue;
    const q = b + ptr;
    if (q + 28 > u8.length) continue;
    const name = ascii(u8, q + 1, 3);
    if (name === 'VOL') {
      if (!vol.site) {
        vol.site = { lat: dv.getFloat32(q + 8), lon: dv.getFloat32(q + 12), heightM: dv.getInt16(q + 16) + dv.getUint16(q + 18) };
        vol.vcp = dv.getUint16(q + 40);
      }
    } else if (u8[q] === 0x44 /* 'D' */ && want.has(name)) {
      const ngates = dv.getUint16(q + 8);
      const word = u8[q + 19];
      const m = {
        ngates,
        first: dv.getUint16(q + 10),   // meters
        spacing: dv.getUint16(q + 12), // meters
        word,
        scale: dv.getFloat32(q + 20),
        offset: dv.getFloat32(q + 24),
      };
      if (word === 8) {
        m.raw = u8.slice(q + 28, q + 28 + ngates);
      } else {
        const r = new Uint16Array(ngates);
        for (let g = 0; g < ngates; g++) r[g] = dv.getUint16(q + 28 + 2 * g);
        m.raw = r;
      }
      radial.moments[name.trim()] = m;
    }
  }
  let sw = vol.sweeps.get(elevNum);
  if (!sw) { sw = { elevNum, radials: [] }; vol.sweeps.set(elevNum, sw); }
  sw.radials.push(radial);
}

function median(a) { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; }

function finishVolume(vol) {
  const sweeps = [];
  for (const sw of vol.sweeps.values()) {
    if (sw.radials.length < 100) continue;
    const angle = median(sw.radials.map(r => r.elev));
    const out = { elevNum: sw.elevNum, angle, nRadials: sw.radials.length, moments: {} };
    for (const name of MOMENTS.map(m => m.trim())) {
      const withM = sw.radials.filter(r => r.moments[name]);
      if (withM.length < sw.radials.length * 0.5) continue;
      out.moments[name] = buildMomentSweep(withM, name);
    }
    if (Object.keys(out.moments).length) sweeps.push(out);
  }
  sweeps.sort((a, b) => a.elevNum - b.elevNum);
  return { icao: vol.icao, site: vol.site, vcp: vol.vcp, time: vol.time, sweeps };
}

// Pack radials of one moment into a dense [radial][gate] array + 0.5-degree azimuth lookup.
function buildMomentSweep(radials, name) {
  let ngates = 0;
  for (const r of radials) ngates = Math.max(ngates, r.moments[name].ngates);
  const m0 = radials[0].moments[name];
  const n = radials.length;
  const raw = m0.word === 8 ? new Uint8Array(n * ngates) : new Uint16Array(n * ngates);
  const az = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const m = radials[i].moments[name];
    raw.set(m.raw.subarray(0, Math.min(m.ngates, ngates)), i * ngates);
    az[i] = radials[i].az;
  }
  // Lookup table: 720 bins of 0.5 deg -> radial index.
  const lut = new Int32Array(720).fill(-1);
  for (let i = 0; i < n; i++) {
    const half = radials[i].azRes === 1 ? 0.25 : 0.5;
    const a0 = Math.round((az[i] - half) * 2), a1 = Math.round((az[i] + half) * 2);
    for (let k = a0; k < a1; k++) lut[((k % 720) + 720) % 720] = i;
  }
  // fill any gaps from neighbours
  for (let pass = 0; pass < 2; pass++)
    for (let k = 0; k < 720; k++) if (lut[k] < 0) lut[k] = lut[(k + 719) % 720];
  return { ngates, first: m0.first, spacing: m0.spacing, scale: m0.scale, offset: m0.offset, raw, az, lut, n };
}

// Value of moment sweep at azimuth (deg) and slant range (km). Returns NaN if no data.
export function sampleSweep(ms, azDeg, rangeKm) {
  const bin = (Math.floor(azDeg * 2) % 720 + 720) % 720;
  const ri = ms.lut[bin];
  if (ri < 0) return NaN;
  const g = Math.round((rangeKm * 1000 - ms.first) / ms.spacing);
  if (g < 0 || g >= ms.ngates) return NaN;
  const raw = ms.raw[ri * ms.ngates + g];
  if (raw < 2) return raw === 1 ? -Infinity /* range folded */ : NaN;
  return (raw - ms.offset) / ms.scale;
}
