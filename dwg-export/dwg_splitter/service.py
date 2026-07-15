"""
High-level orchestration used by both the CLI and (Phase 2) the HTTP API:
bytes in → analysis / split result + manifest out.
"""

from __future__ import annotations

import os
from typing import Callable, Optional

from .analyzer import analyze
from .loader import load_drawing_bytes
from .manifest import build_manifest
from .splitter import _slugify, split_drawing
from .validate import validate_split


def analyze_bytes(data: bytes, filename: str = "") -> dict:
    doc = load_drawing_bytes(data, filename)
    return analyze(doc, filename=filename, size_bytes=len(data))


def split_bytes(
    data: bytes,
    filename: str = "",
    *,
    strategy: Optional[str] = None,
    max_bytes: Optional[int] = None,
    use_oda: Optional[bool] = None,
    validate: bool = True,
    coordinate_check: bool = True,
    on_progress: Optional[Callable[[int, str], None]] = None,
):
    """Load → analyze → split → (validate) → manifest.

    Returns (split_result, manifest). Part bytes live on split_result.parts;
    write them with manifest.write_parts()."""
    doc = load_drawing_bytes(data, filename)
    analysis = analyze(doc, filename=filename, size_bytes=len(data))
    stem = _slugify(os.path.splitext(os.path.basename(filename))[0] or "drawing")

    result = split_drawing(
        doc, stem=stem, strategy=strategy, max_bytes=max_bytes,
        use_oda=use_oda, on_progress=on_progress,
    )
    validation = (
        validate_split(doc, result, coordinate_check=coordinate_check)
        if validate else None
    )
    manifest = build_manifest(result, analysis, validation=validation)
    return result, manifest
