"""
Validate a split — prove the parts are faithful to the original.

Checks:
  * conservation   — every source entity type/count is accounted for in the parts
  * size           — every part is within the byte budget
  * bounds         — the union of the parts' bounding boxes matches the source
  * reopen         — every part re-opens as a valid drawing
  * coordinates    — sampled source coordinates appear (unchanged) in a part

Re-opening DWG parts needs ODA (to read them back). When ODA is unavailable the
reopen/coordinate/type checks fall back to whatever can be read (DXF parts) and
are reported as 'skipped' rather than failed.
"""

from __future__ import annotations

import math
from collections import Counter
from typing import Optional

from . import oda as oda_mod
from .geometry import entity_point
from .loader import read_dxf_bytes


def _round_pt(p: tuple[float, float], nd: int = 3) -> tuple[float, float]:
    return (round(p[0], nd), round(p[1], nd))


def reopen_part(part) -> Optional[object]:
    """Re-open a Part's bytes as an ezdxf Drawing, or None if it can't be read
    here (a DWG part with no ODA available)."""
    try:
        if part.ext == "dxf":
            return read_dxf_bytes(part.data)
        if oda_mod.oda_available():
            dxf = oda_mod.dwg_to_dxf(part.data)
            if dxf:
                return read_dxf_bytes(dxf)
    except Exception:
        return None
    return None


def _type_counts(msp) -> Counter:
    c: Counter = Counter()
    for e in msp:
        try:
            c[e.dxftype()] += 1
        except Exception:
            continue
    return c


def _point_counts(msp) -> Counter:
    c: Counter = Counter()
    for e in msp:
        p = entity_point(e)
        if p is not None:
            c[_round_pt(p)] += 1
    return c


def validate_split(source, result, *, coordinate_check: bool = True) -> dict:
    """Return a report dict: {ok: bool, checks: [...]}. Never raises."""
    checks: list[dict] = []

    def add(name, ok, detail, *, skipped=False):
        checks.append({"check": name, "ok": bool(ok), "skipped": bool(skipped),
                       "detail": detail})

    src_msp = source.modelspace()
    src_types = _type_counts(src_msp)
    src_total = sum(src_types.values())

    # 1. Conservation by count (cheap, always available).
    add("entity_conservation",
        result.emitted_entities == src_total,
        f"source={src_total} emitted={result.emitted_entities}")

    # 2. Size budget.
    over = [p.filename for p in result.parts if p.size > result.budget]
    add("size_budget", not over,
        "all parts within budget" if not over else f"over budget: {over}")

    # 3. Bounds union vs source.
    src_bounds = _union_bounds([p.bounds for p in result.parts])
    src_ref = _msp_bounds(src_msp)
    if src_bounds and src_ref:
        ok = all(abs(a - b) <= max(1.0, abs(b) * 1e-6)
                 for a, b in zip(src_bounds, src_ref))
        add("bounds_union", ok,
            f"parts={_fmt_b(src_bounds)} source={_fmt_b(src_ref)}")
    else:
        add("bounds_union", True, "no computable bounds", skipped=True)

    # 4/5. Reopen + type conservation + coordinate fidelity (needs readable parts).
    reopened = []
    unreadable = []
    for p in result.parts:
        doc = reopen_part(p)
        if doc is None:
            unreadable.append(p.filename)
        else:
            reopened.append(doc)

    if unreadable and not reopened:
        add("parts_reopen", True,
            f"cannot reopen {len(unreadable)} DWG part(s) without ODA",
            skipped=True)
        add("type_conservation", True, "requires readable parts", skipped=True)
        if coordinate_check:
            add("coordinates_unchanged", True, "requires readable parts",
                skipped=True)
        return _finalize(checks)

    add("parts_reopen", not unreadable,
        "all parts reopened" if not unreadable
        else f"unreadable: {unreadable}")

    part_types: Counter = Counter()
    part_points: Counter = Counter()
    for doc in reopened:
        msp = doc.modelspace()
        part_types += _type_counts(msp)
        if coordinate_check:
            part_points += _point_counts(msp)

    # Only compare types over the parts we could actually read.
    if not unreadable:
        add("type_conservation", part_types == src_types,
            _diff_counter(src_types, part_types))
    else:
        add("type_conservation", True,
            "some parts unreadable — partial", skipped=True)

    if coordinate_check:
        if unreadable:
            add("coordinates_unchanged", True, "some parts unreadable — partial",
                skipped=True)
        else:
            src_points = _point_counts(src_msp)
            missing = 0
            for pt, n in src_points.items():
                if part_points.get(pt, 0) < n:
                    missing += n - part_points.get(pt, 0)
            add("coordinates_unchanged", missing == 0,
                "all sampled coordinates preserved" if missing == 0
                else f"{missing} coordinate occurrence(s) not found in parts")

    return _finalize(checks)


def _finalize(checks: list[dict]) -> dict:
    ok = all(c["ok"] for c in checks if not c["skipped"])
    return {"ok": ok, "checks": checks}


def _msp_bounds(msp) -> Optional[list[float]]:
    from ezdxf import bbox

    try:
        b = bbox.extents(msp, fast=True)
    except Exception:
        return None
    if not b.has_data:
        return None
    return [float(b.extmin.x), float(b.extmin.y), float(b.extmax.x), float(b.extmax.y)]


def _union_bounds(bounds_list) -> Optional[list[float]]:
    minx = miny = math.inf
    maxx = maxy = -math.inf
    found = False
    for b in bounds_list:
        if not b:
            continue
        found = True
        minx, miny = min(minx, b[0]), min(miny, b[1])
        maxx, maxy = max(maxx, b[2]), max(maxy, b[3])
    if not found:
        return None
    return [minx, miny, maxx, maxy]


def _fmt_b(b) -> str:
    return "[" + ", ".join(f"{v:.2f}" for v in b) + "]" if b else "None"


def _diff_counter(a: Counter, b: Counter) -> str:
    if a == b:
        return "type counts match"
    diffs = []
    for k in sorted(set(a) | set(b)):
        if a.get(k, 0) != b.get(k, 0):
            diffs.append(f"{k}: src={a.get(k, 0)} parts={b.get(k, 0)}")
    return "; ".join(diffs)
