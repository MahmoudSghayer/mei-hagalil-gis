"""Split Decision Engine — grouping and strategy resolution (no ODA, no pyproj)."""

import pytest

from dwg_splitter.strategies import plan_partitions, resolve_strategy
from tests.fixtures.dxf_samples import multilayer_drawing, single_layer_drawing


def test_resolve_strategy_aliases_and_validation():
    assert resolve_strategy(None) == "hybrid"
    assert resolve_strategy("auto") == "hybrid"
    assert resolve_strategy("LAYER") == "layer"
    assert resolve_strategy("Tile") == "tile"
    with pytest.raises(ValueError):
        resolve_strategy("nonsense")


def test_layer_partition_groups_by_layer_and_conserves():
    doc = multilayer_drawing(n_roads=20, n_buildings=15, n_manholes=10)
    groups, resolved = plan_partitions(doc, "layer")
    assert resolved == "layer"
    labels = {label for label, _ in groups}
    assert labels == {"roads", "buildings", "pipes"}
    # every entity accounted for, exactly once
    total = sum(len(ents) for _, ents in groups)
    assert total == 45
    counts = {label: len(ents) for label, ents in groups}
    assert counts == {"roads": 20, "buildings": 15, "pipes": 10}


def test_tile_partition_is_single_group():
    doc = single_layer_drawing(n=50)
    groups, resolved = plan_partitions(doc, "tile")
    assert resolved == "tile"
    assert len(groups) == 1
    assert groups[0][0] == "tile"
    assert len(groups[0][1]) == 50


def test_hybrid_resolves_and_groups_by_layer():
    doc = multilayer_drawing(n_roads=5, n_buildings=5, n_manholes=5)
    groups, resolved = plan_partitions(doc, "hybrid")
    assert resolved == "hybrid"
    assert len(groups) == 3
