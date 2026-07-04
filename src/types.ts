export type TerrainSource = "synthetic" | "openMeteo" | "mapbox";
export type CloudSource = "synthetic" | "openMeteo" | "openWeather";
export type GeocoderSource = "openMeteo" | "nominatim" | "mapbox";
export type MapSource = "terrainCanvas" | "osmRaster" | "mapboxRaster";

export interface LocationPoint {
  lat: number;
  lon: number;
  label: string;
  elevation?: number;
}

export interface Settings {
  terrainSource: TerrainSource;
  cloudSource: CloudSource;
  geocoderSource: GeocoderSource;
  mapSource: MapSource;
  apiKeys: {
    mapbox: string;
    openWeather: string;
    openMeteo: string;
  };
  terrainVerticalScale: number;
}

export interface TerrainSample {
  lat: number;
  lon: number;
  east: number;
  north: number;
  elevation: number;
}

export interface TerrainGrid {
  center: LocationPoint;
  extentMeters: number;
  resolution: number;
  groundElevation: number;
  minElevation: number;
  maxElevation: number;
  samples: TerrainSample[][];
  sourceLabel: string;
  warning?: string;
}

export interface CloudSnapshot {
  time: Date;
  total: number;
  low: number;
  mid: number;
  high: number;
  sourceLabel: string;
  warning?: string;
}
