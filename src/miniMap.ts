import { clamp, latLonToWorldPixel, localOffset, offsetLocation, worldPixelToLonLat } from "./geo";
import { fetchCachedBlob } from "./data/cache";
import type { LocationPoint, MapSource, Settings, TerrainGrid } from "./types";

interface RasterTile {
  image: HTMLImageElement;
  objectUrl?: string;
  ready: boolean;
}

interface PointerDownState {
  moved: boolean;
  pointerId: number;
  startCenter: LocationPoint;
  startZoom: number;
  x: number;
  y: number;
}

const RASTER_TILE_CACHE_LIMIT = 192;
const RASTER_TILE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const rasterCache = new Map<string, RasterTile>();

export class MiniMap {
  private readonly context: CanvasRenderingContext2D;
  private readonly attribution: HTMLElement;
  private terrain?: TerrainGrid;
  private location?: LocationPoint;
  private yaw = Math.PI / 2;
  private settings?: Settings;
  private viewportCenter?: LocationPoint;
  private resizeObserver: ResizeObserver;
  private zoomOffset = 0;
  private pointerDown?: PointerDownState;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly panel: HTMLElement,
    attribution: HTMLElement,
    private readonly onSelectLocation?: (location: LocationPoint) => void,
    private readonly reportRasterIssue?: (message?: string) => void
  ) {
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Unable to create mini map canvas");
    }
    this.context = context;
    this.attribution = attribution;
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(panel);
    this.panel.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        const direction = event.deltaY < 0 ? 1 : -1;
        this.zoomOffset = clamp(this.zoomOffset + direction, -3, 5);
        this.draw();
      },
      { passive: false }
    );
    this.canvas.addEventListener("pointerdown", (event) => this.onPointerDown(event));
    this.canvas.addEventListener("pointermove", (event) => this.onPointerMove(event));
    this.canvas.addEventListener("pointerup", (event) => this.onPointerUp(event));
    this.canvas.addEventListener("pointercancel", (event) => {
      if (this.pointerDown?.pointerId === event.pointerId) {
        this.canvas.releasePointerCapture(event.pointerId);
      }
      this.pointerDown = undefined;
    });
    this.resize();
  }

  update(terrain: TerrainGrid | undefined, location: LocationPoint, yaw: number, settings: Settings): void {
    const previousSource = this.settings?.mapSource;
    const locationChanged =
      !this.location || Math.abs(this.location.lat - location.lat) > 1e-9 || Math.abs(this.location.lon - location.lon) > 1e-9;

    this.terrain = terrain;
    this.location = location;
    this.yaw = yaw;
    this.settings = settings;
    if (!this.viewportCenter || locationChanged || previousSource !== settings.mapSource) {
      this.viewportCenter = location;
    }
    this.draw();
  }

  center(): void {
    this.viewportCenter = this.location;
    this.draw();
  }

  private resize(): void {
    const rect = this.panel.getBoundingClientRect();
    const width = Math.max(180, Math.floor(rect.width));
    const height = Math.max(150, Math.floor(rect.height - 30));
    const ratio = window.devicePixelRatio || 1;
    this.canvas.width = Math.floor(width * ratio);
    this.canvas.height = Math.floor(height * ratio);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.context.setTransform(ratio, 0, 0, ratio, 0, 0);
    this.draw();
  }

  private draw(): void {
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    this.context.clearRect(0, 0, width, height);

    const source = this.settings?.mapSource ?? "terrainCanvas";
    const rasterDrawn = this.drawRasterBackground(source, width, height);
    if (!rasterDrawn) {
      this.drawTerrainBackground(width, height);
    }
    this.drawPov(width, height);
  }

  private drawRasterBackground(source: MapSource, width: number, height: number): boolean {
    const centerLocation = this.mapCenter();
    if (!centerLocation || !this.settings || source === "terrainCanvas") {
      this.attribution.textContent = "";
      this.reportRasterIssue?.();
      return false;
    }

    const isMapbox = source === "mapboxRaster";
    if (isMapbox && !this.settings.apiKeys.mapbox.trim()) {
      this.attribution.textContent = "Mapbox token missing";
      this.reportRasterIssue?.("Mapbox map tiles need a Mapbox token in Settings.");
      return false;
    }

    const zoom = this.pickZoom(width);
    const tileSize = 256;
    const center = latLonToWorldPixel(centerLocation.lon, centerLocation.lat, zoom, tileSize);
    const topLeft = {
      x: center.x - width / 2,
      y: center.y - height / 2
    };
    const startX = Math.floor(topLeft.x / tileSize);
    const endX = Math.floor((topLeft.x + width) / tileSize);
    const startY = Math.floor(topLeft.y / tileSize);
    const endY = Math.floor((topLeft.y + height) / tileSize);

    this.context.fillStyle = "#1b241f";
    this.context.fillRect(0, 0, width, height);

    let requested = false;
    for (let x = startX; x <= endX; x += 1) {
      for (let y = startY; y <= endY; y += 1) {
        const tile = this.getRasterTile(source, zoom, x, y);
        requested = true;
        if (tile.ready) {
          this.context.drawImage(tile.image, x * tileSize - topLeft.x, y * tileSize - topLeft.y, tileSize, tileSize);
        }
      }
    }

    this.attribution.textContent = isMapbox ? "Mapbox" : "OpenStreetMap";
    return requested;
  }

  private drawTerrainBackground(width: number, height: number): void {
    const gradient = this.context.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, "#284232");
    gradient.addColorStop(0.5, "#746b42");
    gradient.addColorStop(1, "#142a30");
    this.context.fillStyle = gradient;
    this.context.fillRect(0, 0, width, height);
    this.drawTerrainOverlay(width, height);
  }

  private drawTerrainOverlay(width: number, height: number): void {
    const centerLocation = this.mapCenter();
    if (!this.terrain || !centerLocation) {
      return;
    }

    const terrain = this.terrain;
    const visibleExtent = terrain.extentMeters / this.currentTerrainZoom();
    const centerOffset = localOffset(terrain.center, centerLocation);
    const min = terrain.minElevation;
    const max = Math.max(min + 1, terrain.maxElevation);
    const cellW = (width / (terrain.resolution - 1)) * this.currentTerrainZoom();
    const cellH = (height / (terrain.resolution - 1)) * this.currentTerrainZoom();

    for (let z = 0; z < terrain.resolution; z += 1) {
      for (let x = 0; x < terrain.resolution; x += 1) {
        const sample = terrain.samples[z][x];
        const east = sample.east - centerOffset.east;
        const north = sample.north - centerOffset.north;
        if (Math.abs(east) > visibleExtent || Math.abs(north) > visibleExtent) {
          continue;
        }
        const px = ((east + visibleExtent) / (visibleExtent * 2)) * width;
        const py = height - ((north + visibleExtent) / (visibleExtent * 2)) * height;
        const t = clamp((sample.elevation - min) / (max - min), 0, 1);
        const r = Math.round(26 + t * 172);
        const g = Math.round(78 + t * 118);
        const b = Math.round(70 - t * 28);
        this.context.fillStyle = `rgba(${r}, ${g}, ${b}, 0.42)`;
        this.context.fillRect(px - cellW / 2, py - cellH / 2, cellW + 1, cellH + 1);
      }
    }
  }

  private drawPov(width: number, height: number): void {
    if (!this.location) {
      return;
    }
    const point = this.pointForLocation(this.location, width, height);
    if (!point) {
      return;
    }
    const lookX = Math.sin(this.yaw);
    const lookY = -Math.cos(this.yaw);

    this.context.save();
    this.context.translate(point.x, point.y);
    this.context.strokeStyle = "rgba(255, 230, 160, 0.95)";
    this.context.lineWidth = 2;
    this.context.beginPath();
    this.context.moveTo(0, 0);
    this.context.lineTo(lookX * 52, lookY * 52);
    this.context.stroke();
    this.context.fillStyle = "#ffe28a";
    this.context.beginPath();
    this.context.arc(0, 0, 5, 0, Math.PI * 2);
    this.context.fill();
    this.context.restore();
  }

  private pointForLocation(location: LocationPoint, width: number, height: number): { x: number; y: number } | undefined {
    const centerLocation = this.mapCenter();
    if (!centerLocation) {
      return undefined;
    }

    const source = this.settings?.mapSource ?? "terrainCanvas";
    if (source !== "terrainCanvas" && this.settings) {
      const zoom = this.pickZoom(width);
      const tileSize = 256;
      const center = latLonToWorldPixel(centerLocation.lon, centerLocation.lat, zoom, tileSize);
      const point = latLonToWorldPixel(location.lon, location.lat, zoom, tileSize);
      return {
        x: point.x - center.x + width / 2,
        y: point.y - center.y + height / 2
      };
    }

    if (!this.terrain) {
      return undefined;
    }
    const visibleExtent = this.terrain.extentMeters / this.currentTerrainZoom();
    const offset = localOffset(centerLocation, location);
    return {
      x: ((offset.east + visibleExtent) / (visibleExtent * 2)) * width,
      y: height - ((offset.north + visibleExtent) / (visibleExtent * 2)) * height
    };
  }

  private pickZoom(width: number, centerLocation = this.mapCenter()): number {
    if (!this.terrain || !centerLocation) {
      return clamp(10 + this.zoomOffset, 4, 18);
    }
    const metersPerPixel = (this.terrain.extentMeters * 2.2) / Math.max(width, 1);
    const latRad = (centerLocation.lat * Math.PI) / 180;
    return clamp(Math.floor(Math.log2((156543.03392 * Math.cos(latRad)) / metersPerPixel)) + this.zoomOffset, 4, 18);
  }

  private mapCenter(): LocationPoint | undefined {
    return this.viewportCenter ?? this.location;
  }

  private currentTerrainZoom(): number {
    return 2 ** this.zoomOffset;
  }

  private getRasterTile(source: MapSource, zoom: number, x: number, y: number): RasterTile {
    const scale = 2 ** zoom;
    const wrappedX = ((x % scale) + scale) % scale;
    const clampedY = clamp(y, 0, scale - 1);
    const token = this.settings?.apiKeys.mapbox.trim() ?? "";
    const url =
      source === "mapboxRaster"
        ? `https://api.mapbox.com/styles/v1/mapbox/outdoors-v12/tiles/256/${zoom}/${wrappedX}/${clampedY}?access_token=${encodeURIComponent(token)}`
        : `https://tile.openstreetmap.org/${zoom}/${wrappedX}/${clampedY}.png`;
    const key = `${source}:${zoom}:${wrappedX}:${clampedY}:${token.slice(0, 8)}`;
    const cached = rasterCache.get(key);
    if (cached) {
      rasterCache.delete(key);
      rasterCache.set(key, cached);
      return cached;
    }
    const tile: RasterTile = {
      image: new Image(),
      ready: false
    };
    tile.image.crossOrigin = "anonymous";
    tile.image.onload = () => {
      tile.ready = true;
      this.reportRasterIssue?.();
      this.draw();
    };
    tile.image.onerror = () => {
      tile.ready = false;
      this.reportRasterIssue?.(`${source === "mapboxRaster" ? "Mapbox" : "OpenStreetMap"} map tile service issue: map tiles could not load.`);
      if (rasterCache.get(key) === tile) {
        revokeRasterObjectUrl(tile);
        rasterCache.delete(key);
      }
    };
    rasterCache.set(key, tile);
    evictRasterCache();
    void this.loadRasterTile(tile, key, url, source);
    return tile;
  }

  private async loadRasterTile(tile: RasterTile, key: string, url: string, source: MapSource): Promise<void> {
    try {
      const blob = await fetchCachedBlob("horizon-map-raster-v1", url, RASTER_TILE_TTL_MS);
      if (rasterCache.get(key) !== tile) {
        return;
      }
      revokeRasterObjectUrl(tile);
      tile.objectUrl = URL.createObjectURL(blob);
      tile.image.src = tile.objectUrl;
    } catch {
      if (rasterCache.get(key) !== tile) {
        return;
      }
      this.reportRasterIssue?.(`${source === "mapboxRaster" ? "Mapbox" : "OpenStreetMap"} map tile cache issue: using direct tile loading.`);
      tile.image.src = url;
    }
  }

  private onPointerDown(event: PointerEvent): void {
    if (event.button !== 0) {
      return;
    }
    const rect = this.canvas.getBoundingClientRect();
    const center = this.mapCenter();
    if (!center) {
      return;
    }
    this.pointerDown = {
      moved: false,
      startCenter: center,
      startZoom: this.pickZoom(rect.width, center),
      x: event.clientX,
      y: event.clientY,
      pointerId: event.pointerId
    };
    this.canvas.setPointerCapture(event.pointerId);
  }

  private onPointerMove(event: PointerEvent): void {
    if (!this.pointerDown || this.pointerDown.pointerId !== event.pointerId) {
      return;
    }
    const distance = Math.hypot(event.clientX - this.pointerDown.x, event.clientY - this.pointerDown.y);
    if (!this.pointerDown.moved && distance <= 5) {
      return;
    }
    this.pointerDown.moved = true;
    this.viewportCenter = this.centerAfterDrag(this.pointerDown, event);
    event.preventDefault();
    this.draw();
  }

  private onPointerUp(event: PointerEvent): void {
    if (!this.pointerDown || this.pointerDown.pointerId !== event.pointerId) {
      return;
    }
    const pointerDown = this.pointerDown;
    this.pointerDown = undefined;
    this.canvas.releasePointerCapture(event.pointerId);
    if (pointerDown.moved) {
      return;
    }

    const location = this.locationForPointer(event);
    if (location) {
      this.onSelectLocation?.({
        ...location,
        label: `Map ${location.label}`
      });
    }
  }

  private centerAfterDrag(pointerDown: PointerDownState, event: PointerEvent): LocationPoint {
    const dx = event.clientX - pointerDown.x;
    const dy = event.clientY - pointerDown.y;
    const rect = this.canvas.getBoundingClientRect();
    const source = this.settings?.mapSource ?? "terrainCanvas";
    if (source !== "terrainCanvas" && this.settings) {
      const tileSize = 256;
      const center = latLonToWorldPixel(pointerDown.startCenter.lon, pointerDown.startCenter.lat, pointerDown.startZoom, tileSize);
      return worldPixelToLonLat(center.x - dx, center.y - dy, pointerDown.startZoom, tileSize);
    }

    if (!this.terrain) {
      return pointerDown.startCenter;
    }
    const visibleExtent = this.terrain.extentMeters / this.currentTerrainZoom();
    const east = (-dx / Math.max(rect.width, 1)) * visibleExtent * 2;
    const north = (dy / Math.max(rect.height, 1)) * visibleExtent * 2;
    return offsetLocation(pointerDown.startCenter, east, north);
  }

  private locationForPointer(event: PointerEvent): LocationPoint | undefined {
    const centerLocation = this.mapCenter();
    if (!centerLocation) {
      return undefined;
    }

    const rect = this.canvas.getBoundingClientRect();
    const x = clamp(event.clientX - rect.left, 0, rect.width);
    const y = clamp(event.clientY - rect.top, 0, rect.height);
    const source = this.settings?.mapSource ?? "terrainCanvas";
    if (source !== "terrainCanvas" && this.settings) {
      const zoom = this.pickZoom(rect.width);
      const tileSize = 256;
      const center = latLonToWorldPixel(centerLocation.lon, centerLocation.lat, zoom, tileSize);
      return worldPixelToLonLat(center.x - rect.width / 2 + x, center.y - rect.height / 2 + y, zoom, tileSize);
    }

    if (!this.terrain) {
      return undefined;
    }
    const visibleExtent = this.terrain.extentMeters / this.currentTerrainZoom();
    const east = (x / Math.max(rect.width, 1) - 0.5) * visibleExtent * 2;
    const north = (0.5 - y / Math.max(rect.height, 1)) * visibleExtent * 2;
    return offsetLocation(centerLocation, east, north);
  }
}

function evictRasterCache(): void {
  while (rasterCache.size > RASTER_TILE_CACHE_LIMIT) {
    const oldestKey = rasterCache.keys().next().value;
    if (oldestKey === undefined) {
      break;
    }
    const tile = rasterCache.get(oldestKey);
    if (tile) {
      revokeRasterObjectUrl(tile);
      rasterCache.delete(oldestKey);
    }
  }
}

function revokeRasterObjectUrl(tile: RasterTile): void {
  if (tile.objectUrl) {
    URL.revokeObjectURL(tile.objectUrl);
    tile.objectUrl = undefined;
  }
}
