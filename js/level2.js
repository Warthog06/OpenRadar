// NEXRAD Level II (Archive II) decoder: message 31 radials -> sweeps.
// Works on whole files and incrementally on real-time chunks.
import { bunzip2 } from './bzip2.js';

const MOMENTS = ['REF', 'VEL', 'SW', 'ZDR', 'PHI', 'RHO', 'CFP'];

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

/**
 * Collects radials from Level II data as it arrives.
 *  - addFile(u8): a whole (or truncated) Archive II file
 *  - addChunk(u8): one real-time chunk (the start chunk carries the 24-byte volume header)
 *  - snapshot(): current volume with packed sweeps
 * opts.maxElevNum: ignore radials above this elevation number (cheap partial decode).
 */
export class Level2Accumulator {
  constructor(wanted = ['REF', 'VEL', 'RHO'], opts = {}) {
    this.want = new Set(wanted);
    this.maxElevNum = opts.maxElevNum || Infinity;
    this.icao = '';
    this.site = null; this.vcp = null; this.time = null;
    this.endOfVolume = false;
    this.sweeps = new Map();  // elevNum -> { radials, sawEnd, time, endTime }
    this.cache = new Map();   // elevNum -> packed sweep (only for complete sweeps)
    this.version = 0;          // bumps whenever radials are added
    this.nCuts = 0;            // elevation cuts in this VCP (from message 5)
  }

  addFile(u8, onProgress = null) {
    if (ascii(u8, 0, 4) !== 'AR2V') throw new Error('Not a NEXRAD Level II file');
    this.icao = ascii(u8, 20, 4).trim();
    const compressed = 30 <= u8.length && u8[28] === 0x42 && u8[29] === 0x5a; // 'BZ' after first size word
    if (compressed) this.addRecords(u8, 24, onProgress);
    else this.parseMessages(u8.subarray(24));
  }

  addChunk(u8) {
    let off = 0;
    if (ascii(u8, 0, 4) === 'AR2V') { this.icao = ascii(u8, 20, 4).trim(); off = 24; }
    this.addRecords(u8, off);
  }

  // LDM records: 4-byte size (sign = last record flag) + bzip2 stream. Stops at a truncated record.
  addRecords(u8, off, onProgress = null) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    while (off + 4 <= u8.length) {
      const size = Math.abs(dv.getInt32(off));
      if (!size || off + 4 + size > u8.length) break;
      const rec = u8.subarray(off + 4, off + 4 + size);
      off += 4 + size;
      this.parseMessages((rec[0] === 0x42 && rec[1] === 0x5a) ? bunzip2(rec) : rec);
      if (onProgress) onProgress(off / u8.length);
      if (this.stop) break;
    }
    return off;
  }

  parseMessages(data) {
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let p = 0;
    while (p + 28 <= data.length) {
      const size = dv.getUint16(p + 12);  // halfwords, excludes 12-byte CTM header
      const type = data[p + 15];
      if (type === 31) {
        const len = 12 + size * 2;
        if (size > 0 && p + len <= data.length) this.parse31(data, dv, p + 28);
        p += Math.max(len, 28);
      } else {
        // message 5 = volume coverage pattern: halfword 4 is the number of elevation cuts
        if (type === 5 && !this.nCuts) { const n = dv.getUint16(p + 28 + 6); if (n > 0 && n < 40) this.nCuts = n; }
        p += 2432;
      }
    }
  }

  parse31(u8, dv, b) {
    const ms = dv.getUint32(b + 4);
    const jd = dv.getUint16(b + 8);
    const elevNum = u8[b + 22];
    if (elevNum > this.maxElevNum) { this.stop = true; return; }
    const t = (jd - 1) * 86400000 + ms;
    const az = dv.getFloat32(b + 12);
    const azRes = u8[b + 20];
    const status = u8[b + 21];
    const elev = dv.getFloat32(b + 24);
    const nBlocks = dv.getUint16(b + 30);
    if (this.time === null) this.time = t;

    const radial = { az, azRes, elev, moments: {} };
    for (let i = 0; i < Math.min(nBlocks, 10); i++) {
      const ptr = dv.getUint32(b + 32 + 4 * i);
      if (!ptr) continue;
      const q = b + ptr;
      if (q + 28 > u8.length) continue;
      const name = ascii(u8, q + 1, 3).trim();
      if (name === 'VOL') {
        if (!this.site) {
          this.site = { lat: dv.getFloat32(q + 8), lon: dv.getFloat32(q + 12), heightM: dv.getInt16(q + 16) + dv.getUint16(q + 18) };
          this.vcp = dv.getUint16(q + 40);
        }
      } else if (u8[q] === 0x44 /* 'D' */ && this.want.has(name)) {
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
        radial.moments[name] = m;
      }
    }
    let sw = this.sweeps.get(elevNum);
    if (!sw) { sw = { radials: [], sawEnd: false, time: t, endTime: t }; this.sweeps.set(elevNum, sw); }
    sw.radials.push(radial);
    sw.endTime = t;
    if (status === 2 || status === 4) sw.sawEnd = true;   // end of elevation / end of volume
    if (status === 4) this.endOfVolume = true;
    this.version++;
  }

  snapshot() {
    const nums = [...this.sweeps.keys()];
    const maxNum = Math.max(...nums, 0);
    const sweeps = [];
    for (const [elevNum, sw] of this.sweeps) {
      if (sw.radials.length < 60) continue;
      const complete = sw.sawEnd || elevNum < maxNum || this.endOfVolume;
      let out = complete ? this.cache.get(elevNum) : null;
      if (!out || out.nRadials !== sw.radials.length) {
        out = packSweep(elevNum, sw, complete);
        if (complete) this.cache.set(elevNum, out);
      }
      if (Object.keys(out.moments).length) sweeps.push(out);
    }
    sweeps.sort((a, b) => a.elevNum - b.elevNum);
    return {
      icao: this.icao, site: this.site, vcp: this.vcp, time: this.time,
      complete: this.endOfVolume, sweeps,
    };
  }
}

// Parse a whole Archive II file. `wanted` = moment names to keep (e.g. 'REF').
export function parseLevel2(u8, wanted = ['REF', 'VEL', 'RHO'], onProgress = null, opts = {}) {
  const acc = new Level2Accumulator(wanted, opts);
  acc.addFile(u8, onProgress);
  const vol = acc.snapshot();
  if (!opts.maxElevNum) vol.complete = true;
  return vol;
}

function median(a) { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; }

function packSweep(elevNum, sw, complete) {
  const angle = median(sw.radials.map(r => r.elev));
  const out = { elevNum, angle, nRadials: sw.radials.length, time: sw.time, endTime: sw.endTime, complete, moments: {} };
  for (const name of MOMENTS) {
    const withM = sw.radials.filter(r => r.moments[name]);
    if (withM.length < sw.radials.length * 0.5) continue;
    out.moments[name] = buildMomentSweep(withM, name, complete);
  }
  return out;
}

// Pack radials of one moment into a dense [radial][gate] array + 0.5-degree azimuth lookup.
function buildMomentSweep(radials, name, complete) {
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
  // Lookup table: 720 bins of 0.5 deg -> radial index (-1 = not scanned yet).
  const lut = new Int32Array(720).fill(-1);
  for (let i = 0; i < n; i++) {
    const half = radials[i].azRes === 1 ? 0.25 : 0.5;
    const a0 = Math.round((az[i] - half) * 2), a1 = Math.round((az[i] + half) * 2);
    for (let k = a0; k < a1; k++) lut[((k % 720) + 720) % 720] = i;
  }
  if (complete) {
    // fill any small gaps from neighbours
    for (let pass = 0; pass < 2; pass++)
      for (let k = 0; k < 720; k++) if (lut[k] < 0) lut[k] = lut[(k + 719) % 720];
  } else {
    // sweep still in progress: only close single-bin seams, leave the unscanned part empty
    for (let k = 0; k < 720; k++)
      if (lut[k] < 0 && lut[(k + 719) % 720] >= 0 && lut[(k + 1) % 720] >= 0) lut[k] = lut[(k + 719) % 720];
  }
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
