export type TerrainSource = "synthetic" | "openMeteo" | "mapbox";
export type CloudSource = "openMeteoGrid" | "openMeteoEcmwf" | "openMeteoBom" | "hrrrZarr";
export type CloudDataMode = "realtime" | "prediction";
export type GeocoderSource = "openMeteo" | "nominatim" | "mapbox";
export type MapSource = "terrainCanvas" | "osmRaster" | "mapboxRaster";
export type CloudLayer = "low" | "mid" | "high";
export type CloudVolumeType = "modeled" | "approximate" | "satelliteTop";

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
  dataMode: CloudDataMode;
  total: number;
  low: number;
  mid: number;
  high: number;
  sourceLabel: string;
  map?: CloudVolumeMap;
  satelliteTopLabel?: string;
  satelliteTopWarning?: string;
  warning?: string;
}

export interface CloudVolume {
  lat: number;
  lon: number;
  east: number;
  north: number;
  cover: number;
  altitudeMeters: number;
  altitudeReference: "seaLevel" | "ground";
  radiusMeters: number;
  thicknessMeters: number;
  layer: CloudLayer;
  volumeType?: CloudVolumeType;
}

export interface CloudVolumeMap {
  radiusMeters: number;
  resolution: number;
  spacingMeters: number;
  volumes: CloudVolume[];
}
