"""
DXF → GeoJSON reader — the inverse of dxf_builder.py.

Reads a DXF (assumed ITM / EPSG:2039, as produced by ODA from the customer's
DWGs) and emits a WGS84 GeoJSON FeatureCollection. Each feature keeps its
AutoCAD layer name in properties.Layer so the upload page's mapping rules can
auto-classify it, plus any block ATTRIB / TEXT values as extra properties.

Entity handling (mirrors what dxf_builder writes):
  POINT / CIRCLE              → Point        (points are drawn as circles)
  INSERT (block, e.g. manhole)→ Point        (+ Hebrew ATTRIB tags as props)
  TEXT / MTEXT                → Point        (+ Text)
  LINE                        → LineString
  LWPOLYLINE / POLYLINE       → LineString, or Polygon if closed
  ARC / ELLIPSE / SPLINE / …  → skipped

CRS auto-correction (added June 2026):
  Some customer DWGs store ITM with a flipped sign convention (negated X and/or
  Y — e.g. PLAN-KLALI.dwg stores X≈-213000, Y≈-750000). Transforming those as
  plain EPSG:2039 lands every feature far outside Israel, so the upload page
  rejects the whole file ("6752/6752 outside the 7 villages"). We now sample the
  raw model-space coordinates, try the four sign conventions {(+,+),(-,+),
  (+,-),(-,-)}, and pick whichever lands the most points inside Israel's
  bounding box before transforming the whole file with it. If none of them
  produce a meaningful number of in-Israel points the data is left untouched
  (genuinely unknown CRS) and the caller can surface a clear error.
"""

from __future__ import annotations

import os
import tempfile
from typing import Any

import ezdxf
from pyproj import Transformer

# Generous Israel bounding box in WGS84 (lon, lat). Used only to score which
# sign convention is correct — not to filter features.
_ISR_LON = (33.8, 36.2)
_ISR_LAT = (29.2, 33.6)

_SIGN_VARIANTS = [(1, 1), (-1, 1), (1, -1), (-1, -1)]


def _in_israel(lon: float, lat: float) -> bool:
    return _ISR_LON[0] <= lon <= _ISR_LON[1] and _ISR_LAT[0] <= lat <= _ISR_LAT[1]


def _detect_sign(t: Transformer, sample: list[tuple[float, float]]) -> tuple[int, int]:
    """Pick the (sx, sy) sign convention that lands the most sample points in
    Israel. Falls back to (1, 1) when nothing scores meaningfully."""
    if not sample:
        return (1, 1)
    best_sign, best_hits = (1, 1), -1
    for sx, sy in _SIGN_VARIANTS:
        hits = 0
        for x, y in sample:
            lon, lat = t.transform(sx * x, sy * y)
            if _in_israel(lon, lat):
                hits += 1
        if hits > best_hits:
            best_hits, best_sign = hits, (sx, sy)
    # Require at least ~30% of the sample to land in Israel, otherwise the CRS
    # is something we don't understand — don't silently mangle the data.
    if best_hits < max(1, int(0.3 * len(sample))):
        return (1, 1)
    return best_sign


# Candidate source coordinate systems for Israeli CAD data, tried in order.
# Many older drawings are in the Cassini "old Israeli grid", NOT the new ITM —
# converting those as ITM lands them ~500 km away (Sinai). We auto-pick.
_SRC_CANDIDATES = [
    "EPSG:2039",   # Israel 1993 / Israeli TM Grid (ITM, the new grid)
    "EPSG:28193",  # Palestine 1923 / Israeli CS Grid (old Cassini)
    "EPSG:28191",  # Palestine 1923 / Palestine Grid (old Cassini)
    "EPSG:6991",   # Israeli Grid 05/12
]


def _detect_crs_and_sign(sample: list[tuple[float, float]], fallback_crs: str = "EPSG:2039"):
    """Try every candidate source CRS × sign convention and pick the combo that
    lands the most sample points inside Israel. Returns (Transformer, sx, sy).

    Falls back to `fallback_crs` (sign +, +) when nothing matches confidently.
    BUG FIX (2026-07-14): this used to hardcode the fallback to EPSG:2039
    regardless of what the caller asked for — dxf_to_geojson() built a
    Transformer from its `source_crs` argument (e.g. the CRS a user picks on
    the upload form) but then unconditionally discarded it in favour of this
    function's return value, silently ignoring an explicit user choice
    whenever auto-detection was inconclusive. The fallback now honors the
    caller-supplied CRS instead."""
    best = None  # (hits, transformer, sx, sy, crs)
    for crs in _SRC_CANDIDATES:
        try:
            tr = Transformer.from_crs(crs, "EPSG:4326", always_xy=True)
        except Exception:
            continue
        for sx, sy in _SIGN_VARIANTS:
            hits = 0
            for x, y in sample:
                try:
                    lon, lat = tr.transform(sx * x, sy * y)
                except Exception:
                    continue
                if _in_israel(lon, lat):
                    hits += 1
            if best is None or hits > best[0]:
                best = (hits, tr, sx, sy, crs)
    if best is None or best[0] < max(1, int(0.3 * len(sample))):
        fallback_crs = fallback_crs or "EPSG:2039"
        try:
            tr = Transformer.from_crs(fallback_crs, "EPSG:4326", always_xy=True)
        except Exception:
            fallback_crs = "EPSG:2039"
            tr = Transformer.from_crs(fallback_crs, "EPSG:4326", always_xy=True)
        return tr, 1, 1, f"{fallback_crs}?"
    return best[1], best[2], best[3], best[4]


def dxf_to_geojson(dxf_bytes: bytes, source_crs: str = "EPSG:2039") -> dict:
    # ezdxf wants a file path so it can sniff the DXF encoding itself.
    with tempfile.NamedTemporaryFile(suffix=".dxf", delete=False) as tf:
        tf.write(dxf_bytes)
        path = tf.name
    try:
        doc = ezdxf.readfile(path)
    finally:
        os.unlink(path)

    msp = doc.modelspace()

    # ── Pass 1: collect each entity's RAW model-space geometry ──────────────
    # We build geometries in raw DXF coordinates first, sample them to decide
    # the sign convention, then transform everything in pass 2.
    raw_features: list[dict] = []

    def add(geometry: dict, props: dict) -> None:
        raw_features.append({"type": "Feature", "geometry": geometry, "properties": props})

    for e in msp:
        try:
            kind = e.dxftype()
            layer = getattr(e.dxf, "layer", "0") or "0"
            props: dict[str, Any] = {"Layer": layer}
            # Many drawings classify water vs sewage by COLOR/linetype, not layer.
            # Capture the effective ACI colour (resolve BYLAYER/BYBLOCK) + linetype
            # so the importer can split features the CAD only tags by colour.
            col = getattr(e.dxf, "color", 256)
            if col in (0, 256):
                try:
                    col = doc.layers.get(layer).dxf.color
                except Exception:
                    col = 7
            props["Color"] = abs(int(col or 7))
            lt = getattr(e.dxf, "linetype", "") or ""
            if lt and lt.upper() not in ("BYLAYER", "BYBLOCK", "CONTINUOUS"):
                props["LineType"] = lt

            if kind == "POINT":
                loc = e.dxf.location
                add({"type": "Point", "coordinates": [float(loc.x), float(loc.y)]}, props)

            elif kind == "CIRCLE":
                c = e.dxf.center
                add({"type": "Point", "coordinates": [float(c.x), float(c.y)]}, props)

            elif kind in ("TEXT", "MTEXT"):
                ins = e.dxf.insert
                props["Text"] = (e.text if kind == "MTEXT" else e.dxf.text)
                add({"type": "Point", "coordinates": [float(ins.x), float(ins.y)]}, props)

            elif kind == "INSERT":
                ins = e.dxf.insert
                props["Block"] = e.dxf.name
                for att in e.attribs:                     # manhole Hebrew tags etc.
                    tag, val = att.dxf.tag, att.dxf.text
                    if tag and val not in (None, ""):
                        props[tag] = val
                add({"type": "Point", "coordinates": [float(ins.x), float(ins.y)]}, props)

            elif kind == "LINE":
                s, en = e.dxf.start, e.dxf.end
                add({"type": "LineString",
                     "coordinates": [[float(s.x), float(s.y)], [float(en.x), float(en.y)]]}, props)

            elif kind == "LWPOLYLINE":
                pts = [(float(p[0]), float(p[1])) for p in e.get_points("xy")]
                if len(pts) < 2:
                    continue
                coords = [[x, y] for x, y in pts]
                if e.closed and len(coords) >= 3:
                    ring = coords + [coords[0]] if coords[0] != coords[-1] else coords
                    add({"type": "Polygon", "coordinates": [ring]}, props)
                else:
                    add({"type": "LineString", "coordinates": coords}, props)

            elif kind == "POLYLINE":
                pts = [(float(v.dxf.location.x), float(v.dxf.location.y)) for v in e.vertices]
                if len(pts) < 2:
                    continue
                coords = [[x, y] for x, y in pts]
                if getattr(e, "is_closed", False) and len(coords) >= 3:
                    add({"type": "Polygon", "coordinates": [coords + [coords[0]]]}, props)
                else:
                    add({"type": "LineString", "coordinates": coords}, props)

            # other entity types (ARC, ELLIPSE, SPLINE, HATCH, DIMENSION) are skipped
        except Exception:
            continue   # one bad entity must not abort the whole file

    # ── Decide the sign convention from a sample of raw coordinates ─────────
    sample: list[tuple[float, float]] = []
    for f in raw_features:
        c = f["geometry"]["coordinates"]
        # walk down to the first [x, y]
        while isinstance(c, list) and c and isinstance(c[0], list):
            c = c[0]
        if isinstance(c, list) and len(c) >= 2:
            sample.append((c[0], c[1]))
        if len(sample) >= 800:
            break
    # Auto-detect the real source CRS (ITM vs old Cassini grid) AND sign.
    # `source_crs` (the caller's explicit choice, e.g. from the upload form)
    # is used only as the fallback when auto-detection is inconclusive.
    t, sx, sy, src_crs = _detect_crs_and_sign(sample, fallback_crs=source_crs)

    # ── Pass 2: transform every coordinate with the chosen sign ────────────
    def conv(c):
        if isinstance(c, list) and c and isinstance(c[0], list):
            return [conv(sub) for sub in c]
        lon, lat = t.transform(sx * c[0], sy * c[1])
        return [round(lon, 8), round(lat, 8)]

    features: list[dict] = []
    for f in raw_features:
        try:
            g = f["geometry"]
            features.append({
                "type": "Feature",
                "geometry": {"type": g["type"], "coordinates": conv(g["coordinates"])},
                "properties": f["properties"],
            })
        except Exception:
            continue

    return {"type": "FeatureCollection", "features": features,
            "_meta": {"source_crs_detected": src_crs, "sign": [sx, sy]}}
