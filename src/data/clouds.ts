import { clamp, seededRandom } from "../geo";
import type { CloudSnapshot, LocationPoint, Settings } from "../types";

export async function loadCloudSnapshot(location: LocationPoint, time: Date, settings: Settings, signal?: AbortSignal): Promise<CloudSnapshot> {
  try {
    if (settings.cloudSource === "openMeteo") {
      return await loadOpenMeteoClouds(location, time, settings, signal);
    }
    if (settings.cloudSource === "openWeather") {
      return await loadOpenWeatherClouds(location, time, settings, signal);
    }
    return syntheticClouds(location, time);
  } catch (error) {
    const warning = error instanceof Error ? error.message : "Cloud provider failed";
    return {
      ...syntheticClouds(location, time),
      warning
    };
  }
}

function syntheticClouds(location: LocationPoint, time: Date): CloudSnapshot {
  const hour = Math.floor(time.getTime() / 3600000);
  const random = seededRandom(`${location.lat.toFixed(2)}:${location.lon.toFixed(2)}:${hour}`);
  const cycle = Math.sin(hour / 5 + location.lat) * 0.5 + 0.5;
  const total = clamp(Math.round(25 + cycle * 45 + random() * 25), 0, 100);
  const low = clamp(Math.round(total * (0.35 + random() * 0.25)), 0, 100);
  const mid = clamp(Math.round(total * (0.25 + random() * 0.35)), 0, 100);
  const high = clamp(Math.round(total * (0.2 + random() * 0.4)), 0, 100);
  return {
    time,
    total,
    low,
    mid,
    high,
    sourceLabel: "Synthetic forecast"
  };
}

async function loadOpenMeteoClouds(location: LocationPoint, time: Date, settings: Settings, signal?: AbortSignal): Promise<CloudSnapshot> {
  const endpoint = settings.apiKeys.openMeteo
    ? "https://customer-api.open-meteo.com/v1/forecast"
    : "https://api.open-meteo.com/v1/forecast";
  const params = new URLSearchParams({
    latitude: location.lat.toFixed(5),
    longitude: location.lon.toFixed(5),
    hourly: "cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high",
    forecast_days: "16",
    past_days: "1",
    timezone: "auto"
  });
  if (settings.apiKeys.openMeteo) {
    params.set("apikey", settings.apiKeys.openMeteo);
  }

  const response = await fetch(`${endpoint}?${params.toString()}`, { signal });
  if (!response.ok) {
    throw new Error(`Open-Meteo forecast returned ${response.status}`);
  }
  const body = (await response.json()) as {
    utc_offset_seconds?: number;
    hourly?: {
      time?: string[];
      cloud_cover?: number[];
      cloud_cover_low?: number[];
      cloud_cover_mid?: number[];
      cloud_cover_high?: number[];
    };
  };
  const hourly = body.hourly;
  if (!hourly?.time?.length || !hourly.cloud_cover) {
    throw new Error("Open-Meteo forecast response did not include cloud cover");
  }

  const offsetMs = (body.utc_offset_seconds ?? 0) * 1000;
  const target = time.getTime();
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  hourly.time.forEach((iso, index) => {
    const localAsUtc = new Date(`${iso}:00Z`).getTime() - offsetMs;
    const distance = Math.abs(localAsUtc - target);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  });

  return {
    time,
    total: normalizePercent(hourly.cloud_cover[bestIndex]),
    low: normalizePercent(hourly.cloud_cover_low?.[bestIndex]),
    mid: normalizePercent(hourly.cloud_cover_mid?.[bestIndex]),
    high: normalizePercent(hourly.cloud_cover_high?.[bestIndex]),
    sourceLabel: "Open-Meteo Forecast"
  };
}

async function loadOpenWeatherClouds(location: LocationPoint, time: Date, settings: Settings, signal?: AbortSignal): Promise<CloudSnapshot> {
  const key = settings.apiKeys.openWeather.trim();
  if (!key) {
    throw new Error("OpenWeather clouds need an API key in Settings");
  }

  const params = new URLSearchParams({
    lat: location.lat.toFixed(5),
    lon: location.lon.toFixed(5),
    exclude: "minutely,daily,alerts",
    units: "metric",
    appid: key
  });
  const response = await fetch(`https://api.openweathermap.org/data/3.0/onecall?${params.toString()}`, { signal });
  if (!response.ok) {
    throw new Error(`OpenWeather One Call returned ${response.status}`);
  }
  const body = (await response.json()) as {
    current?: { dt?: number; clouds?: number };
    hourly?: Array<{ dt: number; clouds?: number }>;
  };
  const targetSeconds = Math.round(time.getTime() / 1000);
  const options = [...(body.current ? [body.current] : []), ...(body.hourly ?? [])].filter((item) => typeof item.dt === "number");
  if (!options.length) {
    throw new Error("OpenWeather response did not include cloud cover");
  }
  const best = options.reduce((closest, item) =>
    Math.abs((item.dt ?? 0) - targetSeconds) < Math.abs((closest.dt ?? 0) - targetSeconds) ? item : closest
  );
  const total = normalizePercent(best.clouds);
  return {
    time,
    total,
    low: Math.round(total * 0.45),
    mid: Math.round(total * 0.35),
    high: Math.round(total * 0.3),
    sourceLabel: "OpenWeather One Call"
  };
}

function normalizePercent(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? clamp(Math.round(value), 0, 100) : 0;
}
