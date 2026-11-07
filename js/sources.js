// All network data sources used by the app. Every one is free and needs no API key.
export const BUCKET = 'https://unidata-nexrad-level2.s3.amazonaws.com';

const pad = n => String(n).padStart(2, '0');
export const dayPrefix = d => `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}`;

// Times encoded in file names: KTLX20130520_195941_V06(.gz)
export function keyTime(key) {
  const m = /(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/.exec(key);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : NaN;
}

// List one UTC day of Level II volumes for a site (NOAA NEXRAD on AWS Open Data).
export async function listDay(site, date) {
  const prefix = `${dayPrefix(date)}/${site}/`;
  const keys = [];
  let token = '';
  for (let page = 0; page < 5; page++) {
    const url = `${BUCKET}/?list-type=2&prefix=${encodeURIComponent(prefix)}` + (token ? `&continuation-token=${encodeURIComponent(token)}` : '');
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Listing failed (${res.status})`);
    const xml = new DOMParser().parseFromString(await res.text(), 'application/xml');
    for (const k of xml.getElementsByTagName('Key')) {
      const key = k.textContent;
      if (/_V0\d(\.gz)?$/.test(key) || /\d{6}(\.gz)?$/.test(key)) keys.push(key); // skip *_MDM etc.
    }
    const next = xml.getElementsByTagName('NextContinuationToken')[0];
    if (!next) break;
    token = next.textContent;
  }
  return keys.sort().map(key => ({ key, url: `${BUCKET}/${key}`, time: keyTime(key) }));
}

// WSR-88D site list (NWS API). Falls back to a short built-in list.
export async function radarSites() {
  try {
    const res = await fetch('https://api.weather.gov/radar/stations?stationType=WSR-88D');
    if (!res.ok) throw new Error();
    const j = await res.json();
    return j.features
      .map(f => ({ id: f.properties.id, name: f.properties.name, lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] }))
      .sort((a, b) => a.id.localeCompare(b.id));
  } catch {
    return [
      ['KTLX', 'Oklahoma City, OK', 35.333, -97.278], ['KINX', 'Tulsa, OK', 36.175, -95.564],
      ['KFWS', 'Dallas/Fort Worth, TX', 32.573, -97.303], ['KOAX', 'Omaha, NE', 41.320, -96.367],
      ['KLZK', 'Little Rock, AR', 34.836, -92.262], ['KPAH', 'Paducah, KY', 37.068, -88.772],
      ['KBMX', 'Birmingham, AL', 33.172, -86.770], ['KLOT', 'Chicago, IL', 41.604, -88.085],
      ['KDMX', 'Des Moines, IA', 41.731, -93.723], ['KICT', 'Wichita, KS', 37.654, -97.443],
      ['KAMA', 'Amarillo, TX', 35.233, -101.709], ['KMPX', 'Minneapolis, MN', 44.849, -93.566],
    ].map(([id, name, lat, lon]) => ({ id, name, lat, lon }));
  }
}

// Storm-based warning/advisory polygons valid at a time (Iowa Environmental Mesonet, live + archive).
const SEVERITY = { TO: 0, EW: 1, SV: 2, SQ: 3, FF: 4, MA: 5, FL: 6, FA: 7 };
export async function warningsAt(timeMs) {
  const ts = new Date(timeMs).toISOString().slice(0, 19) + 'Z';
  const res = await fetch(`https://mesonet.agron.iastate.edu/geojson/sbw.geojson?ts=${ts}`);
  if (!res.ok) throw new Error(`Warnings failed (${res.status})`);
  const j = await res.json();
  return j.features
    .filter(f => f.geometry && (f.properties.significance === 'W' || f.properties.significance === 'Y'))
    .map(f => {
      const p = f.properties;
      return {
        id: `${p.wfo}.${p.phenomena}.${p.significance}.${p.eventid}.${p.year || ''}`,
        phenomena: p.phenomena, significance: p.significance,
        label: p.ps || `${p.phenomena} ${p.significance}`,
        wfo: p.wfo, eventid: p.eventid, productId: p.product_id, href: p.href,
        issue: Date.parse(p.issue), expire: Date.parse(p.polygon_end || p.expire),
        emergency: !!p.is_emergency, pds: !!p.is_pds,
        tags: {
          tornado: p.tornadotag, damage: p.damagetag,
          hail: p.hailtag != null ? p.hailtag : p.max_hailtag,
          wind: p.windtag != null ? p.windtag : p.max_windtag,
          flood: p.floodtag_damage, squall: p.squalltag,
        },
        geometry: f.geometry,
        rank: (SEVERITY[p.phenomena] ?? 9) + (p.significance === 'Y' ? 10 : 0) - (p.is_emergency ? 5 : 0),
      };
    })
    .sort((a, b) => a.rank - b.rank || b.issue - a.issue);
}

// Full NWS text for a warning: the product segment that carries this event's VTEC code.
const textCache = new Map();
export async function warningText(w) {
  if (!w.productId) return '';
  if (!textCache.has(w.productId)) {
    textCache.set(w.productId, fetch(`https://mesonet.agron.iastate.edu/api/1/nwstext/${encodeURIComponent(w.productId)}`)
      .then(r => { if (!r.ok) throw new Error(`Text unavailable (${r.status})`); return r.text(); })
      .catch(e => { textCache.delete(w.productId); throw e; }));
  }
  // drop the transmission header (sequence number, WMO heading, AWIPS id) at the top
  const text = (await textCache.get(w.productId)).replace(/\r/g, '').replace(/^\s*\d{3}\s*\n[^\n]*\n[^\n]*\n/, '');
  const vtec = `.${w.phenomena}.${w.significance}.${String(w.eventid).padStart(4, '0')}`;
  const parts = text.split(/\n\$\$/);
  const seg = parts.find(x => x.includes(vtec)) || text;
  const header = parts[0].split(/\n\n/).slice(0, 2).join('\n\n');
  return (seg === parts[0] ? seg : `${header}\n\n${seg.trim()}`).trim();
}

// Ray-casting point-in-polygon test for GeoJSON Polygon/MultiPolygon.
export function pointInGeometry(lon, lat, g) {
  const polys = g.type === 'MultiPolygon' ? g.coordinates : g.type === 'Polygon' ? [g.coordinates] : [];
  for (const poly of polys) {
    let inside = false;
    poly.forEach((ring, ri) => {
      let c = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i], [xj, yj] = ring[j];
        if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) c = !c;
      }
      if (c) inside = ri === 0 ? true : false; // holes cancel
    });
    if (inside) return true;
  }
  return false;
}

// Rough centre of a warning polygon (mean of the outer ring of its largest part).
export function geometryCenter(g) {
  const polys = g.type === 'MultiPolygon' ? g.coordinates : [g.coordinates];
  const ring = polys.map(p => p[0]).sort((a, b) => b.length - a.length)[0];
  let x = 0, y = 0;
  for (const [lon, lat] of ring) { x += lon; y += lat; }
  return [x / ring.length, y / ring.length];
}

// County + state outlines (US Census via us-atlas on jsDelivr).
let basemapPromise = null;
export function basemap() {
  if (!basemapPromise) {
    basemapPromise = (async () => {
      const [topo, topojson] = await Promise.all([
        fetch('https://cdn.jsdelivr.net/npm/us-atlas@3.0.1/counties-10m.json').then(r => r.json()),
        import('https://cdn.jsdelivr.net/npm/topojson-client@3.1.0/+esm'),
      ]);
      return {
        counties: topojson.mesh(topo, topo.objects.counties, (a, b) => a !== b && ((a.id / 1000) | 0) === ((b.id / 1000) | 0)),
        states: topojson.mesh(topo, topo.objects.states, (a, b) => a !== b),
        nation: topojson.mesh(topo, topo.objects.nation),
        stateShapes: topojson.feature(topo, topo.objects.states),
        nationShape: topojson.feature(topo, topo.objects.nation),
      };
    })().catch(e => { basemapPromise = null; throw e; });
  }
  return basemapPromise;
}
