"""
Manifest — the JSON sidecar that records a split's inputs and outputs, plus
helpers to write the parts and manifest to disk.
"""

from __future__ import annotations

import json
import os

from .analyzer import human_size


def _bounds_obj(b):
    if not b:
        return None
    return {"minX": b[0], "minY": b[1], "maxX": b[2], "maxY": b[3]}


def build_manifest(result, analysis: dict, *, validation: dict | None = None) -> dict:
    formats = {p.ext for p in result.parts}
    output_format = next(iter(formats)) if len(formats) == 1 else (
        "mixed" if formats else "none"
    )
    manifest = {
        "source": analysis,
        "strategy": result.strategy,
        "max_part_bytes": result.budget,
        "max_part_mb": round(result.budget / (1024 * 1024), 3),
        "oda_used": result.oda_used,
        "output_format": output_format,
        "total_parts": result.total_parts,
        "source_entities": result.source_entities,
        "emitted_entities": result.emitted_entities,
        "warnings": result.warnings,
        "parts": [
            {
                "filename": p.filename,
                "size_bytes": p.size,
                "size": human_size(p.size),
                "entity_count": p.entity_count,
                "layers": p.layers,
                "bounds": _bounds_obj(p.bounds),
            }
            for p in result.parts
        ],
    }
    if validation is not None:
        manifest["validation"] = validation
    return manifest


def write_parts(result, out_dir: str) -> list[str]:
    os.makedirs(out_dir, exist_ok=True)
    written = []
    for p in result.parts:
        path = os.path.join(out_dir, p.filename)
        with open(path, "wb") as fh:
            fh.write(p.data)
        written.append(path)
    return written


def write_manifest(manifest: dict, out_dir: str, name: str = "manifest.json") -> str:
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, name)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, ensure_ascii=False, indent=2)
    return path
