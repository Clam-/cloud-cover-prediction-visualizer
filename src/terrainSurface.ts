import { clamp } from "./geo";
import type { TerrainGrid } from "./types";

export interface TerrainSurfacePoint {
  east: number;
  elevation: number;
  north: number;
}

const EARTH_RADIUS_METERS = 6371008.8;
// k = 0.166 makes (1 - k) / (2R) match the ~6.5444e-8 per-meter² drop PeakFinder uses.
const REFRACTION_COEFFICIENT = 0.166;
const NEAR_VIEWPOINT_DROP_METERS = 20;
const NEAR_VIEWPOINT_DROP_RANGE_METERS = 1000;

export function smoothstep(value: number): number {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
}

export function terrainCurvatureDrop(distanceMeters: number): number {
  return ((distanceMeters * distanceMeters) / (2 * EARTH_RADIUS_METERS)) * (1 - REFRACTION_COEFFICIENT);
}

export function nearViewpointTerrainDrop(distanceMeters: number): number {
  return (1 - smoothstep(distanceMeters / NEAR_VIEWPOINT_DROP_RANGE_METERS)) * NEAR_VIEWPOINT_DROP_METERS;
}

export function projectedTerrainHeight(
  elevation: number,
  groundElevation: number,
  distanceMeters: number,
  verticalScale: number
): number {
  return (
    (elevation - groundElevation) * verticalScale -
    terrainCurvatureDrop(distanceMeters) -
    nearViewpointTerrainDrop(distanceMeters)
  );
}

export function sampleTerrainGridElevation(grid: TerrainGrid, east: number, north: number): number | undefined {
  const geometry = gridSampleGeometry(grid);
  if (!geometry) {
    return undefined;
  }

  const x = (east - geometry.originEast) / geometry.stepEast;
  const z = (north - geometry.originNorth) / geometry.stepNorth;
  if (x < 0 || z < 0 || x > grid.resolution - 1 || z > grid.resolution - 1) {
    return undefined;
  }

  return bicubicSampleGrid(grid, x, z);
}

export function terrainSurfaceResolution(grid: TerrainGrid, maxResolution = 161): number {
  const interpolated = (grid.resolution - 1) * 2 + 1;
  return Math.round(clamp(interpolated, grid.resolution, maxResolution));
}

export function terrainSurfacePointAt(
  grid: TerrainGrid,
  xIndex: number,
  zIndex: number,
  resolution: number
): TerrainSurfacePoint | undefined {
  const span = gridSampleSpan(grid);
  if (!span || resolution < 2) {
    return undefined;
  }

  const tx = xIndex / (resolution - 1);
  const tz = zIndex / (resolution - 1);
  const east = lerp(span.minEast, span.maxEast, tx);
  const north = lerp(span.minNorth, span.maxNorth, tz);
  const elevation = sampleTerrainGridElevation(grid, east, north);
  if (elevation === undefined) {
    return undefined;
  }

  return {
    east,
    elevation,
    north
  };
}

export function sampleScalarGridSmooth(
  width: number,
  height: number,
  sampleAt: (x: number, y: number) => number,
  x: number,
  y: number
): number {
  const clampedX = clamp(x, 0, width - 1);
  const clampedY = clamp(y, 0, height - 1);
  const x0 = Math.floor(clampedX);
  const y0 = Math.floor(clampedY);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const tx = smoothstep(clampedX - x0);
  const ty = smoothstep(clampedY - y0);
  const top = lerp(sampleAt(x0, y0), sampleAt(x1, y0), tx);
  const bottom = lerp(sampleAt(x0, y1), sampleAt(x1, y1), tx);
  return lerp(top, bottom, ty);
}

function bicubicSampleGrid(grid: TerrainGrid, x: number, z: number): number {
  const x1 = Math.floor(x);
  const z1 = Math.floor(z);
  const tx = x - x1;
  const tz = z - z1;
  let minElevation = Number.POSITIVE_INFINITY;
  let maxElevation = Number.NEGATIVE_INFINITY;
  const rows = [-1, 0, 1, 2].map((offsetZ) => {
    const sampleZ = clamp(z1 + offsetZ, 0, grid.resolution - 1);
    const values = [-1, 0, 1, 2].map((offsetX) => {
      const sampleX = clamp(x1 + offsetX, 0, grid.resolution - 1);
      const elevation = grid.samples[sampleZ][sampleX].elevation;
      minElevation = Math.min(minElevation, elevation);
      maxElevation = Math.max(maxElevation, elevation);
      return elevation;
    });
    return catmullRom(values[0], values[1], values[2], values[3], tx);
  });
  return clamp(catmullRom(rows[0], rows[1], rows[2], rows[3], tz), minElevation, maxElevation);
}

function gridSampleGeometry(grid: TerrainGrid):
  | {
      originEast: number;
      originNorth: number;
      stepEast: number;
      stepNorth: number;
    }
  | undefined {
  if (grid.resolution < 2 || grid.samples.length < grid.resolution || grid.samples[0].length < grid.resolution) {
    return undefined;
  }

  const origin = grid.samples[0][0];
  const eastEdge = grid.samples[0][grid.resolution - 1];
  const northEdge = grid.samples[grid.resolution - 1][0];
  const stepEast = (eastEdge.east - origin.east) / (grid.resolution - 1);
  const stepNorth = (northEdge.north - origin.north) / (grid.resolution - 1);
  if (Math.abs(stepEast) < 0.0001 || Math.abs(stepNorth) < 0.0001) {
    return undefined;
  }

  return {
    originEast: origin.east,
    originNorth: origin.north,
    stepEast,
    stepNorth
  };
}

function gridSampleSpan(grid: TerrainGrid):
  | {
      maxEast: number;
      maxNorth: number;
      minEast: number;
      minNorth: number;
    }
  | undefined {
  if (grid.resolution < 2 || grid.samples.length < grid.resolution || grid.samples[0].length < grid.resolution) {
    return undefined;
  }

  const origin = grid.samples[0][0];
  const eastEdge = grid.samples[0][grid.resolution - 1];
  const northEdge = grid.samples[grid.resolution - 1][0];
  return {
    maxEast: eastEdge.east,
    maxNorth: northEdge.north,
    minEast: origin.east,
    minNorth: origin.north
  };
}

function catmullRom(a: number, b: number, c: number, d: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
