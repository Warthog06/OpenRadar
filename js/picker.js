// Map-based radar picker: a US map with every WSR-88D site as a clickable dot,
// plus the warning polygons in effect so you can see where the storms are.
import { basemap, warningsAt } from './sources.js';

const W = 975, H = 610;
const SVGNS = 'http://www.w3.org/2000/svg';
const WARN_COLORS = { TO: '#ff3030', SV: '#ffd21f', FF: '#2bff6a', EW: '#ff8c00', SQ: '#bde8ff', MA: '#ff9ad5' };

let d3geo = null;
const el = (tag, attrs = {}) => {
  const n = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
};

/**
 * opts: { sites: [{id,name,lat,lon}], current: 'KTLX', timeMs, onPick(id) }
 */
export async function openPicker(opts) {
  const dlg = document.getElementById('picker');
  const box = document.getElementById('pickerMap');
  const other = document.getElementById('pickerOther');
  const info = document.getElementById('pickerInfo');
  const tip = document.getElementById('pickerTip');
  box.innerHTML = '<p class="small" style="padding:24px">Loading map…</p>';
  other.innerHTML = '';
  if (!dlg.open) dlg.showModal();

  try {
    if (!d3geo) d3geo = await import('https://cdn.jsdelivr.net/npm/d3-geo@3.1.1/+esm');
  } catch {
    box.innerHTML = '<p class="small" style="padding:24px">Map unavailable offline. Use the list instead.</p>';
    return;
  }
  const map = await basemap();
  const proj = d3geo.geoAlbersUsa().fitSize([W, H], map.nationShape);
  const path = d3geo.geoPath(proj);

  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'group', 'aria-label': 'Map of US radar sites' });
  const gStates = el('g', { class: 'pk-states' });
  for (const f of map.stateShapes.features) { const d = path(f); if (d) gStates.appendChild(el('path', { d })); }
  svg.appendChild(gStates);
  const gWarn = el('g', { class: 'pk-warn' });
  svg.appendChild(gWarn);
  const gSites = el('g', { class: 'pk-sites' });
  svg.appendChild(gSites);

  const offMap = [];
  const pick = id => { dlg.close(); opts.onPick(id); };
  const showTip = (s, x, y) => {
    tip.hidden = false;
    tip.textContent = `${s.id} · ${s.name}`;
    const sr = svg.getBoundingClientRect(), dr = dlg.getBoundingClientRect();
    tip.style.left = `${sr.left - dr.left + dlg.scrollLeft + (x / W) * sr.width}px`;
    tip.style.top = `${sr.top - dr.top + dlg.scrollTop + (y / H) * sr.height}px`;
  };

  const placed = [];
  for (const s of opts.sites) {
    const p = proj([s.lon, s.lat]);
    if (!p) { offMap.push(s); continue; }
    placed.push({ s, x: p[0], y: p[1] });
    const g = el('g', {
      class: 'pk-site' + (s.id === opts.current ? ' current' : ''),
      transform: `translate(${p[0].toFixed(1)},${p[1].toFixed(1)})`,
      tabindex: '0', role: 'button', 'aria-label': `${s.id}, ${s.name}`,
    });
    g.appendChild(el('circle', { r: 13, class: 'hit' }));
    g.appendChild(el('circle', { r: s.id === opts.current ? 6 : 4.2, class: 'dot' }));
    const label = el('text', { x: 6, y: -6 });
    label.textContent = s.id.slice(1);
    g.appendChild(label);
    g.addEventListener('click', () => pick(s.id));
    g.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(s.id); } });
    g.addEventListener('pointerenter', () => showTip(s, p[0], p[1]));
    g.addEventListener('focus', () => showTip(s, p[0], p[1]));
    g.addEventListener('pointerleave', () => { tip.hidden = true; });
    g.addEventListener('blur', () => { tip.hidden = true; });
    gSites.appendChild(g);
  }
  box.innerHTML = '';
  box.appendChild(svg);

  // Touch-friendly: a tap that misses every dot picks the nearest radar within ~32 px.
  svg.addEventListener('click', e => {
    if (e.target.closest('.pk-site')) return;
    const r = svg.getBoundingClientRect(), k = r.width / W;
    let best = null, bd = 32;
    for (const q of placed) {
      const d = Math.hypot(r.left + q.x * k - e.clientX, r.top + q.y * k - e.clientY);
      if (d < bd) { bd = d; best = q.s; }
    }
    if (best) pick(best.id);
  });

  other.innerHTML = offMap.length ? '<span class="small">Outside the map:</span> ' : '';
  for (const s of offMap.sort((a, b) => a.id.localeCompare(b.id))) {
    const b = document.createElement('button');
    b.textContent = s.id; b.title = s.name;
    b.addEventListener('click', () => pick(s.id));
    other.appendChild(b);
  }
  // keep the current site focused for keyboard users
  const cur = gSites.querySelector('.current');
  if (cur) {
    gSites.appendChild(cur);
    if (matchMedia('(pointer: fine)').matches) cur.focus({ preventScroll: true });
  }

  // warnings in effect at the time being viewed
  const t = opts.timeMs || Date.now();
  info.textContent = 'Loading warnings…';
  try {
    const warns = await warningsAt(t);
    if (!dlg.open) return;
    for (const w of warns) {
      const d = path(w.geometry);
      if (!d) continue;
      const col = w.emergency ? '#ff00ff' : WARN_COLORS[w.phenomena] || '#fff';
      gWarn.appendChild(el('path', { d, fill: col, 'fill-opacity': 0.35, stroke: col, 'stroke-width': 1.2 }));
    }
    const counts = {};
    for (const w of warns) counts[w.label] = (counts[w.label] || 0) + 1;
    const when = new Date(t).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
    info.textContent = warns.length
      ? `Warnings at ${when}: ` + Object.entries(counts).map(([k, v]) => `${v} ${k}${v > 1 ? 's' : ''}`).join(', ')
      : `No storm warnings in effect at ${when}.`;
  } catch {
    info.textContent = 'Warnings unavailable.';
  }
}
