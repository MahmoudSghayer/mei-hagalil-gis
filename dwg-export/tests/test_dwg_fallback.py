"""
Regression coverage for the DWG->DXF fallback headers on /api/export/dwg.

main.py skips the OOM-prone ODA DWG conversion (and falls back to returning a
DXF) in two situations:
  1. the export is above MAX_DWG_FEATURES ("too_large")
  2. ODA File Converter isn't available / conversion failed ("oda_unavailable")
Either way the response must carry X-Fallback-Format: dxf and an
X-Fallback-Reason header so the frontend can tell the user (js/backend-client.js
reads exactly these two headers in geoJSONtoDWG()). This was not covered by
tests/test_limits.py (which only exercises /api/export/dxf and the rate
limiter), so it's added here.

Follows the same auth-mocking / rate-limiter-reset pattern as
tests/test_limits.py and tests/test_auth.py; _build_dxf_bytes is monkeypatched
out (pyproj/ezdxf DXF building is covered separately by test_dxf_builder.py),
so these tests only exercise the HTTP/branching layer of export_dwg().
"""
import json
import urllib.request

import pytest
from fastapi.testclient import TestClient

import main

FEATURE = {"type": "Feature", "properties": {}, "geometry": {"type": "Point", "coordinates": [35.3, 32.9]}}
AUTH = {"Authorization": "Bearer tok"}


class FakeResp:
    def __init__(self, status=200, payload=None):
        self.status = status
        self._payload = payload if payload is not None else {}

    def read(self):
        return json.dumps(self._payload).encode()

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def make_urlopen(routes):
    def _urlopen(req, timeout=8):
        url = req.full_url if hasattr(req, "full_url") else str(req)
        for sub, resp in routes:
            if sub in url:
                if isinstance(resp, Exception):
                    raise resp
                return resp
        raise AssertionError(f"unrouted urlopen: {url}")
    return _urlopen


def _routes_for(role):
    return [
        ("/auth/v1/user", FakeResp(200, {"id": "u1"})),
        ("/rest/v1/profiles", FakeResp(200, [{"role": role, "is_active": True}])),
    ]


@pytest.fixture(autouse=True)
def cfg(monkeypatch):
    monkeypatch.setattr(main, "SUPABASE_URL", "https://test.supabase.co")
    monkeypatch.setattr(main, "SUPABASE_APIKEY", "anon-key")
    monkeypatch.setattr(urllib.request, "urlopen", make_urlopen(_routes_for("admin")))
    monkeypatch.setattr(main, "_build_dxf_bytes", lambda features: b"FAKE-DXF-BYTES")
    main.limiter.reset()
    yield
    main.limiter.reset()


@pytest.fixture
def client():
    return TestClient(main.app)


def test_over_max_dwg_features_falls_back_to_dxf_with_too_large_reason(client, monkeypatch):
    monkeypatch.setattr(main, "MAX_DWG_FEATURES", 2)
    # _dxf_to_dwg must not even be attempted once the feature count is over
    # the cap -- assert that by making it blow up if called.
    monkeypatch.setattr(main, "_dxf_to_dwg", lambda dxf_bytes: (_ for _ in ()).throw(
        AssertionError("_dxf_to_dwg should be skipped when too_large")))

    features = [FEATURE, FEATURE, FEATURE]   # 3 > MAX_DWG_FEATURES(2)
    r = client.post("/api/export/dwg", json={"features": features}, headers=AUTH)

    assert r.status_code == 200
    assert r.headers.get("x-fallback-format") == "dxf"
    assert r.headers.get("x-fallback-reason") == "too_large"
    assert r.headers.get("content-type") == "application/dxf"
    assert ".dxf" in r.headers.get("content-disposition", "")
    assert r.content == b"FAKE-DXF-BYTES"


def test_oda_unavailable_falls_back_to_dxf_with_oda_unavailable_reason(client, monkeypatch):
    # Under the cap, but ODA conversion itself fails/unavailable.
    monkeypatch.setattr(main, "_dxf_to_dwg", lambda dxf_bytes: None)

    r = client.post("/api/export/dwg", json={"features": [FEATURE]}, headers=AUTH)

    assert r.status_code == 200
    assert r.headers.get("x-fallback-format") == "dxf"
    assert r.headers.get("x-fallback-reason") == "oda_unavailable"
    assert r.content == b"FAKE-DXF-BYTES"


def test_successful_dwg_conversion_has_no_fallback_headers(client, monkeypatch):
    monkeypatch.setattr(main, "_dxf_to_dwg", lambda dxf_bytes: b"FAKE-DWG-BYTES")

    r = client.post("/api/export/dwg", json={"features": [FEATURE]}, headers=AUTH)

    assert r.status_code == 200
    assert r.headers.get("x-fallback-format") is None
    assert r.headers.get("x-fallback-reason") is None
    assert r.headers.get("content-type") == "application/octet-stream"
    assert ".dwg" in r.headers.get("content-disposition", "")
    assert r.content == b"FAKE-DWG-BYTES"
