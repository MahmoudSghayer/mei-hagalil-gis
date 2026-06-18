"""
Mei HaGalil GIS — DWG Export Service
FastAPI microservice: GeoJSON features → DXF / DWG download.

POST /api/export/dxf  — returns a DXF file (always works)
POST /api/export/dwg  — returns a DWG file (requires ODA File Converter)
                        falls back to DXF if ODA is not installed
GET  /health          — liveness check
"""

from __future__ import annotations

import io
import json
import os
import shutil
import subprocess
import tempfile
import urllib.request
from typing import Any

import jwt
from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

from dxf_builder import build_dxf
from dxf_to_geojson import dxf_to_geojson

app = FastAPI(
    title="Mei HaGalil GIS — DWG Export Service",
    version="1.0.0",
)

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

# Above this feature count, skip the memory-heavy ODA DWG conversion and return
# DXF instead — large exports OOM-crash the converter on small instances (502).
# Raise this if you move to an instance with more RAM.
MAX_DWG_FEATURES: int = int(os.getenv("MAX_DWG_FEATURES", "8000"))

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

class ExportRequest(BaseModel):
    features: list[dict[str, Any]]
    filename: str = "mei-hagalil-export"


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
            if rows and rows[0].get("is_active", True):
                return (uid, rows[0].get("role"))
        except Exception:
            pass
        return (uid, None)

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
    # If the role is known it must be editor/admin; if it couldn't be resolved
    # (HS256 fallback path carries no profile), a valid token still passes.
    if role is None or role in ("admin", "editor"):
        return
    raise HTTPException(status_code=403, detail="Forbidden: export requires editor or admin role")


# ── helpers ───────────────────────────────────────────────────────────────────

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
            res = subprocess.run(cmd, capture_output=True, timeout=120)
            diag["returncode"] = res.returncode
            diag["stdout"] = res.stdout.decode("utf-8", "replace")[-1500:]
            diag["stderr"] = res.stderr.decode("utf-8", "replace")[-1500:]
        except subprocess.TimeoutExpired:
            diag["error"] = "timeout"
            return None, diag
        except OSError as e:
            diag["error"] = f"OSError: {e}"
            return None, diag

        diag["out_files"] = os.listdir(out_dir)
        produced = os.path.join(out_dir, "export.dwg")
        if os.path.exists(produced):
            with open(produced, "rb") as fh:
                return fh.read(), diag

    diag.setdefault("error", "no .dwg produced")
    return None, diag


def _dxf_to_dwg(dxf_bytes: bytes) -> bytes | None:
    dwg, _diag = _convert_dxf_to_dwg(dxf_bytes)
    return dwg


def _dwg_to_dxf(dwg_bytes: bytes) -> bytes | None:
    """Convert DWG bytes → DXF bytes via ODA File Converter (reverse direction)."""
    oda = _find_oda()
    if not oda:
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
            subprocess.run(cmd, capture_output=True, timeout=120)
        except (subprocess.TimeoutExpired, OSError):
            return None
        produced = os.path.join(out_dir, "input.dxf")
        if os.path.exists(produced):
            with open(produced, "rb") as fh:
                return fh.read()
    return None


# ── routes ────────────────────────────────────────────────────────────────────

@app.get("/health")
def health() -> dict:
    oda = _find_oda()
    return {
        "status": "ok",
        "dwg_export": bool(oda),
        "oda_path": oda,
    }


@app.post("/api/export/dxf")
async def export_dxf(
    body: ExportRequest,
    authorization: str | None = Header(None),
) -> StreamingResponse:
    _require_auth(authorization)
    dxf_bytes = _build_dxf_bytes(body.features)
    fname = f"{body.filename}.dxf"
    return StreamingResponse(
        io.BytesIO(dxf_bytes),
        media_type="application/dxf",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )


@app.post("/api/export/dwg")
async def export_dwg(
    body: ExportRequest,
    authorization: str | None = Header(None),
) -> StreamingResponse:
    _require_auth(authorization)

    dxf_bytes = _build_dxf_bytes(body.features)

    # Skip the OOM-prone ODA step for very large exports → return DXF, don't 502.
    too_large = len(body.features) > MAX_DWG_FEATURES
    dwg_bytes = None if too_large else _dxf_to_dwg(dxf_bytes)

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


@app.post("/api/convert/dwg-to-geojson")
async def convert_dwg_to_geojson(
    file: UploadFile = File(...),
    source_crs: str = Form("EPSG:2039"),
    authorization: str | None = Header(None),
) -> JSONResponse:
    """Convert an uploaded DWG → WGS84 GeoJSON (for importing into the map)."""
    _require_auth(authorization)
    dwg_bytes = await file.read()
    dxf_bytes = _dwg_to_dxf(dwg_bytes)
    if not dxf_bytes:
        raise HTTPException(status_code=500, detail="DWG→DXF conversion failed (ODA unavailable?)")
    try:
        geojson = dxf_to_geojson(dxf_bytes, source_crs=source_crs or "EPSG:2039")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"DXF parse failed: {e}")
    return JSONResponse(geojson)


@app.post("/api/convert/dwg-to-dxf")
async def convert_dwg_to_dxf(
    file: UploadFile = File(...),
    authorization: str | None = Header(None),
) -> StreamingResponse:
    """Convert an uploaded DWG file to DXF (for inspection / round-tripping)."""
    _require_auth(authorization)
    dwg_bytes = await file.read()
    dxf_bytes = _dwg_to_dxf(dwg_bytes)
    if not dxf_bytes:
        raise HTTPException(status_code=500, detail="DWG→DXF conversion failed")
    return StreamingResponse(
        io.BytesIO(dxf_bytes),
        media_type="application/dxf",
        headers={"Content-Disposition": 'attachment; filename="converted.dxf"'},
    )

