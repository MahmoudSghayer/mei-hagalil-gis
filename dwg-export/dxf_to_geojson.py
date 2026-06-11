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


def dxf_to_geojson(dxf_bytes: bytes, source_crs: str = "EPSG:2039") -> dict:
    # ezdxf wants a file path so it can sniff the DXF encoding itself.
    with tempfile.NamedTemporaryFile(suffix=".dxf", delete=False) as tf:
        tf.write(dxf_bytes)
        path = tf.name
    try:
        doc = ezdxf.readfile(path)
    finally:
        os.unlink(path)

    t = Transformer.from_crs(source_crs or "EPSG:2039", "EPSG:4326", always_xy=True)
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
    sx, sy = _detect_sign(t, sample)

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

    return {"type": "FeatureCollection", "features": features}
