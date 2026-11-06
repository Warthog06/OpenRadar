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

// Storm-based warning polygons valid at a time (Iowa Environmental Mesonet, works for live + archive).
const PHENOMENA = { TO: 'Tornado', SV: 'Severe Thunderstorm', FF: 'Flash Flood', EW: 'Extreme Wind', SQ: 'Snow Squall', MA: 'Special Marine' };
export async function warningsAt(timeMs) {
  const ts = new Date(timeMs).toISOString().slice(0, 19) + 'Z';
  const res = await fetch(`https://mesonet.agron.iastate.edu/geojson/sbw.geojson?ts=${ts}`);
  if (!res.ok) throw new Error(`Warnings failed (${res.status})`);
  const j = await res.json();
  return j.features
    .filter(f => PHENOMENA[f.properties.phenomena] && f.properties.significance === 'W' && f.geometry)
    .map(f => ({
      phenomena: f.properties.phenomena,
      label: `${PHENOMENA[f.properties.phenomena]} Warning`,
      emergency: !!f.properties.is_emergency,
      geometry: f.geometry,
    }));
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
