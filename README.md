# OpenRadar 3D

A free, open 3D weather radar viewer. It downloads raw NEXRAD Level II scans straight from NOAA's public bucket on AWS, decodes them **in your browser**, and builds 3D reflectivity isosurfaces of storms. There's no backend, no API keys and no server costs.

## Run it

It's a static site. Any static file server works (ES modules and Web Workers don't load from `file://`):

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

To host it for free, use GitHub Pages: Settings → Pages → deploy from `main`, root folder.

Shareable links: `#site=KTLX&live=1` or `#site=KTLX&t=2013-05-20T20:00Z`.

## Features

- Live mode: latest scan for any of the ~160 WSR-88D radars, with auto-update every 90 s.
- Archive mode: any date back to the 1990s, plus historical tornado presets. Step through scans with ◀ ▶.
- 3D reflectivity surfaces at selectable dBZ levels, with vertical exaggeration, opacity and a cutaway plane.
- Ground layer showing lowest-tilt reflectivity or velocity, county and state lines, and warning polygons valid at the scan time.
- Correlation-coefficient filter that removes birds, insects and clutter.
- Works on desktop and phones.

## How it works

| File | Job |
|---|---|
| `js/bzip2.js` | Dependency-free bzip2 decoder (Level II records are bzip2-compressed) |
| `js/level2.js` | Archive II / message 31 parser → sweeps of REF, VEL, RHO, … |
| `js/volume.js` | Beam-height math (4/3 earth model) → 3D Cartesian grid → surface-nets isosurfaces |
| `js/worker.js` | Runs download, decode and meshing off the main thread |
| `js/sources.js` | Data sources (all free, no keys) |
| `js/main.js` | three.js scene, map drawing, UI |

## Data sources (all free, no key)

- Radar: NOAA NEXRAD Level II, `unidata-nexrad-level2` on AWS Open Data
- Radar site list: NWS API (`api.weather.gov/radar/stations`)
- Warning polygons (live and historical): Iowa Environmental Mesonet `sbw.geojson`
- Boundaries: US Census via `us-atlas` (jsDelivr)
- 3D engine: three.js (jsDelivr)

## Known limitations

- Scans appear in the archive bucket about 5–10 min after they finish. True real-time needs the `unidata-nexrad-level2-chunks` bucket (not wired up yet).
- Velocity is shown in 2D only. 3D velocity would need dealiasing.
- Radar geometry limits: nothing directly above the radar (cone of silence), gaps between tilts at long range, and the lowest beam is several km up at 150+ km. "Extend lowest beam to ground" fills that gap for looks. It is not observed data.

Not for life-safety decisions. Use official NWS warnings.
