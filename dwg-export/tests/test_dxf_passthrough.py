"""Tests for the .dxf upload path on /api/convert/dwg-to-geojson.

Covers: a .dxf upload skips the ODA DWG→DXF step entirely (the file is
already DXF — fed straight to dxf_to_geojson), a .dwg upload still goes
through the normal ODA (_dwg_to_dxf) path, and a mismatched upload (.dxf
extension but real "AC10..." DWG binary content) is handled sanely — treated
as a DWG (via ODA), not blindly trusted by extension.

_dwg_to_dxf and dxf_to_geojson are both monkeypatched out (never call real
ODA/ezdxf/pyproj here) — these tests only exercise main.py's routing logic
(which path a given upload takes), mirroring test_limits.py's approach of
stubbing out the heavy conversion internals to test the HTTP layer in
isolation.
"""
import json
import urllib.request

import pytest
from fastapi.testclient import TestClient

import main

AUTH = {"Authorization": "Bearer tok"}
FAKE_GEOJSON = {"type": "FeatureCollection", "features": [
    {"type": "Feature", "properties": {"Layer": "0"}, "geometry": {"type": "Point", "coordinates": [35.3, 32.9]}}
]}


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
    """routes: list of (url_substring, FakeResp | Exception)."""
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
    # main.limiter is a module-level singleton — reset before/after every test
    # so one test's request count can never bleed into another's.
    main.limiter.reset()
    yield
    main.limiter.reset()


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(main, "dxf_to_geojson", lambda dxf_bytes, source_crs="EPSG:2039": FAKE_GEOJSON)
    return TestClient(main.app)


# ── .dxf upload skips ODA entirely ──────────────────────────────────────────

def test_dxf_upload_skips_oda_and_returns_features(client, monkeypatch):
    oda_spy_calls = []
    monkeypatch.setattr(main, "_dwg_to_dxf", lambda dwg_bytes: oda_spy_calls.append(dwg_bytes) or b"SHOULD-NOT-BE-CALLED")

    dxf_text = b"0\r\nSECTION\r\n2\r\nHEADER\r\n0\r\nENDSEC\r\n0\r\nEOF\r\n"
    r = client.post(
        "/api/convert/dwg-to-geojson",
        files={"file": ("plan.dxf", dxf_text, "application/dxf")},
        headers=AUTH,
    )
    assert r.status_code == 200
    assert r.json() == FAKE_GEOJSON
    assert oda_spy_calls == []  # _dwg_to_dxf (the ODA step) was never invoked


def test_dxf_upload_is_case_insensitive_on_extension(client, monkeypatch):
    monkeypatch.setattr(main, "_dwg_to_dxf", lambda dwg_bytes: (_ for _ in ()).throw(AssertionError("ODA should be skipped")))
    r = client.post(
        "/api/convert/dwg-to-geojson",
        files={"file": ("PLAN.DXF", b"0\r\nSECTION\r\n", "application/dxf")},
        headers=AUTH,
    )
    assert r.status_code == 200


# ── .dwg upload still goes through ODA ──────────────────────────────────────

def test_dwg_upload_still_goes_through_oda(client, monkeypatch):
    oda_calls = []

    def fake_dwg_to_dxf(dwg_bytes):
        oda_calls.append(dwg_bytes)
        return b"0\r\nSECTION\r\n0\r\nEOF\r\n"

    monkeypatch.setattr(main, "_dwg_to_dxf", fake_dwg_to_dxf)
    dwg_bytes = b"AC1027" + b"\x00" * 20

    r = client.post(
        "/api/convert/dwg-to-geojson",
        files={"file": ("plan.dwg", dwg_bytes, "application/octet-stream")},
        headers=AUTH,
    )
    assert r.status_code == 200
    assert r.json() == FAKE_GEOJSON
    assert oda_calls == [dwg_bytes]  # ODA WAS invoked, with the raw DWG bytes


def test_dwg_upload_422s_when_oda_unavailable(client, monkeypatch):
    # Conversion failure is a caller-actionable condition now (W3.4 hotfix):
    # 422 with a bilingual detail steering the user to upload DXF directly
    # (was a bare 500 before the ODA OOM/loop-freeze incident fix).
    monkeypatch.setattr(main, "_dwg_to_dxf", lambda dwg_bytes: None)
    r = client.post(
        "/api/convert/dwg-to-geojson",
        files={"file": ("plan.dwg", b"AC1027" + b"\x00" * 10, "application/octet-stream")},
        headers=AUTH,
    )
    assert r.status_code == 422
    assert "DXF" in r.json()["detail"]


# ── mismatched content: .dxf extension but real DWG ("AC10...") bytes ──────

def test_dxf_extension_with_real_dwg_content_is_routed_through_oda_not_trusted_by_extension(client, monkeypatch):
    oda_calls = []

    def fake_dwg_to_dxf(dwg_bytes):
        oda_calls.append(dwg_bytes)
        return b"0\r\nSECTION\r\n0\r\nEOF\r\n"

    monkeypatch.setattr(main, "_dwg_to_dxf", fake_dwg_to_dxf)
    mismatched_bytes = b"AC1032" + b"\x00" * 20  # real DWG binary signature

    r = client.post(
        "/api/convert/dwg-to-geojson",
        files={"file": ("mislabeled.dxf", mismatched_bytes, "application/octet-stream")},
        headers=AUTH,
    )
    assert r.status_code == 200
    # Routed through ODA (content sniff won), NOT fed raw to dxf_to_geojson.
    assert oda_calls == [mismatched_bytes]


def test_looks_like_dwg_helper():
    assert main._looks_like_dwg(b"AC1027" + b"\x00" * 10) is True
    assert main._looks_like_dwg(b"0\r\nSECTION\r\n") is False
    assert main._looks_like_dwg(b"") is False
    assert main._looks_like_dwg(b"AC1") is False  # too short to match the 4-byte signature


# ── auth / rate limiting still apply to the .dxf path (regression coverage) ─

def test_dxf_upload_requires_auth(client):
    r = client.post(
        "/api/convert/dwg-to-geojson",
        files={"file": ("plan.dxf", b"0\r\nSECTION\r\n", "application/dxf")},
    )
    assert r.status_code == 401


def test_dxf_upload_is_rate_limited(client, monkeypatch):
    monkeypatch.setattr(main, "_dwg_to_dxf", lambda dwg_bytes: (_ for _ in ()).throw(AssertionError("ODA should be skipped")))
    statuses = []
    for _ in range(11):
        r = client.post(
            "/api/convert/dwg-to-geojson",
            files={"file": ("plan.dxf", b"0\r\nSECTION\r\n", "application/dxf")},
            headers=AUTH,
        )
        statuses.append(r.status_code)
    assert 429 in statuses
