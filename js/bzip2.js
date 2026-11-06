// Small, dependency-free bzip2 decompressor (enough for NEXRAD Level II LDM records).
// Implements: Huffman/MTF/RLE2 decode -> inverse BWT -> RLE1 undo.

class BitReader {
  constructor(u8) { this.u8 = u8; this.pos = 0; this.buf = 0; this.n = 0; }
  bits(k) { // k <= 24
    while (this.n < k) {
      const b = this.pos < this.u8.length ? this.u8[this.pos++] : 0;
      this.buf = ((this.buf << 8) | b) >>> 0;
      this.n += 8;
    }
    this.n -= k;
    const v = (this.buf >>> this.n) & ((1 << k) - 1);
    this.buf &= (1 << this.n) - 1;
    return v;
  }
  bit() {
    if (this.n === 0) {
      this.buf = this.pos < this.u8.length ? this.u8[this.pos++] : 0;
      this.n = 8;
    }
    this.n--;
    const v = (this.buf >>> this.n) & 1;
    this.buf &= (1 << this.n) - 1;
    return v;
  }
  alignToByte() { this.n = 0; this.buf = 0; }
}

class Output {
  constructor(size) { this.buf = new Uint8Array(size); this.len = 0; }
  ensure(extra) {
    if (this.len + extra <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + extra) cap *= 2;
    const nb = new Uint8Array(cap); nb.set(this.buf.subarray(0, this.len)); this.buf = nb;
  }
  result() { return this.buf.subarray(0, this.len); }
}

function buildTable(lens, n) {
  let minLen = 32, maxLen = 0;
  for (let s = 0; s < n; s++) { if (lens[s] < minLen) minLen = lens[s]; if (lens[s] > maxLen) maxLen = lens[s]; }
  const count = new Int32Array(maxLen + 2);
  for (let s = 0; s < n; s++) count[lens[s]]++;
  const perm = new Int32Array(n);
  let p = 0;
  for (let l = minLen; l <= maxLen; l++) for (let s = 0; s < n; s++) if (lens[s] === l) perm[p++] = s;
  const limit = new Int32Array(maxLen + 2), base = new Int32Array(maxLen + 2);
  let code = 0, idx = 0;
  for (let l = minLen; l <= maxLen; l++) {
    base[l] = idx - code;
    code += count[l]; idx += count[l];
    limit[l] = code - 1;
    code <<= 1;
  }
  return { minLen, maxLen, limit, base, perm };
}

function decodeBlock(br, tt, blockMax, out) {
  if (br.bit()) throw new Error('bzip2: randomized blocks not supported');
  const origPtr = br.bits(24);

  const used16 = br.bits(16);
  const seqToUnseq = new Uint8Array(256);
  let nInUse = 0;
  for (let i = 0; i < 16; i++) {
    if (used16 & (0x8000 >> i)) {
      const b = br.bits(16);
      for (let j = 0; j < 16; j++) if (b & (0x8000 >> j)) seqToUnseq[nInUse++] = i * 16 + j;
    }
  }
  if (!nInUse) throw new Error('bzip2: no symbols');
  const alphaSize = nInUse + 2;

  const nGroups = br.bits(3);
  if (nGroups < 2 || nGroups > 6) throw new Error('bzip2: bad group count');
  const nSelectors = br.bits(15);
  if (!nSelectors) throw new Error('bzip2: no selectors');
  const mtfGroups = [0, 1, 2, 3, 4, 5];
  const selectors = new Uint8Array(nSelectors);
  for (let i = 0; i < nSelectors; i++) {
    let j = 0;
    while (br.bit()) { j++; if (j >= nGroups) throw new Error('bzip2: bad selector'); }
    const v = mtfGroups[j];
    for (; j > 0; j--) mtfGroups[j] = mtfGroups[j - 1];
    mtfGroups[0] = v;
    selectors[i] = v;
  }

  const tables = [];
  for (let g = 0; g < nGroups; g++) {
    const lens = new Uint8Array(alphaSize);
    let len = br.bits(5);
    for (let s = 0; s < alphaSize; s++) {
      for (;;) {
        if (len < 1 || len > 20) throw new Error('bzip2: bad code length');
        if (!br.bit()) break;
        if (br.bit()) len--; else len++;
      }
      lens[s] = len;
    }
    tables.push(buildTable(lens, alphaSize));
  }

  // Huffman + MTF + RUNA/RUNB decode into tt (low byte)
  const mtf = new Uint8Array(256);
  for (let i = 0; i < 256; i++) mtf[i] = i;
  const byteCount = new Int32Array(256);
  const EOB = nInUse + 1;
  let n = 0, groupPos = 0, selIdx = 0, t = null;
  let runPos = 0, run = 0;
  for (;;) {
    if (groupPos === 0) {
      if (selIdx >= nSelectors) throw new Error('bzip2: ran out of selectors');
      t = tables[selectors[selIdx++]];
      groupPos = 50;
    }
    groupPos--;
    let l = t.minLen;
    let code = br.bits(l);
    let sym = -1;
    while (l <= t.maxLen) {
      if (code <= t.limit[l]) { sym = t.perm[t.base[l] + code]; break; }
      code = (code << 1) | br.bit();
      l++;
    }
    if (sym < 0) throw new Error('bzip2: bad huffman code');

    if (sym <= 1) { // RUNA / RUNB
      if (!runPos) { runPos = 1; run = 0; }
      run += (sym + 1) * runPos;
      runPos <<= 1;
      continue;
    }
    if (runPos) {
      runPos = 0;
      const b = seqToUnseq[mtf[0]];
      if (n + run > blockMax) throw new Error('bzip2: run overflow');
      byteCount[b] += run;
      while (run-- > 0) tt[n++] = b;
      run = 0;
    }
    if (sym === EOB) break;
    const idx = sym - 1;
    const v = mtf[idx];
    for (let k = idx; k > 0; k--) mtf[k] = mtf[k - 1];
    mtf[0] = v;
    const b = seqToUnseq[v];
    if (n >= blockMax) throw new Error('bzip2: block overflow');
    byteCount[b]++;
    tt[n++] = b;
  }
  if (origPtr >= n) throw new Error('bzip2: bad origPtr');

  // Inverse BWT
  const cftab = new Int32Array(256);
  for (let i = 0, sum = 0; i < 256; i++) { cftab[i] = sum; sum += byteCount[i]; }
  for (let i = 0; i < n; i++) {
    const b = tt[i] & 0xff;
    tt[cftab[b]++] |= (i << 8);
  }

  // Walk + undo initial RLE (4 equal bytes followed by a repeat count)
  out.ensure(n + 1024);
  let pos = tt[origPtr] >>> 8;
  let last = -1, rep = 0;
  let buf = out.buf, len = out.len;
  for (let i = 0; i < n; i++) {
    const e = tt[pos];
    const b = e & 0xff;
    pos = e >>> 8;
    if (rep === 4) {
      if (b) {
        if (len + b > buf.length) { out.len = len; out.ensure(b + (n - i)); buf = out.buf; }
        buf.fill(last, len, len + b); len += b;
      }
      rep = 0; last = -1;
      continue;
    }
    if (b === last) rep++; else { rep = 1; last = b; }
    if (len >= buf.length) { out.len = len; out.ensure(n - i + 1024); buf = out.buf; }
    buf[len++] = b;
  }
  out.len = len;
}

export function bunzip2(src, sizeHint = 0) {
  const br = new BitReader(src);
  const out = new Output(Math.max(sizeHint, src.length * 6, 1 << 16));
  let tt = null;
  let streams = 0;
  for (;;) {
    if (br.bits(8) !== 0x42 || br.bits(8) !== 0x5a || br.bits(8) !== 0x68) {
      if (streams) break;
      throw new Error('bzip2: bad signature');
    }
    const level = br.bits(8) - 0x30;
    if (level < 1 || level > 9) throw new Error('bzip2: bad block size');
    const blockMax = level * 100000;
    if (!tt || tt.length < blockMax) tt = new Uint32Array(blockMax);
    for (;;) {
      const m1 = br.bits(24), m2 = br.bits(24);
      if (m1 === 0x314159 && m2 === 0x265359) {
        br.bits(16); br.bits(16); // block CRC (not verified)
        decodeBlock(br, tt, blockMax, out);
      } else if (m1 === 0x177245 && m2 === 0x385090) {
        br.bits(16); br.bits(16); // stream CRC
        break;
      } else {
        throw new Error('bzip2: bad block magic');
      }
    }
    streams++;
    br.alignToByte();
    if (br.pos + 4 > src.length) break; // no concatenated stream follows
  }
  return out.result();
}
