#!/usr/bin/env python3
"""pdf2text.py — recursively convert all PDFs in a folder tree to .txt files.

Usage:
    python pdf2text.py <folder> [--force] [--out DIR]

Behaviour:
    * Recurses through <folder> and every subfolder.
    * Each <name>.pdf -> <name>.txt (UTF-8), written next to the PDF by
      default, or under --out mirroring the subfolder layout.
    * Existing non-empty .txt files are SKIPPED unless --force.
    * pymupdf is auto-installed (pip) at startup if missing.
    * Ctrl+C (or console close) aborts gracefully: current file is not
      started again, a summary is printed, exit code = 130.
    * A failing PDF is reported and the run continues with the next file.
"""

import argparse
import subprocess
import sys
import time
from pathlib import Path


def _import_pymupdf():
    """Import the pymupdf module (prefer the modern name, fitz as legacy fallback)."""
    try:
        import pymupdf
        return pymupdf
    except ImportError:
        import fitz  # legacy alias, older pymupdf versions
        return fitz


def ensure_pymupdf():
    """Import pymupdf, auto-installing it via pip if absent."""
    try:
        return _import_pymupdf()
    except ImportError:
        pass
    print("[setup] pymupdf not found - auto-installing via pip ...")
    try:
        subprocess.check_call(
            [sys.executable, "-m", "pip", "install",
             "--disable-pip-version-check", "pymupdf"]
        )
    except subprocess.CalledProcessError as e:
        sys.exit(f"[setup] FAILED to auto-install pymupdf (pip exit code {e.returncode}).\n"
                 f"        Install it manually with:\n"
                 f"            {sys.executable} -m pip install pymupdf")
    try:
        return _import_pymupdf()
    except ImportError:
        sys.exit("[setup] pymupdf was installed but is still not importable.\n"
                 "        Close this script and run it again (fresh interpreter).")


def main():
    ap = argparse.ArgumentParser(
        description="Recursively convert every .pdf in a folder tree to .txt (pymupdf).",
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("folder", help="root folder to scan recursively for *.pdf")
    ap.add_argument("--force", action="store_true",
                    help="re-convert even if the .txt already exists")
    ap.add_argument("--out", metavar="DIR",
                    help="write .txt under DIR (mirrors subfolder layout) "
                         "instead of next to each PDF")
    args = ap.parse_args()

    root = Path(args.folder).expanduser().resolve()
    if not root.is_dir():
        sys.exit(f"error: not a folder: {root}")
    out_root = Path(args.out).expanduser().resolve() if args.out else None
    if out_root:
        out_root.mkdir(parents=True, exist_ok=True)

    fitz = ensure_pymupdf()
    print(f"pdf2text | pymupdf {fitz.__version__}")
    print(f"root  : {root}")
    mode = "FORCE (overwrite existing .txt)" if args.force else "skip existing .txt"
    where = f"output: {out_root} (mirrors layout)" if out_root else "output: next to each PDF"
    print(f"mode  : {mode}")
    print(f"      : {where}")
    print("-" * 72)

    pdfs = sorted(root.rglob("*.pdf"))
    if not pdfs:
        print("no .pdf files found - nothing to do.")
        return
    total = len(pdfs)
    print(f"found : {total} PDF file(s) in this folder tree\n")

    ok = skipped = failed = 0
    aborted = False
    t0 = time.time()
    try:
        for i, pdf in enumerate(pdfs, 1):
            rel = pdf.relative_to(root)
            out_path = (out_root / rel) if out_root else pdf.with_suffix(".txt")

            if not args.force and out_path.exists() and out_path.stat().st_size > 0:
                skipped += 1
                print(f"[{i:>4}/{total}] SKIP (exists)   {rel}")
                continue

            out_path.parent.mkdir(parents=True, exist_ok=True)
            print(f"[{i:>4}/{total}] converting      {rel} ...", end="", flush=True)
            t1 = time.time()
            try:
                doc = fitz.open(pdf)
                try:
                    pages = doc.page_count
                    text = "\n".join(page.get_text() for page in doc)
                finally:
                    doc.close()
            except Exception as e:
                failed += 1
                print(f"\n          ERROR: {type(e).__name__}: {e}  -> skipping this file")
                continue

            out_path.write_text(text, encoding="utf-8", errors="replace")
            nchars = len(text)
            kbytes = out_path.stat().st_size / 1024
            warn = "   [warn] 0 chars extracted - probably a SCANNED pdf (needs OCR)" if nchars == 0 else ""
            print(f" {pages} pages -> {nchars:,} chars "
                  f"({kbytes:,.0f} KB) in {time.time() - t1:.1f} s{warn}")
            ok += 1
    except KeyboardInterrupt:
        aborted = True
        print("\n\n[abort] Ctrl+C received - stopping now (no further files will be started).")

    dt = time.time() - t0
    not_attempted = total - ok - skipped - failed
    print("-" * 72)
    if aborted:
        print(f"ABORTED : {ok} converted, {skipped} skipped, {failed} failed "
              f"(of {total} found, {not_attempted} never started) in {dt:.1f} s")
    else:
        print(f"DONE    : {ok} converted, {skipped} skipped, {failed} failed "
              f"(of {total} found) in {dt:.1f} s")
    sys.exit(130 if aborted else (1 if failed else 0))


if __name__ == "__main__":
    main()
