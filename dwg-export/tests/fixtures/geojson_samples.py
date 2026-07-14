"""
Reusable GeoJSON feature builders for dxf_builder tests.

Coordinates are WGS84 lon/lat, roughly around the Mei HaGalil service area
(northern Israel). These are plain functions (not module-level constants) so
each test gets a fresh dict — build_dxf mutates `properties` in place while
stamping flow direction (FlowFrom/FlowTo/FlowDir), and shared mutable dicts
would leak state between tests.
"""

# Two manhole locations used by flow_pair(): the connecting pipe's endpoints
# are set to exactly these coordinates so _compute_flow's <=8m snap-to-manhole
# match always succeeds regardless of the active Transformer.
MH_A_COORDS = [35.30000, 32.90000]
MH_B_COORDS = [35.30000 + 0.0005, 32.90000]


def water_pipe_feature():
    """LineString water pipe; diameter is labelled in INCHES per dxf_builder."""
    return {
        "type": "Feature",
        "properties": {
            "_category": "water_pipes",
            "OBJECTID": 101,
            "LineDiamet": 6,
        },
        "geometry": {
            "type": "LineString",
            "coordinates": [[35.31000, 32.91000], [35.31100, 32.91050]],
        },
    }


def sewage_manhole_feature(name, coords, *, object_id, tl, depth, low_il=0, high_il=None, dia=None):
    """Point sewage manhole with TL / IL / H / DIA attrs (GIS field schema
    consumed by dxf_builder._manhole_attrib_values)."""
    props = {
        "_category": "sewage_manholes",
        "OBJECTID": object_id,
        "ManholeNum": name,
        "TL": tl,
        "Depth": depth,
        "LowIL": low_il,
    }
    if high_il is not None:
        props["HighIL"] = high_il
    if dia is not None:
        props["ManholeDia"] = dia
    return {
        "type": "Feature",
        "properties": props,
        "geometry": {"type": "Point", "coordinates": list(coords)},
    }


def sewage_pipe_feature(coords_a, coords_b, *, object_id=202, diam_mm=200):
    """LineString sewage pipe; diameter is labelled in MILLIMETRES."""
    return {
        "type": "Feature",
        "properties": {
            "_category": "sewage_pipes",
            "OBJECTID": object_id,
            "LineDiamet": diam_mm,
        },
        "geometry": {
            "type": "LineString",
            "coordinates": [list(coords_a), list(coords_b)],
        },
    }


def hydrant_feature():
    """Point hydrant with a Hebrew property value (exercises XDATA encoding,
    not the drawn label — see hebrew_text_point_feature for the drawn case)."""
    return {
        "type": "Feature",
        "properties": {
            "_category": "hydrants",
            "OBJECTID": 303,
            "StreetName": "רחוב הרצל",
        },
        "geometry": {"type": "Point", "coordinates": [35.29500, 32.89500]},
    }


def parcel_polygon_feature():
    ring = [
        [35.32000, 32.92000],
        [35.32100, 32.92000],
        [35.32100, 32.92100],
        [35.32000, 32.92100],
        [35.32000, 32.92000],
    ]
    return {
        "type": "Feature",
        "properties": {"_category": "parcels", "OBJECTID": 404, "Gush": "12345"},
        "geometry": {"type": "Polygon", "coordinates": [ring]},
    }


def hebrew_text_point_feature():
    """A plain (non-manhole) point with a `Text` property: build_dxf's Point
    branch draws an add_text() label at the point when props["Text"] is set."""
    return {
        "type": "Feature",
        "properties": {
            "_category": "control_point",
            "OBJECTID": 505,
            "Text": "מד-מים ראשי",
        },
        "geometry": {"type": "Point", "coordinates": [35.28000, 32.88000]},
    }


def flow_pair():
    """Two manholes + a connecting sewage pipe, wired so _compute_flow finds a
    clear upstream -> downstream direction: MH-A's invert (101.50, from a
    genuinely-stored LowIL) is higher than MH-B's (99.00), so flow runs
    A -> B (toward the lower invert)."""
    mh_a = sewage_manhole_feature(
        "MH-A", MH_A_COORDS, object_id=601, tl=105.00, depth=3.50, low_il=101.50, high_il=103.20, dia=200,
    )
    mh_b = sewage_manhole_feature(
        "MH-B", MH_B_COORDS, object_id=602, tl=102.00, depth=3.00, low_il=99.00, dia=200,
    )
    pipe = sewage_pipe_feature(MH_A_COORDS, MH_B_COORDS, object_id=701, diam_mm=250)
    return mh_a, mh_b, pipe
