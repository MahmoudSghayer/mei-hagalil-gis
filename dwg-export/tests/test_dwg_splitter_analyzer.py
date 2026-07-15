"""Analyzer — structure inspection + CRS detection (fake_transformer, no ODA)."""

from dwg_splitter.analyzer import analyze, human_size
from tests.fixtures.dxf_samples import multilayer_drawing


def test_human_size():
    assert human_size(None) is None
    assert human_size(500) == "500B"
    assert human_size(2048) == "2.0KB"
    assert human_size(3 * 1024 * 1024) == "3.0MB"


def test_analyze_reports_structure(fake_transformer):
    doc = multilayer_drawing(n_roads=200, n_buildings=150, n_manholes=100)
    a = analyze(doc, filename="city.dxf", size_bytes=1234567)

    assert a["filename"] == "city.dxf"
    assert a["size"] == "1.2MB"
    assert a["entities"] == 450
    assert a["entities_by_type"]["LINE"] == 200
    assert a["entities_by_type"]["LWPOLYLINE"] == 150
    assert a["entities_by_type"]["INSERT"] == 100

    assert a["layer_names"] == ["buildings", "pipes", "roads"]
    counts = {row["name"]: row["entities"] for row in a["layers"]}
    assert counts == {"roads": 200, "buildings": 150, "pipes": 100}

    assert a["blocks"] == ["MANHOLE"]
    assert a["insunits"] == 6
    assert a["units"] == "meters"


def test_analyze_bounds_and_crs(fake_transformer):
    doc = multilayer_drawing(n_roads=50, n_buildings=50, n_manholes=50)
    a = analyze(doc, filename="city.dxf")

    b = a["bounds"]
    assert b is not None
    # grid starts at ITM (200000, 740000)
    assert abs(b["minX"] - 200_000) < 50
    assert abs(b["minY"] - 740_000) < 50
    assert b["maxX"] > b["minX"] and b["maxY"] > b["minY"]

    # Only the EPSG:2039 offset lands these coordinates inside Israel under the
    # fake transformer — detection must pick it unambiguously.
    assert a["coordinate_system"] == "EPSG:2039"
    assert a["coordinate_sign"] == [1, 1]


def test_analyze_empty_drawing():
    import ezdxf

    a = analyze(ezdxf.new("R2018"), filename="empty.dxf", size_bytes=0)
    assert a["entities"] == 0
    assert a["layers"] == []
    assert a["blocks"] == []
    assert a["bounds"] is None
