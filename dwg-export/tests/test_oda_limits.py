"""
Hotfix regression coverage for the ODA-subprocess containment work in main.py.

Production incident this covers: the ODA File Converter subprocess (Qt app
under xvfb-run, converting an uploaded DWG) OOM-killed the whole 512MB Render
container mid-conversion — Render's logs showed "OPTIONS ... 200" ->
"Skipping data after last boundary" -> silence -> "Started server process
[1]" (a restart), with NOTHING logged about the actual failure. The browser
saw a dropped connection with no CORS headers and reported a bogus CORS
error. Separately, both ODA directions were called directly (blocking,
`subprocess.run(..., timeout=120)`) from inside `async def` FastAPI route
handlers — that blocks the single asyncio event loop thread for the whole
conversion, so /health (Render's liveness probe) stops answering too and
Render kills the container as "unhealthy" — a second, independent path to
the exact same silent-restart symptom.

Four things are covered here:
  1. `_oda_preexec_fn()` — the RLIMIT_AS memory-ceiling builder — returns a
     callable that applies the configured ODA_MAX_MEMORY_MB ceiling when
     `resource`/RLIMIT_AS is available, and cleanly returns None when it
     isn't (this dev/CI machine is Windows, where `resource` doesn't exist
     at all — real Linux availability is simulated by monkeypatching
     `main.resource` to a fake module).
  2. Both ODA directions (`_convert_dxf_to_dwg` / `_dwg_to_dxf`) pass that
     preexec_fn through to `subprocess.run`, and log a clear line
     (returncode, stderr tail, input size) on timeout/OSError/no-output —
     the exact information that was missing from the Render logs during the
     incident.
  3. A failed DWG→DXF conversion on the convert endpoints now returns 422
     with the bilingual Hebrew/English detail string, instead of the old
     bare 500.
  4. The event loop stays responsive (proven via a genuinely concurrent
     /health request) while a slow conversion is in flight on another
     request — proving the `asyncio.to_thread` offload actually frees the
     loop, not just that it was called.

Follows the same auth-mocking / rate-limiter-reset / FakeResp pattern as
tests/test_limits.py, tests/test_dwg_fallback.py, tests/test_dxf_passthrough.py.
"""
import json
import logging
import subprocess
import threading
import time
import urllib.request

import pytest
from fastapi.testclient import TestClient

import main

AUTH = {"Authorization": "Bearer tok"}
DWG_BYTES = b"AC1027" + b"\x00" * 10  # real "AC10..." DWG version stamp
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


@pytest.fixture
def live_client(monkeypatch):
    """Like `client`, but used as a context manager so `TestClient.portal` is
    set once (in `__enter__`) and reused for every request made through it.

    This matters ONLY for test_health_stays_responsive_during_slow_conversion
    below: TestClient._portal_factory() creates a BRAND NEW anyio blocking
    portal (its own thread + its own event loop) for every single request
    when `self.portal is None` — which is the case for a plain
    `TestClient(app)` never used as `with TestClient(app) as c`, i.e. the
    plain `client` fixture above. Two requests issued concurrently from two
    Python threads against a plain `client` therefore each get their OWN
    independent event loop and never actually contend for the same loop —
    that would make the responsiveness test pass unconditionally, whether or
    not the route handler blocks the loop. Only inside a `with` block is
    `self.portal` set, so every request is dispatched onto the SAME portal
    (same thread, same event loop) — the shared-loop condition the
    responsiveness test needs in order to mean anything."""
    monkeypatch.setattr(main, "dxf_to_geojson", lambda dxf_bytes, source_crs="EPSG:2039": FAKE_GEOJSON)
    with TestClient(main.app) as c:
        yield c


# ── FakeResourceModule: stands in for the POSIX-only stdlib `resource` module ──

class FakeResourceModule:
    """Minimal stand-in for the stdlib `resource` module's RLIMIT_AS surface,
    for simulating the "available" (Linux/Render) branch of _oda_preexec_fn()
    on this Windows dev machine (where the real `resource` module doesn't
    exist — `main.resource` is None there, see main.py's guarded import)."""
    RLIMIT_AS = "RLIMIT_AS"

    def __init__(self):
        self.calls = []

    def setrlimit(self, which, limits):
        self.calls.append((which, limits))


# ── 1. _oda_preexec_fn(): applied when available, skipped cleanly when not ──

def test_oda_preexec_fn_returns_none_when_resource_module_unavailable(monkeypatch):
    monkeypatch.setattr(main, "resource", None)
    assert main._oda_preexec_fn() is None


def test_oda_preexec_fn_returns_none_when_rlimit_as_missing(monkeypatch):
    class ResourceWithoutRlimitAs:
        pass
    monkeypatch.setattr(main, "resource", ResourceWithoutRlimitAs())
    assert main._oda_preexec_fn() is None


def test_oda_preexec_fn_applies_configured_memory_ceiling_when_available(monkeypatch):
    fake_resource = FakeResourceModule()
    monkeypatch.setattr(main, "resource", fake_resource)
    monkeypatch.setattr(main, "ODA_MAX_MEMORY_MB", 250)

    preexec = main._oda_preexec_fn()
    assert callable(preexec)

    preexec()  # what would run in the child process, post-fork, on POSIX

    expected_bytes = 250 * 1024 * 1024
    assert fake_resource.calls == [(fake_resource.RLIMIT_AS, (expected_bytes, expected_bytes))]


def test_oda_max_memory_mb_env_default_is_400():
    # Reflects main.py's `int(os.getenv("ODA_MAX_MEMORY_MB", "400"))` at
    # import time — only meaningful when the env var isn't set in this
    # environment (true for local/CI runs of this suite).
    import os
    if "ODA_MAX_MEMORY_MB" in os.environ:
        pytest.skip("ODA_MAX_MEMORY_MB is overridden in this environment")
    assert main.ODA_MAX_MEMORY_MB == 400


def test_convert_dxf_to_dwg_passes_preexec_fn_through_to_subprocess_run(monkeypatch):
    monkeypatch.setattr(main, "_find_oda", lambda: "/fake/oda")
    sentinel = object()
    monkeypatch.setattr(main, "_oda_preexec_fn", lambda: sentinel)
    captured = {}

    class FakeCompleted:
        returncode = 0
        stdout = b""
        stderr = b""

    def fake_run(cmd, capture_output=True, timeout=120, preexec_fn=None):
        captured["preexec_fn"] = preexec_fn
        return FakeCompleted()

    monkeypatch.setattr(main.subprocess, "run", fake_run)

    main._convert_dxf_to_dwg(b"FAKE-DXF")

    assert captured["preexec_fn"] is sentinel


def test_dwg_to_dxf_passes_preexec_fn_through_to_subprocess_run(monkeypatch):
    monkeypatch.setattr(main, "_find_oda", lambda: "/fake/oda")
    sentinel = object()
    monkeypatch.setattr(main, "_oda_preexec_fn", lambda: sentinel)
    captured = {}

    class FakeCompleted:
        returncode = 0
        stdout = b""
        stderr = b""

    def fake_run(cmd, capture_output=True, timeout=120, preexec_fn=None):
        captured["preexec_fn"] = preexec_fn
        return FakeCompleted()

    monkeypatch.setattr(main.subprocess, "run", fake_run)

    main._dwg_to_dxf(b"FAKE-DWG")

    assert captured["preexec_fn"] is sentinel


# ── 2. failure/timeout logging — nothing was logged during the incident ────

def test_convert_dxf_to_dwg_timeout_logs_returncode_free_error_with_input_size(monkeypatch, caplog):
    monkeypatch.setattr(main, "_find_oda", lambda: "/fake/oda")

    def fake_run(cmd, capture_output=True, timeout=120, preexec_fn=None):
        raise subprocess.TimeoutExpired(cmd=cmd, timeout=timeout)

    monkeypatch.setattr(main.subprocess, "run", fake_run)

    with caplog.at_level(logging.ERROR, logger="dwg_export"):
        dwg, diag = main._convert_dxf_to_dwg(b"X" * 37)

    assert dwg is None
    assert diag["error"] == "timeout"
    assert "timed out" in caplog.text
    assert "input_bytes=37" in caplog.text


def test_convert_dxf_to_dwg_no_output_logs_returncode_and_stderr_tail(monkeypatch, caplog):
    monkeypatch.setattr(main, "_find_oda", lambda: "/fake/oda")

    class FakeCompleted:
        returncode = 1
        stdout = b""
        stderr = b"ODA crashed: out of memory"

    monkeypatch.setattr(main.subprocess, "run", lambda *a, **k: FakeCompleted())

    with caplog.at_level(logging.ERROR, logger="dwg_export"):
        dwg, diag = main._convert_dxf_to_dwg(b"X" * 21)

    assert dwg is None
    assert "returncode=1" in caplog.text
    assert "out of memory" in caplog.text
    assert "input_bytes=21" in caplog.text


def test_dwg_to_dxf_timeout_logs_error_with_input_size(monkeypatch, caplog):
    monkeypatch.setattr(main, "_find_oda", lambda: "/fake/oda")

    def fake_run(cmd, capture_output=True, timeout=120, preexec_fn=None):
        raise subprocess.TimeoutExpired(cmd=cmd, timeout=timeout)

    monkeypatch.setattr(main.subprocess, "run", fake_run)

    with caplog.at_level(logging.ERROR, logger="dwg_export"):
        dxf = main._dwg_to_dxf(b"Y" * 13)

    assert dxf is None
    assert "timed out" in caplog.text
    assert "input_bytes=13" in caplog.text


def test_dwg_to_dxf_no_output_logs_returncode_and_stderr_tail(monkeypatch, caplog):
    monkeypatch.setattr(main, "_find_oda", lambda: "/fake/oda")

    class FakeCompleted:
        returncode = 1
        stdout = b""
        stderr = b"ODA crashed: bad geometry"

    monkeypatch.setattr(main.subprocess, "run", lambda *a, **k: FakeCompleted())

    with caplog.at_level(logging.ERROR, logger="dwg_export"):
        dxf = main._dwg_to_dxf(b"Z" * 13)

    assert dxf is None
    assert "returncode=1" in caplog.text
    assert "bad geometry" in caplog.text
    assert "input_bytes=13" in caplog.text


def test_dwg_to_dxf_logs_when_oda_binary_missing(monkeypatch, caplog):
    monkeypatch.setattr(main, "_find_oda", lambda: None)

    with caplog.at_level(logging.ERROR, logger="dwg_export"):
        dxf = main._dwg_to_dxf(b"W" * 5)

    assert dxf is None
    assert "input_bytes=5" in caplog.text


# ── 3. clean 422 + bilingual detail to the caller on conversion failure ────

def test_convert_dwg_to_geojson_failure_is_422_with_bilingual_detail(client, monkeypatch):
    monkeypatch.setattr(main, "_dwg_to_dxf", lambda dwg_bytes: None)

    r = client.post(
        "/api/convert/dwg-to-geojson",
        files={"file": ("plan.dwg", DWG_BYTES, "application/octet-stream")},
        headers=AUTH,
    )

    assert r.status_code == 422
    body = r.json()
    assert body["detail"] == main.DWG_CONVERSION_FAILED_DETAIL
    # Sanity: actually bilingual, actually mentions DXF as the workaround.
    assert "DWG" in body["detail"] and "DXF" in body["detail"]
    assert "SAVEAS" in body["detail"]


def test_convert_dwg_to_dxf_failure_is_422_with_bilingual_detail(client, monkeypatch):
    monkeypatch.setattr(main, "_dwg_to_dxf", lambda dwg_bytes: None)

    r = client.post(
        "/api/convert/dwg-to-dxf",
        files={"file": ("plan.dwg", DWG_BYTES, "application/octet-stream")},
        headers=AUTH,
    )

    assert r.status_code == 422
    assert r.json()["detail"] == main.DWG_CONVERSION_FAILED_DETAIL


def test_convert_dwg_to_geojson_success_path_still_returns_200(client, monkeypatch):
    # Regression guard: the 422 change above must not affect the happy path.
    monkeypatch.setattr(main, "_dwg_to_dxf", lambda dwg_bytes: b"0\r\nSECTION\r\n0\r\nEOF\r\n")

    r = client.post(
        "/api/convert/dwg-to-geojson",
        files={"file": ("plan.dwg", DWG_BYTES, "application/octet-stream")},
        headers=AUTH,
    )

    assert r.status_code == 200
    assert r.json() == FAKE_GEOJSON


# ── 4. event loop stays responsive during a slow conversion ────────────────

def test_health_stays_responsive_during_slow_conversion(live_client, monkeypatch):
    """Proves the `asyncio.to_thread` offload in main.py's route handlers
    actually frees the event loop, not just that it's present in the source.

    Uses `live_client` (see its fixture docstring) specifically so every
    request shares ONE anyio blocking portal/event loop — only then do two
    calls issued concurrently from two different Python threads genuinely
    contend for the same loop, the way two real concurrent HTTP requests
    would in production. That lets this test observe event-loop starvation
    directly: if a route handler blocked the loop with a synchronous call
    (the pre-fix code), /health would have to wait behind it too. This was
    verified by temporarily reverting the fix locally (calling `_dwg_to_dxf`
    directly instead of `await _run_dwg_to_dxf(...)`) and confirming this
    exact test then fails (~1.2s+ elapsed) before restoring the fix.

    `_dwg_to_dxf` is monkeypatched to `time.sleep(1.5)` — a real, wall-clock
    blocking call — instead of `asyncio.sleep`, precisely because the whole
    point is to prove `asyncio.to_thread` is moving a *blocking* call off
    the loop, not to test something that was already loop-friendly.
    """
    def slow_dwg_to_dxf(dwg_bytes):
        time.sleep(1.5)
        return b"0\r\nSECTION\r\n0\r\nEOF\r\n"

    monkeypatch.setattr(main, "_dwg_to_dxf", slow_dwg_to_dxf)

    results = {}

    def do_slow_conversion():
        r = live_client.post(
            "/api/convert/dwg-to-geojson",
            files={"file": ("plan.dwg", DWG_BYTES, "application/octet-stream")},
            headers=AUTH,
        )
        results["status"] = r.status_code

    conv_thread = threading.Thread(target=do_slow_conversion)
    conv_thread.start()
    time.sleep(0.3)  # let the conversion request start and enter the sleep

    started = time.monotonic()
    health_resp = live_client.get("/health")
    elapsed = time.monotonic() - started

    conv_thread.join(timeout=5)

    assert health_resp.status_code == 200
    # Pre-fix (blocking call directly in the async handler), /health would
    # have to wait out the remaining ~1.2s of the conversion's sleep. Give
    # generous headroom above pure dispatch overhead without being anywhere
    # near the 1.5s the loop would block for if it weren't offloaded.
    assert elapsed < 1.0, f"/health took {elapsed:.2f}s while a conversion was in flight — event loop appears blocked"
    assert results.get("status") == 200
