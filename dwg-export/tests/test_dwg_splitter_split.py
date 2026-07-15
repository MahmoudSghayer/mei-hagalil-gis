"""
Core splitter behaviour — conservation, size budget, coordinate preservation,
stable GISIDs, and layer/block fidelity. Runs entirely on ezdxf (use_oda=False),
so it needs neither ODA nor pyproj and is deterministic in CI.
"""

from collections import Counter

from dwg_splitter.loader import read_dxf_bytes
from dwg_splitter.splitter import doc_to_dxf_bytes, split_drawing
from dwg_splitter.validate import validate_split
from tests.fixtures.dxf_samples import multilayer_drawing, single_layer_drawing


def _budget_for(doc, fraction=4) -> int:
    """A budget that forces the drawing to split into several parts. The floor is
    kept above the ~19KB DXF fixed overhead so the budget is actually achievable
    for DXF output (below that, no split can help — see the feasibility guard)."""
    return max(40_000, len(doc_to_dxf_bytes(doc)) // fraction)


def _gisids(part) -> list[str]:
    doc = read_dxf_bytes(part.data)
    out = []
    for e in doc.modelspace():
        if e.has_xdata("MGIS"):
            for code, v in e.get_xdata("MGIS"):
                if code == 1000 and str(v).startswith("GISID="):
                    out.append(str(v))
    return out


def test_hybrid_split_conserves_entities_and_meets_budget():
    doc = multilayer_drawing()
    n_total = len(list(doc.modelspace()))
    budget = _budget_for(doc)

    result = split_drawing(doc, stem="city", strategy="hybrid",
                           max_bytes=budget, use_oda=False)

    assert result.total_parts > 1
    assert result.emitted_entities == n_total
    assert all(p.size <= budget for p in result.parts)
    assert all(p.ext == "dxf" for p in result.parts)
    assert not result.warnings


def test_split_validation_all_checks_pass():
    doc = multilayer_drawing()
    result = split_drawing(doc, stem="city", strategy="hybrid",
                           max_bytes=_budget_for(doc), use_oda=False)
    report = validate_split(doc, result)
    assert report["ok"], report
    names = {c["check"]: c for c in report["checks"]}
    assert names["entity_conservation"]["ok"]
    assert names["size_budget"]["ok"]
    assert names["bounds_union"]["ok"]
    assert names["coordinates_unchanged"]["ok"] and not names["coordinates_unchanged"]["skipped"]
    assert names["type_conservation"]["ok"]


def test_gisids_are_globally_unique_across_parts():
    doc = multilayer_drawing()
    n_total = len(list(doc.modelspace()))
    result = split_drawing(doc, stem="city", strategy="hybrid",
                           max_bytes=_budget_for(doc), use_oda=False)
    all_ids = [gid for p in result.parts for gid in _gisids(p)]
    assert len(all_ids) == n_total            # every entity tagged
    assert len(set(all_ids)) == n_total       # and every id distinct


def test_layer_strategy_yields_single_layer_parts():
    doc = multilayer_drawing()
    # Huge budget: no size-driven subdivision, so each layer is exactly one part.
    result = split_drawing(doc, stem="city", strategy="layer",
                           max_bytes=50 * 1024 * 1024, use_oda=False)
    assert result.total_parts == 3
    for p in result.parts:
        assert len(p.layers) == 1


def test_tile_strategy_single_part_under_budget_keeps_all_layers():
    doc = multilayer_drawing(n_roads=10, n_buildings=10, n_manholes=10)
    result = split_drawing(doc, stem="city", strategy="tile",
                           max_bytes=50 * 1024 * 1024, use_oda=False)
    assert result.total_parts == 1
    assert set(result.parts[0].layers) == {"roads", "buildings", "pipes"}


def test_blocks_and_attribs_preserved_in_parts():
    doc = multilayer_drawing()
    result = split_drawing(doc, stem="city", strategy="layer",
                           max_bytes=50 * 1024 * 1024, use_oda=False)
    pipes = next(p for p in result.parts if "pipes" in p.layers)
    part_doc = read_dxf_bytes(pipes.data)
    assert "MANHOLE" in part_doc.blocks
    inserts = [e for e in part_doc.modelspace() if e.dxftype() == "INSERT"]
    assert inserts
    tags = {a.dxf.tag for a in inserts[0].attribs}
    assert "TL" in tags


def test_single_layer_drawing_tiles_within_budget():
    doc = single_layer_drawing(n=400)
    n_total = len(list(doc.modelspace()))
    budget = _budget_for(doc, fraction=3)
    result = split_drawing(doc, stem="dense", strategy="tile",
                           max_bytes=budget, use_oda=False)
    assert result.total_parts > 1
    assert result.emitted_entities == n_total
    assert all(p.size <= budget for p in result.parts)
    # spatial tiles never cut an entity — counts sum exactly
    assert sum(p.entity_count for p in result.parts) == n_total


def test_part_layer_colors_preserved():
    doc = multilayer_drawing(n_roads=10, n_buildings=10, n_manholes=10)
    result = split_drawing(doc, stem="city", strategy="layer",
                           max_bytes=50 * 1024 * 1024, use_oda=False)
    roads = next(p for p in result.parts if "roads" in p.layers)
    part_doc = read_dxf_bytes(roads.data)
    assert part_doc.layers.get("roads").dxf.color == 1
