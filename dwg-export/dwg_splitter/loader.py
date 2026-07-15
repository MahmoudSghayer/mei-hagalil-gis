"""
Load a DWG or DXF into an ezdxf ``Drawing``.

DXF is read directly by ezdxf. DWG (binary) is first converted to DXF by the
ODA File Converter — the same step the import pipeline uses — so this is where
the "needs ODA + enough RAM" requirement bites for oversized DWGs.
"""

from __future__ import annotations

import os
import tempfile

import ezdxf

from . import DwgConversionError, OdaUnavailableError, oda


def _looks_like_dwg(data: bytes) -> bool:
    # DWG binaries start with an "AC1<x>" version stamp (AC1027=2013, AC1032=2018).
    return data[:4] == b"AC10"


def read_dxf_bytes(dxf_bytes: bytes) -> "ezdxf.document.Drawing":
    """Parse DXF bytes into a Drawing. ezdxf sniffs the encoding from a file, so
    we go through a temp file."""
    with tempfile.NamedTemporaryFile(suffix=".dxf", delete=False) as tf:
        tf.write(dxf_bytes)
        path = tf.name
    try:
        return ezdxf.readfile(path)
    finally:
        os.unlink(path)


def load_drawing_bytes(data: bytes, filename: str = "") -> "ezdxf.document.Drawing":
    """DWG or DXF bytes -> Drawing. A .dxf whose content is really DXF text skips
    ODA; anything else (incl. a .dxf that is actually a DWG binary) goes through
    ODA DWG->DXF."""
    name = (filename or "").lower()
    is_dxf = name.endswith(".dxf") and not _looks_like_dwg(data)
    if is_dxf:
        return read_dxf_bytes(data)

    if not oda.oda_available():
        raise OdaUnavailableError(
            "Reading a DWG requires the ODA File Converter, which is not "
            "installed here. Convert the file to DXF first, or run the splitter "
            "where ODA is available (e.g. the bundled Docker image)."
        )
    dxf_bytes = oda.dwg_to_dxf(data)
    if not dxf_bytes:
        raise DwgConversionError(
            "ODA failed to convert the DWG to DXF — the file is likely too "
            "large/complex for the memory available here. Split it on a machine "
            "or Docker image with more RAM, or raise ODA_MAX_MEMORY_MB."
        )
    return read_dxf_bytes(dxf_bytes)


def load_drawing(path: str) -> "ezdxf.document.Drawing":
    """Load a DWG/DXF file from disk into a Drawing."""
    with open(path, "rb") as fh:
        data = fh.read()
    return load_drawing_bytes(data, os.path.basename(path))
