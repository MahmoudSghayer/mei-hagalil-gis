"""
DXF builder — exact Python port of buildDXF() from js/export-feature.js.

Input : list of GeoJSON Feature dicts (WGS84, with _category property)
Output: ezdxf Drawing object (R2000, ITM coordinates, MGIS XDATA)
"""

from __future__ import annotations

from typing import Any

import ezdxf
from ezdxf.document import Drawing
from pyproj import Transformer

# AutoCAD color index per category (mirrors JS colors dict)
COLORS: dict[str, int] = {
    "sewage_pipe": 2,   "manhole": 4,          "sleeve": 6,
    "control_point": 1, "water_pipes": 5,       "water_meters": 5,
    "hydrants": 1,      "valves": 6,            "control_valves": 6,
    "buildings": 8,     "parcels": 3,           "sewage_pipes": 42,
    "sewage_manholes": 42, "reservoirs": 3,     "pump_stations": 2,
    "sampling_points": 6,  "connection_points": 5,
    "pipe_label": 7,    "elevation_label": 7,   "attribute_label": 7,
    "distance_label": 7,   "dimension_line": 9, "manhole_drawing": 8,
    "main_sewer": 1,    "supply_pipe": 5,       "sewage_cascade": 42,
    "fittings": 8,      "annotation_points": 3, "sewer_exit": 2,
    "annotation_polygons": 3, "annotation_lines": 3,
    "valve_chamber": 6, "block": 4,             "other": 7,
}

XDATA_SKIP: frozenset[str] = frozenset({
    "Layer", "Text", "EntityHand", "GlobalID",
    "created_us", "created_da", "last_edite", "last_edi_1",
    "UpdatingUs", "UpdatingDa",
})

MANHOLE_CATS: frozenset[str] = frozenset({"sewage_manholes", "manhole"})
PIPE_CATS: frozenset[str] = frozenset({
    "sewage_pipes", "sewage_pipe", "water_pipes", "main_sewer", "supply_pipe",
})
LABEL_CATS: frozenset[str] = MANHOLE_CATS | PIPE_CATS

# ── coordinate conversion ─────────────────────────────────────────────────────

def _make_transformer() -> Transformer:
    return Transformer.from_crs("EPSG:4326", "EPSG:2039", always_xy=True)


def _to_itm(lon: float, lat: float, t: Transformer) -> tuple[float, float]:
    x, y = t.transform(lon, lat)
    return float(x), float(y)


# ── deduplication ─────────────────────────────────────────────────────────────

def _first_coords(g: dict) -> list:
    gtype = g.get("type", "")
    c = g.get("coordinates", [])
    if gtype == "Point":            return [c]
    if gtype == "LineString":       return c
    if gtype == "MultiLineString":  return c[0] if c else []
    if gtype == "Polygon":          return c[0] if c else []
    if gtype == "MultiPolygon":     return c[0][0] if c and c[0] else []
    return []


def _deduplicate(features: list[dict]) -> list[dict]:
    seen: dict[str, bool] = {}
    out: list[dict] = []
    for f in features:
        props = f.get("properties") or {}
        cat = props.get("_category", "other")
        g = f.get("geometry")

        if props.get("GlobalID"):
            key = f"{cat}:{props['GlobalID']}"
        elif props.get("OBJECTID") is not None:
            key = f"{cat}:obj:{props['OBJECTID']}"
        else:
            if not g:
                out.append(f)
                continue
            coords = _first_coords(g)
            if not coords:
                out.append(f)
                continue
            c0, cn = coords[0], coords[-1]
            key = (f"{cat}:{c0[0]:.4f}:{c0[1]:.4f}"
                   f":{cn[0]:.4f}:{cn[1]:.4f}:{len(coords)}")

        if key not in seen:
            seen[key] = True
            out.append(f)
    return out


# ── XDATA helper ─────────────────────────────────────────────────────────────

def _attach_xdata(entity: Any, props: dict) -> None:
    if not props:
        return
    tags: list[tuple[int, str]] = []
    for k, v in props.items():
        if k.startswith("_"):
            continue
        if k in XDATA_SKIP:
            continue
        if v is None or v == "":
            continue
        s = str(v)[:250]
        tags.append((1000, f"{k}={s}"))
    if tags:
        entity.set_xdata("MGIS", tags)


# ── attribute label helper ────────────────────────────────────────────────────

def _add_label(msp: Any, props: dict, x: float, y: float) -> None:
    if not props:
        return
    cat = props.get("_category", "")
    rows: list[str] = []

    if cat in MANHOLE_CATS:
        if props.get("ManholeNum"):
            rows.append(f"MH: {props['ManholeNum']}")
        try:
            rows.append(f"TL: {float(props['TL']):.2f}")
        except (KeyError, TypeError, ValueError):
            pass
        try:
            rows.append(f"D: {float(props['Depth']):.2f}m")
        except (KeyError, TypeError, ValueError):
            pass
    elif cat in PIPE_CATS:
        if props.get("LineDiamet"):
            rows.append(f"Ø{props['LineDiamet']}mm")

    if not rows:
        return

    th = 1.2
    spacing = 3.5
    dx = 15.0
    dy = 12.0 if cat in MANHOLE_CATS else -12.0
    ox = x + dx
    leader_y = y + dy
    oy = leader_y + (len(rows) - 1) * spacing

    # Leader line: feature point → label anchor
    msp.add_line((x, y, 0.0), (ox, leader_y, 0.0), dxfattribs={"layer": "ATTR"})

    for i, row in enumerate(rows):
        msp.add_text(
            row,
            dxfattribs={
                "layer": "ATTR",
                "insert": (ox, oy - i * spacing, 0.0),
                "height": th,
            },
        )


# ── polyline helper ───────────────────────────────────────────────────────────

def _add_polyline(
    msp: Any,
    raw_coords: list,
    layer: str,
    closed: bool,
    t: Transformer,
    props: dict,
) -> None:
    pts = [_to_itm(c[0], c[1], t) for c in raw_coords]
    poly = msp.add_polyline2d(pts, dxfattribs={"layer": layer, "closed": closed})
    _attach_xdata(poly, props)


# ── main builder ─────────────────────────────────────────────────────────────

def build_dxf(features: list[dict]) -> Drawing:
    t = _make_transformer()
    features = _deduplicate(features)

    # Collect categories present in this export
    seen_cats: set[str] = set()
    for f in features:
        props = f.get("properties") or {}
        seen_cats.add(props.get("_category", "other"))

    doc = ezdxf.new("R2000")
    doc.header["$INSUNITS"] = 6    # meters
    doc.header["$MEASUREMENT"] = 1  # metric

    # Register app ID so XDATA round-trips cleanly
    doc.appids.new("MGIS")

    # Ensure CONTINUOUS linetype exists (required by AutoCAD validators)
    if "Continuous" not in doc.linetypes:
        doc.linetypes.new("Continuous", dxfattribs={"description": "Solid line"})

    # Layer 0 is always present; add ATTR (off by default) + one per category
    doc.layers.new("ATTR", dxfattribs={"color": -3, "linetype": "Continuous"})
    for cat in seen_cats:
        color = COLORS.get(cat, 7)
        doc.layers.new(cat, dxfattribs={"color": color, "linetype": "Continuous"})

    msp = doc.modelspace()

    for f in features:
        props = f.get("properties") or {}
        layer = props.get("_category", "other")
        g = f.get("geometry")
        if not g:
            continue

        gtype = g.get("type", "")
        coords = g.get("coordinates", [])
        label_pt: tuple[float, float] | None = None

        if gtype == "Point":
            x, y = _to_itm(coords[0], coords[1], t)
            pt = msp.add_point((x, y, 0.0), dxfattribs={"layer": layer})
            _attach_xdata(pt, props)
            if props.get("Text"):
                msp.add_text(
                    str(props["Text"]),
                    dxfattribs={"layer": layer, "insert": (x, y, 0.0), "height": 1.0},
                )
            label_pt = (x, y)

        elif gtype == "LineString":
            _add_polyline(msp, coords, layer, False, t, props)
            mid = coords[len(coords) // 2]
            label_pt = _to_itm(mid[0], mid[1], t)

        elif gtype == "MultiLineString":
            for seg in coords:
                _add_polyline(msp, seg, layer, False, t, props)
            mid_seg = coords[len(coords) // 2]
            mid_pt = mid_seg[len(mid_seg) // 2]
            label_pt = _to_itm(mid_pt[0], mid_pt[1], t)

        elif gtype == "Polygon":
            _add_polyline(msp, coords[0], layer, True, t, props)
            ring = coords[0]
            mid = ring[len(ring) // 2]
            label_pt = _to_itm(mid[0], mid[1], t)

        elif gtype == "MultiPolygon":
            for poly in coords:
                _add_polyline(msp, poly[0], layer, True, t, props)
            ring = coords[0][0]
            mid = ring[len(ring) // 2]
            label_pt = _to_itm(mid[0], mid[1], t)

        if label_pt and layer in LABEL_CATS:
            _add_label(msp, props, label_pt[0], label_pt[1])

    return doc
