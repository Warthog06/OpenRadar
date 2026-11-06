// Web map tiles (OpenStreetMap data) for the 3D ground plane and the radar picker.
export const BASEMAPS = {
  osm: {
    label: 'OpenStreetMap',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '© OpenStreetMap contributors',
    maxZoom: 19,
  },
  dark: {
    label: 'Dark (OSM data)',
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
    subdomains: 'abcd',
    attribution: '© OpenStreetMap contributors © CARTO',
    maxZoom: 19,
  },
};

const tileUrl = (style, z, x, y) => {
  const b = BASEMAPS[style];
  const s = b.subdomains ? b.subdomains[(x + y) % b.subdomains.length] : '';
  return b.url.replace('{s}', s).replace('{z}', z).replace('{x}', x).replace('{y}', y);
};

const lon2x = (lon, z) => ((lon + 180) / 360) * 2 ** z;
const lat2y = (lat, z) => { const r = lat * Math.PI / 180; return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z; };
const x2lon = (x, z) => x / 2 ** z * 360 - 180;
const y2lat = (y, z) => { const n = Math.PI - 2 * Math.PI * y / 2 ** z; return 180 / Math.PI * Math.atan(Math.sinh(n)); };

const cache = new Map(); // url -> Promise<HTMLImageElement|null>
function loadTile(url) {
  if (!cache.has(url)) {
    cache.set(url, new Promise(resolve => {
      const img = new Image();
      img.crossOrigin = 'anonymous'; // required so the canvas can become a WebGL texture
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = url;
    }));
    if (cache.size > 400) cache.delete(cache.keys().next().value);
  }
  return cache.get(url);
}

/**
 * Draw a basemap into a square canvas centred on a radar.
 * The canvas uses the same local projection as the radar layer (km east/north of the site),
 * so each Web Mercator tile is placed by its corner coordinates.
 */
export async function renderBasemap(canvas, style, site, rangeKm) {
  const S = canvas.width;
  const ctx = canvas.getContext('2d');
  const cosLat = Math.cos(site.lat * Math.PI / 180);
  const project = (lon, lat) => [
    ((lon - site.lon) * cosLat * 111.195 + rangeKm) / (2 * rangeKm) * S,
    (rangeKm - (lat - site.lat) * 111.195) / (2 * rangeKm) * S,
  ];
  const dLat = rangeKm / 111.195, dLon = rangeKm / (111.195 * cosLat);
  // pick the zoom where one tile pixel is about one canvas pixel
  const z = Math.max(3, Math.min(12, Math.round(Math.log2(40075 * cosLat * S / (256 * 2 * rangeKm)))));
  const x0 = Math.floor(lon2x(site.lon - dLon, z)), x1 = Math.floor(lon2x(site.lon + dLon, z));
  const y0 = Math.floor(lat2y(site.lat + dLat, z)), y1 = Math.floor(lat2y(site.lat - dLat, z));
  const jobs = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
    jobs.push(loadTile(tileUrl(style, z, x, y)).then(img => ({ img, x, y })));
  }
  const tiles = await Promise.all(jobs);
  ctx.clearRect(0, 0, S, S);
  ctx.imageSmoothingEnabled = true;
  let missing = 0;
  for (const { img, x, y } of tiles) {
    if (!img) { missing++; continue; }
    const [ax, ay] = project(x2lon(x, z), y2lat(y, z));
    const [bx, by] = project(x2lon(x + 1, z), y2lat(y + 1, z));
    ctx.drawImage(img, ax, ay, bx - ax + 0.6, by - ay + 0.6); // slight overlap hides seams
  }
  return { missing, total: tiles.length };
}
