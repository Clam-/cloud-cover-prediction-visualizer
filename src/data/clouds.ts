import { clamp, hashNumber, offsetLocation, seededRandom } from "../geo";
import { readPersistentCache, writePersistentCache } from "./cache";
import { hrrrZarrCoversLocation, loadHrrrZarrClouds } from "./hrrr";
import { withRealtimeSatelliteCloudTops } from "./satelliteCloudTops";
import type { CloudDataMode, CloudLayer, CloudSnapshot, CloudSource, CloudVolume, LocationPoint, Settings } from "../types";

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

interface ApproximateCloudLayer {
  altitudeMeters: number;
  layer: CloudLayer;
  thicknessMeters: number;
}

interface LayerCloudSample {
  cover: number;
  layer: CloudLayer;
  sample: CloudGridSample;
}

interface OpenMeteoCloudSourceConfig {
  endpointPath: string;
  hourlyVariables: string[];
  models?: string;
  requestLabel: string;
  sourceKey: CloudSource;
  sourceLabel: string;
}

const OPEN_METEO_GRID_TTL_MS = 90 * 60 * 1000;
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
const APPROXIMATE_CLOUD_LAYERS: ApproximateCloudLayer[] = [
  { layer: "low", altitudeMeters: 1200, thicknessMeters: 850 },
  { layer: "mid", altitudeMeters: 4200, thicknessMeters: 1300 },
  { layer: "high", altitudeMeters: 8300, thicknessMeters: 1600 }
];
const OPEN_METEO_GRID_HOURLY_VARIABLES = [
  "cloud_cover",
  "cloud_cover_low",
  "cloud_cover_mid",
  "cloud_cover_high",
  ...PRESSURE_CLOUD_LEVELS.flatMap((level) => [`cloud_cover_${level.hpa}hPa`, `geopotential_height_${level.hpa}hPa`])
];
const OPEN_METEO_LAYER_HOURLY_VARIABLES = ["cloud_cover", "cloud_cover_low", "cloud_cover_mid", "cloud_cover_high"];
const OPEN_METEO_ECMWF_CONFIG: OpenMeteoCloudSourceConfig = {
  endpointPath: "/v1/forecast",
  hourlyVariables: OPEN_METEO_GRID_HOURLY_VARIABLES,
  models: "ecmwf_ifs",
  requestLabel: "Open-Meteo ECMWF IFS cloud grid",
  sourceKey: "openMeteoEcmwf",
  sourceLabel: "Open-Meteo ECMWF IFS Grid"
};
const OPEN_METEO_CLOUD_SOURCE_CONFIGS: Record<Exclude<CloudSource, "hrrrZarr">, OpenMeteoCloudSourceConfig> = {
  openMeteoGrid: {
    endpointPath: "/v1/forecast",
    hourlyVariables: OPEN_METEO_GRID_HOURLY_VARIABLES,
    requestLabel: "Open-Meteo best-match cloud grid",
    sourceKey: "openMeteoGrid",
    sourceLabel: "Open-Meteo Best Match Grid"
  },
  openMeteoEcmwf: OPEN_METEO_ECMWF_CONFIG,
  openMeteoBom: {
    endpointPath: "/v1/bom",
    hourlyVariables: OPEN_METEO_LAYER_HOURLY_VARIABLES,
    requestLabel: "BoM ACCESS-G cloud grid",
    sourceKey: "openMeteoBom",
    sourceLabel: "BoM ACCESS-G Grid"
  }
};

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
    let snapshot: CloudSnapshot;
    if (settings.cloudSource === "hrrrZarr") {
      snapshot = await loadHrrrZarrCloudsWithGlobalFallback(location, time, signal, mode, settings);
    } else if (settings.cloudSource === "openMeteoBom") {
      snapshot = await loadOpenMeteoCloudsWithGlobalFallback(
        location,
        time,
        settings,
        signal,
        mode,
        OPEN_METEO_CLOUD_SOURCE_CONFIGS.openMeteoBom
      );
    } else {
      snapshot = await loadOpenMeteoGridClouds(
        location,
        time,
        settings,
        signal,
        mode,
        OPEN_METEO_CLOUD_SOURCE_CONFIGS[settings.cloudSource]
      );
    }
    return await withRealtimeSatelliteCloudTops(snapshot, location, time, signal);
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

async function loadHrrrZarrCloudsWithGlobalFallback(
  location: LocationPoint,
  time: Date,
  signal: AbortSignal | undefined,
  mode: CloudDataMode,
  settings: Settings
): Promise<CloudSnapshot> {
  if (!hrrrZarrCoversLocation(location)) {
    const fallback = await loadOpenMeteoGridClouds(location, time, settings, signal, mode, OPEN_METEO_ECMWF_CONFIG);
    return withCloudWarning(fallback, "NOAA HRRR Zarr covers the contiguous United States only");
  }

  try {
    return await loadHrrrZarrClouds(location, time, signal, mode);
  } catch (error) {
    if (isAbortError(error, signal)) {
      throw error;
    }
    const warning = errorMessage(error, "NOAA HRRR Zarr cloud grid failed");
    try {
      const fallback = await loadOpenMeteoGridClouds(location, time, settings, signal, mode, OPEN_METEO_ECMWF_CONFIG);
      return withCloudWarning(fallback, warning);
    } catch (fallbackError) {
      throw new Error(`${warning}; fallback failed: ${errorMessage(fallbackError, "Open-Meteo ECMWF IFS cloud grid failed")}`);
    }
  }
}

async function loadOpenMeteoCloudsWithGlobalFallback(
  location: LocationPoint,
  time: Date,
  settings: Settings,
  signal: AbortSignal | undefined,
  mode: CloudDataMode,
  config: OpenMeteoCloudSourceConfig
): Promise<CloudSnapshot> {
  try {
    return await loadOpenMeteoGridClouds(location, time, settings, signal, mode, config);
  } catch (error) {
    if (isAbortError(error, signal)) {
      throw error;
    }
    const warning = errorMessage(error, `${config.sourceLabel} failed`);
    try {
      const fallback = await loadOpenMeteoGridClouds(location, time, settings, signal, mode, OPEN_METEO_ECMWF_CONFIG);
      return withCloudWarning(fallback, warning);
    } catch (fallbackError) {
      throw new Error(`${warning}; fallback failed: ${errorMessage(fallbackError, "Open-Meteo ECMWF IFS cloud grid failed")}`);
    }
  }
}

async function loadOpenMeteoGridClouds(
  location: LocationPoint,
  time: Date,
  settings: Settings,
  signal?: AbortSignal,
  mode: CloudDataMode = "prediction",
  config: OpenMeteoCloudSourceConfig = OPEN_METEO_CLOUD_SOURCE_CONFIGS.openMeteoGrid
): Promise<CloudSnapshot> {
  const endpoint = settings.apiKeys.openMeteo
    ? `https://customer-api.open-meteo.com${config.endpointPath}`
    : `https://api.open-meteo.com${config.endpointPath}`;
  const samples = buildCloudGridSamples(location);
  const targetHour = formatOpenMeteoUtcHour(time);
  const params = new URLSearchParams({
    latitude: samples.map((sample) => sample.lat.toFixed(5)).join(","),
    longitude: samples.map((sample) => sample.lon.toFixed(5)).join(","),
    hourly: config.hourlyVariables.join(","),
    start_hour: targetHour,
    end_hour: targetHour,
    timezone: "GMT",
    cell_selection: "nearest"
  });
  if (config.models) {
    params.set("models", config.models);
  }
  if (settings.apiKeys.openMeteo) {
    params.set("apikey", settings.apiKeys.openMeteo);
  }

  const url = `${endpoint}?${params.toString()}`;
  const body = await loadCachedJson<OpenMeteoGridPointBody | OpenMeteoGridPointBody[]>(
    openMeteoGridCacheKey(config.sourceKey, location, targetHour, settings.apiKeys.openMeteo, url),
    OPEN_METEO_GRID_TTL_MS,
    url,
    signal,
    config.requestLabel
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
  const layerSamples: LayerCloudSample[] = [];
  const modeledLayerKeys = new Set<string>();

  points.forEach((point, index) => {
    const sample = samples[index];
    const hourly = point.hourly;
    if (!sample || !hourly?.time?.length) {
      return;
    }
    const offsetMs = (point.utc_offset_seconds ?? 0) * 1000;
    const bestIndex = closestOpenMeteoHourlyIndex(hourly.time, time.getTime(), offsetMs);
    pushDefinedPercent(totals, readHourlyPercent(hourly, "cloud_cover", bestIndex));
    const low = readHourlyPercent(hourly, "cloud_cover_low", bestIndex);
    const mid = readHourlyPercent(hourly, "cloud_cover_mid", bestIndex);
    const high = readHourlyPercent(hourly, "cloud_cover_high", bestIndex);
    pushDefinedPercent(lows, low);
    pushDefinedPercent(mids, mid);
    pushDefinedPercent(highs, high);
    pushLayerSample(layerSamples, sample, "low", low);
    pushLayerSample(layerSamples, sample, "mid", mid);
    pushLayerSample(layerSamples, sample, "high", high);

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
        layer: level.layer,
        volumeType: "modeled"
      });
      modeledLayerKeys.add(layerSampleKey(sample, level.layer));
    }
  });
  const approximateVolumes = buildApproximateLayerVolumes(layerSamples, modeledLayerKeys);
  volumes.push(...approximateVolumes);

  if (!totals.length && !volumes.length) {
    throw new Error("Open-Meteo grid response did not include usable cloud pixels");
  }

  const warning = openMeteoApproximateVolumeWarning(config, points, approximateVolumes);
  return {
    time,
    dataMode: mode,
    total: averagePercent(totals.length ? totals : volumes.map((volume) => volume.cover)),
    low: averagePercent(lows.length ? lows : volumes.filter((volume) => volume.layer === "low").map((volume) => volume.cover)),
    mid: averagePercent(mids.length ? mids : volumes.filter((volume) => volume.layer === "mid").map((volume) => volume.cover)),
    high: averagePercent(highs.length ? highs : volumes.filter((volume) => volume.layer === "high").map((volume) => volume.cover)),
    sourceLabel: config.sourceLabel,
    map: {
      radiusMeters: CLOUD_GRID_SPACING_METERS * Math.floor(CLOUD_GRID_RESOLUTION / 2),
      resolution: CLOUD_GRID_RESOLUTION,
      spacingMeters: CLOUD_GRID_SPACING_METERS,
      volumes
    },
    ...(warning ? { warning } : {})
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

function pushLayerSample(
  layerSamples: LayerCloudSample[],
  sample: CloudGridSample,
  layer: CloudLayer,
  cover: number | undefined
): void {
  if (cover !== undefined && cover >= MIN_GRID_VOLUME_COVER) {
    layerSamples.push({ sample, layer, cover });
  }
}

function buildApproximateLayerVolumes(layerSamples: LayerCloudSample[], modeledLayerKeys: Set<string>): CloudVolume[] {
  return layerSamples
    .filter(({ layer, sample }) => !modeledLayerKeys.has(layerSampleKey(sample, layer)))
    .map(({ cover, layer, sample }) => {
      const approximateLayer = APPROXIMATE_CLOUD_LAYERS.find((candidate) => candidate.layer === layer);
      const altitudeMeters = approximateLayer?.altitudeMeters ?? 4200;
      const baseThickness = approximateLayer?.thicknessMeters ?? 1100;
      return {
        lat: sample.lat,
        lon: sample.lon,
        east: sample.east,
        north: sample.north,
        cover,
        altitudeMeters,
        altitudeReference: "seaLevel",
        radiusMeters: CLOUD_GRID_SPACING_METERS * clamp(0.28 + cover / 170, 0.36, 0.84),
        thicknessMeters: baseThickness * clamp(0.72 + cover / 150, 0.76, 1.34),
        layer,
        volumeType: "approximate"
      };
    });
}

function layerSampleKey(sample: CloudGridSample, layer: CloudLayer): string {
  return `${sample.row}:${sample.column}:${layer}`;
}

function openMeteoApproximateVolumeWarning(
  config: OpenMeteoCloudSourceConfig,
  points: OpenMeteoGridPointBody[],
  approximateVolumes: CloudVolume[]
): string | undefined {
  if (!approximateVolumes.length) {
    return undefined;
  }
  if (!config.hourlyVariables.some(isPressureCloudVariable)) {
    return `${config.sourceLabel} provides layer cloud percentages only, so approximate layer volumes are shown in magenta`;
  }
  const hasPressureLevelFields = points.some((point) =>
    PRESSURE_CLOUD_LEVELS.some((level) => Array.isArray(point.hourly?.[`cloud_cover_${level.hpa}hPa`]))
  );
  if (!hasPressureLevelFields) {
    return `${config.sourceLabel} did not return pressure-level cloud fields, so approximate layer volumes are shown in magenta`;
  }
  return `${config.sourceLabel} has layer cloud cover without matching pressure-level volume pixels, so approximate layer volumes are shown in magenta`;
}

function isPressureCloudVariable(variable: string): boolean {
  return /^cloud_cover_\d+hPa$/.test(variable);
}

function withCloudWarning(snapshot: CloudSnapshot, warning: string): CloudSnapshot {
  return {
    ...snapshot,
    warning: snapshot.warning ? `${warning}; ${snapshot.warning}` : warning
  };
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

function openMeteoGridCacheKey(sourceKey: string, location: LocationPoint, targetHour: string, credential: string, url: string): string {
  return [
    "cloud",
    sourceKey,
    credentialFingerprint(credential),
    targetHour,
    cloudPreciseLocationBucket(location),
    hashNumber(url).toString(36)
  ].join(":");
}

function cloudPreciseLocationBucket(location: LocationPoint): string {
  return `${location.lat.toFixed(3)},${location.lon.toFixed(3)}`;
}

function credentialFingerprint(credential: string): string {
  const trimmed = credential.trim();
  return trimmed ? hashNumber(trimmed).toString(36) : "public";
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (error instanceof DOMException && error.name === "AbortError");
}
