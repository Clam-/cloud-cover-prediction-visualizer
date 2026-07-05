import { clamp, hashNumber, offsetLocation, seededRandom } from "../geo";
import { readPersistentCache, writePersistentCache } from "./cache";
import type { CloudDataMode, CloudLayer, CloudSnapshot, CloudVolume, LocationPoint, Settings } from "../types";

interface OpenMeteoForecastBody {
  utc_offset_seconds?: number;
  hourly?: {
    time?: string[];
    cloud_cover?: number[];
    cloud_cover_low?: number[];
    cloud_cover_mid?: number[];
    cloud_cover_high?: number[];
  };
}

interface OpenMeteoCurrentBody {
  utc_offset_seconds?: number;
  current?: {
    time?: string;
    cloud_cover?: number;
  };
  hourly?: {
    time?: string[];
    cloud_cover?: number[];
    cloud_cover_low?: number[];
    cloud_cover_mid?: number[];
    cloud_cover_high?: number[];
  };
}

interface OpenWeatherBody {
  current?: { dt?: number; clouds?: number };
  hourly?: Array<{ dt: number; clouds?: number }>;
}

interface OpenMeteoGridPointBody {
  latitude?: number;
  longitude?: number;
  utc_offset_seconds?: number;
  hourly?: OpenMeteoGridHourly;
}

interface OpenMeteoGridHourly {
  time?: string[];
  [key: string]: number[] | string[] | undefined;
}

interface CloudGridSample extends LocationPoint {
  column: number;
  east: number;
  north: number;
  row: number;
}

interface PressureCloudLevel {
  altitudeMeters: number;
  hpa: number;
  layer: CloudLayer;
  thicknessMeters: number;
}

const CLOUD_LOCATION_PRECISION = 4;
const OPEN_METEO_FORECAST_TTL_MS = 6 * 60 * 60 * 1000;
const OPEN_METEO_CURRENT_TTL_MS = 5 * 60 * 1000;
const OPEN_METEO_GRID_TTL_MS = 90 * 60 * 1000;
const OPEN_WEATHER_FORECAST_TTL_MS = 2 * 60 * 60 * 1000;
const OPEN_WEATHER_CURRENT_TTL_MS = 10 * 60 * 1000;
const CLOUD_GRID_RESOLUTION = 7;
const CLOUD_GRID_SPACING_METERS = 12000;
const MIN_GRID_VOLUME_COVER = 12;
const PRESSURE_CLOUD_LEVELS: PressureCloudLevel[] = [
  { hpa: 925, layer: "low", altitudeMeters: 800, thicknessMeters: 520 },
  { hpa: 850, layer: "low", altitudeMeters: 1500, thicknessMeters: 720 },
  { hpa: 700, layer: "mid", altitudeMeters: 3000, thicknessMeters: 1050 },
  { hpa: 500, layer: "mid", altitudeMeters: 5600, thicknessMeters: 1350 },
  { hpa: 300, layer: "high", altitudeMeters: 9200, thicknessMeters: 1550 }
];
const OPEN_METEO_GRID_HOURLY_VARIABLES = [
  "cloud_cover",
  "cloud_cover_low",
  "cloud_cover_mid",
  "cloud_cover_high",
  ...PRESSURE_CLOUD_LEVELS.flatMap((level) => [`cloud_cover_${level.hpa}hPa`, `geopotential_height_${level.hpa}hPa`])
];

export async function loadCloudSnapshot(
  location: LocationPoint,
  time: Date,
  settings: Settings,
  signal?: AbortSignal,
  mode: CloudDataMode = "prediction"
): Promise<CloudSnapshot> {
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }

  try {
    if (settings.cloudSource === "openMeteoGrid") {
      return await loadOpenMeteoGridClouds(location, time, settings, signal, mode);
    }
    if (settings.cloudSource === "openMeteo") {
      return mode === "realtime"
        ? await loadOpenMeteoCurrentClouds(location, time, settings, signal)
        : await loadOpenMeteoForecastClouds(location, time, settings, signal);
    }
    if (settings.cloudSource === "openWeather") {
      return await loadOpenWeatherClouds(location, time, settings, signal, mode);
    }
    return syntheticClouds(location, time, mode);
  } catch (error) {
    if (isAbortError(error, signal)) {
      throw error;
    }
    const warning = error instanceof Error ? error.message : "Cloud provider failed";
    return {
      ...syntheticClouds(location, time, mode),
      warning
    };
  }
}

async function loadOpenMeteoGridClouds(
  location: LocationPoint,
  time: Date,
  settings: Settings,
  signal?: AbortSignal,
  mode: CloudDataMode = "prediction"
): Promise<CloudSnapshot> {
  const endpoint = settings.apiKeys.openMeteo
    ? "https://customer-api.open-meteo.com/v1/forecast"
    : "https://api.open-meteo.com/v1/forecast";
  const samples = buildCloudGridSamples(location);
  const targetHour = formatOpenMeteoUtcHour(time);
  const params = new URLSearchParams({
    latitude: samples.map((sample) => sample.lat.toFixed(5)).join(","),
    longitude: samples.map((sample) => sample.lon.toFixed(5)).join(","),
    hourly: OPEN_METEO_GRID_HOURLY_VARIABLES.join(","),
    start_hour: targetHour,
    end_hour: targetHour,
    timezone: "GMT",
    cell_selection: "nearest"
  });
  if (settings.apiKeys.openMeteo) {
    params.set("apikey", settings.apiKeys.openMeteo);
  }

  const url = `${endpoint}?${params.toString()}`;
  const body = await loadCachedJson<OpenMeteoGridPointBody | OpenMeteoGridPointBody[]>(
    openMeteoGridCacheKey(location, targetHour, settings.apiKeys.openMeteo, url),
    OPEN_METEO_GRID_TTL_MS,
    url,
    signal,
    "Open-Meteo cloud grid"
  );
  const points = Array.isArray(body) ? body : [body];
  if (!points.length) {
    throw new Error("Open-Meteo grid response did not include cloud fields");
  }

  const totals: number[] = [];
  const lows: number[] = [];
  const mids: number[] = [];
  const highs: number[] = [];
  const volumes: CloudVolume[] = [];

  points.forEach((point, index) => {
    const sample = samples[index];
    const hourly = point.hourly;
    if (!sample || !hourly?.time?.length) {
      return;
    }
    const offsetMs = (point.utc_offset_seconds ?? 0) * 1000;
    const bestIndex = closestOpenMeteoHourlyIndex(hourly.time, time.getTime(), offsetMs);
    pushDefinedPercent(totals, readHourlyPercent(hourly, "cloud_cover", bestIndex));
    pushDefinedPercent(lows, readHourlyPercent(hourly, "cloud_cover_low", bestIndex));
    pushDefinedPercent(mids, readHourlyPercent(hourly, "cloud_cover_mid", bestIndex));
    pushDefinedPercent(highs, readHourlyPercent(hourly, "cloud_cover_high", bestIndex));

    for (const level of PRESSURE_CLOUD_LEVELS) {
      const cover = readHourlyPercent(hourly, `cloud_cover_${level.hpa}hPa`, bestIndex);
      if (cover === undefined || cover < MIN_GRID_VOLUME_COVER) {
        continue;
      }
      const altitude = readHourlyNumber(hourly, `geopotential_height_${level.hpa}hPa`, bestIndex) ?? level.altitudeMeters;
      const radius = CLOUD_GRID_SPACING_METERS * clamp(0.32 + cover / 165, 0.38, 0.88);
      const thickness = level.thicknessMeters * clamp(0.72 + cover / 150, 0.76, 1.34);
      volumes.push({
        lat: sample.lat,
        lon: sample.lon,
        east: sample.east,
        north: sample.north,
        cover,
        altitudeMeters: altitude,
        altitudeReference: "seaLevel",
        radiusMeters: radius,
        thicknessMeters: thickness,
        layer: level.layer
      });
    }
  });

  if (!totals.length && !volumes.length) {
    throw new Error("Open-Meteo grid response did not include usable cloud pixels");
  }

  return {
    time,
    dataMode: mode,
    total: averagePercent(totals.length ? totals : volumes.map((volume) => volume.cover)),
    low: averagePercent(lows.length ? lows : volumes.filter((volume) => volume.layer === "low").map((volume) => volume.cover)),
    mid: averagePercent(mids.length ? mids : volumes.filter((volume) => volume.layer === "mid").map((volume) => volume.cover)),
    high: averagePercent(highs.length ? highs : volumes.filter((volume) => volume.layer === "high").map((volume) => volume.cover)),
    sourceLabel: mode === "realtime" ? "Open-Meteo Current Grid" : "Open-Meteo Forecast Grid",
    map: {
      radiusMeters: CLOUD_GRID_SPACING_METERS * Math.floor(CLOUD_GRID_RESOLUTION / 2),
      resolution: CLOUD_GRID_RESOLUTION,
      spacingMeters: CLOUD_GRID_SPACING_METERS,
      volumes
    }
  };
}

function syntheticClouds(location: LocationPoint, time: Date, mode: CloudDataMode): CloudSnapshot {
  const hour = Math.floor(time.getTime() / 3600000);
  const random = seededRandom(`${location.lat.toFixed(2)}:${location.lon.toFixed(2)}:${hour}`);
  const cycle = Math.sin(hour / 5 + location.lat) * 0.5 + 0.5;
  const total = clamp(Math.round(25 + cycle * 45 + random() * 25), 0, 100);
  const low = clamp(Math.round(total * (0.35 + random() * 0.25)), 0, 100);
  const mid = clamp(Math.round(total * (0.25 + random() * 0.35)), 0, 100);
  const high = clamp(Math.round(total * (0.2 + random() * 0.4)), 0, 100);
  return {
    time,
    dataMode: mode,
    total,
    low,
    mid,
    high,
    sourceLabel: mode === "realtime" ? "Synthetic current" : "Synthetic forecast"
  };
}

async function loadOpenMeteoForecastClouds(location: LocationPoint, time: Date, settings: Settings, signal?: AbortSignal): Promise<CloudSnapshot> {
  const endpoint = settings.apiKeys.openMeteo
    ? "https://customer-api.open-meteo.com/v1/forecast"
    : "https://api.open-meteo.com/v1/forecast";
  const params = new URLSearchParams({
    latitude: location.lat.toFixed(5),
    longitude: location.lon.toFixed(5),
    hourly: "cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high",
    forecast_days: "16",
    past_days: "1",
    timezone: "auto"
  });
  if (settings.apiKeys.openMeteo) {
    params.set("apikey", settings.apiKeys.openMeteo);
  }

  const url = `${endpoint}?${params.toString()}`;
  const body = await loadCachedJson<OpenMeteoForecastBody>(
    cloudCacheKey("openMeteoForecast", location, settings.apiKeys.openMeteo),
    OPEN_METEO_FORECAST_TTL_MS,
    url,
    signal,
    "Open-Meteo forecast"
  );
  const hourly = body.hourly;
  if (!hourly?.time?.length || !hourly.cloud_cover) {
    throw new Error("Open-Meteo forecast response did not include cloud cover");
  }

  const offsetMs = (body.utc_offset_seconds ?? 0) * 1000;
  const bestIndex = closestOpenMeteoHourlyIndex(hourly.time, time.getTime(), offsetMs);

  return {
    time,
    dataMode: "prediction",
    total: normalizePercent(hourly.cloud_cover[bestIndex]),
    low: normalizePercent(hourly.cloud_cover_low?.[bestIndex]),
    mid: normalizePercent(hourly.cloud_cover_mid?.[bestIndex]),
    high: normalizePercent(hourly.cloud_cover_high?.[bestIndex]),
    sourceLabel: "Open-Meteo Forecast"
  };
}

async function loadOpenMeteoCurrentClouds(location: LocationPoint, time: Date, settings: Settings, signal?: AbortSignal): Promise<CloudSnapshot> {
  const endpoint = settings.apiKeys.openMeteo
    ? "https://customer-api.open-meteo.com/v1/forecast"
    : "https://api.open-meteo.com/v1/forecast";
  const params = new URLSearchParams({
    latitude: location.lat.toFixed(5),
    longitude: location.lon.toFixed(5),
    current: "cloud_cover",
    hourly: "cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high",
    forecast_hours: "1",
    past_hours: "1",
    timezone: "auto"
  });
  if (settings.apiKeys.openMeteo) {
    params.set("apikey", settings.apiKeys.openMeteo);
  }

  const url = `${endpoint}?${params.toString()}`;
  const body = await loadCachedJson<OpenMeteoCurrentBody>(
    cloudCacheKey("openMeteoCurrent", location, settings.apiKeys.openMeteo),
    OPEN_METEO_CURRENT_TTL_MS,
    url,
    signal,
    "Open-Meteo current conditions"
  );
  const hourly = body.hourly;
  const offsetMs = (body.utc_offset_seconds ?? 0) * 1000;
  const target = parseOpenMeteoLocalTime(body.current?.time, offsetMs) ?? time.getTime();
  const bestIndex = hourly?.time?.length ? closestOpenMeteoHourlyIndex(hourly.time, target, offsetMs) : -1;
  const total = readPercent(body.current?.cloud_cover ?? hourly?.cloud_cover?.[bestIndex]);
  const low = readPercent(hourly?.cloud_cover_low?.[bestIndex]);
  const mid = readPercent(hourly?.cloud_cover_mid?.[bestIndex]);
  const high = readPercent(hourly?.cloud_cover_high?.[bestIndex]);
  if (total === undefined) {
    throw new Error("Open-Meteo current response did not include cloud cover");
  }

  return {
    time,
    dataMode: "realtime",
    total,
    low: low ?? Math.round(total * 0.45),
    mid: mid ?? Math.round(total * 0.35),
    high: high ?? Math.round(total * 0.3),
    sourceLabel: "Open-Meteo Current"
  };
}

async function loadOpenWeatherClouds(
  location: LocationPoint,
  time: Date,
  settings: Settings,
  signal?: AbortSignal,
  mode: CloudDataMode = "prediction"
): Promise<CloudSnapshot> {
  const key = settings.apiKeys.openWeather.trim();
  if (!key) {
    throw new Error("OpenWeather clouds need an API key in Settings");
  }

  const params = new URLSearchParams({
    lat: location.lat.toFixed(5),
    lon: location.lon.toFixed(5),
    exclude: "minutely,daily,alerts",
    units: "metric",
    appid: key
  });
  const url = `https://api.openweathermap.org/data/3.0/onecall?${params.toString()}`;
  const body = await loadCachedJson<OpenWeatherBody>(
    cloudCacheKey(`openWeather:${mode}`, location, key),
    mode === "realtime" ? OPEN_WEATHER_CURRENT_TTL_MS : OPEN_WEATHER_FORECAST_TTL_MS,
    url,
    signal,
    "OpenWeather One Call"
  );
  const targetSeconds = Math.round(time.getTime() / 1000);
  const options = [...(body.current ? [body.current] : []), ...(body.hourly ?? [])].filter((item) => typeof item.dt === "number");
  if (!options.length) {
    throw new Error("OpenWeather response did not include cloud cover");
  }
  const best =
    mode === "realtime" && typeof body.current?.clouds === "number"
      ? body.current
      : options.reduce((closest, item) =>
          Math.abs((item.dt ?? 0) - targetSeconds) < Math.abs((closest.dt ?? 0) - targetSeconds) ? item : closest
        );
  const total = readPercent(best.clouds);
  if (total === undefined) {
    throw new Error("OpenWeather response did not include cloud cover");
  }
  return {
    time,
    dataMode: mode,
    total,
    low: Math.round(total * 0.45),
    mid: Math.round(total * 0.35),
    high: Math.round(total * 0.3),
    sourceLabel: mode === "realtime" ? "OpenWeather Current" : "OpenWeather One Call"
  };
}

function normalizePercent(value: unknown): number {
  return readPercent(value) ?? 0;
}

function readPercent(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? clamp(Math.round(value), 0, 100) : undefined;
}

function readHourlyPercent(hourly: OpenMeteoGridHourly, key: string, index: number): number | undefined {
  return readPercent(readHourlyNumber(hourly, key, index));
}

function readHourlyNumber(hourly: OpenMeteoGridHourly, key: string, index: number): number | undefined {
  const values = hourly[key];
  const value = Array.isArray(values) ? values[index] : undefined;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function pushDefinedPercent(values: number[], value: number | undefined): void {
  if (value !== undefined) {
    values.push(value);
  }
}

function averagePercent(values: number[]): number {
  if (!values.length) {
    return 0;
  }
  return clamp(Math.round(values.reduce((sum, value) => sum + value, 0) / values.length), 0, 100);
}

function buildCloudGridSamples(location: LocationPoint): CloudGridSample[] {
  const samples: CloudGridSample[] = [];
  const half = Math.floor(CLOUD_GRID_RESOLUTION / 2);
  for (let row = 0; row < CLOUD_GRID_RESOLUTION; row += 1) {
    for (let column = 0; column < CLOUD_GRID_RESOLUTION; column += 1) {
      const east = (column - half) * CLOUD_GRID_SPACING_METERS;
      const north = (half - row) * CLOUD_GRID_SPACING_METERS;
      samples.push({
        ...offsetLocation(location, east, north),
        column,
        east,
        north,
        row
      });
    }
  }
  return samples;
}

function formatOpenMeteoUtcHour(time: Date): string {
  const year = time.getUTCFullYear();
  const month = String(time.getUTCMonth() + 1).padStart(2, "0");
  const day = String(time.getUTCDate()).padStart(2, "0");
  const hour = String(time.getUTCHours()).padStart(2, "0");
  return `${year}-${month}-${day}T${hour}:00`;
}

function closestOpenMeteoHourlyIndex(times: string[], targetMs: number, offsetMs: number): number {
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  times.forEach((iso, index) => {
    const localAsUtc = parseOpenMeteoLocalTime(iso, offsetMs);
    if (localAsUtc === undefined) {
      return;
    }
    const distance = Math.abs(localAsUtc - targetMs);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  });
  return bestIndex;
}

function parseOpenMeteoLocalTime(value: string | undefined, offsetMs: number): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = new Date(`${value}:00Z`).getTime();
  return Number.isFinite(parsed) ? parsed - offsetMs : undefined;
}

async function loadCachedJson<T>(cacheKey: string, ttlMs: number, url: string, signal: AbortSignal | undefined, label: string): Promise<T> {
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
  const cached = await readPersistentCache<T>(cacheKey);
  if (cached) {
    return cached;
  }
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }

  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`${label} returned ${response.status}`);
  }
  const body = (await response.json()) as T;
  await writePersistentCache(cacheKey, body, ttlMs);
  return body;
}

function cloudCacheKey(source: string, location: LocationPoint, credential: string): string {
  return ["cloud", source, credentialFingerprint(credential), cloudLocationBucket(location)].join(":");
}

function openMeteoGridCacheKey(location: LocationPoint, targetHour: string, credential: string, url: string): string {
  return [
    "cloud",
    "openMeteoGrid",
    credentialFingerprint(credential),
    targetHour,
    cloudPreciseLocationBucket(location),
    hashNumber(url).toString(36)
  ].join(":");
}

function cloudLocationBucket(location: LocationPoint): string {
  const lat = Math.round(location.lat * CLOUD_LOCATION_PRECISION) / CLOUD_LOCATION_PRECISION;
  const lon = Math.round(location.lon * CLOUD_LOCATION_PRECISION) / CLOUD_LOCATION_PRECISION;
  return `${lat.toFixed(1)},${lon.toFixed(1)}`;
}

function cloudPreciseLocationBucket(location: LocationPoint): string {
  return `${location.lat.toFixed(3)},${location.lon.toFixed(3)}`;
}

function credentialFingerprint(credential: string): string {
  const trimmed = credential.trim();
  return trimmed ? hashNumber(trimmed).toString(36) : "public";
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (error instanceof DOMException && error.name === "AbortError");
}
