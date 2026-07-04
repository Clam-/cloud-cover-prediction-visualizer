import { clamp, offsetLocation, seededRandom, lonLatToTile } from "../geo";
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
  const elevations: number[] = [];
  const endpoint = settings.apiKeys.openMeteo
    ? "https://customer-api.open-meteo.com/v1/elevation"
    : "https://api.open-meteo.com/v1/elevation";

  for (let i = 0; i < points.length; i += 100) {
    const batch = points.slice(i, i + 100);
    const params = new URLSearchParams({
      latitude: batch.map((point) => point.lat.toFixed(5)).join(","),
      longitude: batch.map((point) => point.lon.toFixed(5)).join(",")
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
    elevations.push(...body.elevation.map((value) => (typeof value === "number" ? value : Number.NaN)));
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
    const tileData = await loadMapboxTerrainTile(tile.x, tile.y, zoom, token);
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

function loadMapboxTerrainTile(x: number, y: number, zoom: number, token: string): Promise<TerrainTile> {
  const key = `${zoom}/${x}/${y}/${token.slice(0, 8)}`;
  const cached = mapboxTileCache.get(key);
  if (cached) {
    mapboxTileCache.delete(key);
    mapboxTileCache.set(key, cached);
    return cached;
  }

  const promise = fetch(`https://api.mapbox.com/v4/mapbox.terrain-rgb/${zoom}/${x}/${y}.pngraw?access_token=${encodeURIComponent(token)}`)
    .then((response) => {
      if (!response.ok) {
        throw new Error(`Mapbox terrain tile returned ${response.status}`);
      }
      return response.blob();
    })
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
