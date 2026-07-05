import "./styles.css";
import * as THREE from "three";
import SunCalc from "suncalc";
import { loadCloudSnapshot } from "./data/clouds";
import { hrrrZarrCoversLocation } from "./data/hrrr";
import { searchLocations } from "./data/geocoders";
import { loadTerrainGrid, recenterTerrainGrid, terrainHasCoverage } from "./data/terrain";
import {
  addHours,
  clamp,
  DEFAULT_LOCATION,
  degreesToRadians,
  distanceMeters,
  formatCoordinate,
  formatTime,
  hashNumber,
  offsetLocation,
  radiansToDegrees,
  roundToHour,
  seededRandom
} from "./geo";
import { MiniMap } from "./miniMap";
import { PanoramaRenderer } from "./panorama";
import { defaultSettings, loadSettings, resetSettings, saveSettings } from "./settings";
import type { CloudDataMode, CloudLayer, CloudSnapshot, CloudVolume, LocationPoint, Settings, TerrainGrid } from "./types";

interface DragState {
  pointerId: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  button: number;
  moved: boolean;
}

type DiagnosticSeverity = "info" | "warning" | "error";

interface DiagnosticEntry {
  message: string;
  severity: DiagnosticSeverity;
}

interface InitialRoute {
  eyeElevation?: number;
  fov?: number;
  location: LocationPoint;
  pitch?: number;
  yaw?: number;
}

interface CloudPuffSpec {
  color: THREE.Color;
  matrix: THREE.Matrix4;
}

const canvas = element<HTMLCanvasElement>("scene");
const panoramaCanvas = element<HTMLCanvasElement>("terrainPanorama");
const searchForm = element<HTMLFormElement>("searchForm");
const searchInput = element<HTMLInputElement>("searchInput");
const searchResults = element<HTMLDivElement>("searchResults");
const heightSlider = element<HTMLInputElement>("heightSlider");
const heightValue = element<HTMLOutputElement>("heightValue");
const terrainHeightValue = element<HTMLButtonElement>("terrainHeightValue");
const fovSlider = element<HTMLInputElement>("fovSlider");
const fovValue = element<HTMLOutputElement>("fovValue");
const timeControl = element<HTMLElement>("timeControl");
const timeValue = element<HTMLOutputElement>("timeValue");
const timeStepButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-hours]"));
const statusPill = element<HTMLDivElement>("statusPill");
const menuButton = element<HTMLButtonElement>("menuButton");
const menuDialog = element<HTMLDialogElement>("menuDialog");
const settingsButton = element<HTMLButtonElement>("settingsButton");
const settingsDialog = element<HTMLDialogElement>("settingsDialog");
const settingsForm = element<HTMLFormElement>("settingsForm");
const closeSettingsButton = element<HTMLButtonElement>("closeSettingsButton");
const resetSettingsButton = element<HTMLButtonElement>("resetSettingsButton");
const mapCenterButton = element<HTMLButtonElement>("mapCenterButton");
const dataModeControl = element<HTMLElement>("dataModeControl");
const realTimeModeButton = element<HTMLButtonElement>("realTimeModeButton");
const predictionModeButton = element<HTMLButtonElement>("predictionModeButton");
const cloudModeLabel = element<HTMLElement>("cloudModeLabel");
const cloudTotalValue = element<HTMLOutputElement>("cloudTotalValue");
const cloudTotalMeter = element<HTMLElement>("cloudTotalMeter");
const cloudLowMeter = element<HTMLElement>("cloudLowMeter");
const cloudMidMeter = element<HTMLElement>("cloudMidMeter");
const cloudHighMeter = element<HTMLElement>("cloudHighMeter");
const cloudLowValue = element<HTMLOutputElement>("cloudLowValue");
const cloudMidValue = element<HTMLOutputElement>("cloudMidValue");
const cloudHighValue = element<HTMLOutputElement>("cloudHighValue");

const terrainSource = element<HTMLSelectElement>("terrainSource");
const cloudSource = element<HTMLSelectElement>("cloudSource");
const geocoderSource = element<HTMLSelectElement>("geocoderSource");
const mapSource = element<HTMLSelectElement>("mapSource");
const mapboxToken = element<HTMLInputElement>("mapboxToken");
const openMeteoKey = element<HTMLInputElement>("openMeteoKey");
const terrainScale = element<HTMLInputElement>("terrainScale");
const MIN_EYE_ELEVATION_METERS = 0;
const MAX_EYE_ELEVATION_METERS = 1000;
const HEIGHT_TERRAIN_SNAP_METERS = 5;
const TERRAIN_REUSE_RADIUS_FRACTION = 0.55;
const CLOUD_RELOAD_DEBOUNCE_MS = 500;
const REALTIME_CLOUD_REFRESH_MS = 5 * 60 * 1000;
const CLOUD_REUSE_DISTANCE_METERS = 30000;
const CLOUD_VOLUME_STYLES = {
  low: {
    color: "#d7e4e2",
    opacity: 0.24,
    renderOrder: 3,
    horizontalScale: 1,
    verticalScale: 1
  },
  mid: {
    color: "#e3dfd1",
    opacity: 0.2,
    renderOrder: 2,
    horizontalScale: 1.16,
    verticalScale: 0.82
  },
  high: {
    color: "#f2ebd4",
    opacity: 0.15,
    renderOrder: 1,
    horizontalScale: 1.45,
    verticalScale: 0.58
  }
} as const satisfies Record<
  CloudLayer,
  {
    color: string;
    horizontalScale: number;
    opacity: number;
    renderOrder: number;
    verticalScale: number;
  }
>;

class HorizonApp {
  private readonly renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.5, 140000);
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly terrainGroup = new THREE.Group();
  private readonly cloudGroup = new THREE.Group();
  private readonly celestialGroup = new THREE.Group();
  private readonly panorama = new PanoramaRenderer(panoramaCanvas);
  private readonly diagnostics = new Map<string, DiagnosticEntry>();
  private statusMessage = "Loading";
  private readonly miniMap = new MiniMap(
    element<HTMLCanvasElement>("miniMap"),
    element<HTMLElement>("miniMapPanel"),
    element<HTMLElement>("mapAttribution"),
    (location) => void this.warpTo(location, false),
    (message) => this.updateDiagnostic("map-raster", message ? { message, severity: "warning" } : undefined)
  );
  private readonly timer = new THREE.Timer();
  private readonly sunLight = new THREE.DirectionalLight("#fff3c2", 1.4);
  private readonly ambient = new THREE.HemisphereLight("#bcd7ff", "#344c32", 0.62);

  private settings = loadSettings();
  private location = DEFAULT_LOCATION;
  private terrain?: TerrainGrid;
  private clouds?: CloudSnapshot;
  private terrainMesh?: THREE.Mesh;
  private seaMesh?: THREE.Mesh;
  private drag?: DragState;
  private yaw = Math.PI / 2;
  private pitch = 0;
  private fov = 70;
  private heightOffset = 2;
  private time = roundToHour(new Date());
  private cloudMode: CloudDataMode = "prediction";
  private loadId = 0;
  private cloudReloadId = 0;
  private cloudReloadTimer?: number;
  private realtimeRefreshTimer?: number;
  private cloudTexture?: THREE.Texture;
  private terrainAbort?: AbortController;
  private cloudAbort?: AbortController;
  private cloudReloadAbort?: AbortController;
  private searchAbort?: AbortController;
  private pendingEyeElevation?: number;
  private terrainDataKey?: string;
  private cloudDataKey?: string;

  async start(): Promise<void> {
    this.configureRenderer();
    this.configureScene();
    this.bindUi();
    this.populateSettingsForm();
    this.updateConfigurationDiagnostics();
    this.updateDataModeUi();
    this.updateHud();
    const initialRoute = this.readInitialRoute();
    if (initialRoute) {
      this.applyInitialRoute(initialRoute);
      await this.warpTo(initialRoute.location, false);
    } else {
      this.location = await this.detectInitialLocation();
      await this.warpTo(this.location, true);
    }
    this.animate();
  }

  private configureRenderer(): void {
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.timer.connect(document);
    this.camera.position.set(0, this.heightOffset, 0);
    window.addEventListener("resize", () => this.resize());
  }

  private configureScene(): void {
    this.scene.background = new THREE.Color("#6e95a6");
    this.scene.fog = new THREE.FogExp2("#9bb5b2", 0.000018);
    this.scene.add(this.terrainGroup);
    this.scene.add(this.cloudGroup);
    this.scene.add(this.celestialGroup);
    this.scene.add(this.ambient);
    this.scene.add(this.sunLight);
  }

  private readInitialRoute(): InitialRoute | undefined {
    const params = new URLSearchParams(window.location.search);
    const lat = readFiniteParam(params, "lat");
    const lon = readFiniteParam(params, "lng") ?? readFiniteParam(params, "lon");
    if (lat === undefined || lon === undefined || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      return undefined;
    }

    const name = params.get("name")?.trim();
    const elevation = readFiniteParam(params, "ele");
    const azi = readFiniteParam(params, "azi");
    const alt = readFiniteParam(params, "alt");
    const fov = readFiniteParam(params, "fov");

    return {
      eyeElevation: elevation,
      fov: fov === undefined ? undefined : clamp(fov, 35, 110),
      location: {
        lat,
        lon,
        elevation,
        label: name || `${formatCoordinate(lat, "lat")}, ${formatCoordinate(lon, "lon")}`
      },
      pitch: alt === undefined ? undefined : clamp(degreesToRadians(alt), -1.32, 1.32),
      yaw: azi === undefined ? undefined : degreesToRadians(((azi % 360) + 360) % 360)
    };
  }

  private applyInitialRoute(route: InitialRoute): void {
    this.location = route.location;
    if (route.yaw !== undefined) {
      this.yaw = route.yaw;
    }
    if (route.pitch !== undefined) {
      this.pitch = route.pitch;
    }
    if (route.fov !== undefined) {
      this.fov = route.fov;
    }
    this.pendingEyeElevation = route.eyeElevation;
  }

  private bindUi(): void {
    canvas.addEventListener("contextmenu", (event) => event.preventDefault());
    canvas.addEventListener("pointerdown", (event) => this.onPointerDown(event));
    canvas.addEventListener("pointermove", (event) => this.onPointerMove(event));
    canvas.addEventListener("pointerup", (event) => this.onPointerUp(event));
    canvas.addEventListener("pointercancel", () => {
      this.drag = undefined;
    });

    searchForm.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.performSearch();
    });

    heightSlider.min = String(MIN_EYE_ELEVATION_METERS);
    heightSlider.max = String(MAX_EYE_ELEVATION_METERS);
    heightSlider.addEventListener("input", () => {
      this.setEyeElevation(Number(heightSlider.value));
      this.updateHud();
      this.updateCamera();
    });
    heightSlider.addEventListener("change", () => {
      this.setEyeElevation(Number(heightSlider.value), true);
      this.updateHud();
      this.updateCamera();
    });
    terrainHeightValue.addEventListener("click", () => {
      this.setEyeElevation(this.terrainElevation(), true);
      this.updateHud();
      this.updateCamera();
    });

    fovSlider.addEventListener("input", () => {
      this.fov = Number(fovSlider.value);
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
      this.updateHud();
      this.renderPanorama();
    });

    timeStepButtons.forEach((button) => {
      button.addEventListener("click", () => {
        if (this.cloudMode === "realtime") {
          return;
        }
        this.time = addHours(this.time, Number(button.dataset.hours));
        this.updateHud();
        this.updateSky();
        this.scheduleCloudReload();
      });
    });

    realTimeModeButton.addEventListener("click", () => this.setCloudMode("realtime"));
    predictionModeButton.addEventListener("click", () => this.setCloudMode("prediction"));

    menuButton.addEventListener("click", () => {
      menuDialog.showModal();
    });
    settingsButton.addEventListener("click", (event) => {
      event.preventDefault();
      menuDialog.close();
      this.populateSettingsForm();
      settingsDialog.showModal();
    });
    closeSettingsButton.addEventListener("click", () => settingsDialog.close());
    resetSettingsButton.addEventListener("click", () => {
      this.settings = resetSettings();
      this.populateSettingsForm();
      this.updateConfigurationDiagnostics();
      void this.warpTo(this.location, false);
    });
    settingsForm.addEventListener("submit", (event) => {
      event.preventDefault();
      this.settings = this.readSettingsForm();
      saveSettings(this.settings);
      settingsDialog.close();
      this.updateConfigurationDiagnostics();
      this.updateStatus("Reloading data sources");
      void this.warpTo(this.location, false);
    });
    mapCenterButton.addEventListener("click", () => this.miniMap.center());
  }

  private async detectInitialLocation(): Promise<LocationPoint> {
    const browserLocation = await new Promise<LocationPoint | undefined>((resolve) => {
      if (!navigator.geolocation) {
        resolve(undefined);
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (position) =>
          resolve({
            lat: position.coords.latitude,
            lon: position.coords.longitude,
            label: "Browser location"
          }),
        () => resolve(undefined),
        { enableHighAccuracy: false, maximumAge: 900000, timeout: 4500 }
      );
    });
    if (browserLocation) {
      return browserLocation;
    }

    try {
      const response = await fetch("https://ipapi.co/json/");
      if (response.ok) {
        const body = (await response.json()) as {
          latitude?: number;
          longitude?: number;
          city?: string;
          region?: string;
          country_name?: string;
        };
        if (typeof body.latitude === "number" && typeof body.longitude === "number") {
          return {
            lat: body.latitude,
            lon: body.longitude,
            label: [body.city, body.region, body.country_name].filter(Boolean).join(", ") || "IP location"
          };
        }
      }
      this.updateDiagnostic("location-service", {
        message: "IP location service issue: using the default location.",
        severity: "warning"
      });
    } catch {
      this.updateDiagnostic("location-service", {
        message: "IP location service issue: using the default location.",
        severity: "warning"
      });
      return DEFAULT_LOCATION;
    }

    return DEFAULT_LOCATION;
  }

  private async performSearch(): Promise<void> {
    const query = searchInput.value.trim();
    if (!query) {
      return;
    }
    this.searchAbort?.abort();
    this.searchAbort = new AbortController();
    this.updateStatus("Searching locations");
    searchResults.hidden = true;
    searchResults.replaceChildren();

    try {
      const results = await searchLocations(query, this.settings, this.location, this.searchAbort.signal);
      this.updateDiagnostic("search-service", undefined);
      if (!results.length) {
        this.updateStatus("No location results");
        return;
      }
      if (results.length === 1) {
        await this.warpTo(results[0], true);
        return;
      }
      results.forEach((result) => {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = result.label;
        button.addEventListener("click", () => {
          searchResults.hidden = true;
          searchInput.value = result.label;
          void this.warpTo(result, true);
        });
        searchResults.append(button);
      });
      searchResults.hidden = false;
      this.updateStatus(`${results.length} locations`);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return;
      }
      const message = error instanceof Error ? error.message : "Search failed";
      this.updateDiagnostic("search-service", {
        message: `Search service issue: ${message}`,
        severity: "warning"
      });
      this.updateStatus(message);
    }
  }

  private async warpTo(location: LocationPoint, faceEast: boolean): Promise<void> {
    this.loadId += 1;
    this.cloudReloadId += 1;
    const id = this.loadId;
    this.cancelScheduledCloudReload();
    const previousLocation = this.location;
    this.terrainAbort?.abort();
    this.cloudAbort?.abort();
    this.cloudReloadAbort?.abort();
    this.terrainAbort = undefined;
    const terrainDataKey = this.terrainRequestKey();
    const reusableTerrainGrid =
      this.terrainDataKey === terrainDataKey &&
      this.terrain !== undefined &&
      terrainHasCoverage(this.terrain, location, this.terrain.extentMeters * TERRAIN_REUSE_RADIUS_FRACTION)
        ? this.terrain
        : undefined;
    const terrainController = reusableTerrainGrid ? undefined : new AbortController();
    const cloudController = new AbortController();
    if (terrainController) {
      this.terrainAbort = terrainController;
    }
    this.cloudAbort = cloudController;
    this.location = location;
    if (faceEast) {
      this.yaw = Math.PI / 2;
      this.pitch = 0;
    }
    searchInput.value = location.label;
    if (this.cloudMode === "realtime") {
      this.time = new Date();
    }
    const requestedCloudMode = this.cloudMode;
    const requestedCloudTime = this.time;
    const cloudDataKey = this.cloudRequestKey(requestedCloudMode);
    const reusableClouds = this.reusableCloudSnapshot(previousLocation, location, requestedCloudTime, requestedCloudMode, cloudDataKey);
    this.updateHud();
    this.updateStatus(`Loading ${location.label}`);
    this.updateDiagnostic("terrain-service", undefined);
    this.updateDiagnostic("cloud-service", undefined);
    this.updateDiagnostic("load-service", undefined);

    let terrain: TerrainGrid;
    let clouds: CloudSnapshot;
    try {
      [terrain, clouds] = await Promise.all([
        reusableTerrainGrid ? Promise.resolve(recenterTerrainGrid(reusableTerrainGrid, location)) : loadTerrainGrid(location, this.settings, terrainController?.signal),
        reusableClouds ? Promise.resolve({ ...reusableClouds, time: requestedCloudTime }) : loadCloudSnapshot(location, requestedCloudTime, this.settings, cloudController.signal, requestedCloudMode)
      ]);
    } catch (error) {
      if (terrainController?.signal.aborted || cloudController.signal.aborted || isAbortError(error)) {
        return;
      }
      const message = errorMessage(error, "Loading location failed");
      this.updateDiagnostic("load-service", {
        message,
        severity: "error"
      });
      this.updateStatus(message);
      return;
    }

    if (id !== this.loadId) {
      return;
    }

    const resolvedLocation = {
      ...location,
      elevation: terrain.groundElevation
    };
    terrain = {
      ...terrain,
      center: resolvedLocation
    };
    this.location = resolvedLocation;
    this.terrainDataKey = terrainDataKey;
    this.terrain = terrain;
    if (this.pendingEyeElevation !== undefined) {
      this.setEyeElevation(this.pendingEyeElevation, true);
      this.pendingEyeElevation = undefined;
    } else {
      this.setEyeElevation(this.currentEyeElevation());
    }
    this.buildTerrainMesh(terrain);
    if (requestedCloudMode === this.cloudMode && clouds.time.getTime() === requestedCloudTime.getTime()) {
      this.clouds = clouds;
      this.cloudDataKey = cloudDataKey;
      this.buildClouds(clouds);
    }
    this.updateHud();
    this.updateSky();
    this.updateCamera();
    this.updateMiniMap();
    this.updateLoadedDataDiagnostics();
    this.updateStatus(this.statusText());
  }

  private scheduleCloudReload(): void {
    this.cloudReloadId += 1;
    this.cloudReloadAbort?.abort();
    const requestId = this.cloudReloadId;
    this.cancelScheduledCloudReload();
    this.cloudReloadTimer = window.setTimeout(() => {
      this.cloudReloadTimer = undefined;
      void this.reloadClouds(requestId);
    }, CLOUD_RELOAD_DEBOUNCE_MS);
  }

  private cancelScheduledCloudReload(): void {
    if (this.cloudReloadTimer !== undefined) {
      window.clearTimeout(this.cloudReloadTimer);
      this.cloudReloadTimer = undefined;
    }
  }

  private async reloadClouds(requestId = ++this.cloudReloadId): Promise<void> {
    if (requestId !== this.cloudReloadId) {
      return;
    }
    this.cloudReloadAbort?.abort();
    const controller = new AbortController();
    this.cloudReloadAbort = controller;
    const id = this.loadId;
    if (this.cloudMode === "realtime") {
      this.time = new Date();
      this.updateHud();
      this.updateSky();
    }
    const requestedTime = this.time;
    const requestedMode = this.cloudMode;
    const cloudDataKey = this.cloudRequestKey(requestedMode);
    this.updateStatus("Loading cloud data");
    this.updateDiagnostic("cloud-service", undefined);
    try {
      const clouds = await loadCloudSnapshot(this.location, requestedTime, this.settings, controller.signal, requestedMode);
      if (
        id !== this.loadId ||
        requestId !== this.cloudReloadId ||
        controller.signal.aborted ||
        requestedMode !== this.cloudMode ||
        clouds.time.getTime() !== this.time.getTime()
      ) {
        return;
      }
      this.clouds = clouds;
      this.cloudDataKey = cloudDataKey;
      this.buildClouds(clouds);
      this.updateHud();
      this.updateSky();
      this.updateCloudDiagnostics(clouds);
      this.updateStatus(this.statusText());
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) {
        return;
      }
      if (id === this.loadId && requestId === this.cloudReloadId) {
        const message = errorMessage(error, "Loading cloud data failed");
        this.updateDiagnostic("cloud-service", {
          message: `Cloud service issue: ${message}`,
          severity: "warning"
        });
        this.updateStatus(message);
      }
    } finally {
      if (this.cloudReloadAbort === controller) {
        this.cloudReloadAbort = undefined;
      }
    }
  }

  private buildTerrainMesh(grid: TerrainGrid): void {
    this.disposeGroupChildren(this.terrainGroup);
    this.terrainMesh = undefined;
    this.seaMesh = undefined;

    const resolution = grid.resolution;
    const positions = new Float32Array(resolution * resolution * 3);
    const colors = new Float32Array(resolution * resolution * 3);
    const indices: number[] = [];
    const color = new THREE.Color();
    const min = grid.minElevation;
    const max = Math.max(grid.maxElevation, min + 1);

    for (let z = 0; z < resolution; z += 1) {
      for (let x = 0; x < resolution; x += 1) {
        const index = z * resolution + x;
        const sample = grid.samples[z][x];
        const y = (sample.elevation - grid.groundElevation) * this.settings.terrainVerticalScale;
        positions[index * 3] = sample.east;
        positions[index * 3 + 1] = y;
        positions[index * 3 + 2] = sample.north;

        const t = clamp((sample.elevation - min) / (max - min), 0, 1);
        if (sample.elevation <= 0) {
          color.setRGB(0.11, 0.27 + t * 0.1, 0.34 + t * 0.2);
        } else if (t < 0.46) {
          color.setRGB(0.16 + t * 0.25, 0.34 + t * 0.35, 0.19 + t * 0.09);
        } else if (t < 0.78) {
          color.setRGB(0.48 + t * 0.22, 0.42 + t * 0.12, 0.28 + t * 0.08);
        } else {
          color.setRGB(0.72 + t * 0.16, 0.68 + t * 0.14, 0.62 + t * 0.16);
        }
        colors[index * 3] = color.r;
        colors[index * 3 + 1] = color.g;
        colors[index * 3 + 2] = color.b;
      }
    }

    for (let z = 0; z < resolution - 1; z += 1) {
      for (let x = 0; x < resolution - 1; x += 1) {
        const a = z * resolution + x;
        const b = a + 1;
        const c = a + resolution;
        const d = c + 1;
        indices.push(a, c, b, b, c, d);
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();

    const material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.96,
      metalness: 0,
      side: THREE.DoubleSide
    });
    this.terrainMesh = new THREE.Mesh(geometry, material);
    this.terrainMesh.name = "warpable-terrain";
    this.terrainGroup.add(this.terrainMesh);

    const seaGeometry = new THREE.PlaneGeometry(grid.extentMeters * 2.3, grid.extentMeters * 2.3, 1, 1);
    const seaMaterial = new THREE.MeshStandardMaterial({
      color: "#1d5263",
      transparent: true,
      opacity: 0.74,
      roughness: 0.45,
      metalness: 0.1
    });
    this.seaMesh = new THREE.Mesh(seaGeometry, seaMaterial);
    this.seaMesh.rotation.x = -Math.PI / 2;
    this.seaMesh.position.y = (0 - grid.groundElevation) * this.settings.terrainVerticalScale - 0.8;
    material.colorWrite = false;
    material.depthWrite = false;
    this.seaMesh.visible = false;
    this.terrainGroup.add(this.seaMesh);
    this.renderPanorama();
  }

  private buildClouds(snapshot: CloudSnapshot): void {
    this.disposeGroupChildren(this.cloudGroup);
    if (snapshot.map?.volumes.length) {
      this.buildMappedCloudVolumes(snapshot);
      return;
    }

    const layers = [
      { name: "low", cover: snapshot.low, altitude: 1200, max: 26, scale: [2100, 640] },
      { name: "mid", cover: snapshot.mid, altitude: 4300, max: 28, scale: [3100, 760] },
      { name: "high", cover: snapshot.high, altitude: 8200, max: 22, scale: [4600, 860] }
    ] as const;

    for (const layer of layers) {
      const random = seededRandom(`${this.location.lat.toFixed(2)}:${this.location.lon.toFixed(2)}:${snapshot.time.toISOString()}:${layer.name}`);
      const modeDensity = snapshot.dataMode === "realtime" ? 1.18 : 1;
      const count = Math.round((layer.cover / 100) * layer.max * modeDensity);
      for (let i = 0; i < count; i += 1) {
        const angle = random() * Math.PI * 2;
        const radius = 9000 + random() * 46000;
        const sprite = new THREE.Sprite(
          new THREE.SpriteMaterial({
            map: this.getCloudTexture(),
            color: new THREE.Color().setHSL(0.12, 0.18, 0.82 + random() * 0.12),
            transparent: true,
            opacity: clamp(0.2 + layer.cover / 220, 0.18, 0.64),
            depthWrite: false
          })
        );
        sprite.position.set(Math.sin(angle) * radius, layer.altitude + random() * 800, Math.cos(angle) * radius);
        sprite.scale.set(layer.scale[0] * (0.65 + random() * 0.9), layer.scale[1] * (0.7 + random() * 0.8), 1);
        sprite.userData.drift = true;
        this.cloudGroup.add(sprite);
      }
    }
  }

  private buildMappedCloudVolumes(snapshot: CloudSnapshot): void {
    const map = snapshot.map;
    if (!map?.volumes.length) {
      return;
    }

    const geometry = new THREE.SphereGeometry(1, 16, 8);
    const specsByLayer: Record<CloudLayer, CloudPuffSpec[]> = {
      low: [],
      mid: [],
      high: []
    };

    map.volumes.forEach((volume) => {
      this.cloudVolumePuffSpecs(volume, snapshot.time).forEach((spec) => {
        specsByLayer[volume.layer].push(spec);
      });
    });

    (Object.keys(specsByLayer) as CloudLayer[]).forEach((layer) => {
      const specs = specsByLayer[layer];
      if (!specs.length) {
        return;
      }
      const style = CLOUD_VOLUME_STYLES[layer];
      const material = new THREE.MeshStandardMaterial({
        color: style.color,
        depthWrite: false,
        opacity: style.opacity,
        roughness: 1,
        side: THREE.DoubleSide,
        transparent: true,
        vertexColors: true
      });
      const mesh = new THREE.InstancedMesh(geometry, material, specs.length);
      mesh.name = `${layer}-forecast-cloud-volumes`;
      mesh.frustumCulled = false;
      mesh.renderOrder = style.renderOrder;
      mesh.userData.drift = false;
      specs.forEach((spec, index) => {
        mesh.setMatrixAt(index, spec.matrix);
        mesh.setColorAt(index, spec.color);
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) {
        mesh.instanceColor.needsUpdate = true;
      }
      this.cloudGroup.add(mesh);
    });
  }

  private cloudVolumePuffSpecs(volume: CloudVolume, time: Date): CloudPuffSpec[] {
    const style = CLOUD_VOLUME_STYLES[volume.layer];
    const random = seededRandom(
      `${volume.lat.toFixed(3)}:${volume.lon.toFixed(3)}:${volume.altitudeMeters.toFixed(0)}:${time.toISOString()}:${volume.layer}`
    );
    const puffCount = clamp(Math.round(1 + volume.cover / 42), 1, 3);
    const specs: CloudPuffSpec[] = [];
    const baseAltitude =
      volume.altitudeReference === "seaLevel" ? volume.altitudeMeters - this.terrainElevation() : volume.altitudeMeters;
    const altitude = clamp(baseAltitude, 180, 14500);
    const baseColor = new THREE.Color(style.color);

    for (let index = 0; index < puffCount; index += 1) {
      const angle = random() * Math.PI * 2;
      const spread = index === 0 ? 0 : volume.radiusMeters * (0.18 + random() * 0.28);
      const position = new THREE.Vector3(
        volume.east + Math.cos(angle) * spread,
        altitude + (random() - 0.5) * volume.thicknessMeters * 0.45,
        volume.north + Math.sin(angle) * spread
      );
      const horizontalDensity = 0.74 + volume.cover / 180;
      const scale = new THREE.Vector3(
        volume.radiusMeters * style.horizontalScale * horizontalDensity * (0.74 + random() * 0.56),
        volume.thicknessMeters * style.verticalScale * (0.2 + volume.cover / 260) * (0.72 + random() * 0.52),
        volume.radiusMeters * style.horizontalScale * horizontalDensity * (0.62 + random() * 0.64)
      );
      const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, random() * Math.PI, 0));
      const matrix = new THREE.Matrix4().compose(position, quaternion, scale);
      const color = baseColor.clone().offsetHSL(0, 0, (random() - 0.5) * 0.08);
      specs.push({ color, matrix });
    }

    return specs;
  }

  private getCloudTexture(): THREE.Texture {
    if (this.cloudTexture) {
      return this.cloudTexture;
    }
    const cloudCanvas = document.createElement("canvas");
    cloudCanvas.width = 256;
    cloudCanvas.height = 96;
    const context = cloudCanvas.getContext("2d");
    if (!context) {
      throw new Error("Unable to create cloud texture");
    }
    const gradient = context.createRadialGradient(128, 48, 8, 128, 48, 120);
    gradient.addColorStop(0, "rgba(255,255,255,0.95)");
    gradient.addColorStop(0.45, "rgba(255,255,255,0.68)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, cloudCanvas.width, cloudCanvas.height);
    context.globalCompositeOperation = "source-over";
    for (let i = 0; i < 38; i += 1) {
      const x = 20 + Math.random() * 216;
      const y = 20 + Math.random() * 48;
      const r = 15 + Math.random() * 34;
      const puff = context.createRadialGradient(x, y, 2, x, y, r);
      puff.addColorStop(0, "rgba(255,255,255,0.72)");
      puff.addColorStop(1, "rgba(255,255,255,0)");
      context.fillStyle = puff;
      context.beginPath();
      context.arc(x, y, r, 0, Math.PI * 2);
      context.fill();
    }
    this.cloudTexture = new THREE.CanvasTexture(cloudCanvas);
    this.cloudTexture.colorSpace = THREE.SRGBColorSpace;
    return this.cloudTexture;
  }

  private updateSky(): void {
    this.disposeGroupChildren(this.celestialGroup);
    const sun = SunCalc.getPosition(this.time, this.location.lat, this.location.lon);
    const moon = SunCalc.getMoonPosition(this.time, this.location.lat, this.location.lon);
    const sunAltitude = sun.altitude;
    const cloudDim = 1 - (this.clouds?.total ?? 0) / 170;
    const dayMix = clamp((sunAltitude + 0.14) / 0.9, 0, 1);
    const skyColor = new THREE.Color().setRGB(0.08 + dayMix * 0.43 * cloudDim, 0.13 + dayMix * 0.45 * cloudDim, 0.16 + dayMix * 0.5 * cloudDim);
    this.scene.background = skyColor;
    this.scene.fog = new THREE.FogExp2(skyColor, 0.000013 + ((this.clouds?.total ?? 0) / 100) * 0.000011);

    this.addCelestial("sun", sun.azimuth, sun.altitude, 1700, "#fff0a5", sunAltitude > -0.1 ? 1 : 0.15);
    this.addCelestial("moon", moon.azimuth, moon.altitude, 1050, "#dce7f5", moon.altitude > -0.05 ? 0.9 : 0.08);

    const sunPosition = this.celestialToWorld(sun.azimuth, sun.altitude, 50000);
    this.sunLight.position.copy(sunPosition);
    this.sunLight.intensity = 0.3 + dayMix * 1.5;
    this.ambient.intensity = 0.34 + dayMix * 0.42;
  }

  private addCelestial(name: string, azimuth: number, altitude: number, size: number, color: string, opacity: number): void {
    const position = this.celestialToWorld(azimuth, altitude, 52000);
    const material = new THREE.SpriteMaterial({
      color,
      transparent: true,
      opacity,
      depthWrite: false
    });
    const sprite = new THREE.Sprite(material);
    sprite.name = name;
    sprite.position.copy(position);
    sprite.scale.set(size, size, 1);
    this.celestialGroup.add(sprite);
  }

  private disposeGroupChildren(group: THREE.Group): void {
    for (const child of [...group.children]) {
      this.disposeObject(child);
    }
    group.clear();
  }

  private disposeObject(object: THREE.Object3D): void {
    object.traverse((child) => {
      const geometry = (child as { geometry?: THREE.BufferGeometry }).geometry;
      geometry?.dispose();

      const material = (child as { material?: THREE.Material | THREE.Material[] }).material;
      if (Array.isArray(material)) {
        material.forEach((item) => item.dispose());
      } else {
        material?.dispose();
      }
    });
  }

  private celestialToWorld(azimuth: number, altitude: number, radius: number): THREE.Vector3 {
    const horizontal = Math.cos(altitude) * radius;
    return new THREE.Vector3(-Math.sin(azimuth) * horizontal, Math.sin(altitude) * radius, -Math.cos(azimuth) * horizontal);
  }

  private onPointerDown(event: PointerEvent): void {
    if (event.button !== 0 && event.button !== 2) {
      return;
    }
    this.drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      button: event.button,
      moved: false
    };
    canvas.setPointerCapture(event.pointerId);
  }

  private onPointerMove(event: PointerEvent): void {
    if (!this.drag || this.drag.pointerId !== event.pointerId) {
      return;
    }
    const dx = event.clientX - this.drag.lastX;
    const dy = event.clientY - this.drag.lastY;
    this.drag.lastX = event.clientX;
    this.drag.lastY = event.clientY;
    if (Math.hypot(event.clientX - this.drag.startX, event.clientY - this.drag.startY) > 4) {
      this.drag.moved = true;
    }
    if (this.drag.button === 2 || this.drag.moved) {
      this.yaw -= dx * 0.004;
      this.pitch = clamp(this.pitch + dy * 0.003, -1.32, 1.32);
      this.updateCamera();
      this.updateMiniMap();
    }
  }

  private onPointerUp(event: PointerEvent): void {
    if (!this.drag || this.drag.pointerId !== event.pointerId) {
      return;
    }
    const drag = this.drag;
    this.drag = undefined;
    canvas.releasePointerCapture(event.pointerId);
    if (drag.button === 0 && !drag.moved) {
      this.pickTerrain(event);
    }
  }

  private pickTerrain(event: PointerEvent): void {
    if (!this.terrainMesh || !this.terrain) {
      return;
    }
    const rect = canvas.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -(((event.clientY - rect.top) / rect.height) * 2 - 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const intersections = this.raycaster.intersectObject(this.terrainMesh, false);
    const hit = intersections.find((item) => item.distance > 20);
    if (!hit) {
      return;
    }
    const next = offsetLocation(this.location, hit.point.x, hit.point.z);
    next.label = `Terrain ${next.label}`;
    void this.warpTo(next, false);
  }

  private updateCamera(): void {
    this.camera.fov = this.fov;
    this.camera.position.set(0, this.heightOffset, 0);
    const direction = new THREE.Vector3(Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), Math.cos(this.yaw) * Math.cos(this.pitch));
    this.camera.lookAt(this.camera.position.clone().add(direction));
    this.camera.updateProjectionMatrix();
    this.renderPanorama();
  }

  private updateMiniMap(): void {
    this.miniMap.update(this.terrain, this.location, this.yaw, this.settings);
  }

  private setCloudMode(mode: CloudDataMode): void {
    const previousMode = this.cloudMode;
    if (mode === "realtime") {
      this.time = new Date();
    } else if (previousMode === "realtime") {
      this.time = roundToHour(this.time);
    }

    this.cloudMode = mode;
    if (mode !== previousMode) {
      this.clouds = undefined;
      this.cloudDataKey = undefined;
      this.disposeGroupChildren(this.cloudGroup);
    }
    this.updateDataModeUi();
    this.updateHud();
    this.updateSky();
    this.configureRealtimeRefresh();

    if (mode !== previousMode || mode === "realtime") {
      this.scheduleCloudReload();
    }
  }

  private configureRealtimeRefresh(): void {
    if (this.realtimeRefreshTimer !== undefined) {
      window.clearInterval(this.realtimeRefreshTimer);
      this.realtimeRefreshTimer = undefined;
    }
    if (this.cloudMode !== "realtime") {
      return;
    }
    this.realtimeRefreshTimer = window.setInterval(() => {
      if (this.cloudMode !== "realtime") {
        return;
      }
      this.time = new Date();
      this.updateHud();
      this.updateSky();
      this.scheduleCloudReload();
    }, REALTIME_CLOUD_REFRESH_MS);
  }

  private updateDataModeUi(): void {
    const realtime = this.cloudMode === "realtime";
    dataModeControl.dataset.mode = this.cloudMode;
    realTimeModeButton.setAttribute("aria-pressed", String(realtime));
    predictionModeButton.setAttribute("aria-pressed", String(!realtime));
    timeControl.classList.toggle("is-live-time", realtime);
    timeStepButtons.forEach((button) => {
      button.disabled = realtime;
    });
    cloudModeLabel.textContent = realtime ? "Real-time" : "Prediction";
  }

  private updateHud(): void {
    const terrainHeight = Math.round(this.terrainElevation());
    const eyeElevation = Math.round(this.currentEyeElevation());
    const relativeHeight = eyeElevation - terrainHeight;
    heightValue.textContent = `${eyeElevation} m\n(${formatSignedMeters(relativeHeight)})`;
    terrainHeightValue.textContent = `${terrainHeight} m`;
    fovValue.textContent = `${Math.round(this.fov)} deg`;
    timeValue.textContent = this.cloudMode === "realtime" ? `Now · ${formatTime(this.time)}` : formatTime(this.time);
    heightSlider.value = String(clamp(eyeElevation, MIN_EYE_ELEVATION_METERS, MAX_EYE_ELEVATION_METERS));
    fovSlider.value = String(this.fov);
    this.updateCloudReadout();
  }

  private updateCloudReadout(): void {
    const total = this.clouds?.total ?? 0;
    const low = this.clouds?.low ?? 0;
    const mid = this.clouds?.mid ?? 0;
    const high = this.clouds?.high ?? 0;

    cloudTotalValue.textContent = this.clouds ? `${total}%` : "--%";
    cloudLowValue.textContent = this.clouds ? `${low}%` : "--%";
    cloudMidValue.textContent = this.clouds ? `${mid}%` : "--%";
    cloudHighValue.textContent = this.clouds ? `${high}%` : "--%";
    setMeter(cloudTotalMeter, total, this.clouds !== undefined);
    setMeter(cloudLowMeter, low, this.clouds !== undefined);
    setMeter(cloudMidMeter, mid, this.clouds !== undefined);
    setMeter(cloudHighMeter, high, this.clouds !== undefined);
  }

  private setEyeElevation(value: number, force = false): void {
    this.heightOffset = this.heightOffsetForEyeElevation(value, force);
  }

  private heightOffsetForEyeElevation(value: number, force = false): number {
    return this.snapEyeElevation(value, force) - this.terrainElevation();
  }

  private snapEyeElevation(value: number, force = false): number {
    const rounded = clamp(Math.round(value), MIN_EYE_ELEVATION_METERS, MAX_EYE_ELEVATION_METERS);
    const terrainHeight = clamp(Math.round(this.terrainElevation()), MIN_EYE_ELEVATION_METERS, MAX_EYE_ELEVATION_METERS);
    const snapDistance = force ? HEIGHT_TERRAIN_SNAP_METERS * 2 : HEIGHT_TERRAIN_SNAP_METERS;
    return Math.abs(rounded - terrainHeight) <= snapDistance ? terrainHeight : rounded;
  }

  private terrainElevation(): number {
    return this.terrain?.groundElevation ?? this.location.elevation ?? 0;
  }

  private currentEyeElevation(): number {
    return this.terrainElevation() + this.heightOffset;
  }

  private terrainRequestKey(): string {
    const mapboxKey = this.settings.apiKeys.mapbox.trim();
    const openMeteoKey = this.settings.apiKeys.openMeteo.trim();
    return [
      this.settings.terrainSource,
      mapboxKey ? hashNumber(mapboxKey).toString(36) : "no-mapbox",
      openMeteoKey ? hashNumber(openMeteoKey).toString(36) : "open-meteo-public"
    ].join(":");
  }

  private cloudRequestKey(mode: CloudDataMode): string {
    const openMeteoKey = this.settings.apiKeys.openMeteo.trim();
    const regionalCoverage =
      this.settings.cloudSource === "hrrrZarr"
        ? hrrrZarrCoversLocation(this.location)
          ? "hrrr-native"
          : "global-fallback"
        : "standard";
    return [
      this.settings.cloudSource,
      mode,
      regionalCoverage,
      openMeteoKey ? hashNumber(openMeteoKey).toString(36) : "open-meteo-public"
    ].join(":");
  }

  private reusableCloudSnapshot(
    previousLocation: LocationPoint,
    nextLocation: LocationPoint,
    requestedTime: Date,
    requestedMode: CloudDataMode,
    cloudDataKey: string
  ): CloudSnapshot | undefined {
    if (!this.clouds || this.cloudDataKey !== cloudDataKey || this.clouds.dataMode !== requestedMode) {
      return undefined;
    }
    if (this.clouds.map && distanceMeters(previousLocation, nextLocation) > 250) {
      return undefined;
    }
    if (distanceMeters(previousLocation, nextLocation) > CLOUD_REUSE_DISTANCE_METERS) {
      return undefined;
    }
    if (requestedMode === "realtime") {
      return Math.abs(requestedTime.getTime() - this.clouds.time.getTime()) <= REALTIME_CLOUD_REFRESH_MS ? this.clouds : undefined;
    }
    return this.clouds.time.getTime() === requestedTime.getTime() ? this.clouds : undefined;
  }

  private updateStatus(message: string): void {
    this.statusMessage = message;
    this.renderDiagnostics();
  }

  private updateDiagnostic(id: string, entry: DiagnosticEntry | undefined): void {
    if (entry) {
      this.diagnostics.set(id, entry);
    } else {
      this.diagnostics.delete(id);
    }
    this.renderDiagnostics();
  }

  private renderDiagnostics(): void {
    statusPill.replaceChildren();
    statusPill.classList.toggle("has-diagnostics", this.diagnostics.size > 0);

    const current = document.createElement("div");
    current.className = "status-current";
    current.textContent = this.statusMessage;
    statusPill.append(current);

    for (const diagnostic of this.diagnostics.values()) {
      const row = document.createElement("div");
      row.className = `diagnostic-entry diagnostic-${diagnostic.severity}`;
      row.textContent = diagnostic.message;
      statusPill.append(row);
    }
  }

  private updateConfigurationDiagnostics(): void {
    const mapboxKeyMissing = !this.settings.apiKeys.mapbox.trim();

    this.updateDiagnostic(
      "config-mapbox-terrain",
      this.settings.terrainSource === "mapbox" && mapboxKeyMissing
        ? {
            message: "Mapbox terrain needs a Mapbox token in Settings.",
            severity: "warning"
          }
        : undefined
    );
    this.updateDiagnostic(
      "config-mapbox-geocoder",
      this.settings.geocoderSource === "mapbox" && mapboxKeyMissing
        ? {
            message: "Mapbox geocoding needs a Mapbox token in Settings.",
            severity: "warning"
          }
        : undefined
    );
    this.updateDiagnostic(
      "config-mapbox-map",
      this.settings.mapSource === "mapboxRaster" && mapboxKeyMissing
        ? {
            message: "Mapbox map tiles need a Mapbox token in Settings.",
            severity: "warning"
          }
        : undefined
    );
  }

  private updateLoadedDataDiagnostics(): void {
    if (this.terrain?.warning) {
      this.updateDiagnostic("terrain-service", {
        message: `Terrain service issue: ${this.terrain.warning}; using synthetic terrain.`,
        severity: "warning"
      });
    } else {
      this.updateDiagnostic("terrain-service", undefined);
    }

    if (this.clouds) {
      this.updateCloudDiagnostics(this.clouds);
    }
  }

  private updateCloudDiagnostics(clouds: CloudSnapshot): void {
    const fallbackMode = clouds.dataMode === "realtime" ? "real-time data" : "forecast";
    this.updateDiagnostic(
      "cloud-service",
      clouds.warning
        ? {
            message: `Cloud service issue: ${clouds.warning}; using synthetic ${fallbackMode}.`,
            severity: "warning"
          }
        : undefined
    );
  }

  private statusText(): string {
    const parts = [
      this.location.label,
      `${this.terrain?.sourceLabel ?? "Terrain"} ${Math.round(this.terrain?.groundElevation ?? 0)} m`,
      `${this.clouds?.sourceLabel ?? "Clouds"} ${this.clouds?.total ?? 0}%`,
      `View ${Math.round(radiansToDegrees(this.yaw) + 360) % 360} deg`
    ];
    return parts.join(" | ");
  }

  private populateSettingsForm(): void {
    terrainSource.value = this.settings.terrainSource;
    cloudSource.value = this.settings.cloudSource;
    geocoderSource.value = this.settings.geocoderSource;
    mapSource.value = this.settings.mapSource;
    mapboxToken.value = this.settings.apiKeys.mapbox;
    openMeteoKey.value = this.settings.apiKeys.openMeteo;
    terrainScale.value = String(this.settings.terrainVerticalScale);
  }

  private readSettingsForm(): Settings {
    return {
      ...defaultSettings,
      terrainSource: terrainSource.value as Settings["terrainSource"],
      cloudSource: cloudSource.value as Settings["cloudSource"],
      geocoderSource: geocoderSource.value as Settings["geocoderSource"],
      mapSource: mapSource.value as Settings["mapSource"],
      terrainVerticalScale: clamp(Number(terrainScale.value) || defaultSettings.terrainVerticalScale, 0.5, 3),
      apiKeys: {
        mapbox: mapboxToken.value.trim(),
        openMeteo: openMeteoKey.value.trim()
      }
    };
  }

  private resize(): void {
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderPanorama();
  }

  private renderPanorama(): void {
    this.panorama.render(this.terrain, {
      fov: this.fov,
      heightOffset: this.heightOffset,
      pitch: this.pitch,
      verticalScale: this.settings.terrainVerticalScale,
      yaw: this.yaw
    });
  }

  private animate = (timestamp?: number): void => {
    requestAnimationFrame(this.animate);
    this.timer.update(timestamp);
    const elapsed = this.timer.getElapsed();
    this.cloudGroup.children.forEach((cloud, index) => {
      if (cloud.userData.drift === false) {
        return;
      }
      cloud.position.x += Math.sin(elapsed * 0.08 + index) * 0.12;
    });
    this.renderer.render(this.scene, this.camera);
  };
}

function element<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) {
    throw new Error(`Missing element #${id}`);
  }
  return node as T;
}

function setMeter(element: HTMLElement, value: number, hasData: boolean): void {
  const cover = hasData ? clamp(value, 0, 100) : 0;
  element.style.setProperty("--cover", `${cover}%`);
  element.setAttribute("aria-valuenow", String(cover));
}

function formatSignedMeters(value: number): string {
  return `${value >= 0 ? "+" : ""}${value} m`;
}

function readFiniteParam(params: URLSearchParams, name: string): number | undefined {
  const raw = params.get(name);
  if (!raw) {
    return undefined;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

const app = new HorizonApp();
void app.start();
