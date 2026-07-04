import type { LocationPoint, Settings } from "../types";

export async function searchLocations(query: string, settings: Settings, near?: LocationPoint, signal?: AbortSignal): Promise<LocationPoint[]> {
  const trimmed = query.trim();
  if (!trimmed) {
    return [];
  }

  if (settings.geocoderSource === "mapbox") {
    return searchMapbox(trimmed, settings, near, signal);
  }
  if (settings.geocoderSource === "nominatim") {
    return searchNominatim(trimmed, signal);
  }
  return searchOpenMeteo(trimmed, settings, signal);
}

async function searchOpenMeteo(query: string, settings: Settings, signal?: AbortSignal): Promise<LocationPoint[]> {
  const endpoint = settings.apiKeys.openMeteo
    ? "https://customer-geocoding-api.open-meteo.com/v1/search"
    : "https://geocoding-api.open-meteo.com/v1/search";
  const params = new URLSearchParams({
    name: query,
    count: "8",
    language: navigator.language?.slice(0, 2) || "en",
    format: "json"
  });
  if (settings.apiKeys.openMeteo) {
    params.set("apikey", settings.apiKeys.openMeteo);
  }

  const response = await fetch(`${endpoint}?${params.toString()}`, { signal });
  if (!response.ok) {
    throw new Error(`Open-Meteo geocoding returned ${response.status}`);
  }
  const body = (await response.json()) as {
    results?: Array<{
      name: string;
      latitude: number;
      longitude: number;
      elevation?: number;
      country?: string;
      admin1?: string;
      timezone?: string;
    }>;
  };
  return (body.results ?? []).map((result) => ({
    lat: result.latitude,
    lon: result.longitude,
    elevation: result.elevation,
    label: [result.name, result.admin1, result.country].filter(Boolean).join(", ")
  }));
}

async function searchNominatim(query: string, signal?: AbortSignal): Promise<LocationPoint[]> {
  const params = new URLSearchParams({
    q: query,
    format: "jsonv2",
    limit: "8",
    addressdetails: "1"
  });
  const response = await fetch(`https://nominatim.openstreetmap.org/search?${params.toString()}`, { signal });
  if (!response.ok) {
    throw new Error(`Nominatim returned ${response.status}`);
  }
  const body = (await response.json()) as Array<{
    display_name: string;
    lat: string;
    lon: string;
  }>;
  return body.map((result) => ({
    lat: Number(result.lat),
    lon: Number(result.lon),
    label: result.display_name
  }));
}

async function searchMapbox(query: string, settings: Settings, near?: LocationPoint, signal?: AbortSignal): Promise<LocationPoint[]> {
  const token = settings.apiKeys.mapbox.trim();
  if (!token) {
    throw new Error("Mapbox geocoding needs a Mapbox token in Settings");
  }
  const params = new URLSearchParams({
    q: query,
    access_token: token,
    limit: "8",
    language: navigator.language || "en"
  });
  if (near) {
    params.set("proximity", `${near.lon.toFixed(5)},${near.lat.toFixed(5)}`);
  }
  const response = await fetch(`https://api.mapbox.com/search/geocode/v6/forward?${params.toString()}`, { signal });
  if (!response.ok) {
    throw new Error(`Mapbox geocoding returned ${response.status}`);
  }
  const body = (await response.json()) as {
    features?: Array<{
      geometry?: { coordinates?: [number, number] };
      properties?: {
        full_address?: string;
        name?: string;
        place_formatted?: string;
      };
    }>;
  };
  return (body.features ?? [])
    .map((feature) => {
      const coords = feature.geometry?.coordinates;
      if (!coords) {
        return undefined;
      }
      const properties = feature.properties ?? {};
      return {
        lat: coords[1],
        lon: coords[0],
        label: properties.full_address ?? [properties.name, properties.place_formatted].filter(Boolean).join(", ") ?? "Mapbox result"
      };
    })
    .filter((item): item is LocationPoint => Boolean(item));
}
