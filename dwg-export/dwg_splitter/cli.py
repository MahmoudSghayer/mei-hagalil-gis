"""
Command-line interface for the DWG splitter.

    python -m dwg_splitter analyze  <input.dwg|.dxf> [--json]
    python -m dwg_splitter split    <input.dwg|.dxf> [--out DIR] [--max-mb 2.5]
                                    [--strategy layer|tile|hybrid] [--dxf]
                                    [--no-validate]

Run this locally (where ODA has full RAM) to pre-split a big DWG into parts that
each clear the server's limits, then upload the parts normally. Without ODA the
splitter still runs but emits DXF parts (which the app imports directly).
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys

from . import DwgSplitError, config
from . import oda as oda_mod
from .manifest import build_manifest, write_manifest, write_parts
from .service import analyze_bytes, split_bytes


def _prepare_console() -> None:
    # The app runs on Hebrew Windows (cp1255 console); force UTF-8 so Hebrew
    # layer names print and no glyph crashes the run. Silence ezdxf's chatty
    # INFO logging (importing main.py turns the root logger up to INFO).
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")  # py3.7+
        except Exception:
            pass
    logging.getLogger("ezdxf").setLevel(logging.WARNING)


def _read(path: str) -> bytes:
    with open(path, "rb") as fh:
        return fh.read()


def _cmd_analyze(args) -> int:
    data = _read(args.input)
    analysis = analyze_bytes(data, os.path.basename(args.input))
    if args.json:
        print(json.dumps(analysis, ensure_ascii=False, indent=2))
        return 0
    _print_analysis(analysis)
    return 0


def _cmd_split(args) -> int:
    data = _read(args.input)
    filename = os.path.basename(args.input)
    stem = os.path.splitext(filename)[0] or "drawing"
    out_dir = args.out or os.path.join(os.getcwd(), f"{stem}_parts")
    max_bytes = int(args.max_mb * 1024 * 1024) if args.max_mb else None
    use_oda = False if args.dxf else None  # None → auto-detect ODA

    if use_oda is None and not oda_mod.oda_available():
        print("• ODA File Converter not found — emitting DXF parts "
              "(valid CAD; the app imports DXF directly).", file=sys.stderr)

    def on_progress(n: int, name: str) -> None:
        print(f"  part {n}: {name}", file=sys.stderr)

    print(f"• Splitting {filename} "
          f"(budget {args.max_mb or config.MAX_DWG_PART_MB} MB/part, "
          f"strategy {args.strategy or config.DEFAULT_STRATEGY}) …",
          file=sys.stderr)

    result, manifest = split_bytes(
        data, filename,
        strategy=args.strategy, max_bytes=max_bytes, use_oda=use_oda,
        validate=not args.no_validate, coordinate_check=not args.no_validate,
        on_progress=on_progress,
    )

    write_parts(result, out_dir)
    manifest_path = write_manifest(manifest, out_dir)

    _print_split_summary(result, manifest, out_dir, manifest_path)
    if manifest.get("validation") and not manifest["validation"]["ok"]:
        return 2
    return 0


def _print_analysis(a: dict) -> None:
    print(f"File:     {a.get('filename')}  ({a.get('size') or '?'})")
    print(f"Version:  {a.get('dxf_version')}   units: {a.get('units')}")
    print(f"Entities: {a.get('entities')}")
    for t, c in list(a.get("entities_by_type", {}).items())[:12]:
        print(f"   {t:<14} {c}")
    print(f"Layers:   {len(a.get('layers', []))}")
    for lyr in a.get("layers", [])[:12]:
        print(f"   {lyr['name']:<24} {lyr['entities']}")
    if a.get("blocks"):
        print(f"Blocks:   {', '.join(a['blocks'][:12])}")
    b = a.get("bounds")
    if b:
        print(f"Bounds:   X[{b['minX']:.2f}, {b['maxX']:.2f}]  "
              f"Y[{b['minY']:.2f}, {b['maxY']:.2f}]")
    print(f"CRS:      {a.get('coordinate_system')}  sign {a.get('coordinate_sign')}")


def _print_split_summary(result, manifest, out_dir, manifest_path) -> None:
    print()
    print(f"✓ {result.total_parts} part(s) written to {out_dir}")
    for p in manifest["parts"]:
        print(f"   {p['filename']:<40} {p['size']:>9}  "
              f"{p['entity_count']:>7} ent  layers={len(p['layers'])}")
    print(f"   manifest: {manifest_path}")
    if result.warnings:
        print("\n⚠ warnings:")
        for w in result.warnings:
            print(f"   - {w}")
    v = manifest.get("validation")
    if v:
        status = "PASS" if v["ok"] else "FAIL"
        print(f"\nValidation: {status}")
        for c in v["checks"]:
            mark = "~" if c["skipped"] else ("✓" if c["ok"] else "✗")
            print(f"   {mark} {c['check']}: {c['detail']}")


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="dwg_splitter",
        description="Split a large DWG/DXF into smaller valid parts at the "
                    "CAD-entity level (coordinates preserved).",
    )
    sub = p.add_subparsers(dest="command", required=True)

    pa = sub.add_parser("analyze", help="inspect a drawing's structure")
    pa.add_argument("input", help="path to a .dwg or .dxf file")
    pa.add_argument("--json", action="store_true", help="print raw JSON")
    pa.set_defaults(func=_cmd_analyze)

    ps = sub.add_parser("split", help="split a drawing into size-bounded parts")
    ps.add_argument("input", help="path to a .dwg or .dxf file")
    ps.add_argument("--out", help="output directory (default: <name>_parts/)")
    ps.add_argument("--max-mb", type=float, default=None,
                    help=f"max size per part in MB (default {config.MAX_DWG_PART_MB})")
    ps.add_argument("--strategy", choices=["layer", "tile", "hybrid", "auto"],
                    default=None,
                    help=f"split strategy (default {config.DEFAULT_STRATEGY})")
    ps.add_argument("--dxf", action="store_true",
                    help="emit DXF parts even if ODA is available")
    ps.add_argument("--no-validate", action="store_true",
                    help="skip the post-split validation checks")
    ps.set_defaults(func=_cmd_split)
    return p


def main(argv: list[str] | None = None) -> int:
    _prepare_console()
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except FileNotFoundError as e:
        print(f"error: file not found: {e.filename}", file=sys.stderr)
        return 1
    except DwgSplitError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
