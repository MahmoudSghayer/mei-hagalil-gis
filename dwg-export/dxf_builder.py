"""
DXF builder — GeoJSON features → ezdxf Drawing (R2018, ITM coordinates).

Mirrors the original buildDXF() from js/export-feature.js, plus the CEO's
revised requirements (June 2026):
  1. Point features are drawn as CIRCLES (radius 0.65), not POINTs.
  2. Sewage manholes are drawn as a block ("שוחת-ביוב") that contains the
     circle + a diagonal mark + invisible block ATTRIBUTES carrying the data,
     matching the customer's reference DWG.
  3. Water-pipe diameters are labelled in INCHES (the GIS stores them in inch);
     sewage-pipe diameters stay in millimetres.
  4. Every entity also carries all of its source attributes as MGIS XDATA.
"""

from __future__ import annotations

import math
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
WATER_PIPE_CATS: frozenset[str] = frozenset({"water_pipes", "supply_pipe"})
SEWAGE_PIPE_CATS: frozenset[str] = frozenset({"sewage_pipes", "sewage_pipe", "main_sewer"})
PIPE_CATS: frozenset[str] = WATER_PIPE_CATS | SEWAGE_PIPE_CATS

# Circle radius for point features (CEO instruction)
POINT_RADIUS = 0.65

# Manhole block — recreated from the customer's reference DWG.
MANHOLE_BLOCK = "שוחת-ביוב"
# (tag, insert_x, insert_y) for the 7 invisible block attributes
MANHOLE_ATTDEFS: list[tuple[str, float, float]] = [
    ("תאור",        6.589, -0.647),
    ("גובה_מכסה",   3.150,  2.738),
    ("גובה_כניסה",  3.130,  1.361),
    ("גובה_יציאה",  3.070, -4.804),
    ("עומק_שוחה",   3.070, -2.277),
    ("קוטר_שוחה",   3.130, -3.466),
    ("הערות",       3.130, -6.252),
]
ATTDEF_HEIGHT = 1.35


# ── coordinate conversion ─────────────────────────────────────────────────────

def _make_transformer() -> Transformer:
    return Transformer.from_crs("EPSG:4326", "EPSG:2039", always_xy=True)


def _to_itm(lon: float, lat: float, t: Transformer) -> tuple[float, float]:
    x, y = t.transform(lon, lat)
    return float(x), float(y)


# ── formatting helpers ─────────────────────────────────────────────────────────

def _fmt_num(v: Any, decimals: int | None = None) -> str:
    """Format a numeric-ish value: drop trailing zeros, optional fixed decimals."""
    try:
        fv = float(v)
    except (TypeError, ValueError):
        return str(v).strip()
    if decimals is not None:
        return f"{fv:.{decimals}f}"
    if fv == int(fv):
        return str(int(fv))
    return f"{fv:g}"


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


# ── manhole block ──────────────────────────────────────────────────────────────

def _ensure_manhole_block(doc: Drawing) -> None:
    """Define the שוחת-ביוב block: circle (r=0.65) + diagonal mark + invisible
    attribute definitions — recreated from the customer's reference DWG."""
    if MANHOLE_BLOCK in doc.blocks:
        return
    blk = doc.blocks.new(name=MANHOLE_BLOCK)
    blk.add_circle((0.0, 0.0), radius=POINT_RADIUS)
    blk.add_line((-0.48, -0.475), (0.48, 0.475))
    for tag, ax, ay in MANHOLE_ATTDEFS:
        blk.add_attdef(
            tag=tag,
            insert=(ax, ay),
            height=ATTDEF_HEIGHT,
            dxfattribs={"flags": 1},  # 1 = invisible
        )


def _manhole_attrib_values(props: dict) -> dict[str, str]:
    """Map GIS manhole fields → the block's Hebrew attribute tags."""
    vals = {tag: "" for tag, _, _ in MANHOLE_ATTDEFS}
    vals["תאור"] = "שוחת ביוב"
    if props.get("TL") not in (None, ""):
        vals["גובה_מכסה"] = _fmt_num(props["TL"], 2)
    # No dedicated inlet-IL field in the source data → גובה_כניסה stays empty
    if props.get("HighIL") not in (None, ""):
        vals["גובה_כניסה"] = _fmt_num(props["HighIL"], 2)
    if props.get("LowIL") not in (None, ""):
        vals["גובה_יציאה"] = _fmt_num(props["LowIL"], 2)
    if props.get("Depth") not in (None, ""):
        vals["עומק_שוחה"] = _fmt_num(props["Depth"], 2)
    if props.get("ManholeDia") not in (None, ""):
        vals["קוטר_שוחה"] = _fmt_num(props["ManholeDia"])
    if props.get("Comment") not in (None, ""):
        vals["הערות"] = str(props["Comment"])[:100]
    return vals


def _add_manhole(msp: Any, props: dict, x: float, y: float) -> None:
    ref = msp.add_blockref(MANHOLE_BLOCK, (x, y, 0.0), dxfattribs={
        "layer": props.get("_category", "sewage_manholes"),
    })
    ref.add_auto_attribs(_manhole_attrib_values(props))
    for att in ref.attribs:               # invisible, like the reference DWG
        att.dxf.flags = att.dxf.flags | 1
    _attach_xdata(ref, props)


# ── pipe label helper ──────────────────────────────────────────────────────────

def _add_pipe_label(msp: Any, props: dict, x: float, y: float) -> None:
    cat = props.get("_category", "")
    diam = props.get("LineDiamet")
    if diam in (None, ""):
        return
    if cat in WATER_PIPE_CATS:
        row = f'Ø{_fmt_num(diam)}"'        # inches (water)
    else:
        row = f"Ø{_fmt_num(diam)}mm"        # millimetres (sewage)

    th = 1.2
    ox = x + 15.0
    leader_y = y - 12.0
    msp.add_line((x, y, 0.0), (ox, leader_y, 0.0), dxfattribs={"layer": "ATTR"})
    msp.add_text(
        row,
        dxfattribs={"layer": "ATTR", "insert": (ox, leader_y, 0.0), "height": th},
    )


# ── polyline helper ───────────────────────────────────────────────────────────

def _add_polyline(
    msp: Any,
    raw_coords: list,
    layer: str,
    closed: bool,
    t: Transformer,
    props: dict,
    bounds: list[float] | None = None,
) -> None:
    pts = [_to_itm(c[0], c[1], t) for c in raw_coords]
    poly = msp.add_lwpolyline(pts, dxfattribs={"layer": layer}, close=closed)
    _attach_xdata(poly, props)
    if bounds is not None:
        for px, py in pts:
            _grow_bounds(bounds, px, py)


def _grow_bounds(b: list[float], x: float, y: float) -> None:
    if x < b[0]: b[0] = x
    if y < b[1]: b[1] = y
    if x > b[2]: b[2] = x
    if y > b[3]: b[3] = y


# ── main builder ─────────────────────────────────────────────────────────────

def build_dxf(features: list[dict]) -> Drawing:
    t = _make_transformer()
    features = _deduplicate(features)

    # Collect categories present in this export
    seen_cats: set[str] = set()
    for f in features:
        props = f.get("properties") or {}
        seen_cats.add(props.get("_category", "other"))

    doc = ezdxf.new("R2018")        # UTF-8 text → clean Hebrew
    doc.header["$INSUNITS"] = 6     # meters
    doc.header["$MEASUREMENT"] = 1  # metric

    doc.appids.new("MGIS")

    if "Continuous" not in doc.linetypes:
        doc.linetypes.new("Continuous", dxfattribs={"description": "Solid line"})

    # ATTR layer (off by default) + one layer per category
    attr_layer = doc.layers.new("ATTR", dxfattribs={"linetype": "Continuous"})
    attr_layer.off()
    for cat in seen_cats:
        doc.layers.new(cat, dxfattribs={"color": COLORS.get(cat, 7),
                                        "linetype": "Continuous"})

    _ensure_manhole_block(doc)
    msp = doc.modelspace()

    # [xmin, ymin, xmax, ymax] — to set the initial view to the data
    bounds: list[float] = [math.inf, math.inf, -math.inf, -math.inf]

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
            _grow_bounds(bounds, x, y)
            if layer in MANHOLE_CATS:
                _add_manhole(msp, props, x, y)
            else:
                # CEO: points become circles (r=0.65)
                circ = msp.add_circle((x, y, 0.0), radius=POINT_RADIUS,
                                      dxfattribs={"layer": layer})
                _attach_xdata(circ, props)
                if props.get("Text"):
                    msp.add_text(
                        str(props["Text"]),
                        dxfattribs={"layer": layer, "insert": (x, y, 0.0),
                                    "height": 1.0},
                    )

        elif gtype == "LineString":
            _add_polyline(msp, coords, layer, False, t, props, bounds)
            mid = coords[len(coords) // 2]
            label_pt = _to_itm(mid[0], mid[1], t)

        elif gtype == "MultiLineString":
            for seg in coords:
                _add_polyline(msp, seg, layer, False, t, props, bounds)
            mid_seg = coords[len(coords) // 2]
            mid_pt = mid_seg[len(mid_seg) // 2]
            label_pt = _to_itm(mid_pt[0], mid_pt[1], t)

        elif gtype == "Polygon":
            _add_polyline(msp, coords[0], layer, True, t, props, bounds)
            ring = coords[0]
            mid = ring[len(ring) // 2]
            label_pt = _to_itm(mid[0], mid[1], t)

        elif gtype == "MultiPolygon":
            for poly in coords:
                _add_polyline(msp, poly[0], layer, True, t, props, bounds)
            ring = coords[0][0]
            mid = ring[len(ring) // 2]
            label_pt = _to_itm(mid[0], mid[1], t)

        # Pipe diameter labels (water = inch, sewage = mm)
        if label_pt and layer in PIPE_CATS:
            _add_pipe_label(msp, props, label_pt[0], label_pt[1])

    _set_initial_view(doc, bounds)
    return doc


def _set_initial_view(doc: Drawing, bounds: list[float]) -> None:
    """Point the modelspace view + drawing extents at the data, so the file
    opens showing the geometry instead of a blank view at the origin."""
    xmin, ymin, xmax, ymax = bounds
    if not all(math.isfinite(v) for v in bounds) or xmax <= xmin or ymax <= ymin:
        return
    cx, cy = (xmin + xmax) / 2.0, (ymin + ymax) / 2.0
    height = max(ymax - ymin, xmax - xmin, 1.0) * 1.15
    doc.header["$EXTMIN"] = (xmin, ymin, 0.0)
    doc.header["$EXTMAX"] = (xmax, ymax, 0.0)
    try:
        doc.set_modelspace_vport(height=height, center=(cx, cy))
    except Exception:
        pass
