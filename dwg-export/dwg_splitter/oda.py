"""
Adapter around the service's ODA File Converter helpers.

DWG<->DXF conversion is done by the ODA File Converter, orchestrated by the
incident-hardened helpers in ``main.py`` (RLIMIT_AS memory cap, 120 s timeout,
diagnostic logging, single-flight semaphore). The splitter reuses those exact
helpers rather than re-implementing them, so there is one source of truth for
how ODA is invoked and guarded.

``main`` is imported lazily inside each call: importing it pulls in the FastAPI
app, which is unnecessary weight for a pure ``ezdxf`` DXF operation and would
make ``dwg_splitter`` unusable in an environment without the web deps. Callers
that only ever touch DXF never trigger the import.
"""

from __future__ import annotations


def _main():
    # dwg-export/main.py — importable because it sits next to this package on
    # sys.path (conftest.py adds it for tests; `python -m dwg_splitter` run from
    # the dwg-export dir puts it on sys.path[0]).
    import main

    return main


def oda_available() -> bool:
    """True if the ODA File Converter binary is installed on this machine."""
    try:
        return _main()._find_oda() is not None
    except Exception:
        return False


def dwg_to_dxf(dwg_bytes: bytes) -> bytes | None:
    """DWG bytes -> DXF bytes via ODA (reverse direction). None on failure."""
    return _main()._dwg_to_dxf(dwg_bytes)


def dxf_to_dwg(dxf_bytes: bytes) -> bytes | None:
    """DXF bytes -> DWG bytes via ODA. None on failure/ODA-missing."""
    return _main()._dxf_to_dwg(dxf_bytes)
