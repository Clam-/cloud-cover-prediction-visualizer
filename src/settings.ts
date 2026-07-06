import type { CloudSource, GeocoderSource, MapSource, Settings, TerrainSource } from "./types";

const STORAGE_KEY = "horizon-cloud-settings";
const TERRAIN_VERTICAL_SCALE_MIN = 0.5;
const TERRAIN_VERTICAL_SCALE_MAX = 3;
const MAX_API_KEY_LENGTH = 2048;

const terrainSources = ["synthetic", "openMeteo", "mapbox"] as const satisfies readonly TerrainSource[];
const cloudSources = ["openMeteoGrid", "openMeteoEcmwf", "openMeteoBom", "hrrrZarr"] as const satisfies readonly CloudSource[];
const geocoderSources = ["openMeteo", "nominatim", "mapbox"] as const satisfies readonly GeocoderSource[];
const mapSources = ["terrainCanvas", "osmRaster", "mapboxRaster"] as const satisfies readonly MapSource[];

export const defaultSettings: Settings = {
  terrainSource: "synthetic",
  cloudSource: "openMeteoGrid",
  geocoderSource: "openMeteo",
  mapSource: "osmRaster",
  apiKeys: {
    mapbox: "",
    openMeteo: ""
  },
  terrainVerticalScale: 1.1
};

export function loadSettings(): Settings {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    return structuredClone(defaultSettings);
  }

  try {
    return sanitizeSettings(JSON.parse(raw));
  } catch {
    return structuredClone(defaultSettings);
  }
}

export function saveSettings(settings: Settings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

export function resetSettings(): Settings {
  const next = structuredClone(defaultSettings);
  saveSettings(next);
  return next;
}

function sanitizeSettings(value: unknown): Settings {
  const input = isRecord(value) ? value : {};
  const apiKeys = isRecord(input.apiKeys) ? input.apiKeys : {};

  return {
    terrainSource: readEnum(input.terrainSource, terrainSources, defaultSettings.terrainSource),
    cloudSource: readEnum(input.cloudSource, cloudSources, defaultSettings.cloudSource),
    geocoderSource: readEnum(input.geocoderSource, geocoderSources, defaultSettings.geocoderSource),
    mapSource: readEnum(input.mapSource, mapSources, defaultSettings.mapSource),
    apiKeys: {
      mapbox: readApiKey(apiKeys.mapbox, defaultSettings.apiKeys.mapbox),
      openMeteo: readApiKey(apiKeys.openMeteo, defaultSettings.apiKeys.openMeteo)
    },
    terrainVerticalScale: readTerrainVerticalScale(input.terrainVerticalScale, defaultSettings.terrainVerticalScale)
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function readApiKey(value: unknown, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }

  const trimmed = value.trim();
  if (trimmed.length > MAX_API_KEY_LENGTH || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    return fallback;
  }
  return trimmed;
}

function readTerrainVerticalScale(value: unknown, fallback: number): number {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= TERRAIN_VERTICAL_SCALE_MIN &&
    value <= TERRAIN_VERTICAL_SCALE_MAX
    ? value
    : fallback;
}
