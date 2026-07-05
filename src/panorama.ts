import { clamp } from "./geo";
import type { TerrainGrid, TerrainSample } from "./types";

interface PanoramaOptions {
  fov: number;
  heightOffset: number;
  pitch: number;
  verticalScale: number;
  yaw: number;
}

interface TerrainBand {
  minDistance: number;
  maxDistance: number;
  fill: string;
  stroke: string;
  lineWidth: number;
}

interface ProjectedPoint {
  altitude: number;
  bearing: number;
  distance: number;
  elevation: number;
  sample: TerrainSample;
  y: number;
}

type ProfilePoint = ProjectedPoint | undefined;

interface ProfileSegment {
  startIndex: number;
  points: ProjectedPoint[];
}

interface RasterVertex {
  depth: number;
  x: number;
  y: number;
}

interface DepthRaster {
  cellHeight: number;
  cellWidth: number;
  depths: Float32Array;
  height: number;
  width: number;
}

const EARTH_RADIUS_METERS = 6371008.8;
const REFRACTION_COEFFICIENT = 0.13;
const MIN_SAMPLE_DISTANCE_METERS = 220;
const DEPTH_RASTER_SCALE = 2.8;
const DEPTH_RASTER_MIN_WIDTH = 260;
const DEPTH_RASTER_MAX_WIDTH = 720;
const DEPTH_RASTER_MIN_HEIGHT = 140;
const DEPTH_RASTER_MAX_HEIGHT = 420;
const DEPTH_EDGE_BUCKETS = 5;
const DEPTH_EDGE_LOG_THRESHOLD = 0.1;
const RASTER_FOV_MARGIN_RADIANS = 0.24;
const TERRAIN_BANDS: TerrainBand[] = [
  {
    minDistance: 42000,
    maxDistance: 98000,
    fill: "rgba(208, 211, 204, 0.68)",
    stroke: "rgba(28, 32, 31, 0.55)",
    lineWidth: 0.9
  },
  {
    minDistance: 28000,
    maxDistance: 52000,
    fill: "rgba(222, 223, 215, 0.78)",
    stroke: "rgba(24, 28, 27, 0.68)",
    lineWidth: 1
  },
  {
    minDistance: 15500,
    maxDistance: 33000,
    fill: "rgba(235, 234, 225, 0.86)",
    stroke: "rgba(20, 24, 23, 0.76)",
    lineWidth: 1.15
  },
  {
    minDistance: 6500,
    maxDistance: 18500,
    fill: "rgba(245, 242, 232, 0.92)",
    stroke: "rgba(18, 22, 21, 0.84)",
    lineWidth: 1.25
  },
  {
    minDistance: MIN_SAMPLE_DISTANCE_METERS,
    maxDistance: 7600,
    fill: "rgba(250, 247, 237, 0.96)",
    stroke: "rgba(12, 16, 15, 0.9)",
    lineWidth: 1.35
  }
];

export class PanoramaRenderer {
  private readonly context: CanvasRenderingContext2D;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Unable to create panorama renderer");
    }
    this.context = context;
  }

  clear(): void {
    this.resize();
    const { width, height } = this.logicalSize();
    this.context.clearRect(0, 0, width, height);
  }

  render(grid: TerrainGrid | undefined, options: PanoramaOptions): void {
    this.resize();
    const { width, height } = this.logicalSize();
    const context = this.context;
    context.clearRect(0, 0, width, height);

    if (!grid || width <= 1 || height <= 1) {
      return;
    }

    const projection = createProjection(width, height, options);
    const columnCount = Math.round(clamp(width / 2.25, 320, 760));
    const depthRaster = createDepthRaster(grid, options, projection, width, height);
    const profiles = TERRAIN_BANDS.map(() => new Array<ProfilePoint>(columnCount));
    const skyline = new Array<ProfilePoint>(columnCount);

    for (const row of grid.samples) {
      for (const sample of row) {
        const distance = Math.hypot(sample.east, sample.north);
        if (distance < MIN_SAMPLE_DISTANCE_METERS) {
          continue;
        }

        const bearing = Math.atan2(sample.east, sample.north);
        const angleOffset = wrapRadians(bearing - options.yaw);
        if (Math.abs(angleOffset) > projection.halfHorizontalFov) {
          continue;
        }

        const column = Math.round(((angleOffset + projection.halfHorizontalFov) / projection.horizontalFov) * (columnCount - 1));
        if (column < 0 || column >= columnCount) {
          continue;
        }

        const curvatureDrop = ((distance * distance) / (2 * EARTH_RADIUS_METERS)) * (1 - REFRACTION_COEFFICIENT);
        const apparentHeight = (sample.elevation - grid.groundElevation) * options.verticalScale - curvatureDrop - options.heightOffset;
        const altitude = Math.atan2(apparentHeight, distance);
        const point: ProjectedPoint = {
          altitude,
          bearing,
          distance,
          elevation: sample.elevation,
          sample,
          y: altitudeToY(altitude, projection)
        };

        if (!skyline[column] || altitude > skyline[column]!.altitude) {
          skyline[column] = point;
        }

        const bandIndex = TERRAIN_BANDS.findIndex((band) => distance >= band.minDistance && distance < band.maxDistance);
        if (bandIndex >= 0 && (!profiles[bandIndex][column] || altitude > profiles[bandIndex][column]!.altitude)) {
          profiles[bandIndex][column] = point;
        }
      }
    }

    const horizonY = altitudeToY(0, projection);
    drawHorizon(context, width, horizonY);

    profiles.forEach((rawProfile, index) => {
      const profile = smoothProfile(interpolateProfile(rawProfile), 2);
      drawTerrainBand(context, profile, TERRAIN_BANDS[index], width, height);
    });

    drawDepthDiscontinuities(context, depthRaster);
    drawSkyline(context, interpolateProfile(skyline), width);
  }

  private resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(rect.width * pixelRatio));
    const height = Math.max(1, Math.round(rect.height * pixelRatio));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
      this.context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    }
  }

  private logicalSize(): { width: number; height: number } {
    const transform = this.context.getTransform();
    return {
      width: this.canvas.width / transform.a,
      height: this.canvas.height / transform.d
    };
  }
}

function createProjection(width: number, height: number, options: PanoramaOptions): {
  focalY: number;
  halfHorizontalFov: number;
  height: number;
  horizontalFov: number;
  pitch: number;
  width: number;
} {
  const verticalFov = (options.fov * Math.PI) / 180;
  const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * (width / height));
  return {
    focalY: height / (2 * Math.tan(verticalFov / 2)),
    halfHorizontalFov: horizontalFov / 2,
    height,
    horizontalFov,
    pitch: options.pitch,
    width
  };
}

function altitudeToY(
  altitude: number,
  projection: Pick<ReturnType<typeof createProjection>, "focalY" | "height" | "pitch">
): number {
  return projection.height / 2 - Math.tan(altitude - projection.pitch) * projection.focalY;
}

function createDepthRaster(
  grid: TerrainGrid,
  options: PanoramaOptions,
  projection: ReturnType<typeof createProjection>,
  width: number,
  height: number
): DepthRaster {
  const rasterWidth = Math.round(clamp(width / DEPTH_RASTER_SCALE, DEPTH_RASTER_MIN_WIDTH, DEPTH_RASTER_MAX_WIDTH));
  const rasterHeight = Math.round(clamp(height / DEPTH_RASTER_SCALE, DEPTH_RASTER_MIN_HEIGHT, DEPTH_RASTER_MAX_HEIGHT));
  const raster: DepthRaster = {
    cellHeight: height / rasterHeight,
    cellWidth: width / rasterWidth,
    depths: new Float32Array(rasterWidth * rasterHeight),
    height: rasterHeight,
    width: rasterWidth
  };
  raster.depths.fill(Number.POSITIVE_INFINITY);

  const vertices = grid.samples.map((row) =>
    row.map((sample) => projectRasterVertex(sample, grid, options, projection, width, height, rasterWidth, rasterHeight))
  );

  for (let z = 0; z < grid.resolution - 1; z += 1) {
    for (let x = 0; x < grid.resolution - 1; x += 1) {
      const a = vertices[z][x];
      const b = vertices[z][x + 1];
      const c = vertices[z + 1][x];
      const d = vertices[z + 1][x + 1];
      rasterizeTriangle(raster, a, c, b);
      rasterizeTriangle(raster, b, c, d);
    }
  }

  return raster;
}

function projectRasterVertex(
  sample: TerrainSample,
  grid: TerrainGrid,
  options: PanoramaOptions,
  projection: ReturnType<typeof createProjection>,
  width: number,
  height: number,
  rasterWidth: number,
  rasterHeight: number
): RasterVertex | undefined {
  const distance = Math.hypot(sample.east, sample.north);
  if (distance < MIN_SAMPLE_DISTANCE_METERS) {
    return undefined;
  }

  const bearing = Math.atan2(sample.east, sample.north);
  const angleOffset = wrapRadians(bearing - options.yaw);
  if (Math.abs(angleOffset) > projection.halfHorizontalFov + RASTER_FOV_MARGIN_RADIANS) {
    return undefined;
  }

  const curvatureDrop = ((distance * distance) / (2 * EARTH_RADIUS_METERS)) * (1 - REFRACTION_COEFFICIENT);
  const apparentHeight = (sample.elevation - grid.groundElevation) * options.verticalScale - curvatureDrop - options.heightOffset;
  const altitude = Math.atan2(apparentHeight, distance);
  const screenX = ((angleOffset + projection.halfHorizontalFov) / projection.horizontalFov) * (width - 1);
  const screenY = altitudeToY(altitude, projection);
  const viewDepth = Math.max(1, distance * Math.cos(angleOffset));

  return {
    depth: viewDepth,
    x: (screenX / Math.max(1, width - 1)) * (rasterWidth - 1),
    y: (screenY / Math.max(1, height - 1)) * (rasterHeight - 1)
  };
}

function rasterizeTriangle(
  raster: DepthRaster,
  a: RasterVertex | undefined,
  b: RasterVertex | undefined,
  c: RasterVertex | undefined
): void {
  if (!a || !b || !c) {
    return;
  }

  const minX = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x)));
  const maxX = Math.min(raster.width - 1, Math.ceil(Math.max(a.x, b.x, c.x)));
  const minY = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y)));
  const maxY = Math.min(raster.height - 1, Math.ceil(Math.max(a.y, b.y, c.y)));
  if (minX > maxX || minY > maxY) {
    return;
  }

  const area = edgeFunction(a, b, c.x, c.y);
  if (Math.abs(area) < 0.0001) {
    return;
  }

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const pointX = x + 0.5;
      const pointY = y + 0.5;
      const w0 = edgeFunction(b, c, pointX, pointY) / area;
      const w1 = edgeFunction(c, a, pointX, pointY) / area;
      const w2 = edgeFunction(a, b, pointX, pointY) / area;
      if (w0 < -0.0001 || w1 < -0.0001 || w2 < -0.0001) {
        continue;
      }

      const reciprocalDepth = w0 / a.depth + w1 / b.depth + w2 / c.depth;
      if (reciprocalDepth <= 0) {
        continue;
      }

      const depth = 1 / reciprocalDepth;
      const index = y * raster.width + x;
      if (depth < raster.depths[index]) {
        raster.depths[index] = depth;
      }
    }
  }
}

function edgeFunction(a: Pick<RasterVertex, "x" | "y">, b: Pick<RasterVertex, "x" | "y">, x: number, y: number): number {
  return (x - a.x) * (b.y - a.y) - (y - a.y) * (b.x - a.x);
}

function interpolateProfile(profile: ProfilePoint[]): ProfilePoint[] {
  const validIndices = profile.reduce<number[]>((indices, point, index) => {
    if (point) {
      indices.push(index);
    }
    return indices;
  }, []);

  if (!validIndices.length) {
    return [];
  }

  const interpolated: ProfilePoint[] = new Array(profile.length);
  let nextValidPointer = 0;
  let previousIndex = validIndices[0];
  const firstValidIndex = validIndices[0];
  const lastValidIndex = validIndices[validIndices.length - 1];

  for (let index = firstValidIndex; index <= lastValidIndex; index += 1) {
    const point = profile[index];
    if (point) {
      interpolated[index] = { ...point };
      previousIndex = index;
      if (validIndices[nextValidPointer] === index) {
        nextValidPointer += 1;
      }
      continue;
    }

    const nextIndex = validIndices[nextValidPointer] ?? previousIndex;
    const previousPoint = profile[previousIndex] ?? profile[nextIndex]!;
    const nextPoint = profile[nextIndex] ?? previousPoint;
    const span = Math.max(1, nextIndex - previousIndex);
    const t = clamp((index - previousIndex) / span, 0, 1);
    interpolated[index] = mixProjectedPoint(previousPoint, nextPoint, t);
  }

  return interpolated;
}

function mixProjectedPoint(a: ProjectedPoint, b: ProjectedPoint, t: number): ProjectedPoint {
  return {
    altitude: lerp(a.altitude, b.altitude, t),
    bearing: lerpAngle(a.bearing, b.bearing, t),
    distance: lerp(a.distance, b.distance, t),
    elevation: lerp(a.elevation, b.elevation, t),
    sample: t < 0.5 ? a.sample : b.sample,
    y: lerp(a.y, b.y, t)
  };
}

function smoothProfile(profile: ProfilePoint[], passes: number): ProfilePoint[] {
  let current = profile;
  for (let pass = 0; pass < passes; pass += 1) {
    current = Array.from({ length: current.length }, (_, index) => {
      const point = current[index];
      if (!point) {
        return undefined;
      }

      const previous = current[index - 1] ?? point;
      const next = current[index + 1] ?? point;
      return {
        ...point,
        altitude: (previous.altitude + point.altitude * 2 + next.altitude) / 4,
        distance: (previous.distance + point.distance * 2 + next.distance) / 4,
        elevation: (previous.elevation + point.elevation * 2 + next.elevation) / 4,
        y: (previous.y + point.y * 2 + next.y) / 4
      };
    });
  }
  return current;
}

function profileSegments(profile: ProfilePoint[]): ProfileSegment[] {
  const segments: ProfileSegment[] = [];
  let active: ProfileSegment | undefined;

  for (let index = 0; index < profile.length; index += 1) {
    const point = profile[index];
    if (!point) {
      active = undefined;
      continue;
    }

    if (!active) {
      active = {
        startIndex: index,
        points: []
      };
      segments.push(active);
    }
    active.points.push(point);
  }

  return segments;
}

function drawHorizon(context: CanvasRenderingContext2D, width: number, y: number): void {
  context.save();
  context.strokeStyle = "rgba(240, 235, 218, 0.44)";
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(0, Math.round(y) + 0.5);
  context.lineTo(width, Math.round(y) + 0.5);
  context.stroke();
  context.restore();
}

function drawTerrainBand(
  context: CanvasRenderingContext2D,
  profile: ProfilePoint[],
  band: TerrainBand,
  width: number,
  height: number
): void {
  if (!profile.length) {
    return;
  }

  context.save();
  const step = width / Math.max(1, profile.length - 1);

  for (const segment of profileSegments(profile)) {
    if (segment.points.length < 2) {
      continue;
    }

    const startX = segment.startIndex * step;
    const endX = (segment.startIndex + segment.points.length - 1) * step;

    context.beginPath();
    context.moveTo(startX, height + 8);
    segment.points.forEach((point, offset) => {
      context.lineTo((segment.startIndex + offset) * step, clamp(point.y, -height, height + 80));
    });
    context.lineTo(endX, height + 8);
    context.closePath();
    context.fillStyle = band.fill;
    context.fill();

    context.strokeStyle = band.stroke;
    context.lineWidth = band.lineWidth;
    context.lineJoin = "round";
    context.lineCap = "round";
    context.beginPath();
    segment.points.forEach((point, offset) => {
      const x = (segment.startIndex + offset) * step;
      const y = clamp(point.y, -height, height + 80);
      if (offset === 0) {
        context.moveTo(x, y);
      } else {
        context.lineTo(x, y);
      }
    });
    context.stroke();
  }
  context.restore();
}

function drawDepthDiscontinuities(context: CanvasRenderingContext2D, raster: DepthRaster): void {
  const paths = Array.from({ length: DEPTH_EDGE_BUCKETS }, () => new Path2D());
  const counts = new Array<number>(DEPTH_EDGE_BUCKETS).fill(0);

  for (let y = 0; y < raster.height; y += 1) {
    for (let x = 0; x < raster.width; x += 1) {
      const index = y * raster.width + x;
      const depth = raster.depths[index];

      if (x < raster.width - 1) {
        addDepthEdge(
          paths,
          counts,
          depth,
          raster.depths[index + 1],
          (x + 1) * raster.cellWidth,
          y * raster.cellHeight,
          (x + 1) * raster.cellWidth,
          (y + 1) * raster.cellHeight
        );
      }

      if (y < raster.height - 1) {
        addDepthEdge(
          paths,
          counts,
          depth,
          raster.depths[index + raster.width],
          x * raster.cellWidth,
          (y + 1) * raster.cellHeight,
          (x + 1) * raster.cellWidth,
          (y + 1) * raster.cellHeight
        );
      }
    }
  }

  context.save();
  context.lineCap = "round";
  context.lineJoin = "round";
  for (let bucket = 0; bucket < paths.length; bucket += 1) {
    if (!counts[bucket]) {
      continue;
    }
    const strength = (bucket + 0.5) / DEPTH_EDGE_BUCKETS;
    context.strokeStyle = `rgba(3, 5, 5, ${0.22 + strength * 0.5})`;
    context.lineWidth = 0.45 + strength * 2.35;
    context.stroke(paths[bucket]);
  }
  context.restore();
}

function addDepthEdge(
  paths: Path2D[],
  counts: number[],
  a: number,
  b: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number
): void {
  const strength = depthEdgeStrength(a, b);
  if (strength <= 0) {
    return;
  }

  const bucket = Math.min(DEPTH_EDGE_BUCKETS - 1, Math.floor(strength * DEPTH_EDGE_BUCKETS));
  paths[bucket].moveTo(x1, y1);
  paths[bucket].lineTo(x2, y2);
  counts[bucket] += 1;
}

function depthEdgeStrength(a: number, b: number): number {
  const aFinite = Number.isFinite(a);
  const bFinite = Number.isFinite(b);
  if (!aFinite && !bFinite) {
    return 0;
  }

  if (!aFinite || !bFinite) {
    const finiteDepth = aFinite ? a : b;
    const nearWeight = 1 - clamp(finiteDepth / 70000, 0, 1);
    return clamp(0.36 + nearWeight * 0.42, 0, 0.86);
  }

  const near = Math.min(a, b);
  const far = Math.max(a, b);
  const logJump = Math.log(far / Math.max(1, near));
  if (logJump < DEPTH_EDGE_LOG_THRESHOLD) {
    return 0;
  }

  const absoluteJump = far - near;
  const nearWeight = 1 - clamp(near / 65000, 0, 1);
  return clamp((logJump - DEPTH_EDGE_LOG_THRESHOLD) / 1.15 + nearWeight * 0.14 + clamp(absoluteJump / 42000, 0, 0.22), 0, 1);
}

function drawSkyline(context: CanvasRenderingContext2D, profile: ProfilePoint[], width: number): void {
  if (!profile.length) {
    return;
  }

  const step = width / Math.max(1, profile.length - 1);
  context.save();
  context.strokeStyle = "rgba(5, 7, 7, 0.88)";
  context.lineWidth = 1.7;
  context.lineJoin = "round";
  context.lineCap = "round";
  for (const segment of profileSegments(profile)) {
    if (segment.points.length < 2) {
      continue;
    }
    context.beginPath();
    segment.points.forEach((point, offset) => {
      const x = (segment.startIndex + offset) * step;
      if (offset === 0) {
        context.moveTo(x, point.y);
      } else {
        context.lineTo(x, point.y);
      }
    });
    context.stroke();
  }
  context.restore();
}

function wrapRadians(value: number): number {
  return Math.atan2(Math.sin(value), Math.cos(value));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpAngle(a: number, b: number, t: number): number {
  return a + wrapRadians(b - a) * t;
}
