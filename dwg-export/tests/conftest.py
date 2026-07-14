"""
Shared fixtures for the DWG export service's pytest suite.

`fake_transformer` patches `dxf_builder.Transformer` / `dxf_to_geojson.Transformer`
with a small, exactly-assertable affine (`FakeTransformer` below) instead of
whichever `pyproj` happens to be installed — the real compiled PROJ library
in CI (`pip install -r requirements.txt`, Python 3.11), or the offline
arithmetic stand-in used on dev machines that cannot build pyproj (see the
stub package's own docstring). Real PROJ performs a genuine Transverse
Mercator (ITM) / Cassini-Soldner (old Israeli grids) projection, not an
affine map, so hard-coding its exact numeric output would make coordinate
assertions either wrong or environment-specific. By injecting our own
Transformer for the duration of a test, every coordinate assertion in
test_dxf_builder.py / test_dxf_to_geojson.py is exact and IDENTICAL whether
pytest runs against the offline stub here or a real pyproj in CI — CI's
`pytest -q` step is still the one that (via `pip install -r
requirements.txt`) exercises the real projection library at import time for
every other test in the suite.
"""
import pytest


class FakeTransformer:
    """A deterministic affine per (from_crs, to_crs) pair, standing in for
    pyproj.Transformer.

    Offsets per candidate CRS are spaced 5,000,000 units apart on at least
    one axis, so a coordinate crafted to land "inside Israel" for one CRS
    can never accidentally also land inside Israel for another candidate —
    this is what lets tests unambiguously select a single CRS branch in
    dxf_to_geojson._detect_crs_and_sign (see _ISR_LON/_ISR_LAT there: a
    +-5,000,000 shift moves any candidate's window ~50 degrees away, far
    outside Israel's ~2.4x4.4 degree bounding box).
    """

    SCALE = 100_000.0
    LON0, LAT0 = 35.0, 32.0
    OFFSETS = {
        "EPSG:2039":  (200_000.0,   700_000.0),
        "EPSG:28193": (5_200_000.0, 700_000.0),
        "EPSG:28191": (200_000.0,   5_700_000.0),
        "EPSG:6991":  (5_200_000.0, 5_700_000.0),
    }

    def __init__(self, crs_from, crs_to, always_xy=True):
        self.crs_from = str(crs_from).upper()
        self.crs_to = str(crs_to).upper()
        self.always_xy = always_xy

    @classmethod
    def from_crs(cls, crs_from, crs_to, always_xy=True):
        return cls(crs_from, crs_to, always_xy=always_xy)

    def transform(self, x, y, *args, **kwargs):
        if self.crs_from == "EPSG:4326":
            ox, oy = self.OFFSETS[self.crs_to]
            return (x - self.LON0) * self.SCALE + ox, (y - self.LAT0) * self.SCALE + oy
        if self.crs_to == "EPSG:4326":
            ox, oy = self.OFFSETS[self.crs_from]
            return (x - ox) / self.SCALE + self.LON0, (y - oy) / self.SCALE + self.LAT0
        raise NotImplementedError(
            f"FakeTransformer: unsupported CRS pair {self.crs_from} -> {self.crs_to}"
        )


@pytest.fixture
def fake_transformer(monkeypatch):
    """Patch both modules' `Transformer` symbol with FakeTransformer and
    return the class so tests can compute expected values by hand."""
    import dxf_builder
    import dxf_to_geojson
    monkeypatch.setattr(dxf_builder, "Transformer", FakeTransformer)
    monkeypatch.setattr(dxf_to_geojson, "Transformer", FakeTransformer)
    return FakeTransformer
