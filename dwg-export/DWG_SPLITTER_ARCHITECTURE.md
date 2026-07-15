# DWG Splitter — Architecture & Usage

Entity-level splitter for the Mei HaGalil GIS. It takes a DWG (or DXF) that is
too large to import and splits it into several **valid, smaller DWG files** — at
the CAD-object level, never by cutting bytes — so each part clears the import
limits and the pieces overlay the original exactly.

Status: **Phase 1 (core engine + CLI) is implemented and tested.** The HTTP API
and the frontend "split & import" flow are Phase 2 (see [Roadmap](#roadmap)).

---

## 1. Why this exists — and the constraint that shapes it

Operators can't import DWGs larger than ~2.9 MB. That number is **not a byte
limit anywhere** — it is emergent. The DWG service converts DWG→DXF with the ODA
File Converter, whose child process is capped at 400 MB of virtual memory
(`ODA_MAX_MEMORY_MB`) so it can't OOM-kill the 512 MB Render free-tier container.
A few-MB DWG pushes ODA past that cap; the child is killed and the import fails
with HTTP 422.

**The chicken-and-egg constraint:** splitting a DWG at the entity level requires
*reading its entities first*, which requires the very DWG→DXF conversion that
OOMs. So **a file too large to convert on the server cannot be split on the
server either.** The splitter must run where ODA has enough RAM:

- **Locally / in the bundled Docker image** (recommended for oversized files) —
  ODA gets full RAM, no 400 MB cap. This is what actually fixes the OOM class.
- On the server, only for files it can already convert (relieves the
  8000-feature and large-GeoJSON limits, not the OOM class).

Raising `ODA_MAX_MEMORY_MB` and/or moving off the free tier is the orthogonal
lever if you'd rather not split.

---

## 2. Pipeline

```
 DWG (local)
   │  ODA DWG→DXF                (reuse main.py _dwg_to_dxf)
   ▼
 DXF ──► ezdxf.Drawing ──► Analyzer ──► analysis.json
   │                          │          (layers, blocks, entities, bbox, CRS, units)
   │                          ▼
   │                   Split Decision Engine   (strategy: layer | tile | hybrid)
   ▼
 Partition entities  ──►  per group, ezdxf.Importer copies entities + their
   │                       layers/blocks/linetypes/styles into a fresh part doc,
   │                       coordinates untouched; a stable GISID=<handle> is
   │                       written into each entity's MGIS XDATA
   │  per part:  DXF → ODA DXF→DWG  (reuse main.py _dxf_to_dwg) → measure bytes
   │  estimate → spatially bisect → verify real size → re-split if still over
   ▼
 DWG parts  +  manifest.json
   │
   ▼
 Upload each part (source_crs=EPSG:2039) → dxf_to_geojson reads GISID back as a
 stable asset_code → ensure_layer merges parts into the SAME "<village>·<category>"
 layer → the map renders exactly as a single import of the original would.
```

---

## 3. Technology decision

**Chosen: ODA File Converter (DWG↔DXF) + ezdxf (entity-level split) + pyproj.**
This is the stack already running in `dwg-export/` — no new heavy dependency.

The keystone is **`ezdxf.addons.importer.Importer`**: it copies a chosen set of
entities *plus their dependencies* — layers, linetypes, text styles, and the
block definitions referenced by INSERTs — between documents. That is precisely
the "DWG output rules" (preserve layers / blocks / attributes / text / line
styles / references) with coordinates left byte-for-byte unchanged.

| Option | Verdict | Why |
|---|---|---|
| **ODA File Converter** (free) | ✅ used | Already integrated; robust DWG↔DXF; runs headless under `xvfb`. |
| **ezdxf `Importer`** | ✅ used | Entity-level copy with dependency resolution; MIT; already a dep. |
| ODA Drawings SDK (full C++) | ❌ | Commercial, heavy; the free Converter already does what we need. |
| LibreDWG | ❌ | GPL (license risk for a private repo); immature on complex DWGs. |
| GDAL/OGR | ❌ | Not an entity-level splitter; DWG read still needs the ODA plugin. |
| AutoCAD COM automation | ❌ | Needs a licensed AutoCAD install. |
| Autodesk APS (Forge) | ❌ | Uploads CAD to a third-party cloud — violates "never send CAD data externally". |

### One caveat we discovered and worked around
`Importer` **does not carry XDATA** across documents. Since the stable per-entity
id lives in XDATA, the splitter imports entities one at a time and copies the
source XDATA (and stamps `GISID=<source-handle>`) onto each freshly-created
target entity. Handles are unique within the source drawing → globally unique
across all parts, and deterministic → idempotent re-uploads. See
`splitter._import_with_ids`.

---

## 4. Module layout (`dwg-export/dwg_splitter/`)

| File | Responsibility |
|---|---|
| `loader.py` | DWG/DXF bytes → `ezdxf.Drawing` (ODA for DWG). |
| `analyzer.py` | Inspect structure → analysis dict (layers, blocks, entities, bbox, CRS, units). |
| `strategies.py` | Split Decision Engine — group entities by `layer` / `tile` / `hybrid`. |
| `geometry.py` | Per-entity representative point + bbox; median spatial bisection. |
| `splitter.py` | Build size-bounded part docs (Importer + GISID), estimate/verify budget. |
| `validate.py` | Conservation, size, bounds, reopen, coordinate-fidelity checks. |
| `manifest.py` | Build `manifest.json`; write parts + manifest to disk. |
| `service.py` | High-level `analyze_bytes` / `split_bytes` (used by CLI and, later, the API). |
| `oda.py` | Thin adapter reusing `main.py`'s incident-hardened ODA helpers. |
| `cli.py` / `__main__.py` | `python -m dwg_splitter analyze|split`. |

---

## 5. Split strategies

- **`layer`** (A) — one part per CAD layer. Use when layers are independent
  (roads / buildings / pipes). A lone layer that exceeds the budget is emitted
  whole, with a warning (single-layer purity over the size guarantee).
- **`tile`** (B) — ignore layers; tile the drawing spatially so **every** part
  meets the budget. Use for one big dense layer. Whole entities are assigned to
  a tile by a representative point — geometry is never cut at a tile boundary.
- **`hybrid`** (C, default, alias `auto`) — layer-first, then spatially tile any
  layer that busts the budget. Independent layers stay clean; oversized ones are
  still guaranteed under the limit.

### Size guarantee
Meeting the byte budget uses a fast **estimate-then-verify** loop: entities are
spatially bisected using a cheap per-entity size estimate, then each emitted part
is *actually rendered* and re-split once more if it still exceeds the budget. The
guarantee is measured on the **real DWG bytes** when ODA is available, and on the
DXF bytes (a conservative proxy — DWG is smaller) otherwise.

> A DXF file has ~19 KB of fixed overhead, and DWG a few KB. If a budget is below
> that overhead it is physically unachievable; the splitter detects this, emits
> one part per layer/tile, and warns once instead of exploding into tiny files.

---

## 6. Setup

### Local (Windows/macOS/Linux) — Python venv
```bash
cd dwg-export
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt -r requirements-dev.txt   # Windows
# .venv/bin/pip install -r requirements.txt -r requirements-dev.txt      # POSIX
```
Without ODA installed the splitter still runs and emits **DXF** parts (which the
app imports directly). To emit **DWG** parts, either install the ODA File
Converter natively (so `ODAFileConverter` is on `PATH`) or use Docker below.

### Local Docker (recommended for oversized DWGs — ODA bundled, no memory cap)
```bash
cd dwg-export
# vendor/ must contain the ODA .deb (see vendor/README.md)
mkdir -p data && cp /path/to/city.dwg data/
docker compose run --rm dwg-export \
  python -m dwg_splitter split /data/city.dwg --out /data/city_parts --max-mb 2.5
# → parts + manifest.json in dwg-export/data/city_parts/
```

---

## 7. CLI usage

```bash
# Inspect structure (add --json for machine-readable output)
python -m dwg_splitter analyze city.dwg

# Split to <=2.5 MB parts (hybrid), writing parts + manifest.json
python -m dwg_splitter split city.dwg --out ./city_parts --max-mb 2.5

# Force a strategy / DXF output / skip validation
python -m dwg_splitter split city.dwg --strategy tile
python -m dwg_splitter split city.dwg --dxf
python -m dwg_splitter split city.dwg --no-validate
```

Example split summary:
```
✓ 5 part(s) written to ./city_parts
   city_roads-t001_001.dwg      121.4KB     750 ent  layers=1
   city_buildings_003.dwg       284.9KB    1200 ent  layers=1
   ...
Validation: PASS
   ✓ entity_conservation: source=3600 emitted=3600
   ✓ size_budget: all parts within budget
   ✓ bounds_union: parts=[…] source=[…]
   ✓ coordinates_unchanged: all sampled coordinates preserved
```

---

## 8. GIS integration (how the pieces show up as one drawing)

Uploading the parts through the normal flow makes them one drawing again:

1. Each part converts with `source_crs=EPSG:2039`; the reprojection is
   deterministic per file, so parts land exactly where the original would.
2. `dxf_to_geojson` reads each entity's `GISID` (from MGIS XDATA) back as
   `EntityHand` → `synthAssetCode` (`js/gis-engine/migrate.js`) turns it into a
   **globally-unique, stable `asset_code`**, so parts accumulate instead of
   overwriting each other.
3. `ensure_layer` is find-or-create by name, so every part that resolves to the
   same `"<village> · <category>"` funnels into the **same** engine layer.

Net effect: the split-and-reassembled drawing renders identically to a single
import of the original.

---

## 9. Configuration

| Env var | Default | Meaning |
|---|---|---|
| `MAX_DWG_PART_MB` | `2.5` | Target max size per part (also `--max-mb`). |
| `DWG_SPLIT_STRATEGY` | `hybrid` | Default strategy (also `--strategy`). |
| `DWG_SPLIT_MIN_ENTITIES` | `1` | Never subdivide a group below this many entities. |
| `DWG_SPLIT_MAX_DEPTH` | `24` | Spatial-bisection recursion cap (safety). |
| `ODA_MAX_MEMORY_MB` | `400` | ODA child memory cap. Raise it locally/Docker. |

---

## 10. Testing

```bash
cd dwg-export
.venv/Scripts/python -m pytest tests/test_dwg_splitter_*.py -q
```
- ODA-free tests (ezdxf only) cover analysis, strategy selection, conservation,
  the size-budget subdivision, coordinate fidelity, and the GISID/XDATA
  round-trip through `dxf_to_geojson`. They run everywhere, including CI.
- `test_dwg_splitter_oda.py` is **skipped where ODA is absent** and exercises the
  real DWG round-trip where the ODA `.deb` is installed (CI / Docker image).

---

## 11. Limitations

- Reading/splitting any **DWG** requires ODA + adequate RAM (no pure-Python DWG
  reader exists). DXF input needs neither.
- Server-side split can't help files that OOM on convert — use the local/Docker
  path.
- The **map import** still maps only POINT/CIRCLE/TEXT/MTEXT/INSERT/LINE/
  LWPOLYLINE/POLYLINE (a pre-existing `dxf_to_geojson` limitation). The **DWG
  parts themselves preserve all entity types** (arcs, splines, hatches, …) via
  the Importer — so nothing is lost at the DWG level; the map simply shows the
  same subset it always did.
- A single entity larger than the budget cannot be split (emitted whole, warned).
- Only **model space** is split (matching the existing import pipeline, which is
  model-space only). Paper-space layouts / viewports / title blocks are not
  carried into the parts.

## Roadmap

- **Phase 2 — HTTP API:** `POST /api/dwg/analyze`, `POST /api/dwg/split` on the
  service (reusing auth, the ODA semaphore, body-size guard). Bounded by the same
  memory cap → for OOM-class files the response points at the local CLI.
- **Phase 2 — Frontend:** on an oversized DWG or a 422 `too_large`, offer
  "Split & import" — call `/api/dwg/split`, then import each part under the same
  village/category names, with progress and error handling.
- Optional `dwg_split_jobs` / `dwg_split_parts` DB tables for audit/history.
- Extend `dxf_to_geojson` to cover ARC/SPLINE/HATCH so the map view is even
  closer to the CAD.
