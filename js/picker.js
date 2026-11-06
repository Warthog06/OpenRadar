// Map-based radar picker (Leaflet): zoomable map with every WSR-88D site, the national
// radar mosaic ("quilt" of all radars) and the warning polygons in effect.
import { warningsAt } from './sources.js';
import { BASEMAPS } from './tiles.js';

const LEAFLET = 'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/';
const WARN_COLORS = { TO: '#ff3030', SV: '#ffd21f', FF: '#2bff6a', EW: '#ff8c00', SQ: '#bde8ff', MA: '#ff9ad5' };
const REGIONS = {
  'Lower 48': [[24, -125], [49.5, -66]],
  Alaska: [[51, -170], [71, -130]],
  Hawaii: [[18.5, -161], [22.5, -154]],
  'Puerto Rico': [[17.5, -68], [19, -65]],
  Guam: [[12.8, 144.2], [14, 145.3]],
};

let L = null, map = null, opened = false;
const layers = {};
let current = null; // options of the latest open() call

async function loadLeaflet() {
  if (L) return L;
  const css = document.createElement('link');
  css.rel = 'stylesheet'; css.href = LEAFLET + 'leaflet.css';
  document.head.appendChild(css);
  L = await import(LEAFLET + 'leaflet-src.esm.js');
  return L;
}

// IEM national base-reflectivity mosaic tiles, current or at a past 5-minute time.
function mosaicUrl(timeMs, live) {
  if (live) return `https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913/{z}/{x}/{y}.png?_=${Math.floor(Date.now() / 300000)}`;
  const ts = new Date(Math.floor(timeMs / 300000) * 300000).toISOString().replace(/[-:T]/g, '').slice(0, 12);
  return `https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/ridge::USCOMP-N0Q-${ts}/{z}/{x}/{y}.png`;
}

function buildMap(box) {
  map = L.map(box, { zoomSnap: 0.5, minZoom: 2, maxZoom: 9, worldCopyJump: true });
  map.attributionControl.setPrefix(false);
  map.on('zoomend', () => box.classList.toggle('show-labels', map.getZoom() >= 5));
  const nav = document.getElementById('pickerRegions');
  nav.innerHTML = '';
  for (const [name, b] of Object.entries(REGIONS)) {
    const btn = document.createElement('button');
    btn.textContent = name;
    btn.addEventListener('click', () => map.fitBounds(b));
    nav.appendChild(btn);
  }
  document.getElementById('pickerMosaic').addEventListener('change', e => {
    if (!layers.mosaic) return;
    if (e.target.checked) layers.mosaic.addTo(map); else map.removeLayer(layers.mosaic);
  });
}

/**
 * o: { sites, current, timeMs, live, basemap: 'osm'|'dark'|'lines', onPick(id) }
 */
export async function openPicker(o) {
  current = o;
  const dlg = document.getElementById('picker');
  const box = document.getElementById('pickerMap');
  const info = document.getElementById('pickerInfo');
  if (!dlg.open) dlg.showModal();
  info.textContent = 'Loading map…';
  try { await loadLeaflet(); } catch {
    info.textContent = 'Map unavailable (offline?). Use the list instead.';
    return;
  }
  if (!map) buildMap(box);
  map.invalidateSize();
  for (const k of Object.keys(layers)) { map.removeLayer(layers[k]); delete layers[k]; }

  // basemap (OpenStreetMap data); the outline-only 3D style uses the dark map here
  const b = BASEMAPS[o.basemap] || BASEMAPS.dark;
  layers.base = L.tileLayer(b.url, { subdomains: b.subdomains || 'abc', maxZoom: 19, attribution: b.attribution }).addTo(map);

  // national radar mosaic: the "quilt" of every radar
  layers.mosaic = L.tileLayer(mosaicUrl(o.timeMs, o.live), {
    opacity: 0.75, maxNativeZoom: 8, maxZoom: 9,
    attribution: 'Radar mosaic: <a href="https://mesonet.agron.iastate.edu/" target="_blank" rel="noopener">IEM</a>',
  });
  if (document.getElementById('pickerMosaic').checked) layers.mosaic.addTo(map);

  // radar sites
  const renderer = L.canvas({ tolerance: 10 }); // generous tap target on phones
  layers.sites = L.layerGroup().addTo(map);
  for (const s of o.sites) {
    const cur = s.id === o.current;
    const m = L.circleMarker([s.lat, s.lon], {
      renderer, radius: cur ? 7 : 5, weight: 1.5, color: '#0a0e13',
      fillColor: cur ? '#ff4d4d' : '#3d9bff', fillOpacity: 1,
    });
    m.bindTooltip(s.id, { permanent: true, direction: 'right', className: 'pk-label' + (cur ? ' current' : ''), offset: [6, 0] });
    m.on('mouseover', () => { info.textContent = `${s.id} · ${s.name}: click to load`; });
    m.on('click', () => { dlg.close(); o.onPick(s.id); });
    layers.sites.addLayer(m);
  }

  // first open: frame the lower 48 (or the current radar if it is outside it)
  if (!opened) {
    opened = true;
    const cs = o.sites.find(s => s.id === o.current);
    const inConus = cs && cs.lat > 24 && cs.lat < 50 && cs.lon > -125 && cs.lon < -66;
    if (cs && !inConus) map.setView([cs.lat, cs.lon], 6); else map.fitBounds(REGIONS['Lower 48']);
  }
  box.classList.toggle('show-labels', map.getZoom() >= 5);

  // warnings in effect at the viewed time
  const when = o.live ? 'now' : 'at ' + new Date(o.timeMs).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  info.textContent = `Radar mosaic ${when} · loading warnings…`;
  try {
    const warns = await warningsAt(o.timeMs);
    if (!dlg.open || current !== o) return;
    layers.warn = L.geoJSON({ type: 'FeatureCollection', features: warns.map(w => ({ type: 'Feature', geometry: w.geometry, properties: w })) }, {
      interactive: false,
      style: f => { const c = f.properties.emergency ? '#ff00ff' : WARN_COLORS[f.properties.phenomena] || '#fff'; return { color: c, weight: 2, fillColor: c, fillOpacity: 0.15 }; },
    }).addTo(map);
    const counts = {};
    for (const w of warns) counts[w.label] = (counts[w.label] || 0) + 1;
    info.textContent = `Radar mosaic ${when} · ` + (warns.length
      ? Object.entries(counts).map(([k, v]) => `${v} ${k}${v > 1 ? 's' : ''}`).join(', ')
      : 'no storm warnings in effect');
  } catch {
    info.textContent = `Radar mosaic ${when} · warnings unavailable`;
  }
}
