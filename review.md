# Code Review — terrain representation, real-time clouds, and minimap

**Scope:** commits `eaaa513` ("Attempt fixing terrain representation and real-time clouds") and `7e7b29b` ("Fix minimap").
**Focus:** accuracy of perspective and representation of peaks/valleys, clouds, and heights.
**Method:** 9 finder passes (line-by-line, removed-behavior, cross-file, reuse, simplification, efficiency, altitude, conventions, minimap) → dedup → one adversarial verifier per candidate. All findings below survived verification (verdicts noted).

> **Status: all findings and all "below the cut" items fixed** (2026-07-05, `tsc` + `vite build` clean).
>
> 1. HT/DQF now accept int16/int8 with `_Unsigned` reinterpretation of data, `_FillValue`, and `valid_range`.
> 2. `clampProfileToSkyline` deleted; the ray march now does real occlusion (only samples rising above every nearer sample enter a band/skyline profile), which also made the depth-edge gate unnecessary.
> 3. Vertical-FOV culling removed; `altitudeToY` clamps the projection angle just short of ±90° so off-screen summits still anchor fills without tan wraparound.
> 4. `projectGoesFixedGrid` implements the GOES-R PUG visibility check, and satellite selection now picks the covering satellite (GOES **or** Himawari) with the smallest geocentric central angle (≤80°).
> 5. Himawari fallback tops are ground-referenced (`altitudeReference: "ground"`) instead of fixed sea-level altitudes.
> 6. Depth-raster vertices stay in view space (depth/right/up) through frustum clipping; screen y is projected after clipping with the same angle clamp.
> 7. Minimap terrain mapping is isotropic (one meters-per-pixel fitted to the smaller canvas axis) across draw, marker, drag, and click paths.
> 8. Raster tile zoom is frozen while a drag is active.
> 9. POV marker falls back to canvas center when terrain is missing.
> 10. Kept the orange render color (per request) and relabeled everything else: legend says "orange satellite top", swatch is now #e58f4d, README says orange.
>
> Below the cut: grid span is computed once per render from lattice corners and `MAX_TERRAIN_BAND_DISTANCE` is a module constant; `isAbortError`/`throwIfAborted`/`errorMessage`/`loadCachedJson`/`loadCachedText` are shared in `data/cache.ts` and `buildGridSamples` in `geo.ts` (clouds/hrrr/satellite/main all use them); curvature is back to `(1 − k) / 2R` with named constants (k = 0.166 ≈ the PeakFinder coefficient); satellite-top cover is a fixed nominal constant instead of a DQF-derived fabrication (the +8/+6 cover fudges are gone too); the GOES overlay download starts concurrently with the base cloud load and the decoded grid is memoized by `bucket:key`.

---

## Findings (most severe first)

### 1. GOES cloud-top overlay likely never loads — HT dtype mismatch
**`src/data/satelliteCloudTops.ts:221`** · correctness · CONFIRMED

`readGoesCloudTopGrid` requires the `HT` dataset to decode as `Uint16Array` (`typedArrayValue` throws otherwise), but GOES-R ABI L2 files store packed variables as **signed int16** with an `_Unsigned='true'` attribute, which h5wasm returns as `Int16Array`. `valid_range` is also read raw, so signed values like `[0, -6]` would set `validMax = -6`.

**Failure:** realtime mode anywhere in GOES coverage — every load throws "HT field had an unexpected data type" and the feature permanently degrades to the `satelliteTopWarning` path. Even if the dtype check passed, the signed `valid_range` would reject every pixel, producing an always-empty overlay with no warning.

### 2. `clampProfileToSkyline` rewrites valley/foothill silhouettes
**`src/panorama.ts:670`** · correctness · CONFIRMED

Any band-profile point more than `terrainDetailDrop` (34–88 px) below the skyline is raised up to `skylineY + maxDrop`. Genuinely visible lower terrain gets its silhouette rewritten, and occluded far terrain is repainted as a fake stripe hugging the ridge line (band profiles get no occlusion test in `recordProfilePoint`).

**Failure:** viewer in a valley with a ridge skyline at y≈200px and near foothills truly at y≈600px — the near band's profile is rewritten to y≈260px and its 0.96-alpha fill (drawn last, far-to-near) paints over the entire mountain face. Any scene where a band top sits >88px below the skyline (valley views, the new 10 000 m eye elevation) is misrendered.

**Deeper fix:** do occlusion during the ray march (track running max altitude per column; record a sample into its band only if it exceeds the max so far). That makes band profiles physically visible surfaces and deletes the clamp — and the matching depth-edge gate — entirely.

### 3. Vertical-FOV culling drops summits → sky holes on steep faces
**`src/panorama.ts:283`** · correctness · CONFIRMED

`projectTerrainRaySample` culls samples with `|altitude − pitch| > halfVerticalFov + 0.08 rad`. Ray steps of 120–520 m can jump the entire 4.6° margin band on steep slopes, so no retained sample lands above the screen top and the column's fill stops short. The old code projected all altitudes, so above-screen summits still anchored the fill.

**Failure:** FOV 35° from a valley floor facing a 30° slope at ~800 m (verticalScale 1.1): per-step altitude change ≈0.095 rad > the 0.08 rad margin — the upper mountain face renders as sky. Fully-culled columns are also reachable, after which `interpolateProfile` bridges the gap with invented geometry.

### 4. GOES limb: no earth-visibility check + wrong satellite preference
**`src/data/satelliteCloudTops.ts:301`** · correctness · CONFIRMED

`projectGoesFixedGrid` lacks the GOES-R PUG visibility check (`H·(H−sx) < sy² + (req²/rpol²)·sz²`), and the coverage box (lat ±62°, dlon ≤82°) admits locations beyond the ~81.3° limb. Beyond-limb points still project to in-grid scan angles that belong to a *different* place on the near side of the disk. `satelliteCloudTopSource` also prefers GOES over Himawari whenever the box test passes.

**Failure:** Sapporo (43.06 N, 141.35 E): dlon to GOES-18 is 81.7° ≤ 82 so GOES-18 wins over Himawari (0.65° away); the central angle 83.9° is past the limb, yet the projection returns x=−0.110, y=0.104 rad — in-grid — so cloud-top heights are sampled from a pixel geolocating ~570 km away (42.3 N, 148.3 E) and rendered as local data.

### 5. Himawari fallback fabricates below-ground cloud-top altitudes
**`src/data/satelliteCloudTops.ts:354`** · correctness · CONFIRMED

`buildFallbackHimawariTops` hard-codes tops at 1650/5050/9100 m MSL (`altitudeReference: "seaLevel"`) with no terrain input. The renderer computes `altitudeMeters − terrainElevation` and clamps to 180 m AGL (main.ts:875–877).

**Failure:** Lhasa (3650 m ground, Himawari-covered, realtime, synthetic snapshot with no map volumes): "low" tops at 1650 m MSL = −2000 m AGL clamp to 180 m AGL; "mid" tops at 5050 m MSL render at 1400 m AGL — the cloud-top-height overlay misstates altitudes by 2–4 km.

### 6. Depth raster projects behind/below-camera vertices through a wrapping tangent
**`src/panorama.ts:407`** · correctness · CONFIRMED

`projectRasterVertex` computes screen y via `tan(altitude − pitch)` with no vertical clipping and no behind-camera cull (the old FOV+margin guard was deleted; `clipRasterTriangle` clips only depth ≥ 1 and the two side planes). When `altitude − pitch` crosses ±90°, tan wraps sign and below-camera terrain projects to the **top** of the frame; `intersectRasterClipEdge` then lerps that bogus y to the near plane.

**Failure:** eye 10 000 m (newly allowed), pitch +10°, vertex 220 m away: altitude −88.7°, diff −98.7°, tan = +6.5 → y far above frame. Triangles containing such vertices smear near depths down raster columns and `drawDepthDiscontinuities` strokes spurious dark edges across the sky (edges above the skyline always pass the visibility gate).

### 7. Minimap north-south compression — bearings disagree with the yaw line
**`src/miniMap.ts:258`** · correctness · CONFIRMED (pre-existing, but propagated into new code by 7e7b29b)

Terrain-canvas mode maps the same ±visibleExtent meters onto canvas **width** horizontally and **height** vertically (~270×190 px), compressing north-south ~30% relative to east-west, while the yaw direction line in `drawPov` is drawn isotropically. The commit replicated the anisotropic formula into the new `pointForLocation`/`centerAfterDrag`/`locationForPointer` paths.

**Failure:** yaw 45° NE — a peak 10 km due NE plots at ~55° screen bearing while the direction line points 45°; a circular mountain renders as an ellipse. Click-to-select stays self-consistent (matching inverse), so the defect is the distorted rendering and bearing/yaw disagreement.

### 8. Minimap mid-drag zoom flip breaks drag tracking
**`src/miniMap.ts:392`** · correctness · CONFIRMED

`centerAfterDrag` converts pointer deltas using the zoom frozen at pointerdown (`startZoom`), while `drawRasterBackground` re-derives zoom per frame from the dragged center's latitude. An integer zoom flip mid-drag renders the map at the new zoom while pan deltas still use the old one.

**Failure:** osmRaster, 52 km extent, 270 px canvas — integer zoom flips near 46.1° N; dragging vertically across that latitude in one gesture reloads tiles at zoom±1, the view snaps scale, and the map tracks at ~2×/~0.5× cursor speed for the rest of the drag.

### 9. Minimap POV marker vanishes while terrain is missing
**`src/miniMap.ts:252`** · correctness · CONFIRMED

In terrain-canvas mode with no terrain loaded, `pointForLocation` returns `undefined` and `drawPov` draws nothing. Before 7e7b29b the position dot and yaw line were always drawn at canvas center — which is exactly correct in that state, since `viewportCenter` always equals `location` without terrain.

**Failure:** terrain still loading, or indefinitely if the terrain/cloud `Promise.all` rejects (main.ts:568 returns leaving `this.terrain` undefined) — the minimap shows only the gradient background with no position dot or view-direction line. Fix: fall back to canvas center.

### 10. Satellite overlay renders orange but is labeled teal everywhere
**`src/main.ts:167`** · consistency · CONFIRMED

`CLOUD_VOLUME_STYLES.satelliteTop` is `#e58f4d` (orange) for all three layers and that color is what's rendered (material + vertex colors; only lightness jittered). But the legend label says "teal satellite top", the legend swatch `.cloud-volume-swatch-satelliteTop` is `#4de5df` (teal), and the README added in the same commit says "teal cloud-top-height overlay".

**Failure:** user enables Real-time mode — the scene shows orange volumes while the on-screen key displays a teal swatch, so the legend doesn't identify the clouds it labels.

---

## Refuted during verification

- **Depth-edge gating below the skyline** (`isTerrainDetailVisible`): the gate reuses the same `detailDrop` as `clampProfileToSkyline` and is required for consistency with that clamp — drawing raw-position edges over clamped bands would misalign. Intentional stylization, not a standalone bug. (It becomes unnecessary if finding #2 is fixed at the root.)
- **Legend key regression for all-approximate snapshots** was downgraded: the key is indeed no longer shown when only one volume type exists, but the magenta hue is still explained by the warning diagnostic in the same status pill, and the old key was itself misleading (hardcoded "pale modeled" entry with no modeled volumes). Mostly-cosmetic tradeoff.

## Verified but below the cut (quality/cleanup)

- **`terrainGridSpan` rescans the whole grid per column** (`src/panorama.ts:307`, CONFIRMED): up to ~11k samples × ~320–760 columns ≈ 3.5–8M redundant iterations on *every pointermove and slider event*. The grid is a regular lattice spanning exactly ±`grid.extentMeters`, so the span is derivable without any scan; `maxTerrainBandDistance` is likewise a constant recomputed per column. One-line hoist.
- **Duplication in `satelliteCloudTops.ts`:** `loadCachedText` re-implements `loadCachedJson` (clouds.ts); `isAbortError`/`errorMessage` are third copies (clouds.ts, hrrr.ts); `buildSatelliteSamples` duplicates the cloud-grid sample builder; `longitudeDistance` re-implements `normalizeLongitude` (geo.ts); inline `(x * Math.PI) / 180` instead of `degreesToRadians`.
- **Magic curvature constant** (`src/terrainSurface.ts:10`): `(d²/2R)·(1−k)` with named `EARTH_RADIUS_METERS`/`REFRACTION_COEFFICIENT` was replaced by opaque `PEAKFINDER_CURVATURE_DROP_COEFFICIENT = 6.54443e-8` (equivalent to k≈0.17). Keep the named-constant form and document the chosen k — the next tuning pass has no model to reason with otherwise.
- **Fabricated cover from DQF** (`src/data/satelliteCloudTops.ts:283`): `cover = clamp(82 − quality·12, 46, 88)` invents a coverage percentage from a retrieval-confidence flag; ACHA carries no opacity information. Consider a dedicated confidence/opacity channel for satelliteTop volumes.
- **Serial satellite fetch** (`src/data/clouds.ts:138`): the GOES overlay load is awaited after the base snapshot though it's independent of it — `Promise.all` would hide its latency. The same NetCDF is also fully re-decoded on every call within its 45-min blob TTL; a size-1 memo keyed by `bucket:key` avoids ~9 identical decodes.
