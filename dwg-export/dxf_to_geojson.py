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
"""

from __future__ import annotations

import os
import tempfile
from typing import Any

import ezdxf
from pyproj import Transformer


def _round_pt(t: Transformer, x: float, y: float) -> list[float]:
    lon, lat = t.transform(float(x), float(y))   # always_xy: (easting,northing)→(lon,lat)
    return [round(lon, 8), round(lat, 8)]


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
    features: list[dict] = []

    def add(geometry: dict, props: dict) -> None:
        features.append({"type": "Feature", "geometry": geometry, "properties": props})

    for e in msp:
        try:
            kind = e.dxftype()
            layer = getattr(e.dxf, "layer", "0") or "0"
            props: dict[str, Any] = {"Layer": layer}

            if kind == "POINT":
                loc = e.dxf.location
                add({"type": "Point", "coordinates": _round_pt(t, loc.x, loc.y)}, props)

            elif kind == "CIRCLE":
                c = e.dxf.center
                add({"type": "Point", "coordinates": _round_pt(t, c.x, c.y)}, props)

            elif kind in ("TEXT", "MTEXT"):
                ins = e.dxf.insert
                props["Text"] = (e.text if kind == "MTEXT" else e.dxf.text)
                add({"type": "Point", "coordinates": _round_pt(t, ins.x, ins.y)}, props)

            elif kind == "INSERT":
                ins = e.dxf.insert
                props["Block"] = e.dxf.name
                for att in e.attribs:                     # manhole Hebrew tags etc.
                    tag, val = att.dxf.tag, att.dxf.text
                    if tag and val not in (None, ""):
                        props[tag] = val
                add({"type": "Point", "coordinates": _round_pt(t, ins.x, ins.y)}, props)

            elif kind == "LINE":
                s, en = e.dxf.start, e.dxf.end
                add({"type": "LineString",
                     "coordinates": [_round_pt(t, s.x, s.y), _round_pt(t, en.x, en.y)]}, props)

            elif kind == "LWPOLYLINE":
                pts = [(p[0], p[1]) for p in e.get_points("xy")]
                if len(pts) < 2:
                    continue
                coords = [_round_pt(t, x, y) for x, y in pts]
                if e.closed and len(coords) >= 3:
                    ring = coords + [coords[0]] if coords[0] != coords[-1] else coords
                    add({"type": "Polygon", "coordinates": [ring]}, props)
                else:
                    add({"type": "LineString", "coordinates": coords}, props)

            elif kind == "POLYLINE":
                pts = [(v.dxf.location.x, v.dxf.location.y) for v in e.vertices]
                if len(pts) < 2:
                    continue
                coords = [_round_pt(t, x, y) for x, y in pts]
                if getattr(e, "is_closed", False) and len(coords) >= 3:
                    add({"type": "Polygon", "coordinates": [coords + [coords[0]]]}, props)
                else:
                    add({"type": "LineString", "coordinates": coords}, props)

            # other entity types (ARC, ELLIPSE, SPLINE, HATCH, DIMENSION) are skipped
        except Exception:
            continue   # one bad entity must not abort the whole file

    return {"type": "FeatureCollection", "features": features}
