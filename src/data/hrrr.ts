import { clamp, hashNumber, offsetLocation } from "../geo";
import type { CloudDataMode, CloudLayer, CloudSnapshot, CloudVolume, LocationPoint } from "../types";
import { fetchCachedBlob, readPersistentCache, writePersistentCache } from "./cache";

type HrrrCloudFieldKey = "total" | CloudLayer;

interface HrrrCloudField {
  altitudeMeters?: number;
  key: HrrrCloudFieldKey;
  layer?: CloudLayer;
  level: string;
  parameter: string;
  thicknessMeters?: number;
}

interface HrrrRun {
  forecastHour: number;
  initHour: number;
  initMs: number;
  path: string;
}

interface HrrrCellSample extends LocationPoint {
  column: number;
  east: number;
  gridColumn: number;
  gridRow: number;
  localColumn: number;
  localRow: number;
  north: number;
  row: number;
  sampleIndex: number;
  tileColumn: number;
  tileRow: number;
}

interface CachedHrrrSnapshot {
  high: number;
  low: number;
  map: {
    radiusMeters: number;
    resolution: number;
    spacingMeters: number;
    volumes: CloudVolume[];
  };
  mid: number;
  total: number;
}

const HOUR_MS = 60 * 60 * 1000;
const HRRR_ZARR_BASE_URL = "https://hrrrzarr.s3.amazonaws.com";
const HRRR_CLOUD_CACHE_NAME = "hrrr-zarr-cloud-chunks-v1";
const HRRR_CHUNK_CACHE_TTL_MS = 14 * 24 * HOUR_MS;
const HRRR_SNAPSHOT_CACHE_TTL_MS = 6 * HOUR_MS;
const HRRR_MISSING_RUN_TTL_MS = 20 * 60 * 1000;
const HRRR_AVAILABILITY_DELAY_MS = 3 * HOUR_MS;
const HRRR_MAX_FORECAST_HOURS = 48;
const HRRR_STANDARD_FORECAST_HOURS = 18;
const HRRR_MAX_RUN_CANDIDATES = 18;
const HRRR_GRID_COLUMNS = 1799;
const HRRR_GRID_ROWS = 1059;
const HRRR_GRID_SPACING_METERS = 3000;
const HRRR_GRID_X0_METERS = -2697520.1425219304;
const HRRR_GRID_Y0_METERS = -1587306.1525566636;
const HRRR_CHUNK_COLUMNS = 150;
const HRRR_CHUNK_ROWS = 150;
const HRRR_CLOUD_GRID_RESOLUTION = 7;
const HRRR_CLOUD_GRID_SPACING_METERS = 9000;
const HRRR_MIN_VOLUME_COVER = 12;
const HRRR_FILL_VALUE = -9999;
const HRRR_LAMBERT_RADIUS_METERS = 6371229;
const HRRR_LAMBERT_LATITUDE_DEGREES = 38.5;
const HRRR_LAMBERT_LONGITUDE_DEGREES = -97.5;
const BLOSC_DOSHUFFLE = 0x01;
const BLOSC_DOBITSHUFFLE = 0x02;
const BLOSC_DONT_SPLIT = 0x10;

const HRRR_EXTENDED_RUN_HOURS = new Set([0, 6, 12, 18, 19]);
const HRRR_CLOUD_FIELDS: HrrrCloudField[] = [
  { key: "total", level: "entire_atmosphere", parameter: "TCDC" },
  { key: "low", layer: "low", level: "low_cloud_layer", parameter: "LCDC", altitudeMeters: 1200, thicknessMeters: 850 },
  { key: "mid", layer: "mid", level: "middle_cloud_layer", parameter: "MCDC", altitudeMeters: 4200, thicknessMeters: 1300 },
  { key: "high", layer: "high", level: "high_cloud_layer", parameter: "HCDC", altitudeMeters: 8300, thicknessMeters: 1600 }
];

const hrrrChunkPromises = new Map<string, Promise<Uint8Array>>();

export async function loadHrrrZarrClouds(
  location: LocationPoint,
  time: Date,
  signal?: AbortSignal,
  mode: CloudDataMode = "prediction"
): Promise<CloudSnapshot> {
  throwIfAborted(signal);

  if (!hrrrZarrCoversLocation(location)) {
    throw new Error("NOAA HRRR Zarr covers the contiguous United States only");
  }

  const samples = buildHrrrGridSamples(location);
  if (!samples.length) {
    throw new Error("NOAA HRRR Zarr does not include usable cloud pixels here");
  }

  const targetHourMs = floorUtcHourMs(time.getTime());
  const runs = buildHrrrRunCandidates(targetHourMs, Date.now());
  if (!runs.length) {
    throw new Error("NOAA HRRR Zarr is not available for that forecast hour");
  }

  let lastUnavailable: Error | undefined;
  for (const run of runs) {
    throwIfAborted(signal);
    const missingKey = hrrrMissingRunCacheKey(run);
    if (await readPersistentCache<boolean>(missingKey)) {
      continue;
    }

    const cacheKey = hrrrSnapshotCacheKey(run, location);
    const cached = await readPersistentCache<CachedHrrrSnapshot>(cacheKey);
    if (cached) {
      return hydrateHrrrSnapshot(cached, time, mode);
    }

    try {
      const snapshot = await loadHrrrRunClouds(samples, run, time, signal, mode);
      await writePersistentCache(cacheKey, dehydrateHrrrSnapshot(snapshot), HRRR_SNAPSHOT_CACHE_TTL_MS);
      return snapshot;
    } catch (error) {
      if (isAbortError(error, signal)) {
        throw error;
      }
      if (error instanceof HrrrUnavailableError) {
        lastUnavailable = error;
        await writePersistentCache(missingKey, true, HRRR_MISSING_RUN_TTL_MS);
        continue;
      }
      throw error;
    }
  }

  throw lastUnavailable ?? new Error("NOAA HRRR Zarr did not have a usable run for that forecast hour");
}

export function hrrrZarrCoversLocation(location: LocationPoint): boolean {
  return locationToHrrrCell(location) !== undefined;
}

async function loadHrrrRunClouds(
  samples: HrrrCellSample[],
  run: HrrrRun,
  time: Date,
  signal: AbortSignal | undefined,
  mode: CloudDataMode
): Promise<CloudSnapshot> {
  const values = new Map<HrrrCloudFieldKey, Map<number, number>>();
  await Promise.all(
    HRRR_CLOUD_FIELDS.map(async (field) => {
      values.set(field.key, await loadHrrrFieldSamples(field, samples, run, signal));
    })
  );

  const totals = valuesArray(values.get("total"));
  const lows = valuesArray(values.get("low"));
  const mids = valuesArray(values.get("mid"));
  const highs = valuesArray(values.get("high"));
  const layerValues = [...lows, ...mids, ...highs];
  if (!totals.length && !layerValues.length) {
    throw new Error("NOAA HRRR Zarr response did not include cloud cover pixels");
  }

  const volumes: CloudVolume[] = [];
  for (const sample of samples) {
    for (const field of HRRR_CLOUD_FIELDS) {
      if (!field.layer || field.altitudeMeters === undefined || field.thicknessMeters === undefined) {
        continue;
      }
      const cover = values.get(field.key)?.get(sample.sampleIndex);
      if (cover === undefined || cover < HRRR_MIN_VOLUME_COVER) {
        continue;
      }

      volumes.push({
        lat: sample.lat,
        lon: sample.lon,
        east: sample.east,
        north: sample.north,
        cover,
        altitudeMeters: field.altitudeMeters,
        altitudeReference: "seaLevel",
        radiusMeters: HRRR_CLOUD_GRID_SPACING_METERS * clamp(0.32 + cover / 160, 0.42, 0.95),
        thicknessMeters: field.thicknessMeters * clamp(0.72 + cover / 150, 0.76, 1.34),
        layer: field.layer
      });
    }
  }

  return {
    time,
    dataMode: mode,
    total: averagePercent(totals.length ? totals : layerValues),
    low: averagePercent(lows),
    mid: averagePercent(mids),
    high: averagePercent(highs),
    sourceLabel: mode === "realtime" ? "NOAA HRRR Recent Grid" : "NOAA HRRR Forecast Grid",
    map: {
      radiusMeters: HRRR_CLOUD_GRID_SPACING_METERS * Math.floor(HRRR_CLOUD_GRID_RESOLUTION / 2),
      resolution: HRRR_CLOUD_GRID_RESOLUTION,
      spacingMeters: HRRR_CLOUD_GRID_SPACING_METERS,
      volumes
    }
  };
}

async function loadHrrrFieldSamples(
  field: HrrrCloudField,
  samples: HrrrCellSample[],
  run: HrrrRun,
  signal?: AbortSignal
): Promise<Map<number, number>> {
  const groups = new Map<string, HrrrCellSample[]>();
  for (const sample of samples) {
    const key = `${sample.tileRow}:${sample.tileColumn}`;
    const group = groups.get(key);
    if (group) {
      group.push(sample);
    } else {
      groups.set(key, [sample]);
    }
  }

  const values = new Map<number, number>();
  await Promise.all(
    [...groups.values()].map(async (group) => {
      const first = group[0];
      const chunk = await loadHrrrChunk(run, field, first.tileRow, first.tileColumn, signal);
      if (!hrrrChunkContainsForecastHour(chunk, run.forecastHour)) {
        throw new HrrrUnavailableError(`NOAA HRRR Zarr run ${formatHrrrRunLabel(run)} does not include that forecast hour`);
      }
      const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      for (const sample of group) {
        const value = readHrrrCloudChunkValue(view, run.forecastHour - 1, sample.localRow, sample.localColumn);
        if (value !== undefined) {
          values.set(sample.sampleIndex, value);
        }
      }
    })
  );
  return values;
}

function hrrrChunkContainsForecastHour(chunk: Uint8Array, forecastHour: number): boolean {
  return forecastHour * HRRR_CHUNK_ROWS * HRRR_CHUNK_COLUMNS * 4 <= chunk.byteLength;
}

async function loadHrrrChunk(
  run: HrrrRun,
  field: HrrrCloudField,
  tileRow: number,
  tileColumn: number,
  signal?: AbortSignal
): Promise<Uint8Array> {
  const url = hrrrChunkUrl(run, field, tileRow, tileColumn);
  let promise = hrrrChunkPromises.get(url);
  if (!promise) {
    promise = (async () => {
      try {
        const blob = await fetchCachedBlob(HRRR_CLOUD_CACHE_NAME, url, HRRR_CHUNK_CACHE_TTL_MS, signal);
        return decodeBloscLz4(new Uint8Array(await blob.arrayBuffer()));
      } catch (error) {
        if (error instanceof Error && error.message.includes("404")) {
          throw new HrrrUnavailableError(`NOAA HRRR Zarr run ${formatHrrrRunLabel(run)} is not available yet`);
        }
        throw error;
      }
    })();
    hrrrChunkPromises.set(url, promise);
  }

  try {
    return await promise;
  } finally {
    hrrrChunkPromises.delete(url);
  }
}

function readHrrrCloudChunkValue(view: DataView, forecastIndex: number, localRow: number, localColumn: number): number | undefined {
  const cellOffset = forecastIndex * HRRR_CHUNK_ROWS * HRRR_CHUNK_COLUMNS + localRow * HRRR_CHUNK_COLUMNS + localColumn;
  const byteOffset = cellOffset * 4;
  if (byteOffset < 0 || byteOffset + 4 > view.byteLength) {
    return undefined;
  }
  const value = view.getFloat32(byteOffset, true);
  if (!Number.isFinite(value) || value <= HRRR_FILL_VALUE) {
    return undefined;
  }
  return clamp(Math.round(value), 0, 100);
}

function buildHrrrGridSamples(location: LocationPoint): HrrrCellSample[] {
  const samples: HrrrCellSample[] = [];
  const half = Math.floor(HRRR_CLOUD_GRID_RESOLUTION / 2);
  let sampleIndex = 0;
  for (let row = 0; row < HRRR_CLOUD_GRID_RESOLUTION; row += 1) {
    for (let column = 0; column < HRRR_CLOUD_GRID_RESOLUTION; column += 1) {
      const east = (column - half) * HRRR_CLOUD_GRID_SPACING_METERS;
      const north = (half - row) * HRRR_CLOUD_GRID_SPACING_METERS;
      const sampleLocation = offsetLocation(location, east, north);
      const cell = locationToHrrrCell(sampleLocation);
      if (!cell) {
        sampleIndex += 1;
        continue;
      }
      samples.push({
        ...sampleLocation,
        column,
        east,
        gridColumn: cell.gridColumn,
        gridRow: cell.gridRow,
        localColumn: cell.gridColumn % HRRR_CHUNK_COLUMNS,
        localRow: cell.gridRow % HRRR_CHUNK_ROWS,
        north,
        row,
        sampleIndex,
        tileColumn: Math.floor(cell.gridColumn / HRRR_CHUNK_COLUMNS),
        tileRow: Math.floor(cell.gridRow / HRRR_CHUNK_ROWS)
      });
      sampleIndex += 1;
    }
  }
  return samples;
}

function locationToHrrrCell(location: LocationPoint): { gridColumn: number; gridRow: number } | undefined {
  const projected = projectHrrrLambert(location);
  const gridColumn = Math.round((projected.x - HRRR_GRID_X0_METERS) / HRRR_GRID_SPACING_METERS);
  const gridRow = Math.round((projected.y - HRRR_GRID_Y0_METERS) / HRRR_GRID_SPACING_METERS);
  if (gridColumn < 0 || gridColumn >= HRRR_GRID_COLUMNS || gridRow < 0 || gridRow >= HRRR_GRID_ROWS) {
    return undefined;
  }
  return { gridColumn, gridRow };
}

function projectHrrrLambert(location: LocationPoint): { x: number; y: number } {
  const latitude = degreesToRadians(location.lat);
  const longitude = degreesToRadians(location.lon);
  const standardLatitude = degreesToRadians(HRRR_LAMBERT_LATITUDE_DEGREES);
  const originLatitude = standardLatitude;
  const originLongitude = degreesToRadians(HRRR_LAMBERT_LONGITUDE_DEGREES);
  const cone = Math.sin(standardLatitude);
  const scale =
    (Math.cos(standardLatitude) * Math.pow(Math.tan(Math.PI / 4 + standardLatitude / 2), cone)) / cone;
  const rho = (HRRR_LAMBERT_RADIUS_METERS * scale) / Math.pow(Math.tan(Math.PI / 4 + latitude / 2), cone);
  const rho0 = (HRRR_LAMBERT_RADIUS_METERS * scale) / Math.pow(Math.tan(Math.PI / 4 + originLatitude / 2), cone);
  const theta = cone * (longitude - originLongitude);
  return {
    x: rho * Math.sin(theta),
    y: rho0 - rho * Math.cos(theta)
  };
}

function buildHrrrRunCandidates(targetHourMs: number, nowMs: number): HrrrRun[] {
  const latestAvailableInitMs = floorUtcHourMs(nowMs - HRRR_AVAILABILITY_DELAY_MS);
  const latestInitMs = Math.min(targetHourMs - HOUR_MS, latestAvailableInitMs);
  const earliestInitMs = targetHourMs - HRRR_MAX_FORECAST_HOURS * HOUR_MS;
  const runs: HrrrRun[] = [];
  for (let initMs = latestInitMs; initMs >= earliestInitMs && runs.length < HRRR_MAX_RUN_CANDIDATES; initMs -= HOUR_MS) {
    const forecastHour = Math.round((targetHourMs - initMs) / HOUR_MS);
    if (forecastHour < 1) {
      continue;
    }
    const initHour = new Date(initMs).getUTCHours();
    const maxForecastHour = HRRR_EXTENDED_RUN_HOURS.has(initHour) ? HRRR_MAX_FORECAST_HOURS : HRRR_STANDARD_FORECAST_HOURS;
    if (forecastHour > maxForecastHour) {
      continue;
    }
    const date = formatHrrrDate(initMs);
    const hour = String(initHour).padStart(2, "0");
    runs.push({
      forecastHour,
      initHour,
      initMs,
      path: `sfc/${date}/${date}_${hour}z_fcst.zarr`
    });
  }
  return runs;
}

function hrrrChunkUrl(run: HrrrRun, field: HrrrCloudField, tileRow: number, tileColumn: number): string {
  return `${HRRR_ZARR_BASE_URL}/${run.path}/${field.level}/${field.parameter}/${field.level}/${field.parameter}/0.${tileRow}.${tileColumn}`;
}

function hydrateHrrrSnapshot(cached: CachedHrrrSnapshot, time: Date, mode: CloudDataMode): CloudSnapshot {
  return {
    time,
    dataMode: mode,
    total: cached.total,
    low: cached.low,
    mid: cached.mid,
    high: cached.high,
    sourceLabel: mode === "realtime" ? "NOAA HRRR Recent Grid" : "NOAA HRRR Forecast Grid",
    map: cached.map
  };
}

function dehydrateHrrrSnapshot(snapshot: CloudSnapshot): CachedHrrrSnapshot {
  return {
    total: snapshot.total,
    low: snapshot.low,
    mid: snapshot.mid,
    high: snapshot.high,
    map: snapshot.map ?? {
      radiusMeters: HRRR_CLOUD_GRID_SPACING_METERS * Math.floor(HRRR_CLOUD_GRID_RESOLUTION / 2),
      resolution: HRRR_CLOUD_GRID_RESOLUTION,
      spacingMeters: HRRR_CLOUD_GRID_SPACING_METERS,
      volumes: []
    }
  };
}

function hrrrSnapshotCacheKey(run: HrrrRun, location: LocationPoint): string {
  return [
    "cloud",
    "hrrrZarr",
    "v1",
    hashNumber(run.path).toString(36),
    `f${run.forecastHour}`,
    `${location.lat.toFixed(3)},${location.lon.toFixed(3)}`
  ].join(":");
}

function hrrrMissingRunCacheKey(run: HrrrRun): string {
  return ["cloud", "hrrrZarr", "missing", "v1", hashNumber(run.path).toString(36)].join(":");
}

function decodeBloscLz4(input: Uint8Array): Uint8Array {
  if (input.byteLength < 16) {
    throw new Error("HRRR Zarr chunk is too small");
  }
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const flags = input[2];
  const typeSize = input[3];
  const byteLength = view.getUint32(4, true);
  const blockSize = view.getUint32(8, true);
  const compressedByteLength = view.getUint32(12, true);
  if (!typeSize || !byteLength || !blockSize || compressedByteLength > input.byteLength) {
    throw new Error("HRRR Zarr chunk has an invalid Blosc header");
  }
  if (flags & BLOSC_DOBITSHUFFLE) {
    throw new Error("HRRR Zarr chunk uses unsupported Blosc bitshuffle");
  }

  const blockCount = Math.ceil(byteLength / blockSize);
  if (16 + blockCount * 4 > input.byteLength) {
    throw new Error("HRRR Zarr chunk has an invalid Blosc block table");
  }

  const output = new Uint8Array(byteLength);
  for (let blockIndex = 0; blockIndex < blockCount; blockIndex += 1) {
    const start = view.getUint32(16 + blockIndex * 4, true);
    const end = blockIndex + 1 < blockCount ? view.getUint32(16 + (blockIndex + 1) * 4, true) : compressedByteLength;
    if (start < 16 || end > compressedByteLength || start >= end) {
      throw new Error("HRRR Zarr chunk has an invalid Blosc block offset");
    }
    const outputOffset = blockIndex * blockSize;
    const outputLength = Math.min(blockSize, byteLength - outputOffset);
    let block = decodeBloscBlock(input.subarray(start, end), outputLength, typeSize, (flags & BLOSC_DONT_SPLIT) === 0);
    if (flags & BLOSC_DOSHUFFLE) {
      block = unshuffleBytes(block, typeSize);
    }
    output.set(block, outputOffset);
  }
  return output;
}

function decodeBloscBlock(block: Uint8Array, outputLength: number, typeSize: number, preferSplit: boolean): Uint8Array {
  if (preferSplit && typeSize > 1) {
    const split = tryDecodeSplitBlock(block, outputLength, typeSize);
    if (split) {
      return split;
    }
  }
  return decodeSizedLz4Block(block, outputLength);
}

function tryDecodeSplitBlock(block: Uint8Array, outputLength: number, typeSize: number): Uint8Array | undefined {
  if (outputLength % typeSize !== 0) {
    return undefined;
  }
  const laneLength = outputLength / typeSize;
  const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
  const output = new Uint8Array(outputLength);
  let offset = 0;
  for (let lane = 0; lane < typeSize; lane += 1) {
    if (offset + 4 > block.byteLength) {
      return undefined;
    }
    const compressedLength = view.getUint32(offset, true);
    offset += 4;
    if (compressedLength <= 0 || offset + compressedLength > block.byteLength) {
      return undefined;
    }
    let laneBytes: Uint8Array;
    try {
      laneBytes = decodeLz4Block(block.subarray(offset, offset + compressedLength), laneLength);
    } catch {
      return undefined;
    }
    output.set(laneBytes, lane * laneLength);
    offset += compressedLength;
  }
  return offset === block.byteLength ? output : undefined;
}

function decodeSizedLz4Block(block: Uint8Array, outputLength: number): Uint8Array {
  const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
  const compressedLength = block.byteLength >= 4 ? view.getUint32(0, true) : 0;
  const payload =
    compressedLength > 0 && compressedLength + 4 <= block.byteLength
      ? block.subarray(4, 4 + compressedLength)
      : block;
  return decodeLz4Block(payload, outputLength);
}

function decodeLz4Block(input: Uint8Array, outputLength: number): Uint8Array {
  const output = new Uint8Array(outputLength);
  let inputOffset = 0;
  let outputOffset = 0;

  while (inputOffset < input.byteLength) {
    const token = input[inputOffset++];
    let literalLength = token >> 4;
    if (literalLength === 15) {
      let next = 255;
      while (next === 255) {
        if (inputOffset >= input.byteLength) {
          throw new Error("Invalid LZ4 literal length");
        }
        next = input[inputOffset++];
        literalLength += next;
      }
    }

    if (literalLength > 0) {
      if (inputOffset + literalLength > input.byteLength || outputOffset + literalLength > output.byteLength) {
        throw new Error("Invalid LZ4 literal run");
      }
      output.set(input.subarray(inputOffset, inputOffset + literalLength), outputOffset);
      inputOffset += literalLength;
      outputOffset += literalLength;
    }

    if (inputOffset >= input.byteLength) {
      break;
    }
    if (inputOffset + 2 > input.byteLength) {
      throw new Error("Invalid LZ4 match offset");
    }
    const matchOffset = input[inputOffset] | (input[inputOffset + 1] << 8);
    inputOffset += 2;
    if (matchOffset <= 0 || outputOffset - matchOffset < 0) {
      throw new Error("Invalid LZ4 match distance");
    }

    let matchLength = token & 0x0f;
    if (matchLength === 15) {
      let next = 255;
      while (next === 255) {
        if (inputOffset >= input.byteLength) {
          throw new Error("Invalid LZ4 match length");
        }
        next = input[inputOffset++];
        matchLength += next;
      }
    }
    matchLength += 4;
    if (outputOffset + matchLength > output.byteLength) {
      throw new Error("Invalid LZ4 match run");
    }
    for (let index = 0; index < matchLength; index += 1) {
      output[outputOffset + index] = output[outputOffset - matchOffset + index];
    }
    outputOffset += matchLength;
  }

  if (outputOffset !== output.byteLength) {
    throw new Error("LZ4 block did not decode to the expected length");
  }
  return output;
}

function unshuffleBytes(input: Uint8Array, typeSize: number): Uint8Array {
  if (typeSize <= 1) {
    return input;
  }
  const output = new Uint8Array(input.byteLength);
  const itemCount = Math.floor(input.byteLength / typeSize);
  for (let byteIndex = 0; byteIndex < typeSize; byteIndex += 1) {
    const sourceOffset = byteIndex * itemCount;
    for (let itemIndex = 0; itemIndex < itemCount; itemIndex += 1) {
      output[itemIndex * typeSize + byteIndex] = input[sourceOffset + itemIndex];
    }
  }
  return output;
}

function valuesArray(values: Map<number, number> | undefined): number[] {
  return values ? [...values.values()] : [];
}

function averagePercent(values: number[]): number {
  if (!values.length) {
    return 0;
  }
  return clamp(Math.round(values.reduce((sum, value) => sum + value, 0) / values.length), 0, 100);
}

function floorUtcHourMs(value: number): number {
  return Math.floor(value / HOUR_MS) * HOUR_MS;
}

function formatHrrrDate(value: number): string {
  const date = new Date(value);
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(date.getUTCDate()).padStart(2, "0")}`;
}

function formatHrrrRunLabel(run: HrrrRun): string {
  return `${formatHrrrDate(run.initMs)} ${String(run.initHour).padStart(2, "0")}z F${String(run.forecastHour).padStart(2, "0")}`;
}

function degreesToRadians(value: number): number {
  return (value * Math.PI) / 180;
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (error instanceof DOMException && error.name === "AbortError");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
}

class HrrrUnavailableError extends Error {}
