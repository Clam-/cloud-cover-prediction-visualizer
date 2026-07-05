import type { Dataset, File as H5File } from "h5wasm";
import { clamp, hashNumber, localOffset, offsetLocation, seededRandom } from "../geo";
import type { CloudLayer, CloudSnapshot, CloudVolume, LocationPoint } from "../types";
import { fetchCachedBlob, readPersistentCache, writePersistentCache } from "./cache";

type SatelliteCloudTopSource = GoesCloudTopSource | HimawariCloudTopSource;

interface GoesCloudTopSource {
  bucket: string;
  kind: "goes";
  label: string;
  longitude: number;
}

interface HimawariCloudTopSource {
  kind: "himawari";
  label: string;
  longitude: number;
}

interface CloudTopSample extends LocationPoint {
  east: number;
  north: number;
}

interface GoesGrid {
  data: Uint16Array;
  dqf?: Uint8Array;
  fillValue: number;
  heightOffset: number;
  heightScale: number;
  projection: GoesProjection;
  rows: number;
  validMax: number;
  validMin: number;
  xOffset: number;
  xScale: number;
  yOffset: number;
  yScale: number;
}

interface GoesProjection {
  heightFromEarthCenter: number;
  semiMajorAxis: number;
  semiMinorAxis: number;
  subpointLongitudeRadians: number;
}

interface SatelliteOverlay {
  label: string;
  volumes: CloudVolume[];
  warning?: string;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const SATELLITE_GRID_RESOLUTION = 7;
const SATELLITE_GRID_SPACING_METERS = 12000;
const SATELLITE_MIN_COVER = 12;
const GOES_PRODUCT = "ABI-L2-ACHAF";
const GOES_AVAILABILITY_DELAY_MS = 18 * 60 * 1000;
const GOES_LOOKBACK_HOURS = 8;
const GOES_LISTING_TTL_MS = 5 * 60 * 1000;
const GOES_FILE_TTL_MS = 45 * 60 * 1000;
const GOES_CLOUD_CACHE_NAME = "goes-cloud-top-height-v1";
const HIMAWARI_MIN_LAT = -62;
const HIMAWARI_MAX_LAT = 62;
const GOES_MIN_LAT = -62;
const GOES_MAX_LAT = 62;

const GOES_SOURCES: GoesCloudTopSource[] = [
  { kind: "goes", bucket: "noaa-goes19", label: "GOES-19 CTH", longitude: -75 },
  { kind: "goes", bucket: "noaa-goes18", label: "GOES-18 CTH", longitude: -137 }
];
const HIMAWARI_SOURCE: HimawariCloudTopSource = {
  kind: "himawari",
  label: "Himawari CTH proxy",
  longitude: 140.7
};

let h5wasmPromise: Promise<(typeof import("h5wasm"))["default"]> | undefined;

export async function withRealtimeSatelliteCloudTops(
  snapshot: CloudSnapshot,
  location: LocationPoint,
  time: Date,
  signal?: AbortSignal
): Promise<CloudSnapshot> {
  if (snapshot.dataMode !== "realtime") {
    return snapshot;
  }

  const source = satelliteCloudTopSource(location);
  if (!source) {
    return snapshot;
  }

  try {
    const overlay =
      source.kind === "goes"
        ? await loadGoesCloudTopOverlay(source, location, time, signal)
        : buildHimawariCloudTopOverlay(source, snapshot, location, time);
    return overlay ? snapshotWithSatelliteOverlay(snapshot, overlay) : snapshot;
  } catch (error) {
    if (isAbortError(error, signal)) {
      throw error;
    }
    return {
      ...snapshot,
      satelliteTopWarning: `${source.label} overlay unavailable: ${errorMessage(error, "satellite cloud-top load failed")}`
    };
  }
}

async function loadH5Wasm(): Promise<(typeof import("h5wasm"))["default"]> {
  h5wasmPromise ??= import("h5wasm").then((module) => module.default);
  return h5wasmPromise;
}

function satelliteCloudTopSource(location: LocationPoint): SatelliteCloudTopSource | undefined {
  const goesSources = GOES_SOURCES.filter((source) => goesSourceCoversLocation(source, location));
  if (goesSources.length) {
    return goesSources.sort((a, b) => longitudeDistance(location.lon, a.longitude) - longitudeDistance(location.lon, b.longitude))[0];
  }
  return himawariCoversLocation(location) ? HIMAWARI_SOURCE : undefined;
}

function goesSourceCoversLocation(source: GoesCloudTopSource, location: LocationPoint): boolean {
  if (location.lat < GOES_MIN_LAT || location.lat > GOES_MAX_LAT) {
    return false;
  }
  return longitudeDistance(location.lon, source.longitude) <= 82;
}

function himawariCoversLocation(location: LocationPoint): boolean {
  return location.lat >= HIMAWARI_MIN_LAT && location.lat <= HIMAWARI_MAX_LAT && longitudeDistance(location.lon, HIMAWARI_SOURCE.longitude) <= 82;
}

async function loadGoesCloudTopOverlay(
  source: GoesCloudTopSource,
  location: LocationPoint,
  time: Date,
  signal: AbortSignal | undefined
): Promise<SatelliteOverlay | undefined> {
  const key = await latestGoesCloudTopKey(source, time, signal);
  const grid = await loadGoesCloudTopGrid(source, key, signal);
  const samples = buildSatelliteSamples(location);
  const volumes = samples.flatMap((sample) => goesSampleToVolume(grid, sample));
  if (!volumes.length) {
    return undefined;
  }
  return {
    label: source.label,
    volumes
  };
}

async function latestGoesCloudTopKey(source: GoesCloudTopSource, time: Date, signal: AbortSignal | undefined): Promise<string> {
  const startMs = Math.min(time.getTime(), Date.now()) - GOES_AVAILABILITY_DELAY_MS;
  for (let offset = 0; offset <= GOES_LOOKBACK_HOURS; offset += 1) {
    const candidate = new Date(startMs - offset * HOUR_MS);
    const { year, dayOfYear, hour } = utcPathParts(candidate);
    const prefix = `${GOES_PRODUCT}/${year}/${dayOfYear}/${hour}/`;
    const url = `https://${source.bucket}.s3.amazonaws.com/?list-type=2&prefix=${prefix}&max-keys=1000`;
    const xml = await loadCachedText(goesListingCacheKey(source, prefix), GOES_LISTING_TTL_MS, url, signal, source.label);
    const keys = parseS3Keys(xml).filter((key) => key.endsWith(".nc"));
    if (keys.length) {
      return keys[keys.length - 1];
    }
  }
  throw new Error("recent NOAA S3 files were not listed");
}

async function loadGoesCloudTopGrid(source: GoesCloudTopSource, key: string, signal: AbortSignal | undefined): Promise<GoesGrid> {
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }

  const url = `https://${source.bucket}.s3.amazonaws.com/${key}`;
  const blob = await fetchCachedBlob(GOES_CLOUD_CACHE_NAME, url, GOES_FILE_TTL_MS, signal);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }

  const h5wasm = await loadH5Wasm();
  const { FS } = await h5wasm.ready;
  const fileName = `goes-cloud-top-${hashNumber(`${source.bucket}:${key}`).toString(36)}.nc`;
  try {
    try {
      FS.unlink(fileName);
    } catch {
      undefined;
    }
    FS.writeFile(fileName, bytes);
    const file = new h5wasm.File(fileName, "r");
    try {
      return readGoesCloudTopGrid(file);
    } finally {
      file.close();
    }
  } finally {
    try {
      FS.unlink(fileName);
    } catch {
      undefined;
    }
  }
}

function readGoesCloudTopGrid(file: H5File): GoesGrid {
  const height = requiredDataset(file, "HT");
  const x = requiredDataset(file, "x");
  const y = requiredDataset(file, "y");
  const projection = requiredDataset(file, "goes_imager_projection");
  const shape = height.shape;
  if (!shape || shape.length !== 2) {
    throw new Error("GOES CTH grid did not include a 2D height field");
  }

  const data = typedArrayValue<Uint16Array>(height, Uint16Array, "HT");
  const dqfDataset = file.get("DQF");
  const dqf = isDataset(dqfDataset) ? typedArrayValue<Uint8Array>(dqfDataset, Uint8Array, "DQF") : undefined;
  const validRange = numberArrayAttr(height, "valid_range");
  const semiMajorAxis = numberAttr(projection, "semi_major_axis");
  const semiMinorAxis = numberAttr(projection, "semi_minor_axis");
  const perspectivePointHeight = numberAttr(projection, "perspective_point_height");
  const subpointLongitude = numberAttr(projection, "longitude_of_projection_origin");

  return {
    data,
    dqf,
    fillValue: numberAttr(height, "_FillValue"),
    heightOffset: numberAttr(height, "add_offset"),
    heightScale: numberAttr(height, "scale_factor"),
    projection: {
      heightFromEarthCenter: perspectivePointHeight + semiMajorAxis,
      semiMajorAxis,
      semiMinorAxis,
      subpointLongitudeRadians: (subpointLongitude * Math.PI) / 180
    },
    rows: shape[0],
    validMax: validRange[1] ?? Number.POSITIVE_INFINITY,
    validMin: validRange[0] ?? Number.NEGATIVE_INFINITY,
    xOffset: numberAttr(x, "add_offset"),
    xScale: numberAttr(x, "scale_factor"),
    yOffset: numberAttr(y, "add_offset"),
    yScale: numberAttr(y, "scale_factor")
  };
}

function goesSampleToVolume(grid: GoesGrid, sample: CloudTopSample): CloudVolume[] {
  const projected = projectGoesFixedGrid(sample, grid.projection);
  if (!projected) {
    return [];
  }

  const columns = grid.data.length / grid.rows;
  const column = Math.round((projected.x - grid.xOffset) / grid.xScale);
  const row = Math.round((projected.y - grid.yOffset) / grid.yScale);
  if (row < 0 || row >= grid.rows || column < 0 || column >= columns) {
    return [];
  }

  const index = row * columns + column;
  const rawHeight = grid.data[index];
  const quality = grid.dqf?.[index];
  if (
    rawHeight === grid.fillValue ||
    rawHeight < grid.validMin ||
    rawHeight > grid.validMax ||
    (quality !== undefined && quality > 2)
  ) {
    return [];
  }

  const altitudeMeters = rawHeight * grid.heightScale + grid.heightOffset;
  if (!Number.isFinite(altitudeMeters) || altitudeMeters < 120 || altitudeMeters > 19000) {
    return [];
  }

  const layer = cloudLayerFromAltitude(altitudeMeters);
  const cover = clamp(82 - (quality ?? 0) * 12, 46, 88);
  return [
    {
      lat: sample.lat,
      lon: sample.lon,
      east: sample.east,
      north: sample.north,
      cover,
      altitudeMeters,
      altitudeReference: "seaLevel",
      radiusMeters: SATELLITE_GRID_SPACING_METERS * 0.72,
      thicknessMeters: satelliteTopThickness(layer, altitudeMeters),
      layer,
      volumeType: "satelliteTop"
    }
  ];
}

function projectGoesFixedGrid(location: Pick<LocationPoint, "lat" | "lon">, projection: GoesProjection): { x: number; y: number } | undefined {
  const latitude = (location.lat * Math.PI) / 180;
  const longitude = (location.lon * Math.PI) / 180;
  const longitudeOffset = longitude - projection.subpointLongitudeRadians;
  const equatorialRadius = projection.semiMajorAxis;
  const polarRadius = projection.semiMinorAxis;
  const eccentricitySquared = (equatorialRadius ** 2 - polarRadius ** 2) / equatorialRadius ** 2;
  const geocentricLatitude = Math.atan((polarRadius ** 2 / equatorialRadius ** 2) * Math.tan(latitude));
  const earthRadius = polarRadius / Math.sqrt(1 - eccentricitySquared * Math.cos(geocentricLatitude) ** 2);
  const sx = projection.heightFromEarthCenter - earthRadius * Math.cos(geocentricLatitude) * Math.cos(longitudeOffset);
  const sy = -earthRadius * Math.cos(geocentricLatitude) * Math.sin(longitudeOffset);
  const sz = earthRadius * Math.sin(geocentricLatitude);
  const range = Math.sqrt(sx ** 2 + sy ** 2 + sz ** 2);
  const x = Math.asin(-sy / range);
  const y = Math.atan(sz / sx);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : undefined;
}

function buildHimawariCloudTopOverlay(
  source: HimawariCloudTopSource,
  snapshot: CloudSnapshot,
  location: LocationPoint,
  time: Date
): SatelliteOverlay | undefined {
  const sourceVolumes = snapshot.map?.volumes.filter((volume) => volume.volumeType !== "satelliteTop" && volume.cover >= SATELLITE_MIN_COVER) ?? [];
  const volumes = sourceVolumes.length
    ? sourceVolumes.map((volume) => cloudVolumeToSatelliteTop(volume))
    : buildFallbackHimawariTops(snapshot, location, time);

  return volumes.length
    ? {
        label: source.label,
        volumes
      }
    : undefined;
}

function cloudVolumeToSatelliteTop(volume: CloudVolume): CloudVolume {
  const altitudeMeters = volume.altitudeMeters + volume.thicknessMeters * 0.5;
  const layer = cloudLayerFromAltitude(altitudeMeters);
  return {
    ...volume,
    altitudeMeters,
    cover: clamp(volume.cover + 8, 36, 90),
    layer,
    radiusMeters: volume.radiusMeters * 0.78,
    thicknessMeters: satelliteTopThickness(layer, altitudeMeters),
    volumeType: "satelliteTop"
  };
}

function buildFallbackHimawariTops(snapshot: CloudSnapshot, location: LocationPoint, time: Date): CloudVolume[] {
  const layers = [
    { layer: "low" as const, cover: snapshot.low, altitudeMeters: 1650 },
    { layer: "mid" as const, cover: snapshot.mid, altitudeMeters: 5050 },
    { layer: "high" as const, cover: snapshot.high, altitudeMeters: 9100 }
  ];
  const random = seededRandom(`${location.lat.toFixed(3)}:${location.lon.toFixed(3)}:${time.toISOString()}:himawari-top`);
  const volumes: CloudVolume[] = [];
  for (const layer of layers) {
    if (layer.cover < SATELLITE_MIN_COVER) {
      continue;
    }
    const count = clamp(Math.round(layer.cover / 28), 1, 4);
    for (let index = 0; index < count; index += 1) {
      const angle = random() * Math.PI * 2;
      const distance = SATELLITE_GRID_SPACING_METERS * (0.35 + random() * 2.2);
      const east = Math.cos(angle) * distance;
      const north = Math.sin(angle) * distance;
      const sample = offsetLocation(location, east, north);
      volumes.push({
        ...sample,
        ...localOffset(location, sample),
        cover: clamp(layer.cover + 6, 34, 88),
        altitudeMeters: layer.altitudeMeters,
        altitudeReference: "seaLevel",
        radiusMeters: SATELLITE_GRID_SPACING_METERS * (0.58 + random() * 0.32),
        thicknessMeters: satelliteTopThickness(layer.layer, layer.altitudeMeters),
        layer: layer.layer,
        volumeType: "satelliteTop"
      });
    }
  }
  return volumes;
}

function snapshotWithSatelliteOverlay(snapshot: CloudSnapshot, overlay: SatelliteOverlay): CloudSnapshot {
  const map = snapshot.map ?? {
    radiusMeters: SATELLITE_GRID_SPACING_METERS * Math.floor(SATELLITE_GRID_RESOLUTION / 2),
    resolution: SATELLITE_GRID_RESOLUTION,
    spacingMeters: SATELLITE_GRID_SPACING_METERS,
    volumes: []
  };

  return {
    ...snapshot,
    sourceLabel: `${snapshot.sourceLabel} + ${overlay.label}`,
    satelliteTopLabel: overlay.label,
    ...(overlay.warning ? { satelliteTopWarning: overlay.warning } : {}),
    map: {
      ...map,
      radiusMeters: Math.max(map.radiusMeters, SATELLITE_GRID_SPACING_METERS * Math.floor(SATELLITE_GRID_RESOLUTION / 2)),
      volumes: [...map.volumes, ...overlay.volumes]
    }
  };
}

function buildSatelliteSamples(location: LocationPoint): CloudTopSample[] {
  const samples: CloudTopSample[] = [];
  const half = Math.floor(SATELLITE_GRID_RESOLUTION / 2);
  for (let row = 0; row < SATELLITE_GRID_RESOLUTION; row += 1) {
    for (let column = 0; column < SATELLITE_GRID_RESOLUTION; column += 1) {
      const east = (column - half) * SATELLITE_GRID_SPACING_METERS;
      const north = (half - row) * SATELLITE_GRID_SPACING_METERS;
      samples.push({
        ...offsetLocation(location, east, north),
        east,
        north
      });
    }
  }
  return samples;
}

async function loadCachedText(
  cacheKey: string,
  ttlMs: number,
  url: string,
  signal: AbortSignal | undefined,
  label: string
): Promise<string> {
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
  const cached = await readPersistentCache<string>(cacheKey);
  if (cached) {
    return cached;
  }
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`${label} listing returned ${response.status}`);
  }
  const body = await response.text();
  await writePersistentCache(cacheKey, body, ttlMs);
  return body;
}

function parseS3Keys(xml: string): string[] {
  const document = new DOMParser().parseFromString(xml, "application/xml");
  return Array.from(document.getElementsByTagName("Key"))
    .map((node) => node.textContent?.trim() ?? "")
    .filter(Boolean);
}

function utcPathParts(date: Date): { dayOfYear: string; hour: string; year: string } {
  const year = date.getUTCFullYear();
  const day = Math.floor((Date.UTC(year, date.getUTCMonth(), date.getUTCDate()) - Date.UTC(year, 0, 1)) / DAY_MS) + 1;
  return {
    dayOfYear: String(day).padStart(3, "0"),
    hour: String(date.getUTCHours()).padStart(2, "0"),
    year: String(year)
  };
}

function requiredDataset(file: H5File, key: string): Dataset {
  const item = file.get(key);
  if (!isDataset(item)) {
    throw new Error(`GOES CTH file did not include ${key}`);
  }
  return item;
}

function isDataset(item: unknown): item is Dataset {
  return typeof item === "object" && item !== null && "attrs" in item && "shape" in item && "value" in item;
}

function typedArrayValue<T extends Uint8Array | Uint16Array>(
  dataset: Dataset,
  constructor: { new (buffer: ArrayBufferLike): T },
  label: string
): T {
  const value = dataset.value;
  if (!(value instanceof constructor)) {
    throw new Error(`GOES CTH ${label} field had an unexpected data type`);
  }
  return value;
}

function numberAttr(dataset: Dataset, name: string): number {
  const value = firstNumber(dataset.attrs[name]?.value);
  if (value === undefined) {
    throw new Error(`GOES CTH ${dataset.path} missing ${name}`);
  }
  return value;
}

function numberArrayAttr(dataset: Dataset, name: string): number[] {
  const value = dataset.attrs[name]?.value;
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    return Array.from(value as unknown as ArrayLike<number | bigint>, Number).filter(Number.isFinite);
  }
  return [];
}

function firstNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    const first = (value as unknown as ArrayLike<number | bigint>)[0];
    const numberValue = typeof first === "bigint" ? Number(first) : first;
    return typeof numberValue === "number" && Number.isFinite(numberValue) ? numberValue : undefined;
  }
  return undefined;
}

function cloudLayerFromAltitude(altitudeMeters: number): CloudLayer {
  if (altitudeMeters < 2600) {
    return "low";
  }
  return altitudeMeters < 7000 ? "mid" : "high";
}

function satelliteTopThickness(layer: CloudLayer, altitudeMeters: number): number {
  const base = layer === "low" ? 320 : layer === "mid" ? 420 : 520;
  return clamp(base + altitudeMeters / 55, 300, 760);
}

function goesListingCacheKey(source: GoesCloudTopSource, prefix: string): string {
  return ["cloud", "goesCth", source.bucket, prefix].join(":");
}

function longitudeDistance(a: number, b: number): number {
  const diff = Math.abs((((a - b + 180) % 360) + 360) % 360 - 180);
  return diff;
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (error instanceof DOMException && error.name === "AbortError");
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
