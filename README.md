# Cloud Cover Prediction Visualizer

A pnpm, Vite, TypeScript, and Three.js app for standing on terrain, looking at the horizon, and visualizing cloud-cover predictions for the selected place and time.

## Run

```sh
pnpm install
pnpm dev
```

Open the local Vite URL shown by the dev server.

## What It Does

- Starts at browser geolocation when permission is available, then tries IP-derived location, then falls back to Phillip Island, Victoria.
- Renders a first-person terrain horizon with a camera looking east by default.
- Supports mouse-drag camera look controls, FOV control, height offset from terrain from -300 m to +300 m, hourly time jumps, and terrain click-to-warp.
- Draws mapped cloud volumes from gridded pressure-level pixels when available, and otherwise places procedural cloud layers from gridded low/mid/high cloud values.
- Places the Sun and Moon for the selected location and visualized time.
- Provides a resizable top-down map and a Settings modal for choosing data sources and API keys.

## Data Sources

The app runs without paid accounts by using synthetic terrain as a guaranteed fallback and Open-Meteo for cloud forecasts and location search. Settings are stored in browser local storage.

### Terrain

- Synthetic terrain: no account. Useful for offline development and predictable rendering.
- Open-Meteo Elevation: no account for non-commercial use. It uses the Open-Meteo elevation endpoint and batches up to 100 coordinates per request.
- Mapbox Terrain-RGB: requires a Mapbox access token. It decodes RGB raster tiles with the Mapbox height formula.

### Clouds

- Open-Meteo Best Match Grid: no account for non-commercial use. The app samples a 7 x 7 coordinate grid around the viewpoint for the selected hour, requesting total/low/mid/high cloud cover plus pressure-level `cloud_cover_*hPa` and `geopotential_height_*hPa` fields when available. Pressure-level pixels are rendered as anchored cloud volumes at their estimated heights.
- Open-Meteo ECMWF IFS Grid: no account for non-commercial use. Uses Open-Meteo's ECMWF IFS model selection as the global high-quality fallback cloud model.
- BoM ACCESS-G Grid: no account for non-commercial use. Uses Open-Meteo's BoM ACCESS-G endpoint and falls back to the ECMWF IFS grid if ACCESS-G does not return usable cloud pixels.
- NOAA HRRR Zarr: no account. The app reads the public HRRR Zarr archive on AWS for CONUS locations, decodes Blosc/LZ4 chunks in the browser, samples 3 km cloud-cover grid cells for total/low/mid/high cloud layers, and caches decoded snapshots plus source chunks to avoid repeated S3 requests. Outside CONUS, or if HRRR cannot produce usable pixels, it falls back to the ECMWF IFS grid.
- Real-time satellite cloud tops: when the Real-time toggle is selected, the app adds a teal cloud-top-height overlay on top of the normal cloud rendering. GOES-18/19 ABI Level 2 cloud-top-height NetCDF4 files are sampled directly from NOAA public S3 for GOES-covered locations. Himawari-covered Asia-Pacific locations use a Himawari-labeled cloud-top proxy derived from the active gridded cloud scaffold until a direct public Himawari cloud-top-height reader is available. This overlay is not shown in Prediction mode, even when the selected prediction time is now.

### Search

- Open-Meteo Geocoding: no account for non-commercial use.
- Nominatim: no account. Use modest interactive search traffic and follow the OpenStreetMap service policy.
- Mapbox Geocoding: requires a Mapbox access token.

### Map

- Terrain canvas: no account. Draws the loaded terrain grid.
- OpenStreetMap raster: no account, interactive use only, with visible attribution.
- Mapbox Outdoors raster: requires a Mapbox access token.

## Account Setup

### Open-Meteo

1. For non-commercial use, leave the Open-Meteo key blank.
2. For commercial or reserved API resources, create an Open-Meteo customer account and put the key in Settings.
3. The app switches customer calls to the `customer-api` or `customer-geocoding-api` host when the key is set.
4. Select Open-Meteo Best Match Grid, Open-Meteo ECMWF IFS Grid, BoM ACCESS-G Grid, or NOAA HRRR Zarr for spatial cloud placement.

Docs:

- https://open-meteo.com/en/docs
- https://open-meteo.com/en/docs/elevation-api
- https://open-meteo.com/en/docs/geocoding-api

### NOAA HRRR

1. No account or key is needed.
2. Select NOAA HRRR Zarr for high-resolution cloud grids over the contiguous United States.
3. Recent Zarr forecast runs can lag model initialization by a few hours, so the app tries recent usable runs and caches temporarily missing runs for a short period.

Docs:

- https://registry.opendata.aws/noaa-hrrr-pds/
- https://mesowest.utah.edu/html/hrrr/
- https://registry.opendata.aws/noaa-goes/

### Mapbox

1. Create a Mapbox account.
2. Create an access token in the Mapbox console.
3. Add the token in Settings.
4. Select Mapbox Terrain-RGB, Mapbox Geocoding, or Mapbox Outdoors raster as needed.

Docs:

- https://docs.mapbox.com/data/tilesets/reference/mapbox-terrain-rgb-v1/
- https://docs.mapbox.com/api/search/geocoding/

### OpenStreetMap Tiles And Nominatim

Use these for light browser-based interactive use. The app does not bulk-download tiles and keeps attribution visible on the mini map.

Docs:

- https://operations.osmfoundation.org/policies/tiles/
- https://nominatim.org/release-docs/latest/api/Search/
