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
import os
import shutil
import subprocess
import tempfile
from typing import Any

import jwt
from fastapi import FastAPI, File, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from dxf_builder import build_dxf

app = FastAPI(
    title="Mei HaGalil GIS — DWG Export Service",
    version="1.0.0",
)

# Restrict which sites may call this service.
# Set ALLOWED_ORIGINS in Render (comma-separated) to your real domain(s),
# e.g. "https://mei-hagalil-gis.vercel.app,https://gis.mei-hagalil.co.il".
# Defaults to "*" only so first-time testing works before you lock it down.
_origins = os.getenv("ALLOWED_ORIGINS", "*")
ALLOWED_ORIGINS: list[str] = (
    ["*"] if _origins.strip() == "*"
    else [o.strip() for o in _origins.split(",") if o.strip()]
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

# Legacy auth token the frontend sends in X-Api-Token. Kept only as a transitional
# fallback — the preferred auth is a Supabase session JWT (see SUPABASE_JWT_SECRET).
API_TOKEN: str = os.getenv("API_TOKEN", "7bnNTN5T70qMRGp75AnrWe5NwaQFawG6tUmi35mz")

# Supabase project JWT secret (Dashboard → Settings → API → JWT Secret).
# When set, the service accepts a logged-in user's "Authorization: Bearer <access_token>"
# and no static token needs to live in the browser. Leave unset to keep token-only auth.
SUPABASE_JWT_SECRET: str = os.getenv("SUPABASE_JWT_SECRET", "")


# ── models ────────────────────────────────────────────────────────────────────

class ExportRequest(BaseModel):
    features: list[dict[str, Any]]
    filename: str = "mei-hagalil-export"


# ── auth ──────────────────────────────────────────────────────────────────────

def _valid_supabase_jwt(authorization: str | None) -> bool:
    """True if `authorization` is 'Bearer <token>' carrying a valid Supabase JWT."""
    if not SUPABASE_JWT_SECRET or not authorization:
        return False
    parts = authorization.split()
    if len(parts) != 2 or parts[0].lower() != "bearer":
        return False
    try:
        jwt.decode(
            parts[1],
            SUPABASE_JWT_SECRET,
            algorithms=["HS256"],
            audience="authenticated",
        )
        return True
    except Exception:
        return False


def _require_auth(x_api_token: str | None, authorization: str | None = None) -> None:
    # Preferred: a valid Supabase session JWT — no shared secret lives in the client.
    if _valid_supabase_jwt(authorization):
        return
    # Transitional fallback: the static token (drop once all clients send a JWT).
    if x_api_token and x_api_token == API_TOKEN:
        return
    raise HTTPException(status_code=401, detail="Unauthorized")


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
    x_api_token: str | None = Header(None),
    authorization: str | None = Header(None),
) -> StreamingResponse:
    _require_auth(x_api_token, authorization)
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
    x_api_token: str | None = Header(None),
    authorization: str | None = Header(None),
) -> StreamingResponse:
    _require_auth(x_api_token, authorization)

    dxf_bytes = _build_dxf_bytes(body.features)
    dwg_bytes = _dxf_to_dwg(dxf_bytes)

    if dwg_bytes:
        fname = f"{body.filename}.dwg"
        return StreamingResponse(
            io.BytesIO(dwg_bytes),
            media_type="application/octet-stream",
            headers={"Content-Disposition": f'attachment; filename="{fname}"'},
        )

    # ODA not available — return DXF so the user still gets their data
    fname = f"{body.filename}.dxf"
    return StreamingResponse(
        io.BytesIO(dxf_bytes),
        media_type="application/dxf",
        headers={
            "Content-Disposition": f'attachment; filename="{fname}"',
            "X-Fallback-Format": "dxf",
        },
    )


@app.post("/api/convert/dwg-to-dxf")
async def convert_dwg_to_dxf(
    file: UploadFile = File(...),
    x_api_token: str | None = Header(None),
    authorization: str | None = Header(None),
) -> StreamingResponse:
    """Convert an uploaded DWG file to DXF (for inspection / round-tripping)."""
    _require_auth(x_api_token, authorization)
    dwg_bytes = await file.read()
    dxf_bytes = _dwg_to_dxf(dwg_bytes)
    if not dxf_bytes:
        raise HTTPException(status_code=500, detail="DWG→DXF conversion failed")
    return StreamingResponse(
        io.BytesIO(dxf_bytes),
        media_type="application/dxf",
        headers={"Content-Disposition": 'attachment; filename="converted.dxf"'},
    )

