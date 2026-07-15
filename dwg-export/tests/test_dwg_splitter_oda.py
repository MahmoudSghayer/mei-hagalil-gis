"""
Real-DWG round-trip tests — exercise the actual ODA File Converter path.

Skipped automatically where ODA is not installed (Windows dev machines), and run
in CI / the Docker image where the ODA .deb is present. These are the tests that
prove the produced parts are genuine DWG files that re-open, not just DXF.
"""

import pytest

from dwg_splitter import oda
from dwg_splitter.analyzer import analyze
from dwg_splitter.loader import load_drawing_bytes
from dwg_splitter.splitter import doc_to_dxf_bytes, split_drawing
from dwg_splitter.validate import validate_split
from tests.fixtures.dxf_samples import drawing_bytes, multilayer_drawing

pytestmark = pytest.mark.skipif(
    not oda.oda_available(), reason="ODA File Converter not installed"
)


def test_split_emits_real_dwg_parts_that_reopen():
    doc = multilayer_drawing()
    budget = max(40_000, len(doc_to_dxf_bytes(doc)) // 4)
    result = split_drawing(doc, stem="city", strategy="hybrid",
                           max_bytes=budget, use_oda=True)

    assert result.oda_used is True
    assert result.total_parts > 1
    assert all(p.ext == "dwg" for p in result.parts)
    assert all(p.size <= budget for p in result.parts)

    report = validate_split(doc, result)  # reopens each DWG via ODA
    assert report["ok"], report


def test_dwg_input_loads_and_analyzes():
    # Produce a real DWG from a DXF, then read it back as the splitter would.
    dxf_bytes = drawing_bytes(multilayer_drawing(n_roads=30, n_buildings=20,
                                                 n_manholes=10))
    dwg_bytes = oda.dxf_to_dwg(dxf_bytes)
    assert dwg_bytes, "ODA should convert DXF->DWG"
    assert dwg_bytes[:4] == b"AC10"  # DWG version stamp

    doc = load_drawing_bytes(dwg_bytes, "city.dwg")
    a = analyze(doc, filename="city.dwg", size_bytes=len(dwg_bytes))
    assert a["entities"] == 60
    assert set(a["layer_names"]) == {"roads", "buildings", "pipes"}
    assert "MANHOLE" in a["blocks"]
