"""
DWG/DXF analyzer — inspect a drawing's structure without changing it.

Produces the JSON the split-decision engine (and the /api/dwg/analyze endpoint)
consume: layers with per-layer entity counts, named blocks, entity totals by
type, the bounding box, the detected coordinate system, and the drawing units.
"""

from __future__ import annotations

import math
from collections import Counter
from typing import Optional

from ezdxf import bbox

from .geometry import entity_point

_UNIT_NAMES = {
    0: "unitless", 1: "inches", 2: "feet", 4: "mm", 5: "cm", 6: "meters",
    7: "km", 8: "microinches", 9: "mils", 21: "US survey feet",
}


def human_size(n: Optional[int]) -> Optional[str]:
    if n is None:
        return None
    if n < 1024:
        return f"{n}B"
    if n < 1024 * 1024:
        return f"{n / 1024:.1f}KB"
    return f"{n / (1024 * 1024):.1f}MB"


def _bounds_from_header(doc) -> Optional[list[float]]:
    """Bounds from $EXTMIN/$EXTMAX, or None if unset. A fresh drawing stores the
    sentinel (1e20, 1e20)/(-1e20, -1e20), which we reject as 'not set'."""
    try:
        emin = doc.header.get("$EXTMIN")
        emax = doc.header.get("$EXTMAX")
    except Exception:
        return None
    if not emin or not emax:
        return None
    try:
        b = [float(emin[0]), float(emin[1]), float(emax[0]), float(emax[1])]
    except (TypeError, ValueError, IndexError):
        return None
    if not all(math.isfinite(v) for v in b):
        return None
    if any(abs(v) > 1e19 for v in b):  # unset sentinel
        return None
    if b[2] <= b[0] or b[3] <= b[1]:
        return None
    return b


def _bounds_computed(msp) -> Optional[list[float]]:
    try:
        b = bbox.extents(msp, fast=True)
    except Exception:
        return None
    if not b.has_data:
        return None
    return [float(b.extmin.x), float(b.extmin.y), float(b.extmax.x), float(b.extmax.y)]


def _detect_crs(sample: list[tuple[float, float]], crs_hint: str):
    """Reuse the service's CRS/sign auto-detection (dxf_to_geojson) so the
    analyzer reports the same CRS the importer would actually use."""
    try:
        import dxf_to_geojson as d2g  # top-level module in dwg-export/

        _t, sx, sy, crs = d2g._detect_crs_and_sign(sample, fallback_crs=crs_hint)
        return crs, [int(sx), int(sy)]
    except Exception:
        return crs_hint, [1, 1]


def analyze(
    doc,
    *,
    filename: str = "",
    size_bytes: Optional[int] = None,
    crs_hint: str = "EPSG:2039",
) -> dict:
    """Inspect an ezdxf ``Drawing`` and return a structured analysis dict."""
    msp = doc.modelspace()

    type_counts: Counter = Counter()
    layer_counts: Counter = Counter()
    total = 0
    sample: list[tuple[float, float]] = []

    for e in msp:
        total += 1
        try:
            type_counts[e.dxftype()] += 1
            layer_counts[(getattr(e.dxf, "layer", "0") or "0")] += 1
            if len(sample) < 800:
                p = entity_point(e)
                if p is not None:
                    sample.append(p)
        except Exception:
            continue

    bounds = _bounds_from_header(doc) or _bounds_computed(msp)
    crs, sign = _detect_crs(sample, crs_hint)

    # User-named block definitions only — exclude *Model_Space/*Paper_Space and
    # anonymous blocks (hatch/dimension geometry: names start with '*').
    blocks = sorted(
        b.name for b in doc.blocks if b.name and not b.name.startswith("*")
    )

    try:
        insunits = int(doc.header.get("$INSUNITS", 0) or 0)
    except (TypeError, ValueError):
        insunits = 0

    return {
        "filename": filename,
        "size_bytes": size_bytes,
        "size": human_size(size_bytes),
        "dxf_version": getattr(doc, "dxfversion", None),
        "entities": total,
        "entities_by_type": dict(
            sorted(type_counts.items(), key=lambda kv: (-kv[1], kv[0]))
        ),
        "layers": [
            {"name": name, "entities": count}
            for name, count in sorted(
                layer_counts.items(), key=lambda kv: (-kv[1], kv[0])
            )
        ],
        "layer_names": sorted(layer_counts.keys()),
        "blocks": blocks,
        "bounds": (
            {"minX": bounds[0], "minY": bounds[1], "maxX": bounds[2], "maxY": bounds[3]}
            if bounds
            else None
        ),
        "coordinate_system": crs,
        "coordinate_sign": sign,
        "insunits": insunits,
        "units": _UNIT_NAMES.get(insunits, "unknown"),
    }
