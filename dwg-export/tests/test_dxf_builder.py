"""
Tests for dxf_builder.build_dxf() — GeoJSON features -> ezdxf Drawing.

Feeds representative feature sets (water pipe, sewage manhole, hydrant,
parcel polygon, Hebrew text) through build_dxf() and inspects the resulting
ezdxf entities directly (and via a real save/reload round trip for the
encoding checks), rather than asserting on imagined behaviour — see
dxf_builder.py for what each branch actually draws.

All coordinate math here goes through the `fake_transformer` fixture
(tests/conftest.py), which replaces pyproj.Transformer with an exactly
computable affine — see that fixture's docstring for why. CI's `pytest -q`
(real `pyproj` from requirements.txt on Python 3.11) still imports and
exercises the real projection at module load / everywhere else in the
service; only the coordinate *values* asserted here are computed against
the fake affine, not real PROJ math.
"""
import math
import os
import tempfile

import ezdxf
import pytest

import dxf_builder
from dxf_builder import MANHOLE_BLOCK, POINT_RADIUS, build_dxf

from fixtures.geojson_samples import (
    flow_pair,
    hebrew_text_point_feature,
    hydrant_feature,
    parcel_polygon_feature,
    sewage_manhole_feature,
    sewage_pipe_feature,
    water_pipe_feature,
    MH_A_COORDS,
    MH_B_COORDS,
)

pytestmark = pytest.mark.usefixtures("fake_transformer")


def _itm(lon, lat, fake_transformer):
    """Expected ITM coords for a WGS84 point under FakeTransformer's affine."""
    ox, oy = fake_transformer.OFFSETS["EPSG:2039"]
    return (
        (lon - fake_transformer.LON0) * fake_transformer.SCALE + ox,
        (lat - fake_transformer.LAT0) * fake_transformer.SCALE + oy,
    )


def _inserts(doc):
    return [e for e in doc.modelspace() if e.dxftype() == "INSERT"]


def _xdata_dict(entity):
    """MGIS XDATA tags as a {key: value} dict, or {} if none attached."""
    try:
        tags = entity.get_xdata("MGIS")
    except ezdxf.DXFValueError:
        return {}
    out = {}
    for tag in tags:
        if tag.code != 1000:
            continue
        k, _, v = tag.value.partition("=")
        out[k] = v
    return out


def _manhole_insert_by_num(doc, manhole_num):
    for ins in _inserts(doc):
        if _xdata_dict(ins).get("ManholeNum") == manhole_num:
            return ins
    raise AssertionError(f"no manhole INSERT found with ManholeNum={manhole_num!r}")


def _attrib_texts(insert):
    return {att.dxf.tag: att.dxf.text for att in insert.attribs}


# ── layers ───────────────────────────────────────────────────────────────────

def test_layers_created_per_category():
    features = [
        water_pipe_feature(),
        hydrant_feature(),
        parcel_polygon_feature(),
        *flow_pair(),
    ]
    doc = build_dxf(features)
    layer_names = {l.dxf.name for l in doc.layers}
    for expected in ("water_pipes", "hydrants", "parcels", "sewage_manholes",
                      "sewage_pipes", "ATTR", "FLOW"):
        assert expected in layer_names, f"missing layer {expected!r}: have {layer_names}"


# ── manhole block ────────────────────────────────────────────────────────────

def test_manhole_block_insert_has_visible_attribs():
    mh_a, mh_b, pipe = flow_pair()
    doc = build_dxf([mh_a, mh_b, pipe])

    assert MANHOLE_BLOCK in doc.blocks

    ins = _manhole_insert_by_num(doc, "MH-A")
    assert ins.dxf.name == MANHOLE_BLOCK

    texts = _attrib_texts(ins)
    assert texts["TL"] == "TL=105.00"
    assert texts["IL1"] == "IL1=103.20"
    assert texts["IL2"] == "IL2=101.50"     # genuinely-stored LowIL, not derived
    assert texts["H"] == "H=3.50"
    assert texts["DIA"] == "200"

    # All five rows must be visible (flags == 0 == not-invisible), since the
    # customer reads levels directly off the block (CEO requirement).
    for att in ins.attribs:
        assert att.dxf.flags == 0
        assert att.is_invisible is False
    assert {a.dxf.tag for a in ins.attribs} == {"TL", "IL1", "IL2", "H", "DIA"}


def test_manhole_il2_derived_from_tl_minus_depth_when_lowil_is_placeholder_zero():
    # CEO fix: LowIL==0 is a data-entry placeholder, not a real invert of 0 —
    # IL2 must be derived as TL - Depth instead of showing "0.00".
    mh_c = sewage_manhole_feature(
        "MH-C", [35.305, 32.905], object_id=603, tl=110.0, depth=4.25, low_il=0, dia=100,
    )
    doc = build_dxf([mh_c])
    ins = _manhole_insert_by_num(doc, "MH-C")
    texts = _attrib_texts(ins)
    assert texts["IL2"] == "IL2=105.75"     # 110.0 - 4.25
    assert texts["IL1"] == "IL1="           # HighIL absent -> blank, not "0"
    assert texts["DIA"] == "100"


# ── pipe diameter labels ────────────────────────────────────────────────────

def test_water_pipe_diameter_label_is_in_inches():
    doc = build_dxf([water_pipe_feature()])
    texts = [e.dxf.text for e in doc.modelspace()
             if e.dxftype() == "TEXT" and e.dxf.layer == "ATTR"]
    assert any(t == 'Ø6"' for t in texts), texts


def test_sewage_pipe_diameter_label_is_in_millimetres():
    mh_a, mh_b, pipe = flow_pair()   # pipe has LineDiamet=250 (mm)
    doc = build_dxf([mh_a, mh_b, pipe])
    texts = [e.dxf.text for e in doc.modelspace()
             if e.dxftype() == "TEXT" and e.dxf.layer == "ATTR"]
    assert any(t == "Ø250mm" for t in texts), texts


# ── point -> circle, ITM coordinates ────────────────────────────────────────

def test_hydrant_point_is_a_circle_at_correct_itm_coords(fake_transformer):
    doc = build_dxf([hydrant_feature()])
    circles = [e for e in doc.modelspace()
               if e.dxftype() == "CIRCLE" and e.dxf.layer == "hydrants"]
    assert len(circles) == 1
    c = circles[0]
    assert c.dxf.radius == POINT_RADIUS
    ex, ey = _itm(35.29500, 32.89500, fake_transformer)
    assert c.dxf.center.x == pytest.approx(ex)
    assert c.dxf.center.y == pytest.approx(ey)
    # Sanity: within the FakeTransformer's synthetic-but-ITM-scale range —
    # real ITM (EPSG:2039) coordinates for Israel are roughly X in
    # [100_000, 300_000], Y in [350_000, 800_000].
    assert 100_000 < ex < 300_000
    assert 350_000 < ey < 900_000


# ── polygon ──────────────────────────────────────────────────────────────────

def test_parcel_polygon_is_a_closed_lwpolyline():
    doc = build_dxf([parcel_polygon_feature()])
    polys = [e for e in doc.modelspace()
             if e.dxftype() == "LWPOLYLINE" and e.dxf.layer == "parcels"]
    assert len(polys) == 1
    assert polys[0].closed is True
    assert len(polys[0]) == 5   # ring as supplied, incl. closing vertex


# ── flow direction ───────────────────────────────────────────────────────────

def test_flow_arrow_and_xdata_for_sewer_pipe_with_invert_data(fake_transformer):
    mh_a, mh_b, pipe = flow_pair()
    doc = build_dxf([mh_a, mh_b, pipe])

    # An arrowhead must be drawn on the FLOW layer at the downstream manhole.
    arrows = [e for e in doc.modelspace()
              if e.dxftype() == "LWPOLYLINE" and e.dxf.layer == "FLOW"]
    assert len(arrows) == 1
    ex, ey = _itm(MH_B_COORDS[0], MH_B_COORDS[1], fake_transformer)
    arrow_pts = list(arrows[0].vertices())
    tip = arrow_pts[1]   # (p_l, p_tip, p_r) -> tip is the middle vertex
    assert tip[0] == pytest.approx(ex, abs=1e-6)
    assert tip[1] == pytest.approx(ey, abs=1e-6)

    # The pipe itself (not the arrow) carries FlowFrom/FlowTo/FlowDir as XDATA.
    pipe_lines = [e for e in doc.modelspace()
                  if e.dxftype() == "LWPOLYLINE" and e.dxf.layer == "sewage_pipes"]
    assert len(pipe_lines) == 1
    xd = _xdata_dict(pipe_lines[0])
    assert xd["FlowFrom"] == "MH-A"     # higher invert (101.50) -> upstream
    assert xd["FlowTo"] == "MH-B"       # lower invert (99.00) -> downstream
    assert xd["FlowDir"] == "downstream"


def test_no_flow_arrow_without_a_connected_pipe():
    mh_a, mh_b, _pipe = flow_pair()
    doc = build_dxf([mh_a, mh_b])   # manholes only, no connecting pipe
    arrows = [e for e in doc.modelspace()
              if e.dxftype() == "LWPOLYLINE" and e.dxf.layer == "FLOW"]
    assert arrows == []


# ── Hebrew text / encoding ──────────────────────────────────────────────────

def test_hebrew_text_and_xdata_survive_a_real_save_reload_round_trip():
    features = [hebrew_text_point_feature(), hydrant_feature()]
    doc = build_dxf(features)

    with tempfile.NamedTemporaryFile(suffix=".dxf", delete=False) as tf:
        path = tf.name
    try:
        doc.saveas(path)
        reloaded = ezdxf.readfile(path)
        msp = reloaded.modelspace()

        texts = [e.dxf.text for e in msp if e.dxftype() == "TEXT"]
        assert "מד-מים ראשי" in texts

        circles = [e for e in msp
                   if e.dxftype() == "CIRCLE" and e.dxf.layer == "hydrants"]
        assert len(circles) == 1
        xd = _xdata_dict(circles[0])
        assert xd["StreetName"] == "רחוב הרצל"
    finally:
        os.unlink(path)


# ── deduplication (bonus coverage: cheap, pure-python, no I/O) ─────────────

def test_duplicate_features_by_objectid_are_collapsed():
    f1 = hydrant_feature()
    f2 = hydrant_feature()   # identical _category + OBJECTID -> same dedup key
    doc = build_dxf([f1, f2])
    circles = [e for e in doc.modelspace()
               if e.dxftype() == "CIRCLE" and e.dxf.layer == "hydrants"]
    assert len(circles) == 1
