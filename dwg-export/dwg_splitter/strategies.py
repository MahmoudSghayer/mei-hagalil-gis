"""
Split Decision Engine — turn an analysis into an ordered list of entity groups.

Three strategies (the A / B / C of the spec):

  layer  (A) — one group per CAD layer. Use when layers are independent
               (roads / buildings / pipes). Parts stay single-layer; a lone
               layer that busts the budget is emitted whole (with a warning).
  tile   (B) — one group of everything; the splitter then tiles it spatially so
               every part meets the budget. Use for one big dense layer.
  hybrid (C) — layer-first, then spatially tile any layer that busts the budget.
               The recommended default: independent layers stay clean, oversized
               ones are still guaranteed under the limit.

Grouping only *labels* and *buckets* entities — it never moves or drops them.
The spatial subdivision that enforces the byte budget lives in splitter.py.
"""

from __future__ import annotations

from collections import OrderedDict


def resolve_strategy(strategy: str | None) -> str:
    s = (strategy or "hybrid").lower()
    if s == "auto":
        s = "hybrid"
    if s not in ("layer", "tile", "hybrid"):
        raise ValueError(
            f"unknown strategy {strategy!r}; choose layer, tile, hybrid (or auto)"
        )
    return s


def plan_partitions(doc, strategy: str) -> tuple[list[tuple[str, list]], str]:
    """Return (groups, resolved_strategy) where groups is an ordered list of
    (label, entities). Every model-space entity appears in exactly one group."""
    resolved = resolve_strategy(strategy)
    entities = list(doc.modelspace())

    if resolved == "tile":
        return ([("tile", entities)] if entities else []), resolved

    # layer / hybrid: bucket by layer, preserving first-seen order.
    groups: "OrderedDict[str, list]" = OrderedDict()
    for e in entities:
        try:
            layer = getattr(e.dxf, "layer", "0") or "0"
        except Exception:
            layer = "0"
        groups.setdefault(layer, []).append(e)

    return [(layer, ents) for layer, ents in groups.items()], resolved
