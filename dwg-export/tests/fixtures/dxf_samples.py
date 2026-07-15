"""
Deterministic synthetic DXF drawings for the dwg_splitter tests.

No randomness — coordinates are laid out on a grid in the ITM (EPSG:2039) range
around Israel so the CRS auto-detector and the spatial tiler both have realistic
input, and every run produces byte-identical files.
"""

from __future__ import annotations

import os
import tempfile

import ezdxf

# ITM origin the grid is laid out from (genuine Israel Transverse Mercator).
_X0, _Y0 = 200_000.0, 740_000.0
_STEP = 12.0  # metres between grid cells


def _grid_xy(i: int, cols: int = 100) -> tuple[float, float]:
    return (_X0 + (i % cols) * _STEP, _Y0 + (i // cols) * _STEP)


def multilayer_drawing(
    n_roads: int = 200,
    n_buildings: int = 150,
    n_manholes: int = 100,
) -> "ezdxf.document.Drawing":
    """A 3-layer drawing: LINE roads, closed LWPOLYLINE buildings, and INSERTs of
    a named MANHOLE block (with a TL attribute) on the pipes layer."""
    doc = ezdxf.new("R2018")
    doc.header["$INSUNITS"] = 6  # metres
    for layer, color in (("roads", 1), ("buildings", 3), ("pipes", 5)):
        doc.layers.new(layer, dxfattribs={"color": color})

    blk = doc.blocks.new("MANHOLE")
    blk.add_circle((0, 0), radius=0.65)
    blk.add_attdef(tag="TL", insert=(1, 1), height=1.0)

    msp = doc.modelspace()
    for i in range(n_roads):
        x, y = _grid_xy(i)
        msp.add_line((x, y), (x + 6, y + 6), dxfattribs={"layer": "roads"})
    for i in range(n_buildings):
        x, y = _grid_xy(i)
        msp.add_lwpolyline(
            [(x, y), (x + 8, y), (x + 8, y + 8), (x, y + 8)],
            close=True,
            dxfattribs={"layer": "buildings"},
        )
    for i in range(n_manholes):
        x, y = _grid_xy(i)
        ref = msp.add_blockref("MANHOLE", (x, y), dxfattribs={"layer": "pipes"})
        ref.add_auto_attribs({"TL": f"{250 + (i % 30)}.5"})
    return doc


def single_layer_drawing(n: int = 400) -> "ezdxf.document.Drawing":
    """One dense layer of circles — the case that only a spatial tiler can split."""
    doc = ezdxf.new("R2018")
    doc.header["$INSUNITS"] = 6
    doc.layers.new("dense", dxfattribs={"color": 2})
    msp = doc.modelspace()
    for i in range(n):
        x, y = _grid_xy(i)
        msp.add_circle((x, y), radius=0.5, dxfattribs={"layer": "dense"})
    return doc


def drawing_bytes(doc) -> bytes:
    with tempfile.NamedTemporaryFile(suffix=".dxf", delete=False) as tf:
        path = tf.name
    try:
        doc.saveas(path)
        with open(path, "rb") as fh:
            return fh.read()
    finally:
        os.unlink(path)
