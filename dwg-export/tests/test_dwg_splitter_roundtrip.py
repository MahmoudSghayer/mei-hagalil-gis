"""
Round-trip: split parts import back through dxf_to_geojson with a stable id.

Covers both the new dxf_to_geojson MGIS/XDATA read and the end-to-end path a
split part takes on upload. Uses fake_transformer so coordinates are exact and
environment-independent.
"""

import ezdxf

from dwg_splitter.manifest import build_manifest
from dwg_splitter.service import split_bytes
from dwg_splitter.splitter import split_drawing
from tests.fixtures.dxf_samples import drawing_bytes, multilayer_drawing

from dxf_to_geojson import dxf_to_geojson


# Israel WGS84 bounding box (matches dxf_to_geojson._ISR_LON/_ISR_LAT).
_LON = (33.8, 36.2)
_LAT = (29.2, 33.6)


def _in_israel(lon, lat):
    return _LON[0] <= lon <= _LON[1] and _LAT[0] <= lat <= _LAT[1]


def _first_xy(geom):
    """Walk any GeoJSON geometry down to its first [x, y]."""
    c = geom["coordinates"]
    while isinstance(c, list) and c and isinstance(c[0], list):
        c = c[0]
    return c[0], c[1]


def test_dxf_to_geojson_reads_gisid_and_attributes(fake_transformer):
    doc = ezdxf.new("R2018")
    doc.appids.new("MGIS")
    doc.layers.new("pipes", dxfattribs={"color": 5})
    msp = doc.modelspace()
    c = msp.add_circle((200_000, 740_000), radius=1, dxfattribs={"layer": "pipes"})
    c.set_xdata("MGIS", [(1000, "GISID=ABC123"), (1000, "Diameter=8")])

    gj = dxf_to_geojson(drawing_bytes(doc), source_crs="EPSG:2039")
    assert len(gj["features"]) == 1
    props = gj["features"][0]["properties"]
    assert props["EntityHand"] == "ABC123"   # GISID -> asset_code source
    assert props["Diameter"] == "8"          # arbitrary MGIS attr round-trips
    assert props["Layer"] == "pipes"


def test_split_parts_import_with_unique_stable_ids(fake_transformer):
    doc = multilayer_drawing()
    n_total = len(list(doc.modelspace()))
    result = split_drawing(doc, stem="city", strategy="hybrid",
                           max_bytes=120_000, use_oda=False)
    assert result.total_parts > 1

    seen_handles = set()
    total_features = 0
    for part in result.parts:
        gj = dxf_to_geojson(part.data, source_crs="EPSG:2039")
        for f in gj["features"]:
            total_features += 1
            lon, lat = _first_xy(f["geometry"])
            assert _in_israel(lon, lat)
            eh = f["properties"].get("EntityHand")
            assert eh, "every split feature must carry a stable id"
            assert eh not in seen_handles, "ids must be unique across parts"
            seen_handles.add(eh)

    # dxf_to_geojson maps LINE/LWPOLYLINE/INSERT — all present here — so every
    # source entity becomes exactly one feature.
    assert total_features == n_total


def test_manhole_block_attributes_survive_split_and_import(fake_transformer):
    doc = multilayer_drawing(n_roads=10, n_buildings=10, n_manholes=20)
    result = split_drawing(doc, stem="city", strategy="layer",
                           max_bytes=50 * 1024 * 1024, use_oda=False)
    pipes = next(p for p in result.parts if "pipes" in p.layers)
    gj = dxf_to_geojson(pipes.data, source_crs="EPSG:2039")
    manholes = [f for f in gj["features"] if f["properties"].get("Block") == "MANHOLE"]
    assert len(manholes) == 20
    assert all("TL" in f["properties"] for f in manholes)


def test_service_split_bytes_builds_manifest(fake_transformer):
    doc = multilayer_drawing()
    data = drawing_bytes(doc)
    result, manifest = split_bytes(
        data, "city.dxf", strategy="hybrid", max_bytes=120_000, use_oda=False,
    )
    assert manifest["total_parts"] == result.total_parts
    assert manifest["source"]["entities"] == len(list(doc.modelspace()))
    assert manifest["output_format"] == "dxf"
    assert manifest["max_part_bytes"] == 120_000
    assert manifest["validation"]["ok"]
    # manifest parts carry the metadata the API/GET endpoint will surface
    for p in manifest["parts"]:
        assert p["filename"] and p["size_bytes"] <= 120_000
        assert "bounds" in p and "layers" in p
