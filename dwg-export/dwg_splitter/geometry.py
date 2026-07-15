"""
Geometry helpers — a single representative point and a bounding box per entity.

Used to assign whole entities to spatial tiles (never cutting an entity across
a tile boundary) and to compute part/drawing extents. All coordinates are the
drawing's own model-space units — nothing here reprojects or moves geometry.
"""

from __future__ import annotations

import math
from typing import Iterable, Optional

from ezdxf import bbox
from ezdxf.math import BoundingBox


def entity_extents(entity) -> Optional[BoundingBox]:
    """Fast (control-point) bounding box of one entity, or None if it has no
    resolvable geometry. ``fast=True`` avoids flattening curves — good enough
    for tile assignment and much cheaper on splines/arcs."""
    try:
        b = bbox.extents([entity], fast=True)
    except Exception:
        return None
    return b if b.has_data else None


def entity_point(entity) -> Optional[tuple[float, float]]:
    """A single representative (x, y) for an entity — the centre of its bounding
    box, with per-type fallbacks for the rare entity ``bbox`` cannot handle."""
    b = entity_extents(entity)
    if b is not None:
        c = b.center
        return (float(c.x), float(c.y))
    dxf = getattr(entity, "dxf", None)
    if dxf is not None:
        for attr in ("insert", "location", "center", "start"):
            try:
                if dxf.hasattr(attr):
                    p = getattr(dxf, attr)
                    return (float(p.x), float(p.y))
            except Exception:
                continue
    return None


def collection_bounds(entities: Iterable) -> Optional[list[float]]:
    """[minx, miny, maxx, maxy] over all entities, or None when empty/degenerate.
    Uses the fast per-entity boxes so it works on any entity mix."""
    minx = miny = math.inf
    maxx = maxy = -math.inf
    found = False
    for e in entities:
        b = entity_extents(e)
        if b is None:
            continue
        found = True
        if b.extmin.x < minx:
            minx = b.extmin.x
        if b.extmin.y < miny:
            miny = b.extmin.y
        if b.extmax.x > maxx:
            maxx = b.extmax.x
        if b.extmax.y > maxy:
            maxy = b.extmax.y
    if not found or not all(math.isfinite(v) for v in (minx, miny, maxx, maxy)):
        return None
    return [minx, miny, maxx, maxy]


def bisect_by_median(entities: list) -> tuple[list, list]:
    """Split entities into two spatial halves along their longer extent axis,
    at the MEDIAN representative coordinate (balanced halves). Entities whose
    point cannot be resolved go with the first half. Returns (a, b); if the set
    cannot be split (all points identical / not enough distinct coords), returns
    (entities, []) so the caller can stop recursing."""
    pts: list[tuple[float, float]] = []
    resolvable: list = []
    unresolved: list = []
    for e in entities:
        p = entity_point(e)
        if p is None:
            unresolved.append(e)
        else:
            pts.append(p)
            resolvable.append(e)

    if len(resolvable) < 2:
        return (entities, [])

    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    span_x = max(xs) - min(xs)
    span_y = max(ys) - min(ys)
    axis = 0 if span_x >= span_y else 1
    if (span_x if axis == 0 else span_y) == 0:
        return (entities, [])  # all points coincide on both axes

    coords = sorted(p[axis] for p in pts)
    mid = coords[len(coords) // 2]  # median

    a: list = list(unresolved)
    b: list = []
    for e, p in zip(resolvable, pts):
        (a if p[axis] < mid else b).append(e)

    # Median can land all points on one side (many ties at the median value).
    # Fall back to a strict index split so we always make progress.
    if not a or not b:
        half = len(resolvable) // 2
        a = list(unresolved) + resolvable[:half]
        b = resolvable[half:]
        if not a or not b:
            return (entities, [])
    return (a, b)
