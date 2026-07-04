import { clamp, localOffset, offsetLocation, seededRandom, lonLatToTile } from "../geo";
import { fetchCachedBlob, readPersistentCacheMany, writePersistentCacheMany } from "./cache";
import type { LocationPoint, Settings, TerrainGrid, TerrainSample } from "../types";

interface TerrainPoint extends LocationPoint {
  east: number;
  north: number;
}

interface TerrainTile {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

const MAPBOX_TILE_CACHE_LIMIT = 128;
const MAPBOX_TERRAIN_TILE_TTL_MS = 180 * 24 * 60 * 60 * 1000;
const OPEN_METEO_ELEVATION_TTL_MS = 365 * 24 * 60 * 60 * 1000;
const OPEN_METEO_ELEVATION_PRECISION = 500;
const mapboxTileCache = new Map<string, Promise<TerrainTile>>();

export async function loadTerrainGrid(center: LocationPoint, settings: Settings, signal?: AbortSignal): Promise<TerrainGrid> {
  const extentMeters = settings.terrainSource === "synthetic" ? 65000 : 52000;
  const resolution = settings.terrainSource === "mapbox" ? 73 : settings.terrainSource === "openMeteo" ? 37 : 105;
  const points = createGridPoints(center, extentMeters, resolution);

  try {
    const elevations =
      settings.terrainSource === "openMeteo"
        ? await sampleOpenMeteo(points, settings, signal)
        : settings.terrainSource === "mapbox"
          ? await sampleMapboxTerrain(points, settings, signal)
          : points.map((point) => syntheticElevation(point.lat, point.lon, center));

    return buildGrid(center, extentMeters, resolution, points, elevations, labelForSource(settings.terrainSource));
  } catch (error) {
    const warning = error instanceof Error ? error.message : "Terrain provider failed";
    const fallbackResolution = 105;
    const fallbackPoints = createGridPoints(center, extentMeters, fallbackResolution);
    const elevations = fallbackPoints.map((point) => syntheticElevation(point.lat, point.lon, center));
    return {
      ...buildGrid(center, extentMeters, fallbackResolution, fallbackPoints, elevations, "Synthetic terrain"),
      warning
    };
  }
}

export function syntheticElevation(lat: number, lon: number, center: LocationPoint): number {
  const localSeed = `${Math.round(center.lat * 10)}:${Math.round(center.lon * 10)}`;
  const random = seededRandom(localSeed);
  const phaseA = random() * Math.PI * 2;
  const phaseB = random() * Math.PI * 2;
  const phaseC = random() * Math.PI * 2;
  const dx = (lon - center.lon) * 74000 * Math.cos((center.lat * Math.PI) / 180);
  const dz = (lat - center.lat) * 111320;
  const distance = Math.hypot(dx, dz);
  const broad = Math.sin(dx / 9500 + phaseA) * 145 + Math.cos(dz / 12500 + phaseB) * 100;
  const ridges = Math.sin((dx + dz) / 4200 + phaseC) * Math.cos((dx - dz) / 6500) * 80;
  const horizonRise = 240 * Math.exp(-Math.abs(distance - 42000) / 18000);
  const shore = center.label.toLowerCase().includes("phillip") ? -22 * Math.exp(-distance / 23000) : 0;
  return Math.round(clamp(42 + broad + ridges + horizonRise + shore, -120, 1650));
}

export function terrainHasCoverage(grid: TerrainGrid, center: LocationPoint, requiredRadiusMeters: number): boolean {
  let minEast = Number.POSITIVE_INFINITY;
  let maxEast = Number.NEGATIVE_INFINITY;
  let minNorth = Number.POSITIVE_INFINITY;
  let maxNorth = Number.NEGATIVE_INFINITY;

  for (const row of grid.samples) {
    for (const sample of row) {
      const offset = localOffset(center, sample);
      minEast = Math.min(minEast, offset.east);
      maxEast = Math.max(maxEast, offset.east);
      minNorth = Math.min(minNorth, offset.north);
      maxNorth = Math.max(maxNorth, offset.north);
    }
  }

  return minEast <= -requiredRadiusMeters && maxEast >= requiredRadiusMeters && minNorth <= -requiredRadiusMeters && maxNorth >= requiredRadiusMeters;
}

export function recenterTerrainGrid(grid: TerrainGrid, center: LocationPoint): TerrainGrid {
  const samples = grid.samples.map((row) =>
    row.map((sample) => {
      const offset = localOffset(center, sample);
      return {
        ...sample,
        east: offset.east,
        north: offset.north
      };
    })
  );
  const groundElevation = sampleTerrainElevation(samples, 0, 0) ?? grid.groundElevation;

  return {
    ...grid,
    center: {
      ...center,
      elevation: groundElevation
    },
    groundElevation,
    samples
  };
}

function createGridPoints(center: LocationPoint, extentMeters: number, resolution: number): TerrainPoint[] {
  const points: TerrainPoint[] = [];
  const step = (extentMeters * 2) / (resolution - 1);
  for (let z = 0; z < resolution; z += 1) {
    const north = -extentMeters + z * step;
    for (let x = 0; x < resolution; x += 1) {
      const east = -extentMeters + x * step;
      const location = offsetLocation(center, east, north);
      points.push({
        ...location,
        east,
        north
      });
    }
  }
  return points;
}

function buildGrid(
  center: LocationPoint,
  extentMeters: number,
  resolution: number,
  points: TerrainPoint[],
  elevations: number[],
  sourceLabel: string
): TerrainGrid {
  let minElevation = Number.POSITIVE_INFINITY;
  let maxElevation = Number.NEGATIVE_INFINITY;
  const samples: TerrainSample[][] = [];

  for (let z = 0; z < resolution; z += 1) {
    const row: TerrainSample[] = [];
    for (let x = 0; x < resolution; x += 1) {
      const index = z * resolution + x;
      const point = points[index];
      const elevation = Number.isFinite(elevations[index]) ? elevations[index] : syntheticElevation(point.lat, point.lon, center);
      minElevation = Math.min(minElevation, elevation);
      maxElevation = Math.max(maxElevation, elevation);
      row.push({
        lat: point.lat,
        lon: point.lon,
        east: point.east,
        north: point.north,
        elevation
      });
    }
    samples.push(row);
  }

  const middle = Math.floor(resolution / 2);
  const groundElevation = samples[middle][middle].elevation;
  return {
    center,
    extentMeters,
    resolution,
    groundElevation,
    minElevation,
    maxElevation,
    samples,
    sourceLabel
  };
}

async function sampleOpenMeteo(points: TerrainPoint[], settings: Settings, signal?: AbortSignal): Promise<number[]> {
  const elevations = new Array<number>(points.length);
  const requests = new Map<string, { lat: number; lon: number; indexes: number[] }>();
  const endpoint = settings.apiKeys.openMeteo
    ? "https://customer-api.open-meteo.com/v1/elevation"
    : "https://api.open-meteo.com/v1/elevation";

  points.forEach((point, index) => {
    const quantized = quantizeElevationPoint(point);
    const key = openMeteoElevationCacheKey(quantized.lat, quantized.lon);
    const request = requests.get(key);
    if (request) {
      request.indexes.push(index);
    } else {
      requests.set(key, {
        ...quantized,
        indexes: [index]
      });
    }
  });

  const cached = await readPersistentCacheMany<number>([...requests.keys()]);
  for (const [key, value] of cached) {
    const request = requests.get(key);
    if (!request) {
      continue;
    }
    for (const index of request.indexes) {
      elevations[index] = value;
    }
  }

  const missing = [...requests.entries()].filter(([key]) => !cached.has(key));
  for (let i = 0; i < missing.length; i += 100) {
    const batch = missing.slice(i, i + 100);
    const params = new URLSearchParams({
      latitude: batch.map(([, point]) => point.lat.toFixed(5)).join(","),
      longitude: batch.map(([, point]) => point.lon.toFixed(5)).join(",")
    });
    if (settings.apiKeys.openMeteo) {
      params.set("apikey", settings.apiKeys.openMeteo);
    }
    const response = await fetch(`${endpoint}?${params.toString()}`, { signal });
    if (!response.ok) {
      throw new Error(`Open-Meteo elevation returned ${response.status}`);
    }
    const body = (await response.json()) as { elevation?: Array<number | null> };
    if (!Array.isArray(body.elevation)) {
      throw new Error("Open-Meteo elevation response did not include elevations");
    }
    const cacheWrites: Array<{ key: string; value: number }> = [];
    body.elevation.forEach((value, batchIndex) => {
      const [key, request] = batch[batchIndex];
      const elevation = typeof value === "number" ? value : Number.NaN;
      for (const pointIndex of request.indexes) {
        elevations[pointIndex] = elevation;
      }
      if (Number.isFinite(elevation)) {
        cacheWrites.push({ key, value: elevation });
      }
    });
    await writePersistentCacheMany(cacheWrites, OPEN_METEO_ELEVATION_TTL_MS);
  }

  return elevations;
}

async function sampleMapboxTerrain(points: TerrainPoint[], settings: Settings, signal?: AbortSignal): Promise<number[]> {
  const token = settings.apiKeys.mapbox.trim();
  if (!token) {
    throw new Error("Mapbox terrain needs a Mapbox token in Settings");
  }

  const zoom = 10;
  const elevations: number[] = [];
  for (const point of points) {
    if (signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    const tile = lonLatToTile(point.lon, point.lat, zoom);
    const tileData = await loadMapboxTerrainTile(tile.x, tile.y, zoom, token, signal);
    const px = clamp(Math.floor((tile.xf - tile.x) * tileData.width), 0, tileData.width - 1);
    const py = clamp(Math.floor((tile.yf - tile.y) * tileData.height), 0, tileData.height - 1);
    const index = (py * tileData.width + px) * 4;
    const r = tileData.data[index];
    const g = tileData.data[index + 1];
    const b = tileData.data[index + 2];
    elevations.push(-10000 + (r * 256 * 256 + g * 256 + b) * 0.1);
  }
  return elevations;
}

function loadMapboxTerrainTile(x: number, y: number, zoom: number, token: string, signal?: AbortSignal): Promise<TerrainTile> {
  const key = `${zoom}/${x}/${y}/${token.slice(0, 8)}`;
  const cached = mapboxTileCache.get(key);
  if (cached) {
    mapboxTileCache.delete(key);
    mapboxTileCache.set(key, cached);
    return cached;
  }

  const url = `https://api.mapbox.com/v4/mapbox.terrain-rgb/${zoom}/${x}/${y}.pngraw?access_token=${encodeURIComponent(token)}`;
  const promise = fetchCachedBlob("horizon-mapbox-terrain-v1", url, MAPBOX_TERRAIN_TILE_TTL_MS, signal)
    .then(createImageBitmap)
    .then((bitmap) => {
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) {
        throw new Error("Unable to read Mapbox terrain tile");
      }
      context.drawImage(bitmap, 0, 0);
      const image = context.getImageData(0, 0, bitmap.width, bitmap.height);
      bitmap.close();
      return {
        width: image.width,
        height: image.height,
        data: image.data
      };
    })
    .catch((error: unknown) => {
      if (mapboxTileCache.get(key) === promise) {
        mapboxTileCache.delete(key);
      }
      throw error;
    });

  mapboxTileCache.set(key, promise);
  evictMapboxTileCache();
  return promise;
}

function sampleTerrainElevation(samples: TerrainSample[][], east: number, north: number): number | undefined {
  const closest: Array<{ distance: number; elevation: number }> = [];

  for (const row of samples) {
    for (const sample of row) {
      const distance = Math.hypot(sample.east - east, sample.north - north);
      if (distance < 1) {
        return sample.elevation;
      }
      closest.push({ distance, elevation: sample.elevation });
    }
  }

  closest.sort((a, b) => a.distance - b.distance);
  const nearest = closest.slice(0, 4);
  if (!nearest.length) {
    return undefined;
  }

  let totalWeight = 0;
  let weightedElevation = 0;
  for (const item of nearest) {
    const weight = 1 / Math.max(item.distance * item.distance, 1);
    totalWeight += weight;
    weightedElevation += item.elevation * weight;
  }
  return Math.round(weightedElevation / totalWeight);
}

function quantizeElevationPoint(point: Pick<LocationPoint, "lat" | "lon">): { lat: number; lon: number } {
  return {
    lat: Math.round(point.lat * OPEN_METEO_ELEVATION_PRECISION) / OPEN_METEO_ELEVATION_PRECISION,
    lon: Math.round(point.lon * OPEN_METEO_ELEVATION_PRECISION) / OPEN_METEO_ELEVATION_PRECISION
  };
}

function openMeteoElevationCacheKey(lat: number, lon: number): string {
  return `terrain:openMeteo:${lat.toFixed(5)}:${lon.toFixed(5)}`;
}

function evictMapboxTileCache(): void {
  while (mapboxTileCache.size > MAPBOX_TILE_CACHE_LIMIT) {
    const oldestKey = mapboxTileCache.keys().next().value;
    if (oldestKey === undefined) {
      break;
    }
    mapboxTileCache.delete(oldestKey);
  }
}

function labelForSource(source: Settings["terrainSource"]): string {
  if (source === "openMeteo") {
    return "Open-Meteo Elevation";
  }
  if (source === "mapbox") {
    return "Mapbox Terrain-RGB";
  }
  return "Synthetic terrain";
}
