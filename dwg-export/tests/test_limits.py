"""
Rate limiting + input-bound tests for the DWG export service.

Covers: per-IP rate limiting on the export/convert endpoints (429 once the
per-minute cap is hit, /health exempt), the Pydantic bounds on ExportRequest
(features item count, filename length/sanitization), and the existing
request-body-size guard (413).

_build_dxf_bytes is monkeypatched out in these tests: real DXF building goes
through pyproj (a compiled PROJ binary not available in every dev/CI
environment — see conftest.py / CLAUDE.md), and these tests only exercise the
HTTP layer (rate limit / validation / filename handling), not DXF content.
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
    # The rate limiter's storage is a module-level singleton (main.limiter) —
    # reset it before AND after every test so one test's request count can
    # never bleed into another's (tests run in the same process).
    main.limiter.reset()
    yield
    main.limiter.reset()


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(main, "_build_dxf_bytes", lambda features: b"FAKE-DXF-BYTES")
    return TestClient(main.app)


# ── rate limiting ────────────────────────────────────────────────────────────

def test_rate_limit_429_after_10_per_minute(client):
    statuses = [
        client.post("/api/export/dxf", json={"features": [FEATURE]}, headers=AUTH).status_code
        for _ in range(11)
    ]
    assert statuses[:10] == [200] * 10
    assert statuses[10] == 429


def test_health_is_exempt_from_rate_limit(client):
    # /health needs no auth and must never be throttled (liveness probe).
    for _ in range(15):
        assert client.get("/health").status_code == 200


def test_convert_endpoint_is_also_rate_limited(client, monkeypatch):
    monkeypatch.setattr(main, "_dwg_to_dxf", lambda dwg_bytes: None)  # short-circuit before ODA
    statuses = []
    for _ in range(11):
        r = client.post(
            "/api/convert/dwg-to-dxf",
            files={"file": ("x.dwg", b"not-a-real-dwg", "application/octet-stream")},
            headers=AUTH,
        )
        statuses.append(r.status_code)
    assert 429 in statuses


# ── ExportRequest.features bound (max 20000) ────────────────────────────────

def test_features_over_20000_is_422(client):
    r = client.post("/api/export/dxf", json={"features": [{}] * 20001}, headers=AUTH)
    assert r.status_code == 422


def test_features_at_20000_is_accepted_by_validation(client):
    # exactly at the bound must pass Pydantic (not a 422 — whatever else it
    # returns depends on rate-limit/auth, which other tests cover).
    r = client.post("/api/export/dxf", json={"features": [{}] * 20000}, headers=AUTH)
    assert r.status_code != 422


# ── ExportRequest.filename bound + sanitization ─────────────────────────────

def test_filename_strips_path_separators_and_header_injection_chars():
    req = main.ExportRequest(features=[FEATURE], filename='../../etc/passwd"\r\nX-Evil: 1')
    assert "/" not in req.filename
    assert "\\" not in req.filename
    assert "\r" not in req.filename
    assert "\n" not in req.filename
    assert '"' not in req.filename


def test_filename_blank_after_sanitizing_falls_back_to_default():
    req = main.ExportRequest(features=[FEATURE], filename="///\\\\")
    assert req.filename == "mei-hagalil-export"


def test_filename_over_100_chars_is_422(client):
    r = client.post("/api/export/dxf", json={"features": [FEATURE], "filename": "x" * 101}, headers=AUTH)
    assert r.status_code == 422


def test_filename_sanitization_applied_end_to_end(client):
    r = client.post(
        "/api/export/dxf",
        json={"features": [FEATURE], "filename": '../evil"file'},
        headers=AUTH,
    )
    assert r.status_code == 200
    cd = r.headers.get("content-disposition", "")
    # only one quote pair should remain: the ones main.py wraps the filename in
    assert cd.count('"') == 2
    assert "/" not in cd.split("filename=")[1]


# ── existing body-size guard (413) — regression coverage ────────────────────

def test_body_over_max_bytes_is_413(client, monkeypatch):
    monkeypatch.setattr(main, "MAX_BODY_BYTES", 100)
    r = client.post(
        "/api/export/dxf",
        content=b"{" + b"x" * 200 + b"}",
        headers={**AUTH, "Content-Type": "application/json"},
    )
    assert r.status_code == 413
