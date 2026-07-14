"""
Tests for dxf_to_geojson.dxf_to_geojson() — the inverse of dxf_builder.

Each test writes a small DXF fixture with ezdxf directly (LWPOLYLINE, LINE,
CIRCLE, TEXT/MTEXT, a block INSERT with ATTRIBs, explicit layer colors),
then runs it through dxf_to_geojson() and inspects the resulting GeoJSON.

CRS auto-detect (dxf_to_geojson.py:71-105) tries 4 candidate source CRSs
(EPSG:2039 / 28193 / 28191 / 6991) x 4 sign conventions and picks whichever
lands the most sample points inside Israel's WGS84 bounding box
(dxf_to_geojson.py:38-47). These tests use the `fake_transformer` fixture
(tests/conftest.py) so each candidate CRS has its own widely-separated,
exactly-invertible affine — real EPSG:6991 differs from EPSG:2039 by only
centimetres in practice, which would make "unambiguously" selecting one over
the other via this hit-counting heuristic untestable with real PROJ (both
would always score 100% and 2039 would win every tie, since it's tried
first). The fake affine's job is to exercise the SELECTION LOGIC itself
(which candidate/sign wins the hit count, and the dead-fallback bug fixed
below), independent of how close two real datums happen to be — CI's
`pytest -q` (real pyproj) still imports and exercises the real projection
for every other code path in the service.
"""
import os
import tempfile

import ezdxf
import pytest

from dxf_to_geojson import dxf_to_geojson

pytestmark = pytest.mark.usefixtures("fake_transformer")


def _dxf_bytes(build_fn) -> bytes:
    doc = ezdxf.new("R2018")
    build_fn(doc, doc.modelspace())
    with tempfile.NamedTemporaryFile(suffix=".dxf", delete=False) as tf:
        path = tf.name
    try:
        doc.saveas(path)
        with open(path, "rb") as fh:
            return fh.read()
    finally:
        os.unlink(path)


def _by_type(features, gtype):
    return [f for f in features if f["geometry"]["type"] == gtype]


# ── geometry conversion ──────────────────────────────────────────────────────

def test_line_becomes_linestring():
    def build(doc, msp):
        msp.add_line((230000, 790000, 0), (230100, 790050, 0), dxfattribs={"layer": "0"})

    result = dxf_to_geojson(_dxf_bytes(build))
    lines = _by_type(result["features"], "LineString")
    assert len(lines) == 1
    assert lines[0]["geometry"]["coordinates"] == [
        pytest.approx([35.3, 32.9], abs=1e-6),
        pytest.approx([35.301, 32.9005], abs=1e-6),
    ]


def test_open_lwpolyline_becomes_linestring():
    def build(doc, msp):
        msp.add_lwpolyline(
            [(230000, 790000), (230050, 790020), (230100, 790000)],
            dxfattribs={"layer": "0"},
        )

    result = dxf_to_geojson(_dxf_bytes(build))
    lines = _by_type(result["features"], "LineString")
    assert len(lines) == 1
    assert len(lines[0]["geometry"]["coordinates"]) == 3


def test_closed_lwpolyline_becomes_polygon():
    def build(doc, msp):
        msp.add_lwpolyline(
            [(230000, 790000), (230100, 790000), (230100, 790100), (230000, 790100)],
            close=True,
            dxfattribs={"layer": "0"},
        )

    result = dxf_to_geojson(_dxf_bytes(build))
    polys = _by_type(result["features"], "Polygon")
    assert len(polys) == 1
    ring = polys[0]["geometry"]["coordinates"][0]
    assert len(ring) == 5                # 4 vertices + closing repeat
    assert ring[0] == ring[-1]


def test_circle_becomes_point():
    def build(doc, msp):
        msp.add_circle((230500, 790500, 0), radius=1.0, dxfattribs={"layer": "0"})

    result = dxf_to_geojson(_dxf_bytes(build))
    pts = _by_type(result["features"], "Point")
    assert len(pts) == 1
    assert pts[0]["geometry"]["coordinates"] == pytest.approx([35.305, 32.905], abs=1e-6)


def test_text_and_mtext_become_points_with_text_property():
    def build(doc, msp):
        msp.add_text("בדיקה", dxfattribs={"layer": "0", "insert": (230600, 790600, 0), "height": 1.0})
        msp.add_mtext("טקסט רב-שורות", dxfattribs={"layer": "0", "insert": (230700, 790700, 0)})

    result = dxf_to_geojson(_dxf_bytes(build))
    pts = _by_type(result["features"], "Point")
    texts = {f["properties"]["Text"] for f in pts}
    assert texts == {"בדיקה", "טקסט רב-שורות"}


def test_block_insert_with_attribs_becomes_point_with_hebrew_tag_props():
    def build(doc, msp):
        blk = doc.blocks.new(name="שוחת-ביוב")
        blk.add_circle((0, 0), radius=0.65)
        blk.add_attdef(tag="TL", insert=(3, 3), height=1.35, dxfattribs={"flags": 0})
        blk.add_attdef(tag="שם", insert=(3, -3), height=1.35, dxfattribs={"flags": 0})
        ref = msp.add_blockref("שוחת-ביוב", (230800, 790800, 0), dxfattribs={"layer": "MANHOLES"})
        ref.add_auto_attribs({"TL": "TL=105.00", "שם": "שוחה-1"})

    result = dxf_to_geojson(_dxf_bytes(build))
    pts = _by_type(result["features"], "Point")
    assert len(pts) == 1
    props = pts[0]["properties"]
    assert props["Block"] == "שוחת-ביוב"
    assert props["TL"] == "TL=105.00"
    assert props["שם"] == "שוחה-1"
    assert props["Layer"] == "MANHOLES"
    assert pts[0]["geometry"]["coordinates"] == pytest.approx([35.308, 32.908], abs=1e-6)


# ── layer / color attribute preservation ────────────────────────────────────

def test_layer_and_bylayer_color_are_preserved():
    def build(doc, msp):
        doc.layers.new("WATER", dxfattribs={"color": 5})
        msp.add_line((230000, 790000, 0), (230010, 790010, 0), dxfattribs={"layer": "WATER"})
        # explicit (not BYLAYER) color overrides the layer's color
        msp.add_line((230020, 790020, 0), (230030, 790030, 0),
                     dxfattribs={"layer": "WATER", "color": 3})

    result = dxf_to_geojson(_dxf_bytes(build))
    lines = _by_type(result["features"], "LineString")
    assert len(lines) == 2
    by_color = sorted(f["properties"]["Color"] for f in lines)
    assert by_color == [3, 5]
    assert all(f["properties"]["Layer"] == "WATER" for f in lines)


# ── CRS + sign auto-detect ───────────────────────────────────────────────────

def test_detects_epsg_2039_itm():
    def build(doc, msp):
        msp.add_circle((230000, 790000, 0), radius=0.5, dxfattribs={"layer": "0"})

    result = dxf_to_geojson(_dxf_bytes(build), source_crs="EPSG:2039")
    assert result["_meta"]["source_crs_detected"] == "EPSG:2039"
    assert result["_meta"]["sign"] == [1, 1]
    assert result["features"][0]["geometry"]["coordinates"] == pytest.approx([35.3, 32.9], abs=1e-6)


def test_detects_epsg_28193_old_israeli_cs_grid():
    def build(doc, msp):
        msp.add_circle((5_230_000, 790_000, 0), radius=0.5, dxfattribs={"layer": "0"})

    result = dxf_to_geojson(_dxf_bytes(build))
    assert result["_meta"]["source_crs_detected"] == "EPSG:28193"
    assert result["_meta"]["sign"] == [1, 1]


def test_detects_epsg_28191_palestine_grid():
    def build(doc, msp):
        msp.add_circle((230_000, 5_790_000, 0), radius=0.5, dxfattribs={"layer": "0"})

    result = dxf_to_geojson(_dxf_bytes(build))
    assert result["_meta"]["source_crs_detected"] == "EPSG:28191"
    assert result["_meta"]["sign"] == [1, 1]


def test_detects_epsg_6991_israeli_grid_05_12():
    def build(doc, msp):
        msp.add_circle((5_230_000, 5_790_000, 0), radius=0.5, dxfattribs={"layer": "0"})

    result = dxf_to_geojson(_dxf_bytes(build))
    assert result["_meta"]["source_crs_detected"] == "EPSG:6991"
    assert result["_meta"]["sign"] == [1, 1]


def test_detects_flipped_sign_both_axes():
    # Mirrors the real-world case from the module docstring: PLAN-KLALI.dwg
    # stores ITM with both X and Y negated.
    def build(doc, msp):
        msp.add_circle((-230000, -790000, 0), radius=0.5, dxfattribs={"layer": "0"})

    result = dxf_to_geojson(_dxf_bytes(build))
    assert result["_meta"]["source_crs_detected"] == "EPSG:2039"
    assert result["_meta"]["sign"] == [-1, -1]
    assert result["features"][0]["geometry"]["coordinates"] == pytest.approx([35.3, 32.9], abs=1e-6)


def test_detects_flipped_sign_x_only():
    def build(doc, msp):
        msp.add_circle((-230000, 790000, 0), radius=0.5, dxfattribs={"layer": "0"})

    result = dxf_to_geojson(_dxf_bytes(build))
    assert result["_meta"]["source_crs_detected"] == "EPSG:2039"
    assert result["_meta"]["sign"] == [-1, 1]


def test_inconclusive_sample_falls_back_to_caller_supplied_source_crs():
    # A coordinate that lands nowhere near Israel under any candidate CRS x
    # sign combination. Before the fix below, _detect_crs_and_sign silently
    # fell back to a hardcoded EPSG:2039 here, discarding the caller's
    # explicit source_crs. It must now honor the caller's choice instead.
    def build(doc, msp):
        msp.add_circle((0, 0, 0), radius=0.5, dxfattribs={"layer": "0"})

    result = dxf_to_geojson(_dxf_bytes(build), source_crs="EPSG:28191")
    assert result["_meta"]["source_crs_detected"] == "EPSG:28191?"


def test_inconclusive_sample_defaults_to_2039_when_no_source_crs_given():
    def build(doc, msp):
        msp.add_circle((0, 0, 0), radius=0.5, dxfattribs={"layer": "0"})

    result = dxf_to_geojson(_dxf_bytes(build))
    assert result["_meta"]["source_crs_detected"] == "EPSG:2039?"
