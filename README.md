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

- Real-time live mode for any of the ~160 WSR-88D radars. It streams the radar's real-time chunks, so each tilt shows up seconds after the radar finishes it, not 5–10 min later. The 3D view updates as a rolling volume, using the newest copy of every tilt. The HUD shows the tilt being scanned and how far through the volume the radar is.
- Low-level loop: animates the recent lowest-tilt scans (reflectivity or velocity), including the extra SAILS / MESO-SAILS scans the radar takes every 1–2 min in severe weather. Earlier volumes are fetched with HTTP range requests, so only about 3 MB of each is downloaded.
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
| `js/worker.js` | Runs download, decode and meshing off the main thread; real-time chunk polling; loop frames |
| `js/sources.js` | Data sources (all free, no keys) |
| `js/main.js` | three.js scene, map drawing, UI |

## Data sources (all free, no key)

- Radar: NOAA NEXRAD Level II on AWS Open Data: `unidata-nexrad-level2` (archive) and `unidata-nexrad-level2-chunks` (real time)
- Radar site list: NWS API (`api.weather.gov/radar/stations`)
- Warning polygons (live and historical): Iowa Environmental Mesonet `sbw.geojson`
- Boundaries: US Census via `us-atlas` (jsDelivr)
- 3D engine: three.js (jsDelivr)

## Known limitations

- Live mode depends on how fast NOAA publishes chunks, normally within seconds. In clear air (VCP 35) a full volume takes about 7 min, so the low-level scan can be that old just before the next volume starts.
- The loop animates only the ground layer. The 3D surfaces stay on the newest scan.
- Velocity is shown in 2D only. 3D velocity would need dealiasing.
- Radar geometry limits: nothing directly above the radar (cone of silence), gaps between tilts at long range, and the lowest beam is several km up at 150+ km. "Extend lowest beam to ground" fills that gap for looks. It is not observed data.

Not for life-safety decisions. Use official NWS warnings.
