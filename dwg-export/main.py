"""
Mei HaGalil GIS — DWG Export Service
FastAPI microservice: GeoJSON features → DXF / DWG download.

POST /api/export/dxf  — returns a DXF file (always works)
POST /api/export/dwg  — returns a DWG file (requires ODA File Converter)
                        falls back to DXF if ODA is not installed
GET  /health          — liveness check
"""

# NOTE: intentionally no `from __future__ import annotations` here. FastAPI
# resolves string annotations using the route function's `__globals__`, but
# slowapi's `@limiter.limit(...)` wraps each handler in a closure defined in
# slowapi's own module — with postponed evaluation on, FastAPI would try to
# eval this module's annotations against slowapi's globals and fail with
# `NameError: name 'StreamingResponse' is not defined` at import time. All
# type hints below (`X | None`, `list[...]`, etc.) are valid natively on the
# Python 3.11 this service runs (CI + the Render Docker image), so postponed
# evaluation isn't needed.

import asyncio
import io
import json
import logging
import os
import shutil
import subprocess
import tempfile
import urllib.request
from typing import Any

try:
    import resource  # POSIX-only: RLIMIT_AS guard on the ODA subprocess (see _oda_preexec_fn)
except ImportError:  # Windows dev machines — the guard becomes a documented no-op there
    resource = None  # type: ignore[assignment]

import jwt
from fastapi import FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field, field_validator
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware
from slowapi.util import get_remote_address

from dxf_builder import build_dxf
from dxf_to_geojson import dxf_to_geojson

app = FastAPI(
    title="Mei HaGalil GIS — DWG Export Service",
    version="1.0.0",
)

# The production incident that prompted the guards in this file (ODA subprocess
# OOM-killing the whole container) left NOTHING in the Render logs — the
# container died before any line about the failure could be written. Every ODA
# failure/timeout path below now logs returncode + stderr tail + input size
# before returning None. `basicConfig` is a no-op if a handler is already
# attached to the root logger (e.g. uvicorn's own logging setup in
# production), so this only matters for bare `python main.py` / `pytest -s`.
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("dwg_export")

# Restrict which sites may call this service.
# Set ALLOWED_ORIGINS in Render (comma-separated) to your real domain(s),
# e.g. "https://mei-hagalil-gis.vercel.app,https://gis.mei-hagalil.co.il".
_origins = os.getenv("ALLOWED_ORIGINS", "https://mei-hagalil-gis.vercel.app")
ALLOWED_ORIGINS: list[str] = (
    ["*"] if _origins.strip() == "*"
    else [o.strip() for o in _origins.split(",") if o.strip()]
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
    expose_headers=["X-Fallback-Format", "X-Fallback-Reason"],
)

# Per-IP rate limiting on the abusable endpoints (DXF/DWG export, DWG conversion).
# This service runs behind Render's reverse proxy, so request.client.host (what
# slowapi's default get_remote_address reads) is Render's proxy address, not the
# caller's — key off X-Forwarded-For instead. Use the LAST entry: the trusted
# proxy appends the real peer IP, so the last entry is proxy-controlled either
# way, while the first entry is client-forgeable (a caller could rotate fake
# leading entries to dodge the limit). Falls back to get_remote_address when
# the header is absent (e.g. running locally without a proxy in front).
def _rate_limit_key(request: Request) -> str:
    xff = request.headers.get("x-forwarded-for")
    if xff:
        return xff.split(",")[-1].strip()
    return get_remote_address(request)


limiter = Limiter(key_func=_rate_limit_key)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
# Added before the body-size middleware below so that middleware stays the
# outermost layer (Starlette runs later-added `add_middleware` calls first) —
# oversized requests are still rejected on Content-Length alone, before the
# rate limiter does any work.
app.add_middleware(SlowAPIMiddleware)

# Reject oversized request bodies BEFORE they are read into memory — a DoS guard
# for the JSON export payload and the DWG file uploads (both otherwise unbounded).
# Override with MAX_BODY_BYTES on Render.
MAX_BODY_BYTES: int = int(os.getenv("MAX_BODY_BYTES", str(32 * 1024 * 1024)))  # 32 MB


@app.middleware("http")
async def _limit_body_size(request: Request, call_next):
    cl = request.headers.get("content-length")
    if cl:
        try:
            if int(cl) > MAX_BODY_BYTES:
                return JSONResponse({"detail": "payload too large"}, status_code=413)
        except ValueError:
            pass
    return await call_next(request)


# Above this feature count, skip the memory-heavy ODA DWG conversion and return
# DXF instead — large exports OOM-crash the converter on small instances (502).
# Raise this if you move to an instance with more RAM.
MAX_DWG_FEATURES: int = int(os.getenv("MAX_DWG_FEATURES", "8000"))

# Virtual-memory ceiling (MB) applied to the ODA File Converter subprocess via
# RLIMIT_AS — see _oda_preexec_fn() below for the full reasoning. Render's free
# tier gives the container 512MB total; this FastAPI process + uvicorn workers
# + the xvfb X server sit around ~150MB baseline, so 400MB leaves the ODA child
# a real budget while still failing (SIGKILL'd by the kernel's malloc path,
# non-zero exit) well before it could push the *container's* cgroup over
# 512MB and get the whole process OOM-killed by Render instead. Tune via env:
# raise it if legitimate conversions start dying under real usage, lower it if
# the container is still going down.
ODA_MAX_MEMORY_MB: int = int(os.getenv("ODA_MAX_MEMORY_MB", "400"))

# Preferred auth: validate the caller's Supabase access token REMOTELY by asking
# Supabase (GET /auth/v1/user). This works no matter how the project signs its
# JWTs (legacy HS256 *or* the newer asymmetric signing keys), so it is more robust
# than a local secret decode. Set both on Render:
#   SUPABASE_URL        e.g. https://xxxx.supabase.co
#   SUPABASE_ANON_KEY   the project's public anon key (safe to expose)
SUPABASE_URL: str = os.getenv("SUPABASE_URL", "").rstrip("/")
SUPABASE_APIKEY: str = os.getenv("SUPABASE_ANON_KEY", "") or os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")

# Legacy fallback: local HS256 verification with the project JWT secret
# (Dashboard → Settings → API → JWT Secret). Only used if SUPABASE_URL is unset.
SUPABASE_JWT_SECRET: str = os.getenv("SUPABASE_JWT_SECRET", "")


# ── models ────────────────────────────────────────────────────────────────────

# Characters stripped from a caller-supplied filename before it goes into the
# Content-Disposition header: control chars (incl. CR/LF — header injection),
# path separators, and the quote that delimits the header's filename="..." value.
_FILENAME_STRIP = frozenset(chr(c) for c in range(0x00, 0x20)) | frozenset([chr(0x7F), "/", "\\", '"'])


def _sanitize_filename(v: str) -> str:
    cleaned = "".join(ch for ch in v if ch not in _FILENAME_STRIP).strip()
    return cleaned or "mei-hagalil-export"


class ExportRequest(BaseModel):
    # 20000 is well above any real export (MAX_DWG_FEATURES already redirects
    # large DWG exports to DXF at 8000) — bounds the request body's item count
    # against a memory-exhaustion DoS via an absurdly long features array.
    features: list[dict[str, Any]] = Field(..., max_length=20000)
    filename: str = Field("mei-hagalil-export", max_length=100)

    @field_validator("filename")
    @classmethod
    def _clean_filename(cls, v: str) -> str:
        return _sanitize_filename(v)


# ── auth ──────────────────────────────────────────────────────────────────────

def _caller_identity(authorization: str | None) -> tuple[str | None, str | None]:
    """Validate the bearer token and return (user_id, role).

    (None, None) means the token is invalid. role may be None if it could not be
    resolved (e.g. the HS256 fallback path, which carries no profile lookup)."""
    if not authorization:
        return (None, None)
    parts = authorization.split()
    if len(parts) != 2 or parts[0].lower() != "bearer":
        return (None, None)
    token = parts[1]

    # Primary: validate the token remotely (works for any JWT signing algorithm)
    # and read the caller's role from their profile.
    if SUPABASE_URL and SUPABASE_APIKEY:
        try:
            req = urllib.request.Request(
                f"{SUPABASE_URL}/auth/v1/user",
                headers={"Authorization": f"Bearer {token}", "apikey": SUPABASE_APIKEY},
            )
            with urllib.request.urlopen(req, timeout=8) as resp:
                if resp.status != 200:
                    return (None, None)
                user = json.loads(resp.read().decode())
        except Exception:
            return (None, None)
        uid = user.get("id")
        if not uid:
            return (None, None)
        try:
            req2 = urllib.request.Request(
                f"{SUPABASE_URL}/rest/v1/profiles?id=eq.{uid}&select=role,is_active",
                headers={"Authorization": f"Bearer {token}", "apikey": SUPABASE_APIKEY},
            )
            with urllib.request.urlopen(req2, timeout=8) as resp:
                rows = json.loads(resp.read().decode())
        except Exception:
            # Fail closed: if we cannot verify the caller's role/status, deny.
            return (None, None)
        if not rows or rows[0].get("is_active") is not True:
            # No profile row, or a suspended account → not authorized.
            return (None, None)
        return (uid, rows[0].get("role"))

    # Fallback: local HS256 verification (no role info available).
    if SUPABASE_JWT_SECRET:
        try:
            jwt.decode(token, SUPABASE_JWT_SECRET, algorithms=["HS256"], audience="authenticated")
            return ("jwt", None)
        except Exception:
            return (None, None)

    return (None, None)


def _require_auth(authorization: str | None = None) -> None:
    """JWT-only authorization for export/convert calls. The caller must present a
    valid Supabase session token; if a role is resolved it must be editor or admin.
    (The legacy static X-Api-Token fallback was removed — P1-1.)"""
    uid, role = _caller_identity(authorization)
    if not uid:
        raise HTTPException(status_code=401, detail="Unauthorized")
    # If the role is known it must be admin/editor/engineer (the DB stores the
    # edit-capable role as 'engineer'; 'editor' kept for back-compat). If it
    # couldn't be resolved (HS256 dev fallback carries no profile), a valid token
    # still passes — in production the remote path always resolves a role or 401s.
    if role is None or role in ("admin", "editor", "engineer"):
        return
    raise HTTPException(status_code=403, detail="Forbidden: export requires editor or admin role")


# ── helpers ───────────────────────────────────────────────────────────────────

# Only one ODA conversion runs at a time. Render's free tier gives this
# service ~0.1 CPU — two concurrent ODA/xvfb subprocesses wouldn't actually
# run in parallel, they'd thrash the same sliver of CPU and each other's
# memory budget for longer than either would take alone. A second concurrent
# upload simply waits for the first conversion to finish rather than racing
# it — a deliberate "prefer waiting over complex queueing" choice; there is
# no separate queue/backoff, just FIFO-ish contention on this semaphore.
_oda_semaphore = asyncio.Semaphore(1)

# Bilingual, actionable detail returned to the caller when DWG→DXF conversion
# fails (ODA missing/timeout/crash — including the RLIMIT_AS guard below
# doing its job). ExportRequest/UploadFile callers are Hebrew-first (this is
# a Hebrew-language GIS tool); the parenthetical English mirrors it for any
# English-reading admin. 422 (not 500): from the caller's point of view this
# is "your file is likely too large/complex for this server", an actionable
# client-side condition, not an opaque server fault.
DWG_CONVERSION_FAILED_DETAIL = (
    "המרת ה-DWG נכשלה — ייתכן שהקובץ גדול/מורכב מדי לשרת. "
    "המר את הקובץ ל-DXF (SAVEAS בתוכנת CAD) והעלה אותו ישירות — "
    "ייבוא DXF אינו דורש המרה. "
    "(DWG conversion failed — likely too large/complex for the server; "
    "save as DXF and upload that instead.)"
)


def _oda_preexec_fn():
    """Build a `subprocess.run(..., preexec_fn=...)` callable that caps the
    ODA File Converter child's virtual memory via RLIMIT_AS, or return None
    where that isn't possible/meaningful.

    Why: ODA File Converter is a Qt GUI app driven headlessly through
    xvfb-run. A large/malformed DWG can make it balloon its memory use well
    past what this 512MB Render container has left (~150MB baseline for this
    FastAPI process + uvicorn + Xvfb) — and until now that OOM-killed the
    whole container (PID 1), dropping the in-flight HTTP connection with no
    response and no CORS headers at all. The browser then reports a bogus
    "CORS error" that has nothing to do with CORS; Render's logs showed
    nothing but "Skipping data after last boundary" then silence then
    "Started server process [1]" (the restart) — no error, no stack trace.

    RLIMIT_AS caps *virtual* address space, not resident memory (there is no
    portable, race-free way to cap RSS from preexec_fn) — Qt/X11 over-commit
    virtual memory routinely (mmap'd fonts, shared libs, lazily-reserved
    buffers), so ODA_MAX_MEMORY_MB is an APPROXIMATE ceiling, not an exact RSS
    budget: a conversion can fail here well before it would have actually
    used that much resident memory. That's an intentional, documented
    trade-off — the goal is only that a runaway conversion's malloc() fails
    and *that child process* exits non-zero (SIGSEGV/SIGABRT/non-zero rc),
    instead of the kernel's OOM-killer picking the whole container. Tune
    ODA_MAX_MEMORY_MB up if real conversions start failing well under actual
    usage, or down if the container is still dying.

    Linux-only: `resource` (and RLIMIT_AS) doesn't exist on Windows, where
    this service's dev machine runs — `subprocess.run` also outright rejects
    a non-None `preexec_fn` on Windows, so this returns None there and
    callers pass that straight through as `preexec_fn=None` (the default,
    a no-op), not a Windows-specific code path. Tests simulate the
    Linux/"available" branch by monkeypatching module-level `resource`.
    """
    if resource is None or not hasattr(resource, "RLIMIT_AS"):
        return None
    limit_bytes = ODA_MAX_MEMORY_MB * 1024 * 1024

    def _apply_memory_limit():
        resource.setrlimit(resource.RLIMIT_AS, (limit_bytes, limit_bytes))

    return _apply_memory_limit


def _build_dxf_bytes(features: list[dict]) -> bytes:
    # ezdxf writes to a *text* stream and handles DXF encoding itself, so we
    # save to a temp .dxf file and read the bytes back.
    doc = build_dxf(features)
    with tempfile.NamedTemporaryFile(suffix=".dxf", delete=False) as tf:
        tmp_path = tf.name
    try:
        doc.saveas(tmp_path)
        with open(tmp_path, "rb") as fh:
            return fh.read()
    finally:
        os.unlink(tmp_path)


def _find_oda() -> str | None:
    """Locate the ODA File Converter binary (PATH or common install dirs)."""
    found = shutil.which("ODAFileConverter")
    if found:
        return found
    for cand in ("/usr/bin/ODAFileConverter", "/usr/local/bin/ODAFileConverter"):
        if os.path.exists(cand):
            return cand
    return None


def _convert_dxf_to_dwg(dxf_bytes: bytes) -> tuple[bytes | None, dict]:
    """Convert DXF bytes → DWG bytes via ODA File Converter CLI.

    ODA File Converter is a Qt GUI app; even in batch mode it needs a display,
    so it is launched under xvfb-run, which provides a virtual X server.

    Returns (dwg_bytes_or_None, diagnostics)."""
    diag: dict = {}
    oda = _find_oda()
    diag["oda"] = oda
    if not oda:
        diag["error"] = "ODA binary not found"
        return None, diag

    with tempfile.TemporaryDirectory() as tmp:
        in_dir = os.path.join(tmp, "in")
        out_dir = os.path.join(tmp, "out")
        os.makedirs(in_dir)
        os.makedirs(out_dir)

        dxf_path = os.path.join(in_dir, "export.dxf")
        with open(dxf_path, "wb") as fh:
            fh.write(dxf_bytes)

        # ODAFileConverter <inDir> <outDir> <version> <type> <recurse> <audit>
        oda_cmd = [oda, in_dir, out_dir, "ACAD2018", "DWG", "0", "0"]
        cmd = oda_cmd
        if shutil.which("xvfb-run"):
            cmd = ["xvfb-run", "-a", *oda_cmd]
        diag["cmd"] = " ".join(cmd)

        try:
            res = subprocess.run(
                cmd, capture_output=True, timeout=120, preexec_fn=_oda_preexec_fn(),
            )
            diag["returncode"] = res.returncode
            diag["stdout"] = res.stdout.decode("utf-8", "replace")[-1500:]
            diag["stderr"] = res.stderr.decode("utf-8", "replace")[-1500:]
        except subprocess.TimeoutExpired:
            diag["error"] = "timeout"
            logger.error(
                "ODA DXF->DWG conversion timed out after 120s: input_bytes=%d",
                len(dxf_bytes),
            )
            return None, diag
        except OSError as e:
            diag["error"] = f"OSError: {e}"
            logger.error(
                "ODA DXF->DWG conversion raised OSError: %s, input_bytes=%d",
                e, len(dxf_bytes),
            )
            return None, diag

        diag["out_files"] = os.listdir(out_dir)
        produced = os.path.join(out_dir, "export.dwg")
        if os.path.exists(produced):
            with open(produced, "rb") as fh:
                return fh.read(), diag

    diag.setdefault("error", "no .dwg produced")
    logger.error(
        "ODA DXF->DWG conversion produced no output file: returncode=%s "
        "input_bytes=%d stderr_tail=%r",
        diag.get("returncode"), len(dxf_bytes), diag.get("stderr", "")[-500:],
    )
    return None, diag


def _dxf_to_dwg(dxf_bytes: bytes) -> bytes | None:
    dwg, _diag = _convert_dxf_to_dwg(dxf_bytes)
    return dwg


def _dwg_to_dxf(dwg_bytes: bytes) -> bytes | None:
    """Convert DWG bytes → DXF bytes via ODA File Converter (reverse direction)."""
    oda = _find_oda()
    if not oda:
        logger.error(
            "ODA DWG->DXF conversion skipped: ODA binary not found, input_bytes=%d",
            len(dwg_bytes),
        )
        return None
    with tempfile.TemporaryDirectory() as tmp:
        in_dir = os.path.join(tmp, "in")
        out_dir = os.path.join(tmp, "out")
        os.makedirs(in_dir)
        os.makedirs(out_dir)
        with open(os.path.join(in_dir, "input.dwg"), "wb") as fh:
            fh.write(dwg_bytes)
        cmd = [oda, in_dir, out_dir, "ACAD2018", "DXF", "0", "0"]
        if shutil.which("xvfb-run"):
            cmd = ["xvfb-run", "-a", *cmd]
        try:
            res = subprocess.run(
                cmd, capture_output=True, timeout=120, preexec_fn=_oda_preexec_fn(),
            )
        except subprocess.TimeoutExpired:
            logger.error(
                "ODA DWG->DXF conversion timed out after 120s: input_bytes=%d",
                len(dwg_bytes),
            )
            return None
        except OSError as e:
            logger.error(
                "ODA DWG->DXF conversion raised OSError: %s, input_bytes=%d",
                e, len(dwg_bytes),
            )
            return None
        produced = os.path.join(out_dir, "input.dxf")
        if os.path.exists(produced):
            with open(produced, "rb") as fh:
                return fh.read()
        stderr_tail = res.stderr.decode("utf-8", "replace")[-1500:]
        logger.error(
            "ODA DWG->DXF conversion produced no output file: returncode=%s "
            "input_bytes=%d stderr_tail=%r",
            res.returncode, len(dwg_bytes), stderr_tail[-500:],
        )
    return None


# Async wrappers around the two ODA directions above, run in a worker thread
# (subprocess.run blocks for real, up to 120s) and serialized through
# _oda_semaphore (only one ODA conversion at a time — see its definition).
# Route handlers below `await` these instead of calling `_dxf_to_dwg`/
# `_dwg_to_dxf` directly: an `async def` FastAPI handler that calls a
# blocking function directly runs it ON the single asyncio event loop thread,
# freezing EVERY other in-flight request (including /health) for the whole
# subprocess duration — that is a second, independent way the container was
# going down (Render's health check stops getting answered → Render kills the
# "unhealthy" container), on top of the OOM path _oda_preexec_fn() guards
# against. `asyncio.to_thread` moves the call to a worker thread so the event
# loop stays free to keep answering /health and other requests meanwhile.
#
# These call `_dxf_to_dwg` / `_dwg_to_dxf` by their plain (module-global)
# names rather than capturing a reference, so existing tests that do
# `monkeypatch.setattr(main, "_dxf_to_dwg", ...)` keep working unchanged —
# the lookup happens at call time, after monkeypatch has already run.
async def _run_dxf_to_dwg(dxf_bytes: bytes) -> bytes | None:
    async with _oda_semaphore:
        return await asyncio.to_thread(_dxf_to_dwg, dxf_bytes)


async def _run_dwg_to_dxf(dwg_bytes: bytes) -> bytes | None:
    async with _oda_semaphore:
        return await asyncio.to_thread(_dwg_to_dxf, dwg_bytes)


# ── routes ────────────────────────────────────────────────────────────────────

@app.get("/health")
@limiter.exempt
def health() -> dict:
    oda = _find_oda()
    return {
        "status": "ok",
        "dwg_export": bool(oda),
        "oda_path": oda,
    }


@app.post("/api/export/dxf")
@limiter.limit("10/minute")
async def export_dxf(
    request: Request,
    body: ExportRequest,
    authorization: str | None = Header(None),
) -> StreamingResponse:
    await asyncio.to_thread(_require_auth, authorization)
    dxf_bytes = await asyncio.to_thread(_build_dxf_bytes, body.features)
    fname = f"{body.filename}.dxf"
    return StreamingResponse(
        io.BytesIO(dxf_bytes),
        media_type="application/dxf",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )


@app.post("/api/export/dwg")
@limiter.limit("10/minute")
async def export_dwg(
    request: Request,
    body: ExportRequest,
    authorization: str | None = Header(None),
) -> StreamingResponse:
    await asyncio.to_thread(_require_auth, authorization)

    dxf_bytes = await asyncio.to_thread(_build_dxf_bytes, body.features)

    # Skip the OOM-prone ODA step for very large exports → return DXF, don't 502.
    too_large = len(body.features) > MAX_DWG_FEATURES
    dwg_bytes = None if too_large else await _run_dxf_to_dwg(dxf_bytes)

    if dwg_bytes:
        fname = f"{body.filename}.dwg"
        return StreamingResponse(
            io.BytesIO(dwg_bytes),
            media_type="application/octet-stream",
            headers={"Content-Disposition": f'attachment; filename="{fname}"'},
        )

    # Fall back to DXF (still opens in AutoCAD) — either ODA is unavailable, or the
    # export is too large to convert to DWG on this instance without crashing.
    fname = f"{body.filename}.dxf"
    return StreamingResponse(
        io.BytesIO(dxf_bytes),
        media_type="application/dxf",
        headers={
            "Content-Disposition": f'attachment; filename="{fname}"',
            "X-Fallback-Format": "dxf",
            "X-Fallback-Reason": "too_large" if too_large else "oda_unavailable",
        },
    )


def _looks_like_dwg(data: bytes) -> bool:
    """DWG binary files start with an "AC1<x>" version stamp (e.g. AC1027 =
    2013, AC1032 = 2018) — the same signature js/pages/upload.js's client-side
    magic-byte gate checks for. Used here to sanity-check the caller's
    filename/extension claim rather than trusting it blindly."""
    return data[:4] == b"AC10"


@app.post("/api/convert/dwg-to-geojson")
@limiter.limit("10/minute")
async def convert_dwg_to_geojson(
    request: Request,
    file: UploadFile = File(...),
    source_crs: str = Form("EPSG:2039"),
    authorization: str | None = Header(None),
) -> JSONResponse:
    """Convert an uploaded DWG *or* DXF → WGS84 GeoJSON (for importing into the
    map). A .dxf upload skips the ODA DWG→DXF conversion step entirely (the
    file is already DXF) — detected by filename extension, but only trusted
    when the content doesn't actually look like a DWG binary (the "AC10..."
    signature): a file named .dxf whose bytes are really a DWG still goes
    through the normal ODA path below."""
    await asyncio.to_thread(_require_auth, authorization)
    raw_bytes = await file.read()
    filename = (file.filename or "").lower()
    is_dxf_upload = filename.endswith(".dxf") and not _looks_like_dwg(raw_bytes)

    if is_dxf_upload:
        dxf_bytes = raw_bytes
    else:
        dxf_bytes = await _run_dwg_to_dxf(raw_bytes)
        if not dxf_bytes:
            # 422, not 500: from the caller's side this reads as "your file is
            # too big/complex for the server", an actionable condition — see
            # DWG_CONVERSION_FAILED_DETAIL for the full bilingual message and
            # _oda_preexec_fn()/the ODA subprocess logging above for why this
            # is now the clean outcome instead of a dropped connection.
            raise HTTPException(status_code=422, detail=DWG_CONVERSION_FAILED_DETAIL)

    try:
        geojson = await asyncio.to_thread(dxf_to_geojson, dxf_bytes, source_crs=source_crs or "EPSG:2039")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"DXF parse failed: {e}")
    return JSONResponse(geojson)


@app.post("/api/convert/dwg-to-dxf")
@limiter.limit("10/minute")
async def convert_dwg_to_dxf(
    request: Request,
    file: UploadFile = File(...),
    authorization: str | None = Header(None),
) -> StreamingResponse:
    """Convert an uploaded DWG file to DXF (for inspection / round-tripping)."""
    await asyncio.to_thread(_require_auth, authorization)
    dwg_bytes = await file.read()
    dxf_bytes = await _run_dwg_to_dxf(dwg_bytes)
    if not dxf_bytes:
        # Harmonized with /api/convert/dwg-to-geojson's failure detail (422,
        # same bilingual message) — same root cause, same actionable fix.
        raise HTTPException(status_code=422, detail=DWG_CONVERSION_FAILED_DETAIL)
    return StreamingResponse(
        io.BytesIO(dxf_bytes),
        media_type="application/dxf",
        headers={"Content-Disposition": 'attachment; filename="converted.dxf"'},
    )

