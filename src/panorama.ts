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
  hatch: string;
  lineWidth: number;
  hatchGap: number;
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

const EARTH_RADIUS_METERS = 6371008.8;
const REFRACTION_COEFFICIENT = 0.13;
const MIN_SAMPLE_DISTANCE_METERS = 220;
const TERRAIN_BANDS: TerrainBand[] = [
  {
    minDistance: 42000,
    maxDistance: 98000,
    fill: "rgba(208, 211, 204, 0.68)",
    stroke: "rgba(28, 32, 31, 0.55)",
    hatch: "rgba(24, 28, 27, 0.055)",
    lineWidth: 0.9,
    hatchGap: 22
  },
  {
    minDistance: 28000,
    maxDistance: 52000,
    fill: "rgba(222, 223, 215, 0.78)",
    stroke: "rgba(24, 28, 27, 0.68)",
    hatch: "rgba(24, 28, 27, 0.07)",
    lineWidth: 1,
    hatchGap: 20
  },
  {
    minDistance: 15500,
    maxDistance: 33000,
    fill: "rgba(235, 234, 225, 0.86)",
    stroke: "rgba(20, 24, 23, 0.76)",
    hatch: "rgba(24, 28, 27, 0.085)",
    lineWidth: 1.15,
    hatchGap: 18
  },
  {
    minDistance: 6500,
    maxDistance: 18500,
    fill: "rgba(245, 242, 232, 0.92)",
    stroke: "rgba(18, 22, 21, 0.84)",
    hatch: "rgba(24, 28, 27, 0.1)",
    lineWidth: 1.25,
    hatchGap: 16
  },
  {
    minDistance: MIN_SAMPLE_DISTANCE_METERS,
    maxDistance: 7600,
    fill: "rgba(250, 247, 237, 0.96)",
    stroke: "rgba(12, 16, 15, 0.9)",
    hatch: "rgba(24, 28, 27, 0.115)",
    lineWidth: 1.35,
    hatchGap: 15
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
        if (Math.abs(angleOffset) > projection.halfFov + projection.margin) {
          continue;
        }

        const column = Math.round(((angleOffset + projection.halfFov) / projection.fovRadians) * (columnCount - 1));
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

    const smoothSkyline = smoothProfile(interpolateProfile(skyline), 1);
    drawSkyline(context, smoothSkyline, width);
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
  fovRadians: number;
  halfFov: number;
  height: number;
  margin: number;
  pitch: number;
  width: number;
} {
  const fovRadians = (options.fov * Math.PI) / 180;
  const verticalFov = 2 * Math.atan(Math.tan(fovRadians / 2) / (width / height));
  return {
    focalY: height / (2 * Math.tan(verticalFov / 2)),
    fovRadians,
    halfFov: fovRadians / 2,
    height,
    margin: fovRadians * 0.1,
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

function interpolateProfile(profile: ProfilePoint[]): ProjectedPoint[] {
  const validIndices = profile.reduce<number[]>((indices, point, index) => {
    if (point) {
      indices.push(index);
    }
    return indices;
  }, []);

  if (!validIndices.length) {
    return [];
  }

  const interpolated: ProjectedPoint[] = new Array(profile.length);
  let nextValidPointer = 0;
  let previousIndex = validIndices[0];

  for (let index = 0; index < profile.length; index += 1) {
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

function smoothProfile(profile: ProjectedPoint[], passes: number): ProjectedPoint[] {
  let current = profile;
  for (let pass = 0; pass < passes; pass += 1) {
    current = current.map((point, index) => {
      const previous = current[Math.max(0, index - 1)];
      const next = current[Math.min(current.length - 1, index + 1)];
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
  profile: ProjectedPoint[],
  band: TerrainBand,
  width: number,
  height: number
): void {
  if (!profile.length) {
    return;
  }

  context.save();
  const step = width / Math.max(1, profile.length - 1);
  context.beginPath();
  context.moveTo(0, height + 8);
  profile.forEach((point, index) => {
    context.lineTo(index * step, clamp(point.y, -height, height + 80));
  });
  context.lineTo(width, height + 8);
  context.closePath();
  context.fillStyle = band.fill;
  context.fill();

  context.save();
  context.clip();
  context.strokeStyle = band.hatch;
  context.lineWidth = 1;
  const diagonalExtent = height * 0.52;
  for (let x = -height; x < width + height; x += band.hatchGap) {
    context.beginPath();
    context.moveTo(x, height + 4);
    context.lineTo(x + diagonalExtent, height * 0.32);
    context.stroke();
  }
  context.restore();

  context.strokeStyle = band.stroke;
  context.lineWidth = band.lineWidth;
  context.lineJoin = "round";
  context.lineCap = "round";
  context.beginPath();
  profile.forEach((point, index) => {
    const x = index * step;
    const y = clamp(point.y, -height, height + 80);
    if (index === 0) {
      context.moveTo(x, y);
    } else {
      context.lineTo(x, y);
    }
  });
  context.stroke();

  drawReliefLines(context, profile, width, height, band.stroke);
  context.restore();
}

function drawReliefLines(
  context: CanvasRenderingContext2D,
  profile: ProjectedPoint[],
  width: number,
  height: number,
  color: string
): void {
  const step = width / Math.max(1, profile.length - 1);
  const intervals = [22, 42, 68];

  context.save();
  context.strokeStyle = color.replace(/[\d.]+\)$/u, "0.22)");
  context.lineWidth = 0.75;

  for (const interval of intervals) {
    context.beginPath();
    profile.forEach((point, index) => {
      const x = index * step;
      const relief = interval + Math.sin(index * 0.09 + interval) * 10 + Math.cos(index * 0.035) * 8;
      const y = clamp(point.y + relief, -height, height + 80);
      if (index === 0) {
        context.moveTo(x, y);
      } else {
        context.lineTo(x, y);
      }
    });
    context.stroke();
  }

  context.restore();
}

function drawSkyline(context: CanvasRenderingContext2D, profile: ProjectedPoint[], width: number): void {
  if (!profile.length) {
    return;
  }

  const step = width / Math.max(1, profile.length - 1);
  context.save();
  context.strokeStyle = "rgba(5, 7, 7, 0.88)";
  context.lineWidth = 1.7;
  context.lineJoin = "round";
  context.lineCap = "round";
  context.beginPath();
  profile.forEach((point, index) => {
    const x = index * step;
    if (index === 0) {
      context.moveTo(x, point.y);
    } else {
      context.lineTo(x, point.y);
    }
  });
  context.stroke();
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
