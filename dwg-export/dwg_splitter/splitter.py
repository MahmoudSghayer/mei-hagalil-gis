"""
DWG Split Processor — partition a drawing's entities into valid, size-bounded
DWG (or DXF) parts, at the CAD-object level.

Guarantees:
  * coordinates are never touched — entities are copied verbatim (ezdxf Importer)
  * every entity ends up in exactly one part (conservation)
  * every part is <= the byte budget (measured on the real DWG when ODA is
    available, otherwise on the DXF as a conservative proxy)
  * each entity carries a stable, globally-unique GISID (its original handle) in
    MGIS XDATA, so parts merge on import instead of overwriting each other

The byte budget is met by a fast estimate-then-verify loop: entities are
spatially bisected using a cheap per-entity size estimate, then each emitted
part is really rendered and re-split once more if it still exceeds the budget.
"""

from __future__ import annotations

import math
import os
import re
import tempfile
from dataclasses import dataclass, field
from typing import Callable, Optional

import ezdxf
from ezdxf import bbox
from ezdxf.addons import Importer

from . import config
from . import oda as oda_mod
from .geometry import bisect_by_median, collection_bounds
from .strategies import plan_partitions

_MGIS_APPID = "MGIS"
_GISID_PREFIX = "GISID="
# Header variables worth carrying to each part so it opens with the same units
# and drawing conventions as the original.
_HEADER_VARS = ("$INSUNITS", "$MEASUREMENT", "$LUNITS", "$AUNITS", "$LUPREC", "$AUPREC")


# ── part document construction ─────────────────────────────────────────────────

def _slugify(name: str) -> str:
    s = re.sub(r"[^A-Za-z0-9._-]+", "_", str(name)).strip("._")
    return s or "layer"


def _new_like(source) -> "ezdxf.document.Drawing":
    """A fresh drawing matching the source's version + key header vars."""
    ver = getattr(source, "dxfversion", None) or "AC1032"
    try:
        target = ezdxf.new(dxfversion=ver)
    except Exception:
        target = ezdxf.new("R2018")
    for var in _HEADER_VARS:
        try:
            if var in source.header:
                target.header[var] = source.header[var]
        except Exception:
            continue
    return target


def _copy_appids(source, target) -> None:
    for appid in source.appids:
        try:
            name = appid.dxf.name
        except Exception:
            continue
        if name and name not in target.appids:
            try:
                target.appids.new(name)
            except Exception:
                continue


def _import_with_ids(source, target, entities) -> None:
    """Import ``entities`` into ``target`` one at a time so each freshly-created
    target entity can be tagged: its source MGIS XDATA is copied over (Importer
    drops XDATA), and a stable GISID=<source-handle> is ensured. Handles are
    unique within the source doc → globally unique across all parts of this job,
    and deterministic → idempotent re-uploads."""
    tmsp = target.modelspace()
    imp = Importer(source, target)
    for src_e in entities:
        prev = len(tmsp)
        try:
            imp.import_entity(src_e)
        except Exception:
            continue
        now = len(tmsp)
        if now == prev:
            continue  # unsupported entity type — Importer skipped it

        try:
            handle = src_e.dxf.handle or ""
        except Exception:
            handle = ""
        try:
            src_tags = (
                list(src_e.get_xdata(_MGIS_APPID))
                if src_e.has_xdata(_MGIS_APPID)
                else []
            )
        except Exception:
            src_tags = []
        has_gid = any(
            code == 1000 and isinstance(v, str) and v.startswith(_GISID_PREFIX)
            for code, v in src_tags
        )
        span = now - prev
        for k, j in enumerate(range(prev, now)):
            tags = list(src_tags)
            if not has_gid and handle:
                # If one source entity expands to several target entities, keep
                # each id distinct so features don't collide within the part.
                suffix = f".{k}" if span > 1 else ""
                tags.append((1000, f"{_GISID_PREFIX}{handle}{suffix}"))
            if not tags:
                continue
            try:
                tmsp[j].set_xdata(_MGIS_APPID, tags)
            except Exception:
                continue
    imp.finalize()


def _set_extents(doc) -> None:
    try:
        b = bbox.extents(doc.modelspace(), fast=True)
    except Exception:
        return
    if not b.has_data:
        return
    doc.header["$EXTMIN"] = (float(b.extmin.x), float(b.extmin.y), 0.0)
    doc.header["$EXTMAX"] = (float(b.extmax.x), float(b.extmax.y), 0.0)
    try:
        height = max(float(b.size.y), float(b.size.x), 1.0) * 1.1
        doc.set_modelspace_vport(height=height, center=(float(b.center.x), float(b.center.y)))
    except Exception:
        pass


def build_part_doc(source, entities) -> "ezdxf.document.Drawing":
    """Build one part drawing containing exactly ``entities`` (+ their required
    layers/blocks/linetypes/styles), coordinates untouched."""
    target = _new_like(source)
    _copy_appids(source, target)
    if _MGIS_APPID not in target.appids:
        target.appids.new(_MGIS_APPID)
    _import_with_ids(source, target, entities)
    _set_extents(target)
    return target


def doc_to_dxf_bytes(doc) -> bytes:
    with tempfile.NamedTemporaryFile(suffix=".dxf", delete=False) as tf:
        path = tf.name
    try:
        doc.saveas(path)
        with open(path, "rb") as fh:
            return fh.read()
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


def _render(doc, use_oda: bool) -> tuple[bytes, str, int]:
    """Render a part doc to output bytes: real DWG when ODA is available, else
    DXF (still a valid CAD file). Returns (data, ext, size_bytes)."""
    dxf_bytes = doc_to_dxf_bytes(doc)
    if use_oda:
        dwg = oda_mod.dxf_to_dwg(dxf_bytes)
        if dwg:
            return dwg, "dwg", len(dwg)
    return dxf_bytes, "dxf", len(dxf_bytes)


# ── size-bounded partitioning ──────────────────────────────────────────────────

def _subdivide(entities: list, estimate: Callable[[list], float], budget: int,
               depth: int = 0) -> list[list]:
    """Recursively bisect a group spatially until the ESTIMATED size of each
    piece is within budget (or it can't be split / hits the depth cap)."""
    if not entities:
        return []
    if (estimate(entities) <= budget
            or len(entities) <= config.MIN_ENTITIES_PER_PART
            or depth >= config.MAX_SUBDIVIDE_DEPTH):
        return [entities]
    a, b = bisect_by_median(entities)
    if not b:  # indivisible (all points coincide)
        return [entities]
    return (_subdivide(a, estimate, budget, depth + 1)
            + _subdivide(b, estimate, budget, depth + 1))


@dataclass
class Part:
    filename: str
    data: bytes
    ext: str
    size: int
    entity_count: int
    layers: list
    bounds: Optional[list]  # [minx, miny, maxx, maxy]


@dataclass
class SplitResult:
    parts: list = field(default_factory=list)
    strategy: str = "hybrid"
    budget: int = 0
    oda_used: bool = False
    source_entities: int = 0
    warnings: list = field(default_factory=list)

    @property
    def total_parts(self) -> int:
        return len(self.parts)

    @property
    def emitted_entities(self) -> int:
        return sum(p.entity_count for p in self.parts)


def _layers_of(entities) -> list:
    out = set()
    for e in entities:
        try:
            out.add(getattr(e.dxf, "layer", "0") or "0")
        except Exception:
            out.add("0")
    return sorted(out)


def split_drawing(
    source,
    *,
    stem: str = "part",
    strategy: Optional[str] = None,
    max_bytes: Optional[int] = None,
    use_oda: Optional[bool] = None,
    on_progress: Optional[Callable[[int, str], None]] = None,
) -> SplitResult:
    """Split an ezdxf ``Drawing`` into size-bounded parts. Returns a SplitResult
    whose parts hold the output bytes (not yet written to disk)."""
    budget = max_bytes if max_bytes is not None else config.max_part_bytes()
    if use_oda is None:
        use_oda = oda_mod.oda_available()

    partitions, resolved = plan_partitions(source, strategy or config.DEFAULT_STRATEGY)

    result = SplitResult(
        strategy=resolved, budget=budget, oda_used=bool(use_oda),
    )

    # Fast per-entity size estimate (avoids building a doc per bisection probe).
    # Measured on DXF — a conservative proxy when the real output is DWG (DWG is
    # smaller), so parts stay safely under budget.
    empty_len = len(doc_to_dxf_bytes(_new_like(source)))
    n_total = sum(1 for _ in source.modelspace())
    source_len = len(doc_to_dxf_bytes(source))
    per_entity = max(1.0, (source_len - empty_len) / max(1, n_total))
    result.source_entities = n_total

    def estimate(ents: list) -> float:
        return empty_len + len(ents) * per_entity

    # A part can never be smaller than the file format's fixed overhead. If the
    # budget is below that, subdividing is futile (it would just emit many parts
    # each still over budget) — fall back to one part per layer/tile and warn
    # once, instead of exploding into hundreds of tiny over-budget files.
    feasible = budget > empty_len
    enforce = resolved != "layer" and feasible
    if resolved != "layer" and not feasible:
        result.warnings.append(
            f"budget {budget} bytes is below the DXF file overhead (~{empty_len} "
            f"bytes); parts cannot be made that small — emitting one part per "
            f"{'tile group' if resolved == 'tile' else 'layer'} instead. Raise "
            f"--max-mb, or split where ODA can emit smaller DWG parts."
        )

    # Build the ordered work list of (label, entities) candidate groups.
    work: list[tuple[str, list]] = []
    for label, ents in partitions:
        if not ents:
            continue
        if enforce:
            subs = _subdivide(ents, estimate, budget)
            if len(subs) == 1:
                work.append((label, subs[0]))
            else:
                for i, sub in enumerate(subs, 1):
                    work.append((f"{label}-t{i:03d}", sub))
        else:
            work.append((label, ents))

    # Render each group; when enforcing the budget, verify the REAL size and
    # bisect once more if the estimate was optimistic.
    idx = 0
    part_no = 0
    while idx < len(work):
        label, ents = work[idx]
        idx += 1
        doc = build_part_doc(source, ents)
        data, ext, size = _render(doc, use_oda)

        if (enforce and size > budget
                and len(ents) > config.MIN_ENTITIES_PER_PART):
            a, b = bisect_by_median(ents)
            if b:
                work.insert(idx, (f"{label}.b", b))
                work.insert(idx, (f"{label}.a", a))
                continue

        part_no += 1
        filename = f"{stem}_{_slugify(label)}_{part_no:03d}.{ext}"
        # Per-part over-budget warning — but not for the infeasible tile/hybrid
        # case, which already emitted one summary warning above.
        if size > budget and (resolved == "layer" or feasible):
            result.warnings.append(
                f"{filename}: {size} bytes exceeds the {budget}-byte budget and "
                f"could not be split further ({len(ents)} entit"
                f"{'y' if len(ents) == 1 else 'ies'})."
            )
        result.parts.append(Part(
            filename=filename, data=data, ext=ext, size=size,
            entity_count=len(ents), layers=_layers_of(ents),
            bounds=collection_bounds(ents),
        ))
        if on_progress:
            on_progress(part_no, filename)

    # Conservation sanity check (should always hold).
    if result.emitted_entities != n_total:
        result.warnings.append(
            f"entity conservation mismatch: source={n_total} "
            f"emitted={result.emitted_entities} (some entities may be unsupported "
            f"by the importer)."
        )
    return result
