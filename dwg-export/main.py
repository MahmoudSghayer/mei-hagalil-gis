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

from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from dxf_builder import build_dxf

app = FastAPI(
    title="Mei HaGalil GIS — DWG Export Service",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

API_TOKEN: str = os.getenv("API_TOKEN", "7bnNTN5T70qMRGp75AnrWe5NwaQFawG6tUmi35mz")


# ── models ────────────────────────────────────────────────────────────────────

class ExportRequest(BaseModel):
    features: list[dict[str, Any]]
    filename: str = "mei-hagalil-export"


# ── auth ──────────────────────────────────────────────────────────────────────

def _require_auth(token: str | None) -> None:
    if token != API_TOKEN:
        raise HTTPException(status_code=401, detail="Unauthorized")


# ── helpers ───────────────────────────────────────────────────────────────────

def _build_dxf_bytes(features: list[dict]) -> bytes:
    doc = build_dxf(features)
    buf = io.BytesIO()
    doc.write(buf)
    buf.seek(0)
    return buf.read()


def _dxf_to_dwg(dxf_bytes: bytes) -> bytes | None:
    """Convert DXF bytes → DWG bytes via ODA File Converter CLI.
    Returns None if ODA is not available or conversion fails."""
    oda = shutil.which("ODAFileConverter")
    if not oda:
        return None

    with tempfile.TemporaryDirectory() as tmp:
        in_dir = os.path.join(tmp, "in")
        out_dir = os.path.join(tmp, "out")
        os.makedirs(in_dir)
        os.makedirs(out_dir)

        dxf_path = os.path.join(in_dir, "export.dxf")
        dwg_path = os.path.join(out_dir, "export.dwg")

        with open(dxf_path, "wb") as fh:
            fh.write(dxf_bytes)

        result = subprocess.run(
            [oda, in_dir, out_dir, "ACAD2018", "DWG", "0", "0"],
            capture_output=True,
            timeout=120,
        )

        if result.returncode == 0 and os.path.exists(dwg_path):
            with open(dwg_path, "rb") as fh:
                return fh.read()

    return None


# ── routes ────────────────────────────────────────────────────────────────────

@app.get("/health")
def health() -> dict:
    oda = shutil.which("ODAFileConverter")
    return {
        "status": "ok",
        "dwg_export": bool(oda),
        "oda_path": oda,
    }


@app.post("/api/export/dxf")
async def export_dxf(
    body: ExportRequest,
    x_api_token: str | None = Header(None),
) -> StreamingResponse:
    _require_auth(x_api_token)
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
) -> StreamingResponse:
    _require_auth(x_api_token)

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
