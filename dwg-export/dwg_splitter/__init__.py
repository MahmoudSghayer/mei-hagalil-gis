"""
dwg_splitter — entity-level DWG splitter for the Mei HaGalil GIS.

Splits a large DWG/DXF drawing into several smaller, *valid* DWG (or DXF)
files at the CAD-object level — never by cutting bytes. Geometry and
coordinates are preserved verbatim, so the pieces overlay the original
exactly and the GIS shows the same result.

Pipeline (see DWG_SPLITTER_ARCHITECTURE.md):

    DWG --ODA--> DXF --ezdxf--> analyze -> decide strategy -> partition
        -> per part: ezdxf.Importer copy (+ stable GISID) -> ODA DXF->DWG
        -> measure & subdivide until <= size limit -> parts + manifest

The DWG<->DXF conversion reuses the incident-hardened ODA helpers in
``main.py`` (memory cap, timeout, logging) — see ``dwg_splitter.oda``.
"""

from __future__ import annotations

__version__ = "1.0.0"


class DwgSplitError(Exception):
    """Base class for all splitter errors."""


class OdaUnavailableError(DwgSplitError):
    """ODA File Converter is required for this operation but not installed.

    Raised when a DWG (binary) input must be read but no ODA binary is on the
    machine. DXF input does not need ODA. Run the splitter where ODA is
    available (locally, or the bundled Docker image) — see the architecture doc.
    """


class DwgConversionError(DwgSplitError):
    """ODA failed to convert DWG<->DXF (missing/timeout/crash/OOM).

    For an oversized DWG this typically means the machine ran out of memory
    for the conversion — split on a machine (or Docker image) with more RAM,
    or raise ODA_MAX_MEMORY_MB.
    """


__all__ = [
    "__version__",
    "DwgSplitError",
    "OdaUnavailableError",
    "DwgConversionError",
]
