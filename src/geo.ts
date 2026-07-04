import type { LocationPoint } from "./types";

export const DEFAULT_LOCATION: LocationPoint = {
  lat: -38.489,
  lon: 145.232,
  label: "Phillip Island, Victoria"
};

const EARTH_RADIUS_METERS = 6371008.8;
const METERS_PER_DEGREE_LAT = 111320;

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function roundToHour(date: Date): Date {
  const rounded = new Date(date);
  rounded.setMinutes(0, 0, 0);
  if (date.getMinutes() >= 30) {
    rounded.setHours(rounded.getHours() + 1);
  }
  return rounded;
}

export function addHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
}

export function metersPerDegreeLon(lat: number): number {
  return METERS_PER_DEGREE_LAT * Math.cos((lat * Math.PI) / 180);
}

export function offsetLocation(center: LocationPoint, east: number, north: number): LocationPoint {
  const lat = center.lat + north / METERS_PER_DEGREE_LAT;
  const lon = center.lon + east / metersPerDegreeLon(center.lat);
  return {
    lat,
    lon: normalizeLongitude(lon),
    label: `${formatCoordinate(lat, "lat")}, ${formatCoordinate(lon, "lon")}`
  };
}

export function localOffset(center: LocationPoint, point: Pick<LocationPoint, "lat" | "lon">): { east: number; north: number } {
  return {
    east: (point.lon - center.lon) * metersPerDegreeLon(center.lat),
    north: (point.lat - center.lat) * METERS_PER_DEGREE_LAT
  };
}

export function distanceMeters(a: Pick<LocationPoint, "lat" | "lon">, b: Pick<LocationPoint, "lat" | "lon">): number {
  const lat1 = degreesToRadians(a.lat);
  const lat2 = degreesToRadians(b.lat);
  const deltaLat = degreesToRadians(b.lat - a.lat);
  const deltaLon = degreesToRadians(b.lon - a.lon);
  const h =
    Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) * Math.sin(deltaLon / 2);
  return 2 * EARTH_RADIUS_METERS * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

export function degreesToRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

export function radiansToDegrees(radians: number): number {
  return (radians * 180) / Math.PI;
}

export function normalizeLongitude(lon: number): number {
  if (lon > 180 || lon < -180) {
    return ((((lon + 180) % 360) + 360) % 360) - 180;
  }
  return lon;
}

export function formatCoordinate(value: number, axis: "lat" | "lon"): string {
  const direction = axis === "lat" ? (value >= 0 ? "N" : "S") : value >= 0 ? "E" : "W";
  return `${Math.abs(value).toFixed(4)} ${direction}`;
}

export function formatTime(date: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
}

export function hashNumber(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function seededRandom(seed: string): () => number {
  let state = hashNumber(seed) || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) % 100000) / 100000;
  };
}

export function lonLatToTile(lon: number, lat: number, zoom: number): { x: number; y: number; xf: number; yf: number } {
  const latRad = degreesToRadians(clamp(lat, -85.05112878, 85.05112878));
  const scale = 2 ** zoom;
  const xf = ((lon + 180) / 360) * scale;
  const yf = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * scale;
  return {
    x: Math.floor(xf),
    y: Math.floor(yf),
    xf,
    yf
  };
}

export function latLonToWorldPixel(lon: number, lat: number, zoom: number, tileSize: number): { x: number; y: number } {
  const tile = lonLatToTile(lon, lat, zoom);
  return {
    x: tile.xf * tileSize,
    y: tile.yf * tileSize
  };
}
