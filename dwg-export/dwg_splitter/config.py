"""
Configurable limits for the splitter.

Every knob has an environment-variable override so the same code runs with a
tight budget on the free-tier server and a generous one on a local/Docker run.
"""

from __future__ import annotations

import os


def _float_env(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        return default


def _int_env(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        return default


# Target maximum size for each generated part. The splitter GUARANTEES every
# output part is <= this (measured on the real DWG bytes when ODA is available,
# otherwise on the DXF bytes as a conservative proxy — DWG is smaller). 2.5 MB
# leaves head-room under the server's 32 MB body guard and, more importantly,
# keeps each part's ODA conversion well inside the 400 MB memory cap.
MAX_DWG_PART_MB: float = _float_env("MAX_DWG_PART_MB", 2.5)


def max_part_bytes(mb: float | None = None) -> int:
    return int((MAX_DWG_PART_MB if mb is None else mb) * 1024 * 1024)


# Below this many entities a group is never subdivided further — a single
# entity that alone exceeds the budget cannot be split, so we emit it (with a
# warning) rather than loop forever.
MIN_ENTITIES_PER_PART: int = _int_env("DWG_SPLIT_MIN_ENTITIES", 1)

# Hard ceiling on spatial-bisection recursion depth (safety backstop against a
# pathological drawing where the budget can never be met).
MAX_SUBDIVIDE_DEPTH: int = _int_env("DWG_SPLIT_MAX_DEPTH", 24)

# Default split strategy when the caller does not specify one.
#   layer  — one part per CAD layer (parts that alone exceed the budget are
#            emitted whole, with a warning)
#   tile   — ignore layers, tile spatially so every part meets the budget
#   hybrid — layer-first, then tile any oversized layer (recommended default)
DEFAULT_STRATEGY: str = os.getenv("DWG_SPLIT_STRATEGY", "hybrid")

VALID_STRATEGIES = ("layer", "tile", "hybrid", "auto")
