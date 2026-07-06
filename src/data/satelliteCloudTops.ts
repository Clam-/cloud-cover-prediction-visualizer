import type { Dataset, File as H5File } from "h5wasm";
import {
  buildGridSamples,
  clamp,
  degreesToRadians,
  hashNumber,
  localOffset,
  normalizeLongitude,
  offsetLocation,
  radiansToDegrees,
  seededRandom,
  type GridSample
} from "../geo";
import type { CloudLayer, CloudSnapshot, CloudVolume, LocationPoint } from "../types";
import { errorMessage, fetchCachedBlob, isAbortError, loadCachedText, throwIfAborted } from "./cache";

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

interface GoesGrid {
  data: Uint16Array | Int16Array;
  dqf?: Uint8Array | Int8Array;
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

export interface RealtimeSatelliteCloudTops {
  apply(snapshot: CloudSnapshot): Promise<CloudSnapshot>;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const SATELLITE_GRID_RESOLUTION = 7;
const SATELLITE_GRID_SPACING_METERS = 12000;
const SATELLITE_MIN_COVER = 12;
// The ACHA product carries no cloud-fraction information, so satellite-top
// volumes use a fixed nominal cover rather than a value derived from DQF.
const SATELLITE_TOP_COVER = 82;
const GOES_PRODUCT = "ABI-L2-ACHAF";
const GOES_AVAILABILITY_DELAY_MS = 18 * 60 * 1000;
const GOES_LOOKBACK_HOURS = 8;
const GOES_LISTING_TTL_MS = 5 * 60 * 1000;
const GOES_FILE_TTL_MS = 45 * 60 * 1000;
const GOES_CLOUD_CACHE_NAME = "goes-cloud-top-height-v1";
// Retrievals degrade sharply approaching the ~81.3 degree geostationary earth
// limb, so stop well short of it and of the poles.
const MAX_SATELLITE_CENTRAL_ANGLE_DEGREES = 80;
const MAX_SATELLITE_LATITUDE_DEGREES = 62;

const GOES_SOURCES: GoesCloudTopSource[] = [
  { kind: "goes", bucket: "noaa-goes19", label: "GOES-19 CTH", longitude: -75 },
  { kind: "goes", bucket: "noaa-goes18", label: "GOES-18 CTH", longitude: -137 }
];
const HIMAWARI_SOURCE: HimawariCloudTopSource = {
  kind: "himawari",
  label: "Himawari CTH proxy",
  longitude: 140.7
};
const SATELLITE_SOURCES: SatelliteCloudTopSource[] = [...GOES_SOURCES, HIMAWARI_SOURCE];

let h5wasmPromise: Promise<(typeof import("h5wasm"))["default"]> | undefined;
let decodedGoesGrid: { cacheKey: string; grid: GoesGrid } | undefined;

export function beginRealtimeSatelliteCloudTops(
  location: LocationPoint,
  time: Date,
  signal?: AbortSignal
): RealtimeSatelliteCloudTops | undefined {
  const source = satelliteCloudTopSource(location);
  if (!source) {
    return undefined;
  }

  if (source.kind === "goes") {
    // Start the GOES download immediately so it overlaps the base cloud load;
    // the settled wrapper keeps an early failure from becoming an unhandled
    // rejection while the base load is still in flight.
    const pending: Promise<{ value: SatelliteOverlay | undefined } | { error: unknown }> = loadGoesCloudTopOverlay(
      source,
      location,
      time,
      signal
    ).then(
      (value) => ({ value }),
      (error: unknown) => ({ error })
    );
    return satelliteCloudTopApplier(source, signal, async () => {
      const settled = await pending;
      if ("error" in settled) {
        throw settled.error;
      }
      return settled.value;
    });
  }

  return satelliteCloudTopApplier(source, signal, async (snapshot) => buildHimawariCloudTopOverlay(source, snapshot, location, time));
}

function satelliteCloudTopApplier(
  source: SatelliteCloudTopSource,
  signal: AbortSignal | undefined,
  loadOverlay: (snapshot: CloudSnapshot) => Promise<SatelliteOverlay | undefined>
): RealtimeSatelliteCloudTops {
  return {
    async apply(snapshot: CloudSnapshot): Promise<CloudSnapshot> {
      if (snapshot.dataMode !== "realtime") {
        return snapshot;
      }
      try {
        const overlay = await loadOverlay(snapshot);
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
  };
}

async function loadH5Wasm(): Promise<(typeof import("h5wasm"))["default"]> {
  h5wasmPromise ??= import("h5wasm").then((module) => module.default);
  return h5wasmPromise;
}

function satelliteCloudTopSource(location: LocationPoint): SatelliteCloudTopSource | undefined {
  if (Math.abs(location.lat) > MAX_SATELLITE_LATITUDE_DEGREES) {
    return undefined;
  }
  const covering = SATELLITE_SOURCES.map((source) => ({
    source,
    centralAngle: satelliteCentralAngleDegrees(location, source.longitude)
  }))
    .filter((candidate) => candidate.centralAngle <= MAX_SATELLITE_CENTRAL_ANGLE_DEGREES)
    .sort((a, b) => a.centralAngle - b.centralAngle);
  return covering[0]?.source;
}

function satelliteCentralAngleDegrees(location: LocationPoint, satelliteLongitude: number): number {
  const latitude = degreesToRadians(location.lat);
  const lonDistance = degreesToRadians(longitudeDistanceDegrees(location.lon, satelliteLongitude));
  return radiansToDegrees(Math.acos(clamp(Math.cos(latitude) * Math.cos(lonDistance), -1, 1)));
}

async function loadGoesCloudTopOverlay(
  source: GoesCloudTopSource,
  location: LocationPoint,
  time: Date,
  signal: AbortSignal | undefined
): Promise<SatelliteOverlay | undefined> {
  const key = await latestGoesCloudTopKey(source, time, signal);
  const grid = await loadGoesCloudTopGrid(source, key, signal);
  const samples = buildGridSamples(location, SATELLITE_GRID_RESOLUTION, SATELLITE_GRID_SPACING_METERS);
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
    const xml = await loadCachedText(goesListingCacheKey(source, prefix), GOES_LISTING_TTL_MS, url, signal, `${source.label} listing`);
    const keys = parseS3Keys(xml).filter((key) => key.endsWith(".nc"));
    if (keys.length) {
      return keys[keys.length - 1];
    }
  }
  throw new Error("recent NOAA S3 files were not listed");
}

async function loadGoesCloudTopGrid(source: GoesCloudTopSource, key: string, signal: AbortSignal | undefined): Promise<GoesGrid> {
  throwIfAborted(signal);
  const cacheKey = `${source.bucket}:${key}`;
  if (decodedGoesGrid?.cacheKey === cacheKey) {
    return decodedGoesGrid.grid;
  }

  const url = `https://${source.bucket}.s3.amazonaws.com/${key}`;
  const blob = await fetchCachedBlob(GOES_CLOUD_CACHE_NAME, url, GOES_FILE_TTL_MS, signal);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  throwIfAborted(signal);

  const h5wasm = await loadH5Wasm();
  const { FS } = await h5wasm.ready;
  const fileName = `goes-cloud-top-${hashNumber(cacheKey).toString(36)}.nc`;
  try {
    try {
      FS.unlink(fileName);
    } catch {
      undefined;
    }
    FS.writeFile(fileName, bytes);
    const file = new h5wasm.File(fileName, "r");
    try {
      const grid = readGoesCloudTopGrid(file);
      decodedGoesGrid = { cacheKey, grid };
      return grid;
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

  // GOES-R L2 files pack variables as signed shorts flagged `_Unsigned = "true"`;
  // h5wasm surfaces them as Int16Array with attribute values in the signed domain,
  // so both the data and its fill/valid-range attributes need reinterpreting.
  const unsigned = isUnsignedPacked(height);
  const toRawDomain = unsigned ? unsignedShortDomain : (value: number) => value;
  const data = packedShortValues(height, unsigned, "HT");
  const dqfDataset = file.get("DQF");
  const dqf = isDataset(dqfDataset) ? packedByteValues(dqfDataset, "DQF") : undefined;
  const validRange = numberArrayAttr(height, "valid_range");
  const semiMajorAxis = numberAttr(projection, "semi_major_axis");
  const semiMinorAxis = numberAttr(projection, "semi_minor_axis");
  const perspectivePointHeight = numberAttr(projection, "perspective_point_height");
  const subpointLongitude = numberAttr(projection, "longitude_of_projection_origin");

  return {
    data,
    dqf,
    fillValue: toRawDomain(numberAttr(height, "_FillValue")),
    heightOffset: numberAttr(height, "add_offset"),
    heightScale: numberAttr(height, "scale_factor"),
    projection: {
      heightFromEarthCenter: perspectivePointHeight + semiMajorAxis,
      semiMajorAxis,
      semiMinorAxis,
      subpointLongitudeRadians: degreesToRadians(subpointLongitude)
    },
    rows: shape[0],
    validMax: validRange[1] !== undefined ? toRawDomain(validRange[1]) : Number.POSITIVE_INFINITY,
    validMin: validRange[0] !== undefined ? toRawDomain(validRange[0]) : Number.NEGATIVE_INFINITY,
    xOffset: numberAttr(x, "add_offset"),
    xScale: numberAttr(x, "scale_factor"),
    yOffset: numberAttr(y, "add_offset"),
    yScale: numberAttr(y, "scale_factor")
  };
}

function goesSampleToVolume(grid: GoesGrid, sample: GridSample): CloudVolume[] {
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
  return [
    {
      lat: sample.lat,
      lon: sample.lon,
      east: sample.east,
      north: sample.north,
      cover: SATELLITE_TOP_COVER,
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
  const latitude = degreesToRadians(location.lat);
  const longitude = degreesToRadians(location.lon);
  const longitudeOffset = longitude - projection.subpointLongitudeRadians;
  const equatorialRadius = projection.semiMajorAxis;
  const polarRadius = projection.semiMinorAxis;
  const eccentricitySquared = (equatorialRadius ** 2 - polarRadius ** 2) / equatorialRadius ** 2;
  const geocentricLatitude = Math.atan((polarRadius ** 2 / equatorialRadius ** 2) * Math.tan(latitude));
  const earthRadius = polarRadius / Math.sqrt(1 - eccentricitySquared * Math.cos(geocentricLatitude) ** 2);
  const sx = projection.heightFromEarthCenter - earthRadius * Math.cos(geocentricLatitude) * Math.cos(longitudeOffset);
  const sy = -earthRadius * Math.cos(geocentricLatitude) * Math.sin(longitudeOffset);
  const sz = earthRadius * Math.sin(geocentricLatitude);

  // GOES-R PUG visibility check: points beyond the earth limb would otherwise
  // project onto valid-looking scan angles that belong to a different location.
  const h = projection.heightFromEarthCenter;
  if (h * (h - sx) < sy ** 2 + (equatorialRadius ** 2 / polarRadius ** 2) * sz ** 2) {
    return undefined;
  }

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
        cover: layer.cover,
        altitudeMeters: layer.altitudeMeters,
        // These are typical layer heights, not observations, so anchor them to
        // the ground: fixed sea-level altitudes would sit below elevated terrain.
        altitudeReference: "ground",
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

function packedShortValues(dataset: Dataset, unsigned: boolean, label: string): Uint16Array | Int16Array {
  const value = dataset.value;
  if (value instanceof Uint16Array) {
    return value;
  }
  if (value instanceof Int16Array) {
    return unsigned ? new Uint16Array(value.buffer, value.byteOffset, value.length) : value;
  }
  throw new Error(`GOES CTH ${label} field had an unexpected data type`);
}

function packedByteValues(dataset: Dataset, label: string): Uint8Array | Int8Array {
  const value = dataset.value;
  if (value instanceof Uint8Array || value instanceof Int8Array) {
    return value;
  }
  throw new Error(`GOES CTH ${label} field had an unexpected data type`);
}

function isUnsignedPacked(dataset: Dataset): boolean {
  const raw = dataset.attrs["_Unsigned"]?.value;
  const text = typeof raw === "string" ? raw : Array.isArray(raw) ? raw[0] : undefined;
  return typeof text === "string" && text.toLowerCase() === "true";
}

function unsignedShortDomain(value: number): number {
  return value < 0 ? value + 0x10000 : value;
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

function longitudeDistanceDegrees(a: number, b: number): number {
  return Math.abs(normalizeLongitude(a - b));
}
