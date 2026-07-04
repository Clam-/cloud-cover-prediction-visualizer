import type { Settings } from "./types";

const STORAGE_KEY = "horizon-cloud-settings";

export const defaultSettings: Settings = {
  terrainSource: "synthetic",
  cloudSource: "openMeteo",
  geocoderSource: "openMeteo",
  mapSource: "terrainCanvas",
  apiKeys: {
    mapbox: "",
    openWeather: "",
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
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      ...structuredClone(defaultSettings),
      ...parsed,
      apiKeys: {
        ...defaultSettings.apiKeys,
        ...(parsed.apiKeys ?? {})
      }
    };
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
