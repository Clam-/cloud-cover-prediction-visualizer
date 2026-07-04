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
- Draws procedural cloud layers from cloud prediction data at low, mid, and high altitudes.
- Places the Sun and Moon for the selected location and visualized time.
- Provides a resizable top-down map and a Settings modal for choosing data sources and API keys.

## Data Sources

The app runs without paid accounts by using synthetic terrain as a guaranteed fallback and Open-Meteo for cloud forecasts and location search. Settings are stored in browser local storage.

### Terrain

- Synthetic terrain: no account. Useful for offline development and predictable rendering.
- Open-Meteo Elevation: no account for non-commercial use. It uses the Open-Meteo elevation endpoint and batches up to 100 coordinates per request.
- Mapbox Terrain-RGB: requires a Mapbox access token. It decodes RGB raster tiles with the Mapbox height formula.

### Clouds

- Synthetic forecast: no account. Useful for offline development.
- Open-Meteo Forecast: no account for non-commercial use. The app requests hourly `cloud_cover`, `cloud_cover_low`, `cloud_cover_mid`, and `cloud_cover_high`.
- OpenWeather One Call: requires an OpenWeather API key with One Call API access. The app uses the nearest hourly `clouds` percentage and distributes it across visual cloud layers.

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

Docs:

- https://open-meteo.com/en/docs
- https://open-meteo.com/en/docs/elevation-api
- https://open-meteo.com/en/docs/geocoding-api

### Mapbox

1. Create a Mapbox account.
2. Create an access token in the Mapbox console.
3. Add the token in Settings.
4. Select Mapbox Terrain-RGB, Mapbox Geocoding, or Mapbox Outdoors raster as needed.

Docs:

- https://docs.mapbox.com/data/tilesets/reference/mapbox-terrain-rgb-v1/
- https://docs.mapbox.com/api/search/geocoding/

### OpenWeather

1. Create an OpenWeather account.
2. Enable One Call API 3.0 access for the API key.
3. Add the key in Settings.
4. Select OpenWeather One Call for cloud data.

Docs:

- https://openweathermap.org/api/one-call-3

### OpenStreetMap Tiles And Nominatim

Use these for light browser-based interactive use. The app does not bulk-download tiles and keeps attribution visible on the mini map.

Docs:

- https://operations.osmfoundation.org/policies/tiles/
- https://nominatim.org/release-docs/latest/api/Search/
